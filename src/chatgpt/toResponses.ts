// A client's request, reshaped for ChatGPT plan usage. Contract snapshot: 2026-10-25.
// https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
//   - store:false and stream:true on every HTTP request; the whole history goes in `input`.
//   - system text goes in `instructions` or developer messages; a {role:"system"} item is rejected.
//   - the fields in UNSUPPORTED_FIELDS and the hosted tools in UNSUPPORTED_TOOLS are not accepted.
// The chat and messages mappings were cross-checked against QuantumNous/new-api's relaykit (chat / Claude <->
// responses), which agrees on instructions, function_call / function_call_output pairing, tool_choice, image and
// document sources. One deliberate difference: Responses treats function tools as strict unless told otherwise and
// the other two do not, so `strict` is always written out.
import { object, type Protocol } from "../gateway/config";
import type { Body } from "../gateway/protocol";
import { RequestContractError } from "../gateway/request";

export const UNSUPPORTED_FIELDS = [
  "background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt",
  "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user",
  // Not in the documented list, but a service tier override is named as unsupported, and stream options are
  // a Chat Completions detail the caller handles itself.
  "service_tier", "stream_options"
];
export const UNSUPPORTED_TOOLS = new Set([
  "image_generation", "file_search", "code_interpreter", "computer", "computer_use", "computer_use_preview", "mcp", "tool_search"
]);
/** Chat fields with nothing to map to; dropped, and named in the normalization report. */
const CHAT_DROPPED = [
  "temperature", "top_p", "max_tokens", "max_completion_tokens", "stop", "seed", "presence_penalty", "frequency_penalty",
  "logit_bias", "logprobs", "top_logprobs", "user", "metadata", "service_tier", "modalities", "audio", "prediction",
  "safety_identifier", "prompt_cache_retention", "web_search_options", "functions", "function_call"
];
/** The unsupported-capability retry may drop anything but these. */
export const REQUIRED_FIELDS = new Set(["model", "input", "stream", "store"]);

export interface Converted { body: Body; removed: string[] }

function refuseHostedTool(tool: Body, path: string): void {
  if (UNSUPPORTED_TOOLS.has(String(tool.type))) {
    throw new RequestContractError(path, `The "${tool.type}" tool is not available with ChatGPT plan usage (function tools and web search are).`);
  }
}

function cleanResponses(payload: Body, removed: string[]): Body {
  const out = structuredClone(payload);
  for (const field of UNSUPPORTED_FIELDS) {
    if (out[field] !== undefined) { delete out[field]; removed.push(field); }
  }
  // A client that sends `previous_response_id: null` means "no earlier response"; that is stateless already.
  if (out.previous_response_id === null) delete out.previous_response_id;
  if (out.previous_response_id !== undefined) {
    throw new RequestContractError("previous_response_id", "ChatGPT plan usage is stateless over HTTP; send the full history in input.");
  }
  if (typeof out.input === "string") out.input = [{ role: "user", content: out.input }];
  for (const [i, item] of (Array.isArray(out.input) ? out.input : []).entries()) {
    if (!object(item)) continue;
    if (item.type === "item_reference") {
      throw new RequestContractError(`input.${i}`, "ChatGPT plan usage is stateless over HTTP; item references cannot be resolved.");
    }
    if (item.role === "system") item.role = "developer";
  }
  for (const [i, tool] of (Array.isArray(out.tools) ? out.tools : []).entries()) if (object(tool)) refuseHostedTool(tool, `tools.${i}`);
  return out;
}

/** The visible text of a message body: a string, or the text / refusal parts of an array. */
function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (!object(part)) return "";
    if (typeof part.text === "string") return part.text;
    return typeof part.refusal === "string" ? part.refusal : "";
  }).filter(Boolean).join("\n");
}
function userContent(content: unknown, path: string): string | Body[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: Body[] = [];
  for (const [i, part] of content.entries()) {
    if (!object(part)) continue;
    const at = `${path}.${i}`;
    if (part.type === "text" || part.type === "input_text") {
      parts.push({ type: "input_text", text: typeof part.text === "string" ? part.text : "" });
    } else if (part.type === "image_url" || part.type === "input_image") {
      const source = part.image_url;
      const url = typeof source === "string" ? source : object(source) ? source.url : undefined;
      if (typeof url !== "string" || !url) throw new RequestContractError(at, "An image part needs a URL.");
      parts.push({ type: "input_image", image_url: url, detail: object(source) && typeof source.detail === "string" ? source.detail : "auto" });
    } else if (part.type === "file" || part.type === "input_file") {
      const file = object(part.file) ? part.file : part;
      parts.push({ type: "input_file",
        ...(typeof file.filename === "string" ? { filename: file.filename } : {}),
        ...(typeof file.file_data === "string" ? { file_data: file.file_data } : {}),
        ...(typeof file.file_id === "string" ? { file_id: file.file_id } : {}) });
    } else {
      throw new RequestContractError(at, `A "${part.type}" part is not supported with ChatGPT plan usage (text, images and files are).`);
    }
  }
  return parts;
}
function toolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  return plainText(content) || (content === undefined || content === null ? "" : JSON.stringify(content));
}

