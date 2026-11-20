import { getMemoryById } from "../../db/memories";
import { approvedCandidateMemory, type MemoryCandidateRow } from "../../db/v2/candidates";
import { readStringArray } from "../../utils/parse";
import { nowIso } from "../../utils/time";
import { isScopedDecisionRecord } from "../currentState/store";
import { isExplicitMemory, parseOrigin, type MemoryProvenance } from "../provenance";

export async function findEpisodeCandidate(db: D1Database, namespace: string, key: string, date: string): Promise<MemoryCandidateRow | null> {
  return db.prepare(`SELECT * FROM memory_candidates WHERE namespace=? AND status IN ('pending','approved')
    AND source IN ('dream_extract','dream_update')
    AND json_extract(provenance,'$.episode_key')=? AND json_extract(provenance,'$.episode_date')=?
    ORDER BY created_at DESC,rowid DESC LIMIT 1`).bind(namespace, key, date).first<MemoryCandidateRow>();
}

/** Derived candidates can grow while pending. Keep the original wording and cited evidence. */
export async function extendDreamCandidate(
  db: D1Database,
  candidate: MemoryCandidateRow,
  input: { content: string; sources: string[]; origin: MemoryProvenance; guard: D1PreparedStatement }
): Promise<boolean> {
  const previous = parseOrigin(candidate.provenance);
  if (candidate.status !== "pending" || previous?.episode_key !== input.origin.episode_key) return false;
  const priorSources = readStringArray(JSON.parse(candidate.source_message_ids ?? "[]"));
  const covered = candidate.content.includes(input.content);
  if (covered && input.sources.every(id => priorSources.includes(id))) return true;
  const sources = [...new Set([...priorSources, ...input.sources])];
  const inputs = [...new Set([...(previous?.inputs ?? []), ...(input.origin.inputs ?? [])])];
  const content = covered ? candidate.content : [candidate.content, input.content].join("\n");
  const origin: MemoryProvenance = {
    ...input.origin,
    attributed_actor: previous?.attributed_actor === input.origin.attributed_actor ? input.origin.attributed_actor : "unknown",
    inputs,
    context_refs: [...new Set([...(previous?.context_refs ?? []), ...(input.origin.context_refs ?? [])])].filter(ref => !inputs.includes(ref))
  };
  const [, saved] = await db.batch([
    input.guard,
    db.prepare(`UPDATE memory_candidates SET content=?,source_message_ids=?,provenance=?,updated_at=?
      WHERE namespace=? AND id=? AND status='pending' AND content=? AND provenance IS ? AND source_message_ids IS ?`)
      .bind(content.length <= 1000 ? content : candidate.content, JSON.stringify(sources), JSON.stringify(origin),
        nowIso(), candidate.namespace, candidate.id, candidate.content, candidate.provenance ?? null, candidate.source_message_ids)
  ]);
  return Boolean(saved.meta.changes);
}

export async function episodeMemory(db: D1Database, namespace: string, candidateId: string) {
  const id = await approvedCandidateMemory(db, namespace, candidateId);
  return id ? writableTarget(db, namespace, id) : null;
}

export async function writableTarget(db: D1Database, namespace: string, id: string) {
  const memory = await getMemoryById(db, { namespace, id });
  if (memory?.status !== "active" || memory.pinned || isExplicitMemory(memory) || isScopedDecisionRecord(memory)) return null;
  return memory;
}
