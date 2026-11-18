// Responses API results, turned back into what the caller's protocol expects. Contract snapshot: 2026-10-25.
// The chat shapes follow OpenAI's chat.completion / chat.completion.chunk; the event names are the Responses ones.
import { object } from "../gateway/config";
import type { Body } from "../gateway/protocol";
import { errorBody, failureFromEvent, STREAM_ENDED, type ApiFailure } from "./errors";
import { SseReader } from "./sse";

const DONE_OK = new Set(["response.completed", "response.done", "response.incomplete"]);
const DONE_FAILED = new Set(["response.failed", "response.error", "error"]);
/** Events that arrive before the answer says anything about itself. */
const PRELUDE = new Set(["response.created", "response.in_progress", "response.queued"]);

export interface Collected { response: Body | null; failure: ApiFailure | null }
/**
 * Reads a whole Responses stream into the final response object. The terminal event's `output` is trusted when it
 * has items; otherwise the items the stream finished along the way (and, last, the text deltas) stand in for it.
 */
export async function collectResponse(reader: SseReader, requestId: string | null = null): Promise<Collected> {
  const finished = new Map<number, Body>();
  let text = "";
  for (;;) {
    const event = await reader.next();
    if (!event) break;
    const type = String(event.type);
    if (type === "response.output_item.done" && object(event.item)) {
      finished.set(typeof event.output_index === "number" ? event.output_index : finished.size, event.item);
    } else if (type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
    } else if (DONE_OK.has(type)) {
      const response: Body = object(event.response) ? { ...event.response } : {};
      if (!Array.isArray(response.output) || !response.output.length) {
        const items = [...finished.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
        response.output = items.length ? items
          : text ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] : [];
      }
      if (!response.status) response.status = type === "response.incomplete" ? "incomplete" : "completed";
      return { response, failure: null };
    } else if (DONE_FAILED.has(type)) {
      return { response: null, failure: failureFromEvent(event, requestId) };
    }
  }
  return { response: null, failure: { ...STREAM_ENDED, requestId } };
}

export function chatFinishReason(response: Body, sawTool: boolean): string {
  if (response.status === "incomplete") return response.incomplete_details?.reason === "content_filter" ? "content_filter" : "length";
  return sawTool ? "tool_calls" : "stop";
}
export function chatUsage(usage: unknown): Body | undefined {
  if (!object(usage)) return undefined;
  const prompt = Number(usage.input_tokens) || 0;
  const completion = Number(usage.output_tokens) || 0;
  return {
    prompt_tokens: prompt, completion_tokens: completion, total_tokens: Number(usage.total_tokens) || prompt + completion,
    prompt_tokens_details: { cached_tokens: Number(usage.input_tokens_details?.cached_tokens) || 0,
      ...(usage.input_tokens_details?.cache_write_tokens !== undefined
        ? { cache_write_tokens: Number(usage.input_tokens_details.cache_write_tokens) || 0 } : {}),
      ...(object(usage.input_tokens_details?.cache_write_tokens_details)
        ? { cache_write_tokens_details: { ...usage.input_tokens_details.cache_write_tokens_details } } : {}) },
    completion_tokens_details: { reasoning_tokens: Number(usage.output_tokens_details?.reasoning_tokens) || 0 }
  };
}
function summaryText(item: Body): string {
  return (Array.isArray(item.summary) ? item.summary : [])
    .map((part: unknown) => object(part) && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n\n");
}
const toolArguments = (item: Body): string =>
  typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});

/** A finished Responses object as one chat.completion. */
export function chatCompletionFromResponse(response: Body, model: string): Body {
  let content = "";
  const reasoning: string[] = [];
  const toolCalls: Body[] = [];
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (!object(item)) continue;
    if (item.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (!object(part)) continue;
        if (part.type === "output_text" && typeof part.text === "string") content += part.text;
        else if (part.type === "refusal" && typeof part.refusal === "string") content += part.refusal;
      }
    } else if (item.type === "reasoning") {
      const text = summaryText(item);
      if (text) reasoning.push(text);
    } else if (item.type === "function_call") {
      toolCalls.push({ id: item.call_id || item.id, type: "function", function: { name: item.name, arguments: toolArguments(item) } });
    }
  }
  const message: Body = { role: "assistant", content: content || (toolCalls.length ? null : "") };
  if (reasoning.length) message.reasoning_content = reasoning.join("\n\n");
  if (toolCalls.length) message.tool_calls = toolCalls;
  const usage = chatUsage(response.usage);
  return {
    id: `chatcmpl-${String(response.id || crypto.randomUUID()).replace(/^resp_/, "")}`,
    object: "chat.completion", created: Number(response.created_at) || Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message, finish_reason: chatFinishReason(response, toolCalls.length > 0) }],
    ...(usage ? { usage } : {})
  };
}

