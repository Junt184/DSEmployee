/**
 * 控制台脚本片段：引导配置 / 常量 / 通用小工具 / 本地持久化
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
export const CHUNK_00_CORE = String.raw`
/* ═══════════════════════════════════════════════════════════════════════════
 * DSEmployee 网页控制台 · 单文件实现
 *
 * 与服务端的契约（逐字节对齐 src/protocol/）：
 *   · 身份：Ed25519，deviceId = sha256(SPKI DER) 小写 hex
 *   · 签名载荷：JSON.stringify({v,deviceId,clientId,role,scopes,nonce,signedAt,platform})
 *     键顺序即协议的一部分，scopes 先排序去重（默认 sort，无比较器）
 *   · 帧：req{type,id,method,params,idempotencyKey?} / res{type,id,ok,payload|error} /
 *         event{type,event,payload,seq?}
 *
 * 安全约定：来自服务端的任何字符串都不拼进 innerHTML。
 * 唯一的 HTML 写入点是 setHtml()，而它强制经过 escapeHtml()；其余全部走 textContent。
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ─────────────────── 0. 引导配置（由服务端注入的 data-* 属性） ─────────────────── */

var BOOT = (function () {
  var node = document.getElementById('dse-boot')
  if (node === null) return { hubId: '', hubName: 'Hub' }
  return {
    hubId: String(node.getAttribute('data-hub-id') || ''),
    hubName: String(node.getAttribute('data-hub-name') || 'Hub')
  }
})()

/* ─────────────────── 1. 常量 ─────────────────── */

var CLIENT_ID = 'dse-web'
var CLIENT_VERSION = '0.1.0'
var PROTOCOL_VERSION = 1
var DEFAULT_ROLE = 'operator'

/* 界面版本 = /ui.js 的内容指纹（服务端在交付时替换掉下面这个占位符）。
   它同时被印在页面上（见 renderUiVersion）并随 connect 上报给 Hub ——
   目的是把"这台设备跑的是哪一版脚本"变成**可见事实**：
   新旧脚本在同一 Hub 上并存时（缓存、PWA、多个浏览器），
   差异不靠肉眼比对布局，而是直接比这一串指纹。 */
var UI_VERSION = '__DSE_UI_VERSION__'

/* operator 角色的全部 scope：连接时静默全申请（见 requestedScopes 的注释）。
   保留清单本身是为了和服务端方法表对照时不靠记忆。 */
var ALL_SCOPES = ['employee.read', 'employee.prompt', 'employee.invoke', 'employee.manage', 'node.admin', 'device.pair', 'approval.resolve']

/* 需要幂等键的方法：服务端 METHODS 表（src/protocol/methods.ts）里
   idempotent: true 且**控制台可能调用**的全集。漏一个就会在调用时吃
   idempotency-key-required —— 而且症状很隐蔽：**这个功能整条不可用**，
   错误只在 ?debug=1 的原始日志里。
   这条不变量由 test/ui-idempotency.test.ts 自动守着（逐条比对方法表），
   不必靠人记得回来核对；rpc() 另有一层自愈兜底，见下。
   （node.register 也带幂等键要求，但它是 node 角色专属，页面不会调，不收。） */
var IDEMPOTENT_METHODS = {
  'session.create': true,
  'session.rename': true,
  'session.prompt': true,
  'session.cancel': true,
  'session.compact': true,
  'session.subscribe': true,
  'session.unsubscribe': true,
  'approval.resolve': true,
  'dsh.question.answer': true,
  'device.pair.approve': true,
  'device.pair.reject': true,
  'device.pair.remove': true,
  'device.token.rotate': true,
  'device.token.revoke': true,
  'employee.invoke': true,
  'employee.create': true,
  'employee.update': true,
  'employee.remove': true,
  'employee.files.set': true,
  'employee.files.upload': true,
  'employee.llm.save': true,
  'employee.autoApprove.set': true,
  'node.permission.set': true,
  'employee.llm.promote': true,
  'employee.llm.linkEndpoint': true,
  'employee.llm.activate': true,
  'employee.llm.remove': true,
  'employee.llm.unset': true,
  'llm.endpoint.upsert': true,
  'llm.endpoint.remove': true,
  'employee.avatar.set': true,
  'employee.avatar.remove': true,
  'office.order.set': true,
  'position.upsert': true,
  'position.remove': true,
  'acl.set': true,
  'job.upsert': true,
  'job.self.upsert': true,
  'node.update': true,
  'push.subscribe': true,
  'pairing.window.set': true,
  'push.unsubscribe': true,
  'push.notify': true,
  'job.self.remove': true,
  'job.remove': true,
  'job.runNow': true,
  'acl.remove': true
}

