import type { MessageRecord } from "../../types";
import { newId } from "../../utils/ids";
import { nowIso } from "../../utils/time";
import { clampMemoryType } from "../../memory/canonicalTypes";
import type { MemoryCandidateRow } from "./candidates";
import { SQLITE_BIND_BATCH_SIZE, uniqueStrings } from "./shared";

// 导入批次、导入的聊天原文、导入候选。表见 migrations/0017_memory_import_export.sql。

// 导入来的候选用这两个 source。夜里的 clef 自动审、助手的 MCP 审核都跳过它们：
// 导入的东西要本人在审核页点了才算。
export const IMPORT_CANDIDATE_SOURCES = ["import_chat", "import_entries"] as const;
export type ImportCandidateSource = (typeof IMPORT_CANDIDATE_SOURCES)[number];

export function isImportCandidateSource(source: string | null | undefined): boolean {
  return typeof source === "string" && (IMPORT_CANDIDATE_SOURCES as readonly string[]).includes(source);
}

// 导入的聊天原文 id 前缀。getMessagesByIds 在 messages 里找不到时，凭这个前缀到 imported_messages 再找。
export const IMPORTED_MESSAGE_PREFIX = "imsg_";

// 一条候选最多挂多少句原文。模型没标出处时整段都挂上，一段最多也就这么多。
const MAX_CANDIDATE_SOURCES = 60;

export interface ImportBatchRow {
  id: string;
  namespace: string;
  kind: string;
  name: string | null;
  fingerprint: string;
  total_chunks: number;
  done_chunks: number;
  total_messages: number;
  total_chars: number;
  first_date: string | null;
  last_date: string | null;
  candidates: number;
  model: string | null;
  model_calls: number;
  tokens_in: number;
  tokens_out: number;
  clef_calls: number;
  created_at: string;
  updated_at: string;
}

export interface ImportBatchSummary extends ImportBatchRow {
  pending: number;
  approved: number;
  discarded: number;
}

export interface ImportChunkRow {
  import_id: string;
  chunk_key: string;
  status: string;
  messages: number;
  chars: number;
  candidates: number;
  model_calls: number;
  tokens_in: number;
  tokens_out: number;
  clef_calls: number;
  error: string | null;
  updated_at: string;
}

