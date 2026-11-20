// Copy detection between a derived text and its possible source. Whitespace,
// punctuation and case are ignored, so reflowed or re-punctuated copies still match.

/** Consecutive characters that count as copied text. Shorter sources must be copied whole. */
export const COPIED_SPAN = 12;
/** Below this many characters a source is too generic to call a copy ("好的", "ok"). */
const MIN_SOURCE = 6;

function fold(text: string): string[] {
  return [...text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "")];
}

/** True when `derived` repeats a span of `source` long enough to be a copy rather than shared vocabulary. */
export function copiesSourceText(derived: string, source: string, span = COPIED_SPAN): boolean {
  const a = fold(derived);
  const b = fold(source);
  const need = Math.min(span, b.length);
  if (need < MIN_SOURCE || a.length < need) return false;
  const grams = new Set<string>();
  for (let i = 0; i + need <= a.length; i++) grams.add(a.slice(i, i + need).join(""));
  for (let i = 0; i + need <= b.length; i++) if (grams.has(b.slice(i, i + need).join(""))) return true;
  return false;
}
