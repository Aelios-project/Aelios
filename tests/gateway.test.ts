import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import { identityNamespace, identityReadNamespaces, invalidateSettingsCache, loadSettings, speakersForNamespace, validateConfig } from "../src/gateway/config";
import { applySettings } from "../src/gateway/settings";
import { appendMemory, classifyTurn, canonical } from "../src/gateway/protocol";
import { catalogClaude, catalogUrl, forgetRestRefusals, nativeAnthropic, resolveUpstream, restRefused, routeFor, rejectedToolFields } from "../src/gateway/upstream";
import { callOpenAICompat } from "../src/proxy/openaiAdapter";
import { OutputCollector, observeResponse, persistExchange, prepareExchange, dispatchExchange } from "../src/gateway/record";
import { getOrCreateConversation } from "../src/db/conversations";
import { saveUserMessages } from "../src/db/messages";
import { backfillFts } from "../src/memory/fts";

import { lexicalOverlapScore, shapeRecallQuery } from "../src/memory/queryShape";
import { codingClient, codingSpeech, isSpeechTool, stripCodeBlocks } from "../src/gateway/coding";

// Test production modules and SQL with deterministic HTTP and Workers AI doubles.
(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);
let sqlite: DatabaseSync;
let db: any;
let env: any;
let ctx: any;
let pending: Promise<unknown>[];
let calls: any[];
let queue: any[];
const identity = () => ({ slug: "partner", namespace: "partner-a", keys: ["CHATBOX_API_KEY"],
  anthropicThinking: "drop_block", models: ["partner", "listed-model", "*opus*"] });
function config(identities = [identity()]) {
  return { version: 3, upstream: { address: "https://upstream.test/ai/v1" }, identities };
}
function setConfig(c: any) { env.GATEWAY_CONFIG = JSON.stringify(c); }
beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter((f: string) => f.endsWith(".sql")).sort()) {
    try { sqlite.exec(readFileSync(`migrations/${file}`, "utf8")); }
    catch (error) {
      if (!String(error).includes("fts5")) throw error;
    }
  }
  db = { prepare(sql: string) {
    const statement = sqlite.prepare(sql); let args: any[] = [];
    const api = { bind(...values: any[]) { args = values; return api; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { const r = statement.run(...args); return { meta: { changes: r.changes } }; }
    }; return api;
  }, async batch(statements: any[]) {
    sqlite.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results; }
    catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  } };
  invalidateSettingsCache();
  forgetRestRefusals();
  calls = []; queue = []; pending = [];
  ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); } };
  env = { DB: db, CHATBOX_API_KEY: "owner-key", IM_API_KEY: "im-key", MEMORY_MCP_API_KEY: "mcp-key",
    CLOUDFLARE_API_TOKEN: "cf-token",
    AI: { async run(model: string, data: any) {
      if (!model.includes("reranker")) throw new Error("embedding unavailable in test");
      return { response: data.contexts.map((c: any, id: number) => ({ id,
        score: lexicalOverlapScore(c.text, shapeRecallQuery({ query: data.query }).lexicalTokens) > 0 ? 0.9 : 0.01 })) };
    } },
    MEMORY_QUEUE: { async send(e: any) { queue.push(e); } } };
  globalThis.fetch = async (url: any, init: any) => {
    if (String(url).endsWith("/models")) {
      calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)), query: null });
      return Response.json({ object: "list", data: [{ id: "anthropic/claude-opus-4-5", object: "model" }] });
    }
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)), query: JSON.parse(init?.body as string) });
    if (String(url).endsWith("/responses")) return Response.json({ model: "gpt-test", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Response reply" }] }] });
    if (String(url).endsWith("/messages")) return Response.json({ model: "claude-test", content: [{ type: "thinking", thinking: "do not record" }, { type: "text", text: "Claude reply" }], stop_reason: "end_turn" });
    return Response.json({ model: "actual", choices: [{ index: 0, message: { content: "你好，记住了。" }, finish_reason: "stop" }] });
  };
  setConfig(config());
});
function request(path: string, body?: any, headers: any = {}, method = body ? "POST" : "GET") {
  return new Request(`https://aelios.test${path}`, { method,
    headers: { authorization: "Bearer owner-key", "content-type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function run(path: string, body?: any, headers?: any) {
  const response = await worker.fetch(request(path, body, headers), env, ctx);
  const text = await response.text(); await Promise.all(pending);
  return { response, text };
}
function count(table: string) { return (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as any).n; }
function precious(namespace: string, content: string) {
  const id = `${namespace}-${content.slice(0, 24)}`;
  sqlite.prepare("INSERT INTO precious (id, namespace, content, created_at) VALUES (?, ?, ?, ?)").run(id, namespace, content, "2026-09-06");
}

test("migrations, native chat recall, namespace isolation, original text and Queue dedup", async () => {
  precious("partner-a", "喜欢 Cloudflare"); precious("partner-a", "昨天吃了番茄炒蛋");
  precious("partner-b", "other identity private memory");
  const body = { model: "partner", messages: [{ role: "user", content: "我们喜欢什么？" }], extra_future_field: { opaque: true } };
  const { response } = await run("/v1/chat/completions", body);
  assert.equal(response.status, 200); assert.equal(response.headers.get("x-aelios-memory"), "injected");
  assert.equal(calls[0].url, "https://upstream.test/ai/v1/chat/completions");
  assert.equal(calls[0].headers.authorization, "Bearer cf-token");
  assert.match(calls[0].query.messages[0].content, /喜欢 Cloudflare/);
  assert.match(calls[0].query.messages[0].content, /相关旧事.*喜欢 Cloudflare/);
  assert.doesNotMatch(calls[0].query.messages[0].content, /番茄炒蛋/);
  assert.doesNotMatch(calls[0].query.messages[0].content, /other identity/);
  assert.doesNotMatch(calls[0].query.messages[0].content, /\[\{"kind"/);
  assert.equal(calls[0].query.extra_future_field, undefined);
  assert.equal(queue[0].userText, "我们喜欢什么？"); assert.equal(queue[0].completion, "complete");
  await persistExchange(env, queue[0]); await persistExchange(env, queue[0]);
  assert.equal(count("gateway_exchanges"), 1); assert.equal(count("messages"), 2);
  const continuation = { model: "partner", messages: [...body.messages,
    { role: "assistant", content: null, tool_calls: [{ id: "t", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t", content: "result" }] };
  await run("/v1/chat/completions", continuation);
  assert.deepEqual(calls[1].query.messages, continuation.messages);
  assert.equal(queue[1].kind, "tool"); assert.equal(queue[1].userText, "");
});

// message_id is UNINDEXED in FTS5: `DELETE FROM message_fts WHERE message_id = ?` reads the whole
// table, and D1 bills every row. Recording a turn must not pay that on every request.
function spySql(): string[] {
  const seen: string[] = [];
  const base = env.DB;
  env.DB = { ...base, prepare(sql: string) { seen.push(sql); return base.prepare(sql); } };
  return seen;
}
const ftsScans = (seen: string[]) => seen.filter(sql => /DELETE FROM (message|memory)_fts WHERE (message|memory)_id = \?/.test(sql));

test("recording a turn indexes each new message once without scanning the FTS table", async () => {
  const seen = spySql();
  await run("/v1/chat/completions", { model: "partner", messages: [{ role: "user", content: "今晚想吃火锅" }] });
  await persistExchange(env, queue[0]); await persistExchange(env, queue[0]);
  assert.deepEqual(ftsScans(seen), []);
  const indexed = (sqlite.prepare("SELECT message_id FROM message_fts").all() as any[]).map(row => row.message_id).sort();
  assert.deepEqual(indexed, [queue[0].userId, `${queue[0].id}:assistant`].sort());
});

test("FTS backfill indexes missing rows without per-row FTS scans", async () => {
  sqlite.prepare("INSERT INTO conversations (id, namespace, created_at, updated_at) VALUES ('c', 'partner-a', 'x', 'x')").run();
  for (const [id, content] of [["m-old", "已经有索引的话"], ["m-new", "还没有索引的话"]]) {
    sqlite.prepare(`INSERT INTO messages (id, conversation_id, namespace, role, content, source, stream, created_at, seq)
      VALUES (?, 'c', 'partner-a', 'user', ?, 'test', 0, '2026-10-28T00:00:00.000Z', 0)`).run(id, content);
  }
  sqlite.prepare("INSERT INTO message_fts (fts_body, namespace, message_id) VALUES ('已经', 'partner-a', 'm-old')").run();
  const seen = spySql();
  const result = await backfillFts(env.DB, { namespace: "partner-a", limit: 10 });
  assert.equal(result.messagesIndexed, 1);
  assert.deepEqual(ftsScans(seen), []);
  assert.ok(seen.every(sql => !/LEFT JOIN (message|memory)_fts/.test(sql)));
  const ids = (sqlite.prepare("SELECT message_id FROM message_fts").all() as any[]).map(row => row.message_id).sort();
  assert.deepEqual(ids, ["m-new", "m-old"]);
});

function seedQuote(namespace: string, id: string, role: "user" | "assistant", content: string) {
  sqlite.prepare("INSERT OR IGNORE INTO conversations (id, namespace, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("c-quote", namespace, "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
  sqlite.prepare(`INSERT INTO messages
    (id, conversation_id, namespace, role, content, source, client_message_hash, stream, created_at, seq)
    VALUES (?, ?, ?, ?, ?, 'test', ?, 0, ?, 0)`).run(
    id, "c-quote", namespace, role, content, id, "2026-09-01T00:00:00.000Z"
  );
}

test("ordinary chat does not inject raw message quotes", async () => {
  precious("partner-a", "喜欢 Cloudflare");
  seedQuote("partner-a", "msg-noise", "assistant", "我喜欢吃番茄炒蛋，还喜欢深夜加糖的豆浆。");
  const { response } = await run("/v1/chat/completions", {
    model: "partner",
    messages: [{ role: "user", content: "我们喜欢什么？" }]
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-aelios-memory"), "injected");
  const injected = JSON.stringify(calls[0].query.messages);
  assert.match(injected, /喜欢 Cloudflare/);
  assert.doesNotMatch(injected, /番茄炒蛋|豆浆/);
});

test("evidence questions may quote a message the memory store does not cover", async () => {
  seedQuote("partner-a", "msg-pass", "user", "那天说的调试暗号是芝麻开门");
  const { response } = await run("/v1/chat/completions", {
    model: "partner",
    messages: [{ role: "user", content: "调试暗号是什么？" }]
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-aelios-memory"), "injected");
  assert.match(JSON.stringify(calls[0].query.messages), /芝麻开门/);
  assert.doesNotMatch(JSON.stringify(calls[0].query.messages), /msg-pass|c-quote/);
});
test("transport metadata stays on the wire but not in memory storage", async () => {
  const envelope = '<message from="9fc3ec3b7f584cdfbfe84f72300e8f08" msg_id="7812076508172213971">迁企微、宁皎搬好了</message>';
  await run("/v1/chat/completions", { model: "partner", messages: [{ role: "user", content: envelope }] });
  assert.equal(calls[0].query.messages[0].content, envelope);
  assert.equal(queue[0].userText, "迁企微、宁皎搬好了");
  await persistExchange(env, queue[0]);
  const stored = sqlite.prepare("SELECT content FROM messages WHERE role = 'user'").get() as { content: string };
  assert.equal(stored.content, "迁企微、宁皎搬好了");
});
test("wecom envelopes recall on inner speech; recap turns skip recall and storage", async () => {
  precious("partner-a", "喜欢 Cloudflare");
  seedQuote("partner-a", "msg-noise", "assistant", "我喜欢吃番茄炒蛋，还喜欢深夜加糖的豆浆。");
  const wecom = '<wecom-message from="086923c2648ccdfdb83072c64717dc35" msg_id="7812076508172213971">我们喜欢什么？</wecom-message>';
  const wecomRes = await run("/v1/chat/completions", { model: "partner", messages: [{ role: "user", content: wecom }] });
  assert.equal(wecomRes.response.status, 200);
  assert.equal(wecomRes.response.headers.get("x-aelios-memory"), "injected");
  assert.equal(calls[0].query.messages[0].content.split("\n\n")[0], wecom);
  const wecomPatch = calls[0].query.messages[0].content.slice(wecom.length);
  assert.match(wecomPatch, /喜欢 Cloudflare/);
  assert.doesNotMatch(wecomPatch, /086923c2648ccdfdb83072c64717dc35|番茄炒蛋/);
  assert.equal(queue[0].kind, "human");
  assert.equal(queue[0].userText, "我们喜欢什么？");
  const afterWecom = (sqlite.prepare("SELECT count(*) AS n FROM messages").get() as any).n as number;

  const recap = "<recap>\nUser stepped away; returning. Recap: <40 words.";
  const recapRes = await run("/v1/chat/completions", { model: "partner", messages: [{ role: "user", content: recap }] });
  assert.equal(recapRes.response.status, 200);
  assert.equal(recapRes.response.headers.get("x-aelios-memory"), "skipped");
  assert.equal(calls[1].query.messages[0].content, recap);
  assert.doesNotMatch(JSON.stringify(calls[1].query.messages), /喜欢 Cloudflare|番茄炒蛋/);
  assert.equal(queue[1].kind, "auxiliary");
  assert.equal(queue[1].userText, "");
  await persistExchange(env, queue[1]);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM messages").get() as any).n, afterWecom);
  const stored = sqlite.prepare("SELECT content FROM messages").all() as { content: string }[];
  assert.ok(stored.every((row) => !/User stepped away|<recap>/i.test(row.content)));
});
test("Anthropic tool_result is not human; client beta, signatures, tools and cache survive", async () => {
  const body = { model: "partner", max_tokens: 1000, tools: [{ name: "t", input_schema: { type: "object" } }],
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "opaque" }, { type: "tool_use", id: "t", name: "t", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "Not me", cache_control: { type: "ephemeral" } }] }] };
  const { response } = await run("/v1/messages", body, { "anthropic-beta": "client-beta" });
  assert.equal(response.status, 200); assert.deepEqual(calls[0].query.messages, body.messages);
  assert.deepEqual(calls[0].query.tools, body.tools);
  assert.equal(calls[0].query.thinking.block_binding.prefix_mismatch_behavior, "drop_block");
  assert.match(calls[0].headers["anthropic-beta"], /client-beta/);
  assert.match(calls[0].headers["anthropic-beta"], /thinking-binding-controls/);
  assert.equal(calls[0].headers.authorization, "Bearer cf-token");
  assert.equal(calls[0].headers["x-api-key"], undefined);
  assert.equal(queue[0].kind, "tool"); assert.equal(queue[0].assistantText, "Claude reply");
});
test("model tool calls are recorded; delivery receipts and tool results are not", async () => {
  const mock = globalThis.fetch;
  globalThis.fetch = async (url: any, init: any) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)), query: JSON.parse(init?.body as string) });
    return Response.json({
      model: "claude-test",
      content: [
        { type: "tool_use", id: "w", name: "weixin_send", input: { text: "今晚吃什么" } },
        { type: "tool_use", id: "b", name: "bash", input: { command: "date" } },
        { type: "text", text: "已回她。" }
      ],
      stop_reason: "tool_use"
    });
  };
  try {
    const { response } = await run("/v1/messages", {
      model: "partner", max_tokens: 16, messages: [{ role: "user", content: "晚饭呢" }]
    });
    assert.equal(response.status, 200);
    assert.match(queue[0].assistantText, /weixin_send/);
    assert.match(queue[0].assistantText, /今晚吃什么/);
    assert.match(queue[0].assistantText, /bash/);
    assert.match(queue[0].assistantText, /date/);
    assert.doesNotMatch(queue[0].assistantText, /已回她/);
    await persistExchange(env, { ...queue[0], completion: "complete" });
    const assistant = sqlite.prepare("SELECT content FROM messages WHERE role = 'assistant'").get() as { content: string };
    assert.match(assistant.content, /今晚吃什么/);
    assert.doesNotMatch(assistant.content, /已回她/);
  } finally { globalThis.fetch = mock; }

  const out = new OutputCollector("messages");
  const event = (data: any) => out.chunk(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
  event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "weixin_send", input: {} } });
  event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"text\":\"在的\"}" } });
  event({ type: "content_block_stop", index: 0 });
  event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "已回她。" } });
  event({ type: "message_stop" });
  out.finish();
  assert.equal(out.text, 'weixin_send {"text":"在的"}');
});
test("Responses string input, tool outputs and encrypted reasoning; hidden server history only rejected for main models", async () => {
  await run("/v1/responses", { model: "partner", input: "你好", store: true });
  assert.equal(calls[0].query.store, false); assert.equal(queue[0].userText, "你好");
  const input = [{ type: "reasoning", encrypted_content: "opaque" }, { type: "function_call_output", call_id: "t", output: "done" }];
  await run("/v1/responses", { model: "partner", input, include: ["reasoning.encrypted_content"] });
  assert.deepEqual(calls[1].query.input, input); assert.equal(queue[1].kind, "tool");
  const { response } = await run("/v1/responses", { model: "partner", input: "next", previous_response_id: "resp_previous" });
  assert.equal(response.status, 400); assert.equal(calls.length, 2);
  // Outside the main list the gateway is a pure pipe: server state passes through, nothing recalled or recorded.
  const side = await run("/v1/responses", { model: "side-model", input: "next", previous_response_id: "resp_previous" });
  assert.equal(side.response.status, 200); assert.equal(side.response.headers.get("x-aelios-memory"), "off");
  assert.equal(calls[2].query.previous_response_id, "resp_previous");
  assert.equal(queue.length, 2);
});
test("append after multimodal blocks without modifying cache markers or original request", () => {
  const body = { messages: [{ role: "user", content: [{ type: "image", source: { data: "opaque" } }, { type: "text", text: "看这个", cache_control: { type: "ephemeral" } }] }] };
  const before = structuredClone(body); const out = appendMemory(body, "messages", "memory");
  assert.deepEqual(body, before); assert.deepEqual(out.messages[0].content.slice(0, 2), before.messages[0].content);
  assert.equal(out.messages[0].content[2].text, "memory");
  assert.equal(classifyTurn({ messages: [{ role: "user", content: [{ type: "tool_result", content: "result" }, { type: "text", text: "Also do this" }] }] }, "messages").kind, "human");
});
test("path picks the identity; keys gate it and the bare path falls back to the first one", async () => {
  const other = { ...identity(), slug: "other", namespace: "partner-b", keys: ["IM_API_KEY"] };
  setConfig(config([identity(), other]));
  const models = await run("/v1/models");
  // The upstream catalog passes through untouched, with the CF token on the wire.
  assert.deepEqual(JSON.parse(models.text).data.map((m: any) => m.id), ["anthropic/claude-opus-4-5"]);
  assert.equal(calls[0].url, "https://upstream.test/ai/v1/models");
  assert.equal(calls[0].headers.authorization, "Bearer cf-token");
  assert.equal(models.response.headers.get("x-aelios-models"), "upstream");
  assert.match(models.response.headers.get("cache-control")!, /no-store/);
  const scoped = await run("/partner/v1/chat/completions", { model: "partner", messages: [{ role: "user", content: "Hi" }] });
  assert.equal(scoped.response.headers.get("x-aelios-identity"), "partner");
  assert.equal(queue[0].namespace, "partner-a");
  // Another key's identity stays unreachable, and a body namespace cannot override it.
  assert.equal((await run("/other/v1/chat/completions", { model: "partner", messages: [] })).response.status, 403);
  await run("/v1/chat/completions", { model: "partner", namespace: "partner-b", messages: [{ role: "user", content: "Hi again" }] });
  assert.equal(queue[1].namespace, "partner-a");
  const im = await run("/other/v1/chat/completions", { model: "partner", messages: [{ role: "user", content: "Hi" }] }, { authorization: "Bearer im-key" });
  assert.equal(im.response.headers.get("x-aelios-identity"), "other");
  assert.equal((await run("/v1/chat/completions", { model: "partner", messages: [] }, { authorization: "Bearer mcp-key" })).response.status, 403);
});
test("model catalog falls back to main-model hints when the upstream cannot answer", async () => {
  const mock = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 404 });
  try {
    const models = await run("/v1/models");
    assert.deepEqual(JSON.parse(models.text).data.map((m: any) => m.id), ["partner", "listed-model"]);
    assert.equal(models.response.headers.get("x-aelios-models"), "fallback:upstream-404");
  } finally { globalThis.fetch = mock; }
  delete env.CLOUDFLARE_API_TOKEN;
  const offline = await run("/v1/models");
  assert.deepEqual(JSON.parse(offline.text).data.map((m: any) => m.id), ["partner", "listed-model"]);
  assert.equal(offline.response.headers.get("x-aelios-models"), "fallback:no-token");
});
test("legacy CF address forms still reach the compat catalog", async () => {
  const acct = "a".repeat(32);
  const catalog = `https://gateway.ai.cloudflare.com/v1/${acct}/default/compat/models`;
  for (const address of [acct,
    `https://gateway.ai.cloudflare.com/v1/${acct}`,
    `https://gateway.ai.cloudflare.com/v1/${acct}/`,
    `https://gateway.ai.cloudflare.com/v1/${acct}/compat`,
    `https://gateway.ai.cloudflare.com/v1/${acct}/default`,
    `https://gateway.ai.cloudflare.com/v1/${acct}/default/`,
    `https://gateway.ai.cloudflare.com/v1/${acct}/default/compat`,
    `https://gateway.ai.cloudflare.com/v1/${acct}/default/compat/`,
    `https://gateway.ai.cloudflare.com/v1/${acct}/default/compat/models`,
    `https://gateway.ai.cloudflare.com/v1/${acct}/default/compat/models/`,
    `https://gateway.ai.cloudflare.com/v1/${acct}/default/compat/chat/completions`,
    `https://gateway.ai.cloudflare.com/v1/${acct}/default/compat/v1`,
    `https://gateway.ai.cloudflare.com/v1/${acct}/default/compat/v1/chat/completions`,
    `https://api.cloudflare.com/client/v4/accounts/${acct}/ai`,
    `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/v1`,
    `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/v1/messages`]) {
    setConfig({ ...config(), upstream: { address } }); calls = [];
    const models = await run("/v1/models");
    assert.equal(models.response.headers.get("x-aelios-models"), "upstream", address);
    assert.equal(calls[0].url, catalog, address);
  }
});


