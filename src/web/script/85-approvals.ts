/**
 * 控制台脚本片段：审批页
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
export const CHUNK_85_APPROVALS = String.raw`
/* ─────────────────── 10. 审批 ─────────────────── */

function employeeNameOf(employeeId) {
  if (typeof employeeId !== 'string' || employeeId === '') return '（未知）'
  var name = state.employeeNames.get(employeeId)
  if (typeof name === 'string' && name !== '') return name
  return shortId(employeeId)
}

function approvalSummaryText(approval) {
  if (approval === null || typeof approval !== 'object') return '（无详情）'
  if (approval.kind === 'dsh.approval') {
    return employeeNameOf(approval.employeeId) + ' 请求批准执行「' + String(approval.toolName || '（未提供动作名）') + '」'
  }
  if (approval.kind === 'dsh.question') {
    var count = Array.isArray(approval.questions) ? approval.questions.length : 0
    return employeeNameOf(approval.employeeId) + ' 有问题要问你' + (count > 0 ? '（' + String(count) + ' 个）' : '')
  }
  var from = String(approval.fromEmployeeName || employeeNameOf(approval.fromEmployeeId))
  var to = String(approval.toEmployeeName || employeeNameOf(approval.toEmployeeId))
  return from + ' → ' + to + '：' + String(approval.task || '').slice(0, 120)
}

/** 审批类别 → 给人看的中文标签（卡片左上角那枚）。 */
function approvalKindLabel(kind) {
  if (kind === 'dsh.approval') return '员工审批'
  if (kind === 'dsh.question') return '员工提问'
  if (kind === 'employee.invoke') return '员工互调'
  return String(kind || 'approval')
}

function approvalStatusLabel(status) {
  if (status === 'pending') return '待处理'
  if (status === 'approved') return '已批准'
  if (status === 'denied') return '已拒绝'
  if (status === 'expired') return '已过期'
  if (status === 'cancelled') return '已取消'
  if (status === 'answered') return '已回答'
  return String(status || '未知状态')
}

function approvalStatusClass(status) {
  if (status === 'pending') return 'warn'
  if (status === 'approved' || status === 'answered') return 'ok'
  if (status === 'denied' || status === 'expired') return 'bad'
  return 'off'
}

function approvalEmployeeId(approval) {
  if (approval === null || typeof approval !== 'object') return ''
  if (approval.kind === 'employee.invoke') return String(approval.fromEmployeeId || '')
  return String(approval.employeeId || '')
}

function approvalEmployeeOf(approval) {
  var id = approvalEmployeeId(approval)
  for (var i = 0; i < state.employees.length; i += 1) {
    var employee = state.employees[i]
    if (String(employee.id || '') === id) return employee
  }
  var fallbackName = ''
  if (approval !== null && typeof approval === 'object') {
    fallbackName = String(approval.fromEmployeeName || '')
  }
  return {
    id: id === '' ? 'approval-' + String(approval && approval.approvalId ? approval.approvalId : 'unknown') : id,
    name: fallbackName !== '' ? fallbackName : employeeNameOf(id),
    role: '',
    position: '',
    available: false,
    nodeOnline: false,
    hasAvatar: false
  }
}

function approvalEmployeeStatus(employee) {
  var badge = availabilityBadge(employee)
  var role = String(employee.role || '').trim()
  var position = positionName(employee.position)
  if (role === '' || role === '（未填写岗位说明）') role = position
  if (role === '') role = '数字员工'
  return role + ' · ' + badge.text
}

function approvalTimestamp(approval, history) {
  var primary = history === true ? Number(approval.resolvedAtMs) : Number(approval.requestedAtMs)
  if (Number.isFinite(primary) && primary > 0) return primary
  var fallback = Number(approval.requestedAtMs)
  return Number.isFinite(fallback) && fallback > 0 ? fallback : Date.now()
}

