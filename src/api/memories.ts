import { authenticate } from "../auth/apiKey";
import { HANDOFF_MAX, HandoffError, residentHandoffMetadata, saveResidentHandoff, validateHandoff } from "../db/v2/handoff";
import { requireScope } from "../auth/scopes";
import { getOrCreateConversation } from "../db/conversations";
import { createMemory, getMemoryById, listMemoriesPage, softDeleteMemory, updateMemory } from "../db/memories";
import { chatArchiveEnabled } from "../db/chatArchive";
import { getMessagesByIds, retainedMessageIds, listMessagesByNamespaceInRange, saveIngestMessages } from "../db/messages";
import { runDailyMemoryDigest } from "../memory/dailyDigest";
import { writeDiaryAfterDream } from "../memory/diaryWriter";
import { deleteMemoryEmbedding, upsertMemoryEmbedding } from "../memory/embedding";
import { exportMemories, exportMemoryDocument } from "../memory/export";
import { readDreamTimeZoneFromEnv } from "../memory/dreamEnv";
import { loadSpeakersForNamespace } from "../memory/speakers";
import { filterAndCompressMemoriesWithMeta } from "../memory/filter";
import { formatMemoryPatch } from "../memory/inject";
import { findSimilarActiveMemory } from "../memory/dedupGate";
import { searchMemories, toMemoryApiRecord } from "../memory/search";
import { invalidateKnownInputs } from "../db/v2/revocation";
import { approvedCandidateMemory } from "../db/v2/candidates";
import { explicitWrite, reviewedOrigin, type MemoryProvenance } from "../memory/provenance";
import { deleteVectorMemory, getVectorMemory } from "../memory/vectorStore";
import { clampMemoryType } from "../memory/canonicalTypes";
import {
  archiveMemory,
  countActiveMemoriesByType,
  countMemoryCandidates,
  createPrecious,
  deleteGlossary,
  deleteLongtail,
  deletePrecious,
  fetchMemoryLifecycleRows,
  getDailyLog,
  getImportCandidateDay,
  getMemoryCandidateById,
  IMPORT_CANDIDATE_SOURCES,
  isImportCandidateSource,
  listGlossary,
  listJudgeDecisionsSince,
  listMemoryCandidates,
  listPrecious,
  type MemoryCandidateRow,
  supersedeMemory,
  updateGlossary,
  updateMemoryCandidateStatus,
  upsertGlossary,
  upsertMemoryByFactKey
} from "../db/v2";
import { parseJudgeNote, undoJudgeDecision } from "../memory/candidateJudge";
import { handleMemoryRevisions } from "./transfer";
import { isClefReviewOn } from "../memory/clefJudge";
import { withImpressionDisclaimer } from "../memory/impression";
import { isV2Enabled, runRecall } from "../memory/v2/recall";

import type { Env, KeyProfile, MemoryApiRecord } from "../types";
import { json, openAiError } from "../utils/json";
import { getYesterdayDateLabel } from "../memory/dreamDates";
import { formatDateLabel } from "../utils/time";
import {
  readBoolean,
  readJsonObject,
  readMessages,
  readNumber,
  readNonNegativeInt,
  readOptionalString,
  readPositiveInt,
  readString,
  readStringArray,
  resolveNamespace
} from "../utils/request";

async function syncMemoryEmbeddingBestEffort(env: Env, memory: Awaited<ReturnType<typeof createMemory>>): Promise<void> {
  try {
    await upsertMemoryEmbedding(env, memory);
  } catch (error) {
    console.error("memory api vector upsert failed", { id: memory.id, error });
  }
}

async function deleteMemoryEmbeddingBestEffort(env: Env, memory: Awaited<ReturnType<typeof createMemory>>): Promise<void> {
  try {
    await deleteMemoryEmbedding(env, memory);
  } catch (error) {
    console.error("memory api vector delete failed", { id: memory.id, error });
  }
}

