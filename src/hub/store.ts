/**
 * Hub 持久化 —— 一个域一个 JSON 文件，全部走原子写。
 *
 * 为什么不用数据库：本产品的状态量极小（几十个设备、几十个员工、几百条记录），
 * 而 JSON 文件的好处是**运维可以直接看、可以直接改、可以直接备份**。
 * 每个域独立文件则避免了一个域的损坏波及全部状态。
 *
 * 一致性策略：内存里持有权威副本，每次变更后立即原子落盘（写临时文件 + rename）。
 * 不做批量写合并 —— 状态量小，正确性比吞吐重要。RPC 幂等账本独立落盘，避免业务域与去重状态互相覆盖。
 */

import path from 'node:path'

import { dseHome, ensureDir, newId, pathExists, readJsonFile, writeJsonFile } from '../util/fsx.ts'
import { loadOrCreateIdentity, type IdentityFile } from '../util/identity.ts'
import type {
  AclRule,
  ApprovalRecord,
  EmployeeRecord,
  IdempotencyRecord,
  InvokeRecord,
  LlmEndpointRecord,
  MailboxItem,
  NodeRecord,
  OfficePrefs,
  PairedDevice,
  PairingRequest,
  PositionEntry,
  PushSubscriptionRecord,
  ScheduleJob,
  ScheduleRun,
} from './types.ts'

export { newId }

/** 内置岗位「通用」——它就是"和以前一样"的那个界面，老员工天然等价，无需迁移。 */
export function defaultPosition(): PositionEntry {
  const now = Date.now()
  return { id: 'general', name: '通用', panels: [], builtin: true, createdAtMs: now, updatedAtMs: now }
}

export interface HubConfig {
  hubId: string
  name: string
  /** 监听端口 */
  port: number
  /** 监听地址。默认回环；开放给网络需显式设置并配合 TLS/反代 */
  host: string
  createdAtMs: number
  /**
   * 允许自动批准"首次、无 scope 请求、role=node"配对的 CIDR 列表。
   * 默认空 = 一切配对都需人工审批（对齐 OpenClaw 的安全姿态）。
   */
  autoApproveCidrs: string[]
  /**
   * 「允许新设备注册」的开关：`'closed'` = 关；`undefined`/`'open'` = 开。
   *
   * **默认是开的**（沿用这个开关出现之前的行为）：升级后自己的设备不会突然进不去。
   * 要藏起来就在控制台的「设备」页点「关闭注册」。
   *
   * 关着的时候，**没有本机设备凭据的 HTTP 访问一律 404**（与 nginx 的 404 逐字节一致）——
   * 于是公网上不存在一个常驻的、未认证可访问的注册入口（那正是审计里"唯一屏障
   * 只有一个 6 位配对码"的根源）。
   *
   * 「有凭据」= 浏览器带着配对时拿到的 `dse_device` cookie（见 `POST /session`）。
   * 没有它，自己的浏览器刷新一下也会 404 —— 所以 cookie 不是锦上添花，是这个开关
   * 能用的前提（见 server.ts 的 `#maybeHideFromStrangers`）。
   */
  pairingMode?: 'open' | 'closed'
  /**
   * 限时开放的截止时刻（仅当 `pairingMode !== 'closed'` 时有意义）。
   * 到点之后**自动回到关闭**（"忘了关"是这类开关最常见的失败方式）。
   * `undefined` = 一直开着，直到有人手动关。
   */
  pairingWindowUntilMs?: number
}

