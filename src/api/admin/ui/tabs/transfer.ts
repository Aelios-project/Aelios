import { I, t } from "../helpers";

export const ADMIN_TAB_TRANSFER = `      <!-- ===== 导入导出 ===== -->
      <section x-show="savedApiKey.trim() && page === 'transfer'" class="page">
        <header class="page-head">
          <div>
            <h1 class="h1">${t("导入导出", "Import &amp; export")}</h1>
            <p class="sub">${t("把记忆搬进来，或者备份出去。", "Bring memories in, or back them up.")}</p>
          </div>
          <span class="chip"><span x-text="L('记忆空间：', 'Memory space: ')"></span><span class="font-semibold" x-text="namespace"></span></span>
        </header>

        <div class="grid gap-3 md:grid-cols-3" role="radiogroup" :aria-label="L('要做什么', 'What to do')">
          <button type="button" role="radio" @click="transferMode = 'chat'" class="mode-card" :class="transferMode === 'chat' ? 'is-active' : ''" :aria-checked="transferMode === 'chat' ? 'true' : 'false'">
            <span class="ico">${I.chat}</span>
            <span><span class="block font-semibold">${t("导入聊天记录", "Import chat history")}</span><span class="mt-1 block text-[13px] muted">${t("支持 ChatGPT、Claude 和酒馆的导出文件。", "Supports exports from ChatGPT, Claude or SillyTavern.")}</span></span>
          </button>
          <button type="button" role="radio" @click="transferMode = 'entries'" class="mode-card" :class="transferMode === 'entries' ? 'is-active' : ''" :aria-checked="transferMode === 'entries' ? 'true' : 'false'">
            <span class="ico">${I.list}</span>
            <span><span class="block font-semibold">${t("导入整理好的条目", "Import a list")}</span><span class="mt-1 block text-[13px] muted">${t("一行一条的清单，也能从别的 AI 搬过来。", "One memory per line. Works for moving over from another AI.")}</span></span>
          </button>
          <button type="button" role="radio" @click="transferMode = 'export'" class="mode-card" :class="transferMode === 'export' ? 'is-active' : ''" :aria-checked="transferMode === 'export' ? 'true' : 'false'">
            <span class="ico">${I.download}</span>
            <span><span class="block font-semibold">${t("导出备份", "Export a backup")}</span><span class="mt-1 block text-[13px] muted">${t("Markdown 能直接改，JSONL 最完整。", "Markdown you can edit, or JSONL with every field.")}</span></span>
          </button>
        </div>

        <section x-show="transferMode === 'chat'" class="panel panel-pad flex flex-col gap-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 class="h2">${t("导入聊天记录", "Import chat history")}</h2>
            <ol class="steps" :aria-label="L('进度', 'Progress')">
              <li :class="chatStep() > 1 ? 'is-done' : 'is-now'"><span class="n" x-text="chatStep() > 1 ? '✓' : '1'"></span><span x-text="L('选文件', 'Pick a file')"></span></li>
              <li class="sep" aria-hidden="true"></li>
              <li :class="chatStep() > 2 ? 'is-done' : chatStep() === 2 ? 'is-now' : ''"><span class="n" x-text="chatStep() > 2 ? '✓' : '2'"></span><span x-text="transfer.chatMode === 'archive' ? L('归档', 'Archive') : L('整理中', 'Reading')"></span></li>
              <li class="sep" aria-hidden="true"></li>
              <li :class="chatStep() === 3 ? 'is-now' : ''"><span class="n">3</span><span x-text="transfer.chatMode === 'archive' ? L('完成', 'Done') : L('去待审确认', 'Confirm in Review')"></span></li>
            </ol>
          </div>
          <template x-if="!transfer.chat">
            <div class="flex flex-col items-start gap-3">
              <p class="text-[13px] muted">${t("认得 ChatGPT、Claude 导出的 conversations.json，酒馆的 .jsonl，还有「名字：内容」一句一行的文本。文件在浏览器里拆开，再分段导入。", "Reads ChatGPT and Claude conversations.json exports, SillyTavern .jsonl, and plain “Name: text” lines. Your browser splits the file into parts for import.")}</p>
              <label class="btn btn-primary cursor-pointer">${I.upload}<span x-text="transfer.chatLoading ? L('在读文件…', 'Reading file…') : L('选聊天记录文件', 'Choose a chat file')"></span>
                <input type="file" accept=".json,.jsonl,.txt,.md,.markdown" class="hidden" @change="loadChatFile($event)">
              </label>
            </div>
          </template>
          <template x-if="transfer.chat">
            <div class="flex flex-col gap-4">
              <div class="flex flex-wrap items-center gap-3 rounded-[12px] p-3.5" style="background: var(--soft)">
                <span class="avatar">${I.file}</span>
                <div class="min-w-0 flex-1">
                  <div class="truncate font-semibold" x-text="transfer.chat.name"></div>
                  <div class="text-[13px] muted" x-text="chatSummaryLabel()"></div>
                </div>
                <label class="btn btn-sm cursor-pointer" :class="transfer.chatRun && transfer.chatRun.running ? 'pointer-events-none opacity-50' : ''"><span x-text="L('换一个文件', 'Choose another file')"></span>
                  <input type="file" accept=".json,.jsonl,.txt,.md,.markdown" class="hidden" @change="loadChatFile($event)">
                </label>
              </div>
              <template x-for="warning in transfer.chat.warnings" :key="warning"><p class="banner banner-warn" x-text="warning"></p></template>
              <div x-show="transfer.chat.needsRoles" class="flex flex-col gap-2">
                <p class="text-[13px]" style="color: var(--t2)">${t("文件里按名字分人。勾上哪些名字是你，其余算助手：", "The file names its speakers. Tick the names that are you; the rest count as the assistant:")}</p>
                <div class="flex flex-wrap gap-2">
                  <template x-for="speaker in transfer.chat.speakers" :key="speaker.name">
                    <label class="pill inline-flex cursor-pointer items-center gap-2" :class="speaker.isUser ? 'is-active' : ''">
                      <input type="checkbox" :checked="speaker.isUser" @change="speaker.isUser = $event.target.checked; rechunkChat()" :disabled="transfer.chatRun && transfer.chatRun.running">
                      <span x-text="speaker.name"></span><span class="count" x-text="speaker.count"></span>
                    </label>
                  </template>
                </div>
              </div>
              <label class="block">
                <span class="label">${t("导入方式", "Import mode")}</span>
                <select class="field" x-model="transfer.chatMode" @change="$nextTick(() => rechunkChat())" :disabled="transfer.chatRun && transfer.chatRun.running">
                  <option value="memory">${t("提取记忆，放进待审", "Extract memories for Review")}</option>
                  <option value="archive">${t("仅归档原文，供关键词搜索", "Archive text for keyword search")}</option>
                </select>
              </label>
              <label x-show="transfer.chatMode === 'memory' && transfer.info && transfer.info.clef.available" class="check items-start">
                <input type="checkbox" x-model="transfer.chatClef" class="mt-0.5">
                <span>${t("让 clef 顺手给每条打个分，待审页能按分筛。只是参考，会多用一点 Workers AI。", "Let clef score each one so you can filter in Review. Only a hint; uses a little more Workers AI.")}</span>
              </label>
              <template x-if="transfer.chatRun">
                <div class="flex flex-col gap-2">
                  <div class="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
                    <span x-text="L('已处理 ', '') + transfer.chatRun.done + ' / ' + transfer.chatRun.total + L(' 段', ' parts')"></span>
                    <span class="font-semibold" x-text="chatRunPercent() + '%'"></span>
                  </div>
                  <div class="bar" role="progressbar" :aria-valuenow="chatRunPercent()" aria-valuemin="0" aria-valuemax="100" :aria-label="L('导入进度', 'Import progress')"><div :style="'width:' + chatRunPercent() + '%'"></div></div>
                  <p class="text-xs muted" x-text="chatRunLabel()"></p>
                  <p x-show="transfer.chatRun.lastError" class="text-xs" style="color: var(--warn)" x-text="L('出错：', 'Error: ') + transfer.chatRun.lastError"></p>
                </div>
              </template>
              <div class="flex flex-wrap gap-2">
                <button type="button" x-show="!transfer.chatRun || (!transfer.chatRun.running && transfer.chatRun.done < transfer.chatRun.total)" @click="runChatImport()" :disabled="!transfer.chat.chunks" class="btn btn-primary">${I.play}<span x-text="transfer.chatRun && transfer.chatRun.done ? L('接着做', 'Continue') : L('开始', 'Start')"></span></button>
                <button type="button" x-show="transfer.chatRun && transfer.chatRun.running" @click="transfer.chatRun.stop = true" class="btn">${I.pause}<span x-text="transfer.chatRun && transfer.chatRun.stop ? L('这段做完就停', 'Stopping after this part') : L('暂停', 'Pause')"></span></button>
                <button type="button" x-show="transfer.chatRun && transfer.chatRun.candidates" @click="go('review'); openImportReview(transfer.chatRun.importId)" class="btn" x-text="transfer.chatRun ? L('去待审确认 ' + transfer.chatRun.candidates + ' 条', 'Confirm ' + transfer.chatRun.candidates + ' in Review') : ''"></button>
              </div>
              <div class="flex flex-col gap-1 text-xs muted">
                <span>${t("页面开着才会跑。关了也没事，下次选同一个文件、同样的勾选，做完的段会跳过，接着做。", "It only runs while this page is open. Closing is fine: pick the same file with the same ticks next time and it picks up where it left off.")}</span>
                <span x-show="transfer.chatMode === 'memory'">${t("候选先进待审。只长期保留被引用的原话。", "Candidates go to Review. Only the lines they cite are kept long-term.")}</span>
                <span x-show="transfer.chatMode === 'archive'">${t("归档后可用 MCP search_chat 查原话和前后文。归档不花模型 token。", "Use MCP search_chat to look up words and nearby messages. Archiving uses no model tokens.")}</span>
              </div>
            </div>
          </template>
        </section>

        <section x-show="transferMode === 'entries'" class="panel panel-pad flex flex-col gap-4">
          <div>
            <h2 class="h2">${t("导入整理好的条目", "Import a list")}</h2>
            <p class="mt-1 text-[13px] muted">${t("一行一条，比如 <code>- 2025-12-15 [偏好] 不吃香菜 #饮食</code>。日期、类型、标签都可以省；Aelios 导出的 md / jsonl 能原样导回，普通列表和一段段文字也认。", "One per line, like <code>- 2025-12-15 [preference] No cilantro #food</code>. Date, type and tags are optional; Aelios .md / .jsonl exports import as-is, and plain lists or paragraphs work too.")}</p>
          </div>
          <details class="rounded-[12px] p-3.5" style="background: var(--soft)">
            <summary class="text-[13px]" style="color: var(--t2)">${t("从别的 AI 搬？让它按这个格式把记得的事列出来", "Moving from another AI? Ask it to list what it remembers in this format")}</summary>
            <pre class="out mt-3" style="background: transparent; padding: 0" x-text="transfer.info ? transfer.info.prompt : L('加载中…', 'Loading…')"></pre>
            <button type="button" @click="copyImportPrompt()" class="btn btn-sm mt-3" x-text="L('复制提示词', 'Copy prompt')"></button>
          </details>
          <label class="block"><span class="label">${t("条目内容", "List contents")}</span>
            <textarea x-model="transfer.entriesText" @input="transfer.preview = null; transfer.entriesName = ''" rows="6" class="field" :placeholder="L('把清单粘贴进来，或者选一个文件', 'Paste the list here, or choose a file')"></textarea>
          </label>
          <div class="flex flex-wrap gap-2">
            <label class="btn cursor-pointer">${I.upload}<span x-text="L('选文件', 'Choose file')"></span>
              <input type="file" accept=".md,.markdown,.txt,.json,.jsonl" class="hidden" @change="loadEntriesFile($event)">
            </label>
            <button type="button" @click="previewEntries()" :disabled="!transfer.entriesText.trim() || transfer.entriesBusy" class="btn" x-text="L('先看看认出了什么', 'Preview what it found')"></button>
          </div>
          <template x-if="transfer.preview">
            <div class="flex flex-col gap-3">
              <p class="text-sm" x-text="entriesPreviewLabel()"></p>
              <template x-for="warning in transfer.preview.warnings" :key="warning"><p class="banner banner-warn" x-text="warning"></p></template>
              <div class="max-h-72 overflow-auto rounded-[12px] p-3" style="background: var(--soft)">
                <template x-for="(entry, index) in transfer.preview.entries.slice(0, 50)" :key="index">
                  <div class="flex items-start gap-2 py-1 text-[13px] leading-6">
                    <span class="chip" :class="entry.kind === 'precious' ? 'chip-coral' : typeChipClass(entry.type || 'fact')" x-text="entry.kind === 'precious' ? L('珍贵', 'Keepsake') : typeLabel(entry.type || 'fact')"></span>
                    <span class="min-w-0 flex-1"><span class="muted" x-text="entry.date ? entry.date + ' ' : ''"></span><span x-text="entry.content"></span> <span class="muted" x-text="(entry.tags || []).map(function(tag) { return '#' + tag; }).join(' ')"></span></span>
                  </div>
                </template>
                <p x-show="transfer.preview.entries.length > 50" class="text-xs muted" x-text="L('……还有 ' + (transfer.preview.entries.length - 50) + ' 条', '…and ' + (transfer.preview.entries.length - 50) + ' more')"></p>
              </div>
              <fieldset class="flex flex-col gap-2 text-sm">
                <legend class="label">${t("导进来以后", "After importing")}</legend>
                <label class="flex items-start gap-2"><input type="radio" value="direct" x-model="transfer.entriesMode" class="mt-1"><span>${t("直接写进记忆库。和已有的一字不差就跳过，很像的转去待审。", "Save straight to Memories. Exact duplicates are skipped; close matches go to Review.")}</span></label>
                <label class="flex items-start gap-2"><input type="radio" value="review" x-model="transfer.entriesMode" class="mt-1"><span>${t("全部先进待审，一条条过。", "Send everything to Review first, one by one.")}</span></label>
                <span class="text-xs muted">${t("标成珍贵的两种都直接收进珍贵。", "Items marked as keepsakes go straight to Keepsakes either way.")}</span>
              </fieldset>
              <div><button type="button" @click="runEntriesImport()" :disabled="transfer.entriesBusy || !transfer.preview.total" class="btn btn-primary">${I.upload}<span x-text="L('导入 ' + transfer.preview.total + ' 条', 'Import ' + transfer.preview.total)"></span></button></div>
            </div>
          </template>
          <p x-show="transfer.entriesRun" class="banner" x-text="entriesRunLabel()"></p>
        </section>

        <section x-show="transferMode === 'export'" class="panel">
          <div class="px-[18px] pt-4">
            <h2 class="h2">${t("导出备份", "Export a backup")}</h2>
            <p class="mt-1 text-[13px] muted" x-text="L('导出「' + namespace + '」空间里在用的记忆和珍贵。', 'Exports the active memories and keepsakes in the “' + namespace + '” space.')"></p>
          </div>
          <div class="divide mt-3" style="border-top: 1px solid var(--div)">
            <div class="row">
              <div class="min-w-0 flex-1"><div class="font-semibold">Markdown</div><div class="text-[13px] muted">${t("能直接打开改，改完从这里原样导回来（带 fact_key 的按 key 改写，旧版留着）。", "Open and edit it, then import it back here as-is (items with a fact_key update in place; old versions are kept).")}</div></div>
              <button type="button" @click="exportMemories('md')" :disabled="transfer.exporting" class="btn btn-primary btn-sm">${I.download}<span x-text="L('导出 .md', 'Export .md')"></span></button>
            </div>
            <div class="row">
              <div class="min-w-0 flex-1"><div class="font-semibold">JSONL</div><div class="text-[13px] muted">${t("字段最全，适合整份备份。", "Every field included. Best for full backups.")}</div></div>
              <button type="button" @click="exportMemories('jsonl')" :disabled="transfer.exporting" class="btn btn-sm">${I.download}<span x-text="L('导出 .jsonl', 'Export .jsonl')"></span></button>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h2 class="h2">${t("导入记录", "Past imports")}</h2>
            <button type="button" @click="loadImportBatches()" class="btn btn-icon btn-sm btn-icon-sm" :aria-label="L('刷新', 'Refresh')">${I.refresh}</button>
          </div>
          <div class="divide mt-3" style="border-top: 1px solid var(--div)">
            <template x-if="transfer.batches.length === 0"><div class="empty">${t("这个空间还没导入过。", "Nothing imported into this space yet.")}</div></template>
            <template x-for="batch in transfer.batches" :key="batch.id">
              <div class="row items-start">
                <span class="w-16 flex-none pt-0.5 text-xs muted" x-text="shortDate(batch.created_at || batch.updated_at)"></span>
                <div class="min-w-0 flex-1">
                  <div class="font-semibold" x-text="importBatchLabel(batch)"></div>
                  <div class="mt-0.5 text-[13px] muted" x-text="importBatchDetail(batch)"></div>
                </div>
                <span class="chip flex-none" :class="batchDone(batch) ? 'chip-ok' : 'chip-warn'" x-text="batchStatusLabel(batch)"></span>
              </div>
            </template>
          </div>
        </section>
      </section>
`;
