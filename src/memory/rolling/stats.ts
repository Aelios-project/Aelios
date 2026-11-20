import type { Env } from "../../types";
import type { GroundedWindowEvent } from "./apply";
import { laneColumns, staleClaimBefore } from "./inbox";
import { activeRollingLane, rollingMode } from "./settings";

interface RollingWindowStats {
  window_key: string;
  mode: "shadow" | "on";
  status: "completed" | "failed";
  error: string | null;
  attempts: number;
  clef_calls: number;
  extractor_calls: number;
  event_count: number;
  duration_ms: number;
}

interface DateRange {
  namespace: string;
  startIso: string;
  endIso: string;
}

export async function getRollingDreamStatus(env: Env, namespace: string) {
  const lane = activeRollingLane(env);
  const col = laneColumns[lane ?? "on"];
  const db = env.DB;
  const pending = `namespace=? AND rolling_skipped=0 AND done_at IS NULL AND ${col.done} IS NULL`;
  const [backlog, active, recent, failures] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count FROM rolling_inbox WHERE ${pending}`).bind(namespace).first<{ count: number }>(),
    lane ? db.prepare(`SELECT ${col.key} AS window_key,${col.at} AS claimed_at FROM rolling_inbox
      WHERE namespace=? AND ${col.done} IS NULL AND ${col.key} GLOB 'rolling_*' AND ${col.at}>=? ORDER BY seq LIMIT 1`)
      .bind(namespace, staleClaimBefore(env)).first<{ window_key: string; claimed_at: string }>() : null,
    db.prepare(`SELECT payload_json,created_at FROM memory_events WHERE namespace=? AND event_type='rolling_window'
      ORDER BY created_at DESC,id DESC LIMIT 8`).bind(namespace).all<{ payload_json: string; created_at: string }>(),
    db.prepare(`SELECT payload_json,created_at FROM memory_events WHERE namespace=? AND event_type='rolling_window'
      AND json_extract(payload_json,'$.status')='failed' ORDER BY created_at DESC,id DESC LIMIT 8`)
      .bind(namespace).all<{ payload_json: string; created_at: string }>()
  ]);
  const summarize = (rows: typeof recent.results) => rows.map(row => ({
    ...JSON.parse(row.payload_json) as RollingWindowStats, finished_at: row.created_at
  }));
  return {
    mode: rollingMode(env),
    backlog: backlog?.count ?? 0,
    active_window: active,
    recent_windows: summarize(recent.results),
    failed_windows: summarize(failures.results)
  };
}

async function listRollingShadowEvents(db: D1Database, { namespace, startIso, endIso }: DateRange) {
  const rows = await db.prepare(`SELECT e.id,e.payload_json FROM memory_events e
    WHERE e.namespace=?1 AND e.event_type='rolling_shadow'
      AND json_extract(e.payload_json,'$.start_at')<?3
      AND json_extract(e.payload_json,'$.end_at')>=?2
    ORDER BY e.created_at,e.id LIMIT 200`).bind(namespace, startIso, endIso).all<{ id: string; payload_json: string }>();
  const items = rows.results.flatMap(row => {
    const payload = JSON.parse(row.payload_json) as { events: GroundedWindowEvent[]; window_key: string };
    return payload.events.filter(event => event.op !== "no_op").map((event, index) => ({
      id: `${row.id}:${index}`, window_key: payload.window_key, ...event
    }));
  });
  const sources = [...new Set(items.flatMap(item => item.source_message_ids))];
  if (!sources.length) return [];
  const retained = await db.prepare(`SELECT id FROM messages WHERE namespace=? AND id IN (SELECT value FROM json_each(?))`)
    .bind(namespace, JSON.stringify(sources)).all<{ id: string }>();
  const retainedIds = new Set(retained.results.map(row => row.id));
  return items.filter(item => item.source_message_ids.every(id => retainedIds.has(id)));
}

async function listNightlyOutputs(db: D1Database, { namespace, startIso, endIso }: DateRange) {
  const rows = await db.prepare(`WITH day_messages(id) AS (
      SELECT id FROM messages WHERE namespace=?1 AND created_at>=?2 AND created_at<?3
    )
    SELECT c.id,c.content,c.type,c.status,c.created_at FROM memory_candidates c
    WHERE c.namespace=?1 AND c.created_at>=?2 AND c.source IN ('dream_extract','dream_add','dream_update','dream_delete')
      AND json_extract(c.provenance,'$.recording_actor') IS NOT 'rolling_dream'
      AND EXISTS (SELECT 1 FROM json_each(c.source_message_ids) j JOIN day_messages d ON d.id=j.value)
    UNION ALL
    SELECT m.id,m.content,m.type,m.status,m.created_at FROM memories m
    WHERE m.namespace=?1 AND m.created_at>=?2 AND m.source='scoped_decision' AND m.status IN ('active','superseded')
      AND json_extract(m.provenance,'$.recording_actor') IS NOT 'rolling_dream'
      AND EXISTS (SELECT 1 FROM json_each(m.source_message_ids) j JOIN day_messages d ON d.id=j.value)
    ORDER BY created_at,id LIMIT 200`).bind(namespace, startIso, endIso)
    .all<{ id: string; content: string; type: string; status: string; created_at: string }>();
  return rows.results;
}

export async function getRollingHarvest(env: Env, range: DateRange) {
  const shadow = await listRollingShadowEvents(env.DB, range);
  if (!shadow.length && rollingMode(env) !== "shadow") return undefined;
  return { shadow, nightly: await listNightlyOutputs(env.DB, range) };
}
