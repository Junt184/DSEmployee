/**
 * 控制台脚本片段：对话页：事件解包、markdown、气泡、流式、发送
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
export const CHUNK_65_CHAT = String.raw`
function ensureSubscribed() {
  if (state.selectedEmployeeId === null || state.selectedSessionId === null) return Promise.resolve(false)
  if (state.subscribed === state.selectedSessionId) return Promise.resolve(true)
  var employeeId = state.selectedEmployeeId
  var sessionId = state.selectedSessionId
  return rpc('session.subscribe', { employeeId: employeeId, sessionId: sessionId })
    .then(function (payload) {
      state.subscribed = sessionId
      pushRaw('session.subscribe 结果', payload)
      return true
    })
    .catch(function (error) {
      reportRpcError('session.subscribe', error)
      return false
    })
}

/**
 * 把当前会话重新接上：节点从离线变回在线时调。
 *
 * 为什么需要：节点离线期间发出去的指令进了 Hub 的离线邮箱（界面上是"排队中"），
 * 但它投递成功、员工开始回答时，本页可能收不到实时事件。
 *
 * ⚠️ 判据不是 state.subscribed：Hub 的 session.subscribe 是**本地登记 + 尽力通知节点**
 * （它给节点发 session.watch 时把错误吞掉了），所以节点离线时订阅照样"成功"——
 * 本页以为订上了，节点侧却从没登记过这个 watch。因此节点一回来必须**强制重订**一次，
 * 否则用户会一直盯着"排队中"，其实员工早就答完了（真机用 WebSocket 帧验证过：
 * 重连后 Hub 收到过 node.changed，但没有任何 session.subscribe / 实时事件）。
 */
function resumeSelectedSession() {
  if (state.phase !== 'ready') return
  if (state.selectedEmployeeId === null || state.selectedSessionId === null) return
  if (selectedNodeOnline() !== true) return
  state.subscribed = null
  var employeeId = state.selectedEmployeeId
  var sessionId = state.selectedSessionId
  loadSessions().then(function () {
    if (state.selectedEmployeeId !== employeeId || state.selectedSessionId !== sessionId) return
    /* openSession 会重新订阅并回填历史：排队气泡随之被真实历史取代（它已经送达了） */
    openSession(sessionId)
    /* 但"被取代"只说明界面刷新了，不说明送出去了 —— 队列里还剩东西就照实说一句，
       否则失败的那条会随气泡一起消失（体检里的「待发 N 条」在另一页，没人会去看）。 */
    if (state.selectedEmployeeId !== employeeId) return
    rpc('node.list', {})
      .then(function (payload) {
        var nodes = pickArray(payload, ['nodes', 'items', 'list'])
        var employee = null
        for (var i = 0; i < state.employees.length; i += 1) {
          if (String(state.employees[i].id || '') === employeeId) employee = state.employees[i]
        }
        if (employee === null) return
        for (var j = 0; j < nodes.length; j += 1) {
          if (String(nodes[j].nodeId || '') !== String(employee.nodeId || '')) continue
          if (typeof nodes[j].queued === 'number' && nodes[j].queued > 0) {
            appendSystem('（还有 ' + String(nodes[j].queued) + ' 条指令留在离线队列里没送出去 —— 详情见「体检」）')
          }
          return
        }
      })
      .catch(function () {
        /* 只是补一句说明：拿不到就算了，不打扰 */
      })
  })
}

/** 记住每个员工所在节点上一次的在线状态（用来识别"离线 → 在线"这一次翻转）。 */
var lastNodeOnline = {}

/**
 * 把这一轮员工列表与上一次的在线状态比一比，返回"选中的那位刚好从离线变回在线"。
 *
 * 只在**翻转那一次**返回 true：resumeSelectedSession 会把聊天区清掉重读历史，
 * 而 employee.changed 在改名、加人、节点重报目录时都会来 —— 每次来都清屏是不能接受的。
 */
function noteNodeOnline(employees) {
  var flipped = false
  var seen = {}
  for (var i = 0; i < employees.length; i += 1) {
    var id = String(employees[i].id || '')
    if (id === '') continue
    var online = employees[i].nodeOnline !== false
    seen[id] = online
    if (online === true && lastNodeOnline[id] === false && id === state.selectedEmployeeId) flipped = true
  }
  lastNodeOnline = seen
  return flipped
}

function openSession(sessionId) {
  state.selectedSessionId = sessionId
  state.subscribed = null
  state.streamBubble = null
  /* 记在本地：节点离线 + 页面刷新过时，靠它把会话接回来（见 adoptOfflineSession） */
  rememberSession(state.selectedEmployeeId, sessionId)
  /* 切会话先把小圈换成这一会话的数（列表里那份快照；实时帧来了会盖掉） */
  applyContextFromSessionList()
  /* 换会话：丢弃未结算的沉淀（必须在 setRunning 之前清，否则运行→空闲转换会误结算） */
  distilling = false
  distillSnapshot = null
  toggleSessionPanel(false)
  /* 会话列表带着 running 标志：进会话时据此恢复发送/停止键形态 */
  var running = false
  for (var i = 0; i < state.sessions.length; i += 1) {
    if (sessionIdOf(state.sessions[i]) === sessionId) {
      running = state.sessions[i].running === true
      break
    }
  }
  setRunning(running)
  renderSessions()
  /* 四宫格右上那格的「会话 N · 当前：xxx」要跟着换会话走（不是四宫格时它自己会跳过） */
  if (typeof renderQuadCells === 'function') renderQuadCells()
  syncControls()
  updateSendButton()
  updateCompactButton()
  updateDistillButton()
  clearMessages('正在读取历史…')
  ensureSubscribed().then(function () {
    if (state.selectedEmployeeId === null || state.selectedSessionId === null) return null
    return rpc('session.history', {
      employeeId: state.selectedEmployeeId,
      sessionId: state.selectedSessionId,
      maxEvents: 400
    })
      .then(function (payload) {
        pushRaw('session.history 结果', payload)
        clearMessages('')
        var events = pickArray(payload, ['events', 'items', 'messages', 'history'])
        if (events.length === 0) {
          clearMessages('（会话暂无历史；直接输入指令即可）')
        } else {
          events.forEach(function (item) {
            renderNormalized(normalizeEvent(item))
          })
        }
        /* 翻页入口：hasMore 且拿到游标（契约 oldestSeq，或首条 history 行的 seq）
           才亮「加载更早记录」按钮；旧节点只回 hasMore 时退化为原来的纯文本提示 */
        historyHasMore = payload !== null && typeof payload === 'object' && payload.hasMore === true
        historyOldestSeq = historyCursor(payload, events)
        if (historyHasMore && historyOldestSeq !== null) syncHistoryMore()
        else if (historyHasMore) appendSystem('（还有更早的历史未加载）')
        scrollMessages()
        return null
      })
      .catch(function (error) {
        reportRpcError('session.history', error)
        clearMessages(
          '读取历史失败（该会话历史可能过大，或节点正在重连）；实时输出不受影响，可稍后重试。（原始错误：' +
            describeError(error) +
            '）'
        )
        return null
      })
  })
}

/* ── 会话事件归一化（历史与实时共用的唯一入口）──
 *
 * normalizeEvent() 把任意一种已知信封形状解包成 dsh 事件，再映射成封闭联合：
 *   { kind:'user',      type, text }
 *   { kind:'assistant', type, stream:'delta'|'block'|'message', text, index }
 *   { kind:'tool',      type, phase:'call'|'result', name, toolId, detail, failed }
 *   { kind:'status',    type, code, text }   // turn/end：completed 或其它收尾
 *   { kind:'error',     type, text }         // turn/end 且 reason.kind==='error'
 *   { kind:'hidden',    type }               // 内部帧：不进对话区（原始帧只进 ?debug=1 面板）
 *
 * 容忍的输入形状：
 *   {type, data}                                            —— dsh 事件本体
 *   {seq, event:{type, data}}                               —— session.history 行
 *   {sessionId, employeeId, event:{method, payload, rpcId}} —— Hub 实时信封
 *     （payload 内层可能再包一层 {type, data}；method==='session/event' 时
 *       payload 是通知体 {type:'session/event', sessionId, event:{type,seq,time,data}}，
 *       真正的事件类型在第三层 payload.event.type）
 *
 * 事件词汇以 docs/04 §10.2 的实测定稿为准；未识别的一律 hidden ——
 * 对话区永不倒原始 JSON（旧的 harvestTexts/describeEvent 启发式已删除）。
 */

function unpackMethodPayload(method, payload) {
  if (payload !== null && typeof payload === 'object') {
    /* 交互帧（审批 / 提问）：payload **本身就是内容**，没有 {type, data} 包装 ——
       形如 {type:'approval/requested', sessionId, approvalId, toolName, callId?, reason?}。
       不在这里特判的话，下面那条分支会取 payload.data（恒 undefined）→ data 变 {}，
       于是 toolName / reason / questions 全被丢掉，卡片只剩一个空壳。 */
    if (method === 'approval/requested' || method === 'question/requested' || method === 'approval/resolved' || method === 'question/resolved') {
      return { type: method, data: payload }
    }
    /* session/event 通知体（dsh 0.1.0-rc.6 实测，docs/04 §10.3）：
       payload = {type:'session/event', sessionId, event:{type, seq, time, data}} ——
       真正的 dsh 事件藏在第三层 payload.event 里；其形状与 session.history 行
       同构，交回 unpackEvent 解。 */
    if (method === 'session/event' && payload.event !== null && typeof payload.event === 'object') {
      var inner = unpackEvent(payload)
      if (inner !== null) return inner
    }
    /* 会话投影通知（dsh 0.1.0-rc.6，docs/04 §10.3 同一批只读通知里的一类）：
       payload 顶层就是 {type:'session/projection', sessionId, key, value, seq} ——
       **key/value 在顶层，不在 payload.data 里**。不在这里特判的话，下面那条通用分支
       会把它读成 {type, data:{}}，key/value 当场丢掉、这一帧谁都不认识，
       于是「上下文占用」永远算不出来（这就是控制台一直没有小圈的原因）。 */
    if (method === 'session/projection') {
      return { type: method, data: payload }
    }
    /* 实时信封的 payload 内层可能再包一层 {type, data} */
    if (typeof payload.type === 'string') {
      return { type: payload.type, data: payload.data !== undefined ? payload.data : {} }
    }
  }
  return { type: method, data: payload !== undefined && payload !== null ? payload : {} }
}

