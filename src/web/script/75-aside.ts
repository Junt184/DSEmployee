/**
 * 控制台脚本片段：宽屏右栏：员工上下文
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
export const CHUNK_75_ASIDE = String.raw`
/* ─────────────────── 9.6 宽屏右栏：员工上下文 ───────────────────
 *
 * 只读面板，数据全部来自**已有 RPC**，不新增协议：
 *   · 专属技能 → employee.skills.list（带 frontmatter 校验结果，把"写了但没生效"摆到台面）
 *   · 工作区交付物 → employee.files.list（员工产出就放在工作区里）
 *   · 未决审批 → 直接读 state.approvals（连上时与事件里已经拉过，不重复请求）
 * 每一块各自显示自己的失败原因：一块拉不到不该让整栏变成空白（"如实"优先于"好看"）。 */

var ASIDE_ROWS_MAX = 8

function employeeById(employeeId) {
  if (typeof employeeId !== 'string' || employeeId === '') return null
  for (var i = 0; i < state.employees.length; i += 1) {
    if (String(state.employees[i].id || '') === employeeId) return state.employees[i]
  }
  return null
}

/** 一个内容块（标题 + 可选徽章），返回可往里 appendChild 行的主体。 */
function asideBlock(aside, title, badgeText, badgeKind) {
  var block = el('div', 'aside-block')
  var head = el('div', 'aside-title', title)
  if (typeof badgeText === 'string' && badgeText !== '') {
    head.appendChild(el('span', 'badge ' + (badgeKind || ''), badgeText))
  }
  block.appendChild(head)
  aside.appendChild(block)
  return block
}

/**
 * 把一个标题行做成"可点开的折叠开关"。
 *
 * 为什么要单独一个函数：折叠行是 div（不是 button），只挂 onclick 的话键盘用户按不动它 ——
 * 而这一页的折叠行是"看会话列表 / 看技能清单"的唯一入口。所以 role/tabindex/aria-expanded
 * 与 Enter/Space 一起给齐；两处（四宫格的会话行、专属技能行）共用这一份。
 */
function makeFoldToggle(head, expanded, toggle) {
  if (head === null || head === undefined) return
  head.classList.add('aside-title-fold')
  head.setAttribute('role', 'button')
  head.setAttribute('tabindex', '0')
  head.setAttribute('aria-expanded', expanded === true ? 'true' : 'false')
  head.appendChild(el('span', 'fold-chev', expanded === true ? '⌃' : '⌄'))
  head.onclick = toggle
  head.onkeydown = function (event) {
    var key = event === null || event === undefined ? '' : String(event.key || '')
    if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return
    event.preventDefault()
    toggle()
  }
}

/** 一行"左键右值"。 */
function asideRow(box, key, value) {
  var row = el('div', 'aside-row')
  row.appendChild(el('span', 'k', key))
  row.appendChild(el('span', 'v', value))
  box.appendChild(row)
  return row
}