async function handleCreateMemory(
  request: Request,
  env: Env,
  profile: KeyProfile
): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;

  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const content = readString(body.content);
  const type = clampMemoryType(readString(body.type), "note");

  if (!content) {
    return openAiError("content is required", 400);
  }

  const namespace = resolveNamespace(profile, body.namespace);
  const sourceMessageIds = await retainedMessageIds(env.DB, namespace, readStringArray(body.source_message_ids));
  if (isV2Enabled(env)) {
    const factKey = readString(body.fact_key);
    if (!factKey) return openAiError("fact_key is required in v2; use memory_pin for precious append-only notes", 400);
    try {
      const result = await upsertMemoryByFactKey(env, {
        namespace,
        factKey,
        type,
        content,
        importance: readNumber(body.importance, 0.6),
        confidence: readNumber(body.confidence, 0.8),
        tags: readStringArray(body.tags),
        provenance: explicitWrite(profile, "rest", readString(body.authored_by)),
        source: readOptionalString(body.source) || profile.source,
        sourceMessageIds,
        validAsOf: readOptionalString(body.valid_as_of),
        // E 轴 (0011)：只在亲手来源 (mcp/manual/api) 时生效，db 层裁剪。
        authoredBy: readOptionalString(body.authored_by),
        responseTendency: readOptionalString(body.response_tendency)
      });
      const record = await getMemoryById(env.DB, { namespace, id: result.id });
      const lifecycleRows = record ? await fetchMemoryLifecycleRows(env.DB, [record.id]) : [];
      return json({
        data: record ? toMemoryApiRecord(record, undefined, lifecycleRows[0] ?? null) : result
      }, { status: result.created ? 201 : 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "memory_upsert failed";
      return openAiError(message, 503, "memory_error");
    }
  }

  let memory: ReturnType<typeof toMemoryApiRecord>;
  try {
    const created = await createMemory(env.DB, {
      namespace: resolveNamespace(profile, body.namespace),
      type,
      content,
      summary: readOptionalString(body.summary),
      importance: readNumber(body.importance, 0.5),
      confidence: readNumber(body.confidence, 0.8),
      pinned: readBoolean(body.pinned),
      tags: readStringArray(body.tags),
      provenance: explicitWrite(profile, "rest", readString(body.authored_by)),
      source: readOptionalString(body.source) || profile.source,
      sourceMessageIds,
      expiresAt: readOptionalString(body.expires_at)
    });
    await syncMemoryEmbeddingBestEffort(env, created);
    memory = toMemoryApiRecord(created);
  } catch (error) {
    const message = error instanceof Error ? error.message : "memory_create failed";
    return openAiError(message, 503, "memory_error");
  }

  return json({ data: memory }, { status: 201 });
}

async function handleListMemories(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;

  const url = new URL(request.url);
  const namespace = resolveNamespace(profile, url.searchParams.get("namespace"));
  const limit = readPositiveInt(url.searchParams.get("limit"), 100, 1000);
  const offset = readNonNegativeInt(url.searchParams.get("offset") ?? url.searchParams.get("cursor"), 0, 1000000);
  const page = await listMemoriesPage(env.DB, {
    namespace,
    status: readString(url.searchParams.get("status")) || "active",
    type: readString(url.searchParams.get("type")),
    limit,
    offset
  });

  return json({
    data: page.records.map((record) => toMemoryApiRecord(record)),
    paging: {
      limit,
      cursor: page.nextOffset === null ? null : String(page.nextOffset),
      has_more: page.hasMore,
      count: page.records.length
    }
  });
}

async function handleExportMemories(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
  let scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;

  const url = new URL(request.url);
  const format = (readString(url.searchParams.get("format")) || "json").toLowerCase();
  // md / jsonl 从 D1 读、给人带走用，只要 memory:read：能读记忆的钥匙本来就能一页页把记忆全翻出来，
  // 再卡 export:read 只会让后台主钥匙导不出自己的记忆。老的 json 导出照旧要 export:read。
  if (format === "md" || format === "markdown" || format === "jsonl") {
    const namespace = resolveNamespace(profile, url.searchParams.get("namespace"));
    const speakers = await loadSpeakersForNamespace(env, namespace);
    const document = await exportMemoryDocument(env, {
      namespace,
      format: format === "jsonl" ? "jsonl" : "md",
      title: speakers?.assistantName ?? null,
      timeZone: readDreamTimeZoneFromEnv(env)
    });
    return new Response(document.body, {
      headers: {
        "content-type": document.contentType,
        "content-disposition": `attachment; filename="${document.filename}"`,
        "cache-control": "no-store",
        "x-aelios-memories": String(document.memories),
        "x-aelios-precious": String(document.precious)
      }
    });
  }

  scopeError = requireScope(profile, "export:read");
  if (scopeError) return scopeError;
  try {
    const result = await exportMemories(env, {
      namespace: resolveNamespace(profile, url.searchParams.get("namespace")),
      type: readString(url.searchParams.get("type")),
      format: readString(url.searchParams.get("format")) || "json"
    });
    return json(result);
  } catch (error) {
    return openAiError(error instanceof Error ? error.message : "memory_export failed", 400, "memory_export_error");
  }
}

async function handleSearchMemories(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;

  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const query = readString(body.query) || "";
  if (!query) return openAiError("query is required", 400);

  const namespace = resolveNamespace(profile, body.namespace);
  const topK = readPositiveInt(body.top_k, Number(env.MEMORY_TOP_K || 50), 50);
  const types = readStringArray(body.types);
  const raw = await searchMemories(env, { namespace, query, topK, types });
  const shouldFilter = readBoolean(body.filter, false);
  const filterResult = shouldFilter
    ? await filterAndCompressMemoriesWithMeta(env, { query, memories: raw })
    : null;
  const data = filterResult ? filterResult.data : raw;

  return json({
    data,
    meta: {
      namespace,
      backend: "d1",
      top_k: topK,
      raw_count: raw.length,
      count: data.length,
      filtered: shouldFilter,
      ...(readBoolean(body.include_filter_debug) && filterResult ? { memory_filter: filterResult.meta } : {})
    },
    ...(readBoolean(body.include_prompt) ? { prompt: formatMemoryPatch(data) } : {})
  });
}

function readRecallK(body: Record<string, unknown>, env: Env): number {
  const raw = body.k !== undefined ? body.k : body.top_k;
  const fallback = Number(env.MEMORY_TOP_K || 50);
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return Number.isFinite(fallback) ? Math.floor(fallback) : 50;
}

async function handleRecallMemories(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;

  if (!isV2Enabled(env)) {
    return handleSearchMemories(request, env, profile);
  }

  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const query = readString(body.query) || "";
  if (!query) return openAiError("query is required", 400);

  const namespace = resolveNamespace(profile, body.namespace);
  const k = readRecallK(body, env);
  const minScore = typeof body.min_score === "number" && Number.isFinite(body.min_score)
    ? body.min_score
    : undefined;
  const types = readStringArray(body.types);
  const includePrompt = readBoolean(body.include_prompt);
  // LMC-5 additive: explicit history opt-in (superseded rows). Default false.
  const includeHistory = body.include_history === undefined ? undefined : readBoolean(body.include_history, false);

  const result = await runRecall(env, {
    namespace,
    query,
    k,
    min_score: minScore,
    types,
    include_history: includeHistory
  });
  const data = result.hits.map((h) => ({
    id: h.id,
    content: h.content,
    type: h.type,
    score: h.score,
    importance: 0.5,
    source: h.source,
    ...(h.provenance ? {provenance: h.provenance} : {}),
    ...(h.version_status ? {version_status: h.version_status, recorded_date: h.recorded_date, event_date: h.event_date} : {}),
    ...(h.revision_of ? {revision_of: h.revision_of} : {}),
    source_layer: h.source_layer
  }));

  let prompt: string | undefined;
  if (includePrompt && result.evidence) {
    prompt = [`[原文状态 ${result.evidence.status}]`, ...result.evidence.messages.map(message =>
      `[${message.created_at}][${message.role}] ${message.text}`)].join("\n");
  } else if (includePrompt && data.length > 0) {
    const promptRecords: MemoryApiRecord[] = data.map((d) => ({
      id: d.id,
      namespace,
      type: d.type,
      content: d.version_status === "superseded" ? `[历史版本] ${d.content}` : d.content,
      summary: null,
      importance: d.importance,
      confidence: 0.8,
      status: "active",
      pinned: false,
      tags: [],
      source: d.source,
      source_message_ids: [],
      vector_id: null,
      last_recalled_at: null,
      recall_count: 0,
      created_at: "",
      updated_at: "",
      expires_at: null,
      score: d.score
    }));
    const patch = formatMemoryPatch(promptRecords);
    const extraLines = [
      ...result.glossary_hits.map((g) => `- [glossary] ${g.term}: ${g.definition}`),
      // #35: 周块跟命中平行注入。标出周次和起止日期，让模型知道这是那一整段时间的概貌，
      // 不是又一条碎片。
      ...result.week_blocks.map(
        (b) => `- [周记 ${b.week} ${b.start_date}~${b.end_date}] ${b.title}：${b.summary}`
      )
    ];
    if (extraLines.length > 0) {
      prompt = patch ? `${patch}\n${extraLines.join("\n")}` : extraLines.join("\n");
    } else {
      prompt = patch || undefined;
    }
  }

  return json({
    data,
    // #35: 周块与 data 平行下发，不混进 data —— 它是上下文块，不是命中。
    ...(result.evidence ? {evidence: result.evidence} : {}),
    week_blocks: result.week_blocks,
    meta: {
      namespace,
      backend: "v2-recall",
      top_k: k,
      count: data.length,
      glossary_hits: result.glossary_hits.length,
      week_block_count: result.week_blocks.length,
      ...result.meta
    },
    ...(prompt ? { prompt } : {})
  });
}

async function handleIngestMemories(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  profile: KeyProfile
): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;

  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const messages = readMessages(body.messages);
  if (messages.length === 0) return openAiError("messages must contain at least one message", 400);

  const namespace = resolveNamespace(profile, body.namespace);
  const source = readString(body.source) || profile.source;
  let handoff: ReturnType<typeof residentHandoffMetadata> | undefined;
  let handoffContent = "";
  if (body.handoff !== undefined) {
    try {
      if (source !== "aelios-resident:letter" || messages.length !== 1 || messages[0].role !== "assistant" || typeof messages[0].content !== "string") {
        throw new HandoffError("handoff metadata is only valid for one Resident assistant letter");
      }
      handoff = residentHandoffMetadata(body.handoff);
      handoffContent = messages[0].content.replace(/^（交接信）/, "");
      // The current-letter limit must not prevent the original letter from being ingested.
      if (Array.from(handoffContent).length > HANDOFF_MAX) {
        handoff = undefined;
        console.warn("Resident letter exceeds current handoff limit; preserving raw ingest only");
      } else {
        validateHandoff(handoffContent);
      }
    } catch (error) {
      if (error instanceof HandoffError) return openAiError(error.message, error.status);
      throw error;
    }
  }
  const conversation = await getOrCreateConversation(env.DB, {
    namespace,
    id: readString(body.conversation_id)
  });
  const ids = await saveIngestMessages(env.DB, {
    conversationId: conversation.id,
    namespace,
    source,
    messages,
    archive: chatArchiveEnabled(env) && !source.startsWith("aelios-resident:")
  });

  if (handoff) {
    try {
      await saveResidentHandoff(env.DB, { namespace, content: handoffContent, ...handoff });
    } catch {
      return openAiError("Current handoff could not be saved; delivery is not confirmed", 503);
    }
  }

  return json({
    data: {
      conversation_id: conversation.id,
      message_ids: ids,
      auto_extract: body.auto_extract !== false
    }
  });
}

