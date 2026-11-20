import type { Env, MemoryApiRecord } from "../../types";
import { fetchMemoriesWithLifecycleByIds } from "../../db/memories";
import { readStringArray } from "../../utils/parse";
import { isScopedDecisionRecord } from "../currentState/store";
import { isExplicitMemory } from "../provenance";
import { toMemoryApiRecord } from "../search";
import type { RollingState } from "./state";
import type { InboxMessage } from "./window";

export interface RollingRecallHit {
  id: string;
  revision: string;
  hit_count: number;
  content: string;
  status: string;
  version_status: string;
  relation: "seen_only";
  protected: boolean;
}

export interface RollingExplicitWrite {
  id: string;
  content: string;
  claimed_author?: string;
  source_message_ids: string[];
}

export interface RollingPacket {
  window: { key: string; from_seq: number; to_seq: number };
  rolling_state: RollingState;
  messages: InboxMessage[];
  recall_hits: RollingRecallHit[];
  explicit_writes: RollingExplicitWrite[];
}

export function windowTimes(messages: InboxMessage[]): { start: string; end: string } | null {
  const times = messages.map((message) => Date.parse(message.created_at)).filter(Number.isFinite);
  if (!times.length) return null;
  return {
    start: new Date(Math.min(...times)).toISOString(),
    end: new Date(Math.max(...times)).toISOString()
  };
}

export async function rollingRecallHits(
  env: Env,
  namespace: string,
  messages: InboxMessage[],
): Promise<RollingRecallHit[]> {
  const range = windowTimes(messages);
  if (!range) return [];
  const end = new Date(Date.parse(range.end) + 120_000).toISOString();
  const events = await env.DB.prepare(`SELECT payload_json FROM memory_events
    WHERE namespace=? AND event_type='recall_explain' AND created_at>=? AND created_at<=?
    ORDER BY created_at DESC LIMIT 256`)
    .bind(namespace, range.start, end)
    .all<{ payload_json: string }>();
  const counts = new Map<string, number>();
  for (const event of events.results) {
    try {
      const payload = JSON.parse(event.payload_json) as { items?: Array<{ id?: unknown; namespace?: unknown; kind?: unknown }> };
      const seen = new Set<string>();
      for (const item of payload.items ?? []) {
        if (typeof item?.id === "string" && item.namespace === namespace && item.kind !== "notebook" && !seen.has(item.id)) {
          seen.add(item.id);
          counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
        }
      }
    } catch {
      // An old audit row is optional context, never a new fact.
    }
  }
  const ids = [...counts.keys()].slice(0, 24);
  if (!ids.length) return [];
  const rows = await fetchMemoriesWithLifecycleByIds(env.DB, { namespace, ids });
  const rowsById = new Map(rows.map((row) => [row.record.id, row]));
  return ids.flatMap((id): RollingRecallHit[] => {
    const row = rowsById.get(id);
    if (!row) return [];
    const { record, lifecycle } = row;
    const memory: MemoryApiRecord = toMemoryApiRecord(record, undefined, lifecycle);
    return [{
      id: memory.id,
      revision: memory.updated_at ?? memory.created_at ?? "",
      hit_count: counts.get(memory.id) ?? 0,
      content: Array.from(memory.content).slice(0, 160).join(""),
      status: memory.status,
      version_status: memory.version_status ?? "current",
      relation: "seen_only",
      protected: isExplicitMemory(record) || isScopedDecisionRecord(record),
    }];
  }).slice(0, 8);
}

export async function rollingExplicitWrites(
  env: Env,
  namespace: string,
  messages: InboxMessage[],
): Promise<RollingExplicitWrite[]> {
  const range = windowTimes(messages);
  if (!range) return [];
  const end = new Date(Date.parse(range.end) + 120_000).toISOString();
  const rows = await env.DB.prepare(`SELECT id,content,provenance,source_message_ids FROM memories
    WHERE namespace=? AND created_at>=? AND created_at<=?
      AND status='active' AND json_valid(provenance)
      AND json_extract(provenance,'$.creation_mode') IN ('agent_explicit','user_explicit')
    ORDER BY created_at DESC LIMIT 5`)
    .bind(namespace, range.start, end)
    .all<{ id: string; content: string; provenance: string | null; source_message_ids: string | null }>();
  return rows.results.map((row) => {
    let origin: { claimed_author?: unknown } | null = null;
    let sources: string[] = [];
    try {
      origin = JSON.parse(row.provenance ?? "null") as { claimed_author?: unknown } | null;
      sources = readStringArray(JSON.parse(row.source_message_ids ?? "[]"));
    } catch {
      // Preserve the record even if an old provenance value is malformed.
    }
    return {
      id: row.id,
      content: Array.from(row.content).slice(0, 300).join(""),
      source_message_ids: sources.slice(0, 8),
      ...(typeof origin?.claimed_author === "string" ? { claimed_author: origin.claimed_author } : {})
    };
  });
}
