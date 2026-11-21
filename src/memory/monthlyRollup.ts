import {
  bindDeleteWeeklyLogsByWeeksStatement,
  bindRecordFoldedWeeksStatements,
  bindUpsertMonthlyLogStatement,
  getMonthlyLog,
  listWeeklyLogsBeforeStartDate,
  type WeeklyLogRow
} from "../db/v2";
import type { Env } from "../types";
import { callModelWithRetry, ModelCallError, readModelName } from "../utils/modelCall";
import {
  addDaysToDateLabel,
  getDateLabelsLookback
} from "./dreamDates";
import { DEFAULT_DREAM_MODEL, readDreamTimeZoneFromEnv } from "./dreamEnv";
import { getMondayOfIsoWeek } from "./weeklyRollup";
import { extractJsonObject, readString } from "../utils/parse";
import { formatDateLabel } from "../utils/time";
import { loadSpeakersForNamespace, rollupSpeakerRule, type DreamSpeakers } from "./speakers";

const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const MAX_MONTHS_PER_RUN = 2;
const ROLLUP_AGE_DAYS = 35;

export interface MonthlyRollupMonthDetail {
  month: string;
  status: "rolled_up" | "skipped" | "dry_run" | "error";
  source_weeks?: number;
  deleted_weeks?: number;
  title?: string;
  summary?: string;
  reason?: string;
}

export interface MonthlyRollupStats {
  enabled: boolean;
  dry_run: boolean;
  cutoff_date: string;
  months_eligible: number;
  months_processed: number;
  months_skipped: number;
  details: MonthlyRollupMonthDetail[];
}

export type MonthlyRollupOptions = {
  dryRun?: boolean;
};

type MonthlyRollupModelResult = {
  title: string;
  summary: string;
} | null;

interface MonthlyRollupModelCallResult {
  result: MonthlyRollupModelResult;
  reason?: "model_error" | "model_invalid_json";
  model?: string;
  status?: number;
}

function isMonthlyRollupEnabled(env: Env): boolean {
  const flag = readString(env.ENABLE_MONTHLY_ROLLUP);
  if (flag) return flag !== "false";
  return true;
}

function readRollupModel(env: Env): string {
  return readModelName(env, ["DIARY_MODEL", "DREAM_MODEL"], DEFAULT_DREAM_MODEL);
}

function readRollupMaxTokens(env: Env): number {
  const parsed = Number(env.DREAM_MAX_TOKENS || env.DAILY_DIGEST_MAX_TOKENS || 3000);
  const numeric = Number.isFinite(parsed) ? parsed : 3000;
  return Math.min(Math.max(Math.floor(numeric), 1), 8000);
}

function formatTodayDateLabel(timeZone: string, now = new Date()): string {
  return formatDateLabel(now, timeZone);
}

function getCutoffDateLabel(todayLabel: string, timeZone: string): string {
  return getDateLabelsLookback(todayLabel, ROLLUP_AGE_DAYS + 1, timeZone)[ROLLUP_AGE_DAYS] ?? todayLabel;
}

export function getMonthLabelForWeekStart(startDate: string, timeZone: string): string {
  const monday = getMondayOfIsoWeek(startDate, timeZone);
  const thursday = addDaysToDateLabel(monday, 3, timeZone);
  return thursday.slice(0, 7);
}

function normalizeMonthlyRollupResult(value: unknown): MonthlyRollupModelResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const title = readString(raw.title);
  const summary = readString(raw.summary);
  if (!title || !summary) return null;
  return { title, summary };
}

