import type { MessageRecord } from "../types";
import type { ExtractedMemory } from "./extract";

// Match against the actual captured batch. A plausible model-generated ID, role or quote alone proves nothing.
export function groundCandidate(
	memory: ExtractedMemory,
	messages: MessageRecord[],
): ExtractedMemory[] {
	const ids = new Set(memory.source_message_ids);
	const cited = messages.filter((m) => ids.has(m.id));
	if (!cited.length) return [];
	const quote = memory.evidence_quote;
	const role = memory.attributed_role;
	const support = cited.filter(
		(m) =>
			m.role === role &&
			quote &&
			m.content.includes(quote) &&
			(role !== "assistant" ||
				(m.capture_kind !== "includes_tool" &&
					(!m.source?.startsWith("gateway:") || m.capture_kind === "visible"))),
	);
	if ((role || quote) && (!role || !support.length)) return [];
	const evidence = support.length ? support : cited;
	const deciding =
		memory.type === "decision" ||
		/决定|确定选择|decided|committed to/i.test(memory.content);
	if (
		deciding &&
		evidence.every(
			(m) =>
				/[?？]$/.test(m.content.trim()) ||
				/^(?:maybe|perhaps|should I|我在考虑|要不要)/i.test(m.content.trim()),
		)
	)
		return [];
	for (const match of memory.content.matchAll(/「([^」]+)」/g)) {
		if (!evidence.some((m) => m.content.includes(match[1]))) return [];
	}
	return [{ ...memory, source_message_ids: evidence.map((m) => m.id) }];
}
