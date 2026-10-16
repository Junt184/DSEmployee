/** 项目工作台使用同一套会话协议和事件词汇，与员工固定工作台分别保留阅读状态。 */
export const CHUNK_62_PROJECTS = String.raw`
var projectWork = {
  nodes: [], projects: [], current: null, sessions: [], sessionId: null,
  events: [], hasMore: false, oldestSeq: null, historyRead: false,
  serial: 0, listSerial: 0, liveSerial: 0, loading: null, historyLoading: false,
  sending: false, mutating: false, opening: false, running: false, newTask: false,
  notice: '', bad: false, cached: false, subscribed: null, drafts: new Map(),
  selectedEmployees: {}, paintPending: false, pollPending: false, directorySelection: null
}

function projectCacheKey() { return 'dse.projects.' + BOOT.hubId }
function projectKey(project) { return project === null ? '' : project.nodeId + '/' + project.projectId }
function projectHistoryKey(project) { return 'project:' + projectKey(project) }
function projectParams(project, sessionId) {
  var params = { nodeId: project.nodeId, projectId: project.projectId }
  if (sessionId) params.sessionId = sessionId
  return params
}
function projectSelectedSession() {
  return projectWork.sessions.find(function (s) { return sessionIdOf(s) === projectWork.sessionId }) || null
}
function projectNode(project) {
  return projectWork.nodes.find(function (node) { return project !== null && node.nodeId === project.nodeId }) || null
}
function projectStill(project, sessionId, serial) {
  return projectKey(projectWork.current) === projectKey(project) && projectWork.sessionId === sessionId && projectWork.serial === serial
}
function projectTell(text, bad) {
  projectWork.notice = text; projectWork.bad = bad === true
  var box = $('projectNotice')
  if (box !== null) { box.textContent = text; box.classList.toggle('bad', bad === true) }
}
function rememberProjectWorkspace() {
  var previous = {}
  try { previous = JSON.parse(readLocal(projectCacheKey()) || '{}') || {} } catch (_) {}
  writeLocal(projectCacheKey(), JSON.stringify({ nodes: projectWork.nodes, projects: projectWork.projects.slice(0, 100),
    current: projectWork.current === null ? previous.current : projectKey(projectWork.current), employees: projectWork.selectedEmployees }))
}
function restoreProjectWorkspace() {
  if (projectWork.cached) return
  projectWork.cached = true
  try {
    var saved = JSON.parse(readLocal(projectCacheKey()) || '{}')
    if (saved === null || typeof saved !== 'object') return
    if (Array.isArray(saved.nodes)) projectWork.nodes = saved.nodes.filter(function (n) { return n && typeof n.nodeId === 'string' })
    if (Array.isArray(saved.projects)) projectWork.projects = saved.projects.filter(function (p) {
      return p && typeof p.projectId === 'string' && typeof p.nodeId === 'string' && typeof p.path === 'string'
    })
    if (saved.employees && typeof saved.employees === 'object') projectWork.selectedEmployees = saved.employees
  } catch (_) {}
}
function projectSaveDraft() {
  var input = $('projectPrompt')
  if (input !== null && projectWork.current !== null) projectWork.drafts.set(projectKey(projectWork.current) + '/' + (projectWork.sessionId || 'new'), input.value)
}
function renderProjectNavigation() {
  var list = $('projectList'), sessions = $('projectSessions'), nodeSelect = $('projectNode')
  if (list === null || sessions === null) return
  var nodeSignature = JSON.stringify(projectWork.nodes.map(function (node) { return [node.nodeId, node.name, node.online] }))
  var projectSignature = JSON.stringify([projectKey(projectWork.current), nodeSignature, projectWork.projects])
  if (list.getAttribute('data-project-signature') !== projectSignature) {
    clear(list)
    projectWork.projects.forEach(function (project) {
      var node = projectNode(project)
      var button = el('button', 'ghost' + (projectKey(project) === projectKey(projectWork.current) ? ' selected' : ''))
      button.type = 'button'; button.appendChild(el('span', '', project.name || project.path))
      button.appendChild(el('span', 'muted', (node ? node.name : shortId(project.nodeId)) + (node && node.online === false ? ' · 离线' : '') + ' · ' + project.path))
      button.onclick = function () { openProjectTask(project) }
      list.appendChild(button)
    })
    if (projectWork.projects.length === 0) list.appendChild(el('p', 'muted', '打开一个已有目录，它会保留在这里。'))
    list.setAttribute('data-project-signature', projectSignature)
  }
  var showArchived = $('projectShowArchived') !== null && $('projectShowArchived').checked
  var sessionSignature = JSON.stringify([projectKey(projectWork.current), projectWork.sessionId, showArchived, projectWork.sessions.map(function (session) {
    return [sessionIdOf(session), sessionTitleOf(session), session.employeeName, session.running, session.archived, session.setupError, session.employeeContextVersion]
  })])
  if (sessions.getAttribute('data-project-signature') !== sessionSignature) {
    clear(sessions)
    projectWork.sessions.forEach(function (session) {
      if (session.archived === true && !showArchived) return
      var id = sessionIdOf(session), button = el('button', 'ghost' + (id === projectWork.sessionId ? ' selected' : ''))
      button.type = 'button'; button.appendChild(el('span', '', sessionTitleOf(session) || '未命名任务'))
      button.appendChild(el('span', 'muted', (session.employeeName || '通用助手') + (session.archived ? ' · 已归档' : session.running ? ' · 执行中' : '') + (session.setupError ? ' · 配置未完成' : '')))
      button.onclick = function () { openProjectConversation(id) }
      sessions.appendChild(button)
    })
    if (sessions.childNodes.length === 0) sessions.appendChild(el('p', 'muted', projectWork.current === null ? '先选择项目。' : '暂无会话，可以直接输入任务。'))
    sessions.setAttribute('data-project-signature', sessionSignature)
  }
  if (nodeSelect !== null && nodeSelect.getAttribute('data-node-signature') !== nodeSignature) {
    var selected = nodeSelect.value
    clear(nodeSelect)
    projectWork.nodes.forEach(function (node) {
      var option = el('option', '', String(node.name || shortId(node.nodeId)) + (node.online === false ? '（离线）' : ''))
      option.value = node.nodeId; nodeSelect.appendChild(option)
    })
    if (projectWork.nodes.some(function (n) { return n.nodeId === selected })) nodeSelect.value = selected
    else if (projectWork.current !== null) nodeSelect.value = projectWork.current.nodeId
    nodeSelect.setAttribute('data-node-signature', nodeSignature)
  }
  renderProjectHeader()
}
function renderProjectEmployees() {
  var select = $('projectEmployee')
  if (select === null) return
  var project = projectWork.current, selected = project === null ? '' : projectWork.selectedEmployees[project.nodeId]
  if (project !== null && selected === undefined) {
    var currentEmployee = employeeById(state.selectedEmployeeId)
    selected = currentEmployee && currentEmployee.nodeId === project.nodeId ? currentEmployee.id : ''
    // 首次目录尚未读到时不记下空选择，员工数据晚到后仍可恢复原执行者。
    if (employeeDirectoryRead) projectWork.selectedEmployees[project.nodeId] = selected
  }
  var local = state.employees.filter(function (employee) { return project !== null && employee.nodeId === project.nodeId })
  var remote = state.employees.filter(function (employee) { return project !== null && employee.nodeId !== project.nodeId && employee.nodeOnline !== false && employee.available !== false && employee.status !== 'missing-dir' })
  function label(employee) { return employee.name + (positionName(employee.position) ? '（' + positionName(employee.position) + '）' : '') }
  var options = [{ value: '', text: '通用助手（节点默认模型）', disabled: false }]
  local.forEach(function (employee) {
    var reason = projectExecutorError(project, employee.id)
    options.push({ value: employee.id, text: label(employee) + (reason ? ' · ' + (employee.nodeOnline === false ? '离线' : '不可用') : ' · 在线'), disabled: reason !== '' })
  })
  if (selected && !options.some(function (option) { return option.value === selected })) {
    options.push({ value: selected, text: '原执行者暂不可用（请重新选择）', disabled: true })
  }
  // 其他在线员工也可看见，但不能在另一台机器上直接访问当前项目目录。
  remote.forEach(function (employee) {
    if (options.some(function (option) { return option.value === employee.id })) return
    options.push({ value: employee.id, text: label(employee) + ' · ' + (employee.nodeName || shortId(employee.nodeId)) + '（其他节点）', disabled: true })
  })
  var signature = JSON.stringify([projectKey(project), selected || '', options])
  if (select.getAttribute('data-executor-signature') !== signature) {
    clear(select)
    options.forEach(function (entry) {
      var option = el('option', '', entry.text); option.value = entry.value; option.disabled = entry.disabled; select.appendChild(option)
    })
    select.value = selected || ''
    select.setAttribute('data-executor-signature', signature)
  }
  select.disabled = project === null || (employeeDirectoryRequest !== null && !employeeDirectoryRead)
  var hint = $('projectEmployeeHint'), node = projectNode(project)
  if (hint !== null) {
    hint.textContent = project === null ? '先打开项目，执行者将按项目所在节点显示。'
      : employeeDirectoryError ? '员工列表更新失败：' + employeeDirectoryError + '。已有名单保留，点击页面“刷新”可重试。'
      : employeeDirectoryRequest !== null && !employeeDirectoryRead ? '正在读取在线员工…'
      : '可选 ' + local.filter(function (employee) { return projectExecutorError(project, employee.id) === '' }).length + ' 位员工，来自 ' + (node ? node.name : '项目所在节点') +
        (remote.length ? '；其他节点的 ' + remote.length + ' 位在线员工需在其节点打开项目后使用。' : '。')
  }
  syncProjectControls()
}
function projectExecutorError(project, employeeId) {
  if (!employeeId) return ''
  var employee = employeeById(employeeId)
  if (employee === null) return '所选员工已不在当前目录中，请刷新员工列表或重新选择执行者。'
  if (project === null || employee.nodeId !== project.nodeId) return '执行员工与项目必须位于同一节点，请在该员工所在节点打开项目目录。'
  if (employee.nodeOnline === false) return '所选员工的节点当前离线，请等待恢复或重新选择执行者。'
  if (employee.status === 'missing-dir' || employee.available === false) return '所选员工当前不可用，请检查员工主目录或重新选择执行者。'
  return ''
}
function renderProjectHeader() {
  var project = projectWork.current, session = projectSelectedSession(), node = projectNode(project)
  var title = $('projectTaskTitle'), environment = $('projectEnvironment'), status = $('projectTurnState')
  if (title !== null) title.textContent = project === null ? '选择项目开始工作' : session === null ? '新任务 · ' + project.name : sessionTitleOf(session) || '未命名任务'
  if (environment !== null) environment.textContent = project === null ? '' :
    String(node ? node.name : shortId(project.nodeId)) + ' · ' + project.path +
    (session === null ? '' : ' · ' + (session.employeeName || '通用助手') +
      (session.employeeId ? session.employeeContextVersion === 1 ? ' · 记忆保存在员工主目录' : ' · 旧会话：独立记忆需新建任务启用' : ''))
  if (status !== null) status.textContent = session && session.setupError ? session.setupError : state.phase !== 'ready' ? '连接恢复后可继续工作' : node && node.online === false ? '执行节点离线' : session && session.archived ? '已归档，可恢复后继续' : projectWork.running ? '执行中' : projectWork.sessionId ? '就绪' : '输入指令即可创建任务'
  syncProjectControls()
}
function syncProjectControls() {
  var ready = state.phase === 'ready', canRead = ready && state.scopes.indexOf('employee.read') >= 0
  var canPrompt = ready && state.scopes.indexOf('employee.prompt') >= 0, project = projectWork.current
  var session = projectSelectedSession(), busy = projectWork.sending || projectWork.mutating
  var nodeSelect = $('projectNode'), selectedNodeId = nodeSelect === null ? '' : nodeSelect.value
  var executor = $('projectEmployee'), executorReady = projectWork.sessionId !== null ||
    (executor !== null && !executor.disabled && projectExecutorError(project, executor.value) === '')
  var controls = { btnProjectOpen: canPrompt && canRead && selectedNodeId !== '' && !projectWork.opening, btnProjectRefresh: canRead,
    btnProjectNewTask: canPrompt && project !== null, btnProjectRename: canPrompt && session !== null && !busy,
    btnProjectArchive: canPrompt && session !== null && !busy && (!projectWork.running || session.archived),
    btnProjectCancel: canPrompt && projectWork.sessionId !== null && projectWork.running && !projectWork.mutating,
    btnProjectSend: canPrompt && project !== null && !busy && executorReady && !(session && (session.archived || session.setupError)) && String(($('projectPrompt') || {}).value || '').trim() !== '' }
  Object.keys(controls).forEach(function (id) { var button = $(id); if (button !== null) button.disabled = !controls[id] })
  var stop = $('btnProjectCancel'); if (stop !== null) stop.classList.toggle('hidden', !projectWork.running)
  var archive = $('btnProjectArchive'); if (archive !== null) archive.textContent = session && session.archived ? '恢复' : '归档'
  var send = $('btnProjectSend'); if (send !== null) send.textContent = projectWork.sending ? '正在发送…' : projectWork.running ? '排队发送' : '发送'
  var prompt = $('projectPrompt'); if (prompt !== null) prompt.disabled = project === null
  syncProjectDirectoryControls()
}
function loadProjectWorkspace() {
  restoreProjectWorkspace(); renderProjectNavigation(); renderProjectEmployees()
  if (state.phase !== 'ready' || state.scopes.indexOf('employee.read') < 0) return Promise.resolve()
  if (projectWork.loading !== null) return projectWork.loading
  var previousSerial = projectWork.serial
  var request = Promise.all([rpc('node.list', {}), loadEmployees()]).then(function (results) {
    var payload = results[0]
    var nodes = pickArray(payload, ['nodes', 'items'])
    projectWork.nodes = nodes
    return Promise.all(nodes.map(function (node) {
      if (node.online === false) return Promise.resolve({ node: node, projects: projectWork.projects.filter(function (p) { return p.nodeId === node.nodeId }) })
      return rpc('project.list', { nodeId: node.nodeId }).then(function (result) {
        if (!result || !Array.isArray(result.projects)) throw new Error('节点未返回有效的项目列表')
        return { node: node, projects: result.projects }
      }).catch(function (error) {
        return { node: node, projects: projectWork.projects.filter(function (p) { return p.nodeId === node.nodeId }), error: describeError(error) }
      })
    }))
  }).then(function (results) {
    var projects = [], errors = []
    results.forEach(function (result) {
      projects = projects.concat(result.projects)
      if (result.error) errors.push(String(result.node.name || '') + '：' + result.error)
    })
    // 接入目录可能与列表请求同时完成，合并本轮刚打开的项目，防止旧列表将它抹掉。
    projectWork.projects.forEach(function (p) { if (!projects.some(function (q) { return projectKey(p) === projectKey(q) })) projects.push(p) })
    projectWork.projects = projects.sort(function (a, b) { return b.lastOpenedAtMs - a.lastOpenedAtMs })
    var saved = null
    try { saved = JSON.parse(readLocal(projectCacheKey()) || '{}').current } catch (_) {}
    rememberProjectWorkspace(); renderProjectNavigation(); renderProjectEmployees()
    if (errors.length) projectTell('部分节点的项目列表未能更新；原有记录保留。请确认 Hub 与节点均已升级。\n' + errors.join('\n'), true)
    else if (projectWork.current === null) projectTell('', false)
    if (projectWork.current === null && projectWork.serial === previousSerial && state.view === 'projects') {
      var remembered = projects.find(function (p) { return projectKey(p) === saved }) || projects[0]
      if (remembered) return openProjectTask(remembered)
    } else if (state.view === 'projects' && projectWork.current !== null) {
      return loadProjectSessions(true)
    }
  }).catch(function (error) { projectTell('项目列表读取失败：' + describeError(error), true) }).finally(function () {
    if (projectWork.loading === request) projectWork.loading = null
    syncProjectControls()
  })
  projectWork.loading = request
  return request
}
function openProjectDirectory(event) {
  if (event) event.preventDefault()
  if (projectWork.opening) return
  var chosen = projectWork.directorySelection
  if (!chosen) { openProjectDirectoryPicker(); return }
  var nodeId = chosen.nodeId, path = chosen.path
  projectWork.opening = true; syncProjectControls()
  rpc('project.open', { nodeId: nodeId, path: path }).then(function (payload) {
    if (!payload || !payload.project || typeof payload.project.projectId !== 'string') throw new Error('节点未返回有效项目')
    var project = payload.project
    projectWork.projects = [project].concat(projectWork.projects.filter(function (p) { return projectKey(p) !== projectKey(project) }))
    rememberProjectWorkspace()
    $('projectOpenPanel').open = false
    return openProjectTask(project).then(function () {
      if (projectKey(projectWork.current) === projectKey(project)) projectTell(payload.historyWarning || '项目已打开，原目录与文件保持原样。', !!payload.historyWarning)
    })
  }).catch(function (error) { projectTell('打开目录失败：' + describeError(error), true) }).finally(function () {
    projectWork.opening = false; syncProjectControls()
  })
}
function projectUnsubscribe() {
  var subscribed = projectWork.subscribed
  projectWork.subscribed = null
  if (subscribed !== null && state.phase === 'ready') rpc('session.unsubscribe', subscribed).catch(function () {})
}
function openProjectTask(project, sessionId) {
  projectSaveDraft(); projectUnsubscribe()
  projectTell('', false)
  projectWork.current = project; projectWork.sessions = readCachedSessions(projectHistoryKey(project)) || []; projectWork.newTask = false
  projectWork.sessionId = null
  projectWork.requestedSession = sessionId || ''
  projectWork.listSerial += 1
  rememberProjectWorkspace(); setView('projects')
  renderProjectNavigation(); renderProjectEmployees()
  var remembered = sessionId || recallSession(projectHistoryKey(project))
  var cachedSession = projectWork.sessions.find(function (s) { return sessionIdOf(s) === remembered && (sessionId || !s.archived) })
  if (cachedSession || (remembered && state.phase !== 'ready')) openProjectConversation(remembered, true)
  else openProjectConversation(null, true)
  projectWork.requestedSession = sessionId || ''
  projectWork.newTask = false
  return loadProjectSessions(false, sessionId)
}
function openProjectSessionFromEmployee(session) {
  var project = { projectId: session.projectId, nodeId: session.nodeId, name: session.projectName || '项目', path: session.projectPath,
    createdAtMs: 0, lastOpenedAtMs: Date.now() }
  if (!projectWork.projects.some(function (p) { return projectKey(p) === projectKey(project) })) projectWork.projects.unshift(project)
  return openProjectTask(project, sessionIdOf(session))
}
function openProjectConversation(sessionId, skipDraft) {
  if (!skipDraft) projectSaveDraft()
  projectUnsubscribe()
  projectWork.serial += 1; projectWork.listSerial += 1; projectWork.historyLoading = false
  projectWork.sessionId = sessionId; projectWork.events = []; projectWork.hasMore = false
  projectWork.requestedSession = ''
  projectWork.oldestSeq = null; projectWork.historyRead = false; projectWork.newTask = sessionId === null
  var session = projectSelectedSession(); projectWork.running = session !== null && session.running === true
  if (session !== null && session.archived && $('projectShowArchived') !== null) $('projectShowArchived').checked = true
  var input = $('projectPrompt'), project = projectWork.current
  if (input !== null) input.value = projectWork.drafts.get(projectKey(project) + '/' + (sessionId || 'new')) || ''
  if (sessionId !== null && project !== null) {
    rememberSession(projectHistoryKey(project), sessionId)
    var cached = readCachedHistory(projectHistoryKey(project), sessionId)
    if (cached !== null && cached !== undefined && Array.isArray(cached.events)) {
      projectWork.events = cached.events; projectWork.hasMore = cached.hasMore === true
      projectWork.oldestSeq = typeof cached.oldestSeq === 'number' ? cached.oldestSeq : null
    }
  }
  renderProjectNavigation(); renderProjectHistory(true)
  if (sessionId !== null) return syncProjectConversation()
  return Promise.resolve()
}
function loadProjectSessions(refreshHistory, requestedSession) {
  var project = projectWork.current
  if (project === null || state.phase !== 'ready') return Promise.resolve()
  var serial = ++projectWork.listSerial
  var liveSerial = projectWork.liveSerial
  return rpc('session.list', projectParams(project)).then(function (payload) {
    if (projectKey(project) !== projectKey(projectWork.current) || serial !== projectWork.listSerial) return
    if (!payload || !Array.isArray(payload.sessions)) throw new Error('节点未返回有效的会话列表')
    var wasRunning = projectWork.running
    projectWork.sessions = payload.sessions
    rememberSessionList(projectHistoryKey(project), payload.sessions)
    if (projectWork.sessionId === null && !projectWork.newTask) {
      var remembered = requestedSession || projectWork.requestedSession || recallSession(projectHistoryKey(project))
      var candidate = payload.sessions.find(function (s) { return sessionIdOf(s) === remembered && (requestedSession || projectWork.requestedSession || s.archived !== true) }) ||
        payload.sessions.filter(function (s) { return s.archived !== true }).slice().sort(function (a, b) {
          return Number(b.updatedAt || b.updatedAtMs || b.createdAtMs || 0) - Number(a.updatedAt || a.updatedAtMs || a.createdAtMs || 0)
        })[0]
      if (candidate) { projectWork.requestedSession = ''; return openProjectConversation(sessionIdOf(candidate)) }
      projectWork.newTask = true
    }
    var selected = projectSelectedSession()
    if (selected !== null && projectWork.liveSerial === liveSerial) projectWork.running = selected.running === true
    renderProjectNavigation()
    if (projectWork.sessionId !== null && (refreshHistory || wasRunning || projectWork.running)) return syncProjectConversation()
  }).catch(function (error) {
    if (projectKey(project) === projectKey(projectWork.current) && serial === projectWork.listSerial) projectTell('会话列表读取失败，已保留当前内容：' + describeError(error), true)
  })
}
function syncProjectConversation() {
  var project = projectWork.current, sessionId = projectWork.sessionId, serial = projectWork.serial
  if (project === null || sessionId === null || state.phase !== 'ready') return Promise.resolve()
  var params = projectParams(project, sessionId)
  return rpc('session.subscribe', params).then(function () {
    if (projectStill(project, sessionId, serial)) projectWork.subscribed = params
    else if (projectKey(projectWork.current) !== projectKey(project) || projectWork.sessionId !== sessionId) rpc('session.unsubscribe', params).catch(function () {})
  }).catch(function (error) {
    if (projectStill(project, sessionId, serial)) projectTell('实时连接未恢复，可点刷新重试：' + describeError(error), true)
  }).then(function () { if (projectStill(project, sessionId, serial)) return loadProjectHistory(false) })
}
function loadProjectHistory(older) {
  var project = projectWork.current, sessionId = projectWork.sessionId, serial = projectWork.serial
  if (project === null || sessionId === null || state.phase !== 'ready' || projectWork.historyLoading) return Promise.resolve()
  var params = projectParams(project, sessionId); params.maxEvents = 400
  if (older && projectWork.oldestSeq !== null) params.beforeSeq = projectWork.oldestSeq
  projectWork.historyLoading = true
  var box = $('projectMessages'), height = box === null ? 0 : box.scrollHeight, top = box === null ? 0 : box.scrollTop
  return rpc('session.history', params).then(function (payload) {
    if (!projectStill(project, sessionId, serial)) return
    if (!payload || !Array.isArray(payload.events)) throw new Error('节点未返回有效历史')
    projectWork.events = mergeSessionHistory(payload.events, projectWork.events).map(function (record) { return record.entry })
    if (older || !projectWork.historyRead) {
      projectWork.hasMore = payload.hasMore === true
      projectWork.oldestSeq = typeof payload.oldestSeq === 'number' ? payload.oldestSeq : null
    }
    projectWork.historyRead = true
    rememberHistory(projectHistoryKey(project), sessionId, { events: projectWork.events, hasMore: projectWork.hasMore, oldestSeq: projectWork.oldestSeq })
    renderProjectHistory(false, !older)
    if (older && box !== null) box.scrollTop = top + box.scrollHeight - height
  }).catch(function (error) {
    if (projectStill(project, sessionId, serial)) projectTell('历史读取失败，当前消息仍保留，可点刷新重试：' + describeError(error), true)
  }).finally(function () { if (projectStill(project, sessionId, serial)) projectWork.historyLoading = false })
}
function projectMessage(container, kind, label) {
  var row = el('div', 'project-message ' + kind), body = el('div', 'project-message-body')
  row.appendChild(el('div', 'muted', label)); row.appendChild(body); container.appendChild(row)
  return body
}
function renderProjectHistory(forceTail, updating) {
  var box = $('projectMessages')
  if (box === null) return
  var top = box.scrollTop, follow = forceTail || box.scrollHeight - box.clientHeight - top < 80
  if (updating && !follow) {
    projectWork.unpainted = true
    var latest = $('btnProjectLatest'); if (latest !== null) latest.classList.remove('hidden')
    return
  }
  projectWork.unpainted = false
  var openTools = new Set(Array.from(box.querySelectorAll('details[data-tool-id]')).filter(function (tool) { return tool.open }).map(function (tool) { return tool.getAttribute('data-tool-id') }))
  clear(box)
  if (projectWork.hasMore) {
    var more = el('button', 'ghost', '读取更早的消息'); more.onclick = function () { loadProjectHistory(true) }; box.appendChild(more)
  }
  var assistant = null, assistants = [], tools = Object.create(null), context = projectWork.current === null ? null : projectParams(projectWork.current)
  var session = projectSelectedSession(), peer = session && session.employeeName ? session.employeeName : '助手'
  projectWork.events.forEach(function (entry) {
    var n = normalizeEvent(entry)
    if (n.kind === 'user') {
      assistant = null; tools = Object.create(null)
      var text = n.text
      var frameKinds = ['员工', '项目']
      frameKinds.forEach(function (kind) {
        var marker = '\n【' + kind + '背景结束】\n\n【本次任务】\n'
        if (text.indexOf('【DSE ' + kind + '背景】\n') === 0 && text.indexOf(marker) >= 0) text = text.slice(text.indexOf(marker) + marker.length)
      })
      projectMessage(box, 'user', '你').textContent = text
    } else if (n.kind === 'assistant') {
      if (assistant === null) { assistant = { body: projectMessage(box, 'assistant', peer), blocks: Object.create(null), final: null }; assistants.push(assistant) }
      if (n.stream === 'message') assistant.final = n.text
      else {
        var key = String(n.index === undefined ? 0 : n.index)
        assistant.blocks[key] = n.stream === 'delta' ? (assistant.blocks[key] || '') + n.text : n.text
      }
    } else if (n.kind === 'tool') {
      assistant = null
      var tool = tools[n.toolId]
      if (!tool) { tool = el('details', 'project-tool'); tool.setAttribute('data-tool-id', n.toolId); tool.open = openTools.has(n.toolId); tool.appendChild(el('summary', '', n.name)); tool.appendChild(el('pre', '', '')); box.appendChild(tool); tools[n.toolId] = tool }
      tool.firstChild.textContent = n.name + (n.phase === 'call' ? ' · 执行中' : n.failed ? ' · 失败' : ' · 已返回')
      tool.lastChild.textContent = n.detail
    } else if (n.kind === 'error') {
      assistant = null
      var body = projectMessage(box, 'error', '回合失败' + (typeof n.atMs === 'number' ? ' · ' + new Date(n.atMs).toLocaleString() : ''))
      body.appendChild(el('p', '', turnFailureMessage(n)))
      var detail = el('details', ''); detail.appendChild(el('summary', '', '错误详情')); detail.appendChild(el('pre', '', (n.code || '') + '\n' + n.text)); body.appendChild(detail)
    } else if (n.kind === 'interaction') {
      assistant = null
      var body = projectMessage(box, 'interaction', '需要你处理'); body.appendChild(el('p', '', n.text))
      if (n.phase === 'request') { var approval = el('button', 'ghost', '打开审批与提问'); approval.onclick = function () { setView('approvals') }; body.appendChild(approval) }
    } else if (n.type === 'turn/end') assistant = null
  })
  assistants.forEach(function (message) {
    var output = message.final === null ? Object.keys(message.blocks).map(function (key) { return message.blocks[key] }).join('') : message.final
    renderMarkdown(message.body, output, context)
  })
  if (box.childNodes.length === 0) box.appendChild(el('p', 'muted', projectWork.current === null ? '选择一个项目，或打开已有目录。' : projectWork.sessionId === null ? '直接输入任务即可开始，无需创建员工。' : '这个会话还没有消息。'))
  box.scrollTop = follow ? box.scrollHeight : top
  var latest = $('btnProjectLatest'); if (latest !== null) latest.classList.toggle('hidden', follow)
}
function onProjectSessionEvent(payload) {
  if (!payload || projectWork.current === null || payload.sessionId !== projectWork.sessionId ||
      (payload.nodeId && payload.nodeId !== projectWork.current.nodeId) ||
      (payload.projectId && payload.projectId !== projectWork.current.projectId)) return
  var n = normalizeEvent(payload)
  projectWork.liveSerial += 1
  if (n.type === 'turn/start') projectWork.running = true
  if (n.type === 'turn/end') projectWork.running = false
  if (sessionEventSeq(payload) !== null) projectWork.events = mergeSessionHistory(projectWork.events, [payload]).map(function (record) { return record.entry })
  if (!projectWork.paintPending) {
    projectWork.paintPending = true
    requestAnimationFrame(function () {
      projectWork.paintPending = false
      if (state.view === 'projects') { renderProjectHistory(false, true); renderProjectHeader() }
    })
  }
  if (n.kind === 'user' || n.type === 'turn/end' || (n.kind === 'assistant' && n.stream === 'message')) {
    rememberHistory(projectHistoryKey(projectWork.current), projectWork.sessionId, { events: projectWork.events, hasMore: projectWork.hasMore, oldestSeq: projectWork.oldestSeq })
  }
}
function sendProjectPrompt() {
  var input = $('projectPrompt'), project = projectWork.current
  var selected = projectSelectedSession()
  if (input === null || project === null || projectWork.sending || projectWork.mutating || state.phase !== 'ready' ||
      state.scopes.indexOf('employee.prompt') < 0 || (selected && (selected.archived || selected.setupError))) return
  var text = input.value.trim(), original = input.value, serial = projectWork.serial, sessionId = projectWork.sessionId
  if (text === '') return
  if (sessionId === null) projectWork.newTask = true
  projectWork.listSerial += 1
  var employee = String(($('projectEmployee') || {}).value || ''), title = String(($('projectTaskName') || {}).value || '').trim()
  if (sessionId === null) {
    var executorError = projectExecutorError(project, employee)
    if (executorError) { projectTell(executorError, true); return }
    if ($('projectEmployee').disabled) { projectTell('员工目录正在读取，请稍后再发送。', true); return }
  }
  var draftKey = projectKey(project) + '/' + (sessionId || 'new')
  projectWork.drafts.set(draftKey, original); projectWork.sending = true; syncProjectControls(); projectTell('正在发送…', false)
  var creating = sessionId !== null ? Promise.resolve({ sessionId: sessionId }) : (function () {
    var params = projectParams(project)
    if (employee !== '') params.employeeId = employee
    if (title !== '') params.title = title
    return rpc('session.create', params)
  })()
  creating.then(function (created) {
    if (!created || typeof created.sessionId !== 'string') throw new Error('未取得有效的会话编号，指令尚未发送')
    sessionId = created.sessionId
    rememberSession(projectHistoryKey(project), sessionId)
    if (projectStill(project, projectWork.sessionId, serial)) {
      projectWork.sessionId = sessionId; projectWork.newTask = false
      projectWork.listSerial += 1
      if (!projectSelectedSession()) projectWork.sessions.unshift({ sessionId: sessionId, title: title, employeeId: employee || undefined,
        employeeName: employee ? (employeeById(employee) || {}).name : undefined, employeeHome: created.employeeHome,
        employeeContextVersion: created.employeeContextVersion, setupError: created.modelError, running: false })
      if ($('projectTaskName') !== null && $('projectTaskName').value.trim() === title) $('projectTaskName').value = ''
    }
    if (created.modelError) throw new Error(created.modelError + '。请修复模型配置后新建任务；原指令已保留。')
    if (created.titleError) toast(created.titleError, 'warn')
    if (projectStill(project, sessionId, serial)) return syncProjectConversation()
  }).then(function () {
    var params = projectParams(project, sessionId); params.text = text
    var liveSerial = projectWork.liveSerial
    return rpc('session.prompt', params).then(function (payload) {
      if (projectWork.drafts.get(draftKey) === original) projectWork.drafts.delete(draftKey)
      var sessionDraftKey = projectKey(project) + '/' + sessionId
      if (projectWork.drafts.get(sessionDraftKey) === original) projectWork.drafts.delete(sessionDraftKey)
      if (projectStill(project, sessionId, serial)) {
        if (input.value === original) input.value = ''
        if (liveSerial === projectWork.liveSerial) projectWork.running = !(payload && payload.queued)
        projectTell(payload && payload.queued ? '执行节点离线，指令已进入队列，等待节点恢复。' : '指令已接收，等待执行结果。', false)
        loadProjectSessions(true)
      } else toast('指令已发送到原项目。', 'ok')
    })
  }).catch(function (error) {
    if (projectKey(project) === projectKey(projectWork.current) && projectWork.serial === serial) projectTell('发送未完成，指令已保留：' + describeError(error) + '。结果不确定时请先刷新会话确认，再决定是否重发。', true)
    else toast('原项目的指令发送未完成：' + describeError(error), 'bad')
  }).finally(function () { projectWork.sending = false; renderProjectHeader() })
}
function changeProjectSession(method, extra) {
  var project = projectWork.current, sessionId = projectWork.sessionId, serial = projectWork.serial
  if (project === null || sessionId === null || projectWork.mutating) return
  projectWork.mutating = true; projectWork.listSerial += 1; syncProjectControls()
  var params = projectParams(project, sessionId)
  Object.keys(extra || {}).forEach(function (key) { params[key] = extra[key] })
  rpc(method, params).then(function () {
    if (projectStill(project, sessionId, serial)) { projectTell('已更新', false); return loadProjectSessions(true) }
  }).catch(function (error) { if (projectStill(project, sessionId, serial)) projectTell('操作失败：' + describeError(error), true) })
    .finally(function () { projectWork.mutating = false; renderProjectHeader() })
}
function projectFileCard(context, filePath, label) {
  var button = el('button', 'ghost', (label || filePath) + ' · 下载')
  button.type = 'button'
  button.onclick = function () {
    button.disabled = true
    downloadEmployeeFile(context, filePath).catch(function (error) { toast('下载失败：' + describeError(error), 'bad') })
      .finally(function () { button.disabled = false })
  }
  return button
}
function bindProjectUi() {
  if ($('projectOpenForm') === null) return
  bindProjectDirectoryPicker()
  $('projectOpenForm').onsubmit = openProjectDirectoryPicker
  $('btnProjectRefresh').onclick = function () { projectTell('', false); loadEmployees(true); loadProjectWorkspace() }
  $('btnProjectNewTask').onclick = function () { openProjectConversation(null); loadEmployees(true); $('projectPrompt').focus() }
  $('projectShowArchived').onchange = renderProjectNavigation
  $('projectEmployee').onchange = function () {
    if (projectWork.current !== null) { projectWork.selectedEmployees[projectWork.current.nodeId] = $('projectEmployee').value; rememberProjectWorkspace(); syncProjectControls() }
  }
  $('projectPrompt').oninput = function () {
    if (projectWork.sessionId === null) { projectWork.newTask = true; projectWork.requestedSession = '' }
    projectSaveDraft(); syncProjectControls()
  }
  $('projectPrompt').onkeydown = function (event) { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); sendProjectPrompt() } }
  $('btnProjectSend').onclick = sendProjectPrompt
  $('btnProjectCancel').onclick = function () { changeProjectSession('session.cancel', {}) }
  $('btnProjectArchive').onclick = function () { var session = projectSelectedSession(); if (session !== null) changeProjectSession('session.archive', { archived: !session.archived }) }
  $('btnProjectRename').onclick = function () {
    var session = projectSelectedSession(); if (session === null) return
    var title = window.prompt('任务名称', sessionTitleOf(session) || '')
    if (title !== null && title.trim() !== '') changeProjectSession('session.rename', { title: title.trim() })
  }
  $('btnProjectLatest').onclick = function () { renderProjectHistory(true); $('btnProjectLatest').classList.add('hidden') }
  $('projectMessages').onscroll = function () {
    var box = $('projectMessages'), following = box.scrollHeight - box.clientHeight - box.scrollTop < 80
    $('btnProjectLatest').classList.toggle('hidden', following)
    if (following && projectWork.unpainted) renderProjectHistory(true)
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && state.view === 'projects') loadProjectWorkspace() })
  setInterval(function () {
    if (state.view !== 'projects' || document.visibilityState === 'hidden' || state.phase !== 'ready' || projectWork.current === null || projectWork.pollPending) return
    projectWork.pollPending = true
    loadProjectSessions(false).finally(function () { projectWork.pollPending = false })
  }, 3500)
}
`