function unpackEvent(envelope) {
  if (envelope === null || typeof envelope !== 'object') return null
  var event = envelope.event
  if (event !== null && typeof event === 'object') {
    if (typeof event.type === 'string') {
      return { type: event.type, data: event.data !== undefined ? event.data : {} }
    }
    if (typeof event.method === 'string') return unpackMethodPayload(event.method, event.payload)
    return null
  }
  if (typeof event === 'string' && event !== '') {
    return unpackMethodPayload(event, envelope.data !== undefined ? envelope.data : envelope.payload)
  }
  if (typeof envelope.type === 'string') {
    /* 投影帧兜底：实时链路是「{method, payload}」信封（走上面的 unpackMethodPayload），
       但历史行或别的入口可能把它直接拍在这里 —— 顶层就是 key/value 时同样要原样带走，
       否则又被吃成 data:{}，小圈再次消失（这类"不报错、只是不显示"最难查）。 */
    if (envelope.type === 'session/projection') return { type: envelope.type, data: envelope }
    return { type: envelope.type, data: envelope.data !== undefined ? envelope.data : {} }
  }
  if (typeof envelope.method === 'string') return unpackMethodPayload(envelope.method, envelope.payload)
  return null
}

function firstString(obj, keys) {
  if (obj === null || typeof obj !== 'object') return ''
  for (var i = 0; i < keys.length; i += 1) {
    var value = obj[keys[i]]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/* 从已知位置取文本：字符串本体 / content 数组里 type==='text' 的项 / {text} / {content}。 */
function textFromContent(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    var parts = []
    for (var i = 0; i < value.length; i += 1) {
      var item = value[i]
      if (typeof item === 'string') parts.push(item)
      else if (item !== null && typeof item === 'object' && typeof item.text === 'string' && (item.type === undefined || item.type === 'text')) {
        parts.push(item.text)
      }
    }
    return parts.join('')
  }
  if (value !== null && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (value.content !== undefined) return textFromContent(value.content)
  }
  return ''
}

/* AGENTS.md 注入、运行时上下文等"系统塞进来的 user/message"不显示在对话区。
   认不出来的 source 一律显示（宁可多显示，不吞用户真消息）。 */
function isInjectedUserMessage(data) {
  if (data === null || typeof data !== 'object') return false
  var source = data.source
  if (source === undefined && data.message !== null && typeof data.message === 'object') source = data.message.source
  var kind = ''
  if (typeof source === 'string') kind = source
  else if (source !== null && typeof source === 'object' && typeof source.kind === 'string') kind = source.kind
  if (kind === '') return false
  if (/^(user|human|operator|client|prompt)$/i.test(kind)) return false
  return /agent|instruction|context|runtime|system|inject/i.test(kind)
}

function normalizeEvent(envelope) {
  var unpacked = unpackEvent(envelope)
  if (unpacked === null) return { kind: 'hidden', type: '' }
  var type = unpacked.type
  var data = unpacked.data

  /* 会话投影：只认这四种 key —— 别的投影（标题、权限、子代理…）不是控制台的事，
     落成 hidden 就不会进消息区、也不会把状态机搅乱。
       · contextPressure / contextBreakdown / tokenUsage → 顶栏那个小圈
       · todos → 四宫格左下「下一步」（岗位 layout:'quad' 才显示，其它页白收也不渲染） */
  if (type === 'session/projection') {
    var projectionKey = data !== null && typeof data === 'object' && data.key !== undefined ? String(data.key) : ''
    if (
      projectionKey !== 'contextPressure' &&
      projectionKey !== 'contextBreakdown' &&
      projectionKey !== 'tokenUsage' &&
      projectionKey !== 'todos'
    ) {
      return { kind: 'hidden', type: type }
    }
    return {
      kind: 'projection',
      type: type,
      key: projectionKey,
      sessionId: data !== null && typeof data === 'object' && data.sessionId !== undefined ? String(data.sessionId) : '',
      value: data !== null && typeof data === 'object' && data.value !== undefined ? data.value : null,
    }
  }

  if (type === 'user/message') {
    if (isInjectedUserMessage(data)) return { kind: 'hidden', type: type }
    var userText = ''
    if (data !== null && typeof data === 'object' && data.message !== undefined) userText = textFromContent(data.message)
    if (userText === '') userText = textFromContent(data)
    if (userText === '') return { kind: 'hidden', type: type }
    return { kind: 'user', type: type, text: userText }
  }

  if (type === 'assistant/chunk') {
    var chunk = data !== null && typeof data === 'object' ? data.chunk : null
    if (chunk === null || typeof chunk !== 'object') return { kind: 'hidden', type: type }
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
      return { kind: 'assistant', type: type, stream: 'delta', index: chunk.index, text: chunk.text }
    }
    if (chunk.type === 'block-end') {
      var block = chunk.block
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        return { kind: 'assistant', type: type, stream: 'block', index: chunk.index, text: block.text }
      }
    }
    /* block-start / usage / finish / 非文本块：内部帧 */
    return { kind: 'hidden', type: type }
  }

  if (type === 'assistant/message') {
    /* 实测定稿：完整文本在 data.message.content（不是 data.content），见 docs/04 §10.2 */
    var message = data !== null && typeof data === 'object' ? data.message : null
    var assistantText = message !== null && typeof message === 'object' ? textFromContent(message.content) : ''
    if (assistantText === '') assistantText = textFromContent(message)
    if (assistantText === '' && data !== null && typeof data === 'object') assistantText = textFromContent(data.content)
    if (assistantText === '') return { kind: 'hidden', type: type }
    return { kind: 'assistant', type: type, stream: 'message', index: 0, text: assistantText }
  }

  if (type === 'tool/call' || type === 'tool/result') {
    var call = data !== null && typeof data === 'object' && data.call !== null && typeof data.call === 'object' ? data.call : null
    var name = firstString(data, ['name', 'tool', 'toolName', 'tool_name'])
    if (name === '' && call !== null) name = firstString(call, ['name', 'tool'])
    if (name === '') name = '工具调用'
    var toolId = firstString(data, ['callId', 'call_id', 'toolCallId', 'invokeId', 'id'])
    if (toolId === '' && call !== null) toolId = firstString(call, ['id', 'callId'])
    if (toolId === '') toolId = name
    var failed = false
    if (type === 'tool/result' && data !== null && typeof data === 'object') {
      failed =
        data.failed === true ||
        data.isError === true ||
        data.is_error === true ||
        data.ok === false ||
        (typeof data.error === 'string' && data.error !== '')
    }
    var detailSource = data
    if (data !== null && typeof data === 'object') {
      if (type === 'tool/call') {
        detailSource =
          data.args !== undefined ? data.args : data.input !== undefined ? data.input : data.arguments !== undefined ? data.arguments : data.params !== undefined ? data.params : data
      } else {
        detailSource = data.result !== undefined ? data.result : data.output !== undefined ? data.output : data.content !== undefined ? data.content : data
      }
    }
    var detail = safeJson(detailSource)
    if (typeof detail !== 'string') detail = String(detailSource)
    if (detail.length > 4000) detail = detail.slice(0, 4000) + '\n…（截断）'
    return { kind: 'tool', type: type, phase: type === 'tool/call' ? 'call' : 'result', name: name, toolId: toolId, detail: detail, failed: failed }
  }

  if (type === 'turn/end') {
    var reason = data !== null && typeof data === 'object' ? data.reason : null
    var reasonKind = reason !== null && typeof reason === 'object' && typeof reason.kind === 'string' ? reason.kind : ''
    if (reasonKind === 'error') {
      var reasonError = reason.error
      var errorText = reasonError !== null && typeof reasonError === 'object' && typeof reasonError.message === 'string' ? reasonError.message : ''
      return { kind: 'error', type: type, text: errorText === '' ? '回合失败（无错误详情）' : errorText }
    }
    if (reasonKind === 'completed') return { kind: 'status', type: type, code: 'turn-end', text: '' }
    if (reasonKind === '') return { kind: 'hidden', type: type }
    return { kind: 'status', type: type, code: 'turn-end', text: '（回合结束：' + reasonKind + '）' }
  }

  /* ── dsh 交互（审批 / 提问）：员工在等人，必须进对话区 ──
   *
   * 这两类帧曾经落进最后的 hidden 兜底 —— 那正是"员工看起来在干活、某些操作
   * 却静默卡住"却不显示任何线索的字面原因。它们现在既进审批面板（可裁决），
   * 也在对话区留一条内联提示（说明**卡在哪一步**）。 */
  if (type === 'approval/requested' || type === 'question/requested') {
    var isApproval = type === 'approval/requested'
    var toolName = isApproval ? firstString(data, ['toolName', 'tool']) : ''
    var reason = firstString(data, ['reason'])
    var questionCount = !isApproval && data !== null && typeof data === 'object' && Array.isArray(data.questions) ? data.questions.length : 0
    var requestText = isApproval
      ? '员工请求批准执行「' + (toolName === '' ? '（未提供动作名）' : toolName) + '」'
      : '员工有问题要问你' + (questionCount > 0 ? '（' + String(questionCount) + ' 个）' : '')
    return {
      kind: 'interaction',
      type: type,
      phase: 'request',
      what: isApproval ? 'approval' : 'question',
      toolName: toolName,
      reason: reason,
      text: requestText
    }
  }

  if (type === 'approval/resolved' || type === 'question/resolved') {
    var outcome = firstString(data, ['outcome'])
    var resolvedText = outcome === 'allowed-once'
      ? '已批准，员工继续执行'
      : outcome === 'rejected'
        ? '已拒绝'
        : outcome === 'answered'
          ? '问题已回答'
          : outcome === 'cancelled'
            ? '已取消（无人应答，或这一步被中止）'
            : '已解决' + (outcome === '' ? '' : '：' + outcome)
    return { kind: 'interaction', type: type, phase: 'resolved', what: type === 'approval/resolved' ? 'approval' : 'question', outcome: outcome, text: resolvedText }
  }

  /* turn/start、step/*、request/*、session/title、sandbox/mode、permission/preset、
     approval/policy、agent/inbox/spliced 以及一切未识别事件：不进对话区 */
  return { kind: 'hidden', type: type }
}