interface Tool { index: number; callId: string; name: string; args: string; opened: boolean; sentArgs: number }
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const DONE_FRAME = "data: [DONE]\n\n";

/** One Responses event stream in, chat.completion.chunk frames out. Holds the little state tool calls need. */
export class ChatStreamTranslator {
  finished = false;
  failure: ApiFailure | null = null;
  private started = false;
  private sawTool = false;
  private reasoningSeen = false;
  private nextTool = 0;
  private readonly tools = new Map<number, Tool>();
  private readonly itemOutput = new Map<string, number>();
  private id = `chatcmpl-${crypto.randomUUID()}`;
  private readonly created = Math.floor(Date.now() / 1000);

  constructor(private readonly opts: { model: string; includeUsage: boolean; requestId?: string | null }) {}

  private chunk(delta: Body, finish: string | null = null): string {
    return frame({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.opts.model,
      choices: [{ index: 0, delta, finish_reason: finish }] });
  }
  private start(out: string[]): void {
    if (this.started) return;
    this.started = true;
    out.push(this.chunk({ role: "assistant", content: "" }));
  }
  private toolAt(event: Body, create: boolean): Tool | undefined {
    let output = typeof event.output_index === "number" ? event.output_index : undefined;
    if (output === undefined && typeof event.item_id === "string") output = this.itemOutput.get(event.item_id);
    if (output === undefined) output = 0;
    let tool = this.tools.get(output);
    if (!tool && create) {
      tool = { index: this.nextTool++, callId: "", name: "", args: "", opened: false, sentArgs: 0 };
      this.tools.set(output, tool);
    }
    if (typeof event.item_id === "string") this.itemOutput.set(event.item_id, output);
    return tool;
  }
  /** Opens the call once its name is known (or at the end, whatever it has), then sends whatever arguments are unsent. */
  private flush(tool: Tool, out: string[], force = false): void {
    if (!tool.opened) {
      if (!tool.name && !force) return;
      this.start(out);
      tool.opened = true;
      this.sawTool = true;
      out.push(this.chunk({ tool_calls: [{ index: tool.index, id: tool.callId || `call_${tool.index}`, type: "function",
        function: { name: tool.name, arguments: "" } }] }));
    }
    if (tool.args.length > tool.sentArgs) {
      out.push(this.chunk({ tool_calls: [{ index: tool.index, function: { arguments: tool.args.slice(tool.sentArgs) } }] }));
      tool.sentArgs = tool.args.length;
    }
  }
  private learn(tool: Tool, item: Body): void {
    if (typeof item.call_id === "string" && item.call_id) tool.callId = item.call_id;
    else if (!tool.callId && typeof item.id === "string") tool.callId = item.id;
    if (typeof item.name === "string" && item.name) tool.name = item.name;
    if (typeof item.arguments === "string" && item.arguments.startsWith(tool.args)) tool.args = item.arguments;
  }

