import type { MemoryProvenance } from "./provenance";
import { isExplicitMemory } from "./provenance";

export function isProvisional(row: {
  source?: string | null;
  authored_by?: string | null;
  provenance?: MemoryProvenance;
  tags: string[];
}): boolean {
  return (
    row.provenance?.provisional_recall_baseline !== undefined &&
    row.tags.includes("provisional") &&
    !isExplicitMemory(row)
  );
}

// The baseline is set by the server on a new Dream approval. A user-supplied tag alone has no effect.
export const PROVISIONAL_SQL = `json_type(provenance,'$.provisional_recall_baseline')='integer'
  AND json_extract(provenance,'$.creation_mode')='dream_derived' AND authored_by IS NULL
  AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value='provisional')`;

export function promoteProvisional(db: D1Database, namespace: string, ids: string[], afterRecall = false) {
  return db
    .prepare(`UPDATE memories SET tags=(SELECT json_group_array(value) FROM json_each(tags) WHERE value<>'provisional'),
    provenance=json_remove(provenance,'$.provisional_recall_baseline')
    WHERE namespace=? AND status='active' AND id IN (SELECT value FROM json_each(?)) AND ${PROVISIONAL_SQL}
    ${afterRecall ? "AND recall_count>=json_extract(provenance,'$.provisional_recall_baseline')+2" : ""}`)
    .bind(namespace, JSON.stringify(ids));
}