function chatToResponses(payload: Body, removed: string[]): Body {
  if (Number(payload.n) > 1) throw new RequestContractError("n", "ChatGPT plan usage answers with one choice; remove n or set it to 1.");
  const instructions: string[] = [];
  const input: Body[] = [];
  for (const [i, message] of (payload.messages as unknown[]).entries()) {
    if (!object(message)) continue;
    const role = message.role;
    if (role === "system" || role === "developer") {
      const text = plainText(message.content);
      if (text.trim()) instructions.push(text);
    } else if (role === "tool" || role === "function") {
      const output = toolOutput(message.content);
      input.push(typeof message.tool_call_id === "string" && message.tool_call_id
        ? { type: "function_call_output", call_id: message.tool_call_id, output }
        : { role: "user", content: `[tool output without a call id] ${output}` });
    } else if (role === "assistant") {
      const text = plainText(message.content);
      if (text) input.push({ role: "assistant", content: text });
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (!object(call) || (call.type && call.type !== "function") || !object(call.function)) continue;
        if (typeof call.id !== "string" || !call.id || typeof call.function.name !== "string" || !call.function.name) continue;
        input.push({ type: "function_call", call_id: call.id, name: call.function.name,
          arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}) });
      }
    } else {
      input.push({ role: "user", content: userContent(message.content, `messages.${i}.content`) });
    }
  }
  const out: Body = { input };
  if (instructions.length) out.instructions = instructions.join("\n\n");

  const tools: Body[] = [];
  for (const [i, tool] of (Array.isArray(payload.tools) ? payload.tools : []).entries()) {
    if (!object(tool)) continue;
    if (tool.type === "function" && object(tool.function)) {
      tools.push({ type: "function", name: tool.function.name, description: tool.function.description,
        parameters: tool.function.parameters ?? { type: "object", properties: {} }, strict: tool.function.strict === true });
    } else if (tool.type === "custom" && object(tool.custom)) {
      // Chat nests a custom tool's name and format under `custom`; Responses puts them on the tool.
      tools.push({ type: "custom", ...tool.custom });
    } else {
      refuseHostedTool(tool, `tools.${i}`);
      tools.push(tool);
    }
  }
  if (tools.length) out.tools = tools;

  const choice = payload.tool_choice;
  if (typeof choice === "string") out.tool_choice = choice;
  else if (object(choice) && choice.type === "function") {
    const name = object(choice.function) ? choice.function.name : choice.name;
    if (typeof name === "string" && name) out.tool_choice = { type: "function", name };
  } else if (object(choice) && choice.type === "allowed_tools") removed.push("tool_choice.allowed_tools");
  else if (object(choice)) out.tool_choice = choice;
  if (typeof payload.parallel_tool_calls === "boolean") out.parallel_tool_calls = payload.parallel_tool_calls;

  const format = payload.response_format;
  if (object(format) && format.type === "json_object") {
    out.text = { format: { type: "json_object" } };
    // JSON mode wants the word "JSON" among the input messages. A prompt that only says it in its system text
    // (which became `instructions`) would be refused, so say it once more where the check looks.
    if (!/json/i.test(JSON.stringify(input))) input.unshift({ role: "developer", content: "Respond with a single JSON object." });
  } else if (object(format) && format.type === "json_schema" && object(format.json_schema)) {
    const { name, schema, strict, description } = format.json_schema;
    out.text = { format: { type: "json_schema", name, schema, ...(strict !== undefined ? { strict } : {}),
      ...(description !== undefined ? { description } : {}) } };
  }
  if (typeof payload.verbosity === "string") out.text = { ...out.text, verbosity: payload.verbosity };
  if (typeof payload.reasoning_effort === "string") {
    out.reasoning = { effort: payload.reasoning_effort,
      ...(!["none", "minimal"].includes(payload.reasoning_effort) ? { summary: "auto" } : {}) };
  }
  if (typeof payload.prompt_cache_key === "string") out.prompt_cache_key = payload.prompt_cache_key;

  for (const field of CHAT_DROPPED) if (payload[field] !== undefined) removed.push(field);
  return out;
}


