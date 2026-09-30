/**
 * Hub 领域模型 —— 跨模块共享的数据形状。
 *
 * 这些形状会经线协议出现在 `/api` 与 WS 上，因此改动是**兼容性变更**：
 * 新增字段只能可选，删除/改义必须同时改 `docs/03-总体设计契约.md`。
 */

import type { ResFrame, Role, Scope } from '../protocol/index.ts'


/**
 * 已执行的幂等 RPC 缓存。key 由 (deviceId, idempotencyKey) 派生；只保存参数摘要，
 * 不把可能含提示词、文件正文或密钥的原始 params 复制进幂等账本。
 */
interface IdempotencyRecordBase {
  deviceId: string
  key: string
  method: string
  paramsHash: string
  createdAtMs: number
}

export type IdempotencyRecord =
  | (IdempotencyRecordBase & { status: 'running' })
  | (IdempotencyRecordBase & { status: 'completed'; response: ResFrame })

/* ────────────────────────────── 设备 ────────────────────────────── */

/** 待审批的配对请求。键是 `requestId`。 */
export interface PairingRequest {
  requestId: string
  /** 公钥指纹（64 位小写 hex） */
  deviceId: string
  publicKey: string
  role: Role
  scopes: Scope[]
  platform: string
  clientId: string
  displayName?: string
  requestedAtMs: number
  /**
   * 过期时间。到点未批准即作废并被清理。
   *
   * 为什么必须有过期：待审批条目会一直躺在台账里（并且每次 `device.list` 都会被列给用户），
   * 陈旧的请求既干扰判断，也是一个长期敞开的口子 —— 半年前那次连接不该在今天还能被批准。
   *
   * 默认 30 分钟（比 OpenClaw 的 5 分钟宽），因为本方案的批准动作常常发生在手机上、
   * 由人稍后处理。节点侧会持续重试，过期后会自动出现一条新的请求，用户不会"卡住"。
   */
  expiresAtMs: number
  /** 请求来自回环地址时为 true —— 这是"本地自动批准"的唯一依据 */
  fromLoopback: boolean
  /** 来源 IP，仅用于审计与 CIDR 判定 */
  remoteIp: string
}

/** 已配对设备。键是 `deviceId`。 */
export interface PairedDevice {
  deviceId: string
  publicKey: string
  role: Role
  /** 配对时批准的 scope —— 这是**永久上限**，令牌不可超出 */
  approvedScopes: Scope[]
  platform: string
  clientId: string
  displayName?: string
  /**
   * 绑定到某个员工：这台设备**只能以这个员工的名义**发起跨员工调用。
   *
   * 为什么必须由服务端绑定、而不是听请求里的 `fromEmployeeId`：员工一旦拿到
   * 自己的凭据，调用方自报的身份就成了"谁能冒充谁"的口子 —— 员工之间可以互相
   * 冒名派活，而台账上记的发起人是假的。绑定之后 `from` 由**认证连接**派生。
   *
   * 只对 operator 设备有意义：node 设备的身份是"某台机器"，不是"某个人"。
   */
  boundEmployeeId?: string
  pairedAtMs: number
  pairedBy: string
  /** 当前令牌的 sha256（不存明文令牌） */
  tokenHash: string
  /**
   * 该设备是否已经领过令牌。
   *
   * 配对批准本身**不签发令牌** —— 令牌由设备在批准后的**首次连接**时自行领取
   * （通过它已经在做的挑战签名证明私钥持有权）。这样用户批准完就能用，
   * 不需要把令牌从 Hub 机器手动搬到终端上；安全性也不打折，因为
   * 能签出那个挑战的人本来就能冒充这台设备。
   */
  tokenClaimed: boolean
  tokenIssuedAtMs: number
  revoked: boolean
  lastSeenAtMs?: number
  lastSeenIp?: string
}

/* ────────────────────────────── 终端节点 ────────────────────────────── */

/**
 * 端点库的一条：BaseURL + Key 输一次，多个员工复用。
 *
 * 为什么存 Hub（而不是每个节点各存一份）：这是用户明确要的"真全局"——
 * 输一次、全员共用、改一处全场生效。代价要说清：**密钥在服务器上多一份静态副本**
 * （`hub/llm-endpoints.json`，0600）。接口一律只回掩码，日志不记 key。
 */
