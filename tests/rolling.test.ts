import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ADMIN_HTML } from "../src/api/admin/ui";
import { handleDreamHarvest, handleDreamStatus } from "../src/api/dream";
import { cleanRawMessage, invalidateKnownInputs } from "../src/db/v2/revocation";
import { validateSettings } from "../src/gateway/settings";
import { runDailyMemoryDigest } from "../src/memory/dream/orchestrator";
import { insertMessageFts } from "../src/memory/fts";
import { searchQuotes } from "../src/memory/quotes";
import { groundWindowProposal } from "../src/memory/rolling/apply";
import { claimRollingWindow } from "../src/memory/rolling/inbox";
import { claimNightlyExtraction, releaseNightlyExtraction } from "../src/memory/rolling/nightly";
import { rollingExplicitWrites, rollingRecallHits, type RollingPacket } from "../src/memory/rolling/payload";
import { runRollingWindow } from "../src/memory/rolling/runner";
import { loadRollingState } from "../src/memory/rolling/state";
import { getRollingDreamStatus } from "../src/memory/rolling/stats";
import { clefTriage, ROLLING_CLEF_MODEL } from "../src/memory/rolling/triage/clef";
import { codePointLength, pickWindow } from "../src/memory/rolling/window";
import { handleQueueMessage } from "../src/queue/consumer";
import type { Env, MessageRecord, QueueMessage } from "../src/types";
import { episodeProposal, insertLine, NOVEL, ORDINARY, seedAffectionateDialogue, SYNTHETIC_AT, SYNTHETIC_DAY } from "./support/rolling-fixture";
import { sqliteFixture } from "./support/sqlite";

(crypto.subtle as typeof crypto.subtle & { timingSafeEqual: typeof timingSafeEqual }).timingSafeEqual = timingSafeEqual;

const novel = { async classify() { return NOVEL; } };
const ordinary = { async classify() { return ORDINARY; } };
const shadowEnv = (db: D1Database): Env => ({ DB: db, ROLLING_DREAM: "shadow", ROLLING_WINDOW_MESSAGES: "2" });
const digestReply = { title: "Synthetic day", summary: "One synthetic conversation.", memories_to_add: [] };

function quoteFirst(packet: RollingPacket) {
  const first = packet.messages[0];
  return {
    events: [{
      op: "new" as const, episode_key: "check-in", type: "event", content: first.content,
      attributed_role: first.role === "assistant" ? "assistant" as const : "user" as const,
      evidence_ids: [first.id], evidence_quote: first.content
    }],
    state_delta: { episodes: [{ key: "check-in", label: "Check-in", last_seq: 0, evidence_ids: [first.id] }] }
  };
}

test("0028 captures new turns, leaves old rows alone, and never reuses a deleted sequence", (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("CREATE TABLE messages(id TEXT, namespace TEXT, role TEXT); CREATE TABLE memory_events(namespace TEXT,event_type TEXT,created_at TEXT)");
  sqlite.exec("INSERT INTO messages VALUES('before','default','user')");
  sqlite.exec(readFileSync("migrations/0028_rolling_inbox.sql", "utf8"));
  sqlite.exec("INSERT INTO messages VALUES('first','default','assistant'),('tool','default','tool')");
  assert.equal(sqlite.prepare("SELECT message_id FROM rolling_inbox").get()?.message_id, "first");
  sqlite.exec("DELETE FROM messages WHERE id='first'; INSERT INTO messages VALUES('second','default','user')");
  assert.equal(sqlite.prepare("SELECT seq FROM rolling_inbox WHERE message_id='second'").get()?.seq, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get()?.n, 3);
});

test("window thresholds respect message and code point budgets, including an oversized head", () => {
  const sizes = [2, 2, 2, 12].map(chars => ({ chars }));
  assert.deepEqual(pickWindow(sizes, { messages: 2, chars: 8 }), sizes.slice(0, 2));
  assert.deepEqual(pickWindow(sizes.slice(2), { messages: 10, chars: 8 }), sizes.slice(2, 3));
  assert.deepEqual(pickWindow(sizes.slice(3), { messages: 10, chars: 8 }), sizes.slice(3));
  assert.deepEqual(pickWindow(sizes.slice(0, 2), { messages: 10, chars: 8 }), []);
  assert.equal(codePointLength("a🧪中"), 3);
});

