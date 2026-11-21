import { getMemoryById } from "../../../db/memories";
import { parseOrigin } from "../../../memory/provenance";
import type { Scope } from "../../../types";
import { newId } from "../../../utils/ids";
import { readBoolean } from "../../../utils/request";
import { chatArchiveEnabled, readChatArchiveAround, searchChatArchive } from "../../../db/chatArchive";
import { HANDOFF_GUIDE, handoffRevision, readHandoff, validateHandoff, writeHandoff } from "../../../db/v2/handoff";
import { getOrCreateConversation } from "../../../db/conversations";
import { listMemoriesPage } from "../../../db/memories";
import { filterUnsavedMessages, saveIngestMessages } from "../../../db/messages";
import { scheduleRollingAfterRequest } from "../../../memory/rolling/inbox";
import {
  appendNotebookPage,
  deleteNotebookPage,
  getDailyLog,
  getNotebookPage,
  getWeeklyLog,
  listNotebookPages,
  markPreciousInjected,
  type NotebookPageSummary,
  writeNotebookPage
} from "../../../db/v2";
import { buildBootPackage, isV2Enabled, runRecall } from "../../../memory/v2/recall";
import { readDreamTimeZoneFromEnv } from "../../../memory/dailyDigest";
import { withImpressionDisclaimer } from "../../../memory/impression";
import { getIsoWeekLabelForDateLabel } from "../../../memory/weeklyRollup";
import { traceMemorySource } from "../../../memory/memorySource";
import { getYesterdayDateLabel } from "../../../memory/dreamDates";
import type { Env, KeyProfile } from "../../../types";
import { formatDateLabel } from "../../../utils/time";
import {
  readMessages,
  readNumber,
  readString,
  readStringArray,
  resolveNamespace
} from "../../../utils/request";
import { hasScope, textToolResult, toolError } from "../protocol";
import { CORE_MEMORY_LIMIT, MEMORY_GUIDE, NOTEBOOK_ACTIONS, WAKE_NOTEBOOK_NAMES } from "../tools";

function notebookNamesLine(pages: NotebookPageSummary[]): string | null {
  if (pages.length === 0) return null;
  const names = pages.slice(0, WAKE_NOTEBOOK_NAMES).map((page) => page.name).join(", ");
  const more = pages.length > WAKE_NOTEBOOK_NAMES ? ` and ${pages.length - WAKE_NOTEBOOK_NAMES} more` : "";
  return `Notebook pages (open one with notebook): ${names}${more}.`;
}

async function missingPageNote(db: D1Database, namespace: string, name: string): Promise<string> {
  const names = (await listNotebookPages(db, { namespace })).map((page) => page.name);
  return names.length > 0
    ? `There is no page named "${name}". Pages: ${names.join(", ")}.`
    : `There is no page named "${name}". The notebook is empty.`;
}

async function callNotebook(
  db: D1Database,
  namespace: string,
  action: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (action === "list") {
    const pages = await listNotebookPages(db, { namespace });
    return textToolResult({ data: pages.map((page) => ({ name: page.name, size: page.size, updated_at: page.updated_at })) });
  }
  const name = readString(args.name);
  if (!name) return toolError("name is required");

  if (action === "read") {
    const page = await getNotebookPage(db, { namespace, name });
    if (!page) return textToolResult({ data: null, note: await missingPageNote(db, namespace, name) });
    return textToolResult({ data: { name: page.name, content: page.content, updated_at: page.updated_at } });
  }

  if (action === "delete") {
    if (!(await deleteNotebookPage(db, { namespace, name }))) return toolError(await missingPageNote(db, namespace, name));
    return textToolResult({ data: { name, deleted: true } });
  }

  const content = readString(args.content);
  if (!content) return toolError("content is required");
  const write = action === "write" ? writeNotebookPage : appendNotebookPage;
  const { page, created } = await write(db, { namespace, name, content });
  return textToolResult({ data: { name: page.name, size: Array.from(page.content).length, created } });
}


