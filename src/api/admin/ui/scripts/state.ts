export const ADMIN_SCRIPT_STATE = String.raw`<script>
function memoryAdmin() {
  // 设置一项项排队存，连点两个开关也不会互相盖掉。放在外面，不进 Alpine 的响应式。
  let settingsQueue = Promise.resolve();
  // 导入聊天记录时读出来的整份消息和切好的段，可能上万条，放在外面不进响应式，页面上只显示数。
  let chatParsed = null;
  let chatChunks = [];
  return {
    // 记忆库里「重要」后面的几栏。
    moreNav: [
      { id: 'precious', label: '珍贵', labelEn: 'Keepsakes' },
      { id: 'glossary', label: '黑话', labelEn: 'Our words' },
      { id: 'notebook', label: '小本本', labelEn: 'Notebook' },
      { id: 'handoff', label: '交接信', labelEn: 'Handoff' },
      { id: 'world', label: '世界知识', labelEn: 'World facts' }
    ],
    canonicalMemoryTypes: ['fact', 'event', 'preference', 'relationship', 'boundary', 'habit', 'decision', 'note'],
    limits: { fact: 120, event: 80, preference: 80, relationship: 80, boundary: 80, habit: 80, decision: 80, note: 120 },
    gwKeyOptions: [
      { id: 'CHATBOX_API_KEY', label: '主钥匙', labelEn: 'Main key' },
      { id: 'IM_API_KEY', label: '第二把', labelEn: 'Second key' },
      { id: 'DEBUG_API_KEY', label: '维护', labelEn: 'Maintenance' },
      { id: 'GUIDE_DOG_API_KEY', label: '导盲犬', labelEn: 'Guide dog' }
    ],
    // 没选过语言就看浏览器：中文浏览器用中文，其余用英文。跟 head 里那段一样。
    lang: (function() {
      const saved = localStorage.getItem('aelios.admin.lang');
      if (saved === 'zh' || saved === 'en') return saved;
      const browser = typeof navigator !== 'undefined' && navigator.language ? navigator.language : '';
      return browser && !/^zh/i.test(browser) ? 'en' : 'zh';
    })(),
    navOpen: false,
    connected: null,
    gwAddress: '',
    gwIdentities: [],
    gwSpaces: [],
    gwGroups: [],
    gwSecrets: [],
    gwBusy: false,
    gwError: '',
    gwQuery: '',
    gwOpen: {},
    gwSnapshot: '',
    hintsOpen: {},
    tokenEditing: false,
    recallHistory: [],
    recallHistoryLoading: false,
    recallHistoryError: '',
    recallHistoryRevision: 0,
    memoryIdentities: [],
    selectedIdentity: localStorage.getItem('aelios.admin.identity') || '',
    identityPreferenceReady: localStorage.getItem('aelios.admin.identity') !== null,
    identityLoadError: '',
    speakerUserName: '',
    speakerAssistantName: '',
    speakerBusy: false,
    spaceRevision: 0,
    page: 'today',
    moreView: 'important',
    workerUrl: localStorage.getItem('aelios.admin.workerUrl') || location.origin,
    apiKey: localStorage.getItem('aelios.admin.apiKey') || '',
    savedApiKey: localStorage.getItem('aelios.admin.apiKey') || '',
    namespace: localStorage.getItem('aelios.admin.namespace') || 'default',
    theme: localStorage.getItem('aelios.admin.colorMode') === 'dark' ? 'dark' : 'light',
    boot: {},
    stats: {},

    todayMessages: [],
    homeRole: 'all',
    homeAll: false,
    home: { diary: null, run: null, harvest: null },
    candidates: [],
    judgeDecisions: [],
    reviewHelp: false,
    reviewType: 'all',
    reviewSelected: {},
    reviewBulkBusy: false,
    reviewBulkLabel: '',
    spaceOpen: false,
    autoReview: null,
    memories: [],
    memoryQuery: '',
    precious: [],
    glossary: [],
    handoffNote: { content: null, revision: 0, source: '', updated_at: null },
    handoffDraft: '',
    handoffGuide: '',
    handoffLoaded: false,
    handoffBusy: false,
    notebookPages: [],
    notebookDraft: null,
    notebookLoaded: false,

    diaryDailies: [],
    diaryRewriting: '',
    diaryWeeklies: [],
    diaryMonthlies: [],
    diaryExpanded: {},
    diaryMode: 'daily',
    diaryPick: '',
    diaryReading: false,

    worldItems: [],
    worldSelection: {},
    worldQuery: '',
    memoryType: 'all',
    memoryCreateOpen: false,
    memoryDraft: { type: 'fact', content: '', fact_key: '', importance: 0.7, confidence: 0.85 },
    glossaryDraft: { term: '', definition: '', aliasesText: '' },
    debugOutput: '',
    toast: '',
    saving: false,

    dreamStatus: null,
    dreamRuns: [],
    dreamActiveRun: null,
    dreamPollTimer: null,
    dreamStatusError: '',
    dreamResolving: false,
    dreamLoading: false,
    dreamTriggering: false,
    dreamDate: '',
    dreamForce: false,
    dreamDryRun: true,
    dreamRunResult: null,
    dreamHarvestDate: '',
    dreamHarvest: null,
    dreamHarvestLoading: false,
    dreamExpanded: {},
    harvestOpen: { new: true, dim: true, judged: false },

    reviewTab: 'daily',
    importReview: { batches: [], importId: '', filter: 'all', items: [], counts: { pending: 0, clef_yes: 0, clef_no: 0 }, offset: 0, more: false, loading: false, bulk: null },
    transferMode: 'chat',
    transfer: { info: null, exporting: false, entriesText: '', entriesName: '', preview: null, entriesMode: 'direct', entriesBusy: false, entriesRun: null, chat: null, chatLoading: false, chatMode: 'memory', chatClef: true, chatRun: null, batches: [] },

    // ===== 中英两套文字 =====
    L(zh, en) {
      return this.lang === 'en' ? en : zh;
    },
    locale() {
      return this.lang === 'en' ? 'en-US' : 'zh-CN';
    },
    setLang(lang) {
      this.lang = lang === 'en' ? 'en' : 'zh';
      localStorage.setItem('aelios.admin.lang', this.lang);
      this.applyLang();
    },
    applyLang() {
      const root = document.documentElement;
      root.dataset.lang = this.lang;
      root.lang = this.lang === 'en' ? 'en' : 'zh-CN';
    },
    // 设置项的名字和说明：英文界面用 labelEn / hintEn，没有就退回中文。
    sLabel(item) {
      return this.lang === 'en' && item.labelEn ? item.labelEn : item.label;
    },
    sHint(item) {
      return this.lang === 'en' && item.hintEn ? item.hintEn : (item.hint || '');
    },
    gLabel(section) {
      return this.lang === 'en' && section.groupEn ? section.groupEn : section.group;
    },
    toggleHint(name) {
      const next = Object.assign({}, this.hintsOpen);
      if (next[name]) delete next[name];
      else next[name] = true;
      this.hintsOpen = next;
    },
    hintOpen(name) {
      return Boolean(this.hintsOpen[name]);
    },
    typeLabel(type) {
      const zh = { fact: '事实', event: '事件', preference: '偏好', relationship: '关系', boundary: '边界', habit: '习惯', decision: '决定', note: '备注', world_fact: '世界知识' };
      const en = { fact: 'Fact', event: 'Event', preference: 'Preference', relationship: 'Relationship', boundary: 'Boundary', habit: 'Habit', decision: 'Decision', note: 'Note', world_fact: 'World fact' };
      return (this.lang === 'en' ? en : zh)[type] || type || '—';
    },
    typeChipClass(type) {
      return this.canonicalMemoryTypes.indexOf(type) >= 0 ? 't-' + type : 'chip-dim';
    },
    importanceLabel(value) {
      const n = Number(value);
      if (value == null || !Number.isFinite(n)) return '—';
      if (n >= 0.75) return this.L('高', 'High');
      if (n >= 0.45) return this.L('中', 'Medium');
      return this.L('低', 'Low');
    },
    parseDay(label) {
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(label || '');
      return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
    },
    // 2026-10-26 → 10月26日 周一 / Mon, Oct 26；short 不带星期。
    dayLabel(label, short) {
      const date = this.parseDay(label);
      if (!date) return label || '';
      if (this.lang === 'en') return date.toLocaleDateString('en-US', short ? { month: 'short', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' });
      const head = (date.getMonth() + 1) + '月' + date.getDate() + '日';
      return short ? head : head + ' ' + ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
    },
    // 2026-08 → 2026年8月 / August 2026
    monthLabel(label) {
      const match = /^(\d{4})-(\d{2})$/.exec(label || '');
      if (!match) return label || '';
      if (this.lang === 'en') return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
      return match[1] + '年' + Number(match[2]) + '月';
    },
    longDayLabel(label) {
      const date = this.parseDay(label);
      if (!date) return label || '';
      return date.toLocaleDateString(this.locale(), { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    },
    todayLabel() {
      return new Date().toLocaleDateString(this.locale(), { month: 'long', day: 'numeric', weekday: 'long' });
    },
    shortDate(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return this.lang === 'en'
        ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : (date.getMonth() + 1) + '月' + date.getDate() + '日';
    },
    clock(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    },
    paragraphs(text) {
      return String(text || '').split(/\n+/).map(function(part) { return part.trim(); }).filter(Boolean);
    },
    excerpt(text) {
      const flat = String(text || '').replace(/\s+/g, ' ').trim();
      return flat.length > 40 ? flat.slice(0, 40) + '…' : flat;
    },
    roleName(role) {
      const idn = this.currentIdentity();
      if (role === 'user') return (idn && (idn.userName || '').trim()) || this.L('你', 'You');
      if (role === 'assistant') return (idn && (idn.assistantName || '').trim()) || this.L('助手', 'Assistant');
      return role || '—';
    },
    baseHost() {
      try { return new URL(this.base()).host; } catch (error) { return this.base(); }
    },

    // 模型清单：只决定 /v1/models 显示什么，不限制能调用什么。改一下存一下，跟设置项一样走同一条队列。
    modelList: { items: [], loaded: false, busy: false, error: '', typed: '', catalog: [], catalogLoaded: false, catalogLoading: false, catalogReason: '', query: '', pickerOpen: false, shown: [], total: 0, checks: {} },
    providersSummary() {
      var list = this.modelList;
      return 'ChatGPT ' + this.chatgptChipText() + ' · ' + this.L('模型清单 ', 'Model list ') + (!list.loaded ? this.L('读取中', 'loading') : list.items.length ? this.L('显示 ' + list.items.length + ' 个', list.items.length + ' shown') : this.L('显示全部', 'showing all'));
    },
    // 连通性：对清单里的一个模型发一条很短的真请求，走和聊天客户端同一条线路。通了变小绿点，没通显示上游的原话。
    modelListState(id) { return (this.modelList.checks[id] || {}).state || ''; },
    modelListCheckTitle(id) {
      var check = this.modelList.checks[id] || {};
      if (check.state === 'ok') return this.L('通了 · ' + check.ms + ' 毫秒，再点一下重新测', 'Works · ' + check.ms + ' ms. Click to test again');
      if (check.state === 'testing') return this.L('测试中…', 'Testing…');
      if (check.state === 'fail') return this.L('没通，点一下重试', 'Failed. Click to retry');
      return this.L('测试连通性（会发一条很短的请求）', 'Test it (sends one tiny request)');
    },
    async modelListCheck(id) {
      if (this.modelListState(id) === 'testing') return;
      this.modelList.checks[id] = { state: 'testing' };
      try {
        var result = await this.request('/api/gateway/models/test', { method: 'POST', body: JSON.stringify({ model: id }) });
        this.modelList.checks[id] = result.ok
          ? { state: 'ok', ms: result.latency_ms }
          : { state: 'fail', error: (result.status ? result.status + ' · ' : '') + (result.error || this.L('没通', 'failed')) };
      } catch (error) {
        this.modelList.checks[id] = { state: 'fail', error: error.message };
      }
    },
    modelListSearch() {
      var list = this.modelList;
      var query = list.query.trim().toLowerCase();
      var taken = list.items;
      var hits = list.catalog.filter(function(id) { return taken.indexOf(id) < 0 && (!query || id.toLowerCase().indexOf(query) >= 0); });
      list.total = hits.length;
      list.shown = hits.slice(0, 60);
    },
    async modelListTogglePicker() {
      var list = this.modelList;
      list.pickerOpen = !list.pickerOpen;
      if (!list.pickerOpen || list.catalogLoaded) return;
      list.catalogLoading = true;
      list.error = '';
      try {
        var data = await this.request('/api/gateway/models');
        list.catalog = (data.chatgpt || []).concat(data.models || []);
        list.catalogReason = data.reason || '';
        list.catalogLoaded = true;
      } catch (error) {
        list.error = this.L('目录读取失败：', 'Couldn’t read the catalog: ') + error.message;
      }
      list.catalogLoading = false;
      this.modelListSearch();
    },
    async modelListAddTyped() {
      var names = this.modelList.typed.split(/[\s,，;；]+/).filter(Boolean);
      if (!names.length) return;
      await this.modelListAdd(names);
      if (!this.modelList.error) this.modelList.typed = '';
    },
    modelListAdd(names) {
      var next = this.modelList.items.slice();
      names.forEach(function(name) { if (next.indexOf(name) < 0) next.push(name); });
      return this.modelListSave(next);
    },
    modelListRemove(id) {
      return this.modelListSave(this.modelList.items.filter(function(item) { return item !== id; }));
    },
    modelListClear() {
      if (!window.confirm(this.L('清空清单？客户端会改回显示上游目录里的全部模型。清单外的模型本来就能调用，不受影响。', 'Clear the list? Your app will show the whole upstream catalog again. Models off the list could always be called, so nothing else changes.'))) return;
      return this.modelListSave([]);
    },
    modelListSave(next) {
      var list = this.modelList;
      var self = this;
      if (JSON.stringify(next) === JSON.stringify(list.items)) return Promise.resolve();
      list.busy = true;
      list.error = '';
      var task = async function() {
        try {
          var result = await self.request('/api/gateway/config', { method: 'PATCH', body: JSON.stringify({ modelList: next }) });
          list.items = result.modelList || [];
          Object.keys(list.checks).forEach(function(name) { if (list.items.indexOf(name) < 0) delete list.checks[name]; });
          self.notify(list.items.length ? self.L('清单存好了，现在显示 ' + list.items.length + ' 个模型', 'List saved. ' + list.items.length + ' models shown') : self.L('清单已清空，改回显示全部', 'List cleared. Showing all models'));
        } catch (error) {
          list.error = self.L('没存上：', 'Not saved: ') + error.message;
        }
        list.busy = false;
        self.modelListSearch();
      };
      var run = settingsQueue.then(task, task);
      settingsQueue = run.catch(function() {});
      return run;
    },
    chatgpt: { status: null, loaded: false, busy: false, testing: false, error: '', authorizeUrl: '', pasted: '', test: null, welcomeOpen: false },
    chatgptChipText() {
      var status = this.chatgpt.status;
      if (!status) return this.chatgpt.error ? this.L('读取失败', 'Couldn’t load') : this.chatgpt.loaded ? '—' : this.L('未读取', 'Not loaded');
      var zh = { connected: '已连接', plan_disabled: '套餐未开通', needs_login: '需重新登录', disconnected: '未连接' };
      var en = { connected: 'Signed in', plan_disabled: 'Plan not allowed', needs_login: 'Sign in again', disconnected: 'Not connected' };
      return (this.lang === 'en' ? en : zh)[status.status] || status.status;
    },
    chatgptChipClass() {
      var status = this.chatgpt.status && this.chatgpt.status.status;
      return status === 'connected' ? 'chip-ok' : status === 'plan_disabled' ? 'chip-warn' : status === 'needs_login' ? 'chip-err' : '';
    },
    async chatgptLoad() {
      if (!this.savedApiKey.trim()) return;
      try {
        this.chatgpt.status = await this.request('/api/gateway/chatgpt/status');
        this.chatgpt.error = '';
        if (this.chatgpt.status.welcome) this.chatgpt.welcomeOpen = true;
      } catch (error) {
        this.chatgpt.error = error.message;
      }
      this.chatgpt.loaded = true;
    },
    // options: {} 首次或同一个账号；{ reconsent: true } 重新授权套餐；{ account: 'new' } 换账号。
    async chatgptLogin(options) {
      this.chatgpt.busy = true;
      this.chatgpt.error = '';
      try {
        var started = await this.request('/api/gateway/chatgpt/login', { method: 'POST', body: JSON.stringify(options || {}) });
        this.chatgpt.authorizeUrl = started.authorize_url;
        this.chatgpt.pasted = '';
        window.open(started.authorize_url, '_blank', 'noopener');
      } catch (error) {
        this.chatgpt.error = error.message;
      }
      this.chatgpt.busy = false;
    },
    async chatgptFinish() {
      var pasted = this.chatgpt.pasted.trim();
      if (!pasted) {
        this.chatgpt.error = this.L('先把浏览器地址栏里的完整地址粘贴进来', 'Paste the full address from your browser’s address bar first');
        return;
      }
      this.chatgpt.busy = true;
      this.chatgpt.error = '';
      try {
        await this.request('/api/gateway/chatgpt/callback', { method: 'POST', body: JSON.stringify({ url: pasted }) });
        this.chatgpt.authorizeUrl = '';
        this.chatgpt.pasted = '';
        this.chatgpt.test = null;
        this.notify(this.L('ChatGPT 已连接', 'ChatGPT connected'));
        await this.chatgptLoad();
      } catch (error) {
        this.chatgpt.error = error.message;
      }
      this.chatgpt.busy = false;
    },
    async chatgptTest() {
      this.chatgpt.busy = true;
      this.chatgpt.testing = true;
      this.chatgpt.error = '';
      try {
        this.chatgpt.test = await this.request('/api/gateway/chatgpt/test', { method: 'POST', body: '{}' });
      } catch (error) {
        this.chatgpt.error = error.message;
      }
      this.chatgpt.testing = false;
      this.chatgpt.busy = false;
      await this.chatgptLoad();
    },
    async chatgptLogout() {
      if (!window.confirm(this.L('退出 ChatGPT 登录？会去 ChatGPT 那边撤销授权，chatgpt/ 开头的模型会停用。', 'Sign out of ChatGPT? This revokes access on ChatGPT’s side, and chatgpt/ models stop working.'))) return;
      this.chatgpt.busy = true;
      this.chatgpt.error = '';
      try {
        var result = await this.request('/api/gateway/chatgpt/logout', { method: 'POST', body: '{}' });
        this.chatgpt.test = null;
        this.chatgpt.authorizeUrl = '';
        this.notify(result.revoked === false ? this.L('已退出；ChatGPT 那边的撤销没确认，可以去 ChatGPT 设置里断开', 'Signed out, but ChatGPT didn’t confirm the revoke. You can disconnect it in ChatGPT settings') : this.L('已退出 ChatGPT', 'Signed out of ChatGPT'));
        await this.chatgptLoad();
      } catch (error) {
        this.chatgpt.error = error.message;
      }
      this.chatgpt.busy = false;
    },
    async chatgptWelcomed() {
      this.chatgpt.welcomeOpen = false;
      try { await this.request('/api/gateway/chatgpt/welcome', { method: 'POST', body: '{}' }); } catch (error) { /* 下次打开再弹一次，不碍事 */ }
    },`;
