import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import { invalidateSettingsCache } from "../src/gateway/config";

// MCP tool list as the Claude app sees it: everyday tools named after the moment they are for,
// usage guidance both in initialize and in wake_up (the Claude app ignores instructions), old names still callable.
(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);
let sqlite: DatabaseSync;
let env: any;

const CORE = ["wake_up", "recall", "remember", "keep_moment", "forget", "learn_word", "read_diary", "search_chat", "log_conversation", "list_memories", "handoff", "notebook"];

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
      async run() { const r = statement.run(...args); return { meta: { changes: r.changes } }; }
    }; return api;
  }, async batch(statements: any[]) {
    const results = []; for (const statement of statements) results.push(await statement.run()); return results;
  } };
  invalidateSettingsCache();
  env = { DB: db, CHATBOX_API_KEY: "owner-key",
    AI: { async run() { return { data: [[0.1, 0.2, 0.3]] }; } },
    VECTORIZE: { async upsert() { return {}; }, async deleteByIds() { return {}; }, async query() { return { matches: [] }; } } };
  globalThis.fetch = async (url: any) => { throw new Error(`unexpected upstream call: ${url}`); };
});

function memory(id: string, content: string, extra: { pinned?: number; importance?: number; factKey?: string } = {}) {
  const at = "2026-09-01T00:00:00.000Z";
  sqlite.prepare(`INSERT INTO memories (id, namespace, type, content, importance, confidence, status, pinned, tags, source,
    source_message_ids, vector_id, created_at, updated_at, fact_key, version_status)
    VALUES (?, 'default', 'fact', ?, ?, 0.8, 'active', ?, '[]', 'dream', '[]', ?, ?, ?, ?, 'current')`)
    .run(id, content, extra.importance ?? 0.6, extra.pinned ?? 0, `mem_${id}`, at, at, extra.factKey ?? null);
  sqlite.prepare("INSERT INTO memory_lifecycle (memory_id, namespace, fact_key, seen_count) VALUES (?, 'default', ?, 0)")
    .run(id, extra.factKey ?? null);
}
const row = (table: string, id: string) => sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as any;

