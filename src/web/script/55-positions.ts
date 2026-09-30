/**
 * 控制台脚本片段：岗位目录与管理 / 新建员工预览
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
export const CHUNK_55_POSITIONS = String.raw`
function positionList() {
  return Array.isArray(state.positions) ? state.positions : []
}

/** 岗位 id 转显示名。目录里没有该 id 时**原样显示 id**（不假装它不存在）。 */
function positionName(positionId) {
  var id = typeof positionId === 'string' ? positionId.trim() : ''
  if (id === '' || id === 'general') return ''
  var list = positionList()
  for (var i = 0; i < list.length; i += 1) {
    if (String(list[i].id || '') === id) return String(list[i].name || id)
  }
  return id
}

/** 拉岗位目录（只需 employee.read）。失败时保留旧缓存并报错，不阻塞页面。 */
function loadPositions() {
  if (state.phase !== 'ready') return Promise.resolve([])
  return rpc('position.list', {})
    .then(function (payload) {
      var list = pickArray(payload, ['positions', 'items', 'list'])
      state.positions = list.filter(function (item) {
        return item !== null && typeof item === 'object' && typeof item.id === 'string'
      })
      /* 目录变了：当前这页的岗位外壳（如秘书页）与工位徽章都要跟着变 */
      if (state.selectedEmployeeId !== null) applyPositionShell(employeeById(state.selectedEmployeeId))
      /* 目录变了，工位上的岗位徽章要跟着变；下拉在新建表单展开时才重建，
         避免冲掉用户正在填的内容 */
      if ($('officeFloor') !== null) renderEmployees()
      return state.positions
    })
    .catch(function (error) {
      reportRpcError('position.list', error)
      return []
    })
}

/** 新增岗位（position.upsert，需要 employee.manage）。返回新岗位 id 供表单接着用。 */
function createPosition(name) {
  return rpc('position.upsert', { name: name }, { idempotencyKey: randomId() })
    .then(function (payload) {
      var entry = payload !== null && typeof payload === 'object' ? payload.position : null
      var id = entry !== null && typeof entry === 'object' ? String(entry.id || '') : ''
      return loadPositions().then(function () {
        if (id !== '') toast('岗位「' + name + '」已加入目录', 'ok')
        return id
      })
    })
    .catch(function (error) {
      reportRpcError('position.upsert', error)
      return ''
    })
}

/**
 * 岗位下拉 + 行内「＋ 新增岗位」。
 * read() 的两种结果对应两条保存路径：已存在的 id 直接用；填了新名字的要先 upsert
 * 拿到 id 再落员工（调用方见 createEmployee 与工位编辑器）。
 */
function buildPositionPicker(currentId) {
  var NEW = '__new_position__'
  var root = el('span', 'group-picker')
  var select = el('select', '')
  var current = typeof currentId === 'string' ? currentId.trim() : ''

  var list = positionList()
  var seen = {}
  list.forEach(function (entry) {
    var id = String(entry.id || '')
    if (id === '' || seen[id] === true) return
    seen[id] = true
    var option = el('option', '', String(entry.name || id))
    option.value = id
    select.appendChild(option)
  })
  /* 当前岗位不在目录里（目录被改过 / 尚未加载）：补一条，让现有绑定仍然可见可保留 */
  var fallback = current === '' ? 'general' : current
  if (seen[fallback] !== true) {
    var orphan = el('option', '', fallback + '（不在目录里）')
    orphan.value = fallback
    select.appendChild(orphan)
  }
  var newOption = el('option', '', '＋ 新增岗位')
  newOption.value = NEW
  select.appendChild(newOption)
  select.value = fallback

  var newInput = el('input', 'group-new hidden')
  newInput.type = 'text'
  newInput.maxLength = 32
  newInput.placeholder = '新岗位名（如：渗透测试）'
  select.onchange = function () {
    var creating = select.value === NEW
    newInput.classList.toggle('hidden', !creating)
    if (creating) newInput.focus()
  }
  root.appendChild(select)
  root.appendChild(newInput)

  return {
    root: root,
    /** { id } 已存在的岗位；{ newName } 需要先新增；两者皆无 = 未选 */
    read: function () {
      if (select.value !== NEW) return { id: select.value }
      var name = String(newInput.value || '').trim().slice(0, 32)
      return name === '' ? {} : { newName: name }
    },
    selectId: function (id) {
      select.value = id
      newInput.value = ''
      newInput.classList.add('hidden')
    }
  }
}

