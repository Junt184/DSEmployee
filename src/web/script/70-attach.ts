/**
 * 控制台脚本片段：发文件（附件）
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
export const CHUNK_70_ATTACH = String.raw`
/* ─────────────────── 发文件（附件）───────────────────
 *
 * 两条通道，各司其职（这不是重复，是 dsh 的附件通道**只收图片**决定的）：
 *
 *   ① 任何文件 → employee.files.upload 落进 <工作区>/收件箱/。
 *      员工要处理的 Excel / PDF / 压缩包只有落在工作区里，才能被它自己的
 *      bash / fs 工具读到 —— dsh 的附件通道明确不收这些类型。
 *   ② 图片 → 除了落盘，还作为**内联内容块**随这一轮一起发（dsh 的
 *      session.prompt 原生支持，由宿主把字节提升为持久附件引用），
 *      于是模型直接"看得见"截图，不必先用工具去打开文件。
 *      ⚠️ 这取决于**模型是否支持图片输入**：当前部署的 deepseek-v4-flash 不支持，
 *      内联会让整轮被拒，所以节点侧会在失败时**自动退回纯文本重发**（见 agent.ts）。
 *      也因此 ① 必须始终成立 —— 任何情况下文件都在收件箱里。
 *
 * 大小上限由节点侧强制（UPLOAD_MAX_BYTES = 2MB，Hub 单帧 4MiB 的载体约束）；
 * 这里做同样的前置检查只是为了给出更快的反馈，不是安全边界。
 */

/** 与节点侧 UPLOAD_MAX_BYTES 对齐（前端只做提前告知，真正的边界在节点）。 */
var ATTACH_MAX_BYTES = 2 * 1024 * 1024
var ATTACH_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
var ATTACH_INBOX = '收件箱'

/* 员工交付文件：卡片绑定产出消息所属的员工，下载时不读取当前选择。 */
function employeeFileCard(employeeId, filePath, label) {
  var name = filePath.split('/').pop() || filePath
  var card = el('span', 'employee-file-card')
  card.setAttribute('data-employee-id', employeeId)
  card.setAttribute('data-file-path', filePath)
  var icon = el('span', 'employee-file-icon', '📄')
  icon.setAttribute('aria-hidden', 'true')
  card.appendChild(icon)
  var details = el('span', 'employee-file-details')
  details.appendChild(el('span', 'employee-file-name', label || name))
  details.appendChild(el('span', 'employee-file-path', filePath))
  card.appendChild(details)
  var button = el('button', 'ghost small employee-file-download', '下载')
  button.type = 'button'
  button.setAttribute('aria-label', '下载文件：' + name)
  button.title = '从员工工作区下载（单文件最大 2 MB）'
  card.appendChild(button)
  var status = el('span', 'employee-file-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  card.appendChild(status)
  button.onclick = function () {
    if (button.disabled) return
    button.disabled = true
    button.textContent = '下载中…'
    status.className = 'employee-file-status'
    status.textContent = ''
    downloadEmployeeFile(employeeId, filePath).then(function (size) {
      status.textContent = '已开始下载 · ' + formatBytes(size)
      button.textContent = '再次下载'
    }).catch(function (error) {
      status.className = 'employee-file-status bad'
      status.textContent = fileDownloadError(error)
      button.textContent = '重试下载'
    }).finally(function () {
      button.disabled = false
    })
  }
  return card
}

function fileDownloadError(error) {
  var message = describeError(error)
  if (/too large to download/i.test(message)) return '文件超过下载上限（2 MB），请让员工拆分后重新发送。'
  if (/ENOENT|not a regular file/i.test(message)) return '文件不存在或已移动，请让员工重新发送。'
  if ((error && error.code === 'node-offline') || /node.*offline|node.*unavailable|node.*not connected/i.test(message)) return '员工节点暂时离线，恢复连接后可重试下载。'
  return '下载失败：' + message
}

function isImageFile(file) {
  return file !== null && typeof file === 'object' && ATTACH_IMAGE_TYPES.indexOf(String(file.type || '')) >= 0
}

/** 员工收件目录下的相对路径；重名自动加序号，不覆盖已有文件。 */
function inboxPathFor(name) {
  var safe = String(name || 'file')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 120)
  if (safe === '') safe = 'file'
  return ATTACH_INBOX + '/' + safe
}