async function rpc(method: string, params: any = {}, query = "") {
  const response = await worker.fetch(new Request(`https://aelios.test/mcp${query}`, { method: "POST",
    headers: { authorization: "Bearer owner-key", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env, { waitUntil() {} } as any);
  return (await response.json() as any).result;
}
const call = async (name: string, args: any = {}) => rpc("tools/call", { name, arguments: args });
const listNames = async (query = "") => (await rpc("tools/list", {}, query)).tools.map((tool: any) => tool.name);

test("initialize carries the usage guidance for clients that read instructions", async () => {
  const result = await rpc("initialize");
  assert.match(result.instructions, /wake_up/);
  assert.match(result.instructions, /recall/);
  assert.match(result.instructions, /log_conversation/);
  assert.match(result.instructions, /notebook/);
});

test("the default list is the everyday tools; review shows only with clef off, maintenance only with tools=all", async () => {
  assert.deepEqual(await listNames(), CORE);
  env.CLEF_AUTO_REVIEW = "off";
  assert.deepEqual(await listNames(), [...CORE, "memory_candidates", "memory_review"]);
  delete env.CLEF_AUTO_REVIEW;
  assert.deepEqual(await listNames("?tools=all"), [...CORE, "memory_candidates", "memory_review", "memory_get", "memory_export"]);

  const tools = (await rpc("tools/list")).tools;
  for (const name of ["wake_up", "recall", "read_diary", "search_chat", "list_memories"]) {
    assert.equal(tools.find((tool: any) => tool.name === name).annotations.readOnlyHint, true, name);
  }
  // The first sentence says when to call, which is all an on-demand tool catalog shows.
  assert.match(tools.find((tool: any) => tool.name === "wake_up").description, /^Call this first in every new conversation/);
});

test("wake_up hands over the guidance and the core memories, pinned first", async () => {
  memory("m-low", "她喜欢晴天。", { importance: 0.3 });
  memory("m-pin", "她叫咲咲，住在武汉。", { pinned: 1, importance: 0.5 });
  memory("m-high", "她的女儿叫可可。", { importance: 0.9 });
  sqlite.prepare("INSERT INTO precious (id, namespace, content, created_at) VALUES ('p1', 'default', '第一次叫我旦九。', '2026-09-02T00:00:00.000Z')").run();

  const { data } = (await call("wake_up")).structuredContent;
  assert.match(data.how_to_use, /wake_up/);
  assert.deepEqual(data.core.map((m: any) => m.id), ["m-pin", "m-high", "m-low"]);
  assert.equal(data.precious[0].content, "第一次叫我旦九。");
  assert.ok("impressions" in data && "glossary" in data);
});

test("remember saves without a fact_key and replaces with history, never in place", async () => {
  const created = (await call("remember", { content: "她最近在备考中级经济师。" })).structuredContent.data;
  assert.equal(created.created, true);
  const saved = row("memories", created.id);
  assert.equal(saved.content, "她最近在备考中级经济师。");
  assert.match(saved.fact_key, /^remember:[0-9a-f]{32}$/);
  assert.equal(saved.source, "mcp");

  memory("m-city", "她住在香港。");
  const moved = (await call("remember", { content: "她 9 月 28 日搬进了武汉的新家。", replaces: "m-city", reason: "搬家了" })).structuredContent.data;
  assert.equal(moved.replaced, "m-city");
  assert.equal(row("memories", "m-city").version_status, "superseded");
  assert.equal(row("memories", moved.id).status, "active");

  memory("m-coffee", "她早上喝拿铁。", { factKey: "user:coffee" });
  const keyed = (await call("remember", { content: "她改喝美式了。", fact_key: "user:coffee" })).structuredContent.data;
  assert.equal(keyed.replaced, "m-coffee");
  assert.equal(row("memories", "m-coffee").content, "她早上喝拿铁。");
  assert.equal(row("memories", "m-coffee").version_status, "superseded");
  assert.equal(row("memories", keyed.id).fact_key, "user:coffee");
});

test("remember keeps world_fact as world knowledge; other free-form types still become one of the eight", async () => {
  const world = (await call("remember", { content: "抹茶是碾茶磨成的粉。", type: "world_fact", fact_key: "world:matcha" })).structuredContent.data;
  assert.equal(row("memories", world.id).type, "world_fact");
  // Looked up again under the same key: the new version replaces it and is still world knowledge.
  const again = (await call("remember", { content: "抹茶是用碾茶磨成的粉，产自日本。", fact_key: "world:matcha" })).structuredContent.data;
  assert.equal(again.replaced, world.id);
  assert.equal(row("memories", again.id).type, "world_fact");
  // The old upsert rewrites in place and always carries a type (fact by default); a world fact stays one.
  const upserted = (await call("memory_upsert", { fact_key: "world:matcha", content: "抹茶是碾茶磨成的粉。" })).structuredContent.data;
  assert.equal(upserted.id, again.id);
  assert.equal(row("memories", again.id).type, "world_fact");
  // A replacement that names a type of the eight takes it.
  const moved = (await call("remember", { content: "她喜欢抹茶。", replaces: again.id, type: "preference" })).structuredContent.data;
  assert.equal(row("memories", moved.id).type, "preference");
  const free = (await call("remember", { content: "一个项目。", type: "project" })).structuredContent.data;
  assert.equal(row("memories", free.id).type, "fact");
});

test("forget archives by default and erases only when asked", async () => {
  memory("m-a", "一条要收起来的。");
  memory("m-b", "一条要删掉的。");
  memory("m-context", "另一晚只读过旧记忆。");
  sqlite.prepare("UPDATE memories SET provenance=? WHERE id='m-context'").run(JSON.stringify({inputs:[],context_refs:["memory:m-a"]}));
  for (const target of ["m-a", "m-b"]) {
    sqlite.prepare(`INSERT INTO memory_candidates(id,namespace,type,content,source,status,target_memory_id,created_at,updated_at)
      VALUES(?,'default','note','待审','dream_update','pending',?,'now','now')`).run(`c-${target}`, target);
  }
  assert.equal((await call("forget", { id: "m-a" })).structuredContent.data.archived, true);
  assert.equal(row("memories", "m-a").status, "archived");
  assert.equal(row("memories", "m-context").status, "active");
  assert.equal(row("memory_candidates","c-m-a").status, "discarded");
  assert.equal(row("memory_candidates","c-m-b").status, "pending");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM memory_revocations").get()?.n, 0);
  assert.equal((await call("forget", { id: "m-b", permanent: true })).structuredContent.data.deleted, true);
  assert.equal(row("memories", "m-b"), undefined);
  assert.equal((await call("forget", { id: "nope" })).isError, true);
});

test("log_conversation opens its own conversation and skips lines it already has", async (t) => {
  // seq is turn-local: make these two separate requests occur at distinct, deterministic times.
  const startedAt = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: startedAt });
  const first = (await call("log_conversation", { messages: [
    { role: "user", content: "今天考了一套题。" },
    { role: "assistant", content: "考得怎么样？" }
  ] })).structuredContent.data;
  assert.match(first.conversation_id, /^conv_/);
  assert.equal(first.saved, 2);
  t.mock.timers.setTime(startedAt + 1000);

  const second = (await call("log_conversation", { conversation_id: first.conversation_id, messages: [
    { role: "user", content: "今天考了一套题。" },
    { role: "assistant", content: "考得怎么样？ " },
    { role: "user", content: "84 分，过了！" },
    { role: "user", content: "84 分，过了！" }
  ] })).structuredContent.data;
  assert.equal(second.saved, 1);
  assert.equal(second.skipped, 3);
  const stored = sqlite.prepare("SELECT role, content, source FROM messages WHERE conversation_id = ? ORDER BY created_at, seq")
    .all(first.conversation_id) as any[];
  assert.deepEqual(stored.map((m) => m.content), ["今天考了一套题。", "考得怎么样？", "84 分，过了！"]);
  assert.ok(stored.every((m) => m.source === "mcp"));
});

test("new chat capture is opt-in; archive search pages literal matches and survives raw retention", async () => {
  const off = await call("log_conversation", { messages: [{ role: "user", content: "不归档的聊天。" }] });
  assert.equal(off.structuredContent.data.saved, 1);
  assert.deepEqual((await call("search_chat", { query: "不归档" })).structuredContent.data.hits, []);
  env.CHAT_ARCHIVE_ENABLED = "true";
  const messages = Array.from({ length: 13 }, (_, index) => ({ role: "user", content: `记录 ${index} Cloudflare + (D1)` }));
  messages.push({ role: "system", content: "系统提示不应该入档。" });
  await call("log_conversation", { messages });
  const first = (await call("search_chat", { query: "CLOUDFLARE + (D1)" })).structuredContent.data;
  const second = (await call("search_chat", { query: "Cloudflare + (D1)", before: first.next })).structuredContent.data;
  assert.equal(first.hits.length, 10);
  assert.equal(second.hits.length, 3);
  assert.equal(second.next, null);
  assert.equal(new Set([...first.hits, ...second.hits].map((hit: any) => hit.id)).size, 13);
  assert.deepEqual((await call("search_chat", { query: "系统提示" })).structuredContent.data.hits, []);
  const { deleteOldMessages } = await import("../src/db/retention");
  await deleteOldMessages(env.DB, "default", "2099-01-01");
  assert.equal((await call("search_chat", { query: "记录" })).structuredContent.data.hits.length, 10);
  const { pruneChatArchive } = await import("../src/db/chatArchive");
  assert.equal(await pruneChatArchive(env.DB, "0"), 0);
  sqlite.prepare("UPDATE chat_archive SET stored_at = '2000-01-01'").run();
  assert.equal(await pruneChatArchive(env.DB, "30"), 13);
  assert.deepEqual((await call("search_chat", { query: "记录" })).structuredContent.data.hits, []);
});

test("renamed tools reach the same handlers and old names keep working", async () => {
  memory("m-1", "她养了一只猫。");
  assert.equal((await call("list_memories")).structuredContent.data[0].id, "m-1");
  assert.equal((await call("memory_list")).structuredContent.data[0].id, "m-1");

  assert.equal((await call("learn_word", { term: "旦九", definition: "她给我起的名字" })).structuredContent.data.term, "旦九");
  assert.equal((await call("keep_moment", { content: "她说今天很开心。" })).structuredContent.data.content, "她说今天很开心。");
  assert.deepEqual((await call("read_diary", { date: "2026-10-01" })).structuredContent.data, null);

  const legacy = (await call("memory_upsert", { fact_key: "user:pet", content: "她养了两只猫。" })).structuredContent.data;
  assert.equal(row("memories", legacy.id).fact_key, "user:pet");
  assert.equal((await call("memory_archive", { id: legacy.id })).structuredContent.data.archived, true);
  // The boot package is cached per namespace for a minute, so only its shape is checked here.
  assert.ok(Array.isArray((await call("memory_boot")).structuredContent.data.glossary));
  assert.equal((await call("no_such_tool")).isError, true);
});

test("the credential, signature and evidence stay separate across namespaces and revisions", async () => {
  env.MEMORY_MCP_API_KEY = "fixed-key";
  const local = (await call("log_conversation", { messages: [{ role: "user", content: "I chose ACP." }] }))
    .structuredContent.data;
  const msg = sqlite
    .prepare("SELECT id FROM messages WHERE conversation_id=?")
    .get(local.conversation_id)?.id;
  await call("log_conversation", { namespace: "other", messages: [{ role: "user", content: "private" }] });
  const foreign = sqlite.prepare("SELECT id FROM messages WHERE namespace='other'").get()?.id;
  const result = await worker.fetch(
    new Request("https://aelios.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer fixed-key" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "remember",
          arguments: {
            content: "I favor a small adapter.",
            authored_by: "Dan9",
            namespace: "other",
            source_message_ids: [msg, foreign]
          }
        }
      })
    }),
    env,
    { waitUntil() {} } as any
  );
  const id = ((await result.json()) as any).result.structuredContent.data.id;
  const saved = row("memories", id);
  assert.deepEqual(
    [saved.content, saved.authored_by, saved.namespace],
    ["I favor a small adapter.", "Dan9", "default"]
  );
  assert.deepEqual(JSON.parse(saved.source_message_ids), [msg]);
  const origin = JSON.parse(saved.provenance);
  assert.deepEqual(
    [origin.creation_mode, origin.recording_actor, origin.attributed_actor],
    ["agent_explicit", "mcp:mcp", "unknown"]
  );
  const next = (
    await call("remember", { content: "November 20. I still favor a small adapter.", authored_by: "GPT" })
  ).structuredContent.data.id;
  assert.notEqual(id, next);
  assert.equal(row("memories", id).status, "active");
  await call("memory_upsert", {
    fact_key: saved.fact_key,
    content: "I changed my mind.",
    authored_by: "GPT"
  });
  const revision = sqlite.prepare("SELECT * FROM memory_revisions WHERE memory_id=?").get(id);
  assert.deepEqual(
    [revision?.content, revision?.authored_by, revision?.provenance],
    [saved.content, "Dan9", saved.provenance]
  );
});

