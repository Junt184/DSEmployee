/**
 * 控制台脚本片段：连接与握手 / RPC / 提示条与通知
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
export const CHUNK_20_TRANSPORT = String.raw`
/* ─────────────────── 6. 连接与握手 ─────────────────── */

function websocketUrl() {
  var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return scheme + '//' + location.host + '/ws'
}

function platformName() {
  var platform = ''
  try {
    platform = String(navigator.platform || '')
  } catch (error) {
    platform = ''
  }
  if (platform === '') platform = 'web'
  return platform.slice(0, 32)
}

/** 设备显示名自动猜：单人自用场景里"哪台设备"看平台就够了，不再要求手填。 */
function guessDisplayName() {
  var ua = ''
  try {
    ua = String(navigator.userAgent || '')
  } catch (error) {
    ua = ''
  }
  var platform = platformName()
  if (/iPhone/i.test(ua)) return 'iPhone 浏览器'
  if (/iPad/i.test(ua)) return 'iPad 浏览器'
  if (/Android/i.test(ua)) return 'Android 浏览器'
  if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) return 'Mac 浏览器'
  if (/Win/i.test(platform)) return 'Windows 浏览器'
  if (/Linux/i.test(platform)) return 'Linux 浏览器'
  return '网页控制台'
}

/* 连接时静默申请全部 operator scope：单人自用的控制台没有"只读模式"的需求，
   要发受限设备时走 dse pair approve --scopes 或配对后 token rotate 收窄。 */
function requestedScopes() {
  return ALL_SCOPES.slice()
}

function storedToken() {
  var token = readLocal(LS.token)
  if (token === null || token === '') return ''
  return String(token)
}

/* 用设备令牌换一个**页面级**凭据（HttpOnly cookie）。
 *
 * 为什么需要它：控制台页面 / 脚本 / 图标都是普通 HTTP 请求，浏览器不会在顶层导航上
 * 带设备令牌 —— 而 Hub 的「注册窗口」关掉之后，没有这个 cookie 的访问拿到的就是
 * nginx 那种 404。也就是说：**配对时窗口开着 → 顺手留下 cookie → 之后窗口关着，
 * 这台已配对的浏览器照常打得开控制台，陌生人打不开。**
 *
 * 失败不影响任何功能（WS 那条路才是功能本体），所以静默。 */
function syncSessionCookie() {
  var token = storedToken()
  if (token === '') return
  try {
    fetch('/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token })
    }).catch(function () { /* 离线或服务端拒绝：忽略 */ })
  } catch (error) { /* 没有 fetch 的老浏览器：忽略 */ }
}

/* 「清除本地令牌」的配套动作：连 cookie 一起抹掉，别留一把能开门的钥匙。 */
function dropSessionCookie() {
  try {
    fetch('/session', { method: 'DELETE' }).catch(function () { /* 忽略 */ })
  } catch (error) { /* 忽略 */ }
}

function connectNow(manual) {
  if (manual === true) state.manualClose = false
  if (state.phase === 'connecting' || state.phase === 'ready') return
  stopRetry()
  closeSocket()
  rejectAllPending('连接已重置')

  state.role = DEFAULT_ROLE
  state.scopes = requestedScopes()
  setPhase('connecting', '正在连接 ' + location.host + ' …')
  setBanner('', 'info')

  ensureIdentity().then(function (identity) {
    if (identity === null) {
      state.tokenMode = true
      if (state.phase === 'connecting') {
        setBanner(state.identityFailure + ' 若确实需要令牌模式，请粘贴设备令牌后重试。', 'warn')
      }
    } else {
      state.tokenMode = false
    }
    openSocket()
  })
}

function openSocket() {
  var socket
  try {
    socket = new WebSocket(websocketUrl())
  } catch (error) {
    setPhase('error', '无法创建 WebSocket：' + describeError(error))
    return
  }
  state.socket = socket
  state.expectClose = false

  var handshakeTimer = setTimeout(function () {
    if (state.phase === 'connecting') {
      setPhase('error', '握手超时：连接已建立但服务端未下发 challenge。')
      closeSocket()
    }
  }, 20000)

  socket.onopen = function () {
    setPhase('connecting', '已建立连接，等待服务端挑战…')
  }

  socket.onmessage = function (messageEvent) {
    onFrame(messageEvent.data)
  }

  socket.onerror = function () {
    if (state.phase === 'connecting') {
      clearTimeout(handshakeTimer)
      setPhase('error', 'WebSocket 传输错误（端口被防火墙拦截？地址写错？）')
      state.expectClose = true
    }
  }

  socket.onclose = function (closeEvent) {
    clearTimeout(handshakeTimer)
    onSocketClosed(closeEvent)
  }
}

function closeSocket() {
  var socket = state.socket
  state.socket = null
  if (socket !== null && socket !== undefined) {
    try {
      socket.close(1000, 'client closed')
    } catch (error) {
      /* 关闭失败不影响状态机 */
    }
  }
}

function onSocketClosed(closeEvent) {
  rejectAllPending('连接已关闭')
  state.subscribed = null
  breakStream()
  state.socket = null
  /* 订阅关系随连接消失（服务端按连接持有）：轮询与手表全部清零，重连后重建 */
  stopDeskPolling()
  state.desk = {}
  state.deskWatch = {}
  state.deskSig = ''

  /* 服务端在重启：这次断开（优雅关闭，或"还没起来"导致的连接失败）都要继续试。
     必须放在 expectClose 那个提前 return **之前** —— 一次失败的尝试会置 expectClose，
     放后面就等于"试一次就永久放弃"。 */
  if (state.restartPending === true) {
    /* 相位必须一起搬走：connectNow 见到 'ready' / 'connecting' 会**直接返回** ——
       只排重连而不清相位，等于排了一个永远连不回去的重连（这道修复自己踩过：
       横幅停在"正在自动重连，第 1 次…"，然后什么都没有，页面继续装死）。 */
    setPhase('closed', '服务端正在重启')
    scheduleServerRestartReconnect()
    return
  }

  if (state.expectClose) {
    /* 握手错误已经由 res 帧解释过了，这里不再覆盖提示 */
    state.expectClose = false
    return
  }
  if (state.phase === 'waiting-pair') return
  if (state.phase === 'ready') {
    setPhase('closed', '连接已断开（code ' + String(closeEvent.code) + '）')
    if (state.manualClose !== true) {
      setBanner('连接意外断开，3 秒后自动重连。', 'warn')
      scheduleReconnect(3000)
    }
    return
  }
  if (state.phase === 'connecting') {
    setPhase('error', '服务端关闭了连接（code ' + String(closeEvent.code) + '）。')
    return
  }
  setPhase('closed', '已断开')
}

