/**
 * 控制台脚本片段：主题切换 / 启动
 *
 * 本段对应原文件的连续行区间，内容与原文件逐字节相同（拆分时用黄金基线比对过）。
 *
 * 为什么拆成文件：这一段原来是 src/web/ui.ts 里那个 8k 行 String.raw 字符串的一部分 ——
 * 单文件没有边界，两个会话并行改会互相踩（真实撞过：edit 被"file changed"打断、提交时
 * 只能按 hunk 挑自己的改动）。拆开后每段各占一个文件，边界就是文件名。
 *
 * 拼接顺序 = 原来的物理顺序，由 ui.ts 里的 CONTROL_UI_SCRIPT 组装；**顺序不能动**：
 * 函数声明会提升，但顶层 var 的赋值不会（state、注册表这类必须在用它的代码之前）。
 */
export const CHUNK_95_THEME_BOOT = String.raw`
/* ─────────────────── 13. 主题（日间 / 夜间） ───────────────────
 *
 * **平台只有两套皮肤**：日间与夜间，一个按钮来回切。作业室（黑底霓虹）不在这里 ——
 * 它是**页面级皮肤**，只挂在岗位外壳 layout: 'quad' 那一页上（见 css.ts 的 .skin-neon
 * 与 68-quad.ts 的开关）。分开的理由就是需求：渗透测试那一页要能"日间 / 作业室"两副面孔，
 * 而办公区、审批、体检、秘书页不该被牵连。 */
function currentTheme() {
  /* 默认日间：用户明确要求浅色为默认，不跟随 prefers-color-scheme。
     认不出来的值（含历史遗留的 'neon'）一律回落日间，不留半套主题。 */
  return readLocal(LS.theme) === 'dark' ? 'dark' : 'light'
}

function applyTheme(theme) {
  var picked = theme === 'dark' ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', picked)
  /* 同步 color-scheme，让滚动条、表单控件等原生件跟随主题 */
  var meta = document.querySelector('meta[name="color-scheme"]')
  if (meta !== null) meta.setAttribute('content', picked)
  /* 按钮文案展示「点击后切到哪边」 */
  var button = $('btnTheme')
  if (button !== null) button.textContent = picked === 'dark' ? '☀️ 日间' : '🌙 夜间'
  writeLocal(LS.theme, picked)
}

function toggleTheme() {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark')
}

/* ─────────────────── 14. 启动 ─────────────────── */

function shouldAutoConnect() {
  /* 默认打开页面就自动连接（自动生成身份、自动申请配对）；
     manual=1 是给排障留的"先别连"开关。 */
  return location.search.indexOf('manual=1') < 0
}

/**
 * 把"本页正在跑的脚本版本"印到所有 [data-ui-version] 上。
 *
 * 服务端在 HTML 里同时写了 data-server-version（HTML 走 no-store，永远是最新的）。
 * 两者不一致 ⇒ 这个页面是**新版 HTML + 旧版脚本**：脚本被浏览器/SW/PWA 缓存冻住了。
 * 这就是"电脑上对、手机上不对"的现场证据，页面上直接自曝，不必再靠肉眼比布局。
 * 旧脚本根本执行不到这里，于是那串默认文案会原地留着 —— 同样是证据。
 */
function renderUiVersion() {
  var nodes = document.querySelectorAll('[data-ui-version]')
  for (var i = 0; i < nodes.length; i += 1) {
    var node = nodes[i]
    var server = String(node.getAttribute('data-server-version') || '')
    var stale = server !== '' && server !== UI_VERSION
    node.textContent = stale
      ? '脚本 ' + UI_VERSION + ' ≠ 服务端 ' + server + '（缓存了旧脚本，刷新即更新）'
      : '脚本 ' + UI_VERSION
    if (stale) node.classList.add('bad')
  }
}

/**
 * 握手里带回来的"服务器当前指纹" vs 本页在跑的指纹 —— 该不该提示（纯函数，便于测试）。
 *
 * 与 renderUiVersion 的区别很关键：那个比的是"本页 HTML 的印章 vs 本页脚本"，能抓到
 * "新版 HTML + 缓存住的旧 JS"；但**部署后开着的标签页 HTML 和 JS 都是旧的、两边相等**，
 * 它一声不响 —— 而这时服务器早就换了一版，用户看到的是"修好了却还是老样子"。
 * 这里比的是服务器**此刻**的指纹，正是那个盲区。
 */
function uiVersionMismatchText(clientVersion, hubVersion) {
  var hub = String(hubVersion === undefined || hubVersion === null ? '' : hubVersion)
  var mine = String(clientVersion === undefined || clientVersion === null ? '' : clientVersion)
  if (hub === '' || mine === '' || hub === mine) return ''
  return (
    '服务器上的控制台已经更新到 ' +
    hub +
    '，这页还在跑 ' +
    mine +
    ' —— 刷新一下（F5 / ⌘R）新功能才会生效。'
  )
}

/** 握手时调用：服务器说指纹对不上，就把印章标红并挂一条看得见的提示。 */
function applyServerUiVersion(hubVersion) {
  var text = uiVersionMismatchText(UI_VERSION, hubVersion)
  if (text === '') return
  var nodes = document.querySelectorAll('[data-ui-version]')
  for (var i = 0; i < nodes.length; i += 1) {
    nodes[i].textContent = '脚本 ' + UI_VERSION + ' ≠ 服务器 ' + String(hubVersion) + '（刷新即更新）'
    nodes[i].classList.add('bad')
  }
  setBanner(text, 'warn')
}

function init() {
  /* PWA 壳：注册 service worker（只做静态壳缓存，不碰 /ws 与 /api）。
     非安全上下文（裸 http://IP）里 API 不存在，静默跳过 */
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    /* 页面此刻是否已被某个 SW 控制：决定下面 controllerchange 是"换代"还是"首次安装" */
    var hadController = navigator.serviceWorker.controller !== null
    /* updateViaCache:'none' —— SW 脚本自身绝不吃 HTTP 缓存，每次上线都要能被取到 */
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(function () {})
    /* SW 换代后自动刷新一次：新 SW 接管（clients.claim）会当场把"新样式 + 旧脚本"
       的错配页面换成一致的，用户不必清缓存、删图标、重装 PWA。
       两个守卫缺一不可：首次安装不刷（那时页面本来就是新的）、且只刷一次防刷新环。 */
    var reloadedForNewWorker = false
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloadedForNewWorker) return
      reloadedForNewWorker = true
      location.reload()
    })
  }

  renderUiVersion()

  /* 主题最先应用：bootstrap 内联脚本可能被 CSP 拦下，这里兜底 */
  applyTheme(currentTheme())
  /* 密度默认紧凑（用户诉求就是信息密度），读过存档就用存档 */
  applyDensity(readLocal(LS.density) === 'comfortable' ? 'comfortable' : 'compact')
  /* 右栏默认展开（宽屏/中档都摆得下），读过存档就用存档 */
  applyAsideVisible(currentAsideVisible())
  /* 左栏同理。常驻左栏只在 ≥1200px 存在，但状态照读不误 —— 窗口从小拖到大时，
     它应该就是上次在大屏上选的那个样子，而不是每次都被重置成展开。 */
  applyPanelVisible(currentPanelVisible())
  loadUnread()
  renderEmployees()
  renderApprovals()
  renderDevices()
  renderSessions()
  clearMessages('（选择员工 → 会话 → 下达指令）')
  bindEvents()
  /* 输入区的两个工具键按屏宽归位（窄屏进会话抽屉、宽屏回输入区）。
     监听窗口尺寸/旋屏而不是只在启动时算一次 —— 手机横竖屏切换与桌面拖窗口都走这里。 */
  placeChatTools()
  if (typeof window.matchMedia === 'function') {
    var toolsQuery = window.matchMedia(CHAT_TOOLS_MOVE_QUERY)
    if (typeof toolsQuery.addEventListener === 'function') {
      toolsQuery.addEventListener('change', function () {
        placeChatTools()
      })
    } else if (typeof toolsQuery.addListener === 'function') {
      /* 老 Safari（≤13）只有已废弃的 addListener */
      toolsQuery.addListener(function () {
        placeChatTools()
      })
    }
  }

  /* 隐藏标签页的定时器会被浏览器节流（实测 10s 轮询在后台 90s 只走一次）。
     不和浏览器对抗：标签页回到前台的瞬间补一轮轮询，让用户看到的永远是新鲜状态 */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') pollDeskStatus()
  })

  /* 原始事件面板默认隐藏：?debug=1 时才需要它 */
  if (location.search.indexOf('debug=1') >= 0) {
    var debugCard = $('cardDebug')
    if (debugCard !== null) debugCard.classList.remove('hidden')
  }

  var presetInput = $('presetInput')
  if (presetInput !== null) presetInput.value = readLocal(LS.preset) || ''

  var lastEmployee = readLocal(LS.lastEmployee)
  if (lastEmployee !== null && lastEmployee !== '') state.selectedEmployeeId = lastEmployee
  setView(readLocal(LS.lastView) || 'office')

  setPhase('idle')
  document.title = 'DSEmployee 控制台 · ' + BOOT.hubName
  state.baseTitle = document.title

  /* 存活性看门狗常开（函数内部按相位自检，空闲时不做事） */
  setInterval(livenessCheck, 5000)

  /* 页面脚本抛出的一切异常都必须看得见：点击处理里抛的异常默认静默，表现成
     "这个按钮是坏的"（审批「通过」按钮踩过这个坑，见 installUiErrorTrap） */
  installUiErrorTrap()

  if (shouldAutoConnect()) {
    setTimeout(function () {
      connectNow()
    }, 200)
  }
}

init()
`
