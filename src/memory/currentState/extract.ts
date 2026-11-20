import { listActiveFactKeys } from "../../db/v2";
import type { Env, MessageRecord } from "../../types";
import { extractDreamMemoriesFromMessages } from "../dreamExtract";
import type { ExtractedMemory } from "../extract";
import { isExplicitDecisionText } from "./decisionCues";

export const DECISION_FORMAT =
	'明确用户决定可加 decision: {"scope_key":"user/project/property","value":"原话中的取值"}。同时给 type=decision、attributed_role=user、evidence_quote、source_message_ids。scope_key 写问题的范围。不要把考虑、提问、引述或扮演认作决定。';

export async function extractDecisionFallback(
	env: Env,
	input: {
		namespace: string;
		messages: MessageRecord[];
		candidates: ExtractedMemory[];
		deadlineAt: number;
	},
) {
	const keys = (
		await listActiveFactKeys(env.DB, { namespace: input.namespace })
	).filter((key) => key.startsWith("decision:user/"));
	const covered = new Set(
		input.candidates
			.filter((candidate) => candidate.decision)
			.flatMap((candidate) => candidate.source_message_ids),
	);
	const message = input.messages.find(
		(message) =>
			message.role === "user" &&
			!covered.has(message.id) &&
			isExplicitDecisionText(message.content),
	);
	if (!message || Date.now() >= input.deadlineAt) return [];
	const result = await extractDreamMemoriesFromMessages(env, {
		namespace: input.namespace,
		messages: [message],
		diaryBackground: false,
		deadlineAt: input.deadlineAt,
		decisionInstructions: `只复核这一句是否有明确决定。\n${DECISION_FORMAT}\n已有范围：${keys.join("、")}`,
	});
	return result.memories.filter((candidate) => candidate.decision);
}