export interface HubState {
  config: HubConfig
  identity: IdentityFile
  pending: Record<string, PairingRequest>
  paired: Record<string, PairedDevice>
  nodes: Record<string, NodeRecord>
  employees: Record<string, EmployeeRecord>
  acl: AclRule[]
  approvals: Record<string, ApprovalRecord>
  invokes: Record<string, InvokeRecord>
  mailbox: Record<string, MailboxItem>
  /** Web Push 订阅（键是 endpoint）—— 手机通知用 */
  pushSubscriptions: Record<string, PushSubscriptionRecord>
  /** LLM 端点库（BaseURL + Key 输一次、多员工复用；密钥在里面，见 LlmEndpointRecord） */
  llmEndpoints: Record<string, LlmEndpointRecord>
  /**
   * 员工级"审批自动放行"（employeeId → 打开时刻）。**在者即为开**。
   *
   * 为什么放 Hub 而不是节点：审批的裁决本来就在 Hub 这一层（dsh 的审批请求抬上来，
   * 人在控制台裁决，再回填给 dsh）。所以"这个员工的审批不用问我"是一条**Hub 侧策略**，
   * 不需要 dsh 支持任何东西 —— 这也正是它在 dsh 没暴露"按员工设权限档位"接口时的价值。
   *
   * 语义边界（必须说清，否则等于偷偷拆掉刹车）：
   *   · 只放行 **dsh.approval**（工具要执行什么），**不放行 dsh.question**（模型在问人问题，
   *     自动编个答案等于替人做决定）；也完全不动**沙箱**——越界读写仍被 dsh 挡。
   *   · 放行会留痕：审批记录里写 `resolvedBy: 'auto:<员工>'`，审批页看得到。
   */
  autoApprove: Record<string, number>
  /** 定时任务（键是 jobId） */
  jobs: Record<string, ScheduleJob>
  /** 定时任务的执行记录（键是 runId，按上限裁剪最旧的） */
  scheduleRuns: Record<string, ScheduleRun>
  officePrefs: OfficePrefs
  /** 岗位目录（用户可增删的共享数据；员工身份里只存 id） */
  positions: Record<string, PositionEntry>
  /** Hub RPC 幂等账本（有限保留期；原始 params 不落盘；响应文件与 Hub 状态同为本机私有数据）。 */
  idempotency: Record<string, IdempotencyRecord>
}

const DEFAULT_PORT = 19790
const DEFAULT_HOST = '127.0.0.1'

export class HubStore {
  readonly root: string
  readonly files: {
    config: string
    identity: string
    pending: string
    paired: string
    nodes: string
    employees: string
    acl: string
    approvals: string
    invokes: string
    mailbox: string
    /** Web Push 订阅 */
    pushSubscriptions: string
    /** 定时任务定义 */
    jobs: string
    /** 定时任务执行记录 */
    scheduleRuns: string
    /** 办公区排序偏好（组顺序 + 组内员工顺序）。见 OfficePrefs 的注释。 */
    officePrefs: string
    /** 岗位目录（岗位 id → 条目）；员工身份里只存 id */
    positions: string
    /** 配对码（只存 sha256 + 过期/已用标记）。见 paircode.ts 的安全设计说明。 */
    pairCode: string
    /** LLM 端点库（0600；里面有 API Key） */
    llmEndpoints: string
    /** 员工级"审批自动放行"开关 */
    autoApprove: string
    /** 节点上报的配对码池（offerId → NodePairCode）。与 Hub 码分文件：来源与生命周期都不同。 */
    nodePairCodes: string
    /** Hub 是从哪个提交部署的（部署脚本写；升级按钮据此把节点升到同一版本）。 */
    deployedCommit: string
    /** 状态目录独占锁。见 `Hub#acquireStateLock`。 */
    lock: string
    idempotency: string
  }
  #state: HubState | undefined
  #idempotencySaveQueue: Promise<void> = Promise.resolve()

  constructor(homeOverride?: string) {
    this.root = path.join(dseHome(homeOverride), 'hub')
    this.files = {
      config: path.join(this.root, 'hub.json'),
      identity: path.join(this.root, 'identity', 'hub.json'),
      pending: path.join(this.root, 'devices', 'pending.json'),
      paired: path.join(this.root, 'devices', 'paired.json'),
      nodes: path.join(this.root, 'nodes.json'),
      employees: path.join(this.root, 'employees.json'),
      acl: path.join(this.root, 'acl.json'),
      approvals: path.join(this.root, 'approvals.json'),
      invokes: path.join(this.root, 'invokes.json'),
      mailbox: path.join(this.root, 'mailbox.json'),
      pushSubscriptions: path.join(this.root, 'push-subscriptions.json'),
      jobs: path.join(this.root, 'jobs.json'),
      scheduleRuns: path.join(this.root, 'schedule-runs.json'),
      officePrefs: path.join(this.root, 'office-prefs.json'),
      positions: path.join(this.root, 'positions.json'),
      pairCode: path.join(this.root, 'pair-code.json'),
      llmEndpoints: path.join(this.root, 'llm-endpoints.json'),
      autoApprove: path.join(this.root, 'auto-approve.json'),
      nodePairCodes: path.join(this.root, 'pair-code-nodes.json'),
      deployedCommit: path.join(this.root, 'deployed-commit.txt'),
      lock: path.join(this.root, 'hub.lock'),
      idempotency: path.join(this.root, 'idempotency.json'),
    }
  }

