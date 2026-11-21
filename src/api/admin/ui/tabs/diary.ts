import { I, t } from "../helpers";

export const ADMIN_TAB_DIARY = `      <!-- ===== 日记 ===== -->
      <section x-show="savedApiKey.trim() && page === 'diary'" class="page">
        <header class="page-head">
          <div>
            <h1 class="h1">${t("日记", "Journal")}</h1>
            <p class="sub">${t("每晚整理完写一篇。是印象，细节以记忆库为准。", "One entry after each nightly run. An impression; Memories has the details.")}</p>
          </div>
          <div class="flex items-center gap-2">
            <div class="seg" role="group" :aria-label="L('日记类型', 'Entry type')">
              <button type="button" @click="diaryMode = 'daily'; diaryPick = ''; diaryReading = false" :class="diaryMode === 'daily' ? 'is-active' : ''" :aria-pressed="diaryMode === 'daily' ? 'true' : 'false'" x-text="L('每天', 'Daily')"></button>
              <button type="button" @click="diaryMode = 'weekly'; diaryPick = ''; diaryReading = false" :class="diaryMode === 'weekly' ? 'is-active' : ''" :aria-pressed="diaryMode === 'weekly' ? 'true' : 'false'" x-text="L('每周', 'Weekly')"></button>
              <button type="button" @click="diaryMode = 'monthly'; diaryPick = ''; diaryReading = false" :class="diaryMode === 'monthly' ? 'is-active' : ''" :aria-pressed="diaryMode === 'monthly' ? 'true' : 'false'" x-text="L('每月', 'Monthly')"></button>
            </div>
            <button type="button" @click="loadDiary()" class="btn btn-icon hidden md:inline-flex" :aria-label="L('刷新', 'Refresh')">${I.refresh}</button>
          </div>
        </header>

        <div class="journal" :class="diaryReading ? 'is-reading' : ''">
          <div class="journal-list flex flex-col gap-3">
            <button type="button" x-show="diaryMode === 'daily' && diaryWeeklies.length" @click="diaryMode = 'weekly'; openDiary('weekly:' + diaryWeeklies[0].week)" class="panel dream-stat grid gap-1 px-4 py-3.5 text-left">
              <span class="text-xs muted" x-text="diaryWeeklies.length ? L('最近一周 · ', 'Latest week · ') + diaryWeeklies[0].start_date + ' – ' + diaryWeeklies[0].end_date : ''"></span>
              <span class="font-semibold" x-text="diaryWeeklies.length ? diaryWeeklies[0].title : ''"></span>
              <span class="link">${t("读周记 →", "Read the weekly →")}</span>
            </button>
            <nav class="panel divide overflow-hidden" :aria-label="L('日记列表', 'Entries')">
              <template x-if="diaryListItems().length === 0">
                <div class="empty" x-text="diaryMode === 'daily' ? L('还没有日记。', 'No journal entries yet.') : diaryMode === 'monthly' ? L('还没有月记。', 'No monthly summaries yet.') : L('还没有周记。', 'No weekly summaries yet.')"></div>
              </template>
              <template x-for="item in diaryListItems()" :key="item.key">
                <button type="button" @click="openDiary(item.key)" class="entry-btn" :class="diaryCurrentKey() === item.key ? 'is-active' : ''" :aria-current="diaryCurrentKey() === item.key ? 'true' : null">
                  <span class="text-xs muted" x-text="item.when"></span>
                  <span class="truncate font-semibold" x-text="item.title"></span>
                  <span class="truncate text-[13px] muted" x-text="item.excerpt"></span>
                </button>
              </template>
            </nav>
          </div>

          <article class="panel reading">
            <button type="button" @click="diaryReading = false" class="link-btn journal-back mb-4" x-text="L('← 日记列表', '← All entries')"></button>
            <template x-if="!diaryCurrent()">
              <p class="muted">${t("选一篇来读。", "Pick an entry to read.")}</p>
            </template>
            <template x-for="entry in (diaryCurrent() ? [diaryCurrent()] : [])" :key="diaryCurrentKey()">
              <div>
                <div class="mb-5" style="border-bottom: 1px solid var(--div); padding-bottom: 16px">
                  <div class="text-[13px] muted" x-text="entry.month ? monthLabel(entry.month) : entry.week ? entry.week + ' · ' + entry.start_date + ' – ' + entry.end_date : longDayLabel(entry.date)"></div>
                  <h2 class="mt-1 text-[22px] font-semibold leading-snug" x-text="entry.title"></h2>
                  <div class="mt-2 flex flex-wrap gap-2">
                    <span x-show="entry.week" class="chip chip-violet" x-text="L(entry.source_days + ' 天汇入', 'From ' + entry.source_days + ' days')"></span>
                    <span x-show="entry.date && entry.source_message_ids && entry.source_message_ids.length" class="chip" x-text="L('基于 ' + (entry.source_message_ids || []).length + ' 条原文', 'From ' + (entry.source_message_ids || []).length + ' messages')"></span>
                    <span x-show="entry.date && entry.sources_kept != null" class="chip" :class="entry.sources_kept ? 'chip-ok' : 'chip-dim'" x-text="entry.sources_kept ? L('原文还在，可以回看', 'Originals still kept') : L('原文已过保留期，只剩这篇', 'Originals expired; only this entry remains')"></span>
                  </div>
                </div>
                <template x-for="(para, index) in paragraphs(entry.summary)" :key="index"><p x-text="para"></p></template>
                <div x-show="entry.date && entry.sources_kept !== 0" class="mt-6 flex flex-wrap items-center gap-3" style="border-top: 1px solid var(--div); padding-top: 16px">
                  <button type="button" x-show="entry.sources_kept !== 0" @click="rewriteDiary(entry)" :disabled="diaryRewriting !== ''" class="btn btn-sm" x-text="diaryRewriting === entry.date ? L('重写中，请保持页面打开…', 'Rewriting — keep this page open…') : L('用原文重写这篇', 'Rewrite from the originals')"></button>
                  <span x-show="entry.sources_kept !== 0" class="text-xs muted">${t("会覆盖现在的内容。", "Replaces the current text.")}</span>
                </div>
              </div>
            </template>
          </article>
        </div>
      </section>
`;
