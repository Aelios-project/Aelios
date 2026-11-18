import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import { invalidateSettingsCache } from "../src/gateway/config";
import { resetModelCache, TIMEOUTS } from "../src/chatgpt/client";
import { resetLearnedFields } from "../src/chatgpt/upstream";
import { ChatStreamTranslator, chatCompletionFromResponse, chatUsage } from "../src/chatgpt/fromResponses";
import { toChatGptRequest } from "../src/chatgpt/toResponses";
import { MessagesStreamTranslator, messageFromResponse, THINKING_SIGNATURE } from "../src/chatgpt/toMessages";
import { runDiaryWriter } from "../src/memory/diaryWriter";
import { callOpenAICompat } from "../src/proxy/openaiAdapter";
import { callModelWithRetry, ModelCallError } from "../src/utils/modelCall";
import { TOKEN_URL, resetOAuthCaches } from "../src/chatgpt/oauth";
import { ensureConnection, saveSession, seal } from "../src/chatgpt/store";

(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);

/** A lookup the test needs to have found; fails with a clear message instead of a TypeError further down. */
function need<T>(value: T | null | undefined, what = "value"): T {
  assert.ok(value !== null && value !== undefined, `expected ${what} to exist`);
  return value as T;
}

const RESPONSES = "https://api.openai.com/v1/responses";
const MODELS = "https://api.openai.com/v1/models";
let sqlite: DatabaseSync;
let env: any;
let ctx: any;
let pending: Promise<unknown>[];
let queue: any[];
/** What api.openai.com was asked, in order. */
let asked: { url: string; method: string; headers: Record<string, string>; body: any }[];
let answer: (body: any, headers: Record<string, string>, nth: number) => Response | Promise<Response>;
let models: () => Response | Promise<Response>;
let tokenCalls: Record<string, string>[];

const sseText = (events: any[]) => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const sseResponse = (events: any[], status = 200) => new Response(sseText(events), { status, headers: { "content-type": "text/event-stream", "x-request-id": "req_test" } });
/** The shortest successful Responses stream: hello, then done. */
function textEvents(text: string, usage: any = { input_tokens: 11, output_tokens: 5, total_tokens: 16 }) {
  return [
    { type: "response.created", response: { id: "resp_abc", status: "in_progress", output: [] } },
    { type: "response.in_progress", response: { id: "resp_abc", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
    ...[...text].length ? text.split(/(?<= )/).map(piece => ({ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: piece })) : [],
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text }] } },
    { type: "response.completed", response: { id: "resp_abc", status: "completed", output: [], usage } }
  ];
}
const frames = (text: string) => text.split("\n\n").map(part => part.trim()).filter(Boolean).map(part => part.replace(/^data: /, ""));
const chunks = (text: string) => frames(text).filter(frame => frame !== "[DONE]").map(frame => JSON.parse(frame));

function identity(models = ["chatgpt/*"]) {
  return { slug: "partner", namespace: "partner-a", keys: ["CHATBOX_API_KEY"], anthropicThinking: "drop_block", models };
}
function setConfig(withUpstream = true, models?: string[]) {
  env.GATEWAY_CONFIG = JSON.stringify({ version: 3, ...(withUpstream ? { upstream: { address: "https://upstream.test/ai/v1" } } : {}), identities: [identity(models)] });
}
async function signIn(options: { expiresIn?: number; planUsage?: boolean; refreshedAgo?: number } = {}) {
  await ensureConnection(env);
  await saveSession(env, { clientId: "oaiapp_route", subject: "user-1", email: "owner@example.com",
    scopes: options.planUsage === false ? "openid offline_access" : "openid offline_access chatgpt.tokens.use.direct",
    planUsage: options.planUsage !== false, accessToken: "access-live", refreshToken: "refresh-live", idToken: null,
    expiresAt: Date.now() + (options.expiresIn ?? 3600_000), earliestRefreshAt: null }, Date.now() - (options.refreshedAgo ?? 0));
}

beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter((f: string) => f.endsWith(".sql")).sort()) {
    try { sqlite.exec(readFileSync(`migrations/${file}`, "utf8")); }
    catch (error) { if (!String(error).includes("fts5")) throw error; }
  }
  const db = { prepare(sql: string) {
    const statement = sqlite.prepare(sql); let args: any[] = [];
    const api = { bind(...values: any[]) { args = values; return api; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { const r = statement.run(...args); return { meta: { changes: r.changes } }; } };
    return api;
  }, async batch(statements: any[]) {
    sqlite.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results; }
    catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  } };
  invalidateSettingsCache(); resetModelCache(); resetLearnedFields(); resetOAuthCaches();
  asked = []; queue = []; pending = []; tokenCalls = [];
  ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); } };
  env = { DB: db, CHATBOX_API_KEY: "owner-key", IM_API_KEY: "im-key", CLOUDFLARE_API_TOKEN: "cf-token-must-not-leak",
    AI: { async run() { throw new Error("embedding unavailable in test"); } },
    MEMORY_QUEUE: { async send(e: any) { queue.push(e); } } };
  answer = () => sseResponse(textEvents("Hello there"));
  models = () => Response.json({ data: [{ slug: "gpt-test", display_name: "GPT Test", visibility: "list" },
    { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide" }, { slug: "gpt-two", display_name: "Two", visibility: "list" }] });
  globalThis.fetch = async (input: any, init: any) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers));
    if (url === RESPONSES) {
      const body = JSON.parse(init.body);
      asked.push({ url, method: init.method, headers, body });
      return answer(body, headers, asked.filter(item => item.url === RESPONSES).length);
    }
    if (url === MODELS) { asked.push({ url, method: "GET", headers, body: null }); return models(); }
    if (url === TOKEN_URL) {
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      tokenCalls.push(form);
      return Response.json({ access_token: "access-renewed", refresh_token: "refresh-renewed", expires_in: 3600 });
    }
    if (url.includes("upstream.test") && url.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "openai/gpt-4o", object: "model" }] });
    }
    if (url.includes("upstream.test")) {
      asked.push({ url, method: init.method, headers, body: init.body ? JSON.parse(init.body) : null });
      return Response.json({ model: "actual", choices: [{ index: 0, message: { content: "from CF" }, finish_reason: "stop" }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  setConfig();
});

function post(path: string, body: any, headers: any = {}) {
  return worker.fetch(new Request(`https://aelios.test${path}`, { method: "POST",
    headers: { authorization: "Bearer owner-key", "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env, ctx);
}
const chat = (body: any) => post("/v1/chat/completions", { model: "chatgpt/gpt-test", messages: [{ role: "user", content: "hi" }], ...body });
const responses = (body: any) => post("/v1/responses", { model: "chatgpt/gpt-test", input: "hi", ...body });
const openai = () => asked.filter(item => item.url === RESPONSES);

test("responses, streaming: goes to api.openai.com with the plan token, never the CF token, with the contract's fields", async () => {
  await signIn();
  const reply = await responses({ stream: true, store: true, temperature: 0.4, top_p: 0.9, max_output_tokens: 100, user: "u1",
    metadata: { a: "b" }, service_tier: "priority", instructions: "Be brief." });
  assert.equal(reply.status, 200);
  assert.match(reply.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(reply.headers.get("x-aelios-provider"), "chatgpt");
  assert.equal(reply.headers.get("x-aelios-model"), "chatgpt/gpt-test");
  const text = await reply.text(); await Promise.all(pending);
  assert.match(text, /response\.completed/);
  assert.equal(openai().length, 1);
  const call = openai()[0];
  assert.equal(call.method, "POST");
  assert.equal(call.headers.authorization, "Bearer access-live");
  assert.ok(!JSON.stringify(call.headers).includes("cf-token-must-not-leak"));
  assert.ok(!("cf-aig-authorization" in call.headers));
  assert.equal(call.body.model, "gpt-test");
  assert.equal(call.body.store, false);
  assert.equal(call.body.stream, true);
  assert.deepEqual(call.body.input, [{ role: "user", content: "hi" }]);
  assert.equal(call.body.instructions, "Be brief.");
  for (const banned of ["temperature", "top_p", "max_output_tokens", "user", "metadata", "service_tier"]) {
    assert.ok(!(banned in call.body), banned);
  }
  assert.equal(asked.filter(item => item.url.includes("upstream.test")).length, 0);
  assert.equal(reply.headers.get("x-aelios-normalized"), "6");
});

test("it works with no CF upstream and no CF token at all", async () => {
  await signIn();
  delete env.CLOUDFLARE_API_TOKEN;
  setConfig(false);
  const reply = await chat({ stream: false });
  assert.equal(reply.status, 200);
  assert.equal((await reply.json() as any).choices[0].message.content, "Hello there");
});

test("responses, not streaming: the finished response comes back as JSON even when the terminal event carries no output", async () => {
  await signIn();
  const reply = await responses({ stream: false });
  const body = await reply.json() as any;
  assert.equal(reply.status, 200);
  assert.equal(body.status, "completed");
  assert.equal(body.output[0].content[0].text, "Hello there");
  assert.equal(openai()[0].body.stream, true, "upstream is always streamed");
});

test("system items become developer items; a string input becomes a message array", async () => {
  await signIn();
  await (await responses({ stream: true, input: [{ role: "system", content: "rules" }, { type: "message", role: "system", content: "more" },
    { role: "user", content: "hi" }] })).text();
  assert.deepEqual(openai()[0].body.input.map((item: any) => item.role), ["developer", "developer", "user"]);
});

test("chat, streaming: translated chunks, usage on request, and the request is rebuilt as Responses", async () => {
  await signIn();
  const reply = await chat({ stream: true, stream_options: { include_usage: true }, temperature: 0.2, max_tokens: 50, top_p: 0.5,
    reasoning_effort: "low", user: "u1", seed: 3, stop: ["x"],
    messages: [{ role: "system", content: "You are kind." }, { role: "user", content: "hi" }] });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get("x-aelios-provider"), "chatgpt");
  const text = await reply.text(); await Promise.all(pending);
  const parts = chunks(text);
  assert.equal(frames(text).at(-1), "[DONE]");
  assert.deepEqual(parts[0].choices[0].delta, { role: "assistant", content: "" });
  assert.equal(parts.filter(part => part.choices[0]?.delta?.content).map(part => part.choices[0].delta.content).join(""), "Hello there");
  const finish = parts.find(part => part.choices[0]?.finish_reason);
  assert.equal(finish.choices[0].finish_reason, "stop");
  assert.ok(parts.every(part => part.object === "chat.completion.chunk" && part.model === "chatgpt/gpt-test" && part.id === "chatcmpl-abc"));
  const usage = parts.at(-1);
  assert.deepEqual(usage.choices, []);
  assert.equal(usage.usage.prompt_tokens, 11);
  assert.equal(usage.usage.completion_tokens, 5);
  assert.equal(usage.usage.total_tokens, 16);
  const body = openai()[0].body;
  assert.equal(body.instructions, "You are kind.");
  assert.deepEqual(body.input, [{ role: "user", content: "hi" }]);
  assert.deepEqual(body.reasoning, { effort: "low", summary: "auto" });
  for (const gone of ["messages", "temperature", "max_tokens", "top_p", "user", "seed", "stop", "stream_options"]) assert.ok(!(gone in body), gone);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
});

test("chat requests reasoning summaries when effort is enabled, including upstream output in both response modes", async () => {
  await signIn();
  answer = body => {
    const summary = body.reasoning?.summary === "auto";
    return sseResponse([
      { type: "response.created", response: { id: "resp_summary" } },
      ...(summary ? [{ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Checked the calculation." },
        { type: "response.output_item.done", output_index: 1, item: { type: "reasoning", summary: [{ type: "summary_text", text: "Checked the calculation." }] } }] : []),
      ...textEvents("2562")
    ]);
  };
  const streamed = chunks(await (await chat({ stream: true, reasoning_effort: "medium" })).text());
  assert.equal(streamed.map(part => part.choices[0]?.delta?.reasoning_content ?? "").join(""), "Checked the calculation.");
  const finished = await (await chat({ stream: false, reasoning_effort: "medium" })).json() as any;
  assert.equal(finished.choices[0].message.reasoning_content, "Checked the calculation.");
  for (const effort of ["none", "minimal"]) {
    await (await chat({ stream: false, reasoning_effort: effort })).text();
    assert.deepEqual(openai().at(-1)?.body.reasoning, { effort });
  }
  await (await chat({ stream: false })).text();
  assert.equal(openai().at(-1)?.body.reasoning, undefined);
});

test("GPT-6.2 Chat requests summaries with default effort, while explicit controls and native Responses remain unchanged", async () => {
  await signIn();
  answer = body => sseResponse([
    ...(body.reasoning?.summary === "auto" ? [{ type: "response.reasoning_summary_text.delta", output_index: 1, delta: "Summary." },
      { type: "response.output_item.done", output_index: 1, item: { type: "reasoning", summary: [{ type: "summary_text", text: "Summary." }] } }] : []),
    ...textEvents("ok")
  ]);
  for (const model of ["chatgpt/gpt-6.2-sol", "chatgpt/gpt-6.2-astra"]) {
    const streamed = chunks(await (await chat({ model, stream: true })).text());
    assert.equal(streamed.map(part => part.choices[0]?.delta?.reasoning_content ?? "").join(""), "Summary.");
    assert.deepEqual(openai().at(-1)?.body.reasoning, { summary: "auto" });
    const result = await (await chat({ model, stream: false })).json() as any;
    assert.equal(result.choices[0].message.reasoning_content, "Summary.");
    for (const effort of ["none", "minimal"]) {
      await (await chat({ model, stream: false, reasoning_effort: effort })).text();
      assert.deepEqual(openai().at(-1)?.body.reasoning, { effort });
    }
  }
  const native = toChatGptRequest({ input: "hi", reasoning: { effort: "low" } }, "responses", "gpt-6.2-sol").body;
  assert.deepEqual(native.reasoning, { effort: "low" });
});

test("GPT-6.2 translated system prompts lead the cacheable input; native Responses instructions remain request-scoped", () => {
  for (const slug of ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.2-sol-2026-11-18"]) {
    for (const protocol of ["chat", "messages"] as const) {
      const payload = protocol === "chat"
        ? { messages: [{ role: "system", content: "Stable policy." }, { role: "developer", content: "More rules." }, { role: "user", content: "hi" }] }
        : { system: "Stable policy.\n\nMore rules.", messages: [{ role: "user", content: "hi" }] };
      const before = structuredClone(payload);
      const body = toChatGptRequest(payload, protocol, slug).body;
      assert.equal(body.instructions, undefined);
      assert.deepEqual(body.input[0], { role: "developer", content: "Stable policy.\n\nMore rules." });
      assert.equal(body.input[1].role, "user");
      assert.deepEqual(payload, before);
    }
  }
  const native = toChatGptRequest({ input: "hi", instructions: "This turn only." }, "responses", "gpt-6.2-sol").body;
  assert.equal(native.instructions, "This turn only.");
  assert.deepEqual(native.input, [{ role: "user", content: "hi" }]);
  const older = toChatGptRequest({ messages: [{ role: "system", content: "rules" }, { role: "user", content: "hi" }] }, "chat", "gpt-6.1-sol").body;
  assert.equal(older.instructions, "rules");
});

test("Responses cache controls and diagnostic comparisons reach the plan with content breakpoints intact", async () => {
  await signIn();
  const input = [{ role: "developer", content: [{ type: "input_text", text: "Stable policy.", prompt_cache_breakpoint: { mode: "explicit" } }] },
    { role: "user", content: "hi" }];
  const options = { mode: "implicit", ttl: "30m", comparison_response_id: "resp_baseline" };
  const diagnostics = { type: "cache_hit" };
  answer = () => sseResponse([{ type: "response.completed", response: { id: "resp_cache", status: "completed", output: [], prompt_cache_diagnostics: diagnostics } }]);
  for (const stream of [true, false]) {
    const reply = await responses({ stream, input, prompt_cache_options: options });
    assert.equal(reply.status, 200);
    assert.deepEqual(openai().at(-1)?.body.prompt_cache_options, options);
    assert.deepEqual(openai().at(-1)?.body.input, input);
    if (stream) assert.match(await reply.text(), /"prompt_cache_diagnostics":\{"type":"cache_hit"\}/);
    else assert.deepEqual((await reply.json() as any).prompt_cache_diagnostics, diagnostics);
  }
});

test("cache writes survive Chat and Messages translation without double-counting input", async () => {
  await signIn();
  const usage = { input_tokens: 3000, output_tokens: 20, total_tokens: 3020,
    input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 1536, cache_write_tokens_details: { ttl_30m_tokens: 1536, ttl_12h_tokens: 0 } } };
  answer = () => sseResponse(textEvents("ok", usage));
  for (const stream of [true, false]) {
    const reply = await chat({ stream, stream_options: { include_usage: true } });
    const mapped = stream ? chunks(await reply.text()).at(-1).usage : (await reply.json() as any).usage;
    assert.equal(mapped.prompt_tokens, 3000);
    assert.deepEqual(mapped.prompt_tokens_details, usage.input_tokens_details);
    const message = await post("/v1/messages", { model: "chatgpt/gpt-test", max_tokens: 100, stream, messages: [{ role: "user", content: "hi" }] });
    const mappedMessage = stream
      ? (await message.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(event => event.type === "message_delta").usage
      : (await message.json() as any).usage;
    assert.deepEqual(mappedMessage, { input_tokens: 440, output_tokens: 20, cache_creation_input_tokens: 1536, cache_read_input_tokens: 1024 });
  }
});

test("chat without include_usage sends no usage chunk", async () => {
  await signIn();
  const text = await (await chat({ stream: true })).text();
  assert.ok(chunks(text).every(part => part.choices.length === 1 && part.usage === undefined));
});

test("chat, not streaming: one chat.completion with usage", async () => {
  await signIn();
  const reply = await chat({ stream: false });
  const body = await reply.json() as any;
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "chatgpt/gpt-test");
  assert.deepEqual(body.choices[0], { index: 0, message: { role: "assistant", content: "Hello there" }, finish_reason: "stop" });
  assert.deepEqual(body.usage, { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16,
    prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } });
});

test("chat history with a tool round trip is rebuilt as function_call / function_call_output, tools flattened with strict written out", async () => {
  await signIn();
  const tools = [{ type: "function", function: { name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } } },
    { type: "function", function: { name: "strict_one", parameters: { type: "object", properties: {} }, strict: true } }];
  await (await chat({ stream: true, tools, tool_choice: { type: "function", function: { name: "get_weather" } }, parallel_tool_calls: false,
    response_format: { type: "json_schema", json_schema: { name: "out", schema: { type: "object" }, strict: true } },
    messages: [
      { role: "system", content: "S1" }, { role: "developer", content: "S2" },
      { role: "user", content: [{ type: "text", text: "weather?" }, { type: "image_url", image_url: { url: "https://img.test/a.png", detail: "high" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
      { role: "assistant", content: "It is sunny." }, { role: "user", content: "thanks" }] })).text();
  const body = openai()[0].body;
  assert.equal(body.instructions, "S1\n\nS2");
  assert.deepEqual(body.input, [
    { role: "user", content: [{ type: "input_text", text: "weather?" }, { type: "input_image", image_url: "https://img.test/a.png", detail: "high" }] },
    { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
    { type: "function_call_output", call_id: "call_1", output: "sunny" },
    { role: "assistant", content: "It is sunny." }, { role: "user", content: "thanks" }]);
  assert.deepEqual(body.tools, [
    { type: "function", name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } }, strict: false },
    { type: "function", name: "strict_one", parameters: { type: "object", properties: {} }, strict: true }]);
  assert.deepEqual(body.tool_choice, { type: "function", name: "get_weather" });
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.text, { format: { type: "json_schema", name: "out", schema: { type: "object" }, strict: true } });
});

test("chat tool call stream: name first, arguments in pieces, finish_reason tool_calls; arguments before the item still arrive", async () => {
  await signIn();
  answer = () => sseResponse([
    { type: "response.created", response: { id: "resp_tool" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Thinking" },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_a", name: "get_weather", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: "{\"city\":" },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: "\"Paris\"}" },
    { type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_1", arguments: "{\"city\":\"Paris\"}" },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_a", name: "get_weather", arguments: "{\"city\":\"Paris\"}" } },
    { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_2", call_id: "call_b", name: "other", arguments: "" } },
    { type: "response.function_call_arguments.done", output_index: 2, item_id: "fc_2", arguments: "{}" },
    { type: "response.completed", response: { id: "resp_tool", status: "completed", output: [] } }]);
  const parts = chunks(await (await chat({ stream: true, tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }] })).text());
  const deltas = parts.map(part => part.choices[0]?.delta).filter(Boolean);
  assert.equal(deltas.filter(delta => delta.reasoning_content).map(delta => delta.reasoning_content).join(""), "Thinking");
  const calls = deltas.flatMap(delta => delta.tool_calls ?? []);
  assert.deepEqual(calls[0], { index: 0, id: "call_a", type: "function", function: { name: "get_weather", arguments: "" } });
  assert.equal(calls.filter(call => call.index === 0).map(call => call.function.arguments).join(""), "{\"city\":\"Paris\"}");
  assert.deepEqual(calls.find(call => call.index === 1 && call.id), { index: 1, id: "call_b", type: "function", function: { name: "other", arguments: "" } });
  assert.equal(calls.filter(call => call.index === 1).map(call => call.function.arguments).join(""), "{}");
  assert.equal(parts.find(part => part.choices[0]?.finish_reason).choices[0].finish_reason, "tool_calls");
});

test("a chat tool call that skips the item event is still opened, with its name, at the end", () => {
  const translator = new ChatStreamTranslator({ model: "m", includeUsage: false });
  const out = [
    ...translator.push({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_9", delta: "{\"a\":1}" }),
    ...translator.push({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_9", call_id: "call_z", name: "late", arguments: "{\"a\":1}" } }),
    ...translator.push({ type: "response.completed", response: { status: "completed" } })];
  const parts = chunks(out.join(""));
  const calls = parts.flatMap(part => part.choices[0]?.delta?.tool_calls ?? []);
  assert.deepEqual(calls.map(call => [call.id, call.function.name, call.function.arguments]), [["call_z", "late", ""], [undefined, undefined, "{\"a\":1}"]]);
});

test("chat tool calls in a non-streaming answer", async () => {
  await signIn();
  answer = () => sseResponse([
    { type: "response.created", response: { id: "resp_n" } },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_q", name: "f", arguments: "{\"x\":1}" } },
    { type: "response.completed", response: { id: "resp_n", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 2, output_tokens_details: { reasoning_tokens: 1 } } } }]);
  const body = await (await chat({ stream: false })).json() as any;
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.equal(body.choices[0].message.content, null);
  assert.deepEqual(body.choices[0].message.tool_calls, [{ id: "call_q", type: "function", function: { name: "f", arguments: "{\"x\":1}" } }]);
  assert.equal(body.usage.completion_tokens_details.reasoning_tokens, 1);
});

test("incomplete answers finish with length, or content_filter", () => {
  const length = chatCompletionFromResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }, "m");
  assert.equal(length.choices[0].finish_reason, "length");
  const filtered = chatCompletionFromResponse({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] }, "m");
  assert.equal(filtered.choices[0].finish_reason, "content_filter");
  assert.equal(chatUsage(undefined), undefined);
});

test("usage limit before anything is said is a real 429 with the documented code, for chat and responses, streamed or not", async () => {
  await signIn();
  const limit = { type: "response.failed", response: { id: "resp_x", status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } };
  answer = () => sseResponse([{ type: "response.created", response: { id: "resp_x" } }, limit]);
  for (const stream of [true, false]) {
    const reply = await chat({ stream });
    assert.equal(reply.status, 429, `chat stream=${stream}`);
    const body = await reply.json() as any;
    assert.equal(body.error.code, "subscription_sharing_usage_limit_exceeded");
    assert.match(body.error.message, /Manage usage/);
    assert.equal(reply.headers.get("cache-control"), "no-store");
  }
  assert.equal((await responses({ stream: false })).status, 429);
  answer = () => new Response(JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } }), { status: 429 });
  assert.equal((await chat({ stream: true })).status, 429);
});

