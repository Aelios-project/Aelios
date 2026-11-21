import type { ToolCallParams } from "../protocol";
import { getOrCreateConversation } from "../../../db/conversations";
import { getMemoryById, listMemoriesPage } from "../../../db/memories";
import { retainedMessageIds, saveIngestMessages } from "../../../db/messages";
import { scheduleRollingAfterRequest } from "../../../memory/rolling/inbox";
import {
  archiveMemory,
  createPrecious,
  deleteMemoryWithReport,
  fetchMemoryLifecycleRows,
  getActiveMemoryByFactKey,
  supersedeMemory,
  upsertGlossary,
  upsertMemoryByFactKey
} from "../../../db/v2";
import { exportMemories } from "../../../memory/export";
import { explicitWrite, } from "../../../memory/provenance";
import { isV2Enabled } from "../../../memory/v2/recall";
import { searchMemories, toMemoryApiRecord } from "../../../memory/search";
import {
  createVectorMemory,
  deleteVectorMemory,
  getVectorMemory,
  listVectorMemories
} from "../../../memory/vectorStore";
import type { Env, KeyProfile } from "../../../types";
import { newId } from "../../../utils/ids";
import {
  readBoolean,
  readMessages,
  readNonNegativeInt,
  readNumber,
  readPositiveInt,
  readString,
  readStringArray,
  resolveNamespace
} from "../../../utils/request";
import { hasScope, textToolResult, toolError } from "../protocol";

