import type { Env } from "../types";
import { isWorkersAiModel } from "../proxy/openaiAdapter";
import { readPositiveInt, readString } from "./dreamUtils";
import { DEFAULT_DREAM_MODEL, readDreamMaxTokens, WORKERS_AI_OUTPUT_LIMIT } from "./dreamDefaults";
export { DEFAULT_DREAM_MODEL, readDreamMaxTokens } from "./dreamDefaults";

const DEFAULT_MAX_MESSAGES = 40;
const DEFAULT_MEMORY_CONTEXT_LIMIT = 40;
export const DEFAULT_EMPTY_MEMORY_MIN_CHARS = 4;
const DEFAULT_TIME_ZONE = "Asia/Singapore";

export function isDreamEnabled(env: Env): boolean {
  const dreamFlag = readString(env.ENABLE_DREAM);
  if (dreamFlag) return dreamFlag !== "false";
  return env.ENABLE_DAILY_MEMORY_DIGEST !== "false";
}

export function readDreamStrategy(env: Env): "upsert" | "review" {
  const raw = env.DREAM_STRATEGY;
  if (raw === "review") return "review";
  return "upsert";
}

export function readFirstEnvValue(...values: unknown[]): unknown {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function readDreamModel(env: Env): string | null {
  return (
    readString(readFirstEnvValue(env.DREAM_MODEL, env.DAILY_DIGEST_MODEL, env.SUMMARY_MODEL)) ||
    DEFAULT_DREAM_MODEL
  );
}

export function readDreamTimeZone(env: Env): string {
  return readString(readFirstEnvValue(env.DREAM_TIME_ZONE, env.DAILY_DIGEST_TIME_ZONE)) || DEFAULT_TIME_ZONE;
}

export function readDreamMaxMessages(env: Env): number {
  return readPositiveInt(
    readFirstEnvValue(env.DREAM_MAX_MESSAGES, env.DAILY_DIGEST_MAX_MESSAGES),
    DEFAULT_MAX_MESSAGES,
    1000
  );
}

/**
 * The only length parameter a background call sends. Unset, it sends none and the model decides how
 * long to think and answer, so any route works. Workers AI is the exception: models such as gpt-oss
 * default to 256 tokens there, which cuts the JSON short, so they get a roomy limit instead.
 */
export function dreamOutputLimit(env: Env, model: string): { max_tokens?: number } {
  const set = readDreamMaxTokens(env);
  if (set !== undefined) return { max_tokens: set };
  return isWorkersAiModel(model) ? { max_tokens: WORKERS_AI_OUTPUT_LIMIT } : {};
}

export function readDreamMemoryContextLimit(env: Env): number {
  return readPositiveInt(
    readFirstEnvValue(env.DREAM_MEMORY_CONTEXT_LIMIT, env.DAILY_DIGEST_MEMORY_CONTEXT_LIMIT),
    DEFAULT_MEMORY_CONTEXT_LIMIT,
    1000
  );
}

export function readDreamTimeZoneFromEnv(env: Env): string {
  return readDreamTimeZone(env);
}