export interface LlmEndpointRecord {
  id: string
  /** 显示名（用户起，如 noelle）——别名由用户自己拼（如 gpt5.6-noelle） */
  name: string
  apiUrl: string
  /** 机密：只在 Hub 状态目录与本节点落地的那份里存在 */
  apiKey?: string
  /** 上次试点「获取模型列表」拿到的模型 id（给界面做下拉候选；可为空） */
  models?: string[]
  /**
   * 出口代理（缺省 = 直连）。
   *
   * 为什么每个端点各自一份：有些端点的域名在 Cloudflare 后面，直连（国内 IP）一律 403，
   * 只有走本机代理才通 —— 而"哪条端点需要代理"是**端点属性**，不是全局开关。
   * 真实模型调用由 dsh 发出，而 dsh 的 provider 配置没有代理字段，
   * 所以节点侧另起一个只监听回环的转发口（见 src/node/llm-proxy.ts）。
   */
  proxy?: { host: string; port: number }
  createdAtMs: number
  updatedAtMs: number
}

export interface NodeRecord {
  /** 节点 id（设备指纹派生，稳定） */
  nodeId: string
  /** 人类可读节点名，可改 */
  name: string
  platform: string
  /** dsh 实例的版本（节点上报） */
  dshVersion?: string
  /**
   * 节点**自己那份代码**的内容指纹（`src/protocol/build.ts` 的 `codeFingerprint`）。
   *
   * 存在的理由：节点是手动升级的（git pull + 重启），分叉时**不会报错** ——
   * 旧节点照常连上、照常列员工，只是能力缺失或行为不同。有了这个字段，控制台与
   * Hub 日志就能直接回答"这台机器跑的是不是同一份代码"，而不是靠人去每台机器上看。
   * 老节点不报这个字段 ⇒ 按 `unknown` 处理（不假装一致）。
   */
  codeVersion?: string
  /**
   * 该节点**实际加载**的入口形态：`dist`（编译产物，`bin/dse.mjs` 优先用它）/ `src`（源码）。
   *
   * 单独记一个字段而不是混进指纹：编译产物与源码是两套东西，"只更新源码、dist 还是旧的"
   * 会让部署看起来生效、实际一行都没跑上（真实踩过：公网 Hub 因部署误带 dist/ 而长期
   * 跑编译产物）。这种状态必须能一眼看出来，而不是靠人去猜。
   */
  runtime?: 'dist' | 'src' | 'unknown'
  /** 该节点托管 dsh 的监听端口（回环） */
  dshPort?: number
  /** 员工工作区根目录（节点上的绝对路径） */
  employeeRoot: string
  online: boolean
  connectedAtMs?: number
  lastSeenAtMs: number
  /**
   * 最近一次自升级的状态（控制台节点行上显示的那个状态机）。
   *
   * 为什么要留状态而不是"点完就算"：节点升级要重启，中间会**离线几十秒**；
   * 如果界面只显示"已发送"，用户无从判断它是在升级中还是挂了。四个状态的分工：
   * `requested`（已发送，等节点回应）→ `prepared`（节点已切指针，即将重启）→
   * 重启后自然变成"代码版本已对齐"；失败则 `failed` 并带原因。
   */
  update?: {
    /** 目标：分支/标签/sha（由 Hub 记录的部署提交决定） */
    to: string
    status: 'requested' | 'prepared' | 'failed'
    requestedAtMs: number
    finishedAtMs?: number
    /** 谁点的（设备 id）—— 升级是重动作，得能追 */
    requestedBy?: string
    /** 节点返回的指纹（prepared 时） */
    fingerprint?: string
    error?: string
  }
}

/* ────────────────────────────── 岗位（职位）────────────────────────────── */

/**
 * 岗位目录条目 —— **用户可增删的共享数据**，不是代码里的分支。
 *
 * 为什么员工身份里存 id、名称只存在这里一处：
 *   · 改岗位名只动一处，已绑定的员工不会失联；身份里存名称的话，改一次名全部断链，
 *     而且「渗透测试」与「渗透」会变成两个互不相干的岗位；
 *   · 目录是"这间办公室有哪些工种"，与 `office.order`（座次偏好）同性质：**共享事实**，
 *     手机与电脑该看到同一份下拉，所以存 Hub 侧而不是各终端 localStorage。
 *
 * `panels` 是**预留**字段：将来按岗位渲染不同面板时，写"用哪几个**通用**面板"
 * （有限、可枚举的那组，见 docs/06 §3.1），这样新增岗位是加数据、不是写新前端。
 * 当前阶段控制台还不渲染它（先只做"岗位字段 + 下拉/新增"）。
 *
 * 红线：岗位**只影响界面与 AGENTS.md 文本，绝不参与鉴权**（权限仍在方法表/scope）。
 */