function approvalRelativeTime(ms) {
  var delta = Date.now() - ms
  if (delta < 60 * 1000) return '刚刚'
  if (delta < 60 * 60 * 1000) return String(Math.max(1, Math.floor(delta / (60 * 1000)))) + ' 分钟前'
  if (delta < 24 * 60 * 60 * 1000) return String(Math.max(1, Math.floor(delta / (60 * 60 * 1000)))) + ' 小时前'
  if (delta < 7 * 24 * 60 * 60 * 1000) return String(Math.max(1, Math.floor(delta / (24 * 60 * 60 * 1000)))) + ' 天前'
  return new Date(ms).toLocaleDateString()
}

function approvalKey(approval, index) {
  var id = String(approval && approval.approvalId ? approval.approvalId : '')
  return id === '' ? 'approval-' + String(index) : id
}

function approvalQueueTitle(approval) {
  if (approval === null || typeof approval !== 'object') return '（无详情）'
  if (approval.kind === 'dsh.approval') return '申请执行：' + String(approval.toolName || '（未提供动作名）')
  if (approval.kind === 'dsh.question') {
    var count = Array.isArray(approval.questions) ? approval.questions.length : 0
    return '有问题要问你' + (count > 0 ? '（' + String(count) + ' 个）' : '')
  }
  if (approval.kind === 'employee.invoke') {
    return '请求交给 ' + String(approval.toEmployeeName || employeeNameOf(approval.toEmployeeId)) + ' 执行'
  }
  return approvalSummaryText(approval)
}

function approvalDetailTitle(approval) {
  if (approval === null || typeof approval !== 'object') return '审批请求'
  if (approval.kind === 'dsh.approval') return '申请执行：' + String(approval.toolName || '（未提供动作名）')
  if (approval.kind === 'dsh.question') {
    var count = Array.isArray(approval.questions) ? approval.questions.length : 0
    return '有问题要问你' + (count > 0 ? '（' + String(count) + ' 个）' : '')
  }
  if (approval.kind === 'employee.invoke') {
    return '请求把任务交给 ' + String(approval.toEmployeeName || employeeNameOf(approval.toEmployeeId))
  }
  return approvalSummaryText(approval)
}

function approvalItems(history) {
  var items = []
  state.approvals.forEach(function (approval) {
    var isHistory = approval.status !== 'pending'
    if (isHistory === history) items.push(approval)
  })
  items.sort(function (left, right) {
    return approvalTimestamp(right, history) - approvalTimestamp(left, history)
  })
  return items.slice(0, 40)
}

function approvalAvatar(approval, size) {
  var employee = approvalEmployeeOf(approval)
  var box = avatarNode(employee, size)
  box.classList.add('approval-avatar')
  ensureAvatar(employee)
  return box
}

function approvalDetailPerson(detail, approval, history) {
  var employee = approvalEmployeeOf(approval)
  var row = el('div', 'approval-person')
  row.appendChild(approvalAvatar(approval, 56))
  var copy = el('div', 'approval-person-copy')
  copy.appendChild(el('strong', '', String(employee.name || employeeNameOf(approvalEmployeeId(approval)))))
  copy.appendChild(el('span', '', approvalEmployeeStatus(employee)))
  row.appendChild(copy)
  row.appendChild(el('span', 'approval-time', new Date(approvalTimestamp(approval, history)).toLocaleString()))
  detail.appendChild(row)
}

