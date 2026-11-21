import type { createMemory } from "../../db/memories";
import { deleteMemoryEmbedding, upsertMemoryEmbedding } from "../../memory/embedding";
import type { MemoryCandidateRow } from "../../db/v2";
import { parseJudgeNote } from "../../memory/candidateJudge";
import type { Env } from "../../types";

export async function syncMemoryEmbeddingBestEffort(env: Env, memory: Awaited<ReturnType<typeof createMemory>>): Promise<void> {
  try {
    await upsertMemoryEmbedding(env, memory);
  } catch (error) {
    console.error("memory api vector upsert failed", { id: memory.id, error });
  }
}

export async function deleteMemoryEmbeddingBestEffort(env: Env, memory: Awaited<ReturnType<typeof createMemory>>): Promise<void> {
  try {
    await deleteMemoryEmbedding(env, memory);
  } catch (error) {
    console.error("memory api vector delete failed", { id: memory.id, error });
  }
}


export function readRecallK(body: Record<string, unknown>, env: Env): number {
  const raw = body.k !== undefined ? body.k : body.top_k;
  const fallback = Number(env.MEMORY_TOP_K || 50);
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return Number.isFinite(fallback) ? Math.floor(fallback) : 50;
}


export function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function toCandidateApiRecord(row: MemoryCandidateRow) {
  return {
    id: row.id,
    namespace: row.namespace,
    type: row.type,
    content: row.content,
    fact_key: row.fact_key,
    confidence: row.confidence,
    importance: row.importance,
    tags: parseJsonArray(row.tags),
    source_message_ids: parseJsonArray(row.source_message_ids),
    ...(row.provenance ? {provenance: JSON.parse(row.provenance)} : {}),
    source: row.source,
    status: row.status,
    target_memory_id: row.target_memory_id,
    decision_note: row.decision_note,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function toJudgeDecisionRecord(row: MemoryCandidateRow) {
  const note = parseJudgeNote(row.decision_note);
  return {
    ...toCandidateApiRecord(row),
    judged_by: note?.judgedBy ?? null,
    reason: note?.reason ?? row.decision_note,
    undone: note?.undone ?? false,
    undoable: note?.undoable ?? false
  };
}

export async function countMessagesInRange(
  db: D1Database,
  input: { namespace: string; startCreatedAt: string; endCreatedAt: string }
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM messages
       WHERE namespace = ?
         AND role IN ('user', 'assistant')
         AND created_at >= ?
         AND created_at < ?`
    )
    .bind(input.namespace, input.startCreatedAt, input.endCreatedAt)
    .first<{ count: number }>();
  return row?.count ?? 0;
}


export function readDiaryTimeZone(env: Env): string {
  return env.DREAM_TIME_ZONE?.trim() || env.DAILY_DIGEST_TIME_ZONE?.trim() || "Asia/Singapore";
}

