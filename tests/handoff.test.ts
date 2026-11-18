import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { runInNewContext } from "node:vm";
import worker from "../src/index";
import { invalidateSettingsCache } from "../src/gateway/config";
import { ADMIN_HTML } from "../src/api/admin/ui";
import { readHandoff, saveResidentHandoff, writeHandoff } from "../src/db/v2/handoff";
import { KEY_PROFILES } from "../src/config/keyProfiles";

(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);
let sqlite: DatabaseSync;
let env: any;
beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
    try { sqlite.exec(readFileSync(`migrations/${file}`, "utf8")); }
    catch (error) { if (!String(error).includes("fts5")) throw error; }
  }
  const db = { prepare(sql: string) {
    const statement = sqlite.prepare(sql); let args: any[] = [];
    const api = { bind(...values: any[]) { args = values; return api; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { return { meta: { changes: statement.run(...args).changes } }; }
    }; return api;
  }, async batch(statements: any[]) { const results = []; for (const s of statements) results.push(await s.run()); return results; } };
  invalidateSettingsCache();
  env = { DB: db, CHATBOX_API_KEY: "owner-key", MEMORY_MCP_API_KEY: "mcp-key", GUIDE_DOG_API_KEY: "dog-key",
    AI: { async run() { return { data: [[0.1, 0.2, 0.3]] }; } },
    VECTORIZE: { async upsert() {}, async deleteByIds() {}, async query() { return { matches: [] }; } } };
  globalThis.fetch = async () => { throw new Error("unexpected upstream call"); };
});
async function rest(path: string, method = "GET", body?: any, key = "owner-key") {
  const response = await worker.fetch(new Request(`https://aelios.test${path}`, { method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} } as any);
  return { status: response.status, body: await response.json() as any };
}
async function rpc(name: string, args: any = {}, key = "owner-key") {
  const r = await rest("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, key);
  return r.body.result;
}
const get = async (namespace = "default") => readHandoff(env.DB, namespace);
const save = async (content: string, revision: number, namespace = "default") => writeHandoff(env.DB, { namespace, content, expectedRevision: revision, source: "human" });
function ingest(id: string, at: number, content = "当前情况和下一步", namespace = "default") {
  return rest("/v1/memory/ingest", "POST", { namespace, conversation_id: `${namespace}:aelios-resident`,
    source: "aelios-resident:letter", handoff: { id, created_at: at }, messages: [{ role: "assistant", content: `（交接信）${content}` }] });
}

test("MCP includes the writing prompt and versioned read/write/delete contract", async () => {
  const result = await rest("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tool = result.body.result.tools.find((t: any) => t.name === "handoff");
  assert.match(tool.description, /Write to your next self/);
  assert.match(tool.description, /emotional/);
  assert.match(tool.description, /expected_revision/);
  assert.match(tool.inputSchema.properties.content.description, /Do not invent memories/);
  const empty = (await rpc("handoff", { action: "read" })).structuredContent;
  assert.equal(empty.data.content, null); assert.equal(empty.data.revision, 0);
  assert.match(empty.writing_guide, /20000/);
  assert.equal((await rpc("handoff", { action: "write", content: "x" })).isError, true);
  const saved = (await rpc("handoff", { action: "write", content: "接着昨天的事情", expected_revision: 0 })).structuredContent.data;
  assert.equal(saved.source, "mcp"); assert.equal(saved.revision, 1);
  assert.equal((await rpc("handoff", { action: "write", content: "stale", expected_revision: 0 })).isError, true);
  assert.equal((await get()).content, "接着昨天的事情");
  assert.equal((await rpc("handoff", { action: "delete", expected_revision: 1 })).structuredContent.data.content, null);
  assert.equal((await get()).revision, 2);
});

test("REST keeps one letter, checks revisions, scopes, content and namespace", async () => {
  assert.equal((await rest("/v1/handoff", "GET", undefined, "wrong")).status, 401);
  assert.equal((await rest("/v1/handoff", "GET", undefined, "dog-key")).status, 403);
  assert.equal((await rest("/v1/handoff", "PUT", { content: "x", expected_revision: 0 }, "dog-key")).status, 403);
  assert.equal((await rest("/v1/handoff", "PUT", { content: "x" })).status, 400);
  assert.equal((await rest("/v1/handoff", "PUT", { content: "x", expected_revision: "0" })).status, 400);
  assert.equal((await rest("/v1/handoff", "PUT", { content: "  ", expected_revision: 0 })).status, 400);
  assert.equal((await rest("/v1/handoff", "PUT", { content: "x".repeat(20001), expected_revision: 0 })).status, 400);
  assert.equal((await rest("/v1/handoff?namespace=other", "PUT", { content: "other", expected_revision: 0 })).status, 200);
  assert.equal((await get()).content, null);
  await save("first", 0); await save("second", 1);
  assert.equal((await get()).content, "second");
  assert.equal((await rest("/v1/handoff", "DELETE", { expected_revision: 1 })).status, 409);
  assert.equal((await rest("/v1/handoff", "DELETE", { expected_revision: 2 })).status, 200);
  assert.equal((await get()).revision, 3);
  assert.equal((await get("other")).content, "other");
});

test("fixed-namespace MCP keys cannot read or write another space", async () => {
  await save("private other", 0, "other");
  const read = await rpc("handoff", { action: "read", namespace: "other" }, "mcp-key");
  assert.equal(read.structuredContent.data.content, null);
  await rpc("handoff", { action: "write", content: "fixed", expected_revision: 0, namespace: "other" }, "mcp-key");
  assert.equal((await get()).content, "fixed");
  assert.equal((await get("other")).content, "private other");
  const original = KEY_PROFILES.mcp.scopes;
  try {
    KEY_PROFILES.mcp.scopes = ["memory:read"];
    assert.equal((await rpc("handoff", { action: "write", content: "x", expected_revision: 1 }, "mcp-key")).isError, true);
    assert.equal((await rpc("handoff", { action: "read" }, "mcp-key")).isError, undefined);
  } finally { KEY_PROFILES.mcp.scopes = original; }
});

test("simultaneous first writes and stale updates have exactly one winner", async () => {
  const results = await Promise.allSettled([save("one", 0), save("two", 0)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const updates = await Promise.allSettled([save("three", 1), save("four", 1)]);
  assert.equal(updates.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await get()).revision, 2);
});

test("only MCP wake_up returns the handoff; the existing REST boot package stays unchanged", async () => {
  const empty = (await rpc("wake_up")).structuredContent.data;
  assert.equal("handoff" in empty, false);
  await save("UNIQUE_HANDOFF_MARKER", 0);
  const boot = (await rpc("wake_up")).structuredContent.data;
  assert.equal(boot.handoff.content, "UNIQUE_HANDOFF_MARKER");
  assert.equal(boot.handoff.source, "human");
  const restBoot = await rest("/v1/memory_boot");
  assert.equal(restBoot.status, 200);
  assert.doesNotMatch(JSON.stringify(restBoot.body), /UNIQUE_HANDOFF_MARKER/);
  assert.equal((await rpc("wake_up", { namespace: "other" })).structuredContent.data.handoff, undefined);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get()?.n, 0);
});

test("wake_up still returns its core pack when the handoff migration is missing", async () => {
  sqlite.exec("DROP TABLE current_handoffs");
  const result = await rpc("wake_up");
  assert.equal(result.isError, undefined);
  assert.ok(Array.isArray(result.structuredContent.data.core));
  assert.ok(result.structuredContent.data.how_to_use);
  assert.equal("handoff" in result.structuredContent.data, false);
  // Explicit handoff operations still report the problem instead of pretending to save.
  assert.equal((await rpc("handoff", { action: "read" })).isError, true);
});

test("overlong Resident letters keep their raw receipt and leave the current letter unchanged", async () => {
  await save("prior", 0);
  const text = "长".repeat(20001);
  const result = await ingest("overlong", Date.now() - 1000, text);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.message_ids.length, 1);
  const raw = sqlite.prepare("SELECT content FROM messages WHERE id = ?").get(result.body.data.message_ids[0]);
  assert.equal(raw?.content, `（交接信）${text}`);
  assert.equal((await get()).content, "prior");
  assert.equal((await get()).revision, 1);
  // The boundary counts code points, including supplementary characters, not UTF-16 units.
  const boundary = "🌟".repeat(20000);
  assert.equal((await ingest("boundary", Date.now() - 500, boundary, "other")).status, 200);
  assert.equal((await get("other")).content, boundary);
  const tooLong = `${boundary}🌟`;
  const skipped = await ingest("overlong-unicode", Date.now() - 250, tooLong, "empty");
  assert.equal(skipped.status, 200);
  assert.equal((await get("empty")).revision, 0);
  assert.equal(sqlite.prepare("SELECT content FROM messages WHERE id = ?").get(skipped.body.data.message_ids[0])?.content, `（交接信）${tooLong}`);
});

test("Resident delivery updates current handoff without changing its normal receipt", async () => {
  const at = Date.now() - 20000;
  const result = await ingest("letter-1", at);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.message_ids.length, 1);
  assert.equal((await get()).content, "当前情况和下一步");
  assert.equal((await get()).source, "resident");
  await ingest("letter-1", at); assert.equal((await get()).revision, 1);
  await ingest("letter-older", at - 1000, "older"); assert.equal((await get()).revision, 1);
  // Both generated before the first delivery: newer generation must still win.
  await ingest("letter-2", at + 1000, "newer");
  assert.equal((await get()).content, "newer"); assert.equal((await get()).revision, 2);
});