var LS = {
  token: 'dse.deviceToken',
  tokenDevice: 'dse.deviceToken.deviceId',
  lastEmployee: 'dse.lastEmployeeId',
  lastView: 'dse.lastView',
  /* 每个员工上次打开的会话 id（{员工id: 会话id}），刷新与重新进入时优先恢复。
     会话本身是节点的事实，本地 id 也为节点离线时保留发送入口。 */
  lastSessions: 'dse.lastSessions',
  preset: 'dse.agentPreset',
  tokenMode: 'dse.tokenMode',
  theme: 'dse.theme',
  unread: 'dse.unread',
  density: 'dse.density',
  /* 右栏（员工上下文）是否展开。与密度同款按设备存 —— "我这块屏幕要不要常驻右栏"
     是设备属性，不是办公室的共享事实（对比 office.order 那种共享偏好） */
  aside: 'dse.asideVisible',
  /* 左栏（会话列表）是否展开。与右栏**分开存**：两个方向的取舍是两件事，
     合成一个键会让"收左栏"顺手把右栏也改掉。同样按设备存。 */
  panel: 'dse.panelVisible',
  /* 安全监测台账里的「已阅」标记（{员工id/发现id: 时刻}）。
     **只存本机**：控制台不写员工的工作区文件（一份数据两个写者，必然两份真相），
     代价是换设备就丢 —— 界面上写明了这一点。 */
  monitorRead: 'dse.monitorRead'
}

var IDB_NAME = 'dse-console'
var IDB_STORE = 'identity'
var IDB_KEY = 'deviceIdentity'

/**
 * Ed25519 公钥的 SPKI DER **固定前缀**（12 字节）。
 *
 * 浏览器 WebCrypto 导出的 raw 公钥只有 32 字节，而服务端用 node:crypto 的
 * createPublicKey({ format:'der', type:'spki' }) 解析，需要完整 SPKI 结构。
 * Ed25519（OID 1.3.101.112）的 SPKI 是定长的：
 *
 *   30 2a                                      SEQUENCE，长度 0x2a = 42
 *      30 05 06 03 2b 65 70                     AlgorithmIdentifier: SEQUENCE(5) { OID 1.3.101.112 }
 *      03 21 00 <32 字节 raw 公钥>               BIT STRING，长度 0x21 = 33（首字节 00 = 无未用位）
 *
 * 42 + 2 = 44 字节 = 12 字节前缀 + 32 字节 raw 公钥。
 * deviceId 必须是 **这整段 44 字节** 的 sha256，而不是 raw 公钥的 sha256 ——
 * 服务端 fingerprintOf() 哈希的正是线路上传的 SPKI DER。
 */
var SPKI_PREFIX_HEX = '302a300506032b6570032100'

/* ─────────────────── 2. 通用小工具 ─────────────────── */

function $(id) {
  return document.getElementById(id)
}

