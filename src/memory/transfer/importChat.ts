// 导入整份聊天记录：后台页面在浏览器里把文件认成消息、按天切段 (chatParse.ts)，一段一段送过来。
// 每段走跟夜里一样的抽取 (extractDreamMemoriesFromMessages)，抽出来的只进审核页「导入的」，不直接落库；
// 人点了才算数。clef 开着就顺手给每条打个分 (有依据 / 值得记)，只当参考，不替人定。
//
// 原话不进 messages 表：那张表 7 天后按 created_at 清掉，旧聊天的日期一进去就到期；
// 夜里的整理也按日期取 messages，旧聊天混进去会被当成那天的聊天再整理一遍。
// 所以只把候选引用到的那几句存进 imported_messages，id 用 imsg_ 开头，查出处时 getMessagesByIds 会去那里找。

import { ARCHIVE_MAX_MESSAGE_CHARS, archiveWriteStatements, type ArchiveMessage } from "../../db/chatArchive";
import {
  createImportCandidate,
  getImportChunk,
  type ImportBatchRow,
  listImportPendingFactKeys,
  type MemoryCandidateRow,
  recordImportChunk,
  saveImportedMessages
} from "../../db/v2";
import type { Env, MessageRecord } from "../../types";
import { sha256Hex } from "../../utils/hash";
import { nowIso } from "../../utils/time";
import { askClefAddScores, buildClefInput, isClefReviewOn } from "../clefJudge";
import { findSimilarActiveMemory } from "../dedupGate";
import { type DreamExtractModelResult, extractDreamMemoriesFromMessages } from "../dreamExtract";
import type { ExtractedMemory } from "../extract";
import type { DreamSpeakers } from "../speakers";

/** 一段最多多少条、多少字。页面按这个切，服务端再挡一道。 */
export const CHAT_CHUNK_MAX_MESSAGES = 80;
export const CHAT_CHUNK_MAX_CHARS = 40_000;
/** 页面默认的切法：比上限松一点，留给模型输出的余量。 */
export const CHAT_CHUNK_DEFAULT_MESSAGES = 60;
export const CHAT_CHUNK_DEFAULT_CHARS = 30_000;

export interface ChatChunkMessageInput {
  seq: number;
  role: "user" | "assistant";
  content: string;
  time: string | null;
  speaker: string | null;
  conversation?: string;
}

export interface ChatChunkInput {
  key: string;
  day: string | null;
  messages: ChatChunkMessageInput[];
}

export interface ChatChunkResult {
  key: string;
  status: "done" | "error" | "skipped";
  candidates: number;
  merged: number;
  duplicates: number;
  model_calls: number;
  tokens_in: number;
  tokens_out: number;
  /** 模型没回用量时按字数估的。 */
  tokens_estimated: boolean;
  clef_calls: number;
  error?: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 校验页面送来的一段；不对就返回原因。 */
export function validateChatChunk(value: unknown, archive = false): { chunk: ChatChunkInput } | { error: string } {
  if (!value || typeof value !== "object") return { error: "chunk must be an object" };
  const raw = value as Record<string, unknown>;
  const key = typeof raw.key === "string" ? raw.key.trim() : "";
  if (!key || key.length > 64) return { error: "chunk.key is required (max 64 chars)" };
  const day = typeof raw.day === "string" && DAY_RE.test(raw.day) ? raw.day : null;
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) return { error: "chunk.messages must be a non-empty array" };
  if (raw.messages.length > CHAT_CHUNK_MAX_MESSAGES) return { error: `a chunk holds at most ${CHAT_CHUNK_MAX_MESSAGES} messages` };
  const messages: ChatChunkMessageInput[] = [];
  const seen = new Set<number>();
  let chars = 0;
  for (const item of raw.messages) {
    if (!item || typeof item !== "object") return { error: "each message must be an object" };
    const message = item as Record<string, unknown>;
    const seq = typeof message.seq === "number" && Number.isSafeInteger(message.seq) && message.seq >= 0 ? message.seq : null;
    if (seq === null) return { error: "message.seq must be a non-negative integer" };
    if (seen.has(seq)) return { error: "message.seq must be unique within a chunk" };
    seen.add(seq);
    if (message.role !== "user" && message.role !== "assistant") return { error: "message.role must be user or assistant" };
    const content = typeof message.content === "string" ? message.content : "";
    if (!content.trim()) continue;
    let time: string | null = null;
    if (typeof message.time === "string" && message.time) {
      const parsed = new Date(message.time);
      if (!Number.isNaN(parsed.getTime())) time = parsed.toISOString();
    }
    const speaker = typeof message.speaker === "string" ? message.speaker.slice(0, 64) : null;
    const conversation = message.conversation;
    if (archive && conversation !== undefined && (typeof conversation !== "string" || !conversation.trim() || conversation.length > 128)) {
      return { error: "message.conversation must be a non-empty string of at most 128 characters" };
    }
    chars += content.length;
    messages.push({ seq, role: message.role, content, time, speaker,
      ...(archive && typeof conversation === "string" ? { conversation } : {}) });
  }
  if (messages.length === 0) return { error: "chunk has no text messages" };
  const maxChars = archive && messages.length === 1 ? ARCHIVE_MAX_MESSAGE_CHARS : CHAT_CHUNK_MAX_CHARS;
  if (chars > maxChars) return { error: `a chunk holds at most ${maxChars} characters` };
  return { chunk: { key, day, messages } };
}

