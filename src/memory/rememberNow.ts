import { upsertMemoryByFactKey } from "../db/v2";
import type { Env } from "../types";
import { sha256Hex } from "../utils/hash";
import { upsertMemoryFts } from "./fts";

export type RememberKind = "save" | "probe" | "recollect";

export interface RememberParse {
  kind: RememberKind;
  content?: string;
}

const REMEMBER_RE = /^(?:请)?(?:帮我)?(?:记住|记一下)(?:一下)?[：:，,\s]*(.+)$/s;
const REMEMBER_EN_RE = /^(?:please\s+)?remember(?:\s+that)?[：:\s]+(.+)$/is;
const PROBE_RE =
  /^(?:你)?(?:还)?(?:请)?(?:帮我)?(?:记住了吗|记住了么|记住了没|记住了嘛|记得吗|记得了吗|记住了|did you remember|have you remembered)[\s?？!！.。]*$/i;
const RECOLLECT_RE =
  /^(?:please\s+)?remember\s+(?:when|how|if|what|who|why|whether|the time)\b/i;
const INSTRUCTION_TAIL_RE =
  /[。.!！；;]\s*(?:只(?:回复|回|说|答|回三个字)[^。.!！]*|(?:请)?只(?:用|回复|回|说)[^。.!！]*|不要[^。.!！]*|(?:only|just)\s+(?:reply|say|respond|answer|output)[^.!]*|do not\b[^.!]*|don't\b[^.!]*)\s*$/i;

function stripInstructionTail(content: string): string {
  let text = content.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i += 1) {
    const next = text.replace(INSTRUCTION_TAIL_RE, "").trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

export function classifyRememberUtterance(text: string): RememberParse | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (PROBE_RE.test(trimmed)) return { kind: "probe" };
  if (RECOLLECT_RE.test(trimmed)) return { kind: "recollect" };
  if (/[?？]\s*$/.test(trimmed)) return { kind: "probe" };

  for (const pattern of [REMEMBER_RE, REMEMBER_EN_RE]) {
    const match = trimmed.match(pattern);
    const raw = match?.[1]?.trim();
    if (!raw) continue;
    const content = stripInstructionTail(raw);
    if (content.length < 2) return { kind: "probe" };
    if (/^[吗么呢吧啊呀]+[?？!！.。]*$/.test(content)) return { kind: "probe" };
    return { kind: "save", content: content.slice(0, 2000) };
  }
  return null;
}

export function parseRememberNow(text: string): string | null {
  const parsed = classifyRememberUtterance(text);
  return parsed?.kind === "save" && parsed.content ? parsed.content : null;
}

export async function captureRememberNow(
  env: Env,
  input: { namespace: string; userText: string; messageId?: string }
): Promise<{ wrote: boolean; indexed?: boolean; id?: string; content?: string }> {
  const classified = classifyRememberUtterance(input.userText);
  if (classified?.kind !== "save" || !classified.content) return { wrote: false };

  const content = classified.content;
  // Idempotent on exact verbatim text only. Topic versioning is Dream's job.
  const factKey = `verbatim:${(await sha256Hex(content.toLowerCase())).slice(0, 24)}`;
  const result = await upsertMemoryByFactKey(env, {
    namespace: input.namespace,
    factKey,
    content,
    type: "note",
    importance: 0.78,
    confidence: 0.7,
    tags: ["remember_now", "verbatim"],
    source: "remember_now",
    provenance: { creation_mode: "user_explicit", attributed_actor: "user", recording_actor: "gateway",
      evidence_relation: "paraphrase", completeness: "partial", inputs: input.messageId ? [`message:${input.messageId}`] : [] },
    sourceMessageIds: input.messageId ? [input.messageId] : []
  });
  const indexed = await upsertMemoryFts(env.DB, {
    namespace: input.namespace,
    memoryId: result.id,
    content
  });
  return { wrote: true, indexed, id: result.id, content };
}