function el(tag, className, text) {
  var node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

function clear(node) {
  if (node === null) return
  while (node.firstChild !== null) node.removeChild(node.firstChild)
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/* 唯一的 innerHTML 写入点：内容一律先转义，杜绝来自服务端的 HTML 注入。 */
function setHtml(node, text) {
  if (node === null) return
  node.innerHTML = escapeHtml(text)
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch (error) {
    return String(value)
  }
}

function describeError(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  if (typeof error.name === 'string' && error.name !== '') return error.name
  return String(error)
}

function shortId(value) {
  var text = String(value === undefined || value === null ? '' : value)
  if (text.length <= 12) return text
  return text.slice(0, 12) + '…'
}

function nowText(ms) {
  var stamp = typeof ms === 'number' && ms > 0 ? ms : Date.now()
  var date = new Date(stamp)
  var hh = String(date.getHours())
  var mm = String(date.getMinutes())
  var ss = String(date.getSeconds())
  if (hh.length < 2) hh = '0' + hh
  if (mm.length < 2) mm = '0' + mm
  if (ss.length < 2) ss = '0' + ss
  return hh + ':' + mm + ':' + ss
}

function bytesToHex(bytes) {
  var out = ''
  for (var i = 0; i < bytes.length; i += 1) {
    var part = bytes[i].toString(16)
    out += part.length === 1 ? '0' + part : part
  }
  return out
}

function hexToBytes(hex) {
  var out = new Uint8Array(Math.floor(hex.length / 2))
  for (var i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** base64url，**无填充**（与服务端 Buffer.toString('base64url') 一致）。 */
function bytesToBase64Url(bytes) {
  var binary = ''
  var chunk = 0x8000
  for (var i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID()
    } catch (error) {
      /* 非安全上下文下 randomUUID 可能不可用，落到下面 */
    }
  }
  var bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (var i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  return bytesToHex(bytes)
}

function hasCrypto() {
  return typeof crypto !== 'undefined' && crypto !== null && typeof crypto.subtle !== 'undefined' && crypto.subtle !== null
}

/* ─────────────────── 3. 本地持久化 ─────────────────── */

function readLocal(key) {
  try {
    return localStorage.getItem(key)
  } catch (error) {
    return null
  }
}

function writeLocal(key, value) {
  try {
    if (value === null || value === undefined || value === '') localStorage.removeItem(key)
    else localStorage.setItem(key, String(value))
  } catch (error) {
    /* 隐私模式下 localStorage 可能抛错：界面仍可用，只是不持久 */
  }
}

/** 会话记忆最多留多少个员工（防止这张表无限长大）。 */
var SESSION_MEMORY_MAX = 20

/** 读出 {员工id: 会话id}。存坏了（手改、旧格式）就当没有 —— 不能让页面因此打不开。 */
function readSessionMemory() {
  var raw = readLocal(LS.lastSessions)
  if (raw === null || raw === '') return {}
  try {
    var parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch (error) {
    return {}
  }
}

/** 记住这个员工当前打开的会话：节点离线、页面又刷新过时，靠它把会话接回来。 */
function rememberSession(employeeId, sessionId) {
  if (employeeId === null || sessionId === null || employeeId === '' || sessionId === '') return
  var map = readSessionMemory()
  /* 重新打开的员工移到末尾，按最近使用淘汰。 */
  delete map[String(employeeId)]
  map[String(employeeId)] = String(sessionId)
  var keys = Object.keys(map)
  while (keys.length > SESSION_MEMORY_MAX) {
    var oldest = keys.shift()
    if (oldest === undefined) break
    delete map[oldest]
  }
  writeLocal(LS.lastSessions, JSON.stringify(map))
}

/** 取回这个员工上次打开的会话 id；没记过返回空串。 */
function recallSession(employeeId) {
  if (employeeId === null || employeeId === '') return ''
  var value = readSessionMemory()[String(employeeId)]
  return typeof value === 'string' ? value : ''
}

function idbOpen() {
  return new Promise(function (resolve, reject) {
    if (typeof indexedDB === 'undefined' || indexedDB === null) {
      reject(new Error('IndexedDB 不可用'))
      return
    }
    var request = indexedDB.open(IDB_NAME, 1)
    request.onupgradeneeded = function () {
      var db = request.result
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE)
    }
    request.onsuccess = function () {
      resolve(request.result)
    }
    request.onerror = function () {
      reject(request.error || new Error('IndexedDB open failed'))
    }
  })
}

function idbGet(key) {
  return idbOpen().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(IDB_STORE, 'readonly')
      var request = tx.objectStore(IDB_STORE).get(key)
      request.onsuccess = function () {
        resolve(request.result === undefined ? null : request.result)
      }
      request.onerror = function () {
        reject(request.error || new Error('IndexedDB get failed'))
      }
    })
  })
}

function idbPut(key, value) {
  return idbOpen().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(IDB_STORE, 'readwrite')
      /* CryptoKey 可被结构化克隆，因此这里能直接存下不可导出的私钥对象 */
      tx.objectStore(IDB_STORE).put(value, key)
      tx.oncomplete = function () {
        resolve(true)
      }
      tx.onerror = function () {
        reject(tx.error || new Error('IndexedDB put failed'))
      }
    })
  })
}

function idbDelete(key) {
  return idbOpen().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).delete(key)
      tx.oncomplete = function () {
        resolve(true)
      }
      tx.onerror = function () {
        reject(tx.error || new Error('IndexedDB delete failed'))
      }
    })
  })
}
`