/**
 * 四宫格（`layout: 'quad'`）的三个可配格位。
 *
 * 缺省 = 那个格子空着并**如实说明**"这个岗位没配内容"，而不是伪装成"没有目标/没有计划"。
 * （右下那格是对话框，属于外壳的一部分，不可配。）
 */
export interface PositionCells {
  /** 左上 */
  tl?: string[]
  /** 左下 */
  bl?: string[]
  /** 右上（岗位面板排在固有的裁决/会话/技能**之前**；审批段只在真有未决时出现） */
  tr?: string[]
  /**
   * 顶部条（员工名右边的一小块：徽章类面板，如「只读 · 无处置权限」）。
   *
   * 为什么单独一个位置而不是塞进 tr：这类内容"平时一句话都不说、有事才亮红"，
   * 它必须**常驻可见但极占地方小** —— 那就是顶部条，而不是四格里的任何一格。
   */
  top?: string[]
}

export interface PositionEntry {
  /** 稳定 id（`[a-z0-9][a-z0-9-]{0,31}`）；员工身份里存的就是它 */
  id: string
  /** 显示名（可改，不参与绑定） */
  name: string
  /** 该岗位用哪些通用面板（见 src/web/script/80-panels.ts 的注册表） */
  panels: string[]
  /**
   * 页面外壳：`''`/未给 = 默认对话页，`'secretary'` = 秘书页（左立绘 + 右对话 + 顶部下拉看板）。
   *
   * 为什么是"外壳"而不是"每个岗位一套界面"：气泡、流式、附件、会话、断线、IME 这些
   * 横切行为**只有一份实现**（src/web/script/65-chat.ts 等），岗位只能换外壳与面板，
   * 换不了这些行为 —— 否则同一件事会有两份真相，改一处漏一处。
   *
   * 为什么不存在别处：和 `panels` 同性质，是"这个工种长什么样"的共享事实，存 Hub 侧，
   * 手机与电脑看到同一份。**不参与鉴权**（红线同 `panels`）。
   */
  layout?: string
  /**
   * 四宫格外壳（`layout: 'quad'`）里**三格各放哪些面板 id**（右下那格永远是对话框，不配）。
   *
   * 为什么是"格位 → 面板 id"而不是给每个岗位写一套界面：格子的**位置**是这一行的形状
   * （左上 / 左下 / 右上 + 右下对话），格子的**内容**才是工种差异。于是外壳一份、
   * 面板若干、岗位目录里勾一下 —— 第三个岗位不需要第三份前端代码。
   *
   * 为什么不复用 `panels`：`panels` 渲染在右栏（`layout: ''` 的岗位仍然用它），而右栏在
   * 四宫格里根本不存在（`#employeeAside` 被外壳隐藏）。两者混用，"配了但没出现"会变成常态。
   * **不参与鉴权**（红线同 `panels`）。
   */
  cells?: PositionCells
  /** 内置岗位（「通用」）：可改名、不可删除 */
  builtin?: boolean
  createdAtMs: number
  updatedAtMs: number
}

/* ────────────────────────────── 员工 ────────────────────────────── */

