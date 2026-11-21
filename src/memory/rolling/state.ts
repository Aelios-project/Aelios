import { readCursor } from "../../db/retention";
import type { Env } from "../../types";
import { codePointLength } from "./window";

export interface RollingState {
  episodes: Array<{
    key: string;
    label: string;
    candidate_id?: string;
    last_seq: number;
    evidence_ids: string[];
  }>;
  open: Array<{ label: string; evidence_ids: string[] }>;
  changes: Array<{ scope_key: string; decision_id: string }>;
  last_window_key?: string;
}

export interface StateDelta {
  episodes?: RollingState["episodes"];
  open?: RollingState["open"];
  close?: string[];
  changes?: RollingState["changes"];
}

const EMPTY: RollingState = { episodes: [], open: [], changes: [] };

export function rollingStateName(namespace: string): string {
  return `rolling_state:${namespace}`;
}

function validState(value: unknown): RollingState {
  if (!value || typeof value !== "object") return { ...EMPTY };
  const raw = value as Partial<RollingState>;
  return {
    episodes: Array.isArray(raw.episodes) ? raw.episodes.filter((item) => item && typeof item.key === "string" && typeof item.label === "string" && Array.isArray(item.evidence_ids)) : [],
    open: Array.isArray(raw.open) ? raw.open.filter((item) => item && typeof item.label === "string" && Array.isArray(item.evidence_ids)) : [],
    changes: Array.isArray(raw.changes) ? raw.changes.filter((item) => item && typeof item.scope_key === "string" && typeof item.decision_id === "string") : [],
    ...(typeof raw.last_window_key === "string" ? { last_window_key: raw.last_window_key } : {}),
  };
}

export async function loadRollingState(
  env: Env,
  namespace: string
): Promise<{ name: string; value: string | null; state: RollingState }> {
  const name = rollingStateName(namespace);
  const value = await readCursor(env.DB, name);
  const state = validState(JSON.parse(value ?? "null"));
  const ids = [...new Set([...state.episodes, ...state.open].flatMap((item) => item.evidence_ids))];
  const [retained, active] = await Promise.all([
    ids.length
      ? env.DB.prepare("SELECT id FROM messages WHERE namespace=? AND id IN (SELECT value FROM json_each(?))")
        .bind(namespace, JSON.stringify(ids)).all<{ id: string }>()
      : null,
    state.changes.length
      ? env.DB.prepare("SELECT id FROM memories WHERE namespace=? AND status='active' AND id IN (SELECT value FROM json_each(?))")
        .bind(namespace, JSON.stringify(state.changes.map((item) => item.decision_id))).all<{ id: string }>()
      : null
  ]);
  const existing = new Set(retained?.results.map((row) => row.id));
  const decisions = new Set(active?.results.map((row) => row.id));
  const keepEvidence = <T extends { evidence_ids: string[] }>(items: T[]): T[] =>
    items.map((item) => ({ ...item, evidence_ids: item.evidence_ids.filter((id) => existing.has(id)) }))
      .filter((item) => item.evidence_ids.length);
  return {
    name, value,
    state: {
      ...state,
      episodes: keepEvidence(state.episodes),
      open: keepEvidence(state.open),
      changes: state.changes.filter((item) => decisions.has(item.decision_id))
    }
  };
}

export function applyStateDelta(
  state: RollingState,
  delta: StateDelta,
  windowKey: string,
  maximumChars: number,
): RollingState {
  if (state.last_window_key === windowKey) return state;
  const closed = new Set(delta.close ?? []);
  const episodes = new Map(state.episodes.map((episode) => [episode.key, episode]));
  for (const episode of delta.episodes ?? []) {
    const previous = episodes.get(episode.key);
    episodes.delete(episode.key);
    episodes.set(episode.key, {
      ...previous,
      ...episode,
      evidence_ids: [...new Set([...(previous?.evidence_ids ?? []), ...episode.evidence_ids])].slice(-3),
    });
  }
  const open = [...new Map([...state.open, ...(delta.open ?? [])].map(item => [item.label, item])).values()]
    .filter((item) => !closed.has(item.label))
    .slice(-8);
  const changes = [...new Map([...state.changes, ...(delta.changes ?? [])].map(item => [item.scope_key, item])).values()];
  const next: RollingState = {
    episodes: [...episodes.values()].filter((episode) => !closed.has(episode.key)).slice(-8),
    open,
    changes,
    last_window_key: windowKey,
  };
  const overBudget = () => codePointLength(JSON.stringify(next)) > maximumChars;
  while (overBudget() && next.open.length) {
    next.open.shift();
  }
  while (overBudget() && next.episodes.length) {
    next.episodes.shift();
  }
  return next;
}