test("auxiliary and incomplete replies do not become Dream sources", async () => {
  await run("/v1/chat/completions", { model: "partner", messages: [{ role: "user", content: "Generate title" }] }, { "x-aelios-purpose": "auxiliary" });
  await persistExchange(env, queue[0]); assert.equal(count("messages"), 0);
  await persistExchange(env, { ...queue[0], id: "incomplete", kind: "human", userText: "real question", assistantText: "half reply", completion: "incomplete" });
  assert.equal(count("messages"), 1); assert.equal((sqlite.prepare("SELECT role FROM messages").get() as any).role, "user");
});
test("retry hashes ignore key order but distinguish later repeated words and sessions", async () => {
  const a = { model: "partner", messages: [{ role: "user", content: "Hi" }] };
  const b = { messages: [{ content: "Hi", role: "user" }], model: "partner" };
  const make = (body: any, session = "one") => prepareExchange(request("/v1/chat/completions", body, { "x-aelios-session-id": session }), body, identity() as any, "chat", classifyTurn(body, "chat"), "chatbox");
  assert.equal((await make(a)).id, (await make(b)).id);
  assert.notEqual((await make(a)).id, (await make(a, "two")).id);
  assert.notEqual((await make(a)).userId, (await make({ ...a, messages: [...a.messages, { role: "assistant", content: "Hello" }, ...a.messages] })).userId);
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
});
test("main-model whitelist gates recall and recording; other models pass through untouched", async () => {
  precious("partner-a", "喜欢 Cloudflare");
  const ask = (model: string, text = `Hi ${model} 我们喜欢 Cloudflare 吗`) =>
    run("/v1/chat/completions", { model, messages: [{ role: "user", content: text }] });
  await ask("partner");
  assert.equal(calls[0].query.model, "partner");
  assert.match(JSON.stringify(calls[0].query.messages), /相关旧事.*喜欢 Cloudflare/);
  // Basename match: a glob pattern sees the model name with or without its author prefix.
  const opus = await ask("anthropic/claude-opus-4-6");
  assert.equal(opus.response.headers.get("x-aelios-memory"), "injected");
  assert.equal(calls[1].query.model, "anthropic/claude-opus-4-6");
  assert.equal(queue.length, 2);
  // Off the list: no recall, no record, model name delivered byte-identical.
  const small = await ask("claude-haiku-4-5", "Hi claude-haiku-4-5");
  assert.equal(small.response.headers.get("x-aelios-memory"), "off");
  assert.equal(calls[2].query.model, "claude-haiku-4-5");
  assert.doesNotMatch(JSON.stringify(calls[2].query.messages), /喜欢 Cloudflare/);
  assert.equal(queue.length, 2);
});
test("SSE byte-exact Unicode and CRLF boundaries; no thinking in observed text", async () => {
  const raw = 'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"secret"}}\r\n\r\n' +
    'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好🌸"}}\r\n\r\n' +
    'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n';
  const bytes = new TextEncoder().encode(raw); let offset = 0; let observed: any;
  const source = new ReadableStream({ pull(c) { if (offset >= bytes.length) c.close(); else c.enqueue(bytes.slice(offset, ++offset)); } });
  const response = observeResponse(new Response(source, { headers: { "content-type": "text/event-stream" } }), "messages", ctx, async (out, interrupted) => { observed = { text: out.text, complete: out.complete, interrupted }; });
  assert.equal(await response.text(), raw); await Promise.all(pending);
  assert.deepEqual(observed, { text: "你好🌸", complete: true, interrupted: false });
});
test("Responses terminal snapshot does not duplicate deltas; broken stream stays incomplete", () => {
  const out = new OutputCollector("responses");
  const event = (data: any) => out.chunk(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
  event({ type: "response.output_text.delta", delta: "Hello" });
  event({ type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] }] } });
  assert.equal(out.text, "Hello"); assert.equal(out.complete, true);
  const broken = new OutputCollector("chat");
  broken.chunk(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'));
  broken.finish(); assert.equal(broken.complete, false);
});
test("cancellation cancels upstream and records interrupted state", async () => {
  let cancelled = false; let interrupted = false;
  const source = new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"half"}}]}\n\n')); }, cancel() { cancelled = true; } });
  const response = observeResponse(new Response(source, { headers: { "content-type": "text/event-stream" } }), "chat", ctx, async (_, flag) => { interrupted = flag; });
  const reader = response.body!.getReader(); await reader.read(); await reader.cancel(); await Promise.all(pending);
  assert.equal(cancelled, true); assert.equal(interrupted, true);
});
test("admin configuration validation, D1 precedence and owner-only writes", async () => {
  assert.equal((await worker.fetch(request("/api/gateway/config", config(), {}, "PUT"), env, ctx)).status, 200);
  env.GATEWAY_CONFIG = "invalid env overridden by D1";
  assert.equal(JSON.parse((await run("/api/gateway/config")).text).identities[0].slug, "partner");
  assert.equal((await worker.fetch(request("/api/gateway/config", config(), { authorization: "Bearer im-key" }, "PUT"), env, ctx)).status, 401);
  assert.throws(() => validateConfig({ version: 2, identities: [] }), /version: 3/);
  assert.throws(() => validateConfig({ version: 3, upstream: { address: "http://insecure.test" }, identities: [] }), /HTTPS/);
});
test("upstream receives the CF token only, dropping unknown envelope fields and preserving response bytes", async () => {
  const mock = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://upstream.test/ai/v1/chat/completions");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer cf-token");
    assert.equal(headers.get("x-api-key"), null);
    assert.equal(JSON.parse(init?.body as string).future, undefined);
    return new Response(' {"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]} ', { headers: { "content-type": "application/json" } });
  };
  try { const result = await run("/v1/chat/completions", { model: "partner", messages: [], future: { keep: true } }); assert.match(result.text, /^ /); }
  finally { globalThis.fetch = mock; }
});
test("missing CF token fails loudly instead of leaking another credential", async () => {
  delete env.CLOUDFLARE_API_TOKEN;
  const { response, text } = await run("/v1/chat/completions", { model: "partner", messages: [] });
  assert.equal(response.status, 502);
  assert.match(JSON.parse(text).error.message, /CLOUDFLARE_API_TOKEN/);
  assert.equal(queue.length, 0); // Preflight fails before recording.
});
test("thinking passthrough preserves reasoning and still injects memory", async () => {
  precious("partner-a", "Cloudflare fan");
  setConfig(config([{ ...identity(), anthropicThinking: "passthrough" }]));
  const body = { model: "partner", max_tokens: 2048, messages: [{ role: "user", content: "Hi Cloudflare" }], thinking: { type: "adaptive" } };
  assert.equal((await run("/v1/messages", body)).response.headers.get("x-aelios-memory"), "injected");
  assert.deepEqual(calls[0].query.thinking, body.thinking);
  assert.ok(calls[0].query.messages[0].content.includes("Cloudflare fan"));
  assert.equal((await run("/v1/messages", { ...body, thinking: { type: "disabled" } })).response.headers.get("x-aelios-memory"), "injected");
});
test("automatic caching lowers to the last cacheable block without rewriting system", async () => {
  const cc = { type: "ephemeral" };
  const body = { model: "partner", max_tokens: 16, cache_control: cc, system: [{ type: "text", text: "persona" }],
    messages: [{ role: "user", content: [{ type: "text", text: "Hi", cache_control: cc }] }] };
  const { response } = await run("/v1/messages", body);
  assert.equal(response.status, 200);
  assert.equal(calls[0].query.cache_control, undefined);
  assert.deepEqual(calls[0].query.system, body.system);
  assert.deepEqual(calls[0].query.messages[0].content[0].cache_control, cc);
  const stringSystem = { model: "partner", max_tokens: 16, cache_control: cc, system: "persona", messages: [{ role: "user", content: "Hi" }] };
  await run("/v1/messages", stringSystem);
  assert.equal(calls[1].query.system, "persona");
  assert.deepEqual(calls[1].query.messages[0].content, [{ type: "text", text: "Hi", cache_control: cc }]);
  const noSystem = { model: "partner", max_tokens: 16, cache_control: cc, messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] };
  await run("/v1/messages", noSystem);
  assert.deepEqual(calls[2].query.messages[0].content[0].cache_control, cc);
});
test("upstream rejecting tool cache_control is learned: retry once stripped, then pre-strip", async () => {
  rejectedToolFields.clear();
  const vertexError = JSON.stringify({ errorCode: "INVALID_ARGUMENT",
    parameters: { unsafeParams: "{unrecognizedProperty=cache_control}" }, message: "Request contained an unrecognized field" });
  const baseFetch = globalThis.fetch;
  const seen: any[] = [];
  let fail = true;
  globalThis.fetch = async (url: any, init: any) => {
    seen.push(JSON.parse(init?.body as string));
    if (fail) { fail = false; return new Response(vertexError, { status: 400 }); }
    return baseFetch(url, init);
  };
  try {
    const body = { model: "partner", max_tokens: 16,
      tools: [{ name: "t", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "Hi" }] };
    const { response } = await run("/v1/messages", body);
    assert.equal(response.status, 200);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0].tools[0].cache_control, { type: "ephemeral" });
    assert.equal(seen[1].tools[0].cache_control, undefined);
    await run("/v1/messages", body);
    assert.equal(seen.length, 3);
    assert.equal(seen[2].tools[0].cache_control, undefined);
  } finally {
    globalThis.fetch = baseFetch;
    rejectedToolFields.clear();
  }
});
test("upstream rejecting eager_input_streaming is learned the same way", async () => {
  rejectedToolFields.clear();
  const relayError = JSON.stringify({ errorCode: "INVALID_ARGUMENT", errorName: "LanguageModelService:InvalidRequest",
    parameters: { unsafeParams: "{unrecognizedProperty=eager_input_streaming}" },
    message: "Request contained an unrecognized field" });
  const baseFetch = globalThis.fetch;
  const seen: any[] = [];
  let fail = true;
  globalThis.fetch = async (url: any, init: any) => {
    seen.push(JSON.parse(init?.body as string));
    if (fail) { fail = false; return new Response(relayError, { status: 400 }); }
    return baseFetch(url, init);
  };
  try {
    const body = { model: "partner", max_tokens: 16,
      tools: [{ name: "t", input_schema: { type: "object" }, eager_input_streaming: true }],
      messages: [{ role: "user", content: "Hi" }] };
    const { response } = await run("/v1/messages", body);
    assert.equal(response.status, 200);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].tools[0].eager_input_streaming, true);
    assert.equal(seen[1].tools[0].eager_input_streaming, undefined);
    await run("/v1/messages", body);
    assert.equal(seen.length, 3);
    assert.equal(seen[2].tools[0].eager_input_streaming, undefined);
  } finally {
    globalThis.fetch = baseFetch;
    rejectedToolFields.clear();
  }
});
test("a relay refusing two tool fields learns both within one request", async () => {
  rejectedToolFields.clear();
  const baseFetch = globalThis.fetch;
  const seen: any[] = [];
  let round = 0;
  globalThis.fetch = async (url: any, init: any) => {
    const sent = JSON.parse(init?.body as string);
    seen.push(sent);
    round++;
    // First pass rejects eager_input_streaming, second rejects cache_control, third succeeds.
    if (round === 1) return new Response(JSON.stringify({ errorCode: "INVALID_ARGUMENT",
      parameters: { unsafeParams: "{unrecognizedProperty=eager_input_streaming}" } }), { status: 400 });
    if (round === 2) return new Response(JSON.stringify({ errorCode: "INVALID_ARGUMENT",
      parameters: { unsafeParams: "{unrecognizedProperty=cache_control}" } }), { status: 400 });
    return baseFetch(url, init);
  };
  try {
    const body = { model: "partner", max_tokens: 16,
      tools: [
        { name: "a", input_schema: { type: "object" }, eager_input_streaming: true },
        { name: "b", input_schema: { type: "object" }, eager_input_streaming: true,
          cache_control: { type: "ephemeral" } }
      ],
      messages: [{ role: "user", content: "Hi" }] };
    const { response } = await run("/v1/messages", body);
    assert.equal(response.status, 200);
    assert.equal(seen.length, 3);
    assert.equal(seen[0].tools[0].eager_input_streaming, true);
    assert.deepEqual(seen[1].tools[1].cache_control, { type: "ephemeral" });
    assert.equal(seen[1].tools[0].eager_input_streaming, undefined);
    assert.equal(seen[2].tools[0].eager_input_streaming, undefined);
    assert.equal(seen[2].tools[1].cache_control, undefined);
    // Both lessons stick for the next request.
    await run("/v1/messages", body);
    assert.equal(seen.length, 4);
    assert.equal(seen[3].tools[0].eager_input_streaming, undefined);
    assert.equal(seen[3].tools[1].cache_control, undefined);
  } finally {
    globalThis.fetch = baseFetch;
    rejectedToolFields.clear();
  }
});
test("an unrecognized field that is not strippable is returned, not retried", async () => {
  rejectedToolFields.clear();
  // `strict` is contract-legal and survives normalization, so it really is on the wire.
  // It is deliberately absent from STRIPPABLE_TOOL_FIELDS: dropping the whitelist check
  // would strip it and retry, turning this test red.
  const junkError = JSON.stringify({ errorCode: "INVALID_ARGUMENT",
    parameters: { unsafeParams: "{unrecognizedProperty=strict}" }, message: "Request contained an unrecognized field" });
  const baseFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => { sends++; return new Response(junkError, { status: 400 }); };
  try {
    const { response } = await run("/v1/messages", { model: "partner", max_tokens: 16,
      tools: [{ name: "t", input_schema: { type: "object" }, strict: true }],
      messages: [{ role: "user", content: "Hi" }] });
    assert.equal(response.status, 400);
    assert.equal(sends, 1);
    assert.equal(rejectedToolFields.size, 0);
  } finally {
    globalThis.fetch = baseFetch;
    rejectedToolFields.clear();
  }
});
test("UPSTREAM_STRIP_TOOL_FIELDS refuses to strip a tool's identity", async () => {
  rejectedToolFields.clear();
  // A typo here would otherwise ship a tool with no name or schema past validation.
  env.UPSTREAM_STRIP_TOOL_FIELDS = "name, input_schema, eager_input_streaming";
  const baseFetch = globalThis.fetch;
  const seen: any[] = [];
  globalThis.fetch = async (url: any, init: any) => { seen.push(JSON.parse(init?.body as string)); return baseFetch(url, init); };
  try {
    const { response } = await run("/v1/messages", { model: "partner", max_tokens: 16,
      tools: [{ name: "t", input_schema: { type: "object" }, eager_input_streaming: true }],
      messages: [{ role: "user", content: "Hi" }] });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].tools[0].name, "t");
    assert.deepEqual(seen[0].tools[0].input_schema, { type: "object" });
    assert.equal(seen[0].tools[0].eager_input_streaming, undefined);
  } finally {
    globalThis.fetch = baseFetch;
    delete env.UPSTREAM_STRIP_TOOL_FIELDS;
    rejectedToolFields.clear();
  }
});
test("UPSTREAM_STRIP_TOOL_FIELDS pre-strips before the first send, no learning 400", async () => {
  rejectedToolFields.clear();
  env.UPSTREAM_STRIP_TOOL_FIELDS = "eager_input_streaming, cache_control";
  const baseFetch = globalThis.fetch;
  const seen: any[] = [];
  globalThis.fetch = async (url: any, init: any) => { seen.push(JSON.parse(init?.body as string)); return baseFetch(url, init); };
  try {
    const { response } = await run("/v1/messages", { model: "partner", max_tokens: 16,
      tools: [{ name: "t", input_schema: { type: "object" }, eager_input_streaming: true,
        cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "Hi" }] });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].tools[0].eager_input_streaming, undefined);
    assert.equal(seen[0].tools[0].cache_control, undefined);
  } finally {
    globalThis.fetch = baseFetch;
    delete env.UPSTREAM_STRIP_TOOL_FIELDS;
    rejectedToolFields.clear();
  }
});
test("Queue failure falls back to D1; successful duplicate cannot overwrite complete record", async () => {
  await run("/v1/chat/completions", { model: "partner", messages: [{ role: "user", content: "Hi" }] });
  env.MEMORY_QUEUE.send = async () => { throw Error("queue unavailable"); };
  await dispatchExchange(env, queue[0]);
  await persistExchange(env, { ...queue[0], assistantText: "different retry" });
  assert.equal(count("gateway_exchanges"), 1); assert.equal(count("messages"), 2);
  assert.equal((sqlite.prepare("SELECT assistant_text FROM gateway_exchanges").get() as any).assistant_text, "你好，记住了。");
});