/** Anthropic dropped these (or they steer a model Anthropic runs, not this one); named in the normalization report. */
const MESSAGES_DROPPED = [
  "max_tokens", "temperature", "top_p", "top_k", "stop_sequences", "metadata", "service_tier", "container",
  "context_management", "inference_geo", "speed"
];
/** Anthropic's thinking budget, as the nearest reasoning effort. No budget means the model's own default. */
function effortForBudget(budget: unknown): string | undefined {
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) return undefined;
  return budget <= 4096 ? "low" : budget <= 16384 ? "medium" : "high";
}
function anthropicSource(source: unknown, path: string): { url?: string; text?: string } {
  if (!object(source)) throw new RequestContractError(path, "A source is required.");
  if (source.type === "url" && typeof source.url === "string") return { url: source.url };
  if (source.type === "base64" && typeof source.data === "string") {
    const media = typeof source.media_type === "string" ? source.media_type : "application/octet-stream";
    return { url: `data:${media};base64,${source.data}` };
  }
  if (source.type === "text" && typeof source.data === "string") return { text: source.data };
  if (source.type === "content" && Array.isArray(source.content)) return { text: plainText(source.content) };
  throw new RequestContractError(path, `A "${source.type}" source is not supported with ChatGPT plan usage (base64, url and text are).`);
}
function mediaPart(block: Body, path: string): Body | null {
  const source = anthropicSource(block.source, `${path}.source`);
  if (block.type === "image") {
    if (!source.url) throw new RequestContractError(path, "An image needs a base64 or url source.");
    return { type: "input_image", image_url: source.url, detail: "auto" };
  }
  if (source.text !== undefined) return source.text ? { type: "input_text", text: source.text } : null;
  const isData = source.url?.startsWith("data:");
  // Inline file data comes with a name in every example of the API, so one is always given.
  const media = isData ? /^data:([^;,]+)/.exec(source.url ?? "")?.[1] : undefined;
  const filename = typeof block.title === "string" && block.title ? block.title : media === "application/pdf" ? "document.pdf" : "document";
  return { type: "input_file", ...(isData ? { filename, file_data: source.url } : { file_url: source.url }) };
}
/**
 * OpenAI's strict mode wants every object closed (`additionalProperties: false`) with every property required.
 * Anthropic's structured outputs do not insist on the second part, so strict is asked for only when the schema
 * already fits; otherwise it is left off and the schema still guides the answer.
 */
function fitsStrict(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.every(fitsStrict);
  if (!object(schema)) return true;
  if (schema.type === "object" || object(schema.properties)) {
    const keys = object(schema.properties) ? Object.keys(schema.properties) : [];
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (schema.additionalProperties !== false || !keys.every(key => required.includes(key))) return false;
  }
  return Object.values(schema).every(value => typeof value !== "object" || value === null || fitsStrict(value));
}
/** A tool result is text, or a mix with images and documents; Responses takes either form. */
function resultOutput(content: unknown, path: string): string | Body[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content);
  const parts: Body[] = [];
  for (const [i, block] of content.entries()) {
    if (!object(block)) continue;
    if (block.type === "text") { if (typeof block.text === "string" && block.text) parts.push({ type: "input_text", text: block.text }); }
    else if (block.type === "image" || block.type === "document") {
      const part = mediaPart(block, `${path}.${i}`);
      if (part) parts.push(part);
    } else throw new RequestContractError(`${path}.${i}`, `A "${block.type}" block is not supported inside a tool result with ChatGPT plan usage.`);
  }
  return parts.every(part => part.type === "input_text") ? parts.map(part => part.text).join("\n") : parts;
}
function systemInstructions(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map(block => object(block) && block.type === "text" && typeof block.text === "string" ? block.text : "")
    .filter(Boolean).join("\n\n");
}

