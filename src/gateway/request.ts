import { object, type Protocol } from "./config";
import { lastCacheableBlock, validateBody, type Body } from "./protocol";

// Contract snapshot: 2026-09-07. Keep protocol envelopes separate from opaque
// application data (JSON Schema, tool arguments/results, encrypted reasoning).
// https://platform.claude.com/docs/en/api/messages/create
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
// https://developers.openai.com/api/reference/resources/responses/methods/create
const fields = (s: string) => new Set(s.split(/\s+/));
const TOP: Record<Protocol, Set<string>> = {
  messages: fields("model messages max_tokens system tools tool_choice thinking output_config output_format metadata stream stop_sequences temperature top_p top_k service_tier cache_control container mcp_servers context_management inference_geo speed"),
  chat: fields("model messages audio frequency_penalty function_call functions logit_bias logprobs max_completion_tokens max_tokens metadata modalities n parallel_tool_calls prediction presence_penalty prompt_cache_key prompt_cache_retention reasoning_effort response_format safety_identifier seed service_tier stop store stream stream_options temperature tool_choice tools top_logprobs top_p user verbosity web_search_options"),
  responses: fields("model input instructions background conversation include max_output_tokens max_tool_calls metadata parallel_tool_calls previous_response_id prompt prompt_cache_key prompt_cache_options prompt_cache_retention reasoning safety_identifier service_tier store stream stream_options temperature text tool_choice tools top_logprobs top_p truncation user context_management")
};
const BLOCKS: Record<string, Set<string>> = {
  text: fields("type text cache_control citations"),
  image: fields("type source cache_control transformations"),
  document: fields("type source cache_control citations context title"),
  search_result: fields("type content source title citations cache_control"),
  thinking: fields("type thinking signature"),
  redacted_thinking: fields("type data"),
  tool_use: fields("type id name input cache_control caller"),
  server_tool_use: fields("type id name input cache_control caller"),
  tool_result: fields("type tool_use_id content is_error cache_control"),
  container_upload: fields("type file_id cache_control"),
  compaction: fields("type content"),
  tool_reference: fields("type tool_name"),
  tool_addition: fields("type tool"),
  tool_removal: fields("type tool"),
  ...Object.fromEntries(["web_search_tool_result", "web_fetch_tool_result", "code_execution_tool_result",
    "bash_code_execution_tool_result", "text_editor_code_execution_tool_result", "tool_search_tool_result",
    "mcp_tool_result"].map(type => [type, fields("type tool_use_id content cache_control is_error")])),
  mcp_tool_use: fields("type id name input server_name")
};

export class RequestContractError extends Error {
  readonly status = 400;
  constructor(readonly path: string, detail: string) {
    super(`${path}: ${detail}`);
  }
}
function requireField(ok: unknown, path: string, detail: string): asserts ok {
  if (!ok) throw new RequestContractError(path, detail);
}
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Immutable, idempotent normalization. Report paths only, never field values. */
export function normalizeRequest(input: Body, protocol: Protocol): { body: Body; removed: string[] } {
  const body = structuredClone(input);
  const removed: string[] = [];
  function pick(value: unknown, allowed: Set<string>, path: string): void {
    if (!object(value)) return;
    for (const key of Object.keys(value)) if (!allowed.has(key)) {
      delete value[key]; removed.push(path ? `${path}.${key}` : key);
    }
  }
  const cache = (value: unknown, path: string) => pick(value, fields("type ttl"), path);
  function blocks(value: unknown, path: string): void {
    if (!Array.isArray(value)) return;
    value.forEach((block, i) => {
      if (!object(block)) return; // Validation reports malformed values.
      const at = `${path}.${i}`;
      const allowed = Object.hasOwn(BLOCKS, block.type) ? BLOCKS[block.type] : undefined;
      requireField(allowed, `${at}.type`, "Unsupported Anthropic content block; update the gateway contract before using this extension.");
      if (["thinking", "redacted_thinking", "compaction"].includes(block.type)) {
        // Never repair signed/encrypted history by deleting or rewriting fields.
        for (const key of Object.keys(block)) requireField(allowed.has(key), `${at}.${key}`, "Unexpected field on an opaque history block; replay the original block unchanged.");
      } else pick(block, allowed, at);
      cache(block.cache_control, `${at}.cache_control`);
      if (block.type === "tool_result" || block.type === "search_result") blocks(block.content, `${at}.content`);
      if (["image", "document"].includes(block.type) && object(block.source)) {
        pick(block.source, fields("type media_type data url file_id content"), `${at}.source`);
        if (block.source.type === "content") blocks(block.source.content, `${at}.source.content`);
      }
    });
  }
  pick(body, TOP[protocol], "");
  if (protocol !== "messages") return { body, removed };
  cache(body.cache_control, "cache_control");
  if (body.thinking !== undefined) requireField(object(body.thinking), "thinking", "Expected a thinking configuration object.");
  if (body.thinking?.block_binding !== undefined) requireField(object(body.thinking.block_binding), "thinking.block_binding", "Expected a binding configuration object.");
  pick(body.metadata, fields("user_id"), "metadata");
  pick(body.thinking, fields("type budget_tokens display block_binding"), "thinking");
  pick(body.thinking?.block_binding, fields("prefix_mismatch_behavior"), "thinking.block_binding");
  pick(body.output_config, fields("effort format"), "output_config");
  pick(body.output_config?.format, fields("type schema"), "output_config.format");
  pick(body.tool_choice, fields("type name disable_parallel_tool_use"), "tool_choice");
  blocks(body.system, "system");
  if (Array.isArray(body.messages)) body.messages.forEach((message: unknown, i: number) => {
    pick(message, fields("role content clear_at output_config"), `messages.${i}`);
    if (object(message)) blocks(message.content, `messages.${i}.content`);
  });
  if (Array.isArray(body.tools)) body.tools.forEach((tool: unknown, i: number) => {
    // Server tools have versioned, tool-specific schemas. Do not flatten them
    // into client tools or traverse their nested domain data.
    if (object(tool) && (!tool.type || tool.type === "custom")) {
      pick(tool, fields("type name description input_schema cache_control strict defer_loading allowed_callers input_examples eager_input_streaming"), `tools.${i}`);
    }
    if (object(tool)) cache(tool.cache_control, `tools.${i}.cache_control`);
  });
  return { body, removed };
}

