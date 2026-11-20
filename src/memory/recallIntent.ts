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
}

const NONE: RecallIntent = { evolution: false, writes: false, userDecision: false, exact: false };

export function isProvenanceSelectionOn(env: Pick<Env, "RECALL_PROVENANCE_SELECTION">): boolean {
  return env.RECALL_PROVENANCE_SELECTION !== "false";
}

/** A request for wording, not any sentence containing "quote" (a price quote, a quote for an essay). */
export function asksForExactWording(query: string): boolean {
  return /原话|逐字|一字不差|怎么说的|exact (?:wording|words)|word for word|verbatim|what did .{1,35} say/i.test(query);
}

export function readRecallIntent(env: Pick<Env, "RECALL_PROVENANCE_SELECTION">, query: string): RecallIntent {
  if (!isProvenanceSelectionOn(env)) return NONE;
  return {
    evolution: /如何演变|怎么演变|决定.{0,5}经过|how did .{0,45}(?:evolve|change)/i.test(query),
    writes: /亲笔|亲自写|写了什么|what did .{1,35} write/i.test(query),
    userDecision: /(?:用户|我)(?:.{0,8})(?:决定|最终选)|(?:user|I) (?:finally )?(?:decide|choose)/i.test(query),
    exact: asksForExactWording(query),
  };
}