test("a topical follow-up does not inject the previous relationship precious", async () => {
  precious("partner-a", "Claude 的陪伴让我觉得被接住，这是一段很长的关系记忆。");
  precious("partner-a", "喜欢 Cloudflare");
  const { response } = await run("/v1/chat/completions", {
    model: "partner",
    messages: [
      { role: "user", content: "聊聊 Claude 的陪伴" },
      { role: "assistant", content: "好" },
      { role: "user", content: "调试暗号是什么？" }
    ]
  });
  assert.equal(response.headers.get("x-aelios-memory"), "empty");
  assert.doesNotMatch(JSON.stringify(calls[0].query.messages), /Aelios memory reference|关系记忆|喜欢 Cloudflare/);
});

test("remember probes and recollection questions do not become facts", async () => {
  await run("/v1/chat/completions", { model: "partner", messages: [{ role: "user", content: "记住了吗？" }] });
  await run("/v1/chat/completions", { model: "partner", messages: [{ role: "user", content: "remember when we talked about the project?" }] });
  await run("/v1/chat/completions", {
    model: "partner",
    messages: [{ role: "user", content: "请记住：暗号是芝麻开门。只回复三个字：记住了" }]
  });
  const rows = sqlite.prepare("SELECT content, type, tags, authored_by FROM memories").all() as Array<{
    content: string;
    type: string;
    tags: string;
    authored_by: string | null;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, "暗号是芝麻开门");
  assert.equal(rows[0].type, "note");
  assert.match(rows[0].tags, /verbatim/);
  assert.equal(rows[0].authored_by, null);
});

test("please-remember writes the original words into long-term memory", async () => {
  const first = await run("/v1/chat/completions", {
    model: "partner",
    messages: [{ role: "user", content: "请记住调试暗号是芝麻开门" }]
  });
  assert.match(first.response.headers.get("x-aelios-remember") || "", /saved|indexed/);
  assert.match(first.response.headers.get("x-aelios-recall-id") || "", /^rcl_/);
  const row = sqlite.prepare("SELECT content, source, source_message_ids FROM memories").get() as {
    content: string;
    source: string;
    source_message_ids: string;
  };
  assert.equal(row.content, "调试暗号是芝麻开门");
  assert.equal(row.source, "remember_now");
  assert.match(row.source_message_ids, /gw_user_/);
  const ask = await run("/v1/chat/completions", {
    model: "partner",
    messages: [
      { role: "user", content: "请记住调试暗号是芝麻开门" },
      { role: "assistant", content: "好" },
      { role: "user", content: "调试暗号是什么？" }
    ]
  });
  assert.equal(ask.response.headers.get("x-aelios-memory"), "empty");
  assert.doesNotMatch(JSON.stringify(calls[1].query.messages), /Aelios 记忆/);
});

