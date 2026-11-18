// Responses API results, as Anthropic Messages. Contract snapshot: 2026-10-25.
// https://platform.claude.com/docs/en/api/messages-streaming  (event order: message_start, then per block
// content_block_start / content_block_delta... / content_block_stop, then message_delta and message_stop)
// Cross-checked against QuantumNous/new-api's relaykit (Responses -> Claude).
import { object } from "../gateway/config";
import type { Body } from "../gateway/protocol";
import { anthropicErrorType, describeFailure, failureFromEvent, STREAM_ENDED, type ApiFailure } from "./errors";
import { SseReader } from "./sse";

const DONE_OK = new Set(["response.completed", "response.done", "response.incomplete"]);
const DONE_FAILED = new Set(["response.failed", "response.error", "error"]);
const PRELUDE = new Set(["response.created", "response.in_progress", "response.queued"]);

export function messagesStopReason(response: Body, sawTool: boolean): string {
  if (response.status === "incomplete") return response.incomplete_details?.reason === "content_filter" ? "refusal" : "max_tokens";
  return sawTool ? "tool_use" : "end_turn";
}
/**
 * A thinking block needs a signature to be replayable: the gateway's own request check (and Anthropic's SDKs) refuse
 * one that is empty, and a client puts the whole reply back into its next request. ChatGPT has nothing to sign, and
 * a replayed thinking block is dropped on the way to ChatGPT anyway, so a fixed marker is all the block carries.
 */
export const THINKING_SIGNATURE = "aelios-chatgpt-reasoning-summary";

/** Anthropic's `input_tokens` leaves out what came from the cache; OpenAI's counts it in. */
export function messagesUsage(usage: unknown): Body {
  const source = object(usage) ? usage : {};
  const input = Number(source.input_tokens) || 0;
  const cached = Math.min(input, Number(source.input_tokens_details?.cached_tokens) || 0);
  const written = Math.min(input - cached, Number(source.input_tokens_details?.cache_write_tokens) || 0);
  return { input_tokens: input - cached - written, output_tokens: Number(source.output_tokens) || 0,
    cache_creation_input_tokens: written, cache_read_input_tokens: cached };
}
const messageId = (response: Body | undefined) => `msg_${String(response?.id || crypto.randomUUID()).replace(/^resp_/, "").replace(/-/g, "")}`;
function parseInput(args: unknown): unknown {
  if (typeof args !== "string" || !args.trim()) return {};
  try { return JSON.parse(args); } catch { return {}; }
}

/** A finished Responses object as one Anthropic message. */
export function messageFromResponse(response: Body, model: string): Body {
  const content: Body[] = [];
  let sawTool = false;
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (!object(item)) continue;
    if (item.type === "reasoning") {
      const text = (Array.isArray(item.summary) ? item.summary : [])
        .map((part: unknown) => object(part) && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n\n");
      if (text) content.push({ type: "thinking", thinking: text, signature: THINKING_SIGNATURE });
    } else if (item.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (!object(part)) continue;
        const text = part.type === "output_text" ? part.text : part.type === "refusal" ? part.refusal : undefined;
        if (typeof text === "string" && text) content.push({ type: "text", text });
      }
    } else if (item.type === "function_call") {
      sawTool = true;
      content.push({ type: "tool_use", id: item.call_id || item.id, name: item.name, input: parseInput(item.arguments) });
    }
  }
  return {
    id: messageId(response), type: "message", role: "assistant", model, content,
    stop_reason: messagesStopReason(response, sawTool), stop_sequence: null, usage: messagesUsage(response.usage)
  };
}

const frame = (type: string, data: Body) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

interface Block { kind: "text" | "thinking" | "tool_use"; key: string; index: number }
interface Tool { callId: string; name: string; args: string; sent: number; block: Block | null; done: boolean }

/** One Responses event stream in, Anthropic stream events out. Blocks are strictly one after another. */
export class MessagesStreamTranslator {
  finished = false;
  failure: ApiFailure | null = null;
  private started = false;
  private sawTool = false;
  /** Set when a tool call's input could not be sent whole; the message then ends as an error, not as a call with a cut input. */
  private lostArgs = false;
  private nextIndex = 0;
  private current: Block | null = null;
  private readonly tools = new Map<number, Tool>();
  private readonly itemOutput = new Map<string, number>();
  private id = messageId(undefined);

  constructor(private readonly opts: { model: string; requestId?: string | null }) {}