/** Structural contract only: the upstream owns model capabilities and signatures. */
export function validateRequest(body: Body, protocol: Protocol, headers = new Headers()): void {
  validateBody(body, protocol);
  requireField(nonempty(body.model), "model", "Provide a nonempty model name.");
  if (body.stream !== undefined) requireField(typeof body.stream === "boolean", "stream", "Use true or false, not a string.");
  if (protocol !== "messages") return;
  requireField(Number.isInteger(body.max_tokens) && body.max_tokens >= 0, "max_tokens", "Anthropic requires a nonnegative integer (0 is cache warming).");
  requireField(body.messages.length > 0, "messages", "Provide at least one message.");
  for (const [field, max] of [["temperature", 1], ["top_p", 1], ["top_k", Number.POSITIVE_INFINITY]] as const) {
    if (body[field] !== undefined) requireField(typeof body[field] === "number" && body[field] >= 0 && body[field] <= max &&
      (field !== "top_k" || Number.isInteger(body[field])), field, `Expected a number between 0 and ${max}.`);
  }
  if (body.stop_sequences !== undefined) requireField(Array.isArray(body.stop_sequences) && body.stop_sequences.every((s: unknown) => typeof s === "string"), "stop_sequences", "Expected an array of strings.");
  let cacheCount = 0;
  let shortCacheSeen = false;
  function cache(value: unknown, path: string): void {
    if (value === undefined || value === null) return;
    requireField(object(value) && value.type === "ephemeral" && (value.ttl === undefined || ["5m", "1h"].includes(value.ttl)), path, 'Use {type:"ephemeral", ttl:"5m"|"1h"}.');
    requireField(!(value.ttl === "1h" && shortCacheSeen), path, "Place 1h cache breakpoints before 5m breakpoints.");
    shortCacheSeen ||= value.ttl !== "1h";
    cacheCount++;
    requireField(cacheCount <= 4, path, "Anthropic allows at most four cache breakpoints.");
  }
  function content(value: unknown, path: string, role: string): void {
    if (typeof value === "string") return;
    requireField(Array.isArray(value) && value.length > 0, path, "Expected text or a nonempty array of content blocks.");
    value.forEach((block, j) => {
      const at = `${path}.${j}`;
      requireField(object(block) && typeof block.type === "string" && Object.hasOwn(BLOCKS, block.type), at, "Expected a supported typed Anthropic content block.");
      if (role === "system") requireField(["text", "tool_addition", "tool_removal"].includes(block.type), `${at}.type`, "System content must be text or a supported tool change.");
      if (["tool_addition", "tool_removal"].includes(block.type)) {
        requireField(role === "system" && object(block.tool), at, "Tool changes require a system message and tool reference/definition.");
        requireField(headers.get("anthropic-beta")?.includes("mid-conversation-tool-changes-2026-07-01"), at, "Requires the mid-conversation-tool-changes-2026-07-01 beta.");
      }
      if (["thinking", "redacted_thinking", "tool_use", "server_tool_use"].includes(block.type)) requireField(role === "assistant", at, "This block belongs in an assistant message.");
      if (block.type === "text") requireField(nonempty(block.text), `${at}.text`, "Text blocks must contain nonempty text.");
      if (block.type === "thinking") requireField(typeof block.thinking === "string" && nonempty(block.signature), at, "Replay thinking and its signature exactly as returned; empty thinking text is valid.");
      if (block.type === "redacted_thinking") requireField(nonempty(block.data), `${at}.data`, "Replay the opaque redacted thinking data unchanged.");
      if (["tool_use", "server_tool_use"].includes(block.type)) requireField(nonempty(block.id) && nonempty(block.name) && object(block.input), at, "A tool call needs id, name and an input object.");
      if (block.type === "tool_result") {
        requireField(role === "user" && nonempty(block.tool_use_id), at, "A tool result belongs in a user message and needs tool_use_id.");
        if (block.is_error !== undefined) requireField(typeof block.is_error === "boolean", `${at}.is_error`, "Expected a boolean.");
        if (block.content !== undefined && !(Array.isArray(block.content) && !block.content.length)) content(block.content, `${at}.content`, "result");
      }
      if (["image", "document"].includes(block.type)) {
        const source = block.source;
        requireField(object(source), `${at}.source`, "Provide an image/document source object.");
        const types = block.type === "image" ? ["base64", "url", "file"] : ["base64", "url", "file", "text", "content"];
        requireField(types.includes(source.type), `${at}.source.type`, "Unsupported source type for this block.");
        if (["base64", "text"].includes(source.type)) requireField(nonempty(source.data) && nonempty(source.media_type), `${at}.source`, "Provide media_type and data.");
        if (source.type === "url") requireField(nonempty(source.url), `${at}.source.url`, "Provide a source URL.");
        if (source.type === "file") requireField(nonempty(source.file_id), `${at}.source.file_id`, "Provide a file ID.");
      }
      cache(block.cache_control, `${at}.cache_control`);
    });
  }
  if (body.tools !== undefined) {
    requireField(Array.isArray(body.tools), "tools", "Expected an array of tool definitions.");
    const names = new Set<string>();
    body.tools.forEach((tool: Body, i: number) => {
      const at = `tools.${i}`;
      requireField(object(tool) && nonempty(tool.name) && !names.has(tool.name), at, "Each tool needs a unique name.");
      names.add(tool.name);
      if (!tool.type || tool.type === "custom") requireField(object(tool.input_schema) && tool.input_schema.type === "object", `${at}.input_schema`, "Client tools require a JSON Schema with type: object.");
      cache(tool.cache_control, `${at}.cache_control`);
    });
  }
  if (body.system !== undefined) content(body.system, "system", "system");
  // Consecutive messages with the same role are one logical turn in Anthropic.
  // Validate the tool cycle on those groups without changing wire order.
  let groupRole = "";
  let pending = new Set<string>();
  let results = new Set<string>();
  let calls = new Set<string>();
  let ordinaryContent = false;
  const allCalls = new Set<string>();
  const finishGroup = (path: string) => {
    if (groupRole === "user") {
      requireField([...pending].every(id => results.has(id)), path, "Every tool_use needs a tool_result in the immediately following user turn.");
      pending = new Set();
    } else if (groupRole === "assistant") pending = calls;
  };
  body.messages.forEach((message: Body, i: number) => {
    const at = `messages.${i}`;
    requireField(["user", "assistant", "system"].includes(message.role), `${at}.role`, "Anthropic accepts user/assistant (or a supported mid-conversation system message), not OpenAI tool roles.");
    if (message.clear_at !== undefined) requireField(message.role === "system" && message.clear_at === "next_user_message" &&
      headers.get("anthropic-beta")?.includes("mid-conversation-system-clear-at-2026-08-21"), `${at}.clear_at`, "Use next_user_message on a system message with the mid-conversation-system-clear-at-2026-08-21 beta.");
    if (message.output_config !== undefined) requireField(message.role === "system" && object(message.output_config) &&
      ["low", "medium", "high", "xhigh", "max"].includes(message.output_config.effort) &&
      headers.get("anthropic-beta")?.includes("mid-conversation-output-config-2026-07-01"), `${at}.output_config`, "Per-message effort requires a system message and the mid-conversation-output-config-2026-07-01 beta.");
    if (message.role !== groupRole) {
      finishGroup(at);
      requireField(!pending.size || message.role === "user", at, "Tool results must immediately follow the assistant's tool calls.");
      groupRole = message.role; results = new Set(); calls = new Set(); ordinaryContent = false;
    }
    if (!(message.role === "system" && message.output_config && Array.isArray(message.content) && !message.content.length)) content(message.content, `${at}.content`, message.role);
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    for (const block of blocks) {
      if (block.type === "tool_use") {
        requireField(!allCalls.has(block.id), `${at}.content`, "Duplicate tool_use id.");
        allCalls.add(block.id); calls.add(block.id);
      } else if (block.type === "tool_result") {
        requireField(!ordinaryContent, `${at}.content`, "Put tool_result blocks before text or images in the user turn.");
        requireField(pending.has(block.tool_use_id) && !results.has(block.tool_use_id), `${at}.content`, "tool_use_id must match one unresolved call in the previous assistant turn.");
        results.add(block.tool_use_id);
      } else ordinaryContent = true;
    }
  });
  finishGroup("messages");
  requireField(!pending.size, "messages", "Supply tool_result blocks before requesting another assistant turn.");
  // Automatic caching shares the final explicit point when TTLs match.
  if (body.cache_control != null) {
    requireField(object(body.cache_control) && body.cache_control.type === "ephemeral" &&
      (body.cache_control.ttl === undefined || ["5m", "1h"].includes(body.cache_control.ttl)), "cache_control", "Use type: ephemeral and ttl: 5m or 1h.");
    const lastBlock = lastCacheableBlock(body);
    if (lastBlock?.cache_control) requireField((lastBlock.cache_control.ttl || "5m") === (body.cache_control.ttl || "5m"), "cache_control", "Automatic and final explicit cache TTLs must agree.");
    else cache(body.cache_control, "cache_control");
  }
  if (body.metadata != null) requireField(object(body.metadata) && (body.metadata.user_id == null || typeof body.metadata.user_id === "string"), "metadata.user_id", "Expected a string.");
  if (body.output_config != null) {
    requireField(object(body.output_config), "output_config", "Expected an object.");
    const { effort, format } = body.output_config;
    if (effort != null) requireField(["low", "medium", "high", "xhigh", "max"].includes(effort), "output_config.effort", "Unsupported effort level.");
    if (format != null) requireField(object(format) && format.type === "json_schema" && object(format.schema), "output_config.format", "Provide type: json_schema and a schema object.");
  }
  if (body.thinking !== undefined) {
    const t = body.thinking;
    requireField(object(t) && ["enabled", "adaptive", "disabled"].includes(t.type), "thinking.type", "Use enabled, adaptive or disabled.");
    if (t.type === "enabled") requireField(Number.isInteger(t.budget_tokens) && t.budget_tokens >= 1024 &&
      (t.budget_tokens < body.max_tokens || headers.get("anthropic-beta")?.includes("interleaved-thinking")), "thinking.budget_tokens", "Enabled thinking needs at least 1024 tokens and a budget below max_tokens (except supported interleaved thinking).");
    else requireField(t.budget_tokens === undefined, "thinking.budget_tokens", "Only enabled thinking accepts a token budget.");
    if (t.display !== undefined) requireField(t.type !== "disabled" && ["summarized", "omitted"].includes(t.display), "thinking.display", "Use summarized or omitted with thinking enabled/adaptive.");
    if (t.block_binding !== undefined) {
      requireField(object(t.block_binding) && ["error", "drop_block"].includes(t.block_binding.prefix_mismatch_behavior), "thinking.block_binding", "Use prefix_mismatch_behavior: error or drop_block.");
      requireField(headers.get("anthropic-beta")?.split(",").map(s => s.trim()).includes("thinking-binding-controls-2026-08-01"), "thinking.block_binding", "Requires anthropic-beta: thinking-binding-controls-2026-08-01.");
    }
    if (t.type !== "disabled") {
      requireField(body.temperature === undefined || body.temperature === 1, "temperature", "Thinking requests require the default temperature (omit it or use 1).");
      requireField(!["any", "tool"].includes(body.tool_choice?.type), "tool_choice", "Thinking supports auto/none tool choice; forced tool calls are incompatible.");
    }
  }
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    requireField(object(choice) && ["auto", "any", "tool", "none"].includes(choice.type), "tool_choice", "Use auto, any, tool or none.");
    if (choice.type === "tool") requireField(nonempty(choice.name) && body.tools?.some((t: Body) => t.name === choice.name), "tool_choice.name", "Name a tool declared in tools.");
    if (choice.disable_parallel_tool_use !== undefined) requireField(typeof choice.disable_parallel_tool_use === "boolean", "tool_choice.disable_parallel_tool_use", "Expected a boolean.");
  }
}