export async function upsertImportBatch(
  db: D1Database,
  input: {
    namespace: string;
    kind: "chat" | "entries" | "archive";
    name?: string | null;
    fingerprint: string;
    totalChunks?: number;
    totalMessages?: number;
    totalChars?: number;
    firstDate?: string | null;
    lastDate?: string | null;
    model?: string | null;
  }
): Promise<{ batch: ImportBatchRow; doneKeys: string[]; created: boolean }> {
  const now = nowIso();
  const existing = await db
    .prepare("SELECT * FROM memory_imports WHERE namespace = ? AND fingerprint = ?")
    .bind(input.namespace, input.fingerprint)
    .first<ImportBatchRow>();

  if (existing) {
    await db
      .prepare(
        `UPDATE memory_imports SET name = COALESCE(?, name), total_chunks = ?, total_messages = ?, total_chars = ?,
           first_date = COALESCE(?, first_date), last_date = COALESCE(?, last_date), model = COALESCE(?, model), updated_at = ?
         WHERE id = ?`
      )
      .bind(
        input.name ?? null,
        input.totalChunks ?? existing.total_chunks,
        input.totalMessages ?? existing.total_messages,
        input.totalChars ?? existing.total_chars,
        input.firstDate ?? null,
        input.lastDate ?? null,
        input.model ?? null,
        now,
        existing.id
      )
      .run();
    const batch = (await getImportBatch(db, { namespace: input.namespace, id: existing.id })) ?? existing;
    const done = await db
      .prepare("SELECT chunk_key FROM memory_import_chunks WHERE import_id = ? AND status = 'done'")
      .bind(existing.id)
      .all<{ chunk_key: string }>();
    return { batch, doneKeys: (done.results ?? []).map((row) => row.chunk_key), created: false };
  }

  const batch: ImportBatchRow = {
    id: newId("imp"),
    namespace: input.namespace,
    kind: input.kind,
    name: input.name ?? null,
    fingerprint: input.fingerprint,
    total_chunks: input.totalChunks ?? 0,
    done_chunks: 0,
    total_messages: input.totalMessages ?? 0,
    total_chars: input.totalChars ?? 0,
    first_date: input.firstDate ?? null,
    last_date: input.lastDate ?? null,
    candidates: 0,
    model: input.model ?? null,
    model_calls: 0,
    tokens_in: 0,
    tokens_out: 0,
    clef_calls: 0,
    created_at: now,
    updated_at: now
  };
  const inserted = await db
    .prepare(
      `INSERT INTO memory_imports (
        id, namespace, kind, name, fingerprint, total_chunks, done_chunks, total_messages, total_chars,
        first_date, last_date, candidates, model, model_calls, tokens_in, tokens_out, clef_calls, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?, 0, 0, 0, 0, ?, ?)
      ON CONFLICT(namespace, fingerprint) DO NOTHING`
    )
    .bind(
      batch.id,
      batch.namespace,
      batch.kind,
      batch.name,
      batch.fingerprint,
      batch.total_chunks,
      batch.total_messages,
      batch.total_chars,
      batch.first_date,
      batch.last_date,
      batch.model,
      now,
      now
    )
    .run();
  // 同一份同时点了两次 (两个标签页、重发的请求)：另一个请求刚建好，就接着用它那批。
  if (!inserted.meta?.changes) {
    const winner = await db
      .prepare("SELECT * FROM memory_imports WHERE namespace = ? AND fingerprint = ?")
      .bind(input.namespace, input.fingerprint)
      .first<ImportBatchRow>();
    if (winner) return { batch: winner, doneKeys: [], created: false };
  }
  return { batch, doneKeys: [], created: true };
}

export async function getImportBatch(
  db: D1Database,
  input: { namespace: string; id: string }
): Promise<ImportBatchRow | null> {
  const row = await db
    .prepare("SELECT * FROM memory_imports WHERE namespace = ? AND id = ?")
    .bind(input.namespace, input.id)
    .first<ImportBatchRow>();
  return row ?? null;
}

export async function listImportBatches(
  db: D1Database,
  input: { namespace: string; limit?: number }
): Promise<ImportBatchSummary[]> {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 20), 1), 100);
  const result = await db
    .prepare(
      `SELECT b.*,
         (SELECT COUNT(*) FROM memory_import_candidates ic JOIN memory_candidates c ON c.id = ic.candidate_id
          WHERE ic.import_id = b.id AND c.status = 'pending') AS pending,
         (SELECT COUNT(*) FROM memory_import_candidates ic JOIN memory_candidates c ON c.id = ic.candidate_id
          WHERE ic.import_id = b.id AND c.status IN ('approved', 'merged')) AS approved,
         (SELECT COUNT(*) FROM memory_import_candidates ic JOIN memory_candidates c ON c.id = ic.candidate_id
          WHERE ic.import_id = b.id AND c.status = 'discarded') AS discarded
       FROM memory_imports b
       WHERE b.namespace = ?
       ORDER BY b.created_at DESC
       LIMIT ?`
    )
    .bind(input.namespace, limit)
    .all<ImportBatchSummary>();
  return result.results ?? [];
}

export async function getImportChunk(
  db: D1Database,
  input: { importId: string; key: string }
): Promise<ImportChunkRow | null> {
  const row = await db
    .prepare("SELECT * FROM memory_import_chunks WHERE import_id = ? AND chunk_key = ?")
    .bind(input.importId, input.key)
    .first<ImportChunkRow>();
  return row ?? null;
}

/**
 * 记一段做完 (或失败)。同一段重试时状态、候选数覆盖，token 和调用次数累加：失败那次也花了钱。
 * 然后按段表重算批次的合计；候选数按这批真正排进去的条数数，重跑过的段不会算两遍。
 */
