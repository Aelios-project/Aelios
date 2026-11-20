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
  /喜欢|偏好|觉得|怎么想|看法|\b(?:prefer|prefers|preferred|preference|preferences|like|likes|think|thinks|feel|feels|opinion|view)\b/gi;
// Whoever is named last before the preference word in its clause holds the preference:
// "你现在喜欢哪种" asks the assistant, "你记得我现在喜欢哪种吗" asks about the user.
const ASSISTANT_SUBJECT = /你|您|助手|\b(?:you|your|yourself|assistant)\b/gi;
const USER_SUBJECT = /我|咱|\b(?:i|we|my|our|me|us)\b/gi;
const CLAUSE_BREAK = /[，。！？；,.!?;\n]/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namePattern(assistantName: string | null | undefined): RegExp | null {
  const name = assistantName?.trim();
  if (!name) return null;
  const escaped = escapeRegExp(name);
  return /^[a-z0-9._-]+$/i.test(name) ? new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "gi") : new RegExp(escaped, "gi");
}

function lastIndexOf(pattern: RegExp, text: string): number {
  let last = -1;
  for (const match of text.matchAll(pattern)) last = match.index;
  return last;
}

/** A preference or opinion word, whoever holds it. */
export function mentionsPreference(query: string): boolean {
  return query.search(OPINION_OR_PREFERENCE_CUE) >= 0;
}

export function asksCurrent(query: string): boolean {
  return CURRENT_CUE.test(query);
}

export function asksPastOrView(query: string): boolean {
  return PAST_OR_VIEW_CUE.test(query);
}

/** True when some clause asks what the assistant (second person or its configured name) prefers or thinks. */
export function asksAssistantView(query: string, assistantName?: string | null): boolean {
  const name = namePattern(assistantName);
  return query.split(CLAUSE_BREAK).some((clause) => {
    const cue = lastIndexOf(OPINION_OR_PREFERENCE_CUE, clause);
    if (cue < 0) return false;
    const before = clause.slice(0, cue);
    const assistant = Math.max(lastIndexOf(ASSISTANT_SUBJECT, before), name ? lastIndexOf(name, before) : -1);
    return assistant >= 0 && assistant > lastIndexOf(USER_SUBJECT, before);
  });
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