function renderApprovalQueue(list, approvals, selectedId, history) {
  clear(list)
  if (approvals.length === 0) {
    var empty = el('li', 'approval-empty')
    empty.appendChild(el('strong', '', history ? '还没有处理记录' : '现在没有需要你处理的请求'))
    empty.appendChild(el('span', '', history ? '员工请求完成后，会在这里留下记录。' : '员工遇到需要确认的事情时，会来这里找你。'))
    list.appendChild(empty)
    return
  }
  approvals.forEach(function (approval, index) {
    var key = approvalKey(approval, index)
    var item = el('li', 'approval-item')
    var button = el('button', 'approval-item-button' + (key === selectedId ? ' active' : ''))
    button.type = 'button'
    if (key === selectedId) button.setAttribute('aria-current', 'true')
    else button.removeAttribute('aria-current')
    button.setAttribute('data-approval-key', key)
    button.appendChild(approvalAvatar(approval, 44))
    var copy = el('span', 'approval-item-copy')
    var top = el('span', 'approval-item-top')
    var employee = approvalEmployeeOf(approval)
    top.appendChild(el('strong', '', String(employee.name || '（未知）')))
    top.appendChild(el('span', 'approval-item-kind', approvalKindLabel(approval.kind)))
    copy.appendChild(top)
    copy.appendChild(el('span', 'approval-item-title', approvalQueueTitle(approval)))
    var meta = el('span', 'approval-item-meta')
    meta.appendChild(el('span', '', approvalRelativeTime(approvalTimestamp(approval, history))))
    meta.appendChild(el('span', 'approval-status ' + (approval.status === 'pending' ? '' : 'approval-status-done'), approvalStatusLabel(approval.status)))
    copy.appendChild(meta)
    button.appendChild(copy)
    button.onclick = function () {
      state.selectedApprovalId = key
      renderApprovals()
    }
    item.appendChild(button)
    list.appendChild(item)
  })
}

function appendApprovalRequestBox(detail, label, value) {
  var box = el('div', 'approval-request-box')
  box.appendChild(el('div', 'approval-request-label', label))
  box.appendChild(el('div', 'approval-request-value', value))
  detail.appendChild(box)
}

function appendApprovalMeta(detail, label, value) {
  if (value === undefined || value === null || String(value) === '') return
  var line = el('div', 'approval-meta-line')
  line.appendChild(el('span', 'approval-meta-label', label))
  line.appendChild(el('span', 'approval-meta-value', value))
  detail.appendChild(line)
}

function renderApprovalHistoryBody(detail, approval) {
  if (approval.kind === 'dsh.approval') {
    appendApprovalRequestBox(detail, '请求操作', String(approval.toolName || '（未提供动作名）'))
  }
  if (approval.kind === 'employee.invoke' && String(approval.task || '') !== '') {
    var task = el('pre', 'approval-task')
    task.textContent = String(approval.task)
    detail.appendChild(task)
  }
  if (approval.reason !== undefined && String(approval.reason) !== '') {
    var reason = el('p', 'approval-reason')
    reason.appendChild(el('strong', '', '员工说明：'))
    reason.appendChild(document.createTextNode(String(approval.reason)))
    detail.appendChild(reason)
  }
  appendApprovalMeta(detail, '请求 ID', String(approval.approvalId || ''))
  appendApprovalMeta(detail, '命中规则', approval.matchedRuleId)
  appendApprovalMeta(detail, '处理结果', approvalStatusLabel(approval.status))
  if (approval.resolutionNote !== undefined && String(approval.resolutionNote) !== '') {
    var note = el('p', 'approval-history-note')
    note.appendChild(el('strong', '', '处理备注：'))
    note.appendChild(document.createTextNode(String(approval.resolutionNote)))
    detail.appendChild(note)
  }
}

