import { getMessagesByIds } from "../db/messages";
import type { MessageRecord } from "../types";
import { searchFtsIds } from "./fts";
import { isPreciousRelevant, lexicalOverlapScore, tokenizeForIndex } from "./queryShape";
import { cleanMessageText } from "../utils/sanitize";

export const QUOTE_EXCERPT_CHARS = 180;
const QUOTE_EVENT_WINDOW_MS = 90_000;

export interface QuoteHit {
  id: string;
  role: "user" | "assistant" | string;
  content: string;
  excerpt: string;
  created_at: string;
  conversation_id: string;
  seq?: number;
  source_ids?: string[];
  score: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function excerptAroundMatch(
  content: string,
  tokens: string[],
  maxLen = QUOTE_EXCERPT_CHARS
): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;

  const lower = text.toLowerCase();
  let hit = -1;
  let hitLen = 0;
  for (const token of tokens) {
    const needle = token.trim().toLowerCase();
    if (needle.length < 2) continue;
    const idx = lower.indexOf(needle);
    if (idx >= 0 && (hit < 0 || idx < hit)) {
      hit = idx;
      hitLen = needle.length;
    }
  }
  if (hit < 0) return text.slice(0, maxLen);

  const window = Math.max(maxLen - hitLen, 32);
  const before = Math.min(Math.floor(window / 3), hit);
  let start = hit - before;
  if (start + maxLen > text.length) start = Math.max(0, text.length - maxLen);
  const chunk = text.slice(start, start + maxLen);
  return `${start > 0 ? "…" : ""}${chunk}${start + chunk.length < text.length ? "…" : ""}`;
}

function toQuoteHit(row: MessageRecord, tokens: string[]): QuoteHit {
  const content = cleanMessageText(row.content);
  return {
    id: row.id,
    role: row.capture_kind === "includes_tool" || (row.role === "assistant" && row.source?.startsWith("gateway:") && !row.capture_kind)
      ? "assistant_record" : row.role,
    content,
    excerpt: excerptAroundMatch(content, tokens),
    created_at: row.created_at,
    conversation_id: row.conversation_id,
    seq: row.seq,
    source_ids: [row.id],
    score: lexicalOverlapScore(content, tokens)
  };
}

async function searchQuotesLike(
  db: D1Database,
  input: { namespace: string; tokens: string[]; limit: number; excludeIds: Set<string> }
): Promise<QuoteHit[]> {
  const tokens = input.tokens.filter((token) => token.length >= 2).slice(0, 8);
  if (tokens.length === 0) return [];
  const clauses = tokens.map(() => "content LIKE ? ESCAPE '\\'");
  const binds: unknown[] = [input.namespace, ...tokens.map((token) => `%${escapeLike(token)}%`)];
  const result = await db
    .prepare(
      `SELECT * FROM messages
       WHERE namespace = ? AND role IN ('user', 'assistant') AND (${clauses.join(" OR ")})
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(...binds, Math.max(input.limit * 3, 24))
    .all<MessageRecord>();

  return (result.results ?? [])
    .filter((row) => !input.excludeIds.has(row.id))
    .map((row) => toQuoteHit(row, tokens))
    .filter((row) => row.score > 0 && isPreciousRelevant(row.content, tokens))
    .sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at));
}
/** A verbatim quote already present in the request's own history is visible to
 * both parties; recalling it spends budget without adding information. */
export function quoteVisibleIn(hit: Pick<QuoteHit, "content" | "excerpt">, contextText: string): boolean {
  const ctx = cleanMessageText(contextText).replace(/\s+/g, " ");
  if (!ctx.trim()) return false;
  let core = cleanMessageText(hit.excerpt || hit.content).replace(/\s+/g, " ").replace(/^[…\s]+|[…\s]+$/g, "");
  if (core.length > 200) core = core.slice(Math.floor((core.length - 200) / 2), Math.floor((core.length - 200) / 2) + 200);
  if (core.length < 8) core = cleanMessageText(hit.content).replace(/\s+/g, " ").trim().slice(0, 160);
  return core.length >= 8 && ctx.includes(core);
}


export function asksForExactWording(query: string): boolean {
  return /原话|逐字|怎么说的|exact (?:wording|words)|what did .{1,35} say|verbatim|quot(?:e|ation)\b/i.test(query);
}

export async function searchQuotes(
  db: D1Database,
  input: {
    namespace: string;
    query: string;
    tokens?: string[];
    limit?: number;
    excludeIds?: string[];
    /** Current request's visible conversation text; quotes already in it are skipped. */
    excludeVisibleIn?: string;
  }
): Promise<QuoteHit[]> {
  const tokens = input.tokens ?? tokenizeForIndex(input.query, 12);
  const limit = Math.min(Math.max(input.limit ?? 4, 1), 12);
  const excludeIds = new Set(input.excludeIds ?? []);
  const ftsIds = await searchFtsIds(db, "message_fts", "message_id", {
    namespace: input.namespace,
    tokens,
    limit: limit * 3
  });
  const fromFts = ftsIds.length
    ? (await getMessagesByIds(db, { namespace: input.namespace, ids: ftsIds }))
      .filter((row) => !excludeIds.has(row.id) && (row.role === "user" || row.role === "assistant"))
      .map((row) => toQuoteHit(row, tokens))
      .filter((row) => row.score > 0 && isPreciousRelevant(row.content, tokens))
    : [];

  const liked = await searchQuotesLike(db, { namespace: input.namespace, tokens, limit, excludeIds });
  const byId = new Map<string, QuoteHit>();
  for (const hit of [...fromFts, ...liked]) {
    const existing = byId.get(hit.id);
    if (!existing || hit.score > existing.score) byId.set(hit.id, hit);
  }
  const fresh = input.excludeVisibleIn
    ? [...byId.values()].filter(hit => !quoteVisibleIn(hit, input.excludeVisibleIn!))
    : [...byId.values()];
  if (asksForExactWording(input.query)) {
    return fresh.filter(hit => hit.role === "user" || hit.role === "assistant")
      .sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at)).slice(0, limit);
  }
  return clusterQuotes(fresh, limit);

}

function compactKey(text: string): string {
  return cleanMessageText(text).toLowerCase().replace(/\s+/g, "").replace(/[，,。.!！?？；;：:“”"'`、]/g, "");
}

