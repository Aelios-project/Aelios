import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { invalidateSettingsCache } from "../src/gateway/config";
import { runDailyMemoryDigest } from "../src/memory/dream/orchestrator";
import { buildDigestPrompt, callDigestModel, runExtractPhase } from "../src/memory/dream/extractPhase";
import { callDreamModelJson, DreamModelTimeoutError } from "../src/memory/dream/modelCall";
import { extractDreamMemoriesFromMessages } from "../src/memory/dreamExtract";
import { extractMemoriesFromMessages } from "../src/memory/extract";
import { draftTriggersForMemory } from "../src/memory/triggers/build";
import { callOpenAICompat } from "../src/proxy/openaiAdapter";
import { callModelWithRetry } from "../src/utils/modelCall";
import type { MessageRecord } from "../src/types";

const DATE = "2026-09-18";
const MODEL = "workers-ai/@cf/openai/gpt-oss-120b";
const DIGEST = { title: "一日整理", summary: "整理这一批合成对话。", sections: [], memories_to_add: [], memories_to_update: [], memories_to_delete: [] };
const REQUEST = { model: MODEL, messages: [{ role: "user" as const, content: "synthetic" }] };

function fixture(t: TestContext, respond: (input: any, options?: any) => unknown | Promise<unknown>) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  for (const file of readdirSync("migrations").filter(f => f.endsWith(".sql")).sort()) {
    try { sqlite.exec(readFileSync(`migrations/${file}`, "utf8")); }
    catch (error) { if (!String(error).includes("fts5")) throw error; }
  }
  const db: any = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: any[] = [];
      const query = {
        bind(...args: any[]) { values = args; return query; },
        async first() { return statement.get(...values) ?? null; },
        async all() { return { results: statement.all(...values) }; },
        async run() { return { meta: { changes: statement.run(...values).changes } }; }
      };
      return query;
    },
    async batch(queries: any[]) { return Promise.all(queries.map(query => query.run())); }
  };
  const env: any = { DB: db, DREAM_MODEL: MODEL, DREAM_TIME_ZONE: "UTC", DREAM_MAX_MESSAGES: "40",
    DREAM_STRATEGY: "review", AI: { run(_model: string, input: any, options?: any) { return respond(input, options); } } };
  invalidateSettingsCache();
  return { sqlite, db, env };
}

function messages(count: number): MessageRecord[] {
  return Array.from({ length: count }, (_, i) => ({ id: `msg_${i}`, conversation_id: "synthetic", namespace: "default",
    role: "user", content: `合成对话第 ${i} 条。`, source: "test", created_at: `${DATE}T10:00:${String(i).padStart(2, "0")}.000Z` }));
}
function stageInput(count: number) {
  return { namespace: "default", dateLabel: DATE, startIso: `${DATE}T00:00:00.000Z`, endIso: "2026-09-19T00:00:00.000Z",
    messages: messages(count), existingMemories: [], hasMore: false };
}
function isDigest(input: any) { return String(input.messages?.[0]?.content).includes("不要输出思考过程"); }
function seedMessages(sqlite: DatabaseSync, rows: MessageRecord[]) {
  for (const row of rows) sqlite.prepare("INSERT INTO messages (id, conversation_id, namespace, role, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.conversation_id, row.namespace, row.role, row.content, row.source, row.created_at);
}
function extraction() { return { memories: [{ content: "合成用户偏好简短说明。", type: "preference", source_message_ids: ["msg_0"], importance: 0.7, confidence: 0.8 }] }; }

// These tests use the real adapter/pipeline and local SQLite, never a remote model or a production database.
test("Workers AI adapter preserves structured JSON, native truncation and reasoning metadata", async (t) => {
  const a = fixture(t, () => ({ response: { memories: [] } }));
  const structured: any = await (await callOpenAICompat(a.env, REQUEST)).json();
  assert.equal(structured.choices[0].message.content, '{"memories":[]}');
  a.env.AI.run = async () => ({ choices: [{ message: { content: '{"memories":[', reasoning_content: "synthetic reasoning" }, finish_reason: "length" }], usage: { completion_tokens: 4000 } });
  const clipped: any = await (await callOpenAICompat(a.env, REQUEST)).json();
  assert.equal(clipped.choices[0].finish_reason, "length");
  assert.equal(clipped.choices[0].message.reasoning_content, "synthetic reasoning");
  assert.equal(clipped.usage.completion_tokens, 4000);
});

test("deadline aborts a stalled Workers AI call rather than waiting forever", async (t) => {
  let signal: AbortSignal | undefined;
  const { env } = fixture(t, (_input, options) => { signal = options.signal; return new Promise(() => {}); });
  await assert.rejects(callDreamModelJson(env, REQUEST, 10), DreamModelTimeoutError);
  assert.equal(signal?.aborted, true);
});

test("deadline includes the HTTP response body, not just response headers", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const { env } = fixture(t, () => assert.fail("not using the binding"));
  delete env.AI;
  env.AI_GATEWAY_BASE_URL = "https://gateway.invalid";
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Response(new ReadableStream({ start(controller) {
      signal?.addEventListener("abort", () => controller.error(signal?.reason), { once: true });
    } }));
  };
  await assert.rejects(callDreamModelJson(env, { ...REQUEST, model: "synthetic/test" }, 10), DreamModelTimeoutError);
  assert.equal(signal?.aborted, true);
});