test("a failure after the answer started arrives in the stream as an error frame and a clean end", async () => {
  await signIn();
  answer = () => sseResponse([
    { type: "response.created", response: { id: "resp_x" } },
    { type: "response.output_text.delta", output_index: 0, delta: "Half an ans" },
    { type: "response.failed", response: { status: "failed", error: { code: "subscription_sharing_usage_unavailable", message: "meter down" } } }]);
  const reply = await chat({ stream: true });
  assert.equal(reply.status, 200);
  const text = await reply.text();
  const parts = chunks(text);
  assert.equal(parts.at(-1).error.code, "subscription_sharing_usage_unavailable");
  assert.equal(frames(text).at(-1), "[DONE]");
  assert.ok(!parts.some(part => part.choices?.[0]?.finish_reason), "a failed answer must not look finished");
});

test("a stream that just stops is reported, not passed off as complete", async () => {
  await signIn();
  answer = () => sseResponse([{ type: "response.created", response: { id: "r" } }, { type: "response.output_text.delta", output_index: 0, delta: "partial" }]);
  const text = await (await chat({ stream: true })).text();
  assert.equal(chunks(text).at(-1).error.code, "stream_ended");
  answer = () => sseResponse([{ type: "response.created", response: { id: "r" } }]);
  assert.equal((await chat({ stream: false })).status, 502);
});

test("status codes: 401 and 5xx are never handed to the client as the client's own auth failure", async () => {
  await signIn();
  const cases: [number, any, number, string][] = [
    [401, { detail: "nope" }, 502, "http_401"], [403, { detail: "region" }, 403, "http_403"], [503, { detail: "off" }, 503, "http_503"],
    [403, { error: { code: "subscription_sharing_user_not_eligible", message: "x" } }, 403, "subscription_sharing_user_not_eligible"],
    [401, { error: { code: "subscription_sharing_invalid_user", message: "x" } }, 502, "subscription_sharing_invalid_user"],
    [500, { error: { message: "boom" } }, 502, "http_500"]];
  for (const [status, payload, expected, code] of cases) {
    answer = () => new Response(JSON.stringify(payload), { status, headers: { "x-request-id": "req_9" } });
    const reply = await chat({ stream: true });
    // A 401 gets one forced refresh and one retry first; the refresh below is allowed because the session is old.
    sqlite.prepare("UPDATE chatgpt_connection SET refreshed_at = ?").run(Date.now() - 3600_000);
    assert.equal(reply.status, expected, `${status} ${code}`);
    const body = await reply.json() as any;
    assert.equal(body.error.code, code);
    assert.equal(body.error.request_id, "req_9");
  }
});