test("evidence recall keeps a distilled memory instead of repeating its source quote", async () => {
  await run("/v1/chat/completions", {
    model: "partner",
    messages: [{ role: "user", content: "请记住调试暗号是芝麻开门" }]
  });
  const ask = await run("/v1/chat/completions", {
    model: "partner",
    messages: [{ role: "user", content: "调试暗号是什么？" }]
  });
  assert.equal(ask.response.headers.get("x-aelios-memory"), "injected");
  const injected = JSON.stringify(calls[1].query.messages);
  assert.match(injected, /回答旧事：「调试暗号是芝麻开门」/);
  assert.doesNotMatch(injected, /请记住调试暗号|用户: 「/);
});

test("CF chat rides compat with the gateway id in the URL; custom upstreams stay bearer-only", async () => {
  env.AI_GATEWAY_ID = "panel-gateway";
  setConfig({ ...config(), upstream: { address: "a".repeat(32) } });
  await run("/v1/chat/completions", { model: "partner", messages: [{ role: "user", content: "Hi" }] });
  assert.equal(calls[0].url, `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/panel-gateway/compat/chat/completions`);
  assert.equal(calls[0].headers.authorization, "Bearer cf-token");
  assert.equal(calls[0].headers["cf-aig-authorization"], undefined);
  calls = [];
  setConfig(config());
  await run("/v1/chat/completions", { model: "partner", messages: [{ role: "user", content: "Hi" }] });
  assert.equal(calls[0].url, "https://upstream.test/ai/v1/chat/completions");
  assert.equal(calls[0].headers["cf-aig-authorization"], undefined);
});

test("every CF paste form routes chat to compat, Claude messages to REST and the rest to provider endpoints", () => {
  const acct = "d121aa7cd60ccebd6213c931efce41da";
  const envLike = {} as any;
  const gw = `https://gateway.ai.cloudflare.com/v1/${acct}/default`;
  const forms = [
    acct,
    acct.toUpperCase(),
    `${gw}/compat/`,
    `${gw}/compat`,
    `${gw}/compat/models`,
    `${gw}/compat/chat/completions`,
    `${gw}/compat/messages`,
    `${gw}/compat/v1`,
    `${gw}`,
    `https://gateway.ai.cloudflare.com/v1/${acct}/compat/`,
    `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/v1`,
    `https://api.cloudflare.com/client/v4/accounts/${acct}/workers/scripts`
  ];
  for (const address of forms) {
    const cfg = { version: 3 as const, upstream: { address }, identities: [] };
    const resolved = resolveUpstream(envLike, cfg);
    assert.equal(catalogUrl(envLike, cfg), `${gw}/compat/models`, address);
    assert.deepEqual(routeFor(resolved, "chat", "openrouter/anthropic/claude-haiku-4.5"),
      { url: `${gw}/compat/chat/completions`, model: "openrouter/anthropic/claude-haiku-4.5", auth: "bearer" }, address);
    assert.deepEqual(routeFor(resolved, "messages", "anthropic/claude-opus-5"),
      { url: `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/v1/messages`, model: "anthropic/claude-opus-5",
        // A pasted URL that names the default gateway names it; an account ID or a REST URL names none.
        auth: "rest", gateway: address.startsWith(gw) ? "default" : null,
        fallback: { url: `${gw}/anthropic/v1/messages`, model: "claude-opus-5", auth: "cf-aig" } }, address);
    assert.deepEqual(routeFor(resolved, "responses", "openai/gpt-5.6-luna"),
      { url: `${gw}/openai/responses`, model: "gpt-5.6-luna", auth: "cf-aig" }, address);
    assert.deepEqual(routeFor(resolved, "messages", "custom-navy/claude-opus-5"),
      { url: `${gw}/custom-navy/messages`, model: "claude-opus-5", auth: "cf-aig" }, address);
    assert.deepEqual(routeFor(resolved, "responses", "custom-navy/gpt-5.1"),
      { url: `${gw}/custom-navy/responses`, model: "gpt-5.1", auth: "cf-aig" }, address);
  }
});

test("the panel Gateway ID names every CF surface", () => {
  const acct = "b".repeat(32);
  const envLike = { AI_GATEWAY_ID: "my-gw" } as any;
  const cfg = { version: 3 as const, upstream: { address: acct }, identities: [] };
  const resolved = resolveUpstream(envLike, cfg);
  const gw = `https://gateway.ai.cloudflare.com/v1/${acct}/my-gw`;
  assert.equal(catalogUrl(envLike, cfg), `${gw}/compat/models`);
  assert.equal(routeFor(resolved, "chat", "openai/gpt-5.1").url, `${gw}/compat/chat/completions`);
  const claude = routeFor(resolved, "messages", "anthropic/claude-opus-5");
  assert.equal(claude.url, `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/v1/messages`);
  assert.equal(claude.gateway, "my-gw");
  assert.equal(claude.fallback?.url, `${gw}/anthropic/v1/messages`);
  assert.equal(routeFor(resolved, "messages", "custom-navy/claude-opus-5").url, `${gw}/custom-navy/messages`);
  assert.equal(routeFor(resolved, "responses", "openai/gpt-5.1").url, `${gw}/openai/responses`);
});

test("no gateway named anywhere: REST leaves it to CF, URL surfaces use the account's default", () => {
  const acct = "f".repeat(32);
  const cfg = { version: 3 as const, upstream: { address: acct }, identities: [] };
  const resolved = resolveUpstream({} as any, cfg);
  assert.equal(resolved.gatewayId, null);
  assert.equal(routeFor(resolved, "messages", "anthropic/claude-opus-5-5").gateway, null);
  assert.equal(catalogUrl({} as any, cfg), `https://gateway.ai.cloudflare.com/v1/${acct}/default/compat/models`);
  // A blank setting is no gateway either.
  assert.equal(resolveUpstream({ AI_GATEWAY_ID: "  " } as any, cfg).gatewayId, null);
  // A gateway named in a pasted URL wins over the setting.
  const pasted = { version: 3 as const, upstream: { address: `https://gateway.ai.cloudflare.com/v1/${acct}/pasted-gw/compat` }, identities: [] };
  assert.equal(resolveUpstream({ AI_GATEWAY_ID: "panel-gw" } as any, pasted).gatewayId, "pasted-gw");
});

test("Claude ids go to REST in Cloudflare's catalog spelling", () => {
  assert.equal(catalogClaude("claude-opus-5-5"), "claude-opus-5.5");
  assert.equal(catalogClaude("claude-haiku-4-5-20251001"), "claude-haiku-4.5-20251001");
  assert.equal(catalogClaude("claude-opus-5-5-fast"), "claude-opus-5.5-fast");
  for (const name of ["claude-opus-5.5", "claude-opus-5", "claude-sonnet-4-20250514", "claude-opus-5-20260101", "claude-3-7-sonnet-20250219"]) {
    assert.equal(catalogClaude(name), name);
  }
  const resolved = resolveUpstream({} as any, { version: 3, upstream: { address: "f".repeat(32) }, identities: [] });
  const route = routeFor(resolved, "messages", "anthropic/claude-opus-5-5");
  assert.equal(route.model, "anthropic/claude-opus-5.5");
  // The provider endpoint keeps Anthropic's own spelling.
  assert.equal(route.fallback?.model, "claude-opus-5-5");
});

test("Claude messages on CF go to the REST API: token as bearer, catalog id, gateway in cf-aig-gateway-id", async () => {
  setConfig({ ...config(), upstream: { address: "c".repeat(32) } });
  await run("/v1/messages", { model: "anthropic/claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] });
  assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${"c".repeat(32)}/ai/v1/messages`);
  assert.equal(calls[0].query.model, "anthropic/claude-opus-5.5");
  assert.equal(calls[0].headers.authorization, "Bearer cf-token");
  assert.equal(calls[0].headers["cf-aig-authorization"], undefined);
  assert.equal(calls[0].headers["cf-aig-gateway-id"], undefined);
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  env.AI_GATEWAY_ID = "her-gateway";
  await run("/v1/messages", { model: "anthropic/claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] });
  assert.equal(calls[1].headers["cf-aig-gateway-id"], "her-gateway");
  assert.equal(calls[1].url, `https://api.cloudflare.com/client/v4/accounts/${"c".repeat(32)}/ai/v1/messages`);
});

test("what REST alone refuses goes to the provider endpoint; the model's own answers do not", () => {
  assert.equal(restRefused(404, '{"type":"error","error":{"type":"not_found_error","message":"Model not found: anthropic/claude-x"}}'), "model");
  assert.equal(restRefused(400, '{"errors":[{"message":"AiError: No such model","code":5007}],"success":false}'), "model");
  assert.equal(restRefused(401, '{"errors":[{"code":10000,"message":"Authentication error"}],"success":false}'), "token");
  assert.equal(restRefused(403, '{"error":{"type":"forbidden","message":"Request not allowed"}}'), null);
  assert.equal(restRefused(400, '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: too large"}}'), null);
  assert.equal(restRefused(429, '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'), null);
});

test("a model REST does not know is sent to the provider endpoint, and skips REST from then on", async () => {
  setConfig({ ...config(), upstream: { address: "c".repeat(32) } });
  const mock = globalThis.fetch;
  globalThis.fetch = async (url: any, init: any) => {
    if (String(url).startsWith("https://api.cloudflare.com/")) {
      calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), query: JSON.parse(init.body) });
      return Response.json({ type: "error", error: { type: "not_found_error", message: "Model not found: anthropic/claude-old-1" } }, { status: 404 });
    }
    return mock(url, init);
  };
  const body = { model: "anthropic/claude-old-1", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] };
  const first = await run("/v1/messages", body);
  assert.equal(first.response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `https://gateway.ai.cloudflare.com/v1/${"c".repeat(32)}/default/anthropic/v1/messages`);
  assert.equal(calls[1].query.model, "claude-old-1");
  assert.equal(calls[1].headers["cf-aig-authorization"], "Bearer cf-token");
  assert.equal(calls[1].headers.authorization, undefined);
  await run("/v1/messages", body);
  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /gateway\.ai\.cloudflare\.com/);
});

test("a token without Workers AI Read keeps Claude working on the provider endpoint", async () => {
  setConfig({ ...config(), upstream: { address: "c".repeat(32) } });
  env.AI_GATEWAY_ID = "her-gateway";
  const mock = globalThis.fetch;
  globalThis.fetch = async (url: any, init: any) => {
    if (String(url).startsWith("https://api.cloudflare.com/")) {
      calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), query: JSON.parse(init.body) });
      return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 401 });
    }
    return mock(url, init);
  };
  const first = await run("/v1/messages", { model: "anthropic/claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] });
  assert.equal(first.response.status, 200);
  assert.equal(calls[1].url, `https://gateway.ai.cloudflare.com/v1/${"c".repeat(32)}/her-gateway/anthropic/v1/messages`);
  assert.equal(calls[1].headers["cf-aig-gateway-id"], undefined);
  // Another Claude model skips REST too: the token is the problem, not the model.
  await run("/v1/messages", { model: "anthropic/claude-haiku-5-5", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] });
  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /\/her-gateway\/anthropic\/v1\/messages$/);
});

test("a refusal from the model itself is passed on, not retried elsewhere", async () => {
  setConfig({ ...config(), upstream: { address: "c".repeat(32) } });
  globalThis.fetch = async (url: any, init: any) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), query: JSON.parse(init.body) });
    return Response.json({ error: { type: "forbidden", message: "Request not allowed" } }, { status: 403 });
  };
  const { response } = await run("/v1/messages", { model: "anthropic/claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] });
  assert.equal(response.status, 403);
  assert.equal(calls.length, 1);
});

test("background model calls use the gateway the chats use", async () => {
  const used: string[] = [];
  env.AI = { gateway(id: string) { used.push(id); return { run: async () => Response.json({ choices: [] }) }; } };
  await callOpenAICompat(env, { model: "deepseek/deepseek-v4-pro", messages: [] } as any);
  env.AI_GATEWAY_ID = "her-gateway";
  await callOpenAICompat(env, { model: "deepseek/deepseek-v4-pro", messages: [] } as any);
  assert.deepEqual(used, ["default", "her-gateway"]);
  // A gateway named only in the pasted upstream URL reaches them through the saved settings.
  delete env.AI_GATEWAY_ID;
  setConfig({ ...config(), upstream: { address: `https://gateway.ai.cloudflare.com/v1/${"c".repeat(32)}/pasted-gw` } });
  invalidateSettingsCache();
  await callOpenAICompat(applySettings(env, await loadSettings(env)), { model: "deepseek/deepseek-v4-pro", messages: [] } as any);
  assert.equal(used[2], "pasted-gw");
});

