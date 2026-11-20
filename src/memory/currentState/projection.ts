import { fetchMemoriesWithLifecycleByIds } from "../../db/memories";
import { assistantNameOf, identityNamespace, loadConfig } from "../../gateway/config";
import type { Env, MemoryApiRecord } from "../../types";
import { asksAssistantView, isProvenanceSelectionOn, mentionsPreference, readRecallIntent, type RecallIntent } from "../recallIntent";
import { toMemoryApiRecord } from "../search";
import type { RecallHit } from "../v2/recall";

export type CurrentState = { status: "outdated"; by: string; as_of: string };

export function isCurrentStateEnabled(
  env: Pick<Env, "CURRENT_STATE_PROJECTION" | "RECALL_PROVENANCE_SELECTION">
): boolean {
  const raw = (env.CURRENT_STATE_PROJECTION ?? "off").trim().toLowerCase();
  return (raw === "on" || raw === "true" || raw === "1") && isProvenanceSelectionOn(env);
}

async function loadAssistantName(env: Env, namespace: string): Promise<string | null> {
  try {
    const identities = (await loadConfig(env)).identities.filter((item) => identityNamespace(item) === namespace);
    const named = identities.find((item) => item.userName?.trim()) ?? identities[0];
    return named ? assistantNameOf(named) : null;
  } catch {
    return null;
  }
}

/**
 * A configured name can only add an assistant subject, so the config is read only when the
 * wording alone does not already settle it and the question mentions a preference at all.
 * `assistantName` undefined means the caller does not know it (MCP, REST); null means none.
 */
async function readIntent(env: Env, namespace: string, query: string, assistantName?: string | null): Promise<RecallIntent> {
  const intent = readRecallIntent(env, query, assistantName);
  if (assistantName !== undefined || intent.asksAssistantView || !mentionsPreference(query)) return intent;
  return { ...intent, asksAssistantView: asksAssistantView(query, await loadAssistantName(env, namespace)) };
}

interface DecisionLink {
  id: string;
  valid_as_of: string;
  outdated_id: string | null;
  linked_id: string;
  linked_fact_key: string | null;
}

function decisionHit(row: MemoryApiRecord): RecallHit {
  return {
    id: row.id,
    content: row.content,
    type: row.type,
    score: 1,
    kind: "memory",
    source_layer: "memory",
    source: row.source ?? null,
    backed: true,
    version_status: row.version_status,
    recorded_date: row.created_at,
    event_date: row.valid_as_of,
    fact_key: row.fact_key,
    source_message_ids: row.source_message_ids,
    provenance: row.provenance
      ? {
          creation_mode: row.provenance.creation_mode,
          recording_actor: row.provenance.recording_actor,
          attributed_actor: row.provenance.attributed_actor,
          claimed_author: row.provenance.claimed_author,
          evidence_relation: row.provenance.evidence_relation,
          completeness: row.provenance.completeness
        }
      : undefined
  };
}

function isUserScopedDecision(hit: RecallHit): boolean {
  return hit.source === "scoped_decision" && hit.provenance?.attributed_actor !== "assistant";
}

async function findDecisions(
  env: Env,
  namespace: string,
  ids: string[],
  keys: string[]
) {
  const linked = ids.length
    ? (await fetchMemoriesWithLifecycleByIds(env.DB, { namespace, ids })).map(({ record, lifecycle }) => ({
        ...toMemoryApiRecord(record, undefined, lifecycle),
        backed: true
      }))
    : [];
  return linked.filter(
    (row) =>
      row.backed &&
      row.source === "scoped_decision" &&
      row.status === "active" &&
      row.version_status !== "superseded" &&
      row.provenance?.attributed_actor === "user" &&
      ((!ids.length && !keys.length) ||
        ids.includes(row.id) ||
        (row.fact_key != null && keys.includes(row.fact_key)))
  );
}

export async function annotateCurrentState(
  env: Env,
  namespace: string,
  hits: RecallHit[],
  query: string,
  history: boolean,
  k: number,
  assistantName?: string | null
): Promise<RecallHit[]> {
  if (!isCurrentStateEnabled(env) || !hits.length) return hits;

  const intent = await readIntent(env, namespace, query, assistantName);

  const nominated = hits.filter((hit) => hit.source_layer === "memory" && hit.backed);
  const rows = nominated.length
    ? await env.DB.prepare(
        `WITH hits(id) AS (SELECT value FROM json_each(?2))
         SELECT d.id, lc.valid_as_of,
           CASE WHEN lc.valid_as_of > old.created_at AND old.id <> d.id THEN old.id END AS outdated_id,
           old.id AS linked_id, old.fact_key AS linked_fact_key
         FROM memories d
         JOIN memory_lifecycle lc ON lc.memory_id = d.id AND lc.namespace = d.namespace
         JOIN memories old ON old.namespace = d.namespace
         JOIN hits ON hits.id = old.id
         WHERE d.namespace = ?1
           AND d.status = 'active'
           AND d.type = 'decision'
           AND d.source = 'scoped_decision'
           AND (d.version_status IS NULL OR d.version_status IN ('current', 'under_review'))
           AND (d.id = old.id OR d.fact_key = old.fact_key OR EXISTS (
             SELECT 1 FROM json_each(d.provenance, '$.state_of') WHERE value = old.id
           ))
         ORDER BY lc.valid_as_of DESC, d.id`
      )
        .bind(namespace, JSON.stringify(nominated.map((hit) => hit.id)))
        .all<DecisionLink>()
    : { results: [] as DecisionLink[] };

  const currentIds = new Set<string>();
  const currentKeys = new Set<string>();
  for (const hit of nominated) {
    const decision = rows.results.find((row) => row.linked_id === hit.id);
    if (!decision) continue;
    if (decision.outdated_id === hit.id) {
      hit.current_state = { status: "outdated", by: decision.id, as_of: decision.valid_as_of };
    }
    currentIds.add(decision.id);
    if (hit.fact_key?.startsWith("decision:user/")) currentKeys.add(hit.fact_key);
  }

  if (intent.asksAssistantView) {
    return hits.filter((hit) => !isUserScopedDecision(hit)).slice(0, k);
  }
  if (!intent.asksCurrent || intent.asksPastOrView) {
    return hits;
  }

  const decisions = await findDecisions(env, namespace, [...currentIds], [...currentKeys]);
  const active = new Map(decisions.map((row) => [row.id, decisionHit(row)]));
  const promoted = history ? [] : [...active.values()];
  const seen = new Set(promoted.map((hit) => hit.id));
  const remaining = hits.flatMap((hit) => {
    if (seen.has(hit.id)) return [];
    seen.add(hit.id);
    const current = hit.fact_key && decisions.find((row) => row.fact_key === hit.fact_key);
    if (current && hit.id !== current.id && !history) return [];
    if (current && hit.id !== current.id) {
      hit.current_state = { status: "outdated", by: current.id, as_of: current.valid_as_of ?? "" };
    }
    return [hit];
  });
  return [...promoted, ...remaining].slice(0, k);
}
