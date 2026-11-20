import type { Env, MemoryApiRecord, MessageRecord, OpenAIChatRequest } from "../../types";
import { callDreamModelJson, DreamModelTimeoutError } from "./modelCall";
import { extractJsonObject } from "../../utils/parse";
import { CHAT_MATERIAL_RULES } from "../chatMaterial";
import { extractDreamMemoriesFromMessages } from "../dreamExtract";
import { readDreamMaxTokens, readDreamModel } from "../dreamEnv";
import type { ExtractedMemory } from "../extract";
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
}): string {
  const speakers = input.speakers ?? null;
  const speakerRule = speakers
    ? `- 站在第三人称写。关于用户用「${speakers.userName}……」；关于助手承诺用「${speakers.assistantName}需要……」。禁止出现 user、用户、assistant、助手，也不要用「你」「我」代替这两人。transcript 已用这两个名字标注角色。`
    : "- 站在“我=助手”的视角写。关于用户，用“你……”；关于助手承诺，用“我需要……”。";
  return [
    "你是 Aelios 的 nightly dream 记忆整理器。你的任务不是简单总结，而是在用户休息时整理长期记忆。",
    "你会读取旧长期记忆和当天聊天 transcript，产出一份更干净、更一致、更有用的 memory store 整理计划。",
    "只输出 JSON，不要 markdown，不要解释，不要输出思考过程。",
    "",
    "日记草稿用 source_message_ids 列出实际引用的原话 ID；没有引用时留空。",
    "Dream 目标：",
    "- 合并重复记忆，避免同一事实以多个版本长期存在。",
    "- 发现过时、被新信息否定、互相矛盾的旧记忆，并提出更新或删除建议（全部进入审核队列）。",
    "- 检查当天夜间抽取候选和旧记忆之间是否重复、过时或冲突。",
    "- 形成简洁的昨日日志，而不是保存流水账。",
    "",
    "窗口：",
    `- 你只能处理 ${input.dateLabel} 这一天窗口内的聊天。窗口是 ${input.startIso} 到 ${input.endIso}。`,
    input.hasMore ? "- 这是当天的一批聊天，不是完整一天；只整理这一批里明确出现的信息。" : "- 这是当天最后一批或完整批次。",
    "",
    "总原则：",
    "- 原始聊天不要逐条变成记忆，只保留未来真的会用到的事实、偏好、边界、项目进展、承诺。",
    "- 宁可少记，也不要把临时语气、寒暄、重复话、空内容、调试内容写进长期记忆。",
    "- 只有明确更正才取代旧立场。提问、备选、推测和沉默不算决定。矛盾未决时留待审核；写清谁说了什么。",
    "- 当新信息只是旧记忆的更准确版本，优先 memories_to_update，不要 memories_to_add。",
    "- 稳定事实的首次抽取由 dream 夜间管线负责，产物全部进审核队列；memories_to_add 默认给空数组。",
    "- 当多条旧记忆重复，保留更完整的一条并删除重复项；必要时先 update 保留项。",
    "- pinned=true 的旧记忆不能删除，只能在 memories_to_update 中提出更保守的补充。",
    "- 旧记忆里的临时计划/意图（例如“打算下个月充值X”）如果已经过期、已经发生、或被当天新信息取代，优先更新成持久事实或直接删除，不要让过期的打算一直躺在库里。",
    speakerRule,
    "- 不要提到 D1、Vectorize、RAG、数据库、记忆系统、代理层等实现细节。",
    ...CHAT_MATERIAL_RULES,
    "",
    "Dream 输出格式：",
    "- title 是 12 字以内标题。",
    "- summary 写成一段简短自然中文，描述这次 dream 整理出了什么。不要编造当天原文没有的具体情节。",
    "- sections 最多 3 段，每段有 heading 和 content；没有必要可以给空数组。",
    "- memories_to_add 保留兼容字段，v2 下默认输出空数组。",
    "- memories_to_update 只针对给出的旧记忆 id。",
    "- memories_to_update 里的 type 只能从这 8 个里选：fact、event、preference、relationship、boundary、habit、decision、note；项目进展归 fact，承诺/决定归 decision。绝不输出 project、world_fact 等其他值。",
    "- memories_to_delete 只删除空、重复、明显过期或被新信息否定的旧记忆。",
    "- 控制总输出长度，宁可少写也不要输出超长 JSON。",
    "",
    "输出 JSON 结构（尖括号里只说明该填什么，不是示例内容，不要照抄；title 和 summary 要写这一批原文实际发生的事）：",
    JSON.stringify({
      date: input.dateLabel,
      title: "<12 字以内标题>",
      summary: "<一段话：这一批聊了什么、这次整理实际做了什么；没有改动就如实写没有改动>",
      sections: [{ heading: "<小标题>", content: "<正文>" }],
      memories_to_add: [],
      memories_to_update: [
        {
          target_id: "mem_x",
          source_message_ids: ["<支持更正的消息 ID>"],
          content: "更新后的旧记忆正文",
          type: "fact",
          importance: 0.88,
          confidence: 0.9,
          tags: ["project"]
        }
      ],
      memories_to_delete: [{ target_id: "mem_y", source_message_ids: ["<支持归档的消息 ID>"], reason: "空内容或重复" }]
    }),
    "",
    "旧长期记忆候选：",
    formatExistingMemories(input.existingMemories),
    "",
    "今日原始聊天：",
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
      { role: "system", content: "你是严格的 JSON 生成器。你只输出 JSON，不要输出思考过程。" },
      { role: "user", content: prompt }
    ],
    max_tokens: readDreamMaxTokens(env),
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

  for (;;) {
    const prompt = buildDigestPrompt({
      dateLabel: input.dateLabel,
      startIso: input.startIso,
      endIso: input.endIso,
      messages,
      existingMemories: input.existingMemories,
      hasMore,
      speakers
    });
    const modelResult = await callDigestModel(env, prompt, {
      dateLabel: input.dateLabel,
      messageCount: messages.length,
      memoryCount: input.existingMemories.length,
      hasMore,
      deadlineAt
    });
    let extractResult: Awaited<ReturnType<typeof extractDreamMemoriesFromMessages>> | undefined;
    if (modelResult.digest) {
      extractResult = await extractDreamMemoriesFromMessages(env, {
        namespace: input.namespace,
        messages,
        speakers,
        dateLabel: input.dateLabel,
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
    return {
      messages,
      hasMore,
      modelResult,
      extractedMemories: extractResult?.memories ?? [],
      extractReason: extractResult?.reason,
      extractModel: extractResult?.model,
      extractStatus: extractResult?.status,
      extractFinishReason: extractResult?.finishReason
    };
  }
}

// Keep DailyDigestResult type re-export for local consumers if needed
export type { DailyDigestResult };
