import assert from "node:assert/strict";
import { test } from "node:test";
import { applyScopedDecision } from "../src/memory/currentState/apply";
import { extractDecisionFallback } from "../src/memory/currentState/extract";
import { annotateCurrentState } from "../src/memory/currentState/projection";
import { queueDreamExtractedMemories } from "../src/memory/dream/judgePhase";
import { runRecall } from "../src/memory/v2/recall";
import { invalidateKnownInputs } from "../src/db/v2/revocation";
import type { ExtractedMemory } from "../src/memory/extract";
import type { Env, MessageRecord } from "../src/types";
import { sqliteFixture } from "./support/sqlite";

function candidate(
	id: string,
	value: string,
	state_of: string[] = [],
): ExtractedMemory {
	return {
		type: "decision",
		content: `用户决定 Aelios 的 integration 采用 ${value}。`,
		attributed_role: "user",
		evidence_quote: `我决定就用 ${value}。`,
		source_message_ids: [id],
		tags: [],
		confidence: 0.9,
		importance: 0.8,
		decision: { scope_key: "user/aelios/integration", value, state_of },
	};
}

test("current decision uses citation time, preserves authored wording, and does not resurrect after withdrawal", async (t) => {
	const { sqlite, db } = sqliteFixture(t);
	const env = { DB: db, CURRENT_STATE_PROJECTION: "on" };
	const authored = "咲咲决定用 SDK，我总算松了口气。";
	sqlite.exec(`INSERT INTO memories(id,namespace,type,source,content,authored_by,created_at,updated_at)
    VALUES('old','default','note','mcp','${authored}','Dan9','2026-11-18','2026-11-18'),
          ('foreign','other','note','mcp','other','Dan9','2026-11-18','2026-11-18'),
          ('absent','default','note','mcp','not shown','Dan9','2026-11-18','2026-11-18')`);
	const insert = sqlite.prepare(
		"INSERT INTO messages(id,conversation_id,namespace,role,content,created_at) VALUES(?,'c','default','user',?,?)",
	);
	for (const [id, content, day] of [
		["a", "我决定就用 ACP。", "20"],
		["b", "我决定就用 SDK。", "19"],
		["c", "我决定就用 REST。", "21"],
		["ask", "要不要用 ACP？", "22"],
		["echo", "他说「我决定就用 SDK。」", "22"],
	]) {
		insert.run(id, content, `2026-11-${day}T12:00:00.000Z`);
	}
	const first = await applyScopedDecision(
		env,
		"default",
		candidate("a", "ACP", ["old", "foreign", "absent"]),
		["old", "foreign"],
	);
	assert.ok(first?.current);
	assert.deepEqual(
		JSON.parse(
			String(
				sqlite
					.prepare("SELECT provenance FROM memories WHERE id=?")
					.get(first.id)?.provenance,
			),
		).state_of,
		["old"],
	);
	const late = await applyScopedDecision(env, "default", candidate("b", "SDK"));
	assert.equal(late?.current, false);
	await applyScopedDecision(env, "default", candidate("b", "SDK"));
	assert.equal(
		sqlite.prepare("SELECT count(*) AS n FROM memory_revisions").get()?.n,
		1,
	);
	assert.equal(
		await applyScopedDecision(env, "default", {
			...candidate("ask", "ACP"),
			evidence_quote: "要不要用 ACP？",
		}),
		null,
	);
	assert.equal(
		await applyScopedDecision(env, "default", candidate("echo", "SDK")),
		null,
	);
	const hit = () => ({
		id: "old",
		content: authored,
		authored_by: "Dan9",
		kind: "memory" as const,
		source_layer: "memory" as const,
		type: "note",
		source: "mcp",
		backed: true,
		score: 0.8,
		recorded_date: "2026-11-18",
	});
	const now = await annotateCurrentState(
		env,
		"default",
		[hit()],
		"Aelios 现在用什么",
		false,
		1,
	);
	assert.deepEqual(
		now.map((h) => h.id),
		[first.id],
	);
	const past = await annotateCurrentState(
		env,
		"default",
		[hit(), ...now],
		"旦九周三怎么想",
		false,
		2,
	);
	assert.equal(past[0].content, authored);
	assert.deepEqual(
		past.map((h) => h.id),
		["old"],
	);
	assert.equal(past[0].current_state?.by, first.id);
	assert.deepEqual(
		(
			await annotateCurrentState(
				env,
				"default",
				[...now, hit()],
				"旦九现在喜欢哪种",
				false,
				2,
			)
		).map((h) => h.id),
		["old"],
	);
	assert.deepEqual(
		await annotateCurrentState(
			{ ...env, CURRENT_STATE_PROJECTION: "off" },
			"default",
			[hit()],
			"现在",
			false,
			1,
		),
		[hit()],
	);
	sqlite
		.prepare("UPDATE memories SET version_status='under_review' WHERE id=?")
		.run(first.id);
	const latest = await applyScopedDecision(
		env,
		"default",
		candidate("c", "REST", ["old"]),
		["old"],
	);
	assert.ok(latest?.current);
	assert.equal(
		sqlite.prepare("SELECT status FROM memories WHERE id=?").get(first.id)
			?.status,
		"superseded",
	);
	await invalidateKnownInputs(
		env,
		{ namespace: "default", id: "c" },
		"message",
	);
	assert.deepEqual(
		(await annotateCurrentState(env, "default", [hit()], "现在", false, 2)).map(
			(h) => h.id,
		),
		["old"],
	);
	assert.equal(
		sqlite.prepare("SELECT content FROM memories WHERE id='old'").get()
			?.content,
		authored,
	);
});