function scheduleReconnect(delayMs) {
  if (state.reconnectTimer !== null) clearTimeout(state.reconnectTimer)
  state.reconnectTimer = setTimeout(function () {
    state.reconnectTimer = null
    connectNow()
  }, delayMs)
}

/* 服务端重启后的自动重连。
 *
 * 为什么单独有一套：shutdown 事件是**服务端要重启**（部署完 / systemctl restart），
 * 不是"用户按了断开"。可旧实现把它塞进 state.manualClose，而 onSocketClosed 恰恰
 * 用 manualClose 判断"要不要重连" —— 于是收到 shutdown 之后**再也不重连**：
 * 页面停在"服务端正在关闭。"，审批推送收不到、点击发不出去，在人眼里就是
 * "这页不更新了/点了没用"（真实事故：hub 部署完，开着的控制台一直是死的，
 * 直到手动刷新）。hub 重启只要几秒，必须自己爬起来。
 *
 * 重启期间"连不上"是正常的（服务端还在启），所以失败的尝试**不能**终止重试 ——
 * 试满上限才放弃，并明确叫人刷新，而不是留着一条看不出死活的横幅。 */
var SERVER_RESTART_RETRY_MAX = 20

/** 重连节奏：前两次 2 秒（hub 重启很快），之后 5 秒；返回 0 = 放弃（纯函数，便于测试）。 */
function restartReconnectDelay(tries) {
  var count = Number(tries)
  if (!isFinite(count) || count < 1) return 2000
  if (count > SERVER_RESTART_RETRY_MAX) return 0
  return count < 3 ? 2000 : 5000
}

function scheduleServerRestartReconnect() {
  state.restartTries = Number(state.restartTries || 0) + 1
  var delay = restartReconnectDelay(state.restartTries)
  if (delay === 0) {
    state.restartPending = false
    setBanner(
      '服务端重启后一直连不上（已试 ' +
        String(state.restartTries - 1) +
        ' 次）。刷新页面重试，或到服务器上看一眼 dse-hub 是不是没起来。',
      'bad',
    )
    return
  }
  setBanner(
    '服务端正在重启（部署 / 重启 hub）—— 正在自动重连，第 ' + String(state.restartTries) + ' 次…',
    'warn',
  )
  scheduleReconnect(delay)
}

/* 连接存活性看门狗。
 *
 * 为什么必须有：公网反代（nginx 反代 wss）下连接会"半开"——实际已断，
 * 但两端 TCP 都以为还活着，永远没有 close 事件。页面看起来「已连接」，
 * 所有 rpc 却在往虚空里发、逐个 30s 超时（线上真实事故：create 的响应
 * 就断在这一环，此后整连接瘫痪）。Hub 每 15s 发一次 tick；超过 2.5 个
 * 心跳间隔没有任何帧进来，就判定连接已死，走正常的断线重连路径。 */

/** 回合卡死检测：只在"回合在跑 + 长时间无事件"时提示一次，并给出可执行的下一步。 */
function checkTurnWatchdog() {
  if (turnRunning !== true || turnStallWarned === true || turnLastEventAt === 0) return
  var idleMs = Date.now() - turnLastEventAt
  if (idleMs < TURN_STALL_MS) return
  turnStallWarned = true
  var minutes = Math.round(idleMs / 60000)
  var nodeOffline = false
  for (var i = 0; i < state.employees.length; i += 1) {
    if (String(state.employees[i].id || '') !== String(state.selectedEmployeeId)) continue
    nodeOffline = state.employees[i].nodeOnline === false
    break
  }
  appendSystem(
    '（已经 ' + String(minutes) + ' 分钟没有来自员工的输出了 —— ' +
      (nodeOffline ? '该员工的节点当前离线，' : '') +
      '可能卡住了。可以点「停止」后再发一次；也可能是模型或网络在抖动。' +
      '（这条只提示一次））'
  )
}

function livenessCheck() {
  if (state.phase !== 'ready') return
  var interval = 15000
  if (
    state.hello !== null &&
    typeof state.hello === 'object' &&
    state.hello.policy !== undefined &&
    typeof state.hello.policy.tickIntervalMs === 'number'
  ) {
    interval = state.hello.policy.tickIntervalMs
  }
  checkTurnWatchdog()
  if (Date.now() - state.lastTickAt < interval * 2.5) return
  /* 不指望 socket 的关闭握手（半开连接上它可能永远不来）——
     直接搬状态机：关 socket、置相位、3 秒后重连 */
  pushRaw('心跳超时，判定连接已死', { lastTickAt: state.lastTickAt, interval: interval })
  closeSocket()
  setPhase('closed', '心跳超时')
  setBanner('连接心跳超时（代理或网络中断），3 秒后自动重连。', 'warn')
  scheduleReconnect(3000)
}

function stopRetry() {
  if (state.retryTimer !== null) {
    clearTimeout(state.retryTimer)
    state.retryTimer = null
  }
  if (state.reconnectTimer !== null) {
    clearTimeout(state.reconnectTimer)
    state.reconnectTimer = null
  }
}

function onFrame(raw) {
  /* 任何帧都算"连接还活着"的证据 —— livenessCheck 就靠这个判定半开连接 */
  state.lastTickAt = Date.now()
  var frame
  try {
    frame = JSON.parse(raw)
  } catch (error) {
    pushRaw('非 JSON 帧', String(raw))
    return
  }
  if (frame === null || typeof frame !== 'object') return
  if (frame.type === 'res') onResponse(frame)
  else if (frame.type === 'event') onEvent(frame)
  else if (frame.type === 'req') pushRaw('服务端主动请求（当前协议未使用）', frame)
  else pushRaw('未知帧类型', frame)
}

