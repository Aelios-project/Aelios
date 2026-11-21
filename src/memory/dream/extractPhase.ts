import { groundCandidate } from "../grounding";
import { DECISION_FORMAT, extractDecisionFallback } from "../currentState/extract";
import { isCurrentStateEnabled } from "../currentState/projection";
import type { Env, MemoryApiRecord, MessageRecord, OpenAIChatRequest } from "../../types";
import { callDreamModelJson, DreamModelTimeoutError } from "./modelCall";
import { extractJsonObject } from "../../utils/parse";
import { CHAT_MATERIAL_RULES } from "../chatMaterial";
import { extractDreamMemoriesFromMessages } from "../dreamExtract";
import { dreamOutputLimit, readDreamModel } from "../dreamEnv";
import type { ExtractedMemory } from "../extract";
import { nameOnlyRule } from "../speakers";
import { loadConfig, speakersForNamespace, type DreamSpeakers } from "../../gateway/config";
import {
  type DailyDigestResult,
  type DigestModelCallResult,
  formatExistingMemories,
  formatTranscript,
  normalizeDigestResult
} from "./helpers";

const DREAM_MODEL_RETRY_BACKOFF_MS = [2000, 8000];
const MAX_BATCH_REDUCTIONS = 3;
const EXTRACT_PHASE_BUDGET_MS = 8 * 60_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableModelStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function buildDigestPrompt(input: {
  dateLabel: string;
  startIso: string;
  endIso: string;
  messages: MessageRecord[];
  existingMemories: MemoryApiRecord[];
  hasMore: boolean;
  speakers?: DreamSpeakers | null;
  scopedDecisions?: boolean;
}): string {
  const speakers = input.speakers ?? null;
  const speakerRule = speakers
    ? `- Write in third person using "${speakers.userName}" for the user and "${speakers.assistantName}" for the assistant (e.g. "${speakers.assistantName} should..."). ${nameOnlyRule(speakers)} The transcript labels turns with these names.`
    : "- Write from the assistant's perspective: use second person for the user and first person for the assistant's commitments.";
  return [
    "You are Aelios's nightly Dream memory organizer. While the user rests, you review existing long-term memories alongside today's transcript and produce a cleaner, more accurate, more consistent memory consolidation plan.",
    "Write all human-facing fields (title, summary, sections, updated memory content) strictly in the user's own language, determined only from the user's messages (ignore assistant replies; if the user mixes languages, use the language the user uses most).",
    "Prioritize factual accuracy and specificity: base every updated memory strictly on what was actually said, and never add emotions, details, or interpretations absent from the transcript.",
    "Output valid JSON only, with no markdown fences, no commentary, and no reasoning.",
    "",
    "List only actually cited raw message IDs in source_message_ids; leave it empty when none are cited.",
    "Dream goals:",
    "- Consolidate duplicate memories so the same fact does not linger in multiple versions.",
    "- Spot outdated, contradicted, or superseded memories and propose updates or archival (all changes enter the review queue).",
    "- Check for overlaps or conflicts between today's conversation and existing memories.",
    "- Draft a concise, human-toned daily digest rather than a dry play-by-play log.",
    "",
    "Window:",
    `- Process only the conversation window for ${input.dateLabel} (${input.startIso} to ${input.endIso}).`,
    input.hasMore ? "- This is one batch of the day, not the full day; consolidate only what appears in this batch." : "- This is the final or complete batch of the day.",
    "",
    "Principles:",
    "- Do not turn every chat line into a memory; keep only facts, preferences, boundaries, ongoing projects, and promises useful in future conversations.",
    "- Prefer fewer, clearer memories over transient tone, small talk, duplicates, or debugging noise.",
    "- Only explicit corrections supersede an earlier stance. Questions, tentative options, speculation, and silence are not decisions. Leave unresolved contradictions for review and state clearly who said what.",
    "- When new details refine an existing memory, use memories_to_update instead of memories_to_add.",
    "- First-time extraction of durable facts is handled by the nightly extractor; keep memories_to_add as [] by default.",
    "- When multiple existing memories duplicate each other, keep the richer one (updating it first if needed) and delete the redundant copies.",
    "- Never delete pinned=true memories; propose only conservative refinements in memories_to_update.",
    "- If an old temporary plan or intention has expired, happened, or been replaced today, update it into a durable fact or archive it.",
    speakerRule,
    "- Never mention D1, Vectorize, RAG, databases, memory systems, or proxy internals.",
    ...CHAT_MATERIAL_RULES,
    "",
    "Dream output format:",
    "- title: a short title (around 3-8 words or <=12 CJK chars).",
    "- summary: one clear, accurate paragraph describing what was discussed and what this pass organized, strictly grounded in the transcript.",
    "- sections: up to 3 objects with heading and content, or [] if unnecessary.",
    "- memories_to_add: compatibility field, default [] in v2.",
    "- memories_to_update: target only existing memory IDs provided below.",
    "- memories_to_update type must be one of: fact, event, preference, relationship, boundary, habit, decision, note (map project progress to fact, promises/decisions to decision).",
    "- memories_to_delete: remove only empty, duplicate, clearly expired, or contradicted memories.",
    "- Keep output concise and well-formed.",
    "",
    "Output JSON shape (angle brackets are placeholders, never copy them verbatim):",
    JSON.stringify({
      date: input.dateLabel,
      title: "<short title>",
      summary: "<one paragraph summarizing what happened in this batch and what was updated; state plainly if no changes were needed>",
      sections: [{ heading: "<heading>", content: "<content>" }],
      memories_to_add: [],
      memories_to_update: [
        {
          target_id: "mem_x",
          source_message_ids: ["<supporting message ID>"],
          content: "<updated memory content>",
          type: "fact",
          importance: 0.88,
          confidence: 0.9,
          tags: ["project"]
        }
      ],
      memories_to_delete: [{ target_id: "mem_y", source_message_ids: ["<supporting message ID>"], reason: "empty or duplicate" }]
    }),
    "",
    ...(input.scopedDecisions ? [DECISION_FORMAT,
      "Also include a decisions array whose items contain content, type, attributed_role, evidence_quote, source_message_ids, and decision. decision.state_of may list existing memory IDs below whose current-state claim is updated by this decision."] : []),
    "Existing long-term memories:",
    formatExistingMemories(input.existingMemories),
    "",
    "Today's raw conversation:",
    formatTranscript(input.messages, speakers)
  ].join("\n");
}

