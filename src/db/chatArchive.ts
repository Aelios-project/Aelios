import { sha256Hex } from "../utils/hash";
import { readNonNegativeInt } from "../utils/request";
import { nowIso } from "../utils/time";

export const ARCHIVE_MAX_MESSAGE_CHARS = 150_000;
const QUERY_MAX = 120;
const CONTEXT_LINES = 4;

export interface ArchiveMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  source: string;
  speaker?: string | null;
  created_at: string;
  /** Source sequence for imports, Unix milliseconds for live conversations. */
  position: number;
}

type ArchiveHit = Pick<ArchiveMessage, "id" | "conversation_id" | "role" | "source" | "speaker" | "created_at"> & { text: string };
type ArchiveRow = ArchiveMessage & { rowid: number };

function normalized(text: string): string {
  // Dotted capital I otherwise expands to two code points under default JS lowercasing.
  return text.replace(/\r\n?/g, "\n").replace(/İ/g, "I").toLowerCase();
}

/** Adjacent Unicode code points, including punctuation. Fixed-width ASCII keeps each pair a single FTS token. */
function bigrams(text: string): string {
  const chars = Array.from(text, (char) => (char.codePointAt(0) ?? 0).toString(36).padStart(4, "0"));
  const pairs: string[] = [];
  for (let i = 1; i < chars.length; i++) pairs.push(chars[i - 1] + chars[i]);
  return pairs.join(" ");
}

export function chatArchiveEnabled(env: { CHAT_ARCHIVE_ENABLED?: string }): boolean {
  return /^(?:true|on|1|yes)$/i.test(env.CHAT_ARCHIVE_ENABLED?.trim() ?? "");
}

export async function archiveWriteStatements(
  db: D1Database,
  namespace: string,
  messages: ArchiveMessage[],
  afterSuccessfulClaim = false
): Promise<D1PreparedStatement[]> {
  if (!messages.length) return [];
  const scope = await sha256Hex(namespace);
  const storedAt = nowIso();
  const rows = JSON.stringify(messages);
  const indexRows = JSON.stringify(messages.map(({ id, content }) => ({ id, tokens: bigrams(normalized(content)) })));
  // Keep text and postings in the same batch transaction. A retry only indexes rows that still need it.
  return [
    db.prepare(`INSERT INTO chat_archive
      (namespace, id, conversation_id, role, content, source, speaker, created_at, position, stored_at)
      SELECT ?, value->>'id', value->>'conversation_id', value->>'role', value->>'content', value->>'source',
        value->>'speaker', value->>'created_at', value->>'position', ?
      FROM json_each(?) WHERE ${afterSuccessfulClaim ? "changes() = 1" : "true"}
      ON CONFLICT(namespace, id) DO NOTHING`).bind(namespace, storedAt, rows),
    // CROSS JOIN keeps the bounded JSON batch outermost; each lookup uses (namespace, id).
    db.prepare(`INSERT INTO chat_archive_fts (rowid, space, body)
      SELECT a.rowid, ?, j.value->>'tokens' FROM json_each(?) j
      CROSS JOIN chat_archive a ON a.namespace = ? AND a.id = j.value->>'id'
      WHERE NOT EXISTS (SELECT 1 FROM chat_archive_fts f WHERE f.rowid = a.rowid)`).bind(scope, indexRows, namespace)
  ];
}

function hit(row: ArchiveRow, text: string): ArchiveHit {
  return { id: row.id, conversation_id: row.conversation_id, role: row.role, source: row.source,
    speaker: row.speaker, created_at: row.created_at, text };
}

function snippet(content: string, query: string): string {
  const text = content.replace(/\r\n?/g, "\n");
  const at = normalized(text).indexOf(query);
  const start = Math.max(0, at - 75);
  const end = Math.min(text.length, start + 300);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

async function archiveRow(db: D1Database, namespace: string, id: string): Promise<ArchiveRow | null> {
  return db.prepare("SELECT * FROM chat_archive WHERE namespace = ? AND id = ?").bind(namespace, id).first<ArchiveRow>();
}

export async function searchChatArchive(db: D1Database, namespace: string, input: { query: string; before?: string }) {
  const query = normalized(input.query.trim());
  const length = Array.from(query).length;
  if (length < 2 || length > QUERY_MAX) return { error: `Use a literal keyword or phrase of 2 to ${QUERY_MAX} characters` };
  const before = input.before ? await archiveRow(db, namespace, input.before) : null;
  if (input.before && !before) return { error: "Search again for a valid page cursor" };
  const scope = await sha256Hex(namespace);
  const match = `space : "${scope}" AND body : "${bigrams(query)}"`;
  const pageSize = 10;
  const binds = before ? [before.created_at, before.rowid] : [];
  const result = await db.prepare(`SELECT a.* FROM chat_archive_fts f
    JOIN chat_archive a ON a.rowid = f.rowid
    WHERE chat_archive_fts MATCH ? AND a.namespace = ? ${before ? "AND (a.created_at, a.rowid) < (?, ?)" : ""}
    ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`).bind(match, namespace, ...binds, pageSize + 1).all<ArchiveRow>();
  const rows = result.results ?? [];
  const page = rows.slice(0, pageSize);
  return {
    hits: page.map((row) => hit(row, snippet(row.content, query))),
    next: rows.length > pageSize ? page.at(-1)?.id ?? null : null
  };
}

export async function readChatArchiveAround(db: D1Database, namespace: string, id: string) {
  const center = await archiveRow(db, namespace, id);
  if (!center) return { error: "Message not found in this chat archive" };
  const find = (direction: "before" | "after") => {
    const op = direction === "before" ? "<" : ">";
    const order = direction === "before" ? "DESC" : "ASC";
    return db.prepare(`SELECT * FROM chat_archive WHERE namespace = ? AND conversation_id = ?
      AND (position, rowid) ${op} (?, ?) ORDER BY position ${order}, rowid ${order} LIMIT ?`)
      .bind(namespace, center.conversation_id, center.position, center.rowid, CONTEXT_LINES);
  };
  const [before, after] = await db.batch<ArchiveRow>([find("before"), find("after")]);
  const lines = [...(before.results ?? []).reverse(), center, ...(after.results ?? [])];
  return { lines: lines.map((row) => ({ ...hit(row, row.content.slice(0, 3000)),
    ...(row.content.length > 3000 ? { truncated: true } : {}), ...(row.id === id ? { hit: true } : {}) })) };
}

export async function pruneChatArchive(db: D1Database, retentionDays: string | undefined): Promise<number> {
  const days = readNonNegativeInt(retentionDays, 0, 36_500);
  if (!days) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  let removed = 0;
  for (let batch = 0; batch < 10; batch++) {
    const result = await db.prepare(`DELETE FROM chat_archive WHERE rowid IN (
      SELECT rowid FROM chat_archive WHERE stored_at < ? ORDER BY stored_at LIMIT 500)`).bind(cutoff).run();
    const count = result.meta.changes ?? 0;
    removed += count;
    if (count < 500) break;
  }
  return removed;
}