  private start(out: string[]): void {
    if (this.started) return;
    this.started = true;
    out.push(frame("message_start", { message: { id: this.id, type: "message", role: "assistant", model: this.opts.model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }));
  }
  private close(out: string[]): void {
    if (!this.current) return;
    // Anthropic sends a thinking block's signature just before the block ends; clients keep it for the replay.
    if (this.current.kind === "thinking") {
      out.push(frame("content_block_delta", { index: this.current.index, delta: { type: "signature_delta", signature: THINKING_SIGNATURE } }));
    }
    out.push(frame("content_block_stop", { index: this.current.index }));
    this.current = null;
  }
  /** The block this event belongs to, opened (and the previous one closed) when it is not already the open one. */
  private open(kind: Block["kind"], key: string, out: string[], tool?: Tool): Block {
    if (this.current?.key === key) return this.current;
    this.close(out);
    this.start(out);
    const block: Block = { kind, key, index: this.nextIndex++ };
    this.current = block;
    const content = kind === "text" ? { type: "text", text: "" }
      : kind === "thinking" ? { type: "thinking", thinking: "", signature: "" }
      : { type: "tool_use", id: tool?.callId || key, name: tool?.name ?? "", input: {} };
    out.push(frame("content_block_start", { index: block.index, content_block: content }));
    return block;
  }
  private toolAt(event: Body, create: boolean): { tool: Tool; output: number } | undefined {
    let output = typeof event.output_index === "number" ? event.output_index : undefined;
    if (output === undefined && typeof event.item_id === "string") output = this.itemOutput.get(event.item_id);
    if (output === undefined) output = 0;
    let tool = this.tools.get(output);
    if (!tool && create) {
      tool = { callId: "", name: "", args: "", sent: 0, block: null, done: false };
      this.tools.set(output, tool);
    }
    if (typeof event.item_id === "string") this.itemOutput.set(event.item_id, output);
    return tool ? { tool, output } : undefined;
  }
  /** Sends the arguments not yet sent, but only while this call's block is the open one. */
  private flush(tool: Tool, out: string[]): void {
    if (!tool.block || tool.args.length <= tool.sent) return;
    if (this.current?.key !== tool.block.key) {
      // Its block was closed by another block before it finished: the rest of its input has nowhere to go.
      this.lostArgs = true;
      return;
    }
    out.push(frame("content_block_delta", { index: tool.block.index, delta: { type: "input_json_delta", partial_json: tool.args.slice(tool.sent) } }));
    tool.sent = tool.args.length;
  }
  private openTool(entry: { tool: Tool; output: number }, out: string[]): void {
    const { tool, output } = entry;
    // A call whose block was left behind by another block cannot be picked up again: that would be a second start.
    if (tool.done || !tool.name || (tool.block && this.current?.key !== tool.block.key)) return;
    this.sawTool = true;
    tool.block = this.open("tool_use", `tool:${output}`, out, tool);
    this.flush(tool, out);
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
    const slot = typeof event.output_index === "number" ? event.output_index : 0;
    if (type === "response.created") {
      if (typeof event.response?.id === "string") this.id = messageId(event.response);
    } else if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      if (typeof event.delta === "string" && event.delta) {
        this.open("text", `text:${slot}`, out);
        out.push(frame("content_block_delta", { index: this.current?.index, delta: { type: "text_delta", text: event.delta } }));
      }
    } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      if (typeof event.delta === "string" && event.delta) {
        this.open("thinking", `thinking:${slot}`, out);
        out.push(frame("content_block_delta", { index: this.current?.index, delta: { type: "thinking_delta", thinking: event.delta } }));
      }
    } else if (type === "response.reasoning_summary_part.added") {
      if (this.current?.key === `thinking:${slot}` && Number(event.summary_index) > 0) {
        out.push(frame("content_block_delta", { index: this.current.index, delta: { type: "thinking_delta", thinking: "\n\n" } }));
      }
    } else if (type === "response.output_item.added" || type === "response.output_item.done") {
      if (object(event.item) && event.item.type === "function_call") {
        const entry = this.toolAt(event, true) as { tool: Tool; output: number };
        if (typeof event.item.id === "string" && typeof event.output_index === "number") this.itemOutput.set(event.item.id, event.output_index);
        this.learn(entry.tool, event.item);
        this.openTool(entry, out);
        if (type === "response.output_item.done" && !entry.tool.done) {
          this.flush(entry.tool, out);
          entry.tool.done = true;
          if (this.current && this.current.key === entry.tool.block?.key) this.close(out);
        }
      }
    } else if (type === "response.function_call_arguments.delta") {
      const entry = this.toolAt(event, true) as { tool: Tool; output: number };
      if (typeof event.delta === "string" && !entry.tool.done) entry.tool.args += event.delta;
      this.flush(entry.tool, out);
    } else if (type === "response.function_call_arguments.done") {
      const entry = this.toolAt(event, true) as { tool: Tool; output: number };
      if (typeof event.arguments === "string" && event.arguments.startsWith(entry.tool.args)) entry.tool.args = event.arguments;
      if (typeof event.name === "string" && event.name) entry.tool.name = event.name;
      this.openTool(entry, out);
      this.flush(entry.tool, out);
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
  /** A stream with no deltas whose final response object carries the answer still gets that answer through. */
  private replay(response: Body, out: string[]): void {
    let slot = 0;
    for (const item of Array.isArray(response.output) ? response.output : []) {
      slot++;
      if (!object(item)) continue;
      if (item.type === "message") {
        const text = (Array.isArray(item.content) ? item.content : []).map((part: unknown) => !object(part) ? ""
          : part.type === "output_text" ? String(part.text ?? "") : part.type === "refusal" ? String(part.refusal ?? "") : "").join("");
        if (!text) continue;
        this.open("text", `text:${slot}`, out);
        out.push(frame("content_block_delta", { index: this.current?.index, delta: { type: "text_delta", text } }));
      } else if (item.type === "reasoning") {
        const text = (Array.isArray(item.summary) ? item.summary : [])
          .map((part: unknown) => object(part) && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n\n");
        if (!text) continue;
        this.open("thinking", `thinking:${slot}`, out);
        out.push(frame("content_block_delta", { index: this.current?.index, delta: { type: "thinking_delta", thinking: text } }));
      } else if (item.type === "function_call" && item.name) {
        const tool: Tool = { callId: String(item.call_id || item.id || ""), name: String(item.name),
          args: typeof item.arguments === "string" ? item.arguments : "", sent: 0, block: null, done: false };
        this.tools.set(100 + slot, tool);
        this.openTool({ tool, output: 100 + slot }, out);
        tool.done = true;
        this.close(out);
      }
    }
  }
  private finish(response: Body, out: string[]): void {
    if (!this.started) this.replay(response, out);
    // A call that was only ever described by its arguments (no item event) is still a call; give it a block now.
    for (const [output, tool] of [...this.tools.entries()].sort((a, b) => a[0] - b[0])) {
      if (tool.done) continue;
      this.openTool({ tool, output }, out);
      this.flush(tool, out);
      tool.done = true;
      this.close(out);
    }
    this.close(out);
    if (this.lostArgs) {
      this.start(out);
      this.fail({ status: 502, code: "stream_interleaved", param: null, requestId: this.opts.requestId ?? null,
        message: "ChatGPT interleaved parallel tool calls in a way that cannot be sent as Anthropic blocks, so a call's input would have been cut." }, out);
      return;
    }
    this.start(out);
    out.push(frame("message_delta", { delta: { stop_reason: messagesStopReason(response, this.sawTool), stop_sequence: null },
      usage: messagesUsage(response.usage) }));
    out.push(frame("message_stop", {}));
    this.finished = true;
  }
  private fail(failure: ApiFailure, out: string[]): void {
    this.failure = failure;
    const described = describeFailure(failure);
    out.push(frame("error", { error: { type: anthropicErrorType(described.status), message: described.message } }));
    this.finished = true;
  }
}

/**
 * An Anthropic stream from a Responses stream. As with chat, the first event that is more than a hello is read
 * before anything is returned, so an answer that fails straight away is still a proper HTTP error.
 */
export async function openMessagesStream(upstream: Response, opts: { model: string }):
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
  const translator = new MessagesStreamTranslator({ ...opts, requestId });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (translator.finished) { controller.close(); await reader.cancel(); return; }
        const event = held.length ? held.shift() as Body : await reader.next().catch(() => null);
        const lines = event ? translator.push(event) : translator.end();
        if (lines.length) { controller.enqueue(encoder.encode(lines.join(""))); return; }
        if (!event) { controller.close(); return; }
      }
    },
    cancel(reason) { return reader.cancel(reason); }
  });
  return { stream };
}
