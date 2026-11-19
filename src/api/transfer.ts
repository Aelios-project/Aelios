// 记忆导入的接口。导出走 GET /v1/memories/export?format=md|jsonl (见 memories.ts)。
//
// GET  /v1/import/info                 页面要的设置：抽取模型、clef 开没开、时区、切段上限、给旧 AI 的提示词
// POST /v1/import/entries/preview      认一份整理好的条目 (md / jsonl / json)，回解析结果，不写库
// POST /v1/import/entries              写一小批条目 (direct 直接写 / review 进审核)
// POST /v1/import/batches              开 (或接着) 一次聊天记录导入，回已经做完的段
// POST /v1/import/chat/chunk           处理一段聊天
// GET  /v1/import/batches              导入过的批次和进度
// GET  /v1/import/candidates           审核页「导入的」：候选 + 数量
// GET  /v1/import/candidates/ids       批量操作要的 id
//
// 空间：跟别的接口一样，?namespace= 或 body.namespace 选，key 允许选空间时才生效。

import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import {
  countImportCandidates,
  getImportBatch,
  type ImportCandidateFilter,
  listImportBatches,
  listImportCandidateIds,
  listImportCandidates,
  listMemoryRevisions,
  recordImportChunk,
  upsertImportBatch
} from "../db/v2";
import { isClefReviewOn } from "../memory/clefJudge";
import { CANONICAL_MEMORY_TYPES } from "../memory/canonicalTypes";
import { readDreamModel, readDreamTimeZoneFromEnv } from "../memory/dreamEnv";
import { loadSpeakersForNamespace } from "../memory/speakers";
import {
  archiveChatChunk,
  CHAT_CHUNK_DEFAULT_CHARS,
  CHAT_CHUNK_DEFAULT_MESSAGES,
  CHAT_CHUNK_MAX_CHARS,
  CHAT_CHUNK_MAX_MESSAGES,
  importChatChunk,
  validateChatChunk
} from "../memory/transfer/importChat";
import { importMemoryEntries } from "../memory/transfer/importEntries";
import {
  buildImportPrompt,
  type ImportEntry,
  MAX_ENTRY_CHARS,
  MAX_IMPORT_ENTRIES,
  mapTypeName,
  parseMemoryImport
} from "../memory/transfer/memoryText";
import type { Env, KeyProfile } from "../types";
import { json, openAiError } from "../utils/json";
import { isRecord, readBoolean, readJsonObject, readNonNegativeInt, readPositiveInt, readString, resolveNamespace } from "../utils/request";

/** 一次请求最多写多少条：每条要查重、可能要向量检索，D1 一次请求的子请求数有限。 */
export const ENTRIES_PER_REQUEST = 25;
/** 预览时一份文字最多多大 (字符)。 */
const MAX_PREVIEW_CHARS = 5_000_000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function readFilter(value: string | null): ImportCandidateFilter {
  return value === "clef_yes" || value === "clef_no" ? value : "all";
}

/** 页面送回来的条目再过一遍：只收认得的字段，长度和类型都卡住。 */
export function sanitizeImportEntry(value: unknown): ImportEntry | null {
  if (!isRecord(value)) return null;
  const content = typeof value.content === "string" ? value.content.trim() : "";
  if (!content || content.length > MAX_ENTRY_CHARS) return null;
  const kind = value.kind === "precious" ? "precious" : "memory";
  const type = typeof value.type === "string" ? mapTypeName(value.type) : null;
  const date = typeof value.date === "string" && DAY_RE.test(value.date) ? value.date : null;
  let createdAt: string | null = null;
  if (typeof value.createdAt === "string" && value.createdAt) {
    const parsed = new Date(value.createdAt);
    if (!Number.isNaN(parsed.getTime())) createdAt = parsed.toISOString();
  }
  const tags = Array.isArray(value.tags)
    ? [...new Set(value.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim().slice(0, 40)).filter(Boolean))].slice(0, 12)
    : [];
  const factKey = typeof value.factKey === "string" && value.factKey.trim() ? value.factKey.trim().slice(0, 160) : null;
  const score = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : null);
  return {
    kind,
    content,
    type,
    date,
    createdAt,
    tags,
    factKey,
    importance: score(value.importance),
    confidence: score(value.confidence),
    pinned: value.pinned === true
  };
}

async function handleInfo(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;
  const url = new URL(request.url);
  const namespace = resolveNamespace(profile, url.searchParams.get("namespace"));
  const speakers = await loadSpeakersForNamespace(env, namespace);
  return json({
    data: {
      namespace,
      model: readDreamModel(env),
      clef: { available: Boolean(env.AI), on: isClefReviewOn(env) },
      time_zone: readDreamTimeZoneFromEnv(env),
      speakers: speakers ? { user: speakers.userName, assistant: speakers.assistantName } : null,
      chunk: {
        max_messages: CHAT_CHUNK_MAX_MESSAGES,
        max_chars: CHAT_CHUNK_MAX_CHARS,
        default_messages: CHAT_CHUNK_DEFAULT_MESSAGES,
        default_chars: CHAT_CHUNK_DEFAULT_CHARS
      },
      entries: { max: MAX_IMPORT_ENTRIES, max_chars: MAX_ENTRY_CHARS, per_request: ENTRIES_PER_REQUEST },
      types: CANONICAL_MEMORY_TYPES,
      prompt: buildImportPrompt(speakers?.userName ?? null)
    }
  });
}