function onEvent(frame) {
  var event = String(frame.event || '')
  var payload = frame.payload === undefined ? {} : frame.payload
  if (event === 'tick') {
    /* onFrame 已把任何帧计入存活性；tick 本身无需进原始日志 */
    return
  }
  pushRaw('event ' + event, payload)

  if (event === 'challenge') {
    sendConnect(payload)
    return
  }
  if (event === 'session.event') {
    onSessionEvent(payload)
    return
  }
  if (event === 'approval.requested') {
    notify('新的审批请求', approvalSummaryText(payload))
    loadApprovals()
    return
  }
  if (event === 'approval.resolved') {
    loadApprovals()
    /* 状态有五种，不能把 approved 之外的一律念成"拒绝"：
       hub 把裁决回填给 dsh 失败时会把这条标成 cancelled —— 那是"裁决记下了、但员工
       那一轮还挂着"，跟"你拒绝了"是两件完全不同的事，报错方向刚好相反。 */
    var resolvedStatus = String(payload.status || '')
    var resolvedByMe =
      state.identity !== null &&
      state.identity !== undefined &&
      String(state.identity.deviceId || '') === String(payload.resolvedBy || '')
    if (resolvedStatus === 'cancelled') {
      toast('这条审批的裁决没能回填给员工 —— 他那一轮可能还挂着，去聊天里看一眼', 'bad')
    } else if (resolvedByMe) {
      /* 自己刚点的那一下已经由 resolveApproval 报过了，别念两遍 */
    } else if (resolvedStatus === 'approved') {
      toast('审批已批准', 'info')
    } else if (resolvedStatus === 'denied') {
      toast('审批已拒绝', 'info')
    } else if (resolvedStatus === 'answered') {
      toast('提问已回答', 'info')
    } else {
      toast('审批状态已更新：' + resolvedStatus, 'info')
    }
    return
  }
  if (event === 'pair.requested') {
    notify('有设备请求配对', deviceRequestText(payload))
    loadDevices()
    return
  }
  if (event === 'pair.resolved') {
    loadDevices()
    return
  }
  if (event === 'employee.changed' || event === 'node.changed') {
    /* loadEmployees 收尾时会比对在线状态：选中的那位从离线变回在线就重接会话
       （见 noteNodeOnline —— 判据是"翻转那一次"，不是"每次事件都清屏重读"）。 */
    loadEmployees()
    /* 岗位卡片开着的话跟着重绘（人数/未使用状态会变） */
    var positionsCard = $('cardPositions')
    if (positionsCard !== null && positionsCard.open === true) renderPositionAdmin()
    /* 正停在体检页就顺手刷新（不在这一页一律不拉，避免常态开销） */
    if (state.view === 'health') refreshHealth()
    return
  }
  if (event === 'job.changed' || event === 'job.ran') {
    /* 正停在定时页就顺手刷新（不在这一页一律不拉，避免常态开销） */
    if (state.view === 'jobs') loadJobs()
    return
  }
  if (event === 'office.order.changed') {
    /* 另一台设备调了办公室座次：拉最新偏好重绘 */
    loadOfficeOrder()
    return
  }
  if (event === 'shutdown') {
    /* 服务端要重启 —— **不是**"用户要求断开"。以前这里置 manualClose，于是 onSocketClosed
       判定"不要重连"：页面从此停在"服务端正在关闭。"，推送与点击全哑，在人眼里就是
       "这页不更新了"（真实事故：hub 部署完，开着的控制台一直是死的，直到手动刷新）。 */
    state.restartPending = true
    state.restartTries = 0
    pushRaw('服务端 shutdown：转入自动重连', { at: Date.now() })
    setBanner('服务端正在重启（部署 / 重启 hub）—— 会自动重连，不用刷新。', 'warn')
    return
  }
}

function sendConnect(challenge) {
  var nonce = challenge !== null && typeof challenge === 'object' ? String(challenge.nonce || '') : ''
  if (nonce === '') {
    setPhase('error', 'challenge 帧缺少 nonce，无法完成握手。')
    return
  }
  var platform = platformName()
  var displayName = guessDisplayName()
  var scopes = state.scopes.slice()

  var identity = state.identity
  var build
  if (identity === null) {
    /* 令牌模式：服务端 connectParamsSchema 目前**强制**要求 device 证明，
       因此这里刻意不带 device，让服务端把原因明确报回来（而不是伪造一个假签名）。 */
    build = Promise.resolve(null)
  } else {
    var signedAt = Date.now()
    var canonical = canonicalConnectPayload({
      deviceId: identity.deviceId,
      clientId: CLIENT_ID,
      role: state.role,
      scopes: scopes,
      nonce: nonce,
      signedAt: signedAt,
      platform: platform
    })
    build = signPayload(canonical).then(function (signature) {
      return {
        id: identity.deviceId,
        publicKey: bytesToBase64Url(identity.spkiDer),
        signature: signature,
        signedAt: signedAt,
        nonce: nonce
      }
    })
  }

  build
    .then(function (deviceProof) {
      var token = storedToken()
      var params = {
        protocol: PROTOCOL_VERSION,
        client: {
          id: CLIENT_ID,
          version: CLIENT_VERSION,
          /* 界面指纹随连接上报：Hub 日志里就能看出"这台设备跑的是哪一版脚本"，
             不必去设备前看屏幕。它不参与签名载荷（签名只覆盖 clientId） */
          ui: UI_VERSION,
          platform: platform,
          mode: state.role,
          displayName: displayName
        },
        role: state.role,
        scopes: scopes
      }
      if (deviceProof !== null) params.device = deviceProof
      if (token !== '') params.auth = { token: token }
      return rpc('connect', params, { id: 'connect', timeoutMs: 20000 })
    })
    .then(function (payload) {
      onHelloOk(payload)
    })
    .catch(function (error) {
      onConnectFailure(error)
    })
}