function renderApprovalDetail(detail, approval, history) {
  clear(detail)
  if (approval === null) {
    var empty = el('div', 'approval-detail-empty')
    empty.appendChild(el('strong', '', history ? '还没有处理记录' : '暂时没有需要你决定的事情'))
    empty.appendChild(el('span', '', history ? '员工请求完成后，会在这里留下记录。' : '员工遇到需要确认的事情时，会来这里找你。'))
    detail.appendChild(empty)
    return
  }
  var top = el('div', 'approval-detail-top')
  top.appendChild(el('strong', '', approvalKindLabel(approval.kind)))
  top.appendChild(el('span', 'badge ' + approvalStatusClass(approval.status), approvalStatusLabel(approval.status)))
  detail.appendChild(top)
  approvalDetailPerson(detail, approval, history)
  detail.appendChild(el('h3', 'approval-detail-title', approvalDetailTitle(approval)))

  if (history) {
    renderApprovalHistoryBody(detail, approval)
    return
  }

  if (approval.kind === 'dsh.approval') {
    appendApprovalRequestBox(detail, '请求操作', String(approval.toolName || '（未提供动作名）'))
    if (approval.reason !== undefined && String(approval.reason) !== '') {
      var reason = el('p', 'approval-reason')
      reason.appendChild(el('strong', '', '员工说明：'))
      reason.appendChild(document.createTextNode(String(approval.reason)))
      detail.appendChild(reason)
    }
    appendApprovalMeta(detail, '会话', shortId(approval.sessionId || ''))
    renderApprovalButtons(detail, approval)
    return
  }
  if (approval.kind === 'dsh.question') {
    renderQuestionCard(detail, approval)
    return
  }
  if (approval.kind === 'employee.invoke') {
    var task = el('pre', 'approval-task')
    task.textContent = String(approval.task || '（未提供任务内容）')
    detail.appendChild(task)
    appendApprovalMeta(detail, '命中规则', approval.matchedRuleId)
    renderApprovalButtons(detail, approval)
    return
  }
  renderApprovalButtons(detail, approval)
}

function setApprovalView(view) {
  state.approvalView = view === 'history' ? 'history' : 'pending'
  state.selectedApprovalId = null
  renderApprovals()
}

function loadApprovals() {
  if (state.phase !== 'ready') return Promise.resolve([])
  return rpc('approval.list', {})
    .then(function (payload) {
      state.approvals = pickArray(payload, ['approvals', 'items', 'pending']).filter(function (item) {
        return item !== null && typeof item === 'object'
      })
      renderApprovals()
      return state.approvals
    })
    .catch(function (error) {
      reportRpcError('approval.list', error)
      return []
    })
}

function renderApprovals() {
  var pendingList = $('approvalList')
  var historyList = $('approvalHistoryList')
  if (pendingList === null || historyList === null) return
  /* 宽屏右栏也列着"这个员工的未决审批"，它读的是同一份 state.approvals ——
     所以在这里顺手重绘一次，保证审批数据变动后右栏也跟着更新。 */
  renderEmployeeAside()
  /* 四宫格右上那格读的也是这一份（同一个 appendApprovalBlock）：一处变动、几处同步。
     少了这一行，行内裁决完按钮还留在屏幕上，用户会以为没批成功。 */
  renderQuadCells()

  var pending = approvalItems(false)
  var history = approvalItems(true)
  var pendingCount = $('approvalCount')
  if (pendingCount !== null) pendingCount.textContent = pending.length > 0 ? String(pending.length) : ''
  var innerPendingCount = $('approvalPendingCount')
  if (innerPendingCount !== null) innerPendingCount.textContent = String(pending.length)
  var innerHistoryCount = $('approvalHistoryCount')
  if (innerHistoryCount !== null) innerHistoryCount.textContent = String(history.length)
  var summary = $('approvalPendingSummary')
  if (summary !== null) summary.textContent = pending.length > 0 ? '待你处理 ' + String(pending.length) + ' 项' : '当前没有待处理请求'

  var activeItems = state.approvalView === 'history' ? history : pending
  var selected = null
  if (state.selectedApprovalId !== null) {
    for (var i = 0; i < activeItems.length; i += 1) {
      if (approvalKey(activeItems[i], i) === state.selectedApprovalId) {
        selected = activeItems[i]
        break
      }
    }
  }
  if (selected === null && activeItems.length > 0) {
    selected = activeItems[0]
    state.selectedApprovalId = approvalKey(selected, 0)
  }
  if (activeItems.length === 0) state.selectedApprovalId = null

  renderApprovalQueue(pendingList, pending, state.approvalView === 'pending' && selected !== null ? state.selectedApprovalId : null, false)
  renderApprovalQueue(historyList, history, state.approvalView === 'history' && selected !== null ? state.selectedApprovalId : null, true)

  var pendingTab = $('approvalTabPending')
  var historyTab = $('approvalTabHistory')
  var pendingPanel = $('approvalPendingPanel')
  var historyPanel = $('approvalHistoryPanel')
  var showingPending = state.approvalView !== 'history'
  if (pendingTab !== null) {
    pendingTab.classList.toggle('active', showingPending)
    pendingTab.setAttribute('aria-selected', showingPending ? 'true' : 'false')
  }
  if (historyTab !== null) {
    historyTab.classList.toggle('active', !showingPending)
    historyTab.setAttribute('aria-selected', showingPending ? 'false' : 'true')
  }
  if (pendingPanel !== null) pendingPanel.classList.toggle('hidden', !showingPending)
  if (historyPanel !== null) historyPanel.classList.toggle('hidden', showingPending)

  var pendingDetail = $('approvalDetail')
  var historyDetail = $('approvalHistoryDetail')
  if (pendingDetail !== null) renderApprovalDetail(pendingDetail, showingPending ? selected : null, false)
  if (historyDetail !== null) renderApprovalDetail(historyDetail, showingPending ? null : selected, true)
}

