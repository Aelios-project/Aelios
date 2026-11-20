import { nowIso } from "../../../utils/time";

// The dependency closure over memory_derivations, and the logical removals it drives.
// Only cited inputs are edges; context a model merely read (context_refs) never is.

/** Recursive closure seeded from the JSON array bound at `seeds` (namespace is ?1). */
const closure = (seeds: string) => `WITH RECURSIVE affected(ref) AS (
  SELECT value FROM json_each(${seeds})
  UNION SELECT d.entity FROM memory_derivations d JOIN affected a ON a.ref=d.input WHERE d.namespace=?1)`;

/** Visible memories the closure would hide. Read before the transaction, for the caller's report only. */
export async function affectedMemories(db: D1Database, namespace: string, seeds: string[]): Promise<string[]> {
  const rows = await db
    .prepare(`${closure("?2")}
    SELECT m.id FROM affected a JOIN memories m ON m.namespace=?1 AND a.ref='memory:' || m.id
    WHERE m.status NOT IN ('archived','deleted')
      AND NOT EXISTS (SELECT 1 FROM memory_revocations r WHERE r.namespace=?1 AND r.ref=a.ref)`)
    .bind(namespace, JSON.stringify(seeds))
    .all<{ id: string }>();
  return (rows.results ?? []).map((row) => row.id);
}

/**
 * Tombstone `seeds` and everything derived from them, then remove those records from every
 * D1 surface. The last statement settles the batch, so a later, unrelated withdrawal leaves
 * summaries regenerated after this one alone. Run all of it in one D1 batch.
 */
export function closureStatements(db: D1Database, namespace: string, root: string, seeds: string[]): D1PreparedStatement[] {
  const revoked = (entity: string) =>
    `EXISTS (SELECT 1 FROM memory_revocations r WHERE r.namespace=?1 AND r.applying=1 AND r.ref=${entity})`;
  const inRevokedDay = (start: string, end: string) => `EXISTS (SELECT 1 FROM memory_revocations r
    WHERE r.namespace=?1 AND r.applying=1 AND substr(r.ref,1,4)='day:' AND substr(r.ref,5,10) BETWEEN ${start} AND ${end})`;
  const revokedMonths = `SELECT f.month FROM folded_week f WHERE f.namespace=?1 AND ${inRevokedDay("f.start_date", "f.end_date")}`;
  return [
    db
      .prepare(`${closure("?3")}
      INSERT OR IGNORE INTO memory_revocations(namespace,ref,pending)
      SELECT ?1,ref,(ref=?2 OR substr(ref,1,7)='memory:' OR substr(ref,1,9)='longtail:') FROM affected`)
      .bind(namespace, root, JSON.stringify(seeds)),
    db
      .prepare(`UPDATE memories SET status='archived', updated_at=?2 WHERE namespace=?1 AND status NOT IN ('archived','deleted')
      AND ${revoked("'memory:' || memories.id")}`)
      .bind(namespace, nowIso()),
    db.prepare(`DELETE FROM longtail WHERE namespace=?1 AND ${revoked("'longtail:' || longtail.id")}`).bind(namespace),
    db
      .prepare(`DELETE FROM memory_candidates WHERE namespace=?1 AND ${revoked("'candidate:' || memory_candidates.id")}`)
      .bind(namespace),
    db.prepare(`DELETE FROM memory_fts WHERE namespace=?1 AND ${revoked("'memory:' || memory_fts.memory_id")}`).bind(namespace),
    db
      .prepare(`DELETE FROM memory_revisions WHERE namespace=?1 AND EXISTS (SELECT 1 FROM json_each(provenance,'$.inputs') i
      JOIN memory_revocations r ON r.namespace=?1 AND r.applying=1 AND r.ref=i.value)`)
      .bind(namespace),
    db
      .prepare(`DELETE FROM memory_events WHERE namespace=?1 AND event_type='dream_review_proposal' AND EXISTS
      (SELECT 1 FROM json_each(payload_json,'$.message_ids') i JOIN memory_revocations r ON r.namespace=?1 AND r.applying=1 AND r.ref='message:' || i.value)`)
      .bind(namespace),
    db
      .prepare(`DELETE FROM perception_cache WHERE namespace=?1 AND EXISTS (SELECT 1 FROM json_each(items) item
      JOIN memory_revocations r ON r.namespace=?1 AND r.applying=1 AND r.ref='memory:' || json_extract(item.value,'$.id'))`)
      .bind(namespace),
    db.prepare(`DELETE FROM monthly_log WHERE namespace=?1 AND month IN (${revokedMonths})`).bind(namespace),
    // All weeks folded into an invalidated month must become eligible for reconstruction.
    db.prepare(`DELETE FROM folded_week WHERE namespace=?1 AND month IN (${revokedMonths})`).bind(namespace),
    db.prepare(`DELETE FROM weekly_log WHERE namespace=?1 AND ${inRevokedDay("start_date", "end_date")}`).bind(namespace),
    db
      .prepare(`UPDATE daily_log SET needs_rebuild=1, title='', summary='' WHERE namespace=?1
      AND ${revoked("'day:' || daily_log.date || '@' || daily_log.updated_at")}`)
      .bind(namespace),
    db.prepare("UPDATE memory_revocations SET applying=0 WHERE namespace=? AND applying=1").bind(namespace),
  ];
}