  push(event: Body): string[] {
    if (this.finished) return [];
    const out: string[] = [];
    const type = String(event.type);
    if (type === "response.created") {
      if (typeof event.response?.id === "string") this.id = `chatcmpl-${event.response.id.replace(/^resp_/, "")}`;
    } else if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      if (typeof event.delta === "string" && event.delta) {
        this.start(out);
        out.push(this.chunk({ content: event.delta }));
      }
    } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      if (typeof event.delta === "string" && event.delta) {
        this.start(out);
        this.reasoningSeen = true;
        out.push(this.chunk({ reasoning_content: event.delta }));
      }
    } else if (type === "response.reasoning_summary_part.added") {
      if (this.reasoningSeen && Number(event.summary_index) > 0) out.push(this.chunk({ reasoning_content: "\n\n" }));
    } else if (type === "response.output_item.added" || type === "response.output_item.done") {
      if (object(event.item) && event.item.type === "function_call") {
        const tool = this.toolAt(event, true) as Tool;
        if (typeof event.item.id === "string" && typeof event.output_index === "number") this.itemOutput.set(event.item.id, event.output_index);
        this.learn(tool, event.item);
        this.flush(tool, out, type === "response.output_item.done");
      }
    } else if (type === "response.function_call_arguments.delta") {
      const tool = this.toolAt(event, true) as Tool;
      if (typeof event.delta === "string") tool.args += event.delta;
      this.flush(tool, out);
    } else if (type === "response.function_call_arguments.done") {
      const tool = this.toolAt(event, true) as Tool;
      if (typeof event.arguments === "string" && event.arguments.startsWith(tool.args)) tool.args = event.arguments;
      if (typeof event.name === "string" && event.name) tool.name = event.name;
      this.flush(tool, out);
    } else if (DONE_OK.has(type)) {
      this.finish(object(event.response) ? event.response : {}, out);
    } else if (DONE_FAILED.has(type)) {
      this.fail(failureFromEvent(event, this.opts.requestId ?? null), out);
    }
    return out;
  }
  /** The upstream closed without a terminal event. */
  end(): string[] {
    if (this.finished) return [];
    const out: string[] = [];
    this.fail({ ...STREAM_ENDED, requestId: this.opts.requestId ?? null }, out);
    return out;
  }
  /**
   * A stream that never sent a delta, but whose final response object carries the answer, still gets that answer
   * through: an empty message that "finished normally" would be the worst way to lose it.
   */
  private replay(response: Body, out: string[]): void {
    for (const item of Array.isArray(response.output) ? response.output : []) {
      if (!object(item)) continue;
      if (item.type === "message") {
        const text = (Array.isArray(item.content) ? item.content : []).map((part: unknown) => !object(part) ? ""
          : part.type === "output_text" ? String(part.text ?? "") : part.type === "refusal" ? String(part.refusal ?? "") : "").join("");
        if (text) { this.start(out); out.push(this.chunk({ content: text })); }
      } else if (item.type === "reasoning") {
        const text = summaryText(item);
        if (text) { this.start(out); out.push(this.chunk({ reasoning_content: text })); }
      } else if (item.type === "function_call") {
        this.flush({ index: this.nextTool++, callId: String(item.call_id || item.id || ""), name: String(item.name || ""),
          args: toolArguments(item), opened: false, sentArgs: 0 }, out, true);
      }
    }
  }
  private finish(response: Body, out: string[]): void {
    if (!this.started) this.replay(response, out);
    for (const tool of [...this.tools.values()].sort((a, b) => a.index - b.index)) this.flush(tool, out, true);
    this.start(out);
    out.push(this.chunk({}, chatFinishReason(response, this.sawTool)));
    const usage = this.opts.includeUsage ? chatUsage(response.usage) : undefined;
    if (usage) out.push(frame({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.opts.model, choices: [], usage }));
    out.push(DONE_FRAME);
    this.finished = true;
  }
  private fail(failure: ApiFailure, out: string[]): void {
    this.failure = failure;
    out.push(frame(errorBody(failure)), DONE_FRAME);
    this.finished = true;
  }
}

/**
 * A chat stream from a Responses stream. The first event that is more than a hello is read before anything is
 * returned, so an answer that fails straight away (usage limit, no eligibility) can still be an HTTP error.
 */
export async function openChatStream(upstream: Response, opts: { model: string; includeUsage: boolean }):
    Promise<{ failure: ApiFailure } | { stream: ReadableStream<Uint8Array> }> {
  const requestId = upstream.headers.get("x-request-id");
  if (!upstream.body) return { failure: { ...STREAM_ENDED, requestId } };
  const reader = new SseReader(upstream.body);
  const held: Body[] = [];
  for (;;) {
    const event = await reader.next().catch(() => null);
    if (!event) break;
    if (DONE_FAILED.has(String(event.type)) && held.every(item => PRELUDE.has(String(item.type)))) {
      await reader.cancel();
      return { failure: failureFromEvent(event, requestId) };
    }
    held.push(event);
    if (!PRELUDE.has(String(event.type))) break;
  }
  const translator = new ChatStreamTranslator({ ...opts, requestId });
  const encoder = new TextEncoder();
  const queue = held;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (translator.finished) { controller.close(); await reader.cancel(); return; }
        const event = queue.length ? queue.shift() as Body : await reader.next().catch(() => null);
        const lines = event ? translator.push(event) : translator.end();
        if (lines.length) { controller.enqueue(encoder.encode(lines.join(""))); return; }
        if (!event) { controller.close(); return; }
      }
    },
    cancel(reason) { return reader.cancel(reason); }
  });
  return { stream };
}
