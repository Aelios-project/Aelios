import { updateMemory } from "../../db/memories";
import { toMemoryApiRecord } from "../../memory/search";
import { isScopedDecisionRecord } from "../../memory/currentState/store";
import { readNumber } from "../../utils/request";
import { authenticate } from "../../auth/apiKey";
import { requireScope } from "../../auth/scopes";
import { createMemory, getMemoryById } from "../../db/memories";
import { getMessagesByIds, retainedMessageIds } from "../../db/messages";
import { findSimilarActiveMemory } from "../../memory/dedupGate";
import { approvedCandidateMemory } from "../../db/v2/candidates";
import { reviewedOrigin, type MemoryProvenance } from "../../memory/provenance";
import { clampMemoryType } from "../../memory/canonicalTypes";
import {
  archiveMemory,
  getImportCandidateDay,
  getMemoryCandidateById,
  IMPORT_CANDIDATE_SOURCES,
  isImportCandidateSource,
  listJudgeDecisionsSince,
  listMemoryCandidates,
  supersedeMemory,
  updateMemoryCandidateStatus,
  upsertMemoryByFactKey
} from "../../db/v2";
import { undoJudgeDecision } from "../../memory/candidateJudge";
import { isClefReviewOn } from "../../memory/clefJudge";
import type { Env, } from "../../types";
import { json, openAiError } from "../../utils/json";
import {
  readJsonObject,
  readPositiveInt,
  readString,
  readStringArray,
  resolveNamespace
} from "../../utils/request";
import {
  parseJsonArray,
  syncMemoryEmbeddingBestEffort,
  toCandidateApiRecord,
  toJudgeDecisionRecord
} from "./shared";

export type ApprovedMemoryResult = {
  id: string;
  action: "upserted" | "superseded" | "created";
  supersededId?: string;
};

async function createApprovedMemoryFromCandidate(
  env: Env,
  input: {
    namespace: string;
    type: string;
    content: string;
    factKey?: string | null;
    confidence: number;
    importance: number;
    tags: string[];
    sourceMessageIds: string[];
    source: string;
    provenance: MemoryProvenance;
    excludeIds?: string[];
    /** 只在新建时用 (导入的候选带着原来的日期)。 */
    createdAt?: string | null;
  }
): Promise<ApprovedMemoryResult> {
  if (input.factKey) {
    const result = await upsertMemoryByFactKey(env, {
      namespace: input.namespace,
      factKey: input.factKey,
      type: input.type,
      content: input.content,
      confidence: input.confidence,
      importance: input.importance,
      tags: input.tags,
      source: input.source,
      provenance: input.provenance,
      sourceMessageIds: input.sourceMessageIds,
      createdAt: input.createdAt
    });
    return { id: result.id, action: "upserted" };
  }

  const hit = await findSimilarActiveMemory(env, {
    namespace: input.namespace,
    content: input.content,
    excludeIds: input.excludeIds
  });
  if (hit && !hit.explicitlyWritten) {
    const result = await supersedeMemory(env, {
      namespace: input.namespace,
      oldId: hit.memory.id,
      newContent: input.content,
      newType: input.type,
      newFactKey: null,
      importance: input.importance,
      confidence: input.confidence,
      tags: input.tags,
      source: input.source,
      provenance: input.provenance,
      sourceMessageIds: input.sourceMessageIds,
      reason: "dedup_gate_supersede",
      createdAt: input.createdAt
    });
    return { id: result.newId, action: "superseded", supersededId: hit.memory.id };
  }

  const created = await createMemory(env.DB, {
    namespace: input.namespace,
    type: input.type,
    content: input.content,
    confidence: input.confidence,
    importance: input.importance,
    tags: input.tags,
    source: input.source,
    provenance: input.provenance,
    sourceMessageIds: input.sourceMessageIds,
    createdAt: input.createdAt
  });
  await syncMemoryEmbeddingBestEffort(env, created);
  return { id: created.id, action: "created" };
}

