-- Nullable fields preserve legacy rows. No transcript, key material or embeddings are copied.
ALTER TABLE memories ADD COLUMN provenance TEXT CHECK (provenance IS NULL OR json_valid(provenance));
ALTER TABLE memory_candidates ADD COLUMN provenance TEXT;
ALTER TABLE memory_revisions ADD COLUMN provenance TEXT;
ALTER TABLE memory_revisions ADD COLUMN authored_by TEXT;
ALTER TABLE messages ADD COLUMN capture_kind TEXT;

CREATE UNIQUE INDEX idx_memory_candidate_result ON memories(namespace, json_extract(provenance, '$.candidate_id'))
  WHERE json_extract(provenance, '$.candidate_id') IS NOT NULL;

-- IDs only. "pending" survives a failed external index cleanup.
CREATE TABLE memory_revocations (
  namespace TEXT NOT NULL,
  ref TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 1,
  applying INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(namespace, ref)
) WITHOUT ROWID;

-- An expired source has no tombstone. An explicitly revoked one must also
-- stay gone when Queue retries or a Dream approval races with deletion.

CREATE TRIGGER skip_revoked_messages BEFORE INSERT ON messages
WHEN EXISTS (SELECT 1 FROM memory_revocations WHERE namespace=NEW.namespace AND ref='message:' || NEW.id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER skip_revoked_chat_archive BEFORE INSERT ON chat_archive
WHEN EXISTS (SELECT 1 FROM memory_revocations WHERE namespace=NEW.namespace AND ref='message:' || NEW.id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER guard_memories_ins BEFORE INSERT ON memories
WHEN NEW.status IN ('active','superseded') AND (EXISTS (SELECT 1 FROM memory_revocations WHERE namespace=NEW.namespace AND ref='memory:' || NEW.id)
  OR EXISTS (SELECT 1 FROM json_each(NEW.provenance, '$.inputs') i
    JOIN memory_revocations r ON r.namespace=NEW.namespace AND r.ref=i.value)
  OR EXISTS (SELECT 1 FROM memory_revocations WHERE namespace=NEW.namespace AND ref='candidate:' || json_extract(NEW.provenance,'$.candidate_id')))
BEGIN SELECT RAISE(ABORT, 'revoked memory input'); END;

CREATE TRIGGER guard_memories_upd BEFORE UPDATE OF status, provenance, content ON memories
WHEN NEW.status IN ('active','superseded') AND (EXISTS (SELECT 1 FROM memory_revocations WHERE namespace=NEW.namespace AND ref='memory:' || NEW.id)
  OR EXISTS (SELECT 1 FROM json_each(NEW.provenance, '$.inputs') i
    JOIN memory_revocations r ON r.namespace=NEW.namespace AND r.ref=i.value)
  OR EXISTS (SELECT 1 FROM memory_revocations WHERE namespace=NEW.namespace AND ref='candidate:' || json_extract(NEW.provenance,'$.candidate_id')))
BEGIN SELECT RAISE(ABORT, 'revoked memory input'); END;

CREATE TRIGGER guard_memory_candidates_ins BEFORE INSERT ON memory_candidates
WHEN (EXISTS (SELECT 1 FROM memory_revocations WHERE namespace=NEW.namespace AND ref='candidate:' || NEW.id)
  OR EXISTS (SELECT 1 FROM json_each(NEW.provenance, '$.inputs') i
    JOIN memory_revocations r ON r.namespace=NEW.namespace AND r.ref=i.value))
BEGIN SELECT RAISE(ABORT, 'revoked memory input'); END;


ALTER TABLE daily_log ADD COLUMN input_refs TEXT;
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
    UNION ALL SELECT namespace, 'candidate:' || id, 'memory:' || target_memory_id FROM memory_candidates
      WHERE target_memory_id IS NOT NULL
  )
  UNION ALL SELECT * FROM (
    SELECT d.namespace, 'day:' || d.date || '@' || d.updated_at, 'message:' || j.value FROM daily_log d,
      json_each(CASE WHEN json_valid(d.source_message_ids) THEN d.source_message_ids END) j
    UNION ALL SELECT d.namespace, 'day:' || d.date || '@' || d.updated_at, j.value FROM daily_log d, json_each(d.input_refs) j
  );

CREATE TRIGGER guard_dream_diary BEFORE INSERT ON daily_log
WHEN EXISTS (SELECT 1 FROM json_each(NEW.source_message_ids) j JOIN memory_revocations r
  ON r.namespace=NEW.namespace AND r.ref='message:' || j.value)
  OR EXISTS (SELECT 1 FROM json_each(NEW.input_refs) j JOIN memory_revocations r
  ON r.namespace=NEW.namespace AND r.ref=j.value)
BEGIN SELECT RAISE(ABORT, 'revoked diary input'); END;

-- Two writers racing to replace one current version cannot create two successors.
CREATE TRIGGER guard_competing_successor BEFORE UPDATE OF superseded_by ON memories
WHEN NEW.superseded_by IS NOT NULL AND OLD.superseded_by IS NOT NULL AND NEW.superseded_by != OLD.superseded_by
BEGIN SELECT RAISE(ABORT, 'memory already superseded'); END;

CREATE TRIGGER guard_longtail_input BEFORE INSERT ON longtail
WHEN EXISTS (SELECT 1 FROM json_each(NEW.source_message_ids) j JOIN memory_revocations r
  ON r.namespace=NEW.namespace AND r.ref='message:' || j.value)
BEGIN SELECT RAISE(ABORT, 'revoked longtail input'); END;
