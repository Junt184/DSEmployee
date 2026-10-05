/**
 * 控制台脚本片段：员工创建与选中 / 会话列表与改名
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
export const CHUNK_60_SESSIONS = String.raw`
function createEmployee() {
  var name = String(($('createName') || {}).value || '').trim()
  var role = String(($('createRole') || {}).value || '').trim()
  /* 分组从选择器读（'' = 不分组）；picker 还没建过（表单从未展开）时不可能有选择 */
  var group = state.createGroupPicker === null ? '' : state.createGroupPicker.read()
  var intro = String(($('createIntro') || {}).value || '').trim()
  var select = $('createNode')
  var nodeId = select === null ? '' : String(select.value || '')
  if (name === '') {
    toast('请先填写员工名字', 'warn')
    return
  }
  if (nodeId === '') {
    toast('请选择落在哪台终端节点上', 'warn')
    return
  }
  var params = { nodeId: nodeId, name: name, role: role }
  if (group !== '') params.group = group
  /* 初始提示词非空才传：空串不往服务端送，避免创建出只有空白 intro 的 manifest */
  if (intro !== '') params.intro = intro
  var positionChoice = state.createPositionPicker === null ? {} : state.createPositionPicker.read()
  toast('正在创建员工…', 'info')
  /* 选了「＋ 新增岗位」时要先把它加进目录（position.upsert）再落员工 —— 岗位 id 必须
     先存在，员工身份里存的才是有效引用 */
  resolvePositionChoice(positionChoice)
    .then(function (position) {
      if (position !== '') params.position = position
      return rpc('employee.create', params)
    })
    .then(function (payload) {
      pushRaw('employee.create 结果', payload)
      toast('员工「' + name + '」已入职', 'ok')
      /* 建成一个就预填下一个新名字（创建常是连着的："再招一个"） */
      state.createNameTouched = false
      autofillCreateName()
      var introInput = $('createIntro')
      if (introInput !== null) introInput.value = ''
      return loadEmployees()
    })
    .catch(function (error) {
      reportRpcError('employee.create', error)
    })
}

function selectEmployee(employeeId, options) {
  var selectionVersion = ++state.employeeSelectionVersion
  if (state.selectedEmployeeId !== employeeId && state.attachments.length > 0) {
    state.attachments = []
    renderAttachStrip()
  }
  state.selectedEmployeeId = employeeId
  writeLocal(LS.lastEmployee, employeeId)
  state.selectedSessionId = null
  state.historySync = null
  state.subscribed = null
  state.sessions = []
  var cached = employeeSessionState(employeeId)
  if (cached.sessions !== null) state.sessions = cached.sessions
  turnRunning = false
  /* 换员工：丢弃未结算的沉淀（回合仍在旧会话里跑，但不在这个页面结算了） */
  distilling = false
  distillSnapshot = null
  /* 点进对话框 = 已读：未读红点清零（先清再渲染，红点随之消失） */
  clearUnread(employeeId)
  clear($('sessionList'))
  bindChatUi()
  renderEmployees()
  renderSessions()
  clearMessages('（正在载入最近会话…）')
  toggleSessionPanel(false)
  /* 点了工位就是「去找这位同事」：切到聊天视图 */
  setView('chat')
  syncControls()
  updateChatHeader()
  updateEffectivePreset()
  updateSendButton()
  updateCompactButton()
  updateDistillButton()
  /* 右栏（宽屏）跟着当前员工走；窄屏它不可见，拉取也只是两次只读 RPC */
  loadEmployeeAside()
  /* 岗位声明的页面外壳（如秘书页）：必须在这里调 —— 漏掉就是"岗位配了秘书页、页面还是老样子"，
     而且不报错（design/秘书页-设计稿.md §3） */
  applyPositionShell(employeeById(employeeId))
  renderSessions()
  loadSessionTree()
  /* 上次阅读的会话优先；失败与确实没有会话必须分开处理。 */
  var entering = employeeId
  return loadSessions().then(function () {
    if (state.selectedEmployeeId !== entering || state.employeeSelectionVersion !== selectionVersion) return
    if (state.selectedSessionId !== null) return /* 用户已经手选了一个会话 */
    if (options !== undefined && options.sessionId) return openSession(options.sessionId)
    if (options !== undefined && options.newSession === true) return createSession()
    var remembered = recallSession(entering)
    var entry = employeeSessionState(entering)
    if (remembered !== '' && (entry.error !== '' || state.sessions.some(function (session) {
      return sessionIdOf(session) === remembered && session.archived !== true
    }))) return openSession(remembered)
    var latest = latestSessionId()
    if (latest !== '') {
      return openSession(latest)
    }
    if (entry.error !== '') {
      clearMessages('暂时无法读取会话列表。请点击会话栏中的「重试」；已有会话不会被替换。')
      return
    }
    if (state.sessions.some(function (session) { return session.archived === true })) {
      clearMessages('会话已全部归档。展开会话栏可查看或恢复历史，也可点击「新会话」。')
      return
    }
    /* 节点离线、列表又拉不到：沿用本地记下的那个会话，让"先排队"这条路留着。
       直接建会话在离线时必然失败，那时发送键会一直是灰的 —— 用户会以为界面坏了。 */
    var adopted = adoptOfflineSession(state.sessions, selectedNodeOnline(), recallSession(entering))
    if (adopted !== '') {
      state.selectedSessionId = adopted
      state.subscribed = null
      renderSessions()
      syncControls()
      updateSendButton()
      updateCompactButton()
      updateDistillButton()
      clearMessages('（暂时连不上该员工的节点：能发，但会先排进队列，等节点上线后送出去）')
      return
    }
    return createSession({ silent: true })
  })
}

