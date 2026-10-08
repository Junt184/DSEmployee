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

/* 切员工即切工作台：先恢复可读内容，再异步同步，不用网络响应串起页面切换。 */
function selectEmployee(employeeId, options) {
  var staying = state.selectedEmployeeId === employeeId
  if (staying && state.view === 'chat' && state.selectedSessionId !== null &&
      !(options && (options.sessionId || options.newSession))) return Promise.resolve()
  rememberChatView()
  var input = $('promptInput')
  if (!staying && state.selectedEmployeeId !== null && input !== null) {
    state.employeeDrafts.set(state.selectedEmployeeId, String(input.value || ''))
  }
  var selectionVersion = ++state.employeeSelectionVersion
  state.sessionOpenVersion += 1
  if (!staying && state.attachments.length > 0) {
    state.attachments = []
    renderAttachStrip()
  }
  state.selectedEmployeeId = employeeId
  writeLocal(LS.lastEmployee, employeeId)
  state.selectedSessionId = null
  state.chatHistory = null
  state.historySync = null
  state.subscribed = null
  var cached = employeeSessionState(employeeId)
  state.sessions = cached.sessions || []
  turnRunning = false
  distilling = false
  distillSnapshot = null
  if (!staying && input !== null) input.value = state.employeeDrafts.get(employeeId) || ''
  clearUnread(employeeId)
  bindChatUi()
  closeSessionNavDrawer()
  /* setView 是外壳的唯一切换入口；不再额外重复 applyPositionShell 与整页渲染。 */
  setView('chat')
  renderSessions()
  setRunning(false)
  updateEffectivePreset()
  autoGrowPrompt()
  syncControls()
  updateSendButton()
  updateCompactButton()
  updateDistillButton()
  var syncStatus = $('chatSyncStatus')
  if (syncStatus !== null) syncStatus.textContent = ''

  function stillEntering() {
    return state.selectedEmployeeId === employeeId && state.employeeSelectionVersion === selectionVersion
  }
  var requested = options && typeof options.sessionId === 'string' ? options.sessionId : ''
  var remembered = recallSession(employeeId)
  var rememberedEntry = state.sessions.find(function (session) { return sessionIdOf(session) === remembered })
  /* 离线且没有列表时显式接回本机记忆；在线的已知空列表不能复活已删除的会话。
     尚未读过列表时可先打开记忆，随后由本次列表响应确认它是否仍有效。 */
  var offlineSession = adoptOfflineSession(state.sessions, selectedNodeOnline(), remembered)
  var unverifiedSession = cached.sessions === null ? remembered : ''
  var initial = requested || (rememberedEntry !== undefined && rememberedEntry.archived !== true ? remembered : latestSessionId()) || offlineSession || unverifiedSession
  var opening = Promise.resolve()
  if (options && options.newSession === true) opening = createSession()
  else if (initial !== '') opening = openSession(initial)
  else clearMessages('正在载入会话…')
  var initialOpenVersion = state.sessionOpenVersion
  var initialLiveVersion = state.sessionLiveVersion || 0
  /* 非当前屏幕的办公区不在切换的关键路径重建。 */
  animateEmployeeWorkspace()
  void loadEmployeeAside()
  loadSessionTree()
  var listing = loadSessions().then(function () {
    if (!stillEntering()) return
    /* 缓存和历史已经可读；列表刷新只更新标题与运行状态，不再把会话重新打开一遍。 */
    var entry = employeeSessionState(employeeId)
    if (state.selectedSessionId !== null) {
      var selected = state.sessions.find(function (session) { return sessionIdOf(session) === state.selectedSessionId })
      var validatingDefault = requested === '' && !(options && options.newSession) && state.sessionOpenVersion === initialOpenVersion
      var unavailable = selected === undefined ? state.sessions.length > 0 || selectedNodeOnline() : selected.archived === true
      if (validatingDefault && entry.error === '' && unavailable) {
        /* 列表确认缓存会话已删除/归档，才换到有效会话；用户手选的会话不受后台刷新影响。 */
        state.selectedSessionId = null
        state.sessionOpenVersion += 1
        state.historySync = null
        state.chatHistory = null
        if (syncStatus !== null) syncStatus.textContent = ''
        setRunning(false)
        renderSessions()
        syncControls()
        updateSendButton()
      } else {
        if (selected !== undefined && (state.sessionLiveVersion || 0) === initialLiveVersion) setRunning(selected.running === true)
        updateChatHeader()
        return
      }
    }
    if (options && options.newSession === true) return
    var latest = latestSessionId()
    if (latest !== '') return openSession(latest)
    if (entry.error !== '') {
      clearMessages('暂时无法读取会话列表。请点击会话栏中的「重试」；已有会话不会被替换。')
      return
    }
    if (state.sessions.some(function (session) { return session.archived === true })) {
      clearMessages('会话已全部归档。展开会话栏可查看或恢复历史，也可点击「新会话」。')
      return
    }
    return createSession({ silent: true })
  })
  return Promise.all([listing, opening])
}

