import { nowIso } from "../../utils/time";
import type { Env } from "../../types";
import { deleteTriggerVectors } from "../../memory/triggers/store";
import { deleteLongtail } from "./longtail";
import { listTriggersForMemory } from "./triggers";

type Source = { namespace: string; id: string };

// This scan runs on an explicit forget only. RAISE guards in 0023 cover a
// candidate or model result that was already in flight when this batch ran.
export async function invalidateKnownInputs(
  env: Env,
  source: Source,
  kind: "message" | "memory",
): Promise<boolean> {
  const { namespace, id } = source;
  const db = env.DB;
  const ref = `${kind}:${id}`;
  const present =
    kind === "message"
      ? "SELECT id FROM messages WHERE namespace=?1 AND id=?2 UNION ALL SELECT id FROM chat_archive WHERE namespace=?1 AND id=?2"
      : "SELECT id FROM memories WHERE namespace=?1 AND id=?2";
  const root = await db
    .prepare(`SELECT 1 FROM (${present} UNION ALL SELECT ref FROM memory_revocations
    WHERE namespace=?1 AND ref=?3 AND pending=1) LIMIT 1`)
    .bind(namespace, id, ref)
    .first();
  if (!root) {
    // Retention may already have removed the raw row while derived records still cite its ID.
    const linked = await db
      .prepare(`SELECT 1 FROM memory_derivations WHERE namespace=?1 AND input=?2
      AND NOT EXISTS (SELECT 1 FROM memory_revocations WHERE namespace=?1 AND ref=?2) LIMIT 1`)
      .bind(namespace, ref)
      .first();
    if (!linked) return false;
  }

  const revoked = (entity: string) =>
    `EXISTS (SELECT 1 FROM memory_revocations r WHERE r.namespace=?1 AND r.applying=1 AND r.ref=${entity})`;
  const statements = [
    db
      .prepare(`WITH RECURSIVE affected(ref) AS (
      SELECT ?2 UNION SELECT d.entity FROM memory_derivations d JOIN affected a ON a.ref=d.input
      WHERE d.namespace=?1)
      INSERT OR IGNORE INTO memory_revocations(namespace,ref,pending) SELECT ?1,ref,(ref=?2 OR substr(ref,1,7)='memory:' OR substr(ref,1,9)='longtail:') FROM affected`)
      .bind(namespace, ref),
    db
      .prepare(`UPDATE memories SET status='archived', updated_at=?2 WHERE namespace=?1 AND status NOT IN ('archived','deleted')
      AND ${revoked("'memory:' || memories.id")}`)
      .bind(namespace, nowIso()),
    db
      .prepare(`DELETE FROM longtail WHERE namespace=?1 AND ${revoked("'longtail:' || longtail.id")}`)
      .bind(namespace),
    db
      .prepare(
        `DELETE FROM memory_candidates WHERE namespace=?1 AND ${revoked("'candidate:' || memory_candidates.id")}`,
      )
      .bind(namespace),
    db
      .prepare(
        `DELETE FROM memory_fts WHERE namespace=?1 AND ${revoked("'memory:' || memory_fts.memory_id")}`,
      )
      .bind(namespace),
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
    db
      .prepare(`DELETE FROM monthly_log WHERE namespace=?1 AND month IN (SELECT month FROM folded_week f
      JOIN memory_revocations r ON r.namespace=f.namespace AND r.applying=1 AND substr(r.ref,1,4)='day:'
      AND substr(r.ref,5,10) BETWEEN f.start_date AND f.end_date WHERE f.namespace=?1)`)
      .bind(namespace),
    // All weeks folded into an invalidated month must become eligible for reconstruction.
    db.prepare(`DELETE FROM folded_week WHERE namespace=?1 AND month IN
      (SELECT f.month FROM folded_week f JOIN memory_revocations r ON r.namespace=f.namespace AND r.applying=1
       AND substr(r.ref,1,4)='day:' AND substr(r.ref,5,10) BETWEEN f.start_date AND f.end_date WHERE f.namespace=?1)`).bind(namespace),
    db
      .prepare(`DELETE FROM weekly_log WHERE namespace=?1 AND EXISTS (SELECT 1 FROM memory_revocations r
      WHERE r.namespace=?1 AND r.applying=1 AND substr(r.ref,1,4)='day:' AND substr(r.ref,5,10) BETWEEN start_date AND end_date)`)
      .bind(namespace),
    db
      .prepare(
        `UPDATE daily_log SET needs_rebuild=1, title='', summary='' WHERE namespace=?1 AND ${revoked("'day:' || daily_log.date || '@' || daily_log.updated_at")}`,
      )
      .bind(namespace),
  ];
  if (kind === "message") {
    statements.push(
      db.prepare("DELETE FROM messages WHERE namespace=? AND id=?").bind(namespace, id),
      db.prepare("DELETE FROM message_fts WHERE namespace=? AND message_id=?").bind(namespace, id),
      db.prepare("DELETE FROM chat_archive WHERE namespace=? AND id=?").bind(namespace, id),
    );
  }
  // A later, unrelated forget must leave regenerated summaries alone. D1 commits
  // the marker and all logical removals in this same transaction.
  statements.push(db.prepare("UPDATE memory_revocations SET applying=0 WHERE namespace=? AND applying=1").bind(namespace));
  await db.batch(statements);
  // Keep trigger IDs until deletion succeeds. A retry can finish all outstanding
  // cleanup in this namespace even after the original message has disappeared.
  const pending = await db
    .prepare(`SELECT r.ref, m.id, m.vector_id FROM memory_revocations r JOIN memories m
    ON m.namespace=r.namespace AND r.ref='memory:' || m.id WHERE r.namespace=? AND r.pending=1`)
    .bind(namespace)
    .all<{ ref: string; id: string; vector_id: string | null }>();
  for (const row of pending.results ?? []) {
    const triggers = await listTriggersForMemory(db, row.id);
    await deleteTriggerVectors(
      env,
      triggers.flatMap((t) => (t.vector_id ? [t.vector_id] : [])),
    );
    if (row.vector_id) await env.VECTORIZE?.deleteByIds([row.vector_id]);
    await db.batch([
      db.prepare("DELETE FROM memory_triggers WHERE namespace=? AND memory_id=?").bind(namespace, row.id),
      db
        .prepare("UPDATE memory_revocations SET pending=0 WHERE namespace=? AND ref=?")
        .bind(namespace, row.ref),
    ]);
  }
  const tails = await db
    .prepare(
      "SELECT ref FROM memory_revocations WHERE namespace=? AND pending=1 AND substr(ref,1,9)='longtail:'",
    )
    .bind(namespace)
    .all<{ ref: string }>();
  for (const row of tails.results) {
    if ((await deleteLongtail(env, { namespace, id: row.ref.slice(9) })) === "vector_error")
      throw new Error("longtail cleanup pending");
    await db
      .prepare("UPDATE memory_revocations SET pending=0 WHERE namespace=? AND ref=?")
      .bind(namespace, row.ref)
      .run();
  }
  await db
    .prepare("UPDATE memory_revocations SET pending=0 WHERE namespace=? AND ref=?")
    .bind(namespace, ref)
    .run();
  return true;
}

