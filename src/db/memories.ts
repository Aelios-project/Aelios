import type { MemoryProvenance } from "../memory/provenance";
import type { MemoryLifecycleRow, MemoryRecord } from "../types";
import { deleteFtsRow, searchFtsIds, upsertMemoryFts } from "../memory/fts";
import { lexicalHitScore } from "../memory/queryShape";
import { saveMemoryRevision } from "./v2/revisions";
import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";

export interface CreateMemoryInput {
  provenance?: MemoryProvenance;
  namespace: string;
  type: string;
  content: string;
  summary?: string | null;
  importance?: number;
  confidence?: number;
  status?: string;
  pinned?: boolean;
  tags?: string[];
  source?: string | null;
  sourceMessageIds?: string[];
  expiresAt?: string | null;
  /** 导入的记忆带着原来的日期。updated_at 仍是现在：过期按 updated_at 算。 */
  createdAt?: string | null;
}

export interface ListMemoryFilters {
  namespace: string;
  type?: string;
  status?: string;
  limit: number;
  offset?: number;
}

export interface ListMemoryPage {
  records: MemoryRecord[];
  hasMore: boolean;
  nextOffset: number | null;
}

export interface UpdateMemoryInput {
  provenance?: MemoryProvenance;
  type?: string;
  content?: string;
  summary?: string | null;
  importance?: number;
  confidence?: number;
  status?: string;
  pinned?: boolean;
  tags?: string[];
  sourceMessageIds?: string[];
  expiresAt?: string | null;
}

