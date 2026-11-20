-- Earlier previews added the version predecessor to every approved extract/add, including
-- similarity suggestions the extractor never cited. Keep the IDs as context and the version
-- links in memory_lifecycle. Named digest updates and deletes retain their target evidence.
UPDATE memories AS m SET provenance=json_set(m.provenance,
  '$.context_refs',(SELECT json_group_array(value) FROM (
    SELECT value FROM json_each(m.provenance,'$.context_refs')
    UNION SELECT value FROM json_each(m.provenance,'$.inputs') WHERE value LIKE 'memory:%')),
  '$.inputs',(SELECT json_group_array(value) FROM json_each(m.provenance,'$.inputs') WHERE value NOT LIKE 'memory:%'))
WHERE EXISTS (SELECT 1 FROM json_each(m.provenance,'$.inputs') WHERE value LIKE 'memory:%')
  AND EXISTS (SELECT 1 FROM memory_candidates c WHERE c.namespace=m.namespace
    AND c.id=json_extract(m.provenance,'$.candidate_id') AND c.source IN ('dream_extract','dream_add'));

UPDATE memory_revisions AS m SET provenance=json_set(m.provenance,
  '$.context_refs',(SELECT json_group_array(value) FROM (
    SELECT value FROM json_each(m.provenance,'$.context_refs')
    UNION SELECT value FROM json_each(m.provenance,'$.inputs') WHERE value LIKE 'memory:%')),
  '$.inputs',(SELECT json_group_array(value) FROM json_each(m.provenance,'$.inputs') WHERE value NOT LIKE 'memory:%'))
WHERE EXISTS (SELECT 1 FROM json_each(m.provenance,'$.inputs') WHERE value LIKE 'memory:%')
  AND EXISTS (SELECT 1 FROM memory_candidates c WHERE c.namespace=m.namespace
    AND c.id=json_extract(m.provenance,'$.candidate_id') AND c.source IN ('dream_extract','dream_add'));