test("default thinking mode keeps the tool loop after an injected turn working on Anthropic's own line", async () => {
  // 2026-10-08: remember called right after a recalled turn, the continuation came back 400
  // "Invalid signature in thinking block. The block is bound to a different conversation".
  precious("partner-a", "Cloudflare fan");
  const plain: any = identity();
  delete plain.anthropicThinking;
  setConfig({ ...config([plain]), upstream: { address: "e".repeat(32) } });
  const user = { role: "user", content: "Cloudflare" };
  const body = { model: "anthropic/claude-opus-5-5", max_tokens: 2048, messages: [user] };
  await run("/v1/messages", body);
  assert.match(calls[0].query.messages[0].content, /Cloudflare fan/);
  assert.equal(calls[0].query.thinking, undefined);
  assert.equal(calls[0].headers["anthropic-beta"], undefined);
  const generated = { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "bound-to-injected-prefix" },
    { type: "tool_use", id: "r", name: "remember", input: { content: "fact" } }] };
  const continuation = { ...body, messages: [user, generated, { role: "user", content: [{ type: "tool_result", tool_use_id: "r", content: "saved" }] }] };
  await run("/v1/messages", continuation);
  assert.deepEqual(calls[1].query.messages, continuation.messages);
  assert.deepEqual(calls[1].query.thinking, { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
  assert.match(calls[1].headers["anthropic-beta"], /thinking-binding-controls-2026-08-01/);
  // The same identity on a relay line is left as the client sent it.
  setConfig(config([plain]));
  await run("/v1/messages", { ...continuation, model: "partner", thinking: { type: "adaptive" } });
  assert.deepEqual(calls[2].query.thinking, { type: "adaptive" });
  assert.equal(calls[2].headers["anthropic-beta"], undefined);
  const resolved = resolveUpstream({} as any, { version: 3, upstream: { address: "e".repeat(32) }, identities: [] });
  assert.equal(nativeAnthropic(routeFor(resolved, "messages", "anthropic/claude-opus-5-5")), true);
  for (const model of ["google-vertex-ai/claude-opus-5-5", "custom-navy/claude-opus-5-5", "openrouter/anthropic/claude-opus-5-5"]) {
    assert.equal(nativeAnthropic(routeFor(resolved, "messages", model)), false, model);
  }
});

test("a model that refuses the guessed thinking gets the request exactly as the client sent it", async () => {
  // Opus wrote the signed history, then the chat switched to a model without adaptive thinking.
  const plain: any = { ...identity(), models: ["*haiku*"] };
  delete plain.anthropicThinking;
  setConfig({ ...config([plain]), upstream: { address: "e".repeat(32) } });
  const mock = globalThis.fetch;
  globalThis.fetch = async (url: any, init: any) => {
    const query = JSON.parse(init.body);
    if (query.thinking?.type === "adaptive") {
      calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), query });
      return Response.json({ type: "error", error: { type: "invalid_request_error", message: "adaptive thinking is not supported on this model" } }, { status: 400 });
    }
    return mock(url, init);
  };
  const body = { model: "anthropic/claude-haiku-4-5", max_tokens: 64, messages: [{ role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "opus" }, { type: "text", text: "hello" }] },
    { role: "user", content: "again" }] };
  const { response } = await run("/v1/messages", body, { "anthropic-beta": "client-beta" });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].query.thinking.type, "adaptive");
  assert.equal(calls[1].query.thinking, undefined);
  assert.equal(calls[1].headers["anthropic-beta"], "client-beta");
  assert.deepEqual(calls[1].query.messages.slice(0, 2), body.messages.slice(0, 2));
});

test("any provider gets a native messages/responses route; prefixless models are refused before any upstream call", async () => {
  setConfig({ ...config(), upstream: { address: "d".repeat(32) } });
  await run("/v1/messages", { model: "openrouter/anthropic/claude-haiku-4.5", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] });
  assert.equal(calls[0].url, `https://gateway.ai.cloudflare.com/v1/${"d".repeat(32)}/default/openrouter/v1/messages`);
  assert.equal(calls[0].query.model, "anthropic/claude-haiku-4.5");
  await run("/v1/responses", { model: "openrouter/openai/gpt-5.1", input: "Hi" });
  assert.equal(calls[1].url, `https://gateway.ai.cloudflare.com/v1/${"d".repeat(32)}/default/openrouter/v1/responses`);
  const bare = await run("/v1/messages", { model: "claude-opus-5", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] });
  assert.equal(bare.response.status, 400);
  assert.match(bare.text, /provider prefix/);
  assert.equal(calls.length, 2);
});

test("settings edited in the admin page override deployment vars everywhere", async () => {
  const withSettings = { ...config(), settings: { CHAT_MODEL: "chosen-in-admin", MEMORY_FILTER_MAX_OUTPUT: " 5 ", DREAM_TIME_ZONE: "" } };
  assert.equal((await worker.fetch(request("/api/gateway/config", withSettings, {}, "PUT"), env, ctx)).status, 200);
  invalidateSettingsCache();
  // Blank stays unset, whitespace is trimmed, and the value reaches unrelated handlers.
  const saved = JSON.parse((await run("/api/gateway/config")).text).settings;
  assert.deepEqual(saved, { CHAT_MODEL: "chosen-in-admin", MEMORY_FILTER_MAX_OUTPUT: "5" });
  const health = JSON.parse((await run("/health")).text);
  assert.equal(health.missing_optional_text_vars.includes("CHAT_MODEL"), false);
  assert.equal(health.missing_optional_text_vars.includes("VISION_MODEL"), true);
  // The env report shows the saved value next to what the Worker was deployed with.
  env.VISION_MODEL = "deployed-vision";
  const report = JSON.parse((await run("/api/gateway/env")).text);
  const items = report.groups.flatMap((g: any) => g.items);
  assert.deepEqual(items.find((i: any) => i.name === "CHAT_MODEL").value, "chosen-in-admin");
  assert.deepEqual(items.find((i: any) => i.name === "VISION_MODEL"), { name: "VISION_MODEL", label: "看图模型", hint: "", labelEn: "Model for images", hintEn: "", value: "", deployed: "deployed-vision" });
  assert.equal(report.groups.find((g: any) => g.group === "模型与线路").groupEn, "Models & routing");
  assert.equal(report.secrets.find((x: any) => x.name === "CHATBOX_API_KEY").present, true);
  assert.equal(report.secrets.find((x: any) => x.name === "DEBUG_API_KEY").present, false);
  assert.equal((await worker.fetch(request("/api/gateway/env", undefined, { authorization: "Bearer im-key" }), env, ctx)).status, 401);
  assert.throws(() => validateConfig({ ...config(), settings: { DB: "hijacked" } }), /Unknown setting/);
});

test("settings page saves one item at a time without touching the rest of the config", async () => {
  const start = { ...config(), upstream: { address: "https://keep.test/v1" }, settings: { CHAT_MODEL: "kept", DREAM_MODEL: "old-dream" } };
  assert.equal((await worker.fetch(request("/api/gateway/config", start, {}, "PUT"), env, ctx)).status, 200);
  // One switch flipped: only that key changes; "" drops a key back to the deployed value.
  const patched = await worker.fetch(request("/api/gateway/config", { settings: { CLEF_AUTO_REVIEW: "true", DREAM_MODEL: "" } }, {}, "PATCH"), env, ctx);
  assert.equal(patched.status, 200);
  assert.deepEqual((await patched.json() as any).settings, { CHAT_MODEL: "kept", CLEF_AUTO_REVIEW: "true" });
  let saved = JSON.parse((await run("/api/gateway/config")).text);
  assert.deepEqual(saved.settings, { CHAT_MODEL: "kept", CLEF_AUTO_REVIEW: "true" });
  assert.equal(saved.upstream.address, "https://keep.test/v1");
  assert.equal(saved.identities[0].slug, "partner");
  // Saving the assistants leaves every setting alone; upstream: null removes it.
  const renamed = [{ ...identity(), userName: "小南" }];
  assert.equal((await worker.fetch(request("/api/gateway/config", { identities: renamed, upstream: null }, {}, "PATCH"), env, ctx)).status, 200);
  saved = JSON.parse((await run("/api/gateway/config")).text);
  assert.deepEqual(saved.settings, { CHAT_MODEL: "kept", CLEF_AUTO_REVIEW: "true" });
  assert.equal(saved.identities[0].userName, "小南");
  assert.equal(saved.upstream, undefined);
  // Bad patches are refused whole and change nothing.
  for (const bad of [{ settings: { DB: "hijacked" } }, { identities: "nope" }, [1]]) {
    assert.equal((await worker.fetch(request("/api/gateway/config", bad, {}, "PATCH"), env, ctx)).status, 400);
  }
  assert.deepEqual(JSON.parse((await run("/api/gateway/config")).text).settings, { CHAT_MODEL: "kept", CLEF_AUTO_REVIEW: "true" });
  assert.equal((await worker.fetch(request("/api/gateway/config", { settings: {} }, { authorization: "Bearer im-key" }, "PATCH"), env, ctx)).status, 401);
  // The env report tells the page which items are switches, their code default, and which are everyday ones.
  invalidateSettingsCache();
  const items = JSON.parse((await run("/api/gateway/env")).text).groups.flatMap((g: any) => g.items);
  const clef = items.find((i: any) => i.name === "CLEF_AUTO_REVIEW");
  assert.equal(clef.kind, "switch");
  assert.equal(clef.defaultOn, true);
  assert.equal(clef.common, true);
  assert.equal(clef.value, "true");
  assert.equal(items.find((i: any) => i.name === "ENABLE_DREAM").defaultOn, true);
  assert.equal(items.find((i: any) => i.name === "CHAT_MODEL").kind, undefined);
});

test("read-space configuration is backwards compatible, bounded, explicit and round-trips via admin", async () => {
  assert.equal(identityNamespace(identity() as any), "partner-a");
  assert.deepEqual(identityReadNamespaces(identity() as any), ["partner-a"]);
  assert.deepEqual(identityReadNamespaces({ ...identity(), readNamespaces: [] } as any), []);
  for (const readNamespaces of [[""], ["a", "a"], [" a"], [42], "a", Array.from({ length: 9 }, (_, i) => String(i))]) {
    assert.throws(() => validateConfig({ ...config(), identities: [{ ...identity(), readNamespaces }] }), /readNamespaces/);
  }
  const updated = { ...config(), identities: [{ ...identity(), namespace: "new", readNamespaces: ["old", "shared", "new"] }] };
  assert.equal((await worker.fetch(request("/api/gateway/config", updated, {}, "PUT"), env, ctx)).status, 200);
  assert.deepEqual(JSON.parse((await run("/api/gateway/config")).text).identities[0].readNamespaces, ["old", "shared", "new"]);
});

test("identity speaker names are optional, bounded, and used by the matching write space", async () => {
  assert.equal(speakersForNamespace(config() as any, "partner-a"), null);
  for (const bad of ["", " \n ", "n".repeat(33), "a\nb"]) {
    assert.throws(() => validateConfig({ ...config(), identities: [{ ...identity(), userName: bad }] }), /userName/);
  }
  const named = { ...config(), identities: [{ ...identity(), userName: "小南", assistantName: "小北" }] };
  const saved = validateConfig(named);
  assert.deepEqual(speakersForNamespace(saved, "partner-a"), { userName: "小南", assistantName: "小北" });
  assert.equal(speakersForNamespace(saved, "other"), null);
  const slugFallback = validateConfig({ ...config(), identities: [{ ...identity(), userName: "小南" }] });
  assert.equal(speakersForNamespace(slugFallback, "partner-a")?.assistantName, "partner");
  assert.equal((await worker.fetch(request("/api/gateway/config", named, {}, "PUT"), env, ctx)).status, 200);
  assert.deepEqual(JSON.parse((await run("/api/gateway/config")).text).identities[0].userName, "小南");
});

test("cross-space recall shares one budget, deduplicates and records provenance while writes stay in the new space", async () => {
  const updated = { ...config(), settings: { MEMORY_FILTER_MAX_OUTPUT: "3" }, identities: [{ ...identity(), namespace: "new", readNamespaces: ["old", "shared"] }] };
  setConfig(updated);
  precious("old", "Cloudflare old memory"); precious("shared", "Cloudflare shared memory");
  precious("old", "Cloudflare duplicate"); precious("shared", "Cloudflare duplicate");
  precious("private", "Cloudflare private memory"); precious("new", "Cloudflare not in read list");
  const { response } = await run("/v1/chat/completions", { model: "partner", namespace: "private", readNamespaces: ["private"], messages: [{ role: "user", content: "Cloudflare memory" }] });
  assert.equal(response.status, 200);
  const prompt = calls[0].query.messages[0].content;
  assert.match(prompt, /Cloudflare old memory/);
  assert.doesNotMatch(prompt, /Cloudflare shared memory/);
  assert.doesNotMatch(prompt, /private memory|not in read list/);
  assert.equal((prompt.match(/Cloudflare duplicate/g) || []).length, 0);
  assert.equal((prompt.match(/^-/gm) || []).length, 1);
  assert.equal(queue[0].namespace, "new");
  await persistExchange(env, queue[0]);
  assert.deepEqual(sqlite.prepare("SELECT DISTINCT namespace FROM messages").all().map((r: any) => r.namespace), ["new"]);
  const trace = JSON.parse((sqlite.prepare("SELECT payload_json FROM memory_events WHERE event_type = 'recall_explain'").get() as any).payload_json as string);
  assert.deepEqual(trace.read_namespaces, ["old", "shared"]);
  assert.equal(trace.write_namespace, "new");
  assert.deepEqual([...new Set(trace.items.map((x: any) => x.namespace))], ["old"]);
  assert.ok(trace.decisions.some((x: any) => x.namespace === "shared" && x.reason === "duplicate_content"));
  assert.ok(trace.decisions.some((x: any) => x.namespace === "shared" && x.reason === "item_budget"));
});

test("two identities can share a space and disabled recall still records original utterances", async () => {
  setConfig({ ...config(), identities: [{ ...identity(), namespace: "shared" }, { ...identity(), slug: "other", namespace: "shared", readNamespaces: [] }] });
  precious("shared", "Cloudflare shared source");
  const body = { model: "partner", messages: [{ role: "user", content: "Cloudflare" }] };
  assert.equal((await run("/partner/v1/chat/completions", body)).response.headers.get("x-aelios-memory"), "injected");
  assert.equal((await run("/other/v1/chat/completions", body)).response.headers.get("x-aelios-memory"), "empty");
  assert.deepEqual(calls[1].query.messages, body.messages);
  assert.equal(queue[1].namespace, "shared");
  assert.equal(queue[1].userText, "Cloudflare");
  assert.notEqual(queue[0].userId, queue[1].userId);
});

