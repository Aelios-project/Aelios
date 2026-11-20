import { getMemoryById } from "../../db/memories";
import { getMessagesByIds } from "../../db/messages";
import { upsertMemoryFts } from "../fts";
import { fetchMemoryLifecycleRows } from "../../db/v2/memories";
import { insertMemoryRelation } from "../../db/v2/relations";
import { MAX_REVISIONS_PER_MEMORY } from "../../db/v2/revisions";
import type { Env, MemoryApiRecord, MemoryRecord } from "../../types";
import { nowIso } from "../../utils/time";
import { upsertMemoryEmbedding } from "../embedding";
import type { MemoryProvenance } from "../provenance";
import { toMemoryApiRecord } from "../search";
import type { CurrentState } from "./projection";

export const SCOPED_DECISION_SOURCE = "scoped_decision";

export function isScopedDecisionRecord(
  record: Pick<MemoryRecord, "source" | "type" | "fact_key"> | null | undefined
): boolean {
  if (!record) return false;
  if (record.source === SCOPED_DECISION_SOURCE) return true;
  return record.type === "decision" && Boolean(record.fact_key?.startsWith("decision:"));
}

export async function recordLateDecisionEvidence(
  env: Env,
  input: {
    namespace: string;
    targetId: string;
    expectedUpdatedAt: string;
    revisionId: string;
    content: string;
    factKey: string;
    validAsOf: string;
    sourceMessageIds: string[];
    provenance: MemoryProvenance;
  },
  guard?: D1PreparedStatement
): Promise<void> {
  const result = await env.DB.batch([
    ...(guard ? [guard] : []),
    env.DB.prepare(
      `INSERT INTO memory_revisions
        (id, memory_id, namespace, type, content, source, source_message_ids, fact_key, written_at, reason, created_at, provenance)
       SELECT ?, id, namespace, 'decision', ?, ?, ?, ?, ?, 'late_evidence', ?, ?
       FROM memories
       WHERE namespace = ? AND id = ? AND status = 'active' AND updated_at = ?
         AND source = ? AND type = 'decision' AND authored_by IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM memory_revocations r
           WHERE r.namespace = memories.namespace
             AND r.ref IN (SELECT value FROM json_each(?))
         )
       ON CONFLICT(id) DO NOTHING`
    ).bind(
      input.revisionId,
      input.content,
      SCOPED_DECISION_SOURCE,
      JSON.stringify(input.sourceMessageIds),
      input.factKey,
      input.validAsOf,
      nowIso(),
      JSON.stringify(input.provenance),
      input.namespace,
      input.targetId,
      input.expectedUpdatedAt,
      SCOPED_DECISION_SOURCE,
      JSON.stringify(input.provenance.inputs ?? [])
    ),
    env.DB.prepare(
      `DELETE FROM memory_revisions
       WHERE namespace = ? AND memory_id = ? AND id NOT IN (
         SELECT id FROM memory_revisions
         WHERE namespace = ? AND memory_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?
       )`
    ).bind(input.namespace, input.targetId, input.namespace, input.targetId, MAX_REVISIONS_PER_MEMORY)
  ]);
  if (!result.at(-2)?.meta.changes) {
    throw new Error("Decision evidence or target changed; retry");
  }
}

