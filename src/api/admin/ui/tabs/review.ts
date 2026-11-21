import { I, CANDIDATE_CARD, t } from "../helpers";

export const ADMIN_TAB_REVIEW = `      <!-- ===== 待审 ===== -->
      <section x-show="savedApiKey.trim() && page === 'review'" class="page">
        <header class="page-head">
          <div>
            <h1 class="h1">${t("待审", "Review")}</h1>
            <p class="sub">${t("确认后才会写进长期记忆。", "Only what you confirm becomes a long-term memory.")}</p>
          </div>
          <button type="button" @click="reviewHelp = !reviewHelp" class="link-btn" :aria-expanded="reviewHelp ? 'true' : 'false'">${I.info}${t("这些是从哪来的？", "Where do these come from?")}</button>
        </header>
        <div x-show="reviewHelp" class="panel note">
          ${t("<b>日常</b>：每晚整理聊天时拿不准的，等你点头。<b>导入的</b>：从「导入导出」搬进来的，只等你自己点，不走自动审核。<b>本周自动处理</b>：自动审核或助手（通过 MCP 的 memory_review）自己定下的，觉得不对可以撤回。",
            "<b>Daily</b>: things the nightly run wasn’t sure about. <b>Imported</b>: brought in from Import &amp; export; only you decide these. <b>Auto-handled</b>: decided by auto-review or by the assistant itself (via MCP memory_review). Undo any you disagree with.")}
        </div>

        <div class="tabs" role="tablist" :aria-label="L('候选来源', 'Where candidates come from')">
          <button type="button" role="tab" @click="reviewTab = 'daily'" class="tab" :class="reviewTab === 'daily' ? 'is-active' : ''" :aria-selected="reviewTab === 'daily' ? 'true' : 'false'">${t("日常", "Daily")}<span class="count" x-text="candidates.length"></span></button>
          <button type="button" role="tab" @click="openImportReview()" class="tab" :class="reviewTab === 'import' ? 'is-active' : ''" :aria-selected="reviewTab === 'import' ? 'true' : 'false'">${t("导入的", "Imported")}<span class="count" x-show="importPendingCount" x-text="importPendingCount"></span></button>
          <button type="button" role="tab" @click="reviewTab = 'auto'; loadJudgeDecisions()" class="tab" :class="reviewTab === 'auto' ? 'is-active' : ''" :aria-selected="reviewTab === 'auto' ? 'true' : 'false'">${t("本周自动处理", "Auto-handled this week")}<span class="count" x-show="judgeDecisions.length" x-text="judgeDecisions.length"></span></button>
        </div>

        <div x-show="reviewTab === 'daily'" class="flex flex-col gap-4">
          <div class="banner" :class="autoReview === 'clef' ? 'banner-ok' : ''">
            <span x-show="autoReview === 'clef'">${I.check}</span><span x-show="autoReview !== 'clef'">${I.info}</span>
            <span class="min-w-0 flex-1" x-text="autoReview === 'clef' ? L('自动审核已开启：今晚整理后会自动处理剩下的，不必一条条点。', 'Auto-review is on. Whatever’s left gets handled tonight, so there’s no need to go one by one.') : L('自动审核关着，这些等你确认；也可以让助手用 MCP 的 memory_review 自己审。', 'Auto-review is off, so these wait for you. Your assistant can also review them through MCP memory_review.')"></span>
            <button type="button" @click="go('settings')" class="link">${t("改设置", "Change")}</button>
          </div>

          <div x-show="candidates.length" class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <label class="check mr-1"><input type="checkbox" :checked="reviewAllSelected()" @change="reviewSelectAll($event.target.checked)"><span x-text="L('全选', 'Select all')"></span></label>
              <button type="button" @click="reviewBulk('approve')" :disabled="!reviewSelectedCount() || reviewBulkBusy" class="btn btn-sm" x-text="L('记住所选', 'Remember selected') + (reviewSelectedCount() ? ' ' + reviewSelectedCount() : '')"></button>
              <button type="button" @click="reviewBulk('discard')" :disabled="!reviewSelectedCount() || reviewBulkBusy" class="btn btn-sm" x-text="L('丢弃所选', 'Discard selected')"></button>
              <span x-show="reviewBulkBusy" class="text-xs muted" x-text="reviewBulkLabel"></span>
            </div>
            <label class="flex items-center gap-2 text-[13px] muted">${t("类型", "Type")}
              <select x-model="reviewType" class="field field-sm">
                <option value="all" x-text="L('全部', 'All')"></option>
                <template x-for="type in reviewTypes()" :key="type"><option :value="type" x-text="typeLabel(type)"></option></template>
              </select>
            </label>
          </div>

          <template x-if="candidates.length === 0">
            <div class="panel empty">${t("没有待审的，都处理好了。", "Nothing to review. You’re all caught up.")}</div>
          </template>
          <div class="flex flex-col gap-3">
            <template x-for="candidate in reviewList()" :key="candidate.id">
              ${CANDIDATE_CARD}
            </template>
          </div>
        </div>

        <div x-show="reviewTab === 'import'" class="flex flex-col gap-4">
          <div class="banner">${I.info}<span class="min-w-0 flex-1">${t("这些不走夜里的自动审核，也不给助手审，等你自己点：记住了才进长期记忆。clef 的分只是参考。", "These skip nightly auto-review and the assistant; only you decide. Remembered ones become long-term memories. clef’s scores are only a hint.")}</span></div>
          <div class="panel panel-pad flex flex-col gap-3">
            <div class="flex flex-wrap gap-2">
              <select x-model="importReview.importId" @change="loadImportCandidates(true)" class="field min-w-0 flex-1" :aria-label="L('哪一次导入', 'Which import')">
                <option value="" x-text="L('全部导入', 'All imports')"></option>
                <template x-for="batch in importReview.batches" :key="batch.id">
                  <option :value="batch.id" x-text="importBatchLabel(batch)"></option>
                </template>
              </select>
              <button type="button" @click="loadImportCandidates(true)" class="btn btn-icon" :aria-label="L('刷新', 'Refresh')">${I.refresh}</button>
            </div>
            <div class="flex flex-wrap gap-2">
              <button type="button" @click="importReview.filter = 'all'; loadImportCandidates(true)" class="pill" :class="importReview.filter === 'all' ? 'is-active' : ''">${t("全部", "All")} <span class="count" x-text="importReview.counts.pending"></span></button>
              <button type="button" @click="importReview.filter = 'clef_yes'; loadImportCandidates(true)" class="pill" :class="importReview.filter === 'clef_yes' ? 'is-active' : ''">${t("clef 觉得该记", "clef says keep")} <span class="count" x-text="importReview.counts.clef_yes"></span></button>
              <button type="button" @click="importReview.filter = 'clef_no'; loadImportCandidates(true)" class="pill" :class="importReview.filter === 'clef_no' ? 'is-active' : ''">${t("clef 觉得不用", "clef says skip")} <span class="count" x-text="importReview.counts.clef_no"></span></button>
            </div>
            <div class="flex flex-wrap gap-2">
              <button type="button" @click="bulkImportCandidates('approve', 'clef_yes')" :disabled="importReview.bulk || !importReview.counts.clef_yes" class="btn btn-primary btn-sm">${I.check}<span x-text="L('记住 clef 觉得该记的 ' + importReview.counts.clef_yes + ' 条', 'Remember all ' + importReview.counts.clef_yes + ' clef would keep')"></span></button>
              <button type="button" @click="bulkImportCandidates('discard', 'clef_no')" :disabled="importReview.bulk || !importReview.counts.clef_no" class="btn btn-sm" x-text="L('丢弃 clef 觉得不用的 ' + importReview.counts.clef_no + ' 条', 'Discard all ' + importReview.counts.clef_no + ' clef would skip')"></button>
            </div>
            <p x-show="importReview.bulk" class="text-xs muted" x-text="importReview.bulk ? importReview.bulk.label + ' ' + importReview.bulk.done + ' / ' + importReview.bulk.total + (importReview.bulk.failed ? L('，失败 ', ', failed ') + importReview.bulk.failed : '') : ''"></p>
          </div>

          <template x-if="importReview.items.length === 0">
            <div class="panel empty" x-text="importReview.loading ? L('加载中…', 'Loading…') : L('这里没有待审的导入候选。', 'No imported candidates waiting.')"></div>
          </template>
          <div class="flex flex-col gap-3">
            <template x-for="candidate in importReview.items" :key="candidate.id">
              ${CANDIDATE_CARD}
            </template>
          </div>
          <button type="button" x-show="importReview.more" @click="loadImportCandidates(false)" class="btn self-center" x-text="L('再看 50 条', 'Show 50 more')"></button>
        </div>

        <div x-show="reviewTab === 'auto'" class="flex flex-col gap-3">
          <p class="text-[13px] muted">${t("近 7 天自动审核和助手自己定下的。觉得不对就撤回：记住的收回，放下的补记。", "What auto-review and your assistant decided in the last 7 days. Undo anything you disagree with.")}</p>
          <template x-if="judgeDecisions.length === 0">
            <div class="panel empty">${t("这 7 天没有自动决定。", "No automatic decisions in the last 7 days.")}</div>
          </template>
          <div x-show="judgeDecisions.length" class="panel divide">
            <template x-for="item in judgeDecisions" :key="item.id">
              <div class="flex flex-wrap items-start gap-3 px-[18px] py-3.5">
                <div class="min-w-0 flex-1">
                  <div class="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
                    <span class="chip" :class="item.undone ? 'chip-dim' : (item.status === 'approved' ? 'chip-ok' : 'chip-dim')" x-text="judgeDecisionLabel(item)"></span>
                    <span class="chip" :class="typeChipClass(item.type)" x-text="typeLabel(item.type)"></span>
                    <span class="muted" x-text="dreamCandidateSourceLabel(item.source)"></span>
                    <span class="muted" x-text="fmt(item.updated_at)"></span>
                  </div>
                  <p class="whitespace-pre-wrap text-sm leading-7" x-text="item.content"></p>
                  <p x-show="item.reason" class="mt-1 text-[13px] muted" x-text="item.reason"></p>
                </div>
                <button type="button" x-show="item.undoable" @click="undoJudgeDecision(item)" class="btn btn-sm">${I.undo}<span x-text="judgeUndoLabel(item)"></span></button>
              </div>
            </template>
          </div>
        </div>
      </section>
`;