function onHelloOk(payload) {
  if (payload === null || typeof payload !== 'object' || payload.type !== 'hello-ok') {
    state.expectClose = true
    setPhase('error', '服务端响应不是 hello-ok：' + safeJson(payload).slice(0, 400))
    closeSocket()
    return
  }
  state.hello = payload
  state.phase = 'ready'
  state.manualClose = false
  /* 连上了：重启重连的计数与标志清零（异常路径靠它不误报"还在重启"） */
  state.restartPending = false
  state.restartTries = 0
  state.pairing = null
  state.authGateForced = false
  setAuthError('')
  state.role = typeof payload.auth === 'object' && payload.auth !== null ? String(payload.auth.role || DEFAULT_ROLE) : DEFAULT_ROLE
  state.scopes = Array.isArray(payload.auth && payload.auth.scopes) ? payload.auth.scopes.slice() : []

  var token = payload.auth && typeof payload.auth.deviceToken === 'string' ? payload.auth.deviceToken : ''
  if (token !== '') {
    writeLocal(LS.token, token)
    if (state.identity !== null) writeLocal(LS.tokenDevice, state.identity.deviceId)
    showTokenPanel(token, '首次配对成功：这是本设备的令牌', '服务端只保留其哈希，「无法再次显示」。请立刻保存（已在浏览器本地留存，但换浏览器 / 清站点数据就没了）。')
  }
  /* 每次连上都会来换一次（令牌轮换后 cookie 也跟着更新）。必须在令牌写入之后 —— 
     首次配对成功那一瞬间就是唯一一次"窗口开着"的机会，错过就得再开一次窗口。 */
  syncSessionCookie()

  setBanner('', 'info')
  setPhase('ready', '已连接 ' + location.host + (state.tokenMode ? '（令牌模式）' : ''))
  /* 服务器认为本页脚本过期（部署后一直开着的标签页就是这样：只重连、不重取 JS）——
     页面上必须自曝，否则"修好了"和"没修"在人眼里一模一样。见 applyServerUiVersion。 */
  if (payload.ui !== undefined && payload.ui !== null && typeof payload.ui === 'object') {
    applyServerUiVersion(payload.ui.hub)
  }
  /* toast 只报用户关心的事：连接成功三个字就够，hub id / role / 心跳参数不弹 */
  toast('已连接', 'ok')

  /* 等目录到位再恢复；期间的用户选择优先于重连前的快照。 */
  var restoringEmployee = state.selectedEmployeeId
  var restoringSession = state.selectedSessionId
  var restoringSelection = state.employeeSelectionVersion
  var restoringOpen = state.sessionOpenVersion
  var restoringView = state.view
  loadEmployees().then(function () {
    if (state.phase !== 'ready') return
    /* 启动时这些页面尚未联网；目录到位后补拉当前页面。 */
    if (state.view === restoringView && ['officeRoom', 'jobs', 'health', 'llm'].indexOf(restoringView) >= 0) {
      VIEW_LOADERS[restoringView]()
    }
    if (state.phase !== 'ready' || state.selectedEmployeeId !== restoringEmployee ||
        state.employeeSelectionVersion !== restoringSelection || state.sessionOpenVersion !== restoringOpen) return
    if (restoringEmployee === null || employeeById(restoringEmployee) === null) return
    if (restoringSession === null) {
      if (state.view === 'chat') return selectEmployee(restoringEmployee)
      return
    }
    return loadSessions().then(function () {
      if (state.phase !== 'ready' || state.selectedEmployeeId !== restoringEmployee ||
          state.selectedSessionId !== restoringSession || state.employeeSelectionVersion !== restoringSelection ||
          state.sessionOpenVersion !== restoringOpen) return
      return openSession(restoringSession)
    })
  })
  loadApprovals()
  loadOfficeOrder()
  if (state.scopes.indexOf('device.pair') >= 0) {
    loadDevices()
    loadPairingWindow()
  }
  /* 工位忙碌状态轮询：进主页后启动，断线即停 */
  startDeskPolling()
  /* 补拉右栏快照 —— 这一行修的是一个**真实的卡死**（本地实测复现）：
     loadEmployeeAside 里有一条 phase !== 'ready' 就 return 的早退，而"点工位"可能
     早于连接就绪（页面刚打开就点、或重连中点击）。那一刻它会**建好空快照就返回**，
     之后再没有人叫它 —— 于是「专属技能」与「工作区交付物」永远停在「正在载入…」，
     而四宫格右上那格读的是同一份快照，一起停。只有刷新页面才能好。
     这里只在"已选员工但快照还没拿到数据"时补一次，避免每次重连都白拉两遍。 */
  var aside = state.aside
  if (
    aside !== null &&
    typeof aside === 'object' &&
    state.selectedEmployeeId !== null &&
    (aside.skills === null || aside.files === null)
  ) {
    loadEmployeeAside()
  }
}