test("explicit empty memories is valid; an absent or entirely unusable list is not; stray bad entries are dropped", async (t) => {
  const { env } = fixture(t, () => ({ response: '{"memories":[]}' }));
  const input = { namespace: "default", messages: messages(1), speakers: null };
  assert.equal((await extractDreamMemoriesFromMessages(env, input)).reason, undefined);
  const tooLong = { content: "长".repeat(1001) };
  for (const payload of [{}, { memories: null }, { memories: [{ content: 123 }] }, { memories: [tooLong, { content: "" }] }]) {
    env.AI.run = async () => ({ response: JSON.stringify(payload) });
    assert.equal((await extractDreamMemoriesFromMessages(env, input)).reason, "model_invalid_json");
  }
  // One over-long or malformed entry used to fail the whole batch and keep the cursor stuck; it is now dropped.
  env.AI.run = async () => ({ response: JSON.stringify({ memories: [...extraction().memories, { content: 123 }, tooLong] }) });
  const mixed = await extractDreamMemoriesFromMessages(env, input);
  assert.equal(mixed.reason, undefined);
  assert.deepEqual(mixed.memories.map(memory => memory.content), extraction().memories.map(memory => memory.content));
});

test("the extraction call gets the same output budget as the digest, not a lower cap", async (t) => {
  const seen: unknown[] = [];
  const { env } = fixture(t, input => { seen.push(input.max_tokens); return { response: '{"memories":[]}' }; });
  const input = { namespace: "default", messages: messages(1), speakers: null };
  env.DREAM_MAX_TOKENS = "8000";
  await extractDreamMemoriesFromMessages(env, input);
  delete env.DREAM_MAX_TOKENS;
  await extractDreamMemoriesFromMessages(env, input);
  env.DREAM_MAX_TOKENS = "99999";
  await extractDreamMemoriesFromMessages(env, input);
  assert.deepEqual(seen, [8000, 3000, 8000]);
});

test("extract failure halves BOTH stages, retaining the unprocessed suffix", async (t) => {
  const calls: any[] = [];
  let extracts = 0;
  const { env } = fixture(t, input => {
    calls.push(input);
    return { response: isDigest(input) ? JSON.stringify(DIGEST) : ++extracts === 1 ? '{"memories":[' : JSON.stringify(extraction()) };
  });
  const input = stageInput(4);
  const result = await runExtractPhase(env, input);
  assert.equal(result.modelResult.digest?.title, DIGEST.title);
  assert.equal(result.extractReason, undefined);
  assert.equal(result.messages.length, 2);
  assert.equal(input.messages.length, 4);
  assert.equal(result.hasMore, true);
  assert.equal(calls.length, 4);
  for (const call of calls.slice(2)) {
    assert.match(call.messages[1].content, /msg_1/);
    assert.doesNotMatch(call.messages[1].content, /msg_2/);
  }
});

