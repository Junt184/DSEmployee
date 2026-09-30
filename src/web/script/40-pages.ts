/**
 * 控制台脚本片段：随机昵称 / 模型配置页
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
export const CHUNK_40_PAGES = String.raw`
/* ─────────────────── 9.5 新建员工：随机昵称 ───────────────────
 *
 * 单人自用场景里"给新员工起名"是高频低价值的决策点 —— 表单展开时自动填一个
 * 可爱的女性昵称，不满意点「换一个」，用户自己填的永远优先。
 * 抽取用 Math.random（无安全需求），但避开现有员工名（重名会让办公区混淆）。
 */
var EMPLOYEE_NAME_POOL = [
  /* 叠字 */
  '桃桃', '朵朵', '念念', '糖糖', '果果', '米米', '豆豆', '萌萌', '甜甜', '暖暖',
  '安安', '宁宁', '悠悠', '然然', '夏夏', '晴晴', '溪溪', '沐沐', '橙橙', '柚柚',
  '梨梨', '杏杏', '荔荔', '莓莓', '椰椰', '麦麦', '苗苗', '芽芽', '棉棉', '糯糯',
  '圆圆', '团团', '柔柔', '蜜蜜', '泡泡', '叮叮', '当当', '可可', '乐乐', '笑笑',
  /* 小字辈 */
  '小满', '小葵', '小桃', '小杏', '小梨', '小柚', '小橙', '小橘', '小荔', '小莓',
  '小椰', '小柠', '小檬', '小棠', '小栀', '小荷', '小芦', '小蒲', '小苔', '小芙',
  '小樱', '小棉', '小糯', '小粟', '小麦', '小豆', '小米', '小甜', '小暖', '小安',
  '小宁', '小悠', '小然', '小夏', '小晴', '小溪', '小沐', '小云', '小月', '小星',
  /* 自然系 */
  '知夏', '晚晴', '初夏', '半夏', '立夏', '白露', '谷雨', '小雪', '青禾', '白桃',
  '青提', '红柚', '青梅', '紫苏', '薄荷', '茉莉', '栀子', '海棠', '丁香', '木棉',
  '风信', '雨眠', '云舒', '溪云', '汀兰', '汀白', '浅夏', '沐晴', '暖阳', '微风',
  '晨露', '朝颜', '晚霞', '春水', '秋梨', '冬枣', '山桃', '野樱', '溪桃', '望舒',
  /* 食物系 */
  '桃酥', '杏子', '栗子', '柚子', '橙子', '布丁', '糯米', '芋圆', '奶盖', '西米',
  '可颂', '麻薯', '青团', '豆花', '花卷', '糖霜', '奶冻', '泡芙', '曲奇', '蛋挞',
  '松饼', '雪媚', '绵绵', '冰糖', '蜜豆', '椰果', '桂圆', '莲雾', '杨桃', '石榴',
  '樱桃', '蓝莓', '草莓', '树莓', '蜜桃', '甜橙', '香梨', '脆柿', '蜜柚', '金桔',
  /* 叠字与其他 */
  '一一', '七七', '九九', '元元', '岁岁', '年年', '朝朝', '暮暮', '多多', '满满',
  '盈盈', '灿灿', '星星', '啾啾', '嘟嘟', '滚滚', '阿梨', '阿桃', '阿杏', '阿柚',
  '阿棠', '阿柠', '阿樱', '阿禾', '阿恬', '阿暖', '囡囡', '妞妞', '丫丫', '妙妙',
  '灵灵', '俏俏', '婉婉', '楚楚', '陶陶', '莞莞', '茸茸', '软软', '晶晶', '栗栗'
]

/** 可用池 = 名字池 − 现有员工名，从可用池里均匀随机；抽空时退回「昵称+两位序号」。 */
function randomEmployeeName() {
  var existing = {}
  state.employees.forEach(function (employee) {
    existing[String(employee.name || '')] = true
  })
  var available = EMPLOYEE_NAME_POOL.filter(function (name) {
    return existing[name] !== true
  })
  if (available.length === 0) {
    return EMPLOYEE_NAME_POOL[Math.floor(Math.random() * EMPLOYEE_NAME_POOL.length)] + String(Math.floor(Math.random() * 90) + 10)
  }
  return available[Math.floor(Math.random() * available.length)]
}

/** 表单展开时的自动填充：用户手动改过名字就不冲掉（手动输入永远优先）。 */
function autofillCreateName() {
  var input = $('createName')
  if (input === null) return
  if (state.createNameTouched === true && String(input.value || '').trim() !== '') return
  input.value = randomEmployeeName()
  state.createNameTouched = false
}

/* ─────────────────── 10. 员工配置标签页（原「模型配置」）───────────────────
 *
 * 这一页管的是"**这个员工怎么跑**"：用哪些模型（端点库 + 别名）、以及它的权限档位。
 * 之所以从「模型配置」改名成「员工配置」：一页里不再只有模型这一件事，
 * 名字跟不上内容，人就会去错的地方找设置。
 *
 * 两层：**端点库**（BaseURL + Key，输一次多员工复用）与**员工模型**
 * （每个员工挂多条「别名 → 端点 + 模型」）。
 *
 * 为什么值得这么改（真实痛点）：原来一个员工只能钉死一个端点 + 一个模型，
 * 换个模型就得把 BaseURL 与 Key 重新手打一遍 —— 于是"同一个员工用不同模型干不同的活"
 * 事实上做不到。现在切换只是在下拉里选一条，密钥永不再经过浏览器。
 *
 * 三个刻意的取舍：
 *   · **别名由用户自己拼**（如 gpt5.6-noelle），系统不自动起名 —— 起名规则猜不准，
 *     而名字是给人认的；
 *   · **设为当前 = 连当前打开的会话一起切**（节点侧用 session.selectModel）；
 *     正在跑回合的会话会拒绝并说明 —— "切了一半"比"没切"更难查；
 *   · 配置**行内展开**而不是弹窗：配模型是"边填边试"的过程（试 URL → 拉模型 → 选 → 存），
 *     弹窗每次开关都丢上下文。
 */

