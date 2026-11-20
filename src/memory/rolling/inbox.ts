import { DREAM_RUN_STALE_MS } from "../../db/dreamRuns";
import { identityNamespace, isMainModel, loadConfig, type Identity } from "../../gateway/config";
import type { Env, RollingWindowQueueMessage } from "../../types";
import { sha256Hex } from "../../utils/hash";
import { nowIso } from "../../utils/time";
import { readDreamModel } from "../dreamEnv";
import { activeRollingLane, rollingSettings, type RollingLane } from "./settings";
import type { TriageAnswers } from "./triage";
import { codePointLength, pickWindow, type InboxMessage } from "./window";

const STAGE_VERSION = "rolling-v1";
const MAX_QUEUE_DELAY_SECONDS = 86_400;

export const laneColumns = {
  on: { key: "window_key", at: "claimed_at", attempts: "attempts", progress: "progress", done: "done_at", error: "error" },
  shadow: { key: "shadow_window_key", at: "shadow_claimed_at", attempts: "shadow_attempts", progress: "shadow_progress", done: "shadow_done_at", error: "shadow_error" }
} as const;

interface WindowProgress {
  model: string;
  chars: number;
  startedAt: string;
  triage?: TriageAnswers | null;
  extract?: boolean;
  completed: string[];
  clefCalls: number;
  extractorCalls: number;
  eventCount: number;
  committing?: boolean;
}

export interface RollingClaim {
  namespace: string;
  lane: RollingLane;
  key: string;
  at: string;
  rows: InboxMessage[];
  attempts: number;
  progress: WindowProgress;
}

interface InboxHead {
  inbox_seq: number;
  id: string;
  chars: number;
  source: string | null;
  role: string;
  capture_kind: string | null;
  upstream_model: string | null;
  request_model: string | null;
}

interface ExistingWindow {
  key: string;
  at: string | null;
  progress: string;
}

export function staleClaimBefore(env: Env): string {
  return new Date(Date.now() - rollingSettings(env).claimTtlMinutes * 60_000).toISOString();
}

export function staleNightlyClaimBefore(): string {
  return new Date(Date.now() - DREAM_RUN_STALE_MS).toISOString();
}

function eligible(row: InboxHead, identities: Identity[]): boolean {
  if (/^(?:github|import|aelios-resident:)/i.test(row.source ?? "")) return false;
  if (row.role === "assistant" && row.capture_kind === "includes_tool") return false;
  if (!row.source?.startsWith("gateway:")) return true;
  const slug = row.source.slice("gateway:".length);
  const identity = identities.find((entry) => entry.slug === slug);
  // Older queued exchanges stored the profile in request_model.
  const model = row.request_model && row.request_model !== slug ? row.request_model : row.upstream_model;
  return Boolean(identity && model && isMainModel(identity, model)
    && (row.role !== "assistant" || row.capture_kind === "visible"));
}

function available(lane: RollingLane): string {
  const col = laneColumns[lane];
  return `i.rolling_skipped=0 AND i.done_at IS NULL AND i.${col.done} IS NULL
    AND (i.${col.key} IS NULL${lane === "on" ? " OR i.window_key LIKE 'nightly:%'" : ""})`;
}

async function existingWindow(env: Env, namespace: string, lane: RollingLane): Promise<ExistingWindow | null> {
  const col = laneColumns[lane];
  return env.DB.prepare(`SELECT ${col.key} AS key,${col.at} AS at,${col.progress} AS progress
    FROM rolling_inbox WHERE namespace=? AND ${col.done} IS NULL AND ${col.key} GLOB 'rolling_*'
    ORDER BY seq LIMIT 1`).bind(namespace).first<ExistingWindow>();
}

export async function scheduleRollingWindow(env: Env, namespace: string): Promise<void> {
  const lane = activeRollingLane(env);
  if (!lane || !env.MEMORY_QUEUE) return;
  const window = await existingWindow(env, namespace, lane);
  if (window?.at && window.at >= staleClaimBefore(env)) return;
  const limits = rollingSettings(env);
  const ready = window ?? await env.DB.prepare(`SELECT COUNT(*) FROM (
    SELECT length(m.content) AS chars FROM rolling_inbox i
    JOIN messages m ON m.namespace=i.namespace AND m.id=i.message_id
    WHERE i.namespace=? AND ${available(lane)} ORDER BY i.seq LIMIT ?
  ) HAVING COUNT(*)>=? OR SUM(chars)>=?`)
    .bind(namespace, limits.messages, limits.messages, limits.chars).first();
  if (ready) await enqueueRollingWindow(env, namespace);
}

export async function enqueueRollingWindow(env: Env, namespace: string, delaySeconds?: number): Promise<void> {
  const job: RollingWindowQueueMessage = { type: "rolling_window", namespace };
  await env.MEMORY_QUEUE?.send(job, delaySeconds ? { delaySeconds: Math.min(delaySeconds, MAX_QUEUE_DELAY_SECONDS) } : undefined);
}

export function scheduleRollingAfterRequest(env: Env, ctx: ExecutionContext, namespace: string): void {
  if (!activeRollingLane(env) || !env.MEMORY_QUEUE) return;
  ctx.waitUntil(scheduleRollingWindow(env, namespace).catch(() =>
    console.warn("rolling: could not schedule window", { namespace })
  ));
}