/** 批准 / 拒绝按钮（互调与 dsh 审批共用）。 */
function renderApprovalButtons(item, approval) {
  var actions = el('div', 'approval-actions')
  var noteInput = el('input', 'note approval-note')
  noteInput.type = 'text'
  noteInput.placeholder = '裁决备注（可选，≤500 字）'
  actions.appendChild(noteInput)
  var row = el('div', 'row approval-action-row')
  var approveButton = el('button', 'primary', approval.kind === 'dsh.approval' ? '批准执行' : '批准')
  var denyButton = el('button', 'danger', '拒绝')
  var detailId = String(approval.approvalId || '')
  /* 与四宫格内联按钮同一套记号：提交期间按 id 锁住（防连点） */
  approveButton.setAttribute('data-approval-id', detailId)
  denyButton.setAttribute('data-approval-id', detailId)
  if (state.canResolve !== true) {
    approveButton.disabled = true
    denyButton.disabled = true
  }
  approveButton.onclick = function () {
    resolveApproval(detailId, true, String(noteInput.value || '').trim())
  }
  denyButton.onclick = function () {
    resolveApproval(detailId, false, String(noteInput.value || '').trim())
  }
  row.appendChild(denyButton)
  row.appendChild(approveButton)
  actions.appendChild(row)
  if (state.canResolve !== true) actions.appendChild(el('div', 'warn', '需要 approval.resolve scope 才能裁决'))
  item.appendChild(actions)
}

/**
 * 提问卡片：把 dsh 的 AskUserQuestionItem[] 渲染成可提交的答案。
 *
 * 形状来自 dsh 的 dsh-user-questions/types（本文件是 String.raw 模板，
 * 注释里不能出现反引号）：
 *   question = { id, question, detail?, header?, options?:[{label, description?}], multiSelect?, intent? }
 *   答案     = { answers: [{ id, selected: string[], custom? }] }
 * Hub 不解释这份结构，原样回填给 dsh —— 所以这里的映射必须逐字对齐上面的定义。
 */