async function handleRunDigest(
  request: Request,
  env: Env,
  profile: KeyProfile
): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;

  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const namespace = resolveNamespace(profile, body.namespace);
  const date = readString(body.date);
  const dates = readStringArray(body.dates);
  const targets = dates.length > 0 ? dates : date ? [date] : [undefined];
  const maxRuns = readPositiveInt(body.max_runs, Number(env.DREAM_MAX_RUNS || env.DAILY_DIGEST_MAX_RUNS || 10), 10);
  const force = readBoolean(body.force, false);
  const results: Array<{
    date?: string;
    runs: Array<Awaited<ReturnType<typeof runDailyMemoryDigest>>>;
    diary_writer?: Awaited<ReturnType<typeof writeDiaryAfterDream>>;
  }> = [];

  for (const target of targets) {
    const runs: Array<Awaited<ReturnType<typeof runDailyMemoryDigest>>> = [];
    for (let i = 0; i < maxRuns; i += 1) {
      const result = await runDailyMemoryDigest(env, namespace, {
        dateLabel: target,
        force: force && i === 0,
        trigger: "manual"
      });
      runs.push(result);
      if (!result.ran || !result.stats?.hasMore) break;
    }
    // The nightly cron only writes yesterday's diary; do it for the date this call just brought to its last batch.
    const last = runs.at(-1);
    results.push({
      date: target,
      runs,
      ...(last?.ran ? { diary_writer: await writeDiaryAfterDream(env, namespace, last.stats.date) } : {})
    });
  }

  return json({
    data: {
      namespace,
      force,
      max_runs: maxRuns,
      results
    }
  });
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toCandidateApiRecord(row: MemoryCandidateRow) {
  return {
    id: row.id,
    namespace: row.namespace,
    type: row.type,
    content: row.content,
    fact_key: row.fact_key,
    confidence: row.confidence,
    importance: row.importance,
    tags: parseJsonArray(row.tags),
    source_message_ids: parseJsonArray(row.source_message_ids),
    ...(row.provenance ? {provenance: JSON.parse(row.provenance)} : {}),
    source: row.source,
    status: row.status,
    target_memory_id: row.target_memory_id,
    decision_note: row.decision_note,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function toJudgeDecisionRecord(row: MemoryCandidateRow) {
  const note = parseJudgeNote(row.decision_note);
  return {
    ...toCandidateApiRecord(row),
    judged_by: note?.judgedBy ?? null,
    reason: note?.reason ?? row.decision_note,
    undone: note?.undone ?? false,
    undoable: note?.undoable ?? false
  };
}

async function countMessagesInRange(
  db: D1Database,
  input: { namespace: string; startCreatedAt: string; endCreatedAt: string }
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM messages
       WHERE namespace = ?
         AND role IN ('user', 'assistant')
         AND created_at >= ?
         AND created_at < ?`
    )
    .bind(input.namespace, input.startCreatedAt, input.endCreatedAt)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function handleMemoryBoot(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  if (request.method !== "GET") return openAiError("Not found", 404);

  const url = new URL(request.url);
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));
  const scopeError = requireScope(auth.profile, "memory:read");
  if (scopeError) return scopeError;

  const start = readString(url.searchParams.get("start")) || `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const end = readString(url.searchParams.get("end")) || new Date().toISOString();
  const dailyDate = readString(url.searchParams.get("daily_date")) || getYesterdayDateLabel(readDiaryTimeZone(env));
  const [dailyLog, precious, glossary, todayMessages, todayRawCount, pendingCount, typeCounts] = await Promise.all([
    getDailyLog(env.DB, { namespace, date: dailyDate }),
    listPrecious(env.DB, { namespace, limit: 100 }),
    listGlossary(env.DB, { namespace }),
    listMessagesByNamespaceInRange(env.DB, {
      namespace,
      startCreatedAt: start,
      endCreatedAt: end,
      limit: 160
    }),
    countMessagesInRange(env.DB, { namespace, startCreatedAt: start, endCreatedAt: end }),
    countMemoryCandidates(env.DB, { namespace, status: "pending", excludeSources: IMPORT_CANDIDATE_SOURCES }),
    countActiveMemoriesByType(env.DB, namespace)
  ]);
  // 导入的候选单独数：审核页的角标只算日常的，导入的在「导入的」那一栏。
  const pendingImportCount = await countMemoryCandidates(env.DB, {
    namespace,
    status: "pending",
    onlySources: IMPORT_CANDIDATE_SOURCES
  });

  return json({
    data: {
      namespace,
      daily_log: dailyLog ? withImpressionDisclaimer({ ...dailyLog }) : dailyLog,
      precious,
      glossary,
      today_messages: todayMessages,
      stats: {
        today_raw_count: todayRawCount,
        pending_candidates: pendingCount,
        pending_import_candidates: pendingImportCount,
        memory_type_counts: typeCounts
      }
    }
  });
}

function readDiaryTimeZone(env: Env): string {
  return env.DREAM_TIME_ZONE?.trim() || env.DAILY_DIGEST_TIME_ZONE?.trim() || "Asia/Singapore";
}

export async function handleDiaryApi(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  if (request.method !== "GET") return openAiError("Not found", 404);

  const scopeError = requireScope(auth.profile, "memory:read");
  if (scopeError) return scopeError;

  const url = new URL(request.url);
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));
  const timeZone = readDiaryTimeZone(env);

  if (url.pathname === "/v1/diary/recent") {
    const today = formatDateLabel(new Date(), timeZone);
    const yesterday = getYesterdayDateLabel(timeZone);
    const rows = await Promise.all([
      getDailyLog(env.DB, { namespace, date: today }),
      getDailyLog(env.DB, { namespace, date: yesterday })
    ]);
    const data = rows
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .map((row) => withImpressionDisclaimer({ ...row }));
    return json({ data });
  }

  const date = readString(url.searchParams.get("date"));
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return openAiError("date query parameter is required (YYYY-MM-DD)", 400);
  }

  const row = await getDailyLog(env.DB, { namespace, date });
  if (!row) {
    return json({ data: null }, { status: 404 });
  }
  return json({ data: withImpressionDisclaimer({ ...row }) });
}