test("a 401 refreshes once and retries once; a recently refreshed token is not refreshed again", async () => {
  await signIn({ refreshedAgo: 3600_000 });
  answer = (_body, headers, nth) => nth === 1 ? new Response("{}", { status: 401 }) : sseResponse(textEvents("ok"));
  const reply = await chat({ stream: false });
  assert.equal(reply.status, 200);
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].grant_type, "refresh_token");
  assert.equal(openai().length, 2);
  assert.equal(openai()[0].headers.authorization, "Bearer access-live");
  assert.equal(openai()[1].headers.authorization, "Bearer access-renewed");

  answer = () => new Response("{}", { status: 401 });
  asked = []; tokenCalls = [];
  assert.equal((await chat({ stream: false })).status, 502);
  assert.equal(tokenCalls.length, 0, "just refreshed: do not refresh again for the same failure");
  assert.equal(openai().length, 2, "one try, one retry, no more");
});

test("an unsupported-capability 400 drops that field once, remembers it, and the next request leaves it out", async () => {
  await signIn();
  answer = (body, _headers, nth) => body.reasoning
    ? new Response(JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability", param: "reasoning", message: "no" } }), { status: 400 })
    : sseResponse(textEvents("fine"));
  const first = await chat({ stream: false, reasoning_effort: "high" });
  assert.equal(first.status, 200);
  assert.equal(openai().length, 2);
  assert.ok("reasoning" in openai()[0].body && !("reasoning" in openai()[1].body));
  assert.equal(first.headers.get("x-aelios-normalized"), "1");
  asked = [];
  assert.equal((await chat({ stream: false, reasoning_effort: "high" })).status, 200);
  assert.equal(openai().length, 1);
  assert.ok(!("reasoning" in openai()[0].body));
  // The request's own spine is never dropped, however it is named.
  answer = () => new Response(JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability", param: "input", message: "no" } }), { status: 400 });
  asked = [];
  const refused = await chat({ stream: false });
  assert.equal(refused.status, 400);
  assert.equal(openai().length, 1);
  assert.equal(((await refused.json()) as any).error.param, "input");
});

test("signed out, signed in without the plan, or needing a new sign-in: a clear error, and ChatGPT is never called", async () => {
  let reply = await chat({ stream: false });
  assert.equal(reply.status, 503);
  assert.equal(((await reply.json()) as any).error.code, "chatgpt_not_connected");
  await signIn({ planUsage: false });
  reply = await chat({ stream: false });
  assert.equal(reply.status, 403);
  assert.equal(((await reply.json()) as any).error.code, "chatgpt_plan_disabled");
  sqlite.prepare("UPDATE chatgpt_connection SET status = 'needs_login'").run();
  reply = await chat({ stream: false });
  assert.equal(reply.status, 503);
  assert.equal(((await reply.json()) as any).error.code, "chatgpt_needs_login");
  assert.equal(openai().length, 0);
});

test("requests ChatGPT plan usage cannot take are refused up front: nothing is sent, nothing is recorded", async () => {
  await signIn();
  const refusals: [string, any, RegExp][] = [
    ["/v1/responses", { input: "hi", tools: [{ type: "image_generation" }] }, /image_generation/],
    ["/v1/responses", { input: "hi", tools: [{ type: "mcp", server_label: "x" }] }, /mcp/],
    ["/v1/responses", { input: "hi", previous_response_id: "resp_1" }, /previous_response_id/],
    ["/v1/responses", { input: [{ type: "item_reference", id: "i" }] }, /item/],
    ["/v1/chat/completions", { messages: [{ role: "user", content: "hi" }], n: 2 }, /\bn\b/],
    ["/v1/chat/completions", { messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "x", format: "wav" } }] }] }, /input_audio/],
    ["/v1/chat/completions", { messages: [{ role: "user", content: "hi" }], tools: [{ type: "code_interpreter" }] }, /code_interpreter/],
    ["/v1/messages", { messages: [{ role: "user", content: "hi" }], max_tokens: 10, tools: [{ type: "bash_20250124", name: "bash" }] }, /bash_20250124/],
    ["/v1/messages", { messages: [{ role: "user", content: "hi" }], max_tokens: 10, mcp_servers: [{ type: "url", url: "https://x.test/mcp", name: "x" }] }, /MCP/],
    ["/v1/messages", { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "server_tool_use", id: "s", name: "web_search", input: {} }] },
      { role: "user", content: "and?" }], max_tokens: 10 }, /server_tool_use/]];
  for (const [path, body, pattern] of refusals) {
    const reply = await post(path, { model: "chatgpt/gpt-test", ...body });
    assert.equal(reply.status, 400, `${path} ${JSON.stringify(body).slice(0, 60)}`);
    assert.match(JSON.stringify(await reply.json()), pattern);
  }
  assert.equal(openai().length, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get()?.n, 0);
});

test("web search and function tools go through; hosted-tool names are matched exactly", async () => {
  await signIn();
  const reply = await responses({ stream: true, tools: [{ type: "web_search" }, { type: "function", name: "f", parameters: {} }, { type: "custom", name: "c" }] });
  assert.equal(reply.status, 200);
  await reply.text();
  assert.deepEqual(openai()[0].body.tools.map((tool: any) => tool.type), ["web_search", "function", "custom"]);
});

test("other models are untouched: they still go to the CF upstream with the CF token", async () => {
  await signIn();
  const reply = await post("/v1/chat/completions", { model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] });
  assert.equal(reply.status, 200);
  assert.equal(openai().length, 0);
  const cf = need(asked.find(item => item.url.includes("upstream.test")), "CF upstream call");
  assert.equal(cf.headers.authorization, "Bearer cf-token-must-not-leak");
});

test("a main model on this route is recalled-for and recorded like any other, under the name the caller used", async () => {
  await signIn();
  const reply = await chat({ stream: true, messages: [{ role: "user", content: "我今天去了海边" }] });
  await reply.text(); await Promise.all(pending);
  assert.equal(reply.headers.get("x-aelios-memory") !== "off", true);
  const exchange = queue.find(item => item?.assistantText !== undefined);
  assert.ok(exchange, "the finished exchange was handed to the recorder");
  assert.equal(exchange.assistantText, "Hello there");
  assert.equal(exchange.model, "chatgpt/gpt-test");
  assert.equal(exchange.completion, "complete");
  assert.equal(exchange.provider, "chatgpt");
});

test("a model outside the main list passes through quietly", async () => {
  await signIn();
  setConfig(true, ["something-else"]);
  const reply = await chat({ stream: false });
  assert.equal(reply.headers.get("x-aelios-memory"), "off");
  assert.equal(reply.status, 200);
});

test("/v1/models lists the plan's models next to the upstream's, and hides the ones ChatGPT does not list", async () => {
  await signIn();
  const reply = await worker.fetch(new Request("https://aelios.test/v1/models", { headers: { authorization: "Bearer owner-key" } }), env, ctx);
  const body = await reply.json() as any;
  assert.deepEqual(body.data.map((item: any) => item.id), ["openai/gpt-4o", "chatgpt/gpt-test", "chatgpt/gpt-two"]);
  assert.equal(body.data[1].display_name, "GPT Test");
  const model = openai(); assert.equal(model.length, 0);
  assert.equal(asked.filter(item => item.url === MODELS).length, 1);
  assert.equal(need(asked.find(item => item.url === MODELS), "models call").headers.authorization, "Bearer access-live");
});

test("/v1/models is unchanged when nothing is connected, and survives ChatGPT being unreachable", async () => {
  const lookup = async () => (await (await worker.fetch(new Request("https://aelios.test/v1/models", { headers: { authorization: "Bearer owner-key" } }), env, ctx)).json() as any);
  assert.ok(!(await lookup()).data.some((item: any) => String(item.id).startsWith("chatgpt/")));
  await signIn();
  models = () => new Response("{}", { status: 503 });
  const body = await lookup();
  assert.ok(Array.isArray(body.data));
  assert.ok(!body.data.some((item: any) => String(item.id).startsWith("chatgpt/")));
});

test("toChatGptRequest: the request spine is always stateless and streamed", () => {
  for (const protocol of ["chat", "messages", "responses"] as const) {
    const payload = protocol === "chat" ? { model: "x", messages: [{ role: "user", content: "hi" }], store: true, stream: false }
      : protocol === "messages" ? { model: "x", messages: [{ role: "user", content: "hi" }], max_tokens: 5, stream: false }
      : { model: "x", input: "hi", store: true, stream: false };
    const { body } = toChatGptRequest(payload, protocol, "slug");
    assert.equal(body.model, "slug");
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
  }
});

