-- The preview digest wrote every message in a batch as a diary citation. A real
-- diary written from an existing draft also recorded a day: reference. Without
-- that reference an all-batch list cannot distinguish a draft from an all-cited diary.
-- Keep the original text and the complete ID list for audit. The diary writer can
-- re-establish citations from surviving messages. New writers exclude citations
-- from context_refs, so their rows cannot match this shape.
UPDATE daily_log AS d SET needs_rebuild=1, input_refs='[]', source_message_ids='[]'
WHERE needs_rebuild=0 AND json_array_length(source_message_ids)>0 AND context_refs IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM json_each(d.context_refs) WHERE value LIKE 'day:%')
  AND NOT EXISTS (SELECT 1 FROM json_each(d.source_message_ids) s WHERE NOT EXISTS
    (SELECT 1 FROM json_each(d.context_refs) c WHERE c.value='message:' || s.value))
  AND NOT EXISTS (SELECT 1 FROM json_each(d.context_refs) c WHERE c.value LIKE 'message:%' AND NOT EXISTS
    (SELECT 1 FROM json_each(d.source_message_ids) s WHERE c.value='message:' || s.value));
