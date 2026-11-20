-- Indexed by the transcript day, including jobs that run days later.
CREATE INDEX idx_dream_candidate_day ON memory_candidates(namespace,json_extract(provenance,'$.dream_date'), status,updated_at)
WHERE source='dream_extract';

-- A review and a ledger extension can overlap while the model is running.
-- Do not apply a verdict to a rewritten/withdrawn proposal, or overwrite an emerging current version.
CREATE TRIGGER guard_auto_candidate_insert BEFORE INSERT ON memories
WHEN NEW.source='judge' AND json_extract(NEW.provenance,'$.candidate_id') IS NOT NULL AND (
  NOT EXISTS (SELECT 1 FROM memory_candidates c WHERE c.namespace=NEW.namespace
    AND c.id=json_extract(NEW.provenance,'$.candidate_id') AND c.status='pending' AND c.content=NEW.content)
  OR EXISTS (SELECT 1 FROM memories m WHERE m.namespace=NEW.namespace AND m.fact_key=NEW.fact_key AND m.status='active'))
BEGIN SELECT RAISE(ABORT,'candidate or current memory changed during review'); END;

CREATE TRIGGER guard_auto_successor BEFORE INSERT ON memory_lifecycle
WHEN NEW.supersedes_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM memories next WHERE next.id=NEW.memory_id AND next.namespace=NEW.namespace AND next.source IN ('judge','dream')
  AND json_extract(next.provenance,'$.creation_mode')='dream_derived'
  AND NOT EXISTS (SELECT 1 FROM memories old WHERE old.id=NEW.supersedes_id AND old.namespace=NEW.namespace
    AND old.superseded_by=next.id AND old.authored_by IS NULL AND coalesce(old.source,'') NOT IN ('mcp','remember_now')
    AND coalesce(json_extract(old.provenance,'$.creation_mode'),'unknown') NOT IN ('agent_explicit','user_explicit')))
BEGIN SELECT RAISE(ABORT,'automatic review target changed'); END;

CREATE TRIGGER guard_reviewed_ledger BEFORE UPDATE OF content,provenance ON memory_candidates
WHEN OLD.status='pending' AND EXISTS (SELECT 1 FROM memories m WHERE m.namespace=OLD.namespace
  AND json_extract(m.provenance,'$.candidate_id')=OLD.id)
BEGIN SELECT RAISE(ABORT,'candidate already applied'); END;
