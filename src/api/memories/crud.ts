import { clampMemoryType } from "../../memory/canonicalTypes";
import { fetchMemoryLifecycleRows, upsertMemoryByFactKey } from "../../db/v2";
import { isV2Enabled } from "../../memory/v2/recall";
import { loadSpeakersForNamespace } from "../../memory/speakers";
import { readDreamTimeZoneFromEnv } from "../../memory/dreamEnv";
import { requireScope } from "../../auth/scopes";
import { createMemory, getMemoryById, listMemoriesPage, softDeleteMemory, updateMemory } from "../../db/memories";
import { retainedMessageIds } from "../../db/messages";
import { exportMemories, exportMemoryDocument } from "../../memory/export";
import { toMemoryApiRecord } from "../../memory/search";
import { invalidateKnownInputs } from "../../db/v2/revocation";
import { explicitWrite } from "../../memory/provenance";
import { deleteVectorMemory, getVectorMemory } from "../../memory/vectorStore";
import { attachCurrentStateMeta, isScopedDecisionRecord } from "../../memory/currentState/store";
import type { Env, KeyProfile, } from "../../types";
import { json, openAiError } from "../../utils/json";
import {
  readBoolean,
  readJsonObject,
  readNumber,
  readNonNegativeInt,
  readOptionalString,
  readPositiveInt,
  readString,
  readStringArray,
  resolveNamespace
} from "../../utils/request";
import { deleteMemoryEmbeddingBestEffort, syncMemoryEmbeddingBestEffort } from "./shared";

export async function handleCreateMemory(
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

export async function handleListMemories(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
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
    data: await attachCurrentStateMeta(env.DB, namespace, page.records),
    paging: {
      limit,
      cursor: page.nextOffset === null ? null : String(page.nextOffset),
      has_more: page.hasMore,
      count: page.records.length
    }
  });
}

export async function handleExportMemories(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
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


export async function handlePatchMemory(
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
  if (isScopedDecisionRecord(existing)) {
    return openAiError(
      "Scoped decision records cannot be edited directly; withdraw the source message or record a new decision instead.",
      409,
      "scoped_decision_immutable"
    );
  }

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

export async function handleDeleteMemory(
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

export async function handleGetMemory(request: Request, env: Env, profile: KeyProfile, id: string): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;

  const namespace = resolveNamespace(profile, new URL(request.url).searchParams.get("namespace"));
  const memory = await getMemoryById(env.DB, { namespace, id });

  if (!memory || memory.namespace !== namespace) return openAiError("Memory not found", 404);
  const [enriched] = await attachCurrentStateMeta(env.DB, namespace, [memory]);
  return json({ data: enriched });
}