export async function handlePrecious(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const url = new URL(request.url);
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2];

  if (request.method === "GET" && !id) {
    const scopeError = requireScope(auth.profile, "memory:read");
    if (scopeError) return scopeError;
    const rows = await listPrecious(env.DB, { namespace, limit: readPositiveInt(url.searchParams.get("limit"), 100, 200) });
    return json({ data: rows });
  }

  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  if (request.method === "POST" && !id) {
    const body = await readJsonObject(request);
    if (!body) return openAiError("Request body must be a JSON object", 400);
    const content = readString(body.content);
    if (!content) return openAiError("content is required", 400);
    const row = await createPrecious(env.DB, {
      namespace: resolveNamespace(auth.profile, body.namespace),
      content,
      contextMessageIds: readStringArray(body.context_message_ids),
      source: readString(body.source) || "human"
    });
    return json({ data: row }, { status: 201 });
  }

  if (request.method === "DELETE" && id) {
    const deleted = await deletePrecious(env.DB, { namespace, id });
    if (!deleted) return openAiError("Precious memory not found", 404);
    return json({ data: { id, deleted: true } });
  }

  return openAiError("Not found", 404);
}

export async function handleGlossaryApi(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const url = new URL(request.url);
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2];

  if (request.method === "GET" && !id) {
    const scopeError = requireScope(auth.profile, "memory:read");
    if (scopeError) return scopeError;
    const rows = await listGlossary(env.DB, {
      namespace,
      status: readString(url.searchParams.get("status")) || "active"
    });
    return json({ data: rows });
  }

  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  if (request.method === "POST" && !id) {
    const body = await readJsonObject(request);
    if (!body) return openAiError("Request body must be a JSON object", 400);
    const term = readString(body.term);
    const definition = readString(body.definition);
    if (!term || !definition) return openAiError("term and definition are required", 400);
    const row = await upsertGlossary(env.DB, {
      namespace: resolveNamespace(auth.profile, body.namespace),
      term,
      aliases: readStringArray(body.aliases),
      definition,
      examples: readStringArray(body.examples)
    });
    return json({ data: row });
  }

  if (request.method === "PATCH" && id) {
    const body = await readJsonObject(request);
    if (!body) return openAiError("Request body must be a JSON object", 400);
    const row = await updateGlossary(env.DB, {
      namespace: resolveNamespace(auth.profile, body.namespace),
      id,
      term: readString(body.term),
      aliases: Array.isArray(body.aliases) ? readStringArray(body.aliases) : undefined,
      definition: readString(body.definition),
      examples: Array.isArray(body.examples) ? readStringArray(body.examples) : undefined,
      status: readString(body.status)
    });
    if (!row) return openAiError("Glossary term not found", 404);
    return json({ data: row });
  }

  if (request.method === "DELETE" && id) {
    const deleted = await deleteGlossary(env.DB, { namespace, id });
    if (!deleted) return openAiError("Glossary term not found", 404);
    return json({ data: { id, deleted: true } });
  }

  return openAiError("Not found", 404);
}