test("explicit recall distinguishes a signed write, a user's choice and missing or clipped original wording", async () => {
  const { runRecall } = await import("../src/memory/v2/recall");
  const { dreamOrigin } = await import("../src/memory/provenance");
  const wrote = (
    await call("remember", { content: "ACP planning. Dan9 preferred DSH.", authored_by: "Dan9" })
  ).structuredContent.data.id;
  memory("choice", "ACP planning. The user chose ACP.");
  memory("legacy", "ACP planning. An unattributed estimate.");
  const line = `I choose ACP. ${"context ".repeat(65)}`;
  sqlite
    .prepare(
      "INSERT INTO messages(id,conversation_id,namespace,role,content,source,created_at) VALUES ('quote','c','default','user',?,'hook','2026-09-01')"
    )
    .run(line);
  const origin = { ...dreamOrigin(["quote"]), attributed_actor: "user", evidence_relation: "paraphrase" };
  sqlite
    .prepare("UPDATE memories SET provenance=?,source_message_ids='[\"quote\"]' WHERE id='choice'")
    .run(JSON.stringify(origin));
  env.ENABLE_MEMORY_RERANKER = "false";
  env.VECTORIZE.query = async () => ({
    matches: [wrote, "legacy", "choice"].map((id) => ({
      id: `mem_${id}`,
      score: 0.85,
      metadata: { ref_id: id, namespace: "default" }
    }))
  });
  const recall = (query: string) =>
    runRecall(env, { namespace: "default", query, k: 5, skip_inject_mark: true });
  assert.equal((await recall("What did Dan9 write about ACP planning?")).hits[0]?.id, wrote);
  const decision = await recall("What did the user decide about ACP planning?");
  assert.equal(decision.hits[0]?.id, "choice");
  assert.equal(decision.hits.find((h) => h.id === "legacy")?.provenance, undefined);
  const exact = await recall("Exact wording of the ACP decision?");
  assert.equal(exact.evidence?.status, "partial");
  assert.deepEqual(exact.evidence?.messages, [
    { id: "quote", role: "user", created_at: "2026-09-01", text: line.slice(0, 400) }
  ]);
  sqlite.prepare("DELETE FROM messages WHERE id='quote'").run();
  assert.deepEqual((await recall("Exact wording of the ACP decision?")).evidence, {
    status: "unavailable",
    messages: []
  });
  assert.equal((await recall("ACP planning")).evidence, undefined);
});