/* ── 端点库 ── */

/** 「新增端点」按钮：展开一个空编辑器（行内，不弹窗）。 */
function bindEndpointUi() {
  var button = $('btnNewEndpoint')
  if (button === null) return
  button.onclick = function () {
    state.llmEndpointEdit = state.llmEndpointEdit === 'new' ? null : 'new'
    renderEndpointList()
  }
}

function loadLlmEndpoints() {
  bindEndpointUi()
  var box = $('endpointList')
  if (box === null) return
  if (state.phase !== 'ready' || state.scopes.indexOf('employee.read') < 0) {
    clear(box)
    box.appendChild(el('div', 'muted', '（未连接）'))
    return
  }
  rpc('llm.endpoint.list', {})
    .then(function (payload) {
      var list = pickArray(payload, ['endpoints'])
      state.llmEndpoints = list.filter(function (item) {
        return item !== null && typeof item === 'object'
      })
      renderEndpointList()
    })
    .catch(function (error) {
      clear(box)
      box.appendChild(el('div', 'muted', '端点库读不出来：' + describeError(error)))
    })
}

function endpointById(endpointId) {
  for (var i = 0; i < state.llmEndpoints.length; i += 1) {
    if (String(state.llmEndpoints[i].id || '') === endpointId) return state.llmEndpoints[i]
  }
  return undefined
}

function endpointLabel(endpointId) {
  if (endpointId === '') return '本地端点（未入库）'
  var entry = endpointById(endpointId)
  return entry === undefined ? '端点已删除（' + endpointId + '）' : String(entry.name || endpointId)
}

function hostOf(apiUrl) {
  try {
    return new URL(String(apiUrl)).host
  } catch (error) {
    return String(apiUrl || '')
  }
}

function renderEndpointList() {
  var box = $('endpointList')
  if (box === null) return
  clear(box)
  var canManage = state.scopes.indexOf('employee.manage') >= 0

  if (state.llmEndpoints.length === 0 && state.llmEndpointEdit === null) {
    box.appendChild(el('div', 'muted', '（库里还没有端点 —— 点右上角「新增端点」）'))
    return
  }

  state.llmEndpoints.forEach(function (entry) {
    var id = String(entry.id || '')
    var row = el('div', 'llm-row')
    var head = el('div', 'llm-row-head')
    head.appendChild(el('strong', '', String(entry.name || id)))
    head.appendChild(
      el(
        'span',
        'llm-status',
        hostOf(entry.apiUrl) +
          ' · ' +
          String(entry.keyMask || '无 key') +
          (entry.proxy === undefined || entry.proxy === null
            ? ''
            : ' · 代理 ' + String(entry.proxy.host) + ':' + String(entry.proxy.port)),
      ),
    )
    var used = Array.isArray(entry.usedBy) ? entry.usedBy : []
    head.appendChild(
      el('span', 'chip', used.length === 0 ? '无人使用' : String(used.length) + ' 个员工在用'),
    )
    var edit = el('button', 'ghost', state.llmEndpointEdit === id ? '收起' : '编辑')
    edit.onclick = function () {
      state.llmEndpointEdit = state.llmEndpointEdit === id ? null : id
      renderEndpointList()
    }
    head.appendChild(edit)
    if (canManage) {
      var remove = el('button', 'ghost danger', '删除')
      remove.onclick = function () {
        if (window.confirm('删除端点「' + String(entry.name || id) + '」？（还有员工在用会被拒绝）') !== true) return
        remove.disabled = true
        rpc('llm.endpoint.remove', { id: id }, { idempotencyKey: randomId() })
          .then(function () {
            toast('已删除端点「' + String(entry.name || id) + '」', 'ok')
            loadLlmEndpoints()
          })
          .catch(function (error) {
            remove.disabled = false
            reportRpcError('llm.endpoint.remove', error)
          })
      }
      head.appendChild(remove)
    }
    row.appendChild(head)

    if (used.length > 0) {
      row.appendChild(
        el(
          'div',
          'muted',
          '在用：' +
            used
              .map(function (item) {
                return String(item.name || item.employeeId || '')
              })
              .join('、'),
        ),
      )
    }
    if (state.llmEndpointEdit === id) row.appendChild(buildEndpointEditor(entry))
    box.appendChild(row)
  })

  if (state.llmEndpointEdit === 'new') {
    var draft = el('div', 'llm-row')
    draft.appendChild(buildEndpointEditor(null))
    box.appendChild(draft)
  }
}

