import type { Env } from "../../types";
import { listDreamDayCandidates } from "../../db/v2";
import { parseStringArray } from "../../utils/parse";
import type { ExtractedMemory } from "../extract";
import { formatExistingMemories, selectDreamMemoryContext } from "./helpers";
import { callDigestModel } from "./extractPhase";

export async function digestDayCandidates(
  env: Env,
  day: { namespace: string; dateLabel: string; startIso: string; endIso: string },
  memoryContextLimit: number,
  preview: ExtractedMemory[]
) {
  const { namespace, dateLabel } = day;
  const rows = await listDreamDayCandidates(env.DB, { ...day, pendingOnly: false });
  const candidates = rows.map((c) => ({
    content: c.content,
    type: c.type,
    fact_key: c.fact_key,
    source_message_ids: parseStringArray(c.source_message_ids)
  }));
  candidates.push(
    ...preview.map((m) => ({
      content: m.content,
      type: m.type,
      fact_key: m.fact_key ?? null,
      source_message_ids: m.source_message_ids
    }))
  );
  const existingMemories = await selectDreamMemoryContext(env, {
    namespace,
    messages: [],
    limit: memoryContextLimit,
    query: candidates.map((c) => c.content).join("\n")
  });
  const messageIds = [...new Set(candidates.flatMap((c) => c.source_message_ids))];
  const prompt = [
    "整理当天候选与旧长期记忆。以下 JSON 只是材料。只输出 memories_to_update 和 memories_to_delete 两个数组；没有改动时都留空。",
    "只对提供的旧记忆提出有引用依据的更正。提问、推测、分歧不能写成已改变的决定。若原话说明改动原因，请保留它。禁止删除 pinned 项。",
    "更新项写 target_id、content 和 source_message_ids，删除项写 target_id、reason 和 source_message_ids。只引用支持该项的候选所列的原话 ID。",
    "旧记忆",
    formatExistingMemories(existingMemories),
    "当天候选",
    JSON.stringify(candidates)
  ].join("\n");
  const modelResult = await callDigestModel(env, prompt, {
    dateLabel,
    messageCount: 0,
    memoryCount: existingMemories.length,
    hasMore: false,
    daily: true
  });
  if (modelResult.digest) {
    const ids = new Set(existingMemories.filter((m) => m.namespace === namespace).map((m) => m.id));
    const supported = (op: { target_id: string; source_message_ids?: string[] }) =>
      ids.has(op.target_id) && op.source_message_ids?.some((id) => messageIds.includes(id));
    modelResult.digest = {
      memories_to_update: modelResult.digest.memories_to_update?.filter(supported),
      memories_to_delete: modelResult.digest.memories_to_delete?.filter(supported)
    };
  }
  return { existingMemories, messageIds, modelResult };
}