export async function handleLongtailApi(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  const url = new URL(request.url);
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2];

  if (request.method !== "DELETE" || !id) return openAiError("Not found", 404);

  const result = await deleteLongtail(env, { namespace, id });
  if (result === "not_found") return openAiError("Longtail entry not found", 404);
  if (result === "vector_error") {
    return openAiError("Longtail vector delete failed", 503, "memory_error");
  }
  return json({ data: { id, deleted: true } });
}

export type ApprovedMemoryResult = {
  id: string;
  action: "upserted" | "superseded" | "created";
  supersededId?: string;
};

async function createApprovedMemoryFromCandidate(
  env: Env,
  input: {
    namespace: string;
    type: string;
    content: string;
    factKey?: string | null;
    confidence: number;
    importance: number;
    tags: string[];
    sourceMessageIds: string[];
    source: string;
    provenance: MemoryProvenance;
    excludeIds?: string[];
    /** 只在新建时用 (导入的候选带着原来的日期)。 */
    createdAt?: string | null;
  }
): Promise<ApprovedMemoryResult> {
  if (input.factKey) {
    const result = await upsertMemoryByFactKey(env, {
      namespace: input.namespace,
      factKey: input.factKey,
      type: input.type,
      content: input.content,
      confidence: input.confidence,
      importance: input.importance,
      tags: input.tags,
      source: input.source,
      provenance: input.provenance,
      sourceMessageIds: input.sourceMessageIds,
      createdAt: input.createdAt
    });
    return { id: result.id, action: "upserted" };
  }

  const hit = await findSimilarActiveMemory(env, {
    namespace: input.namespace,
    content: input.content,
    excludeIds: input.excludeIds
  });
  if (hit && !hit.explicitlyWritten) {
    const result = await supersedeMemory(env, {
      namespace: input.namespace,
      oldId: hit.memory.id,
      newContent: input.content,
      newType: input.type,
      newFactKey: null,
      importance: input.importance,
      confidence: input.confidence,
      tags: input.tags,
      source: input.source,
      provenance: input.provenance,
      sourceMessageIds: input.sourceMessageIds,
      reason: "dedup_gate_supersede",
      createdAt: input.createdAt
    });
    return { id: result.newId, action: "superseded", supersededId: hit.memory.id };
  }

  const created = await createMemory(env.DB, {
    namespace: input.namespace,
    type: input.type,
    content: input.content,
    confidence: input.confidence,
    importance: input.importance,
    tags: input.tags,
    source: input.source,
    provenance: input.provenance,
    sourceMessageIds: input.sourceMessageIds,
    createdAt: input.createdAt
  });
  await syncMemoryEmbeddingBestEffort(env, created);
  return { id: created.id, action: "created" };
}