export async function createMemory(db: D1Database, input: CreateMemoryInput): Promise<MemoryRecord> {
  const id = newId("mem");
  const now = nowIso();
  const vectorId = `mem_${id}`;
  const record: MemoryRecord = {
    id,
    namespace: input.namespace,
    type: input.type,
    content: input.content,
    summary: input.summary ?? null,
    importance: input.importance ?? 0.5,
    confidence: input.confidence ?? 0.8,
    status: input.status ?? "active",
    pinned: input.pinned ? 1 : 0,
    tags: JSON.stringify(input.tags ?? []),
    source: input.source ?? null,
    provenance: JSON.stringify(input.provenance) ?? null,
    source_message_ids: JSON.stringify(input.sourceMessageIds ?? []),
    vector_id: vectorId,
    last_recalled_at: null,
    recall_count: 0,
    created_at: input.createdAt || now,
    updated_at: now,
    expires_at: input.expiresAt ?? null
  };

  await db
    .prepare(
      `INSERT INTO memories (
        id, namespace, type, content, summary, importance, confidence, status,
        pinned, tags, source, source_message_ids, vector_id, created_at, updated_at, expires_at, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      record.id,
      record.namespace,
      record.type,
      record.content,
      record.summary,
      record.importance,
      record.confidence,
      record.status,
      record.pinned,
      record.tags,
      record.source,
      record.source_message_ids,
      record.vector_id,
      record.created_at,
      record.updated_at,
      record.expires_at, record.provenance ?? null
    )
    .run();

  await upsertMemoryFts(db, { namespace: record.namespace, memoryId: record.id, content: record.content });
  return record;
}

export async function listMemoriesPage(db: D1Database, filters: ListMemoryFilters): Promise<ListMemoryPage> {
  let sql = "SELECT * FROM memories WHERE namespace = ?";
  const binds: unknown[] = [filters.namespace];

  if (filters.type) {
    sql += " AND type = ?";
    binds.push(filters.type);
  }

  if (filters.status) {
    sql += " AND status = ?";
    binds.push(filters.status);
  }

  const offset = Math.max(Math.floor(filters.offset ?? 0), 0);
  const limit = Math.max(Math.floor(filters.limit), 1);
  sql += " ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ? OFFSET ?";
  binds.push(limit + 1, offset);

  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<MemoryRecord>();

  const rows = result.results ?? [];
  const records = rows.slice(0, limit);

  return {
    records,
    hasMore: rows.length > limit,
    nextOffset: rows.length > limit ? offset + records.length : null
  };
}

export async function listMemories(db: D1Database, filters: ListMemoryFilters): Promise<MemoryRecord[]> {
  const page = await listMemoriesPage(db, filters);
  return page.records;
}

export async function getMemoryById(
  db: D1Database,
  input: { namespace: string; id: string }
): Promise<MemoryRecord | null> {
  const record = await db
    .prepare("SELECT * FROM memories WHERE namespace = ? AND id = ?")
    .bind(input.namespace, input.id)
    .first<MemoryRecord>();

  return record ?? null;
}

// D1 hard limit is 100 bound params. namespace takes 1 slot; keep id batches at 90
// so total binds (1 + N) stay under the limit with headroom.
const FETCH_BY_IDS_BATCH_SIZE = 90;

export async function fetchMemoriesByIds(
  db: D1Database,
  input: { namespace: string; ids: string[] }
): Promise<MemoryRecord[]> {
  if (input.ids.length === 0) return [];

  const uniqueIds = [...new Set(input.ids.filter((id) => id.trim()))];
  if (uniqueIds.length === 0) return [];

  const rows: MemoryRecord[] = [];
  for (let index = 0; index < uniqueIds.length; index += FETCH_BY_IDS_BATCH_SIZE) {
    const batch = uniqueIds.slice(index, index + FETCH_BY_IDS_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    const result = await db
      .prepare(`SELECT * FROM memories WHERE namespace = ? AND id IN (${placeholders})`)
      .bind(input.namespace, ...batch)
      .all<MemoryRecord>();
    rows.push(...(result.results ?? []));
  }
  return rows;
}

export interface MemoryWithLifecycle {
  record: MemoryRecord;
  lifecycle: MemoryLifecycleRow | null;
}

type MemoryLifecycleJoinRow = MemoryRecord & {
  lc_memory_id: string | null;
  lc_namespace: string | null;
  lc_fact_key: string | null;
  lc_supersedes_id: string | null;
  lc_superseded_by_id: string | null;
  lc_review_reason: string | null;
  lc_valid_as_of: string | null;
  lc_last_seen_at: string | null;
  lc_seen_count: number | null;
  lc_last_injected_at: string | null;
};

function toMemoryWithLifecycle(row: MemoryLifecycleJoinRow): MemoryWithLifecycle {
  const {
    lc_memory_id,
    lc_namespace,
    lc_fact_key,
    lc_supersedes_id,
    lc_superseded_by_id,
    lc_review_reason,
    lc_valid_as_of,
    lc_last_seen_at,
    lc_seen_count,
    lc_last_injected_at,
    ...record
  } = row;

  const lifecycle =
    lc_memory_id == null
      ? null
      : {
          memory_id: lc_memory_id,
          namespace: lc_namespace ?? record.namespace,
          fact_key: lc_fact_key,
          supersedes_id: lc_supersedes_id,
          superseded_by_id: lc_superseded_by_id,
          review_reason: lc_review_reason,
          valid_as_of: lc_valid_as_of,
          last_seen_at: lc_last_seen_at,
          seen_count: lc_seen_count ?? 0,
          last_injected_at: lc_last_injected_at
        };

  return { record: record as MemoryRecord, lifecycle };
}

export async function fetchMemoriesWithLifecycleByIds(
  db: D1Database,
  input: { namespace: string; ids: string[] }
): Promise<MemoryWithLifecycle[]> {
  if (input.ids.length === 0) return [];

  const uniqueIds = [...new Set(input.ids.filter((id) => id.trim()))];
  if (uniqueIds.length === 0) return [];

  const rows: MemoryWithLifecycle[] = [];
  for (let index = 0; index < uniqueIds.length; index += FETCH_BY_IDS_BATCH_SIZE) {
    const batch = uniqueIds.slice(index, index + FETCH_BY_IDS_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT m.*,
          lc.memory_id AS lc_memory_id,
          lc.namespace AS lc_namespace,
          lc.fact_key AS lc_fact_key,
          lc.supersedes_id AS lc_supersedes_id,
          lc.superseded_by_id AS lc_superseded_by_id,
          lc.review_reason AS lc_review_reason,
          lc.valid_as_of AS lc_valid_as_of,
          lc.last_seen_at AS lc_last_seen_at,
          lc.seen_count AS lc_seen_count,
          lc.last_injected_at AS lc_last_injected_at
         FROM memories m
         LEFT JOIN memory_lifecycle lc ON lc.memory_id = m.id
         WHERE m.namespace = ? AND m.id IN (${placeholders})`
      )
      .bind(input.namespace, ...batch)
      .all<MemoryLifecycleJoinRow>();
    rows.push(...(result.results ?? []).map(toMemoryWithLifecycle));
  }
  return rows;
}