function renderQuestionCard(item, approval) {
  var questions = Array.isArray(approval.questions) ? approval.questions : []
  if (questions.length === 0) {
    item.appendChild(el('div', 'warn', '这条提问没有携带问题内容（dsh 侧形状变了？）'))
    return
  }
  var inputs = []
  var questionBox = el('div', 'approval-question-box')
  questions.forEach(function (question) {
    if (question === null || typeof question !== 'object') return
    var box = el('div', 'question')
    if (typeof question.header === 'string' && question.header !== '') box.appendChild(el('div', 'question-header', question.header))
    box.appendChild(el('div', 'question-text', String(question.question || '（空问题）')))
    if (typeof question.detail === 'string' && question.detail !== '') box.appendChild(el('div', 'question-detail', question.detail))

    var multi = question.multiSelect === true
    var controls = []
    var options = Array.isArray(question.options) ? question.options : []
    options.forEach(function (option) {
      if (option === null || typeof option !== 'object') return
      var label = String(option.label || '')
      if (label === '') return
      var line = el('label', 'question-option')
      var input = el('input')
      input.type = multi ? 'checkbox' : 'radio'
      input.name = 'q-' + String(approval.approvalId || '') + '-' + String(question.id || '')
      input.value = label
      line.appendChild(input)
      line.appendChild(el('span', 'question-option-label', label))
      if (typeof option.description === 'string' && option.description !== '') {
        line.appendChild(el('span', 'question-option-desc', option.description))
      }
      box.appendChild(line)
      controls.push(input)
    })
    var custom = el('input', 'question-custom')
    custom.type = 'text'
    custom.placeholder = options.length > 0 ? '其它（可选）' : '你的回答'
    box.appendChild(custom)
    questionBox.appendChild(box)
    inputs.push({ id: String(question.id || ''), multi: multi, controls: controls, custom: custom })
  })
  item.appendChild(questionBox)

  var actions = el('div', 'approval-actions')
  var submit = el('button', 'primary', '提交回答')
  if (state.canResolve !== true) submit.disabled = true
  submit.onclick = function () {
    var answers = []
    var missing = 0
    inputs.forEach(function (entry) {
      var selected = []
      entry.controls.forEach(function (control) {
        if (control.checked) selected.push(control.value)
      })
      var text = String(entry.custom.value || '').trim()
      if (selected.length === 0 && text === '') missing += 1
      var answer = { id: entry.id, selected: selected }
      if (text !== '') answer.custom = text
      answers.push(answer)
    })
    if (missing > 0) {
      setBanner('还有 ' + String(missing) + ' 个问题没有作答', 'bad')
      return
    }
    answerQuestion(String(approval.approvalId || ''), { answers: answers })
  }
  actions.appendChild(submit)
  if (state.canResolve !== true) actions.appendChild(el('div', 'warn', '需要 approval.resolve scope 才能回答'))
  actions.classList.add('approval-question-actions')
  item.appendChild(actions)
}

function answerQuestion(approvalId, answer) {
  return rpc('dsh.question.answer', { approvalId: approvalId, answer: answer })
    .then(function (payload) {
      if (payload !== null && typeof payload === 'object' && payload.delivered === false) {
        toast('回答已记录，但回填 dsh 失败：' + String(payload.deliveryError || '未知原因'), 'bad')
      } else {
        toast('回答已送达员工', 'ok')
      }
      loadApprovals()
    })
    .catch(function (error) {
      reportRpcError('dsh.question.answer', error)
    })
}

/** 提交期间锁住这条审批的按钮（按 data-approval-id 找），失败时再放开。
 *
 *  只动**自己锁上的**那些（打 data-approval-locked 记号）：本来就被业务禁用的按钮
 *  （例如"提案与审批单不一致"时那个禁用的「通过」）不许被解锁顺手打开 —— 那等于
 *  一次失败的提交替你把一道闸门拆了。 */
function lockApprovalButtons(approvalId, label) {
  var nodes = document.querySelectorAll('button[data-approval-id]')
  for (var i = 0; i < nodes.length; i += 1) {
    if (String(nodes[i].getAttribute('data-approval-id') || '') !== approvalId) continue
    if (nodes[i].disabled === true) continue
    nodes[i].disabled = true
    nodes[i].setAttribute('data-approval-locked', '1')
    nodes[i].setAttribute('data-approval-label', String(nodes[i].textContent || ''))
    if (label !== undefined && label !== null) nodes[i].textContent = String(label)
  }
}

