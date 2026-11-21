import { listMessagesByNamespaceInRange } from "../../db/messages";
import { countActiveMemoriesByType, countMemoryCandidates, getDailyLog, IMPORT_CANDIDATE_SOURCES, listGlossary, listPrecious } from "../../db/v2";
import { getYesterdayDateLabel } from "../../memory/dreamDates";
import type { MemoryApiRecord } from "../../types";
import { readStringArray } from "../../utils/request";
import { countMessagesInRange, readDiaryTimeZone } from "./shared";
import { authenticate } from "../../auth/apiKey";
import { requireScope } from "../../auth/scopes";
import { filterAndCompressMemoriesWithMeta } from "../../memory/filter";
import { formatMemoryPatch } from "../../memory/inject";
import { searchMemories } from "../../memory/search";
import { withImpressionDisclaimer } from "../../memory/impression";
import { isV2Enabled, runRecall } from "../../memory/v2/recall";
import type { Env, KeyProfile } from "../../types";
import { json, openAiError } from "../../utils/json";
import {
  readBoolean,
  readJsonObject,
  readPositiveInt,
  readString,
  resolveNamespace
} from "../../utils/request";
import { readRecallK } from "./shared";

export async function handleSearchMemories(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
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


export async function handleRecallMemories(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
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


export async function handleSearchMemoriesApi(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  return handleSearchMemories(request, env, auth.profile);
}

