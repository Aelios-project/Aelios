import { authenticate } from "../auth/apiKey";
import type { Env, KeyProfile } from "../types";
import { json } from "../utils/json";
import { isRecord } from "../utils/request";
import { handleCoreTool } from "./mcp/handlers/core";
import { handleMemoryTool } from "./mcp/handlers/memories";
import { handleReviewTool } from "./mcp/handlers/review";
import {
  type JsonRpcRequest,
  rpcError,
  rpcErrorResponse,
  rpcResult,
  type ToolCallParams,
  toolError,
  withTokenQuery
} from "./mcp/protocol";
import { getTools, MEMORY_GUIDE, RENAMED_TOOLS, type ToolListOptions, toolListOptions } from "./mcp/tools";

export { MEMORY_GUIDE };

async function callTool(
  env: Env,
  ctx: ExecutionContext,
  profile: KeyProfile,
  params: ToolCallParams
): Promise<Record<string, unknown>> {
  const args = isRecord(params.arguments) ? params.arguments : {};
  const requested = typeof params.name === "string" ? params.name : "";
  const name = RENAMED_TOOLS.get(requested) ?? requested;

  const coreResult = await handleCoreTool(name, requested, args, env, ctx, profile);
  if (coreResult) return coreResult;

  const memoryResult = await handleMemoryTool(name, requested, args, env, ctx, profile, (nextParams) => callTool(env, ctx, profile, nextParams));
  if (memoryResult) return memoryResult;

  const reviewResult = await handleReviewTool(name, args, env, profile);
  if (reviewResult) return reviewResult;

  return toolError(`Unknown tool: ${requested}`);
}

async function handleRpc(
  request: JsonRpcRequest,
  env: Env,
  ctx: ExecutionContext,
  profile: KeyProfile,
  listOptions: ToolListOptions
): Promise<Record<string, unknown> | null> {
  if (!request.id && request.method?.startsWith("notifications/")) return null;

  if (request.method === "initialize") {
    return rpcResult(request.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "companion-memory-mcp", version: "0.1.0" },
      instructions: MEMORY_GUIDE
    });
  }

  if (request.method === "tools/list") {
    return rpcResult(request.id, { tools: getTools(listOptions) });
  }

  if (request.method === "resources/list") {
    return rpcResult(request.id, { resources: [] });
  }

  if (request.method === "prompts/list") {
    return rpcResult(request.id, { prompts: [] });
  }

  if (request.method === "tools/call") {
    const params = isRecord(request.params) ? (request.params as ToolCallParams) : {};
    const result = await callTool(env, ctx, profile, params);
    return rpcResult(request.id, result);
  }

  if (request.method === "ping") {
    return rpcResult(request.id, {});
  }

  return rpcError(request.id, -32601, "Method not found");
}

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (request.method === "GET") {
    return json({
      name: "companion-memory-mcp",
      transport: "streamable-http",
      endpoint: new URL(request.url).pathname,
      tools: getTools(toolListOptions(env, new URL(request.url))).map((tool) => tool.name)
    });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const auth = await authenticate(withTokenQuery(request), env);
  if (!auth.ok) return rpcErrorResponse(null, -32001, "Unauthorized", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpcErrorResponse(null, -32700, "Parse error", 400);
  }

  const listOptions = toolListOptions(env, new URL(request.url));

  if (Array.isArray(body)) {
    const results = (
      await Promise.all(
        body
          .filter((item): item is JsonRpcRequest => isRecord(item))
          .map((item) => handleRpc(item, env, ctx, auth.profile, listOptions))
      )
    ).filter((item): item is Record<string, unknown> => item !== null);
    return results.length > 0 ? json(results) : new Response(null, { status: 202 });
  }

  if (!isRecord(body)) return rpcErrorResponse(null, -32600, "Invalid Request", 400);

  const result = await handleRpc(body, env, ctx, auth.profile, listOptions);
  return result ? json(result) : new Response(null, { status: 202 });
}