/* ── 极小 Markdown 渲染器（员工回复是 markdown）──
 *
 * 只实现安全子集：代码围栏、行内代码、加粗、标题、无序/有序列表、http(s) 链接、GFM 表格。
 * 全部 DOM + textContent 构建，不走 innerHTML —— 员工输出是不可信文本。
 * 注意：本文件是 String.raw 模板，反引号字符（96）会终结模板字面量，
 * 行内代码 / 代码围栏的匹配只能用 fromCharCode 迂回。
 */
var MD_TICK = String.fromCharCode(96)
var MD_FENCE_RE = new RegExp('^\\s*' + MD_TICK + MD_TICK + MD_TICK)
var MD_INLINE_RE = new RegExp('(\\*\\*[^*]+\\*\\*|' + MD_TICK + '[^' + MD_TICK + ']+' + MD_TICK + '|\\[[^\\]]*\\]\\([^)\\s]+\\))', 'g')

function appendInlineToken(container, token) {
  if (token.length > 4 && token.slice(0, 2) === '**' && token.slice(-2) === '**') {
    container.appendChild(el('strong', '', token.slice(2, -2)))
    return
  }
  if (token.length > 2 && token.charAt(0) === MD_TICK) {
    container.appendChild(el('code', 'md-code', token.slice(1, -1)))
    return
  }
  var split = token.indexOf('](')
  if (split > 0) {
    var label = token.slice(1, split)
    var url = token.slice(split + 2, -1)
    if (/^https?:\/\//i.test(url)) {
      var link = el('a', 'md-link', label === '' ? url : label)
      link.setAttribute('href', url)
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noopener noreferrer')
      container.appendChild(link)
      return
    }
  }
  container.appendChild(document.createTextNode(token))
}

function appendInlineMd(container, text) {
  MD_INLINE_RE.lastIndex = 0
  var last = 0
  var match = MD_INLINE_RE.exec(text)
  while (match !== null) {
    if (match.index > last) container.appendChild(document.createTextNode(text.slice(last, match.index)))
    appendInlineToken(container, match[0])
    last = match.index + match[0].length
    match = MD_INLINE_RE.exec(text)
  }
  if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)))
}

/* GFM 表格：表头行 + 分隔行（--- / :--- / ---: / :---:）+ 后续含 | 的行。
   列数以表头为准（多的丢掉、少的补空），单元格走同一套行内 markdown。
   不解析单元格里的转义竖线 —— 那会把这套手写扫描器变成另一套解析器。 */
function splitMdTableRow(line) {
  var raw = String(line).replace(/^\s+|\s+$/g, '')
  if (raw.charAt(0) === '|') raw = raw.slice(1)
  if (raw.length > 0 && raw.charAt(raw.length - 1) === '|') raw = raw.slice(0, -1)
  var parts = raw.split('|')
  var out = []
  for (var i = 0; i < parts.length; i += 1) out.push(parts[i].replace(/^\s+|\s+$/g, ''))
  return out
}

function isMdTableSep(line) {
  if (String(line).indexOf('|') < 0) return false
  var cells = splitMdTableRow(line)
  if (cells.length === 0) return false
  for (var i = 0; i < cells.length; i += 1) {
    if (!/^\s*:?-{1,}:?\s*$/.test(cells[i])) return false
  }
  return true
}

function mdTableAlign(cell) {
  var s = String(cell).replace(/\s+/g, '')
  var left = s.charAt(0) === ':'
  var right = s.length > 0 && s.charAt(s.length - 1) === ':'
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return ''
}

function looksLikeMdTableRow(line) {
  return String(line).indexOf('|') >= 0 && !MD_FENCE_RE.test(line)
}

function mdTableCellClass(kind, align) {
  return kind + (align !== '' ? ' md-align-' + align : '')
}

function renderMarkdown(container, text) {
  var lines = String(text).split('\n')
  var para = []
  function flushPara() {
    if (para.length === 0) return
    var p = el('p', 'md-p')
    for (var j = 0; j < para.length; j += 1) {
      if (j > 0) p.appendChild(el('br'))
      appendInlineMd(p, para[j])
    }
    container.appendChild(p)
    para = []
  }
  var i = 0
  while (i < lines.length) {
    var line = lines[i]
    if (MD_FENCE_RE.test(line)) {
      flushPara()
      var codeLines = []
      i += 1
      while (i < lines.length && !MD_FENCE_RE.test(lines[i])) {
        codeLines.push(lines[i])
        i += 1
      }
      i += 1 /* 跳过收尾围栏（或文本结束） */
      var pre = el('pre', 'md-pre')
      pre.appendChild(el('code', '', codeLines.join('\n')))
      container.appendChild(pre)
      continue
    }
    /* 标题：# 到 ###（秘书页的「上次结论」整篇都是标题分节；员工回复里也常见）。
       刻意只到三级：h4 及以下在 340px 宽的右栏和气泡里已经和正文没区别。
       为什么原来没有：渲染器只做"安全子集"，而当时的用例里没人写标题 ——
       实测看到「##」原样显示（秘书页的主要内容就是它），才补上。 */
    var heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushPara()
      var level = String(heading[1]).length
      var headNode = el('h' + String(level + 2), 'md-h md-h' + String(level))
      appendInlineMd(headNode, String(heading[2]).replace(/\s+#+\s*$/, ''))
      container.appendChild(headNode)
      i += 1
      continue
    }
    /* 表格必须看下一行是不是分隔行：单独一行 | a | b | 只是普通段落里的竖线。
       为什么原来没有：安全子集当时的用例只有加粗/列表/代码，员工一输出对照表
       就会整表当正文，列对不齐。 */
    if (looksLikeMdTableRow(line) && i + 1 < lines.length && isMdTableSep(lines[i + 1])) {
      flushPara()
      var headerCells = splitMdTableRow(line)
      var aligns = splitMdTableRow(lines[i + 1])
      var colCount = headerCells.length
      i += 2
      var bodyRows = []
      while (i < lines.length) {
        var tableLine = lines[i]
        if (tableLine.trim() === '') break
        if (!looksLikeMdTableRow(tableLine)) break
        if (/^(#{1,3})\s+/.test(tableLine)) break
        bodyRows.push(splitMdTableRow(tableLine))
        i += 1
      }
      if (colCount > 0) {
        var wrap = el('div', 'md-table-wrap')
        var table = el('table', 'md-table')
        var thead = el('thead')
        var headRow = el('tr')
        var col = 0
        for (col = 0; col < colCount; col += 1) {
          var headAlign = col < aligns.length ? mdTableAlign(aligns[col]) : ''
          var th = el('th', mdTableCellClass('md-th', headAlign))
          appendInlineMd(th, headerCells[col] !== undefined ? headerCells[col] : '')
          headRow.appendChild(th)
        }
        thead.appendChild(headRow)
        table.appendChild(thead)
        var tbody = el('tbody')
        for (var row = 0; row < bodyRows.length; row += 1) {
          var tr = el('tr')
          var rowCells = bodyRows[row]
          for (col = 0; col < colCount; col += 1) {
            var bodyAlign = col < aligns.length ? mdTableAlign(aligns[col]) : ''
            var td = el('td', mdTableCellClass('md-td', bodyAlign))
            appendInlineMd(td, rowCells[col] !== undefined ? rowCells[col] : '')
            tr.appendChild(td)
          }
          tbody.appendChild(tr)
        }
        table.appendChild(tbody)
        wrap.appendChild(table)
        container.appendChild(wrap)
      }
      continue
    }
    var bullet = /^\s*[-*•]\s+/.test(line)
    var numbered = /^\s*\d+[.)]\s+/.test(line)
    if (bullet || numbered) {
      flushPara()
      var listNode = el(bullet ? 'ul' : 'ol', 'md-list')
      while (i < lines.length) {
        var itemLine = lines[i]
        var itemBullet = /^\s*[-*•]\s+/.test(itemLine)
        var itemNumbered = /^\s*\d+[.)]\s+/.test(itemLine)
        if (!itemBullet && !itemNumbered) break
        if (itemBullet !== bullet) break /* 列表类型变了就收尾，另起一个 */
        var item = el('li', 'md-li')
        appendInlineMd(item, itemLine.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''))
        listNode.appendChild(item)
        i += 1
      }
      container.appendChild(listNode)
      continue
    }
    if (line.trim() === '') {
      flushPara()
      i += 1
      continue
    }
    para.push(line)
    i += 1
  }
  flushPara()
}

function clearMessages(placeholder) {
  var box = $('messages')
  if (box === null) return
  clear(box)
  state.streamBubble = null
  turnText = ''
  lastSentText = ''
  toolCards = {}
  /* 视图被清空 = 翻页上下文作废：游标与「加载更早」按钮随消息一起消失 */
  historyHasMore = false
  historyOldestSeq = null
  historyLoading = false
  historyPrependBox = null
  if (placeholder !== undefined && placeholder !== null && placeholder !== '') {
    box.appendChild(el('div', 'empty', placeholder))
  }
}

