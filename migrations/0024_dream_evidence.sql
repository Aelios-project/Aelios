-- Upgrade databases that ran the PR preview. Keep prior revocations, never restore content here.
ALTER TABLE daily_log ADD COLUMN context_refs TEXT;
ALTER TABLE daily_log ADD COLUMN needs_rebuild INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_diary_rebuild ON daily_log(namespace,date) WHERE needs_rebuild=1;

UPDATE memory_candidates
SET provenance=json_set(provenance, '$.context_refs', json_extract(provenance,'$.inputs'),
  '$.inputs', (SELECT json_group_array('message:' || value) FROM json_each(
    CASE WHEN json_valid(source_message_ids) THEN source_message_ids END)))
WHERE json_extract(provenance,'$.creation_mode')='dream_derived'
  AND json_type(provenance,'$.inputs')='array' AND json_type(provenance,'$.context_refs') IS NULL;

UPDATE memories
SET provenance=json_set(provenance, '$.context_refs', json_extract(provenance,'$.inputs'),
  '$.inputs', (SELECT json_group_array('message:' || value) FROM json_each(
    CASE WHEN json_valid(source_message_ids) THEN source_message_ids END)))
WHERE json_extract(provenance,'$.creation_mode')='dream_derived'
  AND json_type(provenance,'$.inputs')='array' AND json_type(provenance,'$.context_refs') IS NULL;

UPDATE memory_revisions
SET provenance=json_set(provenance, '$.context_refs', json_extract(provenance,'$.inputs'),
  '$.inputs', (SELECT json_group_array('message:' || value) FROM json_each(
    CASE WHEN json_valid(source_message_ids) THEN source_message_ids END)))
WHERE json_extract(provenance,'$.creation_mode')='dream_derived'
  AND json_type(provenance,'$.inputs')='array' AND json_type(provenance,'$.context_refs') IS NULL;

-- Only an explicitly selected predecessor is recoverable as an evidence link in the preview.
UPDATE memory_candidates SET provenance=json_insert(provenance, '$.inputs[#]', 'memory:' || target_memory_id)
WHERE source IN ('dream_update','dream_delete') AND target_memory_id IS NOT NULL AND status='pending'
  AND json_type(provenance,'$.inputs')='array';

UPDATE memories AS m SET provenance=json_insert(m.provenance,'$.inputs[#]','memory:' || l.supersedes_id)
FROM memory_lifecycle l WHERE l.memory_id=m.id AND l.namespace=m.namespace AND l.supersedes_id IS NOT NULL
  AND json_extract(m.provenance,'$.creation_mode')='dream_derived';

UPDATE daily_log SET context_refs=input_refs, input_refs=(
  SELECT json_group_array('message:' || value) FROM json_each(CASE WHEN json_valid(source_message_ids) THEN source_message_ids END)
) WHERE input_refs IS NOT NULL;

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
    UNION ALL SELECT m.namespace, 'memory:' || m.id, 'message:' || j.value FROM memories m,
      json_each(CASE WHEN json_valid(m.source_message_ids) THEN m.source_message_ids END) j
      WHERE m.provenance IS NULL AND m.authored_by IS NULL AND m.source IN ('dream','judge','extract','dream_extract','remember_now')
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


CREATE TRIGGER guard_candidate_edits BEFORE UPDATE OF provenance,source_message_ids,content ON memory_candidates
WHEN EXISTS (SELECT 1 FROM json_each(NEW.provenance,'$.inputs') j JOIN memory_revocations r
  ON r.namespace=NEW.namespace AND r.ref=j.value)
BEGIN SELECT RAISE(ABORT,'revoked candidate input'); END;