export async function handleMemoryCandidates(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const url = new URL(request.url);
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2];
  const action = parts[3];

  if (request.method === "GET" && !id) {
    const scopeError = requireScope(auth.profile, "memory:read");
    if (scopeError) return scopeError;
    // scope=daily 只要日常整理出来的，scope=import 只要导入的；不带就全要 (老客户端照旧)。
    const scope = readString(url.searchParams.get("scope"));
    const rows = await listMemoryCandidates(env.DB, {
      namespace,
      status: readString(url.searchParams.get("status")) || "pending",
      limit: readPositiveInt(url.searchParams.get("limit"), 100, 200),
      ...(scope === "daily" ? { excludeSources: IMPORT_CANDIDATE_SOURCES } : {}),
      ...(scope === "import" ? { onlySources: IMPORT_CANDIDATE_SOURCES } : {})
    });
    return json({ data: rows.map(toCandidateApiRecord) });
  }

  // 自动审核这几天替你定下的：GET /v1/candidates/decisions?days=7
  if (request.method === "GET" && id === "decisions" && !action) {
    const scopeError = requireScope(auth.profile, "memory:read");
    if (scopeError) return scopeError;
    const days = readPositiveInt(url.searchParams.get("days"), 7, 31);
    const rows = await listJudgeDecisionsSince(env.DB, {
      namespace,
      sinceIso: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
      limit: readPositiveInt(url.searchParams.get("limit"), 200, 500)
    });
    // auto_review 告诉审核页 clef 每天自动审开没开 (后台设置里的开关)。
    return json({ data: rows.map(toJudgeDecisionRecord), auto_review: isClefReviewOn(env) ? "clef" : null });
  }

  // 候选挂的原话：GET /v1/candidates/:id/sources。导入的旧聊天也在这里查得到 (getMessagesByIds 会去 imported_messages 找)。
  if (request.method === "GET" && id && action === "sources") {
    const readError = requireScope(auth.profile, "memory:read");
    if (readError) return readError;
    const candidate = await getMemoryCandidateById(env.DB, { namespace, id });
    if (!candidate) return openAiError("Candidate not found", 404);
    const ids = parseJsonArray(candidate.source_message_ids).slice(0, 90);
    const messages = await getMessagesByIds(env.DB, { namespace, ids });
    return json({
      data: {
        messages: messages.map((message) => ({
          id: message.id,
          role: message.role,
          created_at: message.created_at,
          content: message.content
        })),
        missing: Math.max(ids.length - messages.length, 0)
      }
    });
  }

  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;
  if (!id || request.method !== "POST") return openAiError("Not found", 404);

  const candidate = await getMemoryCandidateById(env.DB, { namespace, id });
  if (!candidate) return openAiError("Candidate not found", 404);
  const body = (await readJsonObject(request)) ?? {};
  const content = readString(body.content) || candidate.content;
  const type = clampMemoryType(readString(body.type) || candidate.type, "note");
  const factKey = body.fact_key === null ? null : readString(body.fact_key) ?? candidate.fact_key;
  const confidence = readNumber(body.confidence, candidate.confidence);
  const importance = readNumber(body.importance, candidate.importance);
  const tags = Array.isArray(body.tags) ? readStringArray(body.tags) : parseJsonArray(candidate.tags);
  const sourceMessageIds = Array.isArray(body.source_message_ids)
    ? await retainedMessageIds(env.DB, namespace, readStringArray(body.source_message_ids))
    : parseJsonArray(candidate.source_message_ids);

  const provenance = reviewedOrigin(candidate, "review", content !== candidate.content || Array.isArray(body.source_message_ids));
  if (action === "undo") {
    const result = await undoJudgeDecision(env, namespace, candidate);
    if (!result.ok) return openAiError(result.error, result.httpStatus);
    return json({
      data: {
        candidate: result.candidate ? toJudgeDecisionRecord(result.candidate) : null,
        status: result.status,
        memory_id: result.memoryId,
        ...(result.restoredId ? { restored_id: result.restoredId } : {})
      }
    });
  }

  if (action === "approve") {
    const saved = await approvedCandidateMemory(env.DB, namespace, candidate.id);
    if (saved) {
      const updated = candidate.status === "pending" ? await updateMemoryCandidateStatus(env.DB, {
        namespace, id, status: "approved", targetMemoryId: saved
      }) : candidate;
      return json({data: {candidate: updated ? toCandidateApiRecord(updated) : null, memory_id: saved}});
    }
    if (candidate.source === "dream_delete" && candidate.target_memory_id) {
      const archived = await archiveMemory(env, { namespace, id: candidate.target_memory_id });
      if (!archived) return openAiError("Target memory not found", 404);
      const updated = await updateMemoryCandidateStatus(env.DB, {
        namespace,
        id,
        status: "approved",
        targetMemoryId: candidate.target_memory_id,
        decisionNote: readString(body.decision_note) || "dream_delete approved"
      });
      return json({
        data: {
          candidate: updated ? toCandidateApiRecord(updated) : null,
          memory_id: candidate.target_memory_id
        }
      });
    }

    // 导入的候选：新记忆的 created_at 用那天的日期 (聊天那天或条目上写的)，updated_at 照旧是现在。
    const importDay = isImportCandidateSource(candidate.source)
      ? await getImportCandidateDay(env.DB, { candidateId: candidate.id })
      : null;
    const importCreatedAt = importDay && /^\d{4}-\d{2}-\d{2}$/.test(importDay) ? `${importDay}T12:00:00.000Z` : null;

    if (candidate.target_memory_id) {
      const target = await getMemoryById(env.DB, { namespace, id: candidate.target_memory_id });
      const targetActive =
        target &&
        target.status === "active" &&
        target.version_status !== "superseded";
      if (targetActive) {
        const result = await supersedeMemory(env, {
          namespace,
          oldId: candidate.target_memory_id,
          newContent: content,
          newType: type,
          newFactKey: factKey,
          confidence,
          importance,
          tags,
          source: "review",
          provenance,
          sourceMessageIds,
          reason: "approve_update",
          createdAt: importCreatedAt
        });
        const updated = await updateMemoryCandidateStatus(env.DB, {
          namespace,
          id,
          status: "approved",
          targetMemoryId: result.newId,
          decisionNote: readString(body.decision_note) || "approve_update"
        });
        return json({
          data: {
            candidate: updated ? toCandidateApiRecord(updated) : null,
            memory_id: result.newId,
            action: "superseded",
            superseded_id: candidate.target_memory_id
          }
        });
      }
    }

    const fallbackNote = candidate.target_memory_id
      ? `${readString(body.decision_note) || "approved"}; target_gone_fallback`
      : readString(body.decision_note) || "approved";
    const approval = await createApprovedMemoryFromCandidate(env, {
      createdAt: importCreatedAt,
      namespace,
      type,
      content,
      factKey,
      confidence,
      importance,
      tags,
      sourceMessageIds,
      source: "review",
      provenance,
      excludeIds: candidate.target_memory_id ? [candidate.target_memory_id] : undefined
    });
    const updated = await updateMemoryCandidateStatus(env.DB, {
      namespace,
      id,
      status: "approved",
      targetMemoryId: approval.id,
      decisionNote: fallbackNote
    });
    return json({
      data: {
        candidate: updated ? toCandidateApiRecord(updated) : null,
        memory_id: approval.id,
        action: approval.action,
        ...(approval.supersededId ? { superseded_id: approval.supersededId } : {})
      }
    });
  }

  if (action === "discard") {
    const updated = await updateMemoryCandidateStatus(env.DB, {
      namespace,
      id,
      status: "discarded",
      decisionNote: readString(body.decision_note) || "discarded"
    });
    return json({ data: updated ? toCandidateApiRecord(updated) : null });
  }

  if (action === "merge") {
    const targetId = readString(body.target_id);
    if (!targetId) return openAiError("target_id is required", 400);
    const target = await getMemoryById(env.DB, { namespace, id: targetId });
    if (!target) return openAiError("Target memory not found", 404);
    const mergedContent = content || target.content;
    const updatedTarget = await updateMemory(env.DB, {
      namespace,
      id: targetId,
      patch: {
        type,
        content: mergedContent,
        provenance,
        confidence: Math.max(confidence, target.confidence),
        importance: Math.max(importance, target.importance),
        tags,
        sourceMessageIds
      },
      revision: { by: "review", reason: "candidate_merge" }
    });
    if (updatedTarget) await syncMemoryEmbeddingBestEffort(env, updatedTarget);
    const updated = await updateMemoryCandidateStatus(env.DB, {
      namespace,
      id,
      status: "merged",
      targetMemoryId: targetId,
      decisionNote: readString(body.decision_note) || "merged"
    });
    return json({ data: { candidate: updated ? toCandidateApiRecord(updated) : null, memory: updatedTarget ? toMemoryApiRecord(updatedTarget) : null } });
  }

  if (action === "supersede") {
    const oldId = readString(body.target_id);
    if (!oldId) return openAiError("target_id is required", 400);
    const result = await supersedeMemory(env, {
      namespace,
      oldId,
      newContent: content,
      newType: type,
      newFactKey: factKey,
      confidence,
      importance,
      tags,
      source: "review",
      provenance,
      sourceMessageIds,
      reason: readString(body.decision_note) || "candidate_supersede"
    });
    const updated = await updateMemoryCandidateStatus(env.DB, {
      namespace,
      id,
      status: "merged",
      targetMemoryId: result.newId,
      decisionNote: readString(body.decision_note) || "superseded"
    });
    return json({ data: { candidate: updated ? toCandidateApiRecord(updated) : null, memory_id: result.newId } });
  }

  return openAiError("Not found", 404);
}

