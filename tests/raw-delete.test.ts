import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { runInNewContext } from "node:vm";
import worker from "../src/index";
import { invalidateSettingsCache } from "../src/gateway/config";
import { ADMIN_HTML } from "../src/api/admin/ui";

// 删一句原话：报错、乱码、突然拒答这种，在后台首页「今天的对话」里删掉，整理、日记和召回都读不到。
(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);
let sqlite: DatabaseSync;
let env: any;

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
  env = { DB: db, CHATBOX_API_KEY: "owner-key", MEMORY_MCP_API_KEY: "mcp-key" };
  globalThis.fetch = async (url: any) => { throw new Error(`unexpected upstream call: ${url}`); };
  const now = new Date().toISOString();
  const insert = sqlite.prepare(`INSERT INTO messages (id, conversation_id, namespace, role, content, source, created_at, seq)
    VALUES (?, 'gw_c', ?, ?, ?, 'gateway:resident', ?, ?)`);
  const index = sqlite.prepare("INSERT INTO message_fts (fts_body, namespace, message_id) VALUES (?, ?, ?)");
  for (const [id, namespace, role, content, seq] of [
    ["gw_user_1", "default", "user", "帮我看看这段", 0],
    ["gw_req_1:assistant", "default", "assistant", "我不能完成这个任务。", 1],
    ["gw_req_2:assistant", "other", "assistant", "我不能完成这个任务。", 1]
  ] as const) {
    insert.run(id, namespace, role, content, now, seq);
    index.run(content, namespace, id);
  }
});

async function del(id: string, namespace = "default", key = "owner-key", mode = "clean") {
  const response = await worker.fetch(new Request(`https://aelios.test/v1/raw/${encodeURIComponent(id)}?namespace=${namespace}&mode=${mode}`, {
    method: "DELETE", headers: { authorization: `Bearer ${key}` }
  }), env, { waitUntil() {} } as any);
  return { status: response.status, body: await response.json() as any };
}
const rows = () => sqlite.prepare("SELECT id FROM messages ORDER BY id").all().map((row: any) => row.id);
const indexed = () => sqlite.prepare("SELECT message_id FROM message_fts ORDER BY message_id").all().map((row: any) => row.message_id);

test("a line is deleted with its search index, in its own space only", async () => {
  assert.deepEqual(await del("gw_req_1:assistant"), { status: 200, body: { data: { id: "gw_req_1:assistant", deleted: true } } });
  assert.deepEqual(rows(), ["gw_req_2:assistant", "gw_user_1"]);
  assert.deepEqual(indexed(), ["gw_req_2:assistant", "gw_user_1"]);
  assert.equal((await del("gw_req_1:assistant")).status, 404, "gone already");
  assert.equal((await del("gw_req_2:assistant", "default")).status, 404, "another space's line is not this one's");
  assert.deepEqual(rows(), ["gw_req_2:assistant", "gw_user_1"]);
});

test("only DELETE, only with a key that may write", async () => {
  assert.equal((await del("gw_user_1", "default", "wrong")).status, 401);
  const get = await worker.fetch(new Request("https://aelios.test/v1/raw/gw_user_1", { headers: { authorization: "Bearer owner-key" } }),
    env, { waitUntil() {} } as any);
  assert.equal(get.status, 404);
  assert.equal(rows().length, 3);
});

test("the home page's chats have a delete button that asks first, then drops the line from the list", async () => {
  assert.match(ADMIN_HTML, /@click="deleteRaw\(message\)"/);
  const script = (ADMIN_HTML.match(/<script>\s*(function memoryAdmin\(\)[\s\S]*?)<\/script>/) as RegExpMatchArray)[1];
  let answer = false;
  const app = runInNewContext(`${script}\nmemoryAdmin()`, {
    localStorage: { getItem: () => null, setItem() {} },
    location: { origin: "https://aelios.test" },
    document: { documentElement: { dataset: {} } },
    window: { setTimeout() {}, confirm: () => answer }
  });
  const calls: string[] = [];
  app.request = async (path: string, options: any = {}) => { calls.push(`${options.method || "GET"} ${path}`); return { data: { deleted: true } }; };
  app.notify = () => {};
  app.todayMessages = [{ id: "gw_user_1", role: "user", content: "帮我看看这段" }, { id: "gw_req_1:assistant", role: "assistant", content: "我不能完成这个任务。" }];
  app.stats = { today_raw_count: 2 };
  await app.deleteRaw(app.todayMessages[1]);
  assert.deepEqual(calls, [], "a no deletes nothing");
  answer = true;
  await app.deleteRaw(app.todayMessages[1]);
  assert.deepEqual(calls, ["DELETE /v1/raw/gw_req_1%3Aassistant?namespace=default"]);
  assert.deepEqual(app.todayMessages.map((message: any) => message.id), ["gw_user_1"]);
  assert.equal(app.stats.today_raw_count, 1);
  await app.deleteRaw(app.todayMessages[0],"withdraw");
  assert.equal(calls.at(-1),"DELETE /v1/raw/gw_user_1?mode=withdraw&namespace=default");
});

