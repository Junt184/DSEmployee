/**
 * 控制台样式（一段纯字符串，**不含任何插值**）。
 *
 * 为什么单独一个文件：它原来是 ui.ts 里那个 HTML 模板字面量里的一段（1,435 行），
 * 而 ui.ts 同时装着组装逻辑、页面标记与样式三样东西。拆开之后：
 *   · 改样式只动这一个文件，和"改脚本片段""改页面标记"互不干扰；
 *   · 它是 `String.raw`（不是模板字面量）—— 所以里面**不能出现反引号或美元花括号**，
 *     与 src/web/script/ 下的片段同一条约束（有测试逐个钉着）。
 *
 * 界面指纹覆盖 src/web/ 下全部 .ts 原文，所以改这里照样会换代（PWA/缓存不会冻住旧样式）。
 */
export const CONTROL_UI_CSS = String.raw`
/* 双主题：:root 是浅色（默认日间），[data-theme="dark"] 是原有深色。
   所有组件色都走变量，切换只改 documentElement 的 data-theme。 */
:root, [data-theme="light"] {
  --bg: #f5f5f7;
  --panel: #ffffff;
  --panel-2: #eef1f6;
  --line: #d3dae4;
  --fg: #1d2431;
  --muted: #5c6a7e;
  /* accent/ok/warn/bad 保持原有色相，压暗到浅色底上可读 */
  --accent: #2f6fdd;
  --ok: #1c9a58;
  --warn: #a8740a;
  --bad: #cf3f3f;
  --input-bg: #f6f8fb;
  --code-bg: #eceff4;
  --active-bg: #e0ebfd;
  --hover-line: #aebdd2;
  --primary-bg: #d8e6fb;
  --primary-line: #a3c2ef;
  --danger-bg: #f9e3e6;
  --danger-line: #e2a4ac;
  --warn-bg: #fbf2da;
  --warn-line: #dec287;
  --toast-bg: #ffffff;
  --badge-ok-line: #93d3b2;
  --badge-warn-line: #dec287;
  --badge-bad-line: #e5a3a3;
  /* Messages 风格气泡：用户蓝（白字）/ 员工灰（主题前景字） */
  --msg-user-bg: #007aff;
  --msg-user-fg: #ffffff;
  --msg-assistant-bg: #e9e9eb;
  --radius: 10px;
  /* 圆角标尺：组件不再各写各的 px（原先是 40 处硬编码，第三套皮肤收不干净）。
     日/夜用现值 → 两套老主题渲染逐像素不变；作业室只覆盖这套标尺。 */
  --radius-sm: 8px;
  --radius-xs: 6px;
  --radius-lg: 12px;
  --radius-bubble: 18px;
}
[data-theme="dark"] {
  --bg: #000000;
  --panel: #161a22;
  --panel-2: #1d222c;
  --line: #2a3040;
  --fg: #e7eaf1;
  --muted: #98a1b3;
  --accent: #6ea8fe;
  --ok: #3ddc84;
  --warn: #f5b544;
  --bad: #ff6b6b;
  --input-bg: #10131a;
  --code-bg: #0b0e13;
  --active-bg: #1b2740;
  --hover-line: #3b4a66;
  --primary-bg: #1d3a63;
  --primary-line: #2f5c99;
  --danger-bg: #45212a;
  --danger-line: #7a3345;
  --warn-bg: #241f14;
  --warn-line: #6d5622;
  --toast-bg: #191d27;
  --badge-ok-line: #2c6a48;
  --badge-warn-line: #6d5622;
  --badge-bad-line: #6d2b2b;
  /* Messages 风格气泡：深色下用户蓝提亮、员工灰用近黑灰 */
  --msg-user-bg: #0a84ff;
  --msg-user-fg: #ffffff;
  --msg-assistant-bg: #26262a;
  --radius: 10px;
  /* 圆角标尺：组件不再各写各的 px（原先是 40 处硬编码，第三套皮肤收不干净）。
     日/夜用现值 → 两套老主题渲染逐像素不变；作业室只覆盖这套标尺。 */
  --radius-sm: 8px;
  --radius-xs: 6px;
  --radius-lg: 12px;
  --radius-bubble: 18px;
}
/* ── 作业室皮肤（黑底霓虹）——**页面级**，不是第四套主题 ──
 *
 * 它挂在**某个页面容器**上（.skin-neon，目前只有岗位外壳 layout: 'quad' 用它），
 * 而不是挂在 <html data-theme> 上。原因就是需求本身：渗透测试那一页要能"日间 / 作业室"
 * 两副面孔，而**平台其余部分仍然只有日间与夜间**两套 —— 全局多出一套皮肤会改到
 * 办公区、审批、体检、秘书页，那不是要的东西。
 *
 * 靠 CSS 变量的级联实现：令牌在子树根上重声明，页面内部所有组件自动跟着换，
 * 页面之外一个像素都不动。三件事说清：
 *   1. 令牌**成套**（下面这批变量一个不少），所以平台组件不会有"没适配"的洞；
 *      额外的组件外观（等宽/方角/扫描线/荧光）在文件末尾那一段，只有几条。
 *   2. 色值取自设计稿 docs/mockups/渗透测试页-四宫格-皮肤对比.html，对比度都核过：
 *      fg/panel 14.9:1、muted/panel 5.4:1、warn 10.5:1、bad 5.9:1、accent 12.9:1
 *      —— 这一页是拿来读日志与证据的，"够不够酷"排在"看得清"后面。
 *   3. 它也**只在四宫格那一页生效**：切页、切员工、退出外壳都会把类摘掉（见 68-quad.ts）。 */
.skin-neon {
  --bg: #04070a;
  --panel: #0a1014;
  --panel-2: #0d151a;
  --line: #14312c;
  --fg: #cfe9e1;
  --muted: #6f8f88;
  --accent: #35f0a0;
  --ok: #35f0a0;
  --warn: #ffb020;
  --bad: #ff4d6a;
  --input-bg: #060c0f;
  --code-bg: #05090c;
  --active-bg: #0f2620;
  --hover-line: #1d6b4e;
  --primary-bg: #0f2b22;
  --primary-line: #1d6b4e;
  --danger-bg: #2a1119;
  --danger-line: #7a2a3c;
  --warn-bg: #241d0c;
  --warn-line: #6d5622;
  --toast-bg: #0a1014;
  --badge-ok-line: #1d6b4e;
  --badge-warn-line: #6d5622;
  --badge-bad-line: #7a2a3c;
  --msg-user-bg: #114d38;
  --msg-user-fg: #d8fff0;
  --msg-assistant-bg: #0c1418;
  --radius: 2px;
  --radius-sm: 2px;
  --radius-xs: 2px;
  --radius-lg: 2px;
  --radius-bubble: 6px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  -webkit-text-size-adjust: 100%;
}
.hidden { display: none !important; }
.muted { color: var(--muted); }
.warn { color: var(--warn); }
/* 界面脚本指纹：正常时是一行无存在感的灰字；一旦与服务端不一致（脚本被缓存冻住）
   变红加粗 —— 它存在的意义就是"出问题时必须显眼"。 */
.ui-version { margin-left: 6px; font-size: 11px; white-space: nowrap; }
.ui-version.bad { color: var(--bad); font-weight: 600; }
/* ── 体检中心：总览 + 问题队列 + 详情处理 ──
   体检不是日志：先告诉人系统是否需要处理，再让人点进一项看事实和下一步。 */
.health-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.health-heading #btnReloadHealth { flex: 0 0 auto; }
.health-intro { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 6px; color: var(--muted); }
.health-intro #healthLastChecked { font-size: 12px; white-space: nowrap; }
.health-overview { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: stretch; margin-top: 12px; }
.health-state { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 9px 11px; background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius-sm); }
.health-state-dot { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 50%; background: var(--muted); }
.health-state.ok .health-state-dot { background: var(--ok); }
.health-state.warn .health-state-dot { background: var(--warn); }
.health-state.bad .health-state-dot { background: var(--bad); }
.health-state > div { display: flex; flex-direction: column; min-width: 0; }
.health-state strong { font-size: 14px; font-weight: 600; }
.health-state span:not(.health-state-dot) { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.health-counters { display: grid; grid-template-columns: repeat(3, minmax(72px, 1fr)); gap: 6px; }
.health-counters > div { display: flex; min-width: 72px; flex-direction: column; justify-content: center; gap: 1px; padding: 7px 9px; background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius-sm); text-align: center; }
.health-counters span { color: var(--muted); font-size: 11px; }
.health-counters strong { font-size: 15px; font-weight: 600; }
.health-filters { display: flex; gap: 16px; margin-top: 12px; border-bottom: 1px solid var(--line); }
.health-filter { position: relative; min-height: 36px; padding: 5px 2px; border: none; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--muted); font-size: 12px; }
.health-filter:hover:not(:disabled) { border-bottom-color: var(--hover-line); }
.health-filter.active { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }
.health-filter span { margin-left: 4px; color: var(--muted); font-weight: 400; }
.health-workspace { display: grid; grid-template-columns: minmax(250px, 320px) minmax(0, 1fr); gap: 12px; align-items: start; margin-top: 12px; }
.health-queue { min-width: 0; }
.health-queue-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 0 2px 7px; }
.health-queue-heading strong { font-size: 13px; font-weight: 600; }
.health-queue-heading span { color: var(--muted); font-size: 12px; }
#healthBody { display: flex; flex-direction: column; gap: 6px; max-height: 62vh; overflow-y: auto; }
.health-item { display: block; width: 100%; min-height: 0; padding: 9px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel-2); text-align: left; }
.health-item:hover:not(:disabled) { border-color: var(--hover-line); }
.health-item.active { border-color: var(--accent); background: var(--active-bg); }
.health-item-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.health-item-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.health-item-title strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.health-item-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.health-item.bad .health-item-dot { background: var(--bad); }
.health-item.warn .health-item-dot { background: var(--warn); }
.health-item.info .health-item-dot { background: var(--accent); }
.health-item.ok .health-item-dot { background: var(--ok); }
.health-item-subject { margin-top: 4px; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.health-item-summary { margin-top: 3px; color: var(--fg); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.health-severity { flex: 0 0 auto; font-size: 11px; white-space: nowrap; }
.health-severity.bad { color: var(--bad); }
.health-severity.warn { color: var(--warn); }
.health-severity.info { color: var(--accent); }
.health-severity.ok { color: var(--ok); }
.health-empty { display: flex; flex-direction: column; gap: 3px; padding: 14px 10px; border: 1px dashed var(--line); border-radius: var(--radius-sm); color: var(--muted); }
.health-empty strong { color: var(--fg); font-weight: 500; }
.health-detail { min-width: 0; min-height: 230px; padding: 12px; background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius-sm); }
.health-detail-empty { display: flex; min-height: 204px; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: var(--muted); text-align: center; }
.health-detail-empty strong { color: var(--fg); font-weight: 500; }
.health-detail-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 12px; }
.health-detail-top strong { color: var(--fg); font-weight: 600; }
.health-detail-title { margin: 12px 0 4px; font-size: 16px; line-height: 1.4; font-weight: 600; overflow-wrap: anywhere; }
.health-detail-subject { color: var(--muted); font-size: 12px; }
.health-detail-section { margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--line); }
.health-detail-section h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; }
.health-detail-section p { margin: 0; color: var(--fg); font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
.health-facts { display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 0; list-style: none; color: var(--muted); font-size: 12px; }
.health-facts li { overflow-wrap: anywhere; }
.health-facts li::before { content: '·'; margin-right: 6px; color: var(--accent); }
.health-detail-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--line); }
.health-line-action { min-height: 36px; }
.health-line-action.muted { color: var(--muted); font-size: 12px; }
.health-line-action.bad { color: var(--bad); font-size: 12px; }
.health-line-action button { min-height: 36px; }

@media (max-width: 760px) {
  .health-overview { grid-template-columns: minmax(0, 1fr); }
  .health-workspace { grid-template-columns: minmax(0, 1fr); }
  .health-detail { order: -1; }
  #healthBody { max-height: none; }
}
@media (max-width: 460px) {
  .health-intro { align-items: flex-start; flex-direction: column; gap: 2px; }
  .health-counters { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .health-counters > div { min-width: 0; padding: 7px 4px; }
  .health-filters { gap: 11px; }
  .health-filter { font-size: 11px; }
}

/* 岗位管理行：名字输入框占满，右侧是人数与两个动作（触控目标 ≥44px） */
.pos-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.pos-row .pos-name { flex: 1 1 auto; min-width: 0; min-height: 44px; }
.pos-row .pos-meta { flex: 0 0 auto; color: var(--muted); font-size: 12px; }
.pos-row .pos-act { flex: 0 0 auto; min-height: 44px; }
.pos-row .pos-act.danger { color: var(--bad); border-color: var(--bad); }

/* ── 定时任务工作台：左侧扫一眼，右侧编辑与执行 ──
   不做通用后台的长表单：任务和员工的关系、下一次运行、在线状态才是这里的主信息。 */
.jobs-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.jobs-heading #btnReloadJobs { flex: 0 0 auto; }
.jobs-intro { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 6px; color: var(--muted); }
.jobs-policy { color: var(--warn); font-size: 12px; }
.jobs-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
.jobs-stat { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-width: 0; padding: 8px 10px; background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius-sm); }
.jobs-stat-label { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jobs-stat strong { color: var(--fg); font-size: 14px; font-weight: 600; white-space: nowrap; }
.jobs-workspace { display: grid; grid-template-columns: minmax(240px, 34%) minmax(0, 1fr); gap: 12px; align-items: start; margin-top: 14px; }
.jobs-queue { min-width: 0; }
.jobs-queue-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 0 2px 7px; }
.jobs-queue-heading > div { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.jobs-queue-heading strong { font-size: 13px; font-weight: 600; }
.jobs-queue-heading span { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jobs-queue-heading button { flex: 0 0 auto; min-height: 32px; padding: 4px 9px; font-size: 12px; }
#jobList { display: flex; flex-direction: column; gap: 6px; max-height: 58vh; overflow-y: auto; }
.job-row { min-width: 0; padding: 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel); cursor: pointer; }
.job-row:hover { border-color: var(--hover-line); }
.job-row.selected { border-color: var(--accent); background: var(--active-bg); }
.job-row.off { opacity: 0.78; }
.job-row-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.job-row-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.job-row-title strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.job-status-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.job-status-dot.on { background: var(--ok); }
.job-status-dot.warn { background: var(--warn); }
.job-badge { flex: 0 0 auto; font-size: 11px; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; color: var(--muted); white-space: nowrap; }
.job-badge.ok { color: var(--ok); border-color: var(--badge-ok-line); }
.job-badge.warn { color: var(--warn); border-color: var(--badge-warn-line); }
.job-row-meta { margin-top: 5px; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-row-next { margin-top: 3px; color: var(--fg); font-size: 12px; }
.job-row-next.off { color: var(--muted); }
.job-note { margin-top: 7px; padding-top: 6px; border-top: 1px dashed var(--line); color: var(--warn); font-size: 12px; overflow-wrap: anywhere; }
.job-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 9px; padding-top: 8px; border-top: 1px dashed var(--line); }
.job-actions .job-act { min-height: 32px; padding: 4px 9px; font-size: 12px; }
.job-actions .job-act.danger { color: var(--bad); border-color: var(--bad); }
.job-prompt { display: -webkit-box; margin-top: 8px; padding-top: 7px; border-top: 1px dashed var(--line); color: var(--muted); font-size: 12px; line-height: 1.45; overflow: hidden; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.job-runs { margin-top: 7px; padding-top: 6px; border-top: 1px dashed var(--line); font-size: 12px; }
.job-runs summary { cursor: pointer; color: var(--muted); }
.job-run { display: flex; gap: 8px; margin-top: 4px; color: var(--muted); min-width: 0; }
.job-run .job-run-status { flex: 0 0 auto; color: var(--fg); }
.job-run .job-run-when { flex: 0 0 auto; }
.job-run .job-run-detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-empty { display: flex; flex-direction: column; gap: 3px; padding: 14px 10px; border: 1px dashed var(--line); border-radius: var(--radius-sm); color: var(--muted); }
.job-empty strong { color: var(--fg); font-weight: 500; }
.job-detail { min-width: 0; padding: 12px; background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius-sm); }
.job-detail-empty { display: flex; min-height: 230px; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: var(--muted); text-align: center; }
.job-detail-empty strong { color: var(--fg); font-weight: 500; }
.job-detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.job-kicker { display: block; color: var(--muted); font-size: 11px; }
.job-detail-heading h3 { margin: 2px 0 0; font-size: 16px; line-height: 1.35; font-weight: 600; overflow-wrap: anywhere; }
.job-form-state { flex: 0 0 auto; font-size: 12px; color: var(--muted); }
.job-form-state.on { color: var(--ok); }
.job-form-state.off { color: var(--muted); }
.job-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; margin-top: 14px; }
.job-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; color: var(--fg); font-size: 12px; font-weight: 600; }
.job-field input, .job-field select, .job-field textarea { width: 100%; font-weight: 400; }
.job-field-interval { max-width: 220px; }
.job-interval-line { display: flex; align-items: center; gap: 7px; color: var(--muted); font-weight: 400; }
.job-interval-line input { flex: 1 1 auto; width: auto; min-width: 0; }
.job-interval-line > span { white-space: nowrap; }
.job-field-prompt { margin-top: 12px; }
.job-field-prompt textarea { min-height: 100px; resize: vertical; }
.job-field-prompt small { color: var(--muted); font-size: 11px; font-weight: 400; line-height: 1.45; }
.job-form-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--line); }
.job-form-actions button { min-height: 36px; }
.job-form-actions .muted { flex: 1 1 220px; font-size: 12px; line-height: 1.45; }

@media (max-width: 760px) {
  .jobs-workspace { grid-template-columns: minmax(0, 1fr); }
  .job-detail { order: -1; }
  #jobList { max-height: none; }
}
@media (max-width: 460px) {
  .jobs-intro { align-items: flex-start; flex-direction: column; gap: 2px; }
  .jobs-summary { gap: 5px; }
  .jobs-stat { align-items: flex-start; flex-direction: column; gap: 2px; padding: 7px 8px; }
  .jobs-queue-heading { align-items: flex-start; flex-direction: column; }
  .jobs-queue-heading > div { width: 100%; }
  .job-form-grid { grid-template-columns: minmax(0, 1fr); }
  .job-field-interval { max-width: none; }
  .job-form-actions { align-items: stretch; }
  .job-form-actions button { flex: 1 1 0; }
}

button {
  font: inherit;
  color: var(--fg);
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 7px 12px;
  cursor: pointer;
  min-height: 36px;
}
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button.primary { background: var(--primary-bg); border-color: var(--primary-line); }
button.danger { background: var(--danger-bg); border-color: var(--danger-line); }
button.ghost { background: transparent; }
input[type="text"], textarea, select {
  font: inherit;
  color: var(--fg);
  background: var(--input-bg);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 7px 10px;
  width: 100%;
  min-height: 36px;
}
textarea { resize: vertical; }
h1, h2 { font-size: 14px; margin: 0; font-weight: 600; }
h2 { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
/* 顶栏已删，原顶栏的三个按钮住在「办公区」标题行右侧这组小动作区里 */
.h2-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.h2-actions button { min-height: 0; padding: 3px 10px; font-size: 12px; }

.chip {
  font-size: 12px;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 9px;
  white-space: nowrap;
}

.banner {
  margin: 10px 12px 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-left-width: 4px;
  border-radius: var(--radius);
  background: var(--panel);
  word-break: break-word;
}
.banner.info { border-left-color: var(--accent); }
.banner.warn { border-left-color: var(--warn); }
.banner.bad { border-left-color: var(--bad); }
.banner.wait { border-left-color: var(--warn); background: var(--warn-bg); }

/* 左栏已移除（授权体验挪到全屏授权页）：主区域单列、流式宽度 ——
   padding 随屏宽缩（clamp），宽屏不再两侧留白；聊天页单独限宽保可读性 */
main.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  padding: 12px clamp(8px, 2vw, 24px);
  align-items: start;
  width: 100%;
}
#viewChat { width: 100%; min-width: 0; min-height: 0; }

/* ── 全屏授权页（未配对时的「登录页」）── */
.auth-gate {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--bg);
  overflow: auto;
}
.auth-card {
  width: 100%;
  max-width: 480px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 20px;
}
.auth-card h1 { font-size: 16px; margin-bottom: 4px; }
.auth-note { margin-top: 12px; }
.auth-step { font-weight: 600; margin-top: 16px; }
.auth-code-row input {
  flex: 1 1 160px;
  font-size: 22px;
  letter-spacing: 6px;
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.auth-code-row button { flex: 0 0 auto; }
.auth-error { color: var(--bad); font-size: 13px; min-height: 20px; margin-top: 6px; word-break: break-word; }
.col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 10px 12px;
  min-width: 0;
}
.card > h2 { margin-bottom: 8px; }

/* ── 新建员工：把后台表单变成「新建一个工位」 ── */
.create-card > summary { display: flex; align-items: baseline; gap: 10px; }
.create-summary-title { font-weight: 600; }
.create-summary-note { color: var(--muted); font-size: 12px; font-weight: 400; }
.create-workspace { display: grid; grid-template-columns: minmax(190px, 230px) minmax(0, 1fr); gap: 16px; margin-top: 10px; }
.create-preview-panel { min-width: 0; padding: 12px; border: 1px dashed var(--line); border-radius: var(--radius); background: var(--panel-2); }
.create-kicker { color: var(--muted); font-size: 12px; }
.create-preview-desk { display: flex; flex-direction: column; align-items: center; gap: 7px; margin-top: 12px; text-align: center; }
.create-preview-desk .desk-avatar-box { width: 88px; height: 88px; margin: 0; }
.create-preview-desk .desk-avatar-box .desk-avatar { width: 100%; height: 100%; margin: 0; }
.create-preview-info { min-width: 0; width: 100%; }
.create-preview-name { display: block; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.create-preview-badges { display: flex; justify-content: center; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.create-preview-badges .badge { font-size: 11px; }
.create-preview-role, .create-preview-location { margin-top: 5px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.create-preview-location { margin-top: 2px; }
.create-preview-screen { display: flex; flex-direction: column; justify-content: flex-end; gap: 4px; min-height: 64px; margin-top: 12px; padding: 7px 8px; background: var(--code-bg); border: 1px solid var(--line); border-radius: var(--radius-xs); color: var(--muted); font: 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; text-align: left; }
.create-preview-screen-dim { color: var(--muted); }
.create-preview-help { margin-top: 10px; color: var(--muted); font-size: 12px; line-height: 1.5; }
.create-form { min-width: 0; }
.create-section + .create-section { margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--line); }
.create-section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.create-field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; }
.create-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.create-label { color: var(--fg); font-size: 12px; font-weight: 600; }
.create-help { color: var(--muted); font-size: 12px; line-height: 1.4; }
.create-control-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.create-control-line input { flex: 1 1 auto; min-width: 0; }
.create-control-line button { flex: 0 0 auto; white-space: nowrap; }
.create-field > input, .create-field > textarea, .create-field > select { width: 100%; }
.create-field > textarea { min-height: 76px; }
.create-location-grid .create-field-node { grid-column: 1 / -1; }
.create-field #createGroupSlot, .create-field #createPositionSlot { display: block; min-width: 0; }
.create-field .group-picker { display: flex; width: 100%; gap: 6px; min-width: 0; }
.create-field .group-picker select, .create-field .group-picker .group-new { flex: 1 1 auto; min-width: 0; width: 100%; }
.create-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 14px; padding-top: 10px; border-top: 1px dashed var(--line); }
.create-action-buttons { display: flex; gap: 8px; margin-left: auto; }
.create-action-buttons button { min-width: 84px; }

.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.row > button { flex: 0 0 auto; }
.row > input[type="text"] { flex: 1 1 140px; width: auto; }
.row > select { flex: 1 1 140px; width: auto; }

/* ── 视图标签（办公区 | 审批 | 设备 | 体检 | 模型配置）── */
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); padding: 0 4px; }
button.tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  min-height: 0;
  padding: 6px 12px;
  color: var(--muted);
  /* 标签不参与收缩：一行放不下时交给 .tabs 横滑（≤640px），
     而不是把「模型配置」折成两行、把标签条撑高 */
  flex: 0 0 auto;
  white-space: nowrap;
}
button.tab:hover:not(:disabled) { border-bottom-color: var(--hover-line); }
button.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
/* 标签里的计数（审批待处理 / 体检问题）：空的时候整个藏掉 ——
   一个空胶囊既难看又让人以为它坏了。有数字时保留 .chip 的原色（问题数是红的），
   所以这里只加间距，不覆盖 color/border-color。 */
button.tab .chip { margin-left: 6px; }
button.tab .chip:empty { display: none; }

/* ── 员工配置工作台：员工 / 共享服务 / 整机权限各有明确作用范围 ── */
.config-heading h2 { margin: 0; font-size: 22px; }
.config-heading p { margin: 4px 0 0; }
.config-pages, .config-tabs, .config-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.config-pages button[aria-pressed="true"] { background: var(--panel); border-color: var(--accent); color: var(--accent); }
.config-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin: 4px 0 14px; }
.config-workspace { display: grid; grid-template-columns: 230px minmax(0, 1fr); min-height: 550px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }
.config-directory { min-width: 0; padding: 18px 12px; background: var(--panel-2); border-right: 1px solid var(--line); border-radius: var(--radius) 0 0 var(--radius); }
.config-field { display: flex; flex-direction: column; align-items: stretch; min-width: 0; gap: 6px; margin: 0 0 16px; }
.config-label { font-size: 13px; font-weight: 600; }
.config-field input:not([type="checkbox"]), .config-field select, .config-field textarea { width: 100%; min-width: 0; border: 1px solid var(--line); border-radius: var(--radius-xs); padding: 8px 10px; color: var(--fg); background: var(--input-bg); font: inherit; }
.config-field .group-picker { width: 100%; }
.config-field .group-picker select { width: 100%; }
.config-field .group-new { width: 100%; }
.config-help { font-size: 12px; overflow-wrap: anywhere; }
.config-mobile-picker { display: none; }
.config-group-title { color: var(--muted); font-size: 11px; margin: 18px 8px 7px; }
.config-person { display: flex; width: 100%; align-items: center; text-align: left; gap: 9px; padding: 12px 8px; background: transparent; border: 1px solid transparent; margin-bottom: 4px; }
.config-person[aria-pressed="true"] { background: var(--active-bg); border-color: var(--accent); box-shadow: inset 3px 0 var(--accent); }
.config-person-copy { display: flex; flex-direction: column; min-width: 0; }
.config-person-name { font-weight: 600; overflow-wrap: anywhere; }
.config-person .desk-avatar-box { width: 28px; height: 28px; margin: 0; flex: 0 0 auto; }
.config-detail { padding: 24px; min-width: 0; }
.config-person-header { display: flex; align-items: center; gap: 12px; }
.config-person-header h3 { margin: 0 0 3px; }
.config-person-header .desk-avatar-box { width: 44px; height: 44px; margin: 0; flex: 0 0 auto; }
.config-tabs { gap: 20px; margin: 22px 0; border-bottom: 1px solid var(--line); }
.config-tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: 0 0 12px; color: var(--muted); }
.config-tabs button[aria-pressed="true"] { border-bottom-color: var(--accent); color: var(--accent); }
.config-message { margin: 0 0 16px; padding: 10px 12px; background: var(--panel-2); border-radius: var(--radius-sm); overflow-wrap: anywhere; }
.config-model-summary { background: var(--panel-2); border-radius: var(--radius-sm); padding: 16px; margin-bottom: 20px; }
.config-model-summary strong { display: block; margin: 6px 0; overflow-wrap: anywhere; }
.config-section-title { margin: 24px 0 12px; }
.config-model-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 16px 0; border-bottom: 1px solid var(--line); }
.config-model-copy { flex: 1 1 220px; min-width: 0; overflow-wrap: anywhere; }
.config-model-title { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 4px; }
.config-more { position: relative; }
.config-more > summary { cursor: pointer; padding: 8px; color: var(--muted); }
.config-more[open] { flex-basis: 100%; padding: 10px; background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius-sm); }
.config-more .config-field { margin-top: 12px; }
.config-switch { flex-basis: 100%; background: var(--panel-2); border-radius: var(--radius-sm); padding: 14px; }
.config-switch > button { margin-right: 8px; }
.config-form { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--line); }
.config-form > h3 { margin: 0 0 18px; }
.config-form-identity { max-width: 640px; }
.config-check { display: flex; align-items: flex-start; gap: 8px; margin: 14px 0; font-size: 13px; }
.config-check input { flex: 0 0 auto; margin: 4px 0 0; accent-color: var(--accent); }
.config-form-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding-top: 18px; margin-top: 20px; border-top: 1px solid var(--line); }
.config-danger { margin: 22px 0 16px; color: var(--muted); }
.config-danger summary, .config-advanced summary { cursor: pointer; padding: 8px 0; }
.config-danger > button { margin-top: 12px; }
.config-service-row { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 14px; border-bottom: 1px solid var(--line); padding: 20px 0; }
.config-service-row > div:first-child { flex: 1 1 260px; min-width: 0; overflow-wrap: anywhere; }
#endpointEditor { max-width: 680px; }
.config-advanced { margin: 0 0 16px; }
.config-node-row { padding: 20px 0; border-bottom: 1px solid var(--line); }
.config-node-row .config-field { max-width: 540px; }
.config-batch-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 28px; margin: 20px 0; }
.config-batch-people { display: grid; gap: 2px; margin-top: 12px; max-height: 340px; overflow-y: auto; padding-right: 6px; }
.config-batch-people .config-check { margin: 6px 0; }
.config-batch-result { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; padding: 10px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.config-batch-result strong { min-width: 64px; }
.config-batch-result span { flex: 1 1 220px; }
.config-batch-results { margin: 18px 0; }
@media (max-width: 760px) {
  .config-workspace { grid-template-columns: minmax(0, 1fr); }
  .config-directory { border-right: 0; border-bottom: 1px solid var(--line); border-radius: var(--radius) var(--radius) 0 0; padding: 16px; }
  .config-search, #configEmployeeList { display: none; }
  .config-mobile-picker { display: flex; margin: 0; }
  .config-detail { padding: 18px 16px; }
  .config-tabs { gap: 16px; }
  .config-batch-layout { grid-template-columns: minmax(0, 1fr); gap: 18px; }
}
@media (pointer: coarse) {
  #viewLlm button, #viewLlm summary { min-height: 44px; }
  .config-field input:not([type="checkbox"]), .config-field select, .config-field textarea { min-height: 44px; font-size: 16px; }
  .config-check { min-height: 36px; align-items: center; }
}

/* ── 办公区：分组 + 像素工位 ── */
.office-group { margin-top: 12px; }
.office-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  border-bottom: 1px dashed var(--line);
  padding-bottom: 4px;
}
.office-group-name { font-weight: 600; }
/* 流式网格：列数随屏宽自适应，卡片拉伸填满整行（auto-fit：空轨道塌缩，
   成员少的分组行不会出现右侧留白；成员多时卡片趋近 min 宽度）。
   卡片宽度有天花板（max-width）并在轨道内居中 —— 稀疏分组在超宽屏上
   是"工位均匀散布"，而不是拉成离谱的巨卡。 */
.office-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}
.desk {
  width: 100%;
  max-width: 320px;
  justify-self: center;
  position: relative;
  padding: 10px 8px 10px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  text-align: center;
  cursor: pointer;
}
.desk:hover { border-color: var(--hover-line); }
.desk.active { border-color: var(--accent); background: var(--active-bg); }
/* 头像是视觉主体：110px（操作行减半后从 88 加到这里）。线稿脸本身白底圆形；
   自定义图片圆形裁切 + 细描边 */
.desk-avatar { display: block; margin: 4px auto 0; }
/* 自定义头像与线稿脸共用一个盒子：换头像时原地换内容 */
.desk-avatar-box { display: block; margin: 2px auto 0; width: 110px; height: 110px; }
.desk-avatar-box .desk-avatar { margin: 0; width: 100%; height: 100%; }
/* pixelated 只对上传的位图有意义（像素风头像图）；线稿脸 SVG 不需要 */
img.desk-avatar { object-fit: cover; image-rendering: pixelated; border-radius: 50%; border: 2px solid var(--line); }
.llm-row-head .desk-avatar-box { width: 28px; height: 28px; margin: 0; flex: 0 0 auto; }

/* 工位上半部：两栏网格（对应 buildDesk 的结构）——
   第一行左头像右小屏（同行等高，网格轨道天然对齐），
   第二行左名字右状态徽章，第三行「编辑 / 换头像」两个操作按钮。
   头像列 auto 宽（=头像尺寸），小屏吃剩余宽度：窄卡上头像不溢出、小屏不被挤没。 */
.desk-top {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: stretch;
  margin-top: 2px;
}
.desk-top > .desk-avatar-box { margin: 0; justify-self: center; align-self: center; }
/* 忙碌小屏：常驻的迷你终端格。忙时滚屏实时输出（新行锚在底部），
   闲时保留最近一次输出或占位「空闲中」—— 不随忙闲出现/消失，布局不跳。 */
.desk-screen {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  min-width: 0;
  min-height: 0;
  padding: 4px 6px;
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 9px;
  line-height: 14px;
  color: var(--ok);
  overflow: hidden;
  text-align: left;
}
.desk-screen.idle { color: var(--muted); }
.desk-screen-line {
  flex: 0 0 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.desk-screen-line.dim { color: var(--muted); }
/* 名字行：左名字（折行）右状态徽章（不换行，靠右） */
.desk-name {
  display: flex;
  align-items: center;
  min-width: 0;
  font-weight: 600;
  text-align: left;
}
.desk-name-text { word-break: break-word; }
.desk-badges { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; justify-content: flex-end; min-width: 0; }
/* 岗位/节点行在网格里占满整行（名字行与操作行之间） */
.desk-top > .desk-role,
.desk-top > .desk-meta { grid-column: 1 / -1; text-align: center; }
/* 操作行：两个按钮平分整行。
   高度**刻意只给 22px**（原 44px 的一半）—— 省下的那 22px 直接加到头像与
   小屏上，让"看头像 / 看实时输出"这两件真正每天要看的事占更大面积。
   代价是这一行低于 44px 的触控目标建议值，属于有意取舍：这两个按钮是低频
   操作（改名字、换头像），点错了也可以退出重来；而头像与小屏是常驻主体。 */
.desk-actions {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
}
.desk-actions .desk-action { width: 100%; min-height: 22px; font-size: 12px; line-height: 20px; padding: 0 8px; }
.desk-role {
  color: var(--fg);
  opacity: 0.85;
  font-size: 12px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.desk-meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
.desk-group-edit { margin-top: 6px; display: flex; flex-direction: column; gap: 6px; text-align: left; }
.desk-group-edit button { min-height: 0; padding: 4px 8px; font-size: 12px; }
.desk-group-edit input[type="file"] { font-size: 12px; min-height: 0; padding: 4px; width: 100%; }
/* 分组选择器：下拉 + 行内新建输入框 */
.group-picker { display: flex; gap: 6px; flex: 1 1 160px; min-width: 0; }
.group-picker select { flex: 1 1 auto; min-width: 0; }
.group-picker .group-new { flex: 1 1 auto; min-width: 0; }
.desk-group-edit .group-picker { flex-direction: column; flex: 0 0 auto; }
/* 初始提示词 textarea：触控目标 ≥44px，字级与编辑器其余控件一致 */
.desk-group-edit textarea { min-height: 44px; font-size: 12px; }

/* 排序模式的 ↑↓ 小把手（组标题行内 / 工位卡左上角） */
.ord-btns { display: inline-flex; gap: 2px; }
.ord-btns button { min-height: 0; padding: 1px 7px; font-size: 12px; line-height: 1.4; }
/* 组头那支笔：与 ↑↓ 同档的小控件。组头是"管理位"，不是触控主战场，
   所以沿用 .ord-btns 的尺寸约定（命令行的既有取舍），不硬凑 44px。 */
.office-group-head .group-rename { min-width: 0; min-height: 0; padding: 0 6px; font-size: 12px; line-height: 1.6; border-color: transparent; color: var(--muted); }
.office-group-head .group-rename:hover { color: var(--accent); border-color: var(--line); }
/* 行内改名编辑器：占位与只读态同高，避免组头跳动 */
.group-rename-editor { display: inline-flex; align-items: center; gap: 6px; }
/* 提交在途：降透明度而不是禁用输入框（禁用会触发 blur，见 setEditorBusy 的注释） */
.group-rename-editor.busy { opacity: 0.6; }
.group-rename-editor input { width: 160px; min-height: 28px; padding: 2px 8px; font-size: 13px; }
.group-rename-editor button { min-height: 28px; padding: 2px 10px; font-size: 12px; }
.desk .ord-btns { position: absolute; top: 4px; left: 4px; flex-direction: column; }

/* 忙碌徽章：accent 色 + 呼吸动画（双主题都走变量，无需分套） */
.badge.busy { color: var(--accent); border-color: var(--accent); animation: desk-pulse 1.6s ease-in-out infinite; }
/* 疑似卡死：用「警告色 + 不加动画」。忙碌那颗徽章会呼吸（表示"还在动"），
   而卡死恰恰是"不动了"—— 所以它必须一眼看上去跟忙碌不同，而不是更好看。 */
.badge.stall { color: var(--bad); border-color: var(--bad); font-weight: 600; }
.desk-screen-line.stall { color: var(--bad); }
@keyframes desk-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
@media (prefers-reduced-motion: reduce) {
  .badge.busy { animation: none; }
}
/* 未读红点：工位右上角 */
.desk-unread {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 18px;
  height: 18px;
  border-radius: 999px;
  background: var(--bad);
  color: #ffffff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  padding: 0 5px;
  pointer-events: none;
}

/* ── 紧凑密度档：挂在 .office--compact 下，舒适档（默认上面的样式）不动 ──
 *
 * 目标：一屏看到的员工数至少翻倍。做法是缩头像、收间距、砍次要文字
 * （岗位/节点行隐藏），功能元素（忙碌 badge、未读红点、流式小屏、
 * 排序把手）全部保留但等比缩小。
 */
.office--compact .office-group { margin-top: 8px; }
.office--compact .office-group-head { margin-bottom: 4px; padding-bottom: 2px; }
.office--compact .office-grid {
  gap: 8px;
  grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
}
.office--compact .desk {
  padding: 6px 6px 8px;
  border-radius: var(--radius-sm);
  max-width: 200px;
}
.office--compact .desk-avatar-box { width: 62px; height: 62px; margin-top: 0; }
.office--compact .desk-top { gap: 4px 6px; }
.office--compact .desk-name { font-size: 12px; }
.office--compact .desk-badges .badge { font-size: 10px; padding: 0 6px; }
/* 次要信息在紧凑档隐藏：节点名/岗位说明在舒适档看 */
.office--compact .desk-role,
.office--compact .desk-meta { display: none; }
/* 操作按钮同样减半（22px），省下的高度同样归头像与小屏 —— 与舒适档同一取舍 */
.office--compact .desk-actions { gap: 6px; }
.office--compact .desk-actions .desk-action { font-size: 11px; min-height: 22px; line-height: 20px; padding: 0 6px; }
/* 小屏随头像（40px）等高收缩，字号等比缩小 */
.office--compact .desk-screen {
  font-size: 8px;
  line-height: 11px;
  padding: 2px 4px;
}
.office--compact .desk-unread {
  min-width: 14px;
  height: 14px;
  line-height: 14px;
  font-size: 10px;
  padding: 0 4px;
  top: -4px;
  right: -4px;
}
.office--compact .ord-btns button { padding: 0 5px; font-size: 11px; }

ul.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 52vh; overflow: auto; }
ul.list.sessions { max-height: 32vh; }
li.item {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  cursor: pointer;
  background: var(--panel-2);
}
li.item.compact { padding: 6px 8px; }
li.item:hover { border-color: var(--hover-line); }
li.item.active { border-color: var(--accent); background: var(--active-bg); }
li.item .item-top { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
li.item .name { font-weight: 600; word-break: break-word; }
li.item .role { color: var(--fg); opacity: 0.85; margin-top: 2px; word-break: break-word; }
li.item .meta { color: var(--muted); font-size: 12px; margin-top: 2px; word-break: break-all; }
li.empty { color: var(--muted); padding: 6px 2px; border: 1px dashed var(--line); border-radius: var(--radius-sm); }
.badge { font-size: 12px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--line); white-space: nowrap; }
.badge.ok { color: var(--ok); border-color: var(--badge-ok-line); }
.badge.warn { color: var(--warn); border-color: var(--badge-warn-line); }
.badge.bad { color: var(--bad); border-color: var(--badge-bad-line); }
.badge.off { color: var(--muted); }

/* ── 审批中心：员工请求队列 + 详情工作区 ── */
.approval-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.approval-heading #btnReloadApprovals { flex: 0 0 auto; }
.approval-intro { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 6px; color: var(--muted); }
.approval-intro strong { color: var(--fg); font-weight: 600; white-space: nowrap; }
.approval-filters { display: flex; gap: 16px; margin-top: 12px; border-bottom: 1px solid var(--line); }
.approval-filter { position: relative; min-height: 36px; padding: 5px 2px; border: none; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--muted); }
.approval-filter:hover:not(:disabled) { border-bottom-color: var(--hover-line); }
.approval-filter.active { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }
.approval-filter span { margin-left: 5px; color: var(--muted); font-weight: 400; }
.approval-panel { min-width: 0; }
.approval-workspace { display: grid; grid-template-columns: minmax(250px, 320px) minmax(0, 1fr); gap: 12px; align-items: start; margin-top: 12px; }
.approval-queue { min-width: 0; }
.approval-queue-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 0 2px 7px; }
.approval-queue-heading strong { font-size: 13px; font-weight: 600; }
.approval-queue-heading span { color: var(--muted); font-size: 12px; }
.approval-list { display: flex; flex-direction: column; gap: 6px; max-height: 62vh; overflow-y: auto; }
.approval-list li { list-style: none; margin: 0; padding: 0; }
.approval-item-button { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 9px; align-items: start; width: 100%; min-height: 0; padding: 9px; text-align: left; background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius-sm); }
.approval-item-button:hover:not(:disabled) { border-color: var(--accent); }
.approval-item-button.active { background: var(--active-bg); border-color: var(--accent); }
.approval-avatar { display: block; flex: 0 0 auto; margin: 0; width: 44px; height: 44px; }
.approval-avatar .desk-avatar { width: 100%; height: 100%; margin: 0; }
.approval-item-copy { display: block; min-width: 0; }
.approval-item-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
.approval-item-top strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.approval-item-kind { flex: 0 0 auto; color: var(--muted); font-size: 12px; white-space: nowrap; }
.approval-item-title { display: block; margin-top: 2px; color: var(--fg); font-weight: 500; overflow-wrap: anywhere; }
.approval-item-meta { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: 4px; color: var(--muted); font-size: 12px; }
.approval-status { display: inline-flex; align-items: center; gap: 5px; color: var(--warn); white-space: nowrap; }
.approval-status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.approval-status-done { color: var(--muted); }
.approval-empty { display: flex; flex-direction: column; gap: 2px; padding: 12px 10px; border: 1px dashed var(--line); border-radius: var(--radius-sm); color: var(--muted); }
.approval-empty strong { color: var(--fg); font-weight: 500; }
.approval-detail { min-width: 0; padding: 12px; background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius-sm); }
.approval-detail-empty { display: flex; min-height: 180px; flex-direction: column; align-items: center; justify-content: center; gap: 3px; color: var(--muted); text-align: center; }
.approval-detail-empty strong { color: var(--fg); font-weight: 500; }
.approval-detail-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 12px; }
.approval-detail-top > strong { color: var(--fg); font-weight: 600; }
.approval-person { display: flex; align-items: center; gap: 9px; margin-top: 12px; }
.approval-detail .approval-avatar { width: 56px; height: 56px; }
.approval-person-copy { display: flex; min-width: 0; flex-direction: column; }
.approval-person-copy strong { font-weight: 600; }
.approval-person-copy span, .approval-time { color: var(--muted); font-size: 12px; }
.approval-time { margin-left: auto; align-self: flex-start; white-space: nowrap; }
.approval-detail-title { margin: 12px 0 8px; font-size: 16px; line-height: 1.45; font-weight: 600; overflow-wrap: anywhere; }
.approval-request-box { padding: 9px 10px; background: var(--code-bg); border: 1px solid var(--line); border-radius: var(--radius-xs); }
.approval-request-label { color: var(--muted); font-size: 11px; }
.approval-request-value { margin-top: 3px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
.approval-reason { margin: 9px 0 0; color: var(--muted); overflow-wrap: anywhere; }
.approval-reason strong { color: var(--fg); font-weight: 500; }
.approval-task { max-height: 220px; margin: 9px 0 0; padding: 9px 10px; overflow: auto; background: var(--code-bg); border: 1px solid var(--line); border-radius: var(--radius-xs); color: var(--fg); font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.approval-meta-line { display: flex; gap: 10px; margin-top: 7px; font-size: 12px; align-items: baseline; }
.approval-meta-label { flex: 0 0 auto; min-width: 64px; color: var(--muted); }
.approval-meta-value { min-width: 0; color: var(--muted); overflow-wrap: anywhere; }
.approval-actions { margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--line); }
.approval-note { width: 100%; min-height: 38px; }
.approval-action-row { justify-content: flex-end; margin-top: 8px; }
.approval-action-row button { min-width: 76px; }
.approval-question-box { margin-top: 10px; }
.approval-question-box .question { background: var(--panel); }
.approval-question-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.approval-history-note { margin: 12px 0 0; padding-top: 10px; border-top: 1px dashed var(--line); color: var(--muted); overflow-wrap: anywhere; }
.approval-history-note strong { color: var(--fg); font-weight: 500; }
.approval-footnote { margin-top: 9px; color: var(--muted); font-size: 12px; }

@media (max-width: 760px) {
  .approval-workspace { grid-template-columns: minmax(0, 1fr); }
  .approval-detail { order: -1; }
  .approval-list { max-height: none; }
}
@media (max-width: 460px) {
  .approval-intro { align-items: flex-start; flex-direction: column; gap: 2px; }
  .approval-item-button { padding: 7px; }
  .approval-detail { padding: 10px; }
  .approval-time { font-size: 11px; }
  .approval-action-row { justify-content: stretch; }
  .approval-action-row button { flex: 1 1 0; }
}

/* 员工导航属于公共外壳，岗位舞台只排右侧工作区。 */
#viewChatShell {
  position: fixed;
  inset: 0;
  height: 100dvh;
  z-index: 30;
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
  background: var(--bg);
}
#viewChat {
  position: relative;
  isolation: isolate;
  height: 100%;
  max-width: none;
  margin: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}
.chat-nav-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  min-height: 0;
  padding: calc(10px + env(safe-area-inset-top)) 3px calc(10px + env(safe-area-inset-bottom));
  background: var(--panel);
  border-right: 1px solid var(--line);
}
.chat-nav-rail button { width: 44px; min-height: 48px; padding: 6px 2px; border: 0; background: transparent; color: var(--muted); }
.chat-nav-rail button:hover { background: var(--panel-2); color: var(--accent); }
.chat-nav-open, .chat-nav-person { display: flex; flex-direction: column; align-items: center; gap: 5px; font-size: 10px; }
.chat-nav-open { flex: 0 0 auto; }
.chat-nav-open svg { flex: 0 0 auto; }
.chat-nav-people { flex: 1 1 auto; min-height: 0; width: 100%; overflow-y: auto; scrollbar-width: none; display: flex; flex-direction: column; align-items: center; gap: 8px; padding-block: 4px; }
.chat-nav-people::-webkit-scrollbar { display: none; }
.chat-nav-rail .chat-nav-person { position: relative; flex: 0 0 auto; min-height: 60px; border-radius: 10px; transition: background-color 120ms ease, color 120ms ease; }
.chat-nav-rail .chat-nav-person.selected { background: var(--active-bg); color: var(--accent); box-shadow: inset 2px 0 var(--accent); }
.chat-nav-person-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-nav-person .desk-avatar-box { display: flex; width: 30px; height: 30px; margin: 0; }
.chat-nav-person .desk-avatar { width: 100%; height: 100%; margin: 0; }
.chat-nav-person.is-offline .desk-avatar-box { opacity: 0.5; }
.chat-nav-person.is-offline::after { content: ''; position: absolute; right: 6px; top: 28px; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); border: 1px solid var(--panel); }
.chat-nav-backdrop { position: absolute; inset: 0; z-index: 5; background: rgba(0, 0, 0, 0.28); }
#sessionPanel {
  --nav-border: color-mix(in srgb, var(--line) 78%, transparent);
  position: absolute;
  inset: 0 auto 0 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  width: min(320px, calc(100% - 44px));
  height: 100%;
  max-height: none;
  min-width: 0;
  padding: 0;
  overflow: hidden;
  background: var(--panel);
  border-right: 1px solid var(--nav-border);
  border-bottom: 0;
  box-shadow: 12px 0 36px rgba(0, 0, 0, 0.15);
}
.chat-shell.drawer-open > #sessionPanel { animation: employee-nav-in 150ms ease-out both; }
@keyframes employee-nav-in { from { transform: translateX(-100%); } to { transform: translateX(0); } }
.cs-nav-header { display: flex; align-items: flex-start; gap: 4px; flex: 0 0 auto; padding: calc(14px + env(safe-area-inset-top)) 8px 10px 12px; border-bottom: 1px solid var(--nav-border); }
.cs-nav-header .cs-tree-label { flex: 1 1 auto; min-width: 0; }
.cs-nav-close { flex: 0 0 auto; width: 36px; min-height: 36px; padding: 0; border: 0; color: var(--muted); font-size: 26px; }
#sessionList { flex: 1 1 auto; min-height: 0; margin: 0; padding: 12px 10px; overflow-y: auto; overscroll-behavior: contain; }
.cs-nav-footer { flex: 0 0 auto; max-height: 45%; padding: 8px 12px calc(12px + env(safe-area-inset-bottom)); overflow-y: auto; border-top: 1px solid var(--nav-border); }
.chat-shell button:focus-visible, #sessionPanel input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (min-width: 1200px) {
  #viewChatShell { grid-template-columns: clamp(240px, 19vw, 280px) minmax(0, 1fr); }
  #viewChatShell.panel-collapsed { grid-template-columns: 52px minmax(0, 1fr); }
  #viewChatShell:not(.panel-collapsed) > .chat-nav-rail { display: none; }
  #viewChatShell > #sessionPanel { position: relative; inset: auto; grid-column: 1; grid-row: 1; width: 100%; box-shadow: none; }
  #viewChatShell > #viewChat { grid-column: 2; grid-row: 1; }
}
@media (max-width: 640px) {
  #viewChatShell { grid-template-columns: 44px minmax(0, 1fr); }
  .chat-nav-rail { padding-inline: 0; }
  .chat-nav-rail button { width: 40px; }
  #sessionPanel { width: min(320px, calc(100% - 32px)); }
}
@media (prefers-reduced-motion: reduce) {
  .chat-shell.drawer-open > #sessionPanel { animation: none; }
}
/* 顶栏：半透明毛玻璃 */
.chat-top {
  position: sticky;
  top: 0;
  z-index: 2;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  /* 左右内边距吃横屏刘海：iPhone 横屏时 safe-area 在**侧边**，只处理上下会让
     内容（返回键 / 会话按钮）被圆角或刘海压住。先给普通值再给 max()（与本文件
     background 的 var(--panel) → color-mix(...) 是同一套渐进增强写法）：
     不支持 env() 的浏览器看到的是普通值，不会因为整条声明失效而掉成 0。 */
  padding-top: calc(6px + env(safe-area-inset-top));
  padding-right: 8px;
  padding-right: max(8px, env(safe-area-inset-right));
  padding-bottom: 6px;
  padding-left: 8px;
  padding-left: max(8px, env(safe-area-inset-left));
  background: var(--panel);
  background: color-mix(in srgb, var(--panel) 78%, transparent);
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
  backdrop-filter: blur(18px) saturate(1.4);
  border-bottom: 1px solid var(--line);
}
.chat-back {
  flex: 0 0 auto;
  min-width: 44px;
  min-height: 44px;
  padding: 0 8px;
  border: none;
  font-size: 30px;
  line-height: 1;
  color: var(--accent);
}
/* 顶栏的对方区：头像（左） + 名字/状态（右，上下两行）。
 *
 * 为什么用 grid 而不是在外面再包一层 div：名字与状态是既有结构的兄弟节点，包一层就动了
 * 那一块的层级（而这一块被 conversation/秘书页/四宫格三处共用）。grid 让头像跨两行、
 * 文本各占一行，标记一个字节都不用改。
 * 头像为空时（还没选员工）整列收成 0：:empty 直接不显示，连留白都不占。 */
.chat-peer {
  flex: 1 1 auto;
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto;
  align-content: center;
  justify-content: center;
  text-align: center;
}
.chat-peer-avatar { grid-row: 1 / span 2; align-self: center; display: inline-flex; align-items: center; }
.chat-peer-avatar:empty { display: none; }
/* 头像盒复用 .desk-avatar-box（自定义头像与线稿脸同一个盒子），只在这里定尺寸 */
.chat-peer-avatar .desk-avatar-box { width: 30px; height: 30px; margin: 0 8px 0 0; }
.chat-peer-avatar .desk-avatar-box .desk-avatar { width: 100%; height: 100%; margin: 0; }
.chat-peer-name {
  display: block;
  font-weight: 600;
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-peer-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 11px;
  color: var(--muted);
  min-height: 14px;
}
.chat-peer-position { max-width: 24ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-peer-position:empty { display: none; }
.chat-sync-status { color: var(--muted); font-size: 10px; white-space: nowrap; }
.chat-sync-status:empty { display: none; }
.chat-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }
.chat-dot.off { background: var(--muted); }
.chat-dot.busy { background: var(--accent); animation: desk-pulse 1.6s ease-in-out infinite; }
.chat-top-actions { flex: 0 0 auto; display: flex; gap: 4px; }
.chat-top-actions button { min-height: 44px; padding: 4px 12px; }

/* 公共导航中的会话操作。面板位置由 #sessionPanel 统一控制。 */
.chat-sessions {
  flex: 0 0 auto;
  max-height: 45vh;
  overflow-y: auto;
  padding: 8px 12px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.12);
}
.chat-sessions ul.list { max-height: none; }
.cs-tree-label { display: none; }
.cs-new { text-align: center; color: var(--accent); font-weight: 600; }
/* 「＋ 新会话」行下方的命名输入框：留空即不命名 */
.cs-create-input { margin-top: 6px; min-height: 44px; }
/* 会话行右侧的改名铅笔：触控目标 44px，负垂直 margin 避免把紧凑行撑高 */
.cs-edit {
  flex: 0 0 auto;
  min-width: 44px;
  min-height: 44px;
  margin: -8px -2px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 15px;
  line-height: 1;
  border-radius: var(--radius-sm);
  opacity: 0;
}
.cs-edit:hover:not(:disabled) { border: none; color: var(--accent); }
.cs-archive { font-size: 11px; opacity: 0.6; }
.cs-edit:disabled { opacity: 0.35; }
.cs-archives-toggle { min-height: 36px; padding: 4px 8px; font-size: 12px; color: var(--muted); }
ul.cs-archive-sessions { margin: 4px 0; }
li.item:hover .cs-edit, li.item:focus-within .cs-edit { opacity: 1; }
/* 触屏没有 hover：常显但低调 */
@media (hover: none) {
  .cs-edit { opacity: 0.55; }
}
/* 行内改名编辑器：输入框 + 保存键，Enter 提交 / Esc 或失焦取消 */
.cs-rename { display: flex; gap: 6px; align-items: center; }
.cs-rename input { min-height: 44px; }
.cs-rename button { flex: 0 0 auto; min-height: 44px; }
.chat-sessions li.item .item-top .name { flex: 1 1 auto; min-width: 0; }
.chat-advanced { margin-top: 6px; border-top: 1px dashed var(--line); padding-top: 4px; }
.chat-advanced summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 13px;
  min-height: 36px;
  display: flex;
  align-items: center;
}
.chat-advanced input { margin-top: 6px; }
.chat-advanced button { margin-top: 8px; }
.chat-advanced .cs-effective { margin-top: 6px; font-size: 12px; }

/* 消息区：撑满顶栏与输入区之间；桌面消息列居中限宽 760px */
#viewChat .messages {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.messages .empty { margin: auto; color: var(--muted); padding: 24px 16px; text-align: center; }
.chat-latest { display: block; margin: 0 auto 6px; }
.history-error { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; }
.msg { width: 100%; max-width: 760px; margin: 0 auto; display: flex; animation: msg-in 0.18s ease-out; }
.msg.user { justify-content: flex-end; }
.msg.assistant, .msg.tool { justify-content: flex-start; }
.bubble {
  max-width: min(78%, 620px);
  border-radius: var(--radius-bubble);
  padding: 9px 13px;
  font-size: 15px;
  line-height: 1.45;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.msg.user .bubble { background: var(--msg-user-bg); color: var(--msg-user-fg); border-bottom-right-radius: 5px; }
.msg.assistant .bubble { background: var(--msg-assistant-bg); color: var(--fg); border-bottom-left-radius: 5px; }
.bubble-text { white-space: pre-wrap; }
.md-p { margin: 0; }
.md-p + .md-p, .md-list + .md-p, .md-pre + .md-p, .md-p + .md-list, .md-p + .md-pre,
.md-table-wrap + .md-p, .md-p + .md-table-wrap, .md-list + .md-table-wrap, .md-table-wrap + .md-list,
.md-pre + .md-table-wrap, .md-table-wrap + .md-pre { margin-top: 8px; }
.md-list { margin: 4px 0; padding-left: 22px; }
.md-li { margin: 2px 0; }
/* markdown 表格：气泡窄，横向滚动而不是把列挤没。单元格走 textContent，
   边框用已有 --line，不另引颜色。 */
.md-table-wrap { margin: 6px 0; max-width: 100%; overflow-x: auto; }
.bubble > .md-table-wrap:first-child, .board-body > .md-table-wrap:first-child { margin-top: 0; }
.md-table {
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  line-height: 1.4;
}
.md-th, .md-td {
  border: 1px solid var(--line);
  padding: 5px 8px;
  vertical-align: top;
  text-align: left;
  overflow-wrap: anywhere;
}
.md-th { font-weight: 600; background: var(--panel-2); }
.md-align-center { text-align: center; }
.md-align-right { text-align: right; }
.msg.user .md-th, .msg.user .md-td { border-color: rgba(255, 255, 255, 0.28); }
.msg.user .md-th { background: rgba(255, 255, 255, 0.12); }
.md-pre {
  margin: 6px 0;
  padding: 8px 10px;
  background: var(--code-bg);
  border-radius: var(--radius);
  overflow-x: auto;
  white-space: pre;
  font-size: 13px;
}
.md-code { background: var(--code-bg); border-radius: 4px; padding: 1px 5px; font-size: 0.92em; }
.msg.user .md-pre, .msg.user .md-code { background: rgba(255, 255, 255, 0.18); }
/* 未送达的气泡：虚线红边 + 重发入口。刻意不改底色 —— 内容仍是用户写的，
   只是"没送出去"这件事必须说清楚（"看起来发出去了"最误导人）。 */
.msg.user.undelivered .bubble { border: 1px dashed var(--bad); }
.msg-retry { display: flex; justify-content: flex-end; margin-top: 4px; }
.msg-retry button { min-height: 32px; font-size: 12px; padding: 2px 10px; }
/* 排队中（节点离线，指令已进 Hub 的离线邮箱）：黄色虚线，和"未送达"区分开 ——
   前者会被自动送出，后者需要用户决定要不要重发。 */
.msg.user.queued .bubble { border: 1px dashed var(--warn); }
.msg-queued { font-size: 11px; color: var(--warn); text-align: right; margin-top: 2px; }
.md-link { color: var(--accent); text-decoration: underline; word-break: break-all; }
.msg.user .md-link { color: var(--msg-user-fg); }
.employee-file-card {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px 10px;
  width: min(100%, 420px);
  margin: 8px 0;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel-2);
  color: var(--fg);
  text-align: left;
}
.employee-file-icon { font-size: 22px; line-height: 1; }
.employee-file-details { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.employee-file-name { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.employee-file-path, .employee-file-status { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.employee-file-card .employee-file-download { min-height: 36px; white-space: nowrap; }
.employee-file-status { grid-column: 1 / -1; }
.employee-file-status:empty { display: none; }
.employee-file-status.bad { color: var(--bad); }
/* 流式气泡的呼吸光标 */
.cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -0.15em;
  background: currentColor;
  animation: cursor-breathe 1s ease-in-out infinite;
}
@keyframes cursor-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.15; }
}
@keyframes msg-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
/* 工具调用卡片：紧凑一行，点标题展开详情 */
.tool-card {
  max-width: min(78%, 620px);
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: var(--radius-lg);
  padding: 4px 12px;
  font-size: 13px;
  color: var(--muted);
}
.tool-head { display: flex; align-items: center; gap: 8px; min-height: 44px; cursor: pointer; }
.tool-name {
  font-weight: 600;
  color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}
.tool-status { margin-left: auto; font-size: 12px; white-space: nowrap; }
.tool-status.bad { color: var(--bad); }
.tool-detail {
  margin: 0 0 8px;
  padding: 6px 8px;
  background: var(--code-bg);
  border-radius: var(--radius-sm);
  font-size: 12px;
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
/* 回合失败 / 发送失败：内联错误条 */
.err-bar {
  width: 100%;
  background: var(--danger-bg);
  border: 1px solid var(--danger-line);
  color: var(--bad);
  border-radius: var(--radius-lg);
  padding: 8px 12px;
  font-size: 13px;
  word-break: break-word;
}
.err-title { font-weight: 600; }
.err-message, .err-details { margin-top: 6px; }
.err-details summary { cursor: pointer; }
.err-original { margin: 6px 0 0; max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
.sys { color: var(--muted); font-size: 12px; text-align: center; }
/* 员工在等人：交互提示条（审批 / 提问）。
   刻意做成窄条而不是气泡 —— 真正的裁决动作在「审批」面板里，
   对话区只负责说明"卡在哪一步、为什么"。 */
.interaction-note {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  width: 100%;
  background: var(--warn-bg);
  border: 1px solid var(--warn-line);
  border-radius: var(--radius-lg);
  padding: 8px 12px;
  font-size: 13px;
}
.interaction-note.settled {
  background: transparent;
  border-color: var(--line);
  color: var(--muted);
}
.interaction-icon { flex: 0 0 auto; line-height: 1.4; }
.interaction-body { min-width: 0; }
.interaction-title { font-weight: 600; word-break: break-word; }
.interaction-reason { margin-top: 2px; color: var(--muted); word-break: break-word; }
.interaction-hint { margin-top: 2px; color: var(--muted); font-size: 12px; }
/* 待发附件条：贴在输入框上方，显示"这条指令会带哪些文件"。
   横向可滚动，手机上不换行挤压输入区。 */
.attach-strip {
  display: flex;
  gap: 6px;
  align-items: center;
  overflow-x: auto;
  padding: 6px 2px 0;
  font-size: 12px;
}
.attach-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px 4px 3px 10px;
  background: var(--panel, transparent);
  max-width: 60vw;
}
.attach-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attach-size { color: var(--muted); }
.attach-remove {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 999px;
}
.attach-remove:hover { color: var(--bad); }
.attach-hint { flex: 0 0 auto; color: var(--muted); }
/* 附件键：emoji 内容只有 ~18px 宽，实测它因此只有 34px（<44px 触控下限）——
   显式给足 min-width，别再靠内容撑。 */
.chat-attach { flex: 0 0 auto; font-size: 16px; padding: 0 8px; min-width: 44px; min-height: 44px; }
/* 拖入文件时给整个对话区一个可见的落点提示 */
#chat.dragging { outline: 2px dashed var(--primary, var(--accent)); outline-offset: -6px; }
/* 提问卡片：每个问题一块，选项按行排，附一个自由文本兜底 */
.question {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 8px 10px;
  margin: 6px 0;
}
.question-header { font-size: 12px; color: var(--muted); }
.question-text { font-weight: 600; white-space: pre-wrap; word-break: break-word; }
.question-detail { margin-top: 2px; color: var(--muted); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.question-option { display: flex; gap: 6px; align-items: baseline; margin-top: 6px; }
.question-option-label { word-break: break-word; }
.question-option-desc { color: var(--muted); font-size: 12px; }
.question-custom {
  margin-top: 6px;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: transparent;
  color: inherit;
}
/* 消息区顶部的「加载更早记录」入口：整行居中的 ghost 小字，触控目标仍 ≥44px */
.history-more { display: flex; justify-content: center; padding: 2px 0 6px; }
.history-more-btn {
  min-height: 44px;
  padding: 0 16px;
  border-radius: 22px;
  border-color: transparent;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.history-more-btn:hover:not(:disabled) { border-color: var(--line); color: var(--accent); }
.history-more-btn:disabled { opacity: 0.6; cursor: default; }
/* 输入区贴底：胶囊 textarea + 圆形发送键；手机吃 safe-area（含横屏的左右刘海） */
.composer {
  flex: 0 0 auto;
  padding-top: 8px;
  padding-right: 12px;
  padding-right: max(12px, env(safe-area-inset-right));
  padding-bottom: calc(8px + env(safe-area-inset-bottom));
  padding-left: 12px;
  padding-left: max(12px, env(safe-area-inset-left));
}
.composer-inner { max-width: 760px; margin: 0 auto; display: flex; align-items: flex-end; gap: 8px; }
.composer textarea {
  flex: 1 1 auto;
  width: auto;
  border-radius: 22px;
  padding: 11px 16px;
  min-height: 44px;
  max-height: 132px;
  resize: none;
  line-height: 1.45;
  overflow-y: auto;
}
.chat-send {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  min-height: 44px;
  border-radius: 50%;
  border: none;
  padding: 0;
  font-size: 19px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--msg-user-bg);
  color: var(--msg-user-fg);
}
.chat-send.chat-stop { background: var(--bad); font-size: 13px; }
/* composer 行内、发送键左侧的低调压缩入口：ghost 小字，触控目标仍 ≥44px */
.chat-compact {
  flex: 0 0 auto;
  min-width: 44px;
  min-height: 44px;
  padding: 0 10px;
  border-color: transparent;
  border-radius: 22px;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.chat-compact:hover:not(:disabled) { border-color: var(--line); color: var(--accent); }
/* 压缩在途：文字换成菊花（宽度不变，composer 不抖动），配合 disabled 防重复点击 */
.chat-compact.compacting { position: relative; color: transparent; }
.chat-compact.compacting::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 14px;
  height: 14px;
  margin: -8px 0 0 -8px;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: compact-spin 0.8s linear infinite;
}
@keyframes compact-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .msg { animation: none; }
  .cursor { animation: none; }
  .chat-dot.busy { animation: none; }
}
pre, code {
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
}
pre.raw-pre {
  margin: 4px 0 0;
  padding: 6px;
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
pre.task {
  margin: 6px 0 0;
  padding: 6px;
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
input.note { margin-top: 6px; }
code.token {
  display: block;
  margin-top: 6px;
  padding: 8px;
  background: var(--code-bg);
  border: 1px solid var(--warn);
  border-radius: var(--radius-xs);
  word-break: break-all;
  user-select: all;
}
.card.token-card { border-color: var(--warn); background: var(--warn-bg); }
details.debug { color: var(--muted); }
details.debug > summary { cursor: pointer; font-size: 13px; }
/* 可折叠卡片（连接卡等）的 summary 当作卡片标题用 */
details.card > summary { cursor: pointer; font-weight: 600; }
details.card > summary + * { margin-top: 8px; }
.raw-log { max-height: 40vh; overflow: auto; margin-top: 8px; }
.raw-entry { border-top: 1px dashed var(--line); padding-top: 6px; margin-top: 6px; }
.raw-label { font-size: 12px; color: var(--muted); }

.toasts {
  /* 顶部弹出：底部是聊天输入框，不能遮（明暗主题都走变量） */
  position: fixed;
  right: 10px;
  top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: min(92vw, 420px);
  z-index: 50;
}
.toast {
  border: 1px solid var(--line);
  border-left-width: 4px;
  border-radius: var(--radius-sm);
  background: var(--toast-bg);
  padding: 8px 10px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
  cursor: pointer;
}
.toast.ok { border-left-color: var(--ok); }
.toast.info { border-left-color: var(--accent); }
.toast.warn { border-left-color: var(--warn); }
.toast.bad { border-left-color: var(--bad); }
.toast-text { word-break: break-word; }

@media (max-width: 900px) {
  /* 窄屏（手机 / 平板 / 收窄的桌面窗口）上「头像 | 小屏」横排是错的：
     卡片只有 ~110–190px 宽，头像占掉大半，小屏被压成一条细缝 —— 实测 375px 视口下
     161px 卡片：小屏只有 47px 宽（5 个汉字/行），紧凑档 73px（9 个字/行）；
     而小屏（实时输出）才是窄屏上真正要看的东西。
     所以窄屏改成**竖排**（DOM 顺序不变，只靠 grid-template-areas 重排）：
       第 1-2 行：头像占左列、跨两行；右侧上「名字」下「状态徽章」
       第 3 行：  小屏独占整行，吃满卡宽
       之后：    岗位 / 节点 / 操作各占整行
     实测 375px 视口：小屏 143×104（15 字/行 × 7 行）；紧凑档 149×62（18 字/行 × 5 行）。

     名字与徽章**上下排**而不是左右排：左右排时两者共用一个 auto 列，长名字撞上长状态
     会被挤到 9px 宽逐字换行（实测：4 字名字 + 3 字状态，卡高被撑到 289px）；上下排
     则各自拿到整列 ~71px，两个都放得下。 */
  .desk-top {
    grid-template-columns: auto minmax(0, 1fr);
    grid-template-areas:
      "avatar name"
      "avatar badge"
      "screen screen"
      "role   role"
      "meta   meta"
      "act    act";
  }
  .desk-top > .desk-avatar-box { grid-area: avatar; }
  .desk-top > .desk-screen { grid-area: screen; }
  .desk-top > .desk-name { grid-area: name; }
  .desk-top > .desk-badges { grid-area: badge; justify-content: flex-start; }
  .desk-top > .desk-role { grid-area: role; }
  .desk-top > .desk-meta { grid-area: meta; }
  .desk-top > .desk-actions { grid-area: act; }
  /* 头像：竖排后它不再和小屏抢宽度，回到"工牌上的证件照"该有的大小。
     桌面端（>900px）仍是横排 + 110px 主体头像，不动。 */
  .desk-avatar-box { width: 64px; height: 64px; }
  .office--compact .desk-avatar-box { width: 36px; height: 36px; }
  /* 小屏独占整行后要够高，"看实时输出"这件事才成立 */
  .desk-screen { min-height: 104px; }
  .office--compact .desk-screen { min-height: 62px; }
  main.grid { grid-template-columns: minmax(0, 1fr); padding: 10px clamp(6px, 2vw, 12px); }
  ul.list { max-height: 40vh; }
  .h2-actions { justify-content: flex-end; }
  /* 手机上气泡更宽、会话抽屉更高；顶栏与发送键的触控目标 ≥44px 由基础样式保证 */
  .bubble, .tool-card { max-width: 86%; }
  .chat-sessions { max-height: 55vh; }
  .chat-peer-name { font-size: 14px; }
}

/* 紧凑档在窄屏上少两行（岗位/节点本来就 display:none，若仍给它们留轨道，
   grid 的空行不占高度但 gap 照样生效 —— 白扔两个行距） */
@media (max-width: 900px) {
  .office--compact .desk-top {
    grid-template-areas:
      "avatar name"
      "avatar badge"
      "screen screen"
      "act    act";
  }
}

/* 手机（≤640px）：紧凑档 2-3 列、舒适档 2 列；标签页横滑不溢出；授权页收紧 */
@media (max-width: 640px) {
  .office-grid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .office--compact .office-grid { grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); }
  .tabs { overflow-x: auto; }
  .tabs button.tab { white-space: nowrap; }
  /* 一级标签从两个涨到五个，375px 手机上要省着用横向空间：padding 12 → 9px。
     在真控制台里量到的内容宽（375px 视口给标签条 367px）：
       五个标签本体 318px → 省这 30px 后 288px；
       「审批 2 待处理」的胶囊 +72px ⇒ 390px 会溢出，省完 360px 刚好放得下。
     真放不下时（两个计数胶囊同时出现）由上一行的 overflow-x: auto 横滑兜底。 */
  .tabs button.tab { padding: 6px 9px; }
  .auth-card { padding: 14px; }
  .auth-code-row input { font-size: 18px; letter-spacing: 4px; }
  .desk-role { display: none; } /* 手机上两档都砍岗位行，保住卡高 */
}

/* 手机（≤640px）聊天输入区：工具键**搬进会话抽屉**，输入行只留「附件 + 输入框 + 发送」。
 *
 * 实测（Chrome 153，真控制台 + 375px 容器逐项量）：
 *   压缩 82 + 沉淀 82 + 附件 34 + 发送 44 + 4×8 间隙 = 274px 是**定宽不缩**的
 *   （flex:0 0 auto 且 white-space:nowrap），被挤的只有输入框：375px 屏只剩 78px
 *   （去掉 padding ≈3 个汉字），320px 屏只剩 34px 并把整行撑出横向溢出。
 * 而"输入指令"是这屏的主任务，那两个键又是**会话级**低频动作（压缩上下文、把本会话沉淀成技能），
 * 所以它们跟着会话列表走：由 placeChatTools() 在窄屏把 DOM 搬进 #sessionTools，
 * 宽屏搬回输入区（同一批按钮、同一套 event/disabled 状态，不复制第二份）。
 * 结果：375px 下输入框 78px → 247px（≈13 个汉字），输入区高度**仍是 44px**。 */
@media (max-width: 640px) {
  /* iOS 只在输入控件字号 ≥16px 时才不自动放大页面：14px 会让聚焦瞬间整页被放大
     且不会自己还原（"手机上跟电脑不一样"的经典成因之一）。 */
  .composer textarea { font-size: 16px; }
}

/* 窄屏工具槽：桌面端它是空的（按钮在输入区），靠 :empty 收掉占位 */
.chat-session-tools { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.chat-session-tools:empty { display: none; }

/* 宽屏：左侧公共导航之外，普通工作区排「对话 + 员工上下文」。 */
@media (min-width: 1200px) {
  #viewChat {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas:
      "top      aside"
      "messages aside"
      "composer aside";
    width: 100%;
    max-width: none;
    margin: 0;
  }
  #viewChat > .chat-top { grid-area: top; }
  #viewChat > .messages { grid-area: messages; }
  #viewChat > .composer { grid-area: composer; }
  #employeeAside {
    grid-area: aside;
    display: flex !important;
    flex-direction: column;
    gap: 10px;
    height: 100%;
    overflow-y: auto;
    padding: 12px;
    background: var(--panel);
    border-left: 1px solid var(--line);
    font-size: 12px;
  }
  #viewChat .msg, #viewChat .composer-inner { max-width: 860px; }
  #viewChat.aside-collapsed { grid-template-columns: minmax(0, 1fr) 0; }
}

/* ── 中档（641–1199px 且高度 ≥500px）：对话 + 右栏 ──
 *
 * 实测（真机尺寸，见 docs/05 §13.9）：iPad 横屏 1024×768、折叠屏展开 884×1104 在旧规则下
 * **右栏与左栏都拿不到**，退回单栏 —— 而这些宽度其实足够摆"对话 + 右栏"，缺的只是左栏的位置。
 * 所以中档给两栏；左侧员工导航通过公共窄栏打开抽屉。
 * 三栏门槛保持 1200：再窄的话中间列会被挤到 600px 以下，气泡行长反而难读。
 *
 * **高度前提（min-height: 500px）是给横屏手机留的**：844×390 这种"宽够但极矮"的视口，
 * 加上 320px 右栏后输入框从 476px 掉到 266px，而右栏是竖向面板、在 390px 高度里也展不开 ——
 * 赔了对话宽度却没换到信息量。矮屏维持单栏，右栏与按钮都不出现（实测见同处文档）。 */
@media (min-width: 641px) and (max-width: 1199px) and (min-height: 500px) {
  #viewChat {
    display: grid;
    grid-template-columns: minmax(0, 1fr) clamp(240px, 32%, 320px);
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas:
      "top      aside"
      "messages aside"
      "composer aside";
    width: 100%;
    max-width: none;
    margin: 0;
  }
  #viewChat > .chat-top { grid-area: top; }
  #viewChat > .messages { grid-area: messages; }
  #viewChat > .composer { grid-area: composer; }
  #employeeAside {
    grid-area: aside;
    display: flex !important;
    flex-direction: column;
    gap: 10px;
    height: 100%;
    overflow-y: auto;
    padding: 12px;
    background: var(--panel);
    border-left: 1px solid var(--line);
    font-size: 12px;
  }
  #viewChat.aside-collapsed { grid-template-columns: minmax(0, 1fr) 0; }
}

/* ── 左右两栏折叠（各档通用）──
 *
 * 折叠状态是 #viewChat 上的一个类（JS 只切类 + 存 localStorage，偏好按设备走 ——
 * "我这块屏幕要不要常驻这一栏"是设备属性，不是办公室的共享事实）。
 * 窄屏（≤640px）本来就摆不下右栏，所以折叠按钮也藏起来：不给一个按了没用/没意义的按钮。 */
#viewChat.aside-collapsed > #employeeAside { display: none !important; }
#btnAside { display: none; }
/* 与中档两栏同一个前提：够宽**且**够高。横屏手机（844×390）不给按钮 ——
   给了也只会把对话挤窄，还会让人以为右栏本该在那儿。 */
@media (min-width: 641px) and (min-height: 500px) {
  /* 用 inline-block，**不能用 inline-flex**。给 button 设 flex 会把浏览器自带的
     "内容居中盒"换掉（button 的内容默认装在一个 align-items:center 的匿名盒里），
     于是文字贴到顶部。实测（1440px，量的文字行盒中心与按钮盒中心的差）：
       inline-flex → 文字比中心高 6.5px      inline-block → 差 0.34px（与「新会话」一致）
     同一行的按钮本来就是 inline-block（在 flex 行里被块化成 block），跟着它走最稳。 */
  #btnAside { display: inline-block; }
}
/* 四宫格那两页（layout-quad / layout-quad-chat）的右栏是**恒隐藏**的
   （各自写着 > #employeeAside { display: none !important }），「上下文栏折叠」在那里
   点了不会有任何变化 —— 秘书页早按"不给死键"把按钮藏了，这两页是漏的，一并补上。 */
#viewChat[class*="layout-"] > .chat-top #btnAside { display: none; }
/* ══════════ 秘书页外壳（岗位 layout="secretary"）══════════
 *
 * 只换**外壳**：气泡区、输入区、会话抽屉、附件、流式、断线提示全部是原来那几个元素，
 * 这里只重新排它们的位置，外加左立绘 + 顶部下拉箭头 + 全屏看板。
 * 手机不再把立绘压在输入框背后，而是给她一个独立的「停靠舞台」；
 * 键盘弹出时舞台缩成一条仍看得到她的窄带，把主要高度让给消息与输入。
 *
 * 立绘现在是占位剪影（.stage-art 里画一个 SVG），真素材到位后换 script/67-secretary.ts 里的
 * 组装逻辑，CSS 不动。 */

/* 默认（非秘书页）：外壳元素一律不出现 —— 别的岗位这一页与从前逐像素相同 */
.secretary-stage, .board-sheet { display: none; }
.board-pull { display: none; }

/* 秘书页：≥960px 两栏（左立绘 38% / 右对话 62%） */
#viewChat.layout-secretary {
  display: grid;
  grid-template-columns: minmax(0, 38fr) minmax(0, 62fr);
  /* 员工导航在外层，舞台与对话保持独立布局。 */
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  grid-template-areas:
    "top top"
    "stage pull"
    "stage messages"
    "stage composer";
  width: 100%;
  max-width: none;
  margin: 0;
  gap: 0;
}
#viewChat.layout-secretary > .secretary-stage { grid-area: stage; display: flex; flex-direction: column; }
#viewChat.layout-secretary > .board-pull { grid-area: pull; display: inline-flex; }
/* 顶栏（返回办公区 / 新会话）在秘书页**必须留着** ——
   实测踩过：一开始把它隐掉，结果这一页进得去出不来（返回按钮就在它里面）。
   它和下拉箭头各占一行：顶栏在上、箭头在下。 */
#viewChat.layout-secretary > .chat-top { grid-area: top; border-bottom: none; }
/* 秘书页右栏是收起的（信息进全屏看板），所以"上下文"开关在这里没有作用 —— 不给死键 */
#viewChat.layout-secretary > .chat-top #btnAside { display: none; }
#viewChat.layout-secretary > .messages { grid-area: messages; }
#viewChat.layout-secretary > .composer { grid-area: composer; }
/* 秘书页不吃右栏那一套栅格：右栏信息进全屏看板，不进这一页的右列 */
#viewChat.layout-secretary > #employeeAside { display: none !important; }
/* 立绘列 —— 一张**白色画布**（两种主题都是白的）
 *
 * 为什么不做"透明立绘浮在主题色上"：素材是**黑白线稿**（实测人物像素 0% 有彩度、
 * 9.3% 近黑线条 + 84.4% 近白），抠掉白底后黑线落在夜间舞台（#161a22）上
 * 对比度只有 **1.2:1** —— 等于什么都看不见（用户原话：「夜间模式啥也看不到了」）。
 * 保留白底则日/夜都是 **8.5:1**。所以这一列是本页里唯一**不跟随主题**的区域：
 * 它是"画布"，不是"面板"。边界靠右侧一条 1px 分隔线与轻微的纸感内阴影交代，
 * 让白底看起来是**故意的**，而不是漏出来的一块白。
 */
.secretary-stage {
  position: relative;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  padding: 12px 8px 0;
  border-right: 1px solid var(--line);
  background: #ffffff;
  box-shadow: inset -10px 0 18px -14px rgba(0, 0, 0, 0.45);
}
.stage-art {
  position: relative;
  width: min(100%, 420px);
  aspect-ratio: 2 / 3;
  max-height: 70vh;
  /* 状态切换时旧立绘暂存在这里，避免新 WebP 解码期间出现白闪。 */
  background-position: center bottom;
  background-repeat: no-repeat;
  background-size: contain;
}
/* 立绘：素材是"每状态一张完整图"（2:3 画布），contain 保证切图时不变形、不跳。
   stage-img-enter 与 stage-img-ready 是一次性过渡类，动图自己的帧播放仍由 WebP 负责。 */
/* 呼吸：**不占帧**的"活着"感 —— 立绘本身是一条 2.9 秒的眨眼循环，
   如果整幅完全静止，看起来还是一张图在闪。这里用 CSS 让整幅极慢地上下浮 5px（4.2s 一循环），
   眨眼的动图与呼吸的位移互不干扰；关掉动效的人两样都停。 */
.stage-art .stage-img {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  opacity: 1;
  transition: opacity 220ms ease-out;
  animation: stage-breathe 4.2s ease-in-out infinite;
}
.stage-art .stage-img.stage-img-enter { opacity: 0; }
.stage-art .stage-img.stage-img-ready { opacity: 1; }
.stage-art.is-switching .stage-img { will-change: opacity, transform; }
@keyframes stage-breathe {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-5px); }
}
.stage-art .stage-placeholder { width: 100%; height: 100%; }
.stage-art[data-stage="notify"] .stage-img { animation-duration: 3.4s; }
.stage-art[data-stage="thinking"] .stage-img,
.stage-art[data-stage="speaking"] .stage-img { animation-duration: 3.8s; }
.stage-art[data-stage="standby"] .stage-img { animation-duration: 6.2s; }
.stage-art svg { width: 100%; height: 100%; display: block; }
.stage-note { margin-top: 4px; color: var(--muted); font-size: 11px; text-align: center; }
.stage-plate {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 6px;
  font-size: 13px;
  color: var(--muted);
}
.stage-plate #stageName { color: var(--fg); font-weight: 600; }
.stage-plate .stage-state { font-size: 12px; }

/* 顶部下拉箭头：居中的一条窄带，点它把看板拉下来 */
.board-pull {
  grid-area: pull;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  min-height: 34px;
  border: none;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
}
.board-pull:hover:not(:disabled) { color: var(--accent); border-bottom-color: var(--accent); }
.board-pull .board-arrow { font-size: 11px; }
.board-pull .board-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--bad);
}
.board-pull .board-dot.hidden { display: none; }

/* 上次结论：像浅夏递来的一张案头简报，而不是另一个空白后台页面。
   手机覆盖工作区并保留员工导航入口；桌面端 ≥960px 只覆盖右侧对话列，左侧立绘一直可见。 */
.board-sheet {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--panel-2);
  transform: translateY(-100%);
  transition: transform 220ms ease-out;
}
.board-sheet.open { transform: translateY(0); }
.board-head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 10px 14px;
  background: var(--panel);
  background: color-mix(in srgb, var(--panel) 90%, transparent);
  border-bottom: 1px solid var(--line);
}
.board-heading { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.board-kicker { color: var(--muted); font-size: 11px; line-height: 1.35; letter-spacing: 0.04em; }
.board-head .board-title { margin-top: 1px; color: var(--fg); font-size: 17px; font-weight: 650; line-height: 1.35; }
.board-head .board-meta {
  flex: 0 1 auto;
  max-width: 46%;
  padding: 3px 8px;
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 999px;
}
.board-head .board-meta.warn { color: var(--warn); border-color: var(--badge-warn-line); background: var(--warn-bg); }
.board-head #btnBoardClose { flex: 0 0 auto; min-width: 38px; min-height: 38px; padding: 0; }
.board-scroll {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: clamp(14px, 3vw, 30px);
}
.board-paper {
  --fg: #27231f;
  --muted: #766f66;
  --line: #ddd6cc;
  --code-bg: #f1ece4;
  position: relative;
  width: min(100%, 760px);
  min-height: min(480px, calc(100dvh - 190px));
  margin: 0 auto;
  padding: clamp(24px, 4vw, 46px) clamp(22px, 5vw, 58px) 28px;
  overflow: hidden;
  color: var(--fg);
  background: #fffdf8;
  border: 1px solid #d9d1c6;
  border-radius: 5px;
  box-shadow: 0 18px 46px rgba(42, 34, 24, 0.12), 0 2px 6px rgba(42, 34, 24, 0.08);
  opacity: 0;
  transform: translateY(-6px);
  transition: opacity 160ms ease-out 50ms, transform 180ms ease-out 50ms;
}
.board-sheet.open .board-paper { opacity: 1; transform: translateY(0); }
/* 右上折角只做一点纸张感，不使用玻璃拟态或大装饰。 */
.board-paper::after {
  content: '';
  position: absolute;
  top: -1px;
  right: -1px;
  width: 32px;
  height: 32px;
  background: linear-gradient(225deg, var(--panel-2) 0 49%, #e7dfd4 50% 52%, #f7f2ea 53% 100%);
  border-left: 1px solid #d9d1c6;
  border-bottom: 1px solid #d9d1c6;
}
.board-paper-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 22px;
  padding-bottom: 8px;
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.11em;
  border-bottom: 1px solid var(--line);
}
.board-body { width: 100%; line-height: 1.78; }
.board-body p { margin: 0 0 12px; }
.board-body ul, .board-body ol { margin-top: 8px; margin-bottom: 14px; padding-left: 1.35em; }
.board-body li + li { margin-top: 5px; }
.board-body .md-h {
  position: relative;
  margin-top: 24px;
  padding-left: 13px;
  color: var(--fg);
}
.board-body .md-h::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0.35em;
  width: 3px;
  height: 1em;
  background: #bd554e;
  border-radius: 2px;
}
.board-empty { margin: 18vh auto 0; color: var(--muted); text-align: center; }
.board-empty.bad { color: var(--bad); }
.board-hint { max-width: 520px; margin: 10px auto 0; color: var(--muted); font-size: 12px; text-align: center; }
.board-signature {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 7px;
  margin-top: 34px;
  padding-top: 14px;
  color: var(--muted);
  font-size: 11px;
  border-top: 1px dashed var(--line);
}
.board-signature strong { color: var(--fg); font-size: 13px; font-weight: 600; }
.board-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 9px 14px calc(9px + env(safe-area-inset-bottom));
  background: var(--panel);
  border-top: 1px solid var(--line);
}
.board-actions button { min-height: 40px; }

@media (min-width: 960px) {
  #viewChat.layout-secretary > .board-sheet {
    position: relative;
    inset: auto;
    grid-column: 2;
    grid-row: 2 / -1;
    width: 100%;
    height: 100%;
    border-left: 1px solid var(--line);
    contain: layout paint;
  }
}

/* 平板 / 展开的折叠屏（641–959px）：保留两栏，但把立绘列收窄一点。
   这个宽度已经放得下「她在左、对话在右」，没必要跟手机一起退化成单列。 */
@media (min-width: 641px) and (max-width: 959px) and (min-height: 500px) {
  #viewChat.layout-secretary {
    grid-template-columns: minmax(220px, 34fr) minmax(0, 66fr);
  }
  #viewChat.layout-secretary > .secretary-stage .stage-art {
    width: min(100%, 340px);
    max-height: 64vh;
  }
}

/* 手机或横屏矮屏（≤640px，或 641–959px 且高度不足 500px）：立绘是独立的停靠舞台，
   不再藏在输入框后面。顺序为顶栏 → 结论 → 立绘 → 消息 → 输入，只有消息行吃剩余高度。 */
@media (max-width: 640px), (min-width: 641px) and (max-width: 959px) and (max-height: 499px) {
  #viewChat.layout-secretary {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto auto minmax(0, 1fr) auto;
    grid-template-areas:
      "top"
      "pull"
      "stage"
      "messages"
      "composer";
  }
  #viewChat.layout-secretary > .chat-top #btnNewSession { display: none; }
  #viewChat.layout-secretary > .chat-top .chat-top-actions button { padding-left: 9px; padding-right: 9px; }
  .board-scroll { padding: 10px; }
  .board-paper { min-height: calc(100dvh - 164px); padding: 24px 20px; }
  .board-head .board-meta { max-width: 38%; }
  .board-actions button { flex: 1 1 0; padding-left: 8px; padding-right: 8px; }

  #viewChat.layout-secretary > .secretary-stage {
    grid-area: stage;
    align-self: stretch;
    z-index: auto;
    width: 100%;
    height: clamp(138px, 22dvh, 180px);
    min-height: 0;
    padding: 0;
    overflow: hidden;
    pointer-events: none;
    justify-content: center;
    border-right: none;
    border-bottom: 1px solid var(--line);
    background: #ffffff;
    box-shadow: inset 0 -12px 20px -18px rgba(0, 0, 0, 0.5);
    transition: height 180ms ease-out;
  }
  #viewChat.layout-secretary > .secretary-stage .stage-art {
    width: 100%;
    height: 100%;
    max-height: none;
    aspect-ratio: auto;
    overflow: hidden;
  }
  #viewChat.layout-secretary > .secretary-stage .stage-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center 29%;
  }
  #viewChat.layout-secretary > .secretary-stage .stage-art[data-stage="thinking"] .stage-img,
  #viewChat.layout-secretary > .secretary-stage .stage-art[data-stage="speaking"] .stage-img { object-position: center 34%; }
  #viewChat.layout-secretary > .secretary-stage .stage-art[data-stage="standby"] .stage-img { object-position: center 43%; }
  #viewChat.layout-secretary > .secretary-stage .stage-note {
    position: absolute;
    right: 8px;
    bottom: 7px;
    z-index: 2;
    margin: 0;
    padding: 3px 7px;
    background: rgba(255, 255, 255, 0.9);
    border: 1px solid #ddd;
    border-radius: 999px;
  }
  #viewChat.layout-secretary > .secretary-stage .stage-plate {
    position: absolute;
    left: max(10px, env(safe-area-inset-left));
    bottom: 8px;
    z-index: 2;
    gap: 6px;
    margin: 0;
    padding: 4px 9px;
    color: #68707b;
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid #d9dde3;
    border-radius: 999px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    transition: opacity 120ms ease-out;
  }
  #viewChat.layout-secretary > .secretary-stage .stage-plate #stageName { color: #222831; }
  #viewChat.layout-secretary > .messages {
    z-index: auto;
    min-height: 0;
    padding-top: 10px;
    background: var(--bg);
  }
  #viewChat.layout-secretary .bubble,
  #viewChat.layout-secretary .tool-card { max-width: 90%; }
  #viewChat.layout-secretary > .composer {
    z-index: auto;
    background: var(--panel);
    border-top: 1px solid var(--line);
  }

  /* 输入框聚焦时，键盘会把可视高度吃掉：立绘仍留一条存在感，但主动把空间让给对话。 */
  #viewChat.layout-secretary.secretary-keyboard-open > .secretary-stage { height: 78px; }
  #viewChat.layout-secretary.secretary-keyboard-open > .secretary-stage .stage-img { object-position: center 27%; }
  #viewChat.layout-secretary.secretary-keyboard-open > .secretary-stage .stage-plate { opacity: 0; }
}

/* 立绘不做动效时的降级（见 design/秘书页-设计稿.md §2） */
@media (prefers-reduced-motion: reduce) {
  .board-sheet { transition: none; }
  .board-paper { opacity: 1; transform: none; transition: none; }
  /* 关掉动效的人：呼吸与眨眼都停（眨眼是动图，靠换静态图实现，见 stagePrefersStill） */
  .stage-art .stage-img { animation: none; }
  .stage-art .stage-img { transition-duration: 0ms; }
}

/* 宽屏右栏的内容块（窄屏不渲染这些，故不必放进媒体查询）
 *
 * 四宫格的三个格位**复用同一批 aside-block DOM**（同一个 appendApprovalBlock /
 * appendSkillBlock / 面板注册表），所以样式必须一起覆盖：只写 .chat-aside 的话，
 * 四宫格里的块会变成没有边框、没有间距的一堆文字 —— 不报错，只是看着像坏了。 */
.chat-aside .aside-block, .quad-cell .aside-block { border: 1px solid var(--line); border-radius: var(--radius); padding: 8px 10px; }
.chat-aside .aside-title, .quad-cell .aside-title { font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
.chat-aside .aside-title .badge, .quad-cell .aside-title .badge { font-size: 11px; }
.chat-aside .aside-row, .quad-cell .aside-row { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
.chat-aside .aside-row .k, .quad-cell .aside-row .k { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-aside .aside-row .v, .quad-cell .aside-row .v { flex: 0 0 auto; color: var(--muted); }
.chat-aside .aside-file-download, .quad-cell .aside-file-download { flex: 0 0 auto; min-height: 28px; padding: 2px 7px; font-size: 11px; }
.chat-aside .aside-note, .quad-cell .aside-note { color: var(--muted); line-height: 1.5; }
.chat-aside .aside-warn, .quad-cell .aside-warn { color: var(--warn); line-height: 1.5; }
.chat-aside .aside-bad, .quad-cell .aside-bad { color: var(--bad); line-height: 1.5; }
.chat-aside .aside-role, .quad-cell .aside-role { color: var(--fg); opacity: 0.85; line-height: 1.5; }

/* ══════════ 四宫格外壳（岗位 layout="quad"）══════════
 *
 * 只换**外壳**：气泡区、输入区、会话抽屉、附件、流式、断线提示全部是原来那几个元素，
 * 这里只重新排它们的位置。所以"窄屏降级"也只是把三格收进抽屉 —— 行为一行都不用改。
 *
 * 四格与网格区域的对应（docs/08 §3）：
 *
 *   "top  top"      顶栏全宽：不管在哪一格，"我在跟谁说话 / 她在线吗 / 上下文多少"永远可见
 *   "tl   tr"       ① 当前目标      | ③ 指挥栏
 *   "bl   ss"       ② 下一步        | 会话列表（展开时才占高度，auto 行 → 折起时 0）
 *   "bl   msgs"     ② 下一步        | ④ 对话（消息区，格内滚动）
 *   "bl   composer" ② 下一步        | ④ 对话（输入框，贴底）
 *
 * 会话列表**单独占一行**而不是盖在对话上：展开时把对话往下挤一点点，
 * 气泡不被遮住、也不会把右上的指挥栏顶走（秘书页踩过同样的坑）。
 * 左下跨三行：待办列表天然比目标卡长，给它更多高度。 */

/* 默认（非四宫格）：格位、抽屉、本页皮肤按钮一律不出现 —— 别的岗位这一页与从前逐像素相同 */
.quad-cell, .quad-drawer, .quad-skin-btn { display: none; }

@media (min-width: 960px) {
  #viewChat.layout-quad {
    display: grid;
    /* 左 42 / 右 58：左边是"看"（情报），右边是"干"（裁决、切换会话、下指令） */
    grid-template-columns: minmax(0, 42fr) minmax(0, 58fr);
    /* 指挥区保留下限；员工与会话在外层，不占工作区行高。 */
    grid-template-rows: auto minmax(240px, 1fr) minmax(0, 1fr) auto;
    grid-template-areas:
      "top top"
      "tl  tr"
      "bl  msgs"
      "bl  composer";
    width: 100%;
    max-width: none;
    margin: 0;
    gap: 8px;
    padding: 8px;
  }
  #viewChat.layout-quad > .chat-top { grid-area: top; }
  #viewChat.layout-quad > .messages { grid-area: msgs; }
  #viewChat.layout-quad > .composer { grid-area: composer; }
  #viewChat.layout-quad > .quad-tl { grid-area: tl; display: flex; }
  #viewChat.layout-quad > .quad-bl { grid-area: bl; display: flex; }
  #viewChat.layout-quad > .quad-tr { grid-area: tr; display: flex; }
  /* 格子的通用外观：一格里是若干 aside-block，块自己还有边框，所以格子只用底色与内边距 */
  #viewChat.layout-quad > .quad-cell {
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 4px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    font-size: 12px;
    align-content: start;
  }
  /* 右栏在四宫格里不存在：右上那格已经承担了它的职责（技能/审批都在那里）。
     不藏起来会出现"同一份数据两块地方"，而两块的状态迟早不一致。 */
  #viewChat.layout-quad > #employeeAside { display: none !important; }
  /* 本页皮肤开关（日间 / 作业室）：只在四宫格这一页露出来。窄屏不给 ——
     顶栏在手机上已经排不下更多按钮，而它只是个外观开关（默认日间照样能用）。 */
  #viewChat.layout-quad > .chat-top #btnQuadSkin { display: inline-block; /* 同 #btnAside：inline-flex 会让按钮文字贴顶 */ }
}

/* ── 四宫格的第二种排法：对话占右半边全高（岗位 layout: 'quad-chat'）──
 *
 * 为什么要有它：应急响应是**对话驱动**的岗位（提案、解释、追问都在对话里），
 * 而四宫格把对话压在右下那一格里 —— 实测只占约 1/4 屏。这一排法把对话还给右半边：
 *
 *   "top  top"       顶栏全宽
 *   "side side"      一条次级工具条：专属技能 / 未匹配的审批（都是折起来的一行）
 *   "tl   msgs"      左上 事件台（含时间线） ｜ 右侧整列：对话（跨两行）
 *   "bl   msgs"      左下 处置队列             ｜
 *   "bl   composer"  左下（跨两行）            ｜ 输入框贴底
 *
 * 实测（1280×780 的网格区）：对话（消息区 + 输入框）= 56% 宽 × 约 80% 高 ≈ **45% 屏**，
 * 而四宫格那一版是 58% × 42% ≈ 24%（用户的原话："对话肯定要占半个屏幕，而不能是 1/4 个屏幕"）。
 * 格位、面板、皮肤、窄屏抽屉全部与 quad 共用同一份实现 —— 这里只有网格与那一条工具条不同。 */
@media (min-width: 960px) {
  #viewChat.layout-quad-chat {
    display: grid;
    grid-template-columns: minmax(0, 44fr) minmax(0, 56fr);
    /* 第三行是 auto（= 事件台按内容高度，上限见下面 .quad-tl 的 max-height），
       第四行 1fr 全给**处置队列** —— 要动手的地方才该拿到弹性空间，
       而事件台（时钟/阶段/计数）读一眼就够，不需要跟着长高。 */
    grid-template-rows: auto auto auto minmax(0, 1fr) auto;
    grid-template-areas:
      "top top"
      "side side"
      "tl  msgs"
      "bl  msgs"
      "bl  composer";
    width: 100%;
    max-width: none;
    margin: 0;
    gap: 8px;
    padding: 8px;
  }
  #viewChat.layout-quad-chat > .chat-top { grid-area: top; }
  #viewChat.layout-quad-chat > .messages { grid-area: msgs; }
  #viewChat.layout-quad-chat > .composer { grid-area: composer; }
  #viewChat.layout-quad-chat > .quad-tl {
    grid-area: tl;
    display: flex;
    /* 事件台再长也不许把处置队列挤没：超过这个高度就格内滚动 */
    max-height: min(46vh, 420px);
  }
  #viewChat.layout-quad-chat > .quad-bl { grid-area: bl; display: flex; }
  #viewChat.layout-quad-chat > .quad-cell {
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 4px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    font-size: 12px;
    align-content: start;
  }
  /* 右上那格在这一排法里变成顶栏下的一条次级工具条：
     里面的块都是"折起来的一行"，横着排不跟对话抢高度。
     —— 折的是**列表**，不是问题：技能"有几个有问题"、会话"当前是哪条"都留在这一行上。 */
  #viewChat.layout-quad-chat > .quad-tr {
    grid-area: side;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 10px;
    min-width: 0;
    min-height: 0;
    padding: 3px 8px;
    overflow-x: auto;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    font-size: 12px;
  }
  #viewChat.layout-quad-chat > .quad-tr > .aside-block {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0;
    border: none;
    background: transparent;
  }
  #viewChat.layout-quad-chat > .quad-tr > .aside-block > .aside-title { margin: 0; }
  #viewChat.layout-quad-chat > .quad-tr > .aside-block > .aside-note {
    max-width: 32ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* 没配上步骤的审批（例如一条与任何提案都对不上的 dsh 审批）会落进这一条：
     它是"卡住她"的东西，不许被截断成一格宽度 —— 允许换行、允许变高。 */
  #viewChat.layout-quad-chat > .quad-tr > .aside-block:has(.approval-inline) {
    flex: 1 1 auto;
    flex-wrap: wrap;
  }
  #viewChat.layout-quad-chat > .quad-tr .approval-inline { margin-top: 0; }
  /* 工具条里的时间线：只有一条带子 + 一行计数，宽度给它一段固定值别把会话/技能挤没 */
  /* 工具条里的时间线：一条带子 + 一行计数文字（圆点图例在那里会换行、把工具条撑成三行） */
  #viewChat.layout-quad-chat > .quad-tr .inc-tl-compact { width: clamp(120px, 18vw, 260px); margin-top: 0; }
  #viewChat.layout-quad-chat > .quad-tr .inc-tl-compact i { height: 14px; }
  #viewChat.layout-quad-chat .inc-tl-counts { color: var(--muted); font-size: 11px; white-space: nowrap; }
  /* 右栏在这一排法里同样不存在（职责已经分给左下与那一条工具条） */
  #viewChat.layout-quad-chat > #employeeAside { display: none !important; }
  #viewChat.layout-quad-chat > .chat-top #btnQuadSkin { display: inline-block; /* 同 #btnAside：inline-flex 会让按钮文字贴顶 */ }
}

/* 窄屏（≤959px）：不摆四格（四个都看不清），改成一次摊开一格的抽屉。
   主体永远是对话：抽屉摊开时那格压在消息区上（max-height 46vh），不把对话挤没。 */
@media (max-width: 959px) {
  #viewChat.layout-quad {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto minmax(0, 1fr) auto;
    grid-template-areas:
      "top"
      "drawer"
      "messages"
      "composer";
    width: 100%;
    max-width: none;
    margin: 0;
  }
  #viewChat.layout-quad > .chat-top { grid-area: top; }
  #viewChat.layout-quad > .messages { grid-area: messages; }
  #viewChat.layout-quad > .composer { grid-area: composer; }
  #viewChat.layout-quad > .quad-drawer {
    grid-area: drawer;
    display: flex;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--line);
  }
  #viewChat.layout-quad > .quad-drawer button { flex: 1 1 0; min-height: 32px; font-size: 12px; }
  #viewChat.layout-quad > .quad-drawer button[aria-pressed="true"] {
    background: var(--active-bg);
    border-color: var(--accent);
  }
  #viewChat.layout-quad > .quad-cell { display: none; }
  #viewChat.layout-quad[data-drawer="tl"] > .quad-tl,
  #viewChat.layout-quad[data-drawer="bl"] > .quad-bl,
  #viewChat.layout-quad[data-drawer="tr"] > .quad-tr {
    display: flex;
    flex-direction: column;
    gap: 8px;
    grid-area: messages;
    align-self: start;
    justify-self: stretch;
    z-index: 3;
    max-height: 46vh;
    overflow-y: auto;
    margin: 6px 8px 0;
    padding: 6px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    font-size: 12px;
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.12);
  }
  /* 摊开的那格之下，消息区照常滚动（它是背景，不是被替换掉的） */
  #viewChat.layout-quad > .messages { z-index: 1; }
}

/* ── 格位内容（面板渲染出来的件）── */

/** 分节线（同一格里分两段时用） */
.quad-cell .aside-sep { height: 1px; background: var(--line); margin: 6px 0; }
/** 折叠标题行：整行可点，右侧箭头交代状态 */
.quad-cell .aside-title-fold { cursor: pointer; user-select: none; }
.quad-cell .aside-title-fold:hover { color: var(--accent); }
.quad-cell .fold-chev { margin-left: auto; color: var(--muted); font-size: 12px; }
/** 空态：说明"这里为什么是空的"，与灰色小字区分开（它比小字重要） */
.quad-cell .quad-empty { color: var(--fg); line-height: 1.5; margin: 2px 0 4px; }
/** ① 目标名 */
.quad-cell .quad-target { font-size: 16px; font-weight: 600; margin-bottom: 4px; overflow-wrap: anywhere; }
/** 进度：数字用等宽（"黑白线条的数据感"靠字形与语义色，不靠底色） */
.quad-cell .quad-progress { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.quad-cell .quad-progress-label { color: var(--muted); }
.quad-cell .quad-progress-count { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.quad-cell .quad-bars { display: flex; gap: 2px; margin-top: 4px; }
.quad-cell .quad-bars i { flex: 1 1 0; height: 6px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 2px; }
.quad-cell .quad-bars i.f { background: var(--accent); border-color: var(--accent); }
/** 发现分级：四档并排，严重/高在颜色上分开（一眼看出哪一档在长） */
.quad-cell .quad-sev { display: flex; gap: 4px; }
.quad-cell .quad-sev > div {
  flex: 1 1 0; min-width: 0; text-align: center; padding: 3px 2px;
  background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius-sm);
}
.quad-cell .quad-sev strong { display: block; font-size: 15px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.quad-cell .quad-sev span { font-size: 11px; color: var(--muted); }
.quad-cell .quad-sev .lv1 strong { color: var(--bad); }
.quad-cell .quad-sev .lv2 strong { color: var(--warn); }
/** ② 计划条目：进行中的那条给底色 + 加粗，扫一眼就知道她现在在哪一步 */
.quad-cell .quad-todo { display: flex; gap: 6px; padding: 2px 4px; border-radius: var(--radius-xs); line-height: 1.45; }
.quad-cell .quad-todo.now { background: var(--active-bg); font-weight: 600; }
.quad-cell .quad-todo.done { color: var(--muted); }
.quad-cell .quad-todo-box { flex: 0 0 auto; width: 13px; text-align: center; color: var(--muted); }
.quad-cell .quad-todo.now .quad-todo-box { color: var(--accent); }
.quad-cell .quad-todo-text { min-width: 0; overflow-wrap: anywhere; }
/** ③ 审批行内卡（与审批页那份取数共用，这里只是行内版） */
.quad-cell .approval-inline { border: 1px solid var(--warn); border-radius: var(--radius-sm); padding: 6px 8px; margin-top: 6px; background: var(--panel-2); }
.quad-cell .approval-inline-kind { color: var(--muted); font-size: 11px; }
.quad-cell .approval-inline-text { margin: 2px 0 6px; line-height: 1.45; overflow-wrap: anywhere; }
.quad-cell .approval-inline-act { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.quad-cell .approval-inline-act button { min-height: 28px; padding: 2px 10px; font-size: 12px; }

/* ── 安全监测岗位（同一个外壳，换内容）──
 *
 * 这一页的视觉重点只有两个：**新鲜度**（红/黄/灰点）与**权限边界**（顶部徽章）。
 * 其余一律沿用平台的块、行、小字，不新增组件外观。
 * 宽度预算同四宫格：左列格 522–604px、右列格 722–834px（1280 宽窗口实测）。 */

/* 顶部条上的岗位徽章位：非四宫格岗位这一块永远是空的（不占位置） */
.chat-top-cell { display: none; }
#viewChat.layout-quad > .chat-top .chat-top-cell { display: flex; align-items: center; position: relative; }

/** 权限徽章：平时一句话都不说，只有"声明与生效不符"时才亮红 */
.quad-badge-wrap { display: flex; align-items: center; gap: 4px; min-width: 0; }
.quad-badge {
  font: inherit; font-size: 12px; line-height: 1.45; padding: 1px 9px; border-radius: 999px;
  border: 1px solid var(--line); background: transparent; color: var(--muted); cursor: pointer; white-space: nowrap;
  /* 顶部条是稀缺位置：标签再长也不许把整行推出去（推出去的部分会被裁掉） */
  max-width: 26vw; overflow: hidden; text-overflow: ellipsis;
}
.quad-badge.ok { border-color: var(--ok); color: var(--ok); }
.quad-badge.bad { border-color: var(--bad); color: var(--bad); }
.quad-badge:hover { border-color: var(--accent); color: var(--accent); }
/** 徽章弹层：一张说明卡，不做模态（挡住半格对话还要求先关掉它，比不弹还烦）。
    右对齐贴在徽章右侧：**向左**展开。左对齐时实测在 1280px 窗口里会伸出页面右边缘。 */
.quad-pop {
  position: absolute; top: calc(100% + 8px); right: 0; z-index: 6;
  width: min(470px, calc(100vw - 32px));
  display: flex; flex-direction: column; gap: 6px;
  padding: 9px 11px; background: var(--panel); border: 1px solid var(--line);
  border-radius: var(--radius); box-shadow: 0 10px 28px rgba(16, 21, 29, 0.22);
}
.quad-pop .aside-title { font-weight: 600; display: flex; align-items: baseline; gap: 6px; }
.quad-cap { display: flex; gap: 8px; }
.quad-cap-col { flex: 1 1 0; min-width: 0; padding: 5px 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
.quad-cap-col.can { border-color: var(--ok); }
.quad-cap-col.cannot { border-color: var(--bad); }
.quad-cap-head { color: var(--muted); font-size: 12px; font-weight: 600; margin-bottom: 2px; }
.quad-cap-item { font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
.quad-verdict { padding: 4px 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); font-size: 12px; line-height: 1.5; }
.quad-verdict.ok { border-color: var(--ok); }
.quad-verdict.bad { border-color: var(--bad); color: var(--bad); }
.quad-key { color: var(--muted); font: 11.5px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }

/** 标题行右侧的小字（徽章位留给计数，这里放时间口径） */
.quad-cell .quad-sub { margin-left: auto; color: var(--muted); font-size: 11.5px; font-weight: 400; }

/** ① 哨兵台：在岗 / 中断 / 陈旧 */
.quad-cell .quad-posture {
  display: flex; align-items: flex-start; gap: 6px; flex-wrap: wrap;
  margin: 6px 0 7px; padding: 5px 8px; border: 1px solid var(--line);
  border-radius: var(--radius-sm); background: var(--panel-2);
}
.quad-cell .quad-posture.ok { border-color: var(--ok); }
.quad-cell .quad-posture.warn { border-color: var(--warn); }
.quad-cell .quad-posture.off { border-color: var(--bad); }
.quad-cell .quad-posture > .aside-note { flex: 1 1 100%; }
/** 状态点：四态 + 没跑过。灰点 = 失联/没跑过（不是"正常"，所以不能是绿的） */
.quad-cell .quad-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.quad-cell .quad-dot.ok { background: var(--ok); }
.quad-cell .quad-dot.bad { background: var(--bad); }
.quad-cell .quad-dot.warn, .quad-cell .quad-dot.stale { background: var(--warn); }
.quad-cell .quad-dot.off, .quad-cell .quad-dot.none { background: var(--muted); }
.quad-cell .quad-posture .quad-dot { margin-top: 5px; }
.quad-cell .quad-assets { display: flex; flex-direction: column; gap: 5px; }
.quad-cell .quad-asset {
  display: flex; align-items: flex-start; gap: 7px; min-width: 0;
  padding: 5px 8px; border: 1px solid var(--line); border-radius: var(--radius-sm);
}
.quad-cell .quad-asset .quad-dot { margin-top: 6px; }
.quad-cell .quad-asset-main { flex: 1 1 auto; min-width: 0; }
.quad-cell .quad-asset-name { font-weight: 600; overflow-wrap: anywhere; }
.quad-cell .quad-asset-detail { margin-left: 6px; color: var(--muted); font-size: 11.5px; font-weight: 400; }
.quad-cell .quad-asset-sub { color: var(--muted); font-size: 11.5px; line-height: 1.45; }
/** 证据可信度：自证（黄）/ 可核验（绿）—— 这一页最重要的两个标签 */
.quad-cell .quad-prov {
  flex: 0 0 auto; margin-top: 2px; padding: 0 6px; white-space: nowrap;
  border: 1px solid var(--line); border-radius: 999px; font-size: 10.5px;
}
.quad-cell .quad-prov.self { border-color: var(--warn); color: var(--warn); }
.quad-cell .quad-prov.ext { border-color: var(--ok); color: var(--ok); }
.quad-cell .quad-legend { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; color: var(--muted); font-size: 11px; }
.quad-cell .quad-legend .quad-dot { margin-left: 4px; }

/** ② 异常台账：按钮词表里没有处置动词（这条也写在测试里） */
.quad-cell .quad-cannot {
  margin-bottom: 6px; padding: 6px 8px; background: var(--panel-2); line-height: 1.5;
  border: 1px solid var(--warn); border-radius: var(--radius-sm);
}
.quad-cell .quad-find { margin-top: 5px; padding: 5px 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
.quad-cell .quad-find.high { border-color: var(--bad); }
.quad-cell .quad-find.med { border-color: var(--warn); }
.quad-cell .quad-find.stale { opacity: 0.65; }
.quad-cell .quad-find-head { display: flex; align-items: baseline; gap: 6px; }
.quad-cell .quad-find-title { min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
.quad-cell .quad-find-time {
  flex: 0 0 auto; margin-left: auto; color: var(--muted);
  font: 11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
}
.quad-cell .quad-lv {
  flex: 0 0 auto; padding: 0 5px; border: 1px solid var(--line);
  border-radius: var(--radius-xs); font-size: 11px; color: var(--muted);
}
.quad-cell .quad-lv.critical, .quad-cell .quad-lv.high { border-color: var(--bad); color: var(--bad); }
.quad-cell .quad-lv.medium { border-color: var(--warn); color: var(--warn); }
.quad-cell .quad-find-meta, .quad-cell .quad-find-ev {
  color: var(--muted); font-size: 11.5px; line-height: 1.45; overflow-wrap: anywhere;
}
.quad-cell .quad-find-act { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.quad-cell .quad-find-act button { min-height: 26px; padding: 1px 9px; font-size: 12px; }
.quad-cell .quad-find-note { margin-left: auto; color: var(--muted); font-size: 11px; }

/** ③ 值守记录：轮次带（缺口 = 没跑）+ 与上一轮的差异 */
.quad-cell .quad-track { display: flex; gap: 2px; margin-top: 6px; }
.quad-cell .quad-slot {
  flex: 1 1 0; height: 20px; border: 1px solid var(--line);
  border-radius: 3px; background: var(--panel-2);
}
.quad-cell .quad-slot.ok { background: var(--ok); border-color: var(--ok); opacity: 0.5; }
.quad-cell .quad-slot.bad { background: var(--bad); border-color: var(--bad); }
.quad-cell .quad-slot.miss {
  border-style: dashed;
  background: repeating-linear-gradient(45deg, var(--panel-2) 0 3px, transparent 3px 6px);
}
.quad-cell .quad-slot.due { border-color: var(--accent); }
.quad-cell .quad-diff { display: flex; flex-direction: column; gap: 3px; }
.quad-cell .quad-chg { display: flex; gap: 7px; min-width: 0; font-size: 12.5px; line-height: 1.45; }
.quad-cell .quad-chg-k {
  flex: 0 0 auto; min-width: 62px; color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere;
}
.quad-cell .quad-chg-v { min-width: 0; overflow-wrap: anywhere; }
.quad-cell .quad-chg.new .quad-chg-v { color: var(--bad); }
.quad-cell .quad-chg.up .quad-chg-v { color: var(--warn); }
.quad-cell .quad-chg.same .quad-chg-v { color: var(--muted); }
.quad-cell .quad-same { line-height: 1.5; }

/* 手机上的顶部条：先砍装饰性的皮肤开关，权限徽章留着 ——
   "它能不能自己动手"在这一页比换个皮肤重要。 */
@media (max-width: 640px) {
  #viewChat.layout-quad > .chat-top #btnQuadSkin { display: none; }
  .quad-badge { max-width: 34vw; }
  .quad-pop { width: min(420px, calc(100vw - 24px)); }
}

/* markdown 标题（# ~ ###）—— 渲染成 h3~h5，样式按"正文里的分节"给，
   不跟卡片标题（h2）抢视觉层级；气泡与看板共用这套。 */
.md-h { margin: 12px 0 4px; line-height: 1.4; font-weight: 600; }
.md-h1 { font-size: 16px; }
.md-h2 { font-size: 14px; }
.md-h3 { font-size: 13px; color: var(--muted); }
.md-body > .md-h:first-child, .board-body .md-h:first-child { margin-top: 0; }

/* ── 岗位面板（技能台账：三张图 + 周报归档）──
 *
 * 只在右栏出现，所以不必进媒体查询：右栏本身已经按宽度开关
 * （≥1200px 三栏；641–1199px 且高度 ≥500px 两栏；手机与矮屏没有右栏）。
 *
 * 宽度预算：右栏内容宽约 216–316px（轨道 240–340 减 12px padding ×2，再减块内 10px ×2）。
 * 热力网格要在这个宽度里排下 9 列（1 列名字 + 8 周），所以周列用 1fr、名字列封顶。
 * 下面两处 **8** 与脚本里的 SKILL_WINDOW_WEEKS 必须一致（有测试钉着）。 */
.skill-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) repeat(8, minmax(0, 1fr));
  gap: 2px;
  margin-top: 4px;
}
.skill-cell { min-height: 15px; border-radius: 3px; }
.skill-cell.head { color: var(--muted); font-size: 9px; line-height: 15px; text-align: center; overflow: hidden; }
.skill-cell.name { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: 11px; line-height: 15px; }
.skill-cell.name .skill-new {
  flex: 0 0 auto;
  font-size: 9px;
  line-height: 1;
  padding: 1px 3px;
  border-radius: 3px;
  border: 1px solid var(--accent);
  color: var(--accent);
}
.skill-cell.cell { border: 1px solid transparent; background: var(--panel-2); }
.skill-cell.cell.empty { background: transparent; border-color: var(--line); }
/* 四级蓝阶：不引新颜色，直接用主题里已有的四档（浅色/深色各有一套值） */
.skill-cell.cell.l1 { background: var(--panel-2); }
.skill-cell.cell.l2 { background: var(--primary-bg); }
.skill-cell.cell.l3 { background: var(--primary-line); }
.skill-cell.cell.l4 { background: var(--accent); }
/* 首次出现的那一格是绿框：**深浅**与**新旧**分成两条通道 ——
   挤在同一条通道里（比如"新技能颜色更深"），人眼分不出来。 */
.skill-cell.cell.first { box-shadow: inset 0 0 0 2px var(--ok); }

/* 新鲜度：一根三段条 + 8 周折线 */
.fresh-bar {
  display: flex;
  height: 10px;
  margin-top: 4px;
  border: 1px solid var(--line);
  border-radius: 5px;
  overflow: hidden;
}
.fresh-seg { display: block; height: 100%; }
.fresh-seg.seg-new { background: var(--ok); }
.fresh-seg.seg-deep { background: var(--accent); }
.fresh-seg.seg-rest { background: var(--panel-2); }
.fresh-line { display: block; width: 100%; height: 24px; margin-top: 6px; overflow: visible; }
.fresh-line polyline { fill: none; stroke: var(--accent); stroke-width: 1.5; }
.fresh-line circle { fill: var(--accent); }

/* 新技能首现时间轴：8 格，有点 = 那一周首现了新技能 */
.firstseen-track { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 2px; margin-top: 4px; }
.firstseen-cell { display: flex; flex-direction: column; align-items: center; gap: 3px; }
.firstseen-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--panel-2); border: 1px solid var(--line); }
.firstseen-cell.has .firstseen-dot { background: var(--ok); border-color: var(--ok); }
.firstseen-week { font-size: 9px; color: var(--muted); }
.firstseen-cell.has .firstseen-week { color: var(--fg); }

/* 宽屏（≥1920px）：列更密（min 更大），仍填满整行；卡宽天花板同步放宽 */
@media (min-width: 1920px) {
  .office-grid { grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
  .office--compact .office-grid { grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); }
  .desk { max-width: 380px; }
  .office--compact .desk { max-width: 260px; }
}

/* 审批列表复用工位头像盒的基础样式；在窄屏基础规则会把 .desk-avatar-box 放大，
   这里放在全部通用断点之后，避免头像超过列表网格轨道并压住请求文字。 */
@media (max-width: 900px) {
  .approval-item-button .approval-avatar { width: 44px; height: 44px; }
  .approval-detail .approval-avatar { width: 56px; height: 56px; }
}
@media (max-width: 760px) {
  .create-workspace { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .create-preview-panel { padding: 10px; }
  .create-preview-desk { margin-top: 8px; }
  .create-field-grid { grid-template-columns: minmax(0, 1fr); }
  .create-location-grid .create-field-node { grid-column: auto; }
  .create-actions { align-items: stretch; flex-direction: column; }
  .create-action-buttons { width: 100%; margin-left: 0; }
  .create-action-buttons button { flex: 1 1 0; }
}
@media (max-width: 460px) {
  .create-card > summary { align-items: flex-start; flex-direction: column; gap: 2px; }
  .create-control-line { align-items: stretch; flex-direction: column; }
  .create-control-line button { width: 100%; }
}

/* ── 上下文占用小圈（顶栏，元素 id 是 ctxRing）──
 *
 * 数字全部来自 dsh 推的 session/projection 帧（解析与占用率算法见 script/65-chat.ts）。
 * 渲染上用 conic-gradient 画环、中间挖空成一个圆环，百分比由 --ctx-pct 驱动 ——
 * 这样**不引入 SVG、不引入 canvas**，一个变量换一个角度。
 * 颜色跟随 --accent（主题色），所以日/夜两套主题都不用额外规则。
 * 快满时（≥85%）转成告警色：那是"该压缩了"的唯一提示，不能等它满了才发现。
 */
.chat-peer-status { position: relative; display: inline-flex; align-items: center; gap: 6px; }
.ctx-ring {
  --ctx-pct: 0;
  width: 20px;
  height: 20px;
  /* 全局 button 规则里有 min-height:36px / padding:7px 12px / border ——
     不显式压掉这几条，这个环会被撑成 20×36 的**椭圆**（实测踩到），所以必须清零 */
  min-height: 0;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: conic-gradient(var(--accent) calc(var(--ctx-pct) * 1%), var(--line) 0);
  display: inline-grid;
  place-items: center;
  cursor: pointer;
  position: relative;
}
/* 挖空中心 → 圆环。用 ::before 而不是叠一层子元素：子元素会被按钮的点击区影响 */
.ctx-ring::before {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: var(--panel);
}
/* data-unknown=1 = 适配器没报容量、算不出百分比：画成斜纹，别让它看起来像 0% */
.ctx-ring[data-unknown='1'] {
  background: repeating-conic-gradient(var(--muted) 0deg 6deg, var(--line) 6deg 14deg);
}
.ctx-ring[data-pct='0'][data-unknown='0'] { background: var(--line); }
.ctx-ring.hot { background: conic-gradient(var(--bad, #d9534f) calc(var(--ctx-pct) * 1%), var(--line) 0); }
.ctx-pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 5;
  /* 200px 太窄：右列是"未命中 81.1k · 命中 4.2M · 写入 0"这种长值，
     会把左边标签挤成竖排（实测："累计输入"被折成两行，读起来像两个词）。 */
  min-width: 280px;
  max-width: min(340px, calc(100vw - 24px));
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--panel);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  font-size: 12px;
  line-height: 1.6;
}
.ctx-pop-row { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
/* 标签永远单行（"累计输入"绝不许折成"累计/输入"）；数字那一列右对齐，长了就自己折 */
.ctx-pop-row > span { flex: 0 0 auto; color: var(--muted); white-space: nowrap; }
.ctx-pop-row > b { font-weight: 600; text-align: right; }
.ctx-pop-note { margin-top: 4px; color: var(--muted); font-size: 11px; }
/* 累计用量与"当前占用"分开：一条细线，避免被当成同一个数 */
.ctx-pop-sep { margin: 7px 0 5px; border-top: 1px solid var(--line); }
/* 秘书页顶栏本来就挤（返回/名字/会话/新会话），窄屏把浮层改到右边对齐 */
@media (max-width: 640px) {
  .ctx-pop { left: auto; right: 0; }
}

/* ═══ 办公室（全景）：一间会自己动的屋子 ═══
 *
 * 上一版是等距伪 3D 的立体工位 —— 桌子椅子墙都在，但看着像工程图、点着像报表。
 * 这一版只做一件事：**头像在场地上到处走，点一下他就说句话**。
 * 全部由 DOM + CSS 画出来，没有一张图片（头像用的是员工自己的头像）。
 *
 * 布景只有三层：
 *   1. .room 的底色就是"天色"（四个时段各一层薄薄的罩色，见 data-daypart）；
 *   2. .room-ground 一片椭圆地面 —— 影子落上去，"他站在地上"这件事才成立；
 *   3. .walker 一个人：影子 + 头像 + 状态小灯 + 未读角标 + 说话气泡。
 *
 * 走位是脚本按场地尺寸算好的**绝对像素**（脚本会把它夹在场地内，绝不会走出屋子），
 * 这里只负责"让它动起来"：
 *   --w-x / --w-y        起点
 *   --w-1x/1y … 3x/3y    一圈里的三个相对位移（末尾回到起点，所以是个闭环）
 *   --walk-dur           绕一圈多少秒
 *   --walk-delay         相位（负值 = 他已经在路上了，免得一屋人同时出发）
 * 动画只碰 translate / scale / opacity —— 这三样是合成器管的，
 * 50 个人一起走也不会把主线程拖住（改 left/top 就会）。
 */

.room {
  /* —— 天色与地面：白天一套 —— */
  --scene-sky-1: #eef5ff;
  --scene-sky-2: #dcebfd;
  --scene-ground: rgba(112, 136, 172, 0.16);
  --scene-shadow: rgba(30, 40, 60, 0.2);
  --scene-ring: rgba(255, 255, 255, 0.92);
  --scene-tint: rgba(12, 20, 38, 0);
  --scene-bubble: rgba(255, 255, 255, 0.94);
  --scene-bubble-ink: #1c2637;
  --scene-bubble-edge: rgba(30, 44, 66, 0.14);
  /* 头像尺寸：脚本会按人数覆盖它（人越多越小），这里只是兜底 */
  --walker-av: 48px;

  position: relative;
  overflow: hidden;
  display: block;
  height: min(74vh, 760px);
  min-height: 360px;
  margin: 0;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: linear-gradient(180deg, var(--scene-sky-1) 0%, var(--scene-sky-2) 68%, var(--scene-ground) 100%);
  /* 地板上那点柔和的光：不用图片，一层径向渐变就够 */
  isolation: isolate;
}

/* 夜里 / 黄昏 / 清晨：一层薄罩色盖在天色上。
   用"罩色"而不是换四个底色，是为了让它在浅色主题与深色主题下都能对上（另见 --scene-tint 的两套值）。 */
.room::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: var(--scene-tint);
  transition: background 1.2s ease;
  z-index: 3;
}
.room[data-daypart="dawn"] { --scene-tint: rgba(255, 206, 150, 0.18); }
.room[data-daypart="day"] { --scene-tint: rgba(12, 20, 38, 0); }
.room[data-daypart="dusk"] { --scene-tint: rgba(255, 150, 96, 0.2); }
.room[data-daypart="night"] { --scene-tint: rgba(8, 14, 30, 0.5); }

[data-theme="dark"] .room {
  --scene-sky-1: #1a2334;
  --scene-sky-2: #141b29;
  --scene-ground: rgba(150, 176, 214, 0.1);
  --scene-shadow: rgba(0, 0, 0, 0.42);
  --scene-ring: rgba(226, 236, 252, 0.5);
  --scene-bubble: rgba(28, 38, 55, 0.96);
  --scene-bubble-ink: #e9eefb;
  --scene-bubble-edge: rgba(150, 176, 214, 0.22);
}
[data-theme="dark"] .room[data-daypart="night"] { --scene-tint: rgba(4, 8, 20, 0.42); }

/* 地面：一片椭圆。头像的影子和它对齐，视觉上"人踩在地上" */
.room-ground {
  position: absolute;
  left: 50%;
  bottom: -6%;
  width: 118%;
  height: 46%;
  transform: translateX(-50%);
  border-radius: 50%;
  background: radial-gradient(closest-side, var(--scene-ground), transparent 72%);
  pointer-events: none;
  z-index: 0;
}

/* 场地：脚本把头像撒在这一层里，坐标就是这一层的像素 */
.room-scene {
  position: absolute;
  inset: 0;
  z-index: 1;
}

/* —— 一个人 —— */
.walker {
  position: absolute;
  left: var(--w-x);
  top: var(--w-y);
  width: 0;
  height: 0;
  cursor: pointer;
  /* 走路：只在 translate 上动。整圈是一个闭环，所以不会"跳"回起点 */
  animation: walk-loop var(--walk-dur, 22s) ease-in-out infinite;
  animation-delay: var(--walk-delay, 0s);
  /* 50 个人同时动画，提示浏览器这一层会被反复变换 */
  will-change: translate;
}
.walker:focus { outline: none; }
.walker:focus-visible .walker-face,
.walker.active .walker-face {
  box-shadow: 0 0 0 3px var(--accent), 0 6px 14px var(--scene-shadow);
}

/* 影子：跟着起伏一起一缩，看着像脚步 */
.walker-shadow {
  position: absolute;
  left: 50%;
  top: calc(var(--walker-av) * 0.42);
  width: calc(var(--walker-av) * 0.74);
  height: calc(var(--walker-av) * 0.24);
  margin-left: calc(var(--walker-av) * -0.37);
  border-radius: 50%;
  background: var(--scene-shadow);
  filter: blur(1px);
  animation: walk-shadow 1.7s ease-in-out infinite;
}

/* 身体：上下轻轻起伏 —— "走"的感觉全在这里。
   刻意用独立的 translate 属性而不是 transform：外层走路也用 translate，
   两层各动各的才不会互相覆盖。 */
.walker-body {
  position: absolute;
  left: calc(var(--walker-av) / -2);
  top: calc(var(--walker-av) / -2);
  display: block;
  animation: walk-bob 1.7s ease-in-out infinite;
}

.walker-face {
  display: block;
  width: var(--walker-av);
  height: var(--walker-av);
  border-radius: 50%;
  background: var(--panel);
  box-shadow: 0 4px 10px var(--scene-shadow), 0 0 0 2px var(--scene-ring);
  transition: box-shadow 0.18s ease;
}
.walker-face .desk-avatar-box {
  margin: 0;
  width: var(--walker-av);
  height: var(--walker-av);
}
.walker-face .desk-avatar-box .desk-avatar {
  margin: 0;
  width: 100%;
  height: 100%;
  border-radius: 50%;
}
.walker:hover .walker-face { box-shadow: 0 0 0 3px var(--accent), 0 8px 16px var(--scene-shadow); }

/* 状态小灯：头像上永久可见的那一颗 —— 忙闲、离线、卡住一眼看全。
   姓名牌会在悬停时才出现（人多了常显会糊成一团），所以"谁怎么样"必须靠这颗灯。 */
.walker-dot {
  position: absolute;
  right: -1px;
  top: -1px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 2px solid var(--panel);
  background: var(--muted);
  box-sizing: border-box;
}
.walker[data-lamp="ok"] .walker-dot { background: var(--ok); }
.walker[data-lamp="busy"] .walker-dot { background: var(--warn); }
.walker[data-lamp="bad"] .walker-dot { background: var(--bad); }
.walker[data-lamp="off"] .walker-dot { background: var(--muted); }
.walker[data-lamp="busy"] .walker-dot { animation: dot-pulse 1.6s ease-in-out infinite; }

/* 未读角标：全屋唯一"要你行动"的信号 */
.walker-badge:empty { display: none; }
.walker-badge {
  position: absolute;
  left: 76%;
  top: -8px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 9px;
  background: var(--bad);
  color: #fff;
  font-size: 11px;
  line-height: 17px;
  font-weight: 700;
  text-align: center;
  box-sizing: border-box;
  animation: badge-pop 0.32s ease-out;
}
.walker[data-pose="call"] .walker-badge { animation: badge-pop 0.32s ease-out, badge-pulse 1.8s ease-in-out 0.32s infinite; }

/* 小道具：Zzz（离线）/ !（卡住）/ ×（工作区没了）。内容由脚本写，这里只给样子 */
.walker-prop:empty { display: none; }
.walker-prop {
  position: absolute;
  right: -6px;
  top: calc(var(--walker-av) * -0.42);
  font-size: 12px;
  font-weight: 700;
  color: var(--muted);
  text-shadow: 0 1px 2px var(--scene-bubble);
  animation: prop-float 2.6s ease-in-out infinite;
}
.walker[data-pose="alert"] .walker-prop { color: var(--bad); animation: prop-shake 0.7s ease-in-out infinite; }
.walker[data-pose="gone"] .walker-prop { color: var(--warn); }

/* 姓名：平时隐身（人多了会糊），悬停 / 键盘聚焦 / 正在说话时才浮出来。
   pointer-events: none 是必须的 —— 否则那块隐形的字会挡住后面的人，点不中。
   （这条是上一版踩过的坑，见 memory/iso-room-hit-region.md） */
.walker-name {
  position: absolute;
  left: 50%;
  top: calc(var(--walker-av) * 0.62);
  transform: translateX(-50%);
  max-width: 11em;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--scene-bubble);
  color: var(--scene-bubble-ink);
  border: 1px solid var(--scene-bubble-edge);
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.16s ease;
  z-index: 2;
}
.walker:hover .walker-name,
.walker:focus-visible .walker-name,
.walker[data-talk="1"] .walker-name { opacity: 1; }

/* —— 说话气泡：这页的主角。
   点一下头像 → 气泡冒出来，里面是一句他此刻"会说"的话（台词表见 ROOM_LINES）。 */
.walker-bubble {
  position: absolute;
  left: 50%;
  bottom: calc(var(--walker-av) * 0.66);
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 84px;
  max-width: 15em;
  padding: 7px 11px 8px;
  border-radius: 14px;
  background: var(--scene-bubble);
  color: var(--scene-bubble-ink);
  border: 1px solid var(--scene-bubble-edge);
  box-shadow: 0 8px 20px var(--scene-shadow);
  transform: translate(-50%, 6px) scale(0.86);
  transform-origin: 50% 100%;
  opacity: 0;
  /* 藏起来的时候决不能挡住别人：pointer-events: none */
  pointer-events: none;
  transition: opacity 0.16s ease, transform 0.2s cubic-bezier(0.22, 1.2, 0.36, 1);
  z-index: 4;
}
/* 气泡底下那个小尖角（一个旋转 45° 的方块） */
.walker-bubble::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: -5px;
  width: 10px;
  height: 10px;
  margin-left: -5px;
  border-radius: 2px;
  background: var(--scene-bubble);
  border-right: 1px solid var(--scene-bubble-edge);
  border-bottom: 1px solid var(--scene-bubble-edge);
  transform: rotate(45deg);
}
.walker[data-talk="1"] .walker-bubble {
  opacity: 1;
  transform: translate(-50%, 0) scale(1);
  pointer-events: auto;
}
.walker[data-talk="1"] { z-index: 9; }

.walker-bubble-head {
  font-size: 11px;
  line-height: 1.4;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.walker-line {
  font-size: 13.5px;
  line-height: 1.5;
  white-space: nowrap;
}

/* 气泡里的"聊两句"：点它才真的进对话。
   为什么不让点头像直接跳转：这一版的点一下是"说句话"（乐趣），
   跳转是"干活"，两者混在一起会让人不敢点。 */
.walker-talk {
  align-self: flex-start;
  margin-top: 3px;
  padding: 2px 9px;
  border: 1px solid var(--scene-bubble-edge);
  border-radius: 999px;
  background: var(--panel);
  color: var(--scene-bubble-ink);
  font-size: 12px;
  line-height: 1.6;
  cursor: pointer;
}
.walker-talk:hover { border-color: var(--accent); color: var(--accent); }

/* —— 状态决定的小动作 ——
   只有"有话说"的状态才动：满屋人一起抽搐比不动更难看。 */
.walker[data-pose="sleep"] { opacity: 0.72; animation-duration: calc(var(--walk-dur, 22s) * 1.6); }
.walker[data-pose="sleep"] .walker-body { animation-duration: 3.4s; }
.walker[data-pose="sleep"] .walker-face { filter: grayscale(0.55); }
.walker[data-pose="gone"] { opacity: 0.6; }
.walker[data-pose="gone"] .walker-face { filter: grayscale(0.8); }
.walker[data-pose="busy"] .walker-body { animation-duration: 1.1s; }
.walker[data-pose="alert"] .walker-face { box-shadow: 0 0 0 3px var(--bad), 0 6px 14px var(--scene-shadow); }
.walker[data-pose="call"] .walker-face { box-shadow: 0 0 0 3px var(--warn), 0 6px 14px var(--scene-shadow); }

/* 空办公室 */
.room-scene > .empty {
  position: absolute;
  left: 50%;
  top: 46%;
  transform: translate(-50%, -50%);
  max-width: 32em;
  text-align: center;
  color: var(--muted);
}

@keyframes walk-loop {
  0% { translate: 0 0; }
  25% { translate: var(--w-1x, 0) var(--w-1y, 0); }
  50% { translate: var(--w-2x, 0) var(--w-2y, 0); }
  75% { translate: var(--w-3x, 0) var(--w-3y, 0); }
  100% { translate: 0 0; }
}
@keyframes walk-bob {
  0%, 100% { translate: 0 0; }
  50% { translate: 0 -5px; }
}
@keyframes walk-shadow {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(0.86); opacity: 0.72; }
}
@keyframes dot-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.22); }
}
@keyframes badge-pop {
  0% { transform: scale(0.5); }
  100% { transform: scale(1); }
}
@keyframes badge-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.18); }
}
@keyframes prop-float {
  0%, 100% { transform: translateY(0); opacity: 0.8; }
  50% { transform: translateY(-4px); opacity: 1; }
}
@keyframes prop-shake {
  0%, 100% { transform: translateX(0); }
  50% { transform: translateX(2px); }
}

/* 窄屏：气泡与姓名牌跟着小一号（场地本身高度已经是 vh，不用担心放不下） */
@media (max-width: 720px) {
  .room { height: min(66vh, 560px); border-radius: 12px; }
  .walker-bubble { max-width: 11em; padding: 6px 9px 7px; }
  .walker-line { font-size: 12.5px; }
  .walker-name { font-size: 11px; }
}

/* 动效敏感的人：全场静止。
   注意这里连"走路"一起停掉 —— 一堆东西在屏幕上飘，正是这类设置要避免的东西。
   （停下之后头像仍然站在原地，位置由 left/top 决定，不依赖动画。） */
@media (prefers-reduced-motion: reduce) {
  .walker,
  .walker-body,
  .walker-shadow,
  .walker-dot,
  .walker-badge,
  .walker-prop {
    animation: none !important;
    translate: none !important;
  }
  .walker-bubble { transition: none; }
  .room::after { transition: none; }
}

/* ══════════ 作业室皮肤：形状与质感（**挂在页面容器上**）══════════
 *
 * 上面 .skin-neon 那批令牌管颜色，这里管**形状与质感**：等宽字体、方角、荧光描边、
 * 扫描线。为什么敢做这一套：全表只有 10 条规则含硬编码颜色，而且大多是**故意不跟主题**的
 * （秘书页那块白画布、案头简报的纸感、白字红底未读徽章）—— 所以不需要"逐个补洞"，
 * 只需要改形状与加质感。
 *
 * 三条纪律：
 *   1. **作用域全部锁在 .skin-neon 子树里**，页面之外（办公区、审批、体检…）一个像素都不动。
 *   2. 扫描线是 pointer-events: none 的浮层，**不能挡点击**（挡了就整页点不动）。
 *   3. 不加任何动画：这是"看日志与证据"的皮肤，动的东西越少越好。

 * 方角由**令牌标尺**统一给（--radius/-sm/-xs/-lg），所以这里不再逐条列举组件 ——
 * 列举会漂，令牌不会。胶囊形徽章（badge/chip/未读点）用的是 999px，那是另一种语义，不动。 */
.skin-neon {
  /* 等宽：数字与英文变"终端"，中文会回落到系统 CJK 字体，所以字号行高不动 */
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace;
  /* 原生件（滚动条、输入框内芯）跟着走，否则黑底上会闪出一块白 —— 那是"没适配"最典型的露馅 */
  color-scheme: dark;
  /* 扫描线的定位基准（下面那条 ::after） */
  position: relative;
  /* ⚠️ 这两条不是装饰，是**必须**的：容器自己的 color/background 是**从 body 继承**来的
     （body 用的是平台主题的令牌）。只重声明令牌不会改掉已经继承下来的 color ——
     实测表现是"深底上写深字"，几乎看不见。所以容器自己也要显式取一次新令牌。 */
  color: var(--fg);
  background: var(--bg);
}
/* 扫描线：整页浮层，不挡点击 */
.skin-neon::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 9;
  background: repeating-linear-gradient(180deg, rgba(53, 240, 160, 0.035) 0 1px, transparent 1px 4px);
}
/* 荧光描边：主要表面带一层内辉光，像屏幕而不是纸 */
.skin-neon .card,
.skin-neon .desk,
.skin-neon .auth-card,
.skin-neon .jobs-stat,
.skin-neon .job-row,
.skin-neon .aside-block,
.skin-neon .quad-cell {
  box-shadow: inset 0 0 26px rgba(53, 240, 160, 0.045), 0 0 0 1px rgba(53, 240, 160, 0.06);
}
/* 选中的工位/会话：用主色描一圈，比底色差更容易一眼看到 */
.skin-neon .desk.active,
.skin-neon .job-row.selected {
  box-shadow: 0 0 0 1px var(--accent), inset 0 0 30px rgba(53, 240, 160, 0.08);
}
/* 上下文小圈"快满"的那档原来写死了一个红（#d9534f），这里收回令牌，跟 --bad 一起管 */
.skin-neon .ctx-ring.hot { --ctx-hot: var(--bad); }

/* ══════════ 统一身份顶栏与默认聊天页舒适度层 ══════════
 *
 * 默认页是每天反复使用的主工作面：信息架构已经稳定，这里只改善阅读节奏与触控反馈。
 * 顶部身份与操作保持一致；消息与输入区的规则限定在默认页，专属岗位保留自己的舞台布局。
 * 形状采用克制的 Apple 风圆角、半透明表面与轻阴影，不引入渐变或装饰性背景。 */
#viewChat:not([class*="layout-"]) {
  --regular-chat-canvas: color-mix(in srgb, var(--bg) 92%, var(--panel-2));
  --regular-chat-surface: color-mix(in srgb, var(--panel) 94%, var(--bg));
  --regular-chat-border: color-mix(in srgb, var(--line) 78%, transparent);
  background: var(--regular-chat-canvas);
}

#viewChat > .chat-top {
  min-height: 58px;
  gap: 10px;
  background: color-mix(in srgb, var(--panel) 86%, transparent);
  border-bottom-color: var(--regular-chat-border, var(--line));
  box-shadow: 0 1px 0 color-mix(in srgb, var(--panel) 70%, transparent), 0 8px 24px rgba(0, 0, 0, 0.045);
}

#viewChat > .chat-top .chat-back {
  border: 1px solid transparent;
  border-radius: 14px;
  background: color-mix(in srgb, var(--panel-2) 72%, transparent);
  color: var(--accent);
  font-size: 26px;
  transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease;
}
#viewChat > .chat-top .chat-back:hover:not(:disabled) {
  border-color: var(--regular-chat-border, var(--line));
  background: var(--panel-2);
}
#viewChat > .chat-top .chat-back:active:not(:disabled) { transform: scale(0.96); }

#viewChat .chat-peer-avatar .desk-avatar-box { width: 36px; height: 36px; margin-right: 10px; }
#viewChat .chat-peer-avatar img.desk-avatar { border-width: 1px; }
#viewChat .chat-peer-name { font-size: 15px; letter-spacing: 0; }
#viewChat .chat-peer { text-align: left; }
#viewChat .chat-peer-status { justify-content: flex-start; gap: 6px; font-size: 12px; min-width: 0; }
#viewChat .chat-peer-status #streamState { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#viewChat .chat-dot { flex: 0 0 auto; width: 8px; height: 8px; }

#viewChat .chat-top-actions { gap: 6px; }
#viewChat .chat-top-actions button {
  border-color: transparent;
  border-radius: 12px;
  background: transparent;
  color: var(--muted);
  transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
}
#viewChat .chat-top-actions button:hover:not(:disabled) {
  border-color: var(--regular-chat-border, var(--line));
  background: color-mix(in srgb, var(--panel-2) 76%, transparent);
  color: var(--fg);
}
#viewChat .chat-top-actions button.primary {
  border-color: color-mix(in srgb, var(--accent) 24%, transparent);
  background: color-mix(in srgb, var(--active-bg) 82%, transparent);
  color: var(--accent);
}

#sessionPanel ul.list { gap: 4px; }
#sessionPanel .cs-tree-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 2px 4px;
  font-size: 13px;
  font-weight: 600;
}
#sessionPanel .cs-tree-label .muted { font-size: 11px; font-weight: 400; line-height: 1.6; }
#sessionPanel .cs-employee { min-width: 0; padding-bottom: 6px; }
#sessionPanel .cs-employee-head {
  display: flex;
  align-items: center;
  border-radius: 10px;
  transition: background-color 140ms ease;
}
#sessionPanel .cs-employee-head:hover { background: var(--panel-2); }
#sessionPanel .cs-employee.selected > .cs-employee-head {
  background: var(--active-bg);
  box-shadow: inset 3px 0 0 var(--accent), inset 0 0 0 1px color-mix(in srgb, var(--accent) 32%, transparent);
}
#sessionPanel .cs-employee.selected .cs-employee-select,
#sessionPanel .cs-employee.selected > .cs-employee-head .cs-employee-toggle { color: var(--accent); }
.cs-current { flex: 0 0 auto; padding: 2px 5px; border-radius: 5px; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); font-size: 10px; visibility: hidden; }
.cs-employee.selected .cs-current { visibility: visible; }
#sessionPanel .cs-employee-head button {
  min-height: 40px;
  border: 0;
  background: transparent;
  box-shadow: none;
}
#sessionPanel .cs-employee-toggle {
  flex: 0 0 30px;
  width: 30px;
  padding: 0;
  color: var(--muted);
  font-size: 20px;
}
#sessionPanel .cs-employee-select {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 8px 6px 0;
  text-align: left;
  font-size: 13px;
  font-weight: 600;
}
#sessionPanel .cs-employee-select .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cs-employee-label { display: flex; align-items: baseline; flex: 1 1 auto; min-width: 0; }
.cs-employee-label .name { min-width: 0; }
.cs-position { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 400; color: var(--muted); }
#sessionPanel .cs-employee-select .badge { flex: 0 0 auto; margin-left: auto; font-size: 10px; }
#sessionPanel ul.cs-employee-sessions {
  margin: 4px 0 0 15px;
  padding-left: 10px;
  border-left: 1px solid var(--nav-border);
  overflow: visible;
}
#sessionPanel .cs-session-notice { padding: 8px; color: var(--muted); font-size: 11px; }
#sessionPanel .cs-session-notice button { padding: 0; min-height: 32px; font-size: inherit; text-align: left; }
#sessionPanel .cs-employee-sessions .cs-new button { width: 100%; min-height: 36px; border: 0; text-align: left; font-size: 12px; color: var(--accent); }
#sessionPanel .cs-employee-sessions .meta { font-size: 10px; }
#sessionPanel li.item {
  border-color: transparent;
  border-radius: 14px;
  padding: 10px 12px;
  background: transparent;
  transition: background-color 140ms ease, box-shadow 140ms ease, color 140ms ease;
}
#sessionPanel li.item:hover {
  border-color: transparent;
  background: color-mix(in srgb, var(--panel-2) 72%, transparent);
}
#sessionPanel li.item.active {
  border-color: transparent;
  background: var(--active-bg);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent);
}
#sessionPanel li.empty {
  border-color: var(--nav-border);
  border-radius: 14px;
  padding: 10px 12px;
}
#sessionPanel .chat-advanced { border-top-style: solid; border-top-color: var(--nav-border); }
#sessionPanel .cs-create-input,
#sessionPanel .chat-advanced input {
  border-color: var(--nav-border);
  background: var(--input-bg);
}

#viewChat:not([class*="layout-"]) > .messages {
  padding: 24px clamp(16px, 3vw, 34px) 18px;
  gap: 8px;
  background: var(--regular-chat-canvas);
}
#viewChat:not([class*="layout-"]) > .messages .empty {
  max-width: 30em;
  padding: 26px 18px;
  line-height: 1.65;
}
#viewChat:not([class*="layout-"]) > .messages .msg {
  max-width: 860px;
  padding-inline: 2px;
}
#viewChat:not([class*="layout-"]) > .messages .bubble {
  max-width: min(78%, 680px);
  border: 1px solid transparent;
  border-radius: 20px;
  padding: 11px 15px;
  line-height: 1.56;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.035);
}
#viewChat:not([class*="layout-"]) > .messages .msg.user .bubble { border-bottom-right-radius: 7px; }
#viewChat:not([class*="layout-"]) > .messages .msg.assistant .bubble {
  border-color: var(--regular-chat-border);
  background: color-mix(in srgb, var(--panel) 96%, var(--bg));
}
#viewChat:not([class*="layout-"]) > .messages .msg.user .bubble {
  box-shadow: 0 4px 14px color-mix(in srgb, var(--msg-user-bg) 22%, transparent);
}
#viewChat:not([class*="layout-"]) > .messages .tool-card,
#viewChat:not([class*="layout-"]) > .messages .interaction-note,
#viewChat:not([class*="layout-"]) > .messages .err-bar {
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.035);
}

#viewChat:not([class*="layout-"]) > .composer {
  padding-top: 12px;
  background: color-mix(in srgb, var(--panel) 78%, transparent);
  border-top: 1px solid var(--regular-chat-border);
}
#viewChat:not([class*="layout-"]) > .composer .composer-inner {
  max-width: 860px;
  gap: 6px;
  padding: 5px 6px 5px 8px;
  border: 1px solid var(--regular-chat-border);
  border-radius: 23px;
  background: var(--panel);
  box-shadow: 0 5px 20px rgba(0, 0, 0, 0.07);
}
#viewChat:not([class*="layout-"]) > .composer textarea {
  min-height: 42px;
  border-color: transparent;
  background: transparent;
  border-radius: 17px;
  padding: 9px 8px;
}
#viewChat:not([class*="layout-"]) > .composer textarea:hover:not(:disabled) { border-color: transparent; }
#viewChat:not([class*="layout-"]) > .composer .chat-attach,
#viewChat:not([class*="layout-"]) > .composer .chat-compact {
  border-color: transparent;
  border-radius: 15px;
  color: var(--muted);
}
#viewChat:not([class*="layout-"]) > .composer .chat-attach:hover:not(:disabled),
#viewChat:not([class*="layout-"]) > .composer .chat-compact:hover:not(:disabled) {
  border-color: transparent;
  background: var(--panel-2);
  color: var(--fg);
}
#viewChat:not([class*="layout-"]) > .composer .chat-send {
  width: 42px;
  height: 42px;
  min-height: 42px;
  box-shadow: 0 3px 9px color-mix(in srgb, var(--msg-user-bg) 30%, transparent);
}
#viewChat:not([class*="layout-"]) > .composer .chat-send.chat-stop { box-shadow: 0 3px 9px color-mix(in srgb, var(--bad) 25%, transparent); }
#viewChat:not([class*="layout-"]) .attach-strip { padding-top: 8px; }

#viewChat:not([class*="layout-"]) > #employeeAside {
  gap: 12px;
  padding: 16px 14px;
  background: color-mix(in srgb, var(--panel) 92%, var(--bg));
  border-left-color: var(--regular-chat-border);
}
#viewChat:not([class*="layout-"]) > #employeeAside .aside-block {
  border-color: transparent;
  border-radius: 16px;
  padding: 12px;
  background: color-mix(in srgb, var(--panel-2) 74%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--line) 60%, transparent);
}
#viewChat:not([class*="layout-"]) > #employeeAside .aside-title { margin-bottom: 8px; font-size: 13px; }
#viewChat:not([class*="layout-"]) > #employeeAside .aside-row { padding: 3px 0; }

#viewChat:not([class*="layout-"]) button:focus-visible,
#viewChat:not([class*="layout-"]) input:focus-visible,
#viewChat:not([class*="layout-"]) textarea:focus-visible,
#viewChat:not([class*="layout-"]) select:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent) 34%, transparent);
  outline-offset: 2px;
}

@media (max-width: 640px) {
  #viewChat > .chat-top {
    min-height: 54px;
    gap: 6px;
    padding-top: calc(6px + env(safe-area-inset-top));
  }
  #viewChat .chat-peer-avatar .desk-avatar-box { width: 32px; height: 32px; margin-right: 8px; }
  #viewChat .chat-peer-name { font-size: 14px; }
  #viewChat .chat-top-actions { gap: 2px; }
  #viewChat .chat-top-actions button { padding-inline: 9px; }
  #viewChat:not([class*="layout-"]) > .messages { padding: 16px 12px 12px; gap: 6px; }
  #viewChat:not([class*="layout-"]) > .messages .msg { padding-inline: 0; }
  #viewChat:not([class*="layout-"]) > .messages .bubble { max-width: 88%; padding: 10px 13px; }
  #viewChat:not([class*="layout-"]) > .composer { padding-top: 8px; }
  #viewChat:not([class*="layout-"]) > .composer .composer-inner { padding: 4px 5px 4px 6px; }
  #viewChat:not([class*="layout-"]) > .composer textarea { min-height: 40px; padding-inline: 7px; }
}

`
