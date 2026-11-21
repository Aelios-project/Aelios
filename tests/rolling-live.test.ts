import assert from "node:assert/strict";
import { test } from "node:test";
import { invalidateKnownInputs } from "../src/db/v2/revocation";
import { runDiaryWriterForDate } from "../src/memory/diaryWriter";
import { runDailyMemoryDigest } from "../src/memory/dream/orchestrator";
import type { WindowProposal } from "../src/memory/rolling/extract";
import type { RollingPacket } from "../src/memory/rolling/payload";
import { runRollingWindow } from "../src/memory/rolling/runner";
import { getRollingDreamStatus } from "../src/memory/rolling/stats";
import type { Env } from "../src/types";
import { insertLine, NOVEL, SYNTHETIC_AT, SYNTHETIC_DAY } from "./support/rolling-fixture";
import { sqliteFixture } from "./support/sqlite";

function liveEnv(db: D1Database): Env {
  return { DB: db, ROLLING_DREAM: "on", ROLLING_WINDOW_MESSAGES: "2", DREAM_TIME_ZONE: "UTC", DREAM_STRATEGY: "review" };
}

function proposal(packet: RollingPacket, options: Partial<WindowProposal["events"][number]> = {}): WindowProposal {
  const row = packet.messages[0];
  return {
    events: [{
      op: "new", type: "event", content: row.content, evidence_quote: row.content, evidence_ids: [row.id],
      attributed_role: "user", ...options
    }], state_delta: {}
  };
}

const triage = { async classify() { return NOVEL; } };
const digest = { title: "Synthetic day", summary: "A synthetic transcript.", memories_to_add: [] };

function captureNightly(env: Env, seen: string[]) {
  env.AI = { async run(_model: string, request: { messages?: Array<{ content: string }> }) {
    const [system, body] = request.messages ?? [];
    if (!system) return { data: [[1, 0]] };
    if (system.content.includes("no reasoning")) return { response: digest };
    seen.push(body.content);
    return { response: { memories: [] } };
  } } as Env["AI"];
}

test("P2-b nightly model reads only the tail and the journal still reads the entire retained day", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = { ...liveEnv(db), DREAM_STRATEGY: "upsert" };
  insertLine(sqlite, "win_1", "Rolling first.");
  insertLine(sqlite, "win_2", "Rolling second.");
  insertLine(sqlite, "tail", "Nightly tail.");
  assert.equal((await runRollingWindow(env, "default", { triage, extractor: { async extract(packet) { return proposal(packet); } } })).extracted, true);
  assert.equal((await runRollingWindow(env, "default")).reason, "no_window");
  sqlite.prepare(`INSERT INTO daily_log(namespace,date,title,summary,updated_at)
    VALUES('default',?,'Existing diary','Whole day',?)`).run(SYNTHETIC_DAY, SYNTHETIC_AT);
  const prompts: string[] = [];
  captureNightly(env, prompts);
  assert.equal((await runDailyMemoryDigest(env, "default", { dateLabel: SYNTHETIC_DAY })).ran, true);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Nightly tail/);
  assert.doesNotMatch(prompts[0], /Rolling first|Rolling second/);
  assert.equal(sqlite.prepare("SELECT summary FROM daily_log").get()?.summary, "Whole day");
  let diary = "";
  env.AI = { async run(_model: string, input: { messages: Array<{ content: string }> }) {
    diary = input.messages[1].content;
    return { response: { ...digest, source_message_ids: ["win_1", "win_2", "tail"] } };
  } } as Env["AI"];
  assert.equal((await runDiaryWriterForDate(env, "default", SYNTHETIC_DAY)).ran, true);
  for (const text of ["Rolling first", "Rolling second", "Nightly tail"]) assert.ok(diary.includes(text));
});