export function buildMonthlyRollupPrompt(input: {
  month: string;
  weeklyLogs: Array<{ week: string; title: string; summary: string }>;
  existingMonthly?: { title: string; summary: string } | null;
  speakers?: DreamSpeakers | null;
}): string {
  const weekLines = input.weeklyLogs
    .map((row) => `- ${row.week} | ${row.title}\n  ${row.summary}`)
    .join("\n\n");

  const sections = [
    "You are Aelios's monthly impression writer. Read the weekly reflections from this month and distill them into 2-3 warm, natural sentences capturing the month's atmosphere in the user's language (matching the weekly reflections).",
    "Output valid JSON only, with no markdown fences, no commentary, and no reasoning.",
    "",
    "Goals:",
    "- Facts come before warmth: keep a natural, warm tone, but every theme and feeling must come strictly from the weekly reflections. Never invent events, scenes, or emotions just to sound warm.",
    "- Keep broad themes and emotional atmosphere; omit exact numbers, verbatim quotes, tool names, or private specifics.",
    "- summary: 2-3 warm, natural sentences in the user's language (matching the weekly reflections).",
    "- title: a short monthly title in the user's language (matching the weekly reflections; <=12 CJK chars or 3-7 words).",
    rollupSpeakerRule(input.speakers ?? null),
    "- Never mention D1, Vectorize, RAG, databases, memory systems, or proxy internals.",
    "",
    `Month: ${input.month}`,
    "",
    "Output JSON shape:",
    JSON.stringify({
      title: "Monthly impression",
      summary: "The overall warmth and rhythm of the month, recurring relationship themes, and threads worth feeling forward."
    })
  ];

  if (input.existingMonthly) {
    sections.push(
      "",
      "Existing monthly impression (merge and refresh with the new weekly reflections):",
      `- ${input.existingMonthly.title}\n  ${input.existingMonthly.summary}`,
      "",
      "New weekly reflections:",
      weekLines || "(no weekly reflections)"
    );
  } else {
    sections.push("", "Weekly reflections this month:", weekLines || "(no weekly reflections)");
  }

  return sections.join("\n");
}

async function callMonthlyRollupModel(
  env: Env,
  prompt: string,
  meta: { month: string; weekCount: number }
): Promise<MonthlyRollupModelCallResult> {
  const model = readRollupModel(env);
  const maxTokens = readRollupMaxTokens(env);

  const startedAt = Date.now();
  console.log("monthly_rollup: calling model", {
    month: meta.month,
    model,
    weekCount: meta.weekCount,
    promptChars: prompt.length,
    maxTokens
  });

  let text: string;
  try {
    text = await callModelWithRetry(env, {
      model,
      prompt,
      maxTokens,
      logPrefix: "monthly_rollup",
      logMeta: { month: meta.month }
    });
  } catch (error) {
    return {
      result: null,
      reason: "model_error",
      model,
      status: error instanceof ModelCallError ? error.status : undefined
    };
  }

  const elapsedMs = Date.now() - startedAt;
  const json = extractJsonObject(text);
  const result = normalizeMonthlyRollupResult(json);
  if (!result) {
    console.error("monthly_rollup: model returned invalid JSON", {
      month: meta.month,
      model,
      elapsedMs,
      contentChars: text.length
    });
    return { result: null, reason: "model_invalid_json", model };
  }

  console.log("monthly_rollup: model returned valid JSON", {
    month: meta.month,
    model,
    elapsedMs
  });
  return { result, model };
}

function collectEligibleMonths(input: {
  weeklyLogs: WeeklyLogRow[];
  timeZone: string;
}): Map<string, WeeklyLogRow[]> {
  const byMonth = new Map<string, WeeklyLogRow[]>();
  for (const row of input.weeklyLogs) {
    const month = getMonthLabelForWeekStart(row.start_date, input.timeZone);
    const existing = byMonth.get(month) ?? [];
    existing.push(row);
    byMonth.set(month, existing);
  }
  return byMonth;
}

