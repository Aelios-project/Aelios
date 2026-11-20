import type { MemoryProvenance } from "../../memory/provenance";
import { sha256Hex } from "../../utils/hash";
import { clampMemoryType } from "../../memory/canonicalTypes";
import { newId } from "../../utils/ids";
import { nowIso } from "../../utils/time";

export interface MemoryCandidateRow {
  provenance?: string | null;
  id: string;
  namespace: string;
  type: string;
  content: string;
  fact_key: string | null;
  confidence: number;
  importance: number;
  tags: string | null;
  source_message_ids: string | null;
  source: string;
  status: string;
  target_memory_id: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateMemoryCandidateInput {
  provenance?: MemoryProvenance;
  namespace: string;
  type: string;
  content: string;
  factKey?: string | null;
  confidence?: number;
  importance?: number;
  tags?: string[];
  sourceMessageIds?: string[];
  source?: string;
  targetMemoryId?: string | null;
  decisionNote?: string | null;
}

export async function createMemoryCandidate(
  db: D1Database,
  input: CreateMemoryCandidateInput
): Promise<MemoryCandidateRow> {
  // 幂等闸：同一 namespace 下已有等价的 pending 候选就直接复用，不再入队。
  // dream 每晚重跑会对同一目标反复提删除/更新提案，没有这道闸队列会被灌满重复项。
  const observed = input.provenance?.creation_mode === "dream_derived";
  let id = newId("cand");
  if (observed) {
    const refs = input.sourceMessageIds?.length ? input.sourceMessageIds : input.provenance?.inputs;
    const target = input.source === "dream_extract" ? null : input.targetMemoryId;
    const signature = [input.namespace, input.source, input.content, input.factKey, target, [...new Set(refs)].sort()];
    id = `cand_${(await sha256Hex(JSON.stringify(signature))).slice(0, 32)}`;
  }
  const dup = observed ? await getMemoryCandidateById(db, { namespace: input.namespace, id }) : input.targetMemoryId
    ? await db
        .prepare(
          `SELECT * FROM memory_candidates
           WHERE namespace = ? AND status = 'pending' AND source = ? AND target_memory_id = ?
           LIMIT 1`
        )
        .bind(input.namespace, input.source ?? "extract", input.targetMemoryId)
        .first<MemoryCandidateRow>()
    : await db
        .prepare(
          `SELECT * FROM memory_candidates
           WHERE namespace = ? AND status = 'pending' AND source = ? AND content = ?
           LIMIT 1`
        )
        .bind(input.namespace, input.source ?? "extract", input.content)
        .first<MemoryCandidateRow>();
  if (dup) return dup;

  const now = nowIso();
  const record: MemoryCandidateRow = {
    id,
    provenance: JSON.stringify(input.provenance) ?? null,
    namespace: input.namespace,
    type: clampMemoryType(input.type, "note"),
    content: input.content,
    fact_key: input.factKey ?? null,
    confidence: input.confidence ?? 0.5,
    importance: input.importance ?? 0.5,
    tags: JSON.stringify(input.tags ?? []),
    source_message_ids: JSON.stringify(input.sourceMessageIds ?? []),
    source: input.source ?? "extract",
    status: "pending",
    target_memory_id: input.targetMemoryId ?? null,
    decision_note: input.decisionNote ?? null,
    created_at: now,
    updated_at: now
  };

  await db
    .prepare(
      `INSERT INTO memory_candidates (
        id, namespace, type, content, fact_key, confidence, importance, tags,
        source_message_ids, source, status, target_memory_id, decision_note,
        created_at, updated_at, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
    )
    .bind(
      record.id,
      record.namespace,
      record.type,
      record.content,
      record.fact_key,
      record.confidence,
      record.importance,
      record.tags,
      record.source_message_ids,
      record.source,
      record.status,
      record.target_memory_id,
      record.decision_note,
      record.created_at,
      record.updated_at, record.provenance ?? null
    )
    .run();

  return record;
}

// source 过滤：excludeSources 不要这些来源，onlySources 只要这些来源。
// 导入的候选 (import_chat / import_entries) 数量可能上千，夜里的自动审、助手审核、日常审核队列都得在查询里就把它们排掉，
// 不然取前 100 条全是导入的，日常候选永远轮不到。
function sourceFilterSql(input: { excludeSources?: readonly string[]; onlySources?: readonly string[] }): {
  sql: string;
  binds: string[];
} {
  if (input.onlySources && input.onlySources.length > 0) {
    return { sql: ` AND source IN (${input.onlySources.map(() => "?").join(", ")})`, binds: [...input.onlySources] };
  }
  if (input.excludeSources && input.excludeSources.length > 0) {
    return { sql: ` AND source NOT IN (${input.excludeSources.map(() => "?").join(", ")})`, binds: [...input.excludeSources] };
  }
  return { sql: "", binds: [] };
}

export async function listMemoryCandidates(
  db: D1Database,
  input: {
    namespace: string;
    status?: string;
    limit: number;
    excludeSources?: readonly string[];
    onlySources?: readonly string[];
  }
): Promise<MemoryCandidateRow[]> {
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 200);
  const status = input.status ?? "pending";
  const filter = sourceFilterSql(input);
  const result = await db
    .prepare(
      `SELECT *
       FROM memory_candidates
       WHERE namespace = ? AND status = ?${filter.sql}
       ORDER BY confidence ASC, created_at DESC
       LIMIT ?`
    )
    .bind(input.namespace, status, ...filter.binds, limit)
    .all<MemoryCandidateRow>();
  return result.results ?? [];
}

export async function countMemoryCandidates(
  db: D1Database,
  input: { namespace: string; status?: string; excludeSources?: readonly string[]; onlySources?: readonly string[] }
): Promise<number> {
  const status = input.status ?? "pending";
  const filter = sourceFilterSql(input);
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM memory_candidates WHERE namespace = ? AND status = ?${filter.sql}`)
    .bind(input.namespace, status, ...filter.binds)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

// 梦境收成 (dream harvest)：当天被判过 (approved / discarded) 的候选，按判决时间倒序。
// excludeSources：导入的候选不是那晚的梦，收成页不列 (一批批完能有上千条)。
export async function listJudgedCandidatesInRange(
  db: D1Database,
  input: { namespace: string; startIso: string; endIso: string; limit?: number; excludeSources?: readonly string[] }
): Promise<MemoryCandidateRow[]> {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 200), 1), 500);
  const filter = sourceFilterSql({ excludeSources: input.excludeSources });
  const result = await db
    .prepare(
      `SELECT *
       FROM memory_candidates
       WHERE namespace = ? AND status IN ('approved', 'discarded')
         AND updated_at >= ? AND updated_at < ?${filter.sql}
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .bind(input.namespace, input.startIso, input.endIso, ...filter.binds, limit)
    .all<MemoryCandidateRow>();
  return result.results ?? [];
}

// 自动审核的决定 (含撤回过的)，给后台"这周助手自己定的"清单用，按决定时间倒序。
export async function listJudgeDecisionsSince(
  db: D1Database,
  input: { namespace: string; sinceIso: string; limit?: number }
): Promise<MemoryCandidateRow[]> {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 200), 1), 500);
  const result = await db
    .prepare(
      `SELECT *
       FROM memory_candidates
       WHERE namespace = ? AND status IN ('approved', 'discarded') AND updated_at >= ?
         AND (decision_note LIKE 'judge%' OR decision_note LIKE 'undo: judge%')
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .bind(input.namespace, input.sinceIso, limit)
    .all<MemoryCandidateRow>();
  return result.results ?? [];
}

