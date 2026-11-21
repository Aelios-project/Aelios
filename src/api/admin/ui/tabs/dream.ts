import { I, t } from "../helpers";
import { rollingStatusPanel } from "../../rolling";

export const ADMIN_TAB_DREAM = `      <!-- ===== 夜间整理 ===== -->
      <section x-show="savedApiKey.trim() && page === 'dream'" class="page">
        <header class="page-head">
          <div>
            <h1 class="h1">${t("夜间整理", "Nightly")}</h1>
            <p class="sub">${t("每晚把当天的对话整理成记忆和日记，平时不用管。", "Every night, the day’s chats become memories and a journal entry. Usually nothing to do here.")}</p>
          </div>
          <button type="button" @click="refreshDream()" class="btn btn-icon hidden md:inline-flex" :aria-label="L('刷新', 'Refresh')" :title="L('刷新', 'Refresh')">${I.refresh}</button>
        </header>

        <div class="stats">
          <div class="panel dream-stat stat">
            <span class="stat-label">${t("最近一次", "Last run")}</span>
            <span class="flex items-center gap-2 text-[22px] font-semibold leading-[42px]" :style="'color: ' + runColor(dreamLatestRun())">
              <span x-show="dreamLatestRun() && dreamLatestRun().status === 'ok' && !dreamLatestRun().stale">${I.checkBig}</span>
              <span class="truncate" x-text="dreamLatestLabel()"></span>
            </span>
            <span class="stat-sub truncate" x-text="dreamLatestSub()"></span>
          </div>
          <div class="panel dream-stat stat">
            <span class="stat-label">${t("近 7 晚", "Last 7 nights")}</span>
            <span class="stat-num"><span x-text="dreamOkCount()"></span><span class="text-sm font-medium muted" x-text="' / ' + dreamFinishedCount() + L(' 成功', ' succeeded')"></span></span>
            <button type="button" x-show="dreamFirstFailed()" @click="prepareRerun(dreamFirstFailed())" class="link self-start" x-text="dreamFirstFailed() ? L(dayLabel(dreamFirstFailed().date_label) + ' 失败了，去重跑 →', dayLabel(dreamFirstFailed().date_label) + ' failed. Re-run →') : ''"></button>
          </div>
          <div class="panel dream-stat stat">
            <span class="stat-label">${t("近 7 天整理了", "Processed this week")}</span>
            <span class="stat-num"><span x-text="dreamProcessedTotal()"></span><span class="text-sm font-medium muted" x-text="L(' 条消息', ' messages')"></span></span>
            <span class="stat-sub" x-text="dreamRuns.length ? L('平均每晚 ', 'About ') + Math.round(dreamProcessedTotal() / Math.max(dreamRuns.length, 1)) + L(' 条', ' a night') : ''"></span>
          </div>
        </div>

        <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
          <div class="flex flex-col gap-5">
            <section class="panel">
              <div class="panel-head">
                <h2 class="h2">${t("每天的对话量", "Chats per day")}</h2>
                <span class="text-xs muted" x-text="dreamStatus && dreamStatus.time_zone ? L('按 ', 'Days follow ') + dreamStatus.time_zone + L(' 分天', '') : ''"></span>
              </div>
              <div class="flex flex-col gap-2.5 px-[18px] py-4">
                <template x-if="dreamDayBars().length === 0"><p class="text-[13px] muted">${t("还没有消息记录。", "No messages yet.")}</p></template>
                <template x-for="day in dreamDayBars()" :key="day.date">
                  <div class="day-bar">
                    <span class="w-[72px] flex-none muted" x-text="dayLabel(day.date, true)"></span>
                    <span class="raw-bar-track" aria-hidden="true"><span class="raw-bar-fill block" :class="day.done ? 'is-done' : ''" :style="'width:' + day.widthPct + '%'"></span></span>
                    <span class="w-10 flex-none text-right tabular-nums" :style="day.pending ? 'color: var(--ct)' : ''" x-text="day.raw"></span>
                    <span class="chip hidden flex-none sm:inline-flex" :class="day.done ? 'chip-ok' : (day.pending ? 'chip-warn' : 'chip-dim')" x-text="day.stateLabel"></span>
                  </div>
                </template>
              </div>
            </section>

            <section id="dream-run" class="panel panel-pad flex flex-col gap-4">
              <div>
                <h2 class="h2">${t("手动整理一晚", "Run a night by hand")}</h2>
                <p class="mt-1 text-[13px] muted">${t("补跑某一晚，或者先看看会整理出什么。", "Catch up a missed night, or preview what it would produce.")}</p>
              </div>
              <div class="flex flex-wrap items-end gap-3">
                <label class="block"><span class="label">${t("哪一晚", "Night of")}</span><input type="date" x-model="dreamDate" class="field w-auto"></label>
                <label class="check"><input type="checkbox" x-model="dreamDryRun"><span>${t("只预览，不写入", "Preview only, don’t save")}</span></label>
                <label class="check"><input type="checkbox" x-model="dreamForce"><span>${t("已经整理过的也重来", "Redo if already processed")}</span></label>
                <button type="button" @click="triggerDream()" :disabled="dreamTriggering || (!dreamDryRun && dreamActiveRun)" class="btn btn-primary ml-auto">${I.moon}<span x-text="dreamTriggering ? (dreamDryRun ? L('预览中，请保持页面打开…', 'Previewing — keep this page open…') : L('提交中…', 'Submitting…')) : (dreamDryRun ? L('预览', 'Preview') : L('开始', 'Start'))"></span></button>
              </div>
              <p class="text-xs muted">${t("预览时请保持页面打开，结果不写入。关掉预览才是真跑，提交后可以关页。", "Keep this page open while a preview runs; nothing is saved. Untick preview to run for real; once it’s queued you can close the page.")}</p>

              <p x-show="dreamStatusError" class="banner banner-warn" x-text="dreamStatusError"></p>
              <div x-show="dreamActiveRun" class="banner" :class="dreamActiveRun && dreamActiveRun.stale ? 'banner-warn' : ''">
                <div class="min-w-0 flex-1">
                  <div x-text="dreamActiveRun && (L('任务 ', 'Run ') + dreamActiveRun.id + ' · ' + dreamStatusLabel(dreamActiveRun.status, dreamActiveRun.stale))"></div>
                  <p class="mt-1 text-xs" x-show="dreamActiveRun && dreamActiveRun.stale">${t("任务可能已经中断，完成状态还没确认。不会自动重跑，勾了「已经整理过的也重来」也盖不过它，请先核查（比如看 Worker 日志）。", "This run may have stopped, and whether it finished isn’t confirmed. It won’t re-run on its own, and “Redo” can’t override it. Check first (for example in the Worker logs).")}</p>
                </div>
                <button type="button" x-show="dreamActiveRun && dreamActiveRun.stale" @click="resolveDreamRun()" :disabled="dreamResolving" class="btn btn-sm btn-warn"><span x-text="dreamResolving ? L('标记中…', 'Marking…') : L('核查后标记为已中断', 'Checked — mark as stopped')"></span></button>
              </div>

              <div x-show="dreamRunResult" class="flex flex-col gap-3">
                <template x-if="dreamRunResult && dreamRunResult.run_id">
                  <div class="banner" x-text="L('任务 ', 'Run ') + dreamRunResult.run_id + ' · ' + dreamStatusLabel(dreamRunResult.status, dreamRunResult.stale)"></div>
                </template>
                <template x-if="dreamRunResult && dreamRunResult.result && !dreamRunResult.result.ran">
                  <div class="banner" x-text="L('这一晚没有整理：', 'Nothing was run for this night: ') + dreamReasonLabel(dreamRunResult.result.reason)"></div>
                </template>
                <template x-if="dreamRunResult && !dreamRunResult.dry_run && dreamRunResult.result && dreamRunResult.result.ran">
                  <div class="banner banner-ok"><span class="font-semibold">${t("这一晚整理完了。", "This night is done.")}</span> <span x-text="dreamRunStatsLine()"></span></div>
                </template>
                <template x-if="dreamRunResult && dreamRunResult.dry_run && dreamRunResult.result && dreamRunResult.result.ran">
                  <div class="flex flex-col gap-3 rounded-[12px] p-4" style="background: var(--soft)">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="font-semibold" x-text="L('预览 · ', 'Preview · ') + dayLabel(dreamDate || dreamAnchorDate())"></span>
                      <span class="chip chip-ok" x-text="L('新增 ', '') + dreamProposalList('memories_to_add').length + L('', ' new')"></span>
                      <span class="chip chip-warn" x-text="L('更新 ', '') + dreamProposalList('memories_to_update').length + L('', ' updated')"></span>
                      <span class="chip chip-err" x-text="L('移除 ', '') + dreamProposalList('memories_to_delete').length + L('', ' removed')"></span>
                    </div>
                    <div x-show="dreamProposal() && (dreamProposal().title || dreamProposal().summary)">
                      <div class="font-semibold" x-text="dreamProposal() && (dreamProposal().title || '')"></div>
                      <p class="mt-1 whitespace-pre-wrap text-[13px] leading-6" style="color: var(--t2)" x-text="dreamProposal() && (dreamProposal().summary || '')"></p>
                    </div>
                    <template x-if="dreamExtracted().length === 0"><p class="text-[13px] muted">${t("这一晚没有找到要记的。", "Nothing worth remembering from this night.")}</p></template>
                    <template x-for="(mem, idx) in dreamExtracted()" :key="idx">
                      <div class="flex items-start gap-2.5">
                        <span class="chip" :class="typeChipClass(mem.type)" x-text="typeLabel(mem.type)"></span>
                        <span class="min-w-0 flex-1 text-sm leading-6" x-text="mem.content"></span>
                      </div>
                    </template>
                    <details>
                      <summary class="text-xs muted">${t("技术细节", "Technical details")}</summary>
                      <div class="mt-2 flex flex-col gap-2">
                        <template x-if="dreamRoutingGroups().length === 0"><p class="text-xs muted">${t("没有路由项。", "No routing items.")}</p></template>
                        <template x-for="group in dreamRoutingGroups()" :key="group.key">
                          <div>
                            <div class="mb-1 flex items-center gap-2 text-xs"><span class="chip chip-violet" x-text="group.label"></span><span class="muted" x-text="group.items.length"></span></div>
                            <template x-for="(item, i) in group.items" :key="i">
                              <div class="flex items-start gap-2 text-xs leading-6"><span class="chip chip-dim" x-text="dreamRoutingKindLabel(item.kind)"></span><span class="min-w-0 flex-1" x-text="item.content || item.target_id || item.fact_key || '—'"></span></div>
                            </template>
                          </div>
                        </template>
                      </div>
                    </details>
                  </div>
                </template>
              </div>
            </section>
          </div>

          <section class="panel panel-pad">
            <h2 class="h2 mb-4">${t("最近 7 晚", "Last 7 nights")}</h2>
            <template x-if="dreamRuns.length === 0"><p class="text-[13px] muted">${t("近 7 天还没有整理记录。", "No runs in the last 7 days.")}</p></template>
            <div class="dream-rail flex flex-col gap-4">
              <template x-for="run in dreamRuns" :key="run.id">
                <div class="dream-rail-item" :class="dreamRailClass(run.stale ? 'stale' : run.status)">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-semibold" x-text="dayLabel(run.date_label, true)"></span>
                    <span class="chip" :class="dreamStatusChipClass(run.status)">
                      <span x-show="run.status === 'running' && !run.stale" class="breathe inline-block h-1.5 w-1.5 rounded-full bg-current"></span>
                      <span x-text="dreamStatusLabel(run.status, run.stale)"></span>
                    </span>
                    <span class="text-xs muted" x-text="dreamTriggerLabel(run.trigger) + ' · ' + dreamDuration(run)"></span>
                  </div>
                  <div class="mt-0.5 text-xs muted" x-text="(run.model || L('模型未知', 'Unknown model')) + ' · ' + L((run.processed_messages == null ? '—' : run.processed_messages) + ' 条消息', (run.processed_messages == null ? '—' : run.processed_messages) + ' messages')"></div>
                  <template x-if="dreamRunNote(run)">
                    <div class="mt-1.5">
                      <p class="text-xs leading-5" style="color: var(--t2)" :class="isDreamExpanded(run.id) ? '' : 'line-clamp-2'" x-text="dreamRunNote(run)"></p>
                      <button type="button" x-show="dreamRunNote(run).length > 80" @click="toggleDreamExpand(run.id)" class="link-btn" x-text="isDreamExpanded(run.id) ? L('收起', 'Show less') : L('展开', 'Show more')"></button>
                    </div>
                  </template>
                  <button type="button" x-show="run.status === 'error' && !run.stale" @click="prepareRerun(run)" class="btn btn-sm mt-2" x-text="L('重跑这一晚', 'Re-run this night')"></button>
                </div>
              </template>
            </div>
          </section>
        </div>

        ${rollingStatusPanel(t)}

        <section class="panel">
          <div class="panel-head pb-1">
            <div>
              <h2 class="h2">${t("某一晚的收成", "What a night produced")}</h2>
              <p class="mt-1 text-[13px] muted">${t("那晚新记住了什么，哪些淡出了。", "What was remembered that night, and what faded.")}</p>
            </div>
            <label class="flex items-center gap-2 text-[13px] muted"><span>${t("日期", "Date")}</span><input type="date" x-model="dreamHarvestDate" @change="loadDreamHarvest()" class="field field-sm"></label>
          </div>
          <div x-show="dreamHarvestLoading" class="px-[18px] py-4 text-[13px] muted" x-text="L('加载中…', 'Loading…')"></div>
          <div x-show="!dreamHarvest && !dreamHarvestLoading" class="px-[18px] py-4 text-[13px] muted">${t("选一个日期看看。", "Pick a date.")}</div>
          <div x-show="dreamHarvest" class="grid gap-3 p-[18px] md:grid-cols-3">
            <div class="rounded-[12px] p-3.5" style="background: var(--soft)">
              <button type="button" @click="harvestOpen.new = !harvestOpen.new" class="flex w-full items-center gap-2 text-left" :aria-expanded="harvestOpen.new ? 'true' : 'false'">
                <span class="harvest-dot" aria-hidden="true"></span><span class="font-semibold">${t("新记住", "Newly remembered")}</span>
                <span class="text-xs muted" x-text="dreamHarvestCreated().length"></span>
                <span class="chev ml-auto" :class="harvestOpen.new ? 'is-open' : ''">${I.chevron}</span>
              </button>
              <div x-show="harvestOpen.new" class="mt-3 flex flex-col gap-2.5">
                <template x-if="dreamHarvestCreated().length === 0"><p class="text-xs muted">${t("这一晚没有新记住的。", "Nothing new that night.")}</p></template>
                <template x-for="item in dreamHarvestCreated()" :key="item.id">
                  <div class="flex items-start gap-2"><span class="chip" :class="typeChipClass(item.type)" x-text="typeLabel(item.type)"></span><span class="min-w-0 flex-1 text-[13px] leading-6" x-text="item.content"></span></div>
                </template>
              </div>
            </div>
            <div class="rounded-[12px] p-3.5" style="background: var(--soft)">
              <button type="button" @click="harvestOpen.dim = !harvestOpen.dim" class="flex w-full items-center gap-2 text-left" :aria-expanded="harvestOpen.dim ? 'true' : 'false'">
                <span class="dot" aria-hidden="true"></span><span class="font-semibold">${t("淡出", "Faded")}</span>
                <span class="text-xs muted" x-text="dreamHarvestDormant().length"></span>
                <span class="chev ml-auto" :class="harvestOpen.dim ? 'is-open' : ''">${I.chevron}</span>
              </button>
              <div x-show="harvestOpen.dim" class="mt-3 flex flex-col gap-2.5">
                <template x-if="dreamHarvestDormant().length === 0"><p class="text-xs muted">${t("这一晚没有淡出的。", "Nothing faded that night.")}</p></template>
                <template x-for="item in dreamHarvestDormant()" :key="item.id">
                  <div class="text-[13px] leading-6">
                    <div class="flex flex-wrap items-center gap-2 text-xs"><span class="chip chip-dim" x-text="dreamDormantLabel(item.status)"></span><span class="chip" :class="typeChipClass(item.type)" x-text="typeLabel(item.type)"></span></div>
                    <p class="mt-1 muted" x-text="item.content"></p>
                    <p x-show="item.superseded_by" class="text-[11px] muted"><span x-text="L('接替它的：', 'Replaced by: ')"></span><span class="mono" x-text="item.superseded_by"></span></p>
                  </div>
                </template>
              </div>
            </div>
            <div class="rounded-[12px] p-3.5" style="background: var(--soft)">
              <button type="button" @click="harvestOpen.judged = !harvestOpen.judged" class="flex w-full items-center gap-2 text-left" :aria-expanded="harvestOpen.judged ? 'true' : 'false'">
                <span class="dot" style="background: var(--vline)" aria-hidden="true"></span><span class="font-semibold">${t("审核结果", "Review decisions")}</span>
                <span class="text-xs muted" x-text="dreamHarvestCandidates().length"></span>
                <span class="chev ml-auto" :class="harvestOpen.judged ? 'is-open' : ''">${I.chevron}</span>
              </button>
              <div x-show="harvestOpen.judged" class="mt-3 flex flex-col gap-2.5">
                <template x-if="dreamHarvestCandidates().length === 0"><p class="text-xs muted">${t("这一晚没有审核。", "No review decisions that night.")}</p></template>
                <template x-for="item in dreamHarvestCandidates()" :key="item.id">
                  <div class="text-[13px] leading-6">
                    <div class="flex flex-wrap items-center gap-2 text-xs"><span class="chip" :class="item.status === 'approved' ? 'chip-ok' : 'chip-dim'" x-text="dreamCandidateStatusLabel(item.status)"></span><span class="muted" x-text="dreamCandidateSourceLabel(item.source)"></span></div>
                    <p class="mt-1" x-text="item.content"></p>
                    <p x-show="item.decision_note" class="text-[11px] muted" x-text="item.decision_note"></p>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </section>
      </section>
`;