const messages = (body: any, headers: any = {}) => post("/v1/messages", { model: "chatgpt/gpt-test", max_tokens: 100, messages: [{ role: "user", content: "hi" }], ...body }, { "anthropic-version": "2023-06-01", ...headers });
/** Anthropic SSE: `event: x` + `data: {...}` pairs. */
const anthropicEvents = (text: string) => text.split("\n\n").map(part => part.trim()).filter(Boolean).map(part => {
  const lines = part.split("\n");
  return { event: lines[0].replace(/^event: /, ""), data: JSON.parse(lines.slice(1).join("\n").replace(/^data: /, "")) };
});

test("messages, streaming: Anthropic events in order, the usage Anthropic counts, and the request rebuilt as Responses", async () => {
  await signIn();
  const reply = await messages({ stream: true, temperature: 0.3, top_k: 5, stop_sequences: ["x"], metadata: { user_id: "u" },
    system: [{ type: "text", text: "You are kind.", cache_control: { type: "ephemeral" } }, { type: "text", text: "Be brief." }],
    tools: [{ name: "get_weather", description: "Weather", input_schema: { type: "object", properties: { city: { type: "string" } } }, cache_control: { type: "ephemeral" } }],
    tool_choice: { type: "any", disable_parallel_tool_use: true } });
  assert.equal(reply.status, 200);
  assert.match(reply.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(reply.headers.get("x-aelios-provider"), "chatgpt");
  const events = anthropicEvents(await reply.text()); await Promise.all(pending);
  assert.deepEqual(events.map(item => item.event), ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  assert.ok(events.every(item => item.data.type === item.event));
  const start = events[0].data.message;
  assert.equal(start.role, "assistant");
  assert.equal(start.model, "chatgpt/gpt-test");
  assert.deepEqual(start.content, []);
  assert.equal(start.id, "msg_abc");
  assert.deepEqual(events[1].data, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  assert.equal(events.filter(item => item.data.delta?.type === "text_delta").map(item => item.data.delta.text).join(""), "Hello there");
  assert.deepEqual(events[5].data.delta, { stop_reason: "end_turn", stop_sequence: null });
  assert.deepEqual(events[5].data.usage, { input_tokens: 11, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  const body = openai()[0].body;
  assert.equal(body.instructions, "You are kind.\n\nBe brief.");
  assert.deepEqual(body.input, [{ role: "user", content: "hi" }]);
  assert.deepEqual(body.tools, [{ type: "function", name: "get_weather", description: "Weather", strict: false,
    parameters: { type: "object", properties: { city: { type: "string" } } } }]);
  assert.equal(body.tool_choice, "required");
  assert.equal(body.parallel_tool_calls, false);
  assert.ok(!("reasoning" in body), "no thinking asked for, none requested");
  for (const gone of ["messages", "system", "max_tokens", "temperature", "top_k", "stop_sequences", "metadata", "thinking"]) assert.ok(!(gone in body), gone);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.model, "gpt-test");
});

test("messages history: images, documents, thinking, tool_use and tool_result are rebuilt in order", async () => {
  await signIn();
  const reply = await messages({ stream: true, messages: [
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "document", title: "a.pdf", source: { type: "base64", media_type: "application/pdf", data: "JVBER" } },
      { type: "image", source: { type: "url", url: "https://img.test/b.png" } }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "text", text: "Let me check." },
      { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "sunny" }, { type: "text", text: "18C" }] },
      { type: "text", text: "thanks" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "noop", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } }] }] },
    { role: "assistant", content: "plain string turn" }, { role: "user", content: "and again" }] });
  await reply.text();
  assert.deepEqual(openai()[0].body.input, [
    { role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
      { type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64,JVBER" },
      { type: "input_image", image_url: "https://img.test/b.png", detail: "auto" }] },
    { role: "assistant", content: "Let me check." },
    { type: "function_call", call_id: "toolu_1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
    { type: "function_call_output", call_id: "toolu_1", output: "sunny\n18C" },
    { role: "user", content: [{ type: "input_text", text: "thanks" }] },
    { type: "function_call", call_id: "toolu_2", name: "noop", arguments: "{}" },
    { type: "function_call_output", call_id: "toolu_2", output: [{ type: "input_image", image_url: "data:image/png;base64,BBBB", detail: "auto" }] },
    { role: "assistant", content: "plain string turn" }, { role: "user", content: "and again" }]);
  assert.ok(String(reply.headers.get("x-aelios-normalized")) !== "0");
});

