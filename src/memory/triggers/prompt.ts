// Trigger 写入期 prompt (借鉴 T-Mem, EMNLP 2026)。
//
// 一条触发器只有两条合法路线，其余一律废弃：
//   路线 A 语义锚点：沿 is-a 阶梯往上一两级的名词短语，是这条记忆自己的语义被泛化。
//   路线 B 强关联场景：提到这个场景/道具/情境时，这条记忆大概率该被想起来。
//
// 三类废品必须挡掉，它们是这套方法失效的主要原因：
//   复述     —— 把记忆换个说法压成几个词，检索上等于没加东西。
//   过泛标签 —— 什么都套得上，召回时把一堆无关记忆一起拽进来。
//   弱关联场景 —— 场景能挂在很多条记忆上，提到它并不指向这一条。
//
// bridge 不是注释，它自己也进检索 (三视图之一)。所以要求它写成
// 「<记忆里的线索> -> <一步推理>」，而不是给触发器贴个类型标签。

export interface TriggerDraft {
  concept: string;
  bridge: string;
  confidence: number;
}

const CONCEPT_MIN_LEN = 2;
const CONCEPT_MAX_LEN = 40;
const BRIDGE_MAX_LEN = 60;

export function buildTriggerPrompt(input: {
  content: string;
  occurredAt?: string | null;
  count: number;
}): string {
  const when = input.occurredAt ? `\nTime: ${input.occurredAt}` : "";
  return [
    `Generate ${input.count} recall triggers for the memory below. Write each trigger in the same language as the memory, as a concise 2-6 word noun phrase.`,
    "",
    "## Memory",
    `Content: ${input.content}${when}`,
    "",
    "## Two valid paths (every trigger must follow exactly one)",
    "",
    "A. Semantic anchor: a slightly broader concept naming what this memory is about (1-2 levels more general).",
    "B. Strong-cue scenario: a concrete situation, setting, or decision point where mentioning it should immediately bring this memory to mind.",
    "   Only strong, specific associations count; tangential mentions do not.",
    "",
    "## Three invalid patterns to reject",
    "",
    "Restatement: compressing the memory's own words into a short phrase (adds no retrieval lift).",
    "Overly broad label: fits almost anything and loses the memory's specificity.",
    "Weak scenario: a generic context that could match dozens of unrelated memories.",
    "",
    "## Example",
    "",
    "Memory: \"He broke out in hives after eating shrimp at a group dinner.\"",
    "",
    "Path A valid: seafood intolerance / food allergy / allergic reaction",
    "Path B valid: seafood buffet / ordering at a sushi restaurant",
    "Invalid: shrimp allergy (restatement), health issue (too broad), carrying an EpiPen (fits any allergy, weak cue)",
    "",
    "## bridge field",
    "",
    "Attach a short bridge explaining why each trigger is valid.",
    "Format: <clue from the memory> -> <one-step inference>.",
    "The clue must come from the memory's own wording; the inference must be a real single step (categorization, causality, or why this memory matters in that situation).",
    "Do not restate the trigger itself or include labels like \"semantic anchor\".",
    "",
    "Valid: seafood intolerance -> bridge: shrimp is seafood; hives after eating indicate intolerance",
    "Valid: ordering at a sushi restaurant -> bridge: choosing dishes is the decision point where a shrimp allergy matters",
    "",
    "## confidence",
    "",
    "How reliably a listener who knows this person would recall this memory upon hearing the trigger. Score each honestly.",
    "",
    "0.8-1.0: tight mid-level anchor, or a scenario that almost certainly evokes this memory.",
    "0.5-0.8: clear broader anchor, or a strong though not guaranteed scenario.",
    "0.3-0.5: wider category or moderately associated scenario.",
    "Below 0.3: very broad category or weak cue — omit unless nothing better exists.",
    "",
    "## Output",
    "",
    "Output valid JSON only, with no markdown fences and no commentary.",
    '{"triggers":[{"concept":"2-6 words","bridge":"<clue> -> <inference>","confidence":0.0}]}'
  ].join("\n");
}

function isCleanConcept(concept: string): boolean {
  if (concept.length < CONCEPT_MIN_LEN || concept.length > CONCEPT_MAX_LEN) return false;
  // 模型偶尔把整句塞进 concept；带句末标点的一律当没遵守长度约束。
  if (/[。！？；.!?;]/.test(concept)) return false;
  return true;
}

// 复述闸：concept 和记忆正文高度重合时判为复述。
// 字符级包含是最便宜也最准的判据——「虾过敏」对「吃了虾之后起了荨麻疹」不成立包含，
// 所以这里只挡最直白的那一类，剩下的交给 prompt 和 confidence。
function isRestatement(concept: string, content: string): boolean {
  const c = concept.replace(/\s+/g, "");
  if (!c) return true;
  const body = content.replace(/\s+/g, "");
  return body.includes(c) && c.length >= Math.min(8, body.length);
}

export function parseTriggerResponse(
  raw: string,
  input: { content: string; minConfidence: number }
): TriggerDraft[] {
  let parsed: unknown;
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const list = (parsed as { triggers?: unknown }).triggers;
  if (!Array.isArray(list)) return [];

  const seen = new Set<string>();
  const out: TriggerDraft[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const concept = typeof rec.concept === "string" ? rec.concept.trim() : "";
    const bridge = typeof rec.bridge === "string" ? rec.bridge.trim() : "";
    const confidence = typeof rec.confidence === "number" ? rec.confidence : Number.NaN;
    if (!concept || !isCleanConcept(concept)) continue;
    if (!Number.isFinite(confidence) || confidence < input.minConfidence) continue;
    if (isRestatement(concept, input.content)) continue;
    const key = concept.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      concept,
      bridge: bridge.slice(0, BRIDGE_MAX_LEN),
      confidence: Math.min(Math.max(confidence, 0), 1)
    });
  }
  return out;
}