export async function handleMemoryTool(
  name: string,
  requested: string,
  args: Record<string, unknown>,
  env: Env,
  ctx: ExecutionContext,
  profile: KeyProfile,
  dispatchTool: (params: ToolCallParams) => Promise<Record<string, unknown>>
): Promise<Record<string, unknown> | null> {
  if (name === "remember") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    if (!isV2Enabled(env)) return toolError("remember requires MEMORY_LIFECYCLE_ENABLED=true");
    const content = readString(args.content);
    if (!content) return toolError("content is required");
    const namespace = resolveNamespace(profile, args.namespace);
    const factKey = readString(args.fact_key);
    let replaces = readString(args.replaces);
    try {
      const sourceMessageIds = await retainedMessageIds(env.DB, namespace, readStringArray(args.source_message_ids));
      // 传了已有的 fact_key 也走替换，旧版本留作历史；remember 从不原地覆盖。
      if (!replaces && factKey) replaces = (await getActiveMemoryByFactKey(env.DB, { namespace, factKey }))?.id;
      if (replaces) {
        const result = await supersedeMemory(env, {
          namespace,
          oldId: replaces,
          newContent: content,
          newType: readString(args.type),
          newFactKey: factKey,
          allowWorldFact: true,
          validAsOf: readString(args.valid_as_of),
          reason: readString(args.reason),
          importance: readNumber(args.importance, 0.6),
          confidence: readNumber(args.confidence, 0.8),
          tags: readStringArray(args.tags),
          source: "mcp",
          provenance: explicitWrite(profile, "mcp", readString(args.authored_by)),
          sourceMessageIds,
          authoredBy: readString(args.authored_by) || null,
          responseTendency: readString(args.response_tendency) || null
        });
        return textToolResult({
          data: { id: result.newId, created: true, replaced: result.oldStatus === "missing" ? null : replaces }
        });
      }
      const result = await upsertMemoryByFactKey(env, {
        namespace,
        // 没给 key 就现编一个，模型不用先想名字才能记。
        factKey: factKey ?? `remember:${newId("k").slice(2)}`,
        content,
        type: readString(args.type) || "fact",
        allowWorldFact: true,
        importance: readNumber(args.importance, 0.6),
        confidence: readNumber(args.confidence, 0.8),
        tags: readStringArray(args.tags),
        source: "mcp",
        provenance: explicitWrite(profile, "mcp", readString(args.authored_by)),
        sourceMessageIds,
        validAsOf: readString(args.valid_as_of),
        authoredBy: readString(args.authored_by) || null,
        responseTendency: readString(args.response_tendency) || null
      });
      return textToolResult({ data: { id: result.id, created: result.created, replaced: null } });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "remember failed");
    }
  }

  if (name === "forget") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const id = readString(args.id);
    if (!id) return toolError("id is required");
    const namespace = resolveNamespace(profile, args.namespace);
    try {
      if (readBoolean(args.permanent)) return await dispatchTool({ name: "memory_delete", arguments: args });
      if (!isV2Enabled(env)) return toolError("memory_archive requires MEMORY_LIFECYCLE_ENABLED=true");
      if (!await archiveMemory(env, { namespace, id, dismissCandidates: true })) return toolError("Memory not found");
      return textToolResult({ data: { id, archived: true } });
    } catch { return toolError("Memory cleanup incomplete; retry forget"); }
  }


  if (name === "memory_search") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    const query = readString(args.query);
    if (!query) return toolError("query is required");
    const memories = await searchMemories(env, {
      namespace: resolveNamespace(profile, args.namespace),
      query,
      topK: readNumber(args.top_k, Number(env.MEMORY_TOP_K || 50)),
      types: readStringArray(args.types)
    });
    return textToolResult({ data: memories });
  }

  if (name === "memory_create") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    if (isV2Enabled(env)) return toolError("memory_create is deprecated in v2; use remember");
    const content = readString(args.content);
    if (!content) return toolError("content is required");
    let memory: Awaited<ReturnType<typeof createVectorMemory>>;
    try {
      memory = await createVectorMemory(env, {
        namespace: resolveNamespace(profile, args.namespace),
        type: readString(args.type) || "note",
        content,
        summary: readString(args.summary) || null,
        importance: readNumber(args.importance, 0.5),
        confidence: readNumber(args.confidence, 0.8),
        pinned: readBoolean(args.pinned),
        tags: readStringArray(args.tags),
        source: readString(args.source) || "mcp",
        sourceMessageIds: []
      });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "memory_create failed");
    }
    return textToolResult({ data: memory });
  }

  if (name === "memory_list") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    const limit = readPositiveInt(args.limit, 100, 1000);
    const namespace = resolveNamespace(profile, args.namespace);

    // v2: 走 D1 (本体)，能列出 fact_key upsert 写入的记录。
    // v1: 走 Vectorize (向量是当时唯一存储)。
    if (isV2Enabled(env)) {
      const page = await listMemoriesPage(env.DB, {
        namespace,
        type: readString(args.type),
        status: readString(args.status) ?? "active",
        limit,
        offset: readNonNegativeInt(args.offset ?? 0, 0, 1000000)
      });
      const lifecycleRows = await fetchMemoryLifecycleRows(env.DB, page.records.map((r) => r.id));
      const lifecycleByMemoryId = new Map(lifecycleRows.map((lc) => [lc.memory_id, lc]));
      return textToolResult({
        data: page.records.map((r) => toMemoryApiRecord(r, undefined, lifecycleByMemoryId.get(r.id) ?? null)),
        paging: {
          limit,
          has_more: page.hasMore,
          next_offset: page.nextOffset
        }
      });
    }

    try {
      const page = await listVectorMemories(env, {
        namespace,
        count: limit,
        cursor: readString(args.cursor),
        type: readString(args.type) ?? undefined,
        status: readString(args.status) ?? undefined
      });
      return textToolResult({
        data: page.data,
        ...(readBoolean(args.include_ids) ? { ids: page.ids } : {}),
        paging: {
          limit,
          cursor: page.cursor,
          has_more: page.hasMore,
          count: page.count,
          total_count: page.totalCount
        }
      });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : `${requested} failed`);
    }
  }

  if (name === "memory_export") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    if (!hasScope(profile, "export:read")) return toolError("Missing export:read scope");
    try {
      const result = await exportMemories(env, {
        namespace: resolveNamespace(profile, args.namespace),
        type: readString(args.type),
        format: readString(args.format) || "json"
      });
      return textToolResult(result);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "memory_export failed");
    }
  }

  if (name === "memory_get") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    const id = readString(args.id);
    if (!id) return toolError("id is required");

    // v2: 走 D1，能拿到 fact_key upsert / supersede 写入的记录。
    if (isV2Enabled(env)) {
      const record = await getMemoryById(env.DB, {
        namespace: resolveNamespace(profile, args.namespace),
        id
      });
      if (!record) return toolError("Memory not found");
      const lifecycleRows = await fetchMemoryLifecycleRows(env.DB, [record.id]);
      return textToolResult({ data: toMemoryApiRecord(record, undefined, lifecycleRows[0] ?? null) });
    }

    const memory = await getVectorMemory(env, id);
    if (!memory || memory.namespace !== resolveNamespace(profile, args.namespace)) return toolError("Memory not found");
    return textToolResult({ data: memory });
  }

  if (name === "memory_delete") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const id = readString(args.id);
    if (!id) return toolError("id is required");

    // v2: 硬删 D1 + 向量 (本体和镜像一起删)，找不到返回 false。
    if (isV2Enabled(env)) {
      const deleted = await deleteMemoryWithReport(env, {
        namespace: resolveNamespace(profile, args.namespace),
        id
      });
      if (!deleted) return toolError("Memory not found");
      return textToolResult({ data: { id, deleted: true, withdrawn_memories: deleted.withdrawn.filter((other) => other !== id) } });
    }

    const legacy = await getVectorMemory(env, id);
    if (!legacy || legacy.namespace !== resolveNamespace(profile, args.namespace)) return toolError("Memory not found");
    await deleteVectorMemory(env, id);
    return textToolResult({
      data: {
        id,
        deleted: true
      }
    });
  }

  if (name === "memory_ingest") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const messages = readMessages(args.messages);
    if (messages.length === 0) return toolError("messages must contain at least one message");
    const namespace = resolveNamespace(profile, args.namespace);
    const conversation = await getOrCreateConversation(env.DB, {
      namespace,
      id: readString(args.conversation_id)
    });
    const source = readString(args.source) || "mcp";
    const ids = await saveIngestMessages(env.DB, {
      conversationId: conversation.id,
      namespace,
      source,
      messages
    });
    scheduleRollingAfterRequest(env, ctx, namespace);

    return textToolResult({
      data: {
        conversation_id: conversation.id,
        message_ids: ids,
        auto_extract: args.auto_extract !== false
      }
    });
  }



  // --- Aelios 记忆库 v2 端点 (母帖 #11 第 2 步) ---
  // 全部走 MEMORY_LIFECYCLE_ENABLED 总闸；关时返回未启用，不碰 v2 表。


  if (name === "memory_pin") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    if (!isV2Enabled(env)) return toolError(`${requested} requires MEMORY_LIFECYCLE_ENABLED=true`);
    const content = readString(args.content);
    if (!content) return toolError("content is required");
    const precious = await createPrecious(env.DB, {
      namespace: resolveNamespace(profile, args.namespace),
      content,
      contextMessageIds: readStringArray(args.context_message_ids)
    });
    return textToolResult({ data: precious });
  }

  if (name === "glossary_set") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    if (!isV2Enabled(env)) return toolError(`${requested} requires MEMORY_LIFECYCLE_ENABLED=true`);
    const term = readString(args.term);
    const definition = readString(args.definition);
    if (!term) return toolError("term is required");
    if (!definition) return toolError("definition is required");
    const row = await upsertGlossary(env.DB, {
      namespace: resolveNamespace(profile, args.namespace),
      term,
      aliases: readStringArray(args.aliases),
      definition,
      examples: readStringArray(args.examples)
    });
    return textToolResult({ data: row });
  }

  if (name === "memory_upsert") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    if (!isV2Enabled(env)) return toolError("memory_upsert requires MEMORY_LIFECYCLE_ENABLED=true");
    const factKey = readString(args.fact_key);
    const content = readString(args.content);
    if (!factKey) return toolError("fact_key is required");
    if (!content) return toolError("content is required");
    try {
      const result = await upsertMemoryByFactKey(env, {
        namespace: resolveNamespace(profile, args.namespace),
        factKey,
        content,
        type: readString(args.type) || "fact",
        importance: readNumber(args.importance, 0.6),
        confidence: readNumber(args.confidence, 0.8),
        tags: readStringArray(args.tags),
        source: readString(args.source) || "mcp",
        provenance: explicitWrite(profile, "mcp", readString(args.authored_by)),
        validAsOf: readString(args.valid_as_of),
        authoredBy: readString(args.authored_by) || null,
        responseTendency: readString(args.response_tendency) || null
      });
      return textToolResult({ data: result });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "memory_upsert failed");
    }
  }

  if (name === "memory_supersede") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    if (!isV2Enabled(env)) return toolError("memory_supersede requires MEMORY_LIFECYCLE_ENABLED=true");
    const oldId = readString(args.old_id);
    const newContent = readString(args.new_content);
    if (!oldId) return toolError("old_id is required");
    if (!newContent) return toolError("new_content is required");
    try {
      const result = await supersedeMemory(env, {
        namespace: resolveNamespace(profile, args.namespace),
        oldId,
        newContent,
        newType: readString(args.new_type) || "world_fact",
        newFactKey: readString(args.new_fact_key),
        validAsOf: readString(args.valid_as_of),
        reason: readString(args.reason),
        // MCP 走的是亲手通道：source 记 "mcp"，E 轴字段随之生效 (也能亲手 supersede 亲笔记忆)。
        source: "mcp",
        provenance: explicitWrite(profile, "mcp", readString(args.authored_by)),
        authoredBy: readString(args.authored_by) || null,
        responseTendency: readString(args.response_tendency) || null
      });
      return textToolResult({ data: result });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "memory_supersede failed");
    }
  }

  if (name === "memory_archive") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    if (!isV2Enabled(env)) return toolError("memory_archive requires MEMORY_LIFECYCLE_ENABLED=true");
    const id = readString(args.id);
    if (!id) return toolError("id is required");
    const archived = await archiveMemory(env, {
      namespace: resolveNamespace(profile, args.namespace),
      id
    });
    if (!archived) return toolError("Memory not found");
    return textToolResult({ data: { id, archived: true } });
  }

  if (name === "digest_get" || name === "digest_set") {
    return toolError(
      `${requested} is deprecated in v3; digest lives in the client system prompt. Use read_diary for daily_log.`
    );
  }

  if (name === "memory_extract_dryrun") {
    return toolError(
      "memory_extract_dryrun is deprecated in v3; extraction runs via the dream nightly pipeline. Use dream dry_run endpoints instead."
    );
  }

  // 候选审核：clef 自动审关着时，助手自己用这两个工具审。决定记成 judge[助手名]，审核页能撤回。

  return null;
}