test("migration 0023 preserves legacy data and refuses a competing successor atomically", () => {
  const legacy = new DatabaseSync(":memory:");
  try {
    const migration = "0023_memory_provenance.sql";
    for (const file of readdirSync("migrations")
      .filter((file) => file < migration && file.endsWith(".sql"))
      .sort()) {
      legacy.exec(readFileSync(`migrations/${file}`, "utf8"));
    }
    legacy.exec(`INSERT INTO memories(id,namespace,type,content,created_at,updated_at,authored_by)
      VALUES ('old','default','note','original','2026','2026','Dan9')`);
    legacy.exec(readFileSync(`migrations/${migration}`, "utf8"));
    assert.deepEqual(
      { ...legacy.prepare("SELECT content, authored_by, provenance FROM memories").get() },
      { content: "original", authored_by: "Dan9", provenance: null }
    );
    legacy.exec("UPDATE memories SET superseded_by='first' WHERE id='old'");
    legacy.exec("BEGIN");
    try {
      legacy.exec(`INSERT INTO memories(id,namespace,type,content,created_at,updated_at)
        VALUES ('second','default','note','late proposal','2026','2026')`);
      assert.throws(
        () => legacy.exec("UPDATE memories SET superseded_by='second' WHERE id='old'"),
        /already superseded/
      );
    } finally {
      legacy.exec("ROLLBACK");
    }
    assert.equal(legacy.prepare("SELECT COUNT(*) n FROM memories").get()?.n, 1);
    assert.equal(
      legacy.prepare("SELECT superseded_by FROM memories WHERE id='old'").get()?.superseded_by,
      "first"
    );
  } finally {
    legacy.close();
  }
});