/** 握手失败：把 code / message / details 显式摊开，并按错误码给出可执行的下一步。 */
function onConnectFailure(error) {
  var code = error !== null && typeof error === 'object' ? String(error.code || '') : ''
  var message = error !== null && typeof error === 'object' ? String(error.message || '') : String(error)
  var details = error !== null && typeof error === 'object' && error.details !== undefined ? error.details : null
  state.expectClose = true
  closeSocket()
  pushRaw('connect 失败', error)
  stopRetry()

  if (code === 'pairing-required') {
    var requestId = details !== null && typeof details === 'object' ? String(details.requestId || '') : ''
    state.pairing = { requestId: requestId }
    setPhase('waiting-pair', '等待授权')
    /* 全屏授权页接管交互（syncAuthGate 由 setPhase 触发）；这里只留钳制警告 */
    if (details !== null && typeof details === 'object' && Array.isArray(details.clampedScopes) && details.clampedScopes.length > 0) {
      setAuthError('注意：以下越权的 scope 已被服务端裁掉：' + details.clampedScopes.join(', '))
    }
    /* 持续重试：另一台已授权设备在「设备」面板批准后，下一次重试就会直接领令牌进来 */
    schedulePairRetry()
    return
  }

  if (code === 'auth-mismatch') {
    /* 本设备已配对但令牌不对/缺失：恢复路径是「管理员移除配对记录 → 重新走配对码」，
       因此同样亮授权页，把说明放在那里而不是一条一闪而过的 banner。 */
    state.authGateForced = true
    setPhase('error', '认证不匹配')
    setAuthError(
      '令牌不匹配或缺失：' +
        message +
        '。请在已授权设备的「设备」面板移除本设备的配对记录（或轮换令牌），然后点下方「清除本地令牌并重新配对」。'
    )
    return
  }

  if (code === 'token-revoked') {
    state.authGateForced = true
    setPhase('error', '令牌已被吊销')
    setAuthError(
      '令牌已被吊销：服务端保留了配对记录但令牌已作废。请在已授权设备的「设备」面板移除本设备的配对记录，然后点下方「清除本地令牌并重新配对」。'
    )
    return
  }

  if (code === 'device-signature-invalid') {
    setPhase('error', '设备签名校验失败')
    setBanner(
      '设备签名校验失败：' + message + '。最常见原因是本机时钟与服务端相差超过 ±2 分钟（signedAt 超出窗口），请先校准系统时间；其次是本地密钥已损坏 —— 可用「设备」卡片底部的「重置设备密钥」重新生成后重新配对。',
      'bad'
    )
    return
  }

  if (code === 'challenge-invalid') {
    setPhase('error', '挑战已失效')
    setBanner('挑战 nonce 已失效（可能超时或被复用），3 秒后自动重试。', 'warn')
    scheduleReconnect(3000)
    return
  }

  if (code === 'bad-request') {
    setPhase('error', '请求被拒绝')
    var extra = ''
    if (state.identity === null) {
      extra =
        ' 当前处于「令牌模式」：服务端的 connect 参数要求 Ed25519 设备证明（device 字段），仅凭令牌无法完成握手。请改用 https:// 或 http://localhost 打开控制台以启用 WebCrypto。'
    }
    setBanner('请求不合法（bad-request）：' + message + '。' + extra, 'bad')
    if (details !== null) pushRaw('bad-request details', details)
    return
  }

  setPhase('error', '握手失败：' + (code || 'unknown'))
  setBanner('握手失败 [' + (code || 'unknown') + '] ' + message, 'bad')
  if (details !== null) pushRaw('握手失败 details', details)
}

function schedulePairRetry() {
  if (state.retryTimer !== null) clearTimeout(state.retryTimer)
  state.retryTimer = setTimeout(function () {
    state.retryTimer = null
    /* 配对是在**另一次**连接上被批准的；本设备重连时服务端才会下发令牌 */
    connectNow()
  }, 3000)
}

/** 配对码错误 → 面向人的一句话。细分原因在 details.reason（见 handlers.ts）。 */
function redeemErrorText(error) {
  var message = error !== null && typeof error === 'object' ? String(error.message || '') : String(error)
  var reason =
    error !== null && typeof error === 'object' && error.details !== null && typeof error.details === 'object'
      ? String(error.details.reason || '')
      : ''
  if (reason === 'wrong') return '配对码不正确，请核对后重试'
  if (reason === 'expired') return '配对码已过期：请在 Hub 上重新生成（dse pair-code）'
  if (reason === 'used') return '配对码已被使用：每个码只能授权一台设备，请重新生成'
  if (reason === 'no-code') return '本 Hub 尚未生成配对码：请在 Hub 本机执行 dse pair-code'
  if (reason === 'rate-limited') return '尝试次数过多，请一分钟后再试'
  return message === '' ? '授权失败' : message
}

/**
 * 用配对码授权本设备。
 *
 * device.pair.redeem 在**未认证**阶段受理（server.ts 的握手分支），
 * 因此这里开一条独立的一次性 socket，不打断主连接 3 秒一次的重试循环。
 * 成功后令牌仍要靠一次完整签名握手领取 —— 直接重连即可。
 */
function redeemPairCode() {
  var input = $('pairCodeInput')
  var code = input === null ? '' : String(input.value || '').trim()
  if (!/^\d{6}$/.test(code)) {
    setAuthError('请输入 6 位数字配对码')
    return
  }
  var requestId = state.pairing !== null ? String(state.pairing.requestId || '') : ''
  if (requestId === '') {
    setAuthError('配对请求 ID 还没拿到，请稍等（页面正在自动重试）')
    return
  }
  setAuthError('正在校验配对码…')

  var socket
  try {
    socket = new WebSocket(websocketUrl())
  } catch (error) {
    setAuthError('无法建立连接：' + describeError(error))
    return
  }
  var done = false
  var finish = function (message) {
    if (done) return
    done = true
    try {
      socket.close()
    } catch (error) {
      /* 忽略 */
    }
    if (message !== null) setAuthError(message)
  }
  socket.onopen = function () {
    socket.send(
      JSON.stringify({
        type: 'req',
        id: 'redeem',
        method: 'device.pair.redeem',
        params: { requestId: requestId, code: code }
      })
    )
  }
  socket.onmessage = function (messageEvent) {
    var frame
    try {
      frame = JSON.parse(messageEvent.data)
    } catch (error) {
      return
    }
    /* 握手前的 challenge 事件与本请求无关，跳过 */
    if (frame === null || typeof frame !== 'object' || frame.type !== 'res' || frame.id !== 'redeem') return
    if (frame.ok === true) {
      finish(null)
      toast('授权成功，正在进入…', 'ok')
      connectNow(true)
      return
    }
    finish(redeemErrorText(frame.error))
  }
  socket.onerror = function () {
    finish('连接失败（配对码通道）')
  }
  socket.onclose = function () {
    finish('连接被关闭（配对码通道）')
  }
}

/* ─────────────────── 7. RPC ─────────────────── */