function scrollMessages() {
  /* 前插渲染模式（「加载更早」）：滚动由 prependHistoryEvents 统一补差值 */
  if (historyPrependBox !== null) return
  var box = $('messages')
  if (box !== null) box.scrollTop = box.scrollHeight
}

/* ── 历史翻页（「加载更早记录」）──
 *
 * 契约（src/protocol session.history）：入参 maxEvents（默认 400）+ beforeSeq；
 * 返回 {events, hasMore, oldestSeq?}，事件按 seq 升序，oldestSeq 供翻下一页。
 * 旧节点没有 oldestSeq / beforeSeq：UI 容错为原来的「还有更早的历史未加载」纯文本。
 */

/* 渲染管线的目标容器：正常是消息区；前插渲染时改投临时容器，
   渲染完由 prependHistoryEvents 整体 insertBefore 到消息区顶部。 */
function renderBox() {
  return historyPrependBox !== null ? historyPrependBox : $('messages')
}

/* 翻页游标：优先契约字段 payload.oldestSeq；缺失时退化到首条 history 行自带的 seq
   （行形状 {seq, event}，事件按 seq 升序，两者等价）。都没有（旧节点）→ null。 */
function historyCursor(payload, events) {
  if (payload !== null && typeof payload === 'object' && typeof payload.oldestSeq === 'number' && payload.oldestSeq > 0) {
    return payload.oldestSeq
  }
  if (events.length > 0) {
    var first = events[0]
    if (first !== null && typeof first === 'object' && typeof first.seq === 'number' && first.seq > 0) return first.seq
  }
  return null
}

/* 消息区顶部的「加载更早记录」入口：ghost 低调样式、触控目标 ≥44px（见 CSS）。
   仅在还有更早历史且拿到游标时出现；拉取在途禁用防重入。 */
function syncHistoryMore() {
  var box = $('messages')
  if (box === null) return
  var bar = null
  var first = box.firstElementChild
  if (first !== null && first.classList.contains('history-more')) bar = first
  if (!historyHasMore || historyOldestSeq === null) {
    if (bar !== null) box.removeChild(bar)
    return
  }
  if (bar === null) {
    bar = el('div', 'history-more')
    var button = el('button', 'ghost history-more-btn', '加载更早记录')
    button.type = 'button'
    button.onclick = loadEarlierHistory
    bar.appendChild(button)
    box.insertBefore(bar, box.firstChild)
  }
  var btn = bar.firstElementChild
  if (btn !== null) {
    btn.disabled = historyLoading
    btn.textContent = historyLoading ? '正在读取更早记录…' : '加载更早记录'
  }
}

/* 点击「加载更早记录」：带 beforeSeq 游标再拉一页，旧事件前插到消息区顶部。
   拉取期间切了会话就丢弃这页（新会话有自己的 openSession 流程）。 */
function loadEarlierHistory() {
  if (historyLoading) return
  if (!historyHasMore || historyOldestSeq === null) return
  if (state.selectedEmployeeId === null || state.selectedSessionId === null) return
  var employeeId = state.selectedEmployeeId
  var sessionId = state.selectedSessionId
  var beforeSeq = historyOldestSeq
  historyLoading = true
  syncHistoryMore()
  rpc('session.history', {
    employeeId: employeeId,
    sessionId: sessionId,
    maxEvents: 400,
    beforeSeq: beforeSeq
  })
    .then(function (payload) {
      pushRaw('session.history 更早一页', payload)
      historyLoading = false
      if (state.selectedEmployeeId !== employeeId || state.selectedSessionId !== sessionId) return null
      var events = pickArray(payload, ['events', 'items', 'messages', 'history'])
      /* 去重：seq >= 游标的事件已上屏。旧节点若忽略 beforeSeq 会整页重复 ——
         fresh 为空即识别出这种情况，收起翻页入口，免得死循环拉同一页。 */
      var fresh = []
      for (var i = 0; i < events.length; i += 1) {
        var row = events[i]
        var seq = row !== null && typeof row === 'object' && typeof row.seq === 'number' ? row.seq : null
        if (seq !== null && seq >= beforeSeq) continue
        fresh.push(row)
      }
      if (fresh.length > 0) prependHistoryEvents(fresh)
      historyHasMore = payload !== null && typeof payload === 'object' && payload.hasMore === true
      /* 空页或整页重复（旧节点忽略 beforeSeq）：再点也是同一页，收起翻页入口 */
      if (fresh.length === 0) historyHasMore = false
      var cursor = historyCursor(payload, fresh)
      if (cursor !== null) historyOldestSeq = cursor
      syncHistoryMore()
      return null
    })
    .catch(function (error) {
      reportRpcError('session.history', error)
      historyLoading = false
      if (state.selectedEmployeeId === employeeId && state.selectedSessionId === sessionId) {
        syncHistoryMore()
        appendSystem('读取更早历史失败：' + describeError(error) + '（可再点「加载更早记录」重试）')
      }
      return null
    })
}

/* 把一页更早的历史渲染后前插到消息区顶部（翻页按钮条之下、现有消息之上）。
   复用 normalizeEvent → renderNormalized 管线，但改投临时容器：渲染期间不碰真实
   消息区的滚动；插入前记 scrollHeight，插入后按差值补 scrollTop —— 视口不跳。
   渲染用的回合状态（streamBubble/turnText/toolCards/lastSentText）先快照、渲染后
   恢复，免得历史页污染正在进行的实时回合与乐观上屏去重。 */
function prependHistoryEvents(events) {
  var box = $('messages')
  if (box === null) return
  var previousHeight = box.scrollHeight
  var staging = el('div')
  var savedBubble = state.streamBubble
  var savedTurnText = turnText
  var savedLastSent = lastSentText
  var savedToolCards = toolCards
  state.streamBubble = null
  turnText = ''
  lastSentText = ''
  toolCards = {}
  historyPrependBox = staging
  events.forEach(function (item) {
    renderNormalized(normalizeEvent(item))
  })
  /* 旧页可能正好停在半截流式 delta 上：就地定稿，别把呼吸光标永远留在历史里 */
  finalizeStream()
  historyPrependBox = null
  state.streamBubble = savedBubble
  turnText = savedTurnText
  lastSentText = savedLastSent
  toolCards = savedToolCards
  var anchor = box.firstElementChild
  if (anchor !== null && anchor.classList.contains('history-more')) anchor = anchor.nextElementSibling
  while (staging.firstChild !== null) box.insertBefore(staging.firstChild, anchor)
  box.scrollTop += box.scrollHeight - previousHeight
}

/* ── 对话渲染与交互 ──
 *
 * Apple Messages 风格：用户右侧蓝气泡、员工左侧灰气泡（流式时带呼吸光标）、
 * 工具调用是紧凑卡片、回合失败是内联错误条。气泡里没有「原始事件」details ——
 * 原始帧只在 ?debug=1 的调试面板（pushRaw）里看。
 */
var chatBound = false /* 懒绑定守卫：聊天视图自己的控件只在首次进入时绑一次 */
var turnRunning = false /* 回合运行中：发送键变停止方块 */
var compacting = false /* session.compact 在途：压缩按钮转菊花并防重复点击 */
var distilling = false /* 「沉淀为技能」在途：元提示词已发出、等回合结束结算增量，期间防重入 */
var distillSnapshot = null /* 发送沉淀前抓的技能清单快照（Promise<名字数组|null>），回合结束后对比增量 */
var turnText = '' /* 本回合已渲染的 assistant 文本（assistant/message 去重用） */
var lastSentText = '' /* 本地已乐观上屏的 prompt（实时回声去重用） */
var toolCards = {} /* toolId → { status, detail, text }（详情逐次累加） */
/* ── 历史翻页（「加载更早记录」）── */
var historyHasMore = false /* 服务端报告还有更早的一页 */
var historyOldestSeq = null /* 已加载事件里最早的 seq：下一页请求的 beforeSeq 游标 */
var historyLoading = false /* 「加载更早」拉取在途：按钮防重入 */
var historyPrependBox = null /* 非空 = 前插渲染模式：渲染管线改投该容器，滚动条不动 */

/* 回合看门狗：回合在跑、却长时间没有任何事件 ⇒ 多半卡住了。
   只提示一次（不刷屏），并把"可以怎么办"写进去 —— 自动取消是危险的，交给用户决定。 */
var TURN_STALL_MS = 180000
var turnLastEventAt = 0
var turnStallWarned = false


function squash(text) {
  return String(text).replace(/\s+/g, '')
}

/* 聊天视图新增的控件（会话抽屉开关、Enter 发送、输入框自动增高）在这里绑；
   bindEvents 里那份全局绑定（按钮 id 全部保留）不动 */
function bindChatUi() {
  if (chatBound) return
  chatBound = true
  var toggle = $('btnChatSessions')
  if (toggle !== null) {
    toggle.onclick = function () {
      toggleSessionPanel()
    }
  }
  var input = $('promptInput')
  if (input !== null) {
    input.addEventListener('keydown', onPromptKeydown)
    input.addEventListener('input', autoGrowPrompt)
  }
  var compact = $('btnCompact')
  if (compact !== null) compact.onclick = compactContext
  var distill = $('btnDistill')
  if (distill !== null) distill.onclick = distillSkill
  /* 小圈：点一下展开构成（总量/容量在那块里），再点收起 */
  var ring = $('ctxRing')
  if (ring !== null) ring.onclick = toggleContextPop
  updateCompactButton()
  updateDistillButton()
  placeChatTools()
}

/* ── 工具键在窄屏搬家 ──
 *
 * 「压缩上下文 / 沉淀为技能」是**会话级**低频动作，而手机上的输入行只有 ~351px：
 * 实测两个键（各 82px 定宽、white-space:nowrap 不缩）加上附件与发送会把输入框
 * 挤到 78px（≈3 个汉字），320px 屏更是只剩 34px 并撑出横向溢出。
 * 因此窄屏把它们搬进会话抽屉（会话级动作跟着会话列表走），宽屏搬回输入区。
 *
 * 搬的是**同一批 DOM 节点**，不复制第二份按钮 —— 否则 disabled / compacting 菊花 /
 * 文案这些状态会有两处要同步，迟早不一致。放进抽屉后抽屉若关着就够不到，
 * 这是有意的：那是"打开会话列表顺手做一次"的动作，不是每轮都要点的。 */