/** 最近一次会话：按 updatedAt/updatedAtMs 降序取第一个（接口不保证有序，自己排）。 */
function latestSessionId() {
  var best = ''
  var bestAt = -1
  state.sessions.forEach(function (session) {
    if (session.archived === true) return
    var at =
      typeof session.updatedAt === 'number'
        ? session.updatedAt
        : typeof session.updatedAtMs === 'number'
          ? session.updatedAtMs
          : 0
    if (best === '' || at >= bestAt) {
      best = sessionIdOf(session)
      bestAt = at
    }
  })
  return best
}

function sessionIdOf(item) {
  if (item === null || typeof item !== 'object') return ''
  var candidates = [item.sessionId, item.id, item.session_id]
  for (var i = 0; i < candidates.length; i += 1) {
    if (typeof candidates[i] === 'string' && candidates[i] !== '') return candidates[i]
  }
  return ''
}

/* 会话标题取值顺序：session.list 条目的标题在 projections.values.title（顶层没有
   title 字段），旧节点可能还没有 projections —— 退回 name，都没有时返回 ''
   （调用方用 shortId(id) 兜底）。抽屉行与顶栏标题区共用这一条链。 */
function sessionTitleOf(session) {
  if (session === null || typeof session !== 'object') return ''
  var projections = session.projections
  if (projections !== null && typeof projections === 'object') {
    var values = projections.values
    if (values !== null && typeof values === 'object' && typeof values.title === 'string' && values.title !== '') {
      return values.title
    }
  }
  if (typeof session.name === 'string' && session.name !== '') return session.name
  return ''
}

/* 当前选中会话的标题（未选中或无标题返回 ''）：顶栏标题区用 */
function selectedSessionTitle() {
  if (state.selectedSessionId === null) return ''
  for (var i = 0; i < state.sessions.length; i += 1) {
    if (sessionIdOf(state.sessions[i]) === state.selectedSessionId) return sessionTitleOf(state.sessions[i])
  }
  return ''
}

/* 浏览器的最近会话副本按 Hub 隔离；节点暂时离线时仍能阅读。
   只缓存已经读取过的记录，数量和总体积有上限，不冒充完整备份。 */
function workspaceCache() {
  if (state.workspaceCache !== undefined && state.workspaceCache !== null) return state.workspaceCache
  var cache = { lists: [], histories: [] }
  try {
    var parsed = JSON.parse(readLocal('dse.workspaceCache.' + BOOT.hubId) || 'null')
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.lists) && Array.isArray(parsed.histories)) {
      cache.lists = parsed.lists.filter(function (entry) {
        return entry !== null && typeof entry === 'object' && typeof entry.employeeId === 'string' && Array.isArray(entry.sessions)
      }).slice(-20)
      cache.histories = parsed.histories.filter(function (entry) {
        return entry !== null && typeof entry === 'object' && typeof entry.employeeId === 'string' &&
          typeof entry.sessionId === 'string' && entry.payload !== null && typeof entry.payload === 'object' && Array.isArray(entry.payload.events)
      }).slice(-8)
    }
  } catch (error) { /* 缓存损坏不影响读取节点的权威数据。 */ }
  state.workspaceCache = cache
  return cache
}