export interface EmployeeRecord {
  /** 全局唯一 id，随工作区一起走（存在 `<工作区>/.dsemployee/employee.json`） */
  id: string
  /** 所在节点 */
  nodeId: string
  /** 显示名 */
  name: string
  /** 这个员工做什么 —— 员工目录的核心字段 */
  role: string
  /** 可选：初始提示词/身份补充（写进 AGENTS.md 的「设定」行，trim 后 1–500 字符） */
  intro?: string
  /** 工作区绝对路径 */
  workspacePath: string
  /** dsh 侧的 workspace 注册 id（可能尚未注册） */
  workspaceId?: string
  /** 可选：会话创建时使用的 agent preset（工具集模板） */
  agentPreset?: string
  /** 可选：分组/部门名，控制台工位视图按它分区 */
  group?: string
  /** 可选：岗位 id（指向 Hub 侧岗位目录；缺省 = 通用）。存 id 不存名称，改名不断链 */
  position?: string
  /** 是否有自定义头像（节点发现时探测 `.dsemployee/avatar.*`） */
  hasAvatar?: boolean
  /** 当前模型的别名（如 gpt5.6-noelle），节点上报；没配就是 undefined */
  llmActiveName?: string
  /** 这个员工用到的端点库条目的 id（删端点时要能点名"还有谁在用"） */
  llmEndpointIds?: string[]
  /**
   * 头像的版本（文件 mtime 与字节数，节点每次上报时带上）。
   *
   * 为什么要有它：头像是几百 KB 的图，控制台每刷新一次就把所有人的头像经 Hub 拉一遍
   * （实测 9 人 ≈ 4.2 MB base64/次）。有版本号，客户端才能"版本没变就不下载"，
   * 于是"点进去先是线稿、过一会儿才变成照片"这件事只在真正换过头像时发生一次。
   */
  avatarUpdatedAtMs?: number
  avatarBytes?: number
  /**
   * 工作区**自己**是不是一个 git 仓库（`<工作区>/.git` 存在）。
   *
   * 为什么值得单独存一个字段：dsh 的 `projectRoot` 由 `findProjectRoot()` 决定，
   * 它只认 `.git`（从 cwd 往上找第一个含 `.git` 的祖先）。工作区没有自己的 `.git`
   * 时，projectRoot 会落到外层仓库，于是私有技能根变成 `<外层>/.dsh/skills` ——
   * **工作区里的私有技能被静默忽略**（不报错、不告警）。控制台据此把"写了但没生效"
   * 提前摆到台面上，而不是等人发现员工怎么变笨了。
   */
  hasGitAnchor?: boolean
  /** 专属技能名清单（来自 `<工作区>/.dsh/skills` 的目录发现） */
  skills: string[]
  /** 工作区目录是否还在 */
  status: 'ok' | 'missing-dir'
  createdAtMs: number
  updatedAtMs: number
}

/* ────────────────────────────── 办公区显示偏好 ────────────────────────────── */

/**
 * 办公区排序偏好（组顺序 + 组内员工顺序）。
 *
 * 存 Hub 而不是 localStorage：排序是"这间办公室长什么样"的共享事实，
 * 手机和电脑打开控制台应该看到同一个办公室。目录是现实、偏好是视图层 ——
 * 偏好里引用已删除的组/员工是常态，读取方必须容忍并跳过（不许报错）。
 */
export interface OfficePrefs {
  /** 组顺序（组名数组；未分组用 '' 占位） */
  groupOrder: string[]
  /** 组内员工顺序：组名 → 员工 id 数组 */
  employeeOrder: Record<string, string[]>
}

/* ────────────────────────────── 会话 ────────────────────────────── */

export interface SessionRecord {
  sessionId: string
  employeeId: string
  nodeId: string
  cwd?: string
  running: boolean
  blank: boolean
  updatedAt: number
}

/* ────────────────────────────── 授权与审批 ────────────────────────────── */

/** 互调授权效果。 */
export type AclEffect = 'allow' | 'approve' | 'deny'

/**
 * 一条员工互调授权规则。
 *
 * 匹配语义：`from` / `to` 支持 `'*'` 通配。**最具体的规则优先**，
 * 同具体度时 `deny` > `approve` > `allow`（fail-closed）。
 */
