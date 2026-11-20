import { newId } from "../../utils/ids";
import { nowIso } from "../../utils/time";

// 改写前留旧版。supersede 会新开一条、旧条标 superseded，旧文本本来就在；
// 原地改写 (同 fact_key 再写一遍、后台编辑、候选合并) 是在同一行上 UPDATE，以前旧文本直接没了。
// 这些路径在 UPDATE 之前调 saveMemoryRevision，把当时那一版存进 memory_revisions。
// 只在正文真的变了时存；每条记忆最多留 MAX_REVISIONS_PER_MEMORY 版，再多删最老的。

export const MAX_REVISIONS_PER_MEMORY = 20;

export interface MemoryRevisionRow {
  id: string;
  memory_id: string;
  namespace: string;
  type: string | null;
  content: string;
  tags: string | null;
  importance: number | null;
  confidence: number | null;
  source: string | null;
  provenance: string | null;
  authored_by: string | null;
  source_message_ids: string | null;
  fact_key: string | null;
  written_at: string | null;
  replaced_by: string | null;
  reason: string | null;
  created_at: string;
}

interface CurrentMemoryRow {
  id: string;
  namespace: string;
  type: string | null;
  content: string;
  tags: string | null;
  importance: number | null;
  confidence: number | null;
  source: string | null;
  provenance: string | null;
  authored_by: string | null;
  source_message_ids: string | null;
  fact_key: string | null;
  updated_at: string | null;
}

/**
 * 把这条记忆现在的样子存一版。nextContent 跟现在的正文一样 (去掉首尾空白比) 就不存，返回 false。
 * 写入旧版失败时终止改写，下一次请求可以重试。
 */
export async function saveMemoryRevision(
  db: D1Database,
  input: { namespace: string; memoryId: string; nextContent?: string | null; replacedBy?: string | null; reason?: string | null }
): Promise<boolean> {
  const current = await db
    .prepare(
      `SELECT m.id, m.namespace, m.type, m.content, m.tags, m.importance, m.confidence, m.source,
              m.provenance, m.authored_by, m.source_message_ids, COALESCE(m.fact_key, lc.fact_key) AS fact_key, m.updated_at
       FROM memories m
       LEFT JOIN memory_lifecycle lc ON lc.memory_id = m.id
       WHERE m.namespace = ? AND m.id = ?`
    )
    .bind(input.namespace, input.memoryId)
    .first<CurrentMemoryRow>();
  if (!current) return false;
  if (typeof input.nextContent === "string" && input.nextContent.trim() === current.content.trim()) return false;

  await db
    .prepare(
      `INSERT INTO memory_revisions (
        id, memory_id, namespace, type, content, tags, importance, confidence, source,
        source_message_ids, fact_key, written_at, replaced_by, reason, created_at, provenance, authored_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      newId("rev"),
      current.id,
      current.namespace,
      current.type,
      current.content,
      current.tags,
      current.importance,
      current.confidence,
      current.source,
      current.source_message_ids,
      current.fact_key,
      current.updated_at,
      input.replacedBy ?? null,
      input.reason ?? null,
      nowIso(), current.provenance, current.authored_by
    )
    .run();

  await trimMemoryRevisions(db,current.id).run();
  return true;
}

export function trimMemoryRevisions(db:D1Database, memoryId:string):D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM memory_revisions
       WHERE memory_id = ? AND id NOT IN (
         SELECT id FROM memory_revisions WHERE memory_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
       )`
    )
    .bind(memoryId, memoryId, MAX_REVISIONS_PER_MEMORY);
}

export async function listMemoryRevisions(
  db: D1Database,
  input: { namespace: string; memoryId: string }
): Promise<MemoryRevisionRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM memory_revisions
       WHERE namespace = ? AND memory_id = ?
         AND NOT EXISTS (SELECT 1 FROM memory_revocations r WHERE r.namespace=memory_revisions.namespace
           AND r.ref='memory:' || memory_revisions.memory_id)
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .bind(input.namespace, input.memoryId, MAX_REVISIONS_PER_MEMORY)
    .all<MemoryRevisionRow>();
  return result.results ?? [];
}
