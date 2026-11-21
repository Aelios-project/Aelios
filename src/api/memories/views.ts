import { getYesterdayDateLabel } from "../../memory/dreamDates";
import { withImpressionDisclaimer } from "../../memory/impression";
import { readPositiveInt } from "../../utils/request";
import { authenticate } from "../../auth/apiKey";
import { requireScope } from "../../auth/scopes";
import {
  createPrecious,
  deleteGlossary,
  deleteLongtail,
  deletePrecious,
  getDailyLog,
  listGlossary,
  listPrecious,
  updateGlossary,
  upsertGlossary
} from "../../db/v2";
import type { Env } from "../../types";
import { json, openAiError } from "../../utils/json";
import { formatDateLabel } from "../../utils/time";
import {
  readJsonObject,
  readString,
  readStringArray,
  resolveNamespace
} from "../../utils/request";
import { readDiaryTimeZone } from "./shared";

export async function handleDiaryApi(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  if (request.method !== "GET") return openAiError("Not found", 404);

  const scopeError = requireScope(auth.profile, "memory:read");
  if (scopeError) return scopeError;

  const url = new URL(request.url);
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));
  const timeZone = readDiaryTimeZone(env);

  if (url.pathname === "/v1/diary/recent") {
    const today = formatDateLabel(new Date(), timeZone);
    const yesterday = getYesterdayDateLabel(timeZone);
    const rows = await Promise.all([
      getDailyLog(env.DB, { namespace, date: today }),
      getDailyLog(env.DB, { namespace, date: yesterday })
    ]);
    const data = rows
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .map((row) => withImpressionDisclaimer({ ...row }));
    return json({ data });
  }

  const date = readString(url.searchParams.get("date"));
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return openAiError("date query parameter is required (YYYY-MM-DD)", 400);
  }

  const row = await getDailyLog(env.DB, { namespace, date });
  if (!row) {
    return json({ data: null }, { status: 404 });
  }
  return json({ data: withImpressionDisclaimer({ ...row }) });
}

export async function handlePrecious(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const url = new URL(request.url);
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2];

  if (request.method === "GET" && !id) {
    const scopeError = requireScope(auth.profile, "memory:read");
    if (scopeError) return scopeError;
    const rows = await listPrecious(env.DB, { namespace, limit: readPositiveInt(url.searchParams.get("limit"), 100, 200) });
    return json({ data: rows });
  }

  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  if (request.method === "POST" && !id) {
    const body = await readJsonObject(request);
    if (!body) return openAiError("Request body must be a JSON object", 400);
    const content = readString(body.content);
    if (!content) return openAiError("content is required", 400);
    const row = await createPrecious(env.DB, {
      namespace: resolveNamespace(auth.profile, body.namespace),
      content,
      contextMessageIds: readStringArray(body.context_message_ids),
      source: readString(body.source) || "human"
    });
    return json({ data: row }, { status: 201 });
  }

  if (request.method === "DELETE" && id) {
    const deleted = await deletePrecious(env.DB, { namespace, id });
    if (!deleted) return openAiError("Precious memory not found", 404);
    return json({ data: { id, deleted: true } });
  }

  return openAiError("Not found", 404);
}

export async function handleGlossaryApi(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const url = new URL(request.url);
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2];

  if (request.method === "GET" && !id) {
    const scopeError = requireScope(auth.profile, "memory:read");
    if (scopeError) return scopeError;
    const rows = await listGlossary(env.DB, {
      namespace,
      status: readString(url.searchParams.get("status")) || "active"
    });
    return json({ data: rows });
  }

  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  if (request.method === "POST" && !id) {
    const body = await readJsonObject(request);
    if (!body) return openAiError("Request body must be a JSON object", 400);
    const term = readString(body.term);
    const definition = readString(body.definition);
    if (!term || !definition) return openAiError("term and definition are required", 400);
    const row = await upsertGlossary(env.DB, {
      namespace: resolveNamespace(auth.profile, body.namespace),
      term,
      aliases: readStringArray(body.aliases),
      definition,
      examples: readStringArray(body.examples)
    });
    return json({ data: row });
  }

  if (request.method === "PATCH" && id) {
    const body = await readJsonObject(request);
    if (!body) return openAiError("Request body must be a JSON object", 400);
    const row = await updateGlossary(env.DB, {
      namespace: resolveNamespace(auth.profile, body.namespace),
      id,
      term: readString(body.term),
      aliases: Array.isArray(body.aliases) ? readStringArray(body.aliases) : undefined,
      definition: readString(body.definition),
      examples: Array.isArray(body.examples) ? readStringArray(body.examples) : undefined,
      status: readString(body.status)
    });
    if (!row) return openAiError("Glossary term not found", 404);
    return json({ data: row });
  }

  if (request.method === "DELETE" && id) {
    const deleted = await deleteGlossary(env.DB, { namespace, id });
    if (!deleted) return openAiError("Glossary term not found", 404);
    return json({ data: { id, deleted: true } });
  }

  return openAiError("Not found", 404);
}

export async function handleLongtailApi(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  const url = new URL(request.url);
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2];

  if (request.method !== "DELETE" || !id) return openAiError("Not found", 404);

  const result = await deleteLongtail(env, { namespace, id });
  if (result === "not_found") return openAiError("Longtail entry not found", 404);
  if (result === "vector_error") {
    return openAiError("Longtail vector delete failed", 503, "memory_error");
  }
  return json({ data: { id, deleted: true } });
}