function downloadEmployeeFile(employeeId, filePath) {
  return rpc('employee.files.download', { employeeId: employeeId, path: filePath })
    .then(function (payload) {
      if (payload === null || typeof payload !== 'object' || typeof payload.dataBase64 !== 'string') {
        throw new Error('服务端没有返回文件内容')
      }
      var data = payload.dataBase64
      if (data === '' && payload.size !== 0) throw new Error('服务端没有返回文件内容')
      var raw = atob(data)
      var bytes = new Uint8Array(raw.length)
      for (var i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
      var mime = payload !== null && typeof payload === 'object' ? String(payload.mimeType || 'application/octet-stream') : 'application/octet-stream'
      var blob = new Blob([bytes], { type: mime })
      var url = URL.createObjectURL(blob)
      var anchor = document.createElement('a')
      anchor.href = url
      anchor.download = String(filePath).split('/').pop() || 'download'
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
      toast('已开始下载：' + String(filePath), 'ok')
      return bytes.length
    })
}

/**
 * 未决审批块（**容器无关**）：右栏与四宫格右上格共用这一份。
 *
 * 为什么要共用而不是各写一份：审批数是"她卡住了没有"的唯一信号，两份取数必然分叉
 * （角标写 1、右栏写 2 这种没人查得出来的分歧）。所以取数、过滤、文案都在这里，
 * 两处只差一个 options.actions（四宫格的行内裁决按钮）。
 *
 * options.actions === true 时给每条挂「通过 / 拒绝」（调 85-approvals 里那两个既有函数，
 * 不新写裁决逻辑）。dsh.question **不给这两个按钮** —— 提问不是二值裁决，给按钮等于
 * 逼人用"批准/拒绝"去回答一个问题（协议层也会直接拒绝）。
 *
 * options.onlyWhenPending === true 时，**没有未决项就整段不画**（四宫格右上格用）：
 * 那一格是 1/4 屏，"没有需要裁决的事项"这句话一辈子不变，占着位置就是浪费
 * （2026-09-24 用户否掉第一版时常驻的那句 0）。右栏仍要常驻那一段 —— 右栏是"这个员工的全貌"，
 * 少一段会让人以为坏了。返回未决条数（调用方要挂在标题徽章上）。
 */
function appendApprovalBlock(container, employeeId, options) {
  var actions = options !== undefined && options !== null && options.actions === true
  var onlyWhenPending = options !== undefined && options !== null && options.onlyWhenPending === true
  var pending = []
  for (var i = 0; i < state.approvals.length; i += 1) {
    var item = state.approvals[i]
    if (item === null || typeof item !== 'object') continue
    if (String(item.status || '') !== 'pending') continue
    if (
      String(item.employeeId || '') === employeeId ||
      String(item.fromEmployeeId || '') === employeeId ||
      String(item.toEmployeeId || '') === employeeId
    ) {
      pending.push(item)
    }
  }
  if (onlyWhenPending && pending.length === 0) return 0
  var pendingBox = asideBlock(container, '未决审批', pending.length > 0 ? String(pending.length) + ' 待处理' : '', 'warn')
  if (pending.length === 0) {
    pendingBox.appendChild(el('div', 'aside-note', '没有需要裁决的事项'))
    return 0
  }
  var canResolve = state.canResolve === true
  for (var p = 0; p < pending.length && p < 5; p += 1) {
    var one = pending[p]
    var kind = String(one.kind || '')
    if (!actions) {
      pendingBox.appendChild(el('div', 'aside-note', approvalKindLabel(kind) + '：' + approvalSummaryText(one)))
      continue
    }
    /* 四宫格版：一行摘要 + 行内动作（这一格是"人动手的地方"） */
    var row = el('div', 'approval-inline')
    row.appendChild(el('div', 'approval-inline-kind', approvalKindLabel(kind) + ' · ' + approvalRelativeTime(Number(one.requestedAtMs) || 0)))
    row.appendChild(el('div', 'approval-inline-text', approvalSummaryText(one)))
    var act = el('div', 'approval-inline-act')
    if (kind === 'dsh.question') {
      /* 答题不是二值裁决：只给一个"去哪答"的入口，别在这里假装能答。 */
      act.appendChild(el('div', 'aside-note', '这是一个提问，需要选答案'))
      var goAnswer = el('button', 'ghost', '去审批页回答')
      goAnswer.onclick = function () {
        setView('approvals')
      }
      act.appendChild(goAnswer)
    } else if (canResolve) {
      var reject = el('button', 'danger', '拒绝')
      var approve = el('button', 'primary', '通过')
      var inlineId = String(one.approvalId || '')
      /* 提交期间 resolveApproval 要按 id 找得到这两个按钮并锁住（防连点） */
      reject.setAttribute('data-approval-id', inlineId)
      approve.setAttribute('data-approval-id', inlineId)
      /* 闭包捕获：每条各自的 approvalId（用 IIFE 固定住，避免循环变量串味） */
      reject.onclick = (function (approvalId) {
        return function () {
          resolveApproval(approvalId, false)
        }
      })(inlineId)
      approve.onclick = (function (approvalId) {
        return function () {
          resolveApproval(approvalId, true)
        }
      })(inlineId)
      act.appendChild(reject)
      act.appendChild(approve)
    } else {
      act.appendChild(el('div', 'warn', '需要 approval.resolve 权限才能裁决'))
    }
    row.appendChild(act)
    pendingBox.appendChild(row)
  }
  if (pending.length > 5) {
    pendingBox.appendChild(el('div', 'aside-note', '…还有 ' + String(pending.length - 5) + ' 条（到审批页看全部）'))
  }
  if (!actions) pendingBox.appendChild(el('div', 'aside-note', '到办公区页的「审批」卡片裁决'))
  return pending.length
}

/**
 * 专属技能块（**容器无关**）：右栏与四宫格右上格共用。
 *
 * options.fold === true 时行列表默认折起（只留标题徽章），**但错误/空/警告行永远显示** ——
 * 折叠只折"有哪些技能"，不折"技能出问题了"。四宫格那一格只有 1/4 屏，全展开装不下
 * （实测超出 54px），所以默认折叠，但"有问题"必须留在徽章上可见。
 */
function appendSkillBlock(container, employee, snapshot, options) {
  var fold = options !== undefined && options !== null && options.fold === true
  var open = fold ? state.quad !== null && typeof state.quad === 'object' && state.quad.skillsOpen === true : true
  var skills = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.skills) ? snapshot.skills : null
  var bad = 0
  if (skills !== null) {
    for (var b = 0; b < skills.length; b += 1) {
      if (skills[b] !== null && typeof skills[b] === 'object' && skills[b].valid === false) bad += 1
    }
  }
  var box = asideBlock(container, '专属技能', bad > 0 ? String(bad) + ' 个有问题' : '', 'bad')
  if (fold) {
    /* 折叠开关就在标题行上：整行可点（含键盘 —— 见 makeFoldToggle）。
       firstChild 只在真的折叠时才取：别让"整行可点"变成所有调用方都得支持的接口。 */
    makeFoldToggle(box.firstChild, open, function () {
      state.quad.skillsOpen = !(state.quad.skillsOpen === true)
      renderQuadCells()
    })
  }
  if (snapshot !== null && snapshot !== undefined && snapshot.skillsError !== '') {
    box.appendChild(el('div', 'aside-bad', '拉取失败：' + snapshot.skillsError))
    return
  }
  if (snapshot === null || snapshot === undefined || snapshot.skills === null) {
    box.appendChild(el('div', 'aside-note', '（正在载入…）'))
    return
  }
  if (skills.length === 0) {
    box.appendChild(el('div', 'aside-note', '工作区里还没有专属技能（.dsh/skills/）'))
    return
  }
  if (!open) return
  for (var s = 0; s < skills.length && s < ASIDE_ROWS_MAX; s += 1) {
    var skill = skills[s]
    var row = asideRow(box, String(skill.name), skill.valid ? '' : '有问题')
    if (!skill.valid && skill.issues.length > 0) row.title = skill.issues.join('；')
  }
  if (skills.length > ASIDE_ROWS_MAX) {
    box.appendChild(el('div', 'aside-note', '…共 ' + String(skills.length) + ' 个'))
  }
  if (employee !== null && employee !== undefined && employee.hasGitAnchor === false) {
    box.appendChild(
      el('div', 'aside-warn', '工作区缺 .git 锚点：dsh 会把这些私有技能静默忽略（在该工作区执行 git init 即可）'),
    )
  }
}

