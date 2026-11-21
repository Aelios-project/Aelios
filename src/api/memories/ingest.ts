import { HANDOFF_MAX, HandoffError, residentHandoffMetadata, saveResidentHandoff, validateHandoff } from "../../db/v2/handoff";
import { readStringArray } from "../../utils/request";
import { authenticate } from "../../auth/apiKey";
import { requireScope } from "../../auth/scopes";
import { getOrCreateConversation } from "../../db/conversations";
import { chatArchiveEnabled } from "../../db/chatArchive";
import { saveIngestMessages } from "../../db/messages";
import { scheduleRollingAfterRequest } from "../../memory/rolling/inbox";
import { runDailyMemoryDigest } from "../../memory/dailyDigest";
import { writeDiaryAfterDream } from "../../memory/diaryWriter";
import type { Env, KeyProfile } from "../../types";
import { json, openAiError } from "../../utils/json";
import {
  readBoolean,
  readJsonObject,
  readMessages,
  readPositiveInt,
  readString,
  resolveNamespace
} from "../../utils/request";

export async function handleIngestMemories(
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
  scheduleRollingAfterRequest(env, ctx, namespace);

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

export async function handleRunDigest(
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


export async function handleIngestMessagesApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  return handleIngestMemories(request, env, ctx, auth.profile);
}

