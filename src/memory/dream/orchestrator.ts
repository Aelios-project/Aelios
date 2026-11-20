import { DREAM_RUN_STALE_MS } from "../../db/dreamRuns";
import { listDreamDayCandidates } from "../../db/v2";
import { digestDayCandidates } from "./dailyPhase";
import { listMessagesByNamespaceInRange } from "../../db/messages";
import { readCursor, writeCursor } from "../../db/retention";
import type { Env, MemoryApiRecord } from "../../types";
import { newId } from "../../utils/ids";
import { nowIso } from "../../utils/time";
import { readString } from "../../utils/parse";
import {
  formatDreamCursor,
  getDateLabelsLookback,
  getDateRangeForLabel,
  getTargetDigestDateLabel,
  readDailyCursor
} from "../dreamDates";
import {
  isDreamEnabled,
  readDreamMaxMessages,
  readDreamMemoryContextLimit,
  readDreamStrategy,
  readDreamTimeZone
} from "../dreamEnv";
import { runPerceptionPickPhase } from "../perception";
import type { PerceptionPickStats } from "../perception";
import { runRelationBuildPhase, runZAuditPhase } from "../relations";
import type { RelationBuildStats, ZAuditStats } from "../relations";
import { runTriggerBuildPhase } from "../triggers";
import type { TriggerBuildStats } from "../triggers";
import { listVectorMemories } from "../vectorStore";
import { isV2Enabled } from "../v2/recall";
import { runExtractPhase } from "./extractPhase";
import {
  type DailyDigestRunOptions,
  type DailyDigestRunResult,
  cleanEmptyMemories,
  countRawMessagesForDateLabel,
  readDreamCursorValue,
  safeFinishDreamRun,
  safeInsertDreamRun,
  selectDreamMemoryContext
} from "./helpers";
import { buildDreamRoutingPlan, runJudgePhase, queueDreamExtractedMemories } from "./judgePhase";
import { runLifecyclePhase } from "./lifecyclePhase";

// Re-export date/env surface so external importers of dailyDigest keep working.
export {
  addDaysToDateLabel,
  getDateLabelsLookback,
  getDateRangeForLabel,
  getTargetDigestDateLabel,
  readDailyCursor
} from "../dreamDates";
export { readDreamTimeZoneFromEnv } from "../dreamEnv";

export type {
  DailyDigestRunOptions,
  DailyDigestRunResult,
  DailyDigestStats,
  DreamRoutingItem,
  DreamRoutingPlan
} from "./helpers";

export { buildDreamRoutingPlan };
export { countRawMessagesForDateLabel, readDreamCursorValue };

export async function runDreamBackfill(
  env: Env,
  namespace: string,
  options: { maxDates?: number; lookback?: number } = {}
): Promise<Array<{ dateLabel: string; result: DailyDigestRunResult }>> {
  const maxDates = options.maxDates ?? 2;
  const lookback = options.lookback ?? 3;
  const timeZone = readDreamTimeZone(env);
  const anchorDateLabel = getTargetDigestDateLabel(timeZone);
  const candidateLabels = getDateLabelsLookback(anchorDateLabel, lookback + 1, timeZone).slice(1);
  const results: Array<{ dateLabel: string; result: DailyDigestRunResult }> = [];
  let backfilled = 0;

  for (const dateLabel of candidateLabels) {
    if (backfilled >= maxDates) break;

    const { startIso, endIso } = getDateRangeForLabel(dateLabel, timeZone);
    const cursor = await readDreamCursorValue(env.DB, { namespace, dateLabel });
    const cursorState = readDailyCursor(cursor, startIso, endIso);
    if (cursorState.done) continue;

    const rawCount = await countRawMessagesForDateLabel(env.DB, { namespace, dateLabel, timeZone });
    if (rawCount === 0 && !(env.DREAM_DIGEST_MODE === "daily" && cursorState.after)) continue;

    const result = await runDailyMemoryDigest(env, namespace, { dateLabel, trigger: "cron" });
    results.push({ dateLabel, result });
    if (result.ran) backfilled += 1;
  }

  return results;
}

