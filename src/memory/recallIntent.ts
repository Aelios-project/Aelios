import type { Env } from "../types";

// What a question asks of memory, read from its wording. These cues only change which
// evidence is preferred; RECALL_PROVENANCE_SELECTION=false switches all of them off.

export interface RecallIntent {
  /** How a decision or view changed over time: include history, order by date. */
  evolution: boolean;
  /** What someone wrote themselves. */
  writes: boolean;
  /** What the user decided. */
  userDecision: boolean;
  /** The exact words, which only a retained original message can answer. */
  exact: boolean;
  /** Asking what applies right now. */
  asksCurrent: boolean;
  /** Asking about a past point in time or someone's view back then. */
  asksPastOrView: boolean;
  /** Asking about the assistant's own preference or opinion. */
  asksAssistantView: boolean;
}

export const EMPTY_RECALL_INTENT: RecallIntent = {
  evolution: false,
  writes: false,
  userDecision: false,
  exact: false,
  asksCurrent: false,
  asksPastOrView: false,
  asksAssistantView: false
};

const CURRENT_CUE = /现在|目前|当前|最新|\b(?:now|currently|at the moment|these days|latest)\b/i;
const PAST_OR_VIEW_CUE =
  /\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日|周[一二三四五六日天]|星期[一二三四五六日天]|昨天|前天|上周|上个月|当时|那时|以前|怎么想|觉得|看法|\b(?:yesterday|back then|previously|at the time|last\s+(?:week|month|mon|tue|wed|thu|fri|sat|sun)\w*|on\s+(?:mon|tue|wed|thu|fri|sat|sun)\w*|what did .{1,35} think)\b/i;
const OPINION_OR_PREFERENCE_CUE =
  /喜欢|偏好|觉得|怎么想|看法|\b(?:prefer|prefers|preferred|preference|preferences|like|likes|think|thinks|feel|feels|opinion|view)\b/i;
const SECOND_PERSON_SUBJECT_CUE = /你|您|助手|\b(?:you|your|yourself|assistant)\b/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesAssistantName(query: string, assistantName: string | null | undefined): boolean {
  const name = assistantName?.trim();
  if (!name) return false;
  const escaped = escapeRegExp(name);
  if (/^[a-z0-9._-]+$/i.test(name)) {
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(query);
  }
  return query.toLowerCase().includes(name.toLowerCase());
}

export function asksCurrent(query: string): boolean {
  return CURRENT_CUE.test(query);
}

export function asksPastOrView(query: string): boolean {
  return PAST_OR_VIEW_CUE.test(query);
}

export function asksAssistantView(query: string, assistantName?: string | null): boolean {
  if (!OPINION_OR_PREFERENCE_CUE.test(query)) return false;
  return SECOND_PERSON_SUBJECT_CUE.test(query) || matchesAssistantName(query, assistantName);
}

export function isProvenanceSelectionOn(env: Pick<Env, "RECALL_PROVENANCE_SELECTION">): boolean {
  return env.RECALL_PROVENANCE_SELECTION !== "false";
}

/** A request for wording, not any sentence containing "quote" (a price quote, a quote for an essay). */
export function asksForExactWording(query: string): boolean {
  return /原话|逐字|一字不差|怎么说的|exact (?:wording|words)|word for word|verbatim|what did .{1,35} say/i.test(query);
}

export function readRecallIntent(
  env: Pick<Env, "RECALL_PROVENANCE_SELECTION">,
  query: string,
  assistantName?: string | null
): RecallIntent {
  if (!isProvenanceSelectionOn(env)) return EMPTY_RECALL_INTENT;
  return {
    evolution: /如何演变|怎么演变|决定.{0,5}经过|how did .{0,45}(?:evolve|change)/i.test(query),
    writes: /亲笔|亲自写|写了什么|what did .{1,35} write/i.test(query),
    userDecision: /(?:用户|我)(?:.{0,8})(?:决定|最终选)|(?:user|I) (?:finally )?(?:decide|choose)/i.test(query),
    exact: asksForExactWording(query),
    asksCurrent: asksCurrent(query),
    asksPastOrView: asksPastOrView(query),
    asksAssistantView: asksAssistantView(query, assistantName)
  };
}
