/** 在页面内选择执行节点的目录；目录数据由节点返回，浏览器不接触本机文件内容。 */
export const CHUNK_61_DIRECTORY_PICKER = String.raw`
var projectDirectoryBrowser = {
  nodeId: '', nodeName: '', path: '', parentPath: null, directories: [], locations: [], breadcrumbs: [],
  selected: null, back: [], nextOffset: null, total: 0, loading: false, error: '', serial: 0,
  lastPaths: {}, previousFocus: null
}

function projectDirectoryDialogOpen() {
  var dialog = $('projectDirectoryPicker')
  return dialog !== null && dialog.hasAttribute('open')
}
function syncProjectDirectoryControls() {
  var picker = projectDirectoryBrowser
  if ($('projectDirectoryPicker') === null) return
  var allowed = state.phase === 'ready' && state.scopes.indexOf('employee.read') >= 0 && state.scopes.indexOf('employee.prompt') >= 0
  var ready = allowed && !picker.loading
  var controls = { btnProjectDirectoryBack: ready && picker.back.length > 0,
    btnProjectDirectoryUp: ready && picker.parentPath !== null, btnProjectDirectoryHome: ready,
    btnProjectDirectoryRefresh: ready, btnProjectDirectoryCurrent: ready && picker.path !== '',
    btnProjectDirectoryMore: ready && picker.nextOffset !== null,
    btnProjectDirectoryConfirm: ready && picker.selected !== null && picker.error === '' }
  Object.keys(controls).forEach(function (id) { var button = $(id); if (button !== null) button.disabled = !controls[id] })
  var hidden = $('projectDirectoryHidden'); if (hidden !== null) hidden.disabled = !ready
  Array.from($('projectDirectoryPicker').querySelectorAll('[data-directory-navigation]')).forEach(function (button) { button.disabled = !ready })
  var selection = $('projectDirectorySelection')
  if (selection !== null) selection.textContent = picker.selected === null ? '尚未选择文件夹' : picker.selected.path
  Array.from($('projectDirectoryList').querySelectorAll('[data-directory-path]')).forEach(function (row) {
    var selected = picker.selected !== null && row.getAttribute('data-directory-path') === picker.selected.path
    row.classList.toggle('selected', selected)
    var button = row.querySelector('.project-directory-name')
    if (button !== null) button.setAttribute('aria-pressed', selected ? 'true' : 'false')
  })
}
function selectProjectBrowserDirectory(directory) {
  projectDirectoryBrowser.selected = directory
  projectDirectoryBrowser.error = ''
  var status = $('projectDirectoryStatus')
  if (status !== null) { status.textContent = '已选中「' + directory.name + '」'; status.classList.remove('bad') }
  syncProjectDirectoryControls()
}
function renderProjectDirectoryBrowser() {
  var picker = projectDirectoryBrowser, list = $('projectDirectoryList'), places = $('projectDirectoryLocations'), crumbs = $('projectDirectoryBreadcrumbs')
  if (list === null || places === null || crumbs === null) return
  $('projectDirectoryNode').textContent = '执行节点：' + picker.nodeName
  var status = $('projectDirectoryStatus')
  status.textContent = picker.loading ? '正在读取文件夹…' : picker.error || (picker.directories.length === 0 ? '没有子文件夹，可以选择当前文件夹。' : '单击选中文件夹；双击名称或点击箭头进入。')
  status.classList.toggle('bad', picker.error !== '')
  clear(places); clear(crumbs)
  picker.locations.forEach(function (location) {
    var button = el('button', 'ghost', location.name); button.type = 'button'; button.title = location.path
    button.setAttribute('data-directory-navigation', '')
    button.onclick = function () { browseProjectDirectory(location.path, 'push') }
    places.appendChild(button)
  })
  picker.breadcrumbs.forEach(function (part) {
    var button = el('button', 'ghost', part.name); button.type = 'button'; button.title = part.path
    button.setAttribute('data-directory-navigation', '')
    if (part.path === picker.path) button.setAttribute('aria-current', 'location')
    button.onclick = function () { browseProjectDirectory(part.path, 'push') }
    crumbs.appendChild(button)
  })
  var scroll = list.scrollTop
  clear(list)
  picker.directories.forEach(function (directory) {
    var row = el('div', 'project-directory-row')
    row.setAttribute('data-directory-path', directory.path)
    var select = el('button', 'ghost project-directory-name', '📁 ' + directory.name)
    select.type = 'button'; select.title = directory.path; select.setAttribute('data-directory-navigation', '')
    select.onclick = function () { selectProjectBrowserDirectory(directory) }
    select.ondblclick = function () { browseProjectDirectory(directory.path, 'push') }
    select.onkeydown = function (event) {
      if (event.key === 'Enter' || event.key === 'ArrowRight') { event.preventDefault(); browseProjectDirectory(directory.path, 'push') }
      else if (event.key === 'ArrowLeft' && picker.parentPath) { event.preventDefault(); browseProjectDirectory(picker.parentPath, 'push') }
    }
    var enter = el('button', 'ghost project-directory-enter', '›')
    enter.type = 'button'; enter.title = '进入「' + directory.name + '」'; enter.setAttribute('aria-label', enter.title)
    enter.setAttribute('data-directory-navigation', '')
    enter.onclick = function () { browseProjectDirectory(directory.path, 'push') }
    row.appendChild(select); row.appendChild(enter); list.appendChild(row)
  })
  list.scrollTop = scroll
  var more = $('btnProjectDirectoryMore')
  more.classList.toggle('hidden', picker.nextOffset === null)
  more.textContent = picker.loading ? '读取中…' : '加载更多文件夹（已显示 ' + picker.directories.length + ' / ' + picker.total + '）'
  syncProjectDirectoryControls()
}
function browseProjectDirectory(target, mode) {
  var picker = projectDirectoryBrowser
  if (!projectDirectoryDialogOpen()) return Promise.resolve()
  if (mode === 'more' && picker.nextOffset === null) return Promise.resolve()
  var nodeId = picker.nodeId, serial = ++picker.serial, previous = picker.path
  var params = { nodeId: nodeId, showHidden: $('projectDirectoryHidden').checked === true }
  if (typeof target === 'string' && target !== '') params.path = target
  if (mode === 'more') params.offset = picker.nextOffset
  picker.loading = true; picker.error = ''; renderProjectDirectoryBrowser()
  function current() { return projectDirectoryDialogOpen() && picker.nodeId === nodeId && picker.serial === serial }
  return rpc('project.browse', params).then(function (payload) {
    if (!current()) return
    if (!payload || typeof payload.path !== 'string' || !Array.isArray(payload.directories)) throw new Error('节点未返回有效的文件夹列表，请确认节点已升级')
    var directories = payload.directories.filter(function (entry) { return entry && typeof entry.name === 'string' && typeof entry.path === 'string' })
    if (mode === 'more') {
      var known = new Set(picker.directories.map(function (entry) { return entry.path }))
      picker.directories = picker.directories.concat(directories.filter(function (entry) { return !known.has(entry.path) }))
    } else {
      if (mode === 'back') picker.back.pop()
      else if (mode !== 'refresh' && mode !== 'initial' && previous !== '' && previous !== payload.path) picker.back.push(previous)
      picker.directories = directories
      if (payload.path !== previous) {
        picker.selected = null
        $('projectDirectoryList').scrollTop = 0
      }
    }
    picker.path = payload.path; picker.parentPath = typeof payload.parentPath === 'string' ? payload.parentPath : null
    picker.breadcrumbs = Array.isArray(payload.breadcrumbs) ? payload.breadcrumbs : []
    picker.locations = Array.isArray(payload.locations) ? payload.locations : []
    picker.nextOffset = typeof payload.nextOffset === 'number' && payload.nextOffset > (params.offset || 0) ? payload.nextOffset : null
    picker.total = typeof payload.total === 'number' ? payload.total : picker.directories.length
    if (picker.selected === null || (picker.selected.path !== picker.path && !picker.directories.some(function (entry) { return entry.path === picker.selected.path }))) {
      picker.selected = { name: '当前文件夹', path: picker.path }
    }
    picker.lastPaths[nodeId] = picker.path
  }).catch(function (error) {
    if (!current()) return
    picker.error = '文件夹读取失败：' + describeError(error) + '。可返回主目录或点击刷新重试。'
    picker.selected = null
  }).finally(function () {
    if (!current()) return
    picker.loading = false; renderProjectDirectoryBrowser()
  })
}
function openProjectDirectoryPicker(event) {
  if (event) event.preventDefault()
  if (projectWork.opening || projectDirectoryDialogOpen()) return
  var select = $('projectNode'), nodeId = select === null ? '' : select.value
  var node = projectWork.nodes.find(function (item) { return item.nodeId === nodeId })
  if (!node || state.phase !== 'ready') { projectTell('请先连接并选择执行节点。', true); return }
  if (state.scopes.indexOf('employee.read') < 0 || state.scopes.indexOf('employee.prompt') < 0) { projectTell('当前设备没有打开节点目录的权限。', true); return }
  if (node.online === false) { projectTell('这个节点当前离线，恢复在线后即可选择文件夹。', true); return }
  var picker = projectDirectoryBrowser, dialog = $('projectDirectoryPicker')
  picker.serial += 1; picker.nodeId = nodeId; picker.nodeName = node.name || shortId(nodeId)
  picker.path = ''; picker.parentPath = null; picker.directories = []; picker.locations = []; picker.breadcrumbs = []
  picker.selected = null; picker.back = []; picker.nextOffset = null; picker.total = 0; picker.error = ''
  picker.previousFocus = document.activeElement
  var chosen = projectWork.directorySelection
  var initial = chosen && chosen.nodeId === nodeId ? chosen.path : picker.lastPaths[nodeId]
  if (!initial && projectWork.current !== null && projectWork.current.nodeId === nodeId) initial = projectWork.current.path
  if (typeof dialog.showModal === 'function') dialog.showModal()
  else dialog.setAttribute('open', '')
  renderProjectDirectoryBrowser()
  browseProjectDirectory(initial, 'initial')
}
function closeProjectDirectoryPicker() {
  var dialog = $('projectDirectoryPicker')
  projectDirectoryBrowser.serial += 1; projectDirectoryBrowser.loading = false
  if (dialog !== null && dialog.hasAttribute('open')) {
    if (typeof dialog.close === 'function') dialog.close()
    else dialog.removeAttribute('open')
  }
}
function confirmProjectDirectory() {
  var picker = projectDirectoryBrowser
  if (!projectDirectoryDialogOpen() || picker.selected === null || picker.loading || picker.error !== '' || projectWork.opening || state.phase !== 'ready') return
  var select = $('projectNode')
  if (select === null || select.value !== picker.nodeId) { picker.error = '所选节点已改变，请关闭后重新选择。'; renderProjectDirectoryBrowser(); return }
  projectWork.directorySelection = { nodeId: picker.nodeId, path: picker.selected.path }
  $('projectChosenDirectory').textContent = picker.selected.path
  closeProjectDirectoryPicker()
  openProjectDirectory()
}
function bindProjectDirectoryPicker() {
  var dialog = $('projectDirectoryPicker')
  if (dialog === null) return
  $('btnProjectDirectoryClose').onclick = closeProjectDirectoryPicker
  $('btnProjectDirectoryCancel').onclick = closeProjectDirectoryPicker
  $('btnProjectDirectoryHome').onclick = function () { browseProjectDirectory(undefined, 'push') }
  $('btnProjectDirectoryUp').onclick = function () { if (projectDirectoryBrowser.parentPath) browseProjectDirectory(projectDirectoryBrowser.parentPath, 'push') }
  $('btnProjectDirectoryBack').onclick = function () {
    var back = projectDirectoryBrowser.back
    if (back.length > 0) browseProjectDirectory(back[back.length - 1], 'back')
  }
  $('btnProjectDirectoryRefresh').onclick = function () { browseProjectDirectory(projectDirectoryBrowser.path || undefined, 'refresh') }
  $('btnProjectDirectoryMore').onclick = function () { browseProjectDirectory(projectDirectoryBrowser.path, 'more') }
  $('projectDirectoryHidden').onchange = function () { browseProjectDirectory(projectDirectoryBrowser.path || undefined, 'refresh') }
  $('btnProjectDirectoryCurrent').onclick = function () {
    if (projectDirectoryBrowser.path) selectProjectBrowserDirectory({ name: '当前文件夹', path: projectDirectoryBrowser.path })
  }
  $('btnProjectDirectoryConfirm').onclick = confirmProjectDirectory
  $('projectNode').addEventListener('change', function () {
    projectWork.directorySelection = null
    $('projectChosenDirectory').textContent = '点击“打开目录”选择文件夹'
    closeProjectDirectoryPicker(); syncProjectControls()
  })
  dialog.addEventListener('close', function () {
    if (projectDirectoryDialogOpen()) return
    projectDirectoryBrowser.serial += 1; projectDirectoryBrowser.loading = false
    var focus = projectDirectoryBrowser.previousFocus
    if (focus && focus.isConnected && typeof focus.focus === 'function') focus.focus({ preventScroll: true })
  })
}
`
