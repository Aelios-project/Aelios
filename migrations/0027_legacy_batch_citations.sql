-- Rows written before provenance existed list every message of their Dream batch in
-- source_message_ids. That proves the model read a message, not that the row depends on it,
-- so withdrawing an unrelated line from the batch must not hide them. Keep the legacy edge
-- only when one message is listed. Several-message rows are checked in code at withdrawal:
-- hidden when they copy the withdrawn text, otherwise kept and reported as unverified.
-- The source list matches LEGACY_DERIVED_SOURCES in src/db/v2/revocation/legacy.ts.
DROP VIEW memory_derivations;
-- D1 allows at most five SELECT terms in one compound statement, so the edges are
-- grouped by the table they come from.
CREATE VIEW memory_derivations(namespace, entity, input) AS
  SELECT * FROM (
    SELECT m.namespace, 'memory:' || m.id, j.value FROM memories m, json_each(m.provenance,'$.inputs') j
    UNION ALL SELECT namespace, 'memory:' || id, 'candidate:' || json_extract(provenance,'$.candidate_id') FROM memories
      WHERE json_extract(provenance,'$.candidate_id') IS NOT NULL
    UNION ALL SELECT namespace, 'candidate:' || json_extract(provenance,'$.candidate_id'), 'memory:' || id FROM memories
      WHERE json_extract(provenance,'$.candidate_id') IS NOT NULL
    UNION ALL SELECT m.namespace, 'memory:' || m.id, 'message:' || json_extract(m.source_message_ids,'$[0]') FROM memories m
      WHERE m.provenance IS NULL AND m.authored_by IS NULL AND m.source IN ('dream','judge','extract','dream_extract','remember_now')
        AND json_valid(m.source_message_ids) AND json_array_length(m.source_message_ids)=1
  )
  UNION ALL SELECT * FROM (
    SELECT c.namespace, 'candidate:' || c.id, 'message:' || j.value FROM memory_candidates c,
      json_each(CASE WHEN json_valid(c.source_message_ids) THEN c.source_message_ids END) j
    UNION ALL SELECT t.namespace, 'longtail:' || t.id, 'message:' || j.value FROM longtail t,
      json_each(CASE WHEN json_valid(t.source_message_ids) THEN t.source_message_ids END) j
    UNION ALL SELECT c.namespace, 'candidate:' || c.id, j.value FROM memory_candidates c, json_each(c.provenance,'$.inputs') j
  )
  UNION ALL SELECT * FROM (
    SELECT d.namespace, 'day:' || d.date || '@' || d.updated_at, 'message:' || j.value FROM daily_log d,
      json_each(CASE WHEN json_valid(d.source_message_ids) THEN d.source_message_ids END) j
    UNION ALL SELECT d.namespace, 'day:' || d.date || '@' || d.updated_at, j.value FROM daily_log d, json_each(d.input_refs) j
  );