  /** 载入（或首次创建）全部状态。幂等：多次调用只读一次磁盘。 */
  async load(options: { port?: number; host?: string; name?: string } = {}): Promise<HubState> {
    if (this.#state !== undefined) return this.#state
    await ensureDir(this.root)

    const config = await readOrInit<HubConfig>(this.files.config, () => ({
      hubId: newId('hub'),
      name: options.name ?? 'DSEmployee Hub',
      // 注意：这里必须用**文件默认值**，不能用调用方传进来的覆盖值。
      // 否则一次 `dse hub --host 0.0.0.0` 就会把 0.0.0.0 永久固化进配置文件，
      // 此后不加任何参数启动也会绑到全网卡 —— 命令行覆盖绝不该变成持久默认值。
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      createdAtMs: Date.now(),
      autoApproveCidrs: [],
    }))

    // 命令行覆盖监听参数：只影响本次运行的内存值，不落盘（避免误改部署配置）
    if (options.port !== undefined) config.port = options.port
    if (options.host !== undefined) config.host = options.host

    const identity = await loadOrCreateIdentity(this.files.identity, 'hub', config.name)

    this.#state = {
      config,
      identity,
      pending: await readOrInit<Record<string, PairingRequest>>(this.files.pending, () => ({})),
      paired: await readOrInit<Record<string, PairedDevice>>(this.files.paired, () => ({})),
      nodes: await readOrInit<Record<string, NodeRecord>>(this.files.nodes, () => ({})),
      employees: await readOrInit<Record<string, EmployeeRecord>>(this.files.employees, () => ({})),
      acl: await readOrInit<AclRule[]>(this.files.acl, () => []),
      approvals: await readOrInit<Record<string, ApprovalRecord>>(this.files.approvals, () => ({})),
      invokes: await readOrInit<Record<string, InvokeRecord>>(this.files.invokes, () => ({})),
      mailbox: await readOrInit<Record<string, MailboxItem>>(this.files.mailbox, () => ({})),
      pushSubscriptions: await readOrInit<Record<string, PushSubscriptionRecord>>(
        this.files.pushSubscriptions,
        () => ({}),
      ),
      llmEndpoints: await readOrInit<Record<string, LlmEndpointRecord>>(
        this.files.llmEndpoints,
        () => ({}),
      ),
      autoApprove: await readOrInit<Record<string, number>>(this.files.autoApprove, () => ({})),
      jobs: await readOrInit<Record<string, ScheduleJob>>(this.files.jobs, () => ({})),
      scheduleRuns: await readOrInit<Record<string, ScheduleRun>>(this.files.scheduleRuns, () => ({})),
      officePrefs: await readOrInit<OfficePrefs>(this.files.officePrefs, () => ({
        groupOrder: [],
        employeeOrder: {},
      })),
      positions: await readOrInit<Record<string, PositionEntry>>(this.files.positions, () =>
        // 首次启动只放一个内置「通用」：它就是"和以前一样"的那个界面，
        // 因此老员工（没有 position 字段）与它天然等价，不需要任何迁移。
        ({ general: defaultPosition() }),
      ),
      idempotency: await readOrInit<Record<string, IdempotencyRecord>>(this.files.idempotency, () => ({})),
    }
    return this.#state
  }

