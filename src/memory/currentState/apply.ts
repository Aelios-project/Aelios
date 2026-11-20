import { getMessagesByIds } from "../../db/messages";
import { getActiveMemoryByFactKey } from "../../db/v2";
import type { Env } from "../../types";
import { sha256Hex } from "../../utils/hash";
import type { ExtractedMemory } from "../extract";
import { groundCandidate } from "../grounding";
import { dreamOrigin, isExplicitMemory } from "../provenance";
import { isExplicitDecisionText } from "./decisionCues";
import { decisionKey } from "./scopeKey";
import {
  commitScopedDecision,
  recordLateDecisionEvidence,
  SCOPED_DECISION_SOURCE
} from "./store";

export { SCOPED_DECISION_SOURCE };

export async function applyScopedDecision(
  env: Env,
  namespace: string,
  candidate: ExtractedMemory,
  contextIds: string[] = []
) {
  const proposal = candidate.decision;
  const key = proposal && decisionKey(proposal.scope_key);
  if (!key || !proposal || candidate.type !== "decision" || candidate.attributed_role !== "user") {
    return null;
  }

  const ids = [...new Set(candidate.source_message_ids)];
  const messages = await getMessagesByIds(env.DB, { namespace, ids });
  if (!ids.length || messages.length !== ids.length || !messages.some((m) => m.role === "user")) {
    return null;
  }

  const quote = candidate.evidence_quote;
  const support = quote && messages.find((m) => m.role === "user" && m.content.includes(quote));
  const [checked] = support ? groundCandidate(candidate, [support]) : [];
  if (
    !checked ||
    !support ||
    !isExplicitDecisionText(support.content) ||
    !quote?.toLowerCase().includes(proposal.value.toLowerCase()) ||
    !candidate.content.toLowerCase().includes(proposal.value.toLowerCase())
  ) {
    return null;
  }

  const newest = Math.max(...messages.map((m) => Date.parse(m.created_at)));
  if (!Number.isFinite(newest)) return null;
  const at = new Date(newest).toISOString();

  const allowed = new Set(contextIds);
  const context = proposal.state_of.filter((id) => allowed.has(id));
  const sameSpace = context.length
    ? await env.DB.prepare(
        `SELECT id FROM memories WHERE namespace = ?
         AND id IN (SELECT value FROM json_each(?))`
      )
        .bind(namespace, JSON.stringify(context))
        .all<{ id: string }>()
    : null;
  const origin = {
    ...dreamOrigin(ids),
    attributed_actor: "user" as const,
    evidence_relation: "paraphrase" as const,
    state_of: sameSpace?.results.map((row) => row.id) ?? []
  };

  const revoked = await env.DB.prepare(
    `SELECT 1 FROM memory_revocations WHERE namespace = ?
     AND ref IN (SELECT value FROM json_each(?)) LIMIT 1`
  )
    .bind(namespace, JSON.stringify(origin.inputs))
    .first();
  if (revoked) return null;

  const id = `mem_${(await sha256Hex(JSON.stringify([namespace, key, [...ids].sort(), proposal.value]))).slice(0, 32)}`;
  const revisionId = `rev_${id}`;
  const committed = await env.DB.prepare(
    `SELECT id FROM memories WHERE namespace = ?1 AND id = ?2
     UNION ALL SELECT id FROM memory_revisions WHERE namespace = ?1 AND id = ?3 LIMIT 1`
  )
    .bind(namespace, id, revisionId)
    .first<{ id: string }>();
  if (committed) return { id: committed.id, current: false };

  const match = await getActiveMemoryByFactKey(env.DB, { namespace, factKey: key });
  const current =
    match &&
    (await env.DB.prepare(
      `SELECT m.id, m.type, m.source, m.updated_at, m.vector_id, m.authored_by, m.provenance, lc.valid_as_of
       FROM memories m
       LEFT JOIN memory_lifecycle lc ON lc.memory_id = m.id
       WHERE m.namespace = ? AND m.id = ?`
    )
      .bind(namespace, match.id)
      .first<{
        id: string;
        type: string;
        source: string;
        updated_at: string;
        vector_id: string | null;
        valid_as_of: string | null;
        authored_by: string | null;
        provenance: string | null;
      }>());
  if (
    current &&
    (current.source !== SCOPED_DECISION_SOURCE ||
      current.type !== "decision" ||
      isExplicitMemory(current) ||
      !current.valid_as_of)
  ) {
    return null;
  }

  if (current?.valid_as_of && Date.parse(current.valid_as_of) >= newest) {
    await recordLateDecisionEvidence(env, {
      namespace,
      targetId: current.id,
      expectedUpdatedAt: current.updated_at,
      revisionId,
      content: candidate.content,
      factKey: key,
      validAsOf: at,
      sourceMessageIds: ids,
      provenance: origin
    });
    return { id: revisionId, current: false };
  }

  await commitScopedDecision(env, {
    namespace,
    id,
    factKey: key,
    content: candidate.content,
    validAsOf: at,
    sourceMessageIds: ids,
    provenance: origin,
    confidence: candidate.confidence,
    importance: candidate.importance,
    previous: current ? { id: current.id, updatedAt: current.updated_at, vectorId: current.vector_id } : null
  });
  return { id, current: true };
}