test("messages tool call stream: thinking, text, then a tool_use block whose input arrives as partial JSON; stop_reason tool_use", async () => {
  await signIn();
  answer = () => sseResponse([
    { type: "response.created", response: { id: "resp_tool" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
    { type: "response.reasoning_summary_part.added", output_index: 0, summary_index: 0 },
    { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "Think" },
    { type: "response.reasoning_summary_part.added", output_index: 0, summary_index: 1 },
    { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 1, delta: "More" },
    { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
    { type: "response.output_text.delta", output_index: 1, item_id: "msg_1", delta: "Checking." },
    { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_a", name: "get_weather", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_1", delta: "{\"city\":" },
    { type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_1", delta: "\"Paris\"}" },
    { type: "response.function_call_arguments.done", output_index: 2, item_id: "fc_1", arguments: "{\"city\":\"Paris\"}" },
    { type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_a", name: "get_weather", arguments: "{\"city\":\"Paris\"}" } },
    { type: "response.completed", response: { id: "resp_tool", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } } } }]);
  const reply = await messages({ stream: true, max_tokens: 20000, thinking: { type: "enabled", budget_tokens: 8000 },
    tools: [{ name: "get_weather", input_schema: { type: "object", properties: {} } }] });
  const events = anthropicEvents(await reply.text());
  assert.deepEqual(openai()[0].body.reasoning, { effort: "medium", summary: "auto" });
  const starts = events.filter(item => item.event === "content_block_start").map(item => [item.data.index, item.data.content_block]);
  assert.deepEqual(starts, [
    [0, { type: "thinking", thinking: "", signature: "" }], [1, { type: "text", text: "" }],
    [2, { type: "tool_use", id: "call_a", name: "get_weather", input: {} }]]);
  assert.equal(events.filter(item => item.data.delta?.type === "thinking_delta").map(item => item.data.delta.thinking).join(""), "Think\n\nMore");
  assert.equal(events.filter(item => item.data.delta?.type === "input_json_delta").map(item => item.data.delta.partial_json).join(""), "{\"city\":\"Paris\"}");
  // Blocks are strictly one after another: every stop comes before the next start, and every start has its stop.
  const order = events.filter(item => item.event.startsWith("content_block_") && item.event !== "content_block_delta").map(item => `${item.event}:${item.data.index}`);
  assert.deepEqual(order, ["content_block_start:0", "content_block_stop:0", "content_block_start:1", "content_block_stop:1", "content_block_start:2", "content_block_stop:2"]);
  const last = need(events.at(-2)).data;
  assert.equal(last.delta.stop_reason, "tool_use");
  assert.deepEqual(last.usage, { input_tokens: 60, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 40 });
  assert.equal(need(events.at(-1)).event, "message_stop");
});

test("messages: a call whose arguments come before its item, or with no item at all, still becomes one tool_use block", async () => {
  const translator = new MessagesStreamTranslator({ model: "m" });
  const out = [
    ...translator.push({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_9", delta: "{\"a\":" }),
    ...translator.push({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_9", delta: "1}" }),
    ...translator.push({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_9", call_id: "call_z", name: "late", arguments: "{\"a\":1}" } }),
    ...translator.push({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_8", delta: "{}" }),
    ...translator.push({ type: "response.completed", response: { status: "completed" } })];
  const events = anthropicEvents(out.join(""));
  assert.deepEqual(events.filter(item => item.event === "content_block_start").map(item => item.data.content_block.name), ["late"]);
  assert.equal(events.filter(item => item.data.delta?.type === "input_json_delta").map(item => item.data.delta.partial_json).join(""), "{\"a\":1}");
  assert.equal(events.filter(item => item.event === "content_block_start").length, events.filter(item => item.event === "content_block_stop").length);
  assert.equal(need(events.at(-2)).data.delta.stop_reason, "tool_use");
});

test("messages, not streaming: one message with thinking, text and tool_use, and Anthropic's own token counting", async () => {
  await signIn();
  answer = () => sseResponse([
    { type: "response.created", response: { id: "resp_n" } },
    { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", summary: [{ type: "summary_text", text: "Because." }] } },
    { type: "response.output_item.done", output_index: 1, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Sure." }] } },
    { type: "response.output_item.done", output_index: 2, item: { type: "function_call", call_id: "call_q", name: "f", arguments: "{\"x\":1}" } },
    { type: "response.completed", response: { id: "resp_n", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 40 } } } }]);
  const reply = await messages({ stream: false });
  assert.equal(reply.status, 200);
  const body = await reply.json() as any;
  assert.equal(body.type, "message");
  assert.equal(body.role, "assistant");
  assert.equal(body.model, "chatgpt/gpt-test");
  assert.deepEqual(body.content, [{ type: "thinking", thinking: "Because.", signature: THINKING_SIGNATURE }, { type: "text", text: "Sure." },
    { type: "tool_use", id: "call_q", name: "f", input: { x: 1 } }]);
  assert.equal(body.stop_reason, "tool_use");
  assert.equal(body.stop_sequence, null);
  assert.deepEqual(body.usage, { input_tokens: 60, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 40 });
});

test("messages: incomplete answers stop with max_tokens or refusal", () => {
  assert.equal(messageFromResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }, "m").stop_reason, "max_tokens");
  assert.equal(messageFromResponse({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] }, "m").stop_reason, "refusal");
  assert.equal(messageFromResponse({ status: "completed", output: [{ type: "function_call", call_id: "c", name: "f", arguments: "not json" }] }, "m").content[0].input.constructor, Object);
});

test("messages errors wear Anthropic's envelope: before the answer a real status, after it an error event, never a 401", async () => {
  await signIn();
  const limit = { type: "response.failed", response: { id: "r", status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } };
  answer = () => sseResponse([{ type: "response.created", response: { id: "r" } }, limit]);
  for (const stream of [true, false]) {
    const reply = await messages({ stream });
    assert.equal(reply.status, 429, `stream=${stream}`);
    const body = await reply.json() as any;
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "rate_limit_error");
    assert.match(body.error.message, /Manage usage/);
    assert.ok(!("code" in body.error) && !("param" in body.error));
  }
  answer = () => new Response(JSON.stringify({ detail: "nope" }), { status: 401, headers: { "x-request-id": "req_a" } });
  sqlite.prepare("UPDATE chatgpt_connection SET refreshed_at = ?").run(Date.now() - 3600_000);
  const unauthorized = await messages({ stream: true });
  assert.equal(unauthorized.status, 502);
  const unauthorizedBody = await unauthorized.json() as any;
  assert.equal(unauthorizedBody.error.type, "api_error");
  assert.equal(unauthorizedBody.request_id, "req_a");

  answer = () => sseResponse([{ type: "response.created", response: { id: "r" } }, { type: "response.output_text.delta", output_index: 0, delta: "Half" },
    { type: "response.failed", response: { status: "failed", error: { code: "subscription_sharing_usage_unavailable", message: "meter" } } }]);
  const mid = await messages({ stream: true });
  assert.equal(mid.status, 200);
  const events = anthropicEvents(await mid.text());
  assert.equal(need(events.at(-1)).event, "error");
  assert.equal(need(events.at(-1)).data.error.type, "overloaded_error");
  assert.ok(!events.some(item => item.event === "message_stop"), "a failed answer must not look finished");

  answer = () => sseResponse([{ type: "response.created", response: { id: "r" } }, { type: "response.output_text.delta", output_index: 0, delta: "partial" }]);
  assert.equal(need(anthropicEvents(await (await messages({ stream: true })).text()).at(-1)).event, "error");

  sqlite.prepare("UPDATE chatgpt_connection SET status = 'needs_login'").run();
  const signedOut = await messages({ stream: false });
  assert.equal(signedOut.status, 503);
  assert.deepEqual(Object.keys(await signedOut.json() as any).sort(), ["error", "type"]);
});

test("messages: the Anthropic thinking-binding policy is not applied to a ChatGPT answer, even for an identity set to drop_block", async () => {
  await signIn();
  await (await messages({ stream: true })).text();
  const body = openai()[0].body;
  assert.ok(!("reasoning" in body), "the caller asked for no thinking and got none injected");
  assert.ok(!JSON.stringify(body).includes("block_binding"));
  assert.ok(!("anthropic-beta" in openai()[0].headers));
  assert.ok(!("anthropic-version" in openai()[0].headers));
});

test("messages: thinking and effort settings become a reasoning effort and summary; disabled thinking asks for nothing", () => {
  const ask = (extra: any) => toChatGptRequest({ model: "x", messages: [{ role: "user", content: "hi" }], max_tokens: 5, ...extra }, "messages", "s").body.reasoning;
  assert.deepEqual(ask({ thinking: { type: "enabled", budget_tokens: 2000 } }), { effort: "low", summary: "auto" });
  assert.deepEqual(ask({ thinking: { type: "enabled", budget_tokens: 12000 } }), { effort: "medium", summary: "auto" });
  assert.deepEqual(ask({ thinking: { type: "enabled", budget_tokens: 60000 } }), { effort: "high", summary: "auto" });
  assert.deepEqual(ask({ thinking: { type: "adaptive" } }), { summary: "auto" });
  assert.deepEqual(ask({ thinking: { type: "adaptive" }, output_config: { effort: "max" } }), { effort: "high", summary: "auto" });
  assert.deepEqual(ask({ output_config: { effort: "low" } }), { effort: "low" });
  assert.equal(ask({ thinking: { type: "disabled" } }), undefined);
  assert.equal(ask({}), undefined);
});

test("messages: structured output and the web search tool map across; tool_choice variants", () => {
  const build = (extra: any) => toChatGptRequest({ model: "x", messages: [{ role: "user", content: "hi" }], max_tokens: 5, ...extra }, "messages", "s").body;
  // Strict mode only when the schema already fits it (closed objects, every property required); else the schema just guides.
  assert.deepEqual(build({ output_config: { format: { type: "json_schema", schema: { type: "object" } } } }).text,
    { format: { type: "json_schema", name: "output", schema: { type: "object" }, strict: false } });
  const closed = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };
  assert.equal(build({ output_config: { format: { type: "json_schema", schema: closed } } }).text.format.strict, true);
  const optional = { type: "object", properties: { title: { type: "string" }, note: { type: "string" } }, required: ["title"], additionalProperties: false };
  assert.equal(build({ output_config: { format: { type: "json_schema", schema: optional } } }).text.format.strict, false);
  const nested = { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { a: { type: "string" } }, required: [] } } },
    required: ["items"], additionalProperties: false };
  assert.equal(build({ output_config: { format: { type: "json_schema", schema: nested } } }).text.format.strict, false);
  assert.deepEqual(build({ tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }, { name: "f", input_schema: {} }] }).tools,
    [{ type: "web_search" }, { type: "function", name: "f", description: undefined, parameters: {}, strict: false }]);
  assert.equal(build({ tool_choice: { type: "auto" } }).tool_choice, "auto");
  assert.equal(build({ tool_choice: { type: "none" } }).tool_choice, "none");
  assert.deepEqual(build({ tool_choice: { type: "tool", name: "f" } }).tool_choice, { type: "function", name: "f" });
  assert.ok(!("parallel_tool_calls" in build({ tool_choice: { type: "auto" } })));
});

test("messages on a main model is recalled-for and recorded from the Anthropic stream, under the caller's model name", async () => {
  await signIn();
  const reply = await messages({ stream: true, messages: [{ role: "user", content: [{ type: "text", text: "我今天去了海边" }] }] });
  await reply.text(); await Promise.all(pending);
  const exchange = queue.find(item => item?.assistantText !== undefined);
  assert.ok(exchange, "the finished exchange was handed to the recorder");
  assert.equal(exchange.assistantText, "Hello there");
  assert.equal(exchange.model, "chatgpt/gpt-test");
  assert.equal(exchange.completion, "complete");
  assert.equal(exchange.provider, "chatgpt");
  const second = await messages({ stream: false, messages: [{ role: "user", content: "再说一次" }] });
  await second.json(); await Promise.all(pending);
  assert.equal(queue.filter(item => item?.assistantText === "Hello there").length, 2);
});

function precious(namespace: string, content: string) {
  sqlite.prepare("INSERT INTO precious (id, namespace, content, created_at) VALUES (?, ?, ?, ?)").run(`${namespace}-${content.slice(0, 24)}`, namespace, content, "2026-09-06");
}

test("memory recall reaches ChatGPT on the last user message in all three protocols, and another space's memory stays out", async () => {
  await signIn();
  precious("partner-a", "喜欢 Cloudflare");
  precious("partner-b", "other identity private memory");
  const question = "我们喜欢什么？";
  const sends: [string, () => Promise<Response>, (body: any) => string][] = [
    ["chat", () => chat({ stream: false, messages: [{ role: "system", content: "S" }, { role: "user", content: question }] }), body => JSON.stringify(body.input.at(-1))],
    ["messages", () => messages({ stream: false, messages: [{ role: "user", content: [{ type: "text", text: question }] }] }), body => JSON.stringify(body.input.at(-1))],
    ["responses", () => responses({ stream: false, input: question }), body => JSON.stringify(body.input.at(-1))]];
  for (const [name, send, lastItem] of sends) {
    asked = [];
    const reply = await send();
    assert.equal(reply.status, 200, name);
    assert.equal(reply.headers.get("x-aelios-memory"), "injected", name);
    const body = openai()[0].body;
    assert.match(lastItem(body), /喜欢 Cloudflare/, `${name}: the memory rides the last user message`);
    assert.doesNotMatch(JSON.stringify(body), /other identity/, `${name}: another space's memory stays out`);
    assert.ok(!/喜欢 Cloudflare/.test(String(body.instructions ?? "")), `${name}: the system text is left alone, so it stays cacheable`);
    assert.match(lastItem(body), /我们喜欢什么/, `${name}: the question itself is still there`);
  }
});