export async function commitScopedDecision(
  env: Env,
  input: {
    namespace: string;
    id: string;
    factKey: string;
    content: string;
    validAsOf: string;
    sourceMessageIds: string[];
    provenance: MemoryProvenance;
    confidence: number;
    importance: number;
    previous?: { id: string; updatedAt: string; vectorId: string | null } | null;
  },
  guard?: D1PreparedStatement
): Promise<void> {
  const db = env.DB;
  const now = nowIso();
  const vectorId = `mem_${input.id}`;
  const sourceIdsJson = JSON.stringify(input.sourceMessageIds);
  const provenanceJson = JSON.stringify(input.provenance);
  const prev = input.previous ?? null;

  const statements: D1PreparedStatement[] = prev
    ? [
        db.prepare(
          `UPDATE memories
           SET status = 'superseded', version_status = 'superseded', superseded_by = ?, updated_at = ?
           WHERE id = ? AND namespace = ? AND status = 'active' AND updated_at = ?
             AND fact_key = ? AND type = 'decision' AND authored_by IS NULL AND source = ?`
        ).bind(input.id, now, prev.id, input.namespace, prev.updatedAt, input.factKey, SCOPED_DECISION_SOURCE),
        db.prepare("INSERT OR IGNORE INTO memory_lifecycle (memory_id, namespace, seen_count) VALUES (?, ?, 0)")
          .bind(prev.id, input.namespace),
        db.prepare(
          `UPDATE memory_lifecycle
           SET superseded_by_id = ?, review_reason = 'explicit_user_decision'
           WHERE memory_id = ? AND EXISTS (
             SELECT 1 FROM memories WHERE namespace = ? AND id = ? AND superseded_by = ?
           )`
        ).bind(input.id, prev.id, input.namespace, prev.id, input.id),
        db.prepare(
          `INSERT INTO memories (
            id, namespace, type, content, importance, confidence, status, pinned,
            tags, source, source_message_ids, vector_id, created_at, updated_at, expires_at,
            fact_key, version_status, superseded_by, authored_by, response_tendency, provenance
          ) SELECT ?, ?, 'decision', ?, ?, ?, 'active', 0, '[]', ?, ?, ?, ?, ?, NULL, ?, 'current', NULL, NULL, NULL, ?
          WHERE EXISTS (
            SELECT 1 FROM memories WHERE namespace = ? AND id = ? AND superseded_by = ?
          )`
        ).bind(
          input.id, input.namespace, input.content, input.importance, input.confidence,
          SCOPED_DECISION_SOURCE, sourceIdsJson, vectorId, now, now, input.factKey, provenanceJson,
          input.namespace, prev.id, input.id
        ),
        db.prepare(
          `INSERT INTO memory_lifecycle (
            memory_id, namespace, fact_key, supersedes_id, review_reason, valid_as_of, last_seen_at, seen_count, last_injected_at
          ) SELECT ?, ?, ?, ?, 'explicit_user_decision', ?, ?, 0, NULL
          WHERE EXISTS (SELECT 1 FROM memories WHERE namespace = ? AND id = ?)`
        ).bind(input.id, input.namespace, input.factKey, prev.id, input.validAsOf, now, input.namespace, input.id)
      ]
    : [
        db.prepare(
          `INSERT INTO memories (
            id, namespace, type, content, importance, confidence, status, pinned,
            tags, source, source_message_ids, vector_id, created_at, updated_at, expires_at,
            fact_key, version_status, superseded_by, authored_by, response_tendency, provenance
          ) SELECT ?, ?, 'decision', ?, ?, ?, 'active', 0, '[]', ?, ?, ?, ?, ?, NULL, ?, 'current', NULL, NULL, NULL, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM memories WHERE namespace = ? AND fact_key = ? AND status = 'active'
          )`
        ).bind(
          input.id, input.namespace, input.content, input.importance, input.confidence,
          SCOPED_DECISION_SOURCE, sourceIdsJson, vectorId, now, now, input.factKey, provenanceJson,
          input.namespace, input.factKey
        ),
        db.prepare(
          `INSERT INTO memory_lifecycle (
            memory_id, namespace, fact_key, supersedes_id, review_reason, valid_as_of, last_seen_at, seen_count, last_injected_at
          ) SELECT ?, ?, ?, NULL, 'explicit_user_decision', ?, ?, 0, NULL
          WHERE EXISTS (SELECT 1 FROM memories WHERE namespace = ? AND id = ?)`
        ).bind(input.id, input.namespace, input.factKey, input.validAsOf, now, input.namespace, input.id)
      ];

  const committed = await db.batch(guard ? [guard, ...statements] : statements);
  if (!committed.at(-2)?.meta.changes) {
    throw new Error("Decision changed; retry");
  }

  const stored = await getMemoryById(db, { namespace: input.namespace, id: input.id });
  if (stored?.status === "active") {
    try {
      await upsertMemoryEmbedding(env, stored);
    } catch (error) {
      console.error("scoped decision vector sync failed", { id: input.id, error });
    }
  }
  await upsertMemoryFts(db, { namespace: input.namespace, memoryId: input.id, content: input.content });
  if (prev?.vectorId) {
    try {
      await env.VECTORIZE?.deleteByIds([prev.vectorId]);
    } catch (error) {
      console.error("scoped decision old vector delete failed", { id: prev.id, error });
    }
  }
  if (prev) {
    try {
      await insertMemoryRelation(db, {
        srcId: input.id,
        dstId: prev.id,
        relType: "supersedes",
        weight: 1.0,
        createdBy: "manual"
      });
    } catch (error) {
      console.warn("scoped decision relation insert failed", { oldId: prev.id, newId: input.id, error });
    }
  }
}

