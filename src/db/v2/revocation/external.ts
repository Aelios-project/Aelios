import { deleteTriggerVectors } from "../../../memory/triggers/store";
import type { Env } from "../../../types";
import { deleteLongtail } from "../longtail";
import { listTriggersForMemory } from "../triggers";

// Indexes outside D1. Their tombstones stay `pending=1` until removal succeeds, so a retry,
// even after the raw row is gone, finishes every outstanding cleanup in the namespace.

export async function finishExternalCleanup(env: Env, namespace: string, root: string): Promise<void> {
  const db = env.DB;
  const settle = (ref: string) =>
    db.prepare("UPDATE memory_revocations SET pending=0 WHERE namespace=? AND ref=?").bind(namespace, ref);

  const memories = await db
    .prepare(`SELECT r.ref, m.id, m.vector_id FROM memory_revocations r JOIN memories m
    ON m.namespace=r.namespace AND r.ref='memory:' || m.id WHERE r.namespace=? AND r.pending=1`)
    .bind(namespace)
    .all<{ ref: string; id: string; vector_id: string | null }>();
  for (const row of memories.results ?? []) {
    const triggers = await listTriggersForMemory(db, row.id);
    await deleteTriggerVectors(env, triggers.flatMap((t) => (t.vector_id ? [t.vector_id] : [])));
    if (row.vector_id) await env.VECTORIZE?.deleteByIds([row.vector_id]);
    await db.batch([
      db.prepare("DELETE FROM memory_triggers WHERE namespace=? AND memory_id=?").bind(namespace, row.id),
      settle(row.ref),
    ]);
  }

  const tails = await db
    .prepare("SELECT ref FROM memory_revocations WHERE namespace=? AND pending=1 AND substr(ref,1,9)='longtail:'")
    .bind(namespace)
    .all<{ ref: string }>();
  for (const row of tails.results ?? []) {
    if ((await deleteLongtail(env, { namespace, id: row.ref.slice(9) })) === "vector_error") {
      throw new Error("longtail cleanup pending");
    }
    await settle(row.ref).run();
  }
  await settle(root).run();
}
