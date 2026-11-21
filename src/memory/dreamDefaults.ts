import type { Env } from "../types";
import { readPositiveInt, readString } from "./dreamUtils";

export const DEFAULT_DREAM_MODEL = "workers-ai/@cf/zai-org/glm-4.7-flash";
export const WORKERS_AI_OUTPUT_LIMIT = 8000;
export const MAX_OUTPUT_LIMIT = 65_536;

export function readDreamMaxTokens(env: Env): number | undefined {
  const raw = readString(env.DREAM_MAX_TOKENS) ?? readString(env.DAILY_DIGEST_MAX_TOKENS);
  return raw ? readPositiveInt(raw, WORKERS_AI_OUTPUT_LIMIT, MAX_OUTPUT_LIMIT) : undefined;
}
