
import { getMessagesByIds } from "../../../db/messages";
import {
  getMemoryCandidateById,
  IMPORT_CANDIDATE_SOURCES,
  isImportCandidateSource,
  listMemoryCandidates,
  updateMemoryCandidateStatus
} from "../../../db/v2";
import {
  approveCandidate,
  judgeKindFor,
  judgeNotePrefix,
  loadOldMemoryForCandidate,
  parseJsonArray
} from "../../../memory/candidateJudge";
import { formatSpeakerTranscript, loadSpeakersForNamespace } from "../../../memory/speakers";
import type { Env, KeyProfile } from "../../../types";
import { readPositiveInt, readString, resolveNamespace } from "../../../utils/request";
import { hasScope, textToolResult, toolError } from "../protocol";

export async function handleReviewTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  profile: KeyProfile
): Promise<Record<string, unknown> | null> {
  if (name === "memory_candidates") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    const namespace = resolveNamespace(profile, args.namespace);
    const limit = readPositiveInt(args.limit, 20, 50);
    // zone_full 是区满了被挡下的，这里批不了，不列。导入的候选等本人在审核页点，也不列。
    const pending = await listMemoryCandidates(env.DB, {
      namespace,
      status: "pending",
      limit: 200,
      excludeSources: ["zone_full", ...IMPORT_CANDIDATE_SOURCES]
    });
    const speakers = await loadSpeakersForNamespace(env, namespace);
    const data = [];
    for (const candidate of pending.slice(0, limit)) {
      const ids = parseJsonArray(candidate.source_message_ids);
      const messages = ids.length > 0 ? await getMessagesByIds(env.DB, { namespace, ids }) : [];
      data.push({
        id: candidate.id,
        action: judgeKindFor(candidate.source),
        type: candidate.type,
        content: candidate.content,
        fact_key: candidate.fact_key,
        old_memory: await loadOldMemoryForCandidate(env, namespace, candidate),
        transcript: messages.length > 0 ? formatSpeakerTranscript(messages, speakers, 600) : null,
        created_at: candidate.created_at
      });
    }
    return textToolResult({ data, pending: pending.length });
  }

  if (name === "memory_review") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const namespace = resolveNamespace(profile, args.namespace);
    const id = readString(args.id);
    const decision = readString(args.decision);
    if (!id) return toolError("id is required");
    if (decision !== "approve" && decision !== "discard") return toolError("decision must be approve or discard");
    const candidate = await getMemoryCandidateById(env.DB, { namespace, id });
    if (!candidate) return toolError("Candidate not found");
    if (candidate.status !== "pending") return toolError(`Candidate was already decided (${candidate.status})`);
    if (decision === "approve" && candidate.source === "zone_full") {
      return toolError("This candidate is held back because its memory zone is full; leave it for the person");
    }
    if (isImportCandidateSource(candidate.source)) {
      return toolError("This candidate came from an import; the person reviews imports themselves on the review page");
    }
    const speakers = await loadSpeakersForNamespace(env, namespace);
    const reviewer = (speakers?.assistantName ?? "").replace(/[\]\r\n]/g, "").trim().slice(0, 32) || "助手";
    const reason = (readString(args.reason) ?? "").replace(/\s+/g, " ").trim().slice(0, 300)
      || (decision === "approve" ? "我决定记住。" : "我决定放下。");
    const decisionNote = `${judgeNotePrefix(reviewer)}${reason}`;
    try {
      if (decision === "discard") {
        await updateMemoryCandidateStatus(env.DB, { namespace, id, status: "discarded", decisionNote });
        return textToolResult({ data: { id, status: "discarded", memory_id: null } });
      }
      const memoryId = await approveCandidate(
        env,
        namespace,
        candidate,
        parseJsonArray(candidate.tags),
        parseJsonArray(candidate.source_message_ids),
        "mcp_review"
      );
      await updateMemoryCandidateStatus(env.DB, { namespace, id, status: "approved", targetMemoryId: memoryId, decisionNote });
      return textToolResult({ data: { id, status: "approved", memory_id: memoryId } });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "memory_review failed");
    }
  }


  return null;
}