test("R12/P2-a shadow reads actual gateway and ingest turns with no memory tools or candidate writes", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const sent: QueueMessage[] = [];
  const env = {
    ...shadowEnv(db),
    GATEWAY_CONFIG: JSON.stringify({ version: 3, identities: [
      { slug: "lab", namespace: "default", keys: ["CHATBOX_API_KEY"], models: ["synth-*"] }
    ] }),
    MEMORY_QUEUE: { async send(message: QueueMessage) { sent.push(message); } } as unknown as Env["MEMORY_QUEUE"]
  };
  insertLine(sqlite, "extra", "skip an auxiliary model", { source: "gateway:lab", model: "auxiliary" });
  insertLine(sqlite, "tool-text", "skip tool capture", { source: "gateway:lab", model: "synth-v1", role: "assistant", capture: "includes_tool" });
  insertLine(sqlite, "import", "skip an import", { source: "import_chat" });
  insertLine(sqlite, "daily", "skip GitHub daily", { source: "github_daily:synthetic" });
  await handleQueueMessage({
    type: "gateway_exchange", id: "gw_test", userId: "user_test", namespace: "default", profile: "lab",
    conversationId: "turn", protocol: "chat", kind: "human", userText: "Let's name our experiment Prism.",
    assistantText: "Prism it is.", completion: "complete", model: "resolved-upstream", requestedModel: "synth-v1",
    provider: "synthetic", captureKind: "visible", httpStatus: 200, createdAt: SYNTHETIC_AT, stream: false
  }, env);
  assert.deepEqual(sent, [{ type: "rolling_window", namespace: "default" }]);
  const seen: string[] = [];
  const result = await runRollingWindow(env, "default", { triage: novel, extractor: { async extract(packet) {
    seen.push(...packet.messages.map(message => message.id));
    return quoteFirst(packet);
  } } });
  assert.equal(result.extracted, true);
  assert.deepEqual(seen, ["user_test", "gw_test:assistant"]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM memory_candidates").get()?.n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get()?.n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM rolling_inbox WHERE done_at IS NOT NULL").get()?.n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM rolling_inbox WHERE shadow_done_at IS NOT NULL").get()?.n, 2);
});

test("R10/R11/R15/R19/R20 payload isolates recalled context and checks actual citations, not claimed evidence", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = shadowEnv(db);
  insertLine(sqlite, "a", "We opened the prism.", { at: "2026-11-17T10:05:00.000Z" });
  insertLine(sqlite, "b", "Good to see you.", { at: SYNTHETIC_AT });
  const add = sqlite.prepare("INSERT INTO memories(id,namespace,type,content,provenance,created_at,updated_at,source_message_ids) VALUES(?,?,'note',?,?,?,?,?)");
  add.run("remembered", "default", "We opened the prism.", '{"creation_mode":"agent_explicit"}', SYNTHETIC_AT, SYNTHETIC_AT, '["a"]');
  add.run("recall", "default", "We closed it yesterday.", null, SYNTHETIC_AT, SYNTHETIC_AT, null);
  add.run("foreign", "other", "foreign content", null, SYNTHETIC_AT, SYNTHETIC_AT, null);
  add.run("notebook", "default", "notebook content", null, SYNTHETIC_AT, SYNTHETIC_AT, null);
  const items = [
    { id: "recall", namespace: "default" }, { id: "recall", namespace: "default" },
    { id: "foreign", namespace: "other" }, { id: "notebook", namespace: "default", kind: "notebook" }
  ];
  sqlite.prepare("INSERT INTO memory_events(id,namespace,event_type,payload_json,created_at) VALUES('fake','default','recall_explain',?,?)")
    .run(JSON.stringify({ items }), "2026-11-17T10:04:00.000Z");
  const { claim } = await claimRollingWindow(env, "default", "shadow");
  assert.ok(claim);
  const recall = await rollingRecallHits(env, "default", claim.rows);
  assert.deepEqual(recall.map(({ id, hit_count, relation }) => ({ id, hit_count, relation })), [{ id: "recall", hit_count: 1, relation: "seen_only" }]);
  const packet = {
    window: { key: claim.key, from_seq: 1, to_seq: 2 }, messages: claim.rows,
    rolling_state: { episodes: [], open: [], changes: [] },
    recall_hits: recall, explicit_writes: await rollingExplicitWrites(env, "default", claim.rows)
  };
  const proposal = quoteFirst(packet);
  const event = proposal.events[0];
  const grounded = groundWindowProposal(packet, {
    events: [
      event, { ...event, evidence_ids: ["a", "invented"] },
      { ...event, content: "We closed it yesterday.", evidence_quote: "We closed it yesterday." },
      { ...event, op: "update", target_memory_id: "foreign" }
    ],
    state_delta: proposal.state_delta
  });
  assert.deepEqual(grounded.events.map(row => [row.op, row.reason]), [["no_op", "explicit_write"]]);
  assert.deepEqual(grounded.state_delta.episodes, []);
  assert.equal(sqlite.prepare("SELECT content FROM memories WHERE id='remembered'").get()?.content, event.content);
});