  state(): HubState {
    if (this.#state === undefined) throw new Error('HubStore.load() must be called first')
    return this.#state
  }

  /* ── 跨进程一致性 ── */

  /** 记录每个域上次读盘时的 (mtime, size)，用于判断外部是否改过文件。 */
  readonly #stamps = new Map<string, string>()

  /**
   * 重新读取设备台账（pending + paired），**仅当文件在磁盘上变了**。
   *
   * 为什么必须做这件事：`dse pair approve` 是**在 Hub 本机直接改文件的**（见 cli.ts 里的
   * 引导说明），而 Hub 进程内存里有自己的副本。没有这一步的话，用户批准完之后设备重连
   * 依然会被判为未配对 —— 引导流程直接失效。
   *
   * 代价是每次握手多两次 `stat`（内容只在真正变化时才读），相对握手本身的成本可以忽略。
   */
  async refreshDevices(): Promise<{ pendingChanged: boolean; pairedChanged: boolean }> {
    const state = this.state()
    const pending = await this.#reloadIfChanged<Record<string, PairingRequest>>(
      this.files.pending,
      state.pending,
    )
    const paired = await this.#reloadIfChanged<Record<string, PairedDevice>>(
      this.files.paired,
      state.paired,
    )
    const pendingChanged = pending !== state.pending
    const pairedChanged = paired !== state.paired
    if (pendingChanged) state.pending = pending
    if (pairedChanged) state.paired = paired
    return { pendingChanged, pairedChanged }
  }

  async #reloadIfChanged<T>(file: string, current: T): Promise<T> {
    const stamp = await fileStamp(file)
    if (stamp === undefined) return current
    if (this.#stamps.get(file) === stamp) return current
    this.#stamps.set(file, stamp)
    try {
      return await readJsonFile<T>(file, current)
    } catch {
      // 磁盘上出现了损坏内容：保留内存里的可用状态，不要把损坏扩散进来
      return current
    }
  }

  /** 手工标记某个域为"已是最新"，供本进程自己写完盘后调用，避免自己触发一次多余重读。 */
  async markFresh(file: string): Promise<void> {
    const stamp = await fileStamp(file)
    if (stamp !== undefined) this.#stamps.set(file, stamp)
  }

  /** 写盘并立刻记账，使本进程自己的写入不会被 `refreshDevices()` 判为"外部变更"。 */
  async #saveAndMark(file: string, value: unknown): Promise<void> {
    await writeJsonFile(file, value)
    await this.markFresh(file)
  }

  /* ── 落盘（每个域一个方法，调用点显式说明自己在改哪个域）── */

  saveConfig(): Promise<void> {
    return writeJsonFile(this.files.config, this.state().config)
  }
  savePending(): Promise<void> {
    return this.#saveAndMark(this.files.pending, this.state().pending)
  }
  savePaired(): Promise<void> {
    return this.#saveAndMark(this.files.paired, this.state().paired)
  }
  saveNodes(): Promise<void> {
    return writeJsonFile(this.files.nodes, this.state().nodes)
  }
  saveEmployees(): Promise<void> {
    return writeJsonFile(this.files.employees, this.state().employees)
  }
  saveAcl(): Promise<void> {
    return writeJsonFile(this.files.acl, this.state().acl)
  }
  saveApprovals(): Promise<void> {
    return writeJsonFile(this.files.approvals, this.state().approvals)
  }
  saveInvokes(): Promise<void> {
    return writeJsonFile(this.files.invokes, this.state().invokes)
  }
  saveMailbox(): Promise<void> {
    return writeJsonFile(this.files.mailbox, this.state().mailbox)
  }
  savePushSubscriptions(): Promise<void> {
    return writeJsonFile(this.files.pushSubscriptions, this.state().pushSubscriptions)
  }
  saveLlmEndpoints(): Promise<void> {
    /* 里面有 API Key：写盘权限与配对台账同级（0600 由 writeJsonFile 的默认值保证） */
    return writeJsonFile(this.files.llmEndpoints, this.state().llmEndpoints)
  }
  saveAutoApprove(): Promise<void> {
    return writeJsonFile(this.files.autoApprove, this.state().autoApprove)
  }
  saveJobs(): Promise<void> {
    return writeJsonFile(this.files.jobs, this.state().jobs)
  }
  saveScheduleRuns(): Promise<void> {
    return writeJsonFile(this.files.scheduleRuns, this.state().scheduleRuns)
  }
  saveOfficePrefs(): Promise<void> {
    return writeJsonFile(this.files.officePrefs, this.state().officePrefs)
  }

  savePositions(): Promise<void> {
    return writeJsonFile(this.files.positions, this.state().positions)
  }

  /** 串行快照写入，避免并发完成的不同 RPC 互相覆盖幂等记录。 */
  saveIdempotency(): Promise<void> {
    const write = () => writeJsonFile(this.files.idempotency, this.state().idempotency)
    const next = this.#idempotencySaveQueue.then(write, write)
    this.#idempotencySaveQueue = next.catch(() => {})
    return next
  }
}

/**
 * `mtimeMs:size` 形式的文件戳。文件不存在时返回 undefined。
 *
 * 只 stat 不读内容 —— 跨进程一致性的检查会发生在每次握手上，
 * 必须比读一遍文件便宜得多。
 */
async function fileStamp(file: string): Promise<string | undefined> {
  try {
    const { stat } = await import('node:fs/promises')
    const info = await stat(file)
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return undefined
  }
}

/**
 * 读 JSON；文件不存在时调用 `init` 创建并落盘。
 *
 * 与 `readJsonFile` 的区别：这里把"不存在"与"内容损坏"分开处理 ——
 * 不存在是正常首启，损坏必须抛错让人看见（不静默重置安全状态）。
 */
async function readOrInit<T>(file: string, init: () => T): Promise<T> {
  if (await pathExists(file)) {
    return readJsonFile<T>(file, undefined as unknown as T)
  }
  const created = init()
  await writeJsonFile(file, created)
  return created
}