/** 端点编辑器（新增与编辑共用；entry === null = 新增）。 */
function buildEndpointEditor(entry) {
  var id = entry === null ? '' : String(entry.id || '')
  var canManage = state.scopes.indexOf('employee.manage') >= 0
  var editor = el('div', 'llm-editor')

  var nameInput = el('input', '')
  nameInput.type = 'text'
  nameInput.placeholder = '端点名（你认得出就行，如 noelle）'
  nameInput.value = entry === null ? '' : String(entry.name || '')
  editor.appendChild(nameInput)

  var urlInput = el('input', '')
  urlInput.type = 'text'
  urlInput.placeholder = 'BaseURL（如 https://api.example.com/v1）'
  urlInput.value = entry === null ? '' : String(entry.apiUrl || '')
  editor.appendChild(urlInput)

  var keyInput = el('input', '')
  keyInput.type = 'password'
  keyInput.placeholder =
    entry !== null && entry.hasKey === true
      ? 'API Key（已保存 ' + String(entry.keyMask || '') + '，留空 = 不改动）'
      : 'API Key（端点不需要时留空）'
  editor.appendChild(keyInput)

  /* 出口代理：有些域名只有走代理才通（直连被 Cloudflare 挡、或服务方只放行境外 IP）。
     默认值就是最常见的本机代理口 127.0.0.1:7892 —— 勾上就能用，不用手打。 */
  var proxyRow = el('div', 'row')
  var proxyToggle = el('input', '')
  proxyToggle.type = 'checkbox'
  proxyToggle.checked = entry !== null && entry.proxy !== undefined && entry.proxy !== null
  var proxyToggleLabel = el('label', '', '走 HTTP 代理')
  proxyToggleLabel.appendChild(proxyToggle)
  proxyRow.appendChild(proxyToggleLabel)
  var proxyHost = el('input', '')
  proxyHost.type = 'text'
  proxyHost.placeholder = '127.0.0.1'
  proxyHost.value =
    entry !== null && entry.proxy !== undefined && entry.proxy !== null
      ? String(entry.proxy.host || '127.0.0.1')
      : '127.0.0.1'
  var proxyPort = el('input', '')
  proxyPort.type = 'text'
  proxyPort.placeholder = '7892'
  proxyPort.value =
    entry !== null && entry.proxy !== undefined && entry.proxy !== null
      ? String(entry.proxy.port || 7892)
      : '7892'
  var syncProxyInputs = function () {
    proxyHost.disabled = proxyToggle.checked !== true
    proxyPort.disabled = proxyToggle.checked !== true
  }
  proxyToggle.onclick = syncProxyInputs
  syncProxyInputs()
  proxyRow.appendChild(proxyHost)
  proxyRow.appendChild(el('span', 'muted', ':'))
  proxyRow.appendChild(proxyPort)
  editor.appendChild(proxyRow)
  var readProxy = function () {
    if (proxyToggle.checked !== true) return null
    var host = String(proxyHost.value || '').trim() || '127.0.0.1'
    var port = Number.parseInt(String(proxyPort.value || ''), 10)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      toast('代理端口不合法（应当是 1~65535）', 'warn')
      return undefined
    }
    return { host: host, port: port }
  }

  var probeRow = el('div', 'row')
  var probeButton = el('button', 'ghost', '获取模型列表')
  probeButton.disabled = !canManage
  var probeResult = el('span', 'muted', '')
  probeButton.onclick = function () {
    probeButton.disabled = true
    probeResult.textContent = '正在拉取…'
    var proxy = readProxy()
    if (proxy === undefined) return
    var params = { apiUrl: urlInput.value }
    if (id !== '') params.id = id
    if (keyInput.value !== '') params.apiKey = keyInput.value
    /* 显式带上代理（含 null = 不走代理）：这一步是"能不能通"的关键，
       别让用户为了试一次还得先保存一遍。 */
    params.proxy = proxy
    rpc('llm.endpoint.probe', params)
      .then(function (payload) {
        var models = pickArray(payload, ['models'])
        state.llmProbeModels[id] = models
        probeResult.textContent = '拉到 ' + String(models.length) + ' 个模型（保存后供下拉选择）'
        paintEndpointModelOptions(id, models)
      })
      .catch(function (error) {
        probeResult.textContent = ''
        reportRpcError('llm.endpoint.probe', error)
      })
      .then(function () {
        probeButton.disabled = false
      })
  }
  probeRow.appendChild(probeButton)
  probeRow.appendChild(probeResult)
  editor.appendChild(probeRow)

  var modelList = el('div', 'muted', '')
  modelList.setAttribute('data-endpoint-models', id)
  var known = state.llmProbeModels[id] || (entry !== null && Array.isArray(entry.models) ? entry.models : [])
  modelList.textContent = known.length === 0 ? '（还没有模型清单：点上面的按钮拉一次）' : '模型：' + known.join('、')
  editor.appendChild(modelList)

  var actions = el('div', 'row')
  var save = el('button', 'primary', '保存')
  save.disabled = !canManage
  save.onclick = function () {
    var name = String(nameInput.value || '').trim()
    var url = String(urlInput.value || '').trim()
    if (name === '' || url === '') {
      toast('端点名与 BaseURL 都要填', 'warn')
      return
    }
    var params = { name: name, apiUrl: url }
    if (id !== '') params.id = id
    if (keyInput.value !== '') params.apiKey = keyInput.value
    var proxy = readProxy()
    if (proxy === undefined) return
    params.proxy = proxy
    var models = state.llmProbeModels[id]
    if (Array.isArray(models) && models.length > 0) params.models = models
    save.disabled = true
    rpc('llm.endpoint.upsert', params, { idempotencyKey: randomId() })
      .then(function (payload) {
        var synced = pickArray(payload, ['synced'])
        var failed = synced.filter(function (item) {
          return item !== null && typeof item === 'object' && item.ok !== true
        })
        if (failed.length > 0) {
          toast(
            '已保存，但有 ' + String(failed.length) + ' 个员工没能同步（' +
              failed
                .map(function (item) {
                  return String(item.name || '')
                })
                .join('、') +
              '）—— 那台机器可能离线，稍后再保存一次即可',
            'warn',
          )
        } else {
          toast(synced.length > 0 ? '已保存并同步 ' + String(synced.length) + ' 个员工' : '已保存', 'ok')
        }
        state.llmEndpointEdit = null
        loadLlmEndpoints()
      })
      .catch(function (error) {
        save.disabled = false
        reportRpcError('llm.endpoint.upsert', error)
      })
  }
  actions.appendChild(save)
  var cancel = el('button', 'ghost', '取消')
  cancel.onclick = function () {
    state.llmEndpointEdit = null
    renderEndpointList()
  }
  actions.appendChild(cancel)
  editor.appendChild(actions)
  return editor
}