test("R13/R14/R21 low triage preserves explicit writing and searchable original words", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = shadowEnv(db);
  const content = "We have a synthetic nickname Beryl.";
  insertLine(sqlite, "a", content);
  insertLine(sqlite, "b", "Good evening.");
  await insertMessageFts(db, { namespace: "default", messageId: "a", content });
  sqlite.prepare("INSERT INTO memories(id,namespace,type,content,provenance,created_at,updated_at) VALUES('explicit','default','note',?,'{\"creation_mode\":\"agent_explicit\"}',?,?)").run(content, SYNTHETIC_AT, SYNTHETIC_AT);
  const result = await runRollingWindow(env, "default", { triage: ordinary, extractor: { async extract() { assert.fail("low triage"); } } });
  assert.equal(result.extracted, false);
  assert.equal((await getRollingDreamStatus(env, "default")).backlog, 0);
  assert.equal(sqlite.prepare("SELECT content FROM memories WHERE id='explicit'").get()?.content, content);
  assert.ok((await searchQuotes(db, { namespace: "default", query: "Beryl", limit: 4 })).some(hit => hit.id === "a"));
});

test("R16/R17 a Unicode oversized message retries only the failed part and keeps the same model decision", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = { ...shadowEnv(db), ROLLING_WINDOW_CHARS: "4" };
  insertLine(sqlite, "long", "甲🧪乙丙丁戊🙂己庚辛");
  const parts: string[] = [];
  let triageCalls = 0;
  const adapters = {
    triage: { async classify(packet: RollingPacket) {
      triageCalls += 1;
      assert.equal(packet.messages[0].chars, 4);
      return NOVEL;
    } },
    extractor: { async extract(packet: RollingPacket) {
      const row = packet.messages[0];
      parts.push(row.id);
      assert.equal(codePointLength(row.content), row.chars);
      if (parts.length === 2) return null;
      return quoteFirst(packet);
    } }
  };
  const first = await runRollingWindow(env, "default", adapters);
  assert.equal(first.reason, "extraction_failed");
  const second = await runRollingWindow({ ...env, ROLLING_WINDOW_CHARS: "5" }, "default", adapters);
  assert.equal(second.windowKey, first.windowKey);
  assert.equal(second.extracted, true);
  assert.deepEqual(parts, ["long#0-4", "long#4-8", "long#4-8", "long#8-10"]);
  assert.equal(triageCalls, 1);
  const { recent_windows: [stats] } = await getRollingDreamStatus(env, "default");
  assert.deepEqual([stats.attempts, stats.clef_calls, stats.extractor_calls, stats.event_count], [2, 1, 4, 3]);
  assert.deepEqual((await loadRollingState(env, "default", "shadow")).state.episodes[0].evidence_ids, ["long"]);
});