export async function getMemoryCandidateById(
  db: D1Database,
  input: { namespace: string; id: string }
): Promise<MemoryCandidateRow | null> {
  const row = await db
    .prepare("SELECT * FROM memory_candidates WHERE namespace = ? AND id = ?")
    .bind(input.namespace, input.id)
    .first<MemoryCandidateRow>();
  return row ?? null;
}

/** Recover a committed approval if delivery stopped before the candidate status was saved. */
export async function approvedCandidateMemory(db: D1Database, namespace: string, candidateId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT id FROM memories WHERE namespace=? AND json_extract(provenance,'$.candidate_id')=?`)
    .bind(namespace, candidateId).first<{id:string}>();
  return row?.id ?? null;
}

export async function updateMemoryCandidateStatus(
  db: D1Database,
  input: { namespace: string; id: string; status: string; targetMemoryId?: string | null; decisionNote?: string | null }
): Promise<MemoryCandidateRow | null> {
  const now = nowIso();
  // target_memory_id / decision_note 只在调用方真的传了才写。以前是无条件 SET，
  // 调用方不传就等于抹成 NULL——judge 把 dream_update / dream_delete 候选 keep 回
  // pending 时就会丢掉指向的那条记忆，人工再 approve 就变成新建重复记忆而不是 supersede。
  // 显式传 null 仍然是清空，语义没变。
  const sets = ["status = ?"];
  const values: (string | null)[] = [input.status];
  if ("targetMemoryId" in input) {
    sets.push("target_memory_id = ?");
    values.push(input.targetMemoryId ?? null);
  }
  if ("decisionNote" in input) {
    sets.push("decision_note = ?");
    values.push(input.decisionNote ?? null);
  }
  sets.push("updated_at = ?");
  values.push(now);
  await db
    .prepare(
      `UPDATE memory_candidates
       SET ${sets.join(", ")}
       WHERE namespace = ? AND id = ?`
    )
    .bind(...values, input.namespace, input.id)
    .run();
  return getMemoryCandidateById(db, input);
}

/** The day belongs to the conversation. Older candidates can still be located by their first surviving citation. */
export async function listDreamDayCandidates(
  db: D1Database,
  input: {
    namespace: string;
    dateLabel: string;
    startIso: string;
    endIso: string;
    pendingOnly: boolean;
  }
): Promise<MemoryCandidateRow[]> {
  const rows = await db
    .prepare(`SELECT c.* FROM memory_candidates c
    WHERE c.namespace=?1 AND c.source='dream_extract' AND ${input.pendingOnly ? "c.status='pending'" : "c.status IN ('pending','approved')"}
      AND (json_extract(c.provenance,'$.dream_date')=?2 OR (json_extract(c.provenance,'$.dream_date') IS NULL
        AND EXISTS (SELECT 1 FROM messages m WHERE m.namespace=c.namespace AND m.id=json_extract(c.source_message_ids,'$[0]')
          AND m.created_at>=?3 AND m.created_at<?4)))
    ORDER BY c.updated_at DESC,c.id ${input.pendingOnly ? "LIMIT 30" : ""}`)
    .bind(input.namespace, input.dateLabel, input.startIso, input.endIso)
    .all<MemoryCandidateRow>();
  return rows.results;
}

/** Keep prior evidence; a reviewer or another batch may have changed the candidate during inference. */
export async function extendDreamCandidate(
  db: D1Database,
  input: {
    namespace: string;
    dateLabel: string;
    id: string;
    content: string;
    sources: string[];
    origin: MemoryProvenance;
    range: string;
    expectedContent?: string;
  }
): Promise<boolean> {
  const row = await getMemoryCandidateById(db, input);
  if (!row || row.status !== "pending" || row.source !== "dream_extract") return false;
  const previous: MemoryProvenance | undefined = row.provenance ? JSON.parse(row.provenance) : undefined;
  if (previous?.dream_date && previous.dream_date !== input.dateLabel) return false;
  if (previous?.batch_ranges?.includes(input.range)) {
    const known = new Set<string>(JSON.parse(row.source_message_ids ?? "[]"));
    return input.sources.every((id) => known.has(id));
  }
  if (input.expectedContent !== row.content)
    throw new Error("Candidate changed during extraction; retry the batch");
  // A replacement that loses an earlier quoted name or promise is safer as a separate candidate.
  for (const quote of row.content.matchAll(/「([^」]+)」/g)) {
    if (!input.content.includes(quote[0])) return false;
  }
  const sources = [...new Set<string>([...JSON.parse(row.source_message_ids ?? "[]"), ...input.sources])];
  const inputs = new Set([...(previous?.inputs ?? []), ...sources.map((id) => `message:${id}`)]);
  const evidenceAt = [previous?.evidence_at, input.origin.evidence_at]
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1);
  const merged = {
    ...input.origin,
    evidence_at: evidenceAt,
    dream_date: input.dateLabel,
    inputs: [...inputs],
    attributed_actor:
      previous?.attributed_actor === input.origin.attributed_actor ? input.origin.attributed_actor : "unknown",
    context_refs: [...new Set([...(previous?.context_refs ?? []), ...(input.origin.context_refs ?? [])])].filter(
      (ref) => !inputs.has(ref)
    ),
    batch_ranges: [...(previous?.batch_ranges ?? []), input.range]
  };
  const result = await db
    .prepare(`UPDATE memory_candidates SET content=?,source_message_ids=?,provenance=?,updated_at=?
    WHERE namespace=? AND id=? AND status='pending' AND content=? AND provenance IS ? AND source_message_ids IS ?`)
    .bind(
      input.content,
      JSON.stringify(sources),
      JSON.stringify(merged),
      nowIso(),
      input.namespace,
      row.id,
      row.content,
      row.provenance ?? null,
      row.source_message_ids
    )
    .run();
  if (!result.meta.changes) throw new Error("Dream candidate changed during extension; retry the batch");
  return true;
}