function persistWorkspaceCache() {
  var cache = workspaceCache()
  var serialized = JSON.stringify(cache)
  while (serialized.length > 1000000 && cache.histories.length > 0) {
    cache.histories.shift()
    serialized = JSON.stringify(cache)
  }
  while (serialized.length > 1000000 && cache.lists.length > 0) {
    cache.lists.shift()
    serialized = JSON.stringify(cache)
  }
  writeLocal('dse.workspaceCache.' + BOOT.hubId, serialized)
}

function readCachedSessions(employeeId) {
  var lists = workspaceCache().lists
  for (var i = lists.length - 1; i >= 0; i -= 1) {
    if (lists[i].employeeId === employeeId) return lists[i].sessions.filter(function (item) {
      return item !== null && typeof item === 'object'
    })
  }
  return null
}

function rememberSessionList(employeeId, sessions) {
  var cache = workspaceCache()
  cache.lists = cache.lists.filter(function (entry) { return entry.employeeId !== employeeId })
  cache.lists.push({ employeeId: employeeId, sessions: sessions })
  cache.lists = cache.lists.slice(-20)
  persistWorkspaceCache()
}

function readCachedHistory(employeeId, sessionId) {
  var histories = workspaceCache().histories
  for (var i = histories.length - 1; i >= 0; i -= 1) {
    if (histories[i].employeeId === employeeId && histories[i].sessionId === sessionId) return histories[i].payload
  }
  return null
}

function rememberHistory(employeeId, sessionId, payload) {
  var cache = workspaceCache()
  cache.histories = cache.histories.filter(function (entry) {
    return entry.employeeId !== employeeId || entry.sessionId !== sessionId
  })
  var events = payload.events.slice(-800)
  cache.histories.push({ employeeId: employeeId, sessionId: sessionId, payload: {
    events: events,
    hasMore: payload.hasMore === true || events.length < payload.events.length,
    oldestSeq: events.length === 0 ? null : sessionEventSeq(events[0])
  } })
  cache.histories = cache.histories.slice(-8)
  persistWorkspaceCache()
}

function employeeSessionState(employeeId) {
  var entry = state.employeeSessions.get(employeeId)
  if (entry === undefined) {
    entry = { sessions: readCachedSessions(employeeId), loading: false, error: '', request: null, revision: 0 }
    state.employeeSessions.set(employeeId, entry)
  }
  return entry
}

/* 工位已经定期读 session.list；会话树复用这份结果，不再另起一套轮询。 */
function cacheEmployeeSessions(employeeId, sessions, revision) {
  var entry = employeeSessionState(employeeId)
  if (entry.loading) return
  if (revision !== undefined && revision !== (entry.revision || 0)) return
  var next = sessions.filter(function (session) { return session !== null && typeof session === 'object' })
  if (entry.error === '' && JSON.stringify(entry.sessions) === JSON.stringify(next)) return
  entry.sessions = next
  entry.error = ''
  if (state.selectedEmployeeId === employeeId) state.sessions = next
  if (state.view === 'chat' && isRegularSessionTree()) renderSessions()
}

function isRegularSessionTree() {
  var chat = $('viewChat')
  return chat !== null && !chat.classList.contains('layout-secretary') && !chat.classList.contains('layout-quad')
}

/* 展开的员工才补拉列表；已有工位轮询快照时直接复用。 */
function loadSessionTree() {
  if (!isRegularSessionTree() || state.phase !== 'ready' || state.view !== 'chat') return
  state.employees.forEach(function (employee) {
    var id = String(employee.id || '')
    if (id === '' || !state.expandedSessionEmployees.has(id)) return
    var entry = employeeSessionState(id)
    if (entry.sessions === null && !entry.loading && entry.error === '') loadSessions(id, true)
  })
}