export async function handleMemoryCandidates(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const url = new URL(request.url);
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2];
  const action = parts[3];

  if (request.method === "GET" && !id) {
    const scopeError = requireScope(auth.profile, "memory:read");
    if (scopeError) return scopeError;
    // scope=daily 只要日常整理出来的，scope=import 只要导入的；不带就全要 (老客户端照旧)。
    const scope = readString(url.searchParams.get("scope"));
    const rows = await listMemoryCandidates(env.DB, {
      namespace,
      status: readString(url.searchParams.get("status")) || "pending",
      limit: readPositiveInt(url.searchParams.get("limit"), 100, 200),
      ...(scope === "daily" ? { excludeSources: IMPORT_CANDIDATE_SOURCES } : {}),
      ...(scope === "import" ? { onlySources: IMPORT_CANDIDATE_SOURCES } : {})
    });
    return json({ data: rows.map(toCandidateApiRecord) });
  }

  // 自动审核这几天替你定下的：GET /v1/candidates/decisions?days=7
  if (request.method === "GET" && id === "decisions" && !action) {
    const scopeError = requireScope(auth.profile, "memory:read");
    if (scopeError) return scopeError;
    const days = readPositiveInt(url.searchParams.get("days"), 7, 31);
    const rows = await listJudgeDecisionsSince(env.DB, {
      namespace,
      sinceIso: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
      limit: readPositiveInt(url.searchParams.get("limit"), 200, 500)
    });
    // auto_review 告诉审核页 clef 每天自动审开没开 (后台设置里的开关)。
    return json({ data: rows.map(toJudgeDecisionRecord), auto_review: isClefReviewOn(env) ? "clef" : null });
  }

  // 候选挂的原话：GET /v1/candidates/:id/sources。导入的旧聊天也在这里查得到 (getMessagesByIds 会去 imported_messages 找)。
  if (request.method === "GET" && id && action === "sources") {
    const readError = requireScope(auth.profile, "memory:read");
    if (readError) return readError;
    const candidate = await getMemoryCandidateById(env.DB, { namespace, id });
    if (!candidate) return openAiError("Candidate not found", 404);
    const ids = parseJsonArray(candidate.source_message_ids).slice(0, 90);
    const messages = await getMessagesByIds(env.DB, { namespace, ids });
    return json({
      data: {
        messages: messages.map((message) => ({
          id: message.id,
          role: message.role,
          created_at: message.created_at,
          content: message.content
        })),
        missing: Math.max(ids.length - messages.length, 0)
      }
    });
  }

  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;
  if (!id || request.method !== "POST") return openAiError("Not found", 404);

  const candidate = await getMemoryCandidateById(env.DB, { namespace, id });
  if (!candidate) return openAiError("Candidate not found", 404);
  const body = (await readJsonObject(request)) ?? {};
  const content = readString(body.content) || candidate.content;
  const type = clampMemoryType(readString(body.type) || candidate.type, "note");
  const factKey = body.fact_key === null ? null : readString(body.fact_key) ?? candidate.fact_key;
  const confidence = readNumber(body.confidence, candidate.confidence);
  const importance = readNumber(body.importance, candidate.importance);
  const tags = Array.isArray(body.tags) ? readStringArray(body.tags) : parseJsonArray(candidate.tags);
  const sourceMessageIds = Array.isArray(body.source_message_ids)
    ? await retainedMessageIds(env.DB, namespace, readStringArray(body.source_message_ids))
    : parseJsonArray(candidate.source_message_ids);

  const provenance = reviewedOrigin(candidate, "review", content !== candidate.content || Array.isArray(body.source_message_ids));
  if (action === "undo") {
    const result = await undoJudgeDecision(env, namespace, candidate);
    if (!result.ok) return openAiError(result.error, result.httpStatus);
    return json({
      data: {
        candidate: result.candidate ? toJudgeDecisionRecord(result.candidate) : null,
        status: result.status,
        memory_id: result.memoryId,
        ...(result.restoredId ? { restored_id: result.restoredId } : {})
      }
    });
  }

  if (action === "approve") {
    const saved = await approvedCandidateMemory(env.DB, namespace, candidate.id);
    if (saved) {
      const updated = candidate.status === "pending" ? await updateMemoryCandidateStatus(env.DB, {
        namespace, id, status: "approved", targetMemoryId: saved
      }) : candidate;
      return json({data: {candidate: updated ? toCandidateApiRecord(updated) : null, memory_id: saved}});
    }
    if (candidate.source === "dream_delete" && candidate.target_memory_id) {
      const archived = await archiveMemory(env, { namespace, id: candidate.target_memory_id });
      if (!archived) return openAiError("Target memory not found", 404);
      const updated = await updateMemoryCandidateStatus(env.DB, {
        namespace,
        id,
        status: "approved",
        targetMemoryId: candidate.target_memory_id,
        decisionNote: readString(body.decision_note) || "dream_delete approved"
      });
      return json({
        data: {
          candidate: updated ? toCandidateApiRecord(updated) : null,
          memory_id: candidate.target_memory_id
        }
      });
    }

    // 导入的候选：新记忆的 created_at 用那天的日期 (聊天那天或条目上写的)，updated_at 照旧是现在。
    const importDay = isImportCandidateSource(candidate.source)
      ? await getImportCandidateDay(env.DB, { candidateId: candidate.id })
      : null;
    const importCreatedAt = importDay && /^\d{4}-\d{2}-\d{2}$/.test(importDay) ? `${importDay}T12:00:00.000Z` : null;

    if (candidate.target_memory_id) {
      const target = await getMemoryById(env.DB, { namespace, id: candidate.target_memory_id });
      const targetActive =
        target &&
        target.status === "active" &&
        target.version_status !== "superseded";
      if (targetActive) {
        const result = await supersedeMemory(env, {
          namespace,
          oldId: candidate.target_memory_id,
          newContent: content,
          newType: type,
          newFactKey: factKey,
          confidence,
          importance,
          tags,
          source: "review",
          provenance,
          sourceMessageIds,
          reason: "approve_update",
          createdAt: importCreatedAt
        });
        const updated = await updateMemoryCandidateStatus(env.DB, {
          namespace,
          id,
          status: "approved",
          targetMemoryId: result.newId,
          decisionNote: readString(body.decision_note) || "approve_update"
        });
        return json({
          data: {
            candidate: updated ? toCandidateApiRecord(updated) : null,
            memory_id: result.newId,
            action: "superseded",
            superseded_id: candidate.target_memory_id
          }
        });
      }
    }

    const fallbackNote = candidate.target_memory_id
      ? `${readString(body.decision_note) || "approved"}; target_gone_fallback`
      : readString(body.decision_note) || "approved";
    const approval = await createApprovedMemoryFromCandidate(env, {
      createdAt: importCreatedAt,
      namespace,
      type,
      content,
      factKey,
      confidence,
      importance,
      tags,
      sourceMessageIds,
      source: "review",
      provenance,
      excludeIds: candidate.target_memory_id ? [candidate.target_memory_id] : undefined
    });
    const updated = await updateMemoryCandidateStatus(env.DB, {
      namespace,
      id,
      status: "approved",
      targetMemoryId: approval.id,
      decisionNote: fallbackNote
    });
    return json({
      data: {
        candidate: updated ? toCandidateApiRecord(updated) : null,
        memory_id: approval.id,
        action: approval.action,
        ...(approval.supersededId ? { superseded_id: approval.supersededId } : {})
      }
    });
  }

  if (action === "discard") {
    const updated = await updateMemoryCandidateStatus(env.DB, {
      namespace,
      id,
      status: "discarded",
      decisionNote: readString(body.decision_note) || "discarded"
    });
    return json({ data: updated ? toCandidateApiRecord(updated) : null });
  }

  if (action === "merge") {
    const targetId = readString(body.target_id);
    if (!targetId) return openAiError("target_id is required", 400);
    const target = await getMemoryById(env.DB, { namespace, id: targetId });
    if (!target) return openAiError("Target memory not found", 404);
    if (isScopedDecisionRecord(target)) {
      return openAiError(
        "Scoped decision records cannot be edited directly; withdraw the source message or record a new decision instead.",
        409,
        "scoped_decision_immutable"
      );
    }
    const mergedContent = content || target.content;
    const updatedTarget = await updateMemory(env.DB, {
      namespace,
      id: targetId,
      patch: {
        type,
        content: mergedContent,
        provenance,
        confidence: Math.max(confidence, target.confidence),
        importance: Math.max(importance, target.importance),
        tags,
        sourceMessageIds
      },
      revision: { by: "review", reason: "candidate_merge" }
    });
    if (updatedTarget) await syncMemoryEmbeddingBestEffort(env, updatedTarget);
    const updated = await updateMemoryCandidateStatus(env.DB, {
      namespace,
      id,
      status: "merged",
      targetMemoryId: targetId,
      decisionNote: readString(body.decision_note) || "merged"
    });
    return json({ data: { candidate: updated ? toCandidateApiRecord(updated) : null, memory: updatedTarget ? toMemoryApiRecord(updatedTarget) : null } });
  }

  if (action === "supersede") {
    const oldId = readString(body.target_id);
    if (!oldId) return openAiError("target_id is required", 400);
    const result = await supersedeMemory(env, {
      namespace,
      oldId,
      newContent: content,
      newType: type,
      newFactKey: factKey,
      confidence,
      importance,
      tags,
      source: "review",
      provenance,
      sourceMessageIds,
      reason: readString(body.decision_note) || "candidate_supersede"
    });
    const updated = await updateMemoryCandidateStatus(env.DB, {
      namespace,
      id,
      status: "merged",
      targetMemoryId: result.newId,
      decisionNote: readString(body.decision_note) || "superseded"
    });
    return json({ data: { candidate: updated ? toCandidateApiRecord(updated) : null, memory_id: result.newId } });
  }

  return openAiError("Not found", 404);
}

