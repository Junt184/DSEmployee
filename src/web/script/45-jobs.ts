/**
 * 控制台脚本片段：任务页：表单、列表、执行状态
 *
 * 本段对应原文件的连续行区间，内容与原文件逐字节相同（拆分时用黄金基线比对过）。
 *
 * 为什么单独一个文件：这一段原来是 src/web/ui.ts 里那个 8k 行 String.raw 字符串的一部分 ——
 * 单文件没有边界，两个会话并行改会互相踩（真实撞过：edit 被"file changed"打断、提交时
 * 只能按 hunk 挑自己的改动）。拆分后每段各占一个文件，边界就是文件名。
 *
 * 拼接顺序 = 原来的物理顺序，由 ui.ts 里的 CONTROL_UI_SCRIPT 组装；**顺序不能动**：
 * 函数声明会提升，但顶层 var 的赋值不会（state、注册表这类必须在用它的代码之前）。
 */
export const CHUNK_45_JOBS = String.raw`
function formatInterval(ms) {
  var minutes = Math.round(Number(ms || 0) / 60000)
  if (minutes < 60) return String(minutes) + ' 分钟'
  var hours = minutes / 60
  if (hours < 24 && Math.round(hours * 10) % 10 === 0) return String(Math.round(hours)) + ' 小时'
  if (hours < 24) return String(hours.toFixed(1)) + ' 小时'
  var days = hours / 24
  return (Math.round(days * 10) % 10 === 0 ? String(Math.round(days)) : days.toFixed(1)) + ' 天'
}

/** 时刻的人话：多久之后 / 多久之前。 */
function formatWhen(atMs) {
  var at = Number(atMs || 0)
  if (at <= 0) return '—'
  var delta = at - Date.now()
  var abs = Math.abs(delta)
  var unit = '秒'
  var value = Math.round(abs / 1000)
  if (abs >= 86400000) {
    unit = '天'
    value = Math.round(abs / 86400000)
  } else if (abs >= 3600000) {
    unit = '小时'
    value = Math.round(abs / 3600000)
  } else if (abs >= 60000) {
    unit = '分钟'
    value = Math.round(abs / 60000)
  }
  return delta >= 0 ? String(value) + ' ' + unit + '后' : String(value) + ' ' + unit + '前'
}

/** 一条执行记录的人话。status 是**派发**结果，不是"任务成功"。 */
function describeRunStatus(status) {
  if (status === 'dispatched') return '已送出'
  if (status === 'queued-offline') return '已排队（机器不在线）'
  if (status === 'failed') return '派发失败'
  if (status === 'skipped') return '已跳过'
  return String(status || '')
}

var jobEditingId = null
/** empty = 等用户选任务；new = 编辑右侧的新建表单；edit = 编辑已存在任务。 */
var jobDetailMode = 'empty'

function jobById(jobId) {
  var wanted = String(jobId || '')
  for (var i = 0; i < state.jobs.length; i += 1) {
    if (String(state.jobs[i].jobId || '') === wanted) return state.jobs[i]
  }
  return null
}

function clearJobInputs() {
  var name = $('jobName')
  var prompt = $('jobPrompt')
  var interval = $('jobInterval')
  if (name !== null) name.value = ''
  if (prompt !== null) prompt.value = ''
  if (interval !== null) interval.value = '30'
}

function renderJobFormMeta() {
  var select = $('jobEmployee')
  if (select !== null) {
    var current = select.value
    clear(select)
    state.employees.forEach(function (employee) {
      var option = el('option', '', String(employee.name || employee.id))
      option.value = String(employee.id || '')
      select.appendChild(option)
    })
    if (current !== '') select.value = current
  }

  var title = $('jobFormTitle')
  var save = $('btnSaveJob')
  var hint = $('jobFormHint')
  var stateLabel = $('jobFormState')
  var editing = jobDetailMode === 'edit' && jobEditingId !== null
  var job = editing ? jobById(jobEditingId) : null

  if (title !== null) title.textContent = editing ? '编辑任务' : '新建任务'
  if (save !== null) save.textContent = editing ? '保存修改' : '创建任务'
  if (hint !== null) {
    hint.textContent = editing
      ? '修改后下一次运行会按新的间隔计算。'
      : '创建后不会立刻运行；想现在执行，请在任务列表点「立即运行」。'
  }
  if (stateLabel !== null) {
    stateLabel.className = 'job-form-state'
    if (job !== null && job.enabled === true) {
      stateLabel.className += ' on'
      stateLabel.textContent = job.nodeOnline === true ? '启用中' : '启用中 · 机器离线'
    } else if (job !== null) {
      stateLabel.className += ' off'
      stateLabel.textContent = '已停用'
    } else {
      stateLabel.textContent = ''
    }
  }
}

function renderJobDetail() {
  var form = $('jobForm')
  var empty = $('jobDetailEmpty')
  var showForm = jobDetailMode !== 'empty'
  if (form !== null) form.classList.toggle('hidden', !showForm)
  if (empty !== null) empty.classList.toggle('hidden', showForm)
  renderJobFormMeta()
}

function openNewJob() {
  jobEditingId = null
  jobDetailMode = 'new'
  clearJobInputs()
  renderJobs()
  renderJobDetail()
  var name = $('jobName')
  if (name !== null && typeof name.focus === 'function') name.focus()
}

function resetJobForm() {
  openNewJob()
}

function editJob(jobId) {
  var job = jobById(jobId)
  if (job === null) return
  jobEditingId = String(job.jobId)
  jobDetailMode = 'edit'
  var name = $('jobName')
  var prompt = $('jobPrompt')
  var interval = $('jobInterval')
  var select = $('jobEmployee')
  if (name !== null) name.value = String(job.name || '')
  if (prompt !== null) prompt.value = String(job.prompt || '')
  if (interval !== null) interval.value = String(Math.max(1, Math.round(Number(job.intervalMs || 0) / 60000)))
  if (select !== null && job.employeeId !== undefined) select.value = String(job.employeeId)
  renderJobs()
  renderJobDetail()
  var form = $('jobForm')
  if (form !== null && typeof form.scrollIntoView === 'function') form.scrollIntoView({ block: 'nearest' })
}

function saveJob() {
  var name = $('jobName')
  var prompt = $('jobPrompt')
  var interval = $('jobInterval')
  var select = $('jobEmployee')
  if (name === null || prompt === null || interval === null || select === null) return
  var trimmedName = String(name.value || '').trim()
  var trimmedPrompt = String(prompt.value || '').trim()
  var minutes = Number(interval.value || 0)
  if (trimmedName === '') {
    toast('给任务起个名字', 'warn')
    return
  }
  if (trimmedPrompt === '') {
    toast('指令不能为空', 'warn')
    return
  }
  if (!(minutes >= 1)) {
    toast('间隔至少 1 分钟', 'warn')
    return
  }
  if (select.value === '') {
    toast('先选一个员工（节点上线后才会出现在这里）', 'warn')
    return
  }
  var editingId = jobEditingId
  var params = {
    name: trimmedName,
    employeeId: select.value,
    prompt: trimmedPrompt,
    intervalMinutes: minutes
  }
  if (editingId !== null) params.jobId = editingId
  var button = $('btnSaveJob')
  if (button !== null) button.disabled = true
  rpc('job.upsert', params, { idempotencyKey: randomId() })
    .then(function () {
      toast(editingId === null ? '任务已创建' : '任务已更新', 'ok')
      if (editingId === null) {
        jobEditingId = null
        jobDetailMode = 'empty'
      } else {
        jobEditingId = editingId
        jobDetailMode = 'edit'
      }
      loadJobs()
    })
    .catch(function (error) {
      reportRpcError('job.upsert', error)
    })
    .then(function () {
      if (button !== null) button.disabled = false
    })
}

function renderJobSummary() {
  var enabled = 0
  var offline = 0
  var nextAt = 0
  state.jobs.forEach(function (job) {
    if (job.enabled !== true) return
    enabled += 1
    if (job.nodeOnline !== true) offline += 1
    var at = Number(job.nextRunAtMs || 0)
    if (at > 0 && (nextAt === 0 || at < nextAt)) nextAt = at
  })
  var chip = $('jobChip')
  if (chip !== null) chip.textContent = enabled === 0 ? '' : String(enabled) + ' 个启用'
  var enabledNode = $('jobEnabledSummary')
  var nextNode = $('jobNextSummary')
  var offlineNode = $('jobOfflineSummary')
  var hint = $('jobListHint')
  if (enabledNode !== null) enabledNode.textContent = String(enabled)
  if (nextNode !== null) nextNode.textContent = nextAt > 0 ? formatWhen(nextAt) : '暂无'
  if (offlineNode !== null) offlineNode.textContent = String(offline)
  if (hint !== null) hint.textContent = state.jobs.length === 0 ? '还没有任务' : String(state.jobs.length) + ' 个任务'
}

function loadJobs() {
  var box = $('jobList')
  if (box === null) return
  if (state.phase !== 'ready' || state.scopes.indexOf('employee.read') < 0) {
    clear(box)
    box.appendChild(el('div', 'job-empty', '（未连接：定时任务需要连上 Hub）'))
    state.jobs = []
    renderJobSummary()
    renderJobDetail()
    return
  }
  clear(box)
  box.appendChild(el('div', 'muted', '正在读取…'))
  rpc('job.list', {})
    .then(function (payload) {
      state.jobs = pickArray(payload, ['jobs', 'items', 'list'])
      if (jobDetailMode === 'edit' && jobById(jobEditingId) === null) {
        jobEditingId = null
        jobDetailMode = state.jobs.length === 0 ? 'new' : 'empty'
      }
      if (state.jobs.length === 0 && jobDetailMode === 'empty') jobDetailMode = 'new'
      renderJobs()
      renderJobDetail()
      return state.jobs
    })
    .catch(function (error) {
      reportRpcError('job.list', error)
      clear(box)
      box.appendChild(el('div', 'job-empty', '（读取失败：见顶部提示条）'))
      renderJobSummary()
    })
}

function stopJobRowClick(event) {
  if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation()
}

function renderJobs() {
  var box = $('jobList')
  if (box === null) return
  renderJobSummary()
  clear(box)
  if (state.jobs.length === 0) {
    var empty = el('div', 'job-empty')
    empty.appendChild(el('strong', '', '还没有定时任务'))
    empty.appendChild(el('span', '', '点击右侧「新建任务」，把一件事交给数字员工。'))
    box.appendChild(empty)
    return
  }
  var canManage = state.scopes.indexOf('employee.manage') >= 0
  state.jobs.forEach(function (job) {
    var jobId = String(job.jobId || '')
    var selected = jobDetailMode === 'edit' && jobEditingId === jobId
    var row = el('div', 'job-row' + (job.enabled === true ? '' : ' off') + (selected ? ' selected' : ''))
    row.setAttribute('role', 'button')
    row.setAttribute('tabindex', '0')
    row.onclick = function (event) {
      var target = event === null || event === undefined ? null : event.target
      if (target !== null && typeof target.closest === 'function' && target.closest('button, input, textarea, select, summary') !== null) return
      editJob(jobId)
    }
    row.onkeydown = function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        editJob(jobId)
      }
    }

    var top = el('div', 'job-row-top')
    var title = el('div', 'job-row-title')
    title.appendChild(el('span', 'job-status-dot ' + (job.enabled === true ? job.nodeOnline === true ? 'on' : 'warn' : 'off')))
    title.appendChild(el('strong', '', String(job.name || jobId)))
    top.appendChild(title)
    top.appendChild(el('span', 'job-badge ' + (job.enabled === true ? 'ok' : ''), job.enabled === true ? '启用中' : '已停用'))
    row.appendChild(top)

    row.appendChild(
      el(
        'div',
        'job-row-meta',
        String(job.employeeName || job.employeeId || '?') + ' · 每 ' + formatInterval(job.intervalMs)
      )
    )
    row.appendChild(
      el(
        'div',
        'job-row-next' + (job.enabled === true ? '' : ' off'),
        job.enabled === true ? '下次运行：' + formatWhen(job.nextRunAtMs) : '已停用，不会自动运行'
      )
    )
    if (job.nodeOnline !== true) row.appendChild(el('div', 'job-note', '目标机器不在线：到点后会先排队，等它上线再送出。'))
    if (typeof job.disabledReason === 'string' && job.disabledReason !== '') row.appendChild(el('div', 'job-note', String(job.disabledReason)))

    var actions = el('div', 'job-actions')
    var runNow = el('button', 'ghost job-act', '立即运行')
    runNow.disabled = !canManage
    runNow.onclick = function (event) {
      stopJobRowClick(event)
      runNow.disabled = true
      rpc('job.runNow', { jobId: jobId }, { idempotencyKey: randomId() })
        .then(function (payload) {
          var run = payload !== null && typeof payload === 'object' ? payload.run : null
          var status = run !== null && typeof run === 'object' ? String(run.status || '') : ''
          var detail = run !== null && typeof run === 'object' ? String(run.error || run.detail || '') : ''
          toast('这一轮：' + describeRunStatus(status) + (detail === '' ? '' : ' —— ' + detail), status === 'failed' ? 'warn' : 'ok')
          loadJobs()
        })
        .catch(function (error) {
          reportRpcError('job.runNow', error)
          runNow.disabled = false
        })
    }
    actions.appendChild(runNow)

    var toggle = el('button', 'ghost job-act', job.enabled === true ? '停用' : '启用')
    toggle.disabled = !canManage
    toggle.onclick = function (event) {
      stopJobRowClick(event)
      toggle.disabled = true
      rpc(
        'job.upsert',
        {
          jobId: jobId,
          name: String(job.name || ''),
          employeeId: String(job.employeeId || ''),
          prompt: String(job.prompt || ''),
          intervalMs: Number(job.intervalMs || 0),
          enabled: job.enabled !== true
        },
        { idempotencyKey: randomId() }
      )
        .then(function () {
          loadJobs()
        })
        .catch(function (error) {
          reportRpcError('job.upsert', error)
          toggle.disabled = false
        })
    }
    actions.appendChild(toggle)

    var edit = el('button', 'ghost job-act', '编辑')
    edit.disabled = !canManage
    edit.onclick = function (event) {
      stopJobRowClick(event)
      editJob(jobId)
    }
    actions.appendChild(edit)

    var remove = el('button', 'ghost job-act danger', '删除')
    remove.disabled = !canManage
    remove.onclick = function (event) {
      stopJobRowClick(event)
      remove.disabled = true
      rpc('job.remove', { jobId: jobId }, { idempotencyKey: randomId() })
        .then(function () {
          toast('任务已删除', 'ok')
          if (jobEditingId === jobId) {
            jobEditingId = null
            jobDetailMode = 'empty'
          }
          loadJobs()
        })
        .catch(function (error) {
          reportRpcError('job.remove', error)
          remove.disabled = false
        })
    }
    actions.appendChild(remove)
    row.appendChild(actions)

    var promptText = String(job.prompt || '').trim()
    if (promptText !== '') row.appendChild(el('div', 'job-prompt', promptText))

    var runs = Array.isArray(job.runs) ? job.runs : []
    if (runs.length > 0) {
      var details = el('details', 'job-runs')
      details.appendChild(el('summary', '', '最近 ' + String(runs.length) + ' 次派发'))
      runs.forEach(function (run) {
        var line = el('div', 'job-run')
        line.appendChild(el('span', 'job-run-status', describeRunStatus(run.status)))
        line.appendChild(el('span', 'job-run-when', formatWhen(run.startedAtMs)))
        var detail = String(run.error || run.detail || '')
        if (detail !== '') line.appendChild(el('span', 'job-run-detail', detail))
        details.appendChild(line)
      })
      row.appendChild(details)
    }
    box.appendChild(row)
  })
}
`
