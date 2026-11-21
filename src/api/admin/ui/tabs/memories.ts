import { I, HEART_FILLED, t } from "../helpers";

export const ADMIN_TAB_MEMORIES = `      <!-- ===== 记忆库：重要 + 珍贵 / 黑话 / 小本本 / 世界知识 ===== -->
      <section x-show="savedApiKey.trim() && page === 'memory'" class="page">
        <header class="page-head">
          <div>
            <h1 class="h1">${t("记忆库", "Memories")}</h1>
            <p class="sub">${t("助手会在对话里想起这些。", "What your assistant can recall in conversation.")}</p>
          </div>
          <div x-show="moreView === 'important'" class="flex flex-wrap gap-2">
            <label class="search w-[260px] max-w-full">${I.search}<span class="sr-only" x-text="L('搜索记忆', 'Search memories')"></span><input type="search" x-model="memoryQuery" :placeholder="L('搜索记忆', 'Search memories')"></label>
            <button type="button" @click="openMemoryCreate()" class="btn btn-primary">${I.plus}${t("新建", "New")}</button>
          </div>
        </header>

        <div class="tabs" role="tablist" :aria-label="L('记忆分类', 'Memory sections')">
          <button type="button" role="tab" @click="openMemoryTab('important')" class="tab" :class="moreView === 'important' ? 'is-active' : ''" :aria-selected="moreView === 'important' ? 'true' : 'false'">${t("重要", "Core")}<span class="count" x-text="typeCount('all')"></span></button>
          <template x-for="item in moreNav" :key="item.id">
            <button type="button" role="tab" @click="openMemoryTab(item.id)" class="tab" :class="moreView === item.id ? 'is-active' : ''" :aria-selected="moreView === item.id ? 'true' : 'false'"><span x-text="L(item.label, item.labelEn)"></span><span class="count" x-text="memoryTabCount(item.id)"></span></button>
          </template>
        </div>

        <div x-show="moreView === 'important'" class="flex flex-col gap-4">
          <div class="flex flex-wrap gap-2" role="group" :aria-label="L('按类型筛选', 'Filter by type')">
            <template x-for="type in memoryTypes" :key="type">
              <button type="button" @click="memoryType = type; loadMemories()" class="pill" :class="memoryType === type ? 'is-active' : ''" :aria-pressed="memoryType === type ? 'true' : 'false'"><span x-text="memoryTypeLabel(type)"></span> <span class="count" x-show="type !== 'all'" x-text="typeCount(type)"></span></button>
            </template>
          </div>

          <div x-show="memoryCreateOpen" class="panel panel-pad grid gap-3">
            <div class="flex items-center justify-between gap-3">
              <h2 class="h2">${t("新建一条记忆", "New memory")}</h2>
              <button type="button" @click="memoryCreateOpen = false" class="btn btn-icon btn-sm btn-icon-sm" :aria-label="L('关闭', 'Close')">${I.x}</button>
            </div>
            <label class="block"><span class="label">${t("内容", "Content")}</span>
              <textarea x-model="memoryDraft.content" class="field min-h-24" :placeholder="L('一句稳定、以后用得上的事', 'One lasting fact worth recalling later')"></textarea>
            </label>
            <div class="grid gap-3 md:grid-cols-2">
              <label class="block"><span class="label">${t("类型", "Type")}</span>
                <select x-model="memoryDraft.type" class="field">
                  <template x-for="type in canonicalMemoryTypes" :key="type"><option :value="type" x-text="typeLabel(type)"></option></template>
                </select>
              </label>
              <label class="block"><span class="label">${t("重要性", "Importance")} <span x-text="memoryDraft.importance.toFixed(2)"></span></span>
                <input type="range" min="0" max="1" step="0.05" x-model.number="memoryDraft.importance" class="w-full">
              </label>
            </div>
            <details>
              <summary class="text-[13px] muted">${t("技术信息", "Details")}</summary>
              <div class="mt-3 grid gap-3 md:grid-cols-2">
                <label class="block"><span class="label">${t("fact_key（留空按内容自动生成）", "fact_key (blank: made from the content)")}</span>
                  <input x-model="memoryDraft.fact_key" class="field mono" placeholder="preference:answer-style">
                </label>
                <label class="block"><span class="label">${t("把握", "Confidence")} <span x-text="memoryDraft.confidence.toFixed(2)"></span></span>
                  <input type="range" min="0" max="1" step="0.05" x-model.number="memoryDraft.confidence" class="w-full">
                </label>
              </div>
            </details>
            <div class="flex justify-end gap-2">
              <button type="button" @click="memoryCreateOpen = false" class="btn" x-text="L('取消', 'Cancel')"></button>
              <button type="button" @click="createMemory()" :disabled="saving" class="btn btn-primary" x-text="L('保存', 'Save')"></button>
            </div>
          </div>

          <section class="panel overflow-hidden" :aria-label="L('记忆列表', 'Memory list')">
            <div class="hidden flex-wrap items-center gap-4 px-[18px] py-2.5 text-xs md:flex" style="background: var(--soft); color: var(--t3)">
              <span class="flex-[1_1_320px]">${t("内容", "Memory")}</span>
              <span class="mem-col">${t("类型", "Type")}</span>
              <span class="mem-col">${t("重要性", "Importance")}</span>
              <span class="mem-col">${t("更新", "Updated")}</span>
            </div>
            <div class="divide">
              <template x-if="filteredMemories().length === 0">
                <div class="empty" x-text="memoryQuery.trim() ? L('没有找到相关的记忆。', 'No memories match.') : L('这一类还没有记忆。', 'Nothing in this category yet.')"></div>
              </template>
              <template x-for="memory in filteredMemories()" :key="memory.id">
                <div :style="memory.open ? 'background: var(--soft)' : ''">
                  <button type="button" @click="memory.open = !memory.open" class="mem-head" :aria-expanded="memory.open ? 'true' : 'false'">
                    <span class="mem-text">
                      <span x-show="isScopedDecision(memory)" class="mb-1 inline-flex"><span class="chip t-decision" x-text="decisionBadge(memory)"></span></span>
                      <span class="block" :class="memory.open ? '' : 'line-clamp-2'" x-text="memory.content"></span>
                      <span x-show="memory.current_state && memory.current_state.status === 'outdated'" class="mt-1 block text-xs" style="color: var(--warn)" x-text="outdatedNotice(memory)"></span>
                    </span>
                    <span class="mem-col"><span class="chip" :class="typeChipClass(memory.type)" x-text="typeLabel(memory.type)"></span></span>
                    <span class="mem-col" x-text="importanceLabel(memory.importance)"></span>
                    <span class="mem-col" x-text="shortDate(memory.valid_as_of || memory.updated_at || memory.created_at)"></span>
                  </button>
                  <div x-show="memory.open" class="mem-detail">
                    <template x-if="memory.editing">
                      <textarea x-model="memory.draft.content" class="field min-h-32" :aria-label="L('内容', 'Content')"></textarea>
                    </template>
                    <div class="facts">
                      <div><span class="k">${t("重要性", "Importance")}</span><span x-text="importanceLabel(memory.importance)"></span></div>
                      <div><span class="k">${t("把握", "Confidence")}</span><span x-text="pct(memory.confidence)"></span></div>
                      <div x-show="isScopedDecision(memory)"><span class="k">${t("决定范围", "Decision scope")}</span><span class="mono text-xs" x-text="decisionScopeLabel(memory)"></span></div>
                      <div x-show="isScopedDecision(memory) && memory.valid_as_of"><span class="k">${t("决定日期", "Decided on")}</span><span x-text="fmt(memory.valid_as_of)"></span></div>
                      <div x-show="memory.supersedes_id"><span class="k">${t("取代了", "Replaced")}</span><span class="mono text-xs" x-text="memory.supersedes_id"></span></div>
                      <div x-show="memory.superseded_by_id"><span class="k">${t("被它取代", "Replaced by")}</span><span class="mono text-xs" x-text="memory.superseded_by_id"></span></div>
                      <div><span class="k">${t("历史", "History")}</span><button type="button" @click="toggleMemoryRevisions(memory)" class="link text-left" x-text="memory.revOpen ? (isScopedDecision(memory) ? L('收起历史与依据', 'Hide history & sources') : L('收起旧版', 'Hide versions')) : (isScopedDecision(memory) ? L('看历史与依据', 'See history & sources') : L('看旧版', 'See versions'))"></button></div>
                    </div>
                    <div x-show="memory.revOpen" class="flex flex-col gap-2 rounded-[10px] p-3" style="background: var(--soft)">
                      <p x-show="!isScopedDecision(memory)" class="text-xs muted">${t("原地改写之前的样子都在这里（最多 20 版）。恢复也是一次改写，现在这版会先存进来。", "Earlier versions from in-place edits (up to 20). Restoring is also an edit; the current version is saved first.")}</p>
                      <p x-show="isScopedDecision(memory)" class="text-xs muted">${t("这里展示同范围的历史决定、晚到修订与依据原话。决定记录不能直接编辑正文。", "Shows superseded decisions in this scope, late-arriving revisions, and source messages. Decision records cannot be edited directly.")}</p>
                      <p x-show="!memory.revisions" class="text-xs muted" x-text="L('加载中…', 'Loading…')"></p>
                      <template x-if="isScopedDecision(memory) && memory.decision_history && memory.decision_history.length > 0">
                        <div class="flex flex-col gap-1.5">
                          <p class="text-xs font-medium muted">${t("替换链上的旧决定", "Earlier superseded decisions")}</p>
                          <template x-for="prev in memory.decision_history" :key="prev.id">
                            <div class="pt-2 text-[13px] leading-6" style="border-top: 1px solid var(--div)">
                              <div class="flex flex-wrap items-center gap-2 text-xs muted">
                                <span x-text="L('决定于 ', 'Decided ') + fmt(prev.valid_as_of || prev.created_at)"></span>
                                <span class="mono" x-text="prev.id"></span>
                              </div>
                              <p class="whitespace-pre-wrap" x-text="prev.content"></p>
                            </div>
                          </template>
                        </div>
                      </template>
                      <p x-show="memory.revisions && memory.revisions.length === 0 && (!isScopedDecision(memory) || !(memory.decision_history && memory.decision_history.length))" class="text-xs muted" x-text="isScopedDecision(memory) ? L('还没有更早的决定或修订。', 'No earlier decisions or revisions yet.') : L('没改写过。', 'Never edited.')"></p>
                      <template x-for="rev in (memory.revisions || [])" :key="rev.id">
                        <div class="pt-2 text-[13px] leading-6" style="border-top: 1px solid var(--div)">
                          <div class="flex flex-wrap items-center gap-2 text-xs muted">
                            <span x-text="L('写于 ', 'Written ') + fmt(rev.written_at || rev.created_at)"></span>
                            <span x-text="revisionReasonLabel(rev)"></span>
                            <button type="button" x-show="!isScopedDecision(memory)" @click="restoreMemoryRevision(memory, rev)" class="btn btn-sm ml-auto" x-text="L('恢复这版', 'Restore this')"></button>
                          </div>
                          <p class="whitespace-pre-wrap" x-text="rev.content"></p>
                        </div>
                      </template>
                      <template x-if="isScopedDecision(memory) && memory.sources">
                        <div class="flex flex-col gap-1.5 pt-2" style="border-top: 1px solid var(--div)">
                          <p class="text-xs font-medium muted">${t("依据原话", "Source messages")}</p>
                          <p x-show="memory.sources.messages.length === 0" class="text-xs muted" x-text="L('未找到仍在保留期内的依据原话。', 'No retained source messages found.')"></p>
                          <template x-for="msg in memory.sources.messages" :key="msg.id">
                            <div class="pt-1.5 text-[13px] leading-6" style="border-top: 1px solid var(--div)">
                              <div class="flex flex-wrap items-center gap-2 text-xs muted">
                                <span x-text="msg.role === 'user' ? L('用户', 'User') : L('助手', 'Assistant')"></span>
                                <span x-text="fmt(msg.created_at)"></span>
                              </div>
                              <p class="whitespace-pre-wrap" x-text="msg.content"></p>
                            </div>
                          </template>
                          <p x-show="memory.sources.missing > 0" class="text-xs muted" x-text="L('另有 ' + memory.sources.missing + ' 条原话已过期或被删除。', memory.sources.missing + ' additional source message(s) expired or removed.')"></p>
                        </div>
                      </template>
                    </div>
                    <details>
                      <summary class="text-[13px] muted">${t("技术信息", "Details")}</summary>
                      <div class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                        <span class="muted">key</span><span class="mono break-all" x-text="memory.fact_key || '—'"></span>
                        <span class="muted">id</span><span class="mono break-all" x-text="memory.id"></span>
                        <span class="muted" x-show="(memory.tags || []).length">tags</span><span x-show="(memory.tags || []).length" x-text="(memory.tags || []).join(', ')"></span>
                      </div>
                    </details>
                    <div x-show="!isScopedDecision(memory) && memory.mergeOpen" class="flex flex-wrap gap-2">
                      <input x-model="memory.target_id" class="field min-w-0 flex-1" :placeholder="L('并进哪一条：填它的 id', 'Merge into: its id')">
                      <button type="button" @click="mergeDuplicate(memory)" class="btn btn-sm" x-text="L('合并', 'Merge')"></button>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                      <button type="button" x-show="!isScopedDecision(memory)" @click="toggleMemoryEdit(memory)" class="btn btn-sm" x-text="memory.editing ? L('取消', 'Cancel') : L('编辑', 'Edit')"></button>
                      <button type="button" x-show="!isScopedDecision(memory) && memory.editing" @click="saveMemory(memory)" class="btn btn-primary btn-sm" x-text="L('保存', 'Save')"></button>
                      <button type="button" x-show="!isScopedDecision(memory)" @click="memory.mergeOpen = !memory.mergeOpen" class="btn btn-sm" x-text="L('和别的合并', 'Merge with another')"></button>
                      <span x-show="isScopedDecision(memory)" class="text-xs muted" x-text="L('决定记录不能直接编辑正文；要改请撤回依据原话，或重新说一次。', 'Decision records cannot be edited directly; withdraw the source message or state a new decision.')"></span>
                      <button type="button" @click="deleteMemory(memory)" class="btn btn-sm btn-danger ml-auto" x-text="L('移除', 'Remove')"></button>
                    </div>
                  </div>
                </div>
              </template>
            </div>
            <div x-show="memories.length" class="px-[18px] py-3 text-xs muted" style="border-top: 1px solid var(--div)" x-text="memoryFooter()"></div>
          </section>
        </div>

        <div x-show="moreView === 'precious'" class="flex flex-col gap-3">
          <p class="text-[13px] muted">${t("在首页点 ♥ 收下的原话，原样保留，不会被整理改写。", "Exact lines you saved with ♥ on Home. Kept word for word; the nightly run never rewrites them.")}</p>
          <template x-if="precious.length === 0"><div class="panel empty">${t("还没有珍贵。", "No keepsakes yet.")}</div></template>
          <div x-show="precious.length" class="panel divide">
            <template x-for="item in precious" :key="item.id">
              <div class="flex items-start gap-3 px-[18px] py-3.5">
                <div class="min-w-0 flex-1">
                  <div class="mb-1 text-xs muted" x-text="fmt(item.created_at)"></div>
                  <p class="whitespace-pre-wrap text-sm leading-7" x-text="item.content"></p>
                </div>
                <button type="button" @click="unpinPrecious(item)" class="heart is-on" :aria-label="L('取消珍贵', 'Remove from keepsakes')" :title="L('取消珍贵', 'Remove from keepsakes')">${HEART_FILLED}</button>
              </div>
            </template>
          </div>
        </div>

        <div x-show="moreView === 'glossary'" class="flex flex-col gap-3">
          <p class="text-[13px] muted">${t("昵称和只有你们懂的梗。聊天里出现时，助手会照这里理解。", "Nicknames and in-jokes. When they come up, your assistant reads them this way.")}</p>
          <div class="panel panel-pad grid gap-3">
            <div class="grid gap-3 md:grid-cols-[200px_1fr]">
              <input x-model="glossaryDraft.term" class="field" :placeholder="L('词，比如 小土豆', 'Word, e.g. spud')" :aria-label="L('词', 'Word')">
              <input x-model="glossaryDraft.definition" class="field" :placeholder="L('意思', 'What it means')" :aria-label="L('意思', 'Meaning')">
            </div>
            <div class="flex flex-wrap gap-3">
              <input x-model="glossaryDraft.aliasesText" class="field min-w-0 flex-1" :placeholder="L('别的叫法，用逗号隔开（可不填）', 'Other spellings, comma-separated (optional)')" :aria-label="L('别的叫法', 'Other spellings')">
              <button type="button" @click="saveGlossary()" :disabled="!glossaryDraft.term.trim()" class="btn btn-primary" x-text="L('保存', 'Save')"></button>
            </div>
          </div>
          <template x-if="glossary.length === 0"><div class="panel empty">${t("还没有黑话。", "No words yet.")}</div></template>
          <div x-show="glossary.length" class="panel divide">
            <template x-for="item in glossary" :key="item.id">
              <div class="flex items-start gap-3 px-[18px] py-3.5">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-baseline gap-2"><span class="font-semibold" x-text="item.term"></span><span class="text-xs muted" x-text="jsonList(item.aliases).join(' / ')"></span></div>
                  <p class="mt-1 text-sm leading-7" style="color: var(--t2)" x-text="item.definition"></p>
                </div>
                <button type="button" @click="deleteGlossary(item)" class="icon-btn" :aria-label="L('删除', 'Delete')" :title="L('删除', 'Delete')">${I.trash}</button>
              </div>
            </template>
          </div>
        </div>

        <div x-show="moreView === 'handoff'" class="flex flex-col gap-3">
          <p class="text-[13px] muted">${t("每个空间只保留当前一封交接信。你和 AI 都能编辑；仅调用 MCP wake_up 时带回，不自动加入模型上下文。", "One current handoff per space, editable by you and your AI. Returned only when MCP wake_up is called; never automatically added to model context.")}</p>
          <div class="panel panel-pad grid gap-3">
            <p class="text-xs muted" x-text="handoffNote.updated_at ? handoffNote.source + ' · ' + fmt(handoffNote.updated_at) : L('还没有交接信', 'No handoff yet')"></p>
            <textarea x-model="handoffDraft" :disabled="!handoffLoaded || handoffBusy" class="field min-h-64" :aria-label="L('当前交接信', 'Current handoff')"></textarea>
            <details><summary class="text-sm cursor-pointer" x-text="L('怎么写交接信', 'Writing guide')"></summary><p class="text-sm muted whitespace-pre-wrap" x-text="handoffGuide"></p></details>
            <div class="flex gap-2">
              <button type="button" @click="saveHandoff(false)" :disabled="!handoffLoaded || handoffBusy || !handoffDraft.trim()" class="btn btn-primary" x-text="L('保存', 'Save')"></button>
              <button type="button" @click="loadHandoff(true)" :disabled="handoffBusy" class="btn" x-text="L('重新读取', 'Reload')"></button>
              <button type="button" @click="saveHandoff(true)" :disabled="!handoffLoaded || handoffBusy || !handoffNote.content" class="btn btn-danger" x-text="L('删除', 'Delete')"></button>
            </div>
          </div>
        </div>

        <div x-show="moreView === 'notebook'" class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <p class="min-w-0 flex-1 text-[13px] muted">${t("助手按页名读写的笔记，比如备考进度。不会被自动想起，夜里不改写，也不过期。每个空间最多 50 页，每页 2 万字。", "Notes your assistant reads and writes by page name, like study progress. Never recalled on their own, never rewritten at night, never expire. Up to 50 pages per space, 20,000 characters each.")}</p>
            <div class="flex gap-2">
              <button type="button" @click="newNotebookPage()" class="btn btn-primary btn-sm">${I.plus}${t("新建一页", "New page")}</button>
              <button type="button" @click="clearNotebook()" :disabled="notebookPages.length === 0" class="btn btn-sm btn-danger" x-text="L('全部清空', 'Clear all')"></button>
            </div>
          </div>
          <template x-if="notebookDraft">
            <div id="notebook-editor" class="panel panel-pad grid scroll-mt-6 gap-3">
              <input x-model="notebookDraft.name" maxlength="60" class="field" :placeholder="L('页名，比如 经济师进度', 'Page name, e.g. exam-progress')" :aria-label="L('页名', 'Page name')">
              <textarea x-model="notebookDraft.content" class="field min-h-64" :placeholder="L('这一页记什么', 'What goes on this page')" :aria-label="L('内容', 'Content')"></textarea>
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-xs muted" x-text="notebookDraftLabel()"></span>
                <button type="button" @click="saveNotebookPage()" :disabled="saving" class="btn btn-primary btn-sm ml-auto" x-text="L('保存', 'Save')"></button>
                <button type="button" x-show="notebookDraft.id" @click="deleteNotebookPage()" class="btn btn-sm btn-danger" x-text="L('删除这页', 'Delete page')"></button>
                <button type="button" @click="notebookDraft = null" class="btn btn-sm" x-text="L('收起', 'Close')"></button>
              </div>
            </div>
          </template>
          <template x-if="notebookLoaded && notebookPages.length === 0 && !notebookDraft"><div class="panel empty">${t("小本本还是空的。", "The notebook is empty.")}</div></template>
          <div x-show="notebookPages.length" class="panel divide overflow-hidden">
            <template x-for="item in notebookPages" :key="item.id">
              <button type="button" @click="openNotebookPage(item)" class="entry-btn" :class="notebookDraft && notebookDraft.id === item.id ? 'is-active' : ''">
                <span class="flex items-center gap-3">
                  <span class="muted">${I.file}</span>
                  <span class="min-w-0 flex-1 truncate font-semibold" x-text="item.name"></span>
                  <span class="flex-none text-xs muted" x-text="fmt(item.updated_at) + ' · ' + L(item.size + ' 字', item.size + ' chars')"></span>
                </span>
              </button>
            </template>
          </div>
        </div>

        <div x-show="moreView === 'world'" class="flex flex-col gap-3">
          <p class="text-[13px] muted">${t("和你本人无关的常识、资料，平时不进对话，问到时才查。", "General knowledge and reference material, not about you. Only looked up when asked.")}</p>
          <div class="panel panel-pad grid gap-3">
            <div class="flex flex-wrap gap-2">
              <label class="search min-w-0 flex-1">${I.search}<input x-model="worldQuery" @keydown.enter.prevent="searchWorld()" type="search" :placeholder="L('搜索世界知识', 'Search world facts')" :aria-label="L('搜索世界知识', 'Search world facts')"></label>
              <button type="button" @click="searchWorld()" class="btn btn-primary" x-text="L('搜索', 'Search')"></button>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-xs muted">
              <span x-text="L('已选 ', 'Selected ') + selectedWorldCount() + ' / ' + worldItems.length"></span>
              <button type="button" @click="selectAllWorldItems()" class="btn btn-sm" x-text="L('全选当前', 'Select all shown')"></button>
              <button type="button" @click="clearWorldSelection()" class="btn btn-sm" x-text="L('清空选择', 'Clear selection')"></button>
              <button type="button" @click="deleteSelectedWorldItems()" :disabled="selectedWorldCount() === 0 || saving" class="btn btn-sm btn-danger" x-text="L('删除选中', 'Delete selected')"></button>
            </div>
          </div>
          <template x-if="worldItems.length === 0"><div class="panel empty">${t("这里还没有条目。", "Nothing here yet.")}</div></template>
          <div x-show="worldItems.length" class="panel divide">
            <template x-for="item in worldItems" :key="worldItemKey(item)">
              <div class="flex items-start gap-3 px-[18px] py-3.5">
                <input type="checkbox" class="mt-1" :checked="isWorldSelected(item)" @change="toggleWorldItem(item)" :aria-label="L('选择这条', 'Select this one')">
                <div class="min-w-0 flex-1">
                  <div class="mb-1 flex flex-wrap gap-2 text-xs muted"><span x-text="item.type || 'longtail'"></span><span x-text="item.source || ''"></span></div>
                  <p class="whitespace-pre-wrap text-sm leading-7" x-text="item.content"></p>
                </div>
                <button type="button" @click="deleteWorldMemory(item)" class="icon-btn" :aria-label="L('删除', 'Delete')" :title="L('删除', 'Delete')">${I.trash}</button>
              </div>
            </template>
          </div>
        </div>
      </section>
`;
