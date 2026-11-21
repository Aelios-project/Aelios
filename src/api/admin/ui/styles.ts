export const ADMIN_STYLES = `<style>
  /* ===== 色板：白天是晨昏渐变，夜里是深空星野。整页颜色都从这组变量来 ===== */
  :root {
    color-scheme: light;
    --page: #EEEDF8;
    --bg: linear-gradient(165deg, #F6EEF3 0%, #EEEDF8 42%, #E5EBFA 100%);
    --neb1: rgba(244, 160, 124, .42); --neb2: rgba(139, 124, 246, .32); --neb3: rgba(103, 232, 249, .18); --band: rgba(255, 255, 255, 0);
    --s1: rgba(124, 108, 220, .6); --s2: rgba(244, 160, 124, .65); --s3: rgba(103, 180, 249, .55); --halo: rgba(139, 124, 246, .16);
    --so: .7; --shoot: 0;
    --side: rgba(255, 255, 255, .32); --panel: rgba(255, 255, 255, .56); --solid: rgba(255, 255, 255, .9);
    --line: rgba(109, 92, 210, .2); --div: rgba(109, 92, 210, .11);
    --glow: 0 1px 0 rgba(255, 255, 255, .75) inset, 0 10px 28px rgba(88, 76, 160, .14);
    --t1: #232437; --t2: #3C3E5C; --t3: #5A5D86; --soft: rgba(124, 108, 220, .08);
    --coral: #F4A07C; --on-coral: #2A1608; --ct: #A84B22;
    --aur: linear-gradient(135deg, rgba(139, 124, 246, .26), rgba(103, 232, 249, .18)); --aurb: rgba(139, 124, 246, .5);
    --vline: #6D5CD2; --vt: #5B4BC4; --vbg: rgba(139, 124, 246, .15);
    --ok: #1D7350; --okbg: rgba(110, 231, 183, .26); --okdot: #2F9E6E;
    --warn: #7A4A00; --warnbg: rgba(251, 191, 36, .22);
    --err: #A0281C; --errbg: rgba(248, 113, 113, .16); --errb: rgba(200, 70, 60, .4);
    --off: rgba(109, 92, 210, .24); --knob: #FFFFFF; --scrim: rgba(35, 36, 55, .35);
    --fa: #2F5A8A; --fab: rgba(103, 160, 249, .18); --pr: #A84B22; --prb: rgba(244, 160, 124, .22);
    --bo: #9F2A3B; --bob: rgba(240, 110, 140, .16); --de: #5B4BC4; --deb: rgba(139, 124, 246, .18);
    --ev: #1C6B6B; --evb: rgba(80, 200, 200, .18); --ha: #2F6B2A; --hab: rgba(120, 200, 110, .2);
    --re: #8A3A7A; --reb: rgba(220, 120, 200, .16); --no: #3C3E5C; --nob: rgba(109, 92, 210, .09);
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --page: #070A16;
    --bg: linear-gradient(170deg, #05071A 0%, #0A0E2C 50%, #140C33 100%);
    --neb1: rgba(124, 93, 250, .34); --neb2: rgba(56, 189, 248, .2); --neb3: rgba(236, 72, 153, .13); --band: rgba(165, 155, 255, .12);
    --s1: rgba(255, 255, 255, .98); --s2: rgba(205, 214, 255, .9); --s3: rgba(255, 196, 168, .85); --halo: rgba(170, 160, 255, .38);
    --so: 1; --shoot: 1;
    --side: rgba(8, 11, 30, .32); --panel: rgba(20, 26, 58, .48); --solid: rgba(23, 29, 62, .9);
    --line: rgba(148, 163, 255, .18); --div: rgba(148, 163, 255, .1);
    --glow: 0 1px 0 rgba(180, 190, 255, .08) inset, 0 10px 30px rgba(2, 5, 18, .5);
    --t1: #EEF0FF; --t2: #C9CDEA; --t3: #9EA4CC; --soft: rgba(148, 163, 255, .08);
    --ct: #F4A07C;
    --aur: linear-gradient(135deg, rgba(139, 124, 246, .3), rgba(103, 232, 249, .16)); --aurb: rgba(139, 124, 246, .6);
    --vline: #9B8CFF; --vt: #B9AFFF; --vbg: rgba(139, 124, 246, .18);
    --ok: #6EE7B7; --okbg: rgba(110, 231, 183, .12); --okdot: #6EE7B7;
    --warn: #FBBF24; --warnbg: rgba(251, 191, 36, .12);
    --err: #F87171; --errbg: rgba(248, 113, 113, .12); --errb: rgba(248, 113, 113, .4);
    --off: rgba(148, 163, 255, .22); --knob: #EEF0FF; --scrim: rgba(2, 4, 14, .6);
    --fa: #93C5FD; --fab: rgba(103, 160, 249, .15); --pr: #F4A07C; --prb: rgba(244, 160, 124, .15);
    --bo: #F9A8B8; --bob: rgba(240, 110, 140, .15); --de: #B9AFFF; --deb: rgba(139, 124, 246, .2);
    --ev: #67E8F9; --evb: rgba(80, 200, 220, .13); --ha: #A3E39A; --hab: rgba(120, 200, 110, .13);
    --re: #F0ABE0; --reb: rgba(220, 120, 200, .13); --no: #C9CDEA; --nob: rgba(148, 163, 255, .11);
  }

  /* 中英两套文字只显示一套 */
  :root[data-lang="en"] .zh, :root:not([data-lang="en"]) .en { display: none !important; }
  [x-cloak] { display: none !important; }
  *, *::before, *::after { box-sizing: border-box; }
  p, h1, h2, h3, ol, ul, figure, blockquote, pre { margin: 0; }
  ol, ul { padding: 0; }
  button { border: 0; background: none; padding: 0; }
  details > summary { cursor: pointer; }

  html, body { min-height: 100%; background: var(--page); }
  body { margin: 0; color: var(--t1); font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
  * { scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
  button, input, textarea, select { font: inherit; color: inherit; }
  button { cursor: pointer; }
  button:disabled { cursor: default; }
  :focus-visible { outline: 2px solid var(--vline); outline-offset: 2px; }
  h1, h2, h3, button { word-break: keep-all; }
  a { color: var(--ct); }
  svg.i { display: inline-block; flex: none; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
  .muted { color: var(--t3); }

  /* ===== 星空：渐变底 + 三层星点 + 两颗流星（白天流星不显示），只动 opacity / transform ===== */
  .sky { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden;
    background:
      radial-gradient(60% 45% at 82% 6%, var(--neb1), transparent 70%),
      radial-gradient(55% 45% at 6% 88%, var(--neb2), transparent 70%),
      radial-gradient(42% 36% at 38% 42%, var(--neb3), transparent 72%),
      linear-gradient(118deg, transparent 28%, var(--band) 46%, transparent 64%),
      var(--bg); }
  .sky .l { position: absolute; inset: 0; background-repeat: repeat; }
  .sky .a { background-image: radial-gradient(1.2px 1.2px at 24px 36px, var(--s1) 50%, transparent), radial-gradient(1px 1px at 128px 96px, var(--s2) 50%, transparent), radial-gradient(1.6px 1.6px at 212px 180px, var(--s1) 50%, transparent), radial-gradient(1px 1px at 320px 64px, var(--s2) 50%, transparent), radial-gradient(1.2px 1.2px at 392px 240px, var(--s3) 50%, transparent), radial-gradient(1px 1px at 72px 300px, var(--s2) 50%, transparent), radial-gradient(1.6px 1.6px at 268px 356px, var(--s1) 50%, transparent), radial-gradient(1px 1px at 428px 400px, var(--s2) 50%, transparent), radial-gradient(1.2px 1.2px at 168px 424px, var(--s1) 50%, transparent), radial-gradient(1px 1px at 350px 140px, var(--s1) 50%, transparent), radial-gradient(1px 1px at 40px 200px, var(--s3) 50%, transparent), radial-gradient(1px 1px at 240px 20px, var(--s2) 50%, transparent);
    background-size: 460px 460px; animation: sky-a 7s ease-in-out infinite alternate; }
  .sky .b { background-image: radial-gradient(1.8px 1.8px at 96px 148px, var(--s2) 50%, transparent), radial-gradient(2px 2px at 336px 44px, var(--s1) 50%, transparent), radial-gradient(1.4px 1.4px at 512px 208px, var(--s2) 50%, transparent), radial-gradient(1.6px 1.6px at 184px 392px, var(--s3) 50%, transparent), radial-gradient(1.4px 1.4px at 568px 460px, var(--s1) 50%, transparent), radial-gradient(2px 2px at 48px 520px, var(--s2) 50%, transparent), radial-gradient(1.4px 1.4px at 432px 584px, var(--s1) 50%, transparent), radial-gradient(1.2px 1.2px at 280px 270px, var(--s1) 50%, transparent);
    background-size: 620px 620px; animation: sky-b 11s ease-in-out infinite alternate; }
  .sky .c { background-image: radial-gradient(2.4px 2.4px at 140px 120px, var(--s1) 55%, transparent), radial-gradient(12px 12px at 140px 120px, var(--halo), transparent), radial-gradient(2.2px 2.2px at 700px 380px, var(--s2) 55%, transparent), radial-gradient(11px 11px at 700px 380px, var(--halo), transparent), radial-gradient(2.6px 2.6px at 420px 760px, var(--s3) 55%, transparent), radial-gradient(13px 13px at 420px 760px, var(--halo), transparent), radial-gradient(2.2px 2.2px at 860px 860px, var(--s1) 55%, transparent), radial-gradient(10px 10px at 860px 860px, var(--halo), transparent);
    background-size: 960px 960px; animation: sky-c 5s ease-in-out infinite alternate; }
  .sky .shoot { position: absolute; width: 160px; height: 1.5px; border-radius: 999px; background: linear-gradient(90deg, rgba(255, 255, 255, .95), rgba(190, 180, 255, .5) 30%, transparent); opacity: 0; transform: rotate(-28deg); }
  .sky .s1 { top: 90px; left: 68%; animation: sky-shoot 12s ease-in 2s infinite; }
  .sky .s2 { top: 520px; left: 88%; animation: sky-shoot 17s ease-in 9s infinite; }
  @keyframes sky-a { from { opacity: calc(var(--so) * .45); } to { opacity: var(--so); } }
  @keyframes sky-b { from { opacity: var(--so); } to { opacity: calc(var(--so) * .35); } }
  @keyframes sky-c { from { opacity: calc(var(--so) * .55); } to { opacity: var(--so); } }
  @keyframes sky-shoot { 0% { opacity: 0; transform: translate(0, 0) rotate(-28deg); } 2% { opacity: var(--shoot); } 9% { opacity: 0; transform: translate(-300px, 160px) rotate(-28deg); } 100% { opacity: 0; transform: translate(-300px, 160px) rotate(-28deg); } }

  /* ===== 外壳：手机上是一整屏的列，内容区自己滚、底栏钉在下面；宽屏是侧栏 + 正文，整页滚 ===== */
  .app { position: relative; z-index: 1; display: flex; flex-direction: column; height: 100dvh; }
  .main { position: relative; flex: 1; min-width: 0; min-height: 0; overflow-y: auto; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 20px 16px max(40px, env(safe-area-inset-bottom)); }
  .side { position: fixed; inset: 0 auto 0 0; z-index: 60; width: 272px; max-width: 86vw; box-sizing: border-box; padding: 20px 14px; display: flex; flex-direction: column; gap: 22px; overflow-y: auto;
    background: var(--solid); box-shadow: var(--glow); transform: translateX(-104%); transition: transform .2s ease; }
  .side.is-open { transform: none; }
  .side-scrim { position: fixed; inset: 0; z-index: 55; background: var(--scrim); }
  @media (min-width: 768px) {
    .app { flex-direction: row; height: auto; min-height: 100dvh; }
    .main { overflow: visible; }
    .wrap { padding: 32px clamp(16px, 4vw, 40px) 56px; }
    .side { position: sticky; top: 0; height: 100dvh; width: 240px; max-width: none; flex: none; transform: none; transition: none; z-index: 2;
      background: var(--side); box-shadow: inset -1px 0 0 var(--div); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
    .side-scrim, .topbar { display: none !important; }
  }
  .brand { display: flex; align-items: center; gap: 10px; padding: 0 6px; font-size: 16px; font-weight: 600; letter-spacing: -.01em; }
  .logo { width: 32px; height: 32px; border-radius: 9px; background: var(--coral); color: var(--on-coral); display: grid; place-items: center; font-size: 15px; font-weight: 700; flex: none; }
  .viewing { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--line); background: var(--panel); text-align: left; width: 100%; }
  .nav-title { padding: 0 12px 6px; font-size: 11px; font-weight: 600; letter-spacing: .04em; color: var(--t3); }
  .nav-link { display: flex; width: 100%; align-items: center; gap: 12px; min-height: 44px; padding: 0 12px; border-radius: 10px; color: var(--t2); font-size: 14px; font-weight: 500; background: transparent; border: 0; }
  .nav-link:hover { background: var(--soft); color: var(--t1); }
  .nav-link.is-active { background: var(--aur); box-shadow: inset 0 0 0 1px var(--aurb); color: var(--t1); font-weight: 600; }
  .badge { min-width: 22px; padding: 2px 7px; box-sizing: border-box; border-radius: 999px; background: var(--coral); color: var(--on-coral); font-size: 12px; font-weight: 600; text-align: center; line-height: 1.4; }
  .topbar { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--div); background: var(--side); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); position: sticky; top: 0; z-index: 30; }
  .topbar .badge { position: absolute; top: -4px; right: -4px; min-width: 18px; padding: 0 5px; font-size: 10px; }

  /* ===== 部件 ===== */
  .page { display: flex; flex-direction: column; gap: 24px; }
  .page-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px; }
  .h1 { margin: 0; font-size: 28px; font-weight: 600; letter-spacing: -.01em; line-height: 1.25; }
  .h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .sub { margin: 6px 0 0; font-size: 14px; color: var(--t3); }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); box-shadow: var(--glow); }
  .panel-pad { padding: 18px; }
  .panel-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; padding: 16px 18px 0; }
  .divide > * + * { border-top: 1px solid var(--div); }
  .row { display: flex; align-items: center; gap: 14px; padding: 14px 18px; }
  .empty { padding: 28px 18px; text-align: center; color: var(--t3); }
  .stats { display: flex; flex-wrap: wrap; gap: 12px; }
  .stat { flex: 1 1 150px; padding: 16px 18px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .stat-label { font-size: 13px; color: var(--t3); }
  .stat-num { font-size: 28px; font-weight: 600; letter-spacing: -.01em; font-variant-numeric: tabular-nums; line-height: 1.3; }
  .stat-sub { font-size: 12px; color: var(--t3); }
  /* overflow 裁剪：顶上那条极光是直的，不裁会从圆角卡片两侧探出去 */
  .dream-stat { position: relative; overflow: hidden; }
  .dream-stat::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px; background: linear-gradient(90deg, #8B7CF6, #67E8F9); opacity: .75; }

  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 0 16px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel); color: var(--t2); font-size: 14px; font-weight: 500; white-space: nowrap; transition: border-color .15s ease, background-color .15s ease, color .15s ease; }
  .btn:hover:not(:disabled) { border-color: var(--aurb); color: var(--t1); }
  .btn:disabled { opacity: .45; }
  .btn-primary { border: 0; background: var(--coral); color: var(--on-coral); font-weight: 600; }
  .btn-primary:hover:not(:disabled) { color: var(--on-coral); filter: brightness(1.04); }
  .btn-sm { min-height: 36px; padding: 0 12px; font-size: 13px; }
  .btn-icon { width: 44px; padding: 0; }
  .btn-icon-sm { width: 36px; padding: 0; }
  .btn-danger { color: var(--err); }
  .btn-danger:hover:not(:disabled) { border-color: var(--errb); color: var(--err); }
  .btn-warn { border-color: var(--warnbg); background: var(--warnbg); color: var(--warn); font-weight: 600; }
  .link-btn { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: var(--vt); font-size: 13px; font-weight: 500; }
  .link-btn:hover { text-decoration: underline; }
  .link { color: var(--ct); font-size: 13px; font-weight: 500; background: none; border: 0; padding: 0; }
  .link:hover { text-decoration: underline; }
  .field { min-height: 44px; width: 100%; box-sizing: border-box; padding: 0 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--solid); color: var(--t1); outline: none; transition: border-color .15s ease; }
  textarea.field { padding: 10px 12px; line-height: 1.7; resize: vertical; }
  .field:focus { border-color: var(--vline); }
  .field-sm { min-height: 36px; width: auto; }
  .search { position: relative; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--solid); color: var(--t3); box-sizing: border-box; }
  .search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--t1); }
  .search:focus-within { border-color: var(--vline); }
  .label { display: block; font-size: 13px; color: var(--t3); margin-bottom: 6px; }
  .check { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; font-size: 13px; color: var(--t2); }
  input[type="checkbox"], input[type="radio"] { width: 16px; height: 16px; accent-color: var(--vline); flex: none; }

  .tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--line); }
  .tab { min-height: 44px; padding: 0 14px; margin-bottom: -1px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--t2); font-size: 14px; }
  .tab.is-active { border-bottom-color: var(--vline); color: var(--t1); font-weight: 600; }
  .tab .count { margin-left: 4px; color: var(--t3); font-weight: 500; }
  .pill { min-height: 36px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--t2); font-size: 13px; }
  .pill.is-active { border-color: var(--aurb); background: var(--aur); color: var(--t1); font-weight: 600; }
  .pill .count { color: var(--t3); margin-left: 2px; }
  .seg { display: inline-flex; padding: 3px; gap: 2px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel); }
  .seg button { min-height: 32px; padding: 0 12px; border-radius: 8px; border: 0; background: transparent; color: var(--t2); font-size: 13px; }
  .seg button.is-active { background: var(--solid); color: var(--t1); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, .08); }

  .chip { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 2px 9px; font-size: 12px; line-height: 1.6; color: var(--t2); background: var(--soft); white-space: nowrap; }
  .chip-ok { color: var(--ok); background: var(--okbg); }
  .chip-warn { color: var(--warn); background: var(--warnbg); }
  .chip-err { color: var(--err); background: var(--errbg); }
  .chip-dim { color: var(--t3); background: var(--soft); }
  .chip-violet { color: var(--vt); background: var(--vbg); }
  .chip-coral { color: var(--pr); background: var(--prb); }
  .t-fact { color: var(--fa); background: var(--fab); } .t-preference { color: var(--pr); background: var(--prb); }
  .t-boundary { color: var(--bo); background: var(--bob); } .t-decision { color: var(--de); background: var(--deb); }
  .t-event { color: var(--ev); background: var(--evb); } .t-habit { color: var(--ha); background: var(--hab); }
  .t-relationship { color: var(--re); background: var(--reb); } .t-note { color: var(--no); background: var(--nob); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--t3); }
  .dot-ok { background: var(--okdot); } .dot-err { background: var(--err); } .dot-warn { background: var(--warn); }
  .meter { display: inline-block; position: relative; width: 48px; height: 4px; border-radius: 999px; background: var(--off); overflow: hidden; vertical-align: middle; }
  .meter > span { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: var(--vline); }
  .bar { height: 8px; border-radius: 999px; background: var(--off); overflow: hidden; }
  .bar > div { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #8B7CF6, #67E8F9); transition: width .3s ease; }
  .conf { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--t3); }
  .banner { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 12px; background: var(--soft); color: var(--t2); font-size: 13px; }
  .banner-ok { background: var(--okbg); color: var(--ok); }
  .banner-warn { background: var(--warnbg); color: var(--warn); }
  .note { padding: 14px 16px; font-size: 13px; color: var(--t2); line-height: 1.7; }
  .avatar { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; flex: none; font-size: 13px; font-weight: 600; background: var(--vbg); color: var(--vt); }
  .avatar-user { background: var(--prb); color: var(--pr); }
  .heart { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; flex: none; border: 0; background: transparent; color: var(--t3); }
  .heart:hover { background: var(--soft); color: var(--coral); }
  .heart.is-on { color: var(--coral); }
  .quotes { margin-top: 8px; display: grid; gap: 8px; }
  .quotes blockquote { margin: 0; padding: 8px 12px; border-left: 3px solid var(--aurb); border-radius: 0 8px 8px 0; background: var(--soft); font-size: 13px; color: var(--t2); line-height: 1.7; }
  .cand { display: flex; flex-wrap: wrap; gap: 14px; padding: 16px 18px; align-items: flex-start; }
  .cand-check { margin-top: 4px; }
  .cand-body { flex: 1 1 280px; min-width: 0; }
  .cand-text { margin: 10px 0 0; font-size: 15px; line-height: 1.7; white-space: pre-wrap; color: var(--t1); }
  .cand-note { margin: 6px 0 0; font-size: 13px; color: var(--t3); }
  .cand-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-left: auto; }
  .was-now { margin-top: 10px; display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: 14px; line-height: 1.7; }
  .line-through-soft { color: var(--t3); text-decoration: line-through; text-decoration-color: var(--line); white-space: pre-wrap; }
  .menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; min-width: 180px; padding: 6px; border-radius: 12px; border: 1px solid var(--line); background: var(--solid); box-shadow: var(--glow); display: grid; }
  .menu button { text-align: left; padding: 9px 12px; border-radius: 8px; border: 0; background: transparent; color: var(--t1); font-size: 13px; }
  .menu button:hover { background: var(--soft); }
  .chev { display: inline-grid; place-items: center; flex: none; color: var(--t3); transition: transform .15s ease; }
  .chev.is-open { transform: rotate(180deg); }
  .icon-btn { display: inline-grid; place-items: center; flex-shrink: 0; width: 2rem; height: 2rem; border-radius: 999px; color: var(--t3); border: 0; background: transparent; transition: color .15s ease, background-color .15s ease; }
  .icon-btn:hover:not(:disabled) { color: var(--ct); background: var(--soft); }
  .icon-btn:disabled { opacity: .5; }
  .toast { position: fixed; left: 16px; right: 16px; top: 16px; z-index: 80; padding: 12px 16px; border-radius: 12px; border: 1px solid var(--line); background: var(--solid); box-shadow: var(--glow); font-size: 14px; }
  @media (min-width: 768px) { .toast { left: auto; right: 24px; width: 380px; } }
  .modal { position: fixed; inset: 0; z-index: 70; }
  .modal-scrim { position: absolute; inset: 0; background: var(--scrim); }
  .sheet { position: absolute; inset: auto 0 0 0; max-height: 86dvh; overflow-y: auto; padding: 18px 18px max(18px, env(safe-area-inset-bottom)); border-radius: 18px 18px 0 0; border: 1px solid var(--line); background: var(--solid); box-shadow: var(--glow); }
  @media (min-width: 768px) { .sheet { inset: 72px auto auto 50%; transform: translateX(-50%); width: 34rem; border-radius: 16px; } }

  /* 记忆库的表格行 */
  .mem-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; width: 100%; padding: 14px 18px; border: 0; background: transparent; text-align: left; }
  .mem-head:hover { background: var(--soft); }
  .mem-text { flex: 1 1 320px; min-width: 0; font-size: 14px; color: var(--t1); line-height: 1.6; }
  .mem-col { flex: 0 0 96px; font-size: 13px; color: var(--t3); }
  .mem-detail { padding: 4px 18px 18px; display: grid; gap: 14px; }
  .facts { display: flex; flex-wrap: wrap; gap: 10px 28px; font-size: 13px; }
  .facts > div { display: grid; gap: 2px; }
  .facts .k { color: var(--t3); font-size: 12px; }

  /* 设置 */
  .set-row { display: flex; align-items: flex-start; gap: 16px; padding: 14px 0; border-top: 1px solid var(--div); }
  .set-row:first-child { border-top: 0; }
  .set-sub { margin-left: 14px; padding-left: 12px; border-left: 2px solid var(--div); }
  .fold-btn { display: inline-flex; align-items: center; gap: 2px; border: 0; background: var(--soft); color: var(--t2); border-radius: 999px; padding: 1px 6px 1px 9px; font-size: 12px; }
  .set-label { font-size: 14px; font-weight: 500; color: var(--t1); }
  .set-hint { margin-top: 6px; padding: 8px 12px; border-radius: 8px; background: var(--soft); font-size: 13px; color: var(--t2); line-height: 1.7; }
  .set-hint code { display: inline-block; margin-left: 8px; color: var(--t3); font-size: 12px; }
  .set-input { width: 240px; max-width: 46%; flex: none; }
  .info-btn { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 999px; border: 0; background: transparent; color: var(--t3); }
  .info-btn:hover { color: var(--vt); background: var(--soft); }
  .reset-btn { border: 0; background: var(--vbg); color: var(--vt); border-radius: 999px; padding: 1px 9px; font-size: 12px; }
  .dot-changed { width: 7px; height: 7px; border-radius: 50%; background: var(--vline); flex: none; }
  .switch { position: relative; flex-shrink: 0; width: 44px; height: 26px; border-radius: 999px; border: 0; background: var(--off); transition: background-color .15s ease; margin-top: 1px; }
  .switch > span { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 999px; background: var(--knob); box-shadow: 0 1px 3px rgba(0, 0, 0, .2); transition: transform .15s ease; }
  .switch.is-on { background: var(--coral); }
  .switch.is-on > span { transform: translateX(18px); }
  .switch:disabled { opacity: .6; }
  .subnav a, .subnav button { display: block; width: 100%; text-align: left; padding: 8px 12px; border-radius: 8px; border: 0; background: transparent; color: var(--t2); font-size: 13px; text-decoration: none; }
  .subnav button:hover { background: var(--soft); color: var(--t1); }
  .group-btn { display: flex; width: 100%; align-items: center; gap: 10px; min-height: 52px; padding: 0 18px; border: 0; background: transparent; text-align: left; }
  .savebar { position: sticky; bottom: 12px; z-index: 30; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; border-radius: 12px; border: 1px solid var(--coral); background: var(--solid); box-shadow: var(--glow); }

  /* 日记 */
  .journal { display: grid; gap: 16px; }
  .journal-back { display: none; }
  @media (max-width: 1023px) {
    .journal.is-reading .journal-list, .journal:not(.is-reading) .reading { display: none; }
    .journal-back { display: inline-flex; }
  }
  @media (min-width: 1024px) {
    .journal { grid-template-columns: 320px 1fr; align-items: start; }
    .journal .reading { position: sticky; top: 24px; max-height: calc(100dvh - 48px); overflow-y: auto; }
  }
  .entry-btn { display: grid; gap: 2px; width: 100%; padding: 12px 16px; border: 0; background: transparent; text-align: left; }
  .entry-btn:hover { background: var(--soft); }
  .entry-btn.is-active { background: var(--aur); box-shadow: inset 3px 0 0 var(--vline); }
  .reading { padding: 24px clamp(18px, 3vw, 36px); }
  .reading p { margin: 0 0 14px; font-size: 15px; line-height: 1.9; color: var(--t1); }

  /* 夜间整理 */
  .dream-rail { position: relative; }
  .dream-rail::before { content: ""; position: absolute; left: 7px; top: 12px; bottom: 12px; width: 1px; background: linear-gradient(to bottom, var(--aurb), transparent); }
  .dream-rail-item { position: relative; padding-left: 26px; }
  .dream-rail-item::before { content: ""; position: absolute; left: 3px; top: 8px; width: 9px; height: 9px; border-radius: 999px; background: var(--rail-dot, var(--t3)); box-shadow: 0 0 10px 1px var(--rail-glow, transparent); }
  .rail-ok { --rail-dot: var(--okdot); --rail-glow: rgba(110, 231, 183, .4); }
  .rail-err { --rail-dot: var(--err); --rail-glow: rgba(248, 113, 113, .4); }
  .rail-dim { --rail-dot: var(--t3); }
  .rail-run { --rail-dot: var(--warn); --rail-glow: rgba(251, 191, 36, .4); }
  .breathe { animation: dream-breathe 2.2s ease-in-out infinite; }
  @keyframes dream-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  .day-bar { display: flex; align-items: center; gap: 12px; font-size: 13px; }
  .raw-bar-track { flex: 1; min-width: 0; height: 8px; border-radius: 999px; background: var(--off); overflow: hidden; }
  .raw-bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #8B7CF6, #67E8F9); }
  .raw-bar-fill.is-done { background: var(--t3); opacity: .4; }
  .harvest-dot { display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: var(--coral); box-shadow: 0 0 10px 2px rgba(244, 160, 124, .5); }

  .steps { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; padding: 0; list-style: none; font-size: 13px; color: var(--t3); }
  .steps .n { display: inline-grid; place-items: center; width: 22px; height: 22px; margin-right: 6px; border-radius: 50%; background: var(--soft); font-size: 12px; font-weight: 600; }
  .steps .is-done .n { background: var(--okbg); color: var(--ok); }
  .steps .is-now { color: var(--t1); font-weight: 600; }
  .steps .is-now .n { background: var(--coral); color: var(--on-coral); }
  .steps .sep { width: 24px; height: 1px; background: var(--line); }
  .mode-card { display: flex; gap: 14px; align-items: flex-start; padding: 16px 18px; border-radius: 14px; border: 1px solid var(--line); background: var(--panel); text-align: left; }
  .mode-card.is-active { border-color: var(--aurb); background: var(--aur); }
  .mode-card .ico { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; flex: none; background: var(--vbg); color: var(--vt); }
  pre.out { margin: 0; max-height: 420px; overflow: auto; padding: 14px 16px; border-radius: 10px; background: var(--soft); font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }

  /* 星空只是氛围：减少动态时全部静止 */
  @media (prefers-reduced-motion: reduce) {
    .sky *, .breathe { animation: none !important; }
    *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
  }
</style>
</head>`;
