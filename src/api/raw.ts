import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import { cleanRawMessage, invalidateKnownInputs } from "../db/v2/revocation";
import type { Env } from "../types";
import { json, openAiError } from "../utils/json";
import { resolveNamespace } from "../utils/request";

// 原话：后台首页「今天的对话」那一条条。DELETE /v1/raw/<id> 删掉一句（clean，默认）；
// ?mode=withdraw 同时撤回已知衍生记忆，并列出只是同批读过、因而保留的旧记忆。
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
    if (mode === "clean") {
      if (!await cleanRawMessage(env.DB, namespace, id)) return openAiError("Message not found", 404);
      return json({ data: { id, deleted: true } });
    }
    const report = await invalidateKnownInputs(env, { namespace, id }, "message");
    if (!report) return openAiError("Message not found", 404);
    return json({ data: { id, deleted: true, withdrawn_memories: report.withdrawn, unverified_memories: report.unverified } });
  } catch { return openAiError("Source cleanup incomplete; retry deletion", 503); }
}
