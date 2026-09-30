/**
 * 控制台脚本片段：体检页
 *
 * 本段对应原文件的连续行区间，内容与原文件逐字节相同（拆分时用黄金基线比对过）。
 *
 * 为什么单独一个文件：这一段原来是 src/web/ui.ts 里那个 8k 行 String.raw 字符串的一部分 ——
 * 单文件没有边界，两个会话并行改会互相踩（真实撞过：edit 被"file changed"打断、提交时
 * 只能按 hunk 挑自己的改动）。拆分后每段各占一个文件，边界就是文件名。
 *
 * 拼接顺序 = 原来的物理顺序，由 ui.ts 里的 CONTROL_UI_SCRIPT 组装；**顺序不能动**：
 * 函数声明会提升，但顶层 var 的赋值不会（state、注册表这类必须在用它的代码之前）。
 */
export const CHUNK_50_HEALTH = String.raw`
var healthIssues = []
var healthSelectedId = ''
var healthFilterMode = 'all'
var healthLastCheckedAt = 0
var healthError = ''

function healthSeverityRank(kind) {
  if (kind === 'bad') return 3
  if (kind === 'warn') return 2
  if (kind === 'info') return 1
  return 0
}

function healthMaxSeverity(left, right) {
  return healthSeverityRank(left) >= healthSeverityRank(right) ? left : right
}

function healthSeverityLabel(kind) {
  if (kind === 'bad') return '阻断'
  if (kind === 'warn') return '需处理'
  if (kind === 'info') return '信息'
  return '正常'
}

function healthCategoryLabel(category) {
  if (category === 'console') return '控制台'
  if (category === 'hub') return 'Hub'
  if (category === 'node') return '节点'
  if (category === 'employee') return '员工工作区'
  return '系统'
}

function healthIsOpen(issue) {
  return issue.severity === 'bad' || issue.severity === 'warn'
}

function healthIssue(id, category, subject, title, severity, summary, facts, impact, next, node, action) {
  return {
    id: id,
    category: category,
    subject: subject,
    title: title,
    severity: severity,
    summary: summary,
    facts: facts,
    impact: impact,
    next: next,
    node: node === undefined ? null : node,
    action: action === undefined ? '' : action,
  }
}

function healthAdd(issue) {
  healthIssues.push(issue)
}

function healthIssueById(id) {
  for (var i = 0; i < healthIssues.length; i += 1) {
    if (healthIssues[i].id === id) return healthIssues[i]
  }
  return null
}

function healthCheckedText() {
  if (healthLastCheckedAt <= 0) return '尚未检查'
  return '最近检查 ' + new Date(healthLastCheckedAt).toLocaleTimeString()
}

function healthSetOverview() {
  var bad = 0
  var warn = 0
  var info = 0
  var open = 0
  healthIssues.forEach(function (issue) {
    if (issue.severity === 'bad') bad += 1
    else if (issue.severity === 'warn') warn += 1
    else if (issue.severity === 'info') info += 1
    if (healthIsOpen(issue)) open += 1
  })

  var stateNode = $('healthState')
  var title = $('healthStateTitle')
  var text = $('healthStateText')
  var last = $('healthLastChecked')
  var stateKind = healthError !== '' ? 'bad' : bad > 0 ? 'bad' : warn > 0 ? 'warn' : healthLastCheckedAt > 0 ? 'ok' : ''
  if (stateNode !== null) stateNode.className = 'health-state' + (stateKind === '' ? '' : ' ' + stateKind)
  if (title !== null) title.textContent = healthError !== '' ? '体检读取失败' : bad > 0 ? '需要立即处理' : warn > 0 ? '有事项待处理' : healthLastCheckedAt > 0 ? '系统状态稳定' : '尚未检查'
  if (text !== null) {
    text.textContent =
      healthError !== ''
        ? healthError
        : healthLastCheckedAt <= 0
          ? '切入本页后会自动检查。'
          : open === 0
            ? 'Hub、节点与员工工作区没有发现需要处理的问题。'
            : String(open) + ' 项需要处理，另有 ' + String(info) + ' 项信息。'
  }
  if (last !== null) last.textContent = healthCheckedText()

  var badNode = $('healthBadCount')
  var warnNode = $('healthWarnCount')
  var infoNode = $('healthInfoCount')
  if (badNode !== null) badNode.textContent = String(bad)
  if (warnNode !== null) warnNode.textContent = String(warn)
  if (infoNode !== null) infoNode.textContent = String(info)

  var chip = $('healthChip')
  var problems = open
  /* 保留这条明确赋值：一级标签只在有真正需要处理的项目时出现胶囊。 */
  if (chip !== null) {
    chip.textContent = problems === 0 ? '' : String(problems) + ' 项待处理'
    chip.classList.toggle('bad', problems > 0)
  }

  var allCount = $('healthAllCount')
  var openCount = $('healthOpenCount')
  var okCount = $('healthOkCount')
  if (allCount !== null) allCount.textContent = String(healthIssues.length)
  if (openCount !== null) openCount.textContent = String(open)
  if (okCount !== null) okCount.textContent = String(healthIssues.length - open)
}

function healthSetLoading() {
  healthIssues = []
  healthSelectedId = ''
  healthError = ''
  healthLastCheckedAt = 0
  var stateNode = $('healthState')
  var title = $('healthStateTitle')
  var text = $('healthStateText')
  var last = $('healthLastChecked')
  if (stateNode !== null) stateNode.className = 'health-state'
  if (title !== null) title.textContent = '正在检查'
  if (text !== null) text.textContent = '正在读取 Hub、节点与员工工作区状态…'
  if (last !== null) last.textContent = '检查中…'
  var body = $('healthBody')
  if (body !== null) {
    clear(body)
    body.appendChild(el('div', 'health-empty', '正在读取体检数据…'))
  }
  var detail = $('healthDetail')
  if (detail !== null) {
    clear(detail)
    detail.appendChild(el('div', 'health-detail-empty', '正在检查…'))
  }
}

function healthSetFilter(mode) {
  healthFilterMode = mode === 'open' || mode === 'ok' ? mode : 'all'
  var buttons = [
    { id: 'healthFilterAll', mode: 'all' },
    { id: 'healthFilterOpen', mode: 'open' },
    { id: 'healthFilterOk', mode: 'ok' },
  ]
  buttons.forEach(function (item) {
    var button = $(item.id)
    if (button === null) return
    var active = item.mode === healthFilterMode
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', active ? 'true' : 'false')
  })
  healthRenderQueue()
}

function healthFilterMatches(issue) {
  if (healthFilterMode === 'open') return healthIsOpen(issue)
  if (healthFilterMode === 'ok') return !healthIsOpen(issue)
  return true
}

function healthSelectIssue(id) {
  healthSelectedId = id
  healthRenderQueue()
}

function healthRenderDetail(issue) {
  var detail = $('healthDetail')
  if (detail === null) return
  clear(detail)
  if (issue === null) {
    var empty = el('div', 'health-detail-empty')
    empty.appendChild(el('strong', '', '选择一个检查项目'))
    empty.appendChild(el('span', '', '这里会说明事实、影响和下一步。'))
    detail.appendChild(empty)
    return
  }

  var top = el('div', 'health-detail-top')
  top.appendChild(el('strong', '', healthCategoryLabel(issue.category)))
  top.appendChild(el('span', 'health-severity ' + issue.severity, healthSeverityLabel(issue.severity)))
  detail.appendChild(top)
  detail.appendChild(el('h3', 'health-detail-title', issue.title))
  detail.appendChild(el('div', 'health-detail-subject', issue.subject))

  var factsSection = el('section', 'health-detail-section')
  factsSection.appendChild(el('h3', '', '事实'))
  var facts = el('ul', 'health-facts')
  ;(Array.isArray(issue.facts) ? issue.facts : []).forEach(function (fact) {
    facts.appendChild(el('li', '', String(fact)))
  })
  factsSection.appendChild(facts)
  detail.appendChild(factsSection)

  if (issue.impact !== '') {
    var impact = el('section', 'health-detail-section')
    impact.appendChild(el('h3', '', '影响'))
    impact.appendChild(el('p', '', issue.impact))
    detail.appendChild(impact)
  }
  if (issue.next !== '') {
    var next = el('section', 'health-detail-section')
    next.appendChild(el('h3', '', '下一步'))
    next.appendChild(el('p', '', issue.next))
    detail.appendChild(next)
  }

  var actions = el('div', 'health-detail-actions')
  if (issue.node !== null) {
    var update = buildNodeUpdateButton(issue.node)
    if (update !== null) {
      update.classList.add('health-line-action')
      actions.appendChild(update)
    }
  }
  if (issue.action === 'reload') {
    var reload = el('button', 'ghost health-line-action', '重新载入页面')
    reload.onclick = function () {
      if (typeof window !== 'undefined' && typeof window.location !== 'undefined' && typeof window.location.reload === 'function') window.location.reload()
    }
    actions.appendChild(reload)
  }
  if (actions.children.length > 0) detail.appendChild(actions)
}

function healthRenderQueue() {
  var body = $('healthBody')
  if (body === null) return
  clear(body)
  var visible = healthIssues.filter(healthFilterMatches)
  var hint = $('healthQueueHint')
  if (hint !== null) hint.textContent = String(visible.length) + ' 项'
  if (visible.length === 0) {
    var empty = el('div', 'health-empty')
    empty.appendChild(el('strong', '', healthFilterMode === 'open' ? '没有待处理问题' : '没有匹配的检查项'))
    empty.appendChild(el('span', '', healthFilterMode === 'open' ? '当前没有需要你动手处理的项目。' : '切换筛选条件查看其他项目。'))
    body.appendChild(empty)
    healthRenderDetail(null)
    return
  }

  var selected = healthIssueById(healthSelectedId)
  if (selected === null || !healthFilterMatches(selected)) {
    selected = visible[0]
    healthSelectedId = selected.id
  }
  visible.forEach(function (issue) {
    var item = el('button', 'health-item ' + issue.severity + (issue.id === healthSelectedId ? ' active' : ''))
    item.setAttribute('type', 'button')
    item.setAttribute('aria-pressed', issue.id === healthSelectedId ? 'true' : 'false')
    item.onclick = function () { healthSelectIssue(issue.id) }
    var top = el('div', 'health-item-top')
    var title = el('div', 'health-item-title')
    title.appendChild(el('span', 'health-item-dot'))
    title.appendChild(el('strong', '', issue.title))
    top.appendChild(title)
    top.appendChild(el('span', 'health-severity ' + issue.severity, healthSeverityLabel(issue.severity)))
    item.appendChild(top)
    item.appendChild(el('div', 'health-item-subject', issue.subject))
    item.appendChild(el('div', 'health-item-summary', issue.summary))
    body.appendChild(item)
  })
  healthRenderDetail(selected)
}

function buildNodeUpdateButton(node) {
  var nodeId = String(node.nodeId || '')
  var status = String(node.codeStatus || 'unknown')
  var update = node.update !== null && typeof node.update === 'object' ? node.update : null
  var canUpdate = state.phase === 'ready' && state.scopes.indexOf('node.admin') >= 0

  if (update !== null && String(update.status || '') === 'requested') {
    return el('span', 'health-line-action muted', '升级中…（节点在准备新版本，随后会重启）')
  }
  if (update !== null && String(update.status || '') === 'prepared' && node.online !== true) {
    return el('span', 'health-line-action muted', '已切换，等待节点重启回来…')
  }
  if (update !== null && String(update.status || '') === 'failed') {
    return el('span', 'health-line-action bad', '上次升级失败：' + String(update.error || '未知原因'))
  }
  if (node.online !== true || status === 'match') return null
  if (!canUpdate) return el('span', 'health-line-action muted', '需要 node.admin 权限才能升级')

  var button = el('button', 'ghost health-line-action', '升级到 Hub 当前版本')
  button.title =
    '让这台节点自己升级：它会把 Hub 当前版本取下来、校验、装依赖、冒烟，然后重启进新版本。' +
    '有回合在跑时会被拒绝（回合进行中重启会损坏会话日志）。'
  button.onclick = function () {
    button.disabled = true
    button.textContent = '升级中…'
    rpc('node.update', { nodeId: nodeId }, { idempotencyKey: randomId() })
      .then(function (payload) {
        var result = payload !== null && typeof payload === 'object' ? payload : {}
        toast(
          '已让「' + String(node.name || nodeId) + '」升级（目标 ' + String(result.to || '') + '）：它会重启，回来即一致',
          'ok',
        )
        refreshHealth()
      })
      .catch(function (error) {
        button.disabled = false
        button.textContent = '升级到 Hub 当前版本'
        reportRpcError('node.update', error)
      })
  }
  return button
}

function renderHealth(payload) {
  var body = $('healthBody')
  if (body === null) return
  healthIssues = []
  healthSelectedId = ''
  healthError = ''
  healthLastCheckedAt = Date.now()

  var nodes = pickArray(payload, ['nodes', 'items', 'list'])
  var hubCode = payload !== null && typeof payload === 'object' && payload.hubCodeVersion !== undefined && payload.hubCodeVersion !== null ? String(payload.hubCodeVersion) : ''
  var hubRuntime = payload !== null && typeof payload === 'object' ? String(payload.hubRuntime || '') : ''
  var label = document.querySelector('[data-ui-version]')
  var serverStamp = label === null ? '' : String(label.getAttribute('data-server-version') || '')

  if (serverStamp === '') {
    healthAdd(healthIssue('console-version', 'console', '浏览器控制台', '控制台版本未知', 'info', '服务端没有提供当前页面的版本指纹。', ['本页：' + UI_VERSION, '服务端：未知'], '无法确认浏览器是否运行了最新脚本。', '刷新页面；如果仍然未知，再检查 Hub 的静态资源与缓存。', null, 'reload'))
  } else if (serverStamp !== UI_VERSION) {
    healthAdd(healthIssue('console-version', 'console', '浏览器控制台', '控制台脚本版本不一致', 'bad', '本页脚本和服务端指纹不同。', ['本页：' + UI_VERSION, '服务端：' + serverStamp], '浏览器可能仍在使用旧缓存，页面行为与服务端版本不一致。', '重新载入页面；若仍不一致，清理该站点的 Service Worker / PWA 缓存。', null, 'reload'))
  } else {
    healthAdd(healthIssue('console-version', 'console', '浏览器控制台', '控制台脚本一致', 'ok', '本页和服务端使用同一份脚本。', ['版本：' + UI_VERSION], '', '', null, ''))
  }

  var hubFacts = []
  var hubSeverity = 'ok'
  var hubTitle = 'Hub 运行正常'
  var hubSummary = 'Hub 指纹和运行方式没有发现问题。'
  if (hubCode === '') {
    hubSeverity = 'warn'
    hubTitle = 'Hub 代码指纹未知'
    hubSummary = 'Hub 没有提供可核对的代码指纹。'
    hubFacts.push('代码指纹：未知')
  } else {
    hubFacts.push('代码指纹：' + hubCode)
  }
  if (hubRuntime === 'dist') {
    hubSeverity = healthMaxSeverity(hubSeverity, 'warn')
    hubTitle = 'Hub 正在运行编译产物'
    hubSummary = '源码改动不会直接生效。'
    hubFacts.push('运行方式：dist（编译产物）')
  } else if (hubRuntime !== '') {
    hubFacts.push('运行方式：' + hubRuntime)
  }
  healthAdd(healthIssue('hub-runtime', 'hub', 'Hub', hubTitle, hubSeverity, hubSummary, hubFacts, hubSeverity === 'ok' ? '' : '你修改的源码可能没有进入当前运行的 Hub。', hubSeverity === 'ok' ? '' : '确认 Hub 从正确的源码/发布目录启动，然后重新检查。', null, ''))

  if (nodes.length === 0) {
    healthAdd(healthIssue('nodes-empty', 'node', '节点目录', '还没有登记节点', 'info', 'Hub 当前没有可供检查的终端节点。', ['节点数量：0'], '没有节点时，员工无法执行任务。', '启动一个终端节点并完成配对。', null, ''))
  }
  nodes.forEach(function (node) {
    var nodeId = String(node.nodeId || node.name || '?')
    var status = String(node.codeStatus || 'unknown')
    var runtime = String(node.runtime || '')
    var facts = [
      '代码：' + (node.codeVersion ? String(node.codeVersion) : '未上报'),
      'dsh：' + String(node.dshVersion || '未知'),
      '员工：' + String(node.employeeCount || 0),
    ]
    if (runtime !== '') facts.push('运行方式：' + runtime)
    if (typeof node.queued === 'number') facts.push('待发队列：' + String(node.queued) + ' 条')

    var severity = 'ok'
    var title = '节点状态正常'
    var summary = '代码一致，节点在线。'
    var impact = ''
    var next = ''
    if (status === 'mismatch') {
      severity = 'bad'
      title = '节点代码不一致'
      summary = '节点和 Hub 不是同一份代码。'
      impact = '节点上的源码改动不会与 Hub 保持一致，协议或页面行为可能分叉。'
      next = '升级并重启该节点，然后重新检查。'
      facts.push('Hub 代码：' + (hubCode === '' ? '未知' : hubCode))
    } else if (status === 'unknown') {
      severity = 'warn'
      title = '节点代码指纹未知'
      summary = '节点没有上报版本指纹，不能确认它是否一致。'
      impact = '无法确认该节点是否运行了当前版本。'
      next = '升级该节点并重启，让它重新上报指纹。'
    }
    if (runtime === 'dist') {
      severity = healthMaxSeverity(severity, 'warn')
      if (status === 'match') title = '节点正在运行编译产物'
      summary = '源码改动不会直接生效。'
      impact = '你改动源码后，这台节点可能仍继续运行旧的编译产物。'
      next = '确认发布目录和启动方式，再重启节点。'
    }
    if (node.online !== true) {
      severity = healthMaxSeverity(severity, 'info')
      if (status === 'match' && runtime !== 'dist') title = '节点当前离线'
      if (status === 'match' && runtime !== 'dist') summary = '节点暂时没有连接到 Hub。'
      facts.push('连接：离线')
      if (impact === '') impact = '该节点上的员工暂时不能接收新任务；已排队的指令会等它上线。'
      if (next === '') next = '启动节点或检查网络连接。'
    } else {
      facts.push('连接：在线')
    }
    if (typeof node.queued === 'number' && node.queued > 0) {
      severity = healthMaxSeverity(severity, 'warn')
      if (status === 'match' && runtime !== 'dist' && node.online === true) title = '节点有待发送队列'
      summary = '有 ' + String(node.queued) + ' 条指令等待投递。'
      if (impact === '') impact = '这些指令尚未送到员工，队列过期或重试耗尽时需要人工关注。'
      if (next === '') next = '先确认节点连接，再重新检查队列是否清空。'
    }
    healthAdd(healthIssue('node:' + nodeId, 'node', '节点 ' + String(node.name || nodeId), title, severity, summary, facts, impact, next, node, ''))
  })

  var employees = Array.isArray(state.employees) ? state.employees : []
  var employeeProblems = 0
  employees.forEach(function (employee) {
    var who = String(employee.name || employee.id || '?')
    if (employee.status === 'missing-dir') {
      employeeProblems += 1
      healthAdd(healthIssue('employee:' + String(employee.id || who), 'employee', who, '工作区目录缺失', 'bad', '找不到员工的工作区目录。', ['员工：' + who, '状态：missing-dir'], '无法读取工作区文件，也无法确认私有技能。', '在员工所在节点恢复工作区目录，然后重新检查。', null, ''))
      return
    }
    if (employee.hasGitAnchor === false && Array.isArray(employee.skills) && employee.skills.length > 0) {
      employeeProblems += 1
      healthAdd(healthIssue('employee:' + String(employee.id || who), 'employee', who, '私有技能缺少 git 锚点', 'warn', '发现私有技能，但工作区没有 .git 锚点。', ['员工：' + who, '私有技能：' + String(employee.skills.length) + ' 个', '锚点：缺失'], 'dsh 可能静默忽略这些私有技能。', '在该员工工作区执行 git init，然后重新检查。', null, ''))
    }
  })
  if (employeeProblems === 0) {
    healthAdd(healthIssue('employees-summary', 'employee', '员工工作区', '员工工作区正常', 'ok', '未发现目录或技能锚点问题。', ['员工：' + String(employees.length) + ' 个'], '', '', null, ''))
  }

  healthSetOverview()
  healthRenderQueue()
}

function refreshHealth() {
  var body = $('healthBody')
  if (body === null) return
  if (state.phase !== 'ready') {
    healthIssues = []
    healthSelectedId = ''
    healthError = ''
    healthLastCheckedAt = 0
    clear(body)
    body.appendChild(el('div', 'health-empty', '（未连接：体检需要先连上 Hub）'))
    healthSetOverview()
    healthRenderDetail(null)
    if ($('healthChip') !== null) $('healthChip').textContent = ''
    return
  }
  healthSetLoading()
  rpc('node.list', {})
    .then(function (payload) {
      renderHealth(payload)
    })
    .catch(function (error) {
      reportRpcError('node.list', error)
      healthIssues = []
      healthSelectedId = ''
      healthError = '无法读取 Hub 的节点状态：' + describeError(error)
      healthLastCheckedAt = Date.now()
      clear(body)
      body.appendChild(el('div', 'health-empty', '体检读取失败：' + describeError(error)))
      healthSetOverview()
      healthRenderDetail(null)
    })
}

/* ── 岗位（职位）──
 *
 * 与分组选择器同款写法，但**值的性质不同**：分组是自由文本，岗位是**目录里的 id**。
 * 显示名只存在 Hub 侧目录里，所以：
 *   · 给岗位改名只动目录一处，已绑定的员工不会失联；
 *   · 员工身份里存 id（见 EmployeeManifest.position），控制台只做展示映射。
 * 目录是共享事实（手机与电脑看到同一份下拉），因此存 Hub 侧、不进 localStorage。
 */

/** 本地缓存的岗位目录（含内置「通用」）。未连上时为空 —— 调用方要能容忍空数组。 */`