function loadSessions(employeeId, quiet) {
  employeeId = typeof employeeId === 'string' ? employeeId : state.selectedEmployeeId
  if (state.phase !== 'ready' || employeeId === null) {
    renderSessions()
    return Promise.resolve([])
  }
  var entry = employeeSessionState(employeeId)
  if (entry.loading) return entry.request
  entry.revision = (entry.revision || 0) + 1
  var requestRevision = entry.revision
  entry.loading = true
  entry.error = ''
  entry.request = rpc('session.list', { employeeId: employeeId })
    .then(function (payload) {
      var sessions = pickArray(payload, ['sessions', 'items', 'list', 'events']).filter(function (item) {
        return item !== null && typeof item === 'object'
      })
      entry.loading = false
      /* 归档回执已改变列表时，变更前发出的请求不能把旧状态写回来。 */
      if (entry.revision !== requestRevision) return entry.sessions || []
      /* 不能把无法识别的响应当作「暂无会话」。 */
      if (!Array.isArray(payload) && (payload === null || typeof payload !== 'object' ||
          !['sessions', 'items', 'list', 'events'].some(function (key) { return Array.isArray(payload[key]) }))) {
        throw new Error('会话列表响应格式不正确')
      }
      entry.sessions = sessions
      rememberSessionList(employeeId, sessions)
      if (state.selectedEmployeeId === employeeId) {
        state.sessions = entry.sessions
        applyContextFromSessionList()
        updateChatHeader()
      }
      renderSessions()
      return entry.sessions
    })
    .catch(function (error) {
      entry.loading = false
      if (entry.revision !== requestRevision) return entry.sessions || []
      entry.error = '暂时无法读取会话，点击重试'
      if (quiet !== true && state.selectedEmployeeId === employeeId) reportRpcError('session.list', error)
      renderSessions()
      return []
    })
  renderSessions()
  return entry.request
}

/* 新建/改名之后必须重新读，不能复用变更之前发出的在途请求。 */
function reloadEmployeeSessions(employeeId) {
  var entry = employeeSessionState(employeeId)
  if (entry.loading) return entry.request.then(function () { return loadSessions(employeeId) })
  return loadSessions(employeeId)
}

function renderSessions() {
  var list = $('sessionList')
  if (list === null) return
  /* 轮询刷新时保留正在输入的会话名称。 */
  if (list.querySelector('.cs-rename') !== null) return
  clear(list)
  if (isRegularSessionTree()) {
    renderSessionTree(list)
    return
  }
  if (state.selectedEmployeeId === null) {
    list.appendChild(el('li', 'empty', '（先在办公区点选一个同事）'))
    return
  }
  appendSessionRows(list, state.selectedEmployeeId, state.sessions)
}

function appendSessionRows(list, employeeId, sessions, pending) {
  var archived = sessions.filter(function (session) { return session.archived === true })
  sessions = sessions.filter(function (session) { return session.archived !== true })
  sessions.forEach(function (session) {
    appendSessionRow(list, employeeId, session)
  })
  if (sessions.length === 0 && pending !== true) {
    list.appendChild(el('li', 'empty', archived.length > 0 ? '（暂无未归档会话）' : '（暂无会话）'))
  }
  if (archived.length > 0) {
    var archiveGroup = el('li', 'cs-archives')
    var expanded = state.expandedArchives.has(employeeId)
    var toggle = el('button', 'ghost cs-archives-toggle', '已归档（' + archived.length + '）')
    toggle.type = 'button'
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    var children = el('ul', 'list cs-archive-sessions' + (expanded ? '' : ' hidden'))
    children.id = 'archivedSessions_' + employeeId
    toggle.setAttribute('aria-controls', children.id)
    toggle.onclick = function () {
      if (state.expandedArchives.has(employeeId)) state.expandedArchives.delete(employeeId)
      else state.expandedArchives.add(employeeId)
      renderSessions()
    }
    archived.forEach(function (session) { appendSessionRow(children, employeeId, session) })
    archiveGroup.appendChild(toggle)
    archiveGroup.appendChild(children)
    list.appendChild(archiveGroup)
  }
  if (!isRegularSessionTree()) {
    var legacyFresh = el('li', 'item compact cs-new', '＋ 新会话')
    legacyFresh.onclick = function () { createSession() }
    list.appendChild(legacyFresh)
    return
  }
  var fresh = el('li', 'cs-new')
  var create = el('button', 'ghost', '＋ 新会话')
  create.type = 'button'
  create.disabled = state.phase !== 'ready' || state.scopes.indexOf('employee.prompt') < 0
  create.onclick = function () {
    if (state.selectedEmployeeId === employeeId) createSession()
    else selectEmployee(employeeId, { newSession: true })
  }
  fresh.appendChild(create)
  list.appendChild(fresh)
}

