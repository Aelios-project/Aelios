// Run with node --import tsx scripts/bench-memory-continuity.mjs on either checkout.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { runRecall } from "../src/memory/v2/recall.ts";
import { annotateCurrentState } from "../src/memory/currentState/projection.ts";

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync("migrations").sort()) sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
const hasOrigin = sqlite
  .prepare("PRAGMA table_info(memories)")
  .all()
  .some((c) => c.name === "provenance");
const db = {
  prepare(sql) {
    const stmt = sqlite.prepare(sql);
    let args = [];
    const query = {
      bind(...values) {
        args = values;
        return query;
      },
      async first() {
        return stmt.get(...args) ?? null;
      },
      async all() {
        return { results: stmt.all(...args) };
      },
      async run() {
        return { meta: stmt.run(...args) };
      },
    };
    return query;
  },
  async batch(queries) {
    return Promise.all(queries.map((q) => q.run()));
  },
};
let embeds = 0;
const env = {
  DB: db,
  ENABLE_MEMORY_RERANKER: "false",
  AI: {
    async run() {
      embeds++;
      return { data: [[1, 0]] };
    },
  },
  VECTORIZE: {
    async query() {
      return {
        matches: corpus.map(([id], i) => ({
          id: `mem_${id}`,
          score: 0.82 - i / 1000,
          metadata: { ref_id: id, namespace: "bench" },
        })),
      };
    },
  },
};
const corpus = [
  [
    "interpretation",
    "ACP planning. The assistant guessed the user might abandon DSH.",
    "dream_derived",
    "unknown",
  ],
  [
    "writer",
    "ACP planning. Dan9 wrote a reflection about the cost of changing tools.",
    "agent_explicit",
    "unknown",
  ],
  ["user", "ACP planning. The user decided to integrate ACP.", "dream_derived", "user"],
  ["old", "ACP planning. The user considered abandoning DSH.", "dream_derived", "user"],
  ["unrelated", "The ceramic mug is green.", "unknown", "unknown"],
];
for (const [id, content, mode, role] of corpus) {
  const old = id === "old";
  sqlite
    .prepare(
      "INSERT INTO memories(id, namespace, type, content, source, importance, confidence, status, vector_id, created_at, updated_at, version_status, authored_by) VALUES (?, 'bench','note', ?, ?, 0.7, 0.9, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      content,
      id === "writer" ? "mcp" : "judge",
      old ? "superseded" : "active",
      `mem_${id}`,
      old ? "2025-12-01" : "2026-01-01",
      old ? "2025-12-01" : "2026-01-01",
      old ? "superseded" : "current",
      id === "writer" ? "Dan9" : null,
    );
  if (hasOrigin && mode !== "unknown")
    sqlite
      .prepare("UPDATE memories SET provenance=? WHERE id=?")
      .run(
        JSON.stringify({
          creation_mode: mode,
          claimed_author: id === "writer" ? "Dan9" : undefined,
          attributed_actor: role,
          recording_actor: id === "writer" ? "mcp:mcp" : "dream",
          evidence_relation: id === "interpretation" ? "interpretation" : "paraphrase",
          completeness: "partial",
        }),
        id,
      );
}
const queries = [
  ["What did Dan9 write about ACP planning?", "writer"],
  ["What did the user decide about ACP planning?", "user"],
  ["ceramic mug", "unrelated"],
  ["Exact wording of the ACP promise?", null],
  ["How did the ACP choice evolve?", "old"],
];
const times = [];
const byQuery = queries.map(() => []);
const first = [];
const found = [];
const stale = [];
for (let iteration = 0; iteration < 120; iteration++) {
  for (const [index, [query, expected]] of queries.entries()) {
    const start = performance.now();
    const r = await runRecall(env, { namespace: "bench", query, k: 5, skip_inject_mark: true });
    if (iteration >= 20) {
      const duration = performance.now() - start;
      times.push(duration);
      byQuery[index].push(duration);
    }
    first[index] = r.hits[0]?.id;
    found[index] = expected ? r.hits.some((h) => h.id === expected) : r.evidence?.status === "unavailable";
    stale[index] = r.hits.some((h) => h.id === "old");
  }
}
function latency(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)]};
}
console.log(
  JSON.stringify({
    queries: queries.map(([query], i) => ({ query, first: first[i], found: found[i], stale: stale[i], ...latency(byQuery[i]) })),
    samples: times.length,
    ...latency(times),
    embeds,
  }),
);

let projectionModelCalls = 0;
const projectionEnv = {
  DB: db,
  CURRENT_STATE_PROJECTION: "on",
  AI: { async run() { projectionModelCalls++; } },
};
const linkedHit = {
  id: "writer",
  content: corpus.find(([id]) => id === "writer")[1],
  type: "note",
  source: "mcp",
  kind: "memory",
  source_layer: "memory",
  backed: true,
  score: 0.8,
  recorded_date: "2026-01-01",
};
const projectionLatencies = { off: [], linked: [], unrelated: [] };
for (let iteration = 0; iteration < 120; iteration++) {
  for (const [mode, hits, query] of [
    ["off", [linkedHit], "ACP planning now"],
    ["linked", [linkedHit], "ACP planning now"],
    ["unrelated", [{ ...linkedHit, id: "unrelated" }], "ACP planning now"],
  ]) {
    const start = performance.now();
    await annotateCurrentState(
      { ...projectionEnv, CURRENT_STATE_PROJECTION: mode === "off" ? "off" : "on" },
      "bench",
      hits.map((hit) => ({ ...hit })),
      query,
      false,
      5,
    );
    if (iteration >= 20) projectionLatencies[mode].push(performance.now() - start);
  }
}
console.log(JSON.stringify({
  projection: {
    samples: projectionLatencies.off.length,
    off: latency(projectionLatencies.off),
    linked: latency(projectionLatencies.linked),
    unrelated: latency(projectionLatencies.unrelated),
    modelCalls: projectionModelCalls,
  },
}));
sqlite.close();