function messagesToResponses(payload: Body, removed: string[]): Body {
  if (payload.mcp_servers !== undefined && (!Array.isArray(payload.mcp_servers) || payload.mcp_servers.length)) {
    throw new RequestContractError("mcp_servers", "Hosted MCP servers are not available with ChatGPT plan usage.");
  }
  const input: Body[] = [];
  let thinkingDropped = false;
  for (const [i, message] of (payload.messages as unknown[]).entries()) {
    if (!object(message)) continue;
    // Anthropic has only user and assistant; a gateway-level system message mid-conversation is still an instruction.
    const role = message.role === "assistant" ? "assistant" : message.role === "system" ? "developer" : "user";
    if (typeof message.content === "string") {
      if (message.content) input.push({ role, content: message.content });
      continue;
    }
    let parts: Body[] = [];
    const flush = () => {
      if (!parts.length) return;
      input.push({ role, content: role === "assistant" ? parts.map(part => part.text).join("") : parts });
      parts = [];
    };
    for (const [j, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
      if (!object(block)) continue;
      const at = `messages.${i}.content.${j}`;
      if (block.type === "text") {
        if (typeof block.text === "string" && block.text) parts.push({ type: role === "assistant" ? "output_text" : "input_text", text: block.text });
      } else if (block.type === "image" || block.type === "document") {
        if (role === "assistant") throw new RequestContractError(at, `An assistant message cannot carry a "${block.type}" block.`);
        const part = mediaPart(block, at);
        if (part) parts.push(part);
      } else if (block.type === "tool_use") {
        flush();
        if (typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !block.name) continue;
        input.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      } else if (block.type === "tool_result") {
        flush();
        if (typeof block.tool_use_id !== "string" || !block.tool_use_id) continue;
        const output = resultOutput(block.content, `${at}.content`);
        // function_call_output has no error flag, so a failed call says so in its text.
        input.push({ type: "function_call_output", call_id: block.tool_use_id, output: block.is_error !== true ? output
          : typeof output === "string" ? `Error: ${output}` : [{ type: "input_text", text: "Error:" }, ...output] });
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        // Signed for Anthropic and meaningless to this model, so it cannot be replayed.
        if (!thinkingDropped) removed.push("thinking blocks");
        thinkingDropped = true;
      } else {
        throw new RequestContractError(at, `A "${block.type}" block is not supported with ChatGPT plan usage (text, images, documents, tool calls and results are).`);
      }
    }
    flush();
  }
  const out: Body = { input };
  const instructions = systemInstructions(payload.system);
  if (instructions.trim()) out.instructions = instructions;

  const tools: Body[] = [];
  for (const [i, tool] of (Array.isArray(payload.tools) ? payload.tools : []).entries()) {
    if (!object(tool)) continue;
    const type = typeof tool.type === "string" ? tool.type : "custom";
    if (type === "custom") {
      tools.push({ type: "function", name: tool.name, description: tool.description,
        parameters: tool.input_schema ?? { type: "object", properties: {} }, strict: tool.strict === true });
    } else if (type.startsWith("web_search")) {
      tools.push({ type: "web_search" });
    } else {
      throw new RequestContractError(`tools.${i}`, `The "${type}" tool is not available with ChatGPT plan usage (custom tools and web search are).`);
    }
  }
  if (tools.length) out.tools = tools;

  const choice = payload.tool_choice;
  if (object(choice)) {
    if (choice.type === "any") out.tool_choice = "required";
    else if (choice.type === "none") out.tool_choice = "none";
    else if (choice.type === "tool" && typeof choice.name === "string") out.tool_choice = { type: "function", name: choice.name };
    else if (choice.type === "auto") out.tool_choice = "auto";
    if (choice.disable_parallel_tool_use === true && choice.type !== "none") out.parallel_tool_calls = false;
  }

  const format = object(payload.output_config?.format) ? payload.output_config.format : payload.output_format;
  if (object(format) && format.type === "json_schema" && object(format.schema)) {
    out.text = { format: { type: "json_schema", name: "output", schema: format.schema, strict: fitsStrict(format.schema) } };
  }
  // Thinking on means the caller wants to see reasoning, so ask for its summary; a budget or effort steers how hard.
  const thinking = payload.thinking;
  const wantsThinking = object(thinking) && (thinking.type === "enabled" || thinking.type === "adaptive");
  const effort = payload.output_config?.effort;
  const level = typeof effort === "string" ? (effort === "max" || effort === "xhigh" ? "high" : effort) : undefined;
  const steered = level ?? (object(thinking) ? effortForBudget(thinking.budget_tokens) : undefined);
  if (wantsThinking || steered) out.reasoning = { ...(steered ? { effort: steered } : {}), ...(wantsThinking ? { summary: "auto" } : {}) };

  for (const field of MESSAGES_DROPPED) if (payload[field] !== undefined) removed.push(field);
  return out;
}

/** `payload` is already in the caller's protocol with memory appended; `slug` is the ChatGPT model name. */
export function toChatGptRequest(payload: Body, protocol: Protocol, slug: string): Converted {
  const removed: string[] = [];
  const body = protocol === "chat" ? chatToResponses(payload, removed)
    : protocol === "messages" ? messagesToResponses(payload, removed) : cleanResponses(payload, removed);
  // Chat clients such as Resident commonly omit effort to use the model's default.
  // Opt in to 6.2 summaries without overriding that default; explicit none/minimal stays unchanged.
  if (protocol === "chat" && /^gpt-6\.2(?:-|$)/.test(slug) && body.reasoning === undefined) {
    body.reasoning = { summary: "auto" };
  }
  // GPT-6.2 appends top-level instructions after input, outside cacheable prefixes.
  // Preserve reusable system guidance from translated protocols as a leading developer message.
  // Native Responses callers retain control over their own instructions and cache boundaries.
  // https://developers.openai.com/api/docs/guides/prompt-caching
  if (protocol !== "responses" && /^gpt-6\.2(?:-|$)/.test(slug) && typeof body.instructions === "string") {
    body.input.unshift({ role: "developer", content: body.instructions });
    delete body.instructions;
  }
  body.model = slug;
  body.store = false;
  body.stream = true;
  return { body, removed };
}
