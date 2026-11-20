import type { Env } from "../../types";

export type RollingMode = "off" | "shadow" | "on";
export type RollingLane = Exclude<RollingMode, "off">;

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

export function rollingMode(env: Env): RollingMode {
  return env.ROLLING_DREAM === "shadow" || env.ROLLING_DREAM === "on"
    ? env.ROLLING_DREAM
    : "off";
}

export function activeRollingLane(env: Env): RollingLane | null {
  return rollingMode(env) === "shadow" ? "shadow" : null;
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
