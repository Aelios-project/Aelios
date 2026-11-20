// Removing one raw line: its row, its keyword index entry, and the links that still name it.

/** Tables whose rows list the raw messages they were made from. */
const CITING_TABLES = ["memories", "memory_candidates", "memory_revisions", "longtail", "daily_log"] as const;

/** Delete the raw row from the capture store, the opt-in archive and the keyword index. */
export function rawRowStatements(db: D1Database, namespace: string, id: string): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM messages WHERE namespace=? AND id=?").bind(namespace, id),
    db.prepare("DELETE FROM chat_archive WHERE namespace=? AND id=?").bind(namespace, id),
    db.prepare("DELETE FROM message_fts WHERE namespace=? AND message_id=?").bind(namespace, id),
  ];
}

/** Drop the ID from every surviving source list, so nothing points at a line that is gone. */
export function detachStatements(db: D1Database, namespace: string, id: string): D1PreparedStatement[] {
  return CITING_TABLES.map((table) =>
    db
      .prepare(`UPDATE ${table} SET source_message_ids=(
      SELECT json_group_array(value) FROM json_each(source_message_ids) WHERE value<>?2)
      WHERE namespace=?1 AND json_valid(source_message_ids)
        AND EXISTS (SELECT 1 FROM json_each(source_message_ids) WHERE value=?2)`)
      .bind(namespace, id),
  );
}
