import type { Env, MemoryApiRecord } from "../../types";
import {
	fetchMemoriesWithLifecycleByIds,
} from "../../db/memories";
import { isProvenanceSelectionOn } from "../recallIntent";
import { toMemoryApiRecord } from "../search";
import type { RecallHit } from "../v2/recall";

export type CurrentState = { status: "outdated"; by: string; as_of: string };

export function isCurrentStateEnabled(env: Env) {
	return env.CURRENT_STATE_PROJECTION === "on" && isProvenanceSelectionOn(env);
}

export function currentStateIntent(query: string) {
	return {
		current:
			/现在|目前|当前|最新|\b(?:now|currently|at the moment|these days|latest)\b/i.test(
				query,
			),
	};
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
					completeness: row.provenance.completeness,
				}
			: undefined,
	};
}

async function findDecisions(
	env: Env,
	namespace: string,
	ids: string[],
	keys: string[],
) {
	const linked = ids.length
		? (await fetchMemoriesWithLifecycleByIds(env.DB, { namespace, ids })).map(
				({ record, lifecycle }) => ({
					...toMemoryApiRecord(record, undefined, lifecycle),
					backed: true,
				}),
			)
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
				(row.fact_key != null && keys.includes(row.fact_key))),
	);
}

export async function annotateCurrentState(
	env: Env,
	namespace: string,
	hits: RecallHit[],
	query: string,
	history: boolean,
	k: number,
) {
	if (!isCurrentStateEnabled(env)) return hits;
	const intent = currentStateIntent(query);
	const assistantView =
		/(?:助手|旦九|assistant|dan9).{0,16}(?:怎么想|觉得|喜欢|看法|prefer|like|think)|(?:怎么想|觉得|喜欢|看法).{0,16}(?:助手|旦九)/i.test(query);
	if (!hits.length && !intent.current) return hits;
	if (!hits.length) return hits;
	const nominated = hits.filter(
		(hit) => hit.source_layer === "memory" && hit.backed,
	);
	const rows = nominated.length
		? await env.DB.prepare(`WITH hits(id) AS (SELECT value FROM json_each(?2))
      SELECT d.id,lc.valid_as_of,
        CASE WHEN lc.valid_as_of > old.created_at AND old.id<>d.id THEN old.id END AS outdated_id,
        old.id AS linked_id,old.fact_key AS linked_fact_key
      FROM memories d JOIN memory_lifecycle lc ON lc.memory_id=d.id AND lc.namespace=d.namespace
      JOIN memories old ON old.namespace=d.namespace JOIN hits ON hits.id=old.id
      WHERE d.namespace=?1 AND d.status='active' AND d.type='decision' AND d.source='scoped_decision'
        AND (d.version_status IS NULL OR d.version_status IN ('current','under_review'))
        AND (d.id=old.id OR d.fact_key=old.fact_key OR EXISTS (
          SELECT 1 FROM json_each(d.provenance,'$.state_of') WHERE value=old.id
        ))
      ORDER BY lc.valid_as_of DESC,d.id`)
				.bind(namespace, JSON.stringify(nominated.map((hit) => hit.id)))
				.all<DecisionLink>()
		: { results: [] as DecisionLink[] };
	const currentIds = new Set<string>();
	const currentKeys = new Set<string>();
	for (const hit of nominated) {
		const decision = rows.results.find((row) => row.linked_id === hit.id);
		if (!decision) continue;
		if (decision.outdated_id === hit.id)
			hit.current_state = {
				status: "outdated",
				by: decision.id,
				as_of: decision.valid_as_of,
			};
		currentIds.add(decision.id);
		if (hit.fact_key?.startsWith("decision:user/"))
			currentKeys.add(hit.fact_key);
	}
	if (!intent.current)
		return assistantView
			? hits.filter((hit) => hit.source !== "scoped_decision")
			: hits;
	const decisions = await findDecisions(
		env,
		namespace,
		[...currentIds],
		[...currentKeys],
	);
	const active = new Map(decisions.map((row) => [row.id, decisionHit(row)]));
	const promoted = history || assistantView ? [] : [...active.values()];
	const seen = new Set(promoted.map((hit) => hit.id));
	const remaining = hits.flatMap((hit) => {
		if (assistantView && hit.source === "scoped_decision") return [];
		if (seen.has(hit.id)) return [];
		seen.add(hit.id);
		const current =
			hit.fact_key && decisions.find((row) => row.fact_key === hit.fact_key);
		if (current && hit.id !== current.id && !history) return [];
		if (current && hit.id !== current.id)
			hit.current_state = {
				status: "outdated",
				by: current.id,
				as_of: current.valid_as_of ?? "",
			};
		return [hit];
	});
	return [...promoted, ...remaining].slice(0, k);
}
