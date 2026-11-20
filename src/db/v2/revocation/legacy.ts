import { copiesSourceText } from "../../../memory/verbatim";

// Rows written before provenance existed. Dream listed every message of its batch in
// source_message_ids, so a listed ID proves the model read the line, not that the row
// depends on it. 0027 keeps a single listed ID as a citation; this module decides the rest.

/** Sources of pre-provenance rows that a model derived. Matches migration 0027. */
export const LEGACY_DERIVED_SOURCES = ["dream", "judge", "extract", "dream_extract", "remember_now"] as const;

export interface LegacyCoReaders {
  /** Rows that repeat the withdrawn text: withdrawn with it. */
  copied: string[];
  /** Rows that only shared a batch with it: kept, detached and reported. */
  unverified: string[];
}

/** Split the multi-message legacy rows that list `messageId`. Call before the message is deleted. */
export async function splitLegacyCoReaders(db: D1Database, namespace: string, messageId: string): Promise<LegacyCoReaders> {
  const sources = LEGACY_DERIVED_SOURCES.map((source) => `'${source}'`).join(",");
  const rows = await db
    .prepare(`SELECT id, content FROM memories WHERE namespace=?1 AND provenance IS NULL AND authored_by IS NULL
      AND source IN (${sources}) AND json_valid(source_message_ids) AND json_array_length(source_message_ids)>1
      AND EXISTS (SELECT 1 FROM json_each(source_message_ids) WHERE value=?2)
      AND NOT EXISTS (SELECT 1 FROM memory_revocations r WHERE r.namespace=?1 AND r.ref='memory:' || memories.id)`)
    .bind(namespace, messageId)
    .all<{ id: string; content: string }>();
  const split: LegacyCoReaders = { copied: [], unverified: [] };
  if (!rows.results?.length) return split;
  // Without the text (already expired) nothing can be shown to be a copy.
  const source = await db
    .prepare(`SELECT content FROM messages WHERE namespace=?1 AND id=?2
      UNION ALL SELECT content FROM chat_archive WHERE namespace=?1 AND id=?2 LIMIT 1`)
    .bind(namespace, messageId)
    .first<{ content: string }>();
  for (const row of rows.results) {
    (source && copiesSourceText(row.content, source.content) ? split.copied : split.unverified).push(row.id);
  }
  return split;
}