async function processMonth(
  env: Env,
  input: {
    namespace: string;
    month: string;
    weeklyLogs: WeeklyLogRow[];
    dryRun: boolean;
  }
): Promise<MonthlyRollupMonthDetail> {
  const { namespace, month, weeklyLogs, dryRun } = input;
  const baseDetail: MonthlyRollupMonthDetail = {
    month,
    status: "skipped"
  };

  const existingMonthly = await getMonthlyLog(env.DB, { namespace, month });

  if (!existingMonthly && weeklyLogs.length < 2) {
    return { ...baseDetail, status: "skipped", reason: "orphan_weeks", source_weeks: weeklyLogs.length };
  }

  const prompt = buildMonthlyRollupPrompt({
    month,
    weeklyLogs: weeklyLogs.map((row) => ({ week: row.week, title: row.title, summary: row.summary })),
    existingMonthly: existingMonthly
      ? { title: existingMonthly.title, summary: existingMonthly.summary }
      : null,
    speakers: await loadSpeakersForNamespace(env, namespace)
  });
  const modelResult = await callMonthlyRollupModel(env, prompt, {
    month,
    weekCount: weeklyLogs.length
  });

  if (!modelResult.result) {
    return {
      ...baseDetail,
      status: "error",
      source_weeks: weeklyLogs.length,
      reason: modelResult.reason ?? "model_error"
    };
  }

  if (dryRun) {
    return {
      ...baseDetail,
      status: "dry_run",
      source_weeks: weeklyLogs.length,
      title: modelResult.result.title,
      summary: modelResult.result.summary
    };
  }

  try {
    const upsertStmt = bindUpsertMonthlyLogStatement(env.DB, {
      namespace,
      month,
      title: modelResult.result.title,
      summary: modelResult.result.summary,
      sourceWeekCount: weeklyLogs.length
    });
    const deleteStmts = bindDeleteWeeklyLogsByWeeksStatement(env.DB, {
      namespace,
      weeks: weeklyLogs.map((row) => row.week)
    });
    // Remember the folded weeks: their daily_log rows may still be kept for review, and
    // the weekly rollup must not take them for unwritten weeks once weekly_log is gone.
    const foldedStmts = bindRecordFoldedWeeksStatements(env.DB, { namespace, month, weeks: weeklyLogs });
    const results = await env.DB.batch([upsertStmt, ...deleteStmts, ...foldedStmts]);

    const saved = await getMonthlyLog(env.DB, { namespace, month });
    if (!saved) {
      return {
        ...baseDetail,
        status: "error",
        source_weeks: weeklyLogs.length,
        reason: "monthly_log_write_unconfirmed"
      };
    }

    const deletedWeeks = deleteStmts.length > 0 ? (results[1]?.meta?.changes ?? 0) : 0;

    return {
      ...baseDetail,
      status: "rolled_up",
      source_weeks: weeklyLogs.length,
      deleted_weeks: deletedWeeks,
      title: saved.title,
      summary: saved.summary
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("monthly_rollup: failed to persist month", {
      namespace,
      month,
      error: reason
    });
    return {
      ...baseDetail,
      status: "error",
      source_weeks: weeklyLogs.length,
      reason
    };
  }
}

export async function runMonthlyRollup(
  env: Env,
  namespace: string,
  options: MonthlyRollupOptions = {}
): Promise<MonthlyRollupStats> {
  const dryRun = options.dryRun === true;
  const enabled = isMonthlyRollupEnabled(env);
  const timeZone = readDreamTimeZoneFromEnv(env) || DEFAULT_TIME_ZONE;
  const todayLabel = formatTodayDateLabel(timeZone);
  const cutoffDate = getCutoffDateLabel(todayLabel, timeZone);

  if (!enabled) {
    return {
      enabled: false,
      dry_run: dryRun,
      cutoff_date: cutoffDate,
      months_eligible: 0,
      months_processed: 0,
      months_skipped: 0,
      details: []
    };
  }

  const weeklyLogs = await listWeeklyLogsBeforeStartDate(env.DB, {
    namespace,
    beforeStartDate: cutoffDate
  });
  const byMonth = collectEligibleMonths({ weeklyLogs, timeZone });
  const sortedMonths = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const eligibleMonths = sortedMonths.filter(([, rows]) => rows.length >= 2);
  const orphanMonths = sortedMonths.filter(([, rows]) => rows.length < 2);
  const monthsToProcess = eligibleMonths.slice(0, MAX_MONTHS_PER_RUN);
  const details: MonthlyRollupMonthDetail[] = [];

  for (const [month, rows] of orphanMonths) {
    try {
      const detail = await processMonth(env, { namespace, month, weeklyLogs: rows, dryRun });
      details.push(detail);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      details.push({ month, status: "error", reason });
    }
  }

  for (const [month, rows] of monthsToProcess) {
    try {
      const detail = await processMonth(env, { namespace, month, weeklyLogs: rows, dryRun });
      details.push(detail);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error("monthly_rollup: month processing failed", {
        namespace,
        month,
        error: reason
      });
      details.push({
        month,
        status: "error",
        reason
      });
    }
  }

  const monthsProcessed = details.filter((item) => item.status === "rolled_up" || item.status === "dry_run").length;
  const monthsSkipped = details.filter((item) => item.status === "skipped").length;

  return {
    enabled: true,
    dry_run: dryRun,
    cutoff_date: cutoffDate,
    months_eligible: byMonth.size,
    months_processed: monthsProcessed,
    months_skipped: monthsSkipped,
    details
  };
}
