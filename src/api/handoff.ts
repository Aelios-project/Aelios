import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import { HANDOFF_GUIDE, HandoffError, handoffRevision, readHandoff, validateHandoff, writeHandoff } from "../db/v2/handoff";
import type { Env } from "../types";
import { json, openAiError } from "../utils/json";
import { readJsonObject, resolveNamespace } from "../utils/request";

export async function handleHandoffApi(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  const scopeError = requireScope(auth.profile, request.method === "GET" ? "memory:read" : "memory:write");
  if (scopeError) return scopeError;
  const url = new URL(request.url);
  const headers = { "cache-control": "no-store" };
  try {
    if (request.method === "GET") {
      return json({ data: await readHandoff(env.DB, resolveNamespace(auth.profile, url.searchParams.get("namespace"))), writing_guide: HANDOFF_GUIDE }, { headers });
    }
    if (request.method === "PUT" || request.method === "DELETE") {
      const body = await readJsonObject(request);
      if (!body) return openAiError("Request body must be a JSON object", 400);
      const data = await writeHandoff(env.DB, {
        namespace: resolveNamespace(auth.profile, body.namespace ?? url.searchParams.get("namespace")),
        content: request.method === "DELETE" ? null : validateHandoff(body.content),
        expectedRevision: handoffRevision(body.expected_revision), source: "human"
      });
      return json({ data }, { headers });
    }
    return openAiError("Method not allowed", 405);
  } catch (error) {
    if (error instanceof HandoffError) return openAiError(error.message, error.status);
    throw error;
  }
}