export async function handleIngestMessagesApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  return handleIngestMemories(request, env, ctx, auth.profile);
}

export async function handleSearchMemoriesApi(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  return handleSearchMemories(request, env, auth.profile);
}

async function handlePatchMemory(
  request: Request,
  env: Env,
  profile: KeyProfile,
  id: string
): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;

  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const namespace = resolveNamespace(profile, body.namespace);
  const existing = await getMemoryById(env.DB, { namespace, id });
  if (!existing || existing.namespace !== namespace) return openAiError("Memory not found", 404);

  const patch = {
    provenance: explicitWrite(profile, "rest"),
    type: readString(body.type),
    content: readString(body.content),
    summary: readOptionalString(body.summary),
    importance: typeof body.importance === "number" ? readNumber(body.importance, 0.5) : undefined,
    confidence: typeof body.confidence === "number" ? readNumber(body.confidence, 0.8) : undefined,
    status: readString(body.status),
    pinned: typeof body.pinned === "boolean" ? readBoolean(body.pinned) : undefined,
    tags: Array.isArray(body.tags) ? readStringArray(body.tags) : undefined,
    source: body.source === undefined ? undefined : readOptionalString(body.source),
    sourceMessageIds: Array.isArray(body.source_message_ids) ? await retainedMessageIds(env.DB, namespace, readStringArray(body.source_message_ids)) : undefined,
    expiresAt: body.expires_at === undefined ? undefined : readOptionalString(body.expires_at)
  };

  const updated = await updateMemory(env.DB, {
    namespace,
    id,
    patch,
    revision: { by: patch.source || profile.source, reason: "edit" }
  });
  if (updated) {
    if (updated.status === "active") {
      await syncMemoryEmbeddingBestEffort(env, updated);
    } else {
      await deleteMemoryEmbeddingBestEffort(env, updated);
    }
  }

  if (!updated) return openAiError("Memory not found", 404);
  return json({ data: toMemoryApiRecord(updated) });
}