function appendSessionRow(list, employeeId, session) {
  var id = sessionIdOf(session)
  if (id === '') return
  var active = employeeId === state.selectedEmployeeId && id === state.selectedSessionId
  var item = el('li', 'item compact' + (active ? ' active' : ''))
  item.setAttribute('data-session-id', id)
  item.setAttribute('data-employee-id', employeeId)
  item.tabIndex = 0
  item.setAttribute('role', 'button')
  if (active) item.setAttribute('aria-current', 'true')
  var top = el('div', 'item-top')
  top.appendChild(el('span', 'name', sessionTitleOf(session) || shortId(id)))
  if (session.running === true) top.appendChild(el('span', 'badge ok', '运行中'))
  /* 改名入口：铅笔小按钮，桌面 hover 显现、手机常显但低调（样式见 .cs-edit） */
  var edit = el('button', 'cs-edit', '✎')
  edit.type = 'button'
  edit.title = '重命名会话'
  edit.setAttribute('aria-label', '重命名会话')
  edit.disabled = state.phase !== 'ready' || state.scopes.indexOf('employee.prompt') < 0
  edit.onclick = function (event) {
    event.stopPropagation()
    startSessionRename(item, session, id, employeeId)
  }
  top.appendChild(edit)
  var archive = el('button', 'cs-edit cs-archive', session.archived === true ? '恢复' : '归档')
  archive.type = 'button'
  archive.title = session.running === true && session.archived !== true ? '运行中的会话暂不能归档' :
    (session.archived === true ? '恢复会话' : '归档会话（保留历史）')
  archive.setAttribute('aria-label', session.archived === true ? '恢复会话' : '归档会话')
  archive.disabled = state.phase !== 'ready' || state.scopes.indexOf('employee.prompt') < 0 ||
    state.sessionArchivePending.has(employeeId + '/' + id) || (session.running === true && session.archived !== true)
  archive.onclick = function (event) {
    event.stopPropagation()
    setSessionArchived(id, session.archived !== true, employeeId)
  }
  top.appendChild(archive)
  item.appendChild(top)
  var updated = typeof session.updatedAt === 'number' ? session.updatedAt : typeof session.updatedAtMs === 'number' ? session.updatedAtMs : 0
  item.appendChild(el('div', 'meta', updated > 0 ? new Date(updated).toLocaleString() : id))
  item.onclick = function () {
    if (state.selectedEmployeeId === employeeId) openSession(id)
    else selectEmployee(employeeId, { sessionId: id })
  }
  item.onkeydown = function (event) {
    if (event.target !== item || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    item.onclick()
  }
  list.appendChild(item)
}

function renderSessionTree(list) {
  list.setAttribute('aria-label', '员工与会话')
  if (state.employees.length === 0) {
    list.appendChild(el('li', 'empty', '（暂无员工）'))
    return
  }
  officeSections().forEach(function (section) {
    section.members.forEach(function (employee) {
      var id = String(employee.id || '')
      if (id === '') return
      var collapsed = !state.expandedSessionEmployees.has(id)
      var group = el('li', 'cs-employee' + (id === state.selectedEmployeeId ? ' selected' : ''))
      group.setAttribute('data-employee-id', id)
      var head = el('div', 'cs-employee-head')
      var toggle = el('button', 'ghost cs-employee-toggle', collapsed ? '›' : '⌄')
      toggle.type = 'button'
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
      toggle.setAttribute('aria-label', (collapsed ? '展开' : '折叠') + String(employee.name || id) + '的会话')
      var children = el('ul', 'list cs-employee-sessions' + (collapsed ? ' hidden' : ''))
      children.id = 'employeeSessions_' + id
      toggle.setAttribute('aria-controls', children.id)
      toggle.onclick = function () {
        if (!state.expandedSessionEmployees.has(id)) {
          state.expandedSessionEmployees.add(id)
          var entry = employeeSessionState(id)
          if (entry.sessions === null || entry.error !== '') loadSessions(id, true)
        } else state.expandedSessionEmployees.delete(id)
        renderSessions()
      }
      var choose = el('button', 'ghost cs-employee-select')
      choose.type = 'button'
      var positionLabel = positionName(employee.position) || '通用'
      var label = el('span', 'cs-employee-label')
      label.appendChild(el('span', 'name', String(employee.name || shortId(id))))
      var position = el('span', 'cs-position', '（' + positionLabel + '）')
      position.title = positionLabel
      label.appendChild(position)
      choose.appendChild(label)
      choose.title = String(employee.name || shortId(id)) + '（' + positionLabel + '）'
      if (id === state.selectedEmployeeId) choose.appendChild(el('span', 'cs-current', '当前'))
      if (employee.nodeOnline === false) choose.appendChild(el('span', 'badge off', '离线'))
      choose.setAttribute('aria-pressed', id === state.selectedEmployeeId ? 'true' : 'false')
      choose.onclick = function () {
        if (state.selectedEmployeeId !== id) selectEmployee(id)
      }
      head.appendChild(toggle)
      head.appendChild(choose)
      group.appendChild(head)
      if (!collapsed) {
        var entry = employeeSessionState(id)
        var sessions = id === state.selectedEmployeeId ? state.sessions : entry.sessions
        if (entry.error !== '') {
          var retryRow = el('li', 'cs-session-notice')
          var retry = el('button', 'ghost', entry.error)
          retry.type = 'button'
          retry.onclick = function () {
            if (state.selectedEmployeeId === id && state.selectedSessionId === null) selectEmployee(id)
            else loadSessions(id, true)
          }
          retryRow.appendChild(retry)
          children.appendChild(retryRow)
        } else if (entry.sessions === null) children.appendChild(el('li', 'cs-session-notice', '正在载入会话…'))
        appendSessionRows(children, id, sessions || [], entry.sessions === null || entry.error !== '')
      }
      group.appendChild(children)
      list.appendChild(group)
    })
  })
}

/* 行内改名：点击铅笔后整行换成编辑器（输入框预填当前名 + 保存键）。
   Enter/保存提交，Esc/失焦取消；提交在途时禁用控件防重复。 */
function startSessionRename(item, session, id, employeeId) {
  var editor = el('div', 'cs-rename')
  var input = el('input', '')
  input.type = 'text'
  input.value = sessionTitleOf(session)
  input.placeholder = '会话名称'
  input.maxLength = 80
  input.setAttribute('aria-label', '会话名称')
  var save = el('button', 'primary', '保存')
  save.type = 'button'
  var busy = false
  var cancelled = false
  function cancel() {
    if (busy || cancelled) return
    cancelled = true
    clear(item)
    renderSessions()
  }
  function submit() {
    if (busy || cancelled) return
    var title = String(input.value || '').trim()
    if (title === '') {
      toast('会话名称不能为空', 'warn')
      return
    }
    if (title === sessionTitleOf(session)) {
      cancel()
      return
    }
    busy = true
    input.disabled = true
    save.disabled = true
    renameSession(id, title, employeeId).then(function (ok) {
      busy = false
      if (ok === true) {
        cancelled = true
        clear(item)
        renderSessions()
      }
      if (ok !== true && cancelled !== true) {
        /* 失败保留编辑器现场，改了可以再试 */
        input.disabled = false
        save.disabled = false
      }
    })
  }
  input.onkeydown = function (event) {
    if (event.key === 'Enter') {
      if (event.isComposing === true || event.keyCode === 229) return
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    }
  }
  input.onblur = function () {
    /* 移除编辑器也会触发 blur；等 DOM 清理完成再取消，避免重入 clear/removeChild。 */
    Promise.resolve().then(cancel)
  }
  /* mousedown 抢先 preventDefault：点保存不触发 input 的 blur（否则 blur 先取消） */
  save.onmousedown = function (event) {
    event.preventDefault()
  }
  save.onclick = function (event) {
    event.stopPropagation()
    submit()
  }
  editor.onclick = function (event) {
    event.stopPropagation()
  }
  editor.appendChild(input)
  editor.appendChild(save)
  clear(item)
  item.appendChild(editor)
  input.focus()
}

/* session.rename（幂等）：成功刷新列表并 toast；正在看该会话时顶栏标题区随
   loadSessions→updateChatHeader 同步。失败如实 toast 错误，返回 false 让调用方
   保留编辑器。 */
function renameSession(id, title, employeeId) {
  employeeId = typeof employeeId === 'string' ? employeeId : state.selectedEmployeeId
  if (employeeId === null) return Promise.resolve(false)
  return rpc('session.rename', { employeeId: employeeId, sessionId: id, title: title })
    .then(function (payload) {
      pushRaw('session.rename 结果', payload)
      toast('已改名为「' + title + '」', 'ok')
      return reloadEmployeeSessions(employeeId).then(function () {
        if (state.selectedEmployeeId === employeeId && state.selectedSessionId === id) updateChatHeader()
        return true
      })
    })
    .catch(function (error) {
      reportRpcError('session.rename', error)
      return false
    })
}

function setSessionArchived(id, archived, employeeId) {
  var key = employeeId + '/' + id
  if (state.sessionArchivePending.has(key)) return state.sessionArchivePending.get(key)
  var openVersion = state.sessionOpenVersion
  var request = rpc('session.archive', { employeeId: employeeId, sessionId: id, archived: archived })
    .then(function (payload) {
      if (payload === null || typeof payload !== 'object' || payload.archived !== archived) throw new Error('节点未返回有效的归档状态')
      var entry = employeeSessionState(employeeId)
      entry.revision = (entry.revision || 0) + 1
      function update(sessions) {
        return sessions.map(function (session) {
          if (sessionIdOf(session) !== id) return session
          var next = Object.assign({}, session, { archived: archived })
          delete next.archivedAtMs
          if (archived && typeof payload.archivedAtMs === 'number') next.archivedAtMs = payload.archivedAtMs
          return next
        })
      }
      if (entry.sessions !== null) entry.sessions = update(entry.sessions)
      if (state.selectedEmployeeId === employeeId) state.sessions = update(state.sessions)
      rememberSessionList(employeeId, entry.sessions || [])
      if (archived) forgetSession(employeeId, id)
      if (archived && state.selectedEmployeeId === employeeId && state.selectedSessionId === id && state.sessionOpenVersion === openVersion) {
        state.selectedSessionId = null
        state.sessionOpenVersion += 1
        state.subscribed = null
        state.historySync = null
        state.chatHistory = null
        state.streamBubble = null
        setRunning(false)
        clearMessages('此会话已归档，历史完整保留。可从「已归档」查看或恢复，或选择其他会话。')
        applyContextFromSessionList()
        syncControls()
        updateChatHeader()
        updateSendButton()
        updateCompactButton()
        updateDistillButton()
        rpc('session.unsubscribe', { employeeId: employeeId, sessionId: id }).catch(function () {})
      }
      toast(archived ? '会话已归档，历史完整保留' : '会话已恢复', 'ok')
      return true
    })
    .catch(function (error) { reportRpcError('session.archive', error); return false })
    .then(function (ok) {
      state.sessionArchivePending.delete(key)
      renderSessions()
      return ok
    })
  state.sessionArchivePending.set(key, request)
  renderSessions()
  return request
}

function createSession(options) {
  var silent = options !== undefined && options !== null && options.silent === true
  if (state.selectedEmployeeId === null) return Promise.resolve()
  var employeeId = state.selectedEmployeeId
  var selectionVersion = state.employeeSelectionVersion
  var openVersion = state.sessionOpenVersion
  var presetInput = $('presetInput')
  var preset = presetInput === null ? '' : String(presetInput.value || '').trim()
  if (preset !== '') writeLocal(LS.preset, preset)
  var titleInput = $('newSessionTitle')
  var title = titleInput === null ? '' : String(titleInput.value || '').trim()
  var params = { employeeId: employeeId }
  if (preset !== '') params.agentPreset = preset
  if (title !== '') params.title = title
  if (!silent) toast('正在新建会话…', 'info')
  return rpc('session.create', params)
    .then(function (payload) {
      var id = sessionIdOf(payload)
      pushRaw('session.create 结果', payload)
      if (!silent) toast('会话已创建', 'ok')
      if (titleInput !== null && state.selectedEmployeeId === employeeId && state.employeeSelectionVersion === selectionVersion) titleInput.value = ''
      return reloadEmployeeSessions(employeeId).then(function () {
        if (id !== '' && state.selectedEmployeeId === employeeId && state.employeeSelectionVersion === selectionVersion && state.sessionOpenVersion === openVersion) openSession(id)
      })
    })
    .catch(function (error) {
      if (silent) {
        /* 静默建会话失败（典型：节点离线）不弹错误 toast 吓人 ——
           聊天页照常可用，发消息时才报离线 */
        pushRaw('自动新建会话失败', error)
        if (state.selectedEmployeeId !== employeeId || state.employeeSelectionVersion !== selectionVersion) return
        clearMessages('（暂时连不上该员工的节点：能看到这里就说明页面没坏，等节点上线后再发消息）')
        return
      }
      reportRpcError('session.create', error)
    })
}
`
