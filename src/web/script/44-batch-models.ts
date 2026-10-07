/** 批量模型：快照目标与参数、复用相同绑定、有限并发、逐人结果和失败重试。 */
export const CHUNK_44_BATCH_MODELS = String.raw`
function renderBatchModels() {
  var box = $('configBatchPanel'), batch = state.configBatch
  if (box === null) return
  box.classList.toggle('hidden', !batch.open)
  if (!batch.open) return
  if (!batch.mounted) {
    batch.mounted = true
    batch.draft = batch.draft || { endpointId: '', model: '', name: '', nameTouched: false, activate: true, switchSession: false }
    box.appendChild(el('h3', '', '批量设置模型'))
    box.appendChild(el('p', 'muted config-help', '为多位员工添加同一个模型，可同时设为新会话默认。保留其他模型；相同服务与模型会复用已有条目。'))
    var layout = el('div', 'config-batch-layout'), people = el('div', ''), form = el('div', '')
    var filter = el('input', ''); filter.type = 'search'; filter.placeholder = '姓名、岗位或分组'; filter.value = batch.filter
    filter.oninput = function () { batch.filter = filter.value; paintBatchPeople() }
    people.appendChild(configField('选择员工', filter))
    var choices = el('div', 'config-actions')
    choices.appendChild(configButton('全选筛选结果', function () { batchCandidates().forEach(function (employee) { batch.selected.add(String(employee.id)) }); paintBatchPeople() }))
    choices.appendChild(configButton('仅选在线员工', function () { batch.selected.clear(); batchCandidates().forEach(function (employee) { if (employee.nodeOnline !== false) batch.selected.add(String(employee.id)) }); paintBatchPeople() }))
    choices.appendChild(configButton('清空选择', function () { batch.selected.clear(); paintBatchPeople() }))
    people.appendChild(choices)
    var count = el('div', 'muted config-help'); count.id = 'configBatchCount'; people.appendChild(count)
    var targets = el('div', 'config-batch-people'); targets.id = 'configBatchPeople'; people.appendChild(targets)
    form.appendChild(buildConfigModelFields(batch.draft, 'config-batch'))
    form.appendChild(configCheck('设为所选员工的新会话默认模型', batch.draft.activate, function (value) { batch.draft.activate = value }))
    form.appendChild(configCheck('同时切换本控制台当前打开的该员工会话', batch.draft.switchSession, function (value) { batch.draft.switchSession = value }))
    form.appendChild(el('p', 'muted config-help', '会话切换仅在勾选设为默认时生效。运行中的会话会报告未切换，结束后可重试。'))
    var apply = configButton('一键应用到所选员工', function () { runBatchModels(false) }, true); apply.id = 'configBatchApply'; form.appendChild(apply)
    layout.appendChild(people); layout.appendChild(form); box.appendChild(layout)
    var results = el('div', 'config-batch-results'); results.id = 'configBatchResults'; results.setAttribute('aria-live', 'polite'); box.appendChild(results)
    var close = configButton('收起批量设置', function () { batch.open = false; box.classList.add('hidden') }); close.setAttribute('data-batch-close', ''); box.appendChild(close)
  }
  paintBatchPeople(); paintBatchResults(); syncBatchControls()
}

function batchCandidates() {
  var query = String(state.configBatch.filter || '').trim().toLowerCase()
  return state.employees.filter(function (employee) { return (String(employee.name) + (positionName(employee.position) || '通用') + groupOf(employee)).toLowerCase().indexOf(query) >= 0 })
}

function paintBatchPeople() {
  var box = $('configBatchPeople'), batch = state.configBatch
  if (box === null) return
  clear(box)
  var validIds = new Set(state.employees.map(function (employee) { return String(employee.id) }))
  batch.selected.forEach(function (id) { if (!validIds.has(id)) batch.selected.delete(id) })
  batchCandidates().forEach(function (employee) {
    var id = String(employee.id)
    var label = configCheck(String(employee.name) + '（' + (positionName(employee.position) || '通用') + '） · ' + groupOf(employee) + (employee.nodeOnline === false ? ' · 离线' : ''), batch.selected.has(id), function (selected) {
      if (selected) batch.selected.add(id); else batch.selected.delete(id)
      $('configBatchCount').textContent = '已选择 ' + batch.selected.size + ' 位员工'
    })
    label.querySelector('input').disabled = batch.running || !configCanManage()
    box.appendChild(label)
  })
  if (!box.childNodes.length) box.appendChild(el('p', 'muted', '没有匹配的员工。'))
  $('configBatchCount').textContent = '已选择 ' + batch.selected.size + ' 位员工'
}

function syncBatchControls() {
  var box = $('configBatchPanel'), batch = state.configBatch
  if (box === null) return
  box.querySelectorAll('input, select, button').forEach(function (input) {
    if (input.hasAttribute('data-batch-close')) return
    input.disabled = batch.running || !configCanManage()
  })
  var apply = $('configBatchApply')
  if (apply) apply.textContent = batch.running ? '正在逐人应用…' : '一键应用到所选员工'
}

function paintBatchResults() {
  var box = $('configBatchResults'), batch = state.configBatch
  if (box === null) return
  clear(box)
  var job = batch.job
  if (!job) return
  var done = job.rows.filter(function (row) { return row.status === 'done' }).length
  var failed = job.rows.filter(function (row) { return row.status === 'failed' }).length
  box.appendChild(el('h3', '', (batch.running ? '应用进度' : '应用结果') + ' · 成功 ' + done + ' / ' + job.rows.length + ' · 失败 ' + failed))
  box.appendChild(el('p', 'muted config-help', job.endpointName + ' · ' + job.model + (job.activate ? ' · 设为新会话默认' : ' · 仅添加模型')))
  job.rows.forEach(function (row) {
    var item = el('div', 'config-batch-result')
    item.appendChild(el('strong', '', row.name))
    item.appendChild(el('span', row.status === 'failed' ? 'warn' : 'muted', row.message || (row.status === 'working' ? '正在处理…' : '等待处理')))
    if (!batch.running && row.status === 'failed') item.appendChild(configButton('重试此员工', function () { runBatchModels(true, row.employeeId) }))
    box.appendChild(item)
  })
  if (!batch.running && failed) box.appendChild(configButton('仅重试失败员工（' + failed + '）', function () { runBatchModels(true) }, true))
  syncBatchControls()
}

function runBatchModels(retry, onlyEmployeeId) {
  var batch = state.configBatch
  if (batch.running || !configCanManage()) return
  if (!retry) {
    var draft = batch.draft
    if (!draft || !draft.endpointId || !draft.model.trim() || !draft.name.trim() || !batch.selected.size) { toast('请选择员工、模型服务，并填写模型与显示名称。', 'warn'); return }
    if (endpointById(draft.endpointId) === undefined) { toast('模型服务已不存在，请重新选择。', 'warn'); return }
    var selected = state.employees.filter(function (employee) { return batch.selected.has(String(employee.id)) })
    if (selected.some(function (employee) { return !!state.configPending[String(employee.id)] })) { toast('所选员工还有配置正在保存，请稍后再应用。', 'warn'); return }
    batch.job = {
      endpointId: draft.endpointId, endpointName: endpointLabel(draft.endpointId), model: draft.model.trim(), name: draft.name.trim(), activate: draft.activate === true,
      rows: selected.map(function (employee) { return { employeeId: String(employee.id), name: String(employee.name), status: 'waiting', sessionId: draft.activate && draft.switchSession ? currentSessionOf(String(employee.id)) : '', saved: false } })
    }
  }
  var job = batch.job
  if (!job) return
  var rows = job.rows.filter(function (row) { return (!retry || row.status === 'failed') && (!onlyEmployeeId || row.employeeId === onlyEmployeeId) })
  if (!rows.length) return
  if (rows.some(function (row) { return !!state.configPending[row.employeeId] })) { toast('员工配置正在保存，请稍后重试。', 'warn'); return }
  batch.running = true
  rows.forEach(function (row) {
    row.status = 'waiting'; row.message = row.saved ? '等待重试未完成的步骤' : '等待处理'
    state.configPending[row.employeeId] = true
    state.configRequests[row.employeeId] = (state.configRequests[row.employeeId] || 0) + 1
    delete state.configLoads[row.employeeId]
  })
  syncConfigControls(); paintBatchResults(); syncBatchControls()
  var cursor = 0
  var worker = function () {
    if (cursor >= rows.length) return Promise.resolve()
    var row = rows[cursor++]
    row.status = 'working'; row.message = '正在读取现有模型…'; paintBatchResults()
    return applyBatchModel(job, row).then(function (message) {
      row.status = 'done'; row.message = message
    }).catch(function (error) {
      row.status = 'failed'; row.message = (row.saved ? '模型已保存，后续步骤未完成：' : '未完成：') + describeError(error)
    }).then(function () {
      delete state.configPending[row.employeeId]
      paintBatchResults(); syncConfigControls(); return worker()
    })
  }
  Promise.all([worker(), worker()]).then(function () {
    batch.running = false; paintBatchResults(); syncBatchControls(); syncConfigControls()
    loadEmployees(); loadLlmEndpoints()
  })
}

/** 参数与幂等键固定在每位员工的操作记录中；不重放已经成功的员工。 */
function applyBatchModel(job, row) {
  var employee = employeeById(row.employeeId)
  if (!employee) return Promise.reject(new Error('员工已从目录移除。'))
  if (state.phase !== 'ready') return Promise.reject(new Error('连接已断开，恢复后重试。'))
  if (employee.nodeOnline === false) return Promise.reject(new Error('节点离线，上线后可重试。'))
  var prepare = Promise.resolve()
  if (row.saveError && row.saveParams && !row.modelId) {
    /* 请求可能已落盘但响应丢失：先按唯一名称和绑定找回 id，再更新同一记录。
       明确的 node-offline 未派发才换键；未知结果继续用原键，避免重复创建。 */
    prepare = rpc('employee.llm.get', { employeeId: row.employeeId }).then(function (payload) {
      var found = pickArray(payload, ['models']).filter(function (item) {
        return item.name === row.saveParams.name && item.endpointId === job.endpointId && item.model === job.model && (!row.saveParams.id || item.id === row.saveParams.id)
      })[0]
      if (found) { row.saveParams.id = String(found.id); row.saveKey = randomId(); row.saved = true }
      else if (row.saveError === 'node-offline') row.saveKey = randomId()
    })
  }
  if (!row.saveParams && !row.modelId) {
    prepare = rpc('employee.llm.get', { employeeId: row.employeeId }).then(function (payload) {
      if (!payload || !Array.isArray(payload.models)) throw new Error('节点版本不支持多个模型，请先升级节点。')
      acceptConfigDetail(row.employeeId, payload)
      var matching = payload.models.filter(function (item) { return item.endpointId === job.endpointId && item.model === job.model })[0]
      /* 相同绑定复用 id；仍经 Hub 保存一次，保证共享服务的地址和密钥是最新的。 */
      if (matching) row.reused = true
      var clash = payload.models.some(function (item) { return item.name === job.name && (!matching || item.id !== matching.id) })
      if (clash && !matching) throw new Error('显示名称「' + job.name + '」已被其他模型使用，请改名后重新应用。')
      row.saveParams = { employeeId: row.employeeId, endpointId: job.endpointId, model: job.model, name: matching ? String(matching.name) : job.name }
      if (matching) row.saveParams.id = String(matching.id)
      if (job.activate) row.saveParams.activate = true
      row.saveKey = randomId()
    })
  }
  return prepare.then(function () {
    if (row.modelId) return null
    row.message = '正在保存模型…'; paintBatchResults()
    return rpc('employee.llm.save', row.saveParams, { idempotencyKey: row.saveKey }).then(function (payload) {
      acceptConfigDetail(row.employeeId, payload)
      var saved = pickArray(payload, ['models']).filter(function (item) { return item.endpointId === job.endpointId && item.model === job.model && item.name === row.saveParams.name })[0]
      if (!saved) throw new Error('节点没有返回已保存的模型，请刷新配置后重试。')
      row.saved = true; row.modelId = String(saved.id); row.wired = saved.wired === true
      row.saveError = ''
      return saved
    }).catch(function (error) { row.saveError = String((error || {}).code || 'unknown'); throw error })
  }).then(function () {
    if (job.activate) {
      row.message = row.sessionId ? '正在设置默认模型并切换当前会话…' : '正在设置默认模型…'; paintBatchResults()
      /* 默认值与模型绑定相同；重试会话未切换时用新键，使节点重新检查 running 状态。 */
      var params = { employeeId: row.employeeId, id: row.modelId }
      if (row.sessionId) params.sessionId = row.sessionId
      return rpc('employee.llm.activate', params, { idempotencyKey: randomId() }).then(function (payload) {
        acceptConfigDetail(row.employeeId, payload)
        row.saved = true
        if (row.sessionId && (!payload || payload.sessionSwitched !== true)) throw new Error('默认模型已更新，当前会话未切换：' + String((payload || {}).sessionNote || '请稍后重试。'))
        return (row.reused ? '复用已有模型，' : '模型已添加，') + '已设为新会话默认' + (row.sessionId ? '，当前会话已切换。' : '。')
      })
    }
    if (row.saved && row.wired !== true) {
      /* 保存接口可能返回“配置已保存、连接未完成”。显式重试同一条记录，避免新增重复项。 */
      var params = Object.assign({}, row.saveParams, { id: row.modelId })
      delete params.activate
      return rpc('employee.llm.save', params, { idempotencyKey: randomId() }).then(function (payload) {
        acceptConfigDetail(row.employeeId, payload)
        var target = pickArray(payload, ['models']).filter(function (item) { return item.id === row.modelId })[0]
        if (!target || target.wired !== true) throw new Error('模型连接未完成，可重试或检查节点。')
        row.wired = true; return '模型已添加，连接已完成。'
      })
    }
    return row.reused ? '已复用已有模型并同步服务配置。' : '模型已添加。'
  })
}
`