/** 原话的 id：同一批、同一段、同一个序号永远是同一个 id，重跑这段不会多存一份。带上段名，别的客户端每段从 0 编号也不会撞。 */
export async function importedMessageId(importId: string, chunkKey: string, seq: number): Promise<string> {
  const hash = await sha256Hex(`${importId}:${chunkKey}:${seq}`);
  return `imsg_${hash.slice(0, 32)}`;
}

export async function archiveChatChunk(db: D1Database, batch: ImportBatchRow, chunk: ChatChunkInput) {
  const base = { key: chunk.key, messages: chunk.messages.length };
  const existing = await getImportChunk(db, { importId: batch.id, key: chunk.key });
  if (existing?.status === "done") return { ...base, status: "skipped" };

  const records = await Promise.all(chunk.messages.map(async (message): Promise<ArchiveMessage> => ({
    id: await importedMessageId(batch.id, chunk.key, message.seq),
    conversation_id: `import:${batch.id}:${message.conversation ?? "0"}`,
    role: message.role,
    content: message.content,
    source: `import:${batch.id}`,
    speaker: message.speaker,
    created_at: message.time ?? chunk.day ?? "",
    position: message.seq
  })));
  const now = nowIso();
  const results = await db.batch([
    db.prepare(`INSERT INTO memory_import_chunks (import_id, chunk_key, status, messages, chars, updated_at)
      VALUES (?, ?, 'done', ?, ?, ?) ON CONFLICT(import_id, chunk_key) DO NOTHING`)
      .bind(batch.id, chunk.key, records.length, records.reduce((sum, row) => sum + row.content.length, 0), now),
    // The prior INSERT and increment run in one transaction. Concurrent retries count only once.
    db.prepare("UPDATE memory_imports SET done_chunks = done_chunks + 1, updated_at = ? WHERE id = ? AND changes() = 1")
      .bind(now, batch.id),
    ...await archiveWriteStatements(db, batch.namespace, records, true)
  ]);
  return { ...base, status: results[0]?.meta.changes ? "done" : "skipped" };
}

function toMessageRecords(
  namespace: string,
  importId: string,
  chunk: ChatChunkInput,
  ids: string[]
): MessageRecord[] {
  return chunk.messages.map((message, index) => ({
    id: ids[index],
    conversation_id: `import:${importId}`,
    namespace,
    role: message.role,
    content: message.content,
    source: `import:${importId}`,
    // 抽取材料里每句前面会带时间；只知道哪天就写那天，啥都不知道就空着。
    created_at: message.time ?? chunk.day ?? "",
    seq: message.seq
  }));
}

/** 模型回的用量；没回就按字数粗估 (中文大约一字一个 token 多一点)，页面上显示成「约」。 */
function usageOf(result: DreamExtractModelResult, promptChars: number): { input: number; output: number; estimated: boolean } {
  if (result.usage) return { ...result.usage, estimated: false };
  return { input: Math.ceil(promptChars * 1.1) + 2500, output: 300, estimated: true };
}

/**
 * 抽一段。模型回的 JSON 坏了 (多半是输出被截断) 时把这段对半切再各抽一次，只切一层。
 */
