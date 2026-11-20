// Removing one raw line: its row, its keyword index entry, and the links that still name it.

/** Tables whose rows list the raw messages they were made from. */
const CITING_TABLES = ["memories", "memory_candidates", "memory_revisions", "longtail", "daily_log"] as const;

/** Delete the raw row from the capture store, the opt-in archive and the keyword index. */
export function rawRowStatements(db: D1Database, namespace: string, id: string): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM messages WHERE namespace=? AND id=?").bind(namespace, id),
    db.prepare("DELETE FROM chat_archive WHERE namespace=? AND id=?").bind(namespace, id),
    db.prepare("DELETE FROM message_fts WHERE namespace=? AND message_id=?").bind(namespace, id),
    db.prepare(`DELETE FROM memory_events WHERE namespace=? AND event_type='rolling_shadow'
      AND ? IN (SELECT value FROM json_each(payload_json,'$.message_ids'))`).bind(namespace, id),
    db.prepare(`UPDATE memory_events SET payload_json=json_set(payload_json,
      '$.grounded.events', json((SELECT json_group_array(json(e.value)) FROM json_each(payload_json,'$.grounded.events') e
        WHERE ?2 NOT IN (SELECT value FROM json_each(e.value,'$.source_message_ids')))),
      '$.grounded.state_delta.episodes', json((SELECT json_group_array(json(e.value)) FROM json_each(payload_json,'$.grounded.state_delta.episodes') e
        WHERE ?2 NOT IN (SELECT value FROM json_each(e.value,'$.evidence_ids')))),
      '$.grounded.state_delta.open', json((SELECT json_group_array(json(e.value)) FROM json_each(payload_json,'$.grounded.state_delta.open') e
        WHERE ?2 NOT IN (SELECT value FROM json_each(e.value,'$.evidence_ids')))))
      WHERE namespace=?1 AND event_type='rolling_draft' AND EXISTS (
        SELECT 1 FROM json_each(payload_json,'$.grounded.events') e
        WHERE ?2 IN (SELECT value FROM json_each(e.value,'$.source_message_ids'))) `).bind(namespace, id),
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