function rpc(method, params, options) {
  var opts = options === undefined || options === null ? {} : options
  return new Promise(function (resolve, reject) {
    var socket = state.socket
    if (socket === null || socket.readyState !== 1) {
      reject({ code: 'ws-closed', message: 'WebSocket 未连接' })
      return
    }
    var id = opts.id === undefined ? method + '-' + String((state.seq += 1)) : String(opts.id)
    var frame = { type: 'req', id: id, method: method, params: params === undefined ? {} : params }
    if (IDEMPOTENT_METHODS[method] === true) {
      frame.idempotencyKey = opts.idempotencyKey === undefined ? randomId() : String(opts.idempotencyKey)
    }
    var timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30000
    var timer = setTimeout(function () {
      if (state.pending.has(id)) {
        state.pending.delete(id)
        reject({ code: 'timeout', message: '请求超时（' + method + '，' + String(timeoutMs) + 'ms）' })
      }
    }, timeoutMs)

    /* 自愈兜底：万一 IDEMPOTENT_METHODS 漏了某个方法，服务端会回
       idempotency-key-required。那个错误是在**派发之前**返回的（没有任何副作用），
       所以补一个键重发一次是安全的 —— 与其让整条功能静默不可用，不如自愈。

       约定：本函数返回 **true = "我已接管这次失败，正在等重发后的应答"**，
       调用方（onResponse）据此**保留挂账与超时**。这条约定不是装饰：
       onResponse 在 reject 之前就已经把这个 id 从 pending 里删掉、并清掉了超时定时器，
       所以重发时若不同时把 id 放回去，回来的应答会被当成"未匹配的响应"丢掉 ——
       于是这个 Promise **既不 resolve 也不 reject，永久挂起**（超时也已被清掉）。
       旧实现正是这样：自愈没把功能救回来，反而把"报一条错"变成了"卡死"。
       由 test/ui-rpc-selfheal.test.ts 用真实源码盯着（hangs = 测试失败）。 */
    var wrappedResolve = function (payload) {
      resolve(payload)
    }
    var wrappedReject = function (error) {
      var code = error !== null && typeof error === 'object' ? String(error.code || '') : ''
      if (code === 'idempotency-key-required' && frame.idempotencyKey === undefined) {
        frame.idempotencyKey = randomId()
        pushRaw('rpc 自愈：补幂等键重发 ' + method, { method: method })
        try {
          socket.send(JSON.stringify(frame))
        } catch (sendError) {
          reject({ code: 'ws-send-failed', message: describeError(sendError) })
          return false
        }
        /* 重新入册：id 与超时都要还在，重发的应答才有人接 */
        state.pending.set(id, { resolve: wrappedResolve, reject: wrappedReject, timer: timer })
        return true
      }
      reject(error)
      return false
    }

    state.pending.set(id, { resolve: wrappedResolve, reject: wrappedReject, timer: timer })
    try {
      socket.send(JSON.stringify(frame))
    } catch (error) {
      clearTimeout(timer)
      state.pending.delete(id)
      reject({ code: 'ws-send-failed', message: describeError(error) })
    }
  })
}

function onResponse(frame) {
  var id = String(frame.id || '')
  var waiter = state.pending.get(id)
  if (waiter === undefined) {
    pushRaw('未匹配的响应 ' + id, frame)
    return
  }
  if (frame.ok === true) {
    state.pending.delete(id)
    clearTimeout(waiter.timer)
    waiter.resolve(frame.payload === undefined ? {} : frame.payload)
    return
  }
  var error =
    frame.error === undefined || frame.error === null ? { code: 'internal', message: '未知错误' } : frame.error
  /* waiter.reject 返回 true = 它已接管这次失败（自愈重发中）：**不要**出册、不要清超时 ——
     重发的应答还要靠这个挂账接上（见 rpc() 里 wrappedReject 的注释）。 */
  if (waiter.reject(error) === true) return
  state.pending.delete(id)
  clearTimeout(waiter.timer)
}

function rejectAllPending(reason) {
  state.pending.forEach(function (waiter) {
    clearTimeout(waiter.timer)
    waiter.reject({ code: 'ws-closed', message: reason })
  })
  state.pending.clear()
}

/** 统一处理 RPC 失败：原因落提示条（去技术编号），原始错误进原始日志。 */

/* ── 把失败翻成人话 ──
 *
 * 最常遇到的失败是"节点离线"，而它的原始 message 是：
 *   node 740fbeb3652bb58b78349541f855019c7219e659e9217f08cfcd8ef95f9823b2 is not connected
 * 一串 64 位十六进制 + 英文，出现在提示条里既看不懂、也不知道下一步该做什么。
 * 而这条消息里恰好带着**节点 id** —— 拿它反查节点名（employee.list 带回了 nodeName），
 * 就能说成人话；顺带把"哪个员工的指令没发出去"补上（仅当选中员工正好在那台节点上，
 * 避免张冠李戴：employee.create 之类的调用未必针对当前选中的员工）。
 */

/** 任何漏出来的长 id 都截断：免得 64 位十六进制糊满提示条。 */
function shortenIds(text) {
  return String(text).replace(/[0-9a-f]{16,}/g, function (id) {
    return id.slice(0, 8) + '…'
  })
}

/** 从 node-offline 的原始消息里取节点 id，反查节点名；查不到就退回短 id。 */
function nodeLabelFromOfflineMessage(message) {
  var match = String(message).match(/node ([0-9a-f]{16,})/)
  if (match === null) return ''
  var nodeId = match[1]
  for (var i = 0; i < state.employees.length; i += 1) {
    var employee = state.employees[i]
    if (String(employee.nodeId || '') !== nodeId) continue
    var name = typeof employee.nodeName === 'string' ? employee.nodeName : ''
    if (name !== '') return name
  }
  return nodeId.slice(0, 8) + '…'
}

/** 选中的员工是否就在这台节点上（是则把名字写进提示，让"谁没发出去"一目了然）。 */
function selectedEmployeeOnNode(nodeLabel) {
  if (nodeLabel === '' || state.selectedEmployeeId === null) return ''
  for (var i = 0; i < state.employees.length; i += 1) {
    var employee = state.employees[i]
    if (String(employee.id || '') !== state.selectedEmployeeId) continue
    return String(employee.nodeName || '') === nodeLabel ? String(employee.name || '') : ''
  }
  return ''
}

/** 选中员工所在节点当前在线吗。员工不在列表里（还没上报）算"不在线" —— 宁可保守。 */
function selectedNodeOnline() {
  if (state.selectedEmployeeId === null) return false
  for (var i = 0; i < state.employees.length; i += 1) {
    if (String(state.employees[i].id || '') !== String(state.selectedEmployeeId)) continue
    return state.employees[i].nodeOnline !== false
  }
  return false
}