test("only a main model carries memory: the same question on a model outside the list is sent as it came", async () => {
  await signIn();
  precious("partner-a", "喜欢 Cloudflare");
  setConfig(true, ["something-else"]);
  const reply = await chat({ stream: false, messages: [{ role: "user", content: "我们喜欢什么？" }] });
  assert.equal(reply.headers.get("x-aelios-memory"), "off");
  assert.doesNotMatch(JSON.stringify(openai()[0].body), /喜欢 Cloudflare/);
});

test("the nightly diary runs on the ChatGPT plan when DIARY_MODEL says so: plan token, JSON mode, nothing from CF", async () => {
  await signIn();
  const insert = sqlite.prepare("INSERT INTO messages (id, conversation_id, namespace, role, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run("m1", "c", "default", "user", "今天去了海边", "test", "2026-10-14T01:00:00.000Z");
  insert.run("m2", "c", "default", "assistant", "听起来很舒服", "test", "2026-10-14T01:01:00.000Z");
  answer = () => sseResponse(textEvents(JSON.stringify({ title: "海边的一天", summary: "她去了海边。", source_message_ids: ["m1"] })));
  const stats = await runDiaryWriter({ ...env, DIARY_MODEL: "chatgpt/gpt-test", DREAM_TIME_ZONE: "Asia/Singapore" }, "default", "2026-10-14");
  assert.equal(stats.ran, true, JSON.stringify(stats));
  assert.equal(openai().length, 1);
  const call = openai()[0];
  assert.equal(call.headers.authorization, "Bearer access-live");
  assert.ok(!JSON.stringify(call.headers).includes("cf-token-must-not-leak"));
  assert.equal(call.body.model, "gpt-test");
  assert.equal(call.body.store, false);
  assert.deepEqual(call.body.text, { format: { type: "json_object" } });
  assert.match(String(call.body.instructions), /JSON/);
  assert.match(JSON.stringify(call.body.input), /今天去了海边/);
  for (const gone of ["temperature", "max_tokens", "messages", "response_format"]) assert.ok(!(gone in call.body), gone);
  const row = sqlite.prepare("SELECT title, summary FROM daily_log WHERE namespace = 'default' AND date = '2026-10-14'").get() as any;
  assert.equal(row.title, "海边的一天");
  assert.equal(asked.filter(item => item.url.includes("upstream.test")).length, 0);
});

test("a background call on the plan reads like any other model call: text back, the plan's refusal as an error with its message", async () => {
  await signIn();
  const request = { model: "chatgpt/gpt-test", messages: [{ role: "user", content: "hi" }], temperature: 0, max_tokens: 50, stream: false };
  assert.equal(await callModelWithRetry(env, { model: "chatgpt/gpt-test", prompt: "give JSON", backoffMs: [] }), "Hello there");
  const direct = await callOpenAICompat(env, request as never);
  assert.equal(((await direct.json()) as any).choices[0].message.content, "Hello there");
  answer = () => sseResponse([{ type: "response.created", response: { id: "r" } },
    { type: "response.failed", response: { status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } }]);
  await assert.rejects(callModelWithRetry(env, { model: "chatgpt/gpt-test", prompt: "give JSON", backoffMs: [] }),
    (error: any) => error instanceof ModelCallError && error.status === 429 && /Manage usage/.test(String(error.detail)));
  sqlite.prepare("UPDATE chatgpt_connection SET status = 'needs_login'").run();
  await assert.rejects(callModelWithRetry(env, { model: "chatgpt/gpt-test", prompt: "x", backoffMs: [] }),
    (error: any) => error instanceof ModelCallError && error.status === 503 && /Sign in again/.test(String(error.detail)));
});

test("JSON mode on the plan: when the prompt only says JSON in its system text, the word is added where the check looks", () => {
  const build = (messages: any[]) => toChatGptRequest({ model: "x", messages, response_format: { type: "json_object" } }, "chat", "s").body;
  const bare = build([{ role: "system", content: "You output JSON." }, { role: "user", content: "把这个整理一下" }]);
  assert.equal(bare.instructions, "You output JSON.");
  assert.deepEqual(bare.input[0], { role: "developer", content: "Respond with a single JSON object." });
  assert.equal(bare.input.length, 2);
  const said = build([{ role: "user", content: "请输出 JSON" }]);
  assert.deepEqual(said.input, [{ role: "user", content: "请输出 JSON" }]);
});

test("a stored session that cannot be opened (owner key rotated) reads as sign in again, not a crash", async () => {
  await signIn();
  env.CHATBOX_API_KEY = "owner-key";   // the request is authenticated with the old key...
  const key = "rotated";
  sqlite.prepare("UPDATE chatgpt_connection SET access_token_enc = ?").run(await seal({ ...env, CHATBOX_API_KEY: key }, "access-live"));
  const reply = await chat({ stream: false });
  assert.equal(reply.status, 503);
  assert.equal(((await reply.json()) as any).error.code, "chatgpt_needs_login");
});

test("an unsupported field is learned per model, and never for the fields that carry the request's meaning", async () => {
  await signIn();
  answer = body => body.reasoning
    ? new Response(JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability", param: "reasoning", message: "no" } }), { status: 400 })
    : sseResponse(textEvents("ok"));
  assert.equal((await chat({ stream: false, reasoning_effort: "high" })).status, 200);   // gpt-test learns it
  asked = [];
  answer = () => sseResponse(textEvents("ok"));
  const other = await post("/v1/chat/completions", { model: "chatgpt/gpt-two", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high", stream: false });
  assert.equal(other.status, 200);
  assert.deepEqual(openai()[0].body.reasoning, { effort: "high", summary: "auto" }, "what one model refused is still sent to another");
  answer = () => new Response(JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability", param: "tools", message: "no" } }), { status: 400 });
  asked = [];
  const tools = [{ type: "function", function: { name: "f", parameters: {} } }];
  assert.equal((await chat({ stream: false, tools })).status, 400, "the caller hears about it; the tools are not quietly dropped");
  assert.equal(openai().length, 1);
  answer = () => sseResponse(textEvents("ok"));
  asked = [];
  await chat({ stream: false, tools });
  assert.ok(openai()[0].body.tools, "and the next request still carries its tools");
});

test("failures inside the stream get a status that says what kind, and Retry-After is passed on", async () => {
  await signIn();
  const failWith = (code: string) => { answer = () => sseResponse([{ type: "response.created", response: { id: "r" } },
    { type: "response.failed", response: { status: "failed", error: { code, message: "m" } } }]); };
  for (const [code, status] of [["rate_limit_exceeded", 429], ["invalid_prompt", 400], ["invalid_image_url", 400], ["context_length_exceeded", 400],
      ["server_error", 502], ["server_is_overloaded", 503]] as const) {
    failWith(code);
    assert.equal((await chat({ stream: true })).status, status, `chat ${code}`);
    assert.equal((await responses({ stream: false })).status, status, `responses ${code}`);
    assert.equal((await messages({ stream: true })).status, status, `messages ${code}`);
  }
  answer = () => new Response(JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "x" } }), { status: 429, headers: { "retry-after": "120" } });
  const reply = await chat({ stream: false });
  assert.equal(reply.status, 429);
  assert.equal(reply.headers.get("retry-after"), "120");
});

test("a 401's wording is not repeated to the client in case it echoes the credential; other messages pass the secret filter", async () => {
  await signIn();
  sqlite.prepare("UPDATE chatgpt_connection SET refreshed_at = ?").run(Date.now() - 3600_000);
  answer = () => new Response(JSON.stringify({ error: { message: "Incorrect API key provided: sk-proj-abc********wxyz.", code: "invalid_api_key" } }), { status: 401 });
  const reply = await chat({ stream: false });
  assert.equal(reply.status, 502);
  assert.doesNotMatch(JSON.stringify(await reply.json()), /sk-|Incorrect API key|wxyz/);
  answer = () => new Response(JSON.stringify({ error: { message: "bad header Bearer abcdefghijklmnopqrstuvwxyz0123456789", code: "x" } }), { status: 400 });
  assert.doesNotMatch(JSON.stringify(await (await chat({ stream: false })).json()), /abcdefghijklmnopqrstuvwxyz/);
});

test("previous_response_id: null means no state at all, and a chat custom tool is flattened to the Responses shape", async () => {
  await signIn();
  assert.equal((await responses({ stream: false, previous_response_id: null })).status, 200);
  assert.ok(!("previous_response_id" in openai()[0].body));
  asked = [];
  await chat({ stream: false, tools: [{ type: "custom", custom: { name: "patch", format: { type: "text" } } }] });
  assert.deepEqual(openai()[0].body.tools, [{ type: "custom", name: "patch", format: { type: "text" } }]);
});

test("a stream that carries the answer only in its final response object still delivers it, in chat and in messages", async () => {
  await signIn();
  answer = () => sseResponse([{ type: "response.created", response: { id: "resp_x" } },
    { type: "response.completed", response: { id: "resp_x", status: "completed", output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "why" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "All at once." }] },
      { type: "function_call", call_id: "call_1", name: "f", arguments: "{\"a\":1}" }] } }]);
  const parts = chunks(await (await chat({ stream: true })).text());
  const deltas = parts.map(part => part.choices[0]?.delta).filter(Boolean);
  assert.equal(deltas.map(delta => delta.content ?? "").join(""), "All at once.");
  assert.equal(deltas.map(delta => delta.reasoning_content ?? "").join(""), "why");
  const calls = deltas.flatMap(delta => delta.tool_calls ?? []);
  assert.deepEqual(calls[0], { index: 0, id: "call_1", type: "function", function: { name: "f", arguments: "" } });
  assert.equal(calls.slice(1).map(call => call.function.arguments).join(""), "{\"a\":1}");
  assert.equal(parts.find(part => part.choices[0]?.finish_reason).choices[0].finish_reason, "tool_calls");

  const events = anthropicEvents(await (await messages({ stream: true })).text());
  assert.equal(events.filter(item => item.data.delta?.type === "text_delta").map(item => item.data.delta.text).join(""), "All at once.");
  assert.equal(events.filter(item => item.data.delta?.type === "thinking_delta").map(item => item.data.delta.thinking).join(""), "why");
  assert.deepEqual(events.filter(item => item.event === "content_block_start").map(item => item.data.content_block.type), ["thinking", "text", "tool_use"]);
  assert.equal(events.filter(item => item.data.delta?.type === "input_json_delta").map(item => item.data.delta.partial_json).join(""), "{\"a\":1}");
  assert.equal(need(events.at(-2)).data.delta.stop_reason, "tool_use");
});

