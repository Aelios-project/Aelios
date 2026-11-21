import assert from "node:assert/strict";
import { test } from "node:test";
import { callDreamModelJson } from "../src/memory/dream/modelCall";
import { DEFAULT_DREAM_MODEL, dreamOutputLimit, readDreamModel } from "../src/memory/dreamEnv";
import { runDiaryWriter } from "../src/memory/diaryWriter";
import { runMonthlyRollup } from "../src/memory/monthlyRollup";
import { runWeeklyRollup } from "../src/memory/weeklyRollup";
import type { Env } from "../src/types";
import { sqliteFixture } from "./support/sqlite";

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

const gatewayModel = "openrouter/google/gemini-3.8-flash";
for (const { name, model, settings, expected } of [
  { name: "Workers AI default", model: DEFAULT_DREAM_MODEL, settings: {}, expected: 8000 },
  { name: "gateway default", model: gatewayModel, settings: {}, expected: undefined },
  { name: "explicit limit", model: gatewayModel, settings: { DREAM_MAX_TOKENS: "12000" }, expected: 12000 },
  { name: "legacy limit", model: DEFAULT_DREAM_MODEL, settings: { DAILY_DIGEST_MAX_TOKENS: "10000" }, expected: 10000 }
]) {
  test(`diary, weekly and monthly jobs apply the ${name} to outgoing requests`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-07T20:10:00Z") });
    const { sqlite, db } = sqliteFixture(t);
    // The diary supplies one week. An earlier week makes the month eligible for rollup.
    sqlite.exec(`
      INSERT INTO messages (id, conversation_id, namespace, role, content, source, created_at)
      VALUES ('msg_1', 'chat', 'default', 'user', 'I started baking.', 'test', '2026-08-12T12:00:00Z');
      INSERT INTO weekly_log (namespace, week, start_date, end_date, title, summary, source_days, updated_at)
      VALUES ('default', '2026-W32', '2026-08-03', '2026-08-09', 'Last week', 'Baking plans', 1, '2026-08-10');
    `);
    const requests: Record<string, unknown>[] = [];
    const reply = { title: "Baking", summary: "I started baking.", source_message_ids: ["msg_1"] };
    const env: Env = { DB: db, DREAM_MODEL: model, DREAM_TIME_ZONE: "UTC", ...settings };
    if (model === DEFAULT_DREAM_MODEL) {
      env.AI = {
        async run(_model: string, input: Record<string, unknown>) {
          requests.push(input);
          return { response: reply };
        }
      } as unknown as Ai;
    } else {
      env.AI_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1/account/aelios";
      t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        return Response.json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
      });
    }

    assert.equal((await runDiaryWriter(env, "default", "2026-08-12")).ran, true);
    assert.equal((await runWeeklyRollup(env, "default")).weeks_processed, 1);
    assert.equal((await runMonthlyRollup(env, "default")).months_processed, 1);
    assert.equal(requests.length, 3);
    for (const body of requests) {
      assert.equal("max_tokens" in body, expected !== undefined);
      assert.equal(body.max_tokens, expected);
    }
  });
}