test("late Resident delivery cannot overwrite a human/MCP edit or deletion", async () => {
  const at = Date.now() - 30000;
  await ingest("letter-1", at);
  await save("human correction", 1);
  await ingest("letter-1", at);
  await ingest("letter-2", at + 1000, "late old generation");
  assert.equal((await get()).content, "human correction");
  await rpc("handoff", { action: "delete", expected_revision: 2 });
  await ingest("letter-3", at + 2000);
  assert.equal((await get()).content, null);
  // A genuinely new letter may replace the tombstone.
  sqlite.prepare("UPDATE current_handoffs SET updated_at = ? WHERE namespace = 'default'").run(new Date(at + 3000).toISOString());
  await ingest("letter-4", at + 4000, "new session");
  assert.equal((await get()).content, "new session");
});

test("ordinary ingest and legacy letters do not silently become current handoffs", async () => {
  const body = { source: "aelios-resident:letter", messages: [{ role: "assistant", content: "（交接信）legacy" }] };
  assert.equal((await rest("/v1/memory/ingest", "POST", body)).status, 200);
  assert.equal((await get()).content, null);
  assert.equal((await rest("/v1/memory/ingest", "POST", { ...body, source: "chat", handoff: { id: "x", created_at: Date.now() } })).status, 400);
  assert.equal((await ingest("future", Date.now() + 120000)).status, 400);
});