/** 修改某条端点已拉到的模型清单（原地更新，不整页重建 —— 别把正在填的输入清掉）。 */
function paintEndpointModelOptions(endpointId, models) {
  var box = document.querySelector('[data-endpoint-models="' + endpointId + '"]')
  if (box === null) return
  box.textContent = Array.isArray(models) && models.length > 0 ? '模型：' + models.join('、') : '（没拉到模型）'
}

/* ── 节点权限档位（整机级，只影响新建会话）── */

var PRESET_TEXT = {
  'read-only': '只读',
  'workspace-write': '工作区可写（越界会问，默认）',
  'danger-full-access': '完全访问（不逐条审批，整机放开）'
}

function loadNodePermissions() {
  var box = $('nodePermissionList')
  if (box === null) return
  if (state.scopes.indexOf('node.admin') < 0 || state.phase !== 'ready') {
    clear(box)
    box.appendChild(el('div', 'muted', '（需要 node.admin scope）'))
    return
  }
  rpc('node.list', {})
    .then(function (payload) {
      var nodes = pickArray(payload, ['nodes'])
      state.nodePermissions = {}
      nodes.forEach(function (item) {
        if (item === null || typeof item !== 'object') return
        var id = String(item.nodeId || '')
        if (id === '') return
        state.nodePermissions[id] = { name: String(item.name || id), online: item.online === true, preset: undefined }
        if (item.online !== true) return
        rpc('node.permission.get', { nodeId: id })
          .then(function (result) {
            if (state.nodePermissions[id] !== undefined) {
              state.nodePermissions[id].preset = result !== null && typeof result === 'object' ? result.preset : undefined
            }
            renderNodePermissions()
          })
          .catch(function (error) {
            if (state.nodePermissions[id] !== undefined) state.nodePermissions[id].error = describeError(error)
            renderNodePermissions()
          })
      })
      renderNodePermissions()
    })
    .catch(function (error) {
      clear(box)
      box.appendChild(el('div', 'muted', '节点列表读不出来：' + describeError(error)))
    })
}

function renderNodePermissions() {
  var box = $('nodePermissionList')
  if (box === null) return
  clear(box)
  var ids = Object.keys(state.nodePermissions)
  if (ids.length === 0) {
    box.appendChild(el('div', 'muted', '（没有节点）'))
    return
  }
  var canManage = state.scopes.indexOf('node.admin') >= 0
  ids.forEach(function (id) {
    var info = state.nodePermissions[id]
    var row = el('div', 'row')
    row.appendChild(el('strong', '', info.name))
    if (info.online !== true) {
      row.appendChild(el('span', 'muted', '离线（档位要在线时才能改）'))
      box.appendChild(row)
      return
    }
    var select = el('select', '')
    Object.keys(PRESET_TEXT).forEach(function (value) {
      var option = el('option', '', PRESET_TEXT[value])
      option.value = value
      select.appendChild(option)
    })
    select.value = String(info.preset || 'workspace-write')
    select.disabled = !canManage
    var current = el('span', 'muted', info.error !== undefined ? '读不出来：' + info.error : '当前：' + PRESET_TEXT[String(info.preset)] || '未知')
    select.onchange = function () {
      select.disabled = true
      rpc(
        'node.permission.set',
        { nodeId: id, preset: String(select.value) },
        { idempotencyKey: randomId() }
      )
        .then(function (result) {
          info.preset = result !== null && typeof result === 'object' ? result.preset : undefined
          delete info.error
          toast(info.name + ' 的默认档位 → ' + String(PRESET_TEXT[String(info.preset)] || info.preset) + '（只影响新建会话）', 'ok')
          renderNodePermissions()
        })
        .catch(function (error) {
          select.disabled = false
          reportRpcError('node.permission.set', error)
        })
    }
    row.appendChild(select)
    row.appendChild(el('span', 'muted', '当前：' + String(PRESET_TEXT[String(info.preset)] || (info.error === undefined ? '读取中…' : '读不出来'))))
    box.appendChild(row)
  })
}

/* ── 员工模型 ── */

