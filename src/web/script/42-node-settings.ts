/** 节点默认权限：整机作用范围与显式保存，读失败时不伪造默认值。 */
export const CHUNK_42_NODE_SETTINGS = String.raw`
var PRESET_TEXT = { 'read-only': '只读', 'workspace-write': '工作区可写', 'danger-full-access': '完全访问' }

function loadNodePermissions() {
  var box = $('nodePermissionList')
  if (box === null) return
  if (state.scopes.indexOf('node.admin') < 0 || state.phase !== 'ready') {
    clear(box); box.appendChild(el('p', 'muted', state.phase === 'ready' ? '当前设备没有管理节点权限的授权。' : '连接后可读取节点权限。')); return
  }
  var revision = ++state.configNodeRevision
  return rpc('node.list', {}).then(function (payload) {
    if (state.configNodeRevision !== revision) return
    var next = {}
    pickArray(payload, ['nodes']).forEach(function (item) {
      if (!item || !item.nodeId) return
      var id = String(item.nodeId), old = state.nodePermissions[id]
      next[id] = Object.assign({}, old || {}, { name: String(item.name || id), online: item.online === true, loading: item.online === true && !state.configNodePending[id] })
    })
    state.nodePermissions = next; renderNodePermissions()
    Object.keys(next).forEach(function (id) {
      if (!next[id].online || state.configNodePending[id]) return
      var readVersion = (state.configNodeReadVersions[id] || 0) + 1
      state.configNodeReadVersions[id] = readVersion
      rpc('node.permission.get', { nodeId: id }).then(function (payload) {
        if (state.configNodeRevision !== revision || state.configNodePending[id] || state.configNodeReadVersions[id] !== readVersion) return
        next[id].preset = payload && payload.preset; delete next[id].error; next[id].loading = false; renderNodePermissions()
      }).catch(function (error) {
        if (state.configNodeRevision !== revision || state.configNodePending[id] || state.configNodeReadVersions[id] !== readVersion) return
        next[id].error = describeError(error); next[id].loading = false; renderNodePermissions()
      })
    })
  }).catch(function (error) {
    if (state.configNodeRevision !== revision) return
    renderNodePermissions(); box.insertBefore(el('p', 'warn', '读取失败：' + describeError(error)), box.firstChild)
    box.appendChild(configButton('重新读取', loadNodePermissions))
  })
}

function renderNodePermissions() {
  var box = $('nodePermissionList')
  if (box === null) return
  var ids = Object.keys(state.nodePermissions)
  if (!ids.length) { clear(box); box.appendChild(el('p', 'muted', '暂无节点')); return }
  Array.from(box.children).forEach(function (row) { if (ids.indexOf(row.getAttribute('data-config-node')) < 0) box.removeChild(row) })
  ids.forEach(function (id) {
    var info = state.nodePermissions[id]
    var oldRow = Array.from(box.children).filter(function (row) { return row.getAttribute('data-config-node') === id })[0]
    var signature = JSON.stringify([info, state.configNodePending[id], state.phase])
    if (oldRow && oldRow.configSignature === signature) return
    if (oldRow && oldRow.contains(document.activeElement) && !state.configNodePending[id] && state.phase === 'ready' && info.online) return
    var row = el('section', 'config-node-row')
    row.setAttribute('data-config-node', id); row.configSignature = signature
    var mount = function () { if (oldRow) box.replaceChild(row, oldRow); else box.appendChild(row) }
    row.appendChild(el('h3', '', info.name + ' · ' + (info.online ? '在线' : '离线')))
    var employees = state.employees.filter(function (employee) { return employee.nodeId === id }).map(function (employee) { return String(employee.name) })
    row.appendChild(el('p', 'muted config-help', '适用员工：' + (employees.join('、') || '暂无员工')))
    row.appendChild(el('p', 'muted config-help', '新会话默认：' + (info.preset === undefined ? '未知' : permissionLabel(info.preset))))
    if (!info.online) { row.appendChild(el('p', 'warn config-help', '节点离线，上线后可读取和修改。')); mount(); return }
    if (info.loading) row.appendChild(el('p', 'muted config-help', '正在读取…'))
    if (info.error) row.appendChild(el('p', 'warn config-help', '读取失败：' + info.error))
    var select = el('select', '')
    var placeholder = el('option', '', '请选择默认权限'); placeholder.value = ''; select.appendChild(placeholder)
    Object.keys(PRESET_TEXT).forEach(function (preset) { var option = el('option', '', PRESET_TEXT[preset]); option.value = preset; select.appendChild(option) })
    select.value = state.configNodeDrafts[id] === undefined ? String(info.preset || '') : state.configNodeDrafts[id]
    select.onchange = function () { state.configNodeDrafts[id] = select.value }
    select.disabled = !!state.configNodePending[id] || state.phase !== 'ready'
    row.appendChild(configField('之后新建会话的默认权限', select, '影响该节点上的所有员工，不修改已有会话。'))
    var save = configButton(state.configNodePending[id] ? '正在保存…' : '保存节点默认权限', function () {
      if (!select.value || state.configNodePending[id] || state.scopes.indexOf('node.admin') < 0) return
      var value = select.value
      state.configNodePending[id] = true; state.configNodeReadVersions[id] = (state.configNodeReadVersions[id] || 0) + 1; info.loading = false; renderNodePermissions()
      rpc('node.permission.set', { nodeId: id, preset: value }, { idempotencyKey: randomId() }).then(function (payload) {
        var current = state.nodePermissions[id]
        if (current) { current.preset = payload && payload.preset; delete current.error; current.loading = false }
        delete state.configNodeDrafts[id]
        toast(info.name + ' 的新会话默认权限已保存。', 'ok')
      }).catch(function (error) { if (state.nodePermissions[id]) state.nodePermissions[id].error = describeError(error) }).then(function () { delete state.configNodePending[id]; renderNodePermissions() })
    }, true)
    save.disabled = !!state.configNodePending[id] || state.phase !== 'ready' || state.scopes.indexOf('node.admin') < 0
    row.appendChild(save)
    if (info.error) row.appendChild(configButton('重新读取', loadNodePermissions))
    mount()
  })
}
`
