import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import vm from "node:vm";
import worker from "../src/index";
import { invalidateSettingsCache } from "../src/gateway/config";
import { runCandidateJudge } from "../src/memory/candidateJudge";
import { getMessagesByIds } from "../src/db/messages";
import { listActiveFactKeys } from "../src/db/v2";
import { formatMemoriesMarkdown, parseMemoryImport } from "../src/memory/transfer/memoryText";
import {
  chatApplyRoles,
  chatChunkByDay,
  chatParseBrowserScript,
  parseChatExport
} from "../src/memory/transfer/chatParse";

// Memory import / export: export to md or jsonl and import it back, import tidied entries, import whole chat
// histories through review, keep old text when a memory is rewritten in place.
(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);
let sqlite: DatabaseSync;
let env: any;
let extractReplies: any[];
let extractPrompts: string[];
let clefAnswers: any[];
let clefCalls: number;
let similar: { id: string; content: string; score: number } | null;

beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter((f: string) => f.endsWith(".sql")).sort()) {
    try { sqlite.exec(readFileSync(`migrations/${file}`, "utf8")); }
    catch (error) {
      if (!String(error).includes("fts5")) throw error;
    }
  }
  const db = { prepare(sql: string) {
    const statement = sqlite.prepare(sql); let args: any[] = [];
    const api = { bind(...values: any[]) { args = values; return api; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args) }; },
      async run() {
        if (statement.columns().length) return { results: statement.all(...args), meta: { changes: 0 } };
        const result = statement.run(...args);
        return { meta: { changes: result.changes } };
      }
    }; return api;
  }, async batch(statements: any[]) {
    const results = []; for (const statement of statements) results.push(await statement.run()); return results;
  } };
  invalidateSettingsCache();
  extractReplies = []; extractPrompts = []; clefAnswers = []; clefCalls = 0; similar = null;
  env = { DB: db, CHATBOX_API_KEY: "owner-key", IM_API_KEY: "im-key", CLOUDFLARE_API_TOKEN: "cf-token",
    DREAM_MODEL: "workers-ai/@cf/openai/gpt-oss-120b", DREAM_TIMEZONE: "Asia/Shanghai",
    AI: { async run(model: string, input: any) {
      if (model.includes("bge")) return { data: [[0.1, 0.2, 0.3]] };
      if (model.includes("clef")) {
        clefCalls += 1;
        const next = clefAnswers.shift() ?? { grounded: 0.9, worth: 0.9 };
        return { answers: Object.fromEntries(Object.entries(next).map(([id, noul]) => [id, { type: "noul", noul }])) };
      }
      if (model.includes("gpt-oss")) {
        extractPrompts.push(input.messages?.[1]?.content ?? "");
        const reply = extractReplies.shift() ?? { memories: [] };
        return { response: typeof reply === "string" ? reply : JSON.stringify(reply), usage: { prompt_tokens: 1200, completion_tokens: 150 } };
      }
      throw new Error(`unexpected model: ${model}`);
    } },
    VECTORIZE: {
      async upsert() { return {}; },
      async deleteByIds() { return {}; },
      async query() {
        if (!similar) return { matches: [] };
        return { matches: [{ id: `mem_${similar.id}`, score: similar.score,
          metadata: { namespace: "default", content: similar.content, status: "active", type: "fact" } }] };
      }
    } };
  globalThis.fetch = async (url: any) => { throw new Error(`unexpected upstream call: ${url}`); };
  env.GATEWAY_CONFIG = JSON.stringify({ version: 3, upstream: { address: "https://upstream.test/ai/v1" }, identities: [
    { slug: "danjiu", namespace: "default", keys: ["CHATBOX_API_KEY"], models: ["*"], userName: "咲咲", assistantName: "旦九" }
  ] });
});

