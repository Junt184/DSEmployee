/**
 * 控制台脚本片段：设备页与设备密钥维护
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
export const CHUNK_90_DEVICES = String.raw`
/* ─────────────────── 11. 设备面板 ─────────────────── */

function deviceRequestText(request) {
  if (request === null || typeof request !== 'object') return '（无详情）'
  return (
    (request.displayName === undefined || request.displayName === null || request.displayName === ''
      ? String(request.clientId || '未知客户端')
      : String(request.displayName)) +
    ' · ' +
    String(request.platform || '?') +
    ' · role ' +
    String(request.role || '?') +
    ' · 来自 ' +
    String(request.remoteIp || '?')
  )
}

function loadDevices() {
  if (state.phase !== 'ready' || state.scopes.indexOf('device.pair') < 0) return Promise.resolve(null)
  return rpc('device.list', {})
    .then(function (payload) {
      state.devices = {
        pending: Array.isArray(payload && payload.pending) ? payload.pending : [],
        paired: Array.isArray(payload && payload.paired) ? payload.paired : []
      }
      pushRaw('device.list 结果', payload)
      renderDevices()
      return state.devices
    })
    .catch(function (error) {
      reportRpcError('device.list', error)
      return null
    })
}

function renderDevices() {
  var box = $('devicePendingList')
  var pairedBox = $('devicePairedList')
  if (box === null || pairedBox === null) return
  clear(box)
  clear(pairedBox)

  /* 有待批准设备时要"一眼看见"：横幅 + 标题前缀。只有自己挂出的横幅才由自己撤下，
     免得把别的流程（连接错误等）的提示误清掉。 */
  var pendingCount = state.devices.pending.length
  if (pendingCount > 0 && state.phase === 'ready') {
    setBanner('有 ' + String(pendingCount) + ' 台设备等待配对批准 —— 在下方「设备」卡片里处理。', 'warn')
    state.pairBanner = true
    document.title = '【' + String(pendingCount) + ' 台待批准】' + state.baseTitle
  } else if (state.pairBanner === true) {
    state.pairBanner = false
    setBanner('', 'info')
    document.title = state.baseTitle
  }

  if (state.devices.pending.length === 0) box.appendChild(el('li', 'empty', '（没有待审批的设备）'))
  state.devices.pending.forEach(function (request) {
    var item = el('li', 'item')
    var top = el('div', 'item-top')
    top.appendChild(el('span', 'name', String(request.displayName || request.clientId || '未命名设备')))
    top.appendChild(el('span', 'badge warn', '待审批'))
    item.appendChild(top)
    item.appendChild(el('div', 'role', deviceRequestText(request)))
    item.appendChild(el('div', 'meta', 'deviceId ' + String(request.deviceId || '')))
    item.appendChild(el('div', 'meta', '请求 scopes：' + (Array.isArray(request.scopes) ? request.scopes.join(' ') : '无')))
    var scopeInput = el('input', 'note')
    scopeInput.type = 'text'
    scopeInput.placeholder = '批准哪些 scope（空格分隔，留空 = 按请求批准）'
    scopeInput.value = Array.isArray(request.scopes) ? request.scopes.join(' ') : ''
    item.appendChild(scopeInput)
    var row = el('div', 'row')
    var approve = el('button', 'primary', '批准')
    var reject = el('button', 'danger', '拒绝')
    approve.onclick = function () {
      approveDevice(String(request.requestId || ''), String(scopeInput.value || ''))
    }
    reject.onclick = function () {
      rejectDevice(String(request.requestId || ''))
    }
    row.appendChild(approve)
    row.appendChild(reject)
    item.appendChild(row)
    box.appendChild(item)
  })

  if (state.devices.paired.length === 0) pairedBox.appendChild(el('li', 'empty', '（暂无已配对设备）'))
  state.devices.paired.forEach(function (device) {
    var item = el('li', 'item')
    var top = el('div', 'item-top')
    top.appendChild(el('span', 'name', String(device.displayName || device.clientId || '未命名设备')))
    top.appendChild(el('span', 'badge ' + (device.revoked === true ? 'bad' : 'ok'), device.revoked === true ? '已吊销' : '已配对'))
    item.appendChild(top)
    item.appendChild(el('div', 'meta', 'deviceId ' + String(device.deviceId || '')))
    item.appendChild(el('div', 'meta', 'role ' + String(device.role || '?') + ' · platform ' + String(device.platform || '?')))
    item.appendChild(
      el('div', 'meta', '已批 scopes：' + (Array.isArray(device.approvedScopes) ? device.approvedScopes.join(' ') : '无'))
    )
    if (device.lastSeenAtMs !== undefined) {
      item.appendChild(el('div', 'meta', '最近出现 ' + new Date(Number(device.lastSeenAtMs)).toLocaleString() + ' · ' + String(device.lastSeenIp || '')))
    }
    var row = el('div', 'row')
    var rotate = el('button', 'ghost', '轮换令牌')
    var revoke = el('button', 'danger', '吊销令牌')
    var remove = el('button', 'danger', '移除配对')
    if (device.revoked === true) rotate.disabled = true
    rotate.onclick = function () {
      rotateDeviceToken(String(device.deviceId || ''))
    }
    revoke.onclick = function () {
      revokeDeviceToken(String(device.deviceId || ''))
    }
    remove.onclick = function () {
      removeDevice(String(device.deviceId || ''))
    }
    row.appendChild(rotate)
    row.appendChild(revoke)
    row.appendChild(remove)
    item.appendChild(row)
    pairedBox.appendChild(item)
  })
}