test("P2-e off → on → off → on in the same day extracts each message exactly once", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const active = liveEnv(db);
  const off = { ...active, ROLLING_DREAM: "off" };
  const extracted: string[] = [];
  off.AI = { async run(_model: string, request: { messages?: Array<{ content: string }> }) {
    const [system, body] = request.messages ?? [];
    if (!system) return { data: [[1, 0]] };
    if (system.content.includes("no reasoning")) return { response: digest };
    for (const match of body.content.matchAll(/\[(msg_\d+)\]/g)) extracted.push(match[1]);
    return { response: { memories: [] } };
  } } as Env["AI"];
  const extractor = { async extract(packet: RollingPacket) {
    extracted.push(...packet.messages.map(row => row.id));
    return proposal(packet);
  } };
  const add = (...numbers: number[]) => {
    for (const index of numbers) {
      insertLine(sqlite, `msg_${index}`, `Synthetic line ${index}`, {
        at: `${SYNTHETIC_DAY}T${index === 4 ? "09" : "10"}:00:0${index}.000Z`
      });
    }
  };
  add(1, 2);
  assert.equal((await runDailyMemoryDigest(off, "default", { dateLabel: SYNTHETIC_DAY })).ran, true);
  add(3, 4);
  await runRollingWindow(active, "default", { triage, extractor });
  add(5);
  assert.equal((await runDailyMemoryDigest(off, "default", { dateLabel: SYNTHETIC_DAY })).ran, true);
  add(6, 7);
  await runRollingWindow(active, "default", { triage, extractor });
  assert.deepEqual(extracted, ["msg_1", "msg_2", "msg_3", "msg_4", "msg_5", "msg_6", "msg_7"]);
  assert.equal((await getRollingDreamStatus(active, "default")).backlog, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM rolling_inbox WHERE window_key LIKE 'nightly:%'").get()?.n, 3);
});

test("D6 continuation extends the pending episode and targets its approved derived memory only on material change", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = { ...liveEnv(db), ROLLING_WINDOW_MESSAGES: "1" };
  const extractor = { async extract(packet: RollingPacket) {
    return proposal(packet, { episode_key: "shared-lab", op: packet.messages[0].id === "first" ? "new" : "continuation" });
  } };
  const roll = () => runRollingWindow(env, "default", { triage, extractor });
  insertLine(sqlite, "first", "We named the lab 「Prism」.");
  assert.equal((await roll()).extracted, true);
  insertLine(sqlite, "second", "The lab meets on Sundays.");
  assert.equal((await roll()).extracted, true);
  const [candidate] = sqlite.prepare("SELECT * FROM memory_candidates").all();
  assert.ok(candidate);
  assert.equal(candidate.content, "We named the lab 「Prism」.\nThe lab meets on Sundays.");
  assert.deepEqual(JSON.parse(String(candidate.source_message_ids)), ["first", "second"]);
  sqlite.prepare("UPDATE memory_candidates SET status='approved' WHERE id=?").run(candidate.id);
  sqlite.prepare(`INSERT INTO memories(id,namespace,type,content,created_at,updated_at,provenance)
    VALUES('approved','default','event',?,?,?,?)`).run(candidate.content, SYNTHETIC_AT, SYNTHETIC_AT, JSON.stringify({
    creation_mode: "dream_derived", candidate_id: candidate.id
  }));
  insertLine(sqlite, "same", "The lab meets on Sundays.");
  await roll();
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM memory_candidates").get()?.n, 1);
  insertLine(sqlite, "third", "The lab changed its main meeting to Friday.");
  await roll();
  const update = sqlite.prepare("SELECT * FROM memory_candidates WHERE source='dream_update'").get();
  assert.equal(update?.target_memory_id, "approved");
  assert.deepEqual(JSON.parse(String(update?.provenance)).inputs, ["message:third", "memory:approved"]);
  assert.equal(sqlite.prepare("SELECT content FROM memories WHERE id='approved'").get()?.content, candidate.content);
});

test("rolling decisions use P1 ordering and leave an older late arrival in history", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = { ...liveEnv(db), ROLLING_WINDOW_MESSAGES: "1", CURRENT_STATE_PROJECTION: "on" };
  const decide = async (id: string, value: string, at: string) => {
    const quote = `I decided to use ${value}.`;
    insertLine(sqlite, id, quote, { at });
    const result = await runRollingWindow(env, "default", { triage, extractor: { async extract(packet) {
      return proposal(packet, {
        type: "decision", content: `The user decided to use ${value}.`,
        decision: { scope_key: "user/lab/protocol", value, state_of: [] }
      });
    } } });
    assert.equal(result.extracted, true);
  };
  await decide("direct_1", "SDK", `${SYNTHETIC_DAY}T08:00:00.000Z`);
  await decide("direct_2", "ACP", `${SYNTHETIC_DAY}T10:00:00.000Z`);
  await decide("late_old", "REST", `${SYNTHETIC_DAY}T09:00:00.000Z`);
  assert.match(String(sqlite.prepare("SELECT content FROM memories WHERE status='active'").get()?.content), /ACP/);
  assert.match(String(sqlite.prepare("SELECT content FROM memory_revisions WHERE reason='late_evidence'").get()?.content), /REST/);
  assert.match(String(sqlite.prepare("SELECT value FROM processing_cursors WHERE name='rolling_state:default'").get()?.value), /user\/lab\/protocol/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM memory_candidates").get()?.n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM memory_events WHERE event_type='rolling_draft'").get()?.n, 0);
});

