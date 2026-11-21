export const ADMIN_SCRIPT_MEMORIES = String.raw`    async reloadAll() {
      this.savePrefs();
      var tasks = [this.loadBoot(), this.loadCandidates(), this.loadMemories(), this.loadSpaces()];
      if (this.page === 'today') tasks.push(this.loadHome());
      if (this.page === 'review') tasks.push(this.loadJudgeDecisions());
      if (this.page === 'settings') tasks.push(this.loadRecallHistory(), this.chatgptLoad());
      if (this.page === 'diary') tasks.push(this.loadDiary());
      if (this.page === 'memory' && this.moreView === 'world') tasks.push(this.loadWorldFacts());
      if (this.page === 'memory' && this.moreView === 'notebook') tasks.push(this.loadNotebook());
      if (this.page === 'memory' && this.moreView === 'handoff') tasks.push(this.loadHandoff());
      if (this.page === 'transfer') tasks.push(this.loadTransferInfo(), this.loadImportBatches());
      if (this.page === 'review' && this.reviewTab === 'import') tasks.push(this.loadImportBatches(), this.loadImportCandidates(true));
      if (this.page === 'dream') {
        tasks.push(this.loadDreamStatus());
        tasks.push(this.loadDreamHarvest());
      }
      await Promise.all(tasks);
      this.icons();
    },
    todayRange() {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      return { start: start.toISOString(), end: end.toISOString() };
    },
    async loadBoot() {
      const revision = this.spaceRevision;
      try {
        const range = this.todayRange();
        const data = await this.request(this.withNamespace('/v1/memory_boot?start=' + encodeURIComponent(range.start) + '&end=' + encodeURIComponent(range.end)));
        if (revision !== this.spaceRevision) return;
        this.connected = true;
        this.boot = data.data || {};
        this.stats = this.boot.stats || {};

        this.todayMessages = this.boot.today_messages || [];
        this.precious = this.boot.precious || [];
        this.glossary = this.boot.glossary || [];
      } catch (error) {
        if (revision !== this.spaceRevision) return;
        this.connected = false;
        this.notify(error.message);
      }
    },
    // 首页右栏和「昨晚整理」那张卡：最新一篇日记、最近一次整理和那一晚记住的。读不到就空着，不弹错。
    async loadHome() {
      const revision = this.spaceRevision;
      if (!this.apiKey.trim()) return;
      try {
        const results = await Promise.all([
          this.request(this.withNamespace('/admin/diary?limit=1')),
          this.request(this.withNamespace('/v1/dream/status'))
        ]);
        if (revision !== this.spaceRevision) return;
        const dailies = (results[0].data && results[0].data.dailies) || [];
        const status = results[1].data || {};
        const runs = status.dream_runs || [];
        const run = runs.find(function(item) { return item.status !== 'queued' && item.status !== 'running'; }) || runs[0] || null;
        this.home.diary = dailies[0] || null;
        this.home.run = run;
        const date = (run && run.date_label) || status.anchor_date_label || this.yesterdayLabel();
        const harvest = await this.request(this.withNamespace('/admin/dream/harvest?date=' + encodeURIComponent(date)));
        if (revision !== this.spaceRevision) return;
        this.home.harvest = harvest.data || null;
      } catch (error) { /* 首页这几块是锦上添花，读不到就空着 */ }
    },
    homeMessages() {
      const list = this.homeAll ? this.homeFiltered() : this.homeFiltered().slice(0, 8);
      return list;
    },
    homeFiltered() {
      const role = this.homeRole;
      return this.todayMessages.filter(function(message) { return role === 'all' || message.role === role; });
    },
    homeFilteredCount() {
      return this.homeFiltered().length;
    },
    lastMessageTime() {
      let latest = '';
      this.todayMessages.forEach(function(message) { if ((message.created_at || '') > latest) latest = message.created_at; });
      return this.clock(latest);
    },
    homeHarvestCreated() {
      return (this.home.harvest && this.home.harvest.created) || [];
    },
    runColor(run) {
      if (!run) return 'var(--t3)';
      if (run.stale || run.status === 'queued' || run.status === 'running') return 'var(--warn)';
      return { ok: 'var(--ok)', error: 'var(--err)' }[run.status] || 'var(--t3)';
    },
    homeRunColor() {
      return this.runColor(this.home.run);
    },
    homeRunSub() {
      const run = this.home.run;
      if (!run) return this.L('近 7 天没有记录', 'No runs in the last 7 days');
      const created = this.homeHarvestCreated().length;
      return this.dayLabel(run.date_label, true) + ' · ' + this.clock(run.finished_at || run.started_at) + (created ? this.L(' · 新记住 ' + created + ' 条', ' · ' + created + ' new memories') : '');
    },
    homeRunBroken() {
      const run = this.home.run;
      return Boolean(run && (run.status === 'error' || run.stale));
    },
    isPinned(message) {
      const list = this.jsonList;
      return this.precious.some(function(item) {
        return item.content === message.content || list(item.context_message_ids).indexOf(message.id) >= 0;
      });
    },
    togglePin(message) {
      const list = this.jsonList;
      const found = this.precious.find(function(item) {
        return item.content === message.content || list(item.context_message_ids).indexOf(message.id) >= 0;
      });
      return found ? this.unpinPrecious(found) : this.pinMessage(message);
    },
    async loadCandidates() {
      const revision = this.spaceRevision;
      try {
        // 日常这一栏只要整理出来的；导入的在「导入的」那一栏单独翻页。
        const data = await this.request(this.withNamespace('/v1/candidates?status=pending&limit=100&scope=daily'));
        if (revision !== this.spaceRevision) return;
        this.candidates = (data.data || []).map(this.prepareCandidate);
        const ids = {};
        this.candidates.forEach(function(item) { ids[item.id] = true; });
        const kept = {};
        Object.keys(this.reviewSelected).forEach(function(id) { if (ids[id]) kept[id] = true; });
        this.reviewSelected = kept;
      } catch (error) {
        if (revision !== this.spaceRevision) return;
        this.notify(error.message);
      }
    },
    candidateIsUpdate(candidate) {
      return candidate.source === 'dream_update' || Boolean(candidate.existing_content);
    },
    candidateKindLabel(candidate) {
      if (candidate.source === 'dream_delete') return this.L('建议移除', 'Suggested removal');
      if (this.candidateIsUpdate(candidate)) return this.L('更新已有', 'Updates existing');
      if (candidate.import_id) return candidate.source === 'import_chat' ? this.L('来自聊天记录', 'From chat history') : this.L('来自清单', 'From a list');
      return this.L('新记忆', 'New');
    },
    candidateKindClass(candidate) {
      if (candidate.source === 'dream_delete') return 'chip-err';
      if (this.candidateIsUpdate(candidate)) return 'chip-warn';
      return 'chip-violet';
    },
    candidateApproveLabel(candidate) {
      if (candidate.source === 'dream_delete') return this.L('移除', 'Remove');
      if (this.candidateIsUpdate(candidate)) return this.L('改成新的', 'Use new');
      return this.L('记住', 'Remember');
    },
    candidateDiscardLabel(candidate) {
      if (candidate.source === 'dream_delete') return this.L('保留', 'Keep');
      if (this.candidateIsUpdate(candidate)) return this.L('保持原样', 'Keep old');
      return this.L('丢弃', 'Discard');
    },
    reviewTypes() {
      const seen = {};
      this.candidates.forEach(function(item) { seen[item.type] = true; });
      const order = this.canonicalMemoryTypes.filter(function(type) { return seen[type]; });
      return order.concat(Object.keys(seen).filter(function(type) { return order.indexOf(type) < 0; }));
    },
    reviewList() {
      const type = this.reviewType;
      return this.candidates.filter(function(item) { return type === 'all' || item.type === type; });
    },
    reviewToggle(id) {
      const next = Object.assign({}, this.reviewSelected);
      if (next[id]) delete next[id];
      else next[id] = true;
      this.reviewSelected = next;
    },
    reviewSelectedItems() {
      const selected = this.reviewSelected;
      return this.reviewList().filter(function(item) { return selected[item.id]; });
    },
    reviewSelectedCount() {
      return this.reviewSelectedItems().length;
    },
    reviewAllSelected() {
      const list = this.reviewList();
      const selected = this.reviewSelected;
      return list.length > 0 && list.every(function(item) { return selected[item.id]; });
    },
    reviewSelectAll(on) {
      const next = {};
      if (on) this.reviewList().forEach(function(item) { next[item.id] = true; });
      this.reviewSelected = next;
    },
    // 勾选的几条一条条走跟单个按钮一样的接口，失败的留在队列里。
    async reviewBulk(action) {
      const items = this.reviewSelectedItems();
      if (!items.length || this.reviewBulkBusy) return;
      const verb = action === 'approve' ? this.L('记住', 'Remember') : this.L('丢弃', 'Discard');
      if (!window.confirm(this.L(verb + '所选的 ' + items.length + ' 条？', verb + ' the ' + items.length + ' selected?'))) return;
      const ns = this.namespace;
      const revision = this.spaceRevision;
      this.reviewBulkBusy = true;
      let done = 0;
      let failed = 0;
      for (const candidate of items) {
        try {
          const body = action === 'approve' ? this.candidatePayload(candidate) : { namespace: ns };
          await this.request(this.nsPath('/v1/candidates/' + encodeURIComponent(candidate.id) + '/' + action, ns), { method: 'POST', body: JSON.stringify(body) });
        } catch (error) {
          failed += 1;
        }
        done += 1;
        this.reviewBulkLabel = done + ' / ' + items.length;
      }
      this.reviewBulkBusy = false;
      this.reviewBulkLabel = '';
      this.reviewSelected = {};
      this.notify(this.L(verb + '了 ' + (items.length - failed) + ' 条', verb + 'ed ' + (items.length - failed)) + (failed ? this.L('，' + failed + ' 条没成功', '; ' + failed + ' failed') : ''));
      if (revision === this.spaceRevision) await Promise.all([this.loadCandidates(), this.loadMemories(), this.loadBoot()]);
    },
    async loadJudgeDecisions() {
      const revision = this.spaceRevision;
      try {
        const data = await this.request(this.withNamespace('/v1/candidates/decisions?days=7'));
        if (revision !== this.spaceRevision) return;
        this.judgeDecisions = data.data || [];
        this.autoReview = data.auto_review || null;
        this.icons();
      } catch (error) {
        if (revision !== this.spaceRevision) return;
        this.notify(error.message);
      }
    },
    judgeDecisionLabel(item) {
      const archive = item.source === 'dream_delete';
      if (item.undone) {
        if (archive) return item.status === 'approved' ? this.L('撤回后归档', 'Undone, archived') : this.L('撤回后放回', 'Undone, restored');
        return item.status === 'approved' ? this.L('撤回后补记', 'Undone, remembered') : this.L('撤回后收回', 'Undone, dropped');
      }
      const verdict = archive
        ? (item.status === 'approved' ? this.L('归档了', 'archived') : this.L('留着', 'kept'))
        : (item.status === 'approved' ? this.L('记住了', 'remembered') : this.L('放下了', 'let go'));
      return (item.judged_by || this.L('代审', 'auto')) + ' · ' + verdict;
    },
    judgeUndoLabel(item) {
      if (item.source === 'dream_delete') return item.status === 'approved' ? this.L('撤回，放回来', 'Undo: restore it') : this.L('撤回，归档它', 'Undo: archive it');
      return item.status === 'approved' ? this.L('撤回，不记了', 'Undo: forget it') : this.L('撤回，记下来', 'Undo: remember it');
    },
    async undoJudgeDecision(item) {
      try {
        await this.request(this.withNamespace('/v1/candidates/' + encodeURIComponent(item.id) + '/undo'), {
          method: 'POST',
          body: JSON.stringify({})
        });
        await Promise.all([this.loadJudgeDecisions(), this.loadMemories(), this.loadBoot()]);
        this.notify(this.L('已撤回', 'Undone'));
      } catch (error) {
        this.notify(error.message);
      }
    },
    async loadMemories() {
      const revision = this.spaceRevision;
      try {
        const typeParam = this.memoryType && this.memoryType !== 'all' ? '&type=' + encodeURIComponent(this.memoryType) : '';
        const path = '/v1/memory?status=active&limit=100' + typeParam;
        const data = await this.request(this.withNamespace(path));
        if (revision !== this.spaceRevision) return;
        this.memories = (data.data || []).map(function(item) {
          item.open = false;
          item.editing = false;
          item.mergeOpen = false;
          item.target_id = '';
          item.draft = { content: item.content };
          item.revOpen = false;
          item.revisions = null;
          item.decision_history = null;
          item.sources = null;
          return item;
        });
      } catch (error) {
        if (revision !== this.spaceRevision) return;
        this.notify(error.message);
      }
    },
    filteredMemories() {
      const q = this.memoryQuery.trim().toLowerCase();
      if (!q) return this.memories;
      return this.memories.filter(function(item) {
        return [item.content, item.fact_key, (item.tags || []).join(' ')].some(function(text) { return String(text || '').toLowerCase().includes(q); });
      });
    },
    memoryFooter() {
      const total = Number(this.typeCount(this.memoryType)) || 0;
      const shown = this.memories.length;
      if (total > shown) return this.L('显示最近更新的 ' + shown + ' 条，共 ' + total + ' 条', 'Showing the ' + shown + ' most recent of ' + total);
      return this.L('共 ' + shown + ' 条', shown + ' in total');
    },
    openMemoryTab(id) {
      this.moreView = id;
      this.loadMoreView();
    },
    memoryTabCount(id) {
      if (id === 'precious') return this.precious.length || '';
      if (id === 'glossary') return this.glossary.length || '';
      if (id === 'notebook') return this.notebookLoaded ? this.notebookPages.length : '';
      if (id === 'world') return this.worldItems.length || '';
      return '';
    },
    loadMoreView() {
      if (this.moreView === 'world') {
        this.loadWorldFacts();
      } else if (this.moreView === 'handoff') {
        this.loadHandoff();
      } else if (this.moreView === 'notebook') {
        this.loadNotebook();
      } else if (this.moreView === 'important') {
        this.loadMemories();
      } else {
        this.icons();
      }
    },
    async loadWorldFacts() {
      const revision = this.spaceRevision;
      try {
        const data = await this.request(this.withNamespace('/v1/memory?status=active&limit=80&type=world_fact'));
        if (revision !== this.spaceRevision) return;
        this.worldItems = data.data || [];
        this.pruneWorldSelection();
      } catch (error) {
        if (revision !== this.spaceRevision) return;
        this.worldItems = [];
        this.pruneWorldSelection();
        this.notify(error.message);
      }
      this.icons();
    },

    // 报错、乱码、突然拒答这种不想留的原话：删了夜里整理、写日记和召回都不会再读到它。收进珍贵的那份不动。
    async deleteRaw(message, mode) {
      const withdraw = mode === 'withdraw';
      const confirmation = withdraw
        ? this.L('撤回这句及其已知衍生记忆？原话会删除；引用或抄录它的整理记忆、候选和长尾会隐藏，相关日记用剩下的原话重写。助手亲笔写的记忆、只是同一批读过它的旧记忆会保留。之前的导出和备份不在范围内。',
            'Withdraw this line and its known derived memories? The line is deleted; memories, candidates and long-tail entries that cite or copy it are hidden, and affected diaries are rewritten from the remaining lines. Memories the assistant wrote itself, and older memories that only shared a batch with it, stay. Earlier exports and backups are out of reach.')
        : this.L('删除这句？原话和它的搜索索引会删除，不能恢复。已经整理出的记忆不受影响；要一并撤回，请用「撤回这句及其已知衍生记忆」。',
            'Delete this line? The line and its search entry are removed for good. Memories already made from it stay; to remove those too, use "Withdraw this line and its known derived memories".');
      if (!window.confirm(confirmation)) return;
      try {
        const result = await this.request(this.withNamespace('/v1/raw/' + encodeURIComponent(message.id) + (withdraw ? '?mode=withdraw' : '')), { method: 'DELETE' });
        this.todayMessages = this.todayMessages.filter(function(item) { return item.id !== message.id; });
        if (this.stats.today_raw_count) this.stats.today_raw_count -= 1;
        const hidden = ((result && result.data && result.data.withdrawn_memories) || []).length;
        const kept = ((result && result.data && result.data.unverified_memories) || []).length;
        this.notify(withdraw
          ? this.L('已撤回，隐藏 ' + hidden + ' 条衍生记忆' + (kept ? '；' + kept + ' 条旧记忆来源不明，已保留' : ''),
              'Withdrawn; ' + hidden + ' derived memories hidden' + (kept ? '; ' + kept + ' older memories with unclear sources kept' : ''))
          : this.L('删除了', 'Deleted'));
      } catch (error) {
        this.notify(error.message);
      }
    },
    async pinMessage(message) {
      try {
        await this.request(this.withNamespace('/v1/precious'), {
          method: 'POST',
          body: JSON.stringify({ namespace: this.namespace, content: message.content, context_message_ids: [message.id], source: 'human' })
        });
        await this.loadBoot();
        this.notify(this.L('已收进珍贵', 'Saved as a keepsake'));
      } catch (error) {
        this.notify(error.message);
      }
    },
    toggleCandidateEdit(candidate) {
      candidate.editing = !candidate.editing;
      candidate.draft = { content: candidate.content, type: candidate.type, fact_key: candidate.fact_key || '' };
      this.icons();
    },
    candidatePayload(candidate) {
      const draft = candidate.editing ? candidate.draft : candidate;
      return {
        namespace: this.namespace,
        content: draft.content || candidate.content,
        type: draft.type || candidate.type,
        fact_key: draft.fact_key || candidate.fact_key || null,
        confidence: candidate.confidence,
        importance: candidate.importance,
        tags: candidate.tags || [],
        source_message_ids: candidate.source_message_ids || []
      };
    },
    async approveCandidate(candidate) {
      try {
        await this.request(this.withNamespace('/v1/candidates/' + encodeURIComponent(candidate.id) + '/approve'), {
          method: 'POST',
          body: JSON.stringify(this.candidatePayload(candidate))
        });
        if (candidate.import_id) {
          this.dropImportCandidate(candidate);
          await Promise.all([this.loadMemories(), this.loadBoot()]);
        } else {
          await Promise.all([this.loadCandidates(), this.loadMemories(), this.loadBoot()]);
        }
        this.notify(candidate.source === 'dream_delete' ? this.L('已移除', 'Removed') : this.L('记住了', 'Remembered'));
      } catch (error) {
        this.notify(error.message);
      }
    },
    async discardCandidate(candidate) {
      try {
        await this.request(this.withNamespace('/v1/candidates/' + encodeURIComponent(candidate.id) + '/discard'), {
          method: 'POST',
          body: JSON.stringify({ namespace: this.namespace })
        });
        if (candidate.import_id) {
          this.dropImportCandidate(candidate);
          await this.loadBoot();
        } else {
          await Promise.all([this.loadCandidates(), this.loadBoot()]);
        }
        this.notify(candidate.source === 'dream_delete' ? this.L('留着了', 'Kept') : this.L('已丢弃', 'Discarded'));
      } catch (error) {
        this.notify(error.message);
      }
    },
    async mergeCandidate(candidate) {
      if (!candidate.target_id) {
        this.notify(this.L('先填要并进去的那条记忆的 id', 'Enter the id of the memory to merge into'));
        return;
      }
      try {
        const payload = this.candidatePayload(candidate);
        payload.target_id = candidate.target_id;
        await this.request(this.withNamespace('/v1/candidates/' + encodeURIComponent(candidate.id) + '/merge'), {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        await Promise.all([this.loadCandidates(), this.loadMemories(), this.loadBoot()]);
        this.notify(this.L('已合并', 'Merged'));
      } catch (error) {
        this.notify(error.message);
      }
    },
    toggleMemoryEdit(memory) {
      memory.editing = !memory.editing;
      memory.draft = { content: memory.content };
      this.icons();
    },
    openMemoryCreate() {
      const fallback = this.memoryType && this.memoryType !== 'all' ? this.memoryType : 'fact';
      this.memoryDraft = { type: fallback, content: '', fact_key: '', importance: 0.7, confidence: 0.85 };
      this.memoryCreateOpen = true;
      this.icons();
    },
    async ensureFactKey(type, content) {
      const trimmed = (content || '').trim();
      if (!trimmed) return null;
      try {
        const data = new TextEncoder().encode(type + ':' + trimmed);
        const buf = await crypto.subtle.digest('SHA-1', data);
        const hex = Array.from(new Uint8Array(buf)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
        return 'manual:' + type + ':' + hex.slice(0, 10);
      } catch (error) {
        return 'manual:' + type + ':' + Date.now().toString(36);
      }
    },
    async createMemory() {
      const content = (this.memoryDraft.content || '').trim();
      if (!content) { this.notify(this.L('内容不能为空', 'Content can’t be empty')); return; }
      const type = (this.memoryDraft.type || 'fact').trim() || 'fact';
      let factKey = (this.memoryDraft.fact_key || '').trim();
      if (!factKey) factKey = await this.ensureFactKey(type, content);
      this.saving = true;
      try {
        await this.request(this.withNamespace('/v1/memories'), {
          method: 'POST',
          body: JSON.stringify({
            namespace: this.namespace,
            type: type,
            content: content,
            fact_key: factKey,
            importance: Number(this.memoryDraft.importance),
            confidence: Number(this.memoryDraft.confidence),
            source: 'manual'
          })
        });
        this.memoryCreateOpen = false;
        this.memoryType = type;
        await Promise.all([this.loadMemories(), this.loadBoot()]);
        this.notify(this.L('新记忆存好了', 'Memory saved'));
      } catch (error) {
        this.notify(error.message);
      }
      this.saving = false;
    },
    async saveMemory(memory) {
      try {
        await this.request(this.withNamespace('/v1/memory/' + encodeURIComponent(memory.id)), {
          method: 'PATCH',
          body: JSON.stringify({
            namespace: this.namespace,
            type: memory.type,
            content: memory.draft.content,
            confidence: memory.confidence,
            importance: memory.importance,
            tags: memory.tags || []
          })
        });
        await this.loadMemories();
        this.notify(this.L('记忆已保存', 'Memory saved'));
      } catch (error) {
        this.notify(error.message);
      }
    },
    async deleteMemory(memory) {
      if (!window.confirm(this.L('移除这条记忆？引用它的已知衍生记忆也会撤回。', 'Remove this memory and withdraw known memories derived from it?'))) return;
      try {
        const {data} = await this.request(this.withNamespace('/v1/memory/' + encodeURIComponent(memory.id)), { method: 'DELETE' });
        await Promise.all([this.loadMemories(), this.loadBoot()]);
        if (this.page === 'memory' && this.moreView === 'world') await this.loadWorldFacts();
        const count = (data.withdrawn_memories || []).length;
        this.notify(this.L('已移除，连带撤回 ' + count + ' 条记忆', 'Removed. Related memories withdrawn: ' + count));
      } catch (error) {
        this.notify(error.message);
      }
    },
    async deleteWorldMemory(item) {
      if (!window.confirm(this.L('确认删除这条世界知识？', 'Delete this world fact?'))) return;
      try {
        await this.deleteWorldItem(item);
        delete this.worldSelection[this.worldItemKey(item)];
        this.worldSelection = Object.assign({}, this.worldSelection);
        await Promise.all([this.loadMemories(), this.loadBoot()]);
        if (this.moreView === 'world') await this.loadWorldFacts();
        this.notify(this.L('已删除', 'Deleted'));
      } catch (error) {
        this.notify(error.message);
      }
    },
    worldItemKey(item) {
      return (item.type === 'longtail' ? 'longtail' : 'memory') + ':' + item.id;
    },
    isWorldSelected(item) {
      return Boolean(this.worldSelection[this.worldItemKey(item)]);
    },
    selectedWorldItems() {
      return this.worldItems.filter(function(item) { return this.isWorldSelected(item); }, this);
    },
    selectedWorldCount() {
      return this.selectedWorldItems().length;
    },
    toggleWorldItem(item) {
      const key = this.worldItemKey(item);
      const next = Object.assign({}, this.worldSelection);
      if (next[key]) delete next[key];
      else next[key] = true;
      this.worldSelection = next;
    },
    selectAllWorldItems() {
      const next = Object.assign({}, this.worldSelection);
      for (const item of this.worldItems) next[this.worldItemKey(item)] = true;
      this.worldSelection = next;
      this.icons();
    },
    clearWorldSelection() {
      this.worldSelection = {};
      this.icons();
    },
    pruneWorldSelection() {
      const visible = new Set(this.worldItems.map(function(item) { return this.worldItemKey(item); }, this));
      const next = {};
      for (const key of Object.keys(this.worldSelection)) {
        if (visible.has(key)) next[key] = true;
      }
      this.worldSelection = next;
    },
    async deleteWorldItem(item) {
      if (item.type === 'longtail') {
        await this.request(this.withNamespace('/v1/longtail/' + encodeURIComponent(item.id)), { method: 'DELETE' });
        return;
      }
      await this.request(this.withNamespace('/v1/memory/' + encodeURIComponent(item.id)), { method: 'DELETE' });
    },
    async deleteSelectedWorldItems() {
      const items = this.selectedWorldItems();
      if (items.length === 0) return;
      if (!window.confirm(this.L('确认删除选中的 ' + items.length + ' 条世界知识？', 'Delete the ' + items.length + ' selected world facts?'))) return;
      this.saving = true;
      let failed = 0;
      try {
        for (let index = 0; index < items.length; index += 5) {
          const batch = items.slice(index, index + 5);
          const results = await Promise.allSettled(batch.map(function(item) { return this.deleteWorldItem(item); }, this));
          failed += results.filter(function(result) { return result.status === 'rejected'; }).length;
        }
        this.clearWorldSelection();
        await Promise.all([this.loadMemories(), this.loadBoot()]);
        if (this.moreView === 'world') await this.loadWorldFacts();
        this.notify(failed ? this.L('部分删除失败：' + failed + ' 条', failed + ' couldn’t be deleted') : this.L('已删除 ' + items.length + ' 条', 'Deleted ' + items.length));
      } catch (error) {
        this.notify(error.message);
      }
      this.saving = false;
    },
    async mergeDuplicate(memory) {
      if (!memory.target_id) {
        this.notify(this.L('先填要并进去的那条记忆的 id', 'Enter the id of the memory to merge into'));
        return;
      }
      try {
        const target = await this.request(this.withNamespace('/v1/memory/' + encodeURIComponent(memory.target_id)));
        const combined = (target.data.content || '') + '\n' + memory.content;
        await this.request(this.withNamespace('/v1/memory/' + encodeURIComponent(memory.target_id)), {
          method: 'PATCH',
          body: JSON.stringify({ namespace: this.namespace, content: combined, type: target.data.type, tags: target.data.tags || [] })
        });
        await this.request(this.withNamespace('/v1/memory/' + encodeURIComponent(memory.id)), { method: 'DELETE' });
        await Promise.all([this.loadMemories(), this.loadBoot()]);
        this.notify(this.L('已合并成一条', 'Merged into one'));
      } catch (error) {
        this.notify(error.message);
      }
    },
    async unpinPrecious(item) {
      try {
        await this.request(this.withNamespace('/v1/precious/' + encodeURIComponent(item.id)), { method: 'DELETE' });
        await this.loadBoot();
        this.notify(this.L('已取消珍贵', 'Removed from keepsakes'));
      } catch (error) {
        this.notify(error.message);
      }
    },
    splitText(value) {
      return String(value || '').split(/[,，\s]+/).map(function(item) { return item.trim(); }).filter(Boolean);
    },
    async saveGlossary() {
      try {
        await this.request(this.withNamespace('/v1/glossary'), {
          method: 'POST',
          body: JSON.stringify({
            namespace: this.namespace,
            term: this.glossaryDraft.term,
            aliases: this.splitText(this.glossaryDraft.aliasesText),
            definition: this.glossaryDraft.definition
          })
        });
        this.glossaryDraft = { term: '', definition: '', aliasesText: '' };
        await this.loadBoot();
        this.notify(this.L('黑话已保存', 'Word saved'));
      } catch (error) {
        this.notify(error.message);
      }
    },
    async deleteGlossary(item) {
      if (!window.confirm(this.L('删除「' + item.term + '」？', 'Delete “' + item.term + '”?'))) return;
      try {
        await this.request(this.withNamespace('/v1/glossary/' + encodeURIComponent(item.id)), { method: 'DELETE' });
        await this.loadBoot();
        this.notify(this.L('黑话已删除', 'Word deleted'));
      } catch (error) {
        this.notify(error.message);
      }
    },
    async loadHandoff(force) {
      if (this.handoffLoaded && !force) return;
      if (force && this.handoffDraft !== (this.handoffNote.content || '') &&
          !window.confirm(this.L('重新读取会放弃尚未保存的修改，继续？', 'Discard unsaved edits and reload?'))) return;
      const revision = this.spaceRevision;
      this.handoffBusy = true;
      try {
        const response = await this.request(this.withNamespace('/v1/handoff'));
        if (revision !== this.spaceRevision) return;
        this.handoffNote = response.data;
        this.handoffDraft = response.data.content || '';
        this.handoffGuide = response.writing_guide || '';
        this.handoffLoaded = true;
      } catch (error) {
        if (revision === this.spaceRevision) this.notify(error.message);
      } finally {
        if (revision === this.spaceRevision) this.handoffBusy = false;
      }
    },
    async saveHandoff(remove) {
      if (!this.handoffLoaded || this.handoffBusy) return;
      if (remove && !window.confirm(this.L('删除当前交接信？', 'Delete the current handoff?'))) return;
      const revision = this.spaceRevision;
      const draft = this.handoffDraft;
      this.handoffBusy = true;
      try {
        const response = await this.request(this.withNamespace('/v1/handoff'), {
          method: remove ? 'DELETE' : 'PUT',
          body: JSON.stringify({ content: draft, expected_revision: this.handoffNote.revision })
        });
        if (revision !== this.spaceRevision) return;
        this.handoffNote = response.data;
        if (this.handoffDraft === draft) this.handoffDraft = response.data.content || '';
        this.notify(this.L('交接信已更新', 'Handoff updated'));
      } catch (error) {
        if (revision === this.spaceRevision) this.notify(error.message);
      } finally {
        if (revision === this.spaceRevision) this.handoffBusy = false;
      }
    },
    async loadNotebook() {
      const revision = this.spaceRevision;
      try {
        const data = await this.request(this.withNamespace('/v1/notebook'));
        if (revision !== this.spaceRevision) return;
        this.notebookPages = data.data || [];
        this.notebookLoaded = true;
      } catch (error) {
        if (revision !== this.spaceRevision) return;
        this.notify(error.message);
      }
      this.icons();
    },
    newNotebookPage() {
      this.notebookDraft = { id: '', name: '', content: '', updated_at: '' };
      this.revealSoon('notebook-editor');
      this.icons();
    },
    async openNotebookPage(item) {
      const revision = this.spaceRevision;
      try {
        const data = await this.request(this.withNamespace('/v1/notebook/' + encodeURIComponent(item.id)));
        if (revision !== this.spaceRevision) return;
        const page = data.data || {};
        this.notebookDraft = { id: page.id, name: page.name, content: page.content, updated_at: page.updated_at };
        this.revealSoon('notebook-editor');
      } catch (error) {
        this.notify(error.message);
      }
      this.icons();
    },
    notebookDraftLabel() {
      const draft = this.notebookDraft;
      if (!draft) return '';
      const length = Array.from(draft.content || '').length;
      const size = this.L(length + ' / 20000 字', length + ' / 20,000 chars');
      return draft.updated_at ? size + this.L(' · 改于 ', ' · edited ') + this.fmt(draft.updated_at) : size + this.L(' · 新的一页', ' · new page');
    },
    async saveNotebookPage() {
      const draft = this.notebookDraft;
      if (!draft) return;
      // 和服务端一样：去头尾空白，中间连续空白并成一个空格。
      const name = String(draft.name || '').replace(/\s+/g, ' ').trim();
      if (!name || !String(draft.content || '').trim()) {
        this.notify(this.L('页名和内容都要填', 'A page needs a name and some content'));
        return;
      }
      if (!draft.id && this.notebookPages.some(function(item) { return item.name === name; })) {
        if (!window.confirm(this.L('已经有一页叫「' + name + '」，确认用这次写的整页替换它？', 'A page called “' + name + '” already exists. Replace it with this one?'))) return;
      }
      this.saving = true;
      try {
        const body = JSON.stringify({ namespace: this.namespace, name: name, content: draft.content });
        const data = draft.id
          ? await this.request(this.withNamespace('/v1/notebook/' + encodeURIComponent(draft.id)), { method: 'PATCH', body: body })
          : await this.request(this.withNamespace('/v1/notebook'), { method: 'POST', body: body });
        const page = data.data || {};
        this.notebookDraft = { id: page.id, name: page.name, content: page.content, updated_at: page.updated_at };
        await this.loadNotebook();
        this.notify(this.L('这一页已保存', 'Page saved'));
      } catch (error) {
        this.notify(error.message);
      }
      this.saving = false;
    },
    async deleteNotebookPage() {
      const draft = this.notebookDraft;
      if (!draft || !draft.id) return;
      if (!window.confirm(this.L('确认删除「' + draft.name + '」这一页？', 'Delete the page “' + draft.name + '”?'))) return;
      try {
        await this.request(this.withNamespace('/v1/notebook/' + encodeURIComponent(draft.id)), { method: 'DELETE' });
        this.notebookDraft = null;
        await this.loadNotebook();
        this.notify(this.L('这一页已删除', 'Page deleted'));
      } catch (error) {
        this.notify(error.message);
      }
    },
    async clearNotebook() {
      if (this.notebookPages.length === 0) return;
      if (!window.confirm(this.L('确认清空小本本？「' + this.namespace + '」里的 ' + this.notebookPages.length + ' 页会全部删掉，找不回来。', 'Clear the notebook? All ' + this.notebookPages.length + ' pages in “' + this.namespace + '” will be deleted for good.'))) return;
      try {
        const data = await this.request(this.withNamespace('/v1/notebook?confirm=all'), { method: 'DELETE' });
        this.notebookDraft = null;
        await this.loadNotebook();
        const deleted = (data.data && data.data.deleted) || 0;
        this.notify(this.L('小本本已清空，删了 ' + deleted + ' 页', 'Notebook cleared: ' + deleted + ' pages deleted'));
      } catch (error) {
        this.notify(error.message);
      }
    },
    async searchWorld() {
      const revision = this.spaceRevision;
      if (!this.worldQuery.trim()) {
        await this.loadWorldFacts();
        return;
      }
      try {
        const data = await this.request(this.withNamespace('/v1/memory/search'), {
          method: 'POST',
          body: JSON.stringify({ namespace: this.namespace, query: this.worldQuery, top_k: 30, filter: false })
        });
        if (revision !== this.spaceRevision) return;
        this.worldItems = data.data || [];
        this.pruneWorldSelection();
      } catch (error) {
        if (revision !== this.spaceRevision) return;
        this.notify(error.message);
      }
      this.icons();
    },
    async runHealth() {
      try {
        const data = await this.request('/v1/debug/vector_health');
        this.debugOutput = JSON.stringify(data, null, 2);
      } catch (error) {
        this.debugOutput = error.message;
      }
    },
    async runReindex(dryRun) {
      try {
        const data = await this.request('/v1/debug/vector_reindex', {
          method: 'POST',
          body: JSON.stringify({ namespace: this.namespace, limit: 50, dry_run: dryRun })
        });
        this.debugOutput = JSON.stringify(data, null, 2);
      } catch (error) {
        this.debugOutput = error.message;
      }
    },
    async runBackfill(dryRun) {
      try {
        const data = await this.request('/v1/vector-backfill', {
          method: 'POST',
          body: JSON.stringify({ namespace: this.namespace, limit: 50, dry_run: dryRun })
        });
        this.debugOutput = JSON.stringify(data, null, 2);
      } catch (error) {
        this.debugOutput = error.message;
      }
    },
    async runDream() {
      if (!window.confirm(this.L('立刻把「' + this.namespace + '」整理一遍？已经整理过的晚上也会重来。', 'Run the nightly process for “' + this.namespace + '” now? Nights already processed will be redone.'))) return;
      try {
        const data = await this.request('/v1/memories/dream', {
          method: 'POST',
          body: JSON.stringify({ namespace: this.namespace, force: true, max_runs: 3 })
        });
        this.debugOutput = JSON.stringify(data, null, 2);
        await this.reloadAll();
      } catch (error) {
        this.debugOutput = error.message;
      }
    },
    go(id) {
      this.stopDreamPolling();
      this.navOpen = false;
      // 星图是独立的 Three.js 页面，跳过去，不嵌在这里
      if (id === 'starmap') {
        window.location.href = '/admin/starmap';
        return;
      }
      this.page = id;
      if (id === 'today') this.loadHome();
      if (id === 'settings') { this.loadRecallHistory(); this.chatgptLoad(); if (!this.gwGroups.length && this.savedApiKey.trim()) this.gwLoad(); }
      if (id === 'review') { this.loadCandidates(); this.loadJudgeDecisions(); }
      if (id === 'memory') this.loadMoreView();
      if (id === 'diary') { this.diaryReading = false; this.loadDiary(); }
      if (id === 'transfer') { this.loadTransferInfo(); this.loadImportBatches(); }
      if (id === 'dream') {
        this.loadDreamStatus();
        this.loadDreamHarvest();
      }
      this.scrollTop();
      this.icons();
    },`;