const now = () => new Date().toISOString();
function memory(id: string, content: string, factKey: string | null, extra: { namespace?: string; type?: string; created?: string } = {}) {
  const created = extra.created ?? "2026-09-01T00:00:00.000Z";
  sqlite.prepare(`INSERT INTO memories (id, namespace, type, content, importance, confidence, status, pinned, tags, source,
    source_message_ids, vector_id, created_at, updated_at, fact_key, version_status)
    VALUES (?, ?, ?, ?, 0.6, 0.8, 'active', 0, '["咖啡"]', 'dream', '[]', ?, ?, ?, ?, 'current')`)
    .run(id, extra.namespace ?? "default", extra.type ?? "preference", content, `mem_${id}`, created, created, factKey);
  sqlite.prepare("INSERT INTO memory_lifecycle (memory_id, namespace, fact_key, seen_count) VALUES (?, ?, ?, 0)")
    .run(id, extra.namespace ?? "default", factKey);
}
const row = (table: string, id: string, key = "id") => sqlite.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`).get(id) as any;
const all = (sql: string, ...args: any[]) => sqlite.prepare(sql).all(...args) as any[];

async function call(path: string, init: { method?: string; body?: unknown; key?: string } = {}) {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const response = await worker.fetch(new Request(`https://aelios.test${path}`, { method,
    headers: { authorization: `Bearer ${init.key ?? "owner-key"}`, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }), env, { waitUntil() {} } as any);
  const text = await response.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* md / jsonl */ }
  return { status: response.status, headers: response.headers, body };
}
async function mcp(name: string, args: any) {
  const { body } = await call("/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
  return body.result;
}

test("archive import stays out of memory and preserves conversations across chunks", async () => {
  const parsed = parseChatExport(JSON.stringify([
    { messages: [{ role: "user", content: "先说一句。", time: "2020-01-01T10:00:00Z" },
      { role: "assistant", content: "我想找柚子红茶。", time: "2020-01-02T10:00:00Z" }] },
    { messages: [{ role: "user", content: "另一段会话。", time: "2020-01-02T09:00:00Z" }] }
  ]));
  const chunks = chatChunkByDay(parsed.messages, { timeZone: "UTC", keepConversations: true });
  const start = { mode: "archive", fingerprint: "archive-stream", total_chunks: chunks.length, total_messages: 3 };
  const opened = await call("/v1/import/batches", { body: start });
  assert.equal(opened.status, 201);
  const batch = opened.body.data.batch;
  assert.equal(batch.kind, "archive");
  assert.equal(batch.model, null);
  const extractBatch = await call("/v1/import/batches", { body: { ...start, mode: "memory" } });
  assert.notEqual(extractBatch.body.data.batch.id, batch.id);
  for (const chunk of chunks) {
    const body = { import_id: batch.id, chunk };
    const written = await call("/v1/import/chat/chunk", { body });
    assert.equal(written.status, 200);
    assert.equal(written.body.data.result.status, "done");
    assert.equal((await call("/v1/import/chat/chunk", { body })).body.data.result.status, "skipped");
  }
  const resumed = await call("/v1/import/batches", { body: start });
  assert.equal(resumed.body.data.batch.done_chunks, chunks.length);
  assert.deepEqual(resumed.body.data.done_keys.sort(), chunks.map((chunk) => chunk.key).sort());
  assert.deepEqual([extractPrompts.length, clefCalls], [0, 0]);
  for (const table of ["messages", "imported_messages", "memory_candidates", "message_fts"]) {
    assert.deepEqual(all(`SELECT * FROM ${table}`), []);
  }
  assert.equal(all("SELECT * FROM chat_archive").length, 3);
  const hits = (await mcp("search_chat", { query: "柚子" })).structuredContent.data.hits;
  assert.deepEqual(hits.map((hit: any) => hit.text), ["我想找柚子红茶。"]);
  const around = (await mcp("search_chat", { around: hits[0].id })).structuredContent.data.lines;
  assert.deepEqual(around.map((line: any) => line.text), ["先说一句。", "我想找柚子红茶。"]);
  assert.equal(around[1].hit, true);
  assert.deepEqual((await mcp("search_chat", { query: "柚子", namespace: "other" })).structuredContent.data.hits, []);
  assert.equal((await mcp("search_chat", { around: hits[0].id, namespace: "other" })).isError, true);
  assert.equal((await call(`/v1/raw/${hits[0].id}`, { method: "DELETE" })).status, 200);
  assert.deepEqual((await mcp("search_chat", { query: "柚子" })).structuredContent.data.hits, []);
});

test("rewriting a memory in place keeps the old text as a revision", async () => {
  memory("m-coffee", "咲咲喝冰美式。", "preference:coffee");

  // Same fact_key written again with new text: the old text is kept.
  const imported = await call("/v1/import/entries?namespace=default", { body: {
    fingerprint: "fp-1", mode: "direct", entries: [{ content: "咲咲改喝热拿铁了。", type: "preference", factKey: "preference:coffee", tags: [] }]
  } });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.data.counts.updated, 1);
  assert.equal(row("memories", "m-coffee").content, "咲咲改喝热拿铁了。");

  const revisions = await call("/v1/memories/m-coffee/revisions?namespace=default");
  assert.equal(revisions.status, 200);
  assert.deepEqual(revisions.body.data.map((r: any) => [r.content, r.reason, r.fact_key, r.replaced_by]),
    [["咲咲喝冰美式。", "fact_key_upsert", "preference:coffee", "import"]]);
  assert.equal(revisions.body.data[0].written_at, "2026-09-01T00:00:00.000Z");

  // Writing the same text again is "unchanged" and stores nothing.
  const again = await call("/v1/import/entries?namespace=default", { body: {
    fingerprint: "fp-1", mode: "direct", entries: [{ content: "咲咲改喝热拿铁了。", factKey: "preference:coffee" }]
  } });
  assert.equal(again.body.data.counts.unchanged, 1);
  assert.equal(all("SELECT * FROM memory_revisions").length, 1);

  // An edit from the admin page keeps a revision too, and restoring is just another edit.
  const patched = await call("/v1/memory/m-coffee?namespace=default", { method: "PATCH", body: { content: "咲咲喝燕麦拿铁。" } });
  assert.equal(patched.status, 200);
  const after = await call("/v1/memories/m-coffee/revisions?namespace=default");
  assert.deepEqual(after.body.data.map((r: any) => r.content), ["咲咲改喝热拿铁了。", "咲咲喝冰美式。"]);
  assert.equal(after.body.data[0].reason, "edit");

  // Deleting the memory for good takes its old versions with it.
  const { deleteMemoryV2 } = await import("../src/db/v2");
  assert.equal(await deleteMemoryV2(env, { namespace: "default", id: "m-coffee" }), true);
  assert.equal(all("SELECT * FROM memory_revisions").length, 0);
});