test("an edit stops if the database cannot retain the previous version", async () => {
  const { updateMemory } = await import("../src/db/memories");
  memory("original", "I chose ACP.");
  sqlite.exec(
    "CREATE TRIGGER injected_failure BEFORE INSERT ON memory_revisions BEGIN SELECT RAISE(ABORT, 'snapshot failed'); END"
  );
  await assert.rejects(
    updateMemory(env.DB, { namespace: "default", id: "original", patch: { content: "I changed my mind." } }),
    /snapshot failed/
  );
  assert.equal(row("memories", "original").content, "I chose ACP.");
});

test("decision evolution includes the previous in-place version only as history", async () => {
  const original = await call("memory_upsert", { fact_key: "choice:acp", content: "I am considering ACP." });
  const id = original.structuredContent.data.id;
  sqlite.prepare("UPDATE memories SET created_at='2026-01-01',updated_at='2026-01-01' WHERE id=?").run(id);
  await call("memory_upsert", { fact_key: "choice:acp", content: "I chose ACP." });
  env.ENABLE_MEMORY_RERANKER = "false";
  env.VECTORIZE.query = async () => ({
    matches: [{ id: `mem_${id}`, score: 0.99, metadata: { ref_id: id, namespace: "default" } }]
  });
  const history = (await call("recall", { query: "How did the ACP decision evolve?", k: 2 }))
    .structuredContent.data;
  assert.deepEqual(
    history.hits.map((h: any) => [h.content, h.version_status]),
    [
      ["I am considering ACP.", "superseded"],
      ["I chose ACP.", "current"]
    ]
  );
  assert.equal(history.hits[0].revision_of, id);
  const current = (await call("recall", { query: "What did the user decide about ACP?", k: 2 }))
    .structuredContent.data;
  assert.deepEqual(
    current.hits.map((h: any) => h.content),
    ["I chose ACP."]
  );
});
