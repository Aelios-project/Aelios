/**
 * Shared model call helper: single retry+backoff loop used by the nightly
 * memory jobs (weekly/monthly rollup, diary writer, candidate judge).
 *
 * Returns the raw model text (content, falling back to reasoning_content).
 * Callers keep their own JSON parsing, result normalization and model-name
 * resolution. Throws after the final retry.
 */
import { dreamOutputLimit } from "../memory/dreamEnv";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, OpenAIChatRequest, OpenAIChatResponse } from "../types";

export const MODEL_RETRY_BACKOFF_MS = [2000, 8000];

const DEFAULT_SYSTEM_PROMPT = "You are a strict JSON generator. Output valid JSON only, with no markdown fences and no reasoning.";

export interface ModelCallRequest {
  model: string;
  prompt: string;
  maxTokens?: number;
  backoffMs?: number[]; // default [2000, 8000]; pass [] for a single attempt
  systemPrompt?: string; // default JSON-generator system prompt
  logPrefix?: string; // default "model_call"
  logMeta?: Record<string, unknown>;
}

export class ModelCallError extends Error {
  readonly status?: number;
  // What the upstream said, e.g. "3036: You have used up your daily free allocation".
  // A Workers AI failure always reaches us as a bare 500, so this is the only place
  // the actual reason survives.
  readonly detail?: string;

  constructor(message: string, status?: number, detail?: string) {
    super(detail ? `${message}: ${detail}` : message);
    this.name = "ModelCallError";
    this.status = status;
    this.detail = detail;
  }
}

const ERROR_DETAIL_MAX_CHARS = 500;

// Pull the error text out of a non-ok response: the `error.message` of a JSON body
// when there is one, otherwise the raw text, clipped.
export async function readModelErrorDetail(response: Response): Promise<string | undefined> {
  let text: string;
  try {
    text = (await response.text()).trim();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; errors?: unknown };
    const error = parsed.error;
    if (typeof error === "string" && error.trim()) text = error.trim();
    else if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
      text = (error as { message: string }).message.trim() || text;
    } else if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      text = JSON.stringify(parsed.errors);
    }
  } catch {
    // not JSON; keep the raw text
  }
  return text.length > ERROR_DETAIL_MAX_CHARS ? `${text.slice(0, ERROR_DETAIL_MAX_CHARS)}…` : text;
}

/**
 * Read the first non-empty string env var from `keys`, else `fallback`.
 * Callers still own which keys/fallback to use — the original model readers
 * were near-identical but not byte-identical, so only this lookup pattern is unified.
 */
export function readModelName(env: Env, keys: string[], fallback: string): string {
  const record = env as unknown as Record<string, unknown>;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableModelStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function callModelWithRetry(env: Env, req: ModelCallRequest): Promise<string> {
  const backoffMs = req.backoffMs ?? MODEL_RETRY_BACKOFF_MS;
  const logPrefix = req.logPrefix ?? "model_call";
  const maxAttempts = 1 + backoffMs.length;
  const startedAt = Date.now();

  const request: OpenAIChatRequest = {
    model: req.model,
    messages: [
      { role: "system", content: req.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: req.prompt }
    ],
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : dreamOutputLimit(env, req.model)),
    response_format: { type: "json_object" },
    stream: false
  };

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      const waitMs = backoffMs[attempt - 1] ?? backoffMs.at(-1) ?? 8000;
      console.warn(`${logPrefix}: retrying model call after non-ok response`, {
        ...req.logMeta,
        model: req.model,
        attempt: attempt + 1,
        maxAttempts,
        backoffMs: waitMs
      });
      await delay(waitMs);
    }

    try {
      const response = await callOpenAICompat(env, request);
      const elapsedMs = Date.now() - startedAt;
      if (!response.ok) {
        const retriable = isRetriableModelStatus(response.status);
        const detail = await readModelErrorDetail(response);
        console.error(`${logPrefix}: model returned non-ok`, {
          ...req.logMeta,
          model: req.model,
          status: response.status,
          statusText: response.statusText,
          detail,
          elapsedMs,
          attempt: attempt + 1,
          retriable
        });
        if (retriable && attempt < maxAttempts - 1) continue;
        throw new ModelCallError(`model returned status ${response.status}`, response.status, detail);
      }

      const parsed = (await response.json()) as OpenAIChatResponse;
      const message = parsed.choices?.[0]?.message as
        | ({ content?: unknown; reasoning_content?: unknown })
        | undefined;
      const content = typeof message?.content === "string" ? message.content.trim() : "";
      const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
      return content || reasoning;
    } catch (error) {
      if (error instanceof ModelCallError) throw error;
      const elapsedMs = Date.now() - startedAt;
      const message = error instanceof Error && error.message ? error.message : String(error);
      console.error(`${logPrefix} model failed`, {
        ...req.logMeta,
        model: req.model,
        elapsedMs,
        attempt: attempt + 1,
        error: message
      });
      if (attempt < maxAttempts - 1) continue;
      throw error;
    }
  }

  throw new ModelCallError("model call failed after retries");
}
