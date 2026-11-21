import { loadConfig, speakersForNamespace, type DreamSpeakers } from "../gateway/config";
import type { Env, MessageRecord } from "../types";
import { cleanMessageText } from "../utils/sanitize";

export type { DreamSpeakers };

export async function loadSpeakersForNamespace(env: Env, namespace: string): Promise<DreamSpeakers | null> {
  try {
    return speakersForNamespace(await loadConfig(env), namespace);
  } catch {
    return null;
  }
}

export function speakerLabel(role: string, speakers: DreamSpeakers | null): string {
  if (role === "assistant") return speakers?.assistantName ?? "Assistant";
  return speakers?.userName ?? "User";
}

export function formatSpeakerTranscript(
  messages: MessageRecord[],
  speakers: DreamSpeakers | null,
  maxChars: number,
  ellipsis = false
): string {
  return messages
    .map((message) => {
      const text = cleanMessageText(message.content);
      const clipped = text.length <= maxChars ? text : ellipsis ? `${text.slice(0, maxChars)}…` : text.slice(0, maxChars);
      return `[${message.id}][${message.created_at}][${speakerLabel(message.role, speakers)}] ${clipped}`;
    })
    .join("\n\n");
}

export function nameOnlyRule(speakers: DreamSpeakers): string {
  return `Refer to both people strictly by name: "${speakers.userName}" and "${speakers.assistantName}". Never use generic labels like user/assistant or 用户/助手, and do not substitute first/second-person pronouns (I/you, 我/你) for their names.`;
}

export function diarySpeakerRules(speakers: DreamSpeakers | null): string[] {
  if (!speakers) {
    return ['- Write in first person (I) for the assistant; refer to the user naturally (never as "the user").'];
  }
  return [
    `- Speakers: the user is ${speakers.userName}, and the assistant is ${speakers.assistantName}. The transcript below labels turns with these names.`,
    `- This is ${speakers.assistantName}'s personal diary. Refer to the other person as "${speakers.userName}" and to the assistant as "${speakers.assistantName}". ${nameOnlyRule(speakers)}`
  ];
}

export function rollupSpeakerRule(speakers: DreamSpeakers | null): string {
  if (!speakers) {
    return "- Write from the assistant's perspective: use second person for the user and first person for the assistant's own commitments.";
  }
  return `- Speakers: the user is ${speakers.userName}, and the assistant is ${speakers.assistantName}. ${nameOnlyRule(speakers)}`;
}