var CHAT_TOOLS_MOVE_QUERY = '(max-width: 640px)'

/** 返回"当前是否窄屏"（显式传布尔值时不查媒体查询，便于测试）。 */
function placeChatTools(narrowOverride) {
  var compact = $('btnCompact')
  var distill = $('btnDistill')
  var inline = document.querySelector('#viewChat .composer-inner')
  var slot = $('sessionTools')
  if (compact === null || distill === null || inline === null || slot === null) return false
  var narrow = typeof narrowOverride === 'boolean'
    ? narrowOverride
    : window.matchMedia(CHAT_TOOLS_MOVE_QUERY).matches
  if (narrow) {
    if (compact.parentNode !== slot || distill.parentNode !== slot) {
      slot.appendChild(compact)
      slot.appendChild(distill)
    }
    return true
  }
  if (compact.parentNode !== inline || distill.parentNode !== inline) {
    var send = $('btnSend')
    if (send !== null) {
      /* 插回发送键之前，恢复"附件 → 输入框 → 压缩 → 沉淀 → 发送"的原顺序 */
      inline.insertBefore(compact, send)
      inline.insertBefore(distill, send)
    } else {
      inline.appendChild(compact)
      inline.appendChild(distill)
    }
  }
  return false
}

/* 会话抽屉：首屏只剩对话，点顶栏「会话」才展开 */
function toggleSessionPanel(show) {
  var panel = $('sessionPanel')
  if (panel === null) return
  var toggle = $('btnChatSessions')
  var want = typeof show === 'boolean' ? show : panel.classList.contains('hidden')
  panel.classList.toggle('hidden', !want)
  if (toggle !== null) toggle.setAttribute('aria-expanded', want ? 'true' : 'false')
  if (want) {
    updateEffectivePreset()
    loadSessions()
  }
}

/* ── 上下文占用（顶栏那个小圈）──
 *
 * 数字全部来自 dsh 的「session/projection」帧（见 normalizeEvent 的 projection 分支）：
 *   contextPressure:  { pressureTokens?, projectedTokens?, contextWindow? }
 *   contextBreakdown: { systemTokens?, toolsTokens?, messageTokens? }
 *
 * 两条照 dsh 自己的做法（它那个圈就是这么算的）：
 *   ① **占用率读 projectedTokens**（"下一次请求大概要多少"），它缺失时才退回 pressureTokens。
 *      为什么不能只用 pressureTokens：那是**上一次请求实际报的**大小，压缩之后它会停在压缩前，
 *      看起来像"压缩没生效"；projectedTokens 把之后内容的增减折进去，才跟着动。
 *   ② **contextWindow 缺失就不显示百分比**（适配器没报容量时它就是缺的），只显示已用 token。
 *
 * 还有一条纪律：**只认当前会话**。帧是按会话推的，翻旧会话时旧帧还在飞，
 * 不比对 sessionId 就会把别的会话的数字画在这一页上。
 */
function formatContextTokens(value) {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) return ''
  if (value >= 1000000) return String(Math.round(value / 100000) / 10) + 'M'
  if (value >= 1000) return String(Math.round(value / 100) / 10) + 'k'
  return String(Math.round(value))
}

/** 当前会话的占用；拿不到就是 null（**不编数字**）。percent 为 null = 这个模型没报容量 */
function contextOccupancy() {
  var context = state.context
  if (context === null || typeof context !== 'object') return null
  if (context.sessionId === '' || context.sessionId !== state.selectedSessionId) return null
  var pressure = context.pressure
  if (pressure === null || typeof pressure !== 'object') return null
  var used = typeof pressure.projectedTokens === 'number' ? pressure.projectedTokens : null
  if (used === null && typeof pressure.pressureTokens === 'number') used = pressure.pressureTokens
  if (used === null) return null
  var capacity = typeof pressure.contextWindow === 'number' && pressure.contextWindow > 0 ? pressure.contextWindow : null
  return {
    used: used,
    capacity: capacity,
    /* 夹在 0–100：dsh 自己也这么夹（超了不显示成 130%） */
    percent: capacity === null ? null : Math.max(0, Math.min(100, Math.round((used / capacity) * 100))),
  }
}

/** 一份 projection 帧落到 state（只认当前会话；换会话时把上一份作废） */
function applyContextProjection(n) {
  if (n === null || typeof n !== 'object') return
  var sessionId = String(n.sessionId === undefined ? '' : n.sessionId)
  if (sessionId === '') return
  if (state.selectedSessionId === null || sessionId !== state.selectedSessionId) return
  if (state.context === null || typeof state.context !== 'object') {
    state.context = { sessionId: '', pressure: null, breakdown: null, live: false }
  }
  if (state.context.sessionId !== sessionId) {
    state.context = { sessionId: sessionId, pressure: null, breakdown: null, live: false }
  }
  if (n.key === 'contextPressure') state.context.pressure = n.value
  else if (n.key === 'contextBreakdown') state.context.breakdown = n.value
  /* 累计用量（本会话所有回合的账单）：小圈的环不用它，但点开那块要显示
     "这一路花了多少"。数据本来就在推，多存一份不花任何代价。 */
  else if (n.key === 'tokenUsage') state.context.usage = n.value
  /* 标记 live：实时帧比"会话列表里的快照"新，列表那份不许盖回来。 */
  state.context.live = true
  renderContextRing()
}

/**
 * 一份 todos 投影帧落到 state.plan（四宫格左下「下一步」）。
 *
 * 三条来自 dsh 源码的事实（@deepseek-ai/dsh-tool-todo 的投影定义），决定了这里的写法：
 *   1. 值域是 [{content, status}] 或 **null**；
 *   2. 收到 turn/start 会把值置回 null —— 也就是**每轮开场都会清空**；
 *   3. 它跟上下文那两个 key 一样，是**只推不补**的（订阅前的不重放）。
 *
 * 所以本轮被清空时，先把上一份挪进 prev：不然"7 条全 ✓ 还热乎"会在一瞬间消失，
 * 而"上一轮做了什么"恰恰是下一轮开场最该看到的东西。
 */
function applyPlanProjection(n) {
  if (n === null || typeof n !== 'object') return
  var sessionId = String(n.sessionId === undefined ? '' : n.sessionId)
  if (sessionId === '') return
  if (state.selectedSessionId === null || sessionId !== state.selectedSessionId) return
  if (state.plan === null || typeof state.plan !== 'object' || state.plan.sessionId !== sessionId) {
    state.plan = { sessionId: sessionId, todos: null, prev: null, prevAtMs: 0, live: false }
  }
  var value = n.value === undefined ? null : n.value
  if (Array.isArray(value)) {
    state.plan.todos = value
  } else {
    /* null（或形状不认识）：本轮还没写计划。把刚结束那份留成"上一轮"。 */
    if (Array.isArray(state.plan.todos) && state.plan.todos.length > 0) {
      state.plan.prev = state.plan.todos
      state.plan.prevAtMs = Date.now()
    }
    state.plan.todos = null
  }
  state.plan.live = true
  /* renderQuadPlan 在 68-quad 里；控制台是整份脚本跑的，typeof 只在单函数测试时兜底 */
  if (typeof renderQuadPlan === 'function') renderQuadPlan()
}

/**
 * 打开会话时**先用会话列表里的投影把环填上**。
 *
 * 为什么需要：dsh 在 API 侧的 session.subscribe **不回放投影**（回放只在它自家 web 客户端那条路上），
 * 所以光靠实时帧的话，你得先跟她说一句话才看得到小圈 —— 用户实测反馈就是"看不到"。
 * 而「session.list」的每一行**本来就带着** projections.values（dsh 的 SessionSummary 字段，
 * 已用真实 dsh 的 /api/session.list 逐字确认过：contextPressure / contextBreakdown / tokenUsage 都在），
 * 节点是原样透传 items 的，所以这份数字**已经在浏览器里**，只是没人看它。
 *
 * 会话还没有过任何回合时，contextPressure 是空对象 → 占用率取不到数字 → 环继续藏着
 * （这是对的：不编数字，也不显示 0%）。
 */
function applyContextFromSessionList() {
  var sessionId = state.selectedSessionId
  if (sessionId === null || sessionId === '') return
  var item = null
  for (var i = 0; i < state.sessions.length; i += 1) {
    if (sessionIdOf(state.sessions[i]) === sessionId) {
      item = state.sessions[i]
      break
    }
  }
  if (item === null || item === null || typeof item !== 'object') return
  var projections = item.projections
  var values =
    projections !== null && typeof projections === 'object' && projections.values !== null && typeof projections.values === 'object'
      ? projections.values
      : null
  if (values === null) return
  var context = state.context
  /* 已经收到过这一会话的实时帧 → 列表那份是打开那一刻的快照，不许盖回去。
     （两个 key 各自判自己的 live：小圈有实时帧进来过、计划还没有时，计划仍要补。） */
  if (!(context !== null && typeof context === 'object' && context.sessionId === sessionId && context.live === true)) {
    state.context = {
      sessionId: sessionId,
      pressure: values.contextPressure === undefined ? null : values.contextPressure,
      breakdown: values.contextBreakdown === undefined ? null : values.contextBreakdown,
      usage: values.tokenUsage === undefined ? null : values.tokenUsage,
      live: false,
    }
    renderContextRing()
  }
  /* 同一份 values 里也带着 todos（dsh 的 SessionSummary 把注册过的投影一起给）。
     不补这一次，用户得先跟她说一句话才看得到计划 —— 与上面小圈踩过的是同一个坑。
     注意**不设 live**：这是打开那一刻的快照，实时帧一到就顶掉它。 */
  var plan = state.plan
  if (!(plan !== null && typeof plan === 'object' && plan.sessionId === sessionId && plan.live === true)) {
    state.plan = {
      sessionId: sessionId,
      todos: Array.isArray(values.todos) ? values.todos : null,
      prev: null,
      prevAtMs: 0,
      live: false,
    }
    if (typeof renderQuadPlan === 'function') renderQuadPlan()
  }
}

