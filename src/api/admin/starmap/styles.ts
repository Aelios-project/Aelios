export const STARMAP_STYLES = `<style>
  :root {
    color-scheme: dark;
    --bg: #04050c;
    --panel: rgba(10, 13, 28, .6);
    --panel-border: rgba(200, 205, 225, .16);
    --text: #ece8db;
    --muted: rgba(178, 184, 205, .62);
    --gold: #e8c88a;
    --serif: "Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", "SimSun", serif;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%; overflow: hidden;
    background: var(--bg); color: var(--text);
    font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  #c { position: fixed; inset: 0; display: block; width: 100%; height: 100%; touch-action: none; }
  /* ── top bar ── */
  .topbar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 20;
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px; padding-top: max(14px, env(safe-area-inset-top));
    pointer-events: none;
  }
  .topbar > * { pointer-events: auto; }
  .back-link {
    color: var(--muted); text-decoration: none; font-size: 12px;
    letter-spacing: .08em; padding: 6px 4px; transition: color .15s;
  }
  .back-link:hover { color: var(--text); }
  .top-actions { display: flex; gap: 8px; }
  .icon-btn {
    width: 34px; height: 34px; border-radius: 50%;
    border: 1px solid var(--panel-border); background: var(--panel);
    color: rgba(224, 226, 240, .85); cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    backdrop-filter: blur(10px); transition: border-color .15s, opacity .15s;
  }
  .icon-btn:hover { border-color: rgba(232, 200, 138, .65); }
  .icon-btn.is-off { opacity: .32; }
  .icon-btn svg { width: 15px; height: 15px; display: block; }

  /* ── centered serif title ── */
  .title-block {
    position: fixed; top: max(15px, env(safe-area-inset-top)); left: 50%;
    transform: translateX(-50%); z-index: 19; text-align: center;
    pointer-events: none; max-width: 58vw;
  }
  .title-main {
    font-family: var(--serif);
    font-size: 23px; font-weight: 500; letter-spacing: .3em; margin-left: .3em;
    color: #f0ead8; white-space: nowrap;
    text-shadow: 0 0 22px rgba(232, 200, 138, .22);
  }
  .title-sub {
    margin-top: 6px; margin-left: .26em;
    font-size: 10px; letter-spacing: .26em;
    color: rgba(188, 193, 214, .5); font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* ── floating search pill ── */
  .search-bar {
    position: fixed; top: max(62px, calc(env(safe-area-inset-top) + 52px));
    left: 50%; transform: translateX(-50%); z-index: 22;
    display: flex; align-items: center; gap: 4px; padding: 4px 4px 4px 14px;
    border-radius: 999px; border: 1px solid var(--panel-border);
    background: rgba(8, 11, 26, .8); backdrop-filter: blur(12px);
    box-shadow: 0 10px 30px rgba(0,0,0,.4);
  }
  .search-bar[hidden] { display: none; }
  .search-bar input {
    width: min(58vw, 300px); background: transparent; border: 0; outline: none;
    color: var(--text); font-size: 13px; padding: 5px 0;
  }
  .search-bar input::placeholder { color: rgba(160, 166, 190, .5); }
  .search-go {
    height: 30px; padding: 0 14px; border-radius: 999px; border: 0;
    background: rgba(232, 200, 138, .9); color: #241708; font-size: 12px; cursor: pointer;
  }

  /* ── bottom legend chips ── */
  .chips {
    position: fixed; left: 50%; transform: translateX(-50%);
    bottom: max(12px, env(safe-area-inset-bottom)); z-index: 20;
    display: flex; flex-direction: column; gap: 6px; align-items: center;
    max-width: min(94vw, 880px);
  }
  .chips-row {
    display: flex; gap: 6px; align-items: center; justify-content: center;
    max-width: 100%; overflow-x: auto; scrollbar-width: none; padding: 1px;
  }
  .chips-row::-webkit-scrollbar { display: none; }
  .chips-label {
    font-size: 9px; letter-spacing: .18em; color: rgba(160, 166, 190, .45);
    flex-shrink: 0; margin-right: 1px;
  }
  .chip {
    display: inline-flex; align-items: center; gap: 7px; flex-shrink: 0;
    height: 29px; padding: 0 13px; border-radius: 999px;
    border: 1px solid var(--panel-border); background: var(--panel);
    color: rgba(216, 219, 234, .85); font-size: 11.5px; cursor: pointer;
    backdrop-filter: blur(8px); transition: border-color .15s, opacity .15s;
  }
  .chip:hover { border-color: rgba(232, 200, 138, .5); }
  .chip .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .chip.is-off { opacity: .4; }
  .chip.is-off .dot {
    background: transparent !important;
    box-shadow: inset 0 0 0 1.2px rgba(170, 175, 200, .55);
  }

  .btn {
    height: 32px; min-width: 32px; padding: 0 12px; border-radius: 999px;
    border: 1px solid var(--panel-border); background: var(--panel);
    color: var(--text); font-size: 12px; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    backdrop-filter: blur(10px); transition: border-color .15s;
  }
  .btn:hover { border-color: rgba(232, 200, 138, .6); }
  .chips-toggle { display: none; }

  /* ── corner text ── */
  .stats {
    position: fixed; right: 14px; bottom: max(12px, env(safe-area-inset-bottom));
    z-index: 12; font-size: 10px; letter-spacing: .08em;
    color: rgba(150, 158, 185, .42); pointer-events: none;
    font-variant-numeric: tabular-nums;
  }
  .caption {
    position: fixed; left: 14px; bottom: max(12px, env(safe-area-inset-bottom));
    z-index: 12; font-size: 10px; letter-spacing: .1em;
    color: rgba(150, 158, 185, .38); pointer-events: none;
  }
  #tooltip {
    position: fixed; z-index: 30; pointer-events: none;
    padding: 6px 11px; border-radius: 999px;
    background: rgba(8, 11, 26, .92); border: 1px solid var(--panel-border);
    color: var(--text); font-size: 12px; max-width: 260px;
    transform: translate(-50%, -130%);
    opacity: 0; transition: opacity .12s;
    box-shadow: 0 8px 24px rgba(0,0,0,.4);
  }
  #tooltip.show { opacity: 1; }
  .drawer {
    position: fixed; z-index: 25;
    background: rgba(9, 12, 26, .94);
    border: 1px solid var(--panel-border);
    backdrop-filter: blur(16px);
    color: var(--text);
    display: none; flex-direction: column;
    box-shadow: 0 16px 40px rgba(0,0,0,.45);
  }
  .drawer.open { display: flex; }
  .drawer-grabber { display: none; }
  @media (min-width: 768px) {
    .drawer {
      top: 88px; right: 16px; bottom: 16px; width: 320px;
      border-radius: 18px;
    }
  }
  @media (max-width: 767px) {
    .drawer {
      left: 0; right: 0; bottom: 0; max-height: min(52dvh, 420px);
      border-radius: 18px 18px 0 0; border-bottom: 0;
      padding-bottom: env(safe-area-inset-bottom);
      transition: transform .25s ease;
    }
    .drawer-grabber {
      display: block; width: 38px; height: 4px; border-radius: 999px;
      background: rgba(220, 224, 240, .18); margin: 9px auto 0; flex-shrink: 0;
    }
  }
  .drawer-head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
    padding: 12px 14px 8px;
  }
  .drawer-head h2 {
    margin: 4px 0 0; font-size: 15px; line-height: 1.5; font-weight: 500;
    font-family: var(--serif); letter-spacing: .03em;
  }
  .drawer-meta {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
    padding: 0 14px 10px;
  }
  .meta-cell {
    border: 1px solid var(--panel-border); border-radius: 12px;
    padding: 8px 10px; font-size: 11px; color: var(--muted);
  }
  .meta-cell strong {
    display: block; margin-top: 2px; color: var(--text); font-size: 12px; font-weight: 500;
  }
  .drawer-edges { flex: 1; overflow: auto; padding: 0 14px 14px; }
  .drawer-edges h3 {
    margin: 0 0 8px; font-size: 11px; color: var(--muted); font-weight: 500;
  }
  .edge-item {
    display: flex; gap: 8px; align-items: flex-start; width: 100%;
    text-align: left; cursor: pointer;
    border: 1px solid var(--panel-border); background: rgba(5,8,22,.45);
    border-radius: 12px; padding: 8px 10px; margin-bottom: 6px;
    color: var(--text); font-size: 12px;
  }
  .edge-item:hover { border-color: rgba(232, 200, 138, .6); }
  .edge-rel {
    flex-shrink: 0; font-size: 10px; padding: 2px 6px; border-radius: 999px;
    border: 1px solid var(--panel-border); color: var(--muted);
  }
  .empty-banner, .auth-banner, .loading-banner {
    position: fixed; z-index: 15; left: 50%; top: 50%;
    transform: translate(-50%, -50%);
    text-align: center; pointer-events: none;
    padding: 18px 22px; border-radius: 16px;
    border: 1px solid var(--panel-border); background: rgba(8, 11, 26, .72);
    color: var(--muted); font-size: 14px; backdrop-filter: blur(8px);
    max-width: min(90vw, 360px);
  }
  .empty-banner { font-family: var(--serif); letter-spacing: .12em; font-size: 15px; }
  .auth-banner { pointer-events: auto; }
  .auth-banner a { color: var(--gold); }
  .skip-hint {
    position: fixed; bottom: 92px; left: 50%; transform: translateX(-50%);
    z-index: 18; font-size: 11px; color: var(--muted);
    background: rgba(8, 11, 26, .55); border: 1px solid var(--panel-border);
    padding: 6px 12px; border-radius: 999px; pointer-events: none;
    opacity: 0; transition: opacity .3s;
  }
  .skip-hint.show { opacity: 1; }
  @media (max-width: 767px) {
    .title-main { font-size: 19px; }
    /* below the icon row, so the title and the buttons don't overlap on phones */
    .title-block { top: max(58px, calc(env(safe-area-inset-top) + 48px)); max-width: 92vw; }
    .caption { display: none; }
    .stats { left: 14px; right: auto; }
    .chips {
      left: auto; right: 10px; transform: none;
      bottom: max(58px, calc(env(safe-area-inset-bottom) + 50px));
      display: none; align-items: flex-end;
    }
    .chips.open { display: flex; }
    .chips-row { justify-content: flex-end; flex-wrap: wrap; overflow: visible; }
    .chips-toggle {
      display: inline-flex; position: fixed; z-index: 21;
      right: 12px; bottom: max(12px, env(safe-area-inset-bottom));
      height: 34px;
    }
  }
</style>`;
