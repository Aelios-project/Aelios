import type { Env } from "../../types";

export interface RollingSettings {
  messages: number;
  chars: number;
  stateChars: number;
  claimTtlMinutes: number;
  maxAttempts: number;
}

function bounded(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = value?.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed)
    ? Math.min(Math.max(Math.floor(parsed), 1), maximum)
    : fallback;
}

/** Daytime Dream, on unless switched off: windows are triaged and written during the day; nightly fills the gaps. */
export function isDaytimeDreamOn(env: Pick<Env, "ROLLING_DREAM">): boolean {
  // Same reading as the settings page switch. Unknown values, including the retired "shadow", fall back to the default.
  return !["off", "false", "0", "no"].includes((env.ROLLING_DREAM ?? "").trim().toLowerCase());
}

export function rollingSettings(env: Env): RollingSettings {
  return {
    messages: bounded(env.ROLLING_WINDOW_MESSAGES, 10, 100),
    chars: bounded(env.ROLLING_WINDOW_CHARS, 8000, 80000),
    stateChars: bounded(env.ROLLING_STATE_CHARS, 1200, 12000),
    claimTtlMinutes: bounded(env.ROLLING_CLAIM_TTL_MINUTES, 15, 1440),
    maxAttempts: bounded(env.ROLLING_MAX_ATTEMPTS, 3, 10),
  };
}