test("P2-c a removed source cannot be republished by inference finishing after withdrawal", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = shadowEnv(db);
  insertLine(sqlite, "a", "First.");
  insertLine(sqlite, "b", "Second.");
  let notifyStarted = () => {};
  let finish = () => {};
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const running = runRollingWindow(env, "default", { triage: novel, extractor: { async extract(packet) {
    notifyStarted();
    await pending;
    return quoteFirst(packet);
  } } });
  await started;
  assert.equal((await runRollingWindow(env, "default")).reason, "busy");
  await invalidateKnownInputs(env, { namespace: "default", id: "a" }, "message");
  finish();
  assert.equal((await running).reason, "lease_changed");
  assert.equal(sqlite.prepare("SELECT message_id FROM rolling_inbox WHERE message_id='a'").get(), undefined);
  assert.equal(sqlite.prepare("SELECT id FROM memory_events WHERE event_type='rolling_shadow'").get(), undefined);
  await runRollingWindow(env, "default", { triage: novel, extractor: { async extract(packet) { return quoteFirst(packet); } } });
  assert.equal((await loadRollingState(env, "default", "shadow")).state.episodes.length, 1);
  await invalidateKnownInputs(env, { namespace: "default", id: "b" }, "message");
  assert.equal(sqlite.prepare("SELECT id FROM memory_events WHERE event_type='rolling_shadow'").get(), undefined);
  assert.equal((await loadRollingState(env, "default", "shadow")).value, null);
});

test("D4/D5 uses one Clef request; a decision cue bypasses unavailable triage without creating a decision", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = shadowEnv(db);
  const seen: unknown[] = [];
  env.AI = { async run(model: string, input: unknown) {
    assert.equal(model, ROLLING_CLEF_MODEL);
    seen.push(input);
    return null;
  } } as Env["AI"];
  insertLine(sqlite, "a", "我决定就用 ACP。");
  insertLine(sqlite, "b", "明白了。", { role: "assistant" });
  let generated = 0;
  const result = await runRollingWindow(env, "default", { triage: clefTriage(env), extractor: { async extract() {
    generated += 1;
    return { events: [], state_delta: {} };
  } } });
  assert.equal(result.extracted, true);
  assert.equal(generated, 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys((seen[0] as { questions: object }).questions).sort(), ["decision", "novel"]);
  assert.equal(sqlite.prepare("SELECT id FROM memories").get(), undefined);
});

test("P2-d 200 synthetic chat lines sustain one episode across windows with a later turn", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  seedAffectionateDialogue(sqlite);
  const env = { DB: db, ROLLING_DREAM: "shadow" };
  const adapters = {
    triage: { async classify(packet: RollingPacket) { return episodeProposal(packet).events.length ? NOVEL : ORDINARY; } },
    extractor: { async extract(packet: RollingPacket) { return episodeProposal(packet); } }
  };
  for (let index = 0; index < 20; index += 1) assert.equal((await runRollingWindow(env, "default", adapters)).ran, true);
  assert.equal((await runRollingWindow(env, "default", adapters)).ran, false);
  const rows = sqlite.prepare("SELECT payload_json FROM memory_events WHERE event_type='rolling_shadow' ORDER BY rowid").all();
  const proposed = rows.flatMap(row => JSON.parse(String(row.payload_json)).events);
  assert.deepEqual(proposed.map(event => [event.op, event.episode_key, event.source_message_ids]), [
    ["new", "moon-post", ["chat_0"]], ["continuation", "moon-post", ["chat_180"]]
  ]);
});