function renderLlmConfig() {
  var list = $('llmConfigList')
  if (list === null) return
  clear(list)
  if (state.employees.length === 0) {
    list.appendChild(el('div', 'empty', state.phase === 'ready' ? '（暂无员工）' : '（未连接）'))
    return
  }
  /* 与办公区同序：按 group 分区，组名中文排序 */
  var groups = new Map()
  state.employees.forEach(function (employee) {
    var name = groupOf(employee)
    var bucket = groups.get(name)
    if (bucket === undefined) {
      bucket = []
      groups.set(name, bucket)
    }
    bucket.push(employee)
  })
  var names = Array.from(groups.keys()).sort(function (a, b) {
    return a.localeCompare(b, 'zh-Hans-CN')
  })
  var canManage = state.scopes.indexOf('employee.manage') >= 0

  names.forEach(function (name) {
    var members = groups.get(name) || []
    var section = el('div', 'office-group')
    var head = el('div', 'office-group-head')
    head.appendChild(el('span', 'office-group-name', name))
    head.appendChild(el('span', 'chip', String(members.length) + ' 人'))
    section.appendChild(head)
    members.forEach(function (employee) {
      section.appendChild(buildLlmRow(employee, canManage))
    })
    list.appendChild(section)
  })
}

/**
 * 「审批自动放行」开关（**按员工**，Hub 侧策略）。
 *
 * 为什么是这一条而不是"改权限档位"：dsh 这版没有按员工设档位的接口（见下），
 * 而"别老是问我"这件事的裁决点本来就在 Hub。说实话的部分写在下方的提示里：
 * 它免掉的是**审批**，不是沙箱 —— 员工越出工作区读写仍然会被 dsh 挡住；
 * 而且**提问不会被自动回答**（那是在问人，不该替人决定）。
 */
function buildAutoApproveRow(employee, canManage) {
  var id = String(employee.id || '')
  var row = el('div', 'row')
  var box = el('input', '')
  box.type = 'checkbox'
  box.checked = employee.autoApprove === true
  box.disabled = !canManage
  var label = el('label', '', '审批自动放行')
  label.appendChild(box)
  row.appendChild(label)
  var hint = el(
    'span',
    'muted',
    employee.autoApprove === true
      ? '开着：它的 dsh 审批**不再等你**（自动通过，审批页留痕）；提问仍会问你，沙箱越界仍会被挡'
      : '关着：每次要执行工具都会推给你批',
  )
  row.appendChild(hint)
  box.onchange = function () {
    box.disabled = true
    rpc(
      'employee.autoApprove.set',
      { employeeId: id, enabled: box.checked === true },
      { idempotencyKey: randomId() },
    )
      .then(function () {
        toast(box.checked === true ? '已开启：它的审批不再等你' : '已关闭：审批重新等你', box.checked === true ? 'warn' : 'ok')
        loadEmployees()
      })
      .catch(function (error) {
        box.checked = box.checked !== true
        box.disabled = false
        reportRpcError('employee.autoApprove.set', error)
      })
  }
  return row
}

/**
 * 权限档位（**只读显示**）。
 *
 * 为什么现在只能读不能改：dsh 0.1.0-rc.6 没有暴露"按会话/按员工"设档位的接口
 * （session.permissions、session.setPermission 之类逐个试过，全是 not found），
 * 唯一的写入口是**机器级**默认（settings.permission.defaultPreset）——
 * 那会把这台机器上**所有**员工的新会话一起放开，不是"某些员工"。
 * 先把"现在是哪一档"摆到页面上（档位取自最新那个会话的投影），
 * 免得"谁在完全访问下裸奔"只能靠猜。
 */
var PERMISSION_LABELS = {
  'read-only': '只读',
  'workspace-write': '工作区可写（越界会问）',
  'danger-full-access': '完全访问（不逐条审批）',
  custom: '自定义'
}

function permissionLabel(value) {
  var key = String(value || '')
  if (key === '') return '未知'
  return PERMISSION_LABELS[key] === undefined ? key : PERMISSION_LABELS[key]
}

function loadPermissionPreset(employeeId) {
  rpc('session.list', { employeeId: employeeId })
    .then(function (payload) {
      var sessions = pickArray(payload, ['sessions'])
      var newest = null
      sessions.forEach(function (item) {
        if (item === null || typeof item !== 'object') return
        var at = Number(item.updatedAt || item.updatedAtMs || 0)
        if (newest === null || at > Number(newest.updatedAt || newest.updatedAtMs || 0)) newest = item
      })
      var preset = ''
      if (newest !== null && newest.projections !== null && typeof newest.projections === 'object') {
        var values = newest.projections.values
        if (values !== null && typeof values === 'object' && values.permissions !== null && typeof values.permissions === 'object') {
          preset = String(values.permissions.currentValue || '')
        }
      }
      state.llmPermission[employeeId] = { preset: preset, hasSession: newest !== null }
      renderLlmConfig()
    })
    .catch(function () {
      state.llmPermission[employeeId] = { preset: '', hasSession: false, failed: true }
      renderLlmConfig()
    })
}

function permissionLine(employeeId) {
  var info = state.llmPermission[employeeId]
  if (info === undefined) return '权限档位：正在读…'
  if (info.failed === true) return '权限档位：读不出来（节点离线？）'
  if (info.hasSession !== true) return '权限档位：还没有会话（新会话按机器的默认档位）'
  return '权限档位：' + permissionLabel(info.preset) + '（取自最新那个会话；改档位要等 dsh 支持按员工设置）'
}