function readFileBase64(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader()
    reader.onload = function () {
      var result = String(reader.result || '')
      var comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = function () {
      reject(new Error('读取文件失败'))
    }
    reader.readAsDataURL(file)
  })
}

/** 选文件 / 拖入 / 粘贴三条入口都汇到这里。 */
function handlePickedFiles(files) {
  if (state.selectedEmployeeId === null) {
    setBanner('先选中一个员工，再把文件发给他', 'bad')
    return Promise.resolve()
  }
  var list = Array.prototype.slice.call(files || [])
  if (list.length === 0) return Promise.resolve()
  var employeeId = state.selectedEmployeeId
  /* 排队串行：并发上传时同名文件的序号分配会打架 */
  var chain = Promise.resolve()
  list.forEach(function (file) {
    chain = chain.then(function () {
      if (file.size > ATTACH_MAX_BYTES) {
        toast('「' + file.name + '」太大（' + formatBytes(file.size) + '），单次上限 ' + formatBytes(ATTACH_MAX_BYTES), 'bad')
        return
      }
      return readFileBase64(file).then(function (base64) {
        var path = inboxPathFor(file.name)
        return rpc('employee.files.upload', {
          employeeId: employeeId,
          path: path,
          dataBase64: base64
        }).then(function (payload) {
          var stored = payload !== null && typeof payload === 'object' && typeof payload.path === 'string' ? payload.path : path
          state.attachments.push({
            name: String(file.name || 'file'),
            path: stored,
            size: Number(file.size) || 0,
            isImage: isImageFile(file),
            mediaType: String(file.type || ''),
            data: isImageFile(file) ? base64 : null
          })
          renderAttachStrip()
          toast('已把「' + file.name + '」放进 ' + stored, 'ok')
        })
      })
    })
  })
  return chain.catch(function (error) {
    toast('发送文件失败：' + describeError(error), 'bad')
  })
}

function renderAttachStrip() {
  var strip = $('attachStrip')
  if (strip === null) return
  clear(strip)
  if (state.attachments.length === 0) {
    strip.classList.add('hidden')
    return
  }
  strip.classList.remove('hidden')
  state.attachments.forEach(function (item, index) {
    var chip = el('span', 'attach-chip')
    chip.appendChild(el('span', 'attach-name', (item.isImage ? '🖼 ' : '📄 ') + item.name))
    chip.appendChild(el('span', 'attach-size', formatBytes(item.size)))
    var remove = el('button', 'attach-remove', '×')
    remove.title = '移除'
    remove.onclick = function () {
      state.attachments.splice(index, 1)
      renderAttachStrip()
    }
    chip.appendChild(remove)
    strip.appendChild(chip)
  })
  strip.appendChild(el('span', 'attach-hint', '随下一条指令一起发给员工'))
}

/** 把附件路径写进指令正文 —— 员工据此才知道有东西可读。 */
function withAttachmentNote(text, attachments) {
  var lines = attachments.map(function (item) {
    return '- ' + item.path + '（' + item.name + '，' + formatBytes(item.size) + '）'
  })
  var note = '（我放了这些文件在工作区里，请自行读取：\n' + lines.join('\n') + '）'
  return text.trim() === '' ? note : text + '\n\n' + note
}

/** 图片内联内容块；没有图片时返回 null（保持纯文本那条老路径不变）。 */
function buildPromptContent(text, attachments) {
  var images = attachments.filter(function (item) {
    return item.isImage === true && typeof item.data === 'string' && item.data !== ''
  })
  if (images.length === 0) return null
  var content = [{ type: 'text', text: text }]
  images.forEach(function (item) {
    content.push({ type: 'image', mediaType: item.mediaType, data: item.data, name: item.name })
  })
  return content
}

/** 用户侧的回执：把这批文件也记进对话流（否则回看时不知道发过什么）。 */
function appendAttachmentNote(attachments) {
  var box = renderBox()
  if (box === null) return
  var note = el('div', 'interaction-note settled')
  note.appendChild(el('span', 'interaction-icon', '📎'))
  var body = el('div', 'interaction-body')
  body.appendChild(el('div', 'interaction-title', '已发送 ' + String(attachments.length) + ' 个文件'))
  attachments.forEach(function (item) {
    body.appendChild(el('div', 'interaction-reason', item.path + ' · ' + formatBytes(item.size) + (item.isImage ? ' · 模型支持图片时会直接看见' : '')))
  })
  note.appendChild(body)
  box.appendChild(note)
  scrollMessages()
}

