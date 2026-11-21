export const ADMIN_SCRIPT_TRANSFER = String.raw`    // ===== 导入导出 =====
    nsPath(path, ns) {
      const sep = path.indexOf('?') === -1 ? '?' : '&';
      return path + sep + 'namespace=' + encodeURIComponent(ns || 'default');
    },
    async sha256(text) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
    },
    fmtTokens(value) {
      const n = Number(value || 0);
      if (this.lang === 'en') {
        if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k';
        return String(n);
      }
      if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + ' 万';
      return String(n);
    },
    quoteTime(value) {
      // 只知道哪天的原话就是 YYYY-MM-DD；有时间的换成本地时间显示。
      if (!value || /^\d{4}-\d{2}-\d{2}$/.test(value)) return value || '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      const pad = function(n) { return String(n).padStart(2, '0'); };
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    },
    importTypeLabel(type) {
      return this.typeLabel(type || 'fact');
    },
    get importPendingCount() {
      return (this.stats && this.stats.pending_import_candidates) || 0;
    },
    async loadTransferInfo() {
      const revision = this.spaceRevision;
      try {
        const data = await this.request(this.withNamespace('/v1/import/info'));
        if (revision !== this.spaceRevision) return;
        this.transfer.info = data.data || null;
      } catch (error) {
        if (revision === this.spaceRevision) this.notify(error.message);
      }
    },
    async loadImportBatches() {
      const revision = this.spaceRevision;
      try {
        const data = await this.request(this.withNamespace('/v1/import/batches?limit=50'));
        if (revision !== this.spaceRevision) return;
        this.transfer.batches = data.data || [];
        this.importReview.batches = this.transfer.batches.filter(function(batch) { return batch.kind !== 'archive'; });
      } catch (error) {
        if (revision === this.spaceRevision) this.notify(error.message);
      }
    },
    importBatchLabel(batch) {
      const kind = batch.kind === 'archive' ? this.L('聊天档案', 'Chat archive') : batch.kind === 'chat' ? this.L('聊天记录', 'Chat history') : this.L('条目', 'List');
      const range = batch.first_date ? this.L('（', ' (') + batch.first_date + (batch.last_date && batch.last_date !== batch.first_date ? this.L(' 到 ', ' to ') + batch.last_date : '') + this.L('）', ')') : '';
      return kind + ' · ' + (batch.name || this.L('没起名', 'untitled')) + range;
    },
    importBatchDetail(batch) {
      if (batch.kind === 'archive') return (batch.done_chunks || 0) + ' / ' + (batch.total_chunks || 0) + this.L(' 段已归档', ' parts archived');
      const review = this.L('待审 ' + (batch.pending || 0) + '，记住 ' + (batch.approved || 0) + '，丢弃 ' + (batch.discarded || 0), (batch.pending || 0) + ' waiting, ' + (batch.approved || 0) + ' remembered, ' + (batch.discarded || 0) + ' discarded');
      if (batch.kind !== 'chat') return this.L((batch.total_messages || 0) + ' 条，' + (batch.candidates || 0) + ' 条进了待审（' + review + '）', (batch.total_messages || 0) + ' items, ' + (batch.candidates || 0) + ' sent to Review (' + review + ')');
      return this.L('做了 ' + (batch.done_chunks || 0) + ' / ' + (batch.total_chunks || 0) + ' 段，' + (batch.candidates || 0) + ' 条候选（' + review + '），模型 ' + (batch.model_calls || 0) + ' 次，', (batch.done_chunks || 0) + ' / ' + (batch.total_chunks || 0) + ' parts, ' + (batch.candidates || 0) + ' candidates (' + review + '), ' + (batch.model_calls || 0) + ' model calls, ')
        + this.fmtTokens(batch.tokens_in) + this.L(' 进 / ', ' in / ') + this.fmtTokens(batch.tokens_out) + this.L(' 出 token', ' out tokens') + (batch.clef_calls ? ', clef ' + batch.clef_calls : '');
    },
    batchDone(batch) {
      return batch.kind === 'entries' || (Number(batch.total_chunks) > 0 && Number(batch.done_chunks) >= Number(batch.total_chunks));
    },
    batchStatusLabel(batch) {
      if (this.batchDone(batch)) return this.L('完成', 'Done');
      const total = Number(batch.total_chunks) || 0;
      const percent = total ? Math.round((Number(batch.done_chunks) || 0) / total * 100) : 0;
      const running = this.transfer.chatRun && this.transfer.chatRun.running && this.transfer.chatRun.importId === batch.id;
      return (running ? this.L('进行中 ', 'In progress ') : this.L('没做完 ', 'Unfinished ')) + percent + '%';
    },
    chatStep() {
      const chat = this.transfer.chat;
      const run = this.transfer.chatRun;
      if (!chat) return 1;
      if (run && !run.running && run.total && run.done >= run.total) return 3;
      return 2;
    },
    prepareCandidate(item) {
      item.editing = false;
      item.mergeOpen = false;
      item.moreOpen = false;
      item.target_id = '';
      item.draft = { content: item.content, type: item.type, fact_key: item.fact_key || '' };
      item.sourcesOpen = false;
      item.sources = null;
      return item;
    },
    openImportReview(importId) {
      this.reviewTab = 'import';
      if (typeof importId === 'string') this.importReview.importId = importId;
      this.loadImportBatches();
      this.loadImportCandidates(true);
    },
    importCandidatesPath(extra) {
      const state = this.importReview;
      let path = '/v1/import/candidates' + extra + (extra.indexOf('?') === -1 ? '?' : '&') + 'filter=' + encodeURIComponent(state.filter);
      if (state.importId) path += '&import_id=' + encodeURIComponent(state.importId);
      return this.withNamespace(path);
    },
    async loadImportCandidates(reset) {
      const revision = this.spaceRevision;
      const state = this.importReview;
      if (reset) state.offset = 0;
      state.loading = true;
      try {
        const data = await this.request(this.importCandidatesPath('?limit=50&offset=' + state.offset));
        if (revision !== this.spaceRevision) return;
        const items = (data.data || []).map(this.prepareCandidate);
        state.items = reset ? items : state.items.concat(items);
        state.counts = data.counts || { pending: 0, clef_yes: 0, clef_no: 0 };
        state.offset += items.length;
        state.more = items.length === 50;
      } catch (error) {
        if (revision === this.spaceRevision) this.notify(error.message);
      }
      state.loading = false;
      this.icons();
    },
    async refreshImportCounts() {
      const revision = this.spaceRevision;
      try {
        const data = await this.request(this.importCandidatesPath('?limit=1'));
        if (revision !== this.spaceRevision) return;
        this.importReview.counts = data.counts || this.importReview.counts;
      } catch (error) { /* 数字下次刷新再对 */ }
    },
    dropImportCandidate(candidate) {
      const state = this.importReview;
      const before = state.items.length;
      state.items = state.items.filter(function(item) { return item.id !== candidate.id; });
      if (state.items.length < before) state.offset = Math.max(state.offset - 1, 0);
      this.refreshImportCounts();
    },
    clefLooksYes(candidate) {
      return Number(candidate.clef_grounded) >= 0.5 && Number(candidate.clef_worth) >= 0.5;
    },
    clefOpinionLabel(candidate) {
      return this.L('clef：有依据 ', 'clef: grounded ') + this.pct(candidate.clef_grounded) + ' · ' + (candidate.target_memory_id ? this.L('该替换 ', 'should replace ') : this.L('值得记 ', 'worth keeping ')) + this.pct(candidate.clef_worth);
    },
    async toggleCandidateSources(candidate) {
      candidate.sourcesOpen = !candidate.sourcesOpen;
      if (!candidate.sourcesOpen || candidate.sources) return;
      try {
        const data = await this.request(this.withNamespace('/v1/candidates/' + encodeURIComponent(candidate.id) + '/sources'));
        candidate.sources = (data.data && data.data.messages) || [];
      } catch (error) {
        candidate.sources = [];
        this.notify(error.message);
      }
    },
    async bulkImportCandidates(action, filter) {
      const state = this.importReview;
      const total = filter === 'clef_yes' ? state.counts.clef_yes : state.counts.clef_no;
      const label = action === 'approve' ? this.L('记住', 'Remember') : this.L('丢弃', 'Discard');
      const warning = action === 'approve' ? this.L('记住的直接进长期记忆。', 'They go straight into long-term memory.') : this.L('丢弃的不会进记忆。', 'Discarded ones won’t be remembered.');
      if (!total || !window.confirm(this.L(label + ' ' + total + ' 条？', label + ' ' + total + '? ') + warning)) return;
      const ns = this.namespace;
      const self = this;
      try {
        let path = '/v1/import/candidates/ids?filter=' + filter;
        if (state.importId) path += '&import_id=' + encodeURIComponent(state.importId);
        const data = await this.request(this.nsPath(path, ns));
        const ids = data.data || [];
        state.bulk = { label: this.L('在' + label, action === 'approve' ? 'Remembering' : 'Discarding'), done: 0, total: ids.length, failed: 0 };
        let cursor = 0;
        const worker = async function() {
          while (cursor < ids.length) {
            const id = ids[cursor++];
            try {
              await self.request(self.nsPath('/v1/candidates/' + encodeURIComponent(id) + '/' + action, ns), {
                method: 'POST',
                body: JSON.stringify({ namespace: ns })
              });
            } catch (error) {
              state.bulk.failed += 1;
            }
            state.bulk.done += 1;
          }
        };
        await Promise.all([worker(), worker(), worker()]);
        const failed = state.bulk.failed;
        state.bulk = null;
        this.notify(this.L(label + '了 ' + (ids.length - failed) + ' 条', label + 'ed ' + (ids.length - failed)) + (failed ? this.L('，' + failed + ' 条没成功', '; ' + failed + ' failed') : ''));
      } catch (error) {
        state.bulk = null;
        this.notify(error.message);
      }
      if (ns !== this.namespace) return;
      await Promise.all([this.loadImportCandidates(true), this.loadImportBatches(), this.loadBoot(), this.loadMemories()]);
    },
    async exportMemories(format) {
      this.transfer.exporting = true;
      try {
        if (!this.apiKey.trim()) throw new Error(this.L('请先填写 token', 'Enter your token first'));
        const response = await fetch(this.base() + this.withNamespace('/v1/memories/export?format=' + format), {
          headers: { Authorization: 'Bearer ' + this.apiKey }
        });
        if (!response.ok) {
          const text = await response.text();
          let message = response.status + ' ' + response.statusText;
          try { message = JSON.parse(text).error.message || message; } catch (error) { /* 不是 JSON 就用状态码 */ }
          throw new Error(message);
        }
        const blob = await response.blob();
        const disposition = response.headers.get('content-disposition') || '';
        const match = /filename="?([^";]+)"?/.exec(disposition);
        const name = match ? match[1] : 'aelios-' + this.namespace + '.' + format;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(function() { URL.revokeObjectURL(url); }, 2000);
        const count = response.headers.get('x-aelios-memories');
        const precious = response.headers.get('x-aelios-precious') || 0;
        this.notify(count ? this.L('导出了 ' + count + ' 条记忆、' + precious + ' 条珍贵', 'Exported ' + count + ' memories and ' + precious + ' keepsakes') : this.L('导出好了', 'Exported'));
      } catch (error) {
        this.notify(this.L('导出失败：', 'Export failed: ') + error.message);
      }
      this.transfer.exporting = false;
    },
    async copyImportPrompt() {
      if (!this.transfer.info) return;
      try {
        await navigator.clipboard.writeText(this.transfer.info.prompt);
        this.notify(this.L('提示词复制好了', 'Prompt copied'));
      } catch (error) {
        this.notify(this.L('复制不了，手动选中复制吧', 'Couldn’t copy. Select and copy it by hand'));
      }
    },
    async loadEntriesFile(event) {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        this.transfer.entriesText = await file.text();
        this.transfer.entriesName = file.name;
        this.transfer.preview = null;
        await this.previewEntries();
      } catch (error) {
        this.notify(this.L('读不了这个文件：', 'Can’t read this file: ') + error.message);
      }
    },
    async previewEntries() {
      const text = this.transfer.entriesText;
      if (!text.trim()) return;
      this.transfer.entriesBusy = true;
      try {
        const data = await this.request(this.withNamespace('/v1/import/entries/preview'), {
          method: 'POST',
          body: JSON.stringify({ text: text })
        });
        this.transfer.preview = data.data || null;
        if (!this.transfer.info) await this.loadTransferInfo();
      } catch (error) {
        this.notify(error.message);
      }
      this.transfer.entriesBusy = false;
      this.icons();
    },
    entriesPreviewLabel() {
      const preview = this.transfer.preview;
      if (!preview) return '';
      const formats = { 'aelios-jsonl': this.L('Aelios 导出的 jsonl', 'Aelios jsonl export'), jsonl: 'jsonl', json: 'json', markdown: this.L('md / 文本', 'md / text') };
      const self = this;
      const types = Object.keys(preview.by_type || {}).map(function(key) {
        return (key === 'precious' ? self.L('珍贵', 'keepsakes') : key === 'unknown' ? self.L('没写类型', 'no type') : self.typeLabel(key)) + ' ' + preview.by_type[key];
      }).join(this.L('、', ', '));
      if (this.lang === 'en') {
        return 'Found ' + preview.total + ' (' + (formats[preview.format] || preview.format) + ')' + (types ? ': ' + types : '')
          + (preview.dated ? '. ' + preview.dated + ' have dates' : '. None have dates')
          + (preview.with_fact_key ? ', ' + preview.with_fact_key + ' have a fact_key' : '')
          + (preview.skipped ? ', ' + preview.skipped + ' lines skipped' : '') + '.';
      }
      return '认出 ' + preview.total + ' 条（' + (formats[preview.format] || preview.format) + '）' + (types ? '：' + types : '')
        + (preview.dated ? '。' + preview.dated + ' 条带日期' : '。都没带日期')
        + (preview.with_fact_key ? '，' + preview.with_fact_key + ' 条带 fact_key' : '')
        + (preview.skipped ? '，跳过 ' + preview.skipped + ' 行' : '') + '。';
    },
    async runEntriesImport() {
      const preview = this.transfer.preview;
      if (!preview || !preview.entries.length) return;
      if (!this.transfer.info) await this.loadTransferInfo();
      const per = (this.transfer.info && this.transfer.info.entries.per_request) || 25;
      const ns = this.namespace;
      const mode = this.transfer.entriesMode;
      const entries = preview.entries;
      const fingerprint = (await this.sha256(this.transfer.entriesText)).slice(0, 40);
      this.transfer.entriesRun = { running: true, total: entries.length, done: 0, failed: 0, importId: '', lastError: '', counts: { created: 0, updated: 0, unchanged: 0, duplicate: 0, queued: 0, precious: 0, failed: 0 } };
      // 改要经过 Alpine 包过的那一份，页面才会跟着变。
      const run = this.transfer.entriesRun;
      this.transfer.entriesBusy = true;
      for (let index = 0; index < entries.length; index += per) {
        const slice = entries.slice(index, index + per);
        try {
          const data = await this.request(this.nsPath('/v1/import/entries', ns), {
            method: 'POST',
            body: JSON.stringify({ namespace: ns, fingerprint: fingerprint, name: this.transfer.entriesName || this.L('粘贴的文字', 'Pasted text'), mode: mode, start_index: index, total: entries.length, entries: slice })
          });
          const result = data.data || {};
          run.importId = result.import_id || run.importId;
          Object.keys(run.counts).forEach(function(key) { run.counts[key] += (result.counts && result.counts[key]) || 0; });
        } catch (error) {
          run.counts.failed += slice.length;
          run.lastError = error.message;
        }
        run.done = Math.min(index + per, entries.length);
      }
      run.running = false;
      this.transfer.entriesBusy = false;
      if (ns === this.namespace) await Promise.all([this.loadImportBatches(), this.loadBoot(), this.loadMemories()]);
      this.notify(run.counts.failed ? this.L('导完了，有 ' + run.counts.failed + ' 条没成功', 'Done; ' + run.counts.failed + ' failed') : this.L('导完了', 'Import done'));
    },
    entriesRunLabel() {
      const run = this.transfer.entriesRun;
      if (!run) return '';
      const c = run.counts;
      const parts = [];
      if (c.created) parts.push(this.L('新建 ' + c.created, c.created + ' new'));
      if (c.updated) parts.push(this.L('改写 ' + c.updated + '（旧版留着）', c.updated + ' updated (old versions kept)'));
      if (c.unchanged) parts.push(this.L('没变 ' + c.unchanged, c.unchanged + ' unchanged'));
      if (c.duplicate) parts.push(this.L('库里已有、跳过 ' + c.duplicate, c.duplicate + ' already there, skipped'));
      if (c.queued) parts.push(this.L('进待审 ' + c.queued, c.queued + ' sent to Review'));
      if (c.precious) parts.push(this.L('珍贵 ' + c.precious, c.precious + ' keepsakes'));
      if (c.failed) parts.push(this.L('失败 ' + c.failed, c.failed + ' failed') + (run.lastError ? ' (' + run.lastError + ')' : ''));
      return (run.running ? this.L('在导入 ', 'Importing ') : this.L('导完了 ', 'Imported ')) + run.done + ' / ' + run.total + (parts.length ? this.L('：', ': ') + parts.join(this.L('，', ', ')) : '');
    },
    async loadChatFile(event) {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      if (this.transfer.chatRun && this.transfer.chatRun.running) {
        this.notify(this.L('先暂停现在这份', 'Pause the current import first'));
        return;
      }
      if (!window.AeliosChat) {
        this.notify(this.L('页面没加载完整，刷新一下再试', 'The page didn’t fully load. Refresh and try again'));
        return;
      }
      this.transfer.chatLoading = true;
      this.transfer.chat = null;
      this.transfer.chatRun = null;
      chatParsed = null;
      chatChunks = [];
      try {
        if (!this.transfer.info) await this.loadTransferInfo();
        const text = await file.text();
        const parsed = window.AeliosChat.parseChatExport(text, file.name);
        if (!parsed.messages.length) throw new Error(this.L('没认出消息。', 'No messages found. ') + (parsed.warnings[0] || ''));
        chatParsed = parsed;
        const me = this.transfer.info && this.transfer.info.speakers ? this.transfer.info.speakers.user : '';
        const needsRoles = parsed.speakers.some(function(speaker) { return speaker.role === null; });
        this.transfer.chat = {
          name: file.name,
          hash: await this.sha256(text),
          format: parsed.format,
          conversations: parsed.conversations,
          messageCount: parsed.messages.length,
          skipped: parsed.skipped,
          warnings: parsed.warnings,
          needsRoles: needsRoles,
          speakers: parsed.speakers.map(function(speaker) {
            return { name: speaker.name, count: speaker.count, role: speaker.role, isUser: speaker.role === 'user' || (speaker.role === null && !!me && speaker.name === me) };
          }),
          chunks: 0, chars: 0, firstDate: '', lastDate: '', estimateIn: 0, estimateOut: 0, rolesKey: ''
        };
        this.rechunkChat();
      } catch (error) {
        this.notify(this.L('读不了这个文件：', 'Can’t read this file: ') + error.message);
      }
      this.transfer.chatLoading = false;
      this.icons();
    },
    chatTimeZone() {
      if (this.transfer.info && this.transfer.info.time_zone) return this.transfer.info.time_zone;
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (error) { return 'UTC'; }
    },
    rechunkChat() {
      const chat = this.transfer.chat;
      if (!chat || !chatParsed) return;
      const users = chat.speakers.filter(function(speaker) { return speaker.isUser; }).map(function(speaker) { return speaker.name; });
      const messages = chat.needsRoles ? window.AeliosChat.chatApplyRoles(chatParsed.messages, users) : chatParsed.messages;
      const limits = (this.transfer.info && this.transfer.info.chunk) || { default_messages: 60, default_chars: 30000 };
      chatChunks = window.AeliosChat.chatChunkByDay(messages, { timeZone: this.chatTimeZone(), maxMessages: limits.default_messages, maxChars: limits.default_chars, keepConversations: this.transfer.chatMode === 'archive' });
      const days = chatChunks.map(function(chunk) { return chunk.day; }).filter(Boolean).sort();
      chat.chunks = chatChunks.length;
      chat.chars = chatChunks.reduce(function(sum, chunk) { return sum + chunk.chars; }, 0);
      chat.firstDate = days[0] || '';
      chat.lastDate = days[days.length - 1] || '';
      chat.estimateIn = Math.ceil(chat.chars * 1.1) + chat.chunks * 2500;
      chat.estimateOut = chat.chunks * 300;
      chat.rolesKey = users.slice().sort().join('|');
      if (this.transfer.chatRun && !this.transfer.chatRun.running) this.transfer.chatRun = null;
    },
    chatSummaryLabel() {
      const chat = this.transfer.chat;
      if (!chat) return '';
      const formats = { chatgpt: this.L('ChatGPT 导出', 'ChatGPT export'), claude: this.L('Claude 导出', 'Claude export'), sillytavern: this.L('酒馆聊天', 'SillyTavern chat'), json: 'JSON', jsonl: 'JSONL', text: this.L('文本', 'Text') };
      const model = this.transfer.info ? this.transfer.info.model : '';
      const kind = formats[chat.format] || chat.format;
      if (this.transfer.chatMode === 'archive') return kind + ' · ' + chat.messageCount + this.L(' 条消息 · ', ' messages · ') + chat.chunks + this.L(' 段', ' parts');
      if (this.lang === 'en') {
        return kind + ' · ' + (chat.conversations > 1 ? chat.conversations + ' conversations · ' : '') + chat.messageCount + ' messages'
          + (chat.firstDate ? ' · ' + chat.firstDate + (chat.lastDate !== chat.firstDate ? ' to ' + chat.lastDate : '') : ' · no dates found')
          + '. ' + chat.chunks + ' parts, ' + chat.chars + ' characters. The model will read about ' + this.fmtTokens(chat.estimateIn) + ' tokens and write about ' + this.fmtTokens(chat.estimateOut)
          + (model ? ' (' + model + ')' : '') + '.';
      }
      return kind + '，' + (chat.conversations > 1 ? chat.conversations + ' 段对话，' : '') + chat.messageCount + ' 条消息'
        + (chat.firstDate ? '，' + chat.firstDate + (chat.lastDate !== chat.firstDate ? ' 到 ' + chat.lastDate : '') : '，没认出日期')
        + '。切成 ' + chat.chunks + ' 段，共 ' + chat.chars + ' 字。估计模型要读约 ' + this.fmtTokens(chat.estimateIn) + ' token、写约 ' + this.fmtTokens(chat.estimateOut) + ' token'
        + (model ? '（' + model + '）' : '') + '。';
    },
    async runChatImport() {
      const chat = this.transfer.chat;
      const chunks = chatChunks;
      const mode = this.transfer.chatMode;
      if (!chat || !chunks.length || (this.transfer.chatRun && this.transfer.chatRun.running)) return;
      if (chat.needsRoles && !chat.speakers.some(function(speaker) { return speaker.isUser; })) {
        this.notify(this.L('先勾上哪个名字是你', 'Tick which name is you first'));
        return;
      }
      if (!this.transfer.info) await this.loadTransferInfo();
      const ns = this.namespace;
      const limits = (this.transfer.info && this.transfer.info.chunk) || { default_messages: 60, default_chars: 30000 };
      const fingerprint = (await this.sha256([chat.hash, chat.rolesKey, limits.default_messages, limits.default_chars, this.chatTimeZone()].join('|'))).slice(0, 40);
      this.transfer.chatRun = { mode: mode, running: true, stop: false, namespace: ns, importId: '', total: chunks.length, done: 0, candidates: 0, merged: 0, duplicates: 0, modelCalls: 0, tokensIn: 0, tokensOut: 0, estimated: false, clefCalls: 0, errors: 0, lastError: '', current: '' };
      const run = this.transfer.chatRun;
      const self = this;
      const applyBatch = function(batch) {
        if (!batch) return;
        run.done = batch.done_chunks || 0;
        run.candidates = batch.candidates || 0;
        run.modelCalls = batch.model_calls || 0;
        run.tokensIn = batch.tokens_in || 0;
        run.tokensOut = batch.tokens_out || 0;
        run.clefCalls = batch.clef_calls || 0;
      };
      try {
        const start = await this.request(this.nsPath('/v1/import/batches', ns), {
          method: 'POST',
          body: JSON.stringify({ namespace: ns, mode: mode, fingerprint: fingerprint, name: chat.name, total_chunks: chunks.length, total_messages: chat.messageCount, total_chars: chat.chars, first_date: chat.firstDate || null, last_date: chat.lastDate || null })
        });
        const batch = start.data.batch;
        run.importId = batch.id;
        applyBatch(batch);
        const done = new Set(start.data.done_keys || []);
        let streak = 0;
        for (const chunk of chunks) {
          if (run.stop) break;
          if (done.has(chunk.key)) continue;
          run.current = chunk.key;
          try {
            const data = await this.request(this.nsPath('/v1/import/chat/chunk', ns), {
              method: 'POST',
              body: JSON.stringify({ namespace: ns, import_id: batch.id, chunk: { key: chunk.key, day: chunk.day, messages: chunk.messages }, clef: !!this.transfer.chatClef })
            });
            const result = data.data.result;
            if (result.status === 'error') {
              run.errors += 1;
              run.lastError = chunk.key + ': ' + (result.error || self.L('出错了', 'error'));
              streak += 1;
            } else {
              streak = 0;
              done.add(chunk.key);
            }
            run.merged += result.merged || 0;
            run.duplicates += result.duplicates || 0;
            run.estimated = run.estimated || !!result.tokens_estimated;
            applyBatch(data.data.batch);
          } catch (error) {
            run.errors += 1;
            run.lastError = chunk.key + ': ' + error.message;
            streak += 1;
          }
          if (streak >= 3) {
            run.lastError += this.L('（连着 3 段出错，先停下了）', ' (3 parts in a row failed, so it stopped)');
            break;
          }
        }
      } catch (error) {
        run.lastError = error.message;
      }
      run.running = false;
      run.stop = false;
      run.current = '';
      if (ns === this.namespace) await Promise.all([this.loadImportBatches(), this.loadBoot()]);
      this.icons();
    },
    chatRunPercent() {
      const run = this.transfer.chatRun;
      return run && run.total ? Math.round(run.done / run.total * 100) : 0;
    },
    chatRunLabel() {
      const run = this.transfer.chatRun;
      if (!run) return '';
      if (run.mode === 'archive') return (run.running ? this.L('在归档', 'Archiving') : (run.done >= run.total ? this.L('归档完成', 'Archive complete') : this.L('归档已暂停', 'Archive paused'))) + (run.errors ? this.L('，失败 ' + run.errors + ' 段', ', ' + run.errors + ' parts failed') : '');
      if (this.lang === 'en') {
        const headEn = run.running ? 'Reading ' + (run.current || '…') + '. ' : (run.done >= run.total ? 'Done. ' : 'Stopped here. ');
        return headEn + run.done + ' / ' + run.total + ' parts read, ' + run.candidates + ' candidates sent to Review'
          + (run.merged ? ' (' + run.merged + ' more mentions merged into existing candidates)' : '')
          + (run.duplicates ? ', ' + run.duplicates + ' exact duplicates skipped' : '')
          + '. ' + run.modelCalls + ' model calls, ' + this.fmtTokens(run.tokensIn) + ' in / ' + this.fmtTokens(run.tokensOut) + ' out tokens'
          + (run.estimated ? ' (some parts estimated from length)' : '')
          + (run.clefCalls ? ', clef ' + run.clefCalls : '')
          + (run.errors ? ', ' + run.errors + ' parts failed' : '') + '.';
      }
      const head = run.running ? '在做 ' + (run.current || '…') + '。' : (run.done >= run.total ? '做完了。' : '停在这里了。');
      return head + '已做 ' + run.done + ' / ' + run.total + ' 段，' + run.candidates + ' 条候选进了待审'
        + (run.merged ? '（另有 ' + run.merged + ' 次说到同一件事，并进了已有候选）' : '')
        + (run.duplicates ? '，' + run.duplicates + ' 条跟库里一字不差、跳过' : '')
        + '。模型 ' + run.modelCalls + ' 次，' + this.fmtTokens(run.tokensIn) + ' 进 / ' + this.fmtTokens(run.tokensOut) + ' 出 token'
        + (run.estimated ? '（有的段模型没回用量，按字数估的）' : '')
        + (run.clefCalls ? '，clef ' + run.clefCalls + ' 次' : '')
        + (run.errors ? '，出错 ' + run.errors + ' 段' : '') + '。';
    },
    async toggleMemoryRevisions(memory) {
      memory.revOpen = !memory.revOpen;
      if (!memory.revOpen) return;
      memory.revisions = null;
      memory.decision_history = null;
      memory.sources = null;
      try {
        const data = await this.request(this.withNamespace('/v1/memories/' + encodeURIComponent(memory.id) + '/revisions'));
        memory.revisions = data.data || [];
        memory.decision_history = data.decision_history || [];
        memory.sources = data.sources || null;
      } catch (error) {
        memory.revisions = [];
        memory.decision_history = [];
        this.notify(error.message);
      }
    },
    isScopedDecision(memory) {
      return Boolean(memory && (memory.source === 'scoped_decision' || (memory.type === 'decision' && String(memory.fact_key || '').startsWith('decision:'))));
    },
    decisionScopeLabel(memory) {
      return String((memory && memory.fact_key) || '').replace(/^decision:/, '') || '—';
    },
    decisionBadge(memory) {
      const scope = this.decisionScopeLabel(memory);
      const day = this.shortDate((memory && (memory.valid_as_of || memory.created_at)) || '');
      return this.L('当前决定 · ', 'Current decision · ') + scope + (day ? ' · ' + day : '');
    },
    outdatedNotice(memory) {
      const day = this.shortDate((memory && memory.current_state && memory.current_state.as_of) || '');
      return this.L('现状说法已被 ' + (day || '较新') + ' 的决定更新', 'Current status updated by a decision from ' + (day || 'later'));
    },
    revisionReasonLabel(rev) {
      const zh = { fact_key_upsert: '同一个 key 再写一遍时被改', edit: '手动改的', candidate_merge: '审核合并时被改', late_evidence: '晚到的早期决定证据' };
      const en = { fact_key_upsert: 'Changed when the same key was written again', edit: 'Edited by hand', candidate_merge: 'Changed by a merge in Review', late_evidence: 'Late earlier decision evidence' };
      const reason = (this.lang === 'en' ? en : zh)[rev.reason] || rev.reason || '';
      return reason + (rev.replaced_by ? this.L('（改它的：', ' (by ') + rev.replaced_by + this.L('）', ')') : '');
    },
    async restoreMemoryRevision(memory, rev) {
      if (!window.confirm(this.L('把这条记忆恢复成这一版？现在这版会存进旧版里。', 'Restore this version? The current one will be saved as an older version.'))) return;
      try {
        await this.request(this.withNamespace('/v1/memory/' + encodeURIComponent(memory.id)), {
          method: 'PATCH',
          body: JSON.stringify({
            namespace: this.namespace,
            type: rev.type || memory.type,
            content: rev.content,
            confidence: memory.confidence,
            importance: memory.importance,
            tags: (rev.tags && rev.tags.length) ? rev.tags : (memory.tags || []),
            source: 'restore'
          })
        });
        await this.loadMemories();
        this.notify(this.L('恢复好了', 'Restored'));
      } catch (error) {
        this.notify(error.message);
      }
    },
    get pendingCount() {
      if (this.stats && typeof this.stats.pending_candidates === 'number') return this.stats.pending_candidates;
      return this.candidates.length;
    }
  };
}
</script>
</body>
</html>`;
