/** One final decision across all authorized spaces and memory sources. */
import type { Env } from "../types";
import { readRecallIntent } from "./recallIntent";
import { cleanMessageText } from "../utils/sanitize";
import { evidenceWindows, formatExactExcerpt } from "./dankeRecall";
import { isEvidenceQuery, lexicalOverlapScore, shapeRecallQuery } from "./queryShape";
import { IMPRESSION_DISCLAIMER } from "./impression";
import type { SurfaceEntry } from "./surface";

export interface SelectorCandidate {
  id: string;
  windows: string[];
  entry: SurfaceEntry;
}
export interface RecallDecision {
  id?: string;
  namespace?: string;
  kind: string;
  reason: string;
  window?: number;
  purpose?: string;
  excerpt?: string;
  score?: number;
}
export interface SelectorResult {
  entries: SurfaceEntry[];
  decisions: RecallDecision[];
  status: "reranked" | "lexical" | "empty";
  reason?: string;
  model?: string;
  threshold?: number;
  elapsedMs?: number;
}
export interface SelectorInput {
  query: string;
  recent: string[];
  visible?: string;
  entries: SurfaceEntry[];
  maxItems: number;
}

const MAX_CANDIDATES = 16;
const MAX_WINDOWS = 4;
const LATEST = /最近一次|最后一次|上一次|最新|last time|most recent|latest/i;
const canonical = (s: string) => s.toLowerCase().replace(/[\s\p{P}]/gu, "");
const trace = (entry: SurfaceEntry, reason: string): RecallDecision => ({
  id: entry.id, namespace: entry.namespace, kind: entry.kind, reason
});

export function spanRerankerSettings(env: Env) {
  const raw = env.MEMORY_RERANKER_MODEL?.trim() || "@cf/baai/bge-reranker-base";
  const model = raw.replace(/^(?:workers-ai|worker)\//, "");
  const score = Number(env.RECALL_RERANK_MIN_SCORE?.trim() || "0.25");
  const ms = Number(env.RECALL_RERANK_TIMEOUT_MS?.trim() || "1500");
  return {
    model,
    threshold: Number.isFinite(score) ? score : 0.25,
    timeout: Number.isFinite(ms) ? Math.max(100, Math.min(5000, ms)) : 1500
  };
}

/** The reranker binding answers with either a bare array of rows or a one-key envelope. */
type RerankerOutput =
  | { id?: unknown; index?: unknown; score?: unknown }[]
  | { response?: unknown; result?: unknown; data?: unknown }
  | null
  | undefined;

async function scoreRecallSpans(env: Env, query: string, texts: string[]) {
  const { model, timeout } = spanRerankerSettings(env);
  if (env.ENABLE_MEMORY_RERANKER === "false") throw new Error("reranker_disabled");
  if (!env.AI) throw new Error("reranker_missing_binding");
  if (!model.startsWith("@cf/")) throw new Error("reranker_unsupported_model");
  if (!texts.length || texts.length > 64) throw new Error("reranker_invalid_budget");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Workers AI types the model name and its options as per-model literal unions;
    // ours comes from a setting, so widen to whatever `run` accepts.
    type RunArgs = Parameters<NonNullable<Env["AI"]>["run"]>;
    const output = await Promise.race([
      env.AI.run(model as RunArgs[0], { query, contexts: texts.map(text => ({ text })), top_k: texts.length } as RunArgs[1]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("reranker_timeout")), timeout); })
    ]) as RerankerOutput;
    const rows = Array.isArray(output) ? output : output?.response ?? output?.result ?? output?.data;
    if (!Array.isArray(rows) || rows.length !== texts.length) throw new Error("reranker_invalid_response");
    const seen = new Set<number>();
    const scores = new Array<number>(texts.length);
    for (const row of rows) {
      const id = row?.id ?? row?.index;
      if (!Number.isInteger(id) || id < 0 || id >= texts.length || seen.has(id) ||
          typeof row?.score !== "number" || !Number.isFinite(row.score)) throw new Error("reranker_invalid_response");
      seen.add(id); scores[id] = row.score;
    }
    return scores;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    throw new Error(/^reranker_[a-z_]+$/.test(reason) ? reason : "reranker_failed");
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Keep short records intact. Long-record windows include the preceding sentence. */
export function contextualWindows(content: string, query: string): string[] {
  const sections = content.split(/(?:^|\n)(?:【对话归档\s+v\d+\s+[^】]*】|(?:摘要|事实|原话|情绪)[：:]?)[ \t]*(?=\n|$)/g).map(s => s.trim()).filter(Boolean);
  if (sections.length !== 1 || sections[0] !== content) return sections.flatMap(s => contextualWindows(s, query));
  if (content.length <= 400) return [content];
  const units = [...content.matchAll(/[^\n。！？；]+(?:[。！？；]+|\n|$)/g)];
  const spans: string[] = [];
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const start = units[Math.max(0, i - 1)].index!;
    const end = unit.index! + unit[0].length;
    const text = content.slice(start, end).trim();
    if (text && text.length <= 400) spans.push(text);
  }
  const nominated = evidenceWindows(content, query);
  return [...new Set(spans)].sort((a, b) =>
    Number(nominated.some(w => b.includes(w))) - Number(nominated.some(w => a.includes(w))));
}

