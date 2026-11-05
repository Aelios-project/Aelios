import type { Env } from "../types";
import { GATEWAY_HOST_RE, gatewayInAddress, isMainModel, PATHS, stripAddress, type GatewayConfig, type Identity, type Protocol } from "./config";
import { applyThinkingPolicy, PROTECTED_TOOL_FIELDS, rejectedFieldNames, sanitizeCacheControl, STRIPPABLE_TOOL_FIELDS, stripToolField, type Body } from "./protocol";
import { normalizeRequest, validateRequest } from "./request";
import { MODEL_PREFIX, RESPONSES_URL } from "../chatgpt/client";
import { callChatGptUpstream } from "../chatgpt/upstream";
import { toChatGptRequest } from "../chatgpt/toResponses";

const ACCOUNT_RE = /^[a-f0-9]{32}$/i;
const REST_HOST_RE =
  /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([a-f0-9]{32})(?:\/.*)?$/i;

/**
 * Cloudflare's own name for the account's default gateway. Only the gateway.ai.cloudflare.com surfaces need it,
 * because their URL has a gateway segment; the REST API picks the account default by itself when no gateway is named.
 */
export const ACCOUNT_DEFAULT_GATEWAY = "default";

export interface ResolvedUpstream {
  accountId: string | null;
  /** The gateway the owner named (pasted URL or AI_GATEWAY_ID); null: the account's default gateway. */
  gatewayId: string | null;
  /** CF: the gateway root. Custom OpenAI bases stay as typed. */
  base: string;
}

function configuredAddress(env: Env, config: GatewayConfig): string {
  return config.upstream?.address?.trim() || env.AI_GATEWAY_BASE_URL || env.CLOUDFLARE_ACCOUNT_ID || "";
}

/** The only CF catalog that actually lists models. Do not change this shape. */
export function compatBase(accountId: string, gatewayId: string): string {
  return `https://gateway.ai.cloudflare.com/v1/${accountId.toLowerCase()}/${gatewayId}/compat`;
}

/** Root of every BYOK-capable surface: compat, provider endpoints, catalog. */
export function gatewayBase(accountId: string, gatewayId: string): string {
  return `https://gateway.ai.cloudflare.com/v1/${accountId.toLowerCase()}/${gatewayId}`;
}