export async function runDailyMemoryDigest(
  env: Env,
  namespace: string,
  options: DailyDigestRunOptions = {}
): Promise<DailyDigestRunResult> {
  let dreamRunId = options.runId ?? null;
  try {
    if (!isDreamEnabled(env)) {
      await safeFinishDreamRun(env.DB, { id: dreamRunId, status: "skipped", reason: "dream_disabled" });
      return { ran: false, mode: "dream", reason: "dream_disabled" };
    }
    const timeZone = readDreamTimeZone(env);
    const dateLabel = readString(options.dateLabel) || getTargetDigestDateLabel(timeZone);
    dreamRunId ??= await safeInsertDreamRun(env.DB, { namespace, dateLabel, trigger: options.trigger ?? "cron" });
    const run = { dreamRunId, timeZone, dateLabel };
    if (options.dryRun || (env.DREAM_DIGEST_MODE !== "daily" && env.DREAM_EPISODE_LEDGER !== "1"))
      return await performDailyMemoryDigest(env, namespace, options, run);
    // Cron and manual jobs can overlap for a day. An abandoned claim ages out after the job deadline.
    const name = `dream_batch_claim:${namespace}:${dateLabel}`;
    const token = newId("claim");
    const claim = await env.DB.prepare(`INSERT INTO processing_cursors(name,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE updated_at<?`)
      .bind(name,token,nowIso(),new Date(Date.now()-DREAM_RUN_STALE_MS).toISOString()).run();
    if (!claim.meta.changes) {
      await safeFinishDreamRun(env.DB,{id:dreamRunId,status:"skipped",reason:"dream_in_progress"});
      return {ran:false,mode:"dream",date:dateLabel,reason:"dream_in_progress"};
    }
    try {
      return await performDailyMemoryDigest(env, namespace, options, run);
    } finally {
      await env.DB.prepare("DELETE FROM processing_cursors WHERE name=? AND value=?").bind(name,token).run();
    }
  } catch (error) {
    await safeFinishDreamRun(env.DB, {
      id: dreamRunId,
      status: "error",
      reason: "run_failed",
      error: "Dream stopped before completion; earlier writes may already exist. Inspect Worker logs before retrying."
    });
    console.error("dream: run failed", { runId: dreamRunId, error });
    throw error;
  }
}