export async function findOutdatedByDecision(
  db: D1Database,
  namespace: string,
  memoryIds: string[]
): Promise<Map<string, CurrentState>> {
  const result = new Map<string, CurrentState>();
  if (!memoryIds.length) return result;
  const rows = await db
    .prepare(
      `WITH hits(id) AS (SELECT value FROM json_each(?2))
       SELECT d.id, lc.valid_as_of, old.id AS outdated_id
       FROM memories d
       JOIN memory_lifecycle lc ON lc.memory_id = d.id AND lc.namespace = d.namespace
       JOIN memories old ON old.namespace = d.namespace
       JOIN hits ON hits.id = old.id
       WHERE d.namespace = ?1
         AND d.status = 'active'
         AND d.type = 'decision'
         AND d.source = 'scoped_decision'
         AND (d.version_status IS NULL OR d.version_status IN ('current', 'under_review'))
         AND old.id <> d.id
         AND lc.valid_as_of > old.created_at
         AND (d.fact_key = old.fact_key OR EXISTS (
           SELECT 1 FROM json_each(d.provenance, '$.state_of') WHERE value = old.id
         ))
       ORDER BY lc.valid_as_of DESC, d.id`
    )
    .bind(namespace, JSON.stringify(memoryIds))
    .all<{ id: string; valid_as_of: string; outdated_id: string }>();
  for (const row of rows.results) {
    if (!result.has(row.outdated_id)) {
      result.set(row.outdated_id, { status: "outdated", by: row.id, as_of: row.valid_as_of });
    }
  }
  return result;
}

export async function attachCurrentStateMeta(
  db: D1Database,
  namespace: string,
  records: MemoryRecord[]
): Promise<MemoryApiRecord[]> {
  if (!records.length) return [];
  const ids = records.map((record) => record.id);
  const [lifecycles, outdated] = await Promise.all([
    fetchMemoryLifecycleRows(db, ids),
    findOutdatedByDecision(db, namespace, ids)
  ]);
  const lifecycleById = new Map(lifecycles.map((row) => [row.memory_id, row]));
  return records.map((record) => {
    const api = toMemoryApiRecord(record, undefined, lifecycleById.get(record.id) ?? null);
    const currentState = outdated.get(record.id);
    return currentState ? { ...api, current_state: currentState } : api;
  });
}

export interface DecisionChainEntry {
  id: string;
  content: string;
  valid_as_of: string | null;
  created_at: string;
  source_message_ids: string[];
}

export async function loadDecisionHistoryAndSources(
  db: D1Database,
  namespace: string,
  memory: MemoryRecord
): Promise<{
  decision_history: DecisionChainEntry[];
  sources: { messages: Array<{ id: string; role: string; created_at: string; content: string }>; missing: number };
}> {
  const chainRows = memory.fact_key
    ? await db
        .prepare(
          `SELECT m.id, m.content, lc.valid_as_of, m.created_at, m.source_message_ids
           FROM memories m
           LEFT JOIN memory_lifecycle lc ON lc.memory_id = m.id AND lc.namespace = m.namespace
           WHERE m.namespace = ?1
             AND m.fact_key = ?2
             AND m.id <> ?3
             AND m.status = 'superseded'
           ORDER BY COALESCE(lc.valid_as_of, m.created_at) DESC, m.id DESC
           LIMIT 20`
        )
        .bind(namespace, memory.fact_key, memory.id)
        .all<{ id: string; content: string; valid_as_of: string | null; created_at: string; source_message_ids: string | null }>()
    : { results: [] };

  const parseIds = (raw: string | null): string[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  };

  const sourceIds = parseIds(memory.source_message_ids).slice(0, 30);
  const messages = sourceIds.length ? await getMessagesByIds(db, { namespace, ids: sourceIds }) : [];
  return {
    decision_history: chainRows.results.map((row) => ({
      id: row.id,
      content: row.content,
      valid_as_of: row.valid_as_of,
      created_at: row.created_at,
      source_message_ids: parseIds(row.source_message_ids)
    })),
    sources: {
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        created_at: message.created_at,
        content: message.content
      })),
      missing: Math.max(sourceIds.length - messages.length, 0)
    }
  };
}