/** 收起时那一行：当前模型别名由**员工的注册摘要**直接给出，不必再问一次节点。 */
function llmActiveLabel(employee) {
  var name = typeof employee.llmActiveName === 'string' ? employee.llmActiveName : ''
  return name === '' ? '未配置（用节点默认模型）' : '当前：' + name
}

function buildLlmRow(employee, canManage) {
  var id = String(employee.id || '')
  var row = el('div', 'llm-row')

  var head = el('div', 'llm-row-head')
  /* 与工位同源的头像（28px 小尺寸），保持"哪个员工"的视觉一致性 */
  head.appendChild(avatarNode(employee, 28))
  ensureAvatar(employee)
  head.appendChild(el('span', 'name', String(employee.name || id)))
  head.appendChild(el('span', 'llm-status', llmActiveLabel(employee)))
  var toggle = el('button', 'ghost', state.llmOpen[id] === true ? '收起' : '配置')
  toggle.onclick = function () {
    state.llmOpen[id] = state.llmOpen[id] !== true
    if (state.llmOpen[id] === true) loadLlmDetail(id)
    renderLlmConfig()
  }
  head.appendChild(toggle)
  row.appendChild(head)

  if (state.llmOpen[id] !== true) return row

  var detail = state.llmDetail[id]
  var editor = el('div', 'llm-editor')
  editor.appendChild(el('div', 'muted', permissionLine(id)))
  if (canManage) editor.appendChild(buildAutoApproveRow(employee, canManage))
  if (detail === undefined) {
    editor.appendChild(el('div', 'muted', '正在读配置…'))
    row.appendChild(editor)
    return row
  }

  /* 旧节点（还没升级）回的是"一个员工一条端点"的老形状：**如实显示它**，
     而不是硬套新界面显示成"还没配过"（那会把人误导成"配置丢了"）。 */
  if (Array.isArray(detail.models) !== true && typeof detail.model === 'string') {
    editor.appendChild(
      el(
        'div',
        'muted',
        '这台节点还是旧版本：' +
          String(detail.model) +
          ' @ ' +
          hostOf(detail.apiUrl) +
          '（' +
          String(detail.keyMask || '无 key') +
          '）。升级该节点后，这里就能挂多条模型并随时切换。',
      ),
    )
    if (canManage) {
      var upgradeHint = el('div', 'row')
      var goHealth = el('button', 'ghost', '去「体检」页升级这台节点')
      goHealth.onclick = function () {
        setView('health')
      }
      upgradeHint.appendChild(goHealth)
      editor.appendChild(upgradeHint)
    }
    row.appendChild(editor)
    return row
  }

  var models = pickArray(detail, ['models'])
  if (models.length === 0) {
    editor.appendChild(el('div', 'muted', '还没有配过模型 —— 下面加一条。'))
  } else {
    models.forEach(function (item) {
      editor.appendChild(buildModelRow(id, item, canManage))
    })
  }
  editor.appendChild(buildAddModelForm(id, canManage))
  if (canManage && models.length > 0) {
    var clearRow = el('div', 'row')
    var wipe = el('button', 'ghost danger', '清空该员工全部模型配置')
    wipe.onclick = function () {
      if (window.confirm('清空「' + String(employee.name || id) + '」的全部模型配置？dsh 里的路由与凭据也会一起拆掉。') !== true) return
      wipe.disabled = true
      rpc('employee.llm.unset', { employeeId: id }, { idempotencyKey: randomId() })
        .then(function () {
          toast('已清空（新会话回落节点默认模型）', 'warn')
          loadLlmDetail(id)
          loadEmployees()
        })
        .catch(function (error) {
          wipe.disabled = false
          reportRpcError('employee.llm.unset', error)
        })
    }
    clearRow.appendChild(wipe)
    editor.appendChild(clearRow)
  }
  row.appendChild(editor)
  return row
}

