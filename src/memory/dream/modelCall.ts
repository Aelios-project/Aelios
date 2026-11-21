import { callOpenAICompat } from "../../proxy/openaiAdapter";
import type { Env, OpenAIChatRequest, OpenAIChatResponse } from "../../types";

// Includes waiting for headers AND reading the response body. A timeout is not automatically retried.
const DREAM_MODEL_TIMEOUT_MS = 120_000;

export class DreamModelTimeoutError extends Error {
  constructor() {
    super("Dream model call exceeded its deadline");
    this.name = "DreamModelTimeoutError";
  }
}

export async function callDreamModelJson(
  env: Env,
  request: OpenAIChatRequest,
  timeoutMs = DREAM_MODEL_TIMEOUT_MS
): Promise<{ ok: boolean; status: number; statusText: string; parsed?: OpenAIChatResponse }> {
  if (timeoutMs <= 0) throw new DreamModelTimeoutError();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DreamModelTimeoutError();
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  const operation = (async () => {
    const response = await callOpenAICompat(env, request, undefined, controller.signal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, status: response.status, statusText: response.statusText };
    }
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      parsed: await response.json() as OpenAIChatResponse
    };
  })();
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