test("invalid digest schema is retried even when a provider reports stop rather than length", async (t) => {
  let calls = 0;
  const { env } = fixture(t, input => ({ response: ++calls === 1 ? "{}" : JSON.stringify(isDigest(input) ? DIGEST : { memories: [] }) }));
  const result = await runExtractPhase(env, stageInput(4));
  assert.equal(result.messages.length, 2);
  assert.equal(result.extractReason, undefined);
  assert.equal(result.hasMore, true);
  assert.equal(calls, 3);
});

test("repeated invalid extraction has a bounded reduction budget and remains a failure", async (t) => {
  let calls = 0;
  const { env } = fixture(t, input => { calls++; return { response: isDigest(input) ? JSON.stringify(DIGEST) : "{}" }; });
  const result = await runExtractPhase(env, stageInput(40));
  assert.equal(result.extractReason, "model_invalid_json");
  assert.equal(result.messages.length, 5);
  assert.equal(result.hasMore, true);
  assert.equal(calls, 8, "four sizes, two stages each, no endless repair loop");
});

test("a model deadline is reported distinctly and is not automatically retried", async (t) => {
  let calls = 0;
  const { env } = fixture(t, () => { calls++; return new Promise(() => {}); });
  const result = await callDigestModel(env, "synthetic", { dateLabel: DATE, messageCount: 1, memoryCount: 0, hasMore: false, deadlineAt: Date.now() + 10 });
  assert.equal(result.reason, "model_timeout");
  assert.equal(calls, 1);
});

test("a queued run that is disabled before execution still reaches a terminal state", async (t) => {
  const { env, sqlite } = fixture(t, () => assert.fail("model must not run"));
  sqlite.prepare("INSERT INTO dream_runs(id,namespace,date_label,started_at,status,trigger) VALUES('drm_test','default',?,?,'running','manual')").run(DATE, new Date().toISOString());
  env.ENABLE_DREAM = "false";
  const result = await runDailyMemoryDigest(env, "default", { runId: "drm_test" });
  assert.equal(result.ran, false);
  const row = sqlite.prepare("SELECT * FROM dream_runs WHERE id='drm_test'").get()!;
  assert.equal(row.status, "skipped");
  assert.equal(row.reason, "dream_disabled");
  assert.ok(row.finished_at);
});

test("a cursor lookup exception closes the original run rather than leaving running", async (t) => {
  const { env, db, sqlite } = fixture(t, () => assert.fail("model must not run"));
  sqlite.prepare("INSERT INTO dream_runs(id,namespace,date_label,started_at,status,trigger) VALUES('drm_test','default',?,?,'running','manual')").run(DATE, new Date().toISOString());
  const original = db.prepare;
  db.prepare = (sql: string) => {
    if (sql.startsWith("SELECT value FROM processing_cursors")) throw new Error("synthetic cursor outage");
    return original(sql);
  };
  await assert.rejects(runDailyMemoryDigest(env, "default", { runId: "drm_test", dateLabel: DATE }), /synthetic cursor outage/);
  const row = sqlite.prepare("SELECT * FROM dream_runs WHERE id='drm_test'").get()!;
  assert.equal(row.status, "error");
  assert.equal(row.reason, "run_failed");
  assert.ok(row.finished_at);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM dream_runs").get()!.n, 1);
});

test("full dry run uses the reduced batch without advancing a cursor or changing raw messages", async (t) => {
  let extracts = 0;
  const { env, sqlite } = fixture(t, input => ({ response: isDigest(input) ? JSON.stringify(DIGEST) : ++extracts === 1 ? "{}" : JSON.stringify(extraction()) }));
  seedMessages(sqlite, messages(4));
  const result = await runDailyMemoryDigest(env, "default", { dateLabel: DATE, dryRun: true });
  assert.equal(result.ran, true);
  if (!result.ran) return;
  assert.equal(result.stats.processedMessages, 2);
  assert.equal(result.stats.hasMore, true);
  assert.equal(result.stats.cursorAdvanced, false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM processing_cursors").get()!.n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM memory_candidates").get()!.n, 0);
});