test("export to md and jsonl, then import the file back unchanged", async () => {
  memory("m1", "咲咲喝咖啡要跟饭隔一个小时。", "preference:coffee-gap", { created: "2025-12-15T08:00:00.000Z" });
  memory("m2", "咲咲第一次叫旦九老公，用的是「老公 #1」这个说法。", "relationship:first-laogong", { type: "relationship", created: "2025-12-16T08:00:00.000Z" });
  memory("other", "望舒空间里的事。", "fact:other", { namespace: "wangshu" });
  sqlite.prepare(`INSERT INTO precious (id, namespace, content, context_message_ids, source, pinned, created_at)
    VALUES ('p1', 'default', '我们一起看了那场雪。', '[]', 'human', 1, '2025-12-20T10:00:00.000Z')`).run();

  // The everyday chatbox key can export md / jsonl (memory:read is enough).
  const md = await call("/v1/memories/export?format=md&namespace=default");
  assert.equal(md.status, 200);
  assert.match(md.headers.get("content-type") ?? "", /text\/markdown/);
  assert.match(md.headers.get("content-disposition") ?? "", /aelios-default-\d{4}-\d{2}-\d{2}\.md/);
  assert.equal(md.headers.get("x-aelios-memories"), "2");
  assert.equal(md.headers.get("x-aelios-precious"), "1");
  assert.match(md.body, /# Aelios 记忆：旦九（default）/);
  assert.match(md.body, /- 2025-12-15 咲咲喝咖啡要跟饭隔一个小时。 #咖啡 `preference:coffee-gap`/);
  assert.match(md.body, /老公 \\#1/); // a "#" inside the text is escaped so it is not read as a tag
  assert.match(md.body, /## 珍贵 precious\n\n- 2025-12-20 我们一起看了那场雪。/);
  assert.doesNotMatch(md.body, /望舒空间/);

  const parsed = parseMemoryImport(md.body);
  assert.equal(parsed.format, "markdown");
  assert.deepEqual(parsed.entries.map((e) => [e.kind, e.type, e.date, e.content, e.factKey, e.tags]), [
    ["memory", "preference", "2025-12-15", "咲咲喝咖啡要跟饭隔一个小时。", "preference:coffee-gap", ["咖啡"]],
    ["memory", "relationship", "2025-12-16", "咲咲第一次叫旦九老公，用的是「老公 #1」这个说法。", "relationship:first-laogong", ["咖啡"]],
    ["precious", null, "2025-12-20", "我们一起看了那场雪。", null, []]
  ]);

  // Importing the export back changes nothing.
  const result = await call("/v1/import/entries?namespace=default", { body: { fingerprint: "md-back", mode: "direct", entries: parsed.entries } });
  assert.deepEqual(result.body.data.counts, { created: 0, updated: 0, unchanged: 2, duplicate: 1, queued: 0, precious: 0, failed: 0 });

  // jsonl keeps every field and reads back the same way.
  const jsonl = await call("/v1/memories/export?format=jsonl&namespace=wangshu");
  assert.equal(jsonl.status, 200);
  const lines = String(jsonl.body).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].kind, "aelios_export");
  assert.equal(lines[0].namespace, "wangshu");
  assert.deepEqual(lines.slice(1).map((l: any) => l.content), ["望舒空间里的事。"]);
  const back = parseMemoryImport(String(jsonl.body));
  assert.equal(back.format, "aelios-jsonl");
  assert.deepEqual(back.entries.map((e) => [e.content, e.factKey]), [["望舒空间里的事。", "fact:other"]]);

  // A key that cannot choose spaces only ever exports its own.
  const im = await call("/v1/memories/export?format=md&namespace=wangshu", { key: "im-key" });
  assert.doesNotMatch(im.body, /望舒空间/);
});

test("md export keeps text that starts like a date, a [type] or a dash", () => {
  const contents = ["2025年3月2日 去了医院复查。", "[偏好] 是她自己写的前缀。", "——那天下雨。", "：冒号开头。", "#开头的话", "\\反斜杠开头"];
  const md = formatMemoriesMarkdown({ namespace: "default", exportedAt: "2026-10-11T00:00:00.000Z", timeZone: "Asia/Shanghai",
    memories: contents.map((content, index) => ({ id: `m${index}`, type: "event", content, tags: [], fact_key: null,
      created_at: `2025-03-0${index + 1}T00:00:00.000Z`, updated_at: "2025-03-09T00:00:00.000Z" })) as any,
    precious: [] });
  const back = parseMemoryImport(md).entries;
  assert.deepEqual(back.map((e) => [e.type, e.content]), contents.map((content) => ["event", content]));
});

test("importing tidied entries: dated, deduplicated, precious, and similar ones go to review", async () => {
  memory("m-exists", "咲咲住在武汉。", "fact:city");
  const text = [
    "# 从旧 AI 搬来的",
    "",
    "咲咲不吃香菜，",
    "  连香菜味的薯片都不行。",
    "",
    "## 偏好",
    "- 2025-03-12 [偏好] 咲咲喝咖啡不加糖。 #咖啡",
    "- 咲咲住在武汉。",
    "- [关系] 咲咲叫旦九「先生」。",
    "",
    "## 珍贵",
    "- 2025-05-01 那天一起看了海。"
  ].join("\n");
  const preview = await call("/v1/import/entries/preview?namespace=default", { body: { text } });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.total, 5);
  const entries = preview.body.data.entries;
  assert.deepEqual(entries.map((e: any) => [e.kind, e.type, e.date]), [
    ["memory", null, null],
    ["memory", "preference", "2025-03-12"],
    ["memory", "preference", null],
    ["memory", "relationship", null],
    ["precious", null, "2025-05-01"]
  ]);
  assert.equal(entries[0].content, "咲咲不吃香菜，\n连香菜味的薯片都不行。");

  similar = { id: "m-exists", content: "咲咲住在武汉。", score: 0.97 };
  // Only the third entry (no key, not identical) looks similar here; make the vector stub answer once.
  const realQuery = env.VECTORIZE.query;
  let queries = 0;
  env.VECTORIZE.query = async (...args: any[]) => {
    queries += 1;
    // two queries per search (namespaced + legacy). Searches run for entries 1, 2 and 4 (entry 3 is an exact
    // duplicate and skips the search); only entry 4 gets a hit.
    if (queries === 5 || queries === 6) return realQuery(...args);
    return { matches: [] };
  };

  const result = await call("/v1/import/entries?namespace=default", { body: {
    fingerprint: "entries-1", mode: "direct", name: "旧 AI 清单", start_index: 0, total: entries.length, entries
  } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.counts, { created: 2, updated: 0, unchanged: 0, duplicate: 1, queued: 1, precious: 1, failed: 0 });

  const created = all("SELECT m.*, lc.fact_key AS lc_key FROM memories m JOIN memory_lifecycle lc ON lc.memory_id = m.id WHERE m.source = 'import' ORDER BY m.created_at");
  assert.equal(created.length, 2);
  const coffee = created.find((m) => m.content === "咲咲喝咖啡不加糖。");
  assert.equal(coffee.created_at, "2025-03-12T12:00:00.000Z"); // the original date
  assert.ok(coffee.updated_at > "2026-01-01"); // expiry counts from updated_at, so it does not expire on arrival
  assert.match(coffee.fact_key, /^import:preference:[0-9a-f]{12}$/);
  assert.deepEqual(JSON.parse(coffee.tags), ["咖啡"]);
  // Generated keys are not shown to the extractor.
  assert.deepEqual(await listActiveFactKeys(env.DB, { namespace: "default" }), ["fact:city"]);

  const precious = all("SELECT * FROM precious WHERE source = 'import'");
  assert.deepEqual(precious.map((p) => [p.content, p.created_at]), [["那天一起看了海。", "2025-05-01T12:00:00.000Z"]]);

  // The similar one waits on the review page, pointing at the memory it would replace.
  const review = await call("/v1/import/candidates?namespace=default");
  assert.equal(review.body.counts.pending, 1);
  const queued = review.body.data[0];
  assert.deepEqual([queued.source, queued.content, queued.target_memory_id, queued.existing_content],
    ["import_entries", "咲咲叫旦九「先生」。", "m-exists", "咲咲住在武汉。"]);

  // Importing the same list again adds nothing new.
  env.VECTORIZE.query = async () => ({ matches: [] });
  const again = await call("/v1/import/entries?namespace=default", { body: { fingerprint: "entries-1", mode: "direct", entries } });
  assert.deepEqual(again.body.data.counts, { created: 0, updated: 0, unchanged: 0, duplicate: 4, queued: 1, precious: 0, failed: 0 });
  assert.equal((await call("/v1/import/candidates?namespace=default")).body.counts.pending, 1); // still waiting, not written
  assert.equal(all("SELECT * FROM memories WHERE source = 'import'").length, 2);

  const batches = await call("/v1/import/batches?namespace=default");
  assert.equal(batches.body.data.length, 1);
  assert.deepEqual([batches.body.data[0].kind, batches.body.data[0].name, batches.body.data[0].pending], ["entries", "旧 AI 清单", 1]);
});

test("review mode sends every entry to the review page; approving keeps the entry's date", async () => {
  const entries = [
    { content: "咲咲周四中午前交周报。", type: "habit", date: "2026-02-03", tags: ["工作"] },
    { content: "咲咲喜欢杨枝甘露。", type: "preference" }
  ];
  const result = await call("/v1/import/entries?namespace=default", { body: { fingerprint: "rv", mode: "review", entries } });
  assert.equal(result.body.data.counts.queued, 2);
  assert.equal(all("SELECT * FROM memories").length, 0);

  // They stay out of the daily queue, the badge count, the nightly judge and the assistant's own review.
  const daily = await call("/v1/candidates?namespace=default&scope=daily");
  assert.equal(daily.body.data.length, 0);
  const boot = await call(`/v1/memory_boot?namespace=default&start=${encodeURIComponent(now())}&end=${encodeURIComponent(now())}`);
  assert.equal(boot.body.data.stats.pending_candidates, 0);
  assert.equal(boot.body.data.stats.pending_import_candidates, 2);
  await runCandidateJudge(env, "default");
  assert.equal(all("SELECT * FROM memory_candidates WHERE status = 'pending'").length, 2);
  assert.equal(clefCalls, 0);
  const listed = await mcp("memory_candidates", { namespace: "default" });
  assert.equal(listed.structuredContent.pending, 0);
  const candidateId = all("SELECT id FROM memory_candidates WHERE content = '咲咲周四中午前交周报。'")[0].id;
  assert.equal((await mcp("memory_review", { id: candidateId, decision: "approve" })).isError, true);

  const approved = await call(`/v1/candidates/${candidateId}/approve?namespace=default`, { body: {} });
  assert.equal(approved.status, 200);
  const created = row("memories", approved.body.data.memory_id);
  assert.equal(created.content, "咲咲周四中午前交周报。");
  assert.equal(created.created_at, "2026-02-03T12:00:00.000Z");
  assert.ok(created.updated_at > "2026-02-04");
});

test("two different entries that both look like one memory stay two cards; approving one keeps its day", async () => {
  memory("m-coffee", "咲咲喝冰美式。", "preference:coffee");
  similar = { id: "m-coffee", content: "咲咲喝冰美式。", score: 0.97 };
  const entries = [
    { content: "咲咲改喝热拿铁了。", type: "preference", date: "2025-11-02" },
    { content: "咲咲偶尔也喝冷萃。", type: "preference", date: "2025-11-05" }
  ];
  const result = await call("/v1/import/entries?namespace=default", { body: { fingerprint: "two", mode: "direct", entries } });
  assert.equal(result.body.data.counts.queued, 2);
  const pending = all("SELECT * FROM memory_candidates WHERE status = 'pending' ORDER BY content");
  assert.deepEqual(pending.map((c) => [c.content, c.target_memory_id]), [
    ["咲咲偶尔也喝冷萃。", "m-coffee"],
    ["咲咲改喝热拿铁了。", "m-coffee"]
  ]);

  const latte = pending.find((c) => c.content === "咲咲改喝热拿铁了。");
  const approved = await call(`/v1/candidates/${latte.id}/approve?namespace=default`, { body: {} });
  assert.equal(approved.body.data.action, "superseded");
  const created = row("memories", approved.body.data.memory_id);
  assert.equal(created.content, "咲咲改喝热拿铁了。");
  assert.equal(created.created_at, "2025-11-02T12:00:00.000Z");
  assert.ok(created.updated_at > "2026-01-01");
  assert.equal(row("memories", "m-coffee").version_status, "superseded");
});

function chunkOf(day: string, lines: Array<[string, string, number]>) {
  return { key: `${day}#1`, day, messages: lines.map(([role, content, seq]) => ({ seq, role, content, time: `${day}T10:0${seq % 10}:00.000Z`, speaker: null })) };
}

test("importing a chat history: by day, through review, quotes kept outside the 7-day messages table", async () => {
  memory("m-coffee", "咲咲喝冰美式。", "preference:coffee");
  // Two tabs starting the same file at once end up on one batch.
  const startBody = { fingerprint: "chat-1", name: "conversations.json", total_chunks: 2, total_messages: 5, total_chars: 100, first_date: "2025-03-01", last_date: "2025-03-02" };
  const [start, twin] = await Promise.all([
    call("/v1/import/batches?namespace=default", { body: startBody }),
    call("/v1/import/batches?namespace=default", { body: startBody })
  ]);
  assert.deepEqual([start.status, twin.status].sort(), [200, 201]);
  assert.equal(twin.body.data.batch.id, start.body.data.batch.id);
  assert.equal(all("SELECT * FROM memory_imports").length, 1);
  const batch = start.body.data.batch;
  assert.deepEqual(start.body.data.done_keys, []);

  const day1 = chunkOf("2025-03-01", [["user", "我最近改喝热拿铁了", 0], ["assistant", "记下啦", 1], ["user", "晚安", 2]]);
  // The model cites the first message, plus an id that is not in this chunk (dropped).
  extractReplies.push({ memories: [
    { content: "咲咲改喝热拿铁了。", type: "preference", fact_key: "preference:coffee", importance: 0.7, confidence: 0.9, tags: ["咖啡"], source_message_ids: ["placeholder", "msg_elsewhere"] },
    { content: "咲咲睡前会说晚安。", type: "habit", fact_key: "habit:goodnight", tags: [], source_message_ids: [] }
  ] });
  clefAnswers.push({ grounded: 0.92, worth: 0.81 }, { grounded: 0.9, worth: 0.2 });
  // The model sees real ids; patch the placeholder after we know them.
  const firstIds = await Promise.all(day1.messages.map(async (m) => {
    const { importedMessageId } = await import("../src/memory/transfer/importChat");
    return importedMessageId(batch.id, day1.key, m.seq);
  }));
  extractReplies[0].memories[0].source_message_ids[0] = firstIds[0];
  extractReplies[0].memories[1].source_message_ids = firstIds.slice(1);

  const r1 = await call("/v1/import/chat/chunk?namespace=default", { body: { import_id: batch.id, chunk: day1, clef: true } });
  assert.equal(r1.status, 200);
  assert.deepEqual([r1.body.data.result.status, r1.body.data.result.candidates, r1.body.data.result.tokens_in, r1.body.data.result.tokens_out, r1.body.data.result.clef_calls],
    ["done", 2, 1200, 150, 2]);
  assert.equal(r1.body.data.batch.done_chunks, 1);
  assert.equal(r1.body.data.batch.tokens_in, 1200);
  // The extraction prompt carries the chat with its date and the speakers' names, without diary background.
  assert.match(extractPrompts[0], /2025-03-01T10:00:00.000Z\]\[咲咲\] 我最近改喝热拿铁了/);
  assert.doesNotMatch(extractPrompts[0], /前几天的日记/);

  // Nothing went into the messages table; only the cited quotes are kept.
  assert.equal(all("SELECT * FROM messages").length, 0);
  const kept = all("SELECT id, content, day FROM imported_messages ORDER BY seq");
  assert.deepEqual(kept.map((m) => m.content), ["我最近改喝热拿铁了", "记下啦", "晚安"]); // only the two candidates’ cited rows are retained

  const listed = await call(`/v1/import/candidates?namespace=default&import_id=${batch.id}`);
  assert.deepEqual(listed.body.counts, { pending: 2, clef_yes: 1, clef_no: 1 });
  const coffee = listed.body.data.find((c: any) => c.fact_key === "preference:coffee");
  assert.deepEqual([coffee.source, coffee.day, coffee.clef_grounded, coffee.clef_worth, coffee.existing_content],
    ["import_chat", "2025-03-01", 0.92, 0.81, "咲咲喝冰美式。"]);
  assert.deepEqual(coffee.source_message_ids, [firstIds[0]]);
  const clefOnly = await call("/v1/import/candidates?namespace=default&filter=clef_yes");
  assert.deepEqual(clefOnly.body.data.map((c: any) => c.content), ["咲咲改喝热拿铁了。"]);

  // The quote can be looked up from the review page and anywhere else that reads sources.
  const sources = await call(`/v1/candidates/${coffee.id}/sources?namespace=default`);
  assert.deepEqual(sources.body.data.messages.map((m: any) => [m.role, m.content]), [["user", "我最近改喝热拿铁了"]]);
  const viaLookup = await getMessagesByIds(env.DB, { namespace: "default", ids: [firstIds[0]] });
  assert.equal(viaLookup[0].content, "我最近改喝热拿铁了");

  // Sending the same chunk again (resuming) does no work.
  const again = await call("/v1/import/chat/chunk?namespace=default", { body: { import_id: batch.id, chunk: day1 } });
  assert.equal(again.body.data.result.status, "skipped");
  assert.equal(extractPrompts.length, 1);

  // The next day mentions the same fact: it folds into the pending candidate instead of adding a second one.
  const day2 = chunkOf("2025-03-02", [["user", "热拿铁要燕麦奶的", 3], ["assistant", "好", 4]]);
  const secondIds = await Promise.all(day2.messages.map(async (m) => {
    const { importedMessageId } = await import("../src/memory/transfer/importChat");
    return importedMessageId(batch.id, day2.key, m.seq);
  }));
  extractReplies.push({ memories: [
    { content: "咲咲喝燕麦奶热拿铁。", type: "preference", fact_key: "preference:coffee", tags: ["燕麦奶"], source_message_ids: [secondIds[0]] }
  ] });
  const r2 = await call("/v1/import/chat/chunk?namespace=default", { body: { import_id: batch.id, chunk: day2, clef: false } });
  assert.deepEqual([r2.body.data.result.candidates, r2.body.data.result.merged], [0, 1]);
  assert.match(extractPrompts[1], /preference:coffee/); // pending keys from earlier days are offered for reuse
  const merged = row("memory_candidates", coffee.id);
  assert.equal(merged.content, "咲咲喝燕麦奶热拿铁。");
  assert.deepEqual(JSON.parse(merged.source_message_ids), [firstIds[0], secondIds[0]]);
  assert.deepEqual(JSON.parse(merged.tags), ["咖啡", "燕麦奶"]);

  const resumed = await call("/v1/import/batches?namespace=default", { body: { fingerprint: "chat-1", total_chunks: 2 } });
  assert.deepEqual(resumed.body.data.done_keys.sort(), ["2025-03-01#1", "2025-03-02#1"]);
  assert.equal(resumed.body.data.batch.tokens_in, 2400);

  // The nightly judge leaves imports alone; approving replaces the old memory and keeps the quotes.
  await runCandidateJudge(env, "default");
  assert.equal(row("memory_candidates", coffee.id).status, "pending");
  const approved = await call(`/v1/candidates/${coffee.id}/approve?namespace=default`, { body: {} });
  assert.equal(approved.status, 200);
  const newMemory = row("memories", approved.body.data.memory_id);
  assert.equal(newMemory.content, "咲咲喝燕麦奶热拿铁。");
  assert.deepEqual(JSON.parse(newMemory.source_message_ids), [firstIds[0], secondIds[0]]);

  // Other spaces see none of it.
  const wangshu = await call("/v1/import/candidates?namespace=wangshu");
  assert.equal(wangshu.body.counts.pending, 0);
  assert.equal((await call("/v1/import/chat/chunk?namespace=wangshu", { body: { import_id: batch.id, chunk: day2 } })).status, 404);
});

test("a broken model reply splits the chunk once; a failed chunk is recorded and can be retried", async () => {
  const start = await call("/v1/import/batches?namespace=default", { body: { fingerprint: "chat-2", total_chunks: 1 } });
  const batch = start.body.data.batch;
  const day = chunkOf("2025-04-01", [["user", "一", 0], ["assistant", "二", 1], ["user", "三", 2], ["assistant", "四", 3]]);
  extractReplies.push('{"memories": [{"content": "咲咲', { memories: [{ content: "咲咲数到了二。", type: "fact", source_message_ids: [await (await import("../src/memory/transfer/importChat")).importedMessageId(batch.id, day.key, 0)] }] }, { memories: [] });
  const result = await call("/v1/import/chat/chunk?namespace=default", { body: { import_id: batch.id, chunk: day, clef: false } });
  assert.deepEqual([result.body.data.result.status, result.body.data.result.model_calls, result.body.data.result.candidates], ["done", 3, 1]);

  const start2 = await call("/v1/import/batches?namespace=default", { body: { fingerprint: "chat-3", total_chunks: 1 } });
  env.AI.run = async (model: string) => {
    if (model.includes("gpt-oss")) throw new Error("upstream down");
    return { data: [[0.1, 0.2, 0.3]] };
  };
  const failed = await call("/v1/import/chat/chunk?namespace=default", { body: { import_id: start2.body.data.batch.id, chunk: day } });
  assert.equal(failed.body.data.result.status, "error");
  assert.equal(row("memory_import_chunks", start2.body.data.batch.id, "import_id").status, "error");
  const resumed = await call("/v1/import/batches?namespace=default", { body: { fingerprint: "chat-3" } });
  assert.deepEqual(resumed.body.data.done_keys, []);

  // Bad input is refused before anything runs.
  const bad = await call("/v1/import/chat/chunk?namespace=default", { body: { import_id: batch.id, chunk: { key: "x", messages: [{ seq: 0, role: "system", content: "hi" }] } } });
  assert.equal(bad.status, 400);
  const tooMany = await call("/v1/import/entries?namespace=default", { body: { fingerprint: "x", entries: Array.from({ length: 26 }, (_, i) => ({ content: `第${i}条` })) } });
  assert.equal(tooMany.status, 400);
});

const chatgptExport = JSON.stringify([{
  title: "咖啡", create_time: 1741000000, current_node: "d",
  mapping: {
    root: { id: "root", message: null, parent: null, children: ["sys"] },
    sys: { id: "sys", parent: "root", children: ["a"], message: { author: { role: "system" }, content: { content_type: "text", parts: [""] }, metadata: { is_visually_hidden_from_conversation: true } } },
    a: { id: "a", parent: "sys", children: ["b-old", "b"], message: { author: { role: "user" }, create_time: 1741000000, content: { content_type: "text", parts: ["我喜欢冰美式"] }, recipient: "all" } },
    "b-old": { id: "b-old", parent: "a", children: [], message: { author: { role: "assistant" }, create_time: 1741000050, content: { content_type: "text", parts: ["被重新生成掉的回答"] }, recipient: "all" } },
    b: { id: "b", parent: "a", children: ["t"], message: { author: { role: "assistant" }, create_time: 1741000100, content: { content_type: "text", parts: ["记住了"] }, recipient: "all" } },
    t: { id: "t", parent: "b", children: ["d"], message: { author: { role: "tool" }, create_time: 1741000150, content: { content_type: "text", parts: ["tool output"] }, recipient: "all" } },
    d: { id: "d", parent: "t", children: [], message: { author: { role: "user" }, create_time: 1741090000, content: { content_type: "text", parts: ["第二天了"] }, recipient: "all" } }
  }
}]);

test("chat exports from different apps become the same messages, cut by day", () => {
  const gpt = parseChatExport(chatgptExport, "conversations.json");
  assert.equal(gpt.format, "chatgpt");
  assert.deepEqual(gpt.messages.map((m) => [m.role, m.content]), [["user", "我喜欢冰美式"], ["assistant", "记住了"], ["user", "第二天了"]]);
  assert.deepEqual(chatChunkByDay(gpt.messages, { timeZone: "Asia/Shanghai" }).map((c) => [c.key, c.messages.map((m) => m.seq)]),
    [["2025-03-03#1", [0, 1]], ["2025-03-04#1", [2]]]);

  const claude = parseChatExport(JSON.stringify([{ uuid: "u", name: "n", chat_messages: [
    { sender: "human", created_at: "2026-10-01T10:00:00Z", content: [{ type: "text", text: "你好" }, { type: "image" }] },
    { sender: "assistant", created_at: "2026-10-01T10:00:05Z", text: "在呢" }
  ] }]), "conversations.json");
  assert.deepEqual([claude.format, claude.messages.map((m) => [m.role, m.content])], ["claude", [["user", "你好"], ["assistant", "在呢"]]]);

  const tavern = parseChatExport([
    JSON.stringify({ user_name: "咲咲", character_name: "旦九" }),
    JSON.stringify({ name: "咲咲", is_user: true, send_date: "March 3, 2025 9:15pm", mes: "今天好累" }),
    JSON.stringify({ name: "旦九", is_user: false, send_date: "2025-03-03@21h16m00s", mes: "抱抱" })
  ].join("\n"), "chat.jsonl");
  assert.equal(tavern.format, "sillytavern");
  assert.deepEqual(tavern.messages.map((m) => [m.role, m.speaker, m.content]), [["user", "咲咲", "今天好累"], ["assistant", "旦九", "抱抱"]]);

  const text = parseChatExport([
    "## 2025-03-01",
    "咲咲：今天考了模拟卷",
    "旦九：考了多少分",
    "咲咲：72",
    "还差一点",
    "旦九：下次就过了",
    "2025年3月2日 星期日",
    "咲咲：今天休息"
  ].join("\n"), "chat.txt");
  assert.equal(text.format, "text");
  assert.deepEqual(text.speakers.map((s) => [s.name, s.count, s.role]), [["咲咲", 3, null], ["旦九", 2, null]]);
  const roles = chatApplyRoles(text.messages, ["咲咲"]);
  assert.deepEqual(roles.map((m) => [m.role, m.date, m.content]), [
    ["user", "2025-03-01", "今天考了模拟卷"],
    ["assistant", "2025-03-01", "考了多少分"],
    ["user", "2025-03-01", "72\n还差一点"],
    ["assistant", "2025-03-01", "下次就过了"],
    ["user", "2025-03-02", "今天休息"]
  ]);
  const chunks = chatChunkByDay(roles, { timeZone: "Asia/Shanghai", maxMessages: 3 });
  assert.deepEqual(chunks.map((c) => [c.key, c.messages.length]), [["2025-03-01#1", 3], ["2025-03-01#2", 1], ["2025-03-02#1", 1]]);

  // A short paste where one side speaks only once still has two speakers.
  for (const sample of ["Bob：hi\nAlice：hello\nAlice：again", "Alice：hello\nBob：hi\nAlice：again"]) {
    const short = parseChatExport(sample, "short.txt");
    assert.equal(short.messages.length, 3);
    assert.deepEqual(short.messages.map((m) => m.content).sort(), ["again", "hello", "hi"]);
  }
  // In a longer chat a once-only "名字：" line stays inside the message it belongs to.
  const longer = parseChatExport("咲咲：地址是\n地址：武汉\n旦九：记下了\n咲咲：好\n旦九：嗯", "long.txt");
  assert.deepEqual(longer.messages.map((m) => m.content), ["地址是\n地址：武汉", "记下了", "好", "嗯"]);
});

test("the admin page's copy of the parser runs on its own in a browser-like sandbox", () => {
  const script = chatParseBrowserScript();
  assert.doesNotMatch(script, /<\/script/i);
  const sandbox: any = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  const chat = sandbox.window.AeliosChat;
  const parsed = chat.parseChatExport(chatgptExport, "conversations.json");
  assert.equal(parsed.format, "chatgpt");
  // The sandbox has its own Array, so compare as JSON.
  assert.equal(JSON.stringify(chat.chatChunkByDay(parsed.messages, { timeZone: "Asia/Shanghai" }).map((c: any) => c.key)), JSON.stringify(["2025-03-03#1", "2025-03-04#1"]));
  const text = chat.parseChatExport("咲咲：一\n旦九：二\n咲咲：三\n旦九：四", "a.txt");
  assert.equal(JSON.stringify(chat.chatApplyRoles(text.messages, ["咲咲"]).map((m: any) => m.role)), JSON.stringify(["user", "assistant", "user", "assistant"]));
});