test("concurrent first decisions for the same range share a single current slot", async (t) => {
	const { sqlite, db } = sqliteFixture(t);
	for (const [id, value, day] of [
		["a", "ACP", 19],
		["b", "SDK", 20],
	])
		sqlite
			.prepare(
				"INSERT INTO messages(id,conversation_id,namespace,role,content,created_at) VALUES(?,'c','default','user',?,?)",
			)
			.run(id, `我决定就用 ${value}。`, `2026-11-${day}T12:00:00.000Z`);
	const env = { DB: db };
	await Promise.allSettled([
		applyScopedDecision(env, "default", candidate("a", "ACP")),
		applyScopedDecision(env, "default", candidate("b", "SDK")),
	]);
	await applyScopedDecision(env, "default", candidate("a", "ACP"));
	await applyScopedDecision(env, "default", candidate("b", "SDK"));
	assert.deepEqual(
		sqlite
			.prepare("SELECT content FROM memories WHERE status='active'")
			.all()
			.map((r) => r.content),
		["用户决定 Aelios 的 integration 采用 SDK。"],
	);
});

test("projection only follows existing recall links and preserves ordinary fact keys", async (t) => {
	const { sqlite, db } = sqliteFixture(t);
	const env = { DB: db, CURRENT_STATE_PROJECTION: "on" };
	sqlite.exec(`INSERT INTO memories(id,namespace,type,source,content,fact_key,created_at,updated_at)
    VALUES('other-project','default','note','mcp','咲咲决定在 Other 用 SDK。','Dan9','2026-11-18','2026-11-18'),
          ('unrelated','default','note','mcp','Aelios 接口的其他说明。','Dan9','2026-11-18','2026-11-18')`);
	sqlite
		.prepare("INSERT INTO messages(id,conversation_id,namespace,role,content,created_at) VALUES('other-decision','c','default','user','我决定 Other 就用 SDK。','2026-11-19T12:00:00.000Z')")
		.run();
	const applied = await applyScopedDecision(
		env,
		"default",
		{
			...candidate("other-decision", "SDK", ["other-project"]),
			evidence_quote: "我决定 Other 就用 SDK。",
			decision: { scope_key: "user/other/integration", value: "SDK", state_of: ["other-project"] },
		},
		["other-project"],
	);
	assert.ok(applied?.current);
	const linked = await annotateCurrentState(
		env,
		"default",
		[{
			id: "other-project", content: "咲咲决定在 Other 用 SDK。", type: "note", source: "mcp",
			kind: "memory", source_layer: "memory", backed: true, score: 0.8, recorded_date: "2026-11-18",
		}],
		"Other 现在用什么",
		false,
		1,
	);
	assert.equal(linked[0].id, applied.id);
	const unrelated = await annotateCurrentState(env, "default", [], "Aelios 现在用什么", false, 1);
	assert.deepEqual(unrelated, []);
	await queueDreamExtractedMemories(env, {
		namespace: "default",
		memories: [{ type: "fact", content: "Aelios 保留旧接口。", fact_key: "legacy:api", source_message_ids: [], tags: [], confidence: 0.8, importance: 0.6 }],
		messageIds: [],
	});
	assert.equal(sqlite.prepare("SELECT fact_key FROM memory_candidates").get()?.fact_key, "legacy:api");
});

function decisionMessage(
	id: string,
	content: string,
	namespace = "default",
): MessageRecord {
	return {
		id,
		conversation_id: "c",
		namespace,
		role: "user",
		content,
		source: "test",
		created_at: "2026-11-20T12:00:00.000Z",
	};
}