test("full invalid extraction never advances its cursor, writes candidates or loses raw chat", async (t) => {
  const { env, sqlite } = fixture(t, input => ({ response: isDigest(input) ? JSON.stringify(DIGEST) : "{}" }));
  seedMessages(sqlite, messages(4));
  const result = await runDailyMemoryDigest(env, "default", { dateLabel: DATE });
  assert.equal(result.ran, false);
  if (result.ran) return;
  assert.equal(result.reason, "extract_invalid_json");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM processing_cursors").get()!.n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM memory_candidates").get()!.n, 0);
  assert.equal(sqlite.prepare("SELECT status FROM dream_runs").get()!.status, "error");
});

test("unusable digest entries are dropped without stalling the batch, but a wrong container type is still rejected", async (t) => {
  const target_id = "mem_0123456789abcdef0123456789abcdef";
  const messy = {
    ...DIGEST,
    sections: [{}],
    memories_to_add: [{ content: 123 }],
    memories_to_update: [{}, { target_id }, { target_id, content: 123 }, { target_id, content: "更新后的合成正文" }],
    memories_to_delete: [{}]
  };
  const accepted = fixture(t, input => ({ response: JSON.stringify(isDigest(input) ? messy : { memories: [] }) }));
  const result = await runExtractPhase(accepted.env, stageInput(4));
  assert.equal(result.messages.length, 4, "bad entries must not shrink the batch");
  assert.equal(result.hasMore, false);
  assert.equal(result.extractReason, undefined);
  const digest = result.modelResult.digest!;
  assert.deepEqual([digest.sections, digest.memories_to_add, digest.memories_to_delete], [[], [], []]);
  assert.equal(digest.memories_to_update?.length, 1);
  assert.equal(digest.memories_to_update?.[0].content, "更新后的合成正文");

  // Omitted optional lists are simply empty.
  const sparse = fixture(t, input => ({ response: JSON.stringify(isDigest(input) ? { title: DIGEST.title, summary: DIGEST.summary } : { memories: [] }) }));
  const sparseResult = await runExtractPhase(sparse.env, stageInput(4));
  assert.equal(sparseResult.modelResult.digest?.title, DIGEST.title);
  assert.equal(sparseResult.messages.length, 4);

  for (const plan of [{ ...DIGEST, memories_to_update: "oops" }, { ...DIGEST, sections: {} }]) {
    let digestCalls = 0;
    const rejected = fixture(t, input => {
      assert.equal(isDigest(input), true, "reject the digest before attempting extraction");
      digestCalls++;
      return { response: JSON.stringify(plan) };
    });
    const failed = await runExtractPhase(rejected.env, stageInput(4));
    assert.equal(failed.modelResult.digest, null);
    assert.equal(failed.modelResult.reason, "model_invalid_json");
    assert.ok(digestCalls > 1 && digestCalls <= 4);
  }
});

test("the digest prompt's output example is a format placeholder, not a sentence the model can copy into the diary", () => {
  const prompt = buildDigestPrompt({ ...stageInput(2), existingMemories: [], speakers: null });
  assert.doesNotMatch(prompt, /这次 dream 合并了重复记忆/);
  assert.doesNotMatch(prompt, /"title":"夜间整理"/);
  assert.match(prompt, /"title":"<12 字以内标题>"/);
  assert.match(prompt, /不是示例内容，不要照抄/);
});

test("background calls through AI Gateway send no temperature: newer Claude models refuse the request when one is set", async (t) => {
  const sent: any[] = [];
  const { env } = fixture(t, () => assert.fail("a gateway model must not run on the Workers AI binding"));
  env.DREAM_MODEL = "anthropic/claude-haiku-5-5";
  env.AI_GATEWAY_ID = "synthetic-gateway";
  env.AI.gateway = () => ({
    async run({ query }: { query: any }) {
      sent.push(query);
      const content = isDigest(query) ? JSON.stringify(DIGEST) : '{"memories":[]}';
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
    }
  });
  invalidateSettingsCache();
  const digest = await callDigestModel(env, "synthetic", { dateLabel: DATE, messageCount: 1, memoryCount: 0, hasMore: false });
  assert.equal(digest.digest?.title, DIGEST.title);
  await extractDreamMemoriesFromMessages(env, { namespace: "default", messages: messages(1), speakers: null });
  await callModelWithRetry(env, { model: env.DREAM_MODEL, prompt: "give JSON", backoffMs: [] });
  await extractMemoriesFromMessages(env, messages(1));
  await draftTriggersForMemory(env, { content: "合成记忆。" });
  assert.equal(sent.length, 5);
  for (const body of sent) {
    assert.equal(body.model, "anthropic/claude-haiku-5-5");
    assert.ok(!("temperature" in body), JSON.stringify(body).slice(0, 200));
  }
});

