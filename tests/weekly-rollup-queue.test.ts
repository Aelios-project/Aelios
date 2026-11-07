import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { invalidateSettingsCache } from "../src/gateway/config";
import { runDiaryWriter } from "../src/memory/diaryWriter";
import { runMonthlyRollup } from "../src/memory/monthlyRollup";
import { approveWeeklyRollup, getIsoWeekLabelForDateLabel, runWeeklyRollup } from "../src/memory/weeklyRollup";

// Synthetic local SQLite and a stub model only. The seed mirrors the stall seen in a real
// deployment: daily_log kept since 2026-07-27 (review gate on), one weekly summary (W32)
// and a July monthly summary that had already absorbed W31's weekly row.
const MODEL = "workers-ai/@cf/openai/gpt-oss-120b";

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
    try { sqlite.exec(readFileSync(`migrations/${file}`, "utf8")); }
    catch (error) { if (!String(error).includes("fts5")) throw error; }
  }
  const db: any = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: any[] = [];
      const query = {
        bind(...args: any[]) { values = args; return query; },
        async first() { return statement.get(...values) ?? null; },
        async all() { return { results: statement.all(...values) }; },
        async run() { return { meta: { changes: Number(statement.run(...values).changes) } }; }
      };
      return query;
    },
    async batch(queries: any[]) {
      const results = [];
      for (const query of queries) results.push(await query.run());
      return results;
    }
  };
  const weeklyCalls: string[] = [];
  const monthlyCalls: string[] = [];
  const env: any = {
    DB: db,
    DREAM_MODEL: MODEL,
    DIARY_MODEL: MODEL,
    DREAM_TIME_ZONE: "UTC",
    AI: {
      async run(_model: string, input: any) {
        const prompt = String(input.messages?.at(-1)?.content ?? "");
        const week = /周次：(\d{4}-W\d{2})/.exec(prompt)?.[1];
        const month = /月份：(\d{4}-\d{2})/.exec(prompt)?.[1];
        if (week) weeklyCalls.push(week);
        if (month) monthlyCalls.push(month);
        return { response: { title: `合成标题 ${week ?? month}`, summary: `合成摘要 ${week ?? month}` } };
      }
    }
  };
  invalidateSettingsCache();
  return { sqlite, env, weeklyCalls, monthlyCalls };
}

function eachDate(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += 86400000) {
    dates.push(new Date(at).toISOString().slice(0, 10));
  }
  return dates;
}

function seedStalledSpace(sqlite: DatabaseSync) {
  const insertDaily = sqlite.prepare(
    "INSERT INTO daily_log (namespace, date, title, summary, updated_at, source_message_ids) VALUES ('default', ?, ?, ?, ?, '[]')"
  );
  for (const date of eachDate("2026-07-27", "2026-11-19")) {
    insertDaily.run(date, `日记 ${date}`, `合成日记 ${date}`, `${date}T20:10:00.000Z`);
  }
  sqlite.prepare(
    `INSERT INTO weekly_log (namespace, week, start_date, end_date, title, summary, source_days, updated_at)
     VALUES ('default', '2026-W32', '2026-08-03', '2026-08-09', '旧周记', '合成周记 W32', 7, '2026-08-16T20:14:15.041Z')`
  ).run();
  sqlite.prepare(
    `INSERT INTO monthly_log (namespace, month, title, summary, source_week_count, created_at, updated_at)
     VALUES ('default', '2026-07', '七月', '合成月记 2026-07', 1, '2026-08-01T20:20:00.000Z', '2026-08-01T20:20:00.000Z')`
  ).run();
}

function settledWeeks(sqlite: DatabaseSync): Set<string> {
  const rows = sqlite.prepare(
    "SELECT week FROM weekly_log WHERE namespace = 'default' UNION SELECT week FROM folded_week WHERE namespace = 'default'"
  ).all() as Array<{ week: string }>;
  return new Set(rows.map((row) => row.week));
}

test("weekly queue skips finished weeks and moves on to newer ones", async (t) => {
  const { sqlite, env, weeklyCalls } = fixture(t);
  seedStalledSpace(sqlite);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-07T20:10:00Z") });

  const stats = await runWeeklyRollup(env, "default");
  const processed = stats.details.map((detail) => detail.week);

  // W32 already has its weekly summary: it no longer takes one of the two slots.
  assert.ok(!processed.includes("2026-W32"), `W32 should be skipped, got ${processed.join(", ")}`);
  assert.ok(processed.includes("2026-W33"), `W33 should finally be written, got ${processed.join(", ")}`);
  assert.deepEqual(weeklyCalls, processed);
  assert.ok(stats.details.every((detail) => detail.status === "rolled_up"));
});

test("nightly weekly + monthly runs catch up without rewriting folded weeks", async (t) => {
  const { sqlite, env, weeklyCalls, monthlyCalls } = fixture(t);
  seedStalledSpace(sqlite);

  const nights = eachDate("2026-11-07", "2026-11-20");
  for (const night of nights) {
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(`${night}T20:10:00Z`) });
    await runWeeklyRollup(env, "default");
    await runMonthlyRollup(env, "default");
  }

  // Every week is written once at most, even after the monthly rollup deletes its weekly row.
  const counts = new Map<string, number>();
  for (const week of weeklyCalls) counts.set(week, (counts.get(week) ?? 0) + 1);
  for (const [week, count] of counts) assert.equal(count, 1, `${week} was written ${count} times`);
  assert.ok(!counts.has("2026-W32"), "W32 already had a weekly summary");

  // The July monthly is refreshed once (absorbing W31), not every night.
  assert.equal(monthlyCalls.filter((month) => month === "2026-07").length, 1);

  // By the last night every week old enough for a weekly summary has one or was folded.
  const settled = settledWeeks(sqlite);
  const lastCutoff = "2026-11-13"; // 2026-11-20 minus 7 days
  const dueWeeks = new Set(
    eachDate("2026-07-27", "2026-11-08")
      .filter((date) => date < lastCutoff)
      .map((date) => getIsoWeekLabelForDateLabel(date, "UTC"))
  );
  for (const week of dueWeeks) assert.ok(settled.has(week), `${week} never got a weekly summary`);

  // Nothing is left waiting once the queue has caught up.
  const finalStats = await runWeeklyRollup(env, "default");
  assert.equal(finalStats.weeks_eligible, 0);
  assert.equal(finalStats.details.length, 0);

  // Folded weeks keep their dailies until approved, and can still be approved.
  const folded = sqlite.prepare("SELECT week FROM folded_week WHERE week = '2026-W31'").get();
  assert.ok(folded, "W31 should be recorded as folded into July");
  const approved = await approveWeeklyRollup(env, { namespace: "default", week: "2026-W31" });
  assert.deepEqual(approved, { week: "2026-W31", start_date: "2026-07-27", end_date: "2026-08-02", deleted_days: 7 });
});

test("a day in a folded week is not rewritten", async (t) => {
  const { sqlite, env } = fixture(t);
  sqlite.prepare(
    `INSERT INTO folded_week (namespace, week, month, start_date, end_date, folded_at)
     VALUES ('default', '2026-W31', '2026-07', '2026-07-27', '2026-08-02', '2026-11-07T20:20:00.000Z')`
  ).run();

  const stats = await runDiaryWriter(env, "default", "2026-07-29");
  assert.equal(stats.ran, false);
  assert.equal(stats.reason, "week_already_rolled_up");
});