test("storage failure does not acknowledge a new letter or erase the previous handoff", async () => {
  await save("prior", 0);
  const db = env.DB;
  env.DB = { ...db, prepare(sql: string) {
    if (sql.startsWith("INSERT INTO current_handoffs")) throw new Error("synthetic database failure");
    return db.prepare(sql);
  } };
  const result = await ingest("failed", Date.now() - 1000);
  assert.equal(result.status, 503);
  env.DB = db;
  assert.equal((await get()).content, "prior");
});

test("admin editor preserves a conflicting draft and ignores responses after switching spaces", async () => {
  const match = ADMIN_HTML.match(/<script>\s*(function memoryAdmin\(\)[\s\S]*?)<\/script>/);
  assert.ok(match);
  const app = runInNewContext(`${match[1]}\nmemoryAdmin()`, {
    localStorage: { getItem: () => null, setItem() {} }, location: { origin: "https://aelios.test" },
    document: { documentElement: { dataset: {} } }, window: { setTimeout() {}, confirm: () => true }
  });
  app.icons = () => {}; app.notify = () => {}; app.apiKey = "owner";
  app.request = async () => ({ data: { content: "old", revision: 1, source: "mcp", updated_at: "2026-01-01" }, writing_guide: "guide" });
  await app.loadHandoff(); assert.equal(app.handoffDraft, "old");
  app.handoffDraft = "unsaved correction";
  app.request = async (_path: string, opts: any) => {
    assert.equal(JSON.parse(opts.body).expected_revision, 1); throw new Error("Handoff changed");
  };
  await app.saveHandoff(false);
  assert.equal(app.handoffDraft, "unsaved correction"); assert.equal(app.handoffNote.revision, 1);
  let resolve: any;
  app.request = () => new Promise((r) => { resolve = r; });
  const pending = app.loadHandoff(true);
  app.spaceRevision++;
  app.handoffDraft = "other space";
  resolve({ data: { content: "late old space", revision: 2 } }); await pending;
  assert.equal(app.handoffDraft, "other space");
  assert.match(ADMIN_HTML, /x-model="handoffDraft"/);
});