/** 把选择器的结果落成岗位 id：就地新增，或直接返回已存在的 id。 */
function resolvePositionChoice(choice) {
  if (choice !== null && typeof choice === 'object' && typeof choice.id === 'string' && choice.id !== '') {
    return Promise.resolve(choice.id)
  }
  if (choice !== null && typeof choice === 'object' && typeof choice.newName === 'string') {
    return createPosition(choice.newName)
  }
  return Promise.resolve('')
}


/** 岗位管理列表：改名（按 id 幂等）/ 删除（内置不可删）。 */
function renderPositionAdmin() {
  var box = $('positionAdminList')
  var chip = $('positionCount')
  if (box === null) return
  clear(box)
  var list = positionList()
  if (chip !== null) chip.textContent = String(list.length) + ' 个'
  if (list.length === 0) {
    box.appendChild(el('div', 'muted', '（目录为空或未连接）'))
    return
  }
  list.forEach(function (entry) {
    var id = String(entry.id || '')
    var name = String(entry.name || id)
    var bound = 0
    state.employees.forEach(function (employee) {
      if (String(employee.position || '') === id) bound += 1
    })
    var row = el('div', 'pos-row')
    var input = el('input', 'pos-name')
    input.type = 'text'
    input.maxLength = 32
    input.value = name
    input.setAttribute('aria-label', '岗位名')
    var meta = el('span', 'pos-meta', entry.builtin === true ? '内置' : bound === 0 ? '未使用' : bound + ' 人')
    var save = el('button', 'ghost pos-act', '改名')
    var remove = el('button', 'ghost pos-act danger', '删除')
    if (entry.builtin === true) {
      /* 内置岗位是缺省项：改名可以，删除不给（不给一个按了会报错的按钮） */
      remove.disabled = true
      remove.title = '内置岗位不可删除'
    }
    save.onclick = function () {
      var next = String(input.value || '').trim().slice(0, 32)
      if (next === '') {
        toast('岗位名不能为空', 'warn')
        return
      }
      if (next === name) return
      save.disabled = true
      rpc('position.upsert', { id: id, name: next }, { idempotencyKey: randomId() })
        .then(function () {
          toast('岗位已改名为「' + next + '」', 'ok')
          return loadPositions().then(renderPositionAdmin)
        })
        .catch(function (error) {
          save.disabled = false
          refreshPositionsIfStale(error)
          reportRpcError('position.upsert', error)
        })
    }
    remove.onclick = function () {
      /* 删除会动到别人：把影响人数写进确认文案，别让人删完才发现有人被改回通用 */
      var hint = bound === 0 ? '该岗位当前没有员工在用。' : '有 ' + bound + ' 个员工绑着它，会被改回「通用」。'
      if (window.confirm('删除岗位「' + name + '」？' + hint) !== true) return
      remove.disabled = true
      rpc('position.remove', { id: id }, { idempotencyKey: randomId() })
        .then(function (payload) {
          var failed = payload !== null && typeof payload === 'object' && Array.isArray(payload.failed) ? payload.failed.length : 0
          if (failed > 0) {
            toast('已删除「' + name + '」，但有 ' + failed + ' 个员工的岗位没能改回通用（节点离线）', 'warn')
          } else {
            toast('已删除岗位「' + name + '」', 'ok')
          }
          return loadEmployees().then(function () {
            return loadPositions()
          }).then(renderPositionAdmin)
        })
        .catch(function (error) {
          remove.disabled = false
          refreshPositionsIfStale(error)
          reportRpcError('position.remove', error)
        })
    }
    row.appendChild(input)
    row.appendChild(meta)
    row.appendChild(save)
    row.appendChild(remove)
    box.appendChild(row)
  })
}

