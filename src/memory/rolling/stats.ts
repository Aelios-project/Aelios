import type { Env } from "../../types";
import { staleClaimBefore } from "./inbox";
import { isDaytimeDreamOn } from "./settings";

interface RollingWindowStats {
  window_key: string;
  status: "completed" | "failed";
  error: string | null;
  attempts: number;
  clef_calls: number;
  extractor_calls: number;
  event_count: number;
  duration_ms: number;
}

export async function getRollingDreamStatus(env: Env, namespace: string) {
  const on = isDaytimeDreamOn(env);
  const db = env.DB;
  const [backlog, active, recent, failures] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM rolling_inbox WHERE namespace=? AND rolling_skipped=0 AND done_at IS NULL")
      .bind(namespace).first<{ count: number }>(),
    on ? db.prepare(`SELECT window_key,claimed_at FROM rolling_inbox
      WHERE namespace=? AND done_at IS NULL AND window_key GLOB 'rolling_*' AND claimed_at>=? ORDER BY seq LIMIT 1`)
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
    on,
    backlog: backlog?.count ?? 0,
    active_window: active,
    recent_windows: summarize(recent.results),
    failed_windows: summarize(failures.results)
  };
}
