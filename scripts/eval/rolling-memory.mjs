import { runDailyMemoryDigest } from "../../src/memory/dream/orchestrator.ts";
import { scheduleRollingWindow } from "../../src/memory/rolling/inbox.ts";
import { runRollingWindow } from "../../src/memory/rolling/runner.ts";
import { getRollingDreamStatus } from "../../src/memory/rolling/stats.ts";
import { invalidateKnownInputs } from "../../src/db/v2/revocation.ts";
import {
  SYNTHETIC_DAY, SYNTHETIC_AT, NOVEL, ORDINARY, episodeProposal, insertLine, seedAffectionateDialogue
} from "../../tests/support/rolling-fixture.ts";
import { sqliteFixture } from "../../tests/support/sqlite.ts";

const authored = "I prefer check-ins in the morning.";

function baselineReply(request, sqlite, counts) {
  const [system, user] = request.messages;
  if (system.content.includes("不要输出思考过程")) {
    counts.digest += 1;
    return { response: { title: "Check-in", summary: "We scheduled the synthetic check-ins." } };
  }
  counts.extractor += 1;
  const memories = ["chat_0", "chat_180"].filter(id => user.content.includes(`[${id}]`)).map(id => {
    const { content } = sqlite.prepare("SELECT content FROM messages WHERE id=?").get(id);
    return { type: "event", content, attributed_role: "user", evidence_quote: content, source_message_ids: [id] };
  });
  return { response: { memories } };
}

async function sample(mode, latency) {
  let close;
  const { sqlite, db } = sqliteFixture({ after(fn) { close = fn; } });
  try {
    if (mode === "nightly") sqlite.exec("DROP TRIGGER rolling_inbox_capture");
    const counts = { digest: 0, clef: 0, extractor: 0, gated: 0 };
    const env = {
      DB: db, ROLLING_DREAM: mode === "nightly" ? "off" : "shadow", DREAM_TIME_ZONE: "UTC", DREAM_STRATEGY: "review",
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
    sqlite.prepare(`INSERT INTO memories(id,namespace,type,content,authored_by,provenance,created_at,updated_at)
      VALUES('personal','default','note',?,'Synthetic','{"creation_mode":"agent_explicit"}',?,?)`).run(authored, SYNTHETIC_AT, SYNTHETIC_AT);
    insertLine(sqlite, "other", "A different namespace.", { namespace: "other" });
    const enqueueStart = performance.now();
    await scheduleRollingWindow(env, "default");
    const enqueueMs = performance.now() - enqueueStart;
    const adapters = {
      triage: { async classify(packet) {
        counts.clef += 1;
        return episodeProposal(packet).events.length ? NOVEL : ORDINARY;
      } },
      extractor: { async extract(packet) {
        counts.gated += 1;
        if (mode === "triage") return { events: [], state_delta: {} };
        counts.extractor += 1;
        if (mode === "shadow" && counts.extractor === 2) return null;
        return episodeProposal(packet);
      } }
    };
    const start = performance.now();
    let windows = 0;
    let completedRetries = 0;
    if (mode === "nightly") {
      for (let batch = 0; batch < 10; batch += 1) {
        const result = await runDailyMemoryDigest(env, "default", { dateLabel: SYNTHETIC_DAY });
        if (!result.ran || !result.stats.hasMore) break;
      }
    } else {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const result = await runRollingWindow(env, "default", adapters);
        if (!result.ran) break;
        if (!result.retryAfter) windows += 1;
        if (attempt > 0 && result.extracted && counts.extractor === 3) completedRetries += 1;
      }
    }
    const processingMs = performance.now() - start;
    const windowStats = await getRollingDreamStatus(env, "default");
    const events = mode === "nightly"
      ? sqlite.prepare("SELECT content,source_message_ids FROM memory_candidates").all().map(row => ({
        content: row.content, source_message_ids: JSON.parse(row.source_message_ids)
      }))
      : sqlite.prepare("SELECT payload_json FROM memory_events WHERE event_type='rolling_shadow'").all()
        .flatMap(row => JSON.parse(row.payload_json).events.filter(event => event.op !== "no_op"));
    const ids = events.flatMap(event => event.source_message_ids);
    const wrongEvidence = ids.filter(id => !["chat_0", "chat_180"].includes(id)).length;
    const duplicateCandidates = events.length - new Set(events.map(event => event.content)).size;
    await invalidateKnownInputs(env, { namespace: "default", id: "chat_1" }, "message");
    const stored = sqlite.prepare("SELECT content,status FROM memories WHERE id='personal'").get();
    return {
      mode, messages: times.length, captureWriteMs: latency(times), enqueueMs, processingMs, ...counts,
      windows, completedRetries, timeouts: windowStats.failed_windows.filter(row => row.error === "extractor_timeout").length,
      events: events.length, duplicateCandidates, citedIds: ids.length, wrongEvidence,
      crossNamespaceEvidence: ids.filter(id => id === "other").length,
      authoredRetained: stored?.content === authored && stored.status === "active"
    };
  } finally {
    close();
  }
}

export async function runRollingBenchmark(latency) {
  const cases = [];
  for (const mode of ["nightly", "triage", "shadow"]) cases.push(await sample(mode, latency));
  console.log(JSON.stringify({ rolling: { fixture: "local SQLite and synthetic adapters", chatPathAddedModelCalls: 0, cases } }));
}