function renderContextRing() {
  var ring = $('ctxRing')
  if (ring === null) return
  var pop = $('ctxPop')
  var occupancy = contextOccupancy()
  ring.classList.toggle('hidden', occupancy === null)
  if (occupancy === null) {
    if (pop !== null) {
      pop.classList.remove('open')
      pop.classList.add('hidden')
    }
    return
  }
  var used = formatContextTokens(occupancy.used)
  var capacity = occupancy.capacity === null ? '' : formatContextTokens(occupancy.capacity)
  var percent = occupancy.percent === null ? 0 : occupancy.percent
  ring.setAttribute('data-pct', String(percent))
  ring.style.setProperty('--ctx-pct', String(percent))
  /* 不知道容量 → 给一个"未知"的样子（斜纹），别画成 0% 让用户以为还空着 */
  ring.setAttribute('data-unknown', occupancy.percent === null ? '1' : '0')
  /* 快满（≥85%）转告警色：那是"该压缩了"的唯一提示，不能等它满了才发现 */
  ring.classList.toggle('hot', occupancy.percent !== null && occupancy.percent >= 85)
  /* 数字缺一不可时不编：不知道容量就照实说不知道 */
  ring.setAttribute(
    'title',
    occupancy.percent === null
      ? '上下文已用约 ' + used + ' token（这个模型没报容量，算不出百分比）'
      : '上下文已用约 ' + used + ' / ' + capacity + '（' + String(occupancy.percent) + '%）',
  )
  if (pop !== null && pop.classList.contains('open')) renderContextPop(pop)
}

/** 点开的那块：先给总量，再给 dsh 的估算构成（**必须标"约"** —— 三项之和 ≠ 总量） */
function renderContextPop(pop) {
  var occupancy = contextOccupancy()
  if (occupancy === null) return
  var context = state.context
  var breakdown = context !== null && typeof context === 'object' ? context.breakdown : null
  var usage = context !== null && typeof context === 'object' ? context.usage : null
  var rows = []
  rows.push('<div class="ctx-pop-row"><span>已用</span><b>约 ' + formatContextTokens(occupancy.used) + '</b></div>')
  rows.push(
    '<div class="ctx-pop-row"><span>容量</span><b>' +
      (occupancy.capacity === null ? '这个模型没报' : formatContextTokens(occupancy.capacity)) +
      '</b></div>',
  )
  if (breakdown !== null && typeof breakdown === 'object') {
    var names = ['系统提示', '工具定义', '对话内容']
    var values = [breakdown.systemTokens, breakdown.toolsTokens, breakdown.messageTokens]
    var lines = []
    for (var i = 0; i < names.length; i += 1) {
      var text = formatContextTokens(values[i])
      if (text !== '') lines.push(names[i] + ' ' + text)
    }
    if (lines.length > 0) {
      rows.push('<div class="ctx-pop-note">约：' + lines.join(' · ') + '（估算，加起来不等于总量）</div>')
    }
  }
  /* 累计用量（本会话所有回合）：环上那个百分比是"此刻占了多少"，这里回答"这一路花了多少"。
     两个数不是一回事，所以分开两行、并且**明说口径**，免得被当成同一个东西。
     缓存命中单独列：它和未命中输入的价格差一个量级，混在一起看不出钱花在哪儿。 */
  if (usage !== null && typeof usage === 'object') {
    var inParts = []
    var miss = formatContextTokens(usage.uncachedInputTokens)
    var hit = formatContextTokens(usage.cacheReadTokens)
    var write = formatContextTokens(usage.cacheWriteTokens)
    if (miss !== '') inParts.push('未命中 ' + miss)
    if (hit !== '') inParts.push('命中 ' + hit)
    if (write !== '') inParts.push('写入 ' + write)
    var outText = formatContextTokens(usage.outputTokens)
    if (inParts.length > 0 || outText !== '') {
      rows.push('<div class="ctx-pop-sep"></div>')
      if (inParts.length > 0) rows.push('<div class="ctx-pop-row"><span>累计输入</span><b>' + inParts.join(' · ') + '</b></div>')
      if (outText !== '') rows.push('<div class="ctx-pop-row"><span>累计输出</span><b>' + outText + '</b></div>')
      rows.push('<div class="ctx-pop-note">累计 = 本会话所有回合的用量；上面「已用」是此刻的占用</div>')
    }
  }
  pop.innerHTML = rows.join('')
}

function toggleContextPop() {
  var pop = $('ctxPop')
  if (pop === null) return
  var open = !pop.classList.contains('open')
  pop.classList.toggle('open', open)
  pop.classList.toggle('hidden', !open)
  if (open) renderContextPop(pop)
}

function updateChatHeader() {
  var title = $('employeeTitle')
  if (title !== null && state.selectedEmployeeId !== null) {
    var peer = state.employeeNames.get(state.selectedEmployeeId) || shortId(state.selectedEmployeeId)
    /* 正打开着一个有标题的会话时，标题区带上会话名（改名成功后这里随之同步） */
    var sessionTitle = selectedSessionTitle()
    title.textContent = sessionTitle === '' ? peer : peer + ' · ' + sessionTitle
  }
  updateChatPeerAvatar()
  /* 换了会话/员工：小圈跟着走 —— 它记的是"哪个会话的数字"，对不上就收起并等新帧 */
  renderContextRing()
  var busy = turnRunning
  var availability = '在线'
  if (state.selectedEmployeeId !== null) {
    var info = state.desk[state.selectedEmployeeId]
    if (info !== undefined && info.busy === true) busy = true
    for (var i = 0; i < state.employees.length; i += 1) {
      var employee = state.employees[i]
      if (String(employee.id || '') === state.selectedEmployeeId && employee.available === false) availability = '离线'
    }
  }
  var dot = $('chatDot')
  if (dot !== null) dot.className = 'chat-dot ' + (busy ? 'busy' : availability === '离线' ? 'off' : 'online')
  var status = $('streamState')
  if (status !== null) status.textContent = busy ? '忙碌' : availability
}

/**
 * 顶栏对方的头像（名字左边那颗）。
 *
 * 边界：这里**只放一个盒子**，取数一律走 30-office 的 avatarNode/ensureAvatar ——
 * 头像的版本判断、localStorage 缓存、缩图、占位线稿脸都在那一份里（"版本没变就一个字节都不传"
 * 这条省流量的规矩也在那儿）。这里若自己发一次 employee.avatar.get，就会分叉成
 * "工位上是新头像、顶栏还是旧的"，而且每次进聊天页都白拉几百 KB。
 *
 * 换头像后能自动跟上，靠的是 paintAvatar() 按 [data-avatar-for] 找盒子 ——
 * 那个属性在内层 avatarNode 上（**不要**在外层盒子上也写它：写了 paintAvatar 会把
 * 外层盒子当头像盒清空重填，内层的尺寸规则就没了）。所以外层只记一个 data-peer。
 */
function updateChatPeerAvatar() {
  var box = $('chatPeerAvatar')
  if (box === null) return
  var employee = state.selectedEmployeeId === null ? null : employeeById(state.selectedEmployeeId)
  if (employee === null) {
    /* 没选员工（或那位已不在列表里）：收干净 —— 留着上一任的头像比空着更糟 */
    if (box.getAttribute('data-peer') !== null) {
      clear(box)
      box.removeAttribute('data-peer')
    }
    return
  }
  if (typeof avatarNode !== 'function' || typeof ensureAvatar !== 'function') return
  var id = String(employee.id || '')
  /* 同一个人不重建：updateChatHeader 在一次回合里会被叫好几次，重建会闪 */
  if (box.getAttribute('data-peer') === id) return
  clear(box)
  box.appendChild(avatarNode(employee, 30))
  box.setAttribute('data-peer', id)
  ensureAvatar(employee)
}

/* 抽屉「高级」区的生效 preset 行：数据来自 employee.list 已带出的 agentPreset 字段
   （本地状态直读，不发额外 RPC）；有专属 preset 显示其名，否则显示「节点默认」。
   值经 textContent 落 DOM —— preset 名来自服务端，不当 HTML 拼。 */
function updateEffectivePreset() {
  var target = $('effectivePreset')
  if (target === null) return
  var text = '节点默认'
  if (state.selectedEmployeeId !== null) {
    for (var i = 0; i < state.employees.length; i += 1) {
      var employee = state.employees[i]
      if (String(employee.id || '') !== state.selectedEmployeeId) continue
      var preset = typeof employee.agentPreset === 'string' ? employee.agentPreset.trim() : ''
      if (preset !== '') text = preset
      break
    }
  }
  target.textContent = text
}

/* 空文本禁用发送（回合运行中发送键整个换成停止键，见 setRunning） */
function updateSendButton() {
  var send = $('btnSend')
  if (send === null) return
  var input = $('promptInput')
  var empty = input === null || String(input.value || '').trim() === ''
  var canPrompt = state.phase === 'ready' && state.scopes.indexOf('employee.prompt') >= 0
  send.disabled = empty || !canPrompt || state.selectedSessionId === null
}

/* 压缩按钮：员工/会话未选、回合运行中、压缩在途或连接未就绪时禁用 */
function updateCompactButton() {
  var btn = $('btnCompact')
  if (btn === null) return
  var canPrompt = state.phase === 'ready' && state.scopes.indexOf('employee.prompt') >= 0
  btn.disabled =
    compacting || turnRunning || !canPrompt ||
    state.selectedEmployeeId === null || state.selectedSessionId === null
}

