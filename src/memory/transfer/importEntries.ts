// 导入整理好的条目 (md / jsonl / 别处导出的 json)。
//
// 两种做法：
// - direct：直接写进库。带 fact_key 的按 key 写 (改过的会改写，旧版留在 memory_revisions)；
//   跟库里一字不差的跳过；跟库里某条很像的不硬写，排进审核页「导入的」等人定；其余新建。
// - review：全部排进审核页「导入的」，一条条过。
// 「珍贵」的条目两种做法都直接收进珍贵 (那是人亲手标的，不过审核)，一字不差的跳过。
//
// 导入的记忆 created_at 用原来的日期，updated_at 是现在：过期按 updated_at 算，不能一导进来就过期。

import { importOrigin } from "../provenance";
import { createImportCandidate, createPrecious, upsertMemoryByFactKey } from "../../db/v2";
import type { Env } from "../../types";
import { sha256Hex } from "../../utils/hash";
import { findSimilarActiveMemory } from "../dedupGate";
import type { ImportEntry } from "./memoryText";

export type EntryImportMode = "direct" | "review";
export type EntryImportAction = "created" | "updated" | "unchanged" | "duplicate" | "queued" | "precious" | "failed";

export interface EntryImportItem {
  index: number;
  action: EntryImportAction;
  memory_id?: string;
  candidate_id?: string;
  target_memory_id?: string;
  error?: string;
}

export interface EntryImportResult {
  counts: Record<EntryImportAction, number>;
  items: EntryImportItem[];
}

/** 直接导入写进 memories.source 的值。 */
export const ENTRY_IMPORT_SOURCE = "import";

function emptyCounts(): Record<EntryImportAction, number> {
  return { created: 0, updated: 0, unchanged: 0, duplicate: 0, queued: 0, precious: 0, failed: 0 };
}