async function extractChunk(
  env: Env,
  input: { namespace: string; records: MessageRecord[]; speakers: DreamSpeakers | null; day: string | null; extraFactKeys: string[] }
): Promise<{
  memories: ExtractedMemory[];
  calls: number;
  tokensIn: number;
  tokensOut: number;
  estimated: boolean;
  error: string | null;
}> {
  const run = async (records: MessageRecord[]) => {
    const result = await extractDreamMemoriesFromMessages(env, {
      namespace: input.namespace,
      messages: records,
      speakers: input.speakers,
      dateLabel: input.day ?? undefined,
      extraFactKeys: input.extraFactKeys,
      diaryBackground: false
    });
    const chars = records.reduce((sum, record) => sum + record.content.length, 0);
    return { result, usage: usageOf(result, chars) };
  };

  const first = await run(input.records);
  let calls = 1;
  let tokensIn = first.usage.input;
  let tokensOut = first.usage.output;
  let estimated = first.usage.estimated;
  // 回的 JSON 不完整多半是一段太长、输出被截了 (Workers AI 的外壳不报 finish_reason，看不出来)，切小再来一次。
  const broken = first.result.reason === "model_invalid_json";
  if (!broken || input.records.length < 2) {
    const error = first.result.reason ? `${first.result.reason}${first.result.status ? ` (${first.result.status})` : ""}` : null;
    return { memories: first.result.memories, calls, tokensIn, tokensOut, estimated, error };
  }

  const half = Math.ceil(input.records.length / 2);
  const memories: ExtractedMemory[] = [];
  let error: string | null = null;
  for (const part of [input.records.slice(0, half), input.records.slice(half)]) {
    const next = await run(part);
    calls += 1;
    tokensIn += next.usage.input;
    tokensOut += next.usage.output;
    estimated = estimated || next.usage.estimated;
    if (next.result.reason) error = next.result.reason;
    memories.push(...next.result.memories);
  }
  return { memories, calls, tokensIn, tokensOut, estimated, error: memories.length > 0 ? null : error };
}

/**
 * 处理一段。同一段已经做完就跳过 (断了接着做时页面会重送)，force 才重做。
 */