/** 一条模型：别名 / 模型@端点 / 当前标记 / 三个动作。 */
function buildModelRow(employeeId, item, canManage) {
  var modelId = String(item.id || '')
  var row = el('div', 'row')
  row.appendChild(el('strong', '', String(item.name || modelId)))
  row.appendChild(el('span', 'llm-status', String(item.model || '') + ' @ ' + endpointLabel(String(item.endpointId || ''))))
  if (item.active === true) row.appendChild(el('span', 'chip', '当前'))
  else if (item.wired !== true) row.appendChild(el('span', 'chip', '未接线'))
  row.appendChild(el('span', 'muted', hostOf(item.apiUrl) + ' · ' + String(item.keyMask || '无 key')))

  if (canManage) {
    if (item.active !== true) {
      var use = el('button', 'ghost', '设为当前')
      use.onclick = function () {
        use.disabled = true
        activateModel(employeeId, modelId, use)
      }
      row.appendChild(use)
    }
    if (String(item.endpointId || '') === '') {
      /* 迁移来的老配置：BaseURL 与 Key 只在这台机器上。收进库要**把密钥上行给 Hub 一次**，
         所以做成一次明确点击，并说清会发生什么。 */
      var promote = el('button', 'ghost', '收进端点库')
      promote.onclick = function () {
        var name = window.prompt('收进端点库：给这条端点起个名字（如 noelle）', String(item.name || ''))
        if (name === null) return
        promote.disabled = true
        rpc(
          'employee.llm.promote',
          { employeeId: employeeId, id: modelId, endpointName: String(name).trim() },
          { idempotencyKey: randomId() },
        )
          .then(function (payload) {
            var linked = payload !== null && typeof payload === 'object' && payload.linked === true
            var note = payload !== null && typeof payload === 'object' ? String(payload.note || '') : ''
            if (linked) toast('已收进端点库：' + String(name).trim(), 'ok')
            else toast('端点已入库，但这个员工还没指过去：' + note, 'warn')
            loadLlmEndpoints()
            loadLlmDetail(employeeId)
          })
          .catch(function (error) {
            promote.disabled = false
            reportRpcError('employee.llm.promote', error)
          })
      }
      row.appendChild(promote)
    }
    var edit = el('button', 'ghost', '改别名')
    edit.onclick = function () {
      var next = window.prompt('新的别名（只改名字，不影响会话与路由）', String(item.name || ''))
      if (next === null) return
      saveModel(employeeId, { id: modelId, name: String(next).trim(), endpointId: String(item.endpointId || ''), model: String(item.model || '') }, false)
    }
    row.appendChild(edit)
    var remove = el('button', 'ghost danger', '删除')
    remove.onclick = function () {
      if (window.confirm('删除「' + String(item.name || modelId) + '」？它在 dsh 里的路由与凭据会一起拆掉。') !== true) return
      remove.disabled = true
      rpc('employee.llm.remove', { employeeId: employeeId, id: modelId }, { idempotencyKey: randomId() })
        .then(function () {
          toast('已删除', 'ok')
          loadLlmDetail(employeeId)
          loadEmployees()
        })
        .catch(function (error) {
          remove.disabled = false
          reportRpcError('employee.llm.remove', error)
        })
    }
    row.appendChild(remove)
  }
  return row
}

/** 「加一条模型」：别名手填、端点从库里选、模型从该端点的清单里选（也允许手填）。 */
function buildAddModelForm(employeeId, canManage) {
  var form = el('div', 'row')
  var aliasInput = el('input', '')
  aliasInput.type = 'text'
  aliasInput.placeholder = '别名（自己起，如 gpt5.6-noelle）'
  form.appendChild(aliasInput)

  var select = el('select', '')
  state.llmEndpoints.forEach(function (entry) {
    var option = el('option', '', String(entry.name || entry.id))
    option.value = String(entry.id || '')
    select.appendChild(option)
  })
  form.appendChild(select)

  var modelInput = el('input', '')
  modelInput.type = 'text'
  modelInput.setAttribute('list', 'llm-endpoint-models-' + employeeId)
  modelInput.placeholder = '模型 id（如 gpt5.6）'
  form.appendChild(modelInput)
  var dataList = el('datalist', '')
  dataList.id = 'llm-endpoint-models-' + employeeId
  ;(endpointModelsOf(String(select.value || '')) || []).forEach(function (modelId) {
    var option = el('option', '', modelId)
    option.value = modelId
    dataList.appendChild(option)
  })
  form.appendChild(dataList)
  select.onchange = function () {
    paintModelOptions(dataList, endpointModelsOf(String(select.value || '')))
  }

  if (state.llmEndpoints.length === 0) {
    form.appendChild(el('span', 'muted', '（先在端点库里加一条端点）'))
  }

  var save = el('button', 'primary', '保存')
  var saveActive = el('button', 'primary', '保存并设为当前')
  save.disabled = !canManage || state.llmEndpoints.length === 0
  saveActive.disabled = save.disabled
  var submit = function (activate, button) {
    var name = String(aliasInput.value || '').trim()
    var model = String(modelInput.value || '').trim()
    var endpointId = String(select.value || '')
    if (name === '' || model === '' || endpointId === '') {
      toast('别名、端点、模型 id 三个都要填', 'warn')
      return
    }
    button.disabled = true
    saveModel(employeeId, { name: name, endpointId: endpointId, model: model }, activate)
  }
  save.onclick = function () {
    submit(false, save)
  }
  saveActive.onclick = function () {
    submit(true, saveActive)
  }
  form.appendChild(save)
  form.appendChild(saveActive)
  if (!canManage) form.appendChild(el('span', 'muted', '需要 employee.manage scope'))
  return form
}

/** 某个端点候选的模型清单：优先用刚探测到的，其次用库里存的那份。 */
function endpointModelsOf(endpointId) {
  var probed = state.llmProbeModels[endpointId]
  if (Array.isArray(probed) && probed.length > 0) return probed
  var entry = endpointById(endpointId)
  return entry !== undefined && Array.isArray(entry.models) ? entry.models : []
}

function paintModelOptions(dataList, models) {
  if (dataList === null) return
  clear(dataList)
  ;(models || []).forEach(function (modelId) {
    var option = el('option', '', modelId)
    option.value = modelId
    dataList.appendChild(option)
  })
}

function loadLlmDetail(employeeId) {
  delete state.llmDetail[employeeId]
  renderLlmConfig()
  loadPermissionPreset(employeeId)
  rpc('employee.llm.get', { employeeId: employeeId })
    .then(function (payload) {
      state.llmDetail[employeeId] = payload
      renderLlmConfig()
    })
    .catch(function (error) {
      reportRpcError('employee.llm.get', error)
    })
}

