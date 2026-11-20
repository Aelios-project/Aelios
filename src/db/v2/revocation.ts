import type { Env } from "../../types";
import { affectedMemories, closureStatements } from "./revocation/closure";
import { detachStatements, rawRowStatements } from "./revocation/detach";
import { finishExternalCleanup } from "./revocation/external";
import { splitLegacyCoReaders } from "./revocation/legacy";

// Two ways to remove a source. Cleaning drops a raw line and the links to it. Withdrawal also
// hides what is known to depend on it: records that cite it, and older rows that copy its text.
// Neither follows context a model only read. Neither is cryptographic erasure.

type Source = { namespace: string; id: string };

export interface WithdrawalReport {
  /** Memories hidden because they cite, derive from or copy the withdrawn source. */
  withdrawn: string[];
  /** Pre-provenance memories that only shared a Dream batch with it: kept and detached. */
  unverified: string[];
}

async function isWithdrawable(db: D1Database, namespace: string, id: string, ref: string, kind: "message" | "memory") {
  const present =
    kind === "message"
      ? "SELECT id FROM messages WHERE namespace=?1 AND id=?2 UNION ALL SELECT id FROM chat_archive WHERE namespace=?1 AND id=?2"
      : "SELECT id FROM memories WHERE namespace=?1 AND id=?2";
  const root = await db
    .prepare(`SELECT 1 FROM (${present} UNION ALL SELECT ref FROM memory_revocations
    WHERE namespace=?1 AND ref=?3 AND pending=1) LIMIT 1`)
    .bind(namespace, id, ref)
    .first();
  if (root) return true;
  // Retention may already have removed the raw row while derived records still cite its ID.
  const linked = await db
    .prepare(`SELECT 1 FROM memory_derivations WHERE namespace=?1 AND input=?2
    AND NOT EXISTS (SELECT 1 FROM memory_revocations WHERE namespace=?1 AND ref=?2) LIMIT 1`)
    .bind(namespace, ref)
    .first();
  return Boolean(linked);
}

/**
 * Withdraw a source and its known dependants. Returns null when there is nothing to withdraw.
 * D1 removals commit in one batch first; external indexes follow and may be retried.
 */
export async function invalidateKnownInputs(
  env: Env,
  source: Source,
  kind: "message" | "memory",
): Promise<WithdrawalReport | null> {
  const { namespace, id } = source;
  const db = env.DB;
  const ref = `${kind}:${id}`;
  if (!(await isWithdrawable(db, namespace, id, ref, kind))) return null;
  const legacy = kind === "message" ? await splitLegacyCoReaders(db, namespace, id) : { copied: [], unverified: [] };
  const seeds = [ref, ...legacy.copied.map((memoryId) => `memory:${memoryId}`)];
  const withdrawn = await affectedMemories(db, namespace, seeds);
  await db.batch([
    ...closureStatements(db, namespace, ref, seeds),
    ...(kind === "message" ? [...rawRowStatements(db, namespace, id), ...detachStatements(db, namespace, id)] : []),
  ]);
  await finishExternalCleanup(env, namespace, ref);
  return { withdrawn, unverified: legacy.unverified };
}

/** Clean one raw line (the released DELETE route). A later withdrawal still follows provenance inputs. */
export async function cleanRawMessage(db: D1Database, namespace: string, id: string): Promise<boolean> {
  const [message, archive] = await db.batch([...rawRowStatements(db, namespace, id), ...detachStatements(db, namespace, id)]);
  return Boolean(message.meta.changes || archive.meta.changes);
}

export async function revokedMemoryIds(db: D1Database, namespace: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db
    .prepare(`SELECT j.value AS id FROM json_each(?) j JOIN memory_revocations r
    ON r.namespace=? AND r.ref='memory:' || j.value`)
    .bind(JSON.stringify(ids), namespace)
    .all<{ id: string }>();
  return new Set(rows.results.map((row) => row.id));
}