async function pendingHeads(env: Env, namespace: string, lane: RollingLane): Promise<InboxHead[]> {
  const limits = rollingSettings(env);
  let identities: Identity[] | undefined;
  const picked: InboxHead[] = [];
  let after = 0;
  let chars = 0;
  const pageSize = Math.max(limits.messages, 32);
  // Read lengths and capture metadata first. Oversized originals are fetched only once claimed.
  for (;;) {
    const page = await env.DB.prepare(`SELECT i.seq AS inbox_seq,m.id,length(m.content) AS chars,
      m.source,m.role,m.capture_kind,m.upstream_model,m.request_model FROM rolling_inbox i
      JOIN messages m ON m.namespace=i.namespace AND m.id=i.message_id
      WHERE i.namespace=? AND i.seq>? AND ${available(lane)}
      ORDER BY i.seq LIMIT ?`).bind(namespace, after, pageSize).all<InboxHead>();
    const skipped: number[] = [];
    for (const row of page.results) {
      if (!identities && row.source?.startsWith("gateway:")) {
        identities = (await loadConfig(env)).identities.filter((identity) => identityNamespace(identity) === namespace);
      }
      if (!eligible(row, identities ?? [])) {
        skipped.push(row.inbox_seq);
        continue;
      }
      picked.push(row);
      chars += row.chars;
      if (picked.length >= limits.messages || chars >= limits.chars) break;
    }
    if (skipped.length) {
      await env.DB.prepare(`UPDATE rolling_inbox SET rolling_skipped=1
        WHERE namespace=? AND seq IN (SELECT value FROM json_each(?))`)
        .bind(namespace, JSON.stringify(skipped)).run();
    }
    if (picked.length >= limits.messages || chars >= limits.chars || page.results.length < pageSize) {
      return pickWindow(picked, limits);
    }
    after = page.results[page.results.length - 1].inbox_seq;
  }
}

export async function claimRollingWindow(env: Env, namespace: string, lane: RollingLane, resumeKey?: string): Promise<{
  claim?: RollingClaim;
  retryAfter?: number;
}> {
  const col = laneColumns[lane];
  const before = staleClaimBefore(env);
  const at = nowIso();
  const existing = await existingWindow(env, namespace, lane);
  if (resumeKey && existing?.key !== resumeKey) return {};
  if (existing?.at && existing.at >= before) {
    const until = Date.parse(existing.at) + rollingSettings(env).claimTtlMinutes * 60_000;
    return { retryAfter: Math.max(1, Math.ceil((until - Date.now()) / 1000) + 1) };
  }
  let key: string;
  let progress: WindowProgress;
  let lease: D1PreparedStatement;
  if (existing) {
    key = existing.key;
    progress = JSON.parse(existing.progress) as WindowProgress;
    lease = env.DB.prepare(`UPDATE rolling_inbox SET ${col.at}=?,${col.attempts}=${col.attempts}+1
      WHERE namespace=? AND ${col.key}=? AND ${col.done} IS NULL AND (${col.at} IS NULL OR ${col.at}<?)`)
      .bind(at, namespace, key, before);
  } else {
    const heads = await pendingHeads(env, namespace, lane);
    if (!heads.length) return {};
    const model = readDreamModel(env) ?? "";
    const first = heads[0].inbox_seq;
    const last = heads[heads.length - 1].inbox_seq;
    key = `rolling_${(await sha256Hex(JSON.stringify([namespace, model, first, last, STAGE_VERSION, lane]))).slice(0, 32)}`;
    progress = {
      model, chars: rollingSettings(env).chars, startedAt: at, completed: [],
      clefCalls: 0, extractorCalls: 0, eventCount: 0
    };
    lease = env.DB.prepare(`WITH ready(seq) AS MATERIALIZED (
      SELECT i.seq FROM rolling_inbox i
      WHERE i.namespace=?1 AND ${available(lane)} AND i.seq IN (SELECT value FROM json_each(?2))
        AND (i.${col.at} IS NULL OR i.${col.at}<?3)
    )
    UPDATE rolling_inbox SET ${col.key}=?4,${col.at}=?5,${col.attempts}=1,${col.progress}=?6
    WHERE seq IN ready AND (SELECT COUNT(*) FROM ready)=?7
      AND NOT EXISTS (SELECT 1 FROM rolling_inbox
        WHERE namespace=?1 AND ${col.done} IS NULL AND ${col.key} GLOB 'rolling_*' AND ${col.key}<>?4)`)
      .bind(namespace, JSON.stringify(heads.map((row) => row.inbox_seq)),
        lane === "on" ? staleNightlyClaimBefore() : before, key, at, JSON.stringify(progress), heads.length);
  }
  const [leased, selected] = await env.DB.batch<InboxMessage & { attempts: number }>([
    lease,
    env.DB.prepare(`SELECT m.id,m.conversation_id,m.namespace,m.role,m.content,m.source,m.created_at,
      m.capture_kind,i.seq AS inbox_seq,i.${col.attempts} AS attempts FROM rolling_inbox i
      JOIN messages m ON m.namespace=i.namespace AND m.id=i.message_id
      WHERE i.namespace=? AND i.${col.key}=? AND i.${col.at}=? AND i.${col.done} IS NULL
      ORDER BY i.seq`).bind(namespace, key, at)
  ]);
  if (!leased.meta.changes || !selected.results.length) return {};
  const attempts = selected.results[0].attempts;
  const rows = selected.results.map(({ attempts: _attempts, ...row }) => ({
    ...row, chars: codePointLength(row.content)
  }));
  return { claim: { namespace, lane, key, at, rows, attempts, progress } };
}
