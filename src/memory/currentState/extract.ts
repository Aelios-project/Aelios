import { listActiveFactKeys } from "../../db/v2";
import type { Env, MessageRecord } from "../../types";
import { extractDreamMemoriesFromMessages } from "../dreamExtract";
import type { ExtractedMemory } from "../extract";
import { isExplicitDecisionText } from "./decisionCues";

export const DECISION_FORMAT =
  'For an explicit user decision, include decision: {"scope_key":"user/project/property","value":"exact choice from the message"}, along with type="decision", attributed_role="user", evidence_quote, and source_message_ids. scope_key names the decision scope. Never treat musing, questions, quotes, or roleplay as a decision.';

export async function extractDecisionFallback(
  env: Env,
  input: {
    namespace: string;
    messages: MessageRecord[];
    candidates: ExtractedMemory[];
    deadlineAt: number;
  }
) {
  const keys = (await listActiveFactKeys(env.DB, { namespace: input.namespace }))
    .filter((key) => key.startsWith("decision:user/"));
  const covered = new Set(
    input.candidates
      .filter((candidate) => candidate.decision)
      .flatMap((candidate) => candidate.source_message_ids)
  );
  const message = input.messages.find(
    (entry) => entry.role === "user" && !covered.has(entry.id) && isExplicitDecisionText(entry.content)
  );
  if (!message || Date.now() >= input.deadlineAt) return [];
  const result = await extractDreamMemoriesFromMessages(env, {
    namespace: input.namespace,
    messages: [message],
    diaryBackground: false,
    deadlineAt: input.deadlineAt,
    decisionInstructions: `Re-check only whether this single message states an explicit user decision.\n${DECISION_FORMAT}\nExisting scopes: ${keys.join(", ")}`
  });
  return result.memories.filter((candidate) => candidate.decision);
}
