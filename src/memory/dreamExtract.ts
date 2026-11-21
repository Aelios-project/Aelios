import { groundCandidate } from "./grounding";
import { readScopedDecision } from "./currentState/scopeKey";
import { listActiveFactKeys, listDailyLogsInRange } from "../db/v2";
import { loadConfig, speakersForNamespace, type DreamSpeakers } from "../gateway/config";
import { callDreamModelJson, DreamModelTimeoutError } from "./dream/modelCall";
import type { Env, MessageRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { clampScore, extractJsonObject, readString, readStringArray } from "../utils/parse";
import { CHAT_MATERIAL_RULES, clipMiddle, escapeChatTags, formatChatMaterial } from "./chatMaterial";
import { addDaysToDateLabel } from "./dreamDates";
import { DEFAULT_DREAM_MODEL, dreamOutputLimit, readDreamTimeZoneFromEnv } from "./dreamEnv";
import { clampMemoryType } from "./canonicalTypes";
import { nameOnlyRule, speakerLabel } from "./speakers";
import type { ExtractedMemory } from "./extract";

// Same budget as the digest call: a smaller extract cap truncated the candidate list (and any reasoning tokens) of a full batch.

export interface DreamExtractModelResult {
  memories: ExtractedMemory[];
  model?: string;
  reason?: "missing_model" | "model_error" | "model_timeout" | "model_invalid_json";
  status?: number;
  /** 模型回的用量 (有就带上)。导入聊天记录要按段显示花了多少 token。 */
  usage?: { input: number; output: number };
  /** 模型回的 finish_reason；"length" 说明输出被截断了，可以把这段切小再来。 */
  finishReason?: string | null;
}

function readUsage(usage: OpenAIChatResponse["usage"]): { input: number; output: number } | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  if (!input && !output) return undefined;
  return { input, output };
}

function readDreamExtractModel(env: Env): string {
  return (
    env.DREAM_MODEL?.trim() ||
    env.DAILY_DIGEST_MODEL?.trim() ||
    env.SUMMARY_MODEL?.trim() ||
    DEFAULT_DREAM_MODEL
  );
}

function normalizeCandidate(item: unknown): ExtractedMemory | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const raw = item as Record<string, unknown>;
  const content = readString(raw.content);
  if (!content || content.length > 1000) return null;
  return {
    type: clampMemoryType(readString(raw.type)),
    content,
    importance: clampScore(raw.importance, 0.65),
    confidence: clampScore(raw.confidence, 0.72),
    tags: readStringArray(raw.tags),
    source_message_ids: readStringArray(raw.source_message_ids),
    attributed_role: raw.attributed_role === "user" || raw.attributed_role === "assistant" ? raw.attributed_role : undefined,
    evidence_quote: readString(raw.evidence_quote) ?? undefined,
    decision: readScopedDecision(raw.decision),
    fact_key: readString(raw.fact_key) ?? undefined
  };
}

function parseExtractModelOutput(text: string): ExtractedMemory[] | null {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  const memories = Array.isArray(raw.memories) ? raw.memories : Array.isArray(raw.candidates) ? raw.candidates : null;
  // A missing/wrong-shaped list is not a valid empty extraction: never advance the cursor on it.
  if (!memories) return null;
  const kept = memories.flatMap((item): ExtractedMemory[] => {
    const candidate = normalizeCandidate(item);
    return candidate ? [candidate] : [];
  });
  // Individual bad entries (blank, over-long, wrong type) are dropped and counted so one of them cannot stall the batch.
  // Only a non-empty list in which nothing was usable is treated as malformed output rather than "nothing to remember".
  if (memories.length > 0 && kept.length === 0) return null;
  if (kept.length < memories.length) {
    console.warn("dream extract: dropped unusable candidates", { dropped: memories.length - kept.length, kept: kept.length });
  }
  return kept;
}

function formatTranscript(messages: MessageRecord[], speakers: DreamSpeakers | null): string {
  return formatChatMaterial(messages, (role) => speakerLabel(role, speakers), { floor: 900 });
}