/* 沉淀按钮：员工/会话未选、回合运行中、沉淀在途（防重入）或没有 employee.prompt scope 时禁用 */
function updateDistillButton() {
  var btn = $('btnDistill')
  if (btn === null) return
  var canPrompt = state.phase === 'ready' && state.scopes.indexOf('employee.prompt') >= 0
  btn.disabled =
    distilling || turnRunning || !canPrompt ||
    state.selectedEmployeeId === null || state.selectedSessionId === null
}

/* 胶囊输入框自动增高，上限约 6 行 */
function autoGrowPrompt() {
  var input = $('promptInput')
  if (input === null) return
  input.style.height = 'auto'
  input.style.height = String(Math.min(input.scrollHeight, 132)) + 'px'
  updateSendButton()
}

function onPromptKeydown(event) {
  if (event.key !== 'Enter') return
  /* 输入法组词中的 Enter 是选字，不是发送 */
  if (event.isComposing === true || event.keyCode === 229) return
  /* Shift+Enter 换行；Cmd/Ctrl+Enter 由 bindEvents 里那一份监听负责 */
  if (event.shiftKey || event.ctrlKey || event.metaKey) return
  event.preventDefault()
  sendPrompt()
}

/* 回合运行中：发送键换成停止方块（调 session.cancel） */
    function setRunning(running) {
      var wasRunning = turnRunning
      turnRunning = running
  /* 回合起止都重置看门狗：新回合重新计时，结束则不需要再盯 */
  turnLastEventAt = running === true ? Date.now() : 0
  turnStallWarned = false
  var send = $('btnSend')
  if (send !== null) send.classList.toggle('hidden', running)
  var cancel = $('btnCancel')
  if (cancel !== null) cancel.classList.toggle('hidden', !running)
  updateCompactButton()
  updateDistillButton()
  updateChatHeader()
  /* 运行→空闲即本 UI 的 turn/end 时机（live 状态帧、打断、失败复位都走这里）：
     若刚才发起了「沉淀为技能」，结算技能清单增量对比 */
  if (wasRunning === true && running === false) reconcileSkillDistill()
  /* 四宫格左上那格的文件重读时机：一轮干完她会把进度写进 board.json，
     这一刻重读最有意义（工作区没有文件变更推送，见 68-quad 的 reloadQuadFiles）。 */
  if (wasRunning === true && running === false && typeof reloadQuadFiles === 'function') reloadQuadFiles()
  /* 秘书页立绘的联动点：**只认真实的起止翻转**。
     打开会话时按 session.running 恢复按钮形态那一次也在语义上属于"她正在跑"，
     所以翻转就报；而"本来就是 false 又设一次 false"不会打扰立绘（不会把待命顶掉）。 */
  if (wasRunning !== running) stageTurn(running === true)
}

function msgRow(kind) {
  var box = renderBox()
  if (box === null) return null
  var row = el('div', 'msg ' + kind)
  box.appendChild(row)
  return row
}

function appendUserBubble(text) {
  var row = msgRow('user')
  if (row === null) return null
  var bubble = el('div', 'bubble')
  bubble.appendChild(el('div', 'bubble-text', text))
  row.appendChild(bubble)
  scrollMessages()
  /* 返回这一行：发送失败时要在它上面挂「未送达 + 重发」，而不是让用户重新打一遍 */
  return row
}

/* 流式气泡：先纯文本 + 呼吸光标（delta 可能每几十毫秒一条，重排 markdown 会闪）；
   定稿时才过一遍 renderMarkdown（finalizeStream） */
function ensureStreamBubble() {
  if (state.streamBubble !== null) return state.streamBubble
  var row = msgRow('assistant')
  if (row === null) return null
  var body = el('div', 'bubble')
  var textNode = el('div', 'bubble-text')
  body.appendChild(textNode)
  body.appendChild(el('span', 'cursor'))
  row.appendChild(body)
  state.streamBubble = { row: row, body: body, textNode: textNode, blocks: {}, text: '' }
  return state.streamBubble
}

function streamJoinedText(bubble) {
  var keys = Object.keys(bubble.blocks).sort(function (a, b) {
    return Number(a) - Number(b)
  })
  var parts = []
  for (var i = 0; i < keys.length; i += 1) parts.push(bubble.blocks[keys[i]])
  return parts.join('\n\n')
}

function refreshStreamText(bubble) {
  bubble.text = streamJoinedText(bubble)
  bubble.textNode.textContent = bubble.text
}

/* 定稿在途流式气泡：markdown 重排、去掉呼吸光标，返回定稿文本（空气泡返回 ''）。
   每个气泡只定稿一次；定稿文本计入 turnText，供 assistant/message 去重。 */
function finalizeStream(fullText) {
  var bubble = state.streamBubble
  if (bubble === null) return ''
  state.streamBubble = null
  var text = typeof fullText === 'string' && fullText !== '' ? fullText : bubble.text
  if (text === '') {
    if (bubble.row.parentNode !== null) bubble.row.parentNode.removeChild(bubble.row)
    return ''
  }
  clear(bubble.body)
  renderMarkdown(bubble.body, text)
  turnText += text
  return text
}

function appendDelta(index, text) {
  var bubble = ensureStreamBubble()
  if (bubble === null) return
  var key = String(typeof index === 'number' ? index : 0)
  bubble.blocks[key] = (bubble.blocks[key] || '') + text
  refreshStreamText(bubble)
  var status = $('streamState')
  if (status !== null && status.textContent !== '正在输入…') status.textContent = '正在输入…'
  scrollMessages()
}

/* block-end 定稿：用块的完整文本替换该块的增量后整个气泡定稿；
   没有打开的流式气泡（历史里只有块记录）时直接渲染定稿气泡 */
function assistantBlockEnd(index, text) {
  if (state.streamBubble !== null) {
    state.streamBubble.blocks[String(typeof index === 'number' ? index : 0)] = text
    refreshStreamText(state.streamBubble)
    finalizeStream()
  } else {
    var row = msgRow('assistant')
    if (row !== null) {
      var bubble = el('div', 'bubble')
      renderMarkdown(bubble, text)
      row.appendChild(bubble)
    }
    turnText += text
  }
  scrollMessages()
}

/* assistant/message 是完整消息：优先替换在途流式气泡；
   增量已渲染过同一份文本（按去空白比较）则跳过，不重复上屏 */
function assistantMessage(text) {
  if (state.streamBubble !== null) {
    finalizeStream(text)
    scrollMessages()
    return
  }
  if (turnText !== '' && squash(turnText) === squash(text)) return
  var row = msgRow('assistant')
  if (row === null) return
  var bubble = el('div', 'bubble')
  renderMarkdown(bubble, text)
  row.appendChild(bubble)
  turnText += text
  scrollMessages()
}

/* 工具卡片：工具名 + 状态一行（调用中…/已完成/失败），点标题展开/收起详情 */
function appendToolCard(n) {
  var box = renderBox()
  if (box === null) return
  /* 工具调用常夹在两个文本块之间：先定稿在途气泡，
     后续 delta 会另起一个新气泡排在这张卡片后面 */
  finalizeStream()
  var card = toolCards[n.toolId]
  if (card === undefined) {
    var row = el('div', 'msg tool')
    var body = el('div', 'tool-card')
    var head = el('div', 'tool-head')
    head.appendChild(el('span', 'tool-icon', '🔧'))
    head.appendChild(el('span', 'tool-name', n.name))
    var status = el('span', 'tool-status', '')
    head.appendChild(status)
    body.appendChild(head)
    var detail = el('pre', 'tool-detail hidden')
    body.appendChild(detail)
    head.onclick = function () {
      detail.classList.toggle('hidden')
    }
    row.appendChild(body)
    box.appendChild(row)
    card = { status: status, detail: detail, text: '' }
    toolCards[n.toolId] = card
  }
  card.status.textContent = n.phase === 'call' ? '调用中…' : n.failed ? '失败' : '已完成'
  card.status.className = 'tool-status' + (n.phase !== 'call' && n.failed ? ' bad' : '')
  if (n.detail !== '') {
    card.text = card.text === '' ? n.detail : card.text + '\n' + n.detail
    if (card.text.length > 8000) card.text = card.text.slice(0, 8000) + '\n…（截断）'
    card.detail.textContent = card.text
  }
  scrollMessages()
}

/* 回合失败 / 发送失败：内联错误条，如实显示 error.message */
function appendErrorBar(text) {
  var row = msgRow('err')
  if (row === null) return
  row.appendChild(el('div', 'err-bar', text))
  scrollMessages()
}

function appendSystem(text) {
  var box = renderBox()
  if (box === null) return
  box.appendChild(el('div', 'sys', text))
  scrollMessages()
}

function renderNormalized(n, live) {
  switch (n.kind) {
    case 'projection':
      /* 投影帧不进消息区、不碰运行态（它和消息流是两回事）：
         上下文那几个 key 只更新顶栏小圈，todos 只更新四宫格左下那格。 */
      if (n.key === 'todos') applyPlanProjection(n)
      else applyContextProjection(n)
      return
    case 'user':
      finalizeStream()
      turnText = ''
      if (lastSentText !== '' && squash(lastSentText) === squash(n.text)) {
        /* 自己刚发的 prompt 已乐观上屏，实时回声只消费一次 */
        lastSentText = ''
        return
      }
      appendUserBubble(n.text)
      return
    case 'assistant':
      /* 秘书页立绘：她开始吐字了（状态文字 → "说话中"）。**只在实时事件里喊**：
         翻历史时这条也走同一个分支，那时候立绘必须一动不动。 */
      if (live === true) stageSpeaking()
      if (n.stream === 'delta') appendDelta(n.index, n.text)
      else if (n.stream === 'block') assistantBlockEnd(n.index, n.text)
      else assistantMessage(n.text)
      return
    case 'tool':
      appendToolCard(n)
      return
    case 'status':
      finalizeStream()
      /* 历史回放不碰运行态：进会话时已按 session.running 恢复过按钮形态 */
      if (live === true) setRunning(false)
      if (n.text !== '') appendSystem(n.text)
      scrollMessages()
      return
    case 'error':
      finalizeStream()
      if (live === true) setRunning(false)
      appendErrorBar('回合失败：' + n.text)
      return
    case 'interaction':
      /* 历史回放也渲染（回看时能看到"当时卡在这里"），但不碰运行态 */
      appendInteractionNotice(n)
      return
    default:
      return /* hidden：不进对话区 */
  }
}