async function handleEntriesPreview(request: Request, profile: KeyProfile): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;
  const body = await readJsonObject(request);
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim()) return openAiError("text is required", 400);
  if (text.length > MAX_PREVIEW_CHARS) return openAiError(`text is too long (max ${MAX_PREVIEW_CHARS} characters)`, 413);
  const parsed = parseMemoryImport(text);
  const byType: Record<string, number> = {};
  for (const entry of parsed.entries) {
    const key = entry.kind === "precious" ? "precious" : entry.type ?? "unknown";
    byType[key] = (byType[key] ?? 0) + 1;
  }
  return json({
    data: {
      format: parsed.format,
      total: parsed.entries.length,
      by_type: byType,
      dated: parsed.entries.filter((entry) => entry.date || entry.createdAt).length,
      with_fact_key: parsed.entries.filter((entry) => entry.factKey).length,
      skipped: parsed.skipped,
      warnings: parsed.warnings,
      entries: parsed.entries
    }
  });
}

async function handleEntriesImport(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;
  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);
  const namespace = resolveNamespace(profile, body.namespace ?? new URL(request.url).searchParams.get("namespace"));
  const fingerprint = readString(body.fingerprint);
  if (!fingerprint || fingerprint.length > 128) return openAiError("fingerprint is required", 400);
  const mode = body.mode === "review" ? "review" : "direct";
  if (!Array.isArray(body.entries) || body.entries.length === 0) return openAiError("entries must be a non-empty array", 400);
  if (body.entries.length > ENTRIES_PER_REQUEST) return openAiError(`send at most ${ENTRIES_PER_REQUEST} entries per request`, 400);
  const entries = body.entries.map(sanitizeImportEntry);
  const bad = entries.findIndex((entry) => entry === null);
  if (bad >= 0) return openAiError(`entries[${bad}] is not a valid entry`, 400);
  const startIndex = readNonNegativeInt(body.start_index, 0, MAX_IMPORT_ENTRIES);
  const total = readPositiveInt(body.total, entries.length, MAX_IMPORT_ENTRIES);

  const { batch } = await upsertImportBatch(env.DB, {
    namespace,
    kind: "entries",
    name: readString(body.name)?.slice(0, 200) ?? null,
    fingerprint: `${mode}:${fingerprint}`,
    totalChunks: Math.ceil(total / ENTRIES_PER_REQUEST),
    totalMessages: total
  });
  const result = await importMemoryEntries(env, {
    namespace,
    importId: batch.id,
    entries: entries as ImportEntry[],
    mode,
    startIndex
  });
  await recordImportChunk(env.DB, {
    importId: batch.id,
    key: `entries#${startIndex}`,
    status: result.counts.failed === entries.length ? "error" : "done",
    messages: entries.length,
    chars: (entries as ImportEntry[]).reduce((sum, entry) => sum + entry.content.length, 0),
    candidates: result.counts.queued,
    error: result.counts.failed ? `${result.counts.failed} failed` : null
  });
  return json({ data: { import_id: batch.id, mode, ...result } });
}

async function handleStartBatch(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;
  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);
  const namespace = resolveNamespace(profile, body.namespace ?? new URL(request.url).searchParams.get("namespace"));
  const fingerprint = readString(body.fingerprint);
  if (!fingerprint || fingerprint.length > 128) return openAiError("fingerprint is required", 400);
  if (body.mode !== undefined && body.mode !== "memory" && body.mode !== "archive") {
    return openAiError("mode must be memory or archive", 400);
  }
  const archive = body.mode === "archive";
  const day = (value: unknown) => (typeof value === "string" && DAY_RE.test(value) ? value : null);
  const result = await upsertImportBatch(env.DB, {
    namespace,
    kind: archive ? "archive" : "chat",
    name: readString(body.name)?.slice(0, 200) ?? null,
    fingerprint: `${archive ? "archive" : "chat"}:${fingerprint}`,
    totalChunks: readNonNegativeInt(body.total_chunks, 0, 1_000_000),
    totalMessages: readNonNegativeInt(body.total_messages, 0, 100_000_000),
    totalChars: readNonNegativeInt(body.total_chars, 0, 2_000_000_000),
    firstDate: day(body.first_date),
    lastDate: day(body.last_date),
    model: archive ? null : readDreamModel(env)
  });
  return json({ data: { batch: result.batch, done_keys: result.doneKeys, created: result.created } }, { status: result.created ? 201 : 200 });
}