function compareQuoteOrder(a: QuoteHit, b: QuoteHit): number {
  return a.created_at.localeCompare(b.created_at) || (a.seq ?? 0) - (b.seq ?? 0);
}

function withinEventWindow(a: QuoteHit, b: QuoteHit): boolean {
  if (a.conversation_id !== b.conversation_id) return false;
  const delta = Math.abs(Date.parse(a.created_at) - Date.parse(b.created_at));
  return Number.isFinite(delta) && delta <= QUOTE_EVENT_WINDOW_MS;
}

/** Immediate chronological neighbours only. Gateway persist writes user=0 /
 * assistant=1 on every turn, so seq cannot mean "adjacent turn" and must not
 * grow a connected 90s component across a whole session. */
function chronologicalNeighbors(seed: QuoteHit, candidates: QuoteHit[]): QuoteHit[] {
  const pool = [seed, ...candidates.filter((hit) => hit.conversation_id === seed.conversation_id)]
    .sort(compareQuoteOrder);
  const index = pool.findIndex((hit) => hit.id === seed.id);
  if (index < 0) return [];
  const related: QuoteHit[] = [];
  const prev = pool[index - 1];
  const next = pool[index + 1];
  if (prev && withinEventWindow(seed, prev)) related.push(prev);
  if (next && withinEventWindow(seed, next)) related.push(next);
  return related;
}

function mergeQuoteEvent(primary: QuoteHit, related: QuoteHit[]): QuoteHit {
  const event = [primary, ...related];
  const chronological = [...event].sort((a, b) =>
    a.created_at.localeCompare(b.created_at) || (a.seq ?? 0) - (b.seq ?? 0)
  );
  const unique: QuoteHit[] = [];
  for (const hit of [...event].sort((a, b) => b.score - a.score)) {
    const key = compactKey(hit.excerpt || hit.content);
    if (!key || unique.some(other => {
      const seen = compactKey(other.excerpt || other.content);
      return seen === key || seen.includes(key) || key.includes(seen);
    })) continue;
    unique.push(hit);
    if (unique.length >= 2) break;
  }
  unique.sort((a, b) => a.created_at.localeCompare(b.created_at) || (a.seq ?? 0) - (b.seq ?? 0));
  const excerpt = unique.map(hit => hit.excerpt || hit.content).join("；");
  const merged = excerptAroundMatch(excerpt, [], QUOTE_EXCERPT_CHARS);
  return {
    ...primary,
    role: unique.length > 1 ? "conversation" : primary.role,
    content: unique.map(hit => hit.content).join("\n"),
    excerpt: merged,
    source_ids: [...new Set(chronological.flatMap(hit => hit.source_ids ?? [hit.id]))]
  };
}

function clusterQuotes(hits: QuoteHit[], limit: number): QuoteHit[] {
  const kept: QuoteHit[] = [];
  const pending = hits.sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at));
  while (pending.length) {
    const hit = pending.shift()!;
    const related = chronologicalNeighbors(hit, pending);
    for (const neighbor of related) {
      const at = pending.findIndex((candidate) => candidate.id === neighbor.id);
      if (at >= 0) pending.splice(at, 1);
    }
    const duplicate = kept.some((other) =>
      compactKey(other.excerpt).includes(compactKey(hit.excerpt)) || compactKey(hit.excerpt).includes(compactKey(other.excerpt))
    );
    if (duplicate) continue;
    kept.push(mergeQuoteEvent(hit, related));
    if (kept.length >= limit) break;
  }
  return kept;
}

export function formatQuote(hit: QuoteHit, options: { compact?: boolean } = {}): string {
  const quote = cleanMessageText(hit.excerpt || excerptAroundMatch(hit.content, [])).replace(/\s+/g, " ").trim();
  if (options.compact) return quote;
  const day = hit.created_at.slice(0, 10);
  const speaker = hit.role === "assistant" ? "助手" : hit.role === "user" ? "用户" : hit.role === "conversation" ? "对话" : "对话记录";
  return `${day} ${speaker}: 「${quote}」`;
}

export function quoteOverlaps(text: string, quote: string): boolean {
  const a = compactKey(text);
  const b = compactKey(quote);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

/** Auto-recall prefers distilled / precious text. A quote that is already
 * covered by those records is citation noise, not a replacement for them. */
export function keepUncoveredQuotes<T extends { excerpt?: string; content: string }>(
  quotes: T[],
  coveringTexts: string[]
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const quote of quotes) {
    const snippet = quote.excerpt || quote.content;
    if (coveringTexts.some((text) => quoteOverlaps(text, snippet))) dropped.push(quote);
    else kept.push(quote);
  }
  return { kept, dropped };
}