test("Dream grounds speaker and modality in the supplied batch; tool arguments and another space cannot attest speech", async (t) => {
  const rows = messages(4);
  Object.assign(rows[0], { content: "Should I abandon DSH?" });
  Object.assign(rows[1], { content: "I decided to integrate ACP." });
  Object.assign(rows[2], {
    role: "assistant",
    source: "gateway:gpt",
    capture_kind: "visible",
    content: "I prefer the small adapter."
  });
  Object.assign(rows[3], {
    role: "assistant",
    source: "gateway:gpt",
    capture_kind: "includes_tool",
    content: 'send {"text":"I promised to switch."}'
  });
  const proposal = (i: number, content: string, role: string, quote: string) => ({
    type: "decision",
    content,
    attributed_role: role,
    evidence_quote: quote,
    source_message_ids: [rows[i].id]
  });
  const approved = proposal(1, "The user chose ACP.", "user", rows[1].content);
  const spoken = proposal(2, "The assistant prefers the small adapter.", "assistant", rows[2].content);
  const reply = {
    memories: [
      approved,
      spoken,
      proposal(0, "The user abandoned DSH.", "user", rows[0].content),
      proposal(2, "The user prefers the adapter.", "user", rows[2].content),
      proposal(2, "It promised forever.", "assistant", "forever"),
      proposal(3, "It promised to switch.", "assistant", "I promised to switch."),
      { ...spoken, source_message_ids: ["not-in-this-batch"] }
    ]
  };
  const { env } = fixture(t, () => ({ response: JSON.stringify(reply) }));
  const run = (batch: MessageRecord[]) =>
    extractDreamMemoriesFromMessages(env, { namespace: "default", messages: batch, speakers: null });
  const result = await run(rows);
  assert.deepEqual(
    result.memories.map((m) => [m.content, m.attributed_role, m.source_message_ids]),
    [
      [approved.content, "user", ["msg_1"]],
      [spoken.content, "assistant", ["msg_2"]]
    ]
  );
  assert.deepEqual((await run([])).memories, []);
});

test("nightly digest lands a cited scoped decision with only the supplied state_of targets", async (t) => {
  const rows = messages(1);
  rows[0].content = "我决定就用 ACP。";
  const proposed = {
    type: "decision", content: "用户决定 Aelios 接入采用 ACP。", attributed_role: "user",
    evidence_quote: rows[0].content, source_message_ids: [rows[0].id],
    decision: { scope_key: "user/aelios/integration", value: "ACP", state_of: ["old", "not-shown"] },
  };
  const { env, sqlite } = fixture(t, input => ({ response: JSON.stringify(isDigest(input)
    ? { ...DIGEST, decisions: [proposed] } : { memories: [] }) }));
  env.CURRENT_STATE_PROJECTION = "on";
  seedMessages(sqlite, rows);
  sqlite.prepare("INSERT INTO memories(id,namespace,type,content,status,created_at,updated_at) VALUES('old','default','note','old','active','2026-09-17','2026-09-17')").run();
  const result = await runDailyMemoryDigest(env, "default", { dateLabel: DATE });
  assert.equal(result.ran, true);
  const saved = sqlite.prepare("SELECT * FROM memories WHERE source='scoped_decision'").get();
  assert.ok(saved);
  assert.equal(saved.fact_key, "decision:user/aelios/integration");
  assert.deepEqual(JSON.parse(String(saved.provenance)).state_of, ["old"]);
  assert.deepEqual(JSON.parse(String(saved.source_message_ids)), [rows[0].id]);
  const lifecycle = sqlite.prepare("SELECT valid_as_of FROM memory_lifecycle WHERE memory_id=?").get(saved.id);
  assert.ok(lifecycle);
  assert.equal(lifecycle.valid_as_of, rows[0].created_at);
});