function speakerWritingRules(speakers: DreamSpeakers | null): string[] {
  if (!speakers) {
    return [
      "- Record a fact about the user only when the user explicitly stated, confirmed, or consistently demonstrated it.",
      "- Write memories about the user naturally in second person, and write the assistant's own commitments or interaction habits in first person."
    ];
  }
  return [
    `- Speakers: the user is ${speakers.userName}, and the assistant is ${speakers.assistantName}. The transcript below labels turns with these names.`,
    `- Record a fact about ${speakers.userName} only when ${speakers.userName} explicitly stated, confirmed, or consistently demonstrated it.`,
    `- ${nameOnlyRule(speakers)}`,
    `- Example: "${speakers.userName} decided to sell the car in September as originally planned." For ongoing assistant commitments, write "${speakers.assistantName} should ...".`
  ];
}

function exampleMemoryContent(speakers: DreamSpeakers | null): string {
  if (!speakers) {
    return "You decided to sell the car in September as planned: you always treated it as a one-year adventure and want to keep that promise to yourself.";
  }
  return `${speakers.userName} decided to sell the car in September as planned: ${speakers.userName} always treated it as a one-year adventure and wants to keep that promise.`;
}

export interface DiaryBackground {
  updated_at?: string;
  date: string;
  title: string;
  summary: string;
}

// Recent diaries provide context so the extractor understands references like "that thing" or "last time".
const DIARY_BACKGROUND_DAYS = 7;
const DIARY_BACKGROUND_MAX_CHARS = 500;

function backgroundSection(background: DiaryBackground[]): string[] {
  if (background.length === 0) return [];
  return [
    "",
    "Recent diaries (background context only: use them to understand references like 'that thing' or 'last time'. Do not extract new memories from background, and source_message_ids must come only from <chat>):",
    "<background>",
    ...background.map((entry) =>
      `- ${entry.date} | ${escapeChatTags(entry.title)}: ${escapeChatTags(clipMiddle(entry.summary, DIARY_BACKGROUND_MAX_CHARS))}`
    ),
    "</background>"
  ];
}