export async function updateMemory(
  db: D1Database,
  input: {
    namespace: string;
    id: string;
    patch: UpdateMemoryInput;
    // 改了正文时旧文本存一版 (memory_revisions)：谁改的、为什么。
    revision?: { by?: string | null; reason?: string | null };
  }
): Promise<MemoryRecord | null> {
  const contentChanged = input.patch.content !== undefined && await saveMemoryRevision(db, {
      namespace: input.namespace,
      memoryId: input.id,
      nextContent: input.patch.content,
      replacedBy: input.revision?.by ?? null,
      reason: input.revision?.reason ?? "edit"
    });
  const assignments: string[] = [];
  const binds: unknown[] = [];

  function set(column: string, value: unknown): void {
    assignments.push(`${column} = ?`);
    binds.push(value);
  }

  if (input.patch.type !== undefined) set("type", input.patch.type);
  if (input.patch.content !== undefined) {
    set("content", input.patch.content);
    if (contentChanged) set("provenance", JSON.stringify(input.patch.provenance) ?? null);
  }
  if (input.patch.summary !== undefined) set("summary", input.patch.summary);
  if (input.patch.importance !== undefined) set("importance", input.patch.importance);
  if (input.patch.confidence !== undefined) set("confidence", input.patch.confidence);
  if (input.patch.status !== undefined) set("status", input.patch.status);
  if (input.patch.pinned !== undefined) set("pinned", input.patch.pinned ? 1 : 0);
  if (input.patch.tags !== undefined) set("tags", JSON.stringify(input.patch.tags));
  if (input.patch.sourceMessageIds !== undefined || contentChanged) set("source_message_ids", JSON.stringify(input.patch.sourceMessageIds ?? []));
  if (input.patch.expiresAt !== undefined) set("expires_at", input.patch.expiresAt);

  if (assignments.length === 0) {
    return getMemoryById(db, input);
  }

  set("updated_at", nowIso());

  await db
    .prepare(`UPDATE memories SET ${assignments.join(", ")} WHERE namespace = ? AND id = ?`)
    .bind(...binds, input.namespace, input.id)
    .run();

  const updated = await getMemoryById(db, input);
  if (updated) {
    const inactive = updated.status === "deleted" || updated.status === "archived" || updated.status === "expired";
    if (inactive) {
      await deleteFtsRow(db, "memory_fts", "memory_id", updated.id);
    } else if (input.patch.content !== undefined || input.patch.summary !== undefined) {
      await upsertMemoryFts(db, {
        namespace: updated.namespace,
        memoryId: updated.id,
        content: `${updated.content}\n${updated.summary ?? ""}`
      });
    }
  }
  return updated;
}

export async function softDeleteMemory(
  db: D1Database,
  input: { namespace: string; id: string }
): Promise<MemoryRecord | null> {
  return updateMemory(db, {
    namespace: input.namespace,
    id: input.id,
    patch: {
      status: "deleted"
    }
  });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function searchMemoriesByText(
  db: D1Database,
  input: {
    namespace: string;
    query: string;
    types?: string[];
    limit: number;
    includeHistory?: boolean;
    tokens?: string[];
  }
): Promise<Array<MemoryRecord & { score: number }>> {
  const query = input.query.trim().replace(/\s+/g, " ").slice(0, 500);
  const tokens = [...new Set((input.tokens ?? []).map((token) => token.trim()).filter((token) => token.length >= 2))].slice(0, 8);
  // LMC-5: default excludes superseded. includeHistory allows status/version_status=superseded
  // (vectors for superseded rows are deleted on supersede, so text path is the history fallback).
  let sql: string;
  if (input.includeHistory) {
    sql =
      "SELECT * FROM memories WHERE namespace = ? AND (status = 'active' OR status = 'superseded')";
  } else {
    sql =
      "SELECT * FROM memories WHERE namespace = ? AND status = 'active' AND (version_status IS NULL OR version_status != 'superseded')";
  }
  const binds: unknown[] = [input.namespace];

  const likeClauses: string[] = [];
  const likeBinds: unknown[] = [];
  if (query.length >= 2) {
    const like = `%${escapeLike(query)}%`;
    likeClauses.push("(content LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\')");
    likeBinds.push(like, like, like, like);
  }
  for (const token of tokens) {
    const like = `%${escapeLike(token)}%`;
    likeClauses.push("(content LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')");
    likeBinds.push(like, like);
  }
  const ftsIds = tokens.length > 0
    ? await searchFtsIds(db, "memory_fts", "memory_id", { namespace: input.namespace, tokens, limit: input.limit })
    : [];
  // SQL placeholders and bind values must stay in the same order.
  // Previous code put `id IN (...)` first in SQL but appended IDs after LIKE binds.
  if (ftsIds.length > 0) {
    sql += ` AND (id IN (${ftsIds.map(() => "?").join(", ")})`;
    binds.push(...ftsIds);
    if (likeClauses.length > 0) {
      sql += ` OR (${likeClauses.join(" OR ")})`;
      binds.push(...likeBinds);
    }
    sql += ")";
  } else if (likeClauses.length > 0) {
    sql += ` AND (${likeClauses.join(" OR ")})`;
    binds.push(...likeBinds);
  }

  if (input.types && input.types.length > 0) {
    sql += ` AND type IN (${input.types.map(() => "?").join(", ")})`;
    binds.push(...input.types);
  }

  sql += " ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?";
  binds.push(input.limit);

  let result: D1Result<MemoryRecord>;
  try {
    result = await db
      .prepare(sql)
      .bind(...binds)
      .all<MemoryRecord>();
  } catch (error) {
    console.error("text memory search failed", error);
    return [];
  }

  return (result.results ?? []).map((record) => ({
    ...record,
    score: lexicalHitScore(`${record.content}\n${record.summary ?? ""}`, query, tokens)
  }));
}

export async function markMemoriesRecalled(
  db: D1Database,
  input: { namespace: string; ids: string[] }
): Promise<void> {
  if (input.ids.length === 0) return;

  const placeholders = input.ids.map(() => "?").join(", ");
  await db
    .prepare(
      `UPDATE memories
       SET last_recalled_at = ?, recall_count = recall_count + 1
       WHERE namespace = ? AND id IN (${placeholders})`
    )
    .bind(nowIso(), input.namespace, ...input.ids)
    .run();
}