function approveDevice(requestId, scopesText) {
  var params = { requestId: requestId }
  var scopes = scopesText.split(/[\s,，]+/).filter(function (item) {
    return item !== ''
  })
  if (scopes.length > 0) params.approvedScopes = scopes
  rpc('device.pair.approve', params, { idempotencyKey: 'pair-approve-' + requestId })
    .then(function (payload) {
      pushRaw('device.pair.approve 结果', payload)
      var deviceId = payload !== null && typeof payload === 'object' ? String(payload.deviceId || '') : ''
      showApprovalDonePanel(
        '已批准 ' + (deviceId === '' ? '该设备' : '设备 ' + shortId(deviceId)),
        '该设备下次连接时会用自己的私钥自动领取令牌并登录，无需复制任何内容。' +
          '（协议设计：令牌只存哈希、只在领取瞬间下发给设备本身，批准者的界面上不存在可复制的令牌。）'
      )
      var card = $('cardToken')
      if (card !== null) card.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return loadDevices()
    })
    .catch(function (error) {
      reportRpcError('device.pair.approve', error)
    })
}

function rejectDevice(requestId) {
  rpc('device.pair.reject', { requestId: requestId }, { idempotencyKey: 'pair-reject-' + requestId })
    .then(function (payload) {
      pushRaw('device.pair.reject 结果', payload)
      toast('已拒绝配对请求 ' + shortId(requestId), 'warn')
      return loadDevices()
    })
    .catch(function (error) {
      reportRpcError('device.pair.reject', error)
    })
}

function rotateDeviceToken(deviceId) {
  rpc('device.token.rotate', { deviceId: deviceId }, { idempotencyKey: 'rotate-' + deviceId + '-' + String(Date.now()) })
    .then(function (payload) {
      pushRaw('device.token.rotate 结果', payload)
      showTokenPanel(
        String(payload && payload.deviceToken ? payload.deviceToken : ''),
        '令牌已轮换（旧令牌立刻失效）',
        '新令牌只显示这一次。持有旧令牌的终端需要立即粘贴新令牌。'
      )
      return loadDevices()
    })
    .catch(function (error) {
      reportRpcError('device.token.rotate', error)
    })
}

function revokeDeviceToken(deviceId) {
  rpc('device.token.revoke', { deviceId: deviceId }, { idempotencyKey: 'revoke-' + deviceId + '-' + String(Date.now()) })
    .then(function (payload) {
      pushRaw('device.token.revoke 结果', payload)
      toast('已吊销令牌（设备需重新配对）', 'warn')
      return loadDevices()
    })
    .catch(function (error) {
      reportRpcError('device.token.revoke', error)
    })
}

