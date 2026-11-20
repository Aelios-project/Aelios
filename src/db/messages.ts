import { ARCHIVE_MAX_MESSAGE_CHARS, archiveWriteStatements } from "./chatArchive";
import { chatContentText } from "../memory/transfer/chatParse";
import { insertMessageFts } from "../memory/fts";
import type { MessageRecord, OpenAIChatMessage, TokenUsage } from "../types";
import { sha256Hex } from "../utils/hash";
import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";
import { cleanMessageText } from "../utils/sanitize";
import { getImportedMessagesByIds, IMPORTED_MESSAGE_PREFIX } from "./v2/imports";

export const MESSAGE_ORDER_SQL =
  "created_at ASC, seq ASC, CASE role WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END ASC, id ASC";

export const MESSAGE_ORDER_SQL_DESC =
  "created_at DESC, seq DESC, CASE role WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END DESC, id DESC";

function roleSeq(role: string): number {
  if (role === "user") return 0;
  if (role === "assistant") return 1;
  return 2;
}

function contentToText(content: OpenAIChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return JSON.stringify(content);
}

// Stable-hash normalization: trim + collapse whitespace so retrying the same
// (namespace, conversationId, role, content, bucket) yields an identical hash. The DB id
// stays random; only the hash drops it — that is what makes the hash idempotent.
function normalizeContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

export async function saveUserMessages(
  db: D1Database,
  input: {
    conversationId: string;
    namespace: string;
    source: string;
    messages: OpenAIChatMessage[];
    requestModel: string;
    upstreamModel: string;
    upstreamProvider: string;
    stream: boolean;
  }
): Promise<string[]> {
  const lastUserMessage = [...input.messages].reverse().find((message) => message.role === "user");
  const userMessages = lastUserMessage ? [lastUserMessage] : [];
  const ids: string[] = [];

  for (const message of userMessages) {
    const content = cleanMessageText(contentToText(message.content));
    const id = newId("msg");
    // 10-minute time bucket: conversations are eternal (`${namespace}:default`),
    // so content-only hashes would collide on every legitimate repeat of the same
    // text. Same-bucket client retries (seconds apart) still dedupe; a retry that
    // straddles a bucket boundary may insert a duplicate — accepted, rare, and
    // strictly better than dropping real messages.
    const bucket = Math.floor(Date.now() / 600_000);
    const hash = await sha256Hex(`${input.namespace}:${input.conversationId}:${message.role}:${normalizeContent(content)}:${bucket}`);

    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO messages (
          id, conversation_id, namespace, role, content, source, client_message_hash,
          upstream_model, upstream_provider, request_model, stream, created_at, seq
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.conversationId,
        input.namespace,
        "user",
        content,
        input.source,
        hash,
        input.upstreamModel,
        input.upstreamProvider,
        input.requestModel,
        input.stream ? 1 : 0,
        nowIso(),
        roleSeq("user")
      )
      .run();

    // Duplicate hash (client retry): return the existing row id so callers still get a valid message id.
    // That row was indexed when it was first saved, so only a fresh row needs an FTS entry.
    if ((result.meta.changes ?? 0) === 0) {
      const existing = await db
        .prepare("SELECT id FROM messages WHERE client_message_hash = ? LIMIT 1")
        .bind(hash)
        .first<{ id: string }>();
      ids.push(existing?.id ?? id);
    } else {
      ids.push(id);
      await insertMessageFts(db, { namespace: input.namespace, messageId: id, content });
    }
  }

  return ids;
}