/**
 * 节点离线时，能不能沿用"上次打开的那个会话"？
 *
 * 为什么需要：会话 id 是节点的事实，页面刷新后就没了。而节点离线时
 * session.list / session.create 都拉不动 —— 于是 state.selectedSessionId
 * 永远是 null，发送键一直灰着，"先排队"这条路在门口就断了（真机验证过：
 * 只有"会话已经开着、节点才掉线"这一种情形能排队）。
 *
 * 只在**节点确实离线**时沿用：在线时列表为空说明会话真的没了（被删了），
 * 这时复活一个本地记下的死 id，只会让指令排进队列、上线后投递失败。
 * 返回空串表示"不沿用，走原来的路"。
 */
function adoptOfflineSession(sessions, nodeOnline, remembered) {
  if (nodeOnline === true) return ''
  if (Array.isArray(sessions) && sessions.length > 0) return ''
  return typeof remembered === 'string' ? remembered : ''
}

/** 节点离线时，这句话该说"什么没能完成"。键是方法名（reportRpcError 的第一个参数）。 */
var OFFLINE_ACTION_LABELS = {
  'session.list': '会话列表',
  'session.create': '新建会话',
  'session.history': '历史消息',
  'session.rename': '重命名会话',
  'session.archive': '归档或恢复会话',
  'session.subscribe': '会话订阅',
  'session.cancel': '停止回合',
  'session.compact': '压缩会话',
  'employee.list': '员工列表',
  'employee.create': '新建员工',
  'employee.update': '改员工信息',
  'employee.remove': '删除员工',
  'employee.invoke': '员工调用',
  'employee.avatar.set': '换头像',
  'employee.avatar.remove': '移除头像',
  'employee.files.upload': '发文件',
  'employee.llm.get': '读模型配置',
  'employee.llm.set': '改模型配置',
  'employee.llm.probe': '探测模型',
  'employee.skills.list': '读技能台账',
  'node.list': '节点状态',
  'position.list': '岗位目录',
  'position.upsert': '保存岗位',
  'position.remove': '删除岗位',
  'office.order.get': '读座次',
  'office.order.set': '保存座次'
}

/** 统一的失败文案。node-offline 走人话分支，其余保留"方法名 + 原因"（把长 id 截断）。 */
function describeFailure(title, error) {
  var code = error !== null && typeof error === 'object' ? String(error.code || '') : ''
  var raw = error !== null && typeof error === 'object' ? String(error.message || '') : String(error)
  if (code === 'node-offline') {
    /* 节点名必须从**原始**消息里取：那里面才是完整的 64 位 nodeId。
       （这条踩过：先 shortenIds() 再取 id，于是正则永远匹配不到 —— 界面上只剩"这个操作"。） */
    var nodeLabel = nodeLabelFromOfflineMessage(raw)
    var where = nodeLabel === '' ? '' : '：节点「' + nodeLabel + '」当前离线'
    /* 这句话曾经一律说成「「某人」的指令没有发出去」。可是节点离线时失败的常常**不是发指令**
       （刷新页面就是：session.list 拉不到、session.create 建不了），那句话会把人引到
       "我的消息是不是丢了"，而真正的事是"这一步没做成"。所以按动作分两种说法。 */
    if (title !== 'session.prompt') {
      var action = OFFLINE_ACTION_LABELS[title] === undefined ? String(title) : OFFLINE_ACTION_LABELS[title]
      return action + '没能完成' + where + ' —— 等节点上线后重试即可。'
    }
    var who = selectedEmployeeOnNode(nodeLabel)
    var subject = who === '' ? '这个操作' : '「' + who + '」的指令'
    return subject + '没有发出去' + where + ' —— 等节点上线后重试即可。'
  }
  return title + ' 失败：' + shortenIds(raw)
}

function reportRpcError(title, error) {
  /* 原始错误照旧进原始日志（?debug=1 面板），给人看的那条走 describeFailure */
  pushRaw(title + ' 失败', error)
  toast(describeFailure(title, error), 'bad')
  return error
}

/* 点击处理里抛出的异常**默认谁都看不见** —— 浏览器只把它丢给 window.onerror，
 * 而页面上的表现就是"这个按钮点了没反应"。线上真实事故：审批按钮里一个
 * undefined.slice 让"通过"静默失效了很久，没有提示、没有请求、控制台也不报错，
 * 人只能得出"页面没刷新"的结论。
 *
 * 兜底把它变成看得见的红条，并保证原始日志里有完整堆栈。提示最多 3 次（一个循环里
 * 的异常不该刷满屏幕），原始日志始终记全。 */
var UI_ERROR_TRAP_MAX = 3
var uiErrorTrapShown = 0

function noteUiError(title, detail, error) {
  pushRaw(title, { detail: detail, error: error })
  if (uiErrorTrapShown >= UI_ERROR_TRAP_MAX) return
  uiErrorTrapShown += 1
  var tail = uiErrorTrapShown >= UI_ERROR_TRAP_MAX ? '（这类提示最多 3 次，之后只进 ?debug=1 的原始日志）' : ''
  toast(
    title + (detail === '' ? '' : '：' + detail) + ' —— 刚才那一下可能没生效，刷新页面再试。' + tail,
    'bad',
  )
}

function installUiErrorTrap() {
  window.addEventListener('error', function (event) {
    var target = event === null || event === undefined ? null : event.target
    var resource = ''
    if (target !== null && target !== undefined && target !== window && target !== document) {
      resource = String(target.src || target.href || '')
    }
    var message = event === null || event === undefined ? '' : String(event.message || '')
    noteUiError(
      resource === '' ? '页面脚本出错' : '有个资源没加载上',
      resource !== '' ? resource : message,
      event === null || event === undefined ? null : event.error,
    )
  })
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event === null || event === undefined ? null : event.reason
    var detail =
      reason !== null && reason !== undefined && typeof reason === 'object'
        ? String(reason.message || reason.code || '')
        : String(reason)
    noteUiError('页面里有没接住的失败', detail, reason)
  })
}

/* ─────────────────── 8. 提示条 / 通知 ─────────────────── */

