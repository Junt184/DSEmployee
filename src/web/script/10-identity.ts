/**
 * 控制台脚本片段：设备身份（Ed25519）/ 规范载荷与签名
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
export const CHUNK_10_IDENTITY = String.raw`
/* ─────────────────── 4. 设备身份（Ed25519） ─────────────────── */

var state = {
  socket: null,
  phase: 'idle',
  hello: null,
  role: DEFAULT_ROLE,
  scopes: [],
  identity: null,
  identityFailure: '',
  identitySource: '',
  tokenMode: false,
  /* 主页是「办公区」工位视图；点头像才切到 chat */
  view: 'office',
  employees: [],
  employeeNames: new Map(),
  selectedEmployeeId: null,
  sessions: [],
  /* 默认只显示员工；仅记录用户主动展开的会话分组，切换员工不会自动展开。 */
  employeeSessions: new Map(),
  expandedArchives: new Set(),
  sessionArchivePending: new Map(),
  expandedSessionEmployees: new Set(),
  employeeSelectionVersion: 0,
  sessionOpenVersion: 0,
  selectedSessionId: null,
  subscribed: null,
  historySync: null,
  sessionEventSeqs: new Set(),
  approvals: [],
  /* 定时任务列表（控制台只读缓存；事实在 Hub 的 jobs.json） */
  jobs: [],
  /* 审批页的本地视图状态：列表与详情之间的选中关系不属于 Hub 事实。 */
  approvalView: 'pending',
  selectedApprovalId: null,
  /* 待发附件：已上传到员工工作区的文件，随下一条指令一起发出 */
  attachments: [],
  devices: { pending: [], paired: [] },
  pending: new Map(),
  seq: 0,
  retryTimer: null,
  reconnectTimer: null,
  /* 右栏（员工上下文）是否展开：按设备存 localStorage，见 applyAsideVisible */
  asideVisible: true,
  /* 整个左栏沿用设备偏好；员工内部的会话分组另行控制，默认收起。 */
  panelVisible: true,
  /* 岗位目录（Hub 侧共享数据）：控制台只做缓存，用于下拉候选与工位徽章 */
  positions: [],
  expectClose: false,
  manualClose: false,
  /* 服务端重启（部署 / systemctl restart）后的自动重连状态：
     它与 manualClose（用户按了「断开」）是两件事，绝不能共用 —— 共用过一次，
     代价是部署后开着的控制台页一直是死的。见 scheduleServerRestartReconnect。 */
  restartPending: false,
  restartTries: 0,
  canResolve: false,
  streamBubble: null,
  rawCount: 0,
  pairing: null,
  /* 认证类致命错误（令牌被吊销/不匹配）也亮授权页：恢复路径从那里开始 */
  authGateForced: false,
  /* 设备配对横幅是本模块设置的才由本模块清除，避免覆盖别的提示 */
  pairBanner: false,
  baseTitle: '',
  /* 宽屏右栏（员工上下文）的快照：employeeId → { skills, files, skillsError, filesError }。
     未决审批不进这里 —— 那是 state.approvals，重绘时现读，免得两份状态打架。 */
  aside: null,
  /* ── 上下文占用（顶栏那个小圈）──
     dsh 用「session/projection」帧推来两份数字，都是**按会话**的，所以这里记 sessionId：
       pressure   ← key='contextPressure'（{ pressureTokens, projectedTokens, contextWindow }）
       breakdown  ← key='contextBreakdown'（{ systemTokens, toolsTokens, messageTokens }，启发式估算）
     sessionId 与当前选中会话不一致时一律不采信 —— 否则翻旧会话会把旧数字画在别人的会话上。 */
  context: { sessionId: '', pressure: null, breakdown: null },
  /* ── 本轮计划（岗位四宫格左下那格）──
     来自 dsh 的另一个投影：key='todos'（[{content, status}]，status ∈ pending|in_progress|completed）。
     **它在每轮开始时被清空**（dsh 收到 turn/start 就把值置 null），所以这里额外留一份
     「上一轮」：本轮开始时把上一份整体挪进 prev —— 否则"7 条全 ✓"会在下一轮开始的一瞬间
     凭空消失，而用户看到的正是那一刻。与 context 同规矩：只认当前会话，换会话作废；
     live=false 表示这份数字来自 session.list 的快照（订阅前的旧值），不是刚推来的。 */
  plan: { sessionId: '', todos: null, prev: null, prevAtMs: 0, live: false },
  /* ── 四宫格外壳（岗位 layout: 'quad'）──
     格位面板要读的**工作区文件**（授权范围/进度、监测范围/巡检结果）+ 折叠与徽章状态。
     每个文件的失败原因分开存：一格拉不到不该让整格变成空白（真正的形状见 resetQuadState）。 */
  quad: {
    employeeId: '',
    scopeResult: null,
    boardResult: null,
    monitorResult: null,
    findingsResult: null,
    incidentResult: null,
    actionsResult: null,
    incidentsResult: null,
    incidentDoneOpen: false,
    skillsOpen: false,
    badgeOpen: false,
    drawer: '',
    skin: 'day',
  },
  /* ── 工位状态（忙碌 / 未读 / 小屏）── */
  desk: {}, // employeeId → { busy, sessionId }（最近一次轮询的结果）
  deskWatch: {}, // employeeId → sessionId（小屏正在订阅的忙碌会话）
  deskTail: {}, // employeeId → string[]（最近几行输出，小屏滚屏用）
  deskDirty: {}, // employeeId → true（有待绘制的输出）
  deskSig: '', // 上次渲染工位时的 (busy/unread) 签名，没变就不重建 DOM
  unread: {}, // employeeId → 未读条数（localStorage 持久化）
  deskPaintTimer: null,
  deskPollTimer: null,
  /* ── 模型配置标签页 ── */
  llmEndpoints: [], // 端点库（llm.endpoint.list 的 endpoints；key 只有掩码）
  llmDetail: {}, // employeeId → employee.llm.get 的返回（展开时才拉，key 只有掩码）
  llmProbeModels: {}, // 端点 id（'' = 新端点草稿）→ probe 拉到的模型 id 列表
  llmPermission: {}, // employeeId → {preset, hasSession}（权限档位，只读显示）
  nodePermissions: {}, // nodeId → {name, online, preset, error?}（整机级默认档位）
  llmOpen: {}, // employeeId → true（编辑区展开中）
  llmEndpointEdit: null, // 'new' | 端点 id | null（端点库里正在编辑哪一条）
  /* ── 自定义头像缓存（employeeId → dataURL）──
     内存这份负责"这一次渲染"，localStorage 那份负责"下次刷新立刻有图"：
     头像几百 KB，而 Hub 侧只有 RPC 一条路（没有 HTTP 缓存），
     不持久化就等于每次刷新都把所有人的头像重新下载一遍。 */
  avatars: {},
  avatarVersions: {}, // employeeId → 版本（mtime+字节数）；与缓存配对，用来判断要不要重下
  avatarLoading: {}, // employeeId → true（拉取在途，去重用）
  avatarOpen: {}, // employeeId → true（工位上的换头像面板展开中）
  /* 新建员工表单：用户手动改过名字后置 true，自动填充就不再冲掉它 */
  createNameTouched: false,
  /* 新建员工表单的分组选择器实例（展开时重建，选项随员工集合更新） */
  createGroupPicker: null,
  /** 新建员工的岗位选择器（表单展开时重建） */
  createPositionPicker: null,
  /* ── 办公区排序（偏好存 Hub：office.order.get/set）── */
  officeOrder: { groupOrder: [], employeeOrder: {} },
  orderMode: false, // 排序模式：组/工位出现 ↑↓，工位点击进聊天禁用（防误触）
  /* 密度：'compact'（默认，一屏更多员工）| 'comfortable'（大头像宽松版） */
  density: 'compact',
  lastTickAt: 0
}