test("a thinking block the route returned can be replayed in the next request, and is dropped on the way to ChatGPT", async () => {
  await signIn();
  answer = () => sseResponse([{ type: "response.created", response: { id: "r1" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs", summary: [] } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "Because." },
    { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "m", role: "assistant", content: [] } },
    { type: "response.output_text.delta", output_index: 1, delta: "Sure." },
    { type: "response.completed", response: { id: "r1", status: "completed", output: [] } }]);
  const events = anthropicEvents(await (await messages({ stream: true, max_tokens: 20000, thinking: { type: "enabled", budget_tokens: 8000 } })).text());
  // Put the reply back together the way an SDK does, signature_delta included.
  const blocks: any[] = [];
  for (const item of events) {
    if (item.event === "content_block_start") blocks[item.data.index] = { ...item.data.content_block };
    if (item.event === "content_block_delta") {
      const delta = item.data.delta; const block = blocks[item.data.index];
      if (delta.type === "text_delta") block.text += delta.text;
      if (delta.type === "thinking_delta") block.thinking += delta.thinking;
      if (delta.type === "signature_delta") block.signature = delta.signature;
    }
  }
  assert.deepEqual(blocks[0], { type: "thinking", thinking: "Because.", signature: THINKING_SIGNATURE });
  assert.deepEqual(events.filter(item => item.data.index === 0).map(item => item.data.delta?.type ?? item.event).slice(-3),
    ["thinking_delta", "signature_delta", "content_block_stop"], "the signature comes just before the block ends");
  asked = [];
  answer = () => sseResponse(textEvents("fine"));
  const next = await messages({ stream: false, max_tokens: 20000, thinking: { type: "enabled", budget_tokens: 8000 }, messages: [
    { role: "user", content: "hi" }, { role: "assistant", content: blocks }, { role: "user", content: "and then?" }] });
  assert.equal(next.status, 200, await next.clone().text());
  assert.deepEqual(openai()[0].body.input, [{ role: "user", content: "hi" }, { role: "assistant", content: "Sure." }, { role: "user", content: "and then?" }]);
});

test("the caller's anthropic-beta is honored by request validation and never forwarded to ChatGPT", async () => {
  await signIn();
  const body = { stream: false, max_tokens: 4000, thinking: { type: "enabled", budget_tokens: 8000 } };
  assert.equal((await messages(body)).status, 400, "a thinking budget above max_tokens needs the interleaved-thinking beta");
  const ok = await messages(body, { "anthropic-beta": "interleaved-thinking-2025-05-14" });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.ok(!("anthropic-beta" in need(openai().at(-1)).headers));
});

test("messages mapping details: a mid-conversation system message is an instruction, a failed tool result says so, an untitled PDF gets a name", () => {
  const build = (items: any[]) => toChatGptRequest({ model: "x", messages: items, max_tokens: 5 }, "messages", "s").body;
  const body = build([{ role: "user", content: "hi" }, { role: "system", content: "From now on answer in French." },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "f", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } }] },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER" } }] }]);
  assert.deepEqual(body.input[1], { role: "developer", content: "From now on answer in French." });
  assert.deepEqual(body.input[3], { type: "function_call_output", call_id: "t1", output: "Error: boom" });
  assert.deepEqual(body.input[5].output[0], { type: "input_text", text: "Error:" });
  assert.deepEqual(need(body.input.at(-1)).content[0], { type: "input_file", filename: "document.pdf", file_data: "data:application/pdf;base64,JVBER" });
});

test("messages: if ChatGPT interleaves two tool calls so one's input cannot be sent whole, the message ends as an error, not as a call with a cut input", () => {
  const translator = new MessagesStreamTranslator({ model: "m" });
  const out = [
    ...translator.push({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fa", call_id: "ca", name: "f", arguments: "" } }),
    ...translator.push({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fa", delta: "{\"x\":" }),
    ...translator.push({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fb", call_id: "cb", name: "g", arguments: "" } }),
    ...translator.push({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fa", delta: "1}" }),
    ...translator.push({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fb", delta: "{}" }),
    ...translator.push({ type: "response.completed", response: { status: "completed" } })];
  const events = anthropicEvents(out.join(""));
  assert.equal(need(events.at(-1)).event, "error");
  assert.ok(!events.some(item => item.event === "message_stop"));
});

test("two requests refused with a 401 at once: one refreshes, the other waits for that token instead of retrying with the refused one", async () => {
  await signIn({ refreshedAgo: 3600_000 });
  answer = (_body, headers) => headers.authorization === "Bearer access-renewed" ? sseResponse(textEvents("ok")) : new Response("{}", { status: 401 });
  const [first, second] = await Promise.all([chat({ stream: false }), chat({ stream: false })]);
  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.equal(tokenCalls.length, 1);
});

test("the guide-dog's call on the plan hands a needed token refresh to waitUntil, like the gateway paths do", async () => {
  await signIn();
  sqlite.prepare("UPDATE chatgpt_connection SET access_expires_at = ?").run(Date.now() + 60_000);
  env.GUIDE_DOG_API_KEY = "guide-key";
  env.CHAT_MODEL = "chatgpt/gpt-test";
  pending.length = 0;
  const reply = await worker.fetch(new Request("https://aelios.test/v1/guide-dog/chat/completions", { method: "POST",
    headers: { authorization: "Bearer guide-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "companion", messages: [{ role: "user", content: "hi" }] }) }), env, ctx);
  assert.equal(reply.status, 200);
  assert.equal(tokenCalls.length, 1);
  assert.ok(pending.length >= 1, "the refresh was registered with waitUntil");
});

test("a stalled ChatGPT does not hold up /v1/models: the rest of the list still comes", async () => {
  await signIn();
  const before = TIMEOUTS.modelsMs;
  TIMEOUTS.modelsMs = 50;
  try {
    models = () => new Promise<Response>(() => undefined);
    const reply = await worker.fetch(new Request("https://aelios.test/v1/models", { headers: { authorization: "Bearer owner-key" } }), env, ctx);
    const body = await reply.json() as any;
    assert.ok(body.data.some((item: any) => item.id === "openai/gpt-4o"));
    assert.ok(!body.data.some((item: any) => String(item.id).startsWith("chatgpt/")));
  } finally { TIMEOUTS.modelsMs = before; }
});

test("model test: a chatgpt/ model is tried on the plan route with the plan token, and says so when nobody is signed in", async () => {
  const signedOut = await (await post("/api/gateway/models/test", { model: "chatgpt/gpt-test" })).json() as any;
  assert.equal(signedOut.ok, false);
  assert.equal(openai().length, 0, "nothing goes to OpenAI without a sign-in");
  await signIn();
  const result = await (await post("/api/gateway/models/test", { model: "chatgpt/gpt-test" })).json() as any;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 200);
  assert.equal(openai().length, 1);
  assert.equal(openai()[0].headers.authorization, "Bearer access-live");
  assert.equal(openai()[0].body.model, "gpt-test");
  assert.equal(openai()[0].body.stream, true);
  assert.equal(openai()[0].body.store, false);
  assert.equal(asked.filter(item => item.url.includes("upstream.test")).length, 0, "the CF upstream is never touched");
  await Promise.all(pending);
  assert.equal(queue.length, 0);
});