test("revocation hides transitive Dream inputs before a vector failure; retry and backfill cannot revive them", async () => {
  const { runVectorBackfill } = await import("../src/memory/vectorBackfill");
  const { runRecall } = await import("../src/memory/v2/recall");
  const { dreamOrigin } = await import("../src/memory/provenance");
  const id = "gw_user_1";
  const origin = JSON.stringify(dreamOrigin([id]));
  const insert =
    sqlite.prepare(`INSERT INTO memories (id,namespace,type,content,vector_id,created_at,updated_at,source_message_ids,provenance)
    VALUES (?,?, 'note','test adapter',?, '2026-01-01','2026-01-01',?,?)`);
  insert.run("parent", "default", "vec_parent", JSON.stringify([id]), origin);
  insert.run("child", "default", "vec_child", "[]", JSON.stringify(dreamOrigin([], {target:"parent"})));
  insert.run(
    "independent",
    "default",
    "vec_authored",
    JSON.stringify([id]),
    JSON.stringify({ creation_mode: "agent_explicit" })
  );
  insert.run("other", "other", "vec_other", JSON.stringify([id]), origin);
  sqlite
    .prepare(
      "INSERT INTO memory_candidates (id,namespace,content,provenance,created_at,updated_at) VALUES ('pending','default','test',?,'2026','2026')"
    )
    .run(origin);
  sqlite
    .prepare(
      "INSERT INTO memory_triggers(namespace,memory_id,concept,vector_id,created_at) VALUES ('default','child','test','trg','2026')"
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO daily_log(namespace,date,title,summary,source_message_ids,updated_at) VALUES ('default','2026-01-01','test','test',?,'2026')"
    )
    .run(JSON.stringify([id]));
  sqlite
    .prepare(
      "INSERT INTO longtail(id, namespace, content, ts, source_message_ids) VALUES ('lt_tail','default','test adapter','2026',?)"
    )
    .run(JSON.stringify([id]));
  let fail = true;
  const removed: string[] = [];
  const matches = ["parent", "child"].map((ref_id) => ({
    id: `mem_${ref_id}`,
    score: 0.99,
    metadata: { namespace: "default", ref_id, content: "test adapter" }
  }));
  env.AI = {
    async run() {
      return { data: [[1, 0]] };
    }
  };
  env.VECTORIZE = {
    async deleteByIds(ids: string[]) {
      if (fail) throw new Error("offline");
      removed.push(...ids);
    },
    async query() {
      return { matches };
    },
    async getByIds() {
      return [];
    }
  };
  assert.equal((await del(id, "default", "owner-key", "withdraw")).status, 503);
  const active = () =>
    sqlite
      .prepare("SELECT id FROM memories WHERE status='active' ORDER BY id")
      .all()
      .map((r) => r.id);
  assert.deepEqual(active(), ["independent", "other"]);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM longtail").get()?.n, 0);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM daily_log WHERE needs_rebuild=0").get()?.n, 0);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM memory_candidates").get()?.n, 0);
  assert.throws(() => insert.run("late", "default", "vec_late", "[]", origin), /revoked/);
  const result = await runRecall(env, {
    namespace: "default",
    query: "test adapter",
    include_history: true,
    skip_inject_mark: true
  });
  assert.ok(result.hits.every((hit) => hit.id !== "parent" && hit.id !== "child"));
  fail = false;
  assert.equal((await del(id, "default", "owner-key", "withdraw")).status, 200);
  assert.deepEqual(
    new Set(removed),
    new Set(["vec_parent", "vec_child", "trg#c", "trg#b", "trg#j", "lt_tail", "lt_lt_tail"])
  );
  assert.equal((await del(id, "default", "owner-key", "withdraw")).status, 404);
  sqlite.exec(
    "INSERT INTO weekly_log(namespace,week,start_date,end_date,title,summary,source_days,updated_at) VALUES ('default','2026-W01','2025-12-29','2026-01-04','clean','from surviving inputs',1,'2026')"
  );
  assert.equal((await del("gw_req_1:assistant")).status, 200);
  assert.equal(sqlite.prepare("SELECT summary FROM weekly_log").get()?.summary, "from surviving inputs");
  assert.equal((await runVectorBackfill(env, { namespace: "default", dryRun: true })).active_memories, 1);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO messages(id,conversation_id,namespace,role,content,created_at) VALUES (?,'c','default','user','replayed','2026')"
    )
    .run(id);
  assert.equal(sqlite.prepare("SELECT id FROM messages WHERE id=?").get(id), undefined);
});

