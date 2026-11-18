// Calls to the public Responses API with the owner's ChatGPT plan token. Contract snapshot: 2026-10-25.
// https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
// Allowed: https://api.openai.com/v1 with the OAuth access token. Not allowed: ChatGPT backend-api endpoints.
import type { Env } from "../types";
import { object } from "../gateway/config";
import type { Body } from "../gateway/protocol";
import { ChatGptApiError, readFailure } from "./errors";
import { getAccessGrant } from "./token";

export const API_BASE = "https://api.openai.com/v1";
export const RESPONSES_URL = `${API_BASE}/responses`;
export const MODELS_URL = `${API_BASE}/models`;
/** Models are named `chatgpt/<slug>` on the gateway; the slug is what ChatGPT calls them. */
export const MODEL_PREFIX = "chatgpt/";

export interface ChatGptModel { slug: string; name: string }

let modelCache: { account: string; at: number; models: ChatGptModel[] } | null = null;
const MODEL_TTL_MS = 10 * 60_000;
/** Mutable so a test can shorten them; nothing else changes them. */
export const TIMEOUTS = { modelsMs: 5_000 };
export function resetModelCache(): void { modelCache = null; }

/**
 * `GET /v1/models` for this account. Only entries whose `visibility` is "list" are meant to be offered, in the
 * server's order. If nothing carries a visibility at all, the catalog is the plain OpenAI shape and is taken whole.
 */
export function parseModelCatalog(body: unknown): ChatGptModel[] {
  const root = object(body) ? body : {};
  const items: unknown[] = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : Array.isArray(body) ? body : [];
  const entries = items.filter(object);
  const graded = entries.some(entry => typeof entry.visibility === "string");
  const out: ChatGptModel[] = [];
  for (const entry of entries) {
    if (graded && entry.visibility !== "list") continue;
    const slug = typeof entry.slug === "string" ? entry.slug : typeof entry.id === "string" ? entry.id : "";
    if (!slug || out.some(model => model.slug === slug)) continue;
    out.push({ slug, name: typeof entry.display_name === "string" && entry.display_name ? entry.display_name : slug });
  }
  return out;
}

/** `waitUntil` is the request's own: it lets a token refresh finish even if the caller hangs up first. */
export type WaitUntil = (promise: Promise<unknown>) => void;

export async function listChatGptModels(env: Env, options: { fresh?: boolean; signal?: AbortSignal; waitUntil?: WaitUntil } = {}): Promise<ChatGptModel[]> {
  const grant = await getAccessGrant(env, { waitUntil: options.waitUntil });
  if (!options.fresh && modelCache && modelCache.account === grant.clientId && Date.now() - modelCache.at < MODEL_TTL_MS) return modelCache.models;
  // The catalog is a nicety next to every chat app's first request; it does not get to hold that request up.
  const timeout = AbortSignal.timeout(TIMEOUTS.modelsMs);
  const response = await fetch(MODELS_URL, {
    headers: { authorization: `Bearer ${grant.accessToken}`, accept: "application/json" }, redirect: "manual",
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  });
  if (!response.ok) throw new ChatGptApiError(await readFailure(response));
  const models = parseModelCatalog(await response.json().catch(() => null));
  modelCache = { account: grant.clientId, at: Date.now(), models };
  return models;
}

/**
 * One POST to /responses. A 401 gets a single forced refresh and one more try; a token that was refreshed a
 * moment ago is not refreshed again, so a revoked grant cannot turn requests into a refresh storm.
 */
export async function postResponses(env: Env, body: Body, signal?: AbortSignal, waitUntil?: WaitUntil, sessionId?: string): Promise<Response> {
  const send = async (force: boolean) => {
    const grant = await getAccessGrant(env, { force, waitUntil });
    return fetch(RESPONSES_URL, {
      method: "POST", redirect: "manual", signal,
      headers: { authorization: `Bearer ${grant.accessToken}`, "content-type": "application/json", accept: "text/event-stream",
        ...(sessionId ? { "session-id": sessionId } : {}) },
      body: JSON.stringify(body)
    });
  };
  const first = await send(false);
  if (first.status !== 401) return first;
  await first.body?.cancel().catch(() => undefined);
  return send(true);
}
