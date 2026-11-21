import { authenticate } from "../auth/apiKey";
import type { Env } from "../types";
import { openAiError } from "../utils/json";
import { handleMemoryRevisions } from "./transfer";
import {
  handleCreateMemory,
  handleDeleteMemory,
  handleExportMemories,
  handleGetMemory,
  handleListMemories,
  handlePatchMemory
} from "./memories/crud";
import { handleIngestMemories, handleRunDigest } from "./memories/ingest";
import { handleRecallMemories, handleSearchMemories } from "./memories/retrieval";

export { type ApprovedMemoryResult, handleMemoryCandidates } from "./memories/candidates";
export { handleIngestMessagesApi } from "./memories/ingest";
export { handleMemoryBoot, handleSearchMemoriesApi } from "./memories/retrieval";
export { handleDiaryApi, handleGlossaryApi, handleLongtailApi, handlePrecious } from "./memories/views";

export async function handleMemories(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const tail = parts.slice(2);

  if (tail.length === 0 && request.method === "GET") {
    return handleListMemories(request, env, auth.profile);
  }

  if (tail.length === 0 && request.method === "POST") {
    return handleCreateMemory(request, env, auth.profile);
  }

  if (tail.length === 1 && tail[0] === "search" && request.method === "POST") {
    return handleSearchMemories(request, env, auth.profile);
  }

  if (tail.length === 1 && tail[0] === "recall" && request.method === "POST") {
    return handleRecallMemories(request, env, auth.profile);
  }

  if (tail.length === 1 && (tail[0] === "digest" || tail[0] === "dream") && request.method === "POST") {
    return handleRunDigest(request, env, auth.profile);
  }

  if (tail.length === 1 && tail[0] === "ingest" && request.method === "POST") {
    return handleIngestMemories(request, env, ctx, auth.profile);
  }

  if (tail.length === 1 && tail[0] === "export" && request.method === "GET") {
    return handleExportMemories(request, env, auth.profile);
  }

  if (tail.length === 2 && tail[1] === "revisions" && request.method === "GET") {
    return handleMemoryRevisions(request, env, auth.profile, tail[0]);
  }

  if (tail.length === 1) {
    const id = tail[0];
    if (request.method === "GET") return handleGetMemory(request, env, auth.profile, id);
    if (request.method === "PATCH") return handlePatchMemory(request, env, auth.profile, id);
    if (request.method === "DELETE") return handleDeleteMemory(request, env, auth.profile, id);
  }

  return openAiError("Not found", 404);
}
