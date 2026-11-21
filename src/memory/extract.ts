import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MessageRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { extractJsonObject, readStringArray } from "../utils/parse";
import { sanitizeMemoryContent } from "../utils/sanitize";
import { dreamOutputLimit } from "./dreamEnv";

export interface ExtractedMemory {
  type: string;
  content: string;
  importance: number;
  confidence: number;
  tags: string[];
  source_message_ids: string[];
  context_dates?: string[];
  attributed_role?: "user" | "assistant";
  evidence_quote?: string;
  decision?: import("./currentState/scopeKey").ScopedDecision;
  fact_key?: string;  // v2: model can provide fact_key for upsert dedup
}

export interface MemoryExtractionResult {
  memories: ExtractedMemory[];
  summary_patch?: string;
}

function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : fallback;
}

function normalizeMemoryContent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = sanitizeMemoryContent(value);
  if (!text || text.length > 1000) return null;
  return text;
}

function parseExtraction(text: string): MemoryExtractionResult {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object") {
    return { memories: [] };
  }

  const raw = parsed as { memories?: unknown; summary_patch?: unknown };
  const memories = Array.isArray(raw.memories) ? raw.memories : [];

  return {
    summary_patch: typeof raw.summary_patch === "string" ? raw.summary_patch : undefined,
    memories: memories.flatMap((item): ExtractedMemory[] => {
      const stringContent = normalizeMemoryContent(item);
      if (stringContent) {
        return [
          {
            type: "note",
            content: stringContent,
            importance: 0.7,
            confidence: 0.8,
            tags: [],
            source_message_ids: []
          }
        ];
      }

      if (!item || typeof item !== "object") return [];
      const record = item as {
        type?: unknown;
        content?: unknown;
        importance?: unknown;
        confidence?: unknown;
        tags?: unknown;
        source_message_ids?: unknown;
        fact_key?: unknown;
      };

      const content = normalizeMemoryContent(record.content);
      if (!content) return [];

      return [
        {
          type: typeof record.type === "string" && record.type.trim() ? record.type.trim() : "note",
          content,
          importance: normalizeNumber(record.importance, 0.5),
          confidence: normalizeNumber(record.confidence, 0.8),
          tags: readStringArray(record.tags),
          source_message_ids: readStringArray(record.source_message_ids),
          fact_key: typeof record.fact_key === "string" && record.fact_key.trim() ? record.fact_key.trim() : undefined
        }
      ];
    })
  };
}

function buildExtractionPrompt(messages: MessageRecord[]): string {
  const transcript = messages
    .map((message) => {
      const role = message.role === "assistant" ? "Assistant" : "User";
      return `[${message.id}][${role}] ${message.content}`;
    })
    .join("\n\n");

  return [
    "You are a thoughtful long-term memory curator. Extract information worth remembering from the conversation below.",
    "Write from the assistant's perspective for your future self, strictly in the user's own language (determined only from the user's messages, ignoring assistant replies; if the user mixes languages, use the language the user uses most).",
    "Prioritize factual accuracy and specificity: ground every memory in what was actually said, and never add emotions, details, or interpretations absent from the transcript.",
    "Output valid JSON only, with no markdown fences and no commentary.",
    "",
    "Role attribution (critical):",
    "- [User] is the person talking with you.",
    "- [Assistant] is what you yourself said.",
    "- Never misattribute the assistant's words as the user's preferences, identity, experiences, or promises.",
    "- Record facts about the user only when explicitly stated, confirmed, or consistently shown by the user.",
    "- For promises, interaction habits, or boundaries the assistant should uphold, write in first person (e.g. 'I promised...', 'I should...').",
    "",
    "Writing style:",
    "- Avoid stiff labels like 'the user' or 'the assistant'.",
    "- Write memories about the user naturally in second person, and assistant commitments in first person.",
    "- Avoid third-person report phrasing like 'The user stated...' or 'The assistant should...'.",
    "- Make every content entry an accurate, specific, self-contained sentence grounded in the transcript and ready for future conversations.",
    "- Assign a lowercase ASCII fact_key for stable facts (e.g. project:aelios, preference:answer-style, boundary:no-system-records). Omit only when temporary or uncategorizable.",
    "",
    "Do not save:",
    "- Routine small talk or filler words",
    "- Duplicates or unsupported guesses",
    "- One-off prompt style tweaks",
    "- Internal implementation details (memory store, debug tags, D1, Vectorize, RAG, prompt blocks)",
    "",
    "Prioritize:",
    "- Durable user preferences, ongoing projects/plans, meaningful events, promises, boundaries, relationship milestones, and recurring habits.",
    "",
    "Output format:",
    JSON.stringify({
      memories: [
        {
          type: "project",
          content: "You are building a Cloudflare Worker memory proxy.",
          importance: 0.86,
          confidence: 0.94,
          tags: ["project", "cloudflare"],
          fact_key: "project:cloudflare-memory-proxy",
          source_message_ids: ["msg_x"]
        },
        {
          type: "boundary",
          content: "I should avoid framing your personal preferences as system records.",
          importance: 0.82,
          confidence: 0.9,
          tags: ["boundary", "style"],
          source_message_ids: ["msg_y"]
        }
      ],
      summary_patch: "We talked about the memory proxy and how I should record long-term memories naturally."
    }),
    "",
    "Conversation:",
    transcript
  ].join("\n");
}

export async function extractMemoriesFromMessages(
  env: Env,
  messages: MessageRecord[]
): Promise<MemoryExtractionResult> {
  const model = env.DREAM_MODEL || env.DAILY_DIGEST_MODEL || env.SUMMARY_MODEL;
  if (!model || messages.length === 0) {
    return { memories: [] };
  }

  const request: OpenAIChatRequest = {
    model,
    messages: [
      {
        role: "system",
        content: "You are a strict JSON generator. Output valid JSON only."
      },
      {
        role: "user",
        content: buildExtractionPrompt(messages)
      }
    ],
    ...dreamOutputLimit(env, model),
    stream: false
  };

  const response = await callOpenAICompat(env, request);
  if (!response.ok) {
    return { memories: [] };
  }

  const parsed = (await response.json()) as OpenAIChatResponse;
  const message = parsed.choices?.[0]?.message as
    | ({ content?: unknown; reasoning_content?: unknown })
    | undefined;
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
  return parseExtraction(content || reasoning);
}
