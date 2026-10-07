/** 共享模型服务：编辑器独立挂载，草稿与密钥仅在本页内存中暂存。 */
export const CHUNK_41_MODEL_SERVICES = String.raw`
function bindEndpointUi() {
  var button = $('btnNewEndpoint')
  if (button) { button.disabled = !configCanManage(); button.onclick = function () { state.configEndpointReturn = null; openEndpointEditor('new') } }
}

function endpointById(endpointId) {
  return state.llmEndpoints.filter(function (entry) { return String(entry.id) === endpointId })[0]
}
function endpointLabel(endpointId) {
  if (!endpointId) return '本地服务（未共享）'
  var entry = endpointById(endpointId)
  return entry ? String(entry.name) : '服务已删除（' + endpointId + '）'
}
function hostOf(apiUrl) { try { return new URL(String(apiUrl)).host } catch (error) { return String(apiUrl || '') } }

function loadLlmEndpoints() {
  bindEndpointUi()
  if (state.phase !== 'ready' || state.scopes.indexOf('employee.read') < 0) { renderEndpointList(); return Promise.resolve([]) }
  var version = ++state.configEndpointRevision
  return rpc('llm.endpoint.list', {}).then(function (payload) {
    if (version !== state.configEndpointRevision) return state.llmEndpoints
    state.llmEndpoints = pickArray(payload, ['endpoints']).filter(function (entry) { return entry && typeof entry.id === 'string' })
    state.configEndpointLoadError = ''; renderEndpointList(); refreshConfigModelChoices()
    if (state.configEmployeeId) refreshConfigModels(state.configEmployeeId)
    return state.llmEndpoints
  }).catch(function (error) {
    if (version === state.configEndpointRevision) { state.configEndpointLoadError = describeError(error); renderEndpointList() }
    return state.llmEndpoints
  })
}

function renderEndpointList() {
  var box = $('endpointList')
  if (box === null) return
  clear(box)
  if (state.configEndpointLoadError) {
    box.appendChild(el('p', 'warn', '服务读取失败：' + state.configEndpointLoadError))
    box.appendChild(configButton('重新读取', loadLlmEndpoints))
  }
  if (!state.llmEndpoints.length) box.appendChild(el('p', 'muted', state.phase === 'ready' ? '还没有共享模型服务，点击新增服务。' : '连接后可读取模型服务。'))
  state.llmEndpoints.forEach(function (entry) {
    var id = String(entry.id), row = el('div', 'config-service-row'), copy = el('div', '')
    copy.appendChild(el('strong', '', String(entry.name)))
    copy.appendChild(el('div', 'muted config-help', String(entry.apiUrl)))
    copy.appendChild(el('div', 'muted config-help', '密钥：' + String(entry.keyMask || '未保存') + ' · ' + (entry.models || []).length + ' 个候选模型'))
    var used = Array.isArray(entry.usedBy) ? entry.usedBy : []
    copy.appendChild(el('div', 'muted config-help', '使用员工：' + (used.map(function (item) { return String(item.name || item.employeeId) }).join('、') || '暂无')))
    row.appendChild(copy)
    var actions = el('div', 'config-actions')
    var edit = configButton('编辑服务', function () { openEndpointEditor(id) }); edit.disabled = !configCanManage(); edit.setAttribute('data-endpoint-manage', ''); actions.appendChild(edit)
    if (configCanManage()) {
      var remove = configButton('删除', function () {
        if (!window.confirm('删除共享服务「' + entry.name + '」？仍有员工使用时会拒绝删除。')) return
        remove.disabled = true
        rpc('llm.endpoint.remove', { id: id }, { idempotencyKey: randomId() }).then(function () {
          if (state.llmEndpointEdit === id) closeEndpointEditor()
          delete state.configEndpointDrafts[id]; delete state.configEndpointStatus[id]; loadLlmEndpoints()
        }).catch(function (error) { remove.disabled = false; reportRpcError('llm.endpoint.remove', error) })
      }); remove.classList.add('danger'); remove.setAttribute('data-endpoint-manage', ''); actions.appendChild(remove)
    }
    row.appendChild(actions); box.appendChild(row)
  })
  paintEndpointStatus()
}

function closeEndpointEditor() {
  var id = state.llmEndpointEdit
  if (id && state.configEndpointDrafts[id]) {
    state.configEndpointDrafts[id].models = null
    state.configEndpointDrafts[id].apiKey = ''
    state.configEndpointDrafts[id].probeVersion += 1
  }
  state.llmEndpointEdit = null; clear($('endpointEditor'))
}

function openEndpointEditor(id) {
  var current = state.llmEndpointEdit && state.configEndpointDrafts[state.llmEndpointEdit]
  if (current && current.saving) { toast('服务正在保存，请等待结果。', 'warn'); return }
  if (id === state.llmEndpointEdit && $('endpointEditor').childNodes.length) return
  if (state.llmEndpointEdit) closeEndpointEditor()
  state.llmEndpointEdit = id
  var entry = id === 'new' ? null : endpointById(id)
  var box = $('endpointEditor'); clear(box)
  box.appendChild(buildEndpointEditor(entry))
}

function buildEndpointEditor(entry) {
  var id = entry ? String(entry.id) : 'new'
  var draft = state.configEndpointDrafts[id]
  if (!draft) {
    draft = { name: entry ? String(entry.name) : '', apiUrl: entry ? String(entry.apiUrl) : '', apiKey: '', proxy: !!(entry && entry.proxy), host: entry && entry.proxy ? String(entry.proxy.host) : '127.0.0.1', port: entry && entry.proxy ? String(entry.proxy.port) : '7892', probeVersion: 0, models: null, saving: false }
    state.configEndpointDrafts[id] = draft
  }
  var editor = el('div', 'config-form'), fields = []
  editor.appendChild(el('h3', '', entry ? '编辑「' + entry.name + '」' : '新增模型服务'))
  var inputFor = function (key, type) {
    var input = el('input', ''); input.type = type || 'text'; input.value = draft[key]; fields.push(input)
    input.oninput = function () { draft[key] = input.value; if (key !== 'name') { draft.models = null; draft.probeVersion += 1; result.textContent = '' } }
    return input
  }
  var name = inputFor('name'); name.maxLength = 64; editor.appendChild(configField('服务名称', name))
  var url = inputFor('apiUrl'); url.placeholder = 'https://api.example.com/v1'; editor.appendChild(configField('接口地址', url))
  var key = inputFor('apiKey', 'password'); key.autocomplete = 'off'; key.maxLength = 512
  editor.appendChild(configField('API 密钥', key, entry && entry.hasKey ? '已保存 ' + String(entry.keyMask || '') + '，留空保持原值。' : '服务不需要密钥时可留空。'))
  var advanced = el('details', 'config-advanced'); advanced.open = draft.proxy
  advanced.appendChild(el('summary', '', '高级设置 · 出口代理'))
  var proxy = configCheck('使用 HTTP 代理', draft.proxy, function (value) {
    draft.proxy = value; host.disabled = !value; port.disabled = !value; draft.models = null; draft.probeVersion += 1; result.textContent = ''
  }); fields.push(proxy.querySelector('input')); advanced.appendChild(proxy)
  var host = inputFor('host'), port = inputFor('port'); port.inputMode = 'numeric'
  host.disabled = !draft.proxy; port.disabled = !draft.proxy
  advanced.appendChild(configField('代理主机', host)); advanced.appendChild(configField('代理端口', port)); editor.appendChild(advanced)
  var result = el('div', 'muted config-help'); result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite')
  var modelList = el('div', 'muted config-help')
  var known = draft.models || (entry && entry.models) || []
  modelList.textContent = known.length ? '候选模型：' + known.join('、') : '尚未获取模型列表，也可在员工设置中手填模型 ID。'
  var readProxy = function () {
    if (!draft.proxy) return null
    var value = Number(draft.port)
    if (!Number.isInteger(value) || value < 1 || value > 65535 || !draft.host.trim()) throw new Error('请填写代理主机和 1–65535 之间的整数端口。')
    return { host: draft.host.trim(), port: value }
  }
  var paramsFor = function () {
    var params = { apiUrl: draft.apiUrl.trim(), proxy: readProxy() }
    if (entry) params.id = String(entry.id)
    if (draft.apiKey) params.apiKey = draft.apiKey
    return params
  }
  var probe = configButton('获取模型列表', function () {
    if (!configCanManage() || draft.saving) return
    var params
    try { params = paramsFor(); if (!params.apiUrl) throw new Error('请填写接口地址。') }
    catch (error) { result.textContent = describeError(error); return }
    var version = ++draft.probeVersion
    probe.disabled = true; result.textContent = '正在获取模型列表…'
    rpc('llm.endpoint.probe', params).then(function (payload) {
      if (draft.probeVersion !== version || state.llmEndpointEdit !== id) return
      draft.models = pickArray(payload, ['models']); result.textContent = '已获取 ' + draft.models.length + ' 个模型，经节点「' + String(payload.via || '') + '」。保存后可在员工设置中选择。'
      modelList.textContent = draft.models.length ? '候选模型：' + draft.models.join('、') : '未返回候选模型，可手填模型 ID。'
    }).catch(function (error) { if (draft.probeVersion === version) result.textContent = '获取失败：' + describeError(error) }).then(function () { probe.disabled = !configCanManage() || draft.saving })
  }); probe.disabled = !configCanManage()
  editor.appendChild(probe); editor.appendChild(result); editor.appendChild(modelList)
  var users = entry && Array.isArray(entry.usedBy) ? entry.usedBy : []
  editor.appendChild(el('p', 'muted config-help', users.length ? '保存后同步到：' + users.map(function (item) { return String(item.name || item.employeeId) }).join('、') : '保存后可在员工的模型设置中选择。'))
  var actions = el('div', 'config-actions')
  var cancel = configButton('取消', function () { closeEndpointEditor(); returnToConfigModel() })
  cancel.setAttribute('data-endpoint-cancel', '')
  var save = configButton('保存服务', function () {
    if (draft.saving || !configCanManage()) return
    var params
    try { params = paramsFor(); if (!params.apiUrl || !draft.name.trim()) throw new Error('请填写服务名称与接口地址。') }
    catch (error) { result.textContent = describeError(error); return }
    params.name = draft.name.trim()
    if (draft.models !== null) params.models = draft.models
    draft.saving = true; draft.probeVersion += 1
    fields.forEach(function (input) { input.disabled = true }); save.disabled = true; cancel.disabled = true; probe.disabled = true; result.textContent = '正在保存并同步…'
    rpc('llm.endpoint.upsert', params, { idempotencyKey: randomId(), timeoutMs: Math.max(30000, users.length * 16000 + 10000) }).then(function (payload) {
      if (!payload || !payload.endpoint) throw new Error('服务保存响应缺少配置信息，请刷新后查看。')
      var saved = payload.endpoint
      state.llmEndpoints = state.llmEndpoints.filter(function (item) { return item.id !== saved.id }).concat([saved])
      state.configEndpointStatus[String(saved.id)] = { rows: pickArray(payload, ['synced']), running: false }
      delete state.configEndpointDrafts[id]
      state.llmEndpointEdit = null; clear($('endpointEditor')); refreshConfigModelChoices(); renderEndpointList(); loadLlmEndpoints()
      toast('模型服务已保存。', 'ok'); returnToConfigModel(String(saved.id))
    }).catch(function (error) {
      result.textContent = '保存未完成：' + describeError(error)
      draft.saving = false; fields.forEach(function (input) { input.disabled = !configCanManage() }); host.disabled = !draft.proxy; port.disabled = !draft.proxy
      save.disabled = !configCanManage(); cancel.disabled = false; probe.disabled = !configCanManage()
    })
  }, true)
  save.disabled = !configCanManage(); actions.appendChild(save); actions.appendChild(cancel); editor.appendChild(actions)
  if (!configCanManage()) fields.forEach(function (input) { input.disabled = true })
  return editor
}

function syncEndpointControls() {
  bindEndpointUi()
  var list = $('endpointList')
  if (list) list.querySelectorAll('[data-endpoint-manage]').forEach(function (button) { button.disabled = !configCanManage() })
  var editor = $('endpointEditor')
  var draft = state.llmEndpointEdit && state.configEndpointDrafts[state.llmEndpointEdit]
  if (!editor || !draft) return
  editor.querySelectorAll('input, select, button').forEach(function (input) {
    input.disabled = input.hasAttribute('data-endpoint-cancel') ? draft.saving : !configCanManage() || draft.saving
  })
  var inputs = editor.querySelectorAll('.config-advanced input[type="text"]')
  inputs.forEach(function (input) { input.disabled = !configCanManage() || draft.saving || !draft.proxy })
}

function returnToConfigModel(endpointId) {
  var target = state.configEndpointReturn
  state.configEndpointReturn = null
  if (!target || employeeById(target.employeeId) === null) return
  state.configEmployeeId = target.employeeId; state.configTab = 'models'
  if (endpointId) { configModelDraft(target.employeeId).endpointId = endpointId; configModelDraft(target.employeeId).open = true }
  setConfigPage('employees'); renderLlmConfig(true)
}

function paintEndpointStatus() {
  var box = $('endpointStatus'); if (box === null) return
  clear(box)
  Object.keys(state.configEndpointStatus).forEach(function (id) {
    var info = state.configEndpointStatus[id]
    if (!info.rows.length) return
    box.appendChild(el('h3', 'config-section-title', endpointLabel(id) + ' · 员工同步结果'))
    info.rows.forEach(function (row) { box.appendChild(el('p', row.ok ? 'muted config-help' : 'warn config-help', String(row.name || row.employeeId) + '：' + (row.ok ? '已同步' : String(row.error || '未完成')))) })
    var failed = info.rows.filter(function (row) { return row.ok !== true })
    if (failed.length) {
      var retry = configButton(info.running ? '正在重试…' : '仅重试同步失败员工（' + failed.length + '）', function () { retryEndpointSync(id, info) })
      retry.disabled = info.running || !configCanManage(); box.appendChild(retry)
    }
  })
}

function retryEndpointSync(endpointId, info) {
  if (info.running || !configCanManage()) return
  info.running = true; paintEndpointStatus()
  var failed = info.rows.filter(function (row) { return row.ok !== true })
  var chain = Promise.resolve()
  failed.forEach(function (row) {
    var acquired = false
    chain = chain.then(function () {
      if (state.configPending[row.employeeId]) throw new Error('员工配置正在保存，请稍后重试。')
      state.configPending[row.employeeId] = true; acquired = true; syncConfigControls()
      return rpc('employee.llm.get', { employeeId: row.employeeId }).then(function (payload) {
        if (!payload || !Array.isArray(payload.models)) throw new Error('节点版本不支持此操作。')
        var models = payload.models.filter(function (item) { return item.endpointId === endpointId })
        var saves = Promise.resolve()
        models.forEach(function (item) {
          saves = saves.then(function () { return rpc('employee.llm.save', { employeeId: row.employeeId, id: item.id, name: item.name, endpointId: endpointId, model: item.model }, { idempotencyKey: randomId() }) }).then(function (result) {
            acceptConfigDetail(row.employeeId, result)
            var target = pickArray(result, ['models']).filter(function (model) { return model.id === item.id })[0]
            if (!target || !target.wired) throw new Error('模型已保存，连接尚未完成。')
          })
        })
        return saves
      })
    }).then(function () { row.ok = true; delete row.error }).catch(function (error) { row.ok = false; row.error = describeError(error) }).then(function () {
      if (acquired) delete state.configPending[row.employeeId]
      paintEndpointStatus(); syncConfigControls()
    })
  })
  chain.then(function () { info.running = false; paintEndpointStatus(); loadEmployees() })
}
`
