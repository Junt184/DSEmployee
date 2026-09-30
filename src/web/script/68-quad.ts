/**
 * 控制台脚本片段：四宫格外壳（岗位 `layout: 'quad'`）
 *
 * 本段的边界（为什么这样切）：
 *   · **外壳只管位置与折叠**，内容一律来自两处已有实现：
 *       格位面板 → 80-panels 的注册表（`renderPanelsInto`，与右栏同一条渲染路径）
 *       右上三段 → `appendApprovalBlock` / `toggleSessionPanel` / `appendSkillBlock`
 *     —— 四宫格**不复制**任何取数。复制一份的必然结果是"角标写 1、右栏写 2"这种
 *     没人查得出来的分叉（秘书页那一轮定下的规矩）。
 *   · **对话格（右下）一行不改**：气泡、流式、附件、断线、IME 仍是 65-chat 那一份，
 *     这里只决定它们的位置与高度（见 css.ts 的 `grid-template-areas`）。
 *   · 调用入口只有一个：`applyPositionShell`（67-secretary 里那个）。缺了它就会出现
 *     "岗位配了四宫格、页面还是老样子"，而且不报错。
 *
 * 三个格子的分工（与设计稿 docs/08 一致）：
 *   左上 当前目标 = scope.json（**人写**）+ board.json（**员工写**），控制台只读
 *   左下 下一步   = dsh 的 todos 投影（实时，零维护）+ 上一轮收尾
 *   右上 指挥栏   = 未决审批（行内裁决）+ 会话（折叠栏）+ 专属技能 + 岗位追加面板
 */