test("wake_up cannot replay an impression cached before a source was forgotten", async () => {
  const { buildBootPackage } = await import("../src/memory/v2/recall");
  const namespace = "cache-test";
  sqlite.exec(`INSERT INTO messages(id,conversation_id,namespace,role,content,created_at)
    VALUES ('erase','c','cache-test','user','test','2026');
    INSERT INTO daily_log(namespace,date,title,summary,source_message_ids,updated_at)
    VALUES ('cache-test','2026-01-01','test','test','["erase"]','2026');
    INSERT INTO weekly_log(namespace,week,start_date,end_date,title,summary,source_days,updated_at)
    VALUES ('cache-test','2026-W01','2025-12-29','2026-01-04','test','weekly impression',1,'2026')`);
  assert.equal((await buildBootPackage(env, { namespace })).impressions.weekly?.summary, "weekly impression");
  assert.equal((await del("erase", namespace, "owner-key", "withdraw")).status, 200);
  assert.equal((await buildBootPackage(env, { namespace })).impressions.weekly, null);
});

test("cleanup detaches a line; withdrawal follows citations, never batch context", async () => {
  const {dreamOrigin} = await import("../src/memory/provenance");
  const insert = sqlite.prepare(`INSERT INTO memories(id,namespace,type,content,source_message_ids,provenance,created_at,updated_at)
    VALUES (?,'default','note',?,?,?,'2026','2026')`);
  const love = "gw_user_1";
  const junk = "gw_req_1:assistant";
  insert.run("nick","开始叫旦九小九", JSON.stringify([love]), JSON.stringify(dreamOrigin([love], {messages:[love,junk]})));
  insert.run("later","独立的一晚", "[]", JSON.stringify(dreamOrigin([], {memories:["nick"]})));
  insert.run("noise","待移除的一句",JSON.stringify([junk]),JSON.stringify(dreamOrigin([junk])));
  assert.equal((await del(junk)).status,200);
  assert.equal(sqlite.prepare("SELECT source_message_ids FROM memories WHERE id='noise'").get()?.source_message_ids,"[]");
  assert.equal(sqlite.prepare("SELECT count(*) n FROM memory_revocations").get()?.n,0);
  assert.equal((await del(junk,"default","owner-key","withdraw")).status,200);
  assert.equal(sqlite.prepare("SELECT status FROM memories WHERE id='nick'").get()?.status,"active");
  assert.equal((await del(love,"default","owner-key","withdraw")).status,200);
  assert.equal(sqlite.prepare("SELECT status FROM memories WHERE id='nick'").get()?.status,"archived");
  assert.equal(sqlite.prepare("SELECT status FROM memories WHERE id='later'").get()?.status,"active");
});

test("preview batch-wide diary citations are rebuilt from surviving raw messages", async () => {
  const {writeDiaryAfterDream}=await import("../src/memory/diaryWriter");
  const {getDailyLog}=await import("../src/db/v2");
  const day="2026-09-18";
  env.DREAM_TIME_ZONE="UTC";
  sqlite.prepare("UPDATE messages SET created_at=?").run(`${day}T09:00:00.000Z`);
  sqlite.prepare("INSERT INTO processing_cursors(name,value,updated_at) VALUES(?,?,'now')")
    .run(`dream:default:${day}`,`done:${day}T10:00:00Z`);
  sqlite.prepare(`INSERT INTO daily_log(namespace,date,title,summary,source_message_ids,input_refs,context_refs,updated_at)
    VALUES('default',?,'draft','old private draft',?,?,?,'then')`)
    .run(day,'["gw_user_1","gw_req_1:assistant"]','["message:gw_user_1","message:gw_req_1:assistant"]',
      '["message:gw_user_1","message:gw_req_1:assistant","memory:context"]');
  sqlite.exec(readFileSync("migrations/0025_preview_digest_drafts.sql","utf8"));
  assert.equal(await getDailyLog(env.DB,{namespace:"default",date:day}),null);
  assert.equal((await del("gw_req_1:assistant","default","owner-key","withdraw")).status,200);
  env.AI={run:async (_model:string, input:{messages:{content:string}[]})=>{
    const prompt=input.messages.at(-1)?.content ?? "";
    assert.doesNotMatch(prompt,/old private draft|我不能完成这个任务/);
    assert.match(prompt,/帮我看看这段/);
    return {response:JSON.stringify({title:"幸存的原文",summary:"她请我帮她看看这段。",source_message_ids:["gw_user_1"]})};
  }};
  assert.ok((await writeDiaryAfterDream(env,"default",day)).ran);
  const rewritten=await getDailyLog(env.DB,{namespace:"default",date:day});
  assert.deepEqual(rewritten?.source_message_ids,["gw_user_1"]);
});