test("a failure after the live write resumes with the same proposal even after switching off", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = liveEnv(db);
  insertLine(sqlite, "first", "We opened the observatory.");
  insertLine(sqlite, "second", "The projector lit up.");
  sqlite.exec(`CREATE TRIGGER synthetic_checkpoint_failure BEFORE UPDATE OF done_at ON rolling_inbox
    WHEN NEW.done_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic checkpoint outage'); END`);
  let calls = 0;
  const result = await runRollingWindow(env, "default", { triage, extractor: { async extract(packet) {
    calls += 1;
    return proposal(packet);
  } } });
  assert.equal(result.reason, "window_processing_failed");
  const candidate = sqlite.prepare("SELECT id FROM memory_candidates").get()?.id;
  assert.ok(candidate);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM rolling_inbox WHERE done_at IS NOT NULL").get()?.n, 0);
  sqlite.exec("DROP TRIGGER synthetic_checkpoint_failure");
  const off = { ...env, ROLLING_DREAM: "off", AI: { async run() { assert.fail("no model call for an already extracted window"); } } as unknown as Env["AI"] };
  assert.equal((await runDailyMemoryDigest(off, "default", { dateLabel: SYNTHETIC_DAY })).ran, true);
  assert.equal(calls, 1);
  assert.deepEqual(sqlite.prepare("SELECT id FROM memory_candidates").all().map(row => row.id), [candidate]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM rolling_inbox WHERE done_at IS NOT NULL").get()?.n, 2);
});

test("an expired nightly inference cannot write candidates after live rolling takes its messages", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = liveEnv(db);
  insertLine(sqlite, "first", "The lab opens on weekends.");
  insertLine(sqlite, "second", "A moment later.");
  let entered = () => {};
  let release = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  const off = { ...env, ROLLING_DREAM: "off" };
  off.AI = { async run(_model: string, input: { messages: Array<{ content: string }> }) {
    if (input.messages[0].content.includes("no reasoning")) {
      entered();
      await paused;
      return { response: digest };
    }
    return { response: { memories: [{
      type: "event", content: "Stale candidate", attributed_role: "user",
      evidence_quote: "The lab opens on weekends.", source_message_ids: ["first"]
    }] } };
  } } as Env["AI"];
  const nightly = runDailyMemoryDigest(off, "default", { dateLabel: SYNTHETIC_DAY });
  await started;
  sqlite.exec("UPDATE rolling_inbox SET claimed_at='2000-01-01T00:00:00.000Z'");
  assert.equal((await runRollingWindow(env, "default", { triage, extractor: { async extract(packet) {
    return proposal(packet);
  } } })).extracted, true);
  release();
  await assert.rejects(nightly, /malformed JSON/);
  assert.deepEqual(sqlite.prepare("SELECT content FROM memory_candidates").all().map(row => row.content),
    ["The lab opens on weekends."]);
});

test("P2-c/R22 withdrawal follows citations, and age leaves an unrelated candidate awaiting review", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const env = liveEnv(db);
  insertLine(sqlite, "proof-a", "We chose the north trail.");
  insertLine(sqlite, "proof-b", "I collect glass puzzles.");
  await runRollingWindow(env, "default", { triage, extractor: { async extract(packet) {
    return {
      events: packet.messages.flatMap(message => proposal({ ...packet, messages: [message] }).events),
      state_delta: {}
    };
  } } });
  sqlite.exec("UPDATE memory_candidates SET created_at='2000-01-01',updated_at='2000-01-01'");
  await invalidateKnownInputs(env, { namespace: "default", id: "proof-a" }, "message");
  assert.deepEqual(sqlite.prepare("SELECT status,source_message_ids FROM memory_candidates").all().map(row => [row.status, row.source_message_ids]),
    [["pending", '["proof-b"]']]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get()?.n, 0);
  assert.equal(sqlite.prepare("SELECT value FROM processing_cursors WHERE name='rolling_state:default'").get(), undefined);
});
