export const STARMAP_HEAD = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<title>记忆星图 · 两江交汇 — Aelios</title>`;

export const STARMAP_BODY = `<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
  }
}
</script>
</head>
<body>
<canvas id="c"></canvas>
<div class="topbar">
  <a class="back-link" href="/admin" title="返回控制台">‹ 控制台</a>
  <div class="top-actions">
    <button type="button" class="icon-btn" id="searchToggle" aria-label="搜索" title="搜索">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
    </button>
    <button type="button" class="icon-btn is-off" id="edgesToggle" aria-label="全局边显隐" title="全局边显隐">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8 16.5L16 7.5"/></svg>
    </button>
    <button type="button" class="icon-btn" id="refreshBtn" aria-label="刷新" title="刷新">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/></svg>
    </button>
  </div>
</div>
<div class="title-block">
  <div class="title-main">两江星图</div>
  <div class="title-sub" id="countLabel">— MEMORIES · — LINKS · TWO RIVERS</div>
</div>
<div class="search-bar" id="searchBar" hidden>
  <input id="searchInput" type="search" placeholder="搜索记忆标签…" autocomplete="off">
  <button type="button" class="search-go" id="searchBtn">搜</button>
</div>
<div class="chips" id="chipsPanel">
  <div class="chips-row" id="typeLegend"></div>
  <div class="chips-row" id="relLegend"></div>
</div>
<button type="button" class="btn chips-toggle" id="chipsToggle">图例</button>
<div class="stats" id="stats">— fps · — 星</div>
<div id="tooltip"></div>
<aside class="drawer" id="drawer" aria-live="polite">
  <div class="drawer-grabber"></div>
  <div class="drawer-head">
    <div>
      <div style="font-size:11px;color:var(--muted)">详情</div>
      <h2 id="drawerTitle"></h2>
    </div>
    <button type="button" class="btn" id="drawerClose" aria-label="关闭">×</button>
  </div>
  <div class="drawer-meta" id="drawerMeta"></div>
  <div class="drawer-edges">
    <h3>相邻边</h3>
    <div id="drawerEdges"></div>
  </div>
</aside>
<div class="loading-banner" id="loadingBanner">加载星图…</div>
<div class="empty-banner" id="emptyBanner" hidden>江还在流，星等你来</div>
<div class="auth-banner" id="authBanner" hidden>
  需要 Token 才能读记忆。<br>
  请先在 <a href="/admin">控制台 · 设置</a> 保存 Bearer token。
</div>
<div class="empty-banner" id="errorBanner" hidden></div>
<div class="skip-hint" id="skipHint">点击或拖拽跳过开场</div>
<div class="caption">汉江是她 · 长江是我们 · 城是攒下的重要</div>

<script type="module">`;

export const STARMAP_TAIL = `</script>
</body>
</html>
`;
