import { runDailyMemoryDigest } from "../../src/memory/dream/orchestrator.ts";
import { DreamModelTimeoutError } from "../../src/memory/dream/modelCall.ts";
import { scheduleRollingWindow } from "../../src/memory/rolling/inbox.ts";
import { runRollingWindow } from "../../src/memory/rolling/runner.ts";
import { getRollingDreamStatus } from "../../src/memory/rolling/stats.ts";
import { invalidateKnownInputs } from "../../src/db/v2/revocation.ts";
import {
  SYNTHETIC_DAY, SYNTHETIC_AT, NOVEL, ORDINARY, episodeProposal, insertLine, seedAffectionateDialogue
} from "../../tests/support/rolling-fixture.ts";
import { sqliteFixture } from "../../tests/support/sqlite.ts";

const authored = "I prefer check-ins in the morning.";
const choices = new Map([["chat_2", "Saturday"], ["chat_182", "Sunday"]]);
const decision = (value) => ({ scope_key: "user/check-in/day", value, state_of: [] });
const decisionContent = (value) => `The user decided the check-in day is ${value}.`;
const expectedIds = new Set(["chat_0", "chat_180", ...choices.keys()]);

function proposed(packet) {
  const base = episodeProposal(packet);
  const decisions = packet.messages.flatMap(row => {
    const value = choices.get(row.id);
    return value ? [{
      op: "new", type: "decision", content: decisionContent(value),
      attributed_role: "user", evidence_ids: [row.id], evidence_quote: row.content, decision: decision(value)
    }] : [];
  });
  return { ...base, events: [...base.events, ...decisions] };
}

function baselineReply(request, sqlite, counts) {
  const [system, user] = request.messages;
  if (system.content.includes("不要输出思考过程")) {
    counts.digest += 1;
    return { response: { title: "Check-in", summary: "We scheduled the synthetic check-ins." } };
  }
  counts.extractor += 1;
  const memories = [...expectedIds].filter(id => user.content.includes(`[${id}]`)).map(id => {
    const { content } = sqlite.prepare("SELECT content FROM messages WHERE id=?").get(id);
    const common = { attributed_role: "user", evidence_quote: content, source_message_ids: [id] };
    const value = choices.get(id);
    return value
      ? { ...common, type: "decision", content: decisionContent(value), decision: decision(value) }
      : { ...common, type: "event", content };
  });
  return { response: { memories } };
}