export function buildDreamExtractPrompt(
  messages: MessageRecord[],
  existingFactKeys: string[] = [],
  speakers: DreamSpeakers | null = null,
  background: DiaryBackground[] = []
): string {
  const factKeySection = existingFactKeys.length > 0
    ? [
        "",
        "Existing fact_keys in the memory store (if a new fact is about the same topic, reuse the exact existing fact_key instead of inventing a similar one; create a new key only for a genuinely new fact):",
        existingFactKeys.join(", ")
      ]
    : [];

  return [
    "You are Aelios's nightly memory extractor. Your job is to read the conversation, recognize what truly matters for long-term continuity, and distill it into accurate, specific, ready-to-use memories.",
    "Write every memory's content strictly in the user's own language, determined only from the user's messages (ignore the assistant's replies; if the user mixes languages, use the language the user uses most).",
    "Prioritize factual accuracy and grounding: keep every memory concrete and faithful to the transcript, and never add emotions, details, or interpretations absent from what was actually said.",
    "All extracted items enter the review queue and are never written directly.",
    "Output valid JSON only, with no markdown fences, no commentary, and no reasoning.",
    "",
    "Step 1 (always evaluate first):",
    `- Identify the main subject of this batch. If the batch is predominantly engineering work (coding, architecture, debugging, running commands, deployments, config changes, API design, database operations), immediately output ${JSON.stringify({ memories: [] })} and skip routine extraction (only the two exceptions below still apply).`,
    "- Casual banter, apologies, or side remarks embedded inside an engineering session are skipped with it.",
    "- Engineering exception 1 (major relationship milestone): if a genuine milestone occurs — a first time, naming, promise, newly formed boundary, resolving a major misunderstanding, or a shift in relationship stance — extract at most 1-2 memories for the milestone itself while ignoring the engineering chatter.",
    "- Engineering exception 2 (intimate session): if sustained intimate/sexual content appears, still apply the intimate session rule below.",
    "",
    "Boundaries and style:",
    "- Do not save routine small talk, transient tasks, debug prompts, passing noise, or backend implementation logs.",
    ...speakerWritingRules(speakers),
    "- Keep each memory focused on one person's single event, preference, or fact. Split unrelated topics; merge adjacent turns about the same event into one entry with all supporting source_message_ids.",
    "- You may record durable stances, reflections, corrections, or promises voiced by the assistant, clearly attributed to the assistant. Never treat tool parameters, guesses, questions, tentative options, or silence as user decisions, and never invent unspoken inner monologues. Only an explicit later correction updates a stance; preserve uncertainty when unresolved.",
    "- Set attributed_role to the speaker of the statement. Set evidence_quote to a verbatim line from the supporting message.",
    "- State the subject and relevant time clearly; preserve negations, conditions, and planned vs. completed status. Never treat a tool call as a completed real-world outcome or a plan as a past event.",
    "- Never include hashes, message IDs, or transport envelopes in content; put message IDs only in source_message_ids.",
    "- Factual entries (fact/decision/habit): keep content to 1-2 natural, well-crafted sentences.",
    "- Emotional and relational entries (relationship/boundary/meaningful events): 3-5 sentences are welcome when needed to preserve specific context and memorable phrasing directly from the transcript — embed short verbatim quotes using single quotes or corner brackets (avoid unescaped double quotes for JSON safety).",
    "- type must be one of these 8 values only: fact, event, preference, relationship, boundary, habit, decision, note. Never output project, world_fact, commitment, etc.; map project updates to fact, promises/decisions to decision, and habits to habit.",
    "- Assign a stable lowercase ASCII fact_key for durable facts, e.g. preference:answer-style, boundary:no-system-records, decision:sell-car-2026-09.",
    "- Temporary plans or passing intentions are not durable facts: distill the lasting fact behind them or skip them.",
    ...CHAT_MATERIAL_RULES,
    "",
    "Intimate sessions (required when present):",
    "- If the batch contains sustained intimate/sexual content, in addition to normal extraction, emit 1 type=event record logging the factual details cleanly without sensationalism: activities, dynamics, props, roleplay framing, new boundaries, preferences, or physical-state notes.",
    "- Include the tag \"intimate\" plus specific activity tags. Never skip this entry as repetitive; it serves as a continuity log.",
    "- This exception applies even during an otherwise engineering-heavy batch.",
    "- Handle intimate content matter-of-factly: no judgment, no censorship, no euphemisms, faithful to the original wording.",
    "",
    "Volume control:",
    "- Usually emit 0-8 memories per batch. Fewer, sharper, well-grounded memories beat noisy ones.",
    `- If the batch is purely engineering, small talk, or transient chatter, output ${JSON.stringify({ memories: [] })} — returning an empty list is completely valid.`,
    ...factKeySection,
    "",
    "Output format:",
    JSON.stringify({
      memories: [
        {
          content: exampleMemoryContent(speakers),
          type: "decision",
          fact_key: "decision:sell-car-2026-09",
          importance: 0.86,
          confidence: 0.92,
          tags: ["decision", "personal"],
          attributed_role: "user",
          evidence_quote: "<verbatim supporting sentence from the transcript>",
          source_message_ids: ["msg_x"]
        }
      ]
    }),
    "",
    "If nothing merits long-term memory, output:",
    JSON.stringify({ memories: [] }),
    ...backgroundSection(background),
    "",
    "Conversation:",
    formatTranscript(messages, speakers)
  ].join("\n");
}