test("A1 nightly owns off/shadow captures only after applying, and force may rerun nightly-owned rows", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = { ...shadowEnv(db), ROLLING_DREAM: "off", DREAM_TIME_ZONE: "UTC", DREAM_STRATEGY: "review" };
  insertLine(sqlite, "legacy", "Line before migration.");
  sqlite.exec("DELETE FROM rolling_inbox WHERE message_id='legacy'");
  insertLine(sqlite, "a", "First real line.");
  insertLine(sqlite, "b", "Second real line.");
  const extracts: string[] = [];
  env.AI = { async run(_model: string, request: { messages?: Array<{ content: string }> }) {
    const messages = request.messages ?? [];
    if (messages[0]?.content.includes("不要输出思考过程")) return { response: digestReply };
    extracts.push(messages[1]?.content ?? "");
    return { response: { memories: [] } };
  } } as Env["AI"];
  assert.equal((await runRollingWindow(env, "default")).reason, "off");
  assert.equal((await runRollingWindow({ ...env, ROLLING_DREAM: "shadow" }, "default", { triage: ordinary })).ran, true);
  assert.equal((await runDailyMemoryDigest(env, "default", { dateLabel: SYNTHETIC_DAY })).ran, true);
  assert.match(extracts[0], /First real line/);
  assert.match(extracts[0], /Line before migration/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM rolling_inbox WHERE done_at IS NOT NULL AND window_key LIKE 'nightly:%'").get()?.n, 2);
  assert.equal((await runRollingWindow({ ...env, ROLLING_DREAM: "shadow" }, "default")).ran, false);
  assert.equal((await runDailyMemoryDigest(env, "default", { dateLabel: SYNTHETIC_DAY, force: true })).ran, true);
  assert.equal(extracts.length, 2);
  insertLine(sqlite, "late", "Arrived after that day already finished.", { at: "2026-11-17T09:01:00.000Z" });
  assert.equal((await runDailyMemoryDigest(env, "default", { dateLabel: SYNTHETIC_DAY })).ran, true);
  assert.match(extracts[2], /Arrived after that day/);
  assert.doesNotMatch(extracts[2], /First real line|Line before migration/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM rolling_inbox WHERE done_at IS NULL").get()?.n, 0);
});

test("A1 nightly skips a fresh live claim and can take over an expired lease without advancing over it", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = shadowEnv(db);
  insertLine(sqlite, "a", "First.");
  insertLine(sqlite, "b", "Second.");
  const claim = await claimRollingWindow(env, "default", "on");
  assert.ok(claim.claim);
  const rows = sqlite.prepare("SELECT * FROM messages ORDER BY id").all() as unknown as MessageRecord[];
  const run = { dateLabel: SYNTHETIC_DAY, dreamRunId: "test" };
  assert.equal((await claimNightlyExtraction(env, "default", rows, run, false)).blocked, true);
  sqlite.exec("UPDATE rolling_inbox SET claimed_at='2000-01-01T00:00:00.000Z'");
  const nightly = await claimNightlyExtraction(env, "default", rows, run, false);
  assert.deepEqual([...nightly.messageIds], ["a", "b"]);
  assert.equal(await claimRollingWindow(env, "default", "on").then(result => result.claim), undefined);
  await releaseNightlyExtraction(db, "default", nightly);
  assert.ok((await claimRollingWindow(env, "default", "on")).claim);
});

test("late nightly batches extract candidates without replacing an existing diary draft", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = { ...shadowEnv(db), ROLLING_DREAM: "off", DREAM_TIME_ZONE: "UTC", DREAM_STRATEGY: "upsert" };
  insertLine(sqlite, "early", "The observatory opened.");
  env.AI = { async run(_model: string, input: { messages?: Array<{ content: string }> }) {
    const [system, body] = input.messages ?? [];
    if (!system) return { data: [[1, 0]] };
    const late = body.content.includes("The lens arrived.");
    if (system.content.includes("不要输出思考过程")) {
      return { response: {
        title: late ? "Late draft" : "Existing diary", summary: late ? "Only the lens." : "Full-day summary.",
        source_message_ids: late ? ["late"] : ["early"]
      } };
    }
    return { response: { memories: late ? [{
      type: "event", content: "The lens arrived.", attributed_role: "user",
      evidence_quote: "The lens arrived.", source_message_ids: ["late"]
    }] : [] } };
  } } as Env["AI"];
  assert.equal((await runDailyMemoryDigest(env, "default", { dateLabel: SYNTHETIC_DAY })).ran, true);
  const journal = sqlite.prepare("SELECT title,summary,source_message_ids FROM daily_log");
  const before = journal.get();
  assert.equal(before?.title, "Existing diary");
  insertLine(sqlite, "late", "The lens arrived.", { at: "2026-11-17T11:00:00.000Z" });
  assert.equal((await runDailyMemoryDigest(env, "default", { dateLabel: SYNTHETIC_DAY })).ran, true);
  assert.deepEqual(journal.get(), before);
  assert.equal(sqlite.prepare("SELECT content FROM memory_candidates").get()?.content, "The lens arrived.");
});

