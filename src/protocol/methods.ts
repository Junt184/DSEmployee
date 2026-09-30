/**
 * RPC 方法表 —— **权限的唯一单点定义**。
 *
 * 服务端在派发前逐方法查这张表：
 *   - 未知方法 → `unknown-method`（fail-closed，不做任何猜测）
 *   - 所需 scope 未被授予 → `forbidden`
 *   - `idempotent: true` 的方法缺幂等键 → `idempotency-key-required`；同设备同 key 同参数只执行一次（Hub 持久缓存响应）
 *   - `routed: 'node'` 的方法不在 Hub 本地执行，而是路由给员工所在的终端节点
 *
 * 把权限写在这里而不是散落在各 handler 里，是为了让"谁能做什么"可以一次读完、一次改对。
 */

import type { Scope } from './scopes.ts'

/** 方法的执行位置。 */
export type MethodRoute =
  /** Hub 本地执行（目录聚合、设备管理、ACL 等） */
  | 'hub'
  /** 路由到员工所在的终端节点执行（真正驱动 dsh） */
  | 'node'
  /** 由调用方指定目标节点；Hub 只做转发与鉴权 */
  | 'relay'

export interface MethodSpec {
  /** 所需 scope。空数组 = 认证后即可用。 */
  readonly scopes: readonly Scope[]
  /** 执行位置 */
  readonly route: MethodRoute
  /** 要求幂等键；Hub 按设备 + key + method/params 摘要持久缓存响应，保留 24 小时并有总量上限。 */
  readonly idempotent?: boolean
  /** 允许的连接角色 */
  readonly roles: readonly ('operator' | 'node')[]
  /** 一句话说明 */
  readonly summary: string
}

const BOTH = ['operator', 'node'] as const
const OPERATOR_ONLY = ['operator'] as const
const NODE_ONLY = ['node'] as const