export function prepareSelectorCandidates(input: SelectorInput): { candidates: SelectorCandidate[]; decisions: RecallDecision[] } {
  const shaped = shapeRecallQuery({ query: input.query, recent: input.recent });
  const candidates: SelectorCandidate[] = [];
  const decisions: RecallDecision[] = [];
  const visible = canonical(cleanMessageText(input.visible || ""));
  const seen = new Set<string>();
  const seenSources = new Map<string, Set<string>>();
  for (const entry of input.entries) {
    const content = cleanMessageText(entry.content);
    if (!content) { decisions.push(trace(entry, "empty_content")); continue; }
    const textKey = canonical(content.replace(/^(?:请)?记住[：:\s]*/, ""));
    const key = `${entry.speaker || ""}\n${entry.eventDate || ""}\n${textKey}`;
    const sourceKeys = (entry.sourceIds || []).map(id => `${entry.namespace}\n${id}`);
    if (seen.has(key) || sourceKeys.some(id => seenSources.get(id)?.has(textKey))) {
      decisions.push(trace(entry, "duplicate_content")); continue;
    }
    seen.add(key);
    for (const id of sourceKeys) {
      const texts = seenSources.get(id) || new Set<string>(); texts.add(textKey); seenSources.set(id, texts);
    }
    const allWindows = contextualWindows(content, shaped.embeddingQuery);
    let windows = allWindows.filter(w => !visible || !visible.includes(canonical(w)));
    if (!windows.length) { decisions.push(trace(entry, allWindows.length ? "already_visible" : "no_safe_window")); continue; }
    if (candidates.length >= MAX_CANDIDATES) { decisions.push(trace(entry, "candidate_budget")); continue; }
    const ranked = windows.map((w, i) => ({ i, score: lexicalOverlapScore(w, shaped.lexicalTokens) }))
      .sort((a, b) => b.score - a.score || a.i - b.i).slice(0, MAX_WINDOWS);
    windows = ranked.sort((a, b) => a.i - b.i).map(r => windows[r.i]);
    candidates.push({ id: `c${candidates.length}`, windows, entry });
  }
  return { candidates, decisions };
}

function renderSpan(c: SelectorCandidate, window: number, purpose: "answer" | "association"): SurfaceEntry {
  const prefix = c.entry.kind === "impression" ? `${IMPRESSION_DISCLAIMER} `
    : c.entry.speaker === "user" ? "用户原话：" : c.entry.speaker === "assistant" ? "助手原话："
    : c.entry.speaker ? "对话摘录（说话人未区分）：" : "";
  return { ...c.entry, exact: true, window, purpose, content: prefix + formatExactExcerpt(c.windows[window], purpose) };
}

function recallPurpose(query: string): "answer" | "association" {
  return isEvidenceQuery(query.replace(LATEST, " ")) ? "answer" : "association";
}

type RankedSpan = { c: SelectorCandidate; text: string; window: number; score: number };
/** How this turn selects: answering vs. associating, and whether only original wording may surface. */
type Selection = { purpose: "answer" | "association"; exactOnly: boolean };

