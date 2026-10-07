/** 员工配置工作台：选择与聊天独立，草稿只存在页面内存，异步响应局部更新。 */
export const CHUNK_43_EMPLOYEE_CONFIG = String.raw`
function configCanManage() {
  return state.phase === 'ready' && state.scopes.indexOf('employee.manage') >= 0
}

function configButton(text, action, primary) {
  var button = el('button', primary === true ? 'primary' : 'ghost', text)
  button.type = 'button'
  button.onclick = action
  return button
}

function configField(text, input, help) {
  var label = el('label', 'config-field')
  label.appendChild(el('span', 'config-label', text))
  label.appendChild(input)
  if (help) label.appendChild(el('span', 'muted config-help', help))
  return label
}

function configCheck(text, checked, change) {
  var label = el('label', 'config-check')
  var input = el('input', '')
  input.type = 'checkbox'
  input.checked = checked === true
  input.onchange = function () { change(input.checked === true) }
  label.appendChild(input)
  label.appendChild(el('span', '', text))
  return label
}

function configEmployee() {
  return employeeById(String(state.configEmployeeId || ''))
}

function configDraft(employee) {
  var id = String(employee.id)
  if (state.configDrafts[id] === undefined) {
    state.configDrafts[id] = {
      identity: { name: String(employee.name || ''), group: String(employee.group || ''), intro: String(employee.intro || ''), position: { id: String(employee.position || 'general') }, dirty: false },
      model: { open: false, endpointId: '', model: '', name: '', nameTouched: false, activate: true, switchSession: false },
      approval: { value: employee.autoApprove === true, dirty: false }
    }
  }
  var draft = state.configDrafts[id]
  if (!draft.identity.dirty && !state.configPending[id]) {
    draft.identity.name = String(employee.name || '')
    draft.identity.group = String(employee.group || '')
    draft.identity.intro = String(employee.intro || '')
    draft.identity.position = { id: String(employee.position || 'general') }
  }
  if (!draft.approval.dirty) draft.approval.value = employee.autoApprove === true
  return draft
}

function configMessage(employeeId, text, bad) {
  state.configMessages[employeeId] = { text: text, bad: bad === true }
  if (state.configEmployeeId === employeeId) paintConfigMessage()
}

function paintConfigMessage() {
  var box = $('configEmployeeMessage')
  if (box === null) return
  var info = state.configMessages[state.configEmployeeId]
  box.className = 'config-message' + (info === undefined || !info.text ? ' hidden' : info.bad ? ' warn' : '')
  box.textContent = info === undefined ? '' : info.text
}

function openEmployeeConfig() {
  var pages = $('configPages')
  if (pages === null) return
  pages.querySelectorAll('[data-config-page]').forEach(function (button) {
    button.onclick = function () { setConfigPage(button.getAttribute('data-config-page')) }
  })
  $('configTabs').querySelectorAll('[data-config-tab]').forEach(function (button) {
    button.onclick = function () {
      state.configTab = button.getAttribute('data-config-tab')
      renderLlmConfig(true)
      if (state.configTab === 'approval' && configEmployee() !== null) loadPermissionPreset(String(configEmployee().id))
    }
  })
  $('configSearch').value = state.configSearch
  $('configSearch').oninput = function () { state.configSearch = this.value; renderConfigDirectory() }
  $('configMobileEmployee').onchange = function () { selectConfigEmployee(this.value) }
  $('btnBatchModels').onclick = function () {
    state.configBatch.open = !state.configBatch.open
    renderBatchModels()
  }
  loadLlmEndpoints()
  setConfigPage(state.configPage)
  if (state.configPage === 'employees' && configEmployee() !== null && !state.configPending[state.configEmployeeId]) loadLlmDetail(state.configEmployeeId)
}

function setConfigPage(page) {
  state.configPage = ['employees', 'services', 'nodes'].indexOf(page) >= 0 ? page : 'employees'
  var map = { employees: 'configEmployees', services: 'configServices', nodes: 'configNodes' }
  Object.keys(map).forEach(function (key) { $(map[key]).classList.toggle('hidden', key !== state.configPage) })
  $('configPages').querySelectorAll('[data-config-page]').forEach(function (button) {
    button.setAttribute('aria-pressed', String(button.getAttribute('data-config-page') === state.configPage))
  })
  if (state.configPage === 'employees') renderLlmConfig()
  if (state.configPage === 'services') { bindEndpointUi(); renderEndpointList() }
  if (state.configPage === 'nodes') loadNodePermissions()
}

function selectConfigEmployee(employeeId) {
  if (employeeById(employeeId) === null) return
  state.configEmployeeId = employeeId
  writeLocal(LS.configEmployee + '.' + BOOT.hubId, employeeId)
  renderLlmConfig(true)
}

function renderConfigDirectory() {
  var box = $('configEmployeeList')
  var select = $('configMobileEmployee')
  if (box === null || select === null) return
  clear(box); clear(select)
  var query = String(state.configSearch || '').trim().toLowerCase()
  var groups = new Map()
  state.employees.forEach(function (employee) {
    var position = positionName(employee.position) || '通用'
    var option = el('option', '', String(employee.name) + '（' + position + '）')
    option.value = String(employee.id)
    select.appendChild(option)
    if ((String(employee.name) + position + groupOf(employee)).toLowerCase().indexOf(query) < 0) return
    var group = groupOf(employee)
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(employee)
  })
  select.value = String(state.configEmployeeId || '')
  Array.from(groups.keys()).sort(function (a, b) { return a.localeCompare(b, 'zh-Hans-CN') }).forEach(function (group) {
    box.appendChild(el('div', 'config-group-title', group))
    groups.get(group).forEach(function (employee) {
      var id = String(employee.id)
      var choose = configButton('', function () { selectConfigEmployee(id) })
      choose.className = 'config-person'
      choose.setAttribute('aria-pressed', String(id === state.configEmployeeId))
      choose.appendChild(avatarNode(employee, 28)); ensureAvatar(employee)
      var copy = el('span', 'config-person-copy')
      copy.appendChild(el('span', 'config-person-name', String(employee.name) + '（' + (positionName(employee.position) || '通用') + '）'))
      copy.appendChild(el('span', 'muted config-help', String(employee.nodeName || '节点') + ' · ' + (employee.nodeOnline === false ? '离线' : '在线')))
      choose.appendChild(copy)
      box.appendChild(choose)
    })
  })
  if (groups.size === 0) box.appendChild(el('div', 'muted', state.employees.length === 0 ? '暂无员工' : '没有匹配的员工'))
}

function renderLlmConfig(force) {
  var list = $('llmConfigList')
  if (list === null || $('configEmployeeList') === null) return
  if (configEmployee() === null) {
    var remembered = readLocal(LS.configEmployee + '.' + BOOT.hubId)
    state.configEmployeeId = employeeById(String(remembered || '')) !== null ? remembered
      : employeeById(String(state.selectedEmployeeId || '')) !== null ? state.selectedEmployeeId
      : state.employees.length > 0 ? String(state.employees[0].id) : null
  }
  renderConfigDirectory()
  renderBatchModels()
  var employee = configEmployee()
  var heading = $('configEmployeeHeading')
  clear(heading)
  if (employee === null) {
    clear(list); state.configDetailKey = ''
    list.appendChild(el('div', 'empty', state.phase === 'ready' ? '暂无员工，请先在办公区创建员工。' : '连接后可读取员工配置。'))
    return
  }
  var id = String(employee.id)
  configDraft(employee)
  var head = el('div', 'config-person-header')
  head.appendChild(avatarNode(employee, 44)); ensureAvatar(employee)
  var info = el('div', '')
  info.appendChild(el('h3', '', String(employee.name) + '（' + (positionName(employee.position) || '通用') + '）'))
  info.appendChild(el('div', 'muted config-help', groupOf(employee) + ' · ' + String(employee.nodeName || '节点') + ' · ' + (state.phase !== 'ready' ? '连接已断开' : employee.nodeOnline === false ? '节点离线' : '节点在线')))
  head.appendChild(info); heading.appendChild(head)
  $('configTabs').querySelectorAll('[data-config-tab]').forEach(function (button) {
    button.setAttribute('aria-pressed', String(button.getAttribute('data-config-tab') === state.configTab))
  })
  paintConfigMessage()
  var key = id + ':' + state.configTab
  if (state.configDetailKey !== key || force === true) {
    state.configDetailKey = key
    clear(list)
    if (state.configTab === 'identity') list.appendChild(buildConfigIdentity(employee))
    else if (state.configTab === 'approval') list.appendChild(buildConfigApproval(employee))
    else list.appendChild(buildConfigModels(employee))
  }
  refreshConfigModels(id)
  paintConfigPermission(id)
  syncConfigControls()
  if (state.configTab === 'models' && state.llmDetail[id] === undefined && !state.configLoads[id] && state.configErrors[id] === undefined && state.phase === 'ready' && employee.nodeOnline !== false) loadLlmDetail(id)
  if (state.configTab === 'approval' && state.llmPermission[id] === undefined && state.phase === 'ready' && employee.nodeOnline !== false) loadPermissionPreset(id)
}

function syncConfigControls() {
  var employee = configEmployee()
  if (employee === null) return
  var busy = !!state.configPending[String(employee.id)]
  var canManage = configCanManage()
  var root = $('llmConfigList')
  if (root === null) return
  root.querySelectorAll('[data-config-write]').forEach(function (button) { button.disabled = !canManage || busy || employee.nodeOnline === false })
  root.querySelectorAll('input, textarea, select').forEach(function (input) { input.disabled = !canManage || busy })
  root.querySelectorAll('[data-config-hub-write]').forEach(function (input) { input.disabled = !canManage || busy })
  $('btnBatchModels').disabled = !canManage && !state.configBatch.open
}

function configWriteButton(text, action, primary) {
  var button = configButton(text, action, primary)
  button.setAttribute('data-config-write', '')
  return button
}

function configModelDraft(employeeId) {
  return configDraft(employeeById(employeeId)).model
}

/** 返回固定字段名的模型表单；异步响应只改候选项，不替换本表单。批量也复用它。 */
function buildConfigModelFields(draft, prefix) {
  var form = el('div', 'config-model-fields')
  var endpoint = el('select', '')
  endpoint.setAttribute('data-config-edit', '')
  var paintServices = function () {
    clear(endpoint)
    var placeholder = el('option', '', '请选择模型服务'); placeholder.value = ''; endpoint.appendChild(placeholder)
    state.llmEndpoints.forEach(function (entry) { var option = el('option', '', String(entry.name)); option.value = String(entry.id); endpoint.appendChild(option) })
    if (draft.endpointId && endpointById(draft.endpointId) === undefined) { var missing = el('option', '', '服务已删除'); missing.value = draft.endpointId; endpoint.appendChild(missing) }
    endpoint.value = draft.endpointId
  }
  paintServices()
  endpoint.setAttribute('data-config-endpoints', prefix)
  form.appendChild(configField('模型服务', endpoint))
  var model = el('input', '')
  model.type = 'text'; model.maxLength = 200; model.value = draft.model
  model.setAttribute('list', prefix + '-models'); model.setAttribute('data-config-edit', '')
  var dataList = el('datalist', ''); dataList.id = prefix + '-models'
  paintModelOptions(dataList, endpointModelsOf(draft.endpointId))
  form.appendChild(configField('模型', model, '从候选列表选择，也可填写服务支持的模型 ID。')); form.appendChild(dataList)
  var alias = el('input', '')
  alias.type = 'text'; alias.maxLength = 64; alias.value = draft.name; alias.setAttribute('data-config-edit', '')
  form.appendChild(configField('显示名称', alias, '建议名称可直接修改。'))
  var suggest = function () {
    if (!draft.nameTouched) { draft.name = (draft.model + (draft.endpointId ? '-' + endpointLabel(draft.endpointId) : '')).slice(0, 64); alias.value = draft.name }
  }
  endpoint.onchange = function () { draft.endpointId = endpoint.value; paintModelOptions(dataList, endpointModelsOf(endpoint.value)); suggest() }
  model.oninput = function () { draft.model = model.value; suggest() }
  alias.oninput = function () { draft.name = alias.value; draft.nameTouched = true }
  return form
}

function paintModelOptions(dataList, models) {
  if (dataList === null) return
  clear(dataList)
  ;(models || []).forEach(function (modelId) { var option = el('option', '', modelId); option.value = modelId; dataList.appendChild(option) })
}

function endpointModelsOf(endpointId) {
  var entry = endpointById(endpointId)
  return entry !== undefined && Array.isArray(entry.models) ? entry.models : []
}

function refreshConfigModelChoices() {
  document.querySelectorAll('[data-config-endpoints]').forEach(function (select) {
    var previous = select.value
    var active = document.activeElement === select
    if (active) return
    clear(select)
    var placeholder = el('option', '', '请选择模型服务'); placeholder.value = ''; select.appendChild(placeholder)
    state.llmEndpoints.forEach(function (entry) { var option = el('option', '', String(entry.name)); option.value = String(entry.id); select.appendChild(option) })
    if (previous && endpointById(previous) === undefined) { var missing = el('option', '', '服务已删除'); missing.value = previous; select.appendChild(missing) }
    select.value = previous
    paintModelOptions($(select.getAttribute('data-config-endpoints') + '-models'), endpointModelsOf(previous))
  })
}

function buildConfigModels(employee) {
  var id = String(employee.id), draft = configDraft(employee).model
  var panel = el('div', '')
  panel.appendChild(el('div', 'config-model-summary'))
  panel.appendChild(el('div', 'config-model-list'))
  panel.appendChild(el('p', 'muted config-help', '默认模型用于新会话。已有会话保留原来的模型；切换时可选择同时切换当前打开的会话。'))
  var add = configWriteButton(draft.open ? '收起添加表单' : '＋ 添加模型', function () {
    draft.open = !draft.open
    editor.classList.toggle('hidden', !draft.open)
    add.textContent = draft.open ? '收起添加表单' : '＋ 添加模型'
  })
  var toolbar = el('div', 'config-actions')
  toolbar.appendChild(add)
  toolbar.appendChild(configButton('刷新配置', function () { loadLlmDetail(id) }))
  panel.appendChild(toolbar)
  var editor = el('div', 'config-form' + (draft.open ? '' : ' hidden'))
  editor.appendChild(el('h3', '', '添加模型'))
  editor.appendChild(buildConfigModelFields(draft, 'config-model-' + id))
  editor.appendChild(configCheck('同时设为新会话默认模型', draft.activate, function (value) { draft.activate = value }))
  if (currentSessionOf(id) !== '') editor.appendChild(configCheck('设为默认时，同时切换本控制台当前打开的会话', draft.switchSession, function (value) { draft.switchSession = value }))
  var error = el('div', 'warn config-help'); error.setAttribute('role', 'alert'); editor.appendChild(error)
  var actions = el('div', 'config-actions')
  actions.appendChild(configWriteButton('添加模型', function () {
    if (!draft.endpointId || !draft.model.trim() || !draft.name.trim()) { error.textContent = '请选择模型服务，并填写模型与显示名称。'; return }
    if (endpointById(draft.endpointId) === undefined) { error.textContent = '模型服务已不存在，请重新选择。'; return }
    var sessionId = draft.activate && draft.switchSession ? currentSessionOf(id) : ''
    saveModel(id, { endpointId: draft.endpointId, model: draft.model.trim(), name: draft.name.trim() }, draft.activate, sessionId)
  }, true))
  actions.appendChild(configButton('新增模型服务', function () {
    state.configEndpointReturn = { employeeId: id }
    setConfigPage('services'); openEndpointEditor('new')
  }))
  editor.appendChild(actions); panel.appendChild(editor)
  return panel
}

function refreshConfigModels(employeeId) {
  if (state.configEmployeeId !== employeeId || state.configTab !== 'models') return
  var root = $('llmConfigList'), summary = root.querySelector('.config-model-summary'), list = root.querySelector('.config-model-list')
  if (summary === null || list === null) return
  var employee = employeeById(employeeId), detail = state.llmDetail[employeeId]
  if (employee === null) return
  var signature = JSON.stringify([detail, state.configLoads[employeeId], state.configErrors[employeeId], state.phase, employee.nodeOnline, state.configPending[employeeId], state.llmEndpoints.map(function (entry) { return [entry.id, entry.name] })])
  if (list.configSignature === signature) return
  /* 目录推送不打断正在改名或确认切换的操作；写入开始后才更新结果。 */
  if (!state.configPending[employeeId] && (list.querySelector('.config-more[open]') !== null || list.querySelector('.config-switch:not(.hidden)') !== null)) return
  list.configSignature = signature
  clear(summary); clear(list)
  summary.appendChild(el('div', 'muted config-help', '新会话默认模型'))
  var active = pickArray(detail, ['models']).filter(function (item) { return item.active === true })[0]
  summary.appendChild(el('strong', '', active ? String(active.name) : String(employee.llmActiveName || '节点默认模型')))
  if (active) summary.appendChild(el('div', 'muted config-help', endpointLabel(String(active.endpointId || '')) + ' · ' + String(active.model)))
  if (employee.nodeOnline === false || state.phase !== 'ready') list.appendChild(el('p', 'warn config-help', '当前离线，保留已读取的配置；连接恢复后可刷新和修改。'))
  if (state.configLoads[employeeId]) list.appendChild(el('div', 'muted', detail === undefined ? '正在读取配置…' : '正在刷新配置…'))
  if (state.configErrors[employeeId]) {
    list.appendChild(el('div', 'warn config-help', '读取失败：' + state.configErrors[employeeId]))
    var retry = configButton('重新读取', function () { loadLlmDetail(employeeId) })
    retry.disabled = state.phase !== 'ready' || employee.nodeOnline === false
    list.appendChild(retry)
  }
  if (detail === undefined) return
  if (!Array.isArray(detail.models)) {
    list.appendChild(el('p', 'warn', '该节点使用旧版模型配置：' + String(detail.model || '') + '。升级节点后可管理多个模型。'))
    list.appendChild(configButton('去体检页', function () { setView('health') })); return
  }
  list.appendChild(el('h3', 'config-section-title', '已添加模型（' + detail.models.length + '）'))
  detail.models.forEach(function (item) { list.appendChild(buildModelRow(employeeId, item, configCanManage())) })
  if (detail.models.length === 0) list.appendChild(el('p', 'muted', '还没有添加模型，当前使用节点默认模型。'))
  if (detail.models.length > 0 && configCanManage()) {
    var danger = el('details', 'config-danger')
    danger.appendChild(el('summary', '', '管理操作'))
    danger.appendChild(configWriteButton('清空该员工全部模型配置', function () {
      if (!window.confirm('清空「' + employee.name + '」的全部模型配置？新会话将使用节点默认模型，已有模型路由会移除。')) return
      configMutation(employeeId, 'employee.llm.unset', { employeeId: employeeId }, '全部模型配置已清空。')
    }))
    list.appendChild(danger)
  }
  syncConfigControls()
}

function buildModelRow(employeeId, item, canManage) {
  var row = el('div', 'config-model-row'), copy = el('div', 'config-model-copy')
  var title = el('div', 'config-model-title')
  title.appendChild(el('strong', '', String(item.name || item.id)))
  if (item.active === true) title.appendChild(el('span', 'chip', '默认'))
  if (item.wired !== true) title.appendChild(el('span', 'warn config-help', '连接未完成'))
  copy.appendChild(title)
  copy.appendChild(el('div', 'muted config-help', endpointLabel(String(item.endpointId || '')) + ' · ' + String(item.model)))
  row.appendChild(copy)
  if (!canManage) return row
  var actions = el('div', 'config-actions')
  var use = configWriteButton(item.wired !== true ? '重试连接' : item.active === true ? '切换当前会话' : '设为默认', function () {
    clear(confirm)
    confirm.classList.remove('hidden')
    var sessionId = currentSessionOf(employeeId)
    var switchSession = sessionId !== ''
    confirm.appendChild(el('div', '', '将「' + String(item.name) + '」用于新会话。'))
    if (sessionId) confirm.appendChild(configCheck('同时切换本控制台当前打开的会话', true, function (value) { switchSession = value }))
    confirm.appendChild(el('p', 'muted config-help', '正在运行的会话需回合结束后再切换，不会自动等待。'))
    confirm.appendChild(configWriteButton('确认切换', function () { activateModel(employeeId, String(item.id), null, switchSession ? sessionId : '') }, true))
    confirm.appendChild(configButton('取消', function () { confirm.classList.add('hidden'); refreshConfigModels(employeeId) }))
  })
  if (item.active !== true || item.wired !== true || currentSessionOf(employeeId) !== '') actions.appendChild(use)
  else actions.appendChild(el('span', 'muted config-help', '用于新会话'))
  var more = el('details', 'config-more'); more.appendChild(el('summary', '', '更多'))
  more.ontoggle = function () { if (!more.open) refreshConfigModels(employeeId) }
  var rename = el('input', ''); rename.value = String(item.name || ''); rename.maxLength = 64
  more.appendChild(configField('显示名称', rename))
  more.appendChild(configWriteButton('保存名称', function () {
    if (!rename.value.trim()) return
    if (!item.endpointId) { configMessage(employeeId, '请先将本地端点收进模型服务，再修改名称。', true); return }
    saveModel(employeeId, { id: item.id, name: rename.value.trim(), endpointId: item.endpointId, model: item.model }, false, '')
  }))
  if (!item.endpointId) {
    var serviceName = el('input', ''); serviceName.value = String(item.name || ''); serviceName.maxLength = 64
    more.appendChild(configField('共享服务名称', serviceName))
    more.appendChild(configWriteButton('收进模型服务', function () {
      if (!serviceName.value.trim()) return
      configMutation(employeeId, 'employee.llm.promote', { employeeId: employeeId, id: item.id, endpointName: serviceName.value.trim() }, '已收进模型服务。')
    }))
  }
  var remove = configWriteButton('删除模型', function () {
    if (!window.confirm('删除「' + String(item.name) + '」？它的模型路由和凭据会移除。')) return
    configMutation(employeeId, 'employee.llm.remove', { employeeId: employeeId, id: item.id }, '模型已删除。')
  })
  remove.classList.add('danger'); more.appendChild(remove); actions.appendChild(more); row.appendChild(actions)
  var confirm = el('div', 'config-switch hidden'); row.appendChild(confirm)
  return row
}

function loadLlmDetail(employeeId) {
  var employee = employeeById(employeeId)
  if (state.phase !== 'ready' || employee === null || employee.nodeOnline === false) return Promise.resolve(null)
  var version = (state.configRequests[employeeId] || 0) + 1
  state.configRequests[employeeId] = version; state.configLoads[employeeId] = true; delete state.configErrors[employeeId]
  refreshConfigModels(employeeId)
  return rpc('employee.llm.get', { employeeId: employeeId }).then(function (payload) {
    if (state.configRequests[employeeId] !== version) return null
    state.llmDetail[employeeId] = payload; delete state.configLoads[employeeId]
    refreshConfigModels(employeeId); return payload
  }).catch(function (error) {
    if (state.configRequests[employeeId] === version) { delete state.configLoads[employeeId]; state.configErrors[employeeId] = describeError(error); refreshConfigModels(employeeId) }
    return null
  })
}

/** 写响应先落本地，再刷新目录；任何旧读取都不能覆盖写入。 */
function acceptConfigDetail(employeeId, payload) {
  state.configRequests[employeeId] = (state.configRequests[employeeId] || 0) + 1
  delete state.configLoads[employeeId]; delete state.configErrors[employeeId]
  if (payload !== null && typeof payload === 'object' && Array.isArray(payload.models)) state.llmDetail[employeeId] = payload
  refreshConfigModels(employeeId)
}

function configMutation(employeeId, method, params, success) {
  if (!configCanManage() || state.configPending[employeeId]) return Promise.resolve(null)
  state.configPending[employeeId] = true; syncConfigControls()
  return rpc(method, params, { idempotencyKey: randomId() }).then(function (payload) {
    acceptConfigDetail(employeeId, payload)
    configMessage(employeeId, payload && payload.linked === false ? String(payload.note || '服务已保存，但员工尚未绑定。') : success, !!(payload && payload.linked === false))
    var refresh = method === 'employee.remove' ? Promise.resolve() : loadLlmDetail(employeeId)
    return refresh.then(function () { loadEmployees(); loadLlmEndpoints(); return payload })
  }).catch(function (error) { configMessage(employeeId, describeError(error), true); return null }).then(function (payload) {
    delete state.configPending[employeeId]; syncConfigControls(); return payload
  })
}

function currentSessionOf(employeeId) {
  return String(state.selectedEmployeeId || '') === employeeId && typeof state.selectedSessionId === 'string' ? state.selectedSessionId : ''
}

function activateModel(employeeId, modelId, button, sessionId) {
  return configMutation(employeeId, 'employee.llm.activate', Object.assign({ employeeId: employeeId, id: modelId }, sessionId ? { sessionId: sessionId } : {}), '新会话默认模型已更新。').then(function (payload) {
    if (payload && sessionId) configMessage(employeeId, payload.sessionSwitched === true ? '默认模型已更新，当前会话也已切换。' : '默认模型已更新；当前会话未切换：' + String(payload.sessionNote || '请稍后重试。'), payload.sessionSwitched !== true)
    return payload
  })
}

function saveModel(employeeId, params, activate, sessionId) {
  if (!configCanManage() || state.configPending[employeeId]) return Promise.resolve(null)
  var body = Object.assign({ employeeId: employeeId }, params)
  if (activate) body.activate = true
  state.configPending[employeeId] = true; syncConfigControls()
  return rpc('employee.llm.save', body, { idempotencyKey: randomId() }).then(function (payload) {
    acceptConfigDetail(employeeId, payload)
    var saved = pickArray(payload, ['models']).filter(function (item) { return params.id ? item.id === params.id : item.endpointId === params.endpointId && item.model === params.model && item.name === params.name })[0]
    var draft = state.configDrafts[employeeId]
    if (!params.id && draft) draft.model = { open: false, endpointId: params.endpointId, model: '', name: '', nameTouched: false, activate: true, switchSession: false }
    var result = Promise.resolve(payload)
    if (activate && saved && (saved.wired !== true || sessionId)) result = rpc('employee.llm.activate', Object.assign({ employeeId: employeeId, id: saved.id }, sessionId ? { sessionId: sessionId } : {}), { idempotencyKey: randomId() })
    return result.then(function (activated) {
      acceptConfigDetail(employeeId, activated)
      if (!saved || (saved.wired !== true && !activate)) configMessage(employeeId, '模型配置已保存，但连接尚未完成，请设为默认重试。', true)
      else if (sessionId && activated.sessionSwitched !== true) configMessage(employeeId, '模型配置已保存；当前会话未切换：' + String(activated.sessionNote || '请重试切换。'), true)
      else configMessage(employeeId, sessionId ? '模型配置已保存，当前会话已切换。' : activate ? '模型已保存并设为新会话默认。' : '模型配置已保存。')
      return activated
    }).catch(function (error) { configMessage(employeeId, '模型已保存；连接或会话切换失败：' + describeError(error), true); return payload })
  }).catch(function (error) { configMessage(employeeId, '保存失败：' + describeError(error), true); return null }).then(function (payload) {
    delete state.configPending[employeeId]
    if (payload) { loadEmployees(); if (state.configEmployeeId === employeeId && state.configTab === 'models') renderLlmConfig(true) }
    syncConfigControls(); return payload
  })
}

function buildConfigIdentity(employee) {
  var id = String(employee.id), draft = configDraft(employee).identity, panel = el('div', 'config-form-identity')
  var status = el('span', 'muted config-help', draft.dirty ? '有未保存的修改' : '基本信息已保存')
  var touched = function () { draft.dirty = true; status.textContent = '有未保存的修改 · 切换员工后仍保留' }
  var name = el('input', ''); name.value = draft.name; name.maxLength = 64; name.setAttribute('data-config-edit', '')
  name.oninput = function () { draft.name = name.value; touched() }; panel.appendChild(configField('员工姓名', name))
  var position = buildPositionPicker(draft.position.id || 'general')
  if (draft.position.newName !== undefined) {
    position.root.querySelector('select').value = '__new_position__'
    var newPosition = position.root.querySelector('input'); newPosition.value = draft.position.newName; newPosition.classList.remove('hidden')
  }
  position.root.querySelectorAll('input, select').forEach(function (input) { input.setAttribute('data-config-edit', '') })
  position.root.addEventListener('change', function () { draft.position = position.read(); touched() })
  position.root.addEventListener('input', function () { draft.position = position.read(); touched() })
  panel.appendChild(configField('岗位', position.root))
  var group = el('input', ''); group.value = draft.group; group.maxLength = 64; group.setAttribute('list', 'config-group-options'); group.setAttribute('data-config-edit', '')
  group.oninput = function () { draft.group = group.value; touched() }
  panel.appendChild(configField('所属分组', group, '选择已有分组，也可填写新分组；留空表示不分组。'))
  var groups = el('datalist', ''); groups.id = 'config-group-options'
  listGroupNames().forEach(function (value) { groups.appendChild(el('option', '', value)) }); panel.appendChild(groups)
  var intro = el('textarea', ''); intro.value = draft.intro; intro.rows = 4; intro.maxLength = 500; intro.setAttribute('data-config-edit', '')
  intro.oninput = function () { draft.intro = intro.value; touched() }
  panel.appendChild(configField('初始提示词', intro, '在新会话开始时提供给员工。'))
  panel.appendChild(el('div', 'muted config-help', '运行节点：' + String(employee.nodeName || employee.nodeId || '') + '（只读）'))
  panel.appendChild(el('div', 'muted config-help', '工作区：' + String(employee.workspacePath || '') + '（只读）'))
  var file = el('input', ''); file.type = 'file'; file.accept = 'image/png,image/webp,image/gif,image/jpeg'; file.setAttribute('data-config-edit', '')
  panel.appendChild(configField('员工头像', file, 'PNG、WebP、GIF 或 JPEG，最大 2MB。'))
  var avatarActions = el('div', 'config-actions')
  avatarActions.appendChild(configWriteButton('上传头像', function () { uploadAvatar(id, file) }))
  avatarActions.appendChild(configWriteButton('恢复默认头像', function () { removeAvatar(id) })); panel.appendChild(avatarActions)
  var footer = el('div', 'config-form-footer'); footer.appendChild(status)
  footer.appendChild(configWriteButton('保存基本信息', function () {
    if (!draft.name.trim()) { configMessage(id, '请填写员工姓名。', true); return }
    state.configPending[id] = true; syncConfigControls()
    var snapshot = { name: draft.name.trim(), group: draft.group.trim(), intro: draft.intro.trim(), position: Object.assign({}, draft.position) }
    resolvePositionChoice(snapshot.position).then(function (positionId) {
      if (!positionId) throw new Error('请选择岗位或填写新岗位名称。')
      var params = { employeeId: id, group: snapshot.group || null, intro: snapshot.intro || null, position: positionId }
      if (snapshot.name !== String(employee.name)) params.name = snapshot.name
      return rpc('employee.update', params, { idempotencyKey: randomId() })
    }).then(function () {
      draft.dirty = false; configMessage(id, '基本信息已保存。'); return loadEmployees()
    }).catch(function (error) { configMessage(id, '保存失败：' + describeError(error), true) }).then(function () {
      delete state.configPending[id]; status.textContent = draft.dirty ? '有未保存的修改' : '基本信息已保存'; syncConfigControls()
    })
  }, true)); panel.appendChild(footer)
  var danger = el('details', 'config-danger'); danger.appendChild(el('summary', '', '管理操作'))
  var remove = configWriteButton('注销员工（保留工作区）', function () {
    if (!window.confirm('注销「' + String(employee.name) + '」？员工将移出目录，工作区文件保留。')) return
    configMutation(id, 'employee.remove', { employeeId: id }, '员工已注销，工作区保留。')
  }); remove.classList.add('danger'); danger.appendChild(remove); panel.appendChild(danger)
  return panel
}

var PERMISSION_LABELS = { 'read-only': '只读', 'workspace-write': '工作区可写', 'danger-full-access': '完全访问', custom: '自定义' }
function permissionLabel(value) { return PERMISSION_LABELS[String(value)] || String(value || '未知') }

function loadPermissionPreset(employeeId) {
  var previous = state.llmPermission[employeeId]
  if (previous && previous.loading) return
  var version = ((previous && previous.version) || 0) + 1
  state.llmPermission[employeeId] = Object.assign({}, previous || {}, { version: version, loading: true })
  paintConfigPermission(employeeId)
  rpc('session.list', { employeeId: employeeId }).then(function (payload) {
    if (state.llmPermission[employeeId].version !== version) return
    var sessions = pickArray(payload, ['sessions']), newest = null
    sessions.forEach(function (item) { if (item && (!newest || Number(item.updatedAtMs || item.updatedAt || 0) > Number(newest.updatedAtMs || newest.updatedAt || 0))) newest = item })
    var values = newest && newest.projections && newest.projections.values
    state.llmPermission[employeeId] = { version: version, hasSession: newest !== null, preset: values && values.permissions ? String(values.permissions.currentValue || '') : '', sessionName: newest ? sessionTitleOf(newest) || shortId(sessionIdOf(newest)) : '' }
    paintConfigPermission(employeeId)
  }).catch(function (error) {
    if (state.llmPermission[employeeId].version !== version) return
    state.llmPermission[employeeId] = Object.assign({}, previous || {}, { version: version, failed: describeError(error), loading: false }); paintConfigPermission(employeeId)
  })
}

function paintConfigPermission(employeeId) {
  if (state.configEmployeeId !== employeeId || state.configTab !== 'approval') return
  var box = $('configPermissionInfo'); if (box === null) return
  clear(box)
  var info = state.llmPermission[employeeId]
  if (!info) box.appendChild(el('p', 'muted', '尚未读取最近会话的权限。'))
  else {
    if (info.loading) box.appendChild(el('p', 'muted', '正在读取…'))
    if (info.failed) box.appendChild(el('p', 'warn', '读取失败：' + info.failed))
    if (info.preset !== undefined) box.appendChild(el('p', '', info.hasSession ? permissionLabel(info.preset) + ' · 最近会话：' + String(info.sessionName || '') : '还没有会话，新会话使用节点默认权限。'))
  }
  var retry = configButton('刷新权限记录', function () { loadPermissionPreset(employeeId) })
  retry.disabled = state.phase !== 'ready' || (employeeById(employeeId) || {}).nodeOnline === false || !!(info && info.loading)
  box.appendChild(retry)
}

function buildConfigApproval(employee) {
  var id = String(employee.id), draft = configDraft(employee).approval, panel = el('div', '')
  panel.appendChild(el('h3', '', '审批方式'))
  var choice = configCheck('自动通过该员工的审批请求', draft.value, function (value) { draft.value = value; draft.dirty = true })
  choice.querySelector('input').setAttribute('data-config-hub-write', ''); panel.appendChild(choice)
  panel.appendChild(el('p', 'muted config-help', '提问仍需你回答，文件访问范围由会话权限决定。'))
  var save = configButton('保存审批设置', function () {
    if (!configCanManage() || state.configPending[id]) return
    state.configPending[id] = true; syncConfigControls()
    var enabled = draft.value
    rpc('employee.autoApprove.set', { employeeId: id, enabled: enabled }, { idempotencyKey: randomId() }).then(function () {
      draft.dirty = false; employee.autoApprove = enabled; configMessage(id, '自动审批已' + (enabled ? '开启。' : '关闭。')); loadEmployees()
    }).catch(function (error) { configMessage(id, describeError(error), true) }).then(function () { delete state.configPending[id]; syncConfigControls() })
  }, true)
  save.setAttribute('data-config-hub-write', ''); panel.appendChild(save)
  panel.appendChild(el('h3', 'config-section-title', '会话文件访问范围（只读）'))
  var permissions = el('div', ''); permissions.id = 'configPermissionInfo'; panel.appendChild(permissions)
  panel.appendChild(el('p', 'muted config-help', '显示最近会话记录；修改节点默认权限只影响之后新建的会话。'))
  panel.appendChild(configButton('查看节点设置 →', function () { setConfigPage('nodes') }))
  return panel
}
`