test("one unavailable space does not suppress healthy recall; trace lists the failed space", async () => {
  setConfig({ ...config(), identities: [{ ...identity(), readNamespaces: ["broken", "shared"] }] });
  precious("shared", "Cloudflare healthy source");
  const prepare = db.prepare;
  env.DB = { ...db, prepare(sql: string) {
    const statement = prepare(sql);
    const bind = statement.bind;
    statement.bind = (...args: any[]) => {
      bind(...args);
      if (sql.includes("FROM precious") && args.includes("broken")) statement.all = async () => { throw Error("space unavailable"); };
      return statement;
    };
    return statement;
  } };
  assert.equal((await run("/v1/chat/completions", { model: "partner", messages: [{ role: "user", content: "Cloudflare" }] })).response.headers.get("x-aelios-memory"), "injected");
  const trace = JSON.parse((sqlite.prepare("SELECT payload_json FROM memory_events WHERE event_type = 'recall_explain'").get() as any).payload_json as string);
  assert.deepEqual(trace.failed_namespaces, ["broken"]);
});

test("ordinary-memory injection accounting stays in the source space, not the write space", async () => {
  setConfig({ ...config(), identities: [{ ...identity(), namespace: "write-only", readNamespaces: ["archive"] }] });
  env.MEMORY_FILTER_ENABLED = "false";
  sqlite.prepare(`INSERT INTO memories (id, namespace, type, content, importance, confidence, created_at, updated_at)
    VALUES ('shared-fact', 'archive', 'fact', 'Cloudflare is our preferred platform', 1, 1, '2026-09-06', '2026-09-06')`).run();
  const { response } = await run("/v1/chat/completions", { model: "partner", messages: [{ role: "user", content: "Cloudflare platform" }] });
  assert.equal(response.headers.get("x-aelios-memory"), "injected");
  const lifecycle = sqlite.prepare("SELECT namespace, last_injected_at FROM memory_lifecycle WHERE memory_id = 'shared-fact'").get();
  assert.equal(lifecycle?.namespace, "archive");
  assert.ok(lifecycle?.last_injected_at);
});

test("invalid Anthropic requests fail before HTTP, recall or human-memory writes", async () => {
  for (const extra of [{ max_tokens: undefined }, { max_tokens: "64" }, { thinking: "bad" },
    { thinking: { type: "enabled", budget_tokens: 32 } }, { thinking: { type: "oops" } },
    { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "orphan", content: "done" }] }] }]) {
    const { response, text } = await run("/v1/messages", { model: "partner", max_tokens: 2048,
      messages: [{ role: "user", content: "请记住：不能保存这句" }], ...extra });
    assert.equal(response.status, 400, text);
    assert.equal(JSON.parse(text).error.type, "invalid_request_error");
  }
  assert.equal(calls.length, 0); assert.equal(queue.length, 0);
  assert.equal(count("messages"), 0); assert.equal(count("memories"), 0); assert.equal(count("memory_events"), 0);
});

test("normalization runs on side models without enabling thinking; session metadata still separates recordings", async () => {
  const body = { model: "side-model", max_tokens: 128, display: "UI", output_config: { effort: "low" },
    messages: [{ role: "user", content: "hello", ui_id: "local" }] };
  const side = await run("/v1/messages", body);
  assert.equal(side.response.status, 200);
  assert.equal(side.response.headers.get("x-aelios-normalized"), "2");
  assert.equal(calls[0].query.display, undefined);
  assert.equal(calls[0].query.thinking, undefined);
  assert.deepEqual(calls[0].query.output_config, body.output_config);
  assert.equal(queue.length, 0);
  for (const session_id of ["one", "two"]) await run("/v1/messages", { ...body, model: "partner", thinking: { type: "disabled" }, metadata: { session_id, user_id: "u" } });
  assert.notEqual(queue[0].userId, queue[1].userId);
  assert.deepEqual(calls[1].query.metadata, { user_id: "u" });
});

test("memory plus thinking survives the entire simulated tool loop with upstream-owned mismatch handling", async () => {
  precious("partner-a", "Cloudflare fan");
  const user = { role: "user", content: "Cloudflare" };
  const history = [{ role: "user", content: "previous" }, { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "old-signature" }, { type: "text", text: "answer" }] }];
  const body = { model: "partner", max_tokens: 2048, thinking: { type: "adaptive", display: "omitted" }, messages: [...history, user] };
  await run("/v1/messages", body);
  assert.match(calls[0].query.messages.at(-1).content, /Cloudflare fan/);
  assert.deepEqual(calls[0].query.messages.slice(0, -1), history);
  const generated = { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "bound-to-injected-prefix" }, { type: "tool_use", id: "t", name: "lookup", input: {} }] };
  const continuation = { ...body, messages: [...body.messages, generated, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "done" }] }] };
  const second = await run("/v1/messages", continuation);
  assert.equal(second.response.headers.get("x-aelios-memory"), "skipped");
  assert.deepEqual(calls[1].query.messages, continuation.messages);
  assert.equal(calls[1].query.thinking.block_binding.prefix_mismatch_behavior, "drop_block");
  assert.match(calls[1].headers["anthropic-beta"], /thinking-binding-controls/);
  const mixed = { ...continuation, messages: [...continuation.messages.slice(0, -1), { role: "user", content: [...continuation.messages.at(-1)!.content as any[], { type: "text", text: "Also Cloudflare" }] }] };
  const third = await run("/v1/messages", mixed);
  assert.equal(third.response.headers.get("x-aelios-memory"), "injected");
  assert.equal(calls[2].query.messages.at(-1).content[0].type, "tool_result");
  assert.deepEqual(calls[2].query.messages.slice(0, -1), mixed.messages.slice(0, -1));
});

test("reranked recall is wired across sources and stays out of conversation storage", async () => {
  await run("/v1/chat/completions", {model:"partner",messages:[{role:"user",content:"请记住你喜欢下雨天喝热豆浆"}]});
  precious("partner-a", "下雨天，你答应永远找到旦九。");
  precious("partner-b", "下雨天其他身份的秘密。");
  const result=await run("/v1/chat/completions",{model:"partner",messages:[{role:"user",content:"下雨了，早餐吃点什么呢"}]});
  assert.equal(result.response.headers.get("x-aelios-memory"),"injected");
  const prompt=calls.at(-1).query.messages[0].content;
  assert.match(prompt,/热豆浆/);assert.doesNotMatch(prompt,/永远|秘密|event_key/);
  assert.equal((prompt.match(/^- /gm)||[]).length,1);
  const history=await run("/api/gateway/recalls?identity=partner");
  const records=JSON.parse(history.text).items;
  const trace=records.find((r:any)=>r.selection?.status==="reranked");
  assert.ok(trace.decisions.some((d:any)=>d.injected&&d.excerpt.includes("热豆浆")));
});

test("reranker failure continues the chat with a lexical fallback", async () => {
  precious("partner-a","你喜欢雨天喝热豆浆。");
  env.AI={async run(){throw new Error("down");}};
  const result=await run("/v1/chat/completions",{model:"partner",messages:[{role:"user",content:"雨天喝什么"}]});
  assert.equal(result.response.status,200);assert.equal(result.response.headers.get("x-aelios-memory"),"injected");
  assert.match(calls.at(-1).query.messages[0].content,/热豆浆/);
  const rows=JSON.parse((await run("/api/gateway/recalls?identity=partner")).text).items;
  assert.equal(rows[0].selection.status,"lexical");assert.equal(rows[0].selection.reason,"reranker_failed");
  assert.equal((await run("/api/gateway/recalls?identity=partner",undefined,{authorization:"Bearer im-key"})).response.status,401);
  assert.equal((await run("/api/gateway/recalls?identity=missing")).response.status,400);
});

test("recall history filters identities sharing the same write space", async () => {
  setConfig({...config(),identities:[identity(),{...identity(),slug:"other"}]});
  precious("partner-a","你喜欢 Cloudflare。");
  await run("/partner/v1/chat/completions",{model:"partner",messages:[{role:"user",content:"Cloudflare 怎么样"}]});
  await run("/other/v1/chat/completions",{model:"partner",messages:[{role:"user",content:"Cloudflare 好用吗"}]});
  const rows=JSON.parse((await run("/api/gateway/recalls?identity=partner")).text).items;
  assert.equal(rows.length,1);assert.equal(rows[0].identity,"partner");
});

test('retired gateway page redirects to the unified admin without reading credentials or configuration', async () => {
  const response = await worker.fetch(new Request('https://aelios.test/admin/gateway'), {} as any, ctx);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin');
  assert.equal(await response.text(), '');
});

test("default recall batches ordinary memories and precious across spaces once, and exposes scores", async () => {
  setConfig({...config(),identities:[{...identity(),readNamespaces:["partner-a","shared"]}]});
  precious("shared","Cloudflare 还有一条珍贵回忆。");
  precious("private","Cloudflare 其他空间的秘密。");
  sqlite.prepare(`INSERT INTO memories (id, namespace, type, content, importance, confidence, created_at, updated_at)
    VALUES ('rank-fact', 'partner-a', 'fact', 'Cloudflare 是我们用的记忆平台。', 1, 1, '2026-09-06', '2026-09-06')`).run();
  let rankingCalls=0;
  env.AI.run=async(model:string,data:any)=>{
    if(!model.includes("reranker"))throw new Error("embedding unavailable in test");
    rankingCalls++;
    assert.ok(data.contexts.some((c:any)=>c.text.includes("记忆平台")));
    assert.ok(data.contexts.some((c:any)=>c.text.includes("珍贵回忆")));
    assert.ok(data.contexts.every((c:any)=>!c.text.includes("秘密")));
    return {response:data.contexts.map((c:any,id:number)=>({id,score:c.text.includes("记忆平台")?0.92:0.2}))};
  };
  const result=await run("/v1/chat/completions",{model:"partner",messages:[{role:"user",content:"Cloudflare 平台"}]});
  assert.equal(result.response.status,200);assert.equal(rankingCalls,1);assert.equal(calls.length,1);
  assert.match(calls[0].query.messages[0].content,/记忆平台/);
  assert.doesNotMatch(calls[0].query.messages[0].content,/珍贵回忆|秘密|rank-fact|0.92/);
  const trace=JSON.parse((await run("/api/gateway/recalls?identity=partner")).text).items[0];
  assert.equal(trace.selection.status,"reranked");assert.equal(trace.selection.threshold,0.25);
  assert.ok(Number.isFinite(trace.selection.elapsed_ms));
  assert.ok(trace.decisions.some((d:any)=>d.score===0.92&&d.injected));
  assert.ok(trace.decisions.some((d:any)=>d.score===0.2&&!d.injected));
  assert.equal(queue.length,1);assert.equal(queue[0].userText,"Cloudflare 平台");
});
test("Workers AI failure continues the chat with a lexical fallback", async () => {
  precious("partner-a","你喜欢 Cloudflare。");
  env.AI.run=async()=>{throw new Error("not available");};
  const result=await run("/v1/chat/completions",{model:"partner",messages:[{role:"user",content:"Cloudflare 好用吗"}]});
  assert.equal(result.response.status,200);assert.equal(result.response.headers.get("x-aelios-memory"),"injected");
  assert.match(calls[0].query.messages[0].content,/Cloudflare/);
  const trace=JSON.parse((await run("/api/gateway/recalls?identity=partner")).text).items[0];
  assert.equal(trace.selection.status,"lexical");assert.equal(trace.selection.reason,"reranker_failed");assert.equal(queue.length,1);
});
test("keeping a candidate back to pending does not wipe its target memory link", async () => {
  const { updateMemoryCandidateStatus } = await import("../src/db/v2/candidates");
  sqlite.prepare(`INSERT INTO memory_candidates
    (id, namespace, type, content, confidence, importance, source, status, target_memory_id, decision_note, created_at, updated_at)
    VALUES (?, ?, 'fact', '调试暗号换成芝麻关门', 0.6, 0.6, 'dream_update', 'pending', ?, ?, ?, ?)`)
    .run("cand_keep", "partner-a", "mem_old", "extracted", "2026-09-06", "2026-09-06");

  // judge 的 keep 分支只传 status 和 decisionNote，不传 targetMemoryId。
  const kept = await updateMemoryCandidateStatus(db, {
    namespace: "partner-a",
    id: "cand_keep",
    status: "pending",
    decisionNote: "judge: 说不准，留给人工"
  });
  assert.equal(kept?.target_memory_id, "mem_old");
  assert.equal(kept?.decision_note, "judge: 说不准，留给人工");

  // 显式传 null 仍然是清空。
  const cleared = await updateMemoryCandidateStatus(db, {
    namespace: "partner-a",
    id: "cand_keep",
    status: "pending",
    targetMemoryId: null
  });
  assert.equal(cleared?.target_memory_id, null);
  assert.equal(cleared?.decision_note, "judge: 说不准，留给人工");
});

test("the settings page can see how many memories each space holds", async () => {
  const add = sqlite.prepare(`INSERT INTO memories (id, namespace, type, content, status, importance, confidence, created_at, updated_at)
    VALUES (?, ?, 'fact', ?, ?, 1, 1, '2026-09-06', '2026-09-06')`);
  add.run("d1", "default", "咲咲住在武汉", "active");
  add.run("d2", "default", "咲咲喜欢越南咖啡", "active");
  add.run("d3", "default", "旧的住址", "archived");
  add.run("p1", "partner", "partner fact", "active");
  const { response, text } = await run("/api/gateway/spaces");
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(text).spaces, [{ namespace: "default", memories: 2 }, { namespace: "partner", memories: 1 }]);
  assert.equal((await worker.fetch(request("/api/gateway/spaces", undefined, { authorization: "Bearer im-key" }), env, ctx)).status, 401);
});

