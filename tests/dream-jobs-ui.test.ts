import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ADMIN_HTML } from "../src/api/admin/ui";

function panel(confirmAnswer = true) {
  const script = ADMIN_HTML.match(/<script>\s*(function memoryAdmin\(\)[\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  let sequence = 0;
  const timers = new Map<number, () => void>();
  const app = runInNewContext(`${script}\nmemoryAdmin()`, {
    localStorage: { getItem() { return null; }, setItem() {} },
    location: { origin: "https://synthetic.test" },
    document: { documentElement: { dataset: {} } },
    window: {
      confirm() { return confirmAnswer; },
      setTimeout(callback: () => void) { const id = ++sequence; timers.set(id, callback); return id; },
      clearTimeout(id: number) { timers.delete(id); }
    }
  });
  const notices: string[] = [];
  app.icons = () => {};
  app.notify = (message: string) => notices.push(message);
  app.page = "dream";
  app.namespace = "synthetic-space";
  app.dreamDate = "2026-01-10";
  return { app, timers, notices };
}

function run(status = "queued", stale = false) {
  return { id: "drm_synthetic", date_label: "2026-01-10", status, stale, started_at: "2026-01-11T00:00:00Z" };
}

test("manual UI sends background true, displays acceptance ID, polls queued/running and stops on completion", async () => {
  const { app, timers, notices } = panel();
  app.dreamDryRun = false;
  let state = run();
  let harvestReads = 0;
  app.request = async (path: string, options?: { body: string }) => {
    if (path === "/v1/dream/run") {
      assert.deepEqual(JSON.parse(options?.body || "{}"), {
        namespace: "synthetic-space", date: "2026-01-10", force: false, dry_run: false, background: true
      });
      return { data: { run_id: state.id, status: "queued", dry_run: false } };
    }
    if (path.startsWith("/v1/dream/status")) return { data: {
      dream_runs: [state], active_run: ["queued", "running"].includes(state.status) ? state : null
    } };
    if (path.startsWith("/admin/dream/harvest")) { harvestReads += 1; return { data: {} }; }
    throw new Error(`unexpected path ${path}`);
  };
  await app.triggerDream();
  assert.equal(app.dreamRunResult.run_id, "drm_synthetic");
  assert.equal(app.dreamRunResult.status, "queued");
  assert.equal(app.dreamTriggering, false);
  assert.equal(app.dreamActiveRun.id, "drm_synthetic");
  assert.match(notices[0], /已排队.*drm_synthetic/);
  assert.equal(timers.size, 1);
  state = run("running");
  await app.loadDreamStatus();
  assert.equal(app.dreamRunResult.status, "running");
  assert.equal(timers.size, 1);
  state = run("ok");
  await app.loadDreamStatus();
  assert.equal(app.dreamRunResult.status, "ok");
  assert.equal(app.dreamActiveRun, null);
  assert.equal(timers.size, 0);
  assert.equal(harvestReads, 1);
  assert.equal(notices.some((text) => text.includes("梦完了")), false);
});

test("fresh/refresh status reconstructs an active job and stale jobs show unconfirmed without infinite running/polling", async () => {
  const { app, timers } = panel();
  let state = run("running");
  app.request = async () => ({ data: { dream_runs: [], active_run: state } });
  await app.loadDreamStatus();
  assert.equal(app.dreamActiveRun.id, state.id);
  assert.equal(timers.size, 1);
  state = run("running", true);
  await app.loadDreamStatus();
  assert.equal(app.dreamActiveRun.stale, true);
  assert.equal(app.dreamStatusLabel(state.status, state.stale), "可能中断 / 状态未确认");
  assert.equal(app.dreamDuration(state), "状态未确认");
  assert.match(app.dreamRunNote(state), /不会自动重跑/);
  assert.equal(timers.size, 0);
  app.dreamDryRun = false;
  app.dreamForce = true;
  app.request = async () => { throw new Error("active tasks must block submission"); };
  await app.triggerDream();
  assert.equal(app.dreamRunResult, null);
  assert.match(ADMIN_HTML, /「已经整理过的也重来」也盖不过它/);
  assert.match(ADMIN_HTML, /run.status === 'running' && !run.stale/);
});

test("dry-run results retain proposal/extraction/routing rendering and do not poll", async () => {
  assert.match(ADMIN_HTML, /预览时请保持页面打开/);
  assert.match(ADMIN_HTML, /预览中，请保持页面打开/);
  const { app, timers } = panel();
  const result = {
    dry_run: true, result: { ran: true }, proposal: { title: "synthetic proposal", memories_to_add: [] },
    extracted_memories: [{ type: "fact", content: "synthetic fact" }], routing_plan: { items: [] }
  };
  app.request = async (path: string, options: { body: string }) => {
    assert.equal(path, "/v1/dream/run");
    assert.equal(JSON.parse(options.body).dry_run, true);
    assert.equal(JSON.parse(options.body).background, true);
    return { data: result };
  };
  await app.triggerDream();
  assert.equal(app.dreamProposal().title, "synthetic proposal");
  assert.equal(app.dreamExtracted()[0].content, "synthetic fact");
  assert.equal(app.dreamRoutingGroups().length, 0);
  assert.equal(timers.size, 0);
});

test("leaving or switching spaces stops polling; an in-flight acceptance cannot contaminate the new space", async () => {
  const { app, timers } = panel();
  app.dreamActiveRun = run();
  app.scheduleDreamPolling();
  assert.equal(timers.size, 1);
  app.go("today");
  assert.equal(timers.size, 0);
  app.page = "dream";
  app.dreamActiveRun = null;
  app.dreamDryRun = false;
  let release = (_: unknown) => {};
  app.request = () => new Promise((resolve) => { release = resolve; });
  const pending = app.triggerDream();
  app.spaceRevision += 1;
  app.clearSpaceData();
  release({ data: { run_id: "old-space", status: "queued" } });
  await pending;
  assert.equal(app.dreamRunResult, null);
  assert.equal(app.dreamActiveRun, null);
  assert.equal(app.dreamTriggering, false);
  assert.equal(timers.size, 0);
});

test("status read failure stops polling and visibly warns that completion is unconfirmed", async () => {
  const { app, timers } = panel();
  app.dreamActiveRun = run("running");
  app.scheduleDreamPolling();
  app.request = async () => { throw new Error("synthetic status unavailable"); };
  await app.loadDreamStatus();
  assert.match(app.dreamStatusError, /尚未确认.*不要直接重跑/);
  assert.equal(timers.size, 0);
});

test("a stale task offers an explicit close-out that confirms, posts the run id, then refreshes and unblocks submission", async () => {
  assert.match(ADMIN_HTML, /核查后标记为已中断/);
  const { app, notices } = panel();
  let state = run("running", true);
  const calls: string[] = [];
  app.request = async (path: string, options?: { body: string }) => {
    calls.push(path);
    if (path === "/v1/dream/resolve") {
      assert.deepEqual(JSON.parse(options?.body || "{}"), { namespace: "synthetic-space", run_id: "drm_synthetic" });
      state = { ...state, status: "error", stale: false };
      return { data: {} };
    }
    if (path.startsWith("/v1/dream/status")) return { data: {
      dream_runs: [state], active_run: ["queued", "running"].includes(state.status) ? state : null
    } };
    throw new Error(`unexpected path ${path}`);
  };
  await app.loadDreamStatus();
  assert.equal(app.dreamActiveRun.stale, true);
  await app.resolveDreamRun();
  assert.equal(app.dreamActiveRun, null);
  assert.equal(app.dreamResolving, false);
  assert.deepEqual(calls.filter((path) => path === "/v1/dream/resolve"), ["/v1/dream/resolve"]);
  assert.match(notices.at(-1) ?? "", /已标记为已中断.*drm_synthetic/);
  assert.equal(app.dreamReasonLabel("marked_interrupted"), "已核查并标记为中断");
});

test("close-out needs confirmation and is never offered for a task that is not stale", async () => {
  const declined = panel(false);
  declined.app.request = async () => { throw new Error("a declined confirmation must not call the API"); };
  declined.app.dreamActiveRun = run("running", true);
  await declined.app.resolveDreamRun();
  assert.equal(declined.app.dreamResolving, false);

  const fresh = panel();
  fresh.app.request = async () => { throw new Error("a task that may still be running must not be closed"); };
  fresh.app.dreamActiveRun = run("running", false);
  await fresh.app.resolveDreamRun();
  assert.equal(fresh.app.dreamResolving, false);
});

test("the straight aurora bar on the stat cards is clipped to their rounded corners", () => {
  assert.match(ADMIN_HTML, /\.dream-stat \{[^}]*position: relative;[^}]*overflow: hidden;/);
});

test("a diary can be rewritten from its page: confirms, posts the date, reloads on success and explains a refusal", async () => {
  assert.match(ADMIN_HTML, /x-show="entry\.sources_kept !== 0" @click="rewriteDiary\(entry\)"/);
  const { app, notices } = panel();
  const entry = { date: "2026-10-14", sources_kept: 3 };
  const seen: string[] = [];
  let stats: Record<string, unknown> = { ran: true };
  app.request = async (path: string, options?: { body: string }) => {
    seen.push(path);
    if (path === "/admin/diary-rewrite") {
      assert.deepEqual(JSON.parse(options?.body || "{}"), { namespace: "synthetic-space", date: "2026-10-14" });
      return { data: { stats } };
    }
    if (path.startsWith("/admin/diary")) return { data: { dailies: [{ date: "2026-10-14", title: "新日记" }], weeklies: [] } };
    throw new Error(`unexpected path ${path}`);
  };
  await app.rewriteDiary(entry);
  assert.match(notices.at(-1) ?? "", /日记已重写.*2026-10-14/);
  assert.equal(app.diaryDailies[0].title, "新日记");
  assert.equal(app.diaryRewriting, "");

  seen.length = 0;
  stats = { ran: false, reason: "week_already_rolled_up" };
  await app.rewriteDiary(entry);
  assert.match(notices.at(-1) ?? "", /没有重写.*周记/);
  assert.deepEqual(seen, ["/admin/diary-rewrite"]);
  assert.equal(app.diaryRewriting, "");
});

test("the journal has a monthly tab that lists monthly summaries without daily-only controls", async () => {
  assert.match(ADMIN_HTML, /@click="diaryMode = 'monthly'; diaryPick = ''; diaryReading = false"/);
  // Rewrite and source chips belong to daily entries only, so a monthly entry never shows them.
  assert.match(ADMIN_HTML, /x-show="entry\.date && entry\.sources_kept !== 0"/);
  assert.match(ADMIN_HTML, /x-show="entry\.date && entry\.sources_kept != null"/);

  const { app } = panel();
  app.request = async (path: string) => {
    if (path.startsWith("/admin/diary")) {
      return { data: { dailies: [], weeklies: [], monthlies: [{ month: "2026-08", title: "八月", summary: "合成月记。", source_week_count: 2 }] } };
    }
    throw new Error(`unexpected path ${path}`);
  };
  await app.loadDiary();
  app.diaryMode = "monthly";
  const items = app.diaryListItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].key, "monthly:2026-08");
  assert.equal(app.diaryCurrent().title, "八月");

  app.lang = "zh";
  assert.equal(app.monthLabel("2026-08"), "2026年8月");
  app.lang = "en";
  assert.equal(app.monthLabel("2026-08"), "August 2026");
});

test("a declined confirmation or a rewrite already in flight never reaches the API", async () => {
  const declined = panel(false);
  declined.app.request = async () => { throw new Error("must not call the API"); };
  await declined.app.rewriteDiary({ date: "2026-10-14" });
  assert.equal(declined.app.diaryRewriting, "");

  const busy = panel();
  busy.app.request = async () => { throw new Error("must not call the API"); };
  busy.app.diaryRewriting = "2026-10-13";
  await busy.app.rewriteDiary({ date: "2026-10-14" });
  assert.equal(busy.app.diaryRewriting, "2026-10-13");
});