test("decision cues trigger at most one model review and a grounded result reaches the active store", async (t) => {
	const { sqlite, db } = sqliteFixture(t);
	const messages = [
		decisionMessage("a", "我决定就用 ACP。"),
		decisionMessage("b", "我决定改用 SDK。"),
		decisionMessage("c", "我决定改用 REST。"),
	];
	for (const message of messages) {
		sqlite
			.prepare(
				"INSERT INTO messages(id,conversation_id,namespace,role,content,source,created_at) VALUES(?,?,?,?,?,?,?)",
			)
			.run(
				message.id,
				message.conversation_id,
				message.namespace,
				message.role,
				message.content,
				message.source,
				message.created_at,
			);
	}
	let calls = 0;
	const env: Env = {
		DB: db,
		CURRENT_STATE_PROJECTION: "on",
		DREAM_MODEL: "workers-ai/@cf/openai/gpt-oss-120b",
		AI: {
			async run() {
				calls += 1;
				return {
					response: JSON.stringify({ memories: [candidate("a", "ACP")] }),
				};
			},
		} as unknown as Env["AI"],
	};
	const recovered = await extractDecisionFallback(env, {
		namespace: "default",
		messages,
		candidates: [],
		deadlineAt: Date.now() + 10_000,
	});
	assert.equal(calls, 1);
	assert.equal(recovered.length, 1);
	assert.equal(
		await queueDreamExtractedMemories(env, {
			namespace: "default",
			memories: recovered,
			messageIds: messages.map((message) => message.id),
		}),
		0,
	);
	assert.equal(
		sqlite
			.prepare(
				"SELECT count(*) AS n FROM memories WHERE source='scoped_decision' AND status='active'",
			)
			.get()?.n,
		1,
	);
	assert.equal(
		sqlite.prepare("SELECT count(*) AS n FROM memory_candidates").get()?.n,
		0,
	);
});

test("cross-message citations keep their evidence, and projection stays scoped and optional at runRecall", async (t) => {
	const { sqlite, db } = sqliteFixture(t);
	const context = decisionMessage(
		"context",
		"Aelios 的 integration 还要保留现有接口。",
	);
	const decision = decisionMessage("decision", "我决定就用 ACP。");
	const other = decisionMessage("other", "我决定就用 SDK。", "other");
	for (const message of [context, decision, other]) {
		sqlite
			.prepare(
				"INSERT INTO messages(id,conversation_id,namespace,role,content,source,created_at) VALUES(?,?,?,?,?,?,?)",
			)
			.run(
				message.id,
				message.conversation_id,
				message.namespace,
				message.role,
				message.content,
				message.source,
				message.created_at,
			);
	}
	const proposal = {
		...candidate("decision", "ACP"),
		source_message_ids: ["context", "decision"],
	};
	const applied = await applyScopedDecision({ DB: db }, "default", proposal);
	assert.ok(applied?.current);
	assert.deepEqual(
		JSON.parse(
			String(
				sqlite
					.prepare("SELECT source_message_ids FROM memories WHERE id=?")
					.get(applied.id)?.source_message_ids,
			),
		),
		["context", "decision"],
	);
	const otherProposal = {
		...candidate("other", "SDK"),
		decision: {
			scope_key: "user/aelios/integration",
			value: "SDK",
			state_of: [applied.id],
		},
	};
	const foreign = await applyScopedDecision(
		{ DB: db },
		"other",
		otherProposal,
		[applied.id],
	);
	assert.ok(foreign);
	assert.deepEqual(
		JSON.parse(
			String(
				sqlite
					.prepare("SELECT provenance FROM memories WHERE id=?")
					.get(foreign.id)?.provenance,
			),
		).state_of,
		[],
	);
	let projectionModelCalls = 0;
	const env = {
		DB: db,
		CURRENT_STATE_PROJECTION: "on",
		ENABLE_MEMORY_RERANKER: "false",
		AI: { async run() { projectionModelCalls += 1; } } as unknown as Env["AI"],
	};
	const off = await runRecall(
		{
			...env,
			CURRENT_STATE_PROJECTION: "off",
			AI: { async run() { return { data: [[0.1, 0.2]] }; } } as unknown as Env["AI"],
			VECTORIZE: {
				async query() {
					return { matches: [], count: 0 };
				},
			} as unknown as Env["VECTORIZE"],
		},
		{ namespace: "default", query: "Aelios 现在 integration 用什么", k: 2 },
	);
	assert.equal(off.hits.length, 1);
	projectionModelCalls = 0;
	const on = await runRecall(
		{
			...env,
			AI: {
				async run() {
					return { data: [[0.1, 0.2]] };
				},
			} as unknown as Env["AI"],
		},
		{
			namespace: "default",
			query: "Aelios 现在 integration 用什么",
			k: 2,
		},
	);
	assert.equal(on.hits[0].id, applied.id);
	assert.equal(on.hits[0].current_state, undefined);
	assert.deepEqual(
		on.hits.map((hit) => hit.id),
		[applied.id],
	);
	assert.deepEqual(
		await annotateCurrentState(
			env,
			"other",
			[],
			"Aelios 现在 integration 用什么",
			false,
			1,
		),
		[],
	);
	assert.equal(projectionModelCalls, 0, "projection reuses text evidence without model calls");
});