/** 拉取右栏数据（技能 + 交付物）后整栏重绘。进对话时调用；失败各自落到自己的错误行。 */
function loadEmployeeAside() {
  var employee = employeeById(state.selectedEmployeeId)
  if (employee === null) {
    state.aside = null
    renderEmployeeAside()
    return Promise.resolve()
  }
  var employeeId = String(employee.id)
  var previous = state.asideCache.get(employeeId)
  var snapshot = {
    employeeId: employeeId,
    refreshing: previous !== undefined,
    skills: previous ? previous.skills : null,
    files: previous ? previous.files : null,
    skillsError: '',
    filesError: '',
    panels: previous ? previous.panels : [],
    skillTable: previous ? previous.skillTable : null,
    skillTableError: '',
    reports: previous ? previous.reports : null,
    reportsError: '',
  }
  state.aside = snapshot
  state.asideCache.delete(employeeId)
  state.asideCache.set(employeeId, snapshot)
  while (state.asideCache.size > 16) state.asideCache.delete(state.asideCache.keys().next().value)
  renderEmployeeAside()
  if (state.phase !== 'ready') return Promise.resolve()

  var jobs = []
  jobs.push(
    rpc('employee.skills.list', { employeeId: employeeId })
      .then(function (payload) {
        if (state.aside !== snapshot || state.selectedEmployeeId !== employeeId) return
        state.aside.skills = parseSkillList(payload)
      })
      .catch(function (error) {
        if (state.aside !== snapshot || state.selectedEmployeeId !== employeeId) return
        state.aside.skillsError = describeError(error)
      }),
  )
  jobs.push(
    rpc('employee.files.list', { employeeId: employeeId, path: '.' })
      .then(function (payload) {
        if (state.aside !== snapshot || state.selectedEmployeeId !== employeeId) return
        state.aside.files = pickArray(payload, ['entries', 'items', 'list'])
      })
      .catch(function (error) {
        if (state.aside !== snapshot || state.selectedEmployeeId !== employeeId) return
        state.aside.filesError = describeError(error)
      }),
  )
  /* 岗位目录决定这一页要不要拉图表数据。目录可能还没到位：loadEmployees 里那次是并发的，
     而 loadPositions 自己会缓存，这里再调一次只是等它。 */
  var positionsReady = positionList().length > 0 ? Promise.resolve() : loadPositions()
  return positionsReady.then(function () {
    if (state.aside !== snapshot || state.selectedEmployeeId !== employeeId) return
    var panels = positionPanelsOf(employee)
    state.aside.panels = panels
    /* 先把面板骨架画出来（里面是"正在载入"），再拉它们的数据 */
    renderEmployeeAside()
    if (panels.indexOf('report-archive') >= 0) {
      jobs.push(
        loadReportArchive(employeeId).then(
          function (entries) {
            if (state.aside !== snapshot || state.selectedEmployeeId !== employeeId) return
            state.aside.reports = entries
          },
          function (error) {
            if (state.aside !== snapshot || state.selectedEmployeeId !== employeeId) return
            state.aside.reportsError = describeError(error)
          },
        ),
      )
    }
    if (panels.some(function (id) { return SKILL_PANEL_IDS.indexOf(id) >= 0 })) {
      jobs.push(
        loadSkillTable(employeeId).then(function (result) {
          if (state.aside !== snapshot || state.selectedEmployeeId !== employeeId) return
          state.aside.skillTable = result
        }),
      )
    }
    return Promise.all(jobs).then(function () {
      if (state.aside !== snapshot || state.selectedEmployeeId !== employeeId) return
      snapshot.refreshing = false
      renderEmployeeAside()
    })
  })
}

