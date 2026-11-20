import { nowIso } from "../../utils/time";
import type { GroundedWindow } from "./apply";
import { laneColumns, type RollingClaim } from "./inbox";
import { windowTimes } from "./payload";
import type { RollingState } from "./state";

interface StateWrite {
  name: string;
  value: string | null;
  state: RollingState;
}

function guard(claim: RollingClaim, at = claim.at, state?: StateWrite) {
  const col = laneColumns[claim.lane];
  return {
    sql: `? = (SELECT COUNT(*) FROM rolling_inbox WHERE namespace=? AND ${col.key}=? AND ${col.at}=? AND ${col.done} IS NULL)
      ${state ? "AND (SELECT value FROM processing_cursors WHERE name=?) IS ?" : ""}`,
    args: [claim.rows.length, claim.namespace, claim.key, at, ...(state ? [state.name, state.value] : [])]
  };
}

function checkpoint(db: D1Database, claim: RollingClaim, at: string | null, state?: StateWrite): D1PreparedStatement {
  const col = laneColumns[claim.lane];
  const owned = guard(claim, claim.at, state);
  return db.prepare(`UPDATE rolling_inbox SET ${col.progress}=?,${col.at}=?
    WHERE namespace=? AND ${col.key}=? AND ${col.at}=? AND ${col.done} IS NULL AND ${owned.sql}`)
    .bind(JSON.stringify(claim.progress), at, claim.namespace, claim.key, claim.at, ...owned.args);
}

function audit(
  db: D1Database, claim: RollingClaim, id: string, type: string, payload: unknown, at: string, state?: StateWrite
): D1PreparedStatement {
  const owned = guard(claim, claim.at, state);
  return db.prepare(`INSERT INTO memory_events(id,namespace,event_type,memory_id,payload_json,created_at)
    SELECT ?,?,?,NULL,?,? WHERE ${owned.sql} ON CONFLICT(id) DO NOTHING`)
    .bind(id, claim.namespace, type, JSON.stringify(payload), at, ...owned.args);
}

export async function saveRollingProgress(db: D1Database, claim: RollingClaim, retry = false): Promise<boolean> {
  const at = retry ? null : nowIso();
  const result = await checkpoint(db, claim, at).run();
  if (result.meta.changes && at) claim.at = at;
  return Boolean(result.meta.changes);
}

export async function releaseInterruptedWindow(db: D1Database, claim: RollingClaim): Promise<boolean> {
  const col = laneColumns[claim.lane];
  const result = await db.prepare(`UPDATE rolling_inbox SET ${col.at}=NULL
    WHERE namespace=? AND ${col.key}=? AND ${col.at}=? AND ${col.done} IS NULL`)
    .bind(claim.namespace, claim.key, claim.at).run();
  return Boolean(result.meta.changes);
}

export async function saveShadowPart(
  db: D1Database,
  claim: RollingClaim,
  part: number,
  grounded: GroundedWindow,
  state: StateWrite
): Promise<boolean> {
  const at = nowIso();
  const owned = guard(claim, at, state);
  const range = windowTimes(claim.rows);
  const [, saved] = await db.batch([
    audit(db, claim, `evt_${claim.key}_part_${part}`, "rolling_shadow", {
      window_key: claim.key,
      part,
      message_ids: claim.rows.map(row => row.id),
      start_at: range?.start,
      end_at: range?.end,
      triage: claim.progress.triage,
      events: grounded.events
    }, at, state),
    checkpoint(db, claim, at, state),
    db.prepare(`INSERT INTO processing_cursors(name,value,updated_at)
      SELECT ?,?,? WHERE ${owned.sql}
      ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .bind(state.name, JSON.stringify(state.state), at, ...owned.args)
  ]);
  if (saved.meta.changes) claim.at = at;
  return Boolean(saved.meta.changes);
}

export async function finishRollingWindow(db: D1Database, claim: RollingClaim, error?: string): Promise<boolean> {
  const col = laneColumns[claim.lane];
  const at = nowIso();
  const owned = guard(claim);
  const [, finished] = await db.batch([
    audit(db, claim, `evt_${claim.key}`, "rolling_window", {
      window_key: claim.key,
      mode: claim.lane,
      status: error ? "failed" : "completed",
      error: error ?? null,
      attempts: claim.attempts,
      triage: claim.progress.triage ?? null,
      clef_calls: claim.progress.clefCalls,
      extractor_calls: claim.progress.extractorCalls,
      event_count: claim.progress.eventCount,
      duration_ms: Date.parse(at) - Date.parse(claim.progress.startedAt)
    }, at),
    db.prepare(`UPDATE rolling_inbox SET ${col.done}=?,${col.progress}=NULL,${col.error}=?
      WHERE namespace=? AND ${col.key}=? AND ${col.at}=? AND ${col.done} IS NULL AND ${owned.sql}`)
      .bind(at, error ?? null, claim.namespace, claim.key, claim.at, ...owned.args)
  ]);
  return Boolean(finished.meta.changes);
}