function removeDevice(deviceId) {
  rpc('device.pair.remove', { deviceId: deviceId }, { idempotencyKey: 'remove-' + deviceId + '-' + String(Date.now()) })
    .then(function (payload) {
      pushRaw('device.pair.remove 结果', payload)
      toast('已移除配对记录', 'warn')
      return loadDevices()
    })
    .catch(function (error) {
      reportRpcError('device.pair.remove', error)
    })
}

/**
 * 批准成功的如实反馈面板。与 showTokenPanel 分开的原因：协议里批准**不产生**
 * 令牌（被批准设备用自己的私钥在下次签名握手时自行领取，见 devices.ts 的
 * claimToken），所以这里没有令牌区、没有复制按钮 —— 放一个"请复制令牌"的
 * 面板是在描述一个不存在的东西（这正是本次修的 UX 事故）。
 */
function showApprovalDonePanel(title, detail) {
  var card = $('cardToken')
  if (card === null) return
  card.className = 'card'
  clear(card)
  card.appendChild(el('h2', '', title))
  card.appendChild(el('div', '', detail))
  var row = el('div', 'row')
  var dismiss = el('button', 'ghost', '知道了')
  dismiss.onclick = function () {
    card.classList.add('hidden')
    clear(card)
  }
  row.appendChild(dismiss)
  card.appendChild(row)
}

function showTokenPanel(token, title, warning) {
  var card = $('cardToken')
  if (card === null) return
  card.className = 'card token-card'
  clear(card)
  card.appendChild(el('h2', '', title))
  card.appendChild(el('div', 'warn', warning))
  var code = el('code', 'token', token === '' ? '（服务端未返回令牌）' : token)
  card.appendChild(code)
  var row = el('div', 'row')
  var copy = el('button', 'primary', '复制令牌')
  copy.onclick = function () {
    if (token === '') return
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(token).then(
        function () {
          toast('令牌已复制到剪贴板', 'ok')
        },
        function () {
          selectNodeText(code)
        }
      )
    } else {
      selectNodeText(code)
    }
  }
  var dismiss = el('button', 'ghost', '我已保存，隐藏')
  dismiss.onclick = function () {
    card.classList.add('hidden')
    clear(card)
  }
  row.appendChild(copy)
  row.appendChild(dismiss)
  card.appendChild(row)
}

function selectNodeText(node) {
  try {
    var range = document.createRange()
    range.selectNodeContents(node)
    var selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    toast('已选中令牌文本，请手动复制', 'info')
  } catch (error) {
    toast('请手动长按选中令牌文本复制', 'info')
  }
}

/* ─────────────────── 12. 设备密钥维护 ─────────────────── */

function resetDeviceKey() {
  forgetIdentity().then(function () {
    state.tokenMode = false
    toast('已清除本地设备密钥：下次连接会生成新身份，需要重新配对。', 'warn')
    connectNow(true)
  })
}

function clearLocalToken() {
  writeLocal(LS.token, null)
  writeLocal(LS.tokenDevice, null)
  dropSessionCookie()
  toast('已清除本地保存的设备令牌', 'warn')
}