export interface AclRule {
  id: string
  /** 调用方员工 id，或 `*` */
  from: string
  /** 被调方员工 id，或 `*` */
  to: string
  effect: AclEffect
  /** 人类可读的说明，会展示在审批界面上 */
  note?: string
  createdAtMs: number
  createdBy: string
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'answered'

/** 审批中心里所有记录共有的字段。 */
interface ApprovalBase {
  approvalId: string
  status: ApprovalStatus
  requestedAtMs: number
  resolvedAtMs?: number
  /** 裁决者的 deviceId（dsh 侧自行解决的记录没有这一项） */
  resolvedBy?: string
  resolutionNote?: string
}

/** 员工互调：命中 ACL 的 `approve` 规则，等控制台放行。 */
export interface InvokeApproval extends ApprovalBase {
  kind: 'employee.invoke'
  /** 发起方员工 */
  fromEmployeeId: string
  /** 目标员工 */
  toEmployeeId: string
  /** 要交给目标员工的任务文本 */
  task: string
  /** 命中的 ACL 规则 id（便于解释"为什么需要审批"） */
  matchedRuleId?: string
  /** 请求方等待结果的关联 id（同一次 invoke 的 requestId） */
  correlationId: string
}

/**
 * dsh 自身的审批 —— 无人值守终端上的 `approval/request`。
 *
 * 为什么必须有这一类：员工跑在**没人在的**机器上时，dsh 的审批闸没有应答者，
 * 这一轮就会一直挂到工具信号中止（fail-closed）。Hub 的审批中心是那条
 * "节点 → Hub → 手机 → Hub → 节点"反向通道的中间一站，`rpcId` 就是回填坐标
 * （`POST /api/respond` 靠它定位 dsh 侧的 pending 表）。
 */
export interface DshApproval extends ApprovalBase {
  kind: 'dsh.approval'
  employeeId: string
  nodeId: string
  sessionId: string
  /** 要执行的动作名（如 `bash`、`write`）—— 展示给裁决人看的那一行 */
  toolName: string
  callId?: string
  /** dsh 给出的理由（如"需要提权到 workspace 之外"） */
  reason?: string
  /** dsh 侧的审批 id，回填载荷里要原样带上 */
  dshApprovalId: string
  /** 回填坐标：`POST /api/respond` 的 rpcId */
  rpcId: string
}

/**
 * dsh 的提问（`userQuestions`）—— 员工用 `ask_user_question` 问人的那种。
 *
 * 与审批共用审批中心与回填通道，但**答案不是批准/拒绝**，而是一组结构化选择，
 * 所以载荷与 UI 都不同（`questions` 原样透传，Hub 不解释它）。
 */
export interface DshQuestion extends ApprovalBase {
  kind: 'dsh.question'
  employeeId: string
  nodeId: string
  sessionId: string
  /** `AskUserQuestionItem[]`，Hub 不解释，原样给控制台 */
  questions: unknown[]
  /** 用户的答案（`AskUserQuestionAnswer`），答完才有 */
  answer?: unknown
  rpcId: string
}

/** 审批中心的一条记录：互调审批 / dsh 审批 / dsh 提问。按 `kind` 判别。 */
export type ApprovalRecord = InvokeApproval | DshApproval | DshQuestion

/** 需要人工裁决、且裁决结果要回填给 dsh 的那两类（不是 invoke）。 */
export type DshInteraction = DshApproval | DshQuestion

/* ────────────────────────────── 互调记录 ────────────────────────────── */

export type InvokeStatus = 'pending-approval' | 'queued' | 'running' | 'completed' | 'failed' | 'denied'

export interface InvokeRecord {
  invokeId: string
  fromEmployeeId: string
  toEmployeeId: string
  task: string
  status: InvokeStatus
  approvalId?: string
  /** 结果会话（在被调方节点上） */
  resultSessionId?: string
  createdAtMs: number
  finishedAtMs?: number
  /** 结果文本（被调方最终回复） */
  resultText?: string
  error?: string
  /**
   * 发起方是**怎么被认定的**（审计用）：
   *   · `employee-device`：设备绑定了员工，from 由认证连接派生（员工自己发起的）
   *   · `operator-delegated`：operator 显式声明代这个员工发起（`onBehalfOf: true`）
   * 没有这两个字段的是历史记录（那时 from 完全由调用方自报，不可信）。
   */
  principal?: 'employee-device' | 'operator-delegated'
  /** operator 代发起时的设备 id —— "谁在替这个员工发起"必须查得到 */
  delegatedByDeviceId?: string
}

/* ────────────────────────────── Web Push（手机通知）────────────────────────────── */

/**
 * 一台设备的推送订阅。键是 `endpoint`（浏览器给的推送服务地址，全局唯一）。
 *
 * 会过期：换机、清站点数据、iOS 换端点都会让旧 endpoint 失效（推送服务回 404/410）。
 * 这不是异常，是常态 —— 所以发送侧必须**收到 404/410 就删掉它**，否则每次推送都在
 * 打电话给空号，而用户永远收不到、也没人知道为什么。
 */
export interface PushSubscriptionRecord {
  endpoint: string
  keys: { p256dh: string; auth: string }
  /** 哪台设备订的（审计用；推送本身不依赖它） */
  deviceId?: string
  createdAtMs: number
}

/* ────────────────────────────── 定时任务 ────────────────────────────── */

/**
 * 一条定时任务：每隔一段时间把一段指令发给某个员工。
 *
 * 为什么放在 **Hub** 而不是节点上：节点常常是笔电，会睡、会关机、时钟会漂；
 * 而"每隔 N 分钟叫它一次"这件事必须由一台**一直醒着**的机器来记时间。
 * Hub 又恰好知道全部员工目录，并且已经有离线邮箱兜底（目标机器不在线时指令进队列）。
 *
 * 错过的时间点**跳过**，不补跑：笔电睡了 3 小时，醒来不该被 36 条历史任务淹没。
 */
export interface ScheduleJob {
  jobId: string
  /** 显示名（控制台上认人） */
  name: string
  employeeId: string
  /** 到时发给员工的指令（等同用户在对话里发的那句话） */
  prompt: string
  /** 间隔毫秒。最小 60s —— 比一次真实回合还短的间隔没有意义，只会堆队列。 */
  intervalMs: number
  /**
   * 发到哪个会话。首次成功派发后由 Hub 自动记住，于是目标机器离线时
   * 仍能把指令排进那个会话的队列（而不是因为"不知道发哪儿"而失败）。
   */
  sessionId?: string
  enabled: boolean
  /** 下次该跑的时刻（调度器按它扫） */
  nextRunAtMs: number
  lastRunAtMs?: number
  /** 连续失败次数：成功清零；到上限自动停用（见 AUTO_DISABLE_AFTER_FAILURES） */
  consecutiveFailures: number
  /** 自动停用或人工停用的原因（控制台照实显示，不做静默停用） */
  disabledReason?: string
  createdAtMs: number
  updatedAtMs: number
  createdBy?: string
}

/** 一次执行记录。 */
export interface ScheduleRun {
  runId: string
  jobId: string
  /** 派发时刻 */
  startedAtMs: number
  finishedAtMs?: number
  /**
   * 只记**派发**的结果，不冒充"任务成功"：
   * Hub 不解析会话事件（设计如此），所以它只知道"指令交出去了没有"。
   *   dispatched      已交给节点执行
   *   queued-offline  目标节点离线，已进离线邮箱（不是失败）
   *   skipped         这一轮被跳过（例如任务已停用、或时间点已过期）
   *   failed          派发失败（含原因）
   */
  status: 'dispatched' | 'queued-offline' | 'skipped' | 'failed'
  sessionId?: string
  /** 员工与指令的简短说明，列表里一眼能认出是哪次 */
  detail?: string
  error?: string
}

/* ────────────────────────────── 离线邮箱 ────────────────────────────── */

export type MailboxKind = 'session.prompt' | 'session.create' | 'session.cancel' | 'employee.invoke'

/**
 * 发给离线节点的一条待办。
 *
 * 节点重连后按 `createdAtMs` 顺序拉取，逐条 ack。
 * 这是"5 个员工分布在 2 台终端、服务器中转"场景下断线不丢活的关键。
 */
/**
 * 离线邮箱的一条记录。
 *
 * ⚠️ **预留，未接线**：类型（含租约/重投所需的 `attempts` / `deliveredAtMs` /
 * `ackedAtMs`）与 `mailbox.json` 状态文件都在，但全仓库**没有任何入队、出队、
 * 重投实现**，`Hub.requestToNode` 在节点离线时是立即返回 `node-offline`。
 * 也就是说"节点掉线期间的请求排队等重连"**当前不成立** —— 读这个类型时别误以为
 * 它已经在工作。见 docs/03 §3.7 与 docs/05 §14。
 */
export interface MailboxItem {
  mailId: string
  nodeId: string
  kind: MailboxKind
  /** 原始方法名（与 METHODS 对齐） */
  method: string
  params: unknown
  /** 发起方的 correlation id，结果回流时用它定位等待者 */
  correlationId: string
  createdAtMs: number
  attempts: number
  /** 已投递但未 ack 的时间；超过租期会被重新投递 */
  deliveredAtMs?: number
  ackedAtMs?: number
  /**
   * 最近一次投递失败的原因（仅"结果未知"类失败会写）。
   * 保留它是因为这类失败**不自动无限重试**（重试可能让员工收到重复指令），
   * 所以原因必须留在队列里让人看得见，而不是只进一次日志。
   */
  lastError?: string
}