export const METHODS = {
  /* ── 系统 ── */
  health: {
    scopes: [],
    route: 'hub',
    roles: BOTH,
    summary: 'Hub 健康快照（版本、在线节点数、员工数）',
  },
  whoami: {
    scopes: [],
    route: 'hub',
    roles: BOTH,
    summary: '返回当前连接协商出的 role / scopes / deviceId',
  },

  /* ── 设备配对与令牌 ── */
  'device.list': {
    scopes: ['device.pair'],
    route: 'hub',
    roles: OPERATOR_ONLY,
    summary: '列出待审批与已配对的设备',
  },
  'device.pair.approve': {
    scopes: ['device.pair'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '批准一个待配对请求，并签发有界设备令牌',
  },
  'device.pair.reject': {
    scopes: ['device.pair'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '拒绝一个待配对请求',
  },
  'device.pair.remove': {
    scopes: ['device.pair'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '移除一条已配对记录（该设备令牌随之失效）',
  },
  /**
   * 配对码兑换 —— bootstrap 专用口子。
   *
   * 为什么这是安全的：配对码的信任锚是"能看到 Hub 终端输出 / 能在 Hub 本机执行
   * `dse pair-code`"，与 `pair approve` 的"能读写 Hub 状态文件"**同级**（见
   * paircode.ts 与 cli.ts 的引导说明）。它声明空 scope 是因为调用方此刻必然
   * 还没配对、什么 scope 都没有 —— 但它**不因此绕过**任何校验：
   * 码只存 sha256、一次性、24h 过期；redeem 只批准一条已存在的 pending 请求，
   * 令牌仍只签发给持有对应私钥的设备（claimToken 在签名握手内完成）；
   * 另有按 IP 的防爆破计数（见 server.ts / handlers.ts）。
   *
   * 它还在**未认证**（awaiting-connect）阶段被单独受理 —— 见 server.ts 的握手分支。
   */
  'device.pair.redeem': {
    scopes: [],
    route: 'hub',
    roles: BOTH,
    summary: '用 6 位配对码批准一个待配对请求（bootstrap 通道）',
  },
  'device.token.rotate': {
    scopes: ['device.pair'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '在其已批准 role/scope 上限内轮换设备令牌',
  },
  'device.token.revoke': {
    scopes: ['device.pair'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '吊销设备令牌（保留配对记录）',
  },

  /* ── 终端节点 ── */
  'node.list': {
    scopes: ['employee.read'],
    route: 'hub',
    roles: BOTH,
    summary: '列出终端节点及其在线状态、承载的员工数',
  },
  'node.describe': {
    scopes: ['employee.read'],
    route: 'hub',
    roles: BOTH,
    summary: '单个节点的详情（平台、dsh 版本、工作区根、员工清单）',
  },
  'node.register': {
    scopes: [],
    route: 'hub',
    idempotent: true,
    roles: NODE_ONLY,
    summary: '终端节点上报自身信息与承载的员工目录',
  },
  /**
   * 节点上报一个本机生成的配对码（进入 Hub 的节点码池）。
   *
   * 为什么节点配得上这个权：一台已配对的节点本来就持有能驱动其全部员工的
   * 身份，让它出配对码并不扩大攻击面；而场景是真实的 —— Hub 在云上时，
   * 人总在某个终端旁边，就近出码比 SSH 上去看启动输出顺手得多。
   * 约束在 handler / paircode.ts 里强制：有效期 ≤ 30 分钟、每节点 ≤ 3 个活跃码。
   */
  'node.update': {
    /* node.admin：管理终端节点（改名、改配置、重启）。这是它**第一个**真实用途 ——
       scope 早就在，只是从来没有方法用它（自升级正好是它存在的理由）。 */
    scopes: ['node.admin'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '让某个节点自己升级到指定提交（节点把版本准备好后主动重启）',
  },
  'node.paircode.offer': {
    scopes: [],
    route: 'hub',
    roles: NODE_ONLY,
    summary: '节点上报一个本机配对码（短命，供新设备就近授权）',
  },

  /* ── 员工（= 工作区）── */
  'employee.list': {
    scopes: ['employee.read'],
    route: 'hub',
    roles: BOTH,
    summary: '聚合各节点上报的员工目录',
  },
  'employee.get': {
    scopes: ['employee.read'],
    route: 'hub',
    roles: BOTH,
    summary: '单个员工详情（岗位说明、技能清单、所在节点、状态）',
  },
  'employee.create': {
    scopes: ['employee.manage'],
    route: 'node',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '在指定节点上创建一个员工（建工作区 + AGENTS.md + 专属 skills 目录）',
  },
  'employee.update': {
    scopes: ['employee.manage'],
    route: 'node',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '改员工显示名、岗位说明',
  },
  'employee.remove': {
    scopes: ['employee.manage'],
    route: 'node',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '注销一个员工（默认只移除注册，不删目录）',
  },
  'employee.files.list': {
    scopes: ['employee.read'],
    route: 'node',
    roles: BOTH,
    summary: '列出员工工作区里的知识库文件（受限于工作区根）',
  },
  'employee.files.get': {
    scopes: ['employee.read'],
    route: 'node',
    roles: BOTH,
    summary: '读取员工工作区内的一个文本文件',
  },
  /**
   * 把二进制文件递进员工工作区（控制台的"发文件"）。
   *
   * 为什么不复用 `employee.files.set`：那个方法是**文本**语义（知识库编辑，
   * 内容直接以字符串落盘）。二进制若走同一条路会强迫调用方把文件编码成字符串，
   * 而"检查过 base64 就写"这类隐式约定既不好审计、也不好在上限上把关。
   * 分开一个方法，二进制边界（大小上限、路径守卫）就在一处看得见。
   */
  'employee.files.upload': {
    scopes: ['employee.manage'],
    route: 'node',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '把二进制文件上传到员工工作区（≤2MB，base64 经 Hub 转发）',
  },
  'employee.files.set': {
    scopes: ['employee.manage'],
    route: 'node',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '写入员工工作区内的一个文本文件（知识库编辑）',
  },
  'employee.skills.list': {
    scopes: ['employee.read'],
    route: 'node',
    roles: BOTH,
    summary: '列出该员工可见的技能（含专属与全局，标注来源）',
  },

  /* ── 员工级 LLM 端点 ── */
  'employee.llm.get': {
    scopes: ['employee.read'],
    route: 'node',
    roles: OPERATOR_ONLY,
    summary: '读员工的模型列表（别名/端点/模型；apiKey 只回掩码）',
  },
  'employee.llm.save': {
    scopes: ['employee.manage'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '新增或修改员工的一条模型（Hub 按端点库解析出 BaseURL+Key 再下发节点）',
  },
  'employee.llm.activate': {
    scopes: ['employee.manage'],
    route: 'node',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '把「当前模型」切到某一条，并（给了 sessionId 时）把那个会话一起切过去',
  },
  'employee.llm.remove': {
    scopes: ['employee.manage'],
    route: 'node',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '删掉员工的一条模型（连它在 dsh 里的路由与凭据一起拆）',
  },
  'employee.llm.promote': {
    scopes: ['employee.manage'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '把员工手上那条"本地端点"（历史配置）收进端点库：取回 BaseURL+Key 建库并指向它（路由名不变）',
  },
  'employee.llm.linkEndpoint': {
    scopes: ['employee.manage'],
    route: 'node',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '节点侧：把某条模型指向端点库里的 id（条目 id 与路由名不变）',
  },
  'employee.llm.unset': {
    scopes: ['employee.manage'],
    route: 'node',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '清空员工的全部模型配置与 dsh 凭据（回落节点默认模型）',
  },
  'employee.llm.probe': {
    scopes: ['employee.manage'],
    route: 'node',
    roles: OPERATOR_ONLY,
    summary: '从端点拉取可用模型列表（节点直连 {apiUrl}/models，不经 dsh）',
  },
  'node.permission.get': {
    scopes: ['node.admin'],
    route: 'hub',
    roles: OPERATOR_ONLY,
    summary: '读某台节点的默认权限档位（dsh 的 settings.permission.defaultPreset）',
  },
  'node.permission.set': {
    scopes: ['node.admin'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '设某台节点的默认权限档位（**整机**生效，只影响新建会话；已有会话不变）',
  },
  'employee.autoApprove.set': {
    scopes: ['employee.manage'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '开/关某个员工的"审批自动放行"（只放行 dsh 审批，不放行提问、不动沙箱；裁决仍留痕）',
  },
  'llm.endpoint.list': {
    scopes: ['employee.read'],
    route: 'hub',
    roles: OPERATOR_ONLY,
    summary: '端点库列表（BaseURL+Key 输一次多员工复用；key 只回掩码，并标出谁在用）',
  },
  'llm.endpoint.upsert': {
    scopes: ['employee.manage'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '新增/修改端点库的一条；改了 BaseURL 或 Key 会同步到所有在用的员工',
  },
  'llm.endpoint.remove': {
    scopes: ['employee.manage'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '删端点库的一条（还有员工在用则拒绝并点名）',
  },
  'llm.endpoint.probe': {
    scopes: ['employee.manage'],
    route: 'hub',
    roles: OPERATOR_ONLY,
    summary: '试拉端点库某条的模型列表（经一台在线节点发请求）',
  },
  'llm.probe': {
    scopes: ['employee.manage'],
    route: 'node',
    roles: OPERATOR_ONLY,
    summary: '节点侧：拿给定的 BaseURL+Key 直连 {apiUrl}/models 拉模型列表（Hub 代为发探测用）',
  },

  /* ── 员工自定义头像 ── */
  'employee.avatar.get': {
    scopes: ['employee.read'],
    route: 'node',
    roles: OPERATOR_ONLY,
    summary: '读员工的自定义头像（base64，无则 exists:false）',
  },
  'employee.avatar.set': {
    scopes: ['employee.manage'],
    route: 'node',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '上传员工的自定义头像（png/webp/gif/jpeg，≤2MB）',
  },
  'employee.avatar.remove': {
    scopes: ['employee.manage'],
    route: 'node',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '删除员工的自定义头像（回落程序生成头像）',
  },

  /* ── 会话（对话框）── */
  'session.list': {
    scopes: ['employee.read'],
    route: 'node',
    roles: BOTH,
    summary: '列出某个员工工作区下的会话',
  },
  'session.create': {
    scopes: ['employee.prompt'],
    route: 'node',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '在员工工作区下新建一个会话（可选命名：title，节点侧两步落名）',
  },
  'session.prompt': {
    scopes: ['employee.prompt'],
    route: 'node',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '给员工的会话下达指令（核心动作）',
  },
  'session.cancel': {
    scopes: ['employee.prompt'],
    route: 'node',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '打断员工正在进行的轮次',
  },
  'session.compact': {
    scopes: ['employee.prompt'],
    route: 'node',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '压缩该会话的早期上下文（dsh /compact）',
  },
  'session.rename': {
    scopes: ['employee.prompt'],
    route: 'node',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '重命名一个会话',
  },
  'session.history': {
    scopes: ['employee.read'],
    route: 'node',
    roles: BOTH,
    summary: '读取会话历史（用于回放与分页）',
  },
  'session.subscribe': {
    scopes: ['employee.read'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '订阅某个会话的实时事件流',
  },
  'session.unsubscribe': {
    scopes: ['employee.read'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '取消订阅',
  },
  /**
   * 终端节点把 dsh 产生的会话事件推给 Hub，由 Hub 按订阅关系转发给控制端。
   *
   * 这是**唯一**由节点主动调用的写方法：Hub 绝不去轮询 dsh，
   * 事件流的推动方向永远是"节点 → Hub → 控制端"。
   */
  'session.push': {
    scopes: [],
    route: 'hub',
    roles: NODE_ONLY,
    summary: '节点上报一条会话事件（供 Hub 转发给已订阅的控制端）',
  },

  /* ── 员工互调 ── */
  'employee.activity': {
    scopes: ['employee.read'],
    route: 'hub',
    roles: OPERATOR_ONLY,
    summary: '员工活动汇总（元数据：定时任务执行、互调、审批、会话活跃度；不含对话正文）',
  },
  'employee.invoke': {
    scopes: ['employee.invoke'],
    route: 'relay',
    idempotent: true,
    roles: BOTH,
    summary: '以一个员工的身份调用另一个员工（跨机由 Hub 中转，受 ACL 与审批约束）',
  },
  'employee.invoke.list': {
    scopes: ['employee.read'],
    route: 'hub',
    roles: BOTH,
    summary: '查看互调记录（谁调了谁、是否经审批、结果）',
  },

  /* ── 授权 ── */
  'acl.get': {
    scopes: ['employee.read'],
    route: 'hub',
    roles: BOTH,
    summary: '读取员工互调授权表',
  },
  'job.self.list': {
    scopes: ['employee.read'],
    route: 'hub',
    roles: OPERATOR_ONLY,
    summary: '列出**自己**的定时任务（目标员工由绑定身份派生）',
  },
  'job.self.upsert': {
    scopes: ['job.self'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '给自己排任务（新建/改间隔/启停；只能动自己的）',
  },
  'job.self.remove': {
    scopes: ['job.self'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '删掉自己的某条任务',
  },
  'pairing.window': {
    scopes: ['device.pair'],
    route: 'hub',
    roles: OPERATOR_ONLY,
    summary: '查「允许新设备注册」窗口是否开着、还剩多久',
  },
  'pairing.window.set': {
    scopes: ['device.pair'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '开/关「允许新设备注册」窗口（开着时未配对的设备才能看到授权码入口）',
  },
  'push.key': {
    scopes: ['employee.read'],
    route: 'hub',
    roles: OPERATOR_ONLY,
    summary: '取 VAPID 公钥（浏览器订阅手机通知时要它）',
  },
  'push.subscribe': {
    scopes: ['employee.read'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '登记一台设备的推送订阅（手机通知）',
  },
  'push.unsubscribe': {
    scopes: ['employee.read'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '注销推送订阅',
  },
  'push.notify': {
    /* 让员工/定时任务也能"拍一下"用户：秘书汇报好了、任务失败了。
       不另设 scope 的原因：能调它的都是已配对设备（操作台或员工自己的凭据），
       而它只做一件事 —— 给这台机器的所有订阅发一条短通知，读不到任何数据。 */
    scopes: ['employee.read'],
    route: 'hub',
    idempotent: true,
    roles: BOTH,
    summary: '给这台机器的所有订阅发一条手机通知（正文要短，会经厂商推送服务转发）',
  },
  'job.list': {
    scopes: ['employee.read'],
    route: 'hub',
    roles: OPERATOR_ONLY,
    summary: '列出定时任务与它们最近的执行记录',
  },
  'job.upsert': {
    scopes: ['employee.manage'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '新建或修改一条定时任务（间隔、指令、启停）',
  },
  'job.remove': {
    scopes: ['employee.manage'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '删掉一条定时任务（同时清掉它的执行记录）',
  },
  'job.runNow': {
    scopes: ['employee.manage'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '立刻跑一轮（不动时间表，用于验证配置）',
  },
  'acl.remove': {
    scopes: ['employee.manage'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '删掉一条互调授权规则（写错的规则以前删不掉）',
  },
  'acl.set': {
    scopes: ['employee.manage'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '设置一条互调授权规则（允许/需审批/拒绝）',
  },

  /* ── 审批 ── */
  'approval.list': {
    scopes: ['employee.read'],
    route: 'hub',
    roles: BOTH,
    summary: '列出待裁决的审批请求（含 dsh 自身的审批与提问）',
  },
  /**
   * 节点上报一个 dsh 发起的交互（审批 / 提问）。
   *
   * 这是**唯一**能让"员工卡在审批上"被人在手机上看见的入口：审批闸在 dsh 里是
   * 进程内的 `approval/request` waterfall，终端上没人在就 fail-closed，所以必须由
   * 节点把它抬到 Hub 的审批中心。幂等键用 dsh 的 `rpcId`（同一请求重放不产生重复记录）。
   */
  'dsh.interaction.request': {
    scopes: [],
    route: 'hub',
    idempotent: true,
    roles: NODE_ONLY,
    summary: '节点上报一个 dsh 发起的审批/提问（进入 Hub 审批中心）',
  },
  /** 节点上报 dsh 侧已经解决（含超时中止）—— 用于把控制台上的卡片收尾，避免留下假待办。 */
  'dsh.interaction.settle': {
    scopes: [],
    route: 'hub',
    idempotent: true,
    roles: NODE_ONLY,
    summary: '节点上报 dsh 侧的审批/提问已解决',
  },
  /**
   * 回答一个**提问**（不是批准/拒绝）。
   *
   * 与 `approval.resolve` 分开是因为载荷语义完全不同：审批是二值裁决，
   * 提问是一组结构化选择（`AskUserQuestionAnswer`），Hub 不解释它、原样回填给 dsh。
   */
  'dsh.question.answer': {
    scopes: ['approval.resolve'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '回答员工提出的一个问题（回填给 dsh）',
  },

  /* ── 办公区显示偏好 ── */
  'office.order.get': {
    scopes: ['employee.read'],
    route: 'hub',
    roles: BOTH,
    summary: '读办公区排序偏好（组顺序 + 组内员工顺序）',
  },
  'office.order.set': {
    scopes: ['employee.manage'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '全量替换办公区排序偏好（未知组/员工容忍跳过）',
  },
  'position.list': {
    scopes: ['employee.read'],
    route: 'hub',
    roles: BOTH,
    summary: '读岗位目录（有哪些岗位，及各自勾选的面板）',
  },
  'position.upsert': {
    scopes: ['employee.manage'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '新增或改名一个岗位（按 id 幂等；内置「通用」可改名）',
  },
  'position.remove': {
    scopes: ['employee.manage'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '删除一个岗位（内置「通用」不可删）；仍绑着它的员工会被改回通用',
  },
  'approval.resolve': {
    scopes: ['approval.resolve'],
    route: 'hub',
    idempotent: true,
    roles: OPERATOR_ONLY,
    summary: '裁决一个审批请求（批准/拒绝）',
  },
} as const satisfies Record<string, MethodSpec>

export type MethodName = keyof typeof METHODS

/** 全部方法名（含本地与路由方法）。 */
export const METHOD_NAMES = Object.keys(METHODS) as MethodName[]

export function isMethodName(value: string): value is MethodName {
  return Object.hasOwn(METHODS, value)
}

export function methodSpec(name: MethodName): MethodSpec {
  return METHODS[name]
}

/**
 * 供 `hello-ok.features.methods` 使用的发现清单。
 * 按调用方角色过滤 —— 节点不该看到 operator 专属方法，这是"信息最小化"。
 */
export function methodsVisibleTo(role: 'operator' | 'node'): MethodName[] {
  return METHOD_NAMES.filter((name) => (METHODS[name].roles as readonly string[]).includes(role))
}