async function sample(mode, latency) {
  let close;
  const { sqlite, db } = sqliteFixture({ after(fn) { close = fn; } });
  try {
    if (mode === "nightly") sqlite.exec("DROP TRIGGER rolling_inbox_capture");
    const counts = { digest: 0, clef: 0, extractor: 0, gated: 0, timeouts: 0 };
    const env = {
      DB: db, ROLLING_DREAM: mode === "nightly" ? "off" : mode === "triage" ? "shadow" : mode,
      DREAM_TIME_ZONE: "UTC", DREAM_STRATEGY: "review", CURRENT_STATE_PROJECTION: "on",
      AI: { async run(_model, request) {
        if (!request.messages) return { data: [[1, 0]] };
        return baselineReply(request, sqlite, counts);
      } },
      MEMORY_QUEUE: { async send() {} }
    };
    const times = [];
    let reference = performance.now();
    seedAffectionateDialogue(sqlite, () => {
      const at = performance.now();
      times.push(at - reference);
      reference = at;
    });
    for (const [id, value] of choices) {
      const hour = value === "Saturday" ? "09" : "11";
      sqlite.prepare("UPDATE messages SET content=?,created_at=? WHERE id=?")
        .run(`I decided the check-in day is ${value}.`, `${SYNTHETIC_DAY}T${hour}:00:00.000Z`, id);
    }
    sqlite.prepare(`INSERT INTO memories(id,namespace,type,content,authored_by,provenance,created_at,updated_at)
      VALUES('personal','default','note',?,'Synthetic','{"creation_mode":"agent_explicit"}',?,?)`).run(authored, SYNTHETIC_AT, SYNTHETIC_AT);
    insertLine(sqlite, "other", "A different namespace.", { namespace: "other" });
    const enqueueStart = performance.now();
    await scheduleRollingWindow(env, "default");
    const enqueueMs = performance.now() - enqueueStart;
    const adapters = {
      triage: { async classify(packet) {
        counts.clef += 1;
        return proposed(packet).events.length ? NOVEL : ORDINARY;
      } },
      extractor: { async extract(packet) {
        counts.gated += 1;
        if (mode === "triage") return { events: [], state_delta: {} };
        counts.extractor += 1;
        if (counts.extractor === 2) {
          counts.timeouts += 1;
          throw new DreamModelTimeoutError();
        }
        return proposed(packet);
      } }
    };
    const start = performance.now();
    let windows = 0;
    let completedRetries = 0;
    const retrying = new Set();
    if (mode === "nightly") {
      for (let batch = 0; batch < 10; batch += 1) {
        const result = await runDailyMemoryDigest(env, "default", { dateLabel: SYNTHETIC_DAY });
        if (!result.ran || !result.stats.hasMore) break;
      }
    } else {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const result = await runRollingWindow(env, "default", adapters);
        if (!result.ran) break;
        if (result.retryAfter) retrying.add(result.windowKey);
        else {
          windows += 1;
          if (retrying.delete(result.windowKey) && result.extracted) completedRetries += 1;
        }
      }
    }
    const processingMs = performance.now() - start;
    const landed = () => sqlite.prepare(`SELECT content,source_message_ids FROM memory_candidates
      UNION ALL SELECT content,source_message_ids FROM memories WHERE source='scoped_decision' AND status IN ('active','superseded')`).all();
    const writes = mode === "nightly" || mode === "on";
    const events = writes
      ? landed().map(row => ({
        content: row.content, source_message_ids: JSON.parse(row.source_message_ids)
      }))
      : sqlite.prepare("SELECT payload_json FROM memory_events WHERE event_type='rolling_shadow'").all()
        .flatMap(row => JSON.parse(row.payload_json).events.filter(event => event.op !== "no_op"));
    const ids = events.flatMap(event => event.source_message_ids);
    const wrongEvidence = ids.filter(id => !expectedIds.has(id)).length;
    const duplicateCandidates = events.length - new Set(events.map(event => event.content)).size;
    await invalidateKnownInputs(env, { namespace: "default", id: "chat_1" }, "message");
    const stored = sqlite.prepare("SELECT content,status FROM memories WHERE id='personal'").get();
    const active = sqlite.prepare("SELECT content FROM memories WHERE source='scoped_decision' AND status='active'").get();
    const latestShadow = events.filter(event => event.decision).at(-1);
    return {
      mode, messages: times.length, captureWriteMs: latency(times), enqueueMs, processingMs, ...counts,
      windows, completedRetries, failedWindows: (await getRollingDreamStatus(env, "default")).failed_windows.length,
      events: events.length, duplicateCandidates, citedIds: ids.length, wrongEvidence,
      crossNamespaceEvidence: ids.filter(id => id === "other").length,
      latestDecisionCorrect: mode === "triage" ? null : writes ? active?.content === decisionContent("Sunday") : latestShadow?.decision?.value === "Sunday",
      unrelatedLiveWritesWithdrawn: writes ? events.length - landed().length : 0,
      authoredRetained: stored?.content === authored && stored.status === "active"
    };
  } finally {
    close();
  }
}

export async function runRollingBenchmark(latency) {
  const cases = [];
  for (const mode of ["nightly", "triage", "shadow", "on"]) cases.push(await sample(mode, latency));
  console.log(JSON.stringify({ rolling: { fixture: "local SQLite and synthetic adapters", chatPathAddedModelCalls: 0, cases } }));
}
