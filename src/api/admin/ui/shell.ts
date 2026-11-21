import { I, navLink, t } from "./helpers";
import { chatParseBrowserScript } from "../../../memory/transfer/chatParse";

const CHAT_PARSE_SCRIPT = chatParseBrowserScript();

export const ADMIN_HEAD = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Aelios</title>
<script>
// 先定好语言和明暗，免得页面先闪一下另一套。没选过语言就看浏览器：中文浏览器用中文，其余用英文。
(function() {
  var root = document.documentElement;
  var lang = null, theme = null;
  try { lang = localStorage.getItem('aelios.admin.lang'); theme = localStorage.getItem('aelios.admin.colorMode'); } catch (error) {}
  if (lang !== 'zh' && lang !== 'en') {
    var browser = navigator.language || '';
    lang = browser && !/^zh/i.test(browser) ? 'en' : 'zh';
  }
  root.dataset.lang = lang;
  root.lang = lang === 'en' ? 'en' : 'zh-CN';
  root.dataset.theme = theme === 'dark' ? 'dark' : 'light';
})();
</script>
<script src="https://cdn.tailwindcss.com"></script>
<script>
// Tailwind 只用来排版；它自带的重置会盖掉下面按钮、输入框的颜色，关掉，用这里自己的一小段重置。
tailwind.config = { corePlugins: { preflight: false } };
</script>
<script defer src="https://unpkg.com/alpinejs@3.x.x/dist/cdn.min.js"></script>`;

export const ADMIN_BODY_START = `<body>
<div class="sky" aria-hidden="true"><span class="l a"></span><span class="l b"></span><span class="l c"></span><span class="shoot s1"></span><span class="shoot s2"></span></div>
<div x-data="memoryAdmin()" x-init="init()" x-cloak class="app" @keydown.escape.window="navOpen = false">
  <div x-show="navOpen" x-transition.opacity.duration.150ms class="side-scrim" @click="navOpen = false"></div>
  <aside class="side" :class="navOpen ? 'is-open' : ''" :aria-label="L('主导航', 'Main navigation')">
    <div class="brand"><span class="logo" aria-hidden="true">A</span><span>Aelios</span></div>

    <button type="button" @click="spaceOpen = true; navOpen = false" class="viewing" :aria-label="L('切换查看的记忆空间', 'Switch the memory space you are viewing')">
      <span class="min-w-0 flex-1">
        <span class="block text-[11px] muted">${t("正在查看", "Viewing")}</span>
        <span class="block truncate text-sm font-semibold" :style="identityLoadError || emptySpaceHint() ? 'color: var(--ct)' : ''" x-text="viewingLabel()"></span>
      </span>
      <span class="muted">${I.updown}</span>
    </button>

    <nav class="flex flex-col gap-4">
      <div class="flex flex-col gap-0.5">
        <div class="nav-title">${t("日常", "Daily")}</div>
        ${navLink("today", I.home, "首页", "Home")}
        ${navLink("review", I.inbox, "待审", "Review", `<span x-show="pendingCount" class="badge" x-text="pendingCount"></span>`)}
        ${navLink("diary", I.book, "日记", "Journal")}
      </div>
      <div class="flex flex-col gap-0.5">
        <div class="nav-title">${t("记忆", "Memory")}</div>
        ${navLink("memory", I.db, "记忆库", "Memories")}
        ${navLink("starmap", I.spark, "星图", "Star map", `<span class="muted" :title="L('在新页面打开', 'Opens its own page')">${I.ext}</span>`)}
      </div>
      <div class="flex flex-col gap-0.5">
        <div class="nav-title">${t("后台", "System")}</div>
        ${navLink("dream", I.moon, "夜间整理", "Nightly")}
        ${navLink("transfer", I.swap, "导入导出", "Import &amp; export")}
        ${navLink("settings", I.sliders, "设置", "Settings")}
      </div>
    </nav>

    <div class="mt-auto flex flex-col gap-3">
      <div class="flex min-w-0 items-center gap-2 px-1.5 text-xs muted">
        <span class="dot" :class="connected === true ? 'dot-ok' : connected === false ? 'dot-err' : ''" aria-hidden="true"></span>
        <span class="flex-none" x-text="connected === true ? L('已连接', 'Connected') : connected === false ? L('连不上', 'Can’t connect') : savedApiKey.trim() ? L('连接中…', 'Connecting…') : L('还没连接', 'Not connected')"></span>
        <span class="min-w-0 truncate" x-text="baseHost()"></span>
      </div>
      <div class="flex items-center justify-between gap-2">
        <div class="seg" role="group" :aria-label="L('界面语言', 'Language')">
          <button type="button" @click="setLang('zh')" :class="lang === 'zh' ? 'is-active' : ''" :aria-pressed="lang === 'zh' ? 'true' : 'false'">中文</button>
          <button type="button" @click="setLang('en')" :class="lang === 'en' ? 'is-active' : ''" :aria-pressed="lang === 'en' ? 'true' : 'false'">EN</button>
        </div>
        <button type="button" @click="toggleTheme()" class="btn btn-icon" :aria-label="theme === 'dark' ? L('切换到白天', 'Switch to light') : L('切换到夜间', 'Switch to dark')" :title="theme === 'dark' ? L('切换到白天', 'Switch to light') : L('切换到夜间', 'Switch to dark')">
          <span x-show="theme === 'dark'">${I.sun}</span><span x-show="theme !== 'dark'">${I.moon}</span>
        </button>
      </div>
    </div>
  </aside>

  <main class="main">
    <!-- 手机上只有这一条：左边 ☰ 打开侧边栏（导航只有那一套），右边刷新。 -->
    <header class="topbar">
      <button type="button" @click="navOpen = true" class="btn btn-icon relative" :aria-label="L('打开菜单', 'Open menu')">${I.menu}<span x-show="pendingCount" class="badge" x-text="pendingCount"></span></button>
      <div class="brand min-w-0 flex-1"><span class="logo" aria-hidden="true">A</span><span>Aelios</span></div>
      <button type="button" @click="reloadAll()" class="btn btn-icon" :aria-label="L('刷新', 'Refresh')">${I.refresh}</button>
    </header>

    <div class="wrap">
      <section x-show="!savedApiKey.trim()" class="page">
        <header>
          <h1 class="h1">${t("连接你的 Aelios", "Connect to your Aelios")}</h1>
          <p class="sub">${t("填上 Worker 地址和主钥匙（CHATBOX_API_KEY），只存在这台设备的浏览器里。", "Enter your Worker address and main key (CHATBOX_API_KEY). They’re saved only in this browser.")}</p>
        </header>
        <div class="panel panel-pad grid max-w-xl gap-4">
          <label class="block"><span class="label">${t("Worker 地址", "Worker address")}</span>
            <input x-model="workerUrl" @change="savePrefs()" class="field" placeholder="https://…workers.dev">
          </label>
          <label class="block"><span class="label">Token</span>
            <input x-model="apiKey" @keydown.enter.prevent="saveToken()" type="password" class="field" autocomplete="current-password" placeholder="sk-…">
          </label>
          <div><button type="button" @click="saveToken()" :disabled="!apiKey.trim()" class="btn btn-primary">${t("连接", "Connect")}</button></div>
        </div>
      </section>
