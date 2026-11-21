import assert from "node:assert/strict";
import { test } from "node:test";
import { callDreamModelJson } from "../src/memory/dream/modelCall";
import { DEFAULT_DREAM_MODEL, dreamOutputLimit, readDreamModel } from "../src/memory/dreamEnv";
import { callModelWithRetry } from "../src/utils/modelCall";
import type { Env } from "../src/types";

test("GLM-4.7-flash is the default background model; Settings still win", () => {
  assert.equal(DEFAULT_DREAM_MODEL, "workers-ai/@cf/zai-org/glm-4.7-flash");
  assert.equal(readDreamModel({} as Env), DEFAULT_DREAM_MODEL);
  assert.equal(readDreamModel({ DREAM_MODEL: "google-ai-studio/gemini-3.8-flash" } as Env), "google-ai-studio/gemini-3.8-flash");
});

test("background calls send no length limit unless the route needs one or Settings set one", () => {
  const env = {} as Env;
  assert.deepEqual(dreamOutputLimit(env, "google-ai-studio/gemini-3.8-flash"), {});
  assert.deepEqual(dreamOutputLimit(env, "chatgpt/gpt-5"), {});
  assert.deepEqual(dreamOutputLimit(env, "workers-ai/@cf/zai-org/glm-4.7-flash"), { max_tokens: 8000 });
  assert.deepEqual(dreamOutputLimit(env, "@cf/openai/gpt-oss-120b"), { max_tokens: 8000 });
  assert.deepEqual(dreamOutputLimit({ DREAM_MAX_TOKENS: "20000" } as Env, "google-ai-studio/gemini-3.8-flash"), { max_tokens: 20000 });
});

test("a Dream call to Workers AI sends only messages, the format and the roomy limit", async () => {
  const seen: unknown[] = [];
  const env = {
    AI: {
      async run(model: string, input: Record<string, unknown>) {
        seen.push({ model, keys: Object.keys(input).sort(), max_tokens: input.max_tokens });
        return { choices: [{ message: { content: "{}", reasoning_content: "thinking" }, finish_reason: "stop" }] };
      }
    }
  } as unknown as Env;
  const result = await callDreamModelJson(env, {
    model: DEFAULT_DREAM_MODEL,
    messages: [{ role: "user", content: "Summarize." }],
    ...dreamOutputLimit(env, DEFAULT_DREAM_MODEL),
    response_format: { type: "json_object" }
  });
  assert.equal(result.parsed?.choices?.[0]?.message?.content, "{}");
  assert.deepEqual(seen, [{ model: "@cf/zai-org/glm-4.7-flash", keys: ["max_tokens", "messages", "response_format"], max_tokens: 8000 }]);
});

test("the journal and summaries on another route send no max_tokens at all", async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }), { status: 200 });
  }) as typeof fetch;
  const env = { AI_GATEWAY_BASE_URL: "https://gateway.ai.cloudflare.com/v1/account/aelios" } as unknown as Env;
  await callModelWithRetry(env, { model: "openrouter/google/gemini-3.8-flash", prompt: "Write.", backoffMs: [] });
  assert.equal(bodies.length, 1);
  assert.equal("max_tokens" in bodies[0], false);
});
