// Issue #35: diary / impressions are mood, not verified events.

export const IMPRESSION_DISCLAIMER = "Reflective impression only; check original memories or transcripts for verified specifics.";

export function groundedSourceIds(claimed: string[], known: string[]): string[] {
  const allow = new Set(known.filter(Boolean));
  return [...new Set(claimed.filter((id) => allow.has(id)))];
}

export function withImpressionDisclaimer<T extends Record<string, unknown>>(row: T): T & { disclaimer: string } {
  return { ...row, disclaimer: IMPRESSION_DISCLAIMER };
}
