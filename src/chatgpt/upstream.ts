// The gateway's one call on the ChatGPT plan route: reshape, send, and shape the answer for the caller's protocol.
import type { Env } from "../types";
import type { Protocol } from "../gateway/config";
import type { Body } from "../gateway/protocol";
import { postResponses, type WaitUntil } from "./client";
import { anthropicErrorType, errorResponse, readFailure, type ApiFailure, type ErrorShape } from "./errors";
import { chatCompletionFromResponse, collectResponse, openChatStream } from "./fromResponses";
import { SseReader } from "./sse";
import { messageFromResponse, openMessagesStream } from "./toMessages";
import { ChatGptAuthError } from "./token";
import { REQUIRED_FIELDS, toChatGptRequest } from "./toResponses";

export interface ChatGptTarget {
  /** The ChatGPT model name, without the chatgpt/ prefix. */
  model: string;
  /** What the caller called it, echoed back in chat.completion / the message and the recorder. */
  requestedModel: string;
  /** The gateway's normalization report; this call adds what it dropped. */
  removed: string[];
  /** Gateway-scoped opaque cache affinity, shared by the body key and session-id header. */
  sessionId?: string;
  recall?: string;
}

/**
 * "unsupported capability" names the field that was refused. A top-level one is dropped and learned, so the next
 * request for the same model leaves it out from the start instead of paying a 400 first.
 * What is learned belongs to one model (another may accept it) and expires, since the plan route changes; and the
 * fields that carry the request's meaning (tools, tool_choice, text, instructions) are never dropped, because
 * answering without them is worse than the error.
 */
const LEARN_TTL_MS = 3600_000;
const NEVER_DROP = new Set([...REQUIRED_FIELDS, "tools", "tool_choice", "text", "instructions"]);
const learned = new Map<string, Map<string, number>>();
export function resetLearnedFields(): void { learned.clear(); }
function learnedFor(model: string, now = Date.now()): string[] {
  const fields = learned.get(model);
  if (!fields) return [];
  for (const [field, expires] of fields) if (expires <= now) fields.delete(field);
  return [...fields.keys()];
}

const MAX_LEARNING_ROUNDS = 3;
const noStore = { "cache-control": "no-store" };

/** What the caller's SDK parses: Anthropic clients read `{type:"error", error:{type, message}}`, the rest `{error:{...}}`. */
const shapeOf = (protocol: Protocol): ErrorShape => protocol === "messages" ? "anthropic" : "openai";
function authFailure(error: ChatGptAuthError, protocol: Protocol): Response {
  const body = protocol === "messages"
    ? { type: "error", error: { type: anthropicErrorType(error.status), message: error.message } }
    : { error: { message: error.message, type: "api_error", code: `chatgpt_${error.kind}`, param: null } };
  return Response.json(body, { status: error.status, headers: noStore });
}

export async function callChatGptUpstream(env: Env, protocol: Protocol, signal: AbortSignal | undefined,
    target: ChatGptTarget, payload: Body, waitUntil?: WaitUntil): Promise<Response> {
  const shape = shapeOf(protocol);
  const wantsStream = payload.stream === true;
  const includeUsage = payload.stream_options?.include_usage === true;
  const converted = toChatGptRequest(payload, protocol, target.model, target.recall);
  if (target.sessionId) converted.body.prompt_cache_key = target.sessionId;
  target.removed.push(...converted.removed);
  for (const field of learnedFor(target.model)) {
    if (converted.body[field] !== undefined) { delete converted.body[field]; target.removed.push(field); }
  }

  let upstream: Response | undefined;
  try {
    for (let round = 0; round <= MAX_LEARNING_ROUNDS; round++) {
      const response = await postResponses(env, converted.body, signal, waitUntil, target.sessionId);
      if (response.ok) { upstream = response; break; }
      const failure = await readFailure(response);
      const param = failure.param;
      const droppable = failure.code === "subscription_sharing_unsupported_capability" && param && !param.includes(".")
        && !NEVER_DROP.has(param) && converted.body[param] !== undefined && round < MAX_LEARNING_ROUNDS;
      if (!droppable) return errorResponse(failure, {}, shape);
      delete converted.body[param];
      const fields = learned.get(target.model) ?? new Map<string, number>();
      fields.set(param, Date.now() + LEARN_TTL_MS);
      learned.set(target.model, fields);
      target.removed.push(param);
      console.log("chatgpt route learned an unsupported field", { model: target.model, field: param });
    }
  } catch (error) {
    if (error instanceof ChatGptAuthError) return authFailure(error, protocol);
    throw error;
  }
  if (!upstream?.body) {
    return errorResponse({ status: 502, code: "stream_ended", message: "ChatGPT sent no body.", param: null, requestId: null }, {}, shape);
  }

  const requestId = upstream.headers.get("x-request-id");
  // The handler reads these two from AI Gateway responses; same names here keep it to one path.
  const labels: Record<string, string> = { ...noStore, "cf-aig-provider": "chatgpt", "cf-aig-model": target.requestedModel };
  if (requestId) labels["x-request-id"] = requestId;
  const sse = { ...labels, "content-type": "text/event-stream; charset=utf-8" };

  if (protocol === "responses" && wantsStream) return new Response(upstream.body, { status: 200, headers: sse });
  if (protocol === "chat" && wantsStream) {
    const opened = await openChatStream(upstream, { model: target.requestedModel, includeUsage });
    return "failure" in opened ? errorResponse(opened.failure, labels, shape) : new Response(opened.stream, { status: 200, headers: sse });
  }
  if (protocol === "messages" && wantsStream) {
    const opened = await openMessagesStream(upstream, { model: target.requestedModel });
    return "failure" in opened ? errorResponse(opened.failure, labels, shape) : new Response(opened.stream, { status: 200, headers: sse });
  }
  const reader = new SseReader(upstream.body);
  const collected = await collectResponse(reader, requestId);
  await reader.cancel();
  if (!collected.response) {
    const failure: ApiFailure = collected.failure ?? { status: 502, code: "stream_ended", message: "ChatGPT sent no result.", param: null, requestId };
    return errorResponse(failure, labels, shape);
  }
  const answer = protocol === "chat" ? chatCompletionFromResponse(collected.response, target.requestedModel)
    : protocol === "messages" ? messageFromResponse(collected.response, target.requestedModel) : collected.response;
  return Response.json(answer, { status: 200, headers: labels });
}