/** Clean one raw line in the released DELETE route. Later explicit withdrawal can still
 * follow its cited provenance inputs, even when the raw row is already gone. */
export async function cleanRawMessage(db: D1Database, namespace: string, id: string): Promise<boolean> {
  const statements = ["memories", "memory_candidates", "memory_revisions", "longtail", "daily_log"].map(table =>
    db.prepare(`UPDATE ${table} SET source_message_ids=(
      SELECT json_group_array(value) FROM json_each(source_message_ids) WHERE value<>?2)
      WHERE namespace=?1 AND json_valid(source_message_ids)
        AND EXISTS (SELECT 1 FROM json_each(source_message_ids) WHERE value=?2)`).bind(namespace, id));
  const [message, archive] = await db.batch([
    db.prepare("DELETE FROM messages WHERE namespace=? AND id=?").bind(namespace, id),
    db.prepare("DELETE FROM chat_archive WHERE namespace=? AND id=?").bind(namespace, id),
    db.prepare("DELETE FROM message_fts WHERE namespace=? AND message_id=?").bind(namespace, id),
    ...statements
  ]);
  return Boolean(message.meta.changes || archive.meta.changes);
}

export async function revokedMemoryIds(
  db: D1Database,
  namespace: string,
  ids: string[],
): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db
    .prepare(`SELECT j.value AS id FROM json_each(?) j JOIN memory_revocations r
    ON r.namespace=? AND r.ref='memory:' || j.value`)
    .bind(JSON.stringify(ids), namespace)
    .all<{ id: string }>();
  return new Set(rows.results.map((row) => row.id));
}