export async function recordImportChunk(
  db: D1Database,
  input: {
    importId: string;
    key: string;
    status: "done" | "error";
    messages?: number;
    chars?: number;
    candidates?: number;
    modelCalls?: number;
    tokensIn?: number;
    tokensOut?: number;
    clefCalls?: number;
    error?: string | null;
  }
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO memory_import_chunks (
        import_id, chunk_key, status, messages, chars, candidates, model_calls, tokens_in, tokens_out, clef_calls, error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(import_id, chunk_key) DO UPDATE SET
        status = excluded.status,
        messages = excluded.messages,
        chars = excluded.chars,
        candidates = excluded.candidates,
        model_calls = memory_import_chunks.model_calls + excluded.model_calls,
        tokens_in = memory_import_chunks.tokens_in + excluded.tokens_in,
        tokens_out = memory_import_chunks.tokens_out + excluded.tokens_out,
        clef_calls = memory_import_chunks.clef_calls + excluded.clef_calls,
        error = excluded.error,
        updated_at = excluded.updated_at`
    )
    .bind(
      input.importId,
      input.key,
      input.status,
      input.messages ?? 0,
      input.chars ?? 0,
      input.candidates ?? 0,
      input.modelCalls ?? 0,
      input.tokensIn ?? 0,
      input.tokensOut ?? 0,
      input.clefCalls ?? 0,
      input.error ?? null,
      now
    )
    .run();

  await db
    .prepare(
      `UPDATE memory_imports SET
         done_chunks = (SELECT COUNT(*) FROM memory_import_chunks WHERE import_id = ? AND status = 'done'),
         candidates = (SELECT COUNT(*) FROM memory_import_candidates WHERE import_id = ?),
         model_calls = (SELECT COALESCE(SUM(model_calls), 0) FROM memory_import_chunks WHERE import_id = ?),
         tokens_in = (SELECT COALESCE(SUM(tokens_in), 0) FROM memory_import_chunks WHERE import_id = ?),
         tokens_out = (SELECT COALESCE(SUM(tokens_out), 0) FROM memory_import_chunks WHERE import_id = ?),
         clef_calls = (SELECT COALESCE(SUM(clef_calls), 0) FROM memory_import_chunks WHERE import_id = ?),
         updated_at = ?
       WHERE id = ?`
    )
    .bind(input.importId, input.importId, input.importId, input.importId, input.importId, input.importId, now, input.importId)
    .run();
}

// ---------------------------------------------------------------------------
// 导入的聊天原文
// ---------------------------------------------------------------------------

export interface ImportedMessageInput {
  id: string;
  namespace: string;
  importId: string;
  role: "user" | "assistant";
  content: string;
  speaker?: string | null;
  createdAt?: string | null;
  day?: string | null;
  seq: number;
}

interface ImportedMessageRow {
  id: string;
  namespace: string;
  import_id: string;
  role: string;
  content: string;
  speaker: string | null;
  created_at: string | null;
  day: string | null;
  seq: number;
}

/** 存候选引用到的原文。同一句 (同 id) 已经存过就跳过。 */
export async function saveImportedMessages(db: D1Database, messages: ImportedMessageInput[]): Promise<void> {
  const statements = messages.map((message) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO imported_messages (id, namespace, import_id, role, content, speaker, created_at, day, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        message.id,
        message.namespace,
        message.importId,
        message.role,
        message.content,
        message.speaker ?? null,
        message.createdAt ?? null,
        message.day ?? null,
        message.seq
      )
  );
  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
}

function importedRowToMessage(row: ImportedMessageRow): MessageRecord {
  return {
    id: row.id,
    conversation_id: `import:${row.import_id}`,
    namespace: row.namespace,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    source: `import:${row.import_id}`,
    // 原聊天没时间的，用切段时归的那天；连那天也没有就空着。
    created_at: row.created_at || row.day || "",
    seq: row.seq
  };
}

/** 按 id 取导入的原文，排成原来的先后。表还不存在 (老库没跑迁移) 时当没有。 */
export async function getImportedMessagesByIds(
  db: D1Database,
  input: { namespace: string; ids: string[] }
): Promise<MessageRecord[]> {
  const ids = uniqueStrings(input.ids).filter((id) => id.startsWith(IMPORTED_MESSAGE_PREFIX));
  if (ids.length === 0) return [];
  const rows: ImportedMessageRow[] = [];
  try {
    for (let index = 0; index < ids.length; index += SQLITE_BIND_BATCH_SIZE) {
      const batch = ids.slice(index, index + SQLITE_BIND_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(", ");
      const result = await db
        .prepare(`SELECT * FROM imported_messages WHERE namespace = ? AND id IN (${placeholders})`)
        .bind(input.namespace, ...batch)
        .all<ImportedMessageRow>();
      rows.push(...(result.results ?? []));
    }
  } catch (error) {
    console.warn("imported messages lookup failed", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
  rows.sort((a, b) => (a.import_id === b.import_id ? a.seq - b.seq : a.import_id < b.import_id ? -1 : 1));
  return rows.map(importedRowToMessage);
}

// ---------------------------------------------------------------------------
// 导入候选
// ---------------------------------------------------------------------------

export interface ImportCandidateInput {
  namespace: string;
  importId: string;
  source: ImportCandidateSource;
  type: string;
  content: string;
  factKey?: string | null;
  confidence?: number;
  importance?: number;
  tags?: string[];
  sourceMessageIds?: string[];
  targetMemoryId?: string | null;
  decisionNote?: string | null;
  day?: string | null;
  clefGrounded?: number | null;
  clefWorth?: number | null;
}

function parseIds(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 导入候选入队。同一批里已经有一条还没批的、说的是同一件事 (同 fact_key 或正文一样)，
 * 就并进那一条：正文换成后来这条 (聊天按日期从旧到新送，后来的更新)，出处合在一起。
 * 不然一件事在十天里提了十次，审核页就是十条。
 */
export async function createImportCandidate(
  db: D1Database,
  input: ImportCandidateInput
): Promise<{ candidate: MemoryCandidateRow; merged: boolean }> {
  const now = nowIso();
  const factKey = input.factKey?.trim() || null;
  const targetMemoryId = input.targetMemoryId?.trim() || null;
  const tags = uniqueStrings(input.tags ?? []);
  const sourceIds = uniqueStrings(input.sourceMessageIds ?? []).slice(0, MAX_CANDIDATE_SOURCES);

  const existing = await db
    .prepare(
      `SELECT c.* FROM memory_candidates c
       JOIN memory_import_candidates ic ON ic.candidate_id = c.id
       WHERE ic.import_id = ? AND c.namespace = ? AND c.status = 'pending'
         AND ((? IS NOT NULL AND c.fact_key = ?) OR c.content = ?)
       ORDER BY c.created_at DESC
       LIMIT 1`
    )
    .bind(input.importId, input.namespace, factKey, factKey, input.content)
    .first<MemoryCandidateRow>();

  if (existing) {
    const mergedTags = uniqueStrings([...parseIds(existing.tags), ...tags]);
    const mergedSources = uniqueStrings([...parseIds(existing.source_message_ids), ...sourceIds]).slice(-MAX_CANDIDATE_SOURCES);
    await db
      .prepare(
        `UPDATE memory_candidates SET type = ?, content = ?, fact_key = COALESCE(?, fact_key),
           confidence = ?, importance = ?, tags = ?, source_message_ids = ?,
           target_memory_id = COALESCE(?, target_memory_id), decision_note = COALESCE(?, decision_note), updated_at = ?
         WHERE id = ?`
      )
      .bind(
        clampMemoryType(input.type, "note"),
        input.content,
        factKey,
        input.confidence ?? existing.confidence,
        Math.max(input.importance ?? 0, existing.importance),
        JSON.stringify(mergedTags),
        JSON.stringify(mergedSources),
        targetMemoryId,
        input.decisionNote ?? null,
        now,
        existing.id
      )
      .run();
    await db
      .prepare(
        `UPDATE memory_import_candidates SET day = COALESCE(?, day),
           clef_grounded = COALESCE(?, clef_grounded), clef_worth = COALESCE(?, clef_worth)
         WHERE candidate_id = ?`
      )
      .bind(input.day ?? null, input.clefGrounded ?? null, input.clefWorth ?? null, existing.id)
      .run();
    const candidate = await db
      .prepare("SELECT * FROM memory_candidates WHERE id = ?")
      .bind(existing.id)
      .first<MemoryCandidateRow>();
    return { candidate: candidate ?? existing, merged: true };
  }

  const candidate: MemoryCandidateRow = {
    id: newId("cand"),
    namespace: input.namespace,
    type: clampMemoryType(input.type, "note"),
    content: input.content,
    fact_key: factKey,
    confidence: input.confidence ?? 0.6,
    importance: input.importance ?? 0.6,
    tags: JSON.stringify(tags),
    source_message_ids: JSON.stringify(sourceIds),
    source: input.source,
    status: "pending",
    target_memory_id: targetMemoryId,
    decision_note: input.decisionNote ?? null,
    created_at: now,
    updated_at: now
  };
  await db.batch([
    db
      .prepare(
        `INSERT INTO memory_candidates (
          id, namespace, type, content, fact_key, confidence, importance, tags,
          source_message_ids, source, status, target_memory_id, decision_note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
      )
      .bind(
        candidate.id,
        candidate.namespace,
        candidate.type,
        candidate.content,
        candidate.fact_key,
        candidate.confidence,
        candidate.importance,
        candidate.tags,
        candidate.source_message_ids,
        candidate.source,
        candidate.target_memory_id,
        candidate.decision_note,
        now,
        now
      ),
    db
      .prepare(
        `INSERT INTO memory_import_candidates (candidate_id, import_id, namespace, day, clef_grounded, clef_worth, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(candidate.id, input.importId, input.namespace, input.day ?? null, input.clefGrounded ?? null, input.clefWorth ?? null, now)
  ]);
  return { candidate, merged: false };
}

export interface ImportCandidateListRow extends MemoryCandidateRow {
  import_id: string;
  day: string | null;
  clef_grounded: number | null;
  clef_worth: number | null;
  /** 通过后会被替换或改写的那条已有记忆 (指着的那条，或同 fact_key 的那条)。 */
  existing_content: string | null;
}

export type ImportCandidateFilter = "all" | "clef_yes" | "clef_no";

// clef 两个问题都过 0.5 算「觉得该记」；问过但没过算「觉得不用记」；没问过的两边都不算。
const CLEF_YES_SQL = "ic.clef_grounded >= 0.5 AND ic.clef_worth >= 0.5";
const CLEF_NO_SQL = "ic.clef_worth IS NOT NULL AND (ic.clef_grounded < 0.5 OR ic.clef_worth < 0.5)";

function filterSql(filter: ImportCandidateFilter | undefined): string {
  if (filter === "clef_yes") return ` AND ${CLEF_YES_SQL}`;
  if (filter === "clef_no") return ` AND ${CLEF_NO_SQL}`;
  return "";
}

export async function listImportCandidates(
  db: D1Database,
  input: {
    namespace: string;
    importId?: string | null;
    status?: string;
    filter?: ImportCandidateFilter;
    limit?: number;
    offset?: number;
  }
): Promise<ImportCandidateListRow[]> {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 200);
  const offset = Math.max(Math.floor(input.offset ?? 0), 0);
  const binds: unknown[] = [input.namespace, input.status ?? "pending"];
  let where = "";
  if (input.importId) {
    where += " AND ic.import_id = ?";
    binds.push(input.importId);
  }
  where += filterSql(input.filter);
  const result = await db
    .prepare(
      `SELECT c.*, ic.import_id, ic.day, ic.clef_grounded, ic.clef_worth,
         COALESCE(
           (SELECT t.content FROM memories t WHERE t.id = c.target_memory_id AND t.namespace = c.namespace AND t.status = 'active'),
           (SELECT f.content FROM memories f
            WHERE c.fact_key IS NOT NULL AND f.namespace = c.namespace AND f.fact_key = c.fact_key AND f.status = 'active'
              AND (f.version_status IS NULL OR f.version_status != 'superseded')
            ORDER BY f.updated_at DESC LIMIT 1)
         ) AS existing_content
       FROM memory_candidates c
       JOIN memory_import_candidates ic ON ic.candidate_id = c.id
       WHERE c.namespace = ? AND c.status = ?${where}
       ORDER BY COALESCE(ic.day, '9999') ASC, c.created_at ASC, c.id ASC
       LIMIT ? OFFSET ?`
    )
    .bind(...binds, limit, offset)
    .all<ImportCandidateListRow>();
  return result.results ?? [];
}

/** 批量操作要的 id：某批 (或全部) 待审的导入候选，可按 clef 的看法筛。 */
export async function listImportCandidateIds(
  db: D1Database,
  input: { namespace: string; importId?: string | null; filter?: ImportCandidateFilter; limit?: number }
): Promise<string[]> {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 2000), 1), 5000);
  const binds: unknown[] = [input.namespace];
  let where = "";
  if (input.importId) {
    where += " AND ic.import_id = ?";
    binds.push(input.importId);
  }
  where += filterSql(input.filter);
  const result = await db
    .prepare(
      `SELECT c.id FROM memory_candidates c
       JOIN memory_import_candidates ic ON ic.candidate_id = c.id
       WHERE c.namespace = ? AND c.status = 'pending'${where}
       ORDER BY COALESCE(ic.day, '9999') ASC, c.created_at ASC, c.id ASC
       LIMIT ?`
    )
    .bind(...binds, limit)
    .all<{ id: string }>();
  return (result.results ?? []).map((row) => row.id);
}

export async function countImportCandidates(
  db: D1Database,
  input: { namespace: string; importId?: string | null }
): Promise<{ pending: number; clef_yes: number; clef_no: number }> {
  const binds: unknown[] = [input.namespace];
  let where = "";
  if (input.importId) {
    where += " AND ic.import_id = ?";
    binds.push(input.importId);
  }
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS pending,
         COALESCE(SUM(CASE WHEN ${CLEF_YES_SQL} THEN 1 ELSE 0 END), 0) AS clef_yes,
         COALESCE(SUM(CASE WHEN ${CLEF_NO_SQL} THEN 1 ELSE 0 END), 0) AS clef_no
       FROM memory_candidates c
       JOIN memory_import_candidates ic ON ic.candidate_id = c.id
       WHERE c.namespace = ? AND c.status = 'pending'${where}`
    )
    .bind(...binds)
    .first<{ pending: number; clef_yes: number; clef_no: number }>();
  return { pending: row?.pending ?? 0, clef_yes: row?.clef_yes ?? 0, clef_no: row?.clef_no ?? 0 };
}

/** 这一批还没批的候选用过的 fact_key：喂给抽取器，后面几天说到同一件事时复用同一个 key。 */
export async function listImportPendingFactKeys(
  db: D1Database,
  input: { namespace: string; importId: string; limit?: number }
): Promise<string[]> {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 200), 1), 500);
  const result = await db
    .prepare(
      `SELECT DISTINCT c.fact_key AS fact_key FROM memory_candidates c
       JOIN memory_import_candidates ic ON ic.candidate_id = c.id
       WHERE ic.import_id = ? AND c.namespace = ? AND c.status = 'pending' AND c.fact_key IS NOT NULL AND c.fact_key != ''
       ORDER BY c.fact_key
       LIMIT ?`
    )
    .bind(input.importId, input.namespace, limit)
    .all<{ fact_key: string }>();
  return (result.results ?? []).map((row) => row.fact_key);
}

/** 导入候选是哪天的聊天 (或条目上写的日期)。批准时新记忆的 created_at 用这天。 */
export async function getImportCandidateDay(db: D1Database, input: { candidateId: string }): Promise<string | null> {
  const row = await db
    .prepare("SELECT day FROM memory_import_candidates WHERE candidate_id = ?")
    .bind(input.candidateId)
    .first<{ day: string | null }>();
  return row?.day ?? null;
}