`;

export const ADMIN_OVERLAYS = `  <!-- 在页面外层：放在卡片里的话，毛玻璃会把 fixed 困在卡片里、被后面的卡片盖住。 -->
  <div x-show="chatgpt.welcomeOpen" class="modal grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="You're using your ChatGPT plan">
    <div class="modal-scrim"></div>
    <div class="panel relative w-full max-w-sm p-5" style="background: var(--solid)">
      <h3 class="h2">You’re using your ChatGPT plan</h3>
      <p class="mt-2 text-[13px] leading-6 muted">${t("符合条件的请求会用你的 ChatGPT 套餐额度，计入套餐的用量限制。可以在 ChatGPT 设置的 Usage 里管理，或给 Aelios 设每周上限。", "Eligible requests use your ChatGPT plan and count toward its limits. Manage this under Usage in ChatGPT settings, or set a weekly cap for Aelios.")} <a href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noopener">Manage usage</a></p>
      <button type="button" @click="chatgptWelcomed()" class="btn btn-primary mt-4 w-full">Got it</button>
    </div>
  </div>

  <div x-show="spaceOpen" x-transition.opacity.duration.150ms @keydown.escape.window="spaceOpen = false" class="modal">
    <div class="modal-scrim" @click="spaceOpen = false"></div>
    <section role="dialog" aria-modal="true" :aria-label="L('切换查看的记忆空间', 'Switch the memory space you are viewing')" class="sheet">
      <div class="mb-4 flex items-center justify-between gap-3">
        <h2 class="h2">${t("正在查看谁的记忆", "Whose memories you’re viewing")}</h2>
        <button type="button" @click="spaceOpen = false" class="btn btn-icon btn-sm btn-icon-sm" :aria-label="L('关闭', 'Close')">${I.x}</button>
      </div>
      <div class="grid gap-3">
        <label class="block"><span class="label">${t("助手", "Assistant")}</span>
          <select x-model="selectedIdentity" @change="selectIdentity($event.target.value)" class="field">
            <option value="" x-text="L('自选空间（高级）', 'Pick a space (advanced)')"></option>
            <template x-for="idn in memoryIdentities" :key="idn.slug"><option :value="idn.slug" x-text="idn.slug"></option></template>
          </select>
        </label>
        <label class="block"><span class="label">${t("记忆空间", "Memory space")}</span>
          <select x-model="namespace" @change="pickSpace($event.target.value)" class="field">
            <template x-for="space in pickerSpaces()" :key="space.name"><option :value="space.name" x-text="space.label"></option></template>
          </select>
        </label>
      </div>
      <div x-show="emptySpaceHint()" class="banner banner-warn mt-3">
        <span class="min-w-0 flex-1" x-text="emptySpaceHint() && emptySpaceHint().text"></span>
        <button type="button" @click="pickSpace(emptySpaceHint().space)" class="btn btn-sm" x-text="emptySpaceHint() && (L('看 ', 'View ') + emptySpaceHint().space)"></button>
      </div>
      <p class="mt-3 text-[13px] leading-6" style="color: var(--t2)" x-text="spaceDescription()"></p>
      <p class="text-xs leading-6 muted">${t("这里只换查看的记忆；聊天时用哪位助手，由接入地址和钥匙决定。", "This only changes what you’re viewing; which assistant a chat uses depends on its address and key.")}</p>
      <div x-show="selectedIdentity" class="mt-4 grid gap-3 rounded-[12px] p-3.5" style="background: var(--soft)">
        <div>
          <p class="text-sm font-semibold">${t("说话人名字", "Speaker names")}</p>
          <p class="mt-0.5 text-xs muted">${t("夜间整理、日记、审核写记忆时只用这两个名字，不写「用户 / 助手」。", "The nightly run, journal and review use these names instead of “user” and “assistant”.")}</p>
        </div>
        <div class="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label class="block"><span class="label">${t("用户叫什么", "User’s name")}</span><input x-model="speakerUserName" class="field" :placeholder="L('如 小南', 'e.g. Sam')"></label>
          <label class="block"><span class="label">${t("助手叫什么", "Assistant’s name")}</span><input x-model="speakerAssistantName" class="field" :placeholder="L('如 小北；留空用路径名', 'e.g. Robin; blank uses the path')"></label>
          <button type="button" @click="saveSpeakers()" :disabled="speakerBusy" class="btn btn-primary" x-text="L('保存名字', 'Save names')"></button>
        </div>
      </div>
      <p x-show="identityLoadError" x-text="identityLoadError" class="banner banner-warn mt-3"></p>
      <details class="mt-3" :open="!selectedIdentity">
        <summary class="text-xs muted">${t("高级：手动填空间名", "Advanced: type a space name")}</summary>
        <label class="mt-2 block"><span class="label">${t("空间名", "Space name")}</span>
          <input :value="namespace" @change="selectCustomSpace($event.target.value)" class="field" placeholder="default">
        </label>
      </details>
    </section>
  </div>

</div>

<script>
${CHAT_PARSE_SCRIPT}
</script>`;