function bindEvents() {
  /* 秘书页外壳的控件（下拉箭头 / 看板关闭 / Esc）。这里**总会执行**，
     所以绑在这里而不是 selectEmployee 里 —— 后者只在点过工位后才跑。 */
  bindSecretaryUi()
  /* 四宫格外壳的窄屏抽屉按钮，同理（它会话/审批/技能的绑定仍在各自原处） */
  bindQuadUi()
  var tabs = $('viewTabs')
  if (tabs !== null) {
    tabs.addEventListener('click', function (event) {
      /* 用 closest 找按钮，而不是看 event.target.tagName：审批 / 体检 两个标签里带了计数
         chip，点在 chip 上时 target 是那个 span —— 按 tagName 判会当场 return，
         表现为"点标签里的数字没反应、只有点字才有反应"。 */
      var node = event.target
      if (node === null || typeof node.closest !== 'function') return
      var button = node.closest('button.tab')
      if (button === null || tabs.contains(button) !== true) return
      var view = button.getAttribute('data-view')
      /* chat 不从标签进（它从工位进、由返回键退出），其余只认视图表里有的 */
      if (view !== null && view !== 'chat' && Object.prototype.hasOwnProperty.call(VIEW_IDS, view)) setView(view)
    })
  }

  var btnDisconnect = $('btnDisconnect')
  if (btnDisconnect !== null) {
    btnDisconnect.onclick = function () {
      /* 已断开/出错时这个按钮是「重新连接」 */
      if (state.phase === 'idle' || state.phase === 'closed' || state.phase === 'error') {
        state.authGateForced = false
        requestNotificationPermission()
        connectNow(true)
        return
      }
      state.manualClose = true
      stopRetry()
      switch (state.phase) {
        case 'connecting':
        case 'waiting-pair':
          state.expectClose = true
          closeSocket()
          setPhase('idle')
          setBanner('', 'info')
          break
        default:
          /* 手动断开：置上 expectClose，避免 onSocketClosed 把状态改成「已断开」 */
          state.expectClose = true
          closeSocket()
          setPhase('idle')
          state.scopes = []
          syncControls()
          break
      }
    }
  }
  var btnNotify = $('btnNotify')
  if (btnNotify !== null) btnNotify.onclick = requestNotificationPermission
  var btnPushOn = $('btnPushOn')
  if (btnPushOn !== null) btnPushOn.onclick = enablePushNotifications
  loadPairingWindow()
  var btnPushTest = $('btnPushTest')
  if (btnPushTest !== null) btnPushTest.onclick = sendTestPush

  var btnTheme = $('btnTheme')
  if (btnTheme !== null) btnTheme.onclick = toggleTheme

  var btnRedeem = $('btnRedeem')
  if (btnRedeem !== null) btnRedeem.onclick = redeemPairCode
  var pairCodeInput = $('pairCodeInput')
  if (pairCodeInput !== null) {
    pairCodeInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault()
        redeemPairCode()
      }
    })
  }
  var btnRepair = $('btnRepair')
  if (btnRepair !== null) {
    btnRepair.onclick = function () {
      /* 令牌恢复路径：清掉本地令牌重连；前提是管理员已移除旧配对记录 */
      clearLocalToken()
      state.authGateForced = false
      connectNow(true)
    }
  }

  var btnReset = $('btnResetKey')
  if (btnReset !== null) {
    btnReset.onclick = function () {
      if (window.confirm('清除本地设备密钥？该设备需要重新配对（服务端上的旧配对记录需另行移除）。')) resetDeviceKey()
    }
  }
  var btnClearToken = $('btnClearToken')
  if (btnClearToken !== null) btnClearToken.onclick = clearLocalToken

  var reloadEmployees = $('btnReloadEmployees')
  if (reloadEmployees !== null) reloadEmployees.onclick = loadEmployees
  /* 排序模式开关：进入后组/工位出现 ↑↓，工位点击进聊天暂时禁用 */
  var orderModeButton = $('btnOrderMode')
  if (orderModeButton !== null) {
    orderModeButton.onclick = function () {
      state.orderMode = state.orderMode !== true
      orderModeButton.textContent = state.orderMode === true ? '完成' : '排序'
      orderModeButton.classList.toggle('primary', state.orderMode === true)
      renderEmployees()
    }
  }
  /* 密度 toggle 与排序 toggle 互不干扰：一个切 CSS 类，一个进排序模式 */
  var densityButton = $('btnDensity')
  if (densityButton !== null) densityButton.onclick = toggleDensity
  var createEmployeeButton = $('btnCreateEmployee')
  if (createEmployeeButton !== null) createEmployeeButton.onclick = createEmployee
  /* 新建员工表单：展开自动填名（没手动改过的话），「换一个」随时可点 */
  var cardCreate = $('cardCreate')
  if (cardCreate !== null) {
    cardCreate.addEventListener('toggle', function () {
      if (cardCreate.open !== true) return
      autofillCreateName()
      /* 分组选择器在展开时重建：选项随员工集合更新；不展开的期间不重建，
         避免冲掉用户正在进行的填写（参考 probe 不重渲染的教训） */
      var slot = $('createGroupSlot')
      if (slot !== null) {
        clear(slot)
        state.createGroupPicker = buildGroupPicker('')
        slot.appendChild(state.createGroupPicker.root)
      }
      var positionSlot = $('createPositionSlot')
      if (positionSlot !== null) {
        clear(positionSlot)
        state.createPositionPicker = buildPositionPicker('')
        positionSlot.appendChild(state.createPositionPicker.root)
      }
      bindCreatePreviewPicker(state.createGroupPicker)
      bindCreatePreviewPicker(state.createPositionPicker)
      renderCreatePreview()
    })
  }
  var anotherName = $('btnAnotherName')
  if (anotherName !== null) {
    anotherName.onclick = function () {
      var input = $('createName')
      if (input !== null) input.value = randomEmployeeName()
      renderCreatePreview()
    }
  }
  var cancelCreateEmployee = $('btnCancelCreateEmployee')
  if (cancelCreateEmployee !== null) {
    cancelCreateEmployee.onclick = function () {
      var card = $('cardCreate')
      if (card !== null) card.open = false
    }
  }
  var createNameInput = $('createName')
  if (createNameInput !== null) {
    createNameInput.addEventListener('input', function () {
      state.createNameTouched = true
      renderCreatePreview()
    })
  }
  var createRoleInput = $('createRole')
  if (createRoleInput !== null) createRoleInput.addEventListener('input', renderCreatePreview)
  var createNodeSelect = $('createNode')
  if (createNodeSelect !== null) createNodeSelect.addEventListener('change', renderCreatePreview)
  var backOffice = $('btnBackOffice')
  if (backOffice !== null) {
    backOffice.onclick = function () {
      setView('office')
    }
  }
  var reloadSessions = $('btnReloadSessions')
  if (reloadSessions !== null) reloadSessions.onclick = loadSessions
  var newSession = $('btnNewSession')
  if (newSession !== null) newSession.onclick = createSession
  var reloadApprovals = $('btnReloadApprovals')
  if (reloadApprovals !== null) reloadApprovals.onclick = loadApprovals
  var btnReloadJobs = $('btnReloadJobs')
  if (btnReloadJobs !== null) btnReloadJobs.onclick = function () { loadJobs() }
  var btnNewJob = $('btnNewJob')
  if (btnNewJob !== null) btnNewJob.onclick = function () { openNewJob() }
  var btnSaveJob = $('btnSaveJob')
  if (btnSaveJob !== null) btnSaveJob.onclick = function () { saveJob() }
  var btnResetJob = $('btnResetJob')
  if (btnResetJob !== null) btnResetJob.onclick = function () { resetJobForm() }
  var approvalTabPending = $('approvalTabPending')
  if (approvalTabPending !== null) approvalTabPending.onclick = function () { setApprovalView('pending') }
  var approvalTabHistory = $('approvalTabHistory')
  if (approvalTabHistory !== null) approvalTabHistory.onclick = function () { setApprovalView('history') }
  var reloadDevices = $('btnReloadDevices')
  if (reloadDevices !== null) reloadDevices.onclick = loadDevices
  /* 岗位管理：卡片展开时才拉目录（与体检同款，不给后端添常态负担）；
     按钮绑定放在这里而不是事件处理器里 —— 事件处理器那段只在收到 employee.changed 时跑，
     放那儿会导致"卡片点开是空的"（这一版就是这么错的，靠真浏览器才看出来） */
  var addPosition = $('btnAddPosition')
  if (addPosition !== null) addPosition.onclick = addPositionFromAdmin
  var reloadPositions = $('btnReloadPositions')
  if (reloadPositions !== null) {
    reloadPositions.onclick = function () {
      loadPositions().then(renderPositionAdmin)
    }
  }
  var positionsCardBind = $('cardPositions')
  if (positionsCardBind !== null) {
    positionsCardBind.addEventListener('toggle', function () {
      if (positionsCardBind.open === true) loadPositions().then(renderPositionAdmin)
    })
  }

  /* 体检：切到体检页那一刻才去拉数据（由 setView 的 VIEW_LOADERS 触发，见那边注释）——
     点开看的永远是新数据，不在这一页就一个请求都不发。 */
  var reloadHealth = $('btnReloadHealth')
  if (reloadHealth !== null) reloadHealth.onclick = refreshHealth
  var healthFilterAll = $('healthFilterAll')
  if (healthFilterAll !== null) healthFilterAll.onclick = function () { healthSetFilter('all') }
  var healthFilterOpen = $('healthFilterOpen')
  if (healthFilterOpen !== null) healthFilterOpen.onclick = function () { healthSetFilter('open') }
  var healthFilterOk = $('healthFilterOk')
  if (healthFilterOk !== null) healthFilterOk.onclick = function () { healthSetFilter('ok') }

  var send = $('btnSend')
  if (send !== null) send.onclick = sendPrompt
  var cancel = $('btnCancel')
  if (cancel !== null) cancel.onclick = cancelTurn
  /* 右栏折叠开关绑在**总会执行**的这里，而不是 bindChatUi() —— 后者只在点过工位
     （selectEmployee → setView('chat')）时才跑。今天能看见这个按钮的路径恰好都经过
     selectEmployee，所以绑在那里"看起来能用"；一旦将来有第二条进入聊天视图的路径
     （深链、通知点进来），按钮就会变成一个点了没反应的死键。 */
  var asideToggle = $('btnAside')
  if (asideToggle !== null) asideToggle.onclick = toggleAside
  /* 发文件：按钮 / 拖拽 / 粘贴三条入口都汇到 handlePickedFiles */
  var attachButton = $('btnAttach')
  var fileInput = $('fileInput')
  if (attachButton !== null && fileInput !== null) {
    attachButton.onclick = function () {
      fileInput.value = ''
      fileInput.click()
    }
    fileInput.onchange = function () {
      void handlePickedFiles(fileInput.files)
      fileInput.value = ''
    }
  }
  var chatSection = $('chat')
  if (chatSection !== null) {
    chatSection.addEventListener('dragover', function (event) {
      if (event.dataTransfer === null) return
      event.preventDefault()
      chatSection.classList.add('dragging')
    })
    chatSection.addEventListener('dragleave', function () {
      chatSection.classList.remove('dragging')
    })
    chatSection.addEventListener('drop', function (event) {
      chatSection.classList.remove('dragging')
      if (event.dataTransfer === null) return
      var files = event.dataTransfer.files
      if (files === null || files === undefined || files.length === 0) return
      event.preventDefault()
      void handlePickedFiles(files)
    })
  }

  var promptInput = $('promptInput')
  if (promptInput !== null) {
    /* 粘贴截图：控制台最常见的"发图"动作，不该逼用户先存盘再选文件 */
    promptInput.addEventListener('paste', function (event) {
      var items = event.clipboardData !== null && event.clipboardData !== undefined ? event.clipboardData.items : null
      if (items === null || items === undefined) return
      var picked = []
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].kind !== 'file') continue
        var file = items[i].getAsFile()
        if (file !== null) picked.push(file)
      }
      if (picked.length > 0) {
        event.preventDefault()
        void handlePickedFiles(picked)
      }
    })
    promptInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        sendPrompt()
      }
    })
  }
}