test("explicit conversation ids and retry hashes stay namespace-local", async () => {
  const first = await getOrCreateConversation(db, { namespace: "space-a", id: "shared-client-id" });
  const second = await getOrCreateConversation(db, { namespace: "space-b", id: "shared-client-id" });
  assert.equal(first.namespace, "space-a");
  assert.equal(second.namespace, "space-b");
  assert.notEqual(second.id, first.id);
  assert.equal((await getOrCreateConversation(db, { namespace: "space-b", id: "shared-client-id" })).id, second.id);

  const save = (conversationId: string, namespace: string) => saveUserMessages(db, {
    conversationId,
    namespace,
    source: "test",
    messages: [{ role: "user", content: "same words" }],
    requestModel: "test",
    upstreamModel: "test",
    upstreamProvider: "test",
    stream: false
  });
  const [firstMessage] = await save(first.id, first.namespace);
  const [secondMessage] = await save(second.id, second.namespace);
  assert.notEqual(firstMessage, secondMessage);
  const rows = sqlite.prepare("SELECT namespace, conversation_id FROM messages WHERE id IN (?, ?)").all(firstMessage, secondMessage) as any[];
  assert.deepEqual(rows.map((row) => [row.namespace, row.conversation_id]).sort(), [["space-a", first.id], ["space-b", second.id]]);
});

// ---- model list: what /v1/models shows, never what can be called ----
async function admin(method: string, body?: any, headers: any = {}, path = "/api/gateway/config") {
  const response = await worker.fetch(request(path, body, headers, method), env, ctx);
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : null };
}
const LISTED = ["openai/gpt-5", "openrouter/openai/gpt-6.1-sol:floor", "custom-mine/tiny", "dynamic/router-1", "chatgpt/gpt-5"];

test("a saved model list is the whole /v1/models answer: owner's order, hand-typed names kept, upstream never asked", async () => {
  setConfig({ ...config(), modelList: LISTED });
  const models = await run("/v1/models");
  assert.equal(models.response.status, 200);
  const body = JSON.parse(models.text);
  assert.equal(body.object, "list");
  assert.deepEqual(body.data.map((m: any) => m.id), LISTED);
  assert.deepEqual(body.data.map((m: any) => m.owned_by), ["openai", "openrouter", "custom-mine", "dynamic", "chatgpt"]);
  // Which of them get memory under this identity (its main models are "partner", "listed-model" and "*opus*").
  assert.deepEqual(body.data.map((m: any) => m.aelios.main), [false, false, false, false, false]);
  assert.ok(body.data.every((m: any) => m.object === "model"));
  assert.equal(models.response.headers.get("x-aelios-models"), "list");
  assert.match(String(models.response.headers.get("cache-control")), /no-store/);
  assert.equal(calls.length, 0, "the thousand-model catalog is not fetched when a list decides the answer");
  // Without CF credentials the list still answers: it does not depend on the upstream.
  delete env.CLOUDFLARE_API_TOKEN;
  assert.deepEqual(JSON.parse((await run("/v1/models")).text).data.map((m: any) => m.id), LISTED);
});

test("an empty or missing model list leaves /v1/models exactly as it was", async () => {
  for (const modelList of [undefined, []]) {
    setConfig({ ...config(), ...(modelList ? { modelList } : {}) });
    const models = await run("/v1/models");
    assert.equal(models.response.headers.get("x-aelios-models"), "upstream");
    assert.deepEqual(JSON.parse(models.text).data.map((m: any) => m.id), ["anthropic/claude-opus-4-5"]);
  }
});

test("models outside the list still work: the list is display only", async () => {
  setConfig({ ...config(), modelList: ["openai/gpt-5"] });
  for (const model of ["anthropic/claude-opus-4-5", "openrouter/openai/gpt-6.1-sol:floor", "custom-other/unlisted"]) {
    calls.length = 0;
    const reply = await run("/v1/chat/completions", { model, messages: [{ role: "user", content: "Hi" }] });
    assert.equal(reply.response.status, 200, model);
    assert.equal(calls[0].url, "https://upstream.test/ai/v1/chat/completions");
    assert.equal(calls[0].query.model, model);
  }
});

test("model list validation: trimmed, de-duplicated, order kept, empty means none", () => {
  const base = { version: 3, identities: [] };
  assert.deepEqual(validateConfig({ ...base, modelList: [" a/b ", "c", "a/b"] }).modelList, ["a/b", "c"]);
  assert.equal("modelList" in validateConfig({ ...base, modelList: [] }), false);
  assert.equal("modelList" in validateConfig({ ...base, modelList: null }), false);
  assert.equal("modelList" in validateConfig(base), false);
  for (const bad of ["a/b", [""], [" "], ["has space"], [1], ["x".repeat(201)], Array.from({ length: 301 }, (_, i) => `m/${i}`)]) {
    assert.throws(() => validateConfig({ ...base, modelList: bad as any }), /modelList/, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal(validateConfig({ ...base, modelList: Array.from({ length: 300 }, (_, i) => `m/${i}`) }).modelList?.length, 300);
});

test("the list is saved with PATCH by the owner only, and other PATCHes leave it alone", async () => {
  assert.equal((await admin("PATCH", { modelList: ["a/b"] }, { authorization: "Bearer im-key" })).response.status, 401);
  const saved = await admin("PATCH", { modelList: [" openai/gpt-5 ", "custom-mine/tiny", "openai/gpt-5"] });
  assert.equal(saved.response.status, 200);
  assert.deepEqual(saved.json.modelList, ["openai/gpt-5", "custom-mine/tiny"]);
  assert.deepEqual((await admin("GET")).json.modelList, ["openai/gpt-5", "custom-mine/tiny"]);
  // The identities save and the settings saves in /admin never carry the list; they must not wipe it.
  await admin("PATCH", { identities: [identity()] });
  await admin("PATCH", { settings: { VISION_MODEL: "x/vision" } });
  assert.deepEqual((await admin("GET")).json.modelList, ["openai/gpt-5", "custom-mine/tiny"]);
  // And it is what the clients see right away.
  assert.deepEqual(JSON.parse((await run("/v1/models")).text).data.map((m: any) => m.id), ["openai/gpt-5", "custom-mine/tiny"]);
  const bad = await admin("PATCH", { modelList: ["has space"] });
  assert.equal(bad.response.status, 400);
  assert.deepEqual((await admin("GET")).json.modelList, ["openai/gpt-5", "custom-mine/tiny"], "a refused save changes nothing");
  assert.deepEqual((await admin("PATCH", { modelList: [] })).json.modelList, []);
  assert.equal("modelList" in (await admin("GET")).json, false);
  assert.equal(JSON.parse((await run("/v1/models")).text).data[0].id, "anthropic/claude-opus-4-5", "cleared: the whole upstream catalog again");
});

test("the picker catalog: owner only, every upstream id once and sorted, the saved list beside it, even while a list is saved", async () => {
  setConfig({ ...config(), modelList: ["custom-mine/tiny"] });
  assert.equal((await admin("GET", undefined, { authorization: "Bearer im-key" }, "/api/gateway/models")).response.status, 401);
  const mock = globalThis.fetch;
  globalThis.fetch = async (url: any) => {
    calls.push({ url: String(url) });
    return Response.json({ object: "list", data: [{ id: "openai/gpt-5" }, { id: "anthropic/claude-opus-4-5" }, { id: "openai/gpt-5" }, { nope: true }, null, { id: 7 }] });
  };
  try {
    const picker = await admin("GET", undefined, {}, "/api/gateway/models");
    assert.equal(picker.response.status, 200);
    assert.deepEqual(picker.json.models, ["anthropic/claude-opus-4-5", "openai/gpt-5"]);
    assert.deepEqual(picker.json.list, ["custom-mine/tiny"]);
    assert.deepEqual(picker.json.chatgpt, []);
    assert.equal(picker.json.source, "upstream");
    assert.equal(calls.at(-1).url, "https://upstream.test/ai/v1/models");
    globalThis.fetch = async () => new Response("nope", { status: 502 });
    const down = await admin("GET", undefined, {}, "/api/gateway/models");
    assert.equal(down.response.status, 200);
    assert.deepEqual(down.json.models, []);
    assert.equal(down.json.source, "unavailable");
    assert.equal(down.json.reason, "upstream-502");
    assert.deepEqual(down.json.list, ["custom-mine/tiny"], "the saved list is still there to edit");
    globalThis.fetch = async () => new Response("<html>", { status: 200 });
    assert.equal((await admin("GET", undefined, {}, "/api/gateway/models")).json.reason, "unexpected-catalog");
  } finally { globalThis.fetch = mock; }
});

// ---- model connectivity test: one tiny real request, sent the way a client's is, recorded nowhere ----
const testModel = (model: any, headers: any = {}) => admin("POST", { model }, headers, "/api/gateway/models/test");
const completion = (content = "OK") => Response.json({ model: "actual", choices: [{ index: 0, message: { content }, finish_reason: "stop" }] });

test("model test: owner only, and the model must be a name", async () => {
  assert.equal((await testModel("a/b", { authorization: "Bearer im-key" })).response.status, 401);
  for (const bad of [undefined, "", "has space", "x".repeat(201), 7]) {
    assert.equal((await testModel(bad)).response.status, 400, JSON.stringify(bad)?.slice(0, 20));
  }
  assert.equal(calls.length, 0, "nothing was sent upstream for a refused input");
});

test("model test: a model that answers passes, over the same chat route a client uses, and nothing is recorded", async () => {
  const mock = globalThis.fetch;
  globalThis.fetch = async (url: any, init: any) => { calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)), query: JSON.parse(init.body) }); return completion(" OK \n"); };
  try {
    const result = await testModel("openrouter/openai/gpt-6.1-sol:floor");
    assert.equal(result.response.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.status, 200);
    assert.equal(result.json.reply, "OK");
    assert.equal(typeof result.json.latency_ms, "number");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://upstream.test/ai/v1/chat/completions");
    assert.equal(calls[0].headers.authorization, "Bearer cf-token");
    assert.equal(calls[0].query.model, "openrouter/openai/gpt-6.1-sol:floor");
    assert.equal(calls[0].query.stream, false);
    assert.equal(calls[0].query.max_tokens, 32);
    assert.equal(calls[0].query.messages.length, 1, "no memory is added to a connectivity test");
    await Promise.all(pending);
    assert.equal(queue.length, 0);
    assert.equal(count("gateway_exchanges"), 0);
    assert.equal(count("messages"), 0);
  } finally { globalThis.fetch = mock; }
});

test("model test: a refusal comes back with the upstream's own words; HTML is cut down; a 200 that is not a completion fails", async () => {
  const mock = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ error: { message: "The model `nope/x` does not exist." } }, { status: 404 });
    const missing = await testModel("nope/x");
    assert.deepEqual([missing.json.ok, missing.json.status, missing.json.error], [false, 404, "The model `nope/x` does not exist."]);
    globalThis.fetch = async () => new Response(`<html>${"x".repeat(2000)}</html>`, { status: 502 });
    const html = await testModel("a/b");
    assert.equal(html.json.ok, false);
    assert.equal(html.json.status, 502);
    assert.ok(html.json.error.length <= 300);
    globalThis.fetch = async () => Response.json({ hello: "world" });
    assert.match((await testModel("a/b")).json.error, /not with a chat completion/);
    globalThis.fetch = async () => new Response("<html>login</html>", { status: 200 });
    assert.match((await testModel("a/b")).json.error, /not with JSON/);
    globalThis.fetch = async () => { throw new Error("connection reset"); };
    const reset = await testModel("a/b");
    assert.deepEqual([reset.json.ok, reset.json.status, reset.json.error], [false, 0, "connection reset"]);
  } finally { globalThis.fetch = mock; }
  delete env.CLOUDFLARE_API_TOKEN;
  const unset = await testModel("a/b");
  assert.equal(unset.json.ok, false);
  assert.match(unset.json.error, /CLOUDFLARE_API_TOKEN/);
});

test("model test: a reasoning model that wants max_completion_tokens is asked once more with it", async () => {
  const mock = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = async (_url: any, init: any) => {
    const body = JSON.parse(init.body); sent.push(body);
    return "max_tokens" in body
      ? Response.json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }, { status: 400 })
      : completion();
  };
  try {
    const result = await testModel("openai/gpt-5");
    assert.equal(result.json.ok, true);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].max_completion_tokens, 32);
    assert.equal("max_tokens" in sent[1], false);
    // A 400 about anything else is the answer, not a reason to retry.
    sent.length = 0;
    globalThis.fetch = async (_url: any, init: any) => { sent.push(1); return Response.json({ error: { message: "bad key" } }, { status: 400 }); };
    const other = await testModel("openai/gpt-5");
    assert.deepEqual([other.json.ok, other.json.error, sent.length], [false, "bad key", 1]);
  } finally { globalThis.fetch = mock; }
});

test("the model list marks which models get memory under the asking identity; other clients can ignore it", async () => {
  const other = { ...identity(), slug: "other", namespace: "partner-b", keys: ["IM_API_KEY"], models: ["chatgpt/*", "*sol*"] };
  setConfig({ ...config([identity(), other]), modelList: ["anthropic/claude-opus-4-5", "partner", "chatgpt/gpt-5", "openrouter/openai/gpt-6.1-sol:floor", "custom-mine/tiny"] });
  const mark = async (path: string, headers?: any) =>
    Object.fromEntries(JSON.parse((await run(path, undefined, headers)).text).data.map((m: any) => [m.id, m.aelios.main]));
  // "partner" and "*opus*" are main models for the first identity: the pattern matches the full name or the part after the last slash.
  assert.deepEqual(await mark("/v1/models"), {
    "anthropic/claude-opus-4-5": true, partner: true, "chatgpt/gpt-5": false, "openrouter/openai/gpt-6.1-sol:floor": false, "custom-mine/tiny": false });
  // The same list under the other identity, reached by its path with the key it allows.
  assert.deepEqual(await mark("/other/v1/models", { authorization: "Bearer im-key" }), {
    "anthropic/claude-opus-4-5": false, partner: false, "chatgpt/gpt-5": true, "openrouter/openai/gpt-6.1-sol:floor": true, "custom-mine/tiny": false });
});