function animateEmployeeWorkspace() {
  var workspace = $('viewChat')
  if (workspace === null || typeof workspace.animate !== 'function') return
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  if (state.workspaceAnimation) state.workspaceAnimation.cancel()
  state.workspaceAnimation = workspace.animate([{ opacity: 0.92 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' })
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
  if (state.view === 'chat') renderSessions()
}

/* 展开的员工才补拉列表；已有工位轮询快照时直接复用。 */
function loadSessionTree() {
  if (state.phase !== 'ready' || state.view !== 'chat') return
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

function sessionTreeSignature() {
  return JSON.stringify([state.phase, state.scopes, Array.from(state.expandedArchives), Array.from(state.sessionArchivePending.keys()),
    officeSections().map(function (section) {
      return section.members.map(function (employee) {
        var id = String(employee.id || '')
        var expanded = state.expandedSessionEmployees.has(id)
        var entry = expanded ? employeeSessionState(id) : null
        var sessions = entry === null ? [] : id === state.selectedEmployeeId ? state.sessions : entry.sessions
        return [id, employee.name, positionName(employee.position), employee.nodeOnline, expanded,
          entry === null ? '' : entry.error, entry === null || entry.sessions !== null,
          (sessions || []).map(function (session) { return [sessionIdOf(session), sessionTitleOf(session), session.running, session.archived, session.updatedAt, session.updatedAtMs] })]
      })
    })])
}

function syncSessionSelection(list) {
  Array.from(list.querySelectorAll('.cs-employee')).forEach(function (group) {
    var current = group.getAttribute('data-employee-id') === state.selectedEmployeeId
    group.classList.toggle('selected', current)
    var choose = group.querySelector('.cs-employee-select')
    if (choose !== null) choose.setAttribute('aria-pressed', current ? 'true' : 'false')
  })
  Array.from(list.querySelectorAll('[data-session-id]')).forEach(function (row) {
    var current = row.getAttribute('data-employee-id') === state.selectedEmployeeId && row.getAttribute('data-session-id') === state.selectedSessionId
    row.classList.toggle('active', current)
    if (current) row.setAttribute('aria-current', 'true')
    else row.removeAttribute('aria-current')
  })
}

function renderSessions() {
  updateEmployeeNavigation()
  var list = $('sessionList')
  if (list === null) return
  /* 轮询刷新时保留正在输入的会话名称。 */
  if (list.querySelector('.cs-rename') !== null) return
  var signature = sessionTreeSignature()
  if (list.getAttribute('data-tree-signature') === signature) {
    syncSessionSelection(list)
    return
  }
  var scrollTop = list.scrollTop
  var active = document.activeElement
  var row = active !== null && list.contains(active) ? active.closest('[data-employee-id]') : null
  var employeeId = row === null ? '' : row.getAttribute('data-employee-id')
  var sessionId = row === null ? null : row.getAttribute('data-session-id')
  var control = active === null ? '' : ['cs-employee-toggle', 'cs-employee-select', 'cs-archive', 'cs-edit', 'cs-archives-toggle'].find(function (name) {
    return active.classList.contains(name)
  }) || ''
  clear(list)
  renderSessionTree(list)
  list.setAttribute('data-tree-signature', signature)
  list.scrollTop = scrollTop
  /* 实时刷新列表时保留键盘落点，避免展开后焦点突然掉回页面。 */
  if (row !== null) {
    var replacement = Array.from(list.querySelectorAll('[data-employee-id]')).find(function (node) {
      return node.getAttribute('data-employee-id') === employeeId && node.getAttribute('data-session-id') === sessionId
    })
    var focus = replacement === undefined ? null : control === '' ? replacement : replacement.querySelector('.' + control)
    if (focus !== null) focus.focus({ preventScroll: true })
  }
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
      var marker = el('span', 'cs-current', '当前')
      marker.setAttribute('aria-hidden', 'true')
      choose.appendChild(marker)
      if (employee.nodeOnline === false) choose.appendChild(el('span', 'badge off', '离线'))
      choose.setAttribute('aria-pressed', id === state.selectedEmployeeId ? 'true' : 'false')
      choose.onclick = function () {
        if (state.selectedEmployeeId !== id) selectEmployee(id)
        else closeSessionNavDrawer()
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
  /* 编辑器临时替换过行内容，结束编辑时必须重建，不能只更新选中态。 */
  var list = $('sessionList')
  if (list !== null) list.removeAttribute('data-tree-signature')
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