/* ─────────────────── 允许新设备注册（配对窗口）───────────────────
 *
 * 这是一个**开关**：关着的时候，没有本机设备凭据的访问拿到的是 404（和 nginx 一样）——
 * 公网上就不存在一个常驻的、未认证可访问的注册入口。
 *
 * 三条必须说清楚的语义（界面上的字就是按这三条写的，改代码时别只改一半）：
 *   1. **默认开着**（沿用旧行为）：升级不会把老设备锁在门外，要藏得自己点一下关。
 *   2. 关掉**不影响已配对的浏览器**：它们在配对时换了 dse_device cookie，
 *      所以"关了注册"= 陌生人看不到，不是我打不开自己的控制台。
 *   3. 打开时**默认带 15 分钟倒计时**（忘了关是这类开关最常见的失败方式）；
 *      确实要长时间加设备，用「一直开着」那个按钮。
 */
function renderPairingWindow(state) {
  var box = $('pairingWindowBox')
  if (box === null) return
  clear(box)
  var known = state !== null && typeof state === 'object'
  var open = known && state.open === true
  var remaining = known ? Number(state.remainingSec || 0) : 0
  var pairedCount = known ? Number(state.pairedCount || 0) : -1
  var forever = open && remaining <= 0

  if (open) {
    var line = forever
      ? '注册窗口：开着（无到期时间）—— 新设备现在可以输入配对码；用完请点「关闭注册」。'
      : '注册窗口：开着（还剩约 ' + String(Math.max(1, Math.round(remaining / 60))) + ' 分钟）—— 新设备现在可以输入配对码，到点自动关。'
    box.appendChild(el('div', 'muted', line))
    if (pairedCount === 0) {
      box.appendChild(
        el('div', 'muted', '还没有任何已配对设备：第一次配对必须开着窗口（批准在 Hub 本机用 dse pair approve 做）。'),
      )
    }
  } else {
    box.appendChild(el('div', 'muted', '注册窗口：已关闭 —— 未授权的访问只会看到 404（与 nginx 一致）。'))
    box.appendChild(
      el('div', 'muted', '本机已配对的浏览器不受影响（配对时拿到了 cookie）；换浏览器 / 清站点数据后要重新开窗。'),
    )
  }

  var row = el('div', 'row')
  var toggle = el('button', 'ghost', open ? '关闭注册' : '打开 15 分钟')
  toggle.onclick = function () {
    toggle.disabled = true
    setPairingWindow(open ? { open: false } : { open: true, minutes: 15 }, open ? '注册窗口已关闭' : '注册窗口已打开 15 分钟 —— 去新设备上输入配对码', toggle)
  }
  row.appendChild(toggle)

  if (!open) {
    var foreverBtn = el('button', 'ghost', '一直开着')
    foreverBtn.onclick = function () {
      foreverBtn.disabled = true
      setPairingWindow({ open: true }, '注册窗口已打开（无到期时间）—— 用完记得关', foreverBtn)
    }
    row.appendChild(foreverBtn)
  } else if (!forever) {
    var extend = el('button', 'ghost', '再开 60 分钟')
    extend.onclick = function () {
      extend.disabled = true
      setPairingWindow({ open: true, minutes: 60 }, '注册窗口已延长 60 分钟', extend)
    }
    row.appendChild(extend)
  }
  box.appendChild(row)

  if (open) {
    box.appendChild(el('div', 'muted', '窗口期收到注册请求会同时推到你手机（若已开手机通知）。'))
  }
}

