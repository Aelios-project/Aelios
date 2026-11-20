import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import { cleanRawMessage, invalidateKnownInputs } from "../db/v2/revocation";
import type { Env } from "../types";
import { json, openAiError } from "../utils/json";
import { resolveNamespace } from "../utils/request";

// 原话：后台首页「今天的对话」那一条条。DELETE /v1/raw/<id> 删掉一句。
export async function handleRawMessage(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  const url = new URL(request.url);
  let id = "";
  try { id = decodeURIComponent(url.pathname.split("/").filter(Boolean)[2] ?? ""); }
  catch { id = ""; }
  if (request.method !== "DELETE" || !id) return openAiError("Not found", 404);
  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));
  const mode = url.searchParams.get("mode") ?? "clean";
  if (mode !== "withdraw" && mode !== "clean") return openAiError("Unknown deletion mode", 400);
  try {
    const removed = mode === "withdraw"
      ? await invalidateKnownInputs(env, { namespace, id }, "message")
      : await cleanRawMessage(env.DB, namespace, id);
    if (!removed) return openAiError("Message not found", 404);
  } catch { return openAiError("Source cleanup incomplete; retry deletion", 503); }
  return json({ data: { id, deleted: true } });
}