export async function saveAssistantMessage(
  db: D1Database,
  input: {
    conversationId: string;
    namespace: string;
    source: string;
    content: string;
    requestModel: string;
    upstreamModel: string;
    provider: string;
    stream: boolean;
    finishReason?: string | null;
    usage?: TokenUsage;
    cacheMode?: string | null;
    cacheTtl?: string | null;
  }
): Promise<string> {
  const id = newId("msg");
  const usage = input.usage || {};

  await db
    .prepare(
      `INSERT INTO messages (
        id, conversation_id, namespace, role, content, source, upstream_model,
        upstream_provider, request_model, stream, finish_reason, token_input,
        token_output, cache_mode, cache_ttl, cache_hit, cache_read_tokens,
        cache_creation_tokens, raw_usage_json, created_at, seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.conversationId,
      input.namespace,
      "assistant",
      input.content,
      input.source,
      input.upstreamModel,
      input.provider,
      input.requestModel,
      input.stream ? 1 : 0,
      input.finishReason || null,
      usage.prompt_tokens ?? usage.input_tokens ?? null,
      usage.completion_tokens ?? usage.output_tokens ?? null,
      input.cacheMode ?? null,
      input.cacheTtl ?? null,
      typeof usage.cache_read_input_tokens === "number" && usage.cache_read_input_tokens > 0 ? 1 : 0,
      usage.cache_read_input_tokens ?? null,
      usage.cache_creation_input_tokens ?? null,
      JSON.stringify(usage),
      nowIso(),
      roleSeq("assistant")
    )
    .run();

  await insertMessageFts(db, { namespace: input.namespace, messageId: id, content: input.content });
  return id;
}

/** Resolve caller-supplied citations in the authorized space, within the D1 parameter limit. */
export async function retainedMessageIds(db: D1Database, namespace: string, requested: string[]): Promise<string[]> {
  return (await getMessagesByIds(db, {namespace, ids: [...new Set(requested)].slice(0, 90)})).map(m => m.id);
}

export async function getMessagesByIds(
  db: D1Database,
  input: { namespace: string; ids: string[] }
): Promise<MessageRecord[]> {
  if (input.ids.length === 0) return [];

  const result = await db
    .prepare(
      `SELECT id, conversation_id, namespace, role, content, source, created_at, seq, capture_kind
       FROM messages
       WHERE namespace = ? AND id IN (SELECT value FROM json_each(?))
       ORDER BY ${MESSAGE_ORDER_SQL}`
    )
    .bind(input.namespace, JSON.stringify(input.ids))
    .all<MessageRecord>();
  const rows = result.results ?? [];

  // 导入的旧聊天不在 messages 里 (那里 7 天就删)，候选和记忆挂的是 imsg_ 开头的 id，到 imported_messages 找。
  // 看出处、clef 审、助手用 MCP 看候选都走这里，所以导入的原话处处都查得到。
  const found = new Set(rows.map((row) => row.id));
  const importedIds = input.ids.filter((id) => !found.has(id) && id.startsWith(IMPORTED_MESSAGE_PREFIX));
  if (importedIds.length === 0) return rows;
  return [...rows, ...(await getImportedMessagesByIds(db, { namespace: input.namespace, ids: importedIds }))];
}

export async function countMessagesAfterTimestamp(
  db: D1Database,
  namespace: string,
  afterCreatedAt: string | null
): Promise<number> {
  if (!afterCreatedAt) {
    const row = await db
      .prepare(
        `SELECT COUNT(*) as cnt FROM messages
         WHERE namespace = ? AND role IN ('user', 'assistant')`
      )
      .bind(namespace)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  const row = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM messages
       WHERE namespace = ? AND role IN ('user', 'assistant') AND created_at > ?`
    )
    .bind(namespace, afterCreatedAt)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

export async function listMessagesByNamespace(
  db: D1Database,
  namespace: string,
  afterCreatedAt: string | null,
  limit: number
): Promise<MessageRecord[]> {
  let sql = `SELECT id, conversation_id, namespace, role, content, source, created_at, seq, capture_kind
             FROM messages
             WHERE namespace = ? AND role IN ('user', 'assistant')`;
  const binds: unknown[] = [namespace];

  if (afterCreatedAt) {
    sql += " AND created_at > ?";
    binds.push(afterCreatedAt);
  }

  sql += ` ORDER BY ${MESSAGE_ORDER_SQL} LIMIT ?`;
  binds.push(limit);

  const result = await db.prepare(sql).bind(...binds).all<MessageRecord>();
  return result.results ?? [];
}

function appendAfterCursor(
  sql: string,
  binds: unknown[],
  afterCreatedAt?: string | null,
  afterId?: string | null
): string {
  if (!afterCreatedAt) return sql;
  if (afterId) {
    // Look up seq from the cursor row so hash IDs never decide order.
    binds.push(afterCreatedAt, afterCreatedAt, afterId, afterCreatedAt, afterId, afterId);
    return `${sql} AND (
      created_at > ?
      OR (created_at = ? AND seq > COALESCE((SELECT seq FROM messages WHERE id = ?), 0))
      OR (created_at = ? AND seq = COALESCE((SELECT seq FROM messages WHERE id = ?), 0) AND id > ?)
    )`;
  }
  binds.push(afterCreatedAt);
  return `${sql} AND created_at > ?`;
}

export async function listMessagesByNamespaceInRange(
  db: D1Database,
  input: {
    namespace: string;
    startCreatedAt: string;
    endCreatedAt: string;
    afterCreatedAt?: string | null;
    afterId?: string | null;
    limit: number;
  }
): Promise<MessageRecord[]> {
  let sql = `SELECT id, conversation_id, namespace, role, content, source, created_at, seq, capture_kind
             FROM messages
             WHERE namespace = ?
               AND role IN ('user', 'assistant')
               AND created_at >= ?
               AND created_at < ?`;
  const binds: unknown[] = [input.namespace, input.startCreatedAt, input.endCreatedAt];
  sql = appendAfterCursor(sql, binds, input.afterCreatedAt, input.afterId);
  sql += ` ORDER BY ${MESSAGE_ORDER_SQL} LIMIT ?`;
  binds.push(input.limit);

  const result = await db.prepare(sql).bind(...binds).all<MessageRecord>();
  return result.results ?? [];
}

// log_conversation 去重：同一对话里已经存过的 (role, 正文) 不再存第二遍，同一批里重复的也只留一条。
// 正文按 saveIngestMessages 落库时的同一套清洗比较，空白差异不算不同。
export async function filterUnsavedMessages(
  db: D1Database,
  input: { namespace: string; conversationId: string; messages: OpenAIChatMessage[] }
): Promise<OpenAIChatMessage[]> {
  const stored = await db
    .prepare("SELECT role, content FROM messages WHERE namespace = ? AND conversation_id = ?")
    .bind(input.namespace, input.conversationId)
    .all<{ role: string; content: string }>();
  const seen = new Set((stored.results ?? []).map((row) => `${row.role}\n${normalizeContent(row.content)}`));
  const fresh: OpenAIChatMessage[] = [];
  for (const message of input.messages) {
    const key = `${message.role}\n${normalizeContent(cleanMessageText(contentToText(message.content)))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(message);
  }
  return fresh;
}

export async function saveIngestMessages(
  db: D1Database,
  input: {
    conversationId: string;
    namespace: string;
    source: string;
    messages: OpenAIChatMessage[];
    archive?: boolean;
  }
): Promise<string[]> {
  const ids: string[] = [];
  let seq = 0;

  for (const message of input.messages) {
    const content = cleanMessageText(contentToText(message.content));
    if (!content) continue;

    const id = newId("msg");
    ids.push(id);

    const createdAt = nowIso();
    const write = db
      .prepare(
        `INSERT INTO messages (
          id, conversation_id, namespace, role, content, source, stream, created_at, seq
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.conversationId,
        input.namespace,
        message.role,
        content,
        input.source,
        0,
        createdAt,
        seq
      );
    const visible = input.archive ? cleanMessageText(chatContentText(message.content)) : "";
    if (visible && visible.length <= ARCHIVE_MAX_MESSAGE_CHARS && (message.role === "user" || message.role === "assistant")) {
      const archive = await archiveWriteStatements(db, input.namespace, [{ id, conversation_id: input.conversationId,
        role: message.role, content: visible, source: input.source, created_at: createdAt, position: Date.parse(createdAt) }]);
      await db.batch([write, ...archive]);
    } else {
      await write.run();
    }
    await insertMessageFts(db, { namespace: input.namespace, messageId: id, content });
    seq += 1;
  }

  return ids;
}
