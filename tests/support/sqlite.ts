import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { TestContext } from "node:test";

export function sqliteFixture(t: TestContext) {
	const sqlite = new DatabaseSync(":memory:");
	t.after(() => sqlite.close());
	for (const file of readdirSync("migrations")
		.filter((name) => name.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
	}
	function prepare(sql: string) {
		const statement = sqlite.prepare(sql);
		let args: SQLInputValue[] = [];
		const query = {
			bind(...values: SQLInputValue[]) {
				args = values.map((v) => v ?? null);
				return query;
			},
			async first() {
				return statement.get(...args) ?? null;
			},
			async all() {
				return { results: statement.all(...args) };
			},
			run() {
				return { meta: statement.run(...args) };
			},
			execute() {
				return statement.columns().length
					? { results: statement.all(...args) }
					: this.run();
			},
		};
		return query;
	}
	const db = {
		prepare,
		async batch(queries: ReturnType<typeof prepare>[]) {
			sqlite.exec("BEGIN");
			try {
				const results = queries.map((query) => query.execute());
				sqlite.exec("COMMIT");
				return results;
			} catch (error) {
				sqlite.exec("ROLLBACK");
				throw error;
			}
		},
	};
	return { sqlite, db: db as unknown as D1Database };
}