/** The AI REST API (api.cloudflare.com): the gateway goes in the cf-aig-gateway-id header, not the URL. */
export function restBase(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId.toLowerCase()}/ai/v1`;
}

/** The gateway named in the pasted address, else AI_GATEWAY_ID; null leaves it to the account's default gateway. */
export function resolveGatewayId(env: Env, address = ""): string | null {
  return gatewayInAddress(address) ?? (env.AI_GATEWAY_ID?.trim() || null);
}

function parseGatewayHost(address: string): { accountId: string } | null {
  const match = stripAddress(address).match(GATEWAY_HOST_RE);
  return match ? { accountId: match[1] } : null;
}

export function resolveUpstream(env: Env, config: GatewayConfig): ResolvedUpstream {
  const address = configuredAddress(env, config);
  if (!address) throw new Error("Upstream not configured. Set the CF account in /admin.");
  const trimmed = stripAddress(address);
  const gatewayId = resolveGatewayId(env, trimmed);
  const inPath = gatewayId ?? ACCOUNT_DEFAULT_GATEWAY;

  if (ACCOUNT_RE.test(trimmed)) {
    return { accountId: trimmed.toLowerCase(), gatewayId, base: gatewayBase(trimmed, inPath) };
  }

  const rest = trimmed.match(REST_HOST_RE);
  if (rest) {
    return { accountId: rest[1].toLowerCase(), gatewayId, base: gatewayBase(rest[1], inPath) };
  }

  const gw = parseGatewayHost(trimmed);
  if (gw) {
    return { accountId: gw.accountId.toLowerCase(), gatewayId, base: gatewayBase(gw.accountId, inPath) };
  }

  return { accountId: null, gatewayId, base: trimmed };
}

/**
 * Do not change this shape: GET {compat}/models is the catalog CF actually serves. The REST API has no GET
 * /models (405, checked 2026-11-05), so the catalog stays on the gateway surface.
 */
export function catalogUrl(env: Env, config: GatewayConfig): string {
  const resolved = resolveUpstream(env, config);
  if (resolved.accountId) return `${compatBase(resolved.accountId, resolved.gatewayId ?? ACCOUNT_DEFAULT_GATEWAY)}/models`;
  return `${resolved.base}/models`;
}

/** A route the caller can fix by changing protocol or model; not an upstream outage. */
export class UpstreamRouteError extends Error {
  readonly status = 400;
}

export interface UpstreamRoute {
  url: string;
  /** Provider endpoints take the native name; compat keeps the author-prefixed one; REST the catalog id. */
  model: string;
  /**
   * Provider endpoints carry the CF token as cf-aig-authorization (BYOK); bearer elsewhere.
   * "rest" is the AI REST API: the token as bearer, and the gateway, when one is named, as cf-aig-gateway-id.
   * "chatgpt" is the owner's ChatGPT plan: it has its own token, and the CF token never goes there.
   */
  auth: "bearer" | "cf-aig" | "rest" | "chatgpt";
  /** REST only: the gateway to name in cf-aig-gateway-id; null lets CF use the account's default gateway. */
  gateway?: string | null;
  /** REST only: the provider endpoint to use instead when REST cannot take the call (see restRefused). */
  fallback?: UpstreamRoute;
}

/**
 * `chatgpt/<model>` runs on the owner's ChatGPT plan (Sign in with ChatGPT), straight to the public Responses API.
 * Chat, messages and responses callers all get through: the first two are translated both ways.
 */
export function chatGptRoute(model: string): UpstreamRoute | null {
  if (!model.toLowerCase().startsWith(MODEL_PREFIX)) return null;
  const slug = model.slice(MODEL_PREFIX.length).trim();
  if (!slug) throw new UpstreamRouteError(`"${model}" has no model name after ${MODEL_PREFIX}`);
  return { url: RESPONSES_URL, model: slug, auth: "chatgpt" };
}

/**
 * Anthropic's API spells a version with dashes (claude-opus-5-5); Cloudflare's catalog, which the REST API
 * reads, with a dot (claude-opus-5.5) and answers 404 to the dashed one. Names without a minor version, with
 * a dot already, or of the older claude-3-7-sonnet shape are left as written.
 */
export function catalogClaude(name: string): string {
  return name.replace(/^(claude-[a-z]+-\d+)-(\d)(?=$|\D)/i, "$1.$2");
}

/**
 * Where each protocol goes on Cloudflare (checked against the live API 2026-11-05):
 *  - messages for anthropic/… → the AI REST API, /ai/v1/messages: Anthropic's own answers, errors and SSE, the
 *    anthropic-beta header passed through, BYOK under the `default` alias then Unified Billing. The gateway rides
 *    in cf-aig-gateway-id. The provider endpoint is kept as the fallback (see restRefused).
 *  - chat → compat. REST only serves the Unified catalog: BYOK-only providers (deepseek/…), provider-slug names
 *    (google-ai-studio/…, grok/…, workers-ai/…), openrouter/… and custom-… all fail there.
 *  - responses, and messages for any other provider → the provider's native endpoint with its own path shape
 *    (`/v1/messages`; custom providers mount without the v1, and openai's responses drops it per CF docs).
 *    REST's /ai/v1/responses rewrites the response id, which a client continuing by previous_response_id needs.
 */
export function routeFor(resolved: ResolvedUpstream, protocol: Protocol, model: string): UpstreamRoute {
  if (!resolved.accountId) return { url: `${resolved.base}/${PATHS[protocol]}`, model, auth: "bearer" };
  const gw = gatewayBase(resolved.accountId, resolved.gatewayId ?? ACCOUNT_DEFAULT_GATEWAY);
  if (protocol === "chat") return { url: `${gw}/compat/chat/completions`, model, auth: "bearer" };
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash).toLowerCase() : "";
  const native = slash > 0 ? model.slice(slash + 1) : model;
  if (!provider) throw new UpstreamRouteError(
    `"${model}" has no provider prefix; use the author/model form so the BYOK endpoint is known.`);
  const custom = provider.startsWith("custom-");
  const path = protocol === "messages" ? (custom ? "/messages" : "/v1/messages")
    : provider === "openai" || custom ? "/responses" : "/v1/responses";
  const providerRoute: UpstreamRoute = { url: `${gw}/${provider}${path}`, model: native, auth: "cf-aig" };
  if (protocol !== "messages" || provider !== "anthropic") return providerRoute;
  return { url: `${restBase(resolved.accountId)}/messages`, model: `anthropic/${catalogClaude(native)}`, auth: "rest",
    gateway: resolved.gatewayId, fallback: providerRoute };
}

/** Anthropic's own line behind CF; it enforces thinking prefix bindings by default (seen 2026-10-08). */
export function nativeAnthropic(route: UpstreamRoute): boolean {
  if (route.auth === "rest") return route.url.endsWith("/ai/v1/messages") && /^anthropic\//i.test(route.model);
  return route.auth === "cf-aig" && /\/anthropic\/v1\/messages$/.test(route.url);
}

/**
 * Whether the REST API turned the call down for a reason the provider endpoint does not have, so the same
 * request should go there instead: a model the catalog does not know (404 "Model not found", or CF's 5007), or a
 * token without the Workers AI Read permission REST needs (401, CF code 10000). Answers from the model itself,
 * including its own 403s, are not retried.
 */
export function restRefused(status: number, text: string): "model" | "token" | null {
  if (status === 404 && /Model not found/i.test(text)) return "model";
  if (status === 400 && /"code"\s*:\s*5007\b/.test(text)) return "model";
  if (status === 401 && /"code"\s*:\s*10000\b/.test(text)) return "token";
  return null;
}

/** REST refusals learned in this isolate: the token (all of REST) or one catalog id at a time. */
const restLearned = { token: false, models: new Set<string>() };
export function forgetRestRefusals(): void { restLearned.token = false; restLearned.models.clear(); }

/** The CF token the way the route takes it; whatever another route had set is cleared first. */
function setRouteAuth(headers: Headers, route: UpstreamRoute, token: string | undefined): void {
  for (const name of ["authorization", "cf-aig-authorization", "cf-aig-gateway-id"]) headers.delete(name);
  if (route.auth === "cf-aig") headers.set("cf-aig-authorization", `Bearer ${token}`);
  else if (route.auth === "bearer" || route.auth === "rest") headers.set("authorization", `Bearer ${token}`);
  if (route.auth === "rest" && route.gateway) headers.set("cf-aig-gateway-id", route.gateway);
}

// One call, one upstream. Model names pass through as written (minus the provider prefix on native endpoints,
// in catalog spelling on REST); retries and provider fallback are AI Gateway's own job. The one fallback here is
// from REST to the provider endpoint, for what REST alone cannot take (restRefused).
export interface PreparedRequest { route: UpstreamRoute; headers: Headers; body: Body; removed: string[];
  /** The model name as the caller wrote it; the route may have trimmed a prefix off `body.model`. */
  requestedModel: string;
  /** Set when auto guessed adaptive thinking; holds the client's own anthropic-beta for the fallback. */
  guessedThinking?: { beta: string | null };
}
export function prepareGatewayRequest(env: Env, config: GatewayConfig, identity: Identity,
  protocol: Protocol, original: Request, body: Body): PreparedRequest {
  const token = env.CLOUDFLARE_API_TOKEN;
  const chatgpt = chatGptRoute(body.model);
  if (!chatgpt && !token) throw new Error("Missing Worker secret CLOUDFLARE_API_TOKEN");
  const planned = chatgpt ?? routeFor(resolveUpstream(env, config), protocol, body.model);
  // Once REST has turned the token or this model down in this isolate, go straight to the provider endpoint.
  const route = planned.fallback && (restLearned.token || restLearned.models.has(planned.model)) ? planned.fallback : planned;
  const headers = new Headers({
    "content-type": "application/json",
    accept: body.stream ? "text/event-stream" : "application/json"
  });
  setRouteAuth(headers, route, token);
  // Copied for every route: request validation reads the caller's betas (interleaved thinking and the like). The
  // ChatGPT route builds its own headers for OpenAI, so none of these are forwarded there.
  for (const name of ["anthropic-version", "anthropic-beta", "openai-beta", "x-stainless-helper-method"]) {
    const value = original.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (protocol === "messages" && !headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  const normalized = normalizeRequest(body, protocol);
  const out = normalized.body;
  out.model = route.model;
  const clientBeta = headers.get("anthropic-beta");
  // The thinking-binding policy is Anthropic-line plumbing; a ChatGPT answer has no Anthropic signature to bind.
  const guessed = !chatgpt && isMainModel(identity, body.model) &&
    applyThinkingPolicy(out, identity, protocol, headers, nativeAnthropic(route));
  validateRequest(out, protocol, headers);
  sanitizeCacheControl(out, protocol);
  validateRequest(out, protocol, headers);
  // A request ChatGPT plan usage cannot take is the caller's 400, found before recall or recording spends anything.
  if (chatgpt) toChatGptRequest(out, protocol, route.model);
  return { route, headers, body: out, removed: normalized.removed, requestedModel: body.model,
    ...(guessed ? { guessedThinking: { beta: clientBeta } } : {}) };
}
// Isolate-scope learned capability: Vertex-backed and relay lines answer 400
// "unrecognizedProperty=<field>" to tool-definition fields they do not know
// (cache_control, eager_input_streaming). Once per isolate per route, the refused
// fields are learned and stripped before every later send.
export const rejectedToolFields = new Map<string, Set<string>>();

/** Setting values already reported, so a bad one warns once per isolate, not once per request. */
const reportedStripSettings = new Set<string>();

/** Operator escape hatch: strip these before the first send and never eat the 400. */
function preStrippedToolFields(env: Env): string[] {
  const raw = env.UPSTREAM_STRIP_TOOL_FIELDS?.trim();
  if (!raw) return [];
  const named = raw.split(",").map(field => field.trim()).filter(field => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field));
  const usable = named.filter(field => !PROTECTED_TOOL_FIELDS.has(field));
  // The setting is free text, and validateRequest already ran, so a typo naming a tool's
  // identity would ship a broken tool. Refuse those, and say so rather than silently
  // honouring a shorter list than the operator wrote.
  if (usable.length !== named.length && !reportedStripSettings.has(raw)) {
    reportedStripSettings.add(raw);
    console.warn("UPSTREAM_STRIP_TOOL_FIELDS skipped tool identity fields", {
      skipped: named.filter(field => PROTECTED_TOOL_FIELDS.has(field))
    });
  }
  return usable;
}

export async function callGatewayUpstream(env: Env, protocol: Protocol, original: Request,
  prepared: PreparedRequest, body: Body, ctx?: ExecutionContext): Promise<Response> {
  let { route } = prepared;
  const { headers } = prepared;
  // Check the actual wire payload, including the gateway's own modifications.
  validateRequest(body, protocol, headers);
  if (route.auth === "chatgpt") {
    return callChatGptUpstream(env, protocol, original.signal,
      { model: route.model, requestedModel: prepared.requestedModel, removed: prepared.removed }, body,
      ctx ? promise => ctx.waitUntil(promise) : undefined);
  }
  const learned = rejectedToolFields.get(route.url);
  if (learned) for (const field of learned) stripToolField(body, field);
  for (const field of preStrippedToolFields(env)) stripToolField(body, field);
  const send = () => fetch(route.url, {
    method: "POST", headers, body: JSON.stringify(body), signal: original.signal, redirect: "manual"
  });
  let response = await send();
  // REST cannot take this call (a model its catalog does not know, or a token without Workers AI Read), but the
  // provider endpoint can: send the same request there, and in this isolate skip REST for it from now on.
  if (route.auth === "rest" && route.fallback && !response.ok) {
    const refusal = restRefused(response.status, await response.clone().text().catch(() => ""));
    if (refusal) {
      if (refusal === "token") restLearned.token = true;
      else restLearned.models.add(route.model);
      console.warn("gateway REST refused the call; using the provider endpoint", { reason: refusal, model: route.model, status: response.status });
      route = route.fallback;
      setRouteAuth(headers, route, env.CLOUDFLARE_API_TOKEN);
      body.model = route.model;
      for (const field of rejectedToolFields.get(route.url) ?? []) stripToolField(body, field);
      response = await send();
    }
  }
  // A relay names one unknown field per 400, and a client can send several at once
  // (eager_input_streaming on every tool, cache_control on the last one). Learn in a
  // bounded loop so first contact costs at most one round per strippable field.
  for (let round = 0; response.status === 400 && round < STRIPPABLE_TOOL_FIELDS.size; round++) {
    const detail = await response.clone().text().catch(() => "");
    // Only a field we actually removed justifies a retry; anything else is the caller's 400.
    const refused: string[] = [];
    for (const field of rejectedFieldNames(detail)) {
      if (STRIPPABLE_TOOL_FIELDS.has(field) && stripToolField(body, field)) refused.push(field);
    }
    if (!refused.length) break;
    const known = rejectedToolFields.get(route.url) ?? new Set<string>();
    for (const field of refused) known.add(field);
    rejectedToolFields.set(route.url, known);
    console.log("gateway learned upstream rejects tool fields", { url: route.url, fields: refused });
    response = await send();
  }
  // Signed history made auto guess the model thinks by default. A model that refuses the guess
  // (haiku-4-5 has no adaptive, e.g. after switching models mid-chat) gets what the client sent.
  if (response.status === 400 && prepared.guessedThinking) {
    const detail = await response.clone().text().catch(() => "");
    if (/thinking/i.test(detail)) {
      delete body.thinking;
      const { beta } = prepared.guessedThinking;
      if (beta) headers.set("anthropic-beta", beta);
      else headers.delete("anthropic-beta");
      console.log("gateway upstream refused guessed thinking; resending as the client sent it", { url: route.url });
      response = await send();
    }
  }
  return response;
}