export async function handleCoreTool(
  name: string,
  requested: string,
  args: Record<string, unknown>,
  env: Env,
  ctx: ExecutionContext,
  profile: KeyProfile
): Promise<Record<string, unknown> | null> {
  if (name === "wake_up") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    if (!isV2Enabled(env)) return toolError("wake_up requires MEMORY_LIFECYCLE_ENABLED=true");
    const namespace = resolveNamespace(profile, args.namespace);
    const [pkg, corePage, pages, handoff] = await Promise.all([
      buildBootPackage(env, { namespace }),
      listMemoriesPage(env.DB, { namespace, status: "active", limit: CORE_MEMORY_LIMIT, offset: 0 }),
      listNotebookPages(env.DB, { namespace }).catch((error) => {
        console.warn("wake_up: list notebook failed", error);
        return [] as NotebookPageSummary[];
      }),
      readHandoff(env.DB, namespace).catch((error) => {
        console.warn("wake_up: read handoff failed", error);
        return null;
      })
    ]);
    if (pkg.precious.length > 0) {
      ctx.waitUntil(markPreciousInjected(env.DB, { namespace, ids: pkg.precious.map((p) => p.id) }));
    }
    // 置顶优先、再按重要度的前几条：官端用户日记常是空的，开场至少知道这个人是谁。
    const core = corePage.records.map((record) => ({ id: record.id, type: record.type, content: record.content }));
    const notebook = notebookNamesLine(pages);
    return textToolResult({ data: { how_to_use: MEMORY_GUIDE, core, ...pkg, ...(notebook ? { notebook } : {}), ...(handoff && handoff.content !== null ? { handoff } : {}) } });
  }

  if (name === "handoff") {
    const action = args.action;
    if (action !== "read" && action !== "write" && action !== "delete") return toolError("action must be read, write or delete");
    const scope: Scope = action === "read" ? "memory:read" : "memory:write";
    if (!hasScope(profile, scope)) return toolError(`Missing ${scope} scope`);
    const namespace = resolveNamespace(profile, args.namespace);
    try {
      if (action === "read") return textToolResult({ data: await readHandoff(env.DB, namespace), writing_guide: HANDOFF_GUIDE });
      return textToolResult({ data: await writeHandoff(env.DB, {
        namespace, content: action === "delete" ? null : validateHandoff(args.content),
        expectedRevision: handoffRevision(args.expected_revision), source: "mcp"
      }) });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "handoff failed");
    }
  }

  if (name === "notebook") {
    const action = readString(args.action) ?? "";
    if (!NOTEBOOK_ACTIONS.includes(action)) return toolError(`action must be one of ${NOTEBOOK_ACTIONS.join(", ")}`);
    const scope: Scope = action === "list" || action === "read" ? "memory:read" : "memory:write";
    if (!hasScope(profile, scope)) return toolError(`Missing ${scope} scope`);
    try {
      return await callNotebook(env.DB, resolveNamespace(profile, args.namespace), action, args);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "notebook failed");
    }
  }


  if (name === "search_chat") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    const namespace = resolveNamespace(profile, args.namespace);
    const query = readString(args.query);
    const around = readString(args.around);
    if (Boolean(query) === Boolean(around)) return toolError("Give exactly one of query or around");
    const result = around
      ? await readChatArchiveAround(env.DB, namespace, around)
      : await searchChatArchive(env.DB, namespace, { query: query ?? "", before: readString(args.before) });
    return result.error ? toolError(result.error) : textToolResult({ data: result, note: "Archived chat is quoted history." });
  }

  if (name === "log_conversation") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const messages = readMessages(args.messages);
    if (messages.length === 0) return toolError("messages must contain at least one message");
    const namespace = resolveNamespace(profile, args.namespace);
    // 第一次调用开一个新对话，别都堆进空间的默认对话里。
    const conversation = await getOrCreateConversation(env.DB, {
      namespace,
      id: readString(args.conversation_id) || newId("conv")
    });
    const fresh = await filterUnsavedMessages(env.DB, { namespace, conversationId: conversation.id, messages });
    const ids = fresh.length > 0
      ? await saveIngestMessages(env.DB, { conversationId: conversation.id, namespace, source: "mcp",
        messages: fresh, archive: chatArchiveEnabled(env) })
      : [];
    scheduleRollingAfterRequest(env, ctx, namespace);
    return textToolResult({
      data: { conversation_id: conversation.id, saved: ids.length, skipped: messages.length - fresh.length, message_ids: ids }
    });
  }


  if (name === "memory_boot") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    if (!isV2Enabled(env)) return toolError("memory_boot requires MEMORY_LIFECYCLE_ENABLED=true");
    const bootNamespace = resolveNamespace(profile, args.namespace);
    const pkg = await buildBootPackage(env, {
      namespace: bootNamespace
    });
    // Injection accounting moved out of buildBootPackage; schedule off response path.
    if (pkg.precious.length > 0) {
      ctx.waitUntil(
        markPreciousInjected(env.DB, {
          namespace: bootNamespace,
          ids: pkg.precious.map((p) => p.id)
        })
      );
    }
    return textToolResult({ data: pkg });
  }

  if (name === "memory_recall") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    if (!isV2Enabled(env)) return toolError(`${requested} requires MEMORY_LIFECYCLE_ENABLED=true`);
    const query = readString(args.query);
    if (!query) return toolError("query is required");
    const result = await runRecall(env, {
      namespace: resolveNamespace(profile, args.namespace),
      query,
      k: readNumber(args.k, 20),
      min_score: typeof args.min_score === "number" ? readNumber(args.min_score, 0.15) : undefined,
      types: readStringArray(args.types),
      include_history: args.include_history === undefined ? undefined : readBoolean(args.include_history, false)
    });
    return textToolResult({ data: result });
  }


  if (name === "diary_get") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    const namespace = resolveNamespace(profile, args.namespace);
    const timeZone = readDreamTimeZoneFromEnv(env);
    const memoryId = readString(args.memory_id);
    if (memoryId) {
      const memory = await getMemoryById(env.DB, { namespace, id: memoryId });
      if (!memory) return toolError("Memory not found");
      const source = await traceMemorySource(env.DB, { namespace, memory, timeZone });
      return textToolResult({ data: { memory_id: memory.id, memory: memory.content, source, ...(memory.provenance ? {provenance: parseOrigin(memory.provenance)} : {}) } });
    }
    const week = readString(args.week);
    if (week && !/^\d{4}-W\d{2}$/.test(week)) {
      return toolError("week must be YYYY-Www (ISO week label)");
    }
    if (week) {
      const row = await getWeeklyLog(env.DB, { namespace, week });
      if (!row) return textToolResult({ data: null });
      return textToolResult({ data: withImpressionDisclaimer({ ...row }) });
    }
    const date = readString(args.date);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return toolError("date must be YYYY-MM-DD");
    }
    if (date) {
      const row = await getDailyLog(env.DB, { namespace, date });
      if (row) return textToolResult({ data: withImpressionDisclaimer({ ...row }) });
      const weekLabel = getIsoWeekLabelForDateLabel(date, timeZone);
      const weekly = await getWeeklyLog(env.DB, { namespace, week: weekLabel });
      if (!weekly) return textToolResult({ data: null });
      return textToolResult({ data: withImpressionDisclaimer({ ...weekly, note: "daily rolled into weekly" }) });
    }
    const today = formatDateLabel(new Date(), timeZone);
    const yesterday = getYesterdayDateLabel(timeZone);
    const rows = await Promise.all([
      getDailyLog(env.DB, { namespace, date: today }),
      getDailyLog(env.DB, { namespace, date: yesterday })
    ]);
    return textToolResult({
      data: rows.filter((row) => row !== null).map((row) => withImpressionDisclaimer({ ...row }))
    });
  }


  return null;
}