/**
 * 岗位目录在别处被改过时（另一个标签页、手机、CLI），本地这份列表就是过期的：
 * 结果是要么"删一个早就不在的岗位"（not-found，报错里只有一串 pos_…），
 * 要么"改名/新增被拒"。这两种情况下**先把列表刷新回来**再看报错 ——
 * 否则人会对着一个已经不存在的条目反复点。
 *
 * 真实事故：椰椰的岗位指向一个目录里不存在的老 id，而界面上只有一串 pos_421e7a；
 * 看界面的人既不知道那是"岗位没了"，也不知道该改哪里。
 */
function refreshPositionsIfStale(error) {
  var code = error !== null && typeof error === 'object' ? String(error.code || '') : ''
  if (code !== 'not-found' && code !== 'bad-request') return
  loadPositions()
    .then(renderPositionAdmin)
    .catch(function () {
      /* 刷新失败就保持现状：原始报错已经发出去了，这里不再叠一层 */
    })
}

/** 新增岗位（管理入口用；与新建表单里的「＋ 新增岗位」是同一个后端动作）。 */
function addPositionFromAdmin() {
  var input = $('newPositionName')
  var name = input === null ? '' : String(input.value || '').trim().slice(0, 32)
  if (name === '') {
    toast('请先填写岗位名', 'warn')
    return
  }
  createPosition(name).then(function (id) {
    if (id === '') return
    if (input !== null) input.value = ''
    renderPositionAdmin()
  })
}

function createPreviewPositionLabel() {
  var picker = state.createPositionPicker
  if (picker === null) return '通用'
  var choice = picker.read()
  if (choice !== null && typeof choice === 'object') {
    if (typeof choice.newName === 'string' && choice.newName !== '') return choice.newName
    if (typeof choice.id === 'string' && choice.id !== '') {
      var label = positionName(choice.id)
      return label === '' ? '通用' : label
    }
  }
  return '通用'
}

function createPreviewGroupLabel() {
  var picker = state.createGroupPicker
  if (picker === null) return '未分组'
  var group = picker.read()
  return group === '' ? '未分组' : group
}

function renderCreatePreview() {
  var preview = $('createPreview')
  if (preview === null) return
  clear(preview)
  var nameInput = $('createName')
  var roleInput = $('createRole')
  var name = String(nameInput === null ? '' : nameInput.value || '').trim() || '新同事'
  var role = String(roleInput === null ? '' : roleInput.value || '').trim() || '等待填写职责'
  var nodeSelect = $('createNode')
  var nodeName = '等待选择运行节点'
  if (nodeSelect !== null && nodeSelect.options.length > 0 && nodeSelect.selectedIndex >= 0) {
    nodeName = String(nodeSelect.options[nodeSelect.selectedIndex].textContent || '').trim() || nodeName
  }
  var employee = {
    id: 'create-preview-' + name,
    name: name,
    role: role,
    position: state.createPositionPicker === null ? 'general' : (state.createPositionPicker.read().id || 'general'),
    available: false,
    nodeOnline: false,
    hasAvatar: false
  }

  var desk = el('div', 'create-preview-desk')
  desk.appendChild(avatarNode(employee, 88))
  var info = el('div', 'create-preview-info')
  info.appendChild(el('strong', 'create-preview-name', name))
  var badges = el('div', 'create-preview-badges')
  badges.appendChild(el('span', 'badge', createPreviewPositionLabel()))
  badges.appendChild(el('span', 'badge off', '待创建'))
  info.appendChild(badges)
  info.appendChild(el('div', 'create-preview-role', role))
  info.appendChild(el('div', 'create-preview-location', createPreviewGroupLabel() + ' · ' + nodeName))
  desk.appendChild(info)
  preview.appendChild(desk)
  var screen = el('div', 'create-preview-screen')
  screen.appendChild(el('span', 'create-preview-screen-dim', '空闲中'))
  screen.appendChild(el('span', '', '创建后会在这里显示工作状态'))
  preview.appendChild(screen)
}

function bindCreatePreviewPicker(picker) {
  if (picker === null || picker.root === null) return
  var controls = picker.root.querySelectorAll('select, input')
  for (var i = 0; i < controls.length; i += 1) {
    controls[i].addEventListener('change', renderCreatePreview)
    controls[i].addEventListener('input', renderCreatePreview)
  }
}
`
