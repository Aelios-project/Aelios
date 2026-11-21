import assert from "node:assert/strict";
import { test } from "node:test";
import { callDreamModelJson } from "../src/memory/dream/modelCall";
import { DEFAULT_DREAM_MODEL, readDreamModel, readDreamThinkingTokens, withThinkingBudget } from "../src/memory/dreamEnv";
import type { Env } from "../src/types";

test("GLM-4.7-flash is the default background model", () => {
  assert.equal(DEFAULT_DREAM_MODEL, "workers-ai/@cf/zai-org/glm-4.7-flash");
  assert.equal(readDreamModel({} as Env), DEFAULT_DREAM_MODEL);
  assert.equal(readDreamModel({ DREAM_MODEL: "chatgpt/gpt-5" } as Env), "chatgpt/gpt-5");
});

test("the thinking budget sits on top of each answer budget and can be turned down", () => {
  assert.equal(readDreamThinkingTokens({}), 4096);
  assert.deepEqual(withThinkingBudget({}, { max_tokens: 900 }), { max_tokens: 4996 });
  assert.deepEqual(withThinkingBudget({ DREAM_THINKING_TOKENS: "0" }, { max_tokens: 900 }), { max_tokens: 900 });
  assert.equal(readDreamThinkingTokens({ DREAM_THINKING_TOKENS: "999999" }), 16_000);
  const unbounded: { max_tokens?: number; messages: never[] } = { messages: [] };
  assert.equal(withThinkingBudget({}, unbounded), unbounded);
});

test("a Dream call to Workers AI asks for the answer budget plus the thinking budget", async () => {
  const seen: Array<{ model: string; max_tokens: unknown }> = [];
  const env = {
    AI: {
      async run(model: string, input: { max_tokens?: number }) {
        seen.push({ model, max_tokens: input.max_tokens });
        return { choices: [{ message: { content: "{}", reasoning_content: "thinking" }, finish_reason: "stop" }] };
      }
    }
  } as unknown as Env;
  const result = await callDreamModelJson(env, {
    model: DEFAULT_DREAM_MODEL,
    messages: [{ role: "user", content: "Summarize." }],
    max_tokens: 3000
  });
  assert.equal(result.ok, true);
  assert.equal(result.parsed?.choices?.[0]?.message?.content, "{}");
  assert.deepEqual(seen, [{ model: "@cf/zai-org/glm-4.7-flash", max_tokens: 7096 }]);
});