/**
 * 首选路径：按规格用 extractable=false 生成。
 *
 * 现实提醒：extractable: false 按 WebCrypto 规范会**同时**锁住公钥，之后
 * exportKey('raw', publicKey) 会抛 InvalidAccessError —— Chrome / Firefox / Safari
 * 都是这个行为，于是本函数抛错并落到 generateKeyTwoStep() 兜底。
 * 但也有实现（例如 Node 自己的 webcrypto）允许导出**公钥**，此时本路径直接生效，
 * 就是最强姿态：明文私钥从头到尾没有存在过。
 * 两条路径产出的身份完全等价（都是不可签出私钥的 Ed25519 + 32 字节 raw 公钥）。
 */
function generateKeyStrict() {
  return crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']).then(function (pair) {
    return crypto.subtle.exportKey('raw', pair.publicKey).then(function (raw) {
      return { privateKey: pair.privateKey, rawPublicKey: new Uint8Array(raw), strict: true }
    })
  })
}

/**
 * 兜底路径（两步法）：先以可导出方式生成 → 导出公钥与 PKCS#8 →
 * **把私钥重新导入为 extractable:false** → 丢弃 PKCS#8 缓冲区。
 *
 * 这样存进 IndexedDB 的私钥依旧是不可导出的 CryptoKey。
 * 代价：私钥字节在 JS 内存里短暂存在过一次（浏览器 WebCrypto 下无法避免）。
 */