function pickEntries(
  ranked: RankedSpan[],
  input: SelectorInput,
  { purpose, exactOnly }: Selection,
  threshold: number | null
): { entries: SurfaceEntry[]; decisions: RecallDecision[] } {
  const entries: SurfaceEntry[] = [];
  const decisions: RecallDecision[] = [];
  const sources = new Set<string>();
  const texts = new Set<string>();
  const facts = new Set<string>();
  const limit = Math.min(input.maxItems, purpose === "answer" ? 2 : 1);
  for (const r of ranked) {
    const sourceKeys = (r.c.entry.sourceIds || []).map(id => `${r.c.entry.namespace}\n${id}`);
    const factKey = r.c.entry.factKey ? `${r.c.entry.namespace}\n${r.c.entry.factKey}` : "";
    const textKey = `${r.c.entry.speaker || ""}\n${r.c.entry.eventDate || ""}\n${canonical(r.text)}`;
    const reason = exactOnly && (r.c.entry.kind !== "quote" || !["user", "assistant"].includes(r.c.entry.speaker ?? "")) ? "original_unavailable"
      : threshold !== null && r.score < threshold ? "below_rerank_threshold"
      : purpose === "answer" && r.c.entry.kind === "impression" ? "impression_not_evidence"
      : factKey && facts.has(factKey) ? "duplicate_fact"
      : texts.has(textKey) ? "duplicate_content"
      : sourceKeys.some(id => sources.has(id)) ? "duplicate_source"
      : entries.length >= limit ? "item_budget"
      : threshold === null ? "lexical_fallback_selected" : "rerank_selected";
    if (reason === "rerank_selected" || reason === "lexical_fallback_selected") {
      entries.push(renderSpan(r.c, r.window, purpose));
      texts.add(textKey);
      if (factKey) facts.add(factKey);
      for (const key of sourceKeys) sources.add(key);
    }
    decisions.push({ ...trace(r.c.entry, reason), score: r.score, window: r.window, purpose, excerpt: r.text });
  }
  return { entries, decisions };
}

function lexicalRanked(input: SelectorInput, candidates: SelectorCandidate[]): RankedSpan[] {
  const tokens = shapeRecallQuery({ query: input.query, recent: input.recent }).lexicalTokens;
  return candidates.map(c => {
    const best = c.windows.map((text, window) => ({ text, window, score: lexicalOverlapScore(text, tokens) }))
      .sort((a, b) => b.score - a.score)[0];
    return { c, ...best };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score);
}

function lexicalFallback(
  input: SelectorInput,
  candidates: SelectorCandidate[],
  selection: Selection,
  reason: string,
  extra: Partial<SelectorResult> = {}
): SelectorResult {
  const picked = pickEntries(lexicalRanked(input, candidates), input, selection, null);
  return { status: "lexical", reason, ...extra, ...picked };
}

async function rerankedSelection(env: Env, input: SelectorInput, candidates: SelectorCandidate[]): Promise<SelectorResult> {
  const { model, threshold } = spanRerankerSettings(env);
  const start = Date.now();
  const purpose = recallPurpose(input.query);
  const selection: Selection = { purpose, exactOnly: readRecallIntent(env, input.query).exact };
  if (LATEST.test(input.query) && purpose === "answer") {
    return { model, threshold, status: "empty", reason: "latest_requires_evidence", entries: [],
      decisions: candidates.map(c => trace(c.entry, "latest_requires_evidence")) };
  }
  const shaped = shapeRecallQuery({ query: input.query, recent: input.recent });
  const spans = candidates.flatMap(c => c.windows.map((text, window) => ({ c, text, window })));
  try {
    const scores = await scoreRecallSpans(env, shaped.embeddingQuery, spans.map(s =>
      s.c.entry.speaker ? `${s.c.entry.speaker}: ${s.text}` : s.text));
    const ranked = candidates.map(c => {
      const indices = spans.flatMap((s, i) => s.c === c ? [i] : []);
      const best = indices.reduce((a, b) => scores[b] > scores[a] ? b : a);
      return { ...spans[best], score: scores[best] };
    }).sort((a, b) => b.score - a.score);
    const picked = pickEntries(ranked, input, selection, threshold);
    return { model, threshold, status: "reranked", entries: picked.entries, decisions: picked.decisions,
      elapsedMs: Date.now() - start };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "reranker_failed";
    return lexicalFallback(input, candidates, selection, reason, { model, threshold, elapsedMs: Date.now() - start });
  }
}

export async function selectRecall(env: Env, input: SelectorInput): Promise<SelectorResult> {
  const { candidates, decisions } = prepareSelectorCandidates(input);
  if (!candidates.length || input.maxItems <= 0) return { status: "empty", entries: [], decisions };
  const result = await rerankedSelection(env, input, candidates);
  return { ...result, decisions: [...decisions, ...result.decisions] };
}
