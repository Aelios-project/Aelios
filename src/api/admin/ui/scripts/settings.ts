export const ADMIN_SCRIPT_SETTINGS = String.raw`    async init() {
      this.applyLang();
      this.applyTheme();
      this.icons();
      await this.loadMemoryIdentities();
      await this.reloadAll();
    },
    currentIdentity() {
      return this.memoryIdentities.find(idn => idn.slug === this.selectedIdentity);
    },
    flagValue(raw) {
      const text = String(raw || '').trim().toLowerCase();
      if (['on', 'true', '1', 'yes'].includes(text)) return true;
      if (['off', 'false', '0', 'no'].includes(text)) return false;
      return null;
    },
    // 什么都不存时这个开关是开是关：先看部署值，没有就看代码默认。
    switchBaseline(item) {
      const deployed = this.flagValue(item.deployed);
      return deployed === null ? item.defaultOn === true : deployed;
    },
    settingOn(item) {
      const own = this.flagValue(item.value);
      return own === null ? this.switchBaseline(item) : own;
    },
    // 拨回默认就清掉覆盖，跟默认不一样才存 true/false，点了就存。
    toggleSetting(item) {
      const next = !this.settingOn(item);
      return this.saveSetting(item, next === this.switchBaseline(item) ? '' : String(next));
    },
    saveSetting(item, raw) {
      const value = String(raw == null ? '' : raw).trim();
      const before = item.saved || '';
      item.value = value;
      if (value === before) return Promise.resolve();
      item.busy = true;
      const self = this;
      const task = async function() {
        const name = self.sLabel(item);
        try {
          const body = { settings: {} };
          body.settings[item.name] = value;
          const result = await self.request('/api/gateway/config', { method: 'PATCH', body: JSON.stringify(body) });
          const stored = result && result.settings && result.settings[item.name] || '';
          item.value = stored;
          item.saved = stored;
          if (item.kind === 'switch') self.notify(self.settingOn(item) ? self.L('已打开「' + name + '」', 'Turned on “' + name + '”') : self.L('已关闭「' + name + '」', 'Turned off “' + name + '”'));
          else self.notify(stored ? self.L('已保存「' + name + '」', 'Saved “' + name + '”') : self.L('「' + name + '」已恢复默认', '“' + name + '” reset to default'));
        } catch (error) {
          item.value = before;
          self.notify(self.L('「' + name + '」没存上：', '“' + name + '” wasn’t saved: ') + error.message);
        }
        item.busy = false;
      };
      const run = settingsQueue.then(task, task);
      settingsQueue = run.catch(function() {});
      return run;
    },
    gwItems() {
      return this.gwGroups.reduce(function(all, g) { return all.concat(g.items); }, []);
    },
    gwCommon() {
      const items = this.gwItems().filter(function(item) { return item.common; });
      return items.filter(function(item) { return item.kind === 'switch'; })
        .concat(items.filter(function(item) { return item.kind !== 'switch'; }));
    },
    // 网关和运行地区画在「模型与上游」里上游地址下面。
    gwUpstreamSettings() {
      return this.gwItems().filter(function(item) { return item.upstream; });
    },
    // 没在搜时「常用」和上游那几项不在分组里重复；搜的时候所有项都参与（中英文名、说明、变量名都能搜），命中的组自动展开。
    gwSections() {
      const q = this.gwQuery.trim().toLowerCase();
      return this.gwGroups.map(function(g) {
        const items = g.items.filter(function(item) {
          if (!q) return !item.common && !item.upstream;
          return [item.label, item.hint, item.labelEn, item.hintEn, item.name, g.group, g.groupEn].some(function(text) { return String(text || '').toLowerCase().includes(q); });
        });
        return { group: g.group, groupEn: g.groupEn || '', items: items, changed: items.filter(function(item) { return item.saved; }).length };
      }).filter(function(section) { return section.items.length; });
    },
    gwChangedCount() {
      return this.gwItems().filter(function(item) { return item.saved; }).length;
    },
    gwToggle(key) { this.gwOpen[key] = !this.gwOpen[key]; },
    gwIsOpen(key) { return !!this.gwOpen[key]; },
    gwGroupOpen(group) { return !!this.gwQuery.trim() || !!this.gwOpen[group]; },
    gwIdentityTitle(idn) {
      return (idn.assistantName || '').trim() || (idn.slug || '').trim() || this.L('新助手', 'New assistant');
    },
    // 这个助手的写入空间还没有记忆，而别的空间（没被其他助手占着的）有，就提醒一句，点一下改过去。
    gwSpaceHint(idn) {
      const write = (idn.namespace || '').trim() || (idn.slug || '').trim();
      if (!write || !this.gwSpaces.length) return null;
      if (this.gwSpaces.some(function(space) { return space.namespace === write && space.memories > 0; })) return null;
      const others = this.gwIdentities.filter(function(other) { return other !== idn; }).map(function(other) {
        return (other.namespace || '').trim() || (other.slug || '').trim();
      });
      const free = this.gwSpaces.find(function(space) {
        return space.memories > 0 && space.namespace !== write && !others.includes(space.namespace);
      });
      if (!free) return null;
      return { space: free.namespace, text: this.L('「' + write + '」里还没有记忆，' + free.namespace + ' 里有 ' + free.memories + ' 条。', 'Nothing in “' + write + '” yet; ' + free.namespace + ' has ' + free.memories + ' memories.') };
    },
    gwUseSpace(idn) {
      const hint = this.gwSpaceHint(idn);
      if (hint) idn.namespace = hint.space;
    },
    gwIdentitySummary(idn) {
      const slug = (idn.slug || '').trim();
      const models = (idn.modelsText || '').split(/[,，\n]/).map(function(m) { return m.trim(); }).filter(Boolean);
      return [
        slug ? '/' + slug : this.L('还没起名字', 'not named yet'),
        models.length ? models.join(this.L('、', ', ')) : this.L('还没填主模型', 'no models yet'),
        this.L('写入 ', 'writes to ') + ((idn.namespace || '').trim() || slug || '—')
      ].join(' · ');
    },
    viewingLabel() {
      const idn = this.currentIdentity();
      const name = idn ? ((idn.assistantName || '').trim() || idn.slug) : this.L('自选空间', 'Custom space');
      return name + ' · ' + (this.namespace || 'default');
    },
    identitySpaces() {
      const idn = this.currentIdentity();
      if (!idn) return [];
      const write = idn.namespace || idn.slug;
      const reads = idn.readNamespaces === undefined ? [write] : idn.readNamespaces;
      return [...new Set([write, ...reads])].map(name => ({ name: name,
        label: name + (name === write ? this.L(' · 写入空间', ' · write space') : this.L(' · 召回空间', ' · recall space')) }));
    },
    // 没选助手时列出 default、所有有记忆的空间和正在看的这个，没配助手也能点回装着记忆的空间。
    pickerSpaces() {
      if (this.currentIdentity()) return this.identitySpaces();
      const counts = this.gwSpaces;
      const names = [...new Set(['default', ...counts.map(space => space.namespace), this.namespace || 'default'])];
      return names.map(name => {
        const found = counts.find(space => space.namespace === name);
        const note = found ? this.L(' · ' + found.memories + ' 条', ' · ' + found.memories + ' memories') : counts.length ? this.L(' · 没有记忆', ' · empty') : '';
        return { name: name, label: name + note };
      });
    },
    pickSpace(name) {
      const idn = this.currentIdentity();
      if (idn && this.identitySpaces().some(space => space.name === name)) return this.switchSpace(name);
      return this.selectCustomSpace(name);
    },
    // 自选空间时正在看的空间没有记忆、别的空间有，就提醒一句（多半是浏览器还记着一个旧空间名）。
    // 助手自己的空间是空的不在这里提醒：设置页的 gwSpaceHint 管那种情况，这里点过去会摘掉助手。
    emptySpaceHint() {
      if (this.currentIdentity()) return null;
      const current = this.namespace || 'default';
      if (this.gwSpaces.some(space => space.namespace === current && space.memories > 0)) return null;
      const best = this.gwSpaces.find(space => space.memories > 0);
      if (!best) return null;
      return { space: best.namespace, text: this.L('「' + current + '」里还没有记忆，' + best.namespace + ' 里有 ' + best.memories + ' 条。', 'Nothing in “' + current + '” yet; ' + best.namespace + ' has ' + best.memories + ' memories.') };
    },
    async loadSpaces() {
      // 各空间的记忆条数只用来提醒和列空间，读不到不影响别的。
      try { this.gwSpaces = (await this.request('/api/gateway/spaces')).spaces || []; } catch { this.gwSpaces = []; }
    },
    spaceDescription() {
      const idn = this.currentIdentity();
      if (!idn) return this.L('当前查看：', 'Viewing: ') + this.namespace;
      const write = idn.namespace || idn.slug;
      const reads = idn.readNamespaces === undefined ? [write] : idn.readNamespaces;
      const owners = this.memoryIdentities.filter(other =>
        (other.namespace || other.slug) === this.namespace ||
        (other.readNamespaces || []).includes(this.namespace)).map(other => other.slug);
      const shared = owners.filter(name => name !== idn.slug).join(this.L('、', ', '));
      return this.L('写入：', 'Writes to: ') + write + this.L('；召回：', '; recalls from: ') + (reads.length ? reads.join(this.L('、', ', ')) : this.L('已关闭', 'off')) +
        (owners.length > 1 ? this.L('。当前空间也被这些助手使用：', '. This space is also used by: ') + shared : '');
    },
    async loadMemoryIdentities() {
      if (!this.apiKey.trim()) return;
      const revision = this.spaceRevision;
      try {
        const config = await this.request('/api/gateway/config');
        if (revision !== this.spaceRevision) return;
        this.memoryIdentities = config.identities || [];
        this.identityLoadError = '';
        const saved = localStorage.getItem('aelios.admin.identity');
        let idn = this.currentIdentity();
        // Keep an explicitly chosen custom space, including an old unconfigured library.
        if (!idn && saved === null) {
          idn = this.memoryIdentities.find(item => (item.namespace || item.slug) === this.namespace);
          if (!idn && (this.namespace === 'default' || !this.namespace)) idn = this.memoryIdentities[0];
        }
        this.selectedIdentity = idn ? idn.slug : '';
        this.identityPreferenceReady = true;
        if (idn && !this.identitySpaces().some(space => space.name === this.namespace)) {
          this.namespace = idn.namespace || idn.slug;
          this.spaceRevision += 1;
          this.clearSpaceData();
        }
        this.savePrefs();
        this.syncSpeakerDraft();
      } catch (error) {
        if (revision !== this.spaceRevision) return;
        this.identityLoadError = this.L('助手列表读取失败，可在高级选项里填写空间名：', 'Couldn’t load assistants. You can type a space name under Advanced: ') + error.message;
      }
    },
    selectIdentity(slug) {
      this.identityPreferenceReady = true;
      this.selectedIdentity = slug;
      this.syncSpeakerDraft();
      const idn = this.currentIdentity();
      return this.switchSpace(idn ? (idn.namespace || idn.slug) : this.namespace);
    },
    syncSpeakerDraft() {
      const idn = this.currentIdentity();
      this.speakerUserName = idn && idn.userName || '';
      this.speakerAssistantName = idn && idn.assistantName || '';
    },
    async saveSpeakers() {
      const slug = this.selectedIdentity;
      if (!slug || this.speakerBusy) return;
      this.speakerBusy = true;
      try {
        const config = await this.request('/api/gateway/config');
        const identities = config.identities || [];
        const idn = identities.find(item => item.slug === slug);
        if (!idn) throw new Error(this.L('找不到这位助手', 'Assistant not found'));
        const userName = (this.speakerUserName || '').trim();
        const assistantName = (this.speakerAssistantName || '').trim();
        if (userName) idn.userName = userName; else delete idn.userName;
        if (assistantName) idn.assistantName = assistantName; else delete idn.assistantName;
        // 只改助手这一块，设置项不跟着回写。
        await this.request('/api/gateway/config', { method: 'PATCH', body: JSON.stringify({ identities: identities }) });
        const card = this.gwIdentities.find(item => item.slug === slug);
        const wasClean = !this.gwDirty();
        if (card) { card.userName = userName; card.assistantName = assistantName; }
        if (wasClean && this.gwSnapshot) this.gwMark();
        await this.loadMemoryIdentities();
        this.notify(this.L('说话人名字保存好了', 'Speaker names saved'));
      } catch (error) { this.notify(this.L('说话人名字保存失败：', 'Couldn’t save speaker names: ') + error.message); }
      this.speakerBusy = false;
    },
    selectCustomSpace(name) {
      this.identityPreferenceReady = true;
      this.selectedIdentity = '';
      return this.switchSpace(name);
    },
    async switchSpace(name) {
      this.namespace = name.trim() || 'default';
      this.spaceRevision += 1;
      this.clearSpaceData();
      await this.reloadAll();
    },
    clearSpaceData() {
      this.recallHistoryRevision += 1;
      this.recallHistory = []; this.recallHistoryError = ''; this.recallHistoryLoading = false;
      this.boot = {}; this.stats = {};
      this.todayMessages = []; this.candidates = []; this.judgeDecisions = []; this.memories = [];
      this.home = { diary: null, run: null, harvest: null }; this.homeAll = false;
      this.reviewSelected = {};
      this.precious = []; this.glossary = [];
      this.notebookPages = []; this.notebookDraft = null; this.notebookLoaded = false;
      this.handoffNote = { content: null, revision: 0, source: '', updated_at: null };
      this.handoffDraft = ''; this.handoffGuide = ''; this.handoffLoaded = false; this.handoffBusy = false;
      this.diaryDailies = []; this.diaryWeeklies = []; this.diaryMonthlies = []; this.diaryExpanded = {}; this.diaryRewriting = ''; this.diaryPick = ''; this.diaryReading = false;
      this.worldItems = []; this.worldSelection = {}; this.worldQuery = '';
      this.importReview = { batches: [], importId: '', filter: 'all', items: [], counts: { pending: 0, clef_yes: 0, clef_no: 0 }, offset: 0, more: false, loading: false, bulk: null };
      // 正在跑的聊天导入带着自己的空间，换空间不打断它；别的导入状态跟着空间清掉。
      this.transfer.info = null; this.transfer.preview = null; this.transfer.entriesRun = null; this.transfer.batches = [];
      if (this.transfer.chatRun && !this.transfer.chatRun.running) this.transfer.chatRun = null;
      this.memoryCreateOpen = false;
      this.memoryDraft = { type: 'fact', content: '', fact_key: '', importance: 0.7, confidence: 0.85 };
      this.glossaryDraft = { term: '', definition: '', aliasesText: '' };
      this.stopDreamPolling();
      this.dreamStatus = null; this.dreamRuns = []; this.dreamActiveRun = null; this.dreamHarvest = null;
      this.dreamExpanded = {}; this.dreamRunResult = null;
      this.dreamDate = ''; this.dreamHarvestDate = '';
      this.dreamLoading = false; this.dreamHarvestLoading = false;
      this.dreamTriggering = false; this.dreamResolving = false; this.dreamStatusError = '';
      this.debugOutput = '';
    },
    // 图标都直接写在页面里了；留着这个钩子，旧代码里到处在调。
    icons() {
      this.$nextTick(function() {
        if (window.lucide) window.lucide.createIcons();
      });
    },
    savePrefs() {
      localStorage.setItem('aelios.admin.workerUrl', this.workerUrl || location.origin);
      localStorage.setItem('aelios.admin.namespace', this.namespace || 'default');
      if (this.identityPreferenceReady) localStorage.setItem('aelios.admin.identity', this.selectedIdentity || '');
      localStorage.setItem('aelios.admin.colorMode', this.theme || 'light');
    },
    tokenSaved() {
      return (this.apiKey || '') === (this.savedApiKey || '');
    },
    async saveToken() {
      this.spaceRevision += 1;
      this.clearSpaceData();
      this.memoryIdentities = [];
      this.savePrefs();
      localStorage.setItem('aelios.admin.apiKey', this.apiKey || '');
      this.savedApiKey = this.apiKey || '';
      this.connected = null;
      this.tokenEditing = false;
      this.notify(this.apiKey && this.apiKey.trim() ? this.L('Token 已保存', 'Token saved') : this.L('Token 已清空', 'Token cleared'));
      this.gwGroups = []; this.gwSecrets = []; this.gwIdentities = []; this.gwSnapshot = ''; this.gwError = '';
      await this.loadMemoryIdentities();
      await this.switchSpace(this.namespace);
      if (this.page === 'settings' && this.savedApiKey.trim()) await this.gwLoad();
    },
    clearToken() {
      this.apiKey = '';
      this.saveToken();
    },
    signOut() {
      if (!window.confirm(this.L('退出后，这台设备要重新填 Token 才能用。继续吗？', 'Sign out? You’ll need to enter the token again on this device.'))) return;
      this.clearToken();
    },
    applyTheme() {
      document.documentElement.dataset.theme = this.theme === 'dark' ? 'dark' : 'light';
      this.icons();
    },
    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      this.savePrefs();
      this.applyTheme();
    },
    base() {
      return (this.workerUrl || location.origin).replace(/\/+$/, '');
    },
    withNamespace(path) {
      const sep = path.indexOf('?') === -1 ? '?' : '&';
      return path + sep + 'namespace=' + encodeURIComponent(this.namespace || 'default');
    },
    async request(path, options) {
      if (!this.apiKey.trim()) throw new Error(this.L('请先填写 token', 'Enter your token first'));
      const opts = options || {};
      const headers = Object.assign({
        Authorization: 'Bearer ' + this.apiKey
      }, opts.body ? { 'content-type': 'application/json' } : {}, opts.headers || {});
      const response = await fetch(this.base() + path, Object.assign({}, opts, { headers: headers }));
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch (error) { payload = { raw: text }; }
      if (!response.ok) {
        const message = payload && payload.error ? (payload.error.message || payload.error) : response.status + ' ' + response.statusText;
        throw new Error(message);
      }
      return payload || {};
    },
    notify(message) {
      this.toast = message;
      const self = this;
      window.setTimeout(function() {
        if (self.toast === message) self.toast = '';
      }, 2400);
    },
    recallStatusLabel(status) {
      const zh = { reranked: '原文重排＋规则', lexical: '词面兜底', empty: '没有候选', error: '本轮未带上' };
      const en = { reranked: 'Reranked + rules', lexical: 'Lexical fallback', empty: 'No candidates', error: 'Nothing brought in' };
      return (this.lang === 'en' ? en : zh)[status] || this.L('旧版召回', 'Legacy recall');
    },
    recallReasonLabel(reason) {
      const zh = { no_safe_window: '没有能完整保留局部上下文的短片段', rerank_selected: '原文片段相关，已通过规则筛选', lexical_fallback_selected: '重排不可用，改用词面命中', below_rerank_threshold: '相关分数不足，不凑数', duplicate_source: '同一来源本次只占一个位置', duplicate_fact: '同一事实已选更高分版本', impression_not_evidence: '日记印象不当作事实证据', latest_requires_evidence: '要排最近一次，相关分做不到，本轮不带上', reranker_timeout: '原文重排超时，已回落词面', reranker_missing_binding: '缺少 Worker AI 绑定，已回落词面', reranker_disabled: '重排已关闭，已回落词面', reranker_unsupported_model: '请配置 Workers AI 重排模型', reranker_invalid_response: '重排分数无效，已回落词面', reranker_failed: '原文重排失败，已回落词面', duplicate_content: '同一内容只保留一份', already_visible: '聊天历史里已经有了', item_budget: '已选出更合适的记忆', candidate_budget: '超过本次候选数量', empty_content: '没有可用正文' };
      const en = { no_safe_window: 'No short passage keeps its local context intact', rerank_selected: 'Relevant passage; passed the rules', lexical_fallback_selected: 'Rerank unavailable; used a word match', below_rerank_threshold: 'Score too low; not padded in', duplicate_source: 'One slot per source this turn', duplicate_fact: 'A higher-scoring version of this fact was chosen', impression_not_evidence: 'Journal impressions aren’t used as evidence', latest_requires_evidence: 'Can’t rank “most recent” by relevance; skipped this turn', reranker_timeout: 'Rerank timed out; fell back to word match', reranker_missing_binding: 'Missing Workers AI binding; fell back to word match', reranker_disabled: 'Rerank is off; fell back to word match', reranker_unsupported_model: 'Set a Workers AI rerank model', reranker_invalid_response: 'Invalid rerank scores; fell back to word match', reranker_failed: 'Rerank failed; fell back to word match', duplicate_content: 'Same content kept once', already_visible: 'Already in the chat history', item_budget: 'Better memories were chosen', candidate_budget: 'Over this turn’s candidate limit', empty_content: 'No usable text' };
      const labels = this.lang === 'en' ? en : zh;
      if (labels[reason]) return labels[reason];
      return reason || '';
    },
    async loadRecallHistory() {
      const revision = ++this.recallHistoryRevision;
      const spaceRevision = this.spaceRevision;
      const identity = this.selectedIdentity;
      const base = this.base(), key = this.apiKey;
      this.recallHistory = []; this.recallHistoryError = ''; this.recallHistoryLoading = false;
      if (!identity || !this.apiKey.trim()) return;
      this.recallHistoryLoading = true;
      const current = () => revision === this.recallHistoryRevision && spaceRevision === this.spaceRevision &&
        identity === this.selectedIdentity && base === this.base() && key === this.apiKey;
      try {
        const data = await this.request('/api/gateway/recalls?identity=' + encodeURIComponent(identity));
        if (current()) this.recallHistory = data.items || [];
      } catch (error) {
        if (current()) this.recallHistoryError = this.L('召回记录读取失败：', 'Couldn’t load recalls: ') + error.message;
      } finally {
        if (current()) this.recallHistoryLoading = false;
      }
    },
    async gwLoad(manual) {
      if (this.gwBusy) return;
      this.gwBusy = true;
      this.gwError = '';
      try {
        const config = await this.request('/api/gateway/config');
        this.gwAddress = config.upstream && config.upstream.address || '';
        this.modelList.items = config.modelList || [];
        this.modelList.loaded = true;
        this.modelListSearch();
        await this.loadMemoryIdentities();
        this.gwIdentities = (config.identities || []).map(function(idn) {
          return {
            slug: idn.slug || '',
            userName: idn.userName || '',
            assistantName: idn.assistantName || '',
            modelsText: (idn.models || []).join(', '),
            namespace: idn.namespace || '',
            readNamespacesText: idn.readNamespaces ? (idn.readNamespaces.length ? idn.readNamespaces.join(', ') : '[]') : '',
            keys: idn.keys && idn.keys.length ? idn.keys.slice() : ['CHATBOX_API_KEY'],
            anthropicThinking: idn.anthropicThinking || 'auto',
            maxMemoryChars: idn.maxMemoryChars || '',
            codingFilter: idn.codingFilter !== false,
            _open: false
          };
        });
        await this.loadSpaces();
        const envData = await this.request('/api/gateway/env');
        (envData.groups || []).forEach(function(g) {
          g.items.forEach(function(item) { item.value = item.value || ''; item.saved = item.value; item.busy = false; });
        });
        this.gwGroups = envData.groups || [];
        this.gwSecrets = envData.secrets || [];
        this.gwMark();
        if (manual) this.notify(this.L('设置重新读好了', 'Settings reloaded'));
      } catch (error) {
        this.gwError = this.L('设置读取失败：', 'Couldn’t load settings: ') + error.message;
      }
      this.gwBusy = false;
      this.icons();
    },
    gwRefresh() {
      if (this.gwDirty() && !window.confirm(this.L('助手和上游的改动还没保存，重新读取会丢掉，继续吗？', 'Your assistant and upstream changes aren’t saved. Reloading discards them. Continue?'))) return;
      this.gwSnapshot = '';
      return this.gwLoad(true);
    },
    gwAdd() {
      // 第一个助手默认跟 MCP、Claude Code 钩子用同一个 default 空间，不然先用过 MCP 的人记忆会分成两份。
      const namespace = this.gwIdentities.length ? '' : 'default';
      this.gwIdentities.push({ slug: '', userName: '', assistantName: '', modelsText: '', namespace: namespace, readNamespacesText: '', keys: ['CHATBOX_API_KEY'], anthropicThinking: 'auto', maxMemoryChars: '', codingFilter: true, _open: true });
    },
    // 助手和上游要一起改好再存，所以跟线上比一比，有没存的就在底部浮出保存条。
    gwMark() { this.gwSnapshot = JSON.stringify(this.gwPayload()); },
    gwDirty() { return !!this.gwSnapshot && JSON.stringify(this.gwPayload()) !== this.gwSnapshot; },
    gwDiscard() {
      this.gwSnapshot = '';
      return this.gwLoad();
    },
    gwPayload() {
      const identities = this.gwIdentities.map(function(idn) {
        const out = {
          slug: (idn.slug || '').trim(),
          keys: idn.keys,
          models: (idn.modelsText || '').split(/[,，\n]/).map(function(s) { return s.trim(); }).filter(Boolean)
        };
        if ((idn.userName || '').trim()) out.userName = idn.userName.trim();
        if ((idn.assistantName || '').trim()) out.assistantName = idn.assistantName.trim();
        if ((idn.namespace || '').trim()) out.namespace = idn.namespace.trim();
        const reads = (idn.readNamespacesText || '').trim();
        if (reads) out.readNamespaces = reads === '[]' ? [] : reads.split(/[,，\n]/).map(function(s) { return s.trim(); }).filter(Boolean);
        if (idn.anthropicThinking && idn.anthropicThinking !== 'auto') out.anthropicThinking = idn.anthropicThinking;
        const budget = parseInt(idn.maxMemoryChars, 10);
        if (budget) out.maxMemoryChars = budget;
        if (!idn.codingFilter) out.codingFilter = false;
        return out;
      });
      return { identities: identities, upstream: this.gwAddress.trim() ? { address: this.gwAddress.trim() } : null };
    },
    // 只存助手和上游，设置项各自已经存过了，这里不带，免得拿旧值盖掉。
    async gwSave() {
      if (this.gwBusy) return;
      this.gwBusy = true;
      const self = this;
      const payload = this.gwPayload();
      const task = async function() {
        try {
          await self.request('/api/gateway/config', { method: 'PATCH', body: JSON.stringify(payload) });
          self.gwSnapshot = JSON.stringify(payload);
          self.gwIdentities.forEach(function(idn) { idn._open = false; });
          await self.loadMemoryIdentities();
          await self.switchSpace(self.namespace);
          self.notify(self.L('助手和上游保存好了', 'Assistants and upstream saved'));
        } catch (error) { self.notify(self.L('没存上：', 'Not saved: ') + error.message); }
      };
      const run = settingsQueue.then(task, task);
      settingsQueue = run.catch(function() {});
      await run;
      this.gwBusy = false;
    },
    scrollToId(id) {
      if (typeof document.getElementById !== 'function') return;
      const target = document.getElementById(id);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    // 等页面画好再滚过去（刚出现的编辑框之类）。
    revealSoon(id) {
      if (typeof this.$nextTick === 'function') this.$nextTick(function() { this.scrollToId(id); }.bind(this));
    },
    // 回到顶上：宽屏是整页在滚，手机上是 .main 自己在滚。
    scrollTop() {
      if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
      const main = typeof document.querySelector === 'function' ? document.querySelector('.main') : null;
      if (main) main.scrollTop = 0;
    },
    // 窄屏点开一篇就换成全文，带「← 日记列表」；宽屏左右两栏，正文在右边直接换。
    openDiary(key) {
      this.diaryPick = key;
      this.diaryReading = true;
      if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1023px)').matches) this.scrollTop();
    },`;
