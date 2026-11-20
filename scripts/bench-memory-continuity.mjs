// Run with node --import tsx scripts/bench-memory-continuity.mjs on either checkout.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { runRecall } from "../src/memory/v2/recall.ts";

// Run the same deterministic Dream/diary, decision, retention, and withdrawal fixtures used by CI.
if (process.argv.includes("--dream")) {
  const {spawnSync} = await import("node:child_process");
  const result = spawnSync(process.execPath, ["--import","tsx","--test",
    "--test-name-pattern=200-message episode|decision history ACP/SDK|14-day recurring-episode|cleanup detaches a line",
    "tests/dream-extraction-runtime.test.ts","tests/candidate-review.test.ts","tests/raw-delete.test.ts"],
    {encoding:"utf8",maxBuffer:8*1024*1024});
  const output = result.stdout ?? "";
  console.log(result.status === 0 ? output.split("\n").filter(line =>
    /^(?:ok |# (?:per_batch |daily \{|trial active|judge active|tests |pass |fail ))/.test(line)).join("\n") : output);
  if (result.error || result.stderr) console.error(result.error ?? result.stderr);
  process.exit(result.status ?? 1);
}

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
sqlite.close();