/** 条目的日期 → created_at。只有日期的取当天正午 (UTC)，前后十一个时区里都还是那一天。 */
export function entryCreatedAt(entry: Pick<ImportEntry, "createdAt" | "date">): string | null {
  if (entry.createdAt) {
    const parsed = new Date(entry.createdAt);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (entry.date && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
    const parsed = new Date(`${entry.date}T12:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

/** 没带 fact_key 的条目用内容哈希当 key：同一条再导一次落到同一条上，不会多出一份。 */
export async function generatedImportFactKey(type: string, content: string): Promise<string> {
  const hash = await sha256Hex(content.trim());
  return `import:${type}:${hash.slice(0, 12)}`;
}

async function findExactActive(env: Env, namespace: string, contents: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const unique = [...new Set(contents)];
  for (let index = 0; index < unique.length; index += 80) {
    const batch = unique.slice(index, index + 80);
    const result = await env.DB
      .prepare(
        `SELECT id, content FROM memories
         WHERE namespace = ? AND status = 'active'
           AND (version_status IS NULL OR version_status != 'superseded')
           AND content IN (${batch.map(() => "?").join(", ")})`
      )
      .bind(namespace, ...batch)
      .all<{ id: string; content: string }>();
    for (const row of result.results ?? []) found.set(row.content, row.id);
  }
  return found;
}

async function findByFactKeys(env: Env, namespace: string, keys: string[]): Promise<Map<string, { id: string; content: string }>> {
  const found = new Map<string, { id: string; content: string }>();
  const unique = [...new Set(keys)];
  for (let index = 0; index < unique.length; index += 40) {
    const batch = unique.slice(index, index + 40);
    const marks = batch.map(() => "?").join(", ");
    const result = await env.DB
      .prepare(
        `SELECT m.id, m.content, COALESCE(m.fact_key, lc.fact_key) AS fact_key
         FROM memories m
         LEFT JOIN memory_lifecycle lc ON lc.memory_id = m.id
         WHERE m.namespace = ? AND m.status = 'active'
           AND (m.version_status IS NULL OR m.version_status != 'superseded')
           AND (m.fact_key IN (${marks}) OR (m.fact_key IS NULL AND lc.fact_key IN (${marks})))
         ORDER BY m.updated_at DESC`
      )
      .bind(namespace, ...batch, ...batch)
      .all<{ id: string; content: string; fact_key: string }>();
    for (const row of result.results ?? []) {
      if (!found.has(row.fact_key)) found.set(row.fact_key, { id: row.id, content: row.content });
    }
  }
  return found;
}

/** 已经排在审核页「导入的」里、还没批的同样正文：再导一次不重复排，也不绕过审核直接写。 */
async function findPendingImported(env: Env, namespace: string, contents: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const unique = [...new Set(contents)];
  for (let index = 0; index < unique.length; index += 80) {
    const batch = unique.slice(index, index + 80);
    const result = await env.DB
      .prepare(
        `SELECT c.id, c.content FROM memory_candidates c
         JOIN memory_import_candidates ic ON ic.candidate_id = c.id
         WHERE c.namespace = ? AND c.status = 'pending' AND c.content IN (${batch.map(() => "?").join(", ")})`
      )
      .bind(namespace, ...batch)
      .all<{ id: string; content: string }>();
    for (const row of result.results ?? []) found.set(row.content, row.id);
  }
  return found;
}

async function findExactPrecious(env: Env, namespace: string, contents: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = [...new Set(contents)];
  for (let index = 0; index < unique.length; index += 80) {
    const batch = unique.slice(index, index + 80);
    const result = await env.DB
      .prepare(`SELECT content FROM precious WHERE namespace = ? AND content IN (${batch.map(() => "?").join(", ")})`)
      .bind(namespace, ...batch)
      .all<{ content: string }>();
    for (const row of result.results ?? []) found.add(row.content);
  }
  return found;
}

/**
 * 导一小批条目 (后台页面一次送二十来条，D1 一次请求能做的子请求有限)。
 * startIndex 是这批第一条在整份里的序号，回报里的 index 用整份的序号。
 */
export async function importMemoryEntries(
  env: Env,
  input: {
    namespace: string;
    importId: string;
    entries: ImportEntry[];
    mode: EntryImportMode;
    startIndex?: number;
  }
): Promise<EntryImportResult> {
  const counts = emptyCounts();
  const items: EntryImportItem[] = [];
  const start = input.startIndex ?? 0;
  const memoryEntries = input.entries.filter((entry) => entry.kind !== "precious");
  const preciousEntries = input.entries.filter((entry) => entry.kind === "precious");

  const [exact, byKey, exactPrecious, pending] = await Promise.all([
    findExactActive(env, input.namespace, memoryEntries.map((entry) => entry.content)),
    findByFactKeys(env, input.namespace, memoryEntries.flatMap((entry) => (entry.factKey ? [entry.factKey] : []))),
    findExactPrecious(env, input.namespace, preciousEntries.map((entry) => entry.content)),
    findPendingImported(env, input.namespace, memoryEntries.map((entry) => entry.content))
  ]);

  const push = (item: EntryImportItem) => {
    counts[item.action] += 1;
    items.push(item);
  };

  for (const [offset, entry] of input.entries.entries()) {
    const index = start + offset;
    try {
      const createdAt = entryCreatedAt(entry);

      if (entry.kind === "precious") {
        if (exactPrecious.has(entry.content)) {
          push({ index, action: "duplicate" });
          continue;
        }
        const row = await createPrecious(env.DB, {
          namespace: input.namespace,
          content: entry.content,
          source: ENTRY_IMPORT_SOURCE,
          createdAt
        });
        exactPrecious.add(entry.content);
        push({ index, action: "precious", memory_id: row.id });
        continue;
      }

      const type = entry.type ?? "fact";
      const keyed = entry.factKey ? byKey.get(entry.factKey) ?? null : null;

      // 同 key 的那条正文一样：什么都不用做。
      if (keyed && keyed.content.trim() === entry.content.trim()) {
        push({ index, action: "unchanged", memory_id: keyed.id });
        continue;
      }
      // 没带 key、库里有一字不差的：跳过。
      const sameId = exact.get(entry.content);
      if (!entry.factKey && sameId) {
        push({ index, action: "duplicate", memory_id: sameId });
        continue;
      }
      // 一样的正文已经在审核页等着：不重复排。
      const waiting = pending.get(entry.content);
      if (waiting) {
        push({ index, action: "queued", candidate_id: waiting });
        continue;
      }

      // 没带 key 时看看库里有没有很像的：有就不硬写，交给人定 (审核页会把两条并排给看)。
      let similarId: string | null = null;
      if (!keyed && !sameId) {
        const hit = await findSimilarActiveMemory(env, { namespace: input.namespace, content: entry.content });
        similarId = hit?.memory.id ?? null;
      }

      if (input.mode === "review" || (!entry.factKey && similarId)) {
        const { candidate } = await createImportCandidate(env.DB, {
          namespace: input.namespace,
          importId: input.importId,
          source: "import_entries",
          type,
          content: entry.content,
          factKey: entry.factKey,
          confidence: entry.confidence ?? 0.8,
          importance: entry.importance ?? 0.6,
          tags: entry.tags,
          sourceMessageIds: [],
          targetMemoryId: keyed?.id ?? similarId ?? sameId ?? null,
          decisionNote: similarId && !keyed ? `import: similar to ${similarId}` : null,
          day: entry.date ?? (createdAt ? createdAt.slice(0, 10) : null)
        });
        pending.set(entry.content, candidate.id);
        push({ index, action: "queued", candidate_id: candidate.id, target_memory_id: keyed?.id ?? similarId ?? sameId ?? undefined });
        continue;
      }

      const factKey = entry.factKey ?? (await generatedImportFactKey(type, entry.content));
      const result = await upsertMemoryByFactKey(env, {
        namespace: input.namespace,
        factKey,
        type,
        content: entry.content,
        importance: entry.importance ?? 0.6,
        confidence: entry.confidence ?? 0.8,
        tags: entry.tags,
        source: ENTRY_IMPORT_SOURCE,
        provenance: importOrigin,
        sourceMessageIds: [],
        createdAt,
        pinned: entry.pinned
      });
      exact.set(entry.content, result.id);
      byKey.set(factKey, { id: result.id, content: entry.content });
      push({ index, action: result.created ? "created" : "updated", memory_id: result.id });
    } catch (error) {
      console.error("memory import: entry failed", { namespace: input.namespace, index, error });
      push({ index, action: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { counts, items };
}