function saveModel(employeeId, params, activate) {
  var body = { employeeId: employeeId, name: params.name, endpointId: params.endpointId, model: params.model }
  if (params.id !== undefined) body.id = params.id
  if (activate === true) body.activate = true
  rpc('employee.llm.save', body, { idempotencyKey: randomId() })
    .then(function () {
      toast(activate === true ? '已保存并设为当前' : '已保存', 'ok')
      loadLlmDetail(employeeId)
      loadEmployees()
      if (activate === true) activateCurrentSessionIfOpen(employeeId, '') // 设为当前顺手切会话（见下方注释）
    })
    .catch(function (error) {
      reportRpcError('employee.llm.save', error)
    })
}

/**
 * 把某条模型设为当前。**带上"这个员工正在看的那个会话"**——
 * "光改配置不切会话"正是真实事故的形状：界面上明明配好了新 key，
 * 而那个旧会话照旧用一个已经没余额的旧 key，天天 402。
 * 正在跑回合时节点会拒绝并说明原因，这里如实转述。
 */
function activateModel(employeeId, modelId, button) {
  var params = { employeeId: employeeId, id: modelId }
  var sessionId = currentSessionOf(employeeId)
  if (sessionId !== '') params.sessionId = sessionId
  rpc('employee.llm.activate', params, { idempotencyKey: randomId() })
    .then(function (payload) {
      var switched = payload !== null && typeof payload === 'object' && payload.sessionSwitched === true
      var note = payload !== null && typeof payload === 'object' ? String(payload.sessionNote || '') : ''
      if (note !== '' && switched !== true) toast('已设为当前；会话没切：' + note, 'warn')
      else toast(switched === true ? '已设为当前，并把当前会话一起切过去了' : '已设为当前', 'ok')
      loadLlmDetail(employeeId)
      loadEmployees()
      if (button) button.disabled = false
    })
    .catch(function (error) {
      if (button) button.disabled = false
      reportRpcError('employee.llm.activate', error)
    })
}

/** 这个员工此刻在控制台里打开着的会话（不是它就不切 —— 别去改别人正在看的对话）。 */
function currentSessionOf(employeeId) {
  if (String(state.selectedEmployeeId || '') !== employeeId) return ''
  return typeof state.selectedSessionId === 'string' ? state.selectedSessionId : ''
}

/** 保存并设为当前时，若那个会话正开着，也顺手切过去（与「设为当前」同一语义）。 */
function activateCurrentSessionIfOpen(employeeId) {
  var sessionId = currentSessionOf(employeeId)
  if (sessionId === '') return
  var detail = state.llmDetail[employeeId]
  var active = pickArray(detail, ['models']).filter(function (item) {
    return item !== null && typeof item === 'object' && item.active === true
  })[0]
  if (active === undefined) return
  activateModel(employeeId, String(active.id || ''), null)
}

/** 新建员工表单里的节点下拉：node.list 只需 employee.read，失败时留提示不阻塞页面。 */
function loadNodeOptions() {
  var select = $('createNode')
  if (select === null || state.phase !== 'ready') return
  rpc('node.list', {})
    .then(function (payload) {
      var nodes = pickArray(payload, ['nodes', 'items', 'list'])
      clear(select)
      if (nodes.length === 0) {
        select.appendChild(el('option', '', '（暂无在线节点）'))
        renderCreatePreview()
        return
      }
      nodes.forEach(function (node) {
        var option = el('option', '', String(node.name || node.nodeId || '?') + (node.online === false ? '（离线）' : ''))
        option.value = String(node.nodeId || '')
        select.appendChild(option)
      })
      renderCreatePreview()
    })
    .catch(function (error) {
      reportRpcError('node.list', error)
    })
}

/* ─────────────────── 体检 ─────────────────── */

/**
 * 体检：把三类「不报错的分叉」摆到台面上。
 *
 *   1. 控制台脚本指纹 vs 服务端印在页面上的指纹 —— 不一致 = 本页跑的是被缓存冻住的
 *      旧脚本（手机上"和电脑不一样"的经典成因，见 docs/05 §13.5）；
 *   2. Hub 与各节点的**代码指纹** —— 不一致 = 那台机器跑的是旧代码。节点是手动升级的，
 *      跑旧代码时界面上一模一样（照常在线、照常列员工），只有这个字段能戳破它；
 *   3. 员工工作区缺 .git 锚点 —— dsh 的 projectRoot 会落到外层仓库，该员工写在
 *      .dsh/skills 里的私有技能**被静默忽略**（写了也不生效）。
 *
 * 数据来源：node.list（Hub 现算的版本比对）+ 本地已缓存的员工目录（employee.list）。
 * 只在卡片展开时拉取，不给后端添常态负担。
 *
 * 注意：本段是 CONTROL_UI_SCRIPT 模板的一部分，**注释里也不能出现反引号或美元花括号**
 * —— 它们会提前终止 String.raw 模板（这里真踩过：tsc 报的是 "',' expected" +
 * 一大段源码，很难一眼看出是注释里的反引号干的）。
 */
/* ─────────────────── 定时任务 ───────────────────
 *
 * 语义与 Hub 侧严格对齐（见 src/hub/scheduler.ts）：
 *   · 只显示**派发结果**（已送出 / 排队中 / 失败），不冒充"任务成功"—— Hub 不解析
 *     会话事件，员工的回复在被调员工的会话里，这里不编造。
 *   · 停用如实显示原因（自动停用会说"连续失败 N 次"），不做静默停用。
 *   · 「立即运行」不动时间表：否则"点一下试试"会把节奏整体推后，用户以为改了间隔。
 */

/** 间隔的人话：优先"分钟"，够整就升到小时/天。 */`