/* 顶栏已删除：连接相位不再常显（未连接/配对中/出错由授权页与 banner 覆盖），
   setPhase 只负责驱动按钮态与授权页。 */
function setPhase(phase, detail) {
  state.phase = phase
  syncControls()
  syncAuthGate()
}

/**
 * 全屏授权页的显隐：等待配对（waiting-pair）或认证类致命错误时亮出，
 * 其余时候隐藏。它是单人自用形态的「登录页」—— 输入配对码或等另一台设备批准。
 */
function syncAuthGate() {
  var gate = $('authGate')
  if (gate === null) return
  var show = state.phase === 'waiting-pair' || state.authGateForced === true
  gate.classList.toggle('hidden', !show)
  if (!show) return
  var nameNode = $('authHubName')
  if (nameNode !== null) nameNode.textContent = BOOT.hubName
  var addrNode = $('authHubAddr')
  if (addrNode !== null) addrNode.textContent = location.host
  var reqNode = $('authRequestId')
  if (reqNode !== null) {
    var requestId = state.pairing !== null ? String(state.pairing.requestId || '') : ''
    reqNode.textContent = requestId === '' ? '（等待服务端分配…）' : requestId
  }
  /* 拿不到 WebCrypto（http 非 localhost）时连配对都做不到：给指引而不是输入框 */
  var noCrypto = $('authNoCrypto')
  if (noCrypto !== null) noCrypto.classList.toggle('hidden', state.identity !== null || state.tokenMode !== true)
  var pairArea = $('authPairArea')
  if (pairArea !== null) pairArea.classList.toggle('hidden', state.identity === null && state.tokenMode === true)
}

function setAuthError(message) {
  var node = $('authError')
  if (node !== null) node.textContent = message
}

function syncControls() {
  var ready = state.phase === 'ready'
  var scopes = state.scopes
  var canRead = ready && scopes.indexOf('employee.read') >= 0
  var canPrompt = ready && scopes.indexOf('employee.prompt') >= 0
  var canPair = ready && scopes.indexOf('device.pair') >= 0
  var canResolve = ready && scopes.indexOf('approval.resolve') >= 0

  /* 唯一的连接按钮：按相位在「断开/取消/重新连接」间切换（连接默认自动发起） */
  var btnDisconnect = $('btnDisconnect')
  if (btnDisconnect !== null) {
    btnDisconnect.disabled = false
    btnDisconnect.textContent =
      state.phase === 'connecting' || state.phase === 'waiting-pair'
        ? '取消'
        : state.phase === 'ready'
          ? '断开'
          : '重新连接'
  }
  /* 设备页整页都要 device.pair：没这个 scope 时**连标签一起藏掉**。
     原来只藏那张卡片；现在它是一级页，只藏内容会留下一个点开满屏报错的空标签。 */
  var tabDevices = $('tabDevices')
  if (tabDevices !== null) tabDevices.classList.toggle('hidden', !canPair)
  /* 正停在设备页而 scope 又没了（换令牌、服务端收窄权限）：退回办公区 ——
     否则用户会盯着一页永远拉不动的内容，还不明白为什么。 */
  if (!canPair && state.view === 'devices') setView('office')
  var map = {
    btnReloadEmployees: canRead,
    btnOrderMode: ready && scopes.indexOf('employee.manage') >= 0,
    btnCreateEmployee: ready && scopes.indexOf('employee.manage') >= 0,
    btnReloadSessions: canRead && state.selectedEmployeeId !== null,
    btnNewSession: canPrompt && state.selectedEmployeeId !== null,
    btnSend: canPrompt && state.selectedSessionId !== null,
    btnCancel: canPrompt && state.selectedSessionId !== null,
    btnCompact: canPrompt && state.selectedSessionId !== null,
    btnDistill: canPrompt && state.selectedSessionId !== null,
    btnReloadApprovals: canRead,
    btnSaveJob: ready && scopes.indexOf('employee.manage') >= 0,
    btnReloadDevices: canPair,
    btnNewEndpoint: ready && scopes.indexOf('employee.manage') >= 0
  }
  Object.keys(map).forEach(function (id) {
    var node = $(id)
    if (node !== null) node.disabled = map[id] !== true
  })

  if (canResolve !== state.canResolve) {
    state.canResolve = canResolve
    renderApprovals()
    renderDevices()
  }
}

function setBanner(message, kind) {
  var box = $('banner')
  if (box === null) return
  if (message === '' || message === null || message === undefined) {
    box.className = 'banner hidden'
    clear(box)
    return
  }
  box.className = 'banner ' + (kind || 'info')
  clear(box)
  setHtml(box, message)
}

function toast(message, kind) {
  var box = $('toasts')
  if (box === null) return
  var node = el('div', 'toast ' + (kind || 'info'))
  node.appendChild(el('div', 'toast-text', message))
  node.onclick = function () {
    if (node.parentNode !== null) node.parentNode.removeChild(node)
  }
  box.appendChild(node)
  setTimeout(function () {
    if (node.parentNode !== null) node.parentNode.removeChild(node)
  }, kind === 'bad' || kind === 'warn' ? 12000 : 6000)
  while (box.childNodes.length > 5) box.removeChild(box.firstChild)
}

function notify(title, body) {
  toast(title + ' — ' + body, 'warn')
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body: body })
    }
  } catch (error) {
    /* 通知失败不影响主流程 */
  }
}

function pushRaw(label, payload) {
  state.rawCount += 1
  if (location.search.indexOf('debug=1') < 0) return
  var box = $('rawLog')
  if (box === null) return
  var entry = el('div', 'raw-entry')
  entry.appendChild(el('div', 'raw-label', '#' + String(state.rawCount) + ' · ' + nowText() + ' · ' + label))
  var pre = el('pre', 'raw-pre')
  if (typeof payload === 'string') setHtml(pre, payload)
  else setHtml(pre, safeJson(payload))
  entry.appendChild(pre)
  box.appendChild(entry)
  while (box.childNodes.length > 300) box.removeChild(box.firstChild)
  box.scrollTop = box.scrollHeight
}

/* ─────────────────── 9. 员工 / 会话 / 对话 ─────────────────── */
`
