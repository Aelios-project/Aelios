import { authenticate } from "../auth/apiKey";
import {
  describeDreamRun,
  failActiveDreamRun,
  findActiveDreamRun,
  getDreamRun,
  insertQueuedDreamRun,
  listDreamRunsForNamespace,
  resolveStaleDreamRun
} from "../db/dreamRuns";
import {
  IMPORT_CANDIDATE_SOURCES,
  listJudgedCandidatesInRange,
  listMemoriesCreatedInRange,
  listMemoriesGoneDormantInRange
} from "../db/v2";
import { runCandidateJudge } from "../memory/candidateJudge";
import { writeDiaryAfterDream } from "../memory/diaryWriter";
import { getRollingDreamStatus, getRollingHarvest } from "../memory/rolling/stats";
import {
  countRawMessagesForDateLabel,
  getDateLabelsLookback,
  getDateRangeForLabel,
  getTargetDigestDateLabel,
  readDreamCursorValue,
  readDreamTimeZoneFromEnv,
  runDailyMemoryDigest
} from "../memory/dailyDigest";
import { json, openAiError } from "../utils/json";
import { readBoolean, readJsonObject, readString, resolveNamespace } from "../utils/request";
import type { Env } from "../types";

const DREAM_STATUS_LOOKBACK_DAYS = 7;
const DREAM_CURSOR_DATE_LABELS = 3;
const DREAM_HARVEST_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidHarvestDateLabel(label: string): boolean {
  if (!DREAM_HARVEST_DATE_RE.test(label)) return false;
  const [year, month, day] = label.split("-").map(Number);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  // 回环反验：Date.UTC 会把 2/31 这类不存在的日期静默规整进下月，
  // 构造后年月日对不上即非法（闰年 2/29 由此自然判别）。
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

export async function handleDreamStatus(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  if (!auth.profile.scopes.includes("memory:write")) {
    return openAiError("Missing required scope: memory:write", 403);
  }

  const url = new URL(request.url);
  const namespace = readString(url.searchParams.get("namespace")) || auth.profile.namespace;
  const timeZone = readDreamTimeZoneFromEnv(env);
  const anchorDateLabel = getTargetDigestDateLabel(timeZone);
  const cursorDateLabels = getDateLabelsLookback(anchorDateLabel, DREAM_CURSOR_DATE_LABELS, timeZone);
  const sinceIso = new Date(Date.now() - DREAM_STATUS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    const [runs, activeRun, cursors, rawMessageCounts, rolling] = await Promise.all([
      listDreamRunsForNamespace(env.DB, { namespace, sinceIso }),
      findActiveDreamRun(env.DB, namespace),
      Promise.all(
        cursorDateLabels.map(async (dateLabel) => ({
          date_label: dateLabel,
          cursor: await readDreamCursorValue(env.DB, { namespace, dateLabel })
        }))
      ),
      Promise.all(
        cursorDateLabels.map(async (dateLabel) => ({
          date_label: dateLabel,
          raw_messages: await countRawMessagesForDateLabel(env.DB, { namespace, dateLabel, timeZone })
        }))
      ),
      resolveNamespace(auth.profile, namespace) === namespace ? getRollingDreamStatus(env, namespace) : undefined
    ]);

    return json({
      data: {
        namespace,
        time_zone: timeZone,
        anchor_date_label: anchorDateLabel,
        dream_runs: runs.map((run) => describeDreamRun(run)),
        // Includes old unresolved rows outside the seven-day history window.
        active_run: activeRun ? describeDreamRun(activeRun) : null,
        cursors,
        raw_message_counts: rawMessageCounts,
        rolling
      }
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/**
 * Closes an unconfirmed task so it stops blocking background admission. Deliberately explicit: nothing is cleared
 * on a timer, and only a task past the stale threshold qualifies.
 */
export async function handleDreamResolve(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  if (!auth.profile.scopes.includes("memory:write")) {
    return openAiError("Missing required scope: memory:write", 403);
  }

  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const namespace = readString(body.namespace) || auth.profile.namespace;
  const runId = readString(body.run_id);
  if (!runId) return openAiError("run_id is required", 400);

  try {
    if (await resolveStaleDreamRun(env.DB, { id: runId, namespace })) {
      return json({ data: { namespace, run_id: runId, status: "error", reason: "marked_interrupted" } });
    }
    const run = await getDreamRun(env.DB, { id: runId, namespace });
    if (!run) return openAiError("Dream run not found", 404);
    return json({
      ok: false,
      error: "Only a queued/running task that has gone unconfirmed for over 20 minutes can be marked interrupted.",
      data: { namespace, run: describeDreamRun(run) }
    }, { status: 409 });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function handleDreamRun(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  if (!auth.profile.scopes.includes("memory:write")) {
    return openAiError("Missing required scope: memory:write", 403);
  }

  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const namespace = readString(body.namespace) || auth.profile.namespace;
  const dateLabel = readString(body.date);
  const force = readBoolean(body.force, false);
  const dryRun = readBoolean(body.dry_run, false);

  try {
    // Explicit opt-in only. Dry-run and legacy callers retain their synchronous contract.
    if (body.background === true && !dryRun) {
      if (!env.MEMORY_QUEUE) return openAiError("Background dream requires MEMORY_QUEUE", 503);
      const targetDate = dateLabel ?? getTargetDigestDateLabel(readDreamTimeZoneFromEnv(env));
      if (!isValidHarvestDateLabel(targetDate)) return openAiError("date must be YYYY-MM-DD", 400);
      const runId = await insertQueuedDreamRun(env.DB, { namespace, dateLabel: targetDate });
      if (!runId) {
        const activeRun = await findActiveDreamRun(env.DB, namespace);
        return json({
          ok: false,
          error: "A dream task is already active or its completion is unconfirmed; force cannot bypass it.",
          data: { namespace, active_run: activeRun ? describeDreamRun(activeRun) : null }
        }, { status: 409 });
      }
      try {
        await env.MEMORY_QUEUE.send({ type: "dream_run", runId, namespace, dateLabel: targetDate, force });
      } catch {
        try {
          await failActiveDreamRun(env.DB, {
            id: runId,
            expectedStatus: "queued",
            reason: "enqueue_failed",
            error: "Queue acceptance failed; delivery is unconfirmed."
          });
        } catch {
          // Keep the unresolved admission locked if cleanup itself is unavailable.
          console.error("dream: enqueue failure status could not be persisted", { runId });
        }
        return json({
          ok: false,
          error: "Queue acceptance failed; inspect run status before retrying.",
          data: { namespace, run_id: runId }
        }, { status: 503 });
      }
      return json({ data: {
        namespace, date: targetDate, force, dry_run: false, run_id: runId, status: "queued"
      } }, { status: 202 });
    }

    const result = await runDailyMemoryDigest(env, namespace, {
      dateLabel: dateLabel ?? undefined,
      force,
      dryRun,
      trigger: "manual"
    });

    const response: Record<string, unknown> = {
      namespace,
      date: dateLabel ?? getTargetDigestDateLabel(readDreamTimeZoneFromEnv(env)),
      force,
      dry_run: dryRun,
      result
    };

    if (!dryRun) {
      try {
        response.candidate_judge = await runCandidateJudge(env, namespace);
      } catch (error) {
        response.candidate_judge = {
          ran: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
      // Same as the background job: the nightly cron only writes yesterday's diary.
      if (result.ran) response.diary_writer = await writeDiaryAfterDream(env, namespace, result.stats.date);
    }

    if (dryRun && result.ran) {
      if ("proposal" in result && result.proposal) response.proposal = result.proposal;
      if ("routing_plan" in result && result.routing_plan) response.routing_plan = result.routing_plan;
      if ("extracted_memories" in result && result.extracted_memories) {
        response.extracted_memories = result.extracted_memories;
      }
    }

    return json({ data: response });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// 当夜收成 (harvest)：返回某个 date_label 当晚的记忆变动，只读。
// created 新生 / dormant 沉眠 (superseded+archived) / candidates 判决 (approved+discarded)。
export async function handleDreamHarvest(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  if (!auth.profile.scopes.includes("memory:write")) {
    return openAiError("Missing required scope: memory:write", 403);
  }

  const url = new URL(request.url);
  const namespace = readString(url.searchParams.get("namespace")) || auth.profile.namespace;
  const dateLabel = readString(url.searchParams.get("date"));
  if (!dateLabel || !isValidHarvestDateLabel(dateLabel)) {
    return openAiError("date must be YYYY-MM-DD", 400);
  }

  const timeZone = readDreamTimeZoneFromEnv(env);
  let startIso: string;
  let endIso: string;
  try {
    ({ startIso, endIso } = getDateRangeForLabel(dateLabel, timeZone));
  } catch {
    return openAiError("date must be YYYY-MM-DD", 400);
  }

  try {
    const range = { namespace, startIso, endIso };
    const [created, dormant, candidates, rolling] = await Promise.all([
      listMemoriesCreatedInRange(env.DB, { namespace, startIso, endIso }),
      listMemoriesGoneDormantInRange(env.DB, { namespace, startIso, endIso }),
      listJudgedCandidatesInRange(env.DB, { namespace, startIso, endIso, excludeSources: IMPORT_CANDIDATE_SOURCES }),
      resolveNamespace(auth.profile, namespace) === namespace ? getRollingHarvest(env, range) : undefined
    ]);

    return json({
      data: {
        namespace,
        date: dateLabel,
        time_zone: timeZone,
        created,
        dormant,
        candidates,
        rolling
      }
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