function unlockApprovalButtons(approvalId) {
  var nodes = document.querySelectorAll('button[data-approval-id]')
  for (var i = 0; i < nodes.length; i += 1) {
    if (String(nodes[i].getAttribute('data-approval-id') || '') !== approvalId) continue
    if (nodes[i].getAttribute('data-approval-locked') !== '1') continue
    nodes[i].removeAttribute('data-approval-locked')
    nodes[i].disabled = false
    var label = nodes[i].getAttribute('data-approval-label')
    if (label !== null) nodes[i].textContent = label
    nodes[i].removeAttribute('data-approval-label')
  }
}

/**
 * 裁决一个审批 —— 页面上"点一下就改变现实"的那个按钮。
 *
 * 三件事必须做到，且都有过代价：
 *
 * 1. **可选参数不设门槛**。note 是可选的：审批页传了第三个实参，四宫格内联按钮和
 *    应急卡片的"通过/拒绝"只传两个。旧实现写「if (note !== '') params.note = note.slice(0, 500)」，
 *    两个实参时 note 是 undefined，「undefined !== ''」成立 → undefined.slice 抛 TypeError，
 *    而且抛在 toast() 与 rpc() **之前**：没有提示、没有请求、连控制台都不报错。
 *    线上表现就是"渗透测试页面上点通过毫无反应"（页面上看着像没刷新，其实是没发出去）。
 *    所以先归一成字符串，再判空。
 *
 * 2. **不许静默失败**。整段包在 try/catch 里：抛了也要把话说明白，按钮点下去必须有反应。
 *
 * 3. **提交期间锁按钮**。连点的第二次会被服务端判成 already approved（红字），
 *    可第一次其实已经生效了 —— 比起让人怀疑"到底批没批"，不如如实显示"正在提交"。
 *
 * 另外：裁决记录成功 ≠ 卡点解除。hub 把 allowed-once 回填给 dsh 失败时会把这条标成
 * cancelled 并回 delivered:false，那时员工那一轮**仍在挂着**，报成"已批准"是骗人。
 */
function resolveApproval(approvalId, approve, note) {
  try {
    var target = String(approvalId === undefined || approvalId === null ? '' : approvalId)
    if (target === '') {
      toast('这条审批没有 id，裁决不了（页面数据可能过期了，刷新一下再试）', 'bad')
      return Promise.resolve(null)
    }
    var text = typeof note === 'string' ? note.trim() : ''
    var params = { approvalId: target, approve: approve === true }
    if (text !== '') params.note = text.slice(0, 500)
    lockApprovalButtons(target, '正在提交…')
    toast('正在提交裁决…', 'info')
    return rpc('approval.resolve', params)
      .then(function (payload) {
        pushRaw('approval.resolve 结果', payload)
        var deliveryFailed =
          payload !== null && typeof payload === 'object' && payload.delivered === false
        if (deliveryFailed) {
          /* 如实说：这条已经不在待办里了，但员工那边可能还卡着 */
          toast(
            '裁决已记录，但没能回填给员工：' +
              String(payload.deliveryError || '未知原因') +
              ' —— 他那一轮可能仍在等你，去聊天里看一眼。',
            'bad',
          )
        } else {
          toast('已' + (params.approve ? '批准' : '拒绝') + ' ' + shortId(target), params.approve ? 'ok' : 'warn')
        }
        return loadApprovals()
      })
      .catch(function (error) {
        unlockApprovalButtons(target)
        reportRpcError('approval.resolve', error)
        return null
      })
  } catch (error) {
    /* 这里以前是黑洞：异常发生在任何提示之前，页面上只表现为"按钮是坏的" */
    reportRpcError('approval.resolve', error)
    return Promise.resolve(null)
  }
}
`
