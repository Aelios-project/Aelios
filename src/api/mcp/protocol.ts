import type { KeyProfile, Scope } from "../../types";
import { json } from "../../utils/json";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

export interface ToolCallParams {
  name?: unknown;
  arguments?: unknown;
}


export function withTokenQuery(request: Request): Request {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token || request.headers.has("authorization")) return request;

  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  return new Request(request.url, { headers });
}

export function hasScope(profile: KeyProfile, scope: Scope): boolean {
  return profile.scopes.includes(scope);
}

export function rpcResult(id: JsonRpcId | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function rpcError(id: JsonRpcId | undefined, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message }
  };
}

export function textToolResult(data: unknown): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2)
      }
    ],
    structuredContent: data
  };
}

export function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    isError: true
  };
}


export function rpcErrorResponse(id: JsonRpcId | undefined, code: number, message: string, status: number): Response {
  return json(rpcError(id, code, message), { status });
}
