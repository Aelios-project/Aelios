// 后台页面是一整串 HTML：Alpine 管交互，Tailwind CDN 只用来排版，颜色和部件都走下面的 CSS 变量。
// 中英两套文字：静态文字写成 t('中文', 'English') 两个 span，按 <html data-lang> 只显示一个；
// 绑定里的文字用组件里的 L('中文', 'English')。

export const svg = (body: string, size = 18): string =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const t = (zh: string, en: string): string => `<span class="zh">${zh}</span><span class="en">${en}</span>`;

export const I = {
  home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
  inbox: svg('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  book: svg('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
  db: svg('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>'),
  spark: svg('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 3v4M17 5h4"/>'),
  moon: svg('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>'),
  swap: svg('<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>'),
  sliders: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>'),
  updown: svg('<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>', 16),
  refresh: svg('<path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M3 21v-5h5"/>'),
  heart: svg('<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  checkBig: svg('<path d="M20 6 9 17l-5-5"/>', 20),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 16),
  minus: svg('<path d="M5 12h14"/>', 16),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>', 16),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>', 16),
  more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  chevron: svg('<path d="m6 9 6 6 6-6"/>', 16),
  menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  ext: svg('<path d="M7 17 17 7M8 7h9v9"/>', 14),
  upload: svg('<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>'),
  download: svg('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  list: svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
  play: svg('<path d="m6 4 14 8-14 8z"/>', 16),
  pause: svg('<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>', 16),
  trash: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>', 16),
  pencil: svg('<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>', 16),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', 16),
  alert: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>', 16)
};
export const ICON_LINK = svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>', 16);
export const ICON_SPIN = svg('<path d="M21 12a9 9 0 1 1-6.22-8.56"/>', 16);
export const HEART_FILLED = I.heart.replace('fill="none"', 'fill="currentColor"');

// 侧栏里的一项：点了换页。星图是另一个独立页面，跳过去。
export const navLink = (id: string, icon: string, zh: string, en: string, extra = ""): string =>
  `<button type="button" @click="go('${id}')" class="nav-link" :class="page === '${id}' ? 'is-active' : ''" :aria-current="page === '${id}' ? 'page' : null">${icon}<span class="flex-1 text-left">${t(zh, en)}</span>${extra}</button>`;

// 设置页每一项：名字一行，说明收在 ⓘ 里点开才看；开关点了就存，文字改完离开输入框就存。
export const SETTING_ROW = `<div class="set-row" :title="item.name">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span x-show="item.saved" class="dot-changed" aria-hidden="true"></span>
                    <template x-if="item.kind === 'switch'"><span class="set-label" :id="'lb-' + item.name" x-text="sLabel(item)"></span></template>
                    <template x-if="item.kind !== 'switch'"><label class="set-label" :for="'setting-' + item.name" x-text="sLabel(item)"></label></template>
                    <button type="button" x-show="sHint(item)" @click="toggleHint(item.name)" class="info-btn" :aria-expanded="hintOpen(item.name) ? 'true' : 'false'" :aria-label="L('说明：', 'About: ') + sLabel(item)">${I.info}</button>
                    <button type="button" x-show="item.saved" @click="saveSetting(item, '')" :disabled="item.busy" class="reset-btn" x-text="L('已改 · 恢复默认', 'Changed · Reset')"></button>
                  </div>
                  <div x-show="hintOpen(item.name)" class="set-hint">
                    <span x-text="sHint(item)"></span><code x-text="item.name"></code>
                  </div>
                </div>
                <template x-if="item.kind === 'switch'">
                  <button type="button" role="switch" :aria-checked="settingOn(item) ? 'true' : 'false'" :aria-labelledby="'lb-' + item.name" :disabled="item.busy" @click="toggleSetting(item)" class="switch" :class="settingOn(item) ? 'is-on' : ''"><span></span></button>
                </template>
                <template x-if="item.kind !== 'switch'">
                  <input :id="'setting-' + item.name" x-model="item.value" @change="saveSetting(item, item.value)" @keydown.enter.prevent="$event.target.blur()" @keydown.escape="item.value = item.saved; $event.target.blur()" :disabled="item.busy" :placeholder="item.deployed ? L('留空用 ', 'Blank uses ') + item.deployed : L('留空用默认值', 'Blank uses the default')" class="field set-input">
                </template>
              </div>`;

// 待审里的一张卡，日常和导入两栏共用；导入的没有勾选框，批量走 clef 那两个按钮。
export const CANDIDATE_CARD = `<article class="panel cand">
              <input type="checkbox" x-show="!candidate.import_id" class="cand-check" :checked="!!reviewSelected[candidate.id]" @change="reviewToggle(candidate.id)" :aria-label="L('选择这条', 'Select this one')">
              <div class="cand-body">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="chip" :class="typeChipClass(candidate.type)" x-text="typeLabel(candidate.type)"></span>
                  <span class="chip" :class="candidateKindClass(candidate)" x-text="candidateKindLabel(candidate)"></span>
                  <span x-show="candidate.import_id && candidate.day" class="chip chip-dim" x-text="candidate.day"></span>
                  <span x-show="candidate.clef_worth !== null && candidate.clef_worth !== undefined" class="chip" :class="clefLooksYes(candidate) ? 'chip-ok' : 'chip-dim'" x-text="clefOpinionLabel(candidate)"></span>
                  <span x-show="!candidate.import_id && candidate.confidence != null" class="conf">
                    <span x-text="L('把握 ', 'Confidence ') + pct(candidate.confidence)"></span>
                    <span class="meter" aria-hidden="true"><span :style="'width:' + pct(candidate.confidence)"></span></span>
                  </span>
                </div>
                <template x-if="candidate.existing_content">
                  <div class="was-now">
                    <span class="muted" x-text="L('原来', 'Was')"></span><span class="line-through-soft" x-text="candidate.existing_content"></span>
                    <span class="muted" x-text="L('改成', 'Now')"></span><span x-text="candidate.content"></span>
                  </div>
                </template>
                <p x-show="!candidate.editing && !candidate.existing_content" class="cand-text" x-text="candidate.content"></p>
                <p x-show="candidate.source === 'dream_delete'" class="cand-note">
                  <span x-text="L('原因：', 'Why: ') + (candidate.decision_note || L('整理时觉得不再成立', 'no longer seemed true'))"></span>
                  <span class="mono" x-text="candidate.target_memory_id ? ' · ' + candidate.target_memory_id : ''"></span>
                </p>
                <template x-if="candidate.editing">
                  <div class="mt-3 grid gap-2">
                    <textarea x-model="candidate.draft.content" class="field min-h-28" :aria-label="L('内容', 'Content')"></textarea>
                    <div class="grid gap-2 sm:grid-cols-2">
                      <select x-model="candidate.draft.type" class="field" :aria-label="L('类型', 'Type')">
                        <template x-for="type in canonicalMemoryTypes" :key="type"><option :value="type" x-text="typeLabel(type)"></option></template>
                      </select>
                      <input x-model="candidate.draft.fact_key" class="field mono" placeholder="fact_key">
                    </div>
                  </div>
                </template>
                <div x-show="candidate.mergeOpen" class="mt-3 flex flex-wrap gap-2">
                  <input x-model="candidate.target_id" class="field min-w-0 flex-1" :placeholder="L('要并进去的那条记忆的 id', 'id of the memory to merge into')">
                  <button type="button" @click="mergeCandidate(candidate)" class="btn btn-sm" x-text="L('合并', 'Merge')"></button>
                </div>
                <button type="button" @click="toggleCandidateSources(candidate)" class="link-btn mt-2" :aria-expanded="candidate.sourcesOpen ? 'true' : 'false'">
                  <span x-text="candidate.sourcesOpen ? L('收起原话', 'Hide source') : L('看原话', 'Show source')"></span>
                  <span class="chev" :class="candidate.sourcesOpen ? 'is-open' : ''">${I.chevron}</span>
                </button>
                <div x-show="candidate.sourcesOpen" class="quotes">
                  <p x-show="!candidate.sources" class="muted text-xs" x-text="L('加载中…', 'Loading…')"></p>
                  <template x-for="message in (candidate.sources || [])" :key="message.id">
                    <blockquote>
                      <span class="muted text-xs" x-text="roleName(message.role) + (message.created_at ? ' · ' + quoteTime(message.created_at) : '')"></span>
                      <span class="block whitespace-pre-wrap" x-text="message.content"></span>
                    </blockquote>
                  </template>
                  <p x-show="candidate.sources && candidate.sources.length === 0" class="muted text-xs" x-text="L('这条没有挂原话（整理好的条目本身就是原文）。', 'No source lines attached (a prepared list item is its own source).')"></p>
                </div>
              </div>
              <div class="cand-actions">
                <button type="button" @click="approveCandidate(candidate)" class="btn btn-primary btn-sm">${I.check}<span x-text="candidate.editing ? L('改好记住', 'Save & remember') : candidateApproveLabel(candidate)"></span></button>
                <button type="button" @click="discardCandidate(candidate)" class="btn btn-sm" x-text="candidateDiscardLabel(candidate)"></button>
                <div class="relative">
                  <button type="button" @click="candidate.moreOpen = !candidate.moreOpen" class="btn btn-sm btn-icon-sm" :aria-expanded="candidate.moreOpen ? 'true' : 'false'" :aria-label="L('更多操作', 'More actions')">${I.more}</button>
                  <div x-show="candidate.moreOpen" @click.outside="candidate.moreOpen = false" class="menu">
                    <button type="button" @click="toggleCandidateEdit(candidate); candidate.moreOpen = false" x-text="candidate.editing ? L('取消编辑', 'Cancel editing') : L('编辑后记住', 'Edit, then remember')"></button>
                    <button type="button" x-show="!candidate.import_id" @click="candidate.mergeOpen = !candidate.mergeOpen; candidate.moreOpen = false" x-text="L('并进已有的一条', 'Merge into an existing one')"></button>
                  </div>
                </div>
              </div>
            </article>`;