test("codingClient knows coding agents by header or by shell plus edit tools", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  assert.equal(codingClient(h({ "user-agent": "claude-cli/2.1.0 (external, cli)" }), {}), "client:claude-cli");
  assert.equal(codingClient(h({ originator: "codex_cli_rs", "user-agent": "codex_cli_rs/0.50.0" }), {}), "client:codex");
  assert.equal(codingClient(h({ "x-title": "Cline", "http-referer": "https://cline.bot" }), {}), "client:cline");
  assert.equal(codingClient(h({ "x-title": "Roo Code" }), {}), "client:roo code");
  assert.equal(codingClient(h({ "user-agent": "opencode/0.15.0" }), {}), "client:opencode");
  // Messages, Chat Completions and Responses tool shapes, including Anthropic's versioned server tools.
  assert.equal(codingClient(h({}), { tools: [{ name: "Bash" }, { name: "Read" }, { name: "Edit" }] }), "tools:bash+edit");
  assert.equal(codingClient(h({}), { tools: [{ type: "bash_20250124", name: "bash" }, { type: "text_editor_20250728", name: "str_replace_based_edit_tool" }] }), "tools:bash+strreplacebasededittool");
  assert.equal(codingClient(h({}), { tools: [{ type: "function", function: { name: "execute_command" } }, { type: "function", function: { name: "replace_in_file" } }] }), "tools:executecommand+replaceinfile");
  assert.equal(codingClient(h({}), { tools: [{ type: "local_shell" }, { type: "custom", name: "apply_patch" }] }), "tools:localshell+applypatch");
  // A companion app: chat UAs, memory and web tools, or only one of the two kinds.
  assert.equal(codingClient(h({ "user-agent": "Mozilla/5.0 Chatbox/1.15" }), { tools: [{ name: "web_search" }, { name: "memory_recall" }, { name: "write_diary" }] }), null);
  assert.equal(codingClient(h({ "user-agent": "Anthropic/JS 0.60.0" }), { tools: [{ name: "bash" }, { name: "read" }] }), null);
  assert.equal(codingClient(h({}), {}), null);
});

test("coding speech keeps words, turns code blocks into [code] and drops code steps", () => {
  assert.equal(stripCodeBlocks("改成这样：\n```ts\nconst a = 1;\n```\n好了"), "改成这样：\n[code]\n好了");
  assert.equal(stripCodeBlocks("先看：\n~~~py\nprint(1)\n没关上"), "先看：\n[code]");
  assert.equal(stripCodeBlocks("行内 `code` 不动"), "行内 `code` 不动");
  assert.equal(stripCodeBlocks("```\nonly code\n```"), "");
  const said = (content: unknown[]) => {
    const out = new OutputCollector("messages", true);
    out.json({ content, stop_reason: "tool_use" });
    out.finish();
    return codingSpeech(out).text;
  };
  assert.equal(said([{ type: "text", text: "Let me read it." }, { type: "tool_use", name: "Read", input: { file_path: "a.ts" } }]), "");
  assert.equal(said([{ type: "text", text: "我去发" }, { type: "tool_use", name: "weixin_send", input: { text: "晚安" } },
    { type: "tool_use", name: "exec", input: { command: "ls" } }]), "weixin_send {\"text\":\"晚安\"}");
  assert.equal(said([{ type: "text", text: "改好了。\n```\nx\n```" }]), "改好了。\n[code]");
  // A speech tool's name is speech words and where they go, nothing else; MCP server names are not judged.
  for (const name of ["weixin_send", "send_message", "sendMessage", "reply", "tts_speak", "send_sticker", "mcp__weixin__send_message", "send_message_v2"]) assert.ok(isSpeechTool(name), name);
  for (const name of ["sendKeys", "commit_message", "Read", "mcp__github__create_pull_request", "log_message", "send_file", "send_patch", "AskUserQuestion"]) assert.ok(!isSpeechTool(name), name);
});

test("coding agents are recorded as conversation only, unless the assistant turns the filter off", async () => {
  const mock = globalThis.fetch;
  let reply: any = { content: [{ type: "text", text: "我先看看。" }, { type: "tool_use", id: "r", name: "Read", input: { file_path: "/src/a.ts" } }], stop_reason: "tool_use" };
  globalThis.fetch = async (url: any, init: any) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)), query: JSON.parse(init?.body as string) });
    return Response.json({ model: "claude-test", ...reply });
  };
  const claudeCode = { "user-agent": "claude-cli/2.1.0 (external, cli)" };
  const ask = { role: "user", content: "老公帮我把按钮改蓝\n```css\n.btn { color: red }\n```" };
  const step = { role: "assistant", content: reply.content };
  const result = { role: "user", content: [{ type: "tool_result", tool_use_id: "r", content: ".btn { color: red }" }] };
  try {
    // Her turn: recorded without the code, and the reply's file read is not.
    let out = await run("/v1/messages", { model: "partner", max_tokens: 64, messages: [ask] }, claudeCode);
    assert.equal(out.response.headers.get("x-aelios-coding"), "client:claude-cli");
    assert.equal((sqlite.prepare("SELECT content FROM messages WHERE role = 'user'").get() as any).content, "老公帮我把按钮改蓝\n[code]");
    assert.equal(queue.length, 1); assert.equal(queue[0].assistantText, "");
    // A step that only edits code: nothing dispatched at all.
    reply = { content: [{ type: "tool_use", id: "e", name: "Edit", input: { old_string: "red", new_string: "blue" } }], stop_reason: "tool_use" };
    out = await run("/v1/messages", { model: "partner", max_tokens: 64, messages: [ask, step, result] }, claudeCode);
    assert.equal(out.response.status, 200);
    assert.equal(queue.length, 1);
    // The closing reply is conversation and is kept, code and all turned into [code].
    reply = { content: [{ type: "text", text: "改好了，现在是蓝色。\n```css\n.btn { color: blue }\n```" }], stop_reason: "end_turn" };
    await run("/v1/messages", { model: "partner", max_tokens: 64, messages: [ask, step, result] }, claudeCode);
    assert.equal(queue.length, 2); assert.equal(queue[1].assistantText, "改好了，现在是蓝色。\n[code]");
    // Filter off: the old behaviour, everything recorded.
    setConfig(config([{ ...identity(), codingFilter: false } as ReturnType<typeof identity>]));
    reply = { content: [{ type: "tool_use", id: "e", name: "Edit", input: { old_string: "red", new_string: "blue" } }], stop_reason: "tool_use" };
    out = await run("/v1/messages", { model: "partner", max_tokens: 64, messages: [ask, step, result] }, claudeCode);
    assert.equal(out.response.headers.get("x-aelios-coding"), null);
    assert.equal(queue.length, 3); assert.match(queue[2].assistantText, /Edit/);
  } finally { globalThis.fetch = mock; }
  assert.throws(() => validateConfig({ ...config(), identities: [{ ...identity(), codingFilter: "yes" }] }), /codingFilter/);
});

test("coding filter: code tool arguments neither crowd out nor smuggle in what is kept", async () => {
  const mock = globalThis.fetch;
  let reply: any;
  globalThis.fetch = async (url: any, init: any) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)), query: JSON.parse(init?.body as string) });
    return typeof reply === "function" ? reply() : Response.json({ model: "claude-test", ...reply });
  };
  const claudeCode = { "user-agent": "claude-cli/2.1.0 (external, cli)" };
  const ask = { role: "user", content: "帮我改一下" };
  const loop = (n: number) => [ask, { role: "assistant", content: [{ type: "tool_use", id: `t${n}`, name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: "ok" }] }];
  const step = async (n: number) => { const before = queue.length;
    await run("/v1/messages", { model: "partner", max_tokens: 64, messages: loop(n) }, claudeCode);
    return queue.length > before ? queue.at(-1) : null; };
  try {
    // A huge edit next to a message: the message is kept whole, not lost to the 8,000-character cap.
    reply = { content: [{ type: "tool_use", id: "e", name: "Edit", input: { new_string: "x".repeat(9000) } },
      { type: "tool_use", id: "w", name: "weixin_send", input: { text: "晚安" } }], stop_reason: "tool_use" };
    let kept = await step(1);
    assert.ok(kept); assert.equal(kept.completion, "complete"); assert.match(kept.assistantText, /晚安/); assert.doesNotMatch(kept.assistantText, /xxxx/);
    // A huge kept call is still held to the cap.
    reply = { content: [{ type: "tool_use", id: "w", name: "weixin_send", input: { text: "长".repeat(9000) } },
      { type: "tool_use", id: "r", name: "Read", input: {} }], stop_reason: "tool_use" };
    kept = await step(2);
    assert.ok(kept); assert.ok(kept.assistantText.length <= 8000); assert.equal(kept.completion, "truncated");
    // Tool names nobody listed are not speech either.
    reply = { content: [{ type: "text", text: "我开个 PR。" }, { type: "tool_use", id: "g", name: "mcp__github__create_pull_request", input: { body: "diff --git a/x b/x" } }], stop_reason: "tool_use" };
    assert.equal(await step(3), null);
    // A failed step is still recorded as failed, for diagnosis, and its retry closes it.
    const status = () => (sqlite.prepare("SELECT completion_status AS s FROM gateway_exchanges WHERE profile = 'partner' ORDER BY created_at DESC LIMIT 1").get() as any)?.s;
    reply = () => Response.json({ type: "error", error: { type: "api_error", message: "boom" } }, { status: 500 });
    assert.equal(await step(4), null);
    assert.equal(status(), "failed");
    reply = { content: [{ type: "tool_use", id: "r", name: "Read", input: {} }], stop_reason: "tool_use" };
    assert.equal(await step(4), null);
    assert.equal(status(), "complete"); assert.equal(count("gateway_exchanges"), 1);
    // A long code block does not push the words after it out of the cap.
    reply = { content: [{ type: "text", text: `改好了：\n\`\`\`ts\n${"x".repeat(9000)}\n\`\`\`\nDone` }], stop_reason: "end_turn" };
    kept = await step(5);
    assert.ok(kept); assert.equal(kept.completion, "complete"); assert.equal(kept.assistantText, "改好了：\n[code]\nDone");
    // Speech tools are names made only of speech words, and code inside what they say becomes [code].
    reply = { content: [{ type: "tool_use", id: "p", name: "send_patch", input: { patch: "diff --git a/x b/x" } },
      { type: "tool_use", id: "r", name: "Read", input: {} }], stop_reason: "tool_use" };
    assert.equal(await step(6), null);
    reply = { content: [{ type: "tool_use", id: "m", name: "mcp__weixin__send_message", input: { text: "看这个\n```js\nconst a = 1\n```\n好吧" } },
      { type: "tool_use", id: "r", name: "Read", input: {} }], stop_reason: "tool_use" };
    kept = await step(7);
    assert.ok(kept); assert.match(kept.assistantText, /\[code\]/); assert.doesNotMatch(kept.assistantText, /const a/);
  } finally { globalThis.fetch = mock; }
});

test("coding filter: streamed code is dropped as it arrives, and streamed tool arguments are bounded", () => {
  const sse = (events: unknown[]) => new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
  const text = (t: string) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } });
  const out = new OutputCollector("messages", true);
  out.chunk(sse([{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, text("看：\n`"), text("``t"), text("s\n")]));
  for (let i = 0; i < 20; i++) out.chunk(sse([text("y".repeat(1000))]));
  out.chunk(sse([text("\n``"), text("`\n好了"), { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }]));
  out.finish();
  assert.deepEqual(codingSpeech(out), { text: "看：\n[code]\n好了", truncated: false });
  // A huge streamed edit is not held in memory, and does not mark a coding step cut off.
  const big = new OutputCollector("messages", true);
  big.chunk(sse([{ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Write" } }]));
  for (let i = 0; i < 100; i++) big.chunk(sse([{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "z".repeat(1000) } }]));
  assert.ok((big as any).pending.get(1).json.length <= 64000);
  big.chunk(sse([{ type: "content_block_stop", index: 1 }, { type: "message_stop" }]));
  big.finish();
  assert.deepEqual(codingSpeech(big), { text: "", truncated: false });
  // Outside coding mode the same call is kept up to the cap and marked cut off.
  const plain = new OutputCollector("messages");
  plain.chunk(sse([{ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Write" } }]));
  for (let i = 0; i < 100; i++) plain.chunk(sse([{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "z".repeat(1000) } }]));
  plain.chunk(sse([{ type: "content_block_stop", index: 1 }, { type: "message_stop" }]));
  plain.finish();
  assert.ok(plain.truncated); assert.ok(plain.text.length <= 8000);
});

test("coding filter: a longer closing fence ends the block, and earlier code stays out of recall", async () => {
  assert.equal(stripCodeBlocks("看：\n```\ncode\n````\n后面的话"), "看：\n[code]\n后面的话");
  assert.equal(stripCodeBlocks("看：\n````\n```\n还在块里\n````\n后面"), "看：\n[code]\n后面");
  precious("partner-a", "量子猫咪是暗号");
  await run("/v1/chat/completions", { model: "partner", messages: [
    { role: "user", content: "看这个\n```\n量子猫咪\n```" }, { role: "assistant", content: "嗯" }, { role: "user", content: "好了吗" }] },
  { "user-agent": "claude-cli/2.1.0 (external, cli)" });
  assert.doesNotMatch(JSON.stringify(calls.at(-1).query.messages.at(-1)), /量子猫咪是暗号/);
});