function formatBytes(bytes) {
  var n = Number(bytes) || 0
  if (n < 1024) return String(n) + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}

function cancelTurn() {
  if (state.selectedEmployeeId === null || state.selectedSessionId === null) return
  rpc('session.cancel', { employeeId: state.selectedEmployeeId, sessionId: state.selectedSessionId })
    .then(function (payload) {
      pushRaw('session.cancel 结果', payload)
      appendSystem('已发出打断请求 · ' + nowText())
      breakStream()
    })
    .catch(function (error) {
      reportRpcError('session.cancel', error)
      /* 打断失败（多为连接已断）：本地按钮照样复位，不永远卡在「停止」 */
      setRunning(false)
    })
}

/* 压缩上下文：调 session.compact（幂等）。在途时按钮转菊花防重复点击；
   结果按契约 {kind, text} 处理 —— success 上系统行 + toast，error 如实展示 text
   （如「该会话所用 preset 不含压缩能力」「agent 正忙」），UI 不做能力探测。 */
function compactContext() {
  if (state.selectedEmployeeId === null || state.selectedSessionId === null) return
  if (compacting || turnRunning) return
  compacting = true
  var btn = $('btnCompact')
  if (btn !== null) btn.classList.add('compacting')
  updateCompactButton()
  rpc('session.compact', { employeeId: state.selectedEmployeeId, sessionId: state.selectedSessionId })
    .then(function (payload) {
      pushRaw('session.compact 结果', payload)
      var kind = payload !== null && typeof payload === 'object' ? String(payload.kind || '') : ''
      var text = payload !== null && typeof payload === 'object' && typeof payload.text === 'string' ? payload.text : ''
      if (kind === 'success') {
        appendSystem('已压缩上下文' + (text === '' ? '' : '：' + text))
        toast('已压缩上下文', 'ok')
      } else {
        var reason = text === '' ? '未知原因' : text
        toast('压缩上下文失败：' + reason, 'bad')
        appendErrorBar('压缩上下文失败：' + reason)
      }
    })
    .catch(function (error) {
      reportRpcError('session.compact', error)
      appendErrorBar('压缩上下文失败：' + describeError(error))
    })
    .then(function () {
      compacting = false
      var btn2 = $('btnCompact')
      if (btn2 !== null) btn2.classList.remove('compacting')
      updateCompactButton()
    })
}

/* ── 沉淀为技能 ──
 *
 * 用户在聊天里一步步教员工工作流程，教完点「沉淀为技能」：给当前会话发一段
 * 固定元提示词（复用 session.prompt，幂等、mode:'queue'，与手动发送同一通道），
 * 员工流式干活全程可见，元提示词本身也作为用户气泡正常上屏 —— 不发隐形指令。
 * 发送前快照一次技能清单；回合结束（setRunning(true→false)，见 setRunning）后
 * 再拉一次清单对比增量，如实展示结果。
 *
 * 元提示词逐字固定（String.raw 模板里不能写反引号，用 MD_TICK 拼接）：
 */
var DISTILL_PROMPT =
  '【沉淀为技能】把本会话里我们实际演示过的那套工作流程，总结成一个可复用技能：\n' +
  '1. 在你的工作区下新建 ' + MD_TICK + '.dsh/skills/<kebab-case-名称>/SKILL.md' + MD_TICK + '；\n' +
  '2. frontmatter 必须包含 name（kebab-case，与目录同名）和 description（面向模型的触发描述：什么时候该用它），可加 whenToUse；\n' +
  '3. 正文写清：适用场景、前置条件、逐步操作、产出格式、注意事项（只写实际演示并验证过的步骤，不要编造）；\n' +
  '4. 完成后回复：技能名称 + 一句话用途。'

/* employee.skills.list 的容错解析：新形状 {skills:[{name,valid,issues,description?}]}，
   旧形状是字符串数组（payload 本体或 skills/workspaceSkills 等键下）。
   统一成 {name, valid, issues, description}；旧形状没有校验概念，缺 valid 按 true 算。 */