const DIGEST_LIST_KEYS = ["sections", "memories_to_add", "memories_to_update", "memories_to_delete"] as const;

/** A list field of the wrong type means the model ignored the format; a missing one is simply empty. */
function digestListsWellFormed(raw: DailyDigestResult): boolean {
  return DIGEST_LIST_KEYS.every((key) => raw[key] == null || Array.isArray(raw[key]));
}

/**
 * Entries that cannot be used (blank, wrong type, an update that changes nothing) are dropped and counted rather than
 * failing the batch: they would never have been applied, and rejecting the whole night over one kept the cursor stuck.
 */
function sanitizeDigestItems(raw: DailyDigestResult): { digest: DailyDigestResult; dropped: number } {
  const normalized = normalizeDigestResult(raw);
  const digest = normalized.memories_to_update
    ? {
        ...normalized,
        memories_to_update: normalized.memories_to_update.filter((item) =>
          [item.content, item.type, item.importance, item.confidence, item.tags].some((value) => value !== undefined))
      }
    : normalized;
  const dropped = DIGEST_LIST_KEYS.reduce(
    (sum, key) => sum + Math.max(0, (raw[key]?.length ?? 0) - (digest[key]?.length ?? 0)),
    0
  );
  return { digest, dropped };
}

export async function callDigestModel(
  env: Env,
  prompt: string,
  meta: { dateLabel: string; messageCount: number; memoryCount: number; hasMore: boolean; deadlineAt?: number }
): Promise<DigestModelCallResult> {
  const model = readDreamModel(env);
  if (!model) {
    console.error("dream: missing model");
    return { digest: null, reason: "missing_model" };
  }

  const request: OpenAIChatRequest = {
    model,
    messages: [
      { role: "system", content: "You are a strict JSON generator. Output valid JSON only, with no markdown fences and no reasoning." },
      { role: "user", content: prompt }
    ],
    ...dreamOutputLimit(env, model),
    response_format: {
      type: "json_object"
    },
    stream: false
  };

  const startedAt = Date.now();
  console.log("dream: calling model", {
    date: meta.dateLabel,
    model,
    messageCount: meta.messageCount,
    memoryCount: meta.memoryCount,
    hasMore: meta.hasMore,
    promptChars: prompt.length,
    maxTokens: request.max_tokens
  });

  const maxAttempts = 1 + DREAM_MODEL_RETRY_BACKOFF_MS.length;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (meta.deadlineAt !== undefined && meta.deadlineAt <= Date.now()) {
      return { digest: null, reason: "model_timeout", model };
    }
    if (attempt > 0) {
      const backoffMs = DREAM_MODEL_RETRY_BACKOFF_MS[attempt - 1] ?? DREAM_MODEL_RETRY_BACKOFF_MS.at(-1) ?? 8000;
      console.warn("dream: retrying model call after non-ok response", {
        date: meta.dateLabel,
        model,
        attempt: attempt + 1,
        maxAttempts,
        backoffMs
      });
      if (meta.deadlineAt !== undefined && Date.now() + backoffMs >= meta.deadlineAt) {
        return { digest: null, reason: "model_timeout", model };
      }
      await delay(backoffMs);
    }

    try {
      const response = await callDreamModelJson(env, request,
        meta.deadlineAt === undefined ? undefined : Math.min(120_000, meta.deadlineAt - Date.now()));
      const elapsedMs = Date.now() - startedAt;
      if (!response.ok) {
        const retriable = isRetriableModelStatus(response.status);
        console.error("dream: model returned non-ok", {
          date: meta.dateLabel,
          model,
          status: response.status,
          statusText: response.statusText,
          elapsedMs,
          attempt: attempt + 1,
          retriable
        });
        if (retriable && attempt < maxAttempts - 1) continue;
        return { digest: null, reason: "model_error", model, status: response.status };
      }
      const choice = response.parsed?.choices?.[0];
      const message = choice?.message as ({ content?: unknown; reasoning_content?: unknown }) | undefined;
      const content = typeof message?.content === "string" ? message.content.trim() : "";
      const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
      const json = extractJsonObject(content || reasoning);
      const shape = json as DailyDigestResult | null;
      if (!shape || typeof shape !== "object" || Array.isArray(shape)
        || typeof shape.title !== "string" || !shape.title.trim()
        || typeof shape.summary !== "string" || !shape.summary.trim()
        || !digestListsWellFormed(shape)) {
        console.error("dream: model returned invalid JSON", {
          date: meta.dateLabel,
          model,
          elapsedMs,
          finishReason: choice?.finish_reason ?? null,
          contentChars: content.length,
          reasoningChars: reasoning.length
        });
        return { digest: null, reason: "model_invalid_json", model, finishReason: choice?.finish_reason };
      }
      const { digest, dropped } = sanitizeDigestItems(shape);
      if (dropped > 0) {
        console.warn("dream: dropped unusable digest entries", { date: meta.dateLabel, model, dropped });
      }
      console.log("dream: model returned valid JSON", {
        date: meta.dateLabel,
        model,
        elapsedMs,
        finishReason: choice?.finish_reason ?? null,
        contentChars: content.length,
        reasoningChars: reasoning.length,
        attempt: attempt + 1
      });
      return { digest, model };
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const message = error instanceof Error && error.message ? error.message : String(error);
      console.error("dream model failed", {
        date: meta.dateLabel,
        model,
        elapsedMs,
        attempt: attempt + 1,
        error: message
      });
      // A deadline is not automatically retried: the provider may still be completing a billed request.
      if (error instanceof DreamModelTimeoutError) return { digest: null, reason: "model_timeout", model };
      if (attempt < maxAttempts - 1) continue;
      return { digest: null, reason: "model_error", model };
    }
  }

  return { digest: null, reason: "model_error", model };
}

