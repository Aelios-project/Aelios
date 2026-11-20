import { isProvisional } from "../provisional";
import { trimMemoryRevisions } from "../../db/v2/revisions";
import { getMessagesByIds } from "../../db/messages";
import { parseStringArray } from "../../utils/parse";
import type { MemoryRecord } from "../../types";
import type { MemoryCandidateRow } from "../../db/v2";
import { isExplicitMemory, latestEvidenceTime, parseOrigin, reviewedOrigin } from "../provenance";

async function evidenceTime(
  db: D1Database,
  row: Pick<MemoryRecord, "namespace" | "provenance" | "source_message_ids">
) {
  const stored = parseOrigin(row.provenance)?.evidence_at;
  if (stored) return stored;
  const ids = [...new Set(parseStringArray(row.source_message_ids))];
  const rows = await getMessagesByIds(db, { namespace: row.namespace, ids });
  return ids.length && rows.length === ids.length ? latestEvidenceTime(rows) : undefined;
}

/** Called after normal review accepts a Dream decision. Missing or tied chronology cannot select a successor. */
export async function orderDreamDecision(db: D1Database, candidate: MemoryCandidateRow, target: MemoryRecord) {
  const origin = parseOrigin(candidate.provenance);
  const trial = isProvisional({...target, tags:parseStringArray(target.tags), provenance:parseOrigin(target.provenance)});
  if (
    isExplicitMemory(target) ||
    target.status !== "active" ||
    target.version_status === "under_review" ||
    (origin?.attributed_actor !== "user" && !(trial && origin?.attributed_actor === "assistant")) ||
    origin?.evidence_relation !== "paraphrase"
  )
    return "pending";
  const [next, prior] = await Promise.all([evidenceTime(db, candidate), evidenceTime(db, target)]);
  if (!next || !prior || next === prior) return "pending";
  if (next > prior) return "current";
  const provenance = { ...reviewedOrigin(candidate, "judge"), evidence_at: next };
  const insert = db
    .prepare(`INSERT INTO memory_revisions
    (id,memory_id,namespace,type,content,tags,importance,confidence,source,source_message_ids,fact_key,written_at,reason,created_at,provenance)
    SELECT ?,m.id,m.namespace,?,?,?,?,?,'judge',?,?,?,'dream_backfill',?,? FROM memories m
    WHERE m.id=? AND m.namespace=? AND m.status='active'
      AND EXISTS (SELECT 1 FROM memory_candidates c WHERE c.id=? AND c.namespace=m.namespace AND c.status='pending'
        AND c.content=? AND c.provenance IS ?)
    ON CONFLICT(id) DO NOTHING`)
    .bind(
      `rev_${candidate.id}`,
      candidate.type,
      candidate.content,
      candidate.tags,
      candidate.importance,
      candidate.confidence,
      candidate.source_message_ids,
      candidate.fact_key,
      next,
      new Date().toISOString(),
      JSON.stringify(provenance),
      target.id,
      candidate.namespace,
      candidate.id,
      candidate.content,
      candidate.provenance ?? null
    );
  const [result] = await db.batch([insert, trimMemoryRevisions(db, target.id)]);
  if (
    result.meta.changes ||
    (await db
      .prepare("SELECT id FROM memory_revisions WHERE namespace=? AND id=? AND reason='dream_backfill'")
      .bind(candidate.namespace, `rev_${candidate.id}`)
      .first())
  )
    return "history";
  return "pending";
}

/** Combine ordinary supersedes links and in-place/backfill revisions without indexing old answers as current. */
export async function decisionTimelines(
  db: D1Database,
  namespace: string,
  ids: string[]
): Promise<Map<string, string[]>> {
  const timelines = new Map<string, string[]>();
  if (!ids.length) return timelines;
  const rows = await db
    .prepare(`WITH RECURSIVE chain(root,id) AS (
    SELECT id,id FROM memories WHERE namespace=?1 AND id IN (SELECT value FROM json_each(?2)) AND status='active'
    UNION SELECT c.root,m.id FROM memories m JOIN chain c ON m.superseded_by=c.id
      WHERE m.namespace=?1 AND m.status='superseded'
  ), earlier AS (
    SELECT root,m.content,coalesce(json_extract(m.provenance,'$.evidence_at'),m.created_at) AS at,m.id
      FROM chain JOIN memories m USING(id) WHERE m.id<>root
    UNION ALL SELECT c.root,r.content,coalesce(json_extract(r.provenance,'$.evidence_at'),r.written_at,r.created_at),r.id
      FROM memory_revisions r JOIN chain c ON c.id=r.memory_id WHERE r.namespace=?1
  ), ranked AS (
    SELECT root,content,row_number() OVER (PARTITION BY root ORDER BY at DESC,id DESC) AS rank FROM earlier
  ) SELECT root,content FROM ranked WHERE rank<=3 ORDER BY root,rank DESC`)
    .bind(namespace, JSON.stringify(ids))
    .all<{ root: string; content: string }>();
  for (const row of rows.results) {
    const entries = timelines.get(row.root) ?? [];
    entries.push(row.content);
    timelines.set(row.root, entries);
  }
  return timelines;
}