function parseSkillList(payload) {
  var list = pickArray(payload, ['skills', 'workspaceSkills', 'items', 'list'])
  var skills = []
  for (var i = 0; i < list.length; i += 1) {
    var item = list[i]
    if (typeof item === 'string') {
      if (item !== '') skills.push({ name: item, valid: true, issues: [], description: '' })
    } else if (item !== null && typeof item === 'object') {
      var name = typeof item.name === 'string' ? item.name : ''
      if (name === '') continue
      var issues = []
      if (Array.isArray(item.issues)) {
        for (var j = 0; j < item.issues.length; j += 1) issues.push(String(item.issues[j]))
      }
      skills.push({
        name: name,
        valid: item.valid !== false,
        issues: issues,
        description: typeof item.description === 'string' ? item.description : ''
      })
    }
  }
  return skills
}

function distillSkill() {
  if (state.selectedEmployeeId === null || state.selectedSessionId === null) return
  if (distilling || turnRunning) return
  if (state.phase !== 'ready' || state.scopes.indexOf('employee.prompt') < 0) return
  var employeeId = state.selectedEmployeeId
  var sessionId = state.selectedSessionId
  distilling = true
  updateDistillButton()
  appendSystem('正在把本会话沉淀为技能…')
  /* 发送前快照一次清单（先发快照请求再发 prompt，同一连接上有先后）；
     快照失败不阻塞沉淀本身 —— 记 null，结算时如实说明无法对比增量 */
  distillSnapshot = rpc('employee.skills.list', { employeeId: employeeId })
    .then(function (payload) {
      pushRaw('employee.skills.list 结果', payload)
      return parseSkillList(payload).map(function (skill) {
        return skill.name
      })
    })
    .catch(function (error) {
      reportRpcError('employee.skills.list', error)
      return null
    })
  finalizeStream()
  turnText = ''
  lastSentText = DISTILL_PROMPT
  appendUserBubble(DISTILL_PROMPT)
  /* 乐观置忙碌：与 sendPrompt 同款；失败路径复位并放弃这次结算 */
  setRunning(true)
  ensureSubscribed()
    .then(function () {
      /* 节点侧 session.prompt 要的是纯文本 text 字段（同 sendPrompt） */
      return rpc('session.prompt', {
        employeeId: employeeId,
        sessionId: sessionId,
        mode: 'queue',
        text: DISTILL_PROMPT
      })
    })
    .then(function (payload) {
      pushRaw('session.prompt 结果', payload)
    })
    .catch(function (error) {
      reportRpcError('session.prompt', error)
      appendErrorBar('发送失败：' + describeError(error))
      distilling = false
      distillSnapshot = null
      setRunning(false)
    })
}

/* 回合结束后的沉淀结算（由 setRunning 的运行→空闲转换触发；distilling 为假时直接返回）。
   对比发送前快照与当前清单：新增 valid → 报喜；新增但 valid:false → 警告行如实列出
   issues；无增量 → 指向它刚才的回复。清单拉不到就明说，不编造对比结论。 */
function reconcileSkillDistill() {
  if (distilling !== true) return
  distilling = false
  updateDistillButton()
  var employeeId = state.selectedEmployeeId
  var snapshot = distillSnapshot
  distillSnapshot = null
  if (employeeId === null || snapshot === null) return
  snapshot
    .then(function (before) {
      return rpc('employee.skills.list', { employeeId: employeeId }).then(function (payload) {
        pushRaw('employee.skills.list 结果', payload)
        return { before: before, after: parseSkillList(payload) }
      })
    })
    .then(function (result) {
      if (result.before === null) {
        appendSystem('沉淀前的技能清单没拿到，做不了增量对比；请直接看它刚才的回复与 .dsh/skills 目录')
        return
      }
      var added = []
      for (var i = 0; i < result.after.length; i += 1) {
        if (result.before.indexOf(result.after[i].name) < 0) added.push(result.after[i])
      }
      if (added.length === 0) {
        appendSystem('这次没有新技能落盘，看看它刚才的回复')
        return
      }
      for (var j = 0; j < added.length; j += 1) {
        var skill = added[j]
        if (skill.valid) {
          appendSystem('已学会新技能：' + skill.name + (skill.description === '' ? '' : ' —— ' + skill.description) + '（新会话生效）')
        } else {
          appendSystem('警告：新技能「' + skill.name + '」已落盘但校验未通过：' + (skill.issues.length > 0 ? skill.issues.join('；') : '（节点未给出详情）'))
        }
      }
    })
    .catch(function (error) {
      reportRpcError('employee.skills.list', error)
      appendSystem('沉淀结果确认失败（技能清单拉取失败）：' + describeError(error))
    })
}
`