function setPairingWindow(params, okMessage, button) {
  rpc('pairing.window.set', params, { idempotencyKey: randomId() })
    .then(function (result) {
      toast(okMessage, 'ok')
      renderPairingWindow(result)
    })
    .catch(function (error) {
      reportRpcError('pairing.window.set', error)
      if (button) button.disabled = false
    })
}

function loadPairingWindow() {
  var box = $('pairingWindowBox')
  if (box === null) return
  if (state.phase !== 'ready' || state.scopes.indexOf('device.pair') < 0) {
    clear(box)
    box.appendChild(el('div', 'muted', '（需要 device.pair 权限）'))
    return
  }
  rpc('pairing.window', {})
    .then(function (payload) { renderPairingWindow(payload) })
    .catch(function () { clear(box) })
}

function requestNotificationPermission() {
  try {
    if (typeof Notification === 'undefined') {
      toast('本浏览器不支持桌面通知，页面内提示仍然可用。', 'info')
      return
    }
    if (Notification.permission === 'granted') return
    Notification.requestPermission().then(function (result) {
      toast(result === 'granted' ? '桌面通知已开启' : '桌面通知未授权（页面内提示仍然可用）', 'info')
    })
  } catch (error) {
    toast('请求通知权限失败：' + describeError(error), 'warn')
  }
}