export const CHUNK_68_QUAD = String.raw`
/* ═══════════ 9.5 四宫格外壳（岗位 layout: 'quad'）═══════════ */

/** 页面外壳 id：岗位目录里 「layout」 写的就是它 */
var QUAD_LAYOUT = 'quad'
/**
 * 四宫格的第二种排法：**对话占右半边全高**（岗位 layout: 'quad-chat'）。
 *
 * 为什么需要它：应急响应是**对话驱动**的岗位（提案、解释、追问都在对话里），
 * 而四宫格把对话压在右下那一格里（约 1/4 屏）。这一排法只在网格上不同：
 *   左上 事件台 ｜ 右侧整列：对话
 *   左下 处置队列 ｜（会话/技能折成顶栏下的一条）
 * 格位、面板、皮肤、窄屏抽屉全部与 quad 共用同一份实现。
 */
var QUAD_CHAT_LAYOUT = 'quad-chat'
/** 窄屏（≤959px）一次只摊开一格；这个键记的是"摊开哪一格" */
var QUAD_DRAWER_KEY = 'dse.quadDrawer'
/** 窄屏抽屉里允许的格位（右下那格是对话，不参与） */
var QUAD_DRAWER_CELLS = ['tl', 'bl', 'tr']
/**
 * 这一页自己的皮肤：日间 / 作业室。
 *
 * 为什么不做成"第四套主题"：需求是**渗透测试那一页**要能两副面孔，而办公区、审批、
 * 体检、秘书页不该被牵连（它们只有日间/夜间）。所以皮肤挂在 #viewChat 这个子树根上
 * （.skin-neon），令牌在子树里重声明 —— 页面之外一个像素都不动。
 * 偏好按设备记（同右栏折叠的规矩）：这是"我这块屏幕想不想看作战室"，不是共享事实。
 */
var QUAD_SKIN_KEY = 'dse.quadSkin'
var QUAD_SKINS = ['day', 'neon']

function quadCellNodes() {
  return { tl: $('quadTl'), bl: $('quadBl'), tr: $('quadTr'), top: $('quadTop') }
}

/** 三格 + 顶部徽章位都清空（换员工、退出外壳时用；留着上次的 DOM 会在切回来时闪一下旧数据） */
function clearQuadCells() {
  var cells = quadCellNodes()
  if (cells.tl !== null) clear(cells.tl)
  if (cells.bl !== null) clear(cells.bl)
  if (cells.tr !== null) clear(cells.tr)
  if (cells.top !== null) clear(cells.top)
}

/** 这一页此刻是不是四宫格（行为函数只在自己这页生效，别去改别人的页面） */
function quadActive() {
  var chat = $('viewChat')
  return chat !== null && chat.classList.contains('layout-quad')
}

/**
 * 进入四宫格。
 *
 * 为什么要按 employeeId 判"换了员工"：换员工时上一份 scope/board 必须作废，
 * 否则会拿 A 的授权范围画在 B 的页面上 —— 这一格的数据是**安全相关**的，
 * 串味比难看严重得多。
 */
function applyQuadShell(employee) {
  var chat = $('viewChat')
  if (chat === null) return
  var employeeId = String(employee === null || employee === undefined ? '' : employee.id || '')
  if (state.quad === null || typeof state.quad !== 'object') resetQuadState('')
  if (state.quad.employeeId !== employeeId) {
    resetQuadState(employeeId)
    clearQuadCells()
  }
  applyQuadDrawer(state.quad.drawer)
  applyQuadSkin(state.quad.skin)
  renderQuadCells()
  /* 只有这一页真的需要工作区文件时才去读（别的岗位不花这个请求） */
  loadQuadFiles(employeeId)
}

/** 退出四宫格：把状态清干净（下次进来不该看见上次的数字） */
function leaveQuadShell() {
  if (state.quad === null || typeof state.quad !== 'object' || state.quad.employeeId === '') return
  clearQuadCells()
  clearQuadSkin()
  resetQuadState('')
}

function resetQuadState(employeeId) {
  var drawer = readLocal(QUAD_DRAWER_KEY)
  state.quad = {
    employeeId: employeeId,
    scopeResult: null,
    boardResult: null,
    /* 安全监测那两个文件（monitor.json / findings.json）—— 与上面两个同款：
       "还没读"与"读不到"必须分开存，否则页面没法如实说清是哪一种。 */
    monitorResult: null,
    findingsResult: null,
    /* 应急响应那两个文件（incident.json / actions.json）：同款分开存 */
    incidentResult: null,
    actionsResult: null,
    incidentsResult: null,
    /* 处置队列里"已结束的步骤"是否展开（默认收起：格子只有约 382px） */
    incidentDoneOpen: false,
    skillsOpen: false,
    badgeOpen: false,
    drawer: QUAD_DRAWER_CELLS.indexOf(drawer) >= 0 ? drawer : '',
    skin: readLocal(QUAD_SKIN_KEY) === 'neon' ? 'neon' : 'day',
  }
}

/* ── 本页皮肤：日间 / 作业室 ── */

/**
 * 把皮肤应用到这一页，并更新按钮文案（说"点一下会切到哪边"）。
 *
 * 只切 #viewChat 上的一个类：颜色靠令牌级联自动换完，不需要逐个组件改。
 * 退出四宫格时由 clearQuadSkin 摘掉 —— 否则切到别的同事那一页会带着作战室的样子。
 */
function applyQuadSkin(skin) {
  var chat = $('viewChat')
  var want = QUAD_SKINS.indexOf(skin) >= 0 ? skin : 'day'
  if (state.quad !== null && typeof state.quad === 'object') state.quad.skin = want
  writeLocal(QUAD_SKIN_KEY, want)
  if (chat !== null) chat.classList.toggle('skin-neon', want === 'neon')
  var button = $('btnQuadSkin')
  if (button !== null) {
    button.textContent = want === 'neon' ? '☀️ 日间' : '🖥️ 作业室'
    button.title = '这一页的皮肤：' + (want === 'neon' ? '作业室（黑底霓虹）' : '日间') + ' —— 只影响这一页'
    button.setAttribute('aria-pressed', want === 'neon' ? 'true' : 'false')
  }
}

/** 点一下切换（按钮与快捷键共用这一个入口） */
function toggleQuadSkin() {
  applyQuadSkin(state.quad !== null && state.quad.skin === 'neon' ? 'day' : 'neon')
}

/** 离开四宫格那一页：把皮肤摘掉，别的页面不跟着变 */
function clearQuadSkin() {
  var chat = $('viewChat')
  if (chat !== null) chat.classList.remove('skin-neon')
}

/* ── 窄屏抽屉：一次只摊开一格 ── */

/** 设抽屉状态并把标记写到 #viewChat 上（CSS 只看这个属性，不看 JS 状态）。 */
function applyQuadDrawer(cell) {
  var chat = $('viewChat')
  var want = QUAD_DRAWER_CELLS.indexOf(cell) >= 0 ? cell : ''
  if (state.quad !== null && typeof state.quad === 'object') state.quad.drawer = want
  writeLocal(QUAD_DRAWER_KEY, want)
  if (chat === null) return
  if (want === '') chat.removeAttribute('data-drawer')
  else chat.setAttribute('data-drawer', want)
  for (var i = 0; i < QUAD_DRAWER_CELLS.length; i += 1) {
    var key = QUAD_DRAWER_CELLS[i]
    var button = $('quadDrawer_' + key)
    if (button === null) return
    button.setAttribute('aria-pressed', want === key ? 'true' : 'false')
  }
}

/** 点抽屉按钮：同一格再点一次 = 收起（窄屏上"只看对话"要能一键回去） */
function toggleQuadDrawer(cell) {
  applyQuadDrawer(state.quad !== null && state.quad.drawer === cell ? '' : cell)
}

/* ── 渲染 ── */

/** 面板渲染的上下文（格位面板与右栏面板共用一份形状，各取所需）。 */
function quadContext(employee) {
  return {
    employee: employee,
    plan: state.plan,
    scopeResult: state.quad.scopeResult,
    boardResult: state.quad.boardResult,
    monitorResult: state.quad.monitorResult,
    findingsResult: state.quad.findingsResult,
    incidentResult: state.quad.incidentResult,
    actionsResult: state.quad.actionsResult,
    incidentsResult: state.quad.incidentsResult,
  }
}

/** 一格没有可显示的东西时**如实说明**（不编"暂无目标"这种含糊话，也不留白板）。 */
function quadEmptyNote(cell, what) {
  var box = el('div', 'aside-block')
  box.appendChild(el('div', 'aside-title', what))
  box.appendChild(el('div', 'quad-empty', '这个岗位没有给这一格配内容。'))
  box.appendChild(el('div', 'aside-note', '在岗位目录里给 cells.' + cell + ' 填面板 id（见 docs/08）。'))
  return box
}

/**
 * 重画三格（换员工、会话变化、折叠切换、投影帧到达都会调）。
 *
 * 为什么允许"整格重画"而不是增量改：每一格只有几个节点，重画的代价可以忽略，
 * 而增量改要维护"哪个节点对应哪条数据"，是这类页面最常见的错误来源。
 * 唯一必须避免的是重画**对话格** —— 那里的滚动位置与输入焦点是用户的，不能碰。
 */
function renderQuadCells() {
  if (!quadActive()) return
  var cells = quadCellNodes()
  var employee = employeeById(state.selectedEmployeeId)
  if (cells.tl !== null) clear(cells.tl)
  if (cells.bl !== null) clear(cells.bl)
  if (cells.tr !== null) clear(cells.tr)
  if (cells.top !== null) clear(cells.top)
  if (employee === null) {
    if (cells.tl !== null) cells.tl.appendChild(el('div', 'aside-note', '（未选中员工）'))
    return
  }
  var ids = positionCellsOf(employee)
  var ctx = quadContext(employee)
  /* 顶部徽章位：平时一句话都不说，有事才亮红（"只读 · 无处置权限"就是它） */
  /* ctx.cell = 面板落在哪一格。为什么需要它：同一份数据在格子里与在顶栏那条工具条里
     该有不同密度（工具条只有一行高）。面板据此换紧凑形态，而不是复制一个面板。 */
  if (cells.top !== null && ids.top.length > 0) renderPanelsInto(cells.top, withCell(ctx, 'top'), ids.top)
  if (cells.tl !== null) {
    if (ids.tl.length === 0) cells.tl.appendChild(quadEmptyNote('tl', '左上 · 当前目标'))
    else renderPanelsInto(cells.tl, withCell(ctx, 'tl'), ids.tl)
  }
  if (cells.bl !== null) {
    if (ids.bl.length === 0) cells.bl.appendChild(quadEmptyNote('bl', '左下 · 下一步'))
    else renderPanelsInto(cells.bl, withCell(ctx, 'bl'), ids.bl)
  }
  if (cells.tr !== null) renderQuadTrCell(cells.tr, employee, ids.tr, ctx)
}

/** ctx 加一个 cell 字段（同一份数据在不同格位可以有不同密度）。 */
function withCell(ctx, cell) {
  var copy = {}
  for (var key in ctx) {
    if (Object.prototype.hasOwnProperty.call(ctx, key)) copy[key] = ctx[key]
  }
  copy.cell = cell
  return copy
}

/** 只重画左下（投影帧很频繁，别为了它把右上那三段也重建一遍）。 */
function renderQuadPlan() {
  if (!quadActive()) return
  var bl = $('quadBl')
  if (bl === null) return
  clear(bl)
  var employee = employeeById(state.selectedEmployeeId)
  if (employee === null) return
  var ids = positionCellsOf(employee)
  if (ids.bl.length === 0) {
    bl.appendChild(quadEmptyNote('bl', '左下 · 下一步'))
    return
  }
  renderPanelsInto(bl, withCell(quadContext(employee), 'bl'), ids.bl)
}

/**
 * 右上「指挥栏」：岗位面板 → 未决审批（**只在真有未决时出现**）→ 会话折叠栏 → 专属技能折叠栏。
 *
 * 为什么审批段改成条件渲染（2026-09-24）：安全监测岗**没有处置权限**，审批常态是 0，
 * 而"本岗位无处置权限，不产生审批"这句话一辈子不变 —— 常驻一个永远不变的数字等于白占位置。
 * 它现在只在真有事时露头（那一刻它仍是唯一能解除阻塞的地方），
 * "为什么平时没有"那句话搬到了顶部徽章的弹层里。这条规矩对渗透页同样成立。
 */
function renderQuadTrCell(tr, employee, ids, ctx) {
  var employeeId = String(employee.id || '')

  /* 1. 岗位给这一格配的面板（安全监测的「值守记录」就在这里）。
        排在审批之上是刻意的：它是这一格唯一每轮都会变的东西。 */
  renderPanelsInto(tr, withCell(ctx, 'tr'), ids)

  /* 2. 未决审批：一出现就是"她卡住了"，所以排在最上面、默认展开、带行内裁决；没有就不显示 */
  appendApprovalBlock(tr, employeeId, { actions: true, onlyWhenPending: true })

  /* 3. 会话折叠栏：折起只留一行「当前：xxx」，展开是右列里的一条独立行（不盖住对话） */
  var expanded = sessionPanelExpanded()
  var foldBox = el('div', 'aside-block')
  var foldHead = el('div', 'aside-title')
  foldHead.appendChild(el('span', '', '会话'))
  if (state.sessions.length > 0) foldHead.appendChild(el('span', 'badge', String(state.sessions.length)))
  /* 用的是顶栏那个开关的**同一个**函数：两处状态不可能不一致。
     键盘可达性由 makeFoldToggle 一并给齐（折叠行是 div，不是 button）。 */
  makeFoldToggle(foldHead, expanded, function () {
    toggleSessionPanel()
    renderQuadCells()
  })
  foldBox.appendChild(foldHead)
  if (!expanded) {
    var title = currentSessionTitle()
    foldBox.appendChild(el('div', 'aside-note', title === '' ? '还没打开会话' : '当前：' + title))
    foldBox.appendChild(el('div', 'aside-note', '展开后列表在这一格下面，不覆盖对话'))
  }
  tr.appendChild(foldBox)

  /* 4. 专属技能：默认折起（这一格只有 1/4 屏，全展开实测超出 54px），
       但"有几个有问题"留在标题徽章上 —— 折的是列表，不是问题。 */
  var snapshot = state.aside !== null && state.aside.employeeId === employeeId ? state.aside : null
  appendSkillBlock(tr, employee, snapshot, { fold: true })
}

/** 会话列表此刻是否展开（顶栏按钮与折叠栏共用同一个真相：panel 的 hidden 类）。 */
function sessionPanelExpanded() {
  var panel = $('sessionPanel')
  return panel !== null && !panel.classList.contains('hidden')
}

/** 当前会话标题（会话列表里的那份投影；没有就空串 —— 不编"未命名"）。 */
function currentSessionTitle() {
  var sessionId = state.selectedSessionId
  if (sessionId === null || sessionId === '') return ''
  for (var i = 0; i < state.sessions.length; i += 1) {
    if (sessionIdOf(state.sessions[i]) === sessionId) return sessionTitleOf(state.sessions[i])
  }
  return ''
}

/* ── 工作区文件（格位面板的数据；按岗位配了哪些面板决定读哪些） ── */

/**
 * 这一页要读哪些工作区文件。
 *
 * 为什么按面板 id 推、而不是"凡四宫格都读一遍"：employee.files.get 是**打到员工那台机器**的
 * RPC。没配监测/应急面板的岗位（比如渗透测试那页）多读几个文件，就是纯浪费。
 *
 * capability-badge 两处岗位共用，但**声明来自哪个文件取决于这个岗位还配了什么**：
 * 应急响应看 incident.json，安全监测看 monitor.json —— 所以先扫一遍有没有 incident-* 面板。
 */
function quadFileNeeds(ids) {
  var all = ids.tl.concat(ids.bl).concat(ids.tr).concat(ids.top)
  var needs = { scope: false, board: false, monitor: false, findings: false, incident: false, actions: false, incidents: false }
  var incidentPosition = false
  for (var i = 0; i < all.length; i += 1) {
    if (QUAD_INCIDENT_PANELS.indexOf(all[i]) >= 0) incidentPosition = true
  }
  for (var k = 0; k < all.length; k += 1) {
    var id = all[k]
    if (id === 'pentest-target') {
      needs.scope = true
      needs.board = true
    } else if (id === 'monitor-post' || id === 'monitor-findings' || id === 'monitor-watch') {
      needs.monitor = true
      needs.findings = true
    } else if (id === 'incident-post' || id === 'incident-steps' || id === 'incident-timeline') {
      needs.incident = true
      needs.actions = true
      /* 事件台那一格还要"历史事件"（incidents.json）：只有它读，别的格不花这次请求 */
      if (id === 'incident-post') needs.incidents = true
    } else if (id === 'capability-badge') {
      if (incidentPosition) needs.incident = true
      else needs.monitor = true
    }
  }
  return needs
}

/** 应急响应那三个面板 id（只用来判"这个岗位是不是应急岗"，别处不要引用它） */
var QUAD_INCIDENT_PANELS = ['incident-post', 'incident-steps', 'incident-timeline']

function loadQuadFiles(employeeId) {
  if (!quadActive()) return
  var employee = employeeById(employeeId)
  if (employee === null) return
  var needs = quadFileNeeds(positionCellsOf(employee))
  if (!needs.scope && !needs.board && !needs.monitor && !needs.findings && !needs.incident && !needs.actions && !needs.incidents) return
  var jobs = []
  var store = function (key, job) {
    jobs.push(
      job.then(function (result) {
        if (state.quad.employeeId !== employeeId) return
        state.quad[key] = result
        renderQuadCells()
      }),
    )
  }
  if (needs.scope || needs.board) {
    store('scopeResult', readWorkspaceJson(employeeId, SCOPE_PATH))
    store('boardResult', readWorkspaceJson(employeeId, BOARD_PATH))
  }
  if (needs.monitor) store('monitorResult', readWorkspaceJson(employeeId, MONITOR_PATH))
  if (needs.findings) store('findingsResult', readWorkspaceJson(employeeId, FINDINGS_PATH))
  if (needs.incident) store('incidentResult', readWorkspaceJson(employeeId, INCIDENT_PATH))
  if (needs.actions) store('actionsResult', readWorkspaceJson(employeeId, ACTIONS_PATH))
  if (needs.incidents) store('incidentsResult', readWorkspaceJson(employeeId, INCIDENTS_PATH))
  void Promise.all(jobs)
}

/**
 * 重读左上那格的文件（一轮对话结束后调一次）。
 *
 * 为什么不做文件监听/轮询：工作区**没有文件变更推送**（节点不上报 fs 事件），
 * 轮询只是"用请求量假装实时"。真正的时机只有两个：进页面、以及她干完一轮
 * （她会把进度写进 board.json，那一刻重读最有意义）。
 */
function reloadQuadFiles() {
  if (!quadActive()) return
  var employeeId = state.quad !== null && typeof state.quad === 'object' ? state.quad.employeeId : ''
  if (employeeId === '') return
  loadQuadFiles(employeeId)
}

/* ── 绑定（抽屉按钮；会话/审批/技能各自的绑定仍在原处） ── */

function bindQuadUi() {
  if (quadBound) return
  quadBound = true
  var skinBtn = $('btnQuadSkin')
  if (skinBtn !== null) skinBtn.onclick = toggleQuadSkin
  /* 徽章弹层：点别处关掉。不做模态、不锁滚动 —— 它只是一张说明卡，
     挡住半格对话还要求人先关掉它，比不弹还烦。 */
  document.addEventListener('click', function (event) {
    if (state.quad === null || typeof state.quad !== 'object' || state.quad.badgeOpen !== true) return
    var target = event === null || event === undefined ? null : event.target
    if (target === null || target === undefined || typeof target.closest !== 'function') return
    if (target.closest('#quadTop') !== null) return
    state.quad.badgeOpen = false
    renderQuadCells()
  })
  for (var i = 0; i < QUAD_DRAWER_CELLS.length; i += 1) {
    var key = QUAD_DRAWER_CELLS[i]
    var button = $('quadDrawer_' + key)
    if (button === null) continue
    button.onclick = (function (cell) {
      return function () {
        toggleQuadDrawer(cell)
      }
    })(key)
  }
}

var quadBound = false
`