export async function importChatChunk(
  env: Env,
  input: {
    namespace: string;
    batch: ImportBatchRow;
    chunk: ChatChunkInput;
    speakers: DreamSpeakers | null;
    /** 用 clef 给候选打分；不传就看 CLEF_AUTO_REVIEW 开没开、有没有 AI 绑定。 */
    clef?: boolean;
    force?: boolean;
  }
): Promise<ChatChunkResult> {
  const { namespace, batch, chunk } = input;
  const base: ChatChunkResult = {
    key: chunk.key,
    status: "done",
    candidates: 0,
    merged: 0,
    duplicates: 0,
    model_calls: 0,
    tokens_in: 0,
    tokens_out: 0,
    tokens_estimated: false,
    clef_calls: 0
  };

  if (!input.force) {
    const done = await getImportChunk(env.DB, { importId: batch.id, key: chunk.key });
    if (done?.status === "done") {
      return { ...base, status: "skipped", candidates: done.candidates, model_calls: 0 };
    }
  }

  const ids = await Promise.all(chunk.messages.map((message) => importedMessageId(batch.id, chunk.key, message.seq)));
  const records = toMessageRecords(namespace, batch.id, chunk, ids);
  const chars = chunk.messages.reduce((sum, message) => sum + message.content.length, 0);
  const extraFactKeys = await listImportPendingFactKeys(env.DB, { namespace, importId: batch.id });

  const extracted = await extractChunk(env, { namespace, records, speakers: input.speakers, day: chunk.day, extraFactKeys });
  const result: ChatChunkResult = {
    ...base,
    model_calls: extracted.calls,
    tokens_in: extracted.tokensIn,
    tokens_out: extracted.tokensOut,
    tokens_estimated: extracted.estimated
  };

  if (extracted.error && extracted.memories.length === 0) {
    await recordImportChunk(env.DB, {
      importId: batch.id,
      key: chunk.key,
      status: "error",
      messages: records.length,
      chars,
      modelCalls: extracted.calls,
      tokensIn: extracted.tokensIn,
      tokensOut: extracted.tokensOut,
      error: extracted.error
    });
    return { ...result, status: "error", error: extracted.error };
  }

  const useClef = (input.clef ?? isClefReviewOn(env)) && Boolean(env.AI);
  const chunkIds = new Set(ids);
  const recordById = new Map(records.map((record) => [record.id, record]));
  const cited = new Set<string>();

  type Planned = {
    memory: ExtractedMemory;
    sources: string[];
    targetId: string | null;
    targetContent: string | null;
    note: string | null;
  };

  // 抽完以后哪一步出错 (D1 抖了、子请求超了)：这段记成失败，花掉的 token 照记，下次重跑这段。
  // 已经排进去的候选留着；重跑时同 fact_key、同正文的会并进去。
  try {
    const planned: Planned[] = [];
    for (const memory of extracted.memories) {
      // 出处只认这一段里的消息；模型没标或者标错了，就整段都挂上，审核时至少看得到原文。
      const own = memory.source_message_ids.filter((id) => chunkIds.has(id));
      const sources = own.length > 0 ? own : ids;
      const hit = await findSimilarActiveMemory(env, { namespace, content: memory.content });
      if (hit && hit.memory.content.trim() === memory.content.trim()) {
        result.duplicates += 1;
        continue;
      }
      planned.push({
        memory,
        sources,
        targetId: hit?.memory.id ?? null,
        targetContent: hit?.memory.content ?? null,
        note: hit ? `import: similar to ${hit.memory.id} (score=${hit.score.toFixed(2)})` : null
      });
      for (const id of sources) cited.add(id);
    }

    // 先存原话再建候选：候选建好了原话没存上，审核页就看不到出处。
    await saveImportedMessages(
      env.DB,
      chunk.messages.flatMap((message, index) =>
        cited.has(ids[index])
          ? [
              {
                id: ids[index],
                namespace,
                importId: batch.id,
                role: message.role,
                content: message.content,
                speaker: message.speaker,
                createdAt: message.time,
                day: chunk.day,
                seq: message.seq
              }
            ]
          : []
      )
    );

    for (const item of planned) {
      let scores: { grounded: number; worth: number } | null = null;
      if (useClef) {
        try {
          const kind = item.targetId ? "update" : "add";
          const shell = {
            type: item.memory.type,
            content: item.memory.content,
            fact_key: item.memory.fact_key ?? null
          } as MemoryCandidateRow;
          const messages = item.sources.flatMap((id) => {
            const record = recordById.get(id);
            return record ? [record] : [];
          });
          result.clef_calls += 1;
          scores = await askClefAddScores(env, buildClefInput(kind, shell, messages, input.speakers, item.targetContent));
        } catch (error) {
          console.warn("memory import: clef failed", { namespace, key: chunk.key, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const { merged } = await createImportCandidate(env.DB, {
        namespace,
        importId: batch.id,
        source: "import_chat",
        type: item.memory.type,
        content: item.memory.content,
        factKey: item.memory.fact_key ?? null,
        confidence: item.memory.confidence,
        importance: item.memory.importance,
        tags: item.memory.tags,
        sourceMessageIds: item.sources,
        targetMemoryId: item.targetId,
        decisionNote: item.note,
        day: chunk.day,
        clefGrounded: scores?.grounded ?? null,
        clefWorth: scores?.worth ?? null
      });
      if (merged) result.merged += 1;
      else result.candidates += 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("memory import: chunk failed after extraction", { namespace, key: chunk.key, error: message });
    await recordImportChunk(env.DB, {
      importId: batch.id,
      key: chunk.key,
      status: "error",
      messages: records.length,
      chars,
      candidates: result.candidates,
      modelCalls: extracted.calls,
      tokensIn: extracted.tokensIn,
      tokensOut: extracted.tokensOut,
      clefCalls: result.clef_calls,
      error: message
    });
    return { ...result, status: "error", error: message };
  }

  await recordImportChunk(env.DB, {
    importId: batch.id,
    key: chunk.key,
    status: "done",
    messages: records.length,
    chars,
    candidates: result.candidates,
    modelCalls: extracted.calls,
    tokensIn: extracted.tokensIn,
    tokensOut: extracted.tokensOut,
    clefCalls: result.clef_calls
  });
  return result;
}