/** Run digest and extraction on exactly the same batch; only a fully valid batch may advance the cursor. */
export async function runExtractPhase(
  env: Env,
  input: {
    namespace: string;
    dateLabel: string;
    startIso: string;
    endIso: string;
    messages: MessageRecord[];
    existingMemories: MemoryApiRecord[];
    hasMore: boolean;
    extractMessageIds?: ReadonlySet<string>;
  }
): Promise<{
  messages: MessageRecord[];
  hasMore: boolean;
  modelResult: DigestModelCallResult;
  extractedMemories: ExtractedMemory[];
  extractReason?: "model_error" | "model_timeout" | "model_invalid_json" | "missing_model";
  extractModel?: string;
  extractStatus?: number;
  extractFinishReason?: string | null;
}> {
  let messages = input.messages;
  let hasMore = input.hasMore;
  let reductions = 0;
  const deadlineAt = Date.now() + EXTRACT_PHASE_BUDGET_MS;
  const speakers = speakersForNamespace(await loadConfig(env), input.namespace);
  const owned = input.extractMessageIds;

  for (;;) {
    const extractMessages = owned ? messages.filter(message => owned.has(message.id)) : messages;
    if (!extractMessages.length) return { messages, hasMore, modelResult: { digest: {} }, extractedMemories: [] };
    const prompt = buildDigestPrompt({
      dateLabel: input.dateLabel,
      startIso: input.startIso,
      endIso: input.endIso,
      messages: extractMessages,
      existingMemories: input.existingMemories,
      hasMore,
      speakers,
      scopedDecisions: isCurrentStateEnabled(env)
    });
    const modelResult = await callDigestModel(env, prompt, {
      dateLabel: input.dateLabel,
      messageCount: extractMessages.length,
      memoryCount: input.existingMemories.length,
      hasMore,
      deadlineAt
    });
    let extractResult: Awaited<ReturnType<typeof extractDreamMemoriesFromMessages>> | undefined;
    if (modelResult.digest) {
      extractResult = await extractDreamMemoriesFromMessages(env, {
        namespace: input.namespace,
        messages: extractMessages,
        speakers,
        dateLabel: input.dateLabel,
        decisionInstructions: isCurrentStateEnabled(env) ? DECISION_FORMAT : undefined,
        deadlineAt
      });
    }
    const invalidJson = modelResult.reason === "model_invalid_json" || extractResult?.reason === "model_invalid_json";
    if (invalidJson && messages.length > 1 && reductions < MAX_BATCH_REDUCTIONS && Date.now() < deadlineAt) {
      const nextSize = Math.max(1, Math.floor(messages.length / 2));
      console.warn("dream: retrying both stages on a smaller batch after invalid JSON", {
        date: input.dateLabel,
        phase: modelResult.digest ? "extract" : "digest",
        previousMessageCount: messages.length,
        nextMessageCount: nextSize
      });
      messages = messages.slice(0, nextSize);
      hasMore = true;
      reductions += 1;
      continue;
    }
    if (modelResult.digest && extractMessages.length !== messages.length) {
      const ids = new Set(extractMessages.map(message => message.id));
      const citesOnlyNew = (item: { source_message_ids?: string[] }) =>
        Boolean(item.source_message_ids?.length && item.source_message_ids.every(id => ids.has(id)));
      const digest = modelResult.digest;
      digest.memories_to_add = digest.memories_to_add?.filter(citesOnlyNew);
      digest.memories_to_update = digest.memories_to_update?.filter(citesOnlyNew);
      digest.memories_to_delete = digest.memories_to_delete?.filter(citesOnlyNew);
      digest.decisions = digest.decisions?.filter(citesOnlyNew);
    }
    if (modelResult.digest?.decisions) {
      modelResult.digest.decisions = isCurrentStateEnabled(env)
        ? modelResult.digest.decisions.flatMap(candidate => groundCandidate(candidate, extractMessages))
        : undefined;
    }
    const candidates = [...(modelResult.digest?.decisions ?? []), ...(extractResult?.memories ?? [])];
    if (modelResult.digest && extractResult && !extractResult.reason && isCurrentStateEnabled(env)) {
      candidates.push(...await extractDecisionFallback(env, { namespace: input.namespace, messages: extractMessages, candidates, deadlineAt }));
    }
    return {
      messages,
      hasMore,
      modelResult,
      extractedMemories: candidates,
      extractReason: extractResult?.reason,
      extractModel: extractResult?.model,
      extractStatus: extractResult?.status,
      extractFinishReason: extractResult?.finishReason
    };
  }
}

// Keep DailyDigestResult type re-export for local consumers if needed
export type { DailyDigestResult };