async function handleDeleteMemory(
  request: Request,
  env: Env,
  profile: KeyProfile,
  id: string
): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;

  const namespace = resolveNamespace(profile, new URL(request.url).searchParams.get("namespace"));
  const existing = await getMemoryById(env.DB, { namespace, id });
  if (!existing || existing.namespace !== namespace) {
    const legacy = env.VECTORIZE ? await getVectorMemory(env, id) : null;
    if (!legacy || legacy.namespace !== namespace) return openAiError("Memory not found", 404);
    const deletedLegacyVector = await deleteVectorMemory(env, id);
    if (deletedLegacyVector) return json({ data: { id, deleted: true, source: "legacy_vectorize", withdrawn_memories: [] } });
    return openAiError("Memory not found", 404);
  }

  let report: Awaited<ReturnType<typeof invalidateKnownInputs>>;
  try { report = await invalidateKnownInputs(env, { namespace, id }, "memory"); }
  catch { return openAiError("Memory cleanup incomplete; retry deletion", 503); }
  await softDeleteMemory(env.DB, { namespace, id });
  return json({ data: { id: existing.id, vector_id: existing.vector_id, deleted: true, withdrawn_memories: report?.withdrawn.filter((other) => other !== id) ?? [] } });
}

async function handleGetMemory(request: Request, env: Env, profile: KeyProfile, id: string): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;

  const namespace = resolveNamespace(profile, new URL(request.url).searchParams.get("namespace"));
  const memory = await getMemoryById(env.DB, { namespace, id });

  if (!memory || memory.namespace !== namespace) return openAiError("Memory not found", 404);
  return json({ data: toMemoryApiRecord(memory) });
}

export async function handleMemories(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const tail = parts.slice(2);

  if (tail.length === 0 && request.method === "GET") {
    return handleListMemories(request, env, auth.profile);
  }

  if (tail.length === 0 && request.method === "POST") {
    return handleCreateMemory(request, env, auth.profile);
  }

  if (tail.length === 1 && tail[0] === "search" && request.method === "POST") {
    return handleSearchMemories(request, env, auth.profile);
  }

  if (tail.length === 1 && tail[0] === "recall" && request.method === "POST") {
    return handleRecallMemories(request, env, auth.profile);
  }

  if (tail.length === 1 && (tail[0] === "digest" || tail[0] === "dream") && request.method === "POST") {
    return handleRunDigest(request, env, auth.profile);
  }

  if (tail.length === 1 && tail[0] === "ingest" && request.method === "POST") {
    return handleIngestMemories(request, env, ctx, auth.profile);
  }

  if (tail.length === 1 && tail[0] === "export" && request.method === "GET") {
    return handleExportMemories(request, env, auth.profile);
  }

  if (tail.length === 2 && tail[1] === "revisions" && request.method === "GET") {
    return handleMemoryRevisions(request, env, auth.profile, tail[0]);
  }

  if (tail.length === 1) {
    const id = tail[0];
    if (request.method === "GET") return handleGetMemory(request, env, auth.profile, id);
    if (request.method === "PATCH") return handlePatchMemory(request, env, auth.profile, id);
    if (request.method === "DELETE") return handleDeleteMemory(request, env, auth.profile, id);
  }

  return openAiError("Not found", 404);
}