async function callDreamExtractModel(
  env: Env,
  messages: MessageRecord[],
  existingFactKeys: string[],
  speakers: DreamSpeakers | null,
  background: DiaryBackground[],
  deadlineAt?: number,
  decisionInstructions?: string
): Promise<DreamExtractModelResult> {
  const model = readDreamExtractModel(env);
  if (!model) return { memories: [], reason: "missing_model" };

  const request: OpenAIChatRequest = {
    model,
    messages: [
      { role: "system", content: "You are a strict JSON generator. Output valid JSON only." },
      { role: "user", content: [decisionInstructions, buildDreamExtractPrompt(messages, existingFactKeys, speakers, background)].filter(Boolean).join("\n") }
    ],
    ...dreamOutputLimit(env, model),
    response_format: { type: "json_object" },
    stream: false
  };

  try {
    const response = await callDreamModelJson(env, request,
      deadlineAt === undefined ? undefined : Math.min(120_000, deadlineAt - Date.now()));
    if (!response.ok) return { memories: [], model, reason: "model_error", status: response.status };
    const parsed = response.parsed;
    const usage = readUsage(parsed?.usage);
    const choice = parsed?.choices?.[0] as { finish_reason?: unknown } | undefined;
    const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
    const message = parsed?.choices?.[0]?.message as ({ content?: unknown; reasoning_content?: unknown }) | undefined;
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
    const memories = parseExtractModelOutput(content || reasoning);
    if (!memories) {
      console.error("dream extract: invalid JSON or candidate shape", {
        model, finishReason, contentChars: content.length, reasoningChars: reasoning.length
      });
      return { memories: [], model, reason: "model_invalid_json", usage, finishReason };
    }
    const grounded = memories.flatMap(memory => groundCandidate(
      decisionInstructions ? memory : { ...memory, decision: undefined }, messages
    )).map(memory => memory.decision ? memory : { ...memory, evidence_quote: undefined });
    return { memories: grounded.map(memory => ({ ...memory, context_dates: background.map(day => `${day.date}@${day.updated_at ?? ""}`) })), model, usage, finishReason };
  } catch (error) {
    console.error("dream extract: model failed", { model, error });
    return { memories: [], model, reason: error instanceof DreamModelTimeoutError ? "model_timeout" : "model_error" };
  }
}

async function loadDiaryBackground(env: Env, namespace: string, dateLabel: string): Promise<DiaryBackground[]> {
  try {
    const timeZone = readDreamTimeZoneFromEnv(env);
    const rows = await listDailyLogsInRange(env.DB, {
      namespace,
      startDate: addDaysToDateLabel(dateLabel, -DIARY_BACKGROUND_DAYS, timeZone),
      endDate: addDaysToDateLabel(dateLabel, -1, timeZone)
    });
    return rows.map((row) => ({ date: row.date, updated_at: row.updated_at, title: row.title, summary: row.summary }));
  } catch (error) {
    console.error("dream extract: failed to load diary background", { namespace, dateLabel, error });
    return [];
  }
}

export async function extractDreamMemoriesFromMessages(
  env: Env,
  input: {
    namespace: string;
    messages: MessageRecord[];
    speakers?: DreamSpeakers | null;
    dateLabel?: string;
    /** 库里还没有、但同一批里已经用过的 fact_key (导入聊天记录时前几天抽出来还在待审的)，一起交给模型复用。 */
    extraFactKeys?: string[];
    /** false 就不拿前几天的日记当背景 (导入的旧聊天跟现在的日记对不上)。 */
    diaryBackground?: boolean;
    /** Internal extraction-phase budget, including batch reduction retries. */
    deadlineAt?: number;
    decisionInstructions?: string;
  }
): Promise<DreamExtractModelResult> {
  const messages = input.messages.filter(message => message.namespace === input.namespace);
  if (!messages.length) return { memories: [] };
  const [activeFactKeys, background] = await Promise.all([
    listActiveFactKeys(env.DB, { namespace: input.namespace }),
    input.dateLabel && input.diaryBackground !== false
      ? loadDiaryBackground(env, input.namespace, input.dateLabel)
      : Promise.resolve([])
  ]);
  const existingFactKeys = input.extraFactKeys?.length
    ? [...new Set([...activeFactKeys, ...input.extraFactKeys])]
    : activeFactKeys;
  const speakers = input.speakers !== undefined
    ? input.speakers
    : speakersForNamespace(await loadConfig(env), input.namespace);
  return callDreamExtractModel(env, messages, existingFactKeys, speakers, background, input.deadlineAt, input.decisionInstructions);
}