function generateKeyTwoStep() {
  return crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']).then(function (pair) {
    return crypto.subtle.exportKey('raw', pair.publicKey).then(function (raw) {
      return crypto.subtle.exportKey('pkcs8', pair.privateKey).then(function (pkcs8) {
        return crypto.subtle
          .importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign'])
          .then(function (privateKey) {
            return { privateKey: privateKey, rawPublicKey: new Uint8Array(raw), strict: false }
          })
      })
    })
  })
}

/** 把 32 字节 raw 公钥包装成服务端能解析的 SPKI DER（12 字节前缀 + 32 字节）。 */
function wrapSpkiDer(rawPublicKey) {
  var prefix = hexToBytes(SPKI_PREFIX_HEX)
  var der = new Uint8Array(prefix.length + rawPublicKey.length)
  der.set(prefix, 0)
  der.set(rawPublicKey, prefix.length)
  return der
}

/**
 * 取得（或生成）本设备的 Ed25519 身份。
 * 返回 null 表示当前环境无法做 Ed25519 → 调用方切换到"粘贴设备令牌"模式。
 */
function ensureIdentity() {
  if (state.identity !== null) return Promise.resolve(state.identity)

  return idbGet(IDB_KEY)
    .catch(function () {
      return null
    })
    .then(function (stored) {
      if (stored !== null && stored !== undefined && stored.privateKey && stored.deviceId && stored.spkiDer) {
        state.identity = {
          key: stored.privateKey,
          spkiDer: new Uint8Array(stored.spkiDer),
          deviceId: String(stored.deviceId)
        }
        state.identitySource = 'indexeddb'
        return state.identity
      }
      if (!hasCrypto()) {
        state.identityFailure =
          '当前页面不是安全上下文，浏览器不提供 WebCrypto（crypto.subtle）。请用 https:// 或 http://localhost 打开本控制台。'
        return null
      }
      return generateKeyStrict()
        .catch(function () {
          return generateKeyTwoStep()
        })
        .then(function (material) {
          var der = wrapSpkiDer(material.rawPublicKey)
          return crypto.subtle.digest('SHA-256', der).then(function (digest) {
            var deviceId = bytesToHex(new Uint8Array(digest))
            var identity = { key: material.privateKey, spkiDer: der, deviceId: deviceId }
            state.identity = identity
            state.identitySource = material.strict ? 'generated-nonextractable' : 'generated-two-step'
            return idbPut(IDB_KEY, {
              privateKey: material.privateKey,
              spkiDer: der,
              deviceId: deviceId,
              createdAtMs: Date.now()
            })
              .catch(function () {
                toast('设备私钥无法写入 IndexedDB；刷新页面后设备身份会变，需要重新配对。', 'warn')
              })
              .then(function () {
                return identity
              })
          })
        })
        .catch(function (error) {
          state.identityFailure =
            '本浏览器不支持 Ed25519（WebCrypto 报错：' + describeError(error) + '）。已切换为「粘贴设备令牌」模式。'
          return null
        })
    })
}

function forgetIdentity() {
  state.identity = null
  state.identitySource = ''
  return idbDelete(IDB_KEY).catch(function () {
    return false
  })
}

/* ─────────────────── 5. 规范载荷与签名 ─────────────────── */

/**
 * 构造待签名载荷 —— 必须与服务端 canonicalConnectPayload() **逐字节相同**：
 *   · 键顺序固定：v, deviceId, clientId, role, scopes, nonce, signedAt, platform
 *   · scopes 先 [...new Set(...)] 去重再 .sort()（默认 UTF-16 码元序，无比较器）
 *   · v 固定为 1（SIGN_PAYLOAD_VERSION）
 */
function canonicalConnectPayload(input) {
  var scopes = Array.from(new Set(input.scopes)).sort()
  return JSON.stringify({
    v: 1,
    deviceId: input.deviceId,
    clientId: input.clientId,
    role: input.role,
    scopes: scopes,
    nonce: input.nonce,
    signedAt: input.signedAt,
    platform: input.platform
  })
}

function signPayload(payload) {
  var bytes = new TextEncoder().encode(payload)
  return crypto.subtle.sign({ name: 'Ed25519' }, state.identity.key, bytes).then(function (signature) {
    return bytesToBase64Url(new Uint8Array(signature))
  })
}
`
