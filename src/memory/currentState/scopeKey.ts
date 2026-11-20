import { readString, readStringArray } from "../../utils/parse";

const SCOPE = /^user\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ScopedDecision {
  scope_key: string;
  value: string;
  state_of: string[];
}

export function decisionKey(scope: string): string | null {
  return scope.length <= 128 && SCOPE.test(scope) ? `decision:${scope}` : null;
}

export function readScopedDecision(value: unknown): ScopedDecision | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const scope = readString(input.scope_key);
  const choice = readString(input.value);
  if (!scope || !decisionKey(scope) || !choice || choice.length > 160) return undefined;
  return {
    scope_key: scope,
    value: choice,
    state_of: readStringArray(input.state_of)
  };
}