/* ─────────────────── 手机通知（Web Push）───────────────────
 *
 * 与上面那个「桌面通知」的区别很关键：桌面通知只在**页面开着**时有效（是页内 API），
 * 而 Web Push 是"应用关着也能收到"——它靠 service worker + 推送服务。
 * 所以"手机上要能收到"必须走这条：订阅一次，之后由 Hub 往推送服务发。
 */
function base64UrlToBytes(text) {
  var padded = String(text).replace(/-/g, '+').replace(/_/g, '/')
  while (padded.length % 4 !== 0) padded += '='
  var raw = atob(padded)
  var bytes = new Uint8Array(raw.length)
  for (var i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** 订阅手机通知：要权限 → 拿 VAPID 公钥 → 订阅 → 上报给 Hub。 */
function enablePushNotifications() {
  if (typeof navigator === 'undefined' || navigator.serviceWorker === undefined) {
    toast('这个浏览器没有 service worker，收不了离线通知', 'warn')
    return
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    toast('通知权限被拒绝过：要在浏览器/系统设置里重新允许，页面这边无法再弹权限框', 'warn')
    return
  }
  try { localStorage.removeItem('dse.pushEndpoint') } catch (error) { /* 忽略 */ }
  rpc('push.key', {})
    .then(function (payload) {
      var publicKey = payload !== null && typeof payload === 'object' ? String(payload.publicKey || '') : ''
      if (publicKey === '') throw new Error('Hub 没有给出 VAPID 公钥')
      return navigator.serviceWorker.ready.then(function (registration) {
        return registration.pushManager.subscribe({
          /* iOS 强制要求 true：每条推送都必须显示通知（不显示会被判滥用） */
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(publicKey)
        })
      })
    })
    .then(function (subscription) {
      var json = subscription.toJSON()
      var keys = json.keys || {}
      return rpc(
        'push.subscribe',
        { endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh || '', auth: keys.auth || '' } },
        { idempotencyKey: randomId() }
      ).then(function (result) {
        try { localStorage.setItem('dse.pushEndpoint', subscription.endpoint) } catch (error) { /* 忽略 */ }
        var total = result !== null && typeof result === 'object' ? result.total : null
        toast('手机通知已开启' + (typeof total === 'number' ? '（这台 Hub 共 ' + String(total) + ' 个订阅）' : ''), 'ok')
      })
    })
    .catch(function (error) {
      /* 常见原因：不是在"添加到主屏幕"的应用里开的（iOS 会直接拒绝订阅），
         或者浏览器不支持推送。原文照说，别写成"开启失败"这种没信息量的话。 */
      toast('开不了手机通知：' + describeError(error), 'warn')
    })
}

/** 发一条测试通知 —— 让用户当场确认"手机到底响不响"。 */
function sendTestPush() {
  rpc('push.notify', { title: 'DSEmployee 测试通知', body: '看到这条说明手机通知通了', tag: 'dse-test' }, { idempotencyKey: randomId() })
    .then(function (result) {
      var sent = result !== null && typeof result === 'object' ? Number(result.sent || 0) : 0
      var note = result !== null && typeof result === 'object' ? String(result.note || '') : ''
      toast(sent > 0 ? '已发往 ' + String(sent) + ' 个订阅' : '没有可发的订阅：' + (note === '' ? '先开启手机通知' : note), sent > 0 ? 'ok' : 'warn')
    })
    .catch(function (error) {
      reportRpcError('push.notify', error)
    })
}
`