test("a short rolling lease cannot cut off an in-progress nightly batch", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = { ...shadowEnv(db), ROLLING_CLAIM_TTL_MINUTES: "1" };
  insertLine(sqlite, "one", "First line.");
  insertLine(sqlite, "two", "Second line.");
  const rows = sqlite.prepare("SELECT * FROM messages ORDER BY id").all() as unknown as MessageRecord[];
  const claim = await claimNightlyExtraction(env, "default", rows, { dateLabel: SYNTHETIC_DAY, dreamRunId: "first" }, false);
  assert.equal(claim.leasedIds.length, 2);
  sqlite.prepare("UPDATE rolling_inbox SET claimed_at=?").run(new Date(Date.now() - 5 * 60_000).toISOString());
  const other = { dateLabel: SYNTHETIC_DAY, dreamRunId: "other" };
  assert.equal((await claimNightlyExtraction(env, "default", rows, other, false)).blocked, true);
  assert.equal((await claimRollingWindow(env, "default", "on")).claim, undefined);
  sqlite.exec("UPDATE rolling_inbox SET claimed_at='2000-01-01T00:00:00.000Z'");
  assert.equal((await claimNightlyExtraction(env, "default", rows, other, false)).leasedIds.length, 2);
});

test("A3 settings and existing Dream endpoints report modes, retry failures, and comparisons", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = { ...shadowEnv(db), CHATBOX_API_KEY: "synthetic-secret", DREAM_TIME_ZONE: "UTC", ROLLING_MAX_ATTEMPTS: "1" };
  insertLine(sqlite, "a", "First.");
  insertLine(sqlite, "b", "Second.");
  await runRollingWindow(env, "default", { triage: { async classify() { return null; } } });
  assert.deepEqual(validateSettings({ ROLLING_DREAM: "shadow" }), { ROLLING_DREAM: "shadow" });
  assert.deepEqual(validateSettings({ ROLLING_DREAM: "on" }), { ROLLING_DREAM: "on" });
  assert.throws(() => validateSettings({ ROLLING_DREAM: "invalid" }), /off, shadow, on/);
  assert.match(ADMIN_HTML, /settingOption\(item\)/);
  assert.match(ADMIN_HTML, /What rolling would write/);
  const req = (path: string) => new Request(`https://synthetic.invalid${path}`, { headers: { authorization: "Bearer synthetic-secret" } });
  const status = await handleDreamStatus(req("/v1/dream/status"), env);
  assert.equal(status.status, 200);
  assert.equal((await status.json() as { data: { rolling: { failed_windows: Array<{ error: string }> } } }).data.rolling.failed_windows[0].error, "triage_failed");
  const harvest = await handleDreamHarvest(req(`/admin/dream/harvest?date=${SYNTHETIC_DAY}`), env);
  assert.equal(harvest.status, 200);
  assert.deepEqual((await harvest.json() as { data: { rolling: unknown } }).data.rolling, { shadow: [], nightly: [] });
  await cleanRawMessage(db, "default", "a");
  assert.equal(sqlite.prepare("SELECT 1 FROM rolling_inbox WHERE message_id='a'").get(), undefined);
});
