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

function guard(claim: RollingClaim, at = claim.at, state?: StateWrite, doneAt: string | null = null) {
  const col = laneColumns[claim.lane];
  return {
    sql: `? = (SELECT COUNT(*) FROM rolling_inbox WHERE namespace=? AND ${col.key}=? AND ${col.at}=? AND ${col.done} IS ?)
      ${state ? "AND (SELECT value FROM processing_cursors WHERE name=?) IS ?" : ""}`,
    args: [claim.rows.length, claim.namespace, claim.key, at, doneAt, ...(state ? [state.name, state.value] : [])]
  };
}

/** Included in the same D1 batch as a memory write so an expired or deleted lease aborts the batch. */
export function assertRollingLease(db: D1Database, claim: RollingClaim): D1PreparedStatement {
  const owned = guard(claim);
  return db.prepare(`SELECT CASE WHEN ${owned.sql} THEN 1 ELSE json('rolling lease lost') END`)
    .bind(...owned.args);
}

function writeState(db: D1Database, state: StateWrite, at: string, owned: ReturnType<typeof guard>): D1PreparedStatement {
  return db.prepare(`INSERT INTO processing_cursors(name,value,updated_at)
    SELECT ?,?,? WHERE ${owned.sql}
    ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(state.name, JSON.stringify(state.state), at, ...owned.args);
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
    writeState(db, state, at, owned)
  ]);
  if (saved.meta.changes) claim.at = at;
  return Boolean(saved.meta.changes);
}

export interface RollingDraft {
  part: number;
  grounded: GroundedWindow;
  recall_ids: string[];
}

export async function saveRollingDraft(db: D1Database, claim: RollingClaim, draft: RollingDraft): Promise<boolean> {
  const at = nowIso();
  const [, saved] = await db.batch([
    audit(db, claim, `evt_${claim.key}_draft_${draft.part}`, "rolling_draft", {
      window_key: claim.key, ...draft
    }, at),
    checkpoint(db, claim, at)
  ]);
  if (saved.meta.changes) claim.at = at;
  return Boolean(saved.meta.changes);
}

export async function loadRollingDrafts(db: D1Database, claim: RollingClaim): Promise<RollingDraft[]> {
  if (!claim.progress.completed.length) return [];
  const ids = claim.progress.completed.map(part => `evt_${claim.key}_draft_${part}`);
  const rows = await db.prepare(`SELECT payload_json FROM memory_events WHERE namespace=? AND event_type='rolling_draft'
    AND id IN (SELECT value FROM json_each(?))`).bind(claim.namespace, JSON.stringify(ids)).all<{ payload_json: string }>();
  if (rows.results.length !== ids.length) throw new Error("Rolling drafts missing");
  return rows.results.map(row => JSON.parse(row.payload_json) as RollingDraft).sort((a, b) => a.part - b.part);
}

export async function finishRollingWindow(db: D1Database, claim: RollingClaim, error?: string, state?: StateWrite): Promise<boolean> {
  const col = laneColumns[claim.lane];
  const at = nowIso();
  const owned = guard(claim, claim.at, state);
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
      .bind(at, error ?? null, claim.namespace, claim.key, claim.at, ...owned.args),
    ...(state ? [writeState(db, state, at, guard(claim, claim.at, state, at))] : []),
    ...(claim.lane === "on" && claim.progress.completed.length ? [db.prepare(`DELETE FROM memory_events
      WHERE namespace=? AND event_type='rolling_draft' AND id GLOB ? AND ${guard(claim, claim.at, undefined, at).sql}`)
      .bind(claim.namespace, `evt_${claim.key}_draft_*`, ...guard(claim, claim.at, undefined, at).args)] : [])
  ]);
  return Boolean(finished.meta.changes);
}
