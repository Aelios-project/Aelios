export const ADMIN_SCRIPT_DREAM = `    async loadDiary() {
      const revision = this.spaceRevision;
      try {
        const data = await this.request(this.withNamespace('/admin/diary?limit=30'));
        if (revision !== this.spaceRevision) return;
        const payload = data.data || {};
        this.diaryDailies = payload.dailies || [];
        this.diaryWeeklies = payload.weeklies || [];
        this.diaryMonthlies = payload.monthlies || [];
      } catch (error) {
        if (revision !== this.spaceRevision) return;
        this.notify(error.message);
      }
      this.icons();
    },
    diaryListItems() {
      const self = this;
      if (this.diaryMode === 'monthly') {
        return this.diaryMonthlies.map(function(entry) {
          return { key: 'monthly:' + entry.month, when: self.monthLabel(entry.month), title: entry.title, excerpt: self.excerpt(entry.summary) };
        });
      }
      if (this.diaryMode === 'weekly') {
        return this.diaryWeeklies.map(function(entry) {
          return { key: 'weekly:' + entry.week, when: entry.week + ' · ' + entry.start_date + ' – ' + entry.end_date, title: entry.title, excerpt: self.excerpt(entry.summary) };
        });
      }
      return this.diaryDailies.map(function(entry) {
        return { key: 'daily:' + entry.date, when: self.dayLabel(entry.date), title: entry.title, excerpt: self.excerpt(entry.summary) };
      });
    },
    diaryCurrentKey() {
      const items = this.diaryListItems();
      const pick = this.diaryPick;
      if (items.some(function(item) { return item.key === pick; })) return pick;
      return items.length ? items[0].key : '';
    },
    diaryCurrent() {
      const key = this.diaryCurrentKey();
      if (!key) return null;
      const cut = key.indexOf(':');
      const kind = key.slice(0, cut);
      const id = key.slice(cut + 1);
      if (kind === 'monthly') return this.diaryMonthlies.find(function(entry) { return entry.month === id; }) || null;
      if (kind === 'weekly') return this.diaryWeeklies.find(function(entry) { return entry.week === id; }) || null;
      return this.diaryDailies.find(function(entry) { return entry.date === id; }) || null;
    },
    diaryReasonLabel(reason, error) {
      const zh = {
        disabled: '日记写手没有开启',
        no_messages: '这一天没有可用的聊天原文',
        week_already_rolled_up: '这一周已经汇总成周记，不再重写',
        ungrounded_sources: '模型给的原文来源对不上，没有写入',
        model_error: '模型出错',
        model_invalid_json: '模型返回格式不合要求'
      };
      const en = {
        disabled: 'The journal writer is off',
        no_messages: 'No chat transcript for that day',
        week_already_rolled_up: 'That week is already in a weekly summary, so it can’t be rewritten',
        ungrounded_sources: 'The model’s sources didn’t match the transcript; nothing written',
        model_error: 'Model error',
        model_invalid_json: 'The model returned an invalid format'
      };
      return (this.lang === 'en' ? en : zh)[reason] || error || reason || this.L('原因未知', 'Unknown reason');
    },
    async rewriteDiary(entry) {
      if (this.diaryRewriting) return;
      if (!window.confirm(this.L('用 ' + entry.date + ' 的聊天原文重写这篇日记，现在的内容会被覆盖。继续？', 'Rewrite this entry from the ' + entry.date + ' transcript? The current text will be replaced.'))) return;
      const revision = this.spaceRevision;
      this.diaryRewriting = entry.date;
      try {
        const data = await this.request('/admin/diary-rewrite', {
          method: 'POST',
          body: JSON.stringify({ namespace: this.namespace, date: entry.date })
        });
        if (revision !== this.spaceRevision) return;
        const stats = (data.data && data.data.stats) || {};
        if (stats.ran) {
          this.notify(this.L('日记已重写：', 'Entry rewritten: ') + entry.date);
          await this.loadDiary();
        } else {
          this.notify(this.L('没有重写：', 'Not rewritten: ') + this.diaryReasonLabel(stats.reason, stats.error));
        }
      } catch (error) {
        if (revision !== this.spaceRevision) return;
        this.notify(error.message);
      } finally {
        if (revision === this.spaceRevision) this.diaryRewriting = '';
      }
    },
    isDiaryExpanded(key) {
      return Boolean(this.diaryExpanded[key]);
    },
    toggleDiaryExpand(key) {
      const next = Object.assign({}, this.diaryExpanded);
      if (next[key]) delete next[key];
      else next[key] = true;
      this.diaryExpanded = next;
    },
    yesterdayLabel() {
      const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const pad = function(n) { return String(n).padStart(2, '0'); };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    },
    dreamAnchorDate() {
      return (this.dreamStatus && this.dreamStatus.anchor_date_label) || this.yesterdayLabel();
    },
    stopDreamPolling() {
      if (this.dreamPollTimer != null) window.clearTimeout(this.dreamPollTimer);
      this.dreamPollTimer = null;
    },
    scheduleDreamPolling() {
      this.stopDreamPolling();
      if (this.page !== 'dream' || !this.dreamActiveRun || this.dreamActiveRun.stale) return;
      const revision = this.spaceRevision;
      this.dreamPollTimer = window.setTimeout(() => {
        this.dreamPollTimer = null;
        if (revision === this.spaceRevision && this.page === 'dream') this.loadDreamStatus();
      }, 5000);
    },
    async loadDreamStatus() {
      const revision = this.spaceRevision;
      this.stopDreamPolling();
      this.dreamLoading = true;
      this.dreamStatusError = '';
      try {
        const data = await this.request(this.withNamespace('/v1/dream/status'));
        if (revision !== this.spaceRevision) return;
        const payload = data.data || {};
        this.dreamStatus = payload;
        this.dreamRuns = payload.dream_runs || [];
        this.dreamActiveRun = payload.active_run || this.dreamRuns.find(function(run) {
          return run.status === 'queued' || run.status === 'running';
        }) || null;
        const tracked = this.dreamRunResult && this.dreamRunResult.run_id;
        const run = tracked && (this.dreamRuns.find(function(item) { return item.id === tracked; })
          || (this.dreamActiveRun && this.dreamActiveRun.id === tracked ? this.dreamActiveRun : null));
        if (run) {
          const previousStatus = this.dreamRunResult.status;
          this.dreamRunResult.status = run.status;
          this.dreamRunResult.stale = run.stale;
          if ((previousStatus === 'queued' || previousStatus === 'running') && run.status !== 'queued' && run.status !== 'running') {
            this.loadDreamHarvest();
          }
        }
        this.scheduleDreamPolling();
        if (!this.dreamDate) this.dreamDate = this.dreamAnchorDate();
        if (!this.dreamHarvestDate) this.dreamHarvestDate = this.dreamAnchorDate();
      } catch (error) {
        if (revision !== this.spaceRevision) return;
        this.dreamStatusError = this.L('状态读取失败，任务是否完成尚未确认。请刷新核查，不要直接重跑。', 'Couldn’t read the status, so whether the run finished is unconfirmed. Refresh to check; don’t just run it again.');
        this.notify(error.message);
      }
      this.dreamLoading = false;
      this.icons();
    },
    async loadDreamHarvest() {
      const revision = this.spaceRevision;
      if (!this.dreamHarvestDate) this.dreamHarvestDate = this.dreamAnchorDate();
      this.dreamHarvestLoading = true;
      try {
        const data = await this.request(this.withNamespace('/admin/dream/harvest?date=' + encodeURIComponent(this.dreamHarvestDate)));
        if (revision !== this.spaceRevision) return;
        this.dreamHarvest = data.data || null;
      } catch (error) {
        if (revision !== this.spaceRevision) return;
        this.dreamHarvest = null;
        this.notify(error.message);
      }
      this.dreamHarvestLoading = false;
      this.icons();
    },
    refreshDream() {
      this.loadDreamStatus();
      this.loadDreamHarvest();
    },
    // 失败的那一晚：把日期填进「手动整理一晚」，切成真跑，滚过去等你点「开始」。
    prepareRerun(run) {
      if (!run) return;
      if (this.page !== 'dream') this.go('dream');
      this.dreamDate = run.date_label;
      this.dreamDryRun = false;
      this.dreamForce = false;
      this.revealSoon('dream-run');
    },
    async resolveDreamRun() {
      const run = this.dreamActiveRun;
      if (this.dreamResolving || !run || !run.stale) return;
      if (!window.confirm(this.L('确认任务 ' + run.id + ' 已经不在执行？标记后可以重新发起，但它可能已经写入了部分记忆，建议先查 Worker 日志。', 'Confirm run ' + run.id + ' is no longer running? You can start again afterwards, but it may have saved some memories already; check the Worker logs first.'))) return;
      const revision = this.spaceRevision;
      this.dreamResolving = true;
      try {
        await this.request('/v1/dream/resolve', {
          method: 'POST',
          body: JSON.stringify({ namespace: this.namespace, run_id: run.id })
        });
        if (revision !== this.spaceRevision) return;
        this.notify(this.L('已标记为已中断：', 'Marked as stopped: ') + run.id);
        await this.loadDreamStatus();
      } catch (error) {
        if (revision !== this.spaceRevision) return;
        this.notify(error.message);
        await this.loadDreamStatus();
      } finally {
        if (revision === this.spaceRevision) this.dreamResolving = false;
      }
    },
    async triggerDream() {
      if (this.dreamTriggering || (!this.dreamDryRun && this.dreamActiveRun)) return;
      const revision = this.spaceRevision;
      const dryRun = this.dreamDryRun;
      const date = this.dreamDate || this.dreamAnchorDate();
      if (this.dreamForce && !this.dreamDryRun) {
        if (!window.confirm(this.L('会把 ' + date + ' 这一晚重新整理一遍，已经整理过的也会重来。继续吗？', 'This redoes the night of ' + date + ', even if it was already processed. Continue?'))) return;
      }
      this.dreamTriggering = true;
      this.dreamRunResult = null;
      try {
        const data = await this.request('/v1/dream/run', {
          method: 'POST',
          body: JSON.stringify({ namespace: this.namespace, date: date, force: this.dreamForce, dry_run: dryRun, background: true })
        });
        if (revision !== this.spaceRevision) return;
        this.dreamRunResult = data.data || null;
        if (!dryRun) {
          this.dreamHarvestDate = date;
          if (this.dreamRunResult && this.dreamRunResult.run_id) {
            this.notify(this.L('已排队，任务 ', 'Queued: run ') + this.dreamRunResult.run_id);
          }
          await this.loadDreamStatus();
        }
      } catch (error) {
        if (revision !== this.spaceRevision) return;
        this.notify(error.message);
        if (!dryRun) await this.loadDreamStatus();
      }
      this.dreamTriggering = false;
      this.icons();
    },
    dreamLatestRun() {
      return this.dreamRuns.length ? this.dreamRuns[0] : null;
    },
    dreamLatestLabel() {
      const run = this.dreamLatestRun();
      return run ? this.dreamStatusLabel(run.status, run.stale) : this.L('还没有记录', 'No runs yet');
    },
    dreamLatestSub() {
      const run = this.dreamLatestRun();
      return run ? this.dayLabel(run.date_label, true) + ' · ' + this.clock(run.started_at) + ' · ' + this.dreamDuration(run) : '';
    },
    dreamOkCount() {
      return this.dreamRuns.filter(function(run) { return run.status === 'ok'; }).length;
    },
    dreamFinishedCount() {
      return this.dreamRuns.filter(function(run) { return run.status === 'ok' || run.status === 'error'; }).length;
    },
    dreamFirstFailed() {
      return this.dreamRuns.find(function(run) { return run.status === 'error' && !run.stale; }) || null;
    },
    dreamSuccessRate() {
      const total = this.dreamFinishedCount();
      if (!total) return '—';
      return Math.round((this.dreamOkCount() / total) * 100) + '%';
    },
    dreamProcessedTotal() {
      return this.dreamRuns.reduce(function(sum, run) { return sum + (Number(run.processed_messages) || 0); }, 0);
    },
    dreamAnchorLabel() {
      const payload = this.dreamStatus || {};
      if (!payload.anchor_date_label) return '';
      return this.L('锚点 ', 'Anchor ') + payload.anchor_date_label + (payload.time_zone ? ' · ' + payload.time_zone : '');
    },
    dreamDayBars() {
      const payload = this.dreamStatus || {};
      const counts = payload.raw_message_counts || [];
      const cursors = {};
      (payload.cursors || []).forEach(function(item) { cursors[item.date_label] = item.cursor; });
      const max = counts.reduce(function(m, item) { return Math.max(m, Number(item.raw_messages) || 0); }, 0);
      const self = this;
      return counts.map(function(item) {
        const cursor = cursors[item.date_label];
        const done = typeof cursor === 'string' && cursor.indexOf('done:') === 0;
        const raw = Number(item.raw_messages) || 0;
        return {
          date: item.date_label,
          raw: raw,
          done: done,
          pending: raw > 0 && !done,
          widthPct: max > 0 && raw > 0 ? Math.max(Math.round((raw / max) * 100), 4) : 0,
          stateLabel: done ? self.L('已整理', 'Done') : (cursor ? self.L('整理到一半', 'Partly done') : (raw > 0 ? self.L('待整理', 'Pending') : self.L('没有消息', 'No chats')))
        };
      });
    },
    dreamStatusLabel(status, stale) {
      if (stale && (status === 'queued' || status === 'running')) return this.L('可能中断 / 状态未确认', 'May have stopped / unconfirmed');
      const zh = { ok: '完成', error: '失败', skipped: '跳过', queued: '排队中', running: '进行中' };
      const en = { ok: 'Done', error: 'Failed', skipped: 'Skipped', queued: 'Queued', running: 'Running' };
      return (this.lang === 'en' ? en : zh)[status] || status || this.L('未知', 'Unknown');
    },
    dreamStatusChipClass(status) {
      return { ok: 'chip-ok', error: 'chip-err', skipped: 'chip-dim', queued: 'chip-warn', running: 'chip-warn' }[status] || 'chip-dim';
    },
    dreamRailClass(status) {
      return { ok: 'rail-ok', error: 'rail-err', skipped: 'rail-dim', running: 'rail-run', queued: 'rail-run', stale: 'rail-run' }[status] || 'rail-dim';
    },
    dreamTriggerLabel(trigger) {
      const zh = { cron: '自动', manual: '手动' };
      const en = { cron: 'Scheduled', manual: 'Manual' };
      return (this.lang === 'en' ? en : zh)[trigger] || trigger || '—';
    },
    dreamDuration(run) {
      if (run.stale) return this.L('状态未确认', 'Unconfirmed');
      if (!run.finished_at) return run.status === 'running' ? this.L('进行中', 'Running') : (run.status === 'queued' ? this.L('等待中', 'Waiting') : '—');
      const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
      if (!Number.isFinite(ms) || ms < 0) return '—';
      const sec = Math.round(ms / 1000);
      if (sec < 60) return sec + 's';
      return Math.floor(sec / 60) + 'm' + String(sec % 60).padStart(2, '0') + 's';
    },
    dreamReasonLabel(reason) {
      if (reason === 'inbox_claimed') return this.L('这批消息正由另一个整理任务处理，可稍后补跑', 'Another Dream task has claimed this batch. Try again later.');
      const zh = {
        already_done: '这一晚已经整理过了',
        no_messages: '没有新消息',
        dry_run: '只是预览',
        dream_disabled: '夜间整理没开',
        model_error: '模型出错',
        model_timeout: '模型请求超时',
        model_invalid_json: '模型返回格式不合要求',
        extract_model_error: '抽取模型出错',
        extract_model_timeout: '抽取模型请求超时',
        extract_invalid_json: '抽取结果格式不合要求',
        run_failed: '整理异常退出，请先核查是否部分落库',
        enqueue_failed: '任务未确认入队',
        marked_interrupted: '已核查并标记为中断',
        execution_failed: '后台任务异常退出',
        v2_disabled: 'v2 未启用'
      };
      const en = {
        already_done: 'This night was already processed',
        no_messages: 'No new messages',
        dry_run: 'Preview only',
        dream_disabled: 'The nightly run is off',
        model_error: 'Model error',
        model_timeout: 'Model request timed out',
        model_invalid_json: 'The model returned an invalid format',
        extract_model_error: 'Extraction model error',
        extract_model_timeout: 'Extraction model timed out',
        extract_invalid_json: 'Extraction returned an invalid format',
        run_failed: 'The run stopped unexpectedly; check whether some memories were saved first',
        enqueue_failed: 'Couldn’t confirm the run was queued',
        marked_interrupted: 'Checked and marked as stopped',
        execution_failed: 'The background job stopped unexpectedly',
        v2_disabled: 'v2 is not enabled'
      };
      return (this.lang === 'en' ? en : zh)[reason] || reason || this.L('原因未知', 'Unknown reason');
    },
    dreamRunNote(run) {
      const parts = [];
      if (run.stale) parts.push(this.L('超过 20 分钟未确认完成，可能中断；不会自动重跑', 'Not confirmed done after 20 minutes; it may have stopped and won’t re-run on its own'));
      if (run.reason) parts.push(this.dreamReasonLabel(run.reason));
      if (run.error) {
        let text = run.error;
        try {
          const parsed = JSON.parse(run.error);
          if (Array.isArray(parsed)) {
            text = this.L(parsed.length + ' 条落库出错：', parsed.length + ' failed to save: ') + parsed.map(function(item) {
              return (item.target_id || '?') + '（' + (item.reason || '?') + '）';
            }).join(this.L('；', '; '));
          }
        } catch (error) {}
        parts.push(text);
      }
      return parts.join(' · ');
    },
    isDreamExpanded(id) {
      return Boolean(this.dreamExpanded[id]);
    },
    toggleDreamExpand(id) {
      const next = Object.assign({}, this.dreamExpanded);
      if (next[id]) delete next[id];
      else next[id] = true;
      this.dreamExpanded = next;
    },
    dreamProposal() {
      return this.dreamRunResult && this.dreamRunResult.proposal ? this.dreamRunResult.proposal : null;
    },
    dreamProposalList(key) {
      const proposal = this.dreamProposal();
      return proposal && Array.isArray(proposal[key]) ? proposal[key] : [];
    },
    dreamExtracted() {
      return this.dreamRunResult && Array.isArray(this.dreamRunResult.extracted_memories) ? this.dreamRunResult.extracted_memories : [];
    },
    dreamRoutingGroups() {
      const plan = this.dreamRunResult && this.dreamRunResult.routing_plan;
      const items = plan && Array.isArray(plan.items) ? plan.items : [];
      const groups = {};
      const order = [];
      const self = this;
      items.forEach(function(item) {
        const dest = item.destination || 'candidate';
        if (!groups[dest]) {
          groups[dest] = { key: dest, label: dest === 'world_fact_direct' ? self.L('直达世界知识', 'Straight to world facts') : self.L('进待审', 'To Review'), items: [] };
          order.push(dest);
        }
        groups[dest].items.push(item);
      });
      return order.map(function(key) { return groups[key]; });
    },
    dreamRoutingKindLabel(kind) {
      const zh = { extract: '抽取', add: '新增', update: '更新', delete: '归档' };
      const en = { extract: 'Extract', add: 'Add', update: 'Update', delete: 'Archive' };
      return (this.lang === 'en' ? en : zh)[kind] || kind || '—';
    },
    dreamRunStatsLine() {
      const stats = this.dreamRunResult && this.dreamRunResult.result && this.dreamRunResult.result.stats;
      if (!stats) return '';
      return this.L('处理消息 ', 'Messages ') + (stats.processedMessages || 0)
        + this.L(' · 新增 ', ' · added ') + (stats.addedMemories || 0)
        + this.L(' · 更新 ', ' · updated ') + (stats.updatedMemories || 0)
        + this.L(' · 归档 ', ' · archived ') + (stats.deletedMemories || 0)
        + this.L(' · 进待审 ', ' · to Review ') + (stats.queuedCandidates || 0);
    },
    dreamHarvestCreated() {
      return (this.dreamHarvest && this.dreamHarvest.created) || [];
    },
    dreamHarvestDormant() {
      return (this.dreamHarvest && this.dreamHarvest.dormant) || [];
    },
    dreamHarvestCandidates() {
      return (this.dreamHarvest && this.dreamHarvest.candidates) || [];
    },
    dreamDormantLabel(status) {
      if (status === 'superseded') return this.L('被新的接替', 'Replaced');
      if (status === 'archived') return this.L('归档', 'Archived');
      return status || '—';
    },
    dreamCandidateStatusLabel(status) {
      if (status === 'approved') return this.L('记住了', 'Remembered');
      if (status === 'discarded') return this.L('没记', 'Skipped');
      return status || '—';
    },
    dreamCandidateSourceLabel(source) {
      const zh = { dream_add: '新增提案', dream_update: '更新提案', dream_delete: '移除提案', extract: '抽取', zone_full: '区满' };
      const en = { dream_add: 'Proposed add', dream_update: 'Proposed update', dream_delete: 'Proposed removal', extract: 'Extracted', zone_full: 'Zone full' };
      return (this.lang === 'en' ? en : zh)[source] || source || '—';
    },
    pct(value) {
      return Math.round(Number(value || 0) * 100) + '%';
    },
    fmt(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString(this.locale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    },
    jsonList(value) {
      if (Array.isArray(value)) return value;
      try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        return [];
      }
    },
    get memoryTypes() {
      // 固定分类：全部 + 8 个 canonical 类型。类型在写入层已被 clampMemoryType
      // 收敛，面板不再派生自由类型 tab。全部 用于排查历史脏数据。
      return ['all'].concat(this.canonicalMemoryTypes);
    },
    memoryTypeLabel(type) {
      return type === 'all' ? this.L('全部', 'All') : this.typeLabel(type);
    },
    typeCount(type) {
      const rows = this.stats.memory_type_counts || [];
      if (type === 'all') {
        return rows.reduce(function(sum, row) { return sum + Number(row.count || 0); }, 0);
      }
      const hit = rows.find(function(row) { return row.type === type; });
      return hit ? hit.count : 0;
    },
    typeLimit(type) {
      if (type === 'all') {
        return Object.keys(this.limits).reduce(function(sum, key) { return sum + this.limits[key]; }.bind(this), 0);
      }
      return this.limits[type] || 100;
    },
    capacityUsed() {
      return this.typeCount('all');
    },
    capacityTotal() {
      return this.typeLimit('all');
    },
    capacityPercent() {
      const total = this.capacityTotal();
      return total ? Math.min(100, Math.round(this.capacityUsed() / total * 100)) : 0;
    },
    capacityLabel() {
      return this.capacityUsed() + '/' + this.capacityTotal();
    },`;