// R01/R02: deleting an unrelated line (m_junk) never takes memories that only read it.
const memoryRow = (id: string, content: string, source: string, authoredBy: string | null, sources: string[], provenance: unknown) =>
  sqlite.prepare(`INSERT INTO memories(id,namespace,type,content,source,authored_by,source_message_ids,provenance,created_at,updated_at)
    VALUES (?,'default','note',?,?,?,?,?,'2026','2026')`)
    .run(id, content, source, authoredBy, JSON.stringify(sources), provenance === null ? null : JSON.stringify(provenance));
const memoryStatus = (id: string) => (sqlite.prepare("SELECT status FROM memories WHERE id=?").get(id) as any)?.status;
const sourcesOf = (id: string) => JSON.parse((sqlite.prepare("SELECT source_message_ids s FROM memories WHERE id=?").get(id) as any).s);

test("R01: an unrelated line goes alone; the nickname and a later authored memory stay, in either mode", async () => {
  const { dreamOrigin, explicitWrite } = await import("../src/memory/provenance");
  const love = "gw_user_1";
  const junk = "gw_req_1:assistant";
  const authored = explicitWrite({ source: "resident", namespace: "default" } as any, "mcp", "旦九");
  memoryRow("nick_authored", "我开始叫她小九", "mcp", "旦九", [love], authored);
  memoryRow("nick_dream", "她被叫作小九", "judge", null, [love], dreamOrigin([love], { messages: [love, junk] }));
  memoryRow("later", "那晚她又叫了我一次", "mcp", "旦九", [], { ...authored, context_refs: ["memory:nick_authored"] });
  for (const mode of ["clean", "withdraw"]) {
    sqlite.prepare("INSERT OR IGNORE INTO messages(id,conversation_id,namespace,role,content,created_at) VALUES (?,'c','default','assistant','我不能完成这个任务。','2026')").run(junk);
    const response = await del(junk, "default", "owner-key", mode);
    assert.equal(response.status, 200, mode);
    assert.deepEqual(["nick_authored", "nick_dream", "later"].map(memoryStatus), ["active", "active", "active"], mode);
    if (mode === "withdraw") assert.deepEqual(response.body.data.withdrawn_memories, []);
  }
  assert.deepEqual(rows(), ["gw_req_2:assistant", "gw_user_1"]);
});

test("R02: rows written before provenance are withdrawn only when they cite the line alone or copy it", async () => {
  const love = "gw_user_1";
  const junk = "gw_req_1:assistant";
  // Shapes the pre-provenance Dream wrote: whole-batch source lists, no provenance.
  memoryRow("batch_update", "她请旦九帮忙看一段文字", "judge", null, [love, junk], null);
  memoryRow("batch_copy", "助手回答过：我不能完成这个任务。", "dream", null, [love, junk], null);
  memoryRow("single_cite", "助手那天拒绝过一次", "judge", null, [junk], null);
  memoryRow("hand_written", "我开始叫她小九", "mcp", null, [love, junk], null);
  const response = await del(junk, "default", "owner-key", "withdraw");
  assert.equal(response.status, 200);
  assert.deepEqual(new Set(response.body.data.withdrawn_memories), new Set(["batch_copy", "single_cite"]));
  assert.deepEqual(response.body.data.unverified_memories, ["batch_update"]);
  assert.deepEqual(["batch_update", "batch_copy", "single_cite", "hand_written"].map(memoryStatus),
    ["active", "archived", "archived", "active"]);
  assert.deepEqual(sourcesOf("batch_update"), [love], "kept rows no longer point at the withdrawn line");
  assert.deepEqual(sourcesOf("hand_written"), [love]);
  // Withdrawing the line the row actually came from still cannot prove dependence for a batch row.
  const again = await del(love, "default", "owner-key", "withdraw");
  assert.equal(again.status, 200);
  assert.equal(memoryStatus("batch_update"), "archived", "now a single-cited row: the citation is unambiguous");
});

test("the delete actions are named for their scope", () => {
  assert.match(ADMIN_HTML, /L\('删除这句', 'Delete this line'\)/);
  assert.match(ADMIN_HTML, /撤回这句及其已知衍生记忆/);
});
