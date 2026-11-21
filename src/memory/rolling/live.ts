import { createMemoryCandidate, getActiveMemoryByFactKey } from "../../db/v2";
import type { Env } from "../../types";
import { formatDateLabel } from "../../utils/time";
import { applyScopedDecision } from "../currentState/apply";
import { isCurrentStateEnabled } from "../currentState/projection";
import { decisionKey } from "../currentState/scopeKey";
import { readDreamTimeZone } from "../dreamEnv";
import { dreamOrigin, type MemoryProvenance } from "../provenance";
import type { GroundedWindowEvent } from "./apply";
import { assertRollingLease, finishRollingWindow, loadRollingDrafts, type RollingDraft } from "./checkpoint";
import { episodeMemory, extendDreamCandidate, findEpisodeCandidate, writableTarget } from "./episodes";
import type { RollingClaim } from "./inbox";
import { rollingSettings } from "./settings";
import { applyStateDelta, loadRollingState, type StateDelta } from "./state";

async function applyEvent(env: Env, claim: RollingClaim, draft: RollingDraft, event: GroundedWindowEvent) {
  const { namespace, rows } = claim;
  const db = env.DB;
  const seen = rows.map(row => row.id);
  const cited = event.source_message_ids;
  const guard = assertRollingLease(db, claim);
  const candidate = {
    type: event.type, content: event.content, tags: [], confidence: 0.8, importance: 0.6,
    source_message_ids: cited, attributed_role: event.attributed_role, evidence_quote: event.evidence_quote,
    decision: event.decision
  };
  const key = event.decision && decisionKey(event.decision.scope_key);
  if (isCurrentStateEnabled(env) && key && event.decision) {
    const saved = await applyScopedDecision(env, namespace, candidate, draft.recall_ids, { guard, rollingMessages: seen });
    if (saved) {
      const active = await getActiveMemoryByFactKey(db, { namespace, factKey: key });
      return { change: active ? { scope_key: event.decision.scope_key, decision_id: active.id } : undefined };
    }
  }

  const latest = Math.max(...rows.filter(row => cited.includes(row.id)).map(row => Date.parse(row.created_at)));
  const date = Number.isFinite(latest) ? formatDateLabel(new Date(latest), readDreamTimeZone(env)) : undefined;
  const episode = date && event.episode_key ? { episode_key: event.episode_key, episode_date: date } : {};
  let target = event.target_memory_id && event.op === "update" ? await writableTarget(db, namespace, event.target_memory_id) : null;
  if (event.op === "update" && !target) return null;
  const originFor = (targetId?: string): MemoryProvenance => ({
    ...dreamOrigin(cited, { messages: seen, memories: draft.recall_ids, target: targetId }),
    ...episode,
    recording_actor: "rolling_dream",
    attributed_actor: event.attributed_role ?? "unknown",
    evidence_relation: "paraphrase"
  });
  if (date && event.episode_key && event.op === "continuation") {
    const prior = await findEpisodeCandidate(db, namespace, event.episode_key, date);
    if (prior?.status === "pending") {
      const current = await extendDreamCandidate(db, prior, {
        content: event.content, sources: cited, origin: originFor(prior.target_memory_id ?? undefined), guard
      });
      if (!current) throw new Error("Pending episode changed during the rolling commit");
      return { candidateId: prior.id };
    }
    if (prior?.status === "approved") {
      target = await episodeMemory(db, namespace, prior.id);
      if (!target) return null;
      if (target.content.includes(event.content)) return { candidateId: prior.id };
    }
  }
  if (target?.content.trim() === event.content.trim()) return null;
  const saved = await createMemoryCandidate(db, {
    namespace, type: candidate.type, content: candidate.content, confidence: candidate.confidence, importance: candidate.importance,
    sourceMessageIds: cited, provenance: originFor(target?.id),
    source: target ? "dream_update" : "dream_extract",
    targetMemoryId: target?.id ?? null
  }, guard);
  return { candidateId: saved.id };
}

export async function commitRollingDrafts(env: Env, claim: RollingClaim): Promise<boolean> {
  const { namespace, key, rows } = claim;
  const retained = new Set(rows.map(row => row.id));
  const snapshot = await loadRollingState(env, namespace);
  let state = snapshot.state;
  const drafts = await loadRollingDrafts(env.DB, claim);
  for (const draft of drafts) {
    const { events, state_delta: delta } = draft.grounded;
    const accepted = new Set<string>();
    const episodeCandidates = new Map<string, string>();
    const changes: NonNullable<StateDelta["changes"]> = [];
    for (const event of events) {
      if (event.op === "no_op" || !event.source_message_ids.every(id => retained.has(id))) continue;
      const result = await applyEvent(env, claim, draft, event);
      if (!result) continue;
      for (const id of event.source_message_ids) accepted.add(id);
      if (result.change) changes.push(result.change);
      if (event.episode_key && result.candidateId) episodeCandidates.set(event.episode_key, result.candidateId);
    }
    const supports = (ids: string[]) => ids.length > 0 && ids.every(id => accepted.has(id));
    state = applyStateDelta(state, {
      close: delta.close?.filter(() => accepted.size > 0),
      open: delta.open?.filter(item => supports(item.evidence_ids)),
      episodes: delta.episodes?.filter(item => supports(item.evidence_ids)).map(item => ({
        ...item, candidate_id: episodeCandidates.get(item.key)
      })),
      changes
    }, `${key}:${draft.part}`, rollingSettings(env).stateChars);
  }
  return finishRollingWindow(env.DB, claim, undefined, { ...snapshot, state });
}