/**
 * 交互提示条：员工在等一个批准 / 一个回答。
 *
 * 刻意做成**内联窄条**而不是对话框 —— 真正的裁决动作在「审批」面板里（那里有
 * 全局待办计数与完整上下文），对话区只负责说明"卡在哪一步、为什么"。
 */
function appendInteractionNotice(n) {
  var box = renderBox()
  if (box === null) return
  var note = el('div', 'interaction-note' + (n.phase === 'resolved' ? ' settled' : ''))
  note.appendChild(el('span', 'interaction-icon', n.what === 'approval' ? '⏸' : '❓'))
  var body = el('div', 'interaction-body')
  body.appendChild(el('div', 'interaction-title', n.text))
  if (n.phase === 'request' && n.reason !== '') body.appendChild(el('div', 'interaction-reason', n.reason))
  if (n.phase === 'request') {
    body.appendChild(el('div', 'interaction-hint', '到「审批」面板处理（顶部标签 → 审批）'))
  }
  note.appendChild(body)
  box.appendChild(note)
  scrollMessages()
}

function breakStream() {
  finalizeStream()
  setRunning(false)
}

function onSessionEvent(payload) {
  var sessionId = payload !== null && typeof payload === 'object' && typeof payload.sessionId === 'string' ? payload.sessionId : ''
  /* Hub 转发的载荷带 employeeId（见 session.push 的归属校验）；
     老节点可能不带 —— 用订阅表反查兜底 */
  var employeeId = payload !== null && typeof payload === 'object' && typeof payload.employeeId === 'string' ? payload.employeeId : ''
  if (employeeId === '') {
    employeeId = employeeOfDeskWatch(sessionId) || (state.selectedSessionId === sessionId ? state.selectedEmployeeId : null) || ''
  }
  var n = normalizeEvent(payload)
  var inChatWith =
    state.view === 'chat' &&
    state.selectedEmployeeId !== null &&
    (employeeId === '' || employeeId === state.selectedEmployeeId)
  var isSelectedSession = state.selectedSessionId !== null && (sessionId === '' || sessionId === state.selectedSessionId)

      if (inChatWith && isSelectedSession) {
        /* 任何事件都算"员工还在动"：看门狗据此判断是否卡住 */
        turnLastEventAt = Date.now()
        turnStallWarned = false
        /* hidden 帧也可能驱动状态（turn/start → 忙碌），但永远不进对话区 */
        if (n.type === 'turn/start') setRunning(true)
    renderNormalized(n, true)
    return
  }

  /* 工位小屏与未读：小屏吃所有"正在做什么"的信号（assistant 文本、工具调用、
     回合起止，见 deskLineOf）；未读红点仍只按 assistant 定稿计（ping/状态类不算），
     自己在当前页面发的消息是 user 类，天然不会进这条分支。 */
  if (employeeId !== '') {
    var line = deskLineOf(n)
    if (line !== '') appendDeskTail(employeeId, line)
    /* 未读只按定稿计（message/block），不对每个 delta 累加，免得红点数字爆炸 */
    if (n.kind === 'assistant' && n.text !== '' && n.stream !== 'delta' && !inChatWith) bumpUnread(employeeId)
  }
}

function sendPrompt() {
  var input = $('promptInput')
  if (input === null || state.selectedEmployeeId === null || state.selectedSessionId === null) return
  var typed = String(input.value || '')
  var pending = state.attachments.slice()
  /* 只贴了文件没打字也算一条指令 —— 否则"发个表格过去"这个动作会静默失败 */
  if (typed.trim() === '' && pending.length === 0) return
  var text = typed
  if (pending.length > 0) text = withAttachmentNote(typed, pending)
  input.value = ''
  autoGrowPrompt()
  finalizeStream()
  turnText = ''
  lastSentText = text
  var row = appendUserBubble(text)
  if (pending.length > 0) appendAttachmentNote(pending)
  /* 乐观置忙碌：实时流健康时 turn/start 也会来置；失败路径会复位 */
  setRunning(true)
  deliverPrompt(text, pending, row)
}


/* ── 发送失败的处置 ──
 *
 * 旧实现有三个"看起来成功"的问题：
 *   ① 乐观上屏的气泡留在对话里，像是发出去了；
 *   ② 输入框在发送时就清空了，失败后**用户打的那段字就没了**，重试只能重新打；
 *   ③ 只在提示条里报一句英文错误，而提示条还会自己消失。
 * 现在：气泡标记「未送达」并就地给「重发这条」（复用原文与附件）。
 *
 * 另一个更微妙的问题：**超时 ≠ 没送达**（节点可能已经写进 dsh，只是响应丢了），
 * 直接重发可能让员工收到两条。所以结果未知时先查一次会话历史：这次 prompt 若已出现在
 * 历史里，就说明已送达，界面照实说、不给重发按钮。
 */

/** 该会话最近的历史里是否已经有这条 user 消息（判断"超时其实已送达"）。 */
function promptAlreadyDelivered(employeeId, sessionId, text) {
  return rpc('session.history', { employeeId: employeeId, sessionId: sessionId, maxEvents: 30 })
    .then(function (payload) {
      var events = pickArray(payload, ['events', 'items', 'messages', 'history'])
      for (var i = events.length - 1; i >= 0; i -= 1) {
        var normalized = normalizeEvent(events[i])
        if (normalized.kind !== 'user') continue
        if (squash(normalized.text) === squash(text)) return true
      }
      return false
    })
    .catch(function () {
      /* 查不到就**不假装知道**：按"未确认"处理，把决定权留给用户 */
      return null
    })
}

/** 把这一行标成「未送达」并挂上重发入口。 */

/** 节点离线但指令已进 Hub 的离线邮箱 —— 不是失败，但必须说清"还没送到"。 */
function markPromptQueued(row, payload) {
  var employeeId = state.selectedEmployeeId
  var nodeLabel = ''
  for (var i = 0; i < state.employees.length; i += 1) {
    if (String(state.employees[i].id || '') !== String(employeeId)) continue
    nodeLabel = String(state.employees[i].nodeName || '')
    break
  }
  var length = payload !== null && typeof payload === 'object' && typeof payload.queueLength === 'number' ? payload.queueLength : null
  appendSystem(
    '（节点' + (nodeLabel === '' ? '' : '「' + nodeLabel + '」') + '当前离线 —— 这条指令已排入队列' +
      (length === null ? '' : '（待发 ' + String(length) + ' 条）') +
      '，它上线后会自动送出）'
  )
  if (row === null) return
  row.classList.add('queued')
  if (row.querySelector('.msg-queued') !== null) return
  var bar = el('div', 'msg-queued', '排队中 · 节点上线后自动送出')
  row.appendChild(bar)
}

function markPromptUndelivered(row, text, pending) {
  if (row === null) return
  row.classList.add('undelivered')
  if (row.querySelector('.msg-retry') !== null) return
  var bar = el('div', 'msg-retry')
  var button = el('button', 'ghost', '重发这条')
  button.title = '上次发送失败或结果未知。若它其实已经送达，重发会让员工收到两条 —— 可以先看一眼员工是不是已经在处理了。'
  button.onclick = function (event) {
    event.stopPropagation()
    row.classList.remove('undelivered')
    if (bar.parentNode !== null) bar.parentNode.removeChild(bar)
    setRunning(true)
    deliverPrompt(text, pending, row)
  }
  bar.appendChild(button)
  row.appendChild(bar)
}

/** 发送（或重发）一条指令；row 是已经上屏的那一行，失败时就地标记它。 */
function deliverPrompt(text, pending, row) {
  var employeeId = state.selectedEmployeeId
  var sessionId = state.selectedSessionId
  if (employeeId === null || sessionId === null) return Promise.resolve()
  return ensureSubscribed()
    .then(function () {
      /* 节点侧 session.prompt 要的是纯文本 text（agent.ts 的 requireString）；
         附件另走 content 内容块（图片会被内联，模型直接看得见）。 */
      var params = {
        employeeId: employeeId,
        sessionId: sessionId,
        mode: 'queue',
        text: text
      }
      var content = buildPromptContent(text, pending)
      if (content !== null) params.content = content
      return rpc('session.prompt', params)
    })
    .then(function (payload) {
      pushRaw('session.prompt 结果', payload)
      /* 发出去了才清空 —— 失败时附件还留在待发条里，重发时一起带上 */
      state.attachments = []
      renderAttachStrip()
      /* 节点离线但指令进了离线邮箱：不是失败（会被自动送出），但也不是"已送达" */
      if (payload !== null && typeof payload === 'object' && payload.queued === true) {
        markPromptQueued(row, payload)
      }
    })
    .catch(function (error) {
      reportRpcError('session.prompt', error)
      appendSystem('（' + describeFailure('session.prompt', error) + '）')
      setRunning(false)
      var code = error !== null && typeof error === 'object' ? String(error.code || '') : ''
      /* 明确的拒绝（节点离线等）肯定没送达，不必查历史；只有"结果未知"才值得查 */
      if (code === 'node-offline') {
        markPromptUndelivered(row, text, pending)
        return
      }
      promptAlreadyDelivered(employeeId, sessionId, text).then(function (delivered) {
        if (delivered === true) {
          appendSystem('（查了一下：这条其实已经送达，员工那边应该在处理了 —— 不必重发）')
          return
        }
        markPromptUndelivered(row, text, pending)
      })
    })
}
`