async function performDailyMemoryDigest(
  env: Env,
  namespace: string,
  options: DailyDigestRunOptions,
  run: { dreamRunId: string | null; timeZone: string; dateLabel: string }
): Promise<DailyDigestRunResult> {
  const { dreamRunId, timeZone, dateLabel } = run;
  const dryRun = options.dryRun === true;
  const { startIso, endIso } = getDateRangeForLabel(dateLabel, timeZone);
  const cursorName = `dream:${namespace}:${dateLabel}`;
  const legacyCursorName = `daily_digest:${namespace}:${dateLabel}`;
  const cursor = (await readCursor(env.DB, cursorName)) ?? (await readCursor(env.DB, legacyCursorName));
  const cursorState = options.force ? { done: false, after: null, afterId: null } : readDailyCursor(cursor, startIso, endIso);
  if (cursorState.done) {
    await safeFinishDreamRun(env.DB, {
      id: dreamRunId,
      status: "skipped",
      reason: "already_done"
    });
    return { ran: false, mode: "dream", date: dateLabel, reason: "already_done", startIso, endIso, cursor };
  }

  const daily = env.DREAM_DIGEST_MODE === "daily";
  const maxMessages = readDreamMaxMessages(env);
  const fetchedMessages = await listMessagesByNamespaceInRange(env.DB, {
    namespace,
    startCreatedAt: startIso,
    endCreatedAt: endIso,
    afterCreatedAt: cursorState.after,
    afterId: cursorState.afterId,
    limit: maxMessages + 1
  });
  if (fetchedMessages.length === 0 && !(daily && cursorState.after)) {
    if (!dryRun) {
      await writeCursor(env.DB, cursorName, `done:${cursorState.after ?? startIso}`);
    }
    await safeFinishDreamRun(env.DB, {
      id: dreamRunId,
      status: "skipped",
      reason: "no_messages"
    });
    return { ran: false, mode: "dream", date: dateLabel, reason: "no_messages", startIso, endIso, cursor };
  }

  const memoryContextLimit = readDreamMemoryContextLimit(env);
  const strategy = readDreamStrategy(env);
  const v2Enabled = isV2Enabled(env);
  const batch = fetchedMessages.slice(0, maxMessages);
  const day = {namespace, dateLabel, startIso, endIso};
  const ledger = env.DREAM_EPISODE_LEDGER === "1"
    ? await listDreamDayCandidates(env.DB, {...day, pendingOnly:true}) : undefined;
  let existingMemories: MemoryApiRecord[] = [];
  try {
    if (!daily && v2Enabled) {
      existingMemories = await selectDreamMemoryContext(env, {
        namespace,
        messages: batch,
        limit: memoryContextLimit
      });
    } else if (!daily) {
      existingMemories = (await listVectorMemories(env, {
        namespace,
        count: memoryContextLimit
      })).data;
    }
  } catch (error) {
    console.error("dream: failed to list existing memories", error);
  }
  let cleanedEmptyMemories =
    daily || dryRun || (v2Enabled && strategy === "review") ? 0 : await cleanEmptyMemories(env, namespace);
  const fetchedHasMore = fetchedMessages.length > maxMessages;

  // --- extract phase (digest model + dream extract) ---
  const extractPhase = await runExtractPhase(env, {
    namespace,
    dateLabel,
    startIso,
    endIso,
    messages: batch,
    existingMemories,
    ledger,
    hasMore: fetchedHasMore
  });
  const { messages, hasMore, extractedMemories } = extractPhase;
  let { modelResult } = extractPhase;
  let messageIds = messages.map(message => message.id);
  const lastMessage = messages.at(-1);
  const position = { createdAt: lastMessage?.created_at ?? cursorState.after ?? startIso, id: lastMessage?.id ?? cursorState.afterId };
  let extractedCount = 0;
  if (daily && !extractPhase.extractReason && (dryRun || v2Enabled)) {
    if (!dryRun && lastMessage) {
      extractedCount = await queueDreamExtractedMemories(env, {namespace, dateLabel, memories:extractedMemories, messageIds, strict:true});
      await writeCursor(env.DB, cursorName, formatDreamCursor({...position, done:false}));
    }
    if (hasMore && !dryRun) {
      await safeFinishDreamRun(env.DB, {id:dreamRunId, status:"ok", processedMessages:messages.length, model:modelResult.model});
      return {ran:true, stats:{date:dateLabel, mode:"dream", processedMessages:messages.length, addedMemories:0,
        updatedMemories:0, deletedMemories:0, queuedCandidates:extractedCount, cleanedEmptyMemories:0, cursorAdvanced:true, hasMore}};
    }
    if (!hasMore) {
      if (!dryRun && strategy !== "review") cleanedEmptyMemories = await cleanEmptyMemories(env,namespace);
      ({ existingMemories, messageIds, modelResult } = await digestDayCandidates(env, day,
        memoryContextLimit, dryRun ? extractedMemories : []));
    }
  }
  const digest = modelResult.digest;

  if (!digest) {
    console.error("dream: digest incomplete", {
      reason: modelResult.reason,
      model: modelResult.model,
      status: modelResult.status
    });
    await safeFinishDreamRun(env.DB, {
      id: dreamRunId,
      status: "error",
      reason: modelResult.reason ?? "model_error",
      model: modelResult.model,
      processedMessages: messages.length,
      error: modelResult.finishReason
        ? `finish_reason=${modelResult.finishReason}`
        : modelResult.status
          ? `status=${modelResult.status}`
          : null
    });
    return {
      ran: false,
      mode: "dream",
      date: dateLabel,
      reason: modelResult.reason ?? "model_error",
      startIso,
      endIso,
      cursor,
      processedMessages: messages.length,
      model: modelResult.model,
      status: modelResult.status,
      finishReason: modelResult.finishReason
    };
  }

  if (extractPhase.extractReason) {
    console.error("dream: extract failed; cursor not advanced", {
      date: dateLabel,
      reason: extractPhase.extractReason,
      model: extractPhase.extractModel,
      status: extractPhase.extractStatus
    });
    await safeFinishDreamRun(env.DB, {
      id: dreamRunId,
      status: "error",
      reason: extractPhase.extractReason === "model_invalid_json" ? "extract_invalid_json"
        : extractPhase.extractReason === "model_timeout" ? "extract_model_timeout" : "extract_model_error",
      model: extractPhase.extractModel ?? modelResult.model,
      processedMessages: messages.length,
      error: extractPhase.extractStatus
        ? `status=${extractPhase.extractStatus}`
        : extractPhase.extractFinishReason ? `finish_reason=${extractPhase.extractFinishReason}` : extractPhase.extractReason
    });
    return {
      ran: false,
      mode: "dream",
      date: dateLabel,
      reason: extractPhase.extractReason === "model_invalid_json" ? "extract_invalid_json"
        : extractPhase.extractReason === "model_timeout" ? "extract_model_timeout" : "extract_model_error",
      startIso,
      endIso,
      cursor,
      processedMessages: messages.length,
      model: extractPhase.extractModel ?? modelResult.model,
      status: extractPhase.extractStatus
    };
  }

  if (dryRun) {
    // --- judge phase (routing plan only) ---
    const { routingPlan } = await runJudgePhase(env, {
      namespace,
      extracted: extractedMemories,
      digest
    });
    await safeFinishDreamRun(env.DB, {
      id: dreamRunId,
      status: "skipped",
      reason: "dry_run",
      model: modelResult.model,
      processedMessages: messages.length
    });
    return {
      ran: true,
      stats: {
        date: dateLabel,
        mode: "dream",
        processedMessages: messages.length,
        addedMemories: 0,
        updatedMemories: 0,
        deletedMemories: 0,
        queuedCandidates: routingPlan.summary.to_candidates,
        cleanedEmptyMemories,
        cursorAdvanced: false,
        hasMore
      },
      proposal: digest,
      routing_plan: routingPlan,
      extracted_memories: extractedMemories
    };
  }


  if (!v2Enabled) {
    console.error("dream: v2 lifecycle disabled; cursor not advanced", { namespace, date: dateLabel });
    await safeFinishDreamRun(env.DB, {
      id: dreamRunId,
      status: "error",
      reason: "v2_disabled",
      model: modelResult.model,
      processedMessages: messages.length
    });
    return {
      ran: false,
      mode: "dream",
      date: dateLabel,
      reason: "v2_disabled",
      startIso,
      endIso,
      cursor,
      processedMessages: messages.length,
      model: modelResult.model
    };
  }

  // --- lifecycle phase (supersede / archive / upsert / candidates + daily log) ---
  const v2Result = await runLifecyclePhase(env, {
    namespace,
    strategy,
    dateLabel,
    messages,
    digest,
    messageIds,
    extracted: daily ? [] : extractedMemories,
    writeDraft: !daily,
    contextMemoryIds: existingMemories.filter(m => m.namespace === namespace).map(m => m.id)
  });

  if (daily && v2Result.errors.some(error => error.reason !== "target_not_found")) {
    throw new Error("Daily digest writes incomplete; extraction checkpoint retained");
  }

  // --- LMC-5 phases (after existing tidy; each isolated so failures don't scrap the night) ---
  let relationBuild: RelationBuildStats | undefined;
  try {
    relationBuild = await runRelationBuildPhase(env, {
      namespace,
      startIso,
      endIso
    });
  } catch (error) {
    console.error("dream: relation-build phase failed", {
      namespace,
      date: dateLabel,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  // 触发器建期。和上面的 relation-build 一样单独隔离：这一步烧模型调用，
  // 失败不该把整夜的整理一起拖掉。TRIGGER_BUILD 默认 off，关着时它立刻返回。
  let triggerBuild: TriggerBuildStats | undefined;
  try {
    triggerBuild = await runTriggerBuildPhase(env, {
      namespace,
      startIso,
      endIso
    });
  } catch (error) {
    console.error("dream: trigger-build phase failed", {
      namespace,
      date: dateLabel,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  let zAudit: ZAuditStats | undefined;
  try {
    zAudit = await runZAuditPhase(env, {
      namespace,
      startIso,
      endIso
    });
    if (zAudit.pairs.length > 0) {
      // 夜批报告：under_review 对写入 memory_events，供人工确认后 supersede
      await env.DB
        .prepare(
          `INSERT INTO memory_events (id, namespace, event_type, memory_id, payload_json, created_at)
           VALUES (?, ?, ?, NULL, ?, ?)`
        )
        .bind(
          newId("evt"),
          namespace,
          "dream_z_audit",
          JSON.stringify({
            date: dateLabel,
            pairs: zAudit.pairs,
            marked_under_review: zAudit.marked_under_review,
            edges_inserted: zAudit.edges_inserted,
            note: "Never auto-supersede; human confirm via memory_supersede"
          }),
          nowIso()
        )
        .run();
      console.log("dream z_audit report", {
        namespace,
        date: dateLabel,
        pairs: zAudit.pairs.length,
        marked: zAudit.marked_under_review,
        edges: zAudit.edges_inserted
      });
    }
  } catch (error) {
    console.error("dream: z_audit phase failed", {
      namespace,
      date: dateLabel,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  let perception: PerceptionPickStats | undefined;
  try {
    // End-phase: pick 1–2 high-importance, not-recalled-in-7d, redacted items.
    // When multi-batch dream (hasMore), still refresh cache so SessionStart sees latest pick.
    perception = await runPerceptionPickPhase(env, { namespace, dateLabel });
  } catch (error) {
    console.error("dream: perception pick phase failed", {
      namespace,
      date: dateLabel,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  await writeCursor(env.DB, cursorName, formatDreamCursor({
    done: !hasMore,
    ...position
  }));

  // LMC-5 phase report is additive audit data — never stuff into dream_runs.error
  // (legacy shape is JSON array of apply errors, or null). Persist via memory_events.
  const hasLmc5Report =
    relationBuild !== undefined ||
    zAudit !== undefined ||
    perception !== undefined ||
    triggerBuild !== undefined;
  if (hasLmc5Report) {
    try {
      await env.DB
        .prepare(
          `INSERT INTO memory_events (id, namespace, event_type, memory_id, payload_json, created_at)
           VALUES (?, ?, ?, NULL, ?, ?)`
        )
        .bind(
          newId("evt"),
          namespace,
          "dream_lmc5_report",
          JSON.stringify({
            date: dateLabel,
            relation_build: relationBuild ?? null,
            trigger_build: triggerBuild ?? null,
            z_audit_pairs: zAudit?.pairs ?? [],
            z_audit: zAudit
              ? {
                  marked_under_review: zAudit.marked_under_review,
                  edges_inserted: zAudit.edges_inserted,
                  pairs: zAudit.pairs
                }
              : null,
            perception: perception ?? null
          }),
          nowIso()
        )
        .run();
    } catch (error) {
      console.warn("dream: failed to write lmc5 report event", {
        namespace,
        date: dateLabel,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // dream_runs.error: restore pre-LMC5 shape — JSON array of {target_id,reason} or null.
  // Successful runs with only z_audit findings / relation truncation stay status=ok, error=null.
  await safeFinishDreamRun(env.DB, {
    id: dreamRunId,
    status: "ok",
    model: modelResult.model,
    processedMessages: messages.length,
    error: v2Result.errors.length > 0 ? JSON.stringify(v2Result.errors) : null
  });

  return {
    ran: true,
    stats: {
      date: dateLabel,
      mode: "dream",
      processedMessages: messages.length,
      addedMemories: v2Result.added,
      updatedMemories: v2Result.updated,
      deletedMemories: v2Result.deleted,
      queuedCandidates: extractedCount + v2Result.queuedCandidates,
      cleanedEmptyMemories,
      cursorAdvanced: true,
      hasMore,
      errors: v2Result.errors,
      relation_build: relationBuild,
      z_audit: zAudit,
      perception
    }
  };
}