async function handleChatChunk(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;
  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);
  const namespace = resolveNamespace(profile, body.namespace ?? new URL(request.url).searchParams.get("namespace"));
  const importId = readString(body.import_id);
  if (!importId) return openAiError("import_id is required", 400);
  const batch = await getImportBatch(env.DB, { namespace, id: importId });
  if (!batch || (batch.kind !== "chat" && batch.kind !== "archive")) return openAiError("Import batch not found", 404);
  const checked = validateChatChunk(body.chunk, batch.kind === "archive");
  if ("error" in checked) return openAiError(checked.error, 400);
  if (batch.kind === "archive") {
    const result = await archiveChatChunk(env.DB, batch, checked.chunk);
    const after = await getImportBatch(env.DB, { namespace, id: importId });
    return json({ data: { result, batch: after } });
  }

  const speakers = await loadSpeakersForNamespace(env, namespace);
  const result = await importChatChunk(env, {
    namespace,
    batch,
    chunk: checked.chunk,
    speakers,
    clef: typeof body.clef === "boolean" ? body.clef : undefined,
    force: readBoolean(body.force)
  });
  const after = await getImportBatch(env.DB, { namespace, id: importId });
  return json({ data: { result, batch: after } });
}

async function handleListBatches(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;
  const url = new URL(request.url);
  const namespace = resolveNamespace(profile, url.searchParams.get("namespace"));
  const rows = await listImportBatches(env.DB, {
    namespace,
    limit: readPositiveInt(url.searchParams.get("limit"), 50, 200)
  });
  return json({ data: rows });
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

async function handleListCandidates(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;
  const url = new URL(request.url);
  const namespace = resolveNamespace(profile, url.searchParams.get("namespace"));
  const importId = readString(url.searchParams.get("import_id")) ?? null;
  const filter = readFilter(url.searchParams.get("filter"));
  const [rows, counts] = await Promise.all([
    listImportCandidates(env.DB, {
      namespace,
      importId,
      status: readString(url.searchParams.get("status")) || "pending",
      filter,
      limit: readPositiveInt(url.searchParams.get("limit"), 50, 200),
      offset: readNonNegativeInt(url.searchParams.get("offset"), 0, 1_000_000)
    }),
    countImportCandidates(env.DB, { namespace, importId })
  ]);
  return json({
    data: rows.map((row) => ({
      id: row.id,
      namespace: row.namespace,
      type: row.type,
      content: row.content,
      fact_key: row.fact_key,
      confidence: row.confidence,
      importance: row.importance,
      tags: parseIds(row.tags),
      source_message_ids: parseIds(row.source_message_ids),
      source: row.source,
      status: row.status,
      target_memory_id: row.target_memory_id,
      decision_note: row.decision_note,
      created_at: row.created_at,
      updated_at: row.updated_at,
      import_id: row.import_id,
      day: row.day,
      clef_grounded: row.clef_grounded,
      clef_worth: row.clef_worth,
      existing_content: row.existing_content
    })),
    counts
  });
}

async function handleCandidateIds(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;
  const url = new URL(request.url);
  const namespace = resolveNamespace(profile, url.searchParams.get("namespace"));
  const ids = await listImportCandidateIds(env.DB, {
    namespace,
    importId: readString(url.searchParams.get("import_id")) ?? null,
    filter: readFilter(url.searchParams.get("filter")),
    limit: readPositiveInt(url.searchParams.get("limit"), 2000, 5000)
  });
  return json({ data: ids });
}

export async function handleImportApi(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (method === "GET" && pathname === "/v1/import/info") return handleInfo(request, env, auth.profile);
  if (method === "POST" && pathname === "/v1/import/entries/preview") return handleEntriesPreview(request, auth.profile);
  if (method === "POST" && pathname === "/v1/import/entries") return handleEntriesImport(request, env, auth.profile);
  if (method === "POST" && pathname === "/v1/import/batches") return handleStartBatch(request, env, auth.profile);
  if (method === "GET" && pathname === "/v1/import/batches") return handleListBatches(request, env, auth.profile);
  if (method === "POST" && pathname === "/v1/import/chat/chunk") return handleChatChunk(request, env, auth.profile);
  if (method === "GET" && pathname === "/v1/import/candidates") return handleListCandidates(request, env, auth.profile);
  if (method === "GET" && pathname === "/v1/import/candidates/ids") return handleCandidateIds(request, env, auth.profile);
  return openAiError("Not found", 404);
}

/** GET /v1/memories/:id/revisions：这条记忆原地改写前的旧版，新的在前。 */
export async function handleMemoryRevisions(request: Request, env: Env, profile: KeyProfile, id: string): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;
  const namespace = resolveNamespace(profile, new URL(request.url).searchParams.get("namespace"));
  const rows = await listMemoryRevisions(env.DB, { namespace, memoryId: id });
  return json({
    data: rows.map((row) => ({
      id: row.id,
      memory_id: row.memory_id,
      type: row.type,
      content: row.content,
      tags: parseIds(row.tags),
      fact_key: row.fact_key,
      source: row.source,
      written_at: row.written_at,
      replaced_by: row.replaced_by,
      reason: row.reason,
      created_at: row.created_at
    }))
  });
}
