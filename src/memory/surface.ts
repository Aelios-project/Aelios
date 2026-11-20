// LMC-5 surface(): readable notes, not a JSON dump.
// A single markdown list is what actually gets used; models treat JSON blobs as debris.

import { cleanMessageText } from "../utils/sanitize";

export interface SurfaceEntry {
  kind: string;
  content: string;
  id?: string;
  /** Accounting provenance; never accept a namespace from the client request. */
  namespace?: string;
  /** Raw quote ids for trace/debug only; never rendered into the prompt. */
  sourceIds?: string[];
  /** Already a bounded evidence window; do not re-truncate the stored sentence. */
  exact?: boolean;
  window?: number;
  purpose?: "answer" | "association";
  recordedDate?: string | null;
  eventDate?: string | null;
  factKey?: string | null;
  speaker?: string;
  currentState?: import("./currentState/projection").CurrentState;
}

export interface SurfaceOptions {
  budget?: number;
  maxItems?: number;
  maxChars?: number;
}

export interface AssembledSurface {
  text: string;
  entries: SurfaceEntry[];
}

function truncateEntry(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(maxChars - 1, 8)).trim()}…`;
}

export function assembleRecallSurface(entries: SurfaceEntry[], options: SurfaceOptions = {}): AssembledSurface {
  const budget = options.budget ?? 6000;
  const maxItems = options.maxItems ?? entries.length;
  const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY;
  const cleaned = entries
    .map((entry) => {
      const text = cleanMessageText(entry.content);
      return {
        kind: entry.kind.trim(),
        content: entry.exact ? text : truncateEntry(text, maxChars),
        ...(entry.id ? { id: entry.id } : {}),
        ...(entry.namespace ? { namespace: entry.namespace } : {}),
        ...(entry.sourceIds?.length ? { sourceIds: entry.sourceIds } : {}),
        ...(entry.exact ? { exact: true } : {}),
        ...(entry.window !== undefined ? { window: entry.window } : {}),
        ...(entry.purpose ? { purpose: entry.purpose } : {})
      };
    })
    .filter((entry) => entry.kind && entry.content);
  if (cleaned.length === 0) return { text: "", entries: [] };

  const header = "[Aelios 记忆：仅供本轮参考，可能已经过时]\n";
  const footer = "\n[/Aelios 记忆]";
  const overhead = header.length + footer.length;

  const lines: string[] = [];
  const used: SurfaceEntry[] = [];
  let usedChars = 0;
  for (const entry of cleaned) {
    if (used.length >= Math.max(maxItems, 0)) break;
    const remaining = budget - overhead - usedChars;
    if (remaining <= 24) break;
    if (entry.exact && entry.content.length + 4 > remaining) continue;
    const content = entry.content.length + 4 > remaining
      ? `${entry.content.slice(0, Math.max(remaining - 4, 8)).trim()}…`
      : entry.content;
    const line = `- ${content}`;
    lines.push(line);
    used.push({ ...entry, content });
    usedChars += line.length + 1;
  }

  if (lines.length === 0) return { text: "", entries: [] };
  return { text: header + lines.join("\n") + footer, entries: used };
}

export function formatRecallSurface(entries: SurfaceEntry[], budgetOrOptions: number | SurfaceOptions = 6000): string {
  const options = typeof budgetOrOptions === "number" ? { budget: budgetOrOptions } : budgetOrOptions;
  return assembleRecallSurface(entries, options).text;
}