/** 整栏重绘。没有选中员工时只留一行说明。 */
function renderEmployeeAside() {
  /* 四宫格右上那格显示的是**同一份技能快照**（同一个 appendSkillBlock）。
     技能是异步拉回来的，而格位是先画后到数据 —— 不在这里补一次重画，那一格会永远停在
     「正在载入…」（生产上真实发生过：本地夹具恰好没暴露这个竞态）。 */
  if (typeof renderQuadCells === 'function') renderQuadCells()
  var aside = $('employeeAside')
  if (aside === null) return
  clear(aside)
  var employee = employeeById(state.selectedEmployeeId)
  if (employee === null) {
    aside.appendChild(el('div', 'aside-note', '（未选中员工）'))
    return
  }
  var employeeId = String(employee.id)

  /* 头块：名字 + 可用性徽章 + 岗位说明 + 落在哪台节点 */
  var badge = availabilityBadge(employee)
  var head = el('div', 'aside-block')
  var title = el('div', 'aside-title', String(employee.name || '（未命名）'))
  title.appendChild(el('span', 'badge ' + badge.kind, badge.text))
  head.appendChild(title)
  if (state.aside !== null && state.aside.employeeId === employeeId && state.aside.refreshing) {
    head.appendChild(el('div', 'aside-note', '上次读取的信息 · 正在更新…'))
  }
  var role = typeof employee.role === 'string' ? employee.role : ''
  if (role !== '') head.appendChild(el('div', 'aside-role', role))
  var positionLabel = positionName(employee.position)
  head.appendChild(
    el(
      'div',
      'aside-note',
      '节点 ' + String(employee.nodeName || employee.nodeId || '?') +
        (positionLabel === '' ? '' : ' · 岗位 ' + positionLabel) +
        ' · ' + shortId(employeeId),
    ),
  )
  aside.appendChild(head)

  /* 岗位声明的面板（技能台账三张图 / 周报归档）。放在头块之后、通用块之前 ——
     对这一页来说它们才是主内容，通用块是补充。 */
  var snapshotOfPanels = state.aside !== null && state.aside.employeeId === employeeId ? state.aside : null
  renderPositionPanels(aside, employee, snapshotOfPanels)

  /* 未决审批：现读 state.approvals（不额外请求），按员工维度过滤。
     取数与文案在 appendApprovalBlock 里 —— 四宫格右上格用的是同一个函数（只是多给按钮）。 */
  appendApprovalBlock(aside, employeeId, {})

  var snapshot = state.aside !== null && state.aside.employeeId === employeeId ? state.aside : null

  /* 专属技能（右栏这里永远展开；四宫格那一格空间只有 1/4 屏，传 fold:true） */
  appendSkillBlock(aside, employee, snapshot, {})

  /* 工作区交付物（跳过 .dsemployee / .dsh 这类内部目录） */
  var fileBox = asideBlock(aside, '工作区交付物')
  if (snapshot !== null && snapshot.filesError !== '') {
    fileBox.appendChild(el('div', 'aside-bad', '拉取失败：' + snapshot.filesError))
  } else if (snapshot === null || snapshot.files === null) {
    fileBox.appendChild(el('div', 'aside-note', '（正在载入…）'))
  } else {
    var shown = 0
    for (var f = 0; f < snapshot.files.length && shown < ASIDE_ROWS_MAX; f += 1) {
      var entry = snapshot.files[f]
      if (entry === null || typeof entry !== 'object') continue
      var entryPath = String(entry.path || '')
      if (entryPath === '' || entryPath.indexOf('.dsemployee') === 0 || entryPath.indexOf('.dsh') === 0) continue
      var isDir = entry.type === 'dir'
      var fileRow = asideRow(fileBox, entryPath + (isDir ? '/' : ''), isDir ? '' : formatBytes(Number(entry.size) || 0))
      if (!isDir) {
        var download = el('button', 'ghost aside-file-download', '下载')
        download.title = '下载这个工作区文件'
        download.onclick = (function (pathToDownload) {
          return function (event) {
            event.stopPropagation()
            downloadEmployeeFile(employeeId, pathToDownload).catch(function (error) {
              reportRpcError('employee.files.download', error)
            })
          }
        })(entryPath)
        fileRow.appendChild(download)
      }
      shown += 1
    }
    if (shown === 0) fileBox.appendChild(el('div', 'aside-note', '工作区里还没有产出文件'))
  }
}
`
