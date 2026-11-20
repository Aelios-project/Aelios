import type { Env, MessageRecord } from "../../types";
import { newId } from "../../utils/ids";
import { nowIso } from "../../utils/time";
import { staleClaimBefore } from "./inbox";

interface NightlyClaim {
  key: string;
  messageIds: ReadonlySet<string>;
  blocked: boolean;
  leasedIds: string[];
}

export async function listNightlyInboxBacklog(
  db: D1Database, namespace: string, startIso: string, endIso: string, limit: number
): Promise<MessageRecord[]> {
  const rows = await db.prepare(`SELECT m.id,m.conversation_id,m.namespace,m.role,m.content,m.source,m.created_at,m.seq,m.capture_kind
    FROM messages m JOIN rolling_inbox i ON i.namespace=m.namespace AND i.message_id=m.id
    WHERE m.namespace=? AND m.created_at>=? AND m.created_at<? AND i.done_at IS NULL
    ORDER BY m.created_at,m.seq,m.id LIMIT ?`).bind(namespace, startIso, endIso, limit).all<MessageRecord>();
  return rows.results;
}

export async function claimNightlyExtraction(
  env: Env,
  namespace: string,
  messages: MessageRecord[],
  run: { dateLabel: string; dreamRunId: string | null },
  force: boolean
): Promise<NightlyClaim> {
  const key = `nightly:${run.dateLabel}:${run.dreamRunId ?? newId("dream")}`;
  const ids = JSON.stringify(messages.map(message => message.id));
  const before = staleClaimBefore(env);
  const [, rows] = await env.DB.batch<{ message_id: string; window_key: string | null; done_at: string | null }>([
    env.DB.prepare(`WITH busy AS MATERIALIZED (
      SELECT 1 FROM rolling_inbox WHERE namespace=?1 AND done_at IS NULL
        AND (claimed_at>=?3 OR json_extract(progress,'$.committing')=1)
        AND message_id IN (SELECT value FROM json_each(?2)) LIMIT 1
    ), abandoned(key) AS MATERIALIZED (
      SELECT DISTINCT window_key FROM rolling_inbox WHERE namespace=?1 AND done_at IS NULL
        AND window_key GLOB 'rolling_*' AND message_id IN (SELECT value FROM json_each(?2))
    )
    UPDATE rolling_inbox SET
      window_key=CASE WHEN message_id IN (SELECT value FROM json_each(?2)) THEN ?4 ELSE NULL END,
      claimed_at=CASE WHEN message_id IN (SELECT value FROM json_each(?2)) THEN ?5 ELSE NULL END,
      progress=NULL,attempts=0
    WHERE namespace=?1 AND (message_id IN (SELECT value FROM json_each(?2)) OR window_key IN abandoned)
      AND done_at IS NULL AND NOT EXISTS (SELECT 1 FROM busy)`)
      .bind(namespace, ids, before, key, nowIso()),
    env.DB.prepare(`SELECT message_id,window_key,done_at FROM rolling_inbox
      WHERE namespace=? AND message_id IN (SELECT value FROM json_each(?))`).bind(namespace, ids),
    env.DB.prepare(`DELETE FROM memory_events AS e WHERE e.namespace=? AND e.event_type='rolling_draft'
      AND NOT EXISTS (SELECT 1 FROM rolling_inbox i WHERE i.namespace=e.namespace
        AND i.window_key=json_extract(e.payload_json,'$.window_key') AND i.done_at IS NULL)`).bind(namespace)
  ]);
  const ledger = new Map(rows.results.map(row => [row.message_id, row]));
  const blocked = rows.results.some(row => !row.done_at && row.window_key !== key);
  const messageIds = new Set(messages.flatMap(message => {
    const row = ledger.get(message.id);
    return !row || row.window_key === key || (force && row.done_at && row.window_key?.startsWith("nightly:"))
      ? [message.id] : [];
  }));
  const leasedIds = rows.results.filter(row => row.window_key === key && !row.done_at).map(row => row.message_id);
  return { key, messageIds, blocked, leasedIds };
}

export async function refreshNightlyClaim(
  db: D1Database, namespace: string, claim: NightlyClaim | null, processed: string[]
): Promise<D1PreparedStatement | undefined> {
  if (!claim?.leasedIds.length) return undefined;
  const ids = claim.leasedIds.filter(id => processed.includes(id));
  if (!ids.length) return undefined;
  const jsonIds = JSON.stringify(ids);
  const guard = db.prepare(`SELECT CASE WHEN ?=(
      SELECT COUNT(*) FROM rolling_inbox WHERE namespace=? AND window_key=? AND done_at IS NULL
      AND message_id IN (SELECT value FROM json_each(?))
    ) THEN 1 ELSE json('nightly lease lost') END`).bind(ids.length, namespace, claim.key, jsonIds);
  await db.batch([
    guard,
    db.prepare("UPDATE rolling_inbox SET claimed_at=? WHERE namespace=? AND window_key=? AND done_at IS NULL")
      .bind(nowIso(), namespace, claim.key)
  ]);
  return guard;
}

export async function markNightlyExtracted(
  db: D1Database, namespace: string, claim: NightlyClaim | null, processed: string[]
): Promise<void> {
  if (!claim?.leasedIds.length) return;
  await db.prepare(`UPDATE rolling_inbox SET done_at=?,error=NULL
    WHERE namespace=? AND window_key=? AND done_at IS NULL AND message_id IN (SELECT value FROM json_each(?))`)
    .bind(nowIso(), namespace, claim.key, JSON.stringify(processed)).run();
}

export async function releaseNightlyExtraction(db: D1Database, namespace: string, claim: NightlyClaim | null): Promise<void> {
  if (!claim?.leasedIds.length) return;
  await db.prepare(`UPDATE rolling_inbox SET window_key=NULL,claimed_at=NULL
    WHERE namespace=? AND window_key=? AND done_at IS NULL`)
    .bind(namespace, claim.key).run();
}
