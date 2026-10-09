/**
 * 终端节点代理 —— 员工真正"住"的地方。
 *
 * 它做四件事，每一件都对应一个明确的边界：
 *   1. **托管本机 dsh**（`DshProcess`），因为驱动 `/api` 的进程必须与 dsh 同机；
 *   2. **管员工 = 管工作区**（`EmployeeStore`），并把自己的目录**上报**给 Hub；
 *   3. **执行 Hub 下发的请求**，把它翻译成 dsh 的 `/api` 调用；
 *   4. **把 dsh 的输出推回 Hub**，由 Hub 按订阅关系分发给手机/控制台。
 *
 * 关于事件形状的实测结论（dsh 0.1.0-rc.6，docs/04 §10.3）：
 *   下行流里所有帧共用 `server-request` 信封，靠 method 区分；会话输出走
 *   `session/event`，payload 顶层恒有 `sessionId`，内层事件词汇见 §10.2。
 *   这里的职责仍是**搬运而不是解释**：把帧按订阅归属推给 Hub，由控制端渲染。
 */

import path from 'node:path'

import { HubClient, HubCallError } from '../client/hub-client.ts'
import { currentCodeFingerprint, packageRoot, runtimeEntry } from '../protocol/build.ts'
import { protocolError, type ProtocolErrorShape, type ReqFrame } from '../protocol/index.ts'
import { dseHome, ensureDir, findFreePort, newId, readJsonFile, writeFileAtomic, writeJsonFile } from '../util/fsx.ts'
import {
  DshClient,
  DshApiError,
  DshCarrierError,
  type DshDownlink,
  type DshEventFrame,
  type ServerRequestFrame,
} from './dsh-client.ts'
import { DshProcess } from './dsh-process.ts'
import { markConnected, releasePaths, resolveUpdateRepo } from './release.ts'
import { prepareRelease } from './update.ts'
import { EmployeeStore, type DiscoveredEmployee } from './employees.ts'
import { ensureFileDeliveryInstructions } from './file-delivery.ts'
import { forwarderPort, normalizeProxyConfig, startLocalForwarder, type LocalForwarder, type Upstream } from './llm-proxy.ts'
import { isPermissionPreset, PERMISSION_PRESETS, readDefaultPreset, writeDefaultPreset } from './permission.ts'
import { historyEntrySeq, pageEvents, sanitizeHistoryEvents, sanitizeLiveEvent } from './session-payload.ts'
import { SessionArchiveStore } from './session-archive.ts'
import {
  activeModelOf,
  applyLlmToSession,
  assertLlmApiUrl,
  deleteLlmConfig,
  llmRouteKeyFor,
  llmViewModel,
  modelRouteFor,
  newModelId,
  normalizeModelName,
  probeModels,
  readLlmFile,
  selectModelForSession,
  unwireModelFromDsh,
  wireModelToDsh,
  writeLlmFile,
  type EmployeeLlmFile,
  type EmployeeModelEntry,
} from './employee-llm.ts'

/**
 * 本机记住的 Hub 地址文件名（`$DSE_HOME/hub-url`）。
 *
 * 稳定启动脚本（scripts/start-node.ps1 / run-node.sh）从它读 Hub 地址 —— 那两个脚本
 * 在公开仓库里，所以地址不能写在脚本里；而写成占位符又会让已经部署的机器重启后连不上。
 * 由节点自己落一份，两边都不用把地址写进仓库。
 * 导出是为了让测试能钉住"写的人与读的人指的是同一个路径"。
 */
export const HUB_URL_FILE = 'hub-url'

/** 把 Hub 地址写到 `$DSE_HOME/hub-url`（一行，末尾换行；0600）。 */
export async function writeHubUrlFile(home: string, hubUrl: string): Promise<void> {
  const url = hubUrl.trim()
  if (url === '') throw new Error('hubUrl is empty')
  await writeFileAtomic(path.join(home, HUB_URL_FILE), `${url}\n`, 0o600)
}

export interface NodeAgentOptions {
  /** 本产品家目录（默认 ~/.dsemployee） */
  home?: string
  /** Hub 的 WS 地址 */
  hubUrl: string
  /** 节点显示名 */
  name: string
  /** 员工工作区根目录 */
  employeeRoot: string
  /** dsh 的 DSH_HOME。省略则用 dsh 默认（~/.dsh） */
  dshHome?: string
  /** 由我们托管 dsh 吗？false 表示连一个已经在跑的实例（需给 dshPort） */
  manageDsh?: boolean
  /** 托管模式下期望的端口（0 = 让 dsh 自选） */
  dshPort?: number
  /** 非托管模式下要连接的端口 */
  attachPort?: number
  /** dsh 可执行文件名或路径 */
  dshCommand?: string
  /**
   * 传给**托管的 dsh 子进程**的环境变量。
   *
   * 最常用的是 `DEEPSEEK_API_KEY`：dsh 找不到模型凭据时整轮会以
   * `MISSING_CREDENTIAL` 失败 —— 那条错误会一路回传到调用方，
   * 所以这里必须能把凭据传进去，否则员工看起来"能连上但一干活就失败"。
   */
  dshEnv?: Record<string, string>
  /**
   * 新建会话的节点级默认 agent preset。
   *
   * 取值顺序（session.create）：调用参数显式指定 > 员工配置（employee.agentPreset）> 本默认。
   * 为什么需要它：dsh 自己的部署默认是 `minimal`，而 minimal **没有** `/compact`（压缩）
   * 等能力 —— 三者都不给时会话会落到残缺的工具集上。CLI（dse node）默认传 `standard`。
   */
  defaultPreset?: string
  verbose?: boolean
}

export class NodeAgent {
  readonly options: NodeAgentOptions
  readonly #verbose: boolean
  #dshProcess: DshProcess | undefined
  #dsh: DshClient | undefined
  #store: EmployeeStore | undefined
  #hub: HubClient | undefined
  #downlink: DshDownlink | undefined
  #stopping = false
  /** 被控制端订阅的 sessionId 集合 */
  readonly #watchedSessions = new Set<string>()
  /** sessionId → employeeId（推送事件时用来做归属校验） */
  readonly #sessionOwner = new Map<string, string>()
  readonly #sessionArchives = new SessionArchiveStore()
  /**
   * 每个会话**最后一次事件**的时刻（不区分有没有人在看）。
   *
   * 为什么必须在这里记：控制台要在"没人开着那个对话"时也能回答"它是不是卡住了"——
   * 而那正是线上事故的现场（员工卡在 bash 上，没人盯着那个会话，界面只显示"运行中"）。
   * 记在节点侧而不是 Hub 侧：Hub 刻意**不解析**会话事件（它只转发），而节点本来就在
   * 转发每一个事件，顺手记时间戳是零成本的。判据用的是"running 且 N 分钟零事件"。
   */
  readonly #sessionLastEventAt = new Map<string, number>()

  constructor(options: NodeAgentOptions) {
    this.options = options
    this.#verbose = options.verbose ?? false
    // 不给节点级缺省 preset 时，新会话会落到 **dsh 自己的部署默认**，
    // 而实测那是 `minimal` —— 没有 /compact、没有 ask_user_question、没有沙箱提权。
    // 症状很隐蔽：员工能连上、能回话，只是某些能力"用不了"。CLI 默认传 standard，
    // 但直接构造 NodeAgent 的调用方（含本仓库的 e2e 脚本）容易漏 —— 这里必须说出来。
    if (options.defaultPreset === undefined) {
      this.#log(
        'warning: no --default-preset given; new sessions fall back to dsh\'s deployment default, ' +
          "which is usually 'minimal' (no /compact, no ask_user_question, no sandbox escalation). " +
          "Pass defaultPreset: 'standard' unless that is intentional.",
      )
    }
    /* 启动时就算出本进程的代码指纹（内部带缓存）。必须在这里算：它读的是磁盘上的
       源码，懒算会把"部署后没重启"的那份新代码算进来，于是报出去的是**磁盘的版本**
       而不是**本进程真正在跑的版本** —— 与 Hub 的比对就失去意义了。 */
    currentCodeFingerprint()
  }

  get dshPort(): number | undefined {
    return this.#dshProcess?.port ?? this.options.attachPort
  }

  /* ────────────────────────── 启动 ────────────────────────── */

  async start(): Promise<void> {
    const home = dseHome(this.options.home)
    await ensureDir(home)
    await ensureDir(this.options.employeeRoot)

    /* 记下这次连的是哪个 Hub（`$DSE_HOME/hub-url`）。
     *
     * 为什么节点要管这件事：稳定启动脚本（scripts/start-node.*）必须知道 Hub 地址，
     * 而它在**公开仓库**里。把地址写死在脚本里 = 把一个运营者的部署域名随仓库发给
     * 每个 clone 的人；写成占位符又会让那台机器在下次重启后连不上。
     * 真正知道地址的是节点自己（`--hub` 传进来的），所以由它落到本机一份，
     * 启动脚本从那里读 —— 两边都不必把地址写进仓库。
     *
     * 地址是 URL 不是凭据，泄漏面很小；放进 `$DSE_HOME` 只因为它属于
     * 「这台机器的配置」，不属于产品代码。非致命：写不进去不该拦住节点启动。 */
    await writeHubUrlFile(home, this.options.hubUrl).catch(() => {})

    // 1) dsh：托管或附着
    const port = await this.#ensureDsh()
    this.#dsh = new DshClient({ port, verbose: this.#verbose })
    const describe = await this.#dsh.hostDescribe()
    this.#log(`attached to dsh ${describe.version} on port ${port} (cwd=${describe.cwd})`)

    // 2) 员工存储
    this.#store = new EmployeeStore(this.options.employeeRoot, this.#dsh)
    await this.#store.init()

    // 3) 下行流：dsh 的事件从这里来。
    // 断连由 DshDownlink 自己退避重连（dsh 被 DshProcess 在同一端口自愈后，
    // 流会自己回来）；这里只如实记录 —— 断开期间的输出是**真的丢了**
    // （mux 无回放），日志必须能看出断流区间。
    this.#downlink = this.#dsh.openDownlink()
    this.#downlink.on('request', (frame) => {
      void this.#forwardDshFrame(frame)
    })
    // 会话事件帧（session/event 等只读通知）—— 实时输出走这条路到 Hub
    this.#downlink.on('event', (frame) => {
      void this.#forwardDshEvent(frame)
    })
    this.#downlink.on('open', (info) => this.#log(`downlink connected: ${info.channel}`))
    this.#downlink.on('error', (error) => this.#log(`downlink error: ${error.message}`))
    this.#downlink.on('close', (info) =>
      this.#log(`downlink closed: ${info.channel}; will auto-reconnect with backoff`),
    )
    this.#downlink.open()

    // 4) 连 Hub
    const identityFile = path.join(home, 'nodes', safeName(this.options.name), 'identity.json')
    const tokenFile = path.join(home, 'nodes', safeName(this.options.name), 'token.json')

    const savedToken = await readJsonFile<{ token?: string }>(tokenFile, {})
    const hub = await HubClient.create({
      identityFile,
      url: this.options.hubUrl,
      role: 'node',
      /**
       * 节点**刻意不索要任何 scope**。
       *
       * 两个原因：
       *  1. 它用不上 —— 节点只调用 `node.register` 与 `session.push`，两者所需的 scope 都是空的。
       *     它"执行指令"靠的是收到 Hub 下发的 `req` 帧，那走的是节点角色本身，不经过 scope 门。
       *  2. 这正好让"首次回环自动批准"这条窄规则能生效 —— 该规则的条件之一就是
       *     **未索要任何 scope**（防御"自己给自己要权限"）。节点若索要 scope，
       *     这条规则就永不触发，回环开发环境也得人工批准，纯属自找麻烦。
       *     最小权限与自动化在这里方向一致，不需要取舍。
       */
      scopes: [],
      clientId: 'dse-node',
      displayName: this.options.name,
      verbose: this.#verbose,
      ...(savedToken.token === undefined ? {} : { token: savedToken.token }),
    })
    this.#hub = hub

    hub.on('deviceToken', ({ token }) => {
      void writeJsonFile(tokenFile, { token, savedAtMs: Date.now() }).then(() =>
        this.#log('saved device token (the hub keeps only its hash, so this file is the only copy)'),
      )
    })
    hub.on('hello', (hello) => {
      this.#log(
        `connected to hub ${hello.hubId} as node "${this.options.name}" (scopes: ${hello.auth.scopes.join(', ') || 'none'})`,
      )
    })
    hub.on('reconnected', () => {
      this.#log('reconnected to hub; re-registering employees')
      void this.#register().catch((error: unknown) => this.#log(`re-register failed: ${String(error)}`))
    })
    /* 本地转发口要在**第一个模型请求之前**就绪：dsh 不会等我们。
       这里不 await（启动不该被它拖住），失败也只是带代理的端点暂时不通 —— 如实记一行。 */
    void this.#refreshLlmRoutes().catch((error: unknown) =>
      this.#log(`warning: llm 转发口没起来（带代理的端点会连不上）：${String(error)}`),
    )
    hub.on('request', (frame) => {
      void this.#handleHubRequest(frame)
    })
    // 握手失败不在这里处理：`#connectWithRetry` 已经负责区分"等待批准"与"真失败"，
    // 并保证只提示一次。在这里再监听会重复输出。
    hub.on('error', (error) => this.#log(`hub client error: ${error.message}`))

    const hello = await this.#connectWithRetry(hub)
    this.#log(`hub handshake ok; dsh version reported as ${describe.version}`)
    /* 给自己盖章：证明"这个版本能用"。节点自升级的回滚判定只认这个证据
       （连不上网络的版本不该被回滚，崩得起的版本才该）。只有指针指的版本等于
       本进程指纹时才会写 —— 见 release.ts 的 markConnected。 */
    void markConnected({ repo: packageRoot(), mine: currentCodeFingerprint() })
      .then((noted) => {
        if (noted.noted === true) this.#log(`release pointer: ${noted.release} marked connected`)
        else if (noted.reason !== undefined && noted.release !== undefined) {
          this.#log(`release pointer: not marking (${noted.reason})`)
        }
      })
      .catch(() => undefined)
    await this.#register(describe.version)
    void hello
  }

  /**
   * 连上 Hub，若未配对则**持续等待**而不是退出。
   *
   * 这是部署流程决定的：你先启动节点，然后走到另一台设备上去批准它。
   * 如果节点在拿到 `pairing-required` 时就退出，用户批准完还得回来手动重启一次 ——
   * 那是个纯粹自找的麻烦。因此这里只记录清晰的指引并重试。
   *
   * 重试间隔固定 10 秒：配对是人在操作，不需要退避到分钟级；
   * 而固定的节奏让日志可读（每次重试的 requestId 也是同一个，因为 Hub 侧按 deviceId 去重）。
   */
  async #connectWithRetry(hub: HubClient): Promise<Awaited<ReturnType<HubClient['connect']>>> {
    const retryDelayMs = 10_000
    let warnedOnce = false

    for (;;) {
      if (this.#stopping) throw new Error('node is stopping')
      try {
        return await hub.connect()
      } catch (error) {
        const code = error instanceof HubCallError ? error.code : 'unknown'

        if (code === 'pairing-required') {
          if (!warnedOnce) {
            this.#reportPairingRequired(
              error instanceof HubCallError ? error.details : undefined,
            )
            warnedOnce = true
          }
          this.#log(`still waiting for approval; retrying in ${retryDelayMs / 1000}s`)
        } else {
          this.#log(
            `hub connection failed (${code}): ${error instanceof Error ? error.message : String(error)}; retrying in ${retryDelayMs / 1000}s`,
          )
        }

        await sleep(retryDelayMs)
        continue
      }
    }
  }

  async #ensureDsh(): Promise<number> {
    if (this.options.manageDsh === false) {
      const port = this.options.attachPort
      if (port === undefined) {
        throw new Error('manageDsh:false requires attachPort to be set')
      }
      return port
    }

    // 自己挑端口，而不是传 0 让 dsh 选后从它的输出里解析。
    // 好处有两层：① 不把我们的启动逻辑绑死在 dsh 的日志格式上；
    // ② 显式端口意味着**不需要捕获子进程输出**，也就用不到管道 stdio
    //（受限环境下管道的 spawn 会直接 EPERM）。
    //
    // 注意把 0 也当作"请自己挑"：`0 ?? x` 得到的是 0（0 不是 nullish），
    // 若只判 undefined 就会把 0 一路传给 dsh，于是又落回"解析输出"那条脆弱路径。
    const configuredPort = this.options.dshPort ?? 0
    const port = configuredPort > 0 ? configuredPort : await findFreePort()

    const process_ = new DshProcess({
      cwd: this.options.employeeRoot,
      port,
      verbose: this.#verbose,
      ...(this.options.dshCommand === undefined ? {} : { command: this.options.dshCommand }),
      env: {
        ...(this.options.dshEnv ?? {}),
        ...(this.options.dshHome === undefined ? {} : { DSH_HOME: this.options.dshHome }),
      },
    })
    this.#dshProcess = process_
    process_.on('exit', ({ code, willRestart }) =>
      this.#log(`dsh exited code=${code ?? 'null'} willRestart=${willRestart}`),
    )
    process_.on('failed', ({ reason }) => {
      this.#log(`dsh failed permanently: ${reason}`)
    })
    return await process_.start()
  }

  async stop(): Promise<void> {
    if (this.#llmForwarder !== undefined) {
      await this.#llmForwarder.close().catch(() => undefined)
      this.#llmForwarder = undefined
    }
    this.#stopping = true
    this.#downlink?.close()
    this.#hub?.close()
    await this.#dshProcess?.stop()
  }

  /* ────────────────────────── 上报 ────────────────────────── */

  async #register(dshVersion = 'unknown'): Promise<void> {
    const hub = this.#requireHub()
    const store = this.#requireStore()
    const { employees, warnings } = await store.discover()
    for (const warning of warnings) this.#log(`warning: ${warning}`)

    // 顺手把还没在 dsh 里注册的工作区补上（dsh 重启/换 DSH_HOME 后这一步是必要的）
    for (const employee of employees) {
      try {
        await ensureFileDeliveryInstructions(employee.workspacePath)
      } catch (error) {
        this.#log(`warning: ${employee.name} 文件交付指令安装失败：${error instanceof Error ? error.message : String(error)}`)
      }
      const workspaceId = await store.ensureRegistered(employee)
      if (workspaceId !== undefined) employee.workspaceId = workspaceId
    }

    // 每员工装配已不再物化专属 preset：私有技能由 dsh 的默认发现提供
    // （`<projectRoot>/.dsh/skills`，rank 100），前提是**员工工作区本身是 dsh 认定的
    // 项目根** —— 即工作区里（或某个祖先里）有 `.git`。详见 docs/05 §4。
    // 用 scripts/probe-skill-roots.ts 可随时体检这一点；缺锚点的员工会随
    // node.register 上报，由控制台「体检」显示为告警（`hasGitAnchor`）。

    /* 本节点**正在跑**的代码指纹：随注册上报，让 Hub 与它自己比对。
       节点是手动升级的，跑旧代码时界面上看不出来（照常在线、照常列员工），
       所以这件事必须由机器自己报，而不是靠人记得去每台机器上看。 */
    const codeVersion = currentCodeFingerprint()
    if (codeVersion === undefined) {
      this.#log('warning: 无法计算本节点代码指纹（src/ 与 bin/ 不在交付里？）；Hub 将按"未知"处理')
    }

    const result = await hub.call<{
      nodeId: string
      registeredEmployees: number
      removedStale: number
      conflictedEmployeeIds?: string[]
    }>(
      'node.register',
      {
        name: this.options.name,
        platform: `${process.platform}-${process.arch}`,
        employeeRoot: this.options.employeeRoot,
        dshVersion,
        ...(codeVersion === undefined ? {} : { codeVersion }),
        runtime: runtimeEntry(),
        dshPort: this.dshPort ?? 0,
        employees: employees.map((employee) => ({
          id: employee.id,
          name: employee.name,
          role: employee.role,
          workspacePath: employee.workspacePath,
          skills: employee.skills,
          status: employee.status,
          createdAtMs: employee.createdAtMs,
          hasGitAnchor: employee.hasGitAnchor,
          ...(employee.position === undefined ? {} : { position: employee.position }),
          ...(employee.workspaceId === undefined ? {} : { workspaceId: employee.workspaceId }),
          ...(employee.agentPreset === undefined ? {} : { agentPreset: employee.agentPreset }),
          ...(employee.group === undefined ? {} : { group: employee.group }),
          ...(employee.intro === undefined ? {} : { intro: employee.intro }),
          hasAvatar: employee.hasAvatar,
          /* 模型配置摘要：控制台据此一行显示"现在用哪个模型"，
             Hub 侧据此回答"这个端点库条目还有谁在用"（删端点时要能点名） */
          ...(employee.llmActiveName === undefined ? {} : { llmActiveName: employee.llmActiveName }),
          ...(employee.llmEndpointIds === undefined ? {} : { llmEndpointIds: employee.llmEndpointIds }),
          /* 头像版本（mtime+字节数）：客户端本地缓存的失效依据 ——
             没有它，"换了头像"只能靠把所有人的头像重新下载一遍才发现得了。 */
          ...(employee.avatarUpdatedAtMs === undefined
            ? {}
            : { avatarUpdatedAtMs: employee.avatarUpdatedAtMs, avatarBytes: employee.avatarBytes ?? 0 }),
        })),
      },
      { idempotencyKey: `register-${Date.now()}` },
    )

    this.#log(
      `registered ${result.registeredEmployees} employee(s) on node ${result.nodeId.slice(0, 12)}…`,
    )
    if (result.conflictedEmployeeIds !== undefined && result.conflictedEmployeeIds.length > 0) {
      this.#log(
        `warning: these employee ids are also declared by another node (a copied workspace?): ${result.conflictedEmployeeIds.join(', ')}`,
      )
    }
  }

  /* ────────────────────────── 处理 Hub 请求 ────────────────────────── */

  async #handleHubRequest(frame: ReqFrame): Promise<void> {
    const hub = this.#requireHub()
    try {
      const payload = await this.dispatch(frame.method, frame.params)
      hub.respond(frame.id, { ok: true, payload })
    } catch (error) {
      hub.respond(frame.id, { ok: false, error: toProtocolError(error) })
    }
  }

  /** 把 Hub 的方法翻译成对 dsh / 工作区的操作。 */
  async dispatch(method: string, rawParams: unknown): Promise<unknown> {
    const params = (rawParams ?? {}) as Record<string, unknown>
    const store = this.#requireStore()
    const dsh = this.#requireDsh()

    switch (method) {
      /* ── 员工 ── */
      case 'employee.create': {
        const created = await store.create({
          name: requireString(params, 'name'),
          role: typeof params['role'] === 'string' ? params['role'] : '',
          ...(typeof params['slug'] === 'string' ? { slug: params['slug'] } : {}),
          ...(typeof params['agentPreset'] === 'string' ? { agentPreset: params['agentPreset'] } : {}),
          ...(typeof params['group'] === 'string' ? { group: params['group'] } : {}),
          ...(typeof params['intro'] === 'string' ? { intro: params['intro'] } : {}),
          ...(typeof params['position'] === 'string' ? { position: params['position'] } : {}),
        })
        await this.#register()
        return created
      }
      /* ── 员工级 LLM 端点（配置存工作区，接线到本机 dsh）── */
      case 'employee.llm.get':
        return await this.#llmGet(requireString(params, 'employeeId'))
      case 'employee.llm.save':
        return await this.#llmSave(requireString(params, 'employeeId'), params)
      case 'employee.llm.activate':
        return await this.#llmActivate(requireString(params, 'employeeId'), params)
      case 'employee.llm.remove':
        return await this.#llmRemove(requireString(params, 'employeeId'), params)
      case 'employee.llm.unset':
        return await this.#llmUnset(requireString(params, 'employeeId'))
      case 'employee.llm.probe':
        return await this.#llmProbe(requireString(params, 'employeeId'), params)
      /* 机器级权限档位（dsh 的 settings.permission.defaultPreset） */
      case 'node.permission.get':
        return await this.#permissionGet()
      case 'node.permission.set':
        return await this.#permissionSet(params)
      /* Hub 级：端点库里的探测。不带 employeeId —— 端点连通性与具体员工无关，
         只是借一台有出网能力的节点发这个请求（Hub 自己未必能出网）。 */
      case 'llm.probe':
        return await probeModels(
          requireString(params, 'apiUrl'),
          typeof params['apiKey'] === 'string' && params['apiKey'] !== '' ? params['apiKey'] : undefined,
          10_000,
          normalizeProxyConfig(params['proxy']),
        )
      /* 把一条"本地端点"（历史配置）交给 Hub 收进端点库 —— 明确的一次动作，见方法注释 */
      case 'employee.llm.promote':
        return await this.#llmPromote(requireString(params, 'employeeId'), params)
      case 'employee.llm.linkEndpoint':
        return await this.#llmLinkEndpoint(requireString(params, 'employeeId'), params)
      /* 端点库改了 BaseURL/Key 之后，Hub 逐员工调它把本地那份也换掉并重新接线 */
      case 'employee.llm.endpoint.sync':
        return await this.#llmEndpointSync(requireString(params, 'employeeId'), params)
      /* ── 员工自定义头像（存工作区，set/remove 后重新上报 hasAvatar）── */
      case 'employee.avatar.get': {
        const avatar = await store.avatarGet(requireString(params, 'employeeId'))
        if (avatar === undefined) return { exists: false }
        return {
          exists: true,
          mimeType: avatar.mimeType,
          dataBase64: avatar.data.toString('base64'),
          size: avatar.size,
          updatedAtMs: avatar.updatedAtMs,
        }
      }
      case 'employee.avatar.set': {
        const updated = await store.avatarSet(requireString(params, 'employeeId'), {
          mimeType: requireString(params, 'mimeType'),
          data: Buffer.from(requireString(params, 'dataBase64'), 'base64'),
        })
        await this.#register()
        return updated
      }
      case 'employee.avatar.remove': {
        const removed = await store.avatarRemove(requireString(params, 'employeeId'))
        await this.#register()
        return removed
      }
      case 'employee.update': {
        const updated = await store.update(requireString(params, 'employeeId'), {
          ...(typeof params['name'] === 'string' ? { name: params['name'] } : {}),
          ...(typeof params['role'] === 'string' ? { role: params['role'] } : {}),
          ...(params['agentPreset'] === null
            ? { agentPreset: null }
            : typeof params['agentPreset'] === 'string'
              ? { agentPreset: params['agentPreset'] }
              : {}),
          // group 支持 null 清除（回到未分组）
          ...(params['group'] === null
            ? { group: null }
            : typeof params['group'] === 'string'
              ? { group: params['group'] }
              : {}),
          // intro 同样支持 null 清除（空串在 store 层也按删除处理）
          ...(params['intro'] === null
            ? { intro: null }
            : typeof params['intro'] === 'string'
              ? { intro: params['intro'] }
              : {}),
          // 岗位：null 表示回到「通用」（与 group 的清除语义一致）
          ...(params['position'] === null
            ? { position: null }
            : typeof params['position'] === 'string'
              ? { position: params['position'] }
              : {}),
        })
        await this.#register()
        return updated
      }
      case 'employee.remove': {
        const removed = await store.remove(requireString(params, 'employeeId'), {
          deleteFiles: params['deleteFiles'] === true,
        })
        await this.#register()
        return removed
      }
      case 'employee.files.list':
        return {
          entries: await store.listFiles(
            requireString(params, 'employeeId'),
            typeof params['path'] === 'string' ? params['path'] : '.',
          ),
        }
      case 'employee.files.get':
        return await store.readFile(
          requireString(params, 'employeeId'),
          requireString(params, 'path'),
        )
      case 'employee.files.download': {
        const file = await store.downloadFile(
          requireString(params, 'employeeId'),
          requireString(params, 'path'),
        )
        return {
          path: file.path,
          size: file.size,
          mimeType: file.mimeType,
          dataBase64: file.data.toString('base64'),
        }
      }
      case 'employee.files.set':
        return await store.writeFile(
          requireString(params, 'employeeId'),
          requireString(params, 'path'),
          requireString(params, 'content', { allowEmpty: true }),
        )
      /* 二进制"递材料"：控制台发文件 → 落进员工工作区，员工用自己的工具就能读到。
         大小与路径边界都在 store.uploadFile 里强制（网络入口的硬边界）。 */
      case 'employee.files.upload': {
        const data = Buffer.from(requireString(params, 'dataBase64'), 'base64')
        return await store.uploadFile(
          requireString(params, 'employeeId'),
          requireString(params, 'path'),
          data,
        )
      }
      case 'employee.skills.list':
        return await this.#listSkills(requireString(params, 'employeeId'))

      /* ── 会话 ── */
      case 'session.list': {
        const employee = await this.#findEmployee(requireString(params, 'employeeId'))
        const [all, archives] = await Promise.all([dsh.sessionList(), this.#sessionArchives.list(employee.workspacePath)])
        const sessions = (all.items as Array<Record<string, unknown>>).filter(
          (item) => typeof item['cwd'] === 'string' && path.resolve(item['cwd']) === employee.workspacePath,
        )
        for (const session of sessions) {
          const id = session['sessionId']
          if (typeof id !== 'string') continue
          session['archived'] = archives.has(id)
          const archivedAtMs = archives.get(id)
          if (archivedAtMs !== undefined) session['archivedAtMs'] = archivedAtMs
          this.#sessionOwner.set(id, employee.id)
          /* 带上"最后一次事件的时刻"：控制台据此在没人盯着的时候也能看出"这个回合疑似卡死"。
             没收到过事件的会话不填该字段（不假装有数据）。 */
          const last = this.#sessionLastEventAt.get(id)
          if (last !== undefined) session['lastEventAtMs'] = last
        }
        return { sessions }
      }
      case 'session.archive': {
        const employee = await this.#findEmployee(requireString(params, 'employeeId'))
        const sessionId = requireString(params, 'sessionId')
        if (typeof params['archived'] !== 'boolean') throw protocolError('bad-request', 'archived 必须为布尔值')
        const archived = params['archived']
        const all = await dsh.sessionList()
        const session = (all.items as Array<Record<string, unknown>>).find(item =>
          item['sessionId'] === sessionId && typeof item['cwd'] === 'string' &&
          path.resolve(item['cwd']) === employee.workspacePath)
        if (session === undefined) throw protocolError('not-found', '该员工下不存在此会话')
        if (archived && session['running'] === true) throw protocolError('bad-request', '运行中的会话暂不能归档，请等回合结束')
        const archivedAtMs = await this.#sessionArchives.set(employee.workspacePath, sessionId, archived)
        return { sessionId, archived, ...(archivedAtMs === undefined ? {} : { archivedAtMs }) }
      }
      case 'session.create': {
        const employee = await this.#findEmployee(requireString(params, 'employeeId'))
        const workspaceId = employee.workspaceId ?? (await store.ensureRegistered(employee))
        // preset 取值顺序：调用参数显式指定 > 员工配置 > 节点默认。
        // 三者都没有时不传，落 dsh 的部署默认（注意那是 minimal，没有 /compact 等能力）。
        const agentPreset =
          typeof params['agentPreset'] === 'string'
            ? params['agentPreset']
            : (employee.agentPreset ?? this.options.defaultPreset)
        // 可选命名。dsh 会**静默忽略** create payload 里的 title（实测 0.1.0-rc.6），
        // 所以这里不传它，改为创建成功后第二步用 session.rename 落名。
        // 给了 title 但非法（trim 后为空 / 超 200 字符）时在建会话**之前**就拒绝，
        // 调用方修正后可用同一幂等键安全重试，不会留下"建了但没名"的半成品。
        const title =
          params['title'] === undefined ? undefined : requireSessionTitle(params['title'])
        const created = await dsh.sessionCreate({
          // workspaceId 与 cwd 互斥，优先用已注册的 workspaceId
          ...(workspaceId === undefined
            ? { cwd: employee.workspacePath }
            : { workspaceId }),
          ...(agentPreset === undefined ? {} : { agentPreset }),
          ...(typeof params['sessionId'] === 'string' ? { sessionId: params['sessionId'] } : {}),
        })
        this.#sessionOwner.set(created.sessionId, employee.id)
        // 员工配了专用端点的话，新会话直接选到他的模型（旧会话不迁移，见 employee-llm.ts）
        await applyLlmToSession(dsh, employee.workspacePath, employee.id, created.sessionId, (m) =>
          this.#log(m),
        )
        if (title === undefined) return created
        try {
          const renamed = await dsh.sessionRename(created.sessionId, title)
          return { ...created, title: renamed.title }
        } catch (error) {
          // 会话已经建成：命名失败既不能吞掉，也不能把整个调用伪装成失败
          // （那会诱导调用方用幂等键重试，建出重复会话）。
          // 如实返回 sessionId，同时把命名的失败摆到台面上。
          return {
            ...created,
            titleError: `会话已创建，但命名失败：${error instanceof Error ? error.message : String(error)}`,
          }
        }
      }
      case 'session.prompt': {
        const employeeId = requireString(params, 'employeeId')
        const sessionId = requireString(params, 'sessionId')
        const text = requireString(params, 'text')
        const mode = params['mode'] === 'steer' ? 'steer' : 'queue'
        this.#sessionOwner.set(sessionId, employeeId)
        // 可选：控制台可以把图片**内联**进这一轮（dsh 的 session.prompt 原生支持
        // 图片内容块，由宿主把字节提升为持久附件引用）。非图片文件不走这里 ——
        // dsh 的附件通道只收图片，其它类型走 employee.files.upload 落进工作区。
        const content = Array.isArray(params['content'])
          ? (params['content'] as Array<Record<string, unknown>>)
          : undefined
        if (content === undefined) {
          const plain = await dsh.sessionPrompt(sessionId, text, mode)
          return plain ?? { accepted: true }
        }
        try {
          const rich = await dsh.sessionPromptContent(sessionId, content, mode)
          return rich ?? { accepted: true }
        } catch (error) {
          /* 内联图片失败时**自动退回纯文本重发**。
           *
           * 为什么必须兜这一层：当前部署的模型（deepseek-v4-flash）不支持图片输入，
           * dsh 会以「Model "…" does not support image input」拒绝**整轮请求** ——
           * 也就是说，只顾着"把图片内联进去"会让这一轮彻底失败，比不发图更糟。
           * 而文件本身已经落在工作区的收件箱里，员工用自己的工具照样能读到，
           * 所以退回纯文本是无损的：拿到能力就用，拿不到就降级，用户不必知道细节。
           *
           * 只在错误确实指向图片能力时才降级：其它失败（凭据、网络、会话不存在）
           * 保持原样抛出，不能被这里吞成一个"看起来成功了"的回合。 */
          const message = error instanceof Error ? error.message : String(error)
          if (!/image input|does not support image/i.test(message)) throw error
          this.#log(`inlining images was rejected by the model; retrying as text-only (${message})`)
          const plain = await dsh.sessionPrompt(sessionId, text, mode)
          return {
            ...(plain !== null && typeof plain === 'object' ? (plain as Record<string, unknown>) : {}),
            accepted: true,
            imageDelivery: 'skipped',
            imageNote: '当前模型不支持图片输入，已改为纯文本发送；文件仍在工作区的收件箱里，员工可直接读取',
          }
        }
      }
      case 'session.cancel':
        return await dsh.sessionCancel(requireString(params, 'sessionId'))
      case 'session.compact':
        return await this.#sessionCompact(
          requireString(params, 'employeeId'),
          requireString(params, 'sessionId'),
        )
      case 'session.rename': {
        // 先确认员工归属再碰 dsh（与 session.compact 同一顺序）：
        // 员工不在本节点时这里就抛掉，rename 请求不会发到 dsh。
        const employee = await this.#findEmployee(requireString(params, 'employeeId'))
        const sessionId = requireString(params, 'sessionId')
        const title = requireSessionTitle(params['title'])
        this.#sessionOwner.set(sessionId, employee.id)
        return await dsh.sessionRename(sessionId, title)
      }
      case 'session.history': {
        const sessionId = requireString(params, 'sessionId')
        const beforeSeq = typeof params['beforeSeq'] === 'number' ? params['beforeSeq'] : undefined
        // 入参兼容：旧 maxMessages 映射为 maxEvents；新 maxEvents 优先
        const maxEvents =
          typeof params['maxEvents'] === 'number'
            ? params['maxEvents']
            : typeof params['maxMessages'] === 'number'
              ? params['maxMessages']
              : undefined
        // 历史可达数十 MB（base64 截图、37KB 的 request/header），整包回传会超过
        // MAX_FRAME_BYTES 被 Hub 掐线。beforeSeq 透传给 dsh（它按 seq 定位老窗口，
        // 免得全量读出），取回后节点侧先瘦身再按条数 + 字节双预算分页。
        const raw = await dsh.sessionHistory(sessionId, {
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        })
        const sanitized = sanitizeHistoryEvents(raw.events)
        // dsh 的 beforeSeq 语义以实测为准，这里再过滤一次保底（seq < beforeSeq）
        const candidates =
          beforeSeq === undefined
            ? sanitized
            : sanitized.filter((entry) => {
                const seq = historyEntrySeq(entry)
                return seq !== undefined && seq < beforeSeq
              })
        const page = pageEvents(candidates, { ...(maxEvents === undefined ? {} : { maxEvents }) })
        // dsh 窗口之外可能还有更老的事件：dsh 自报 hasMore 时并入翻页语义，
        // 游标退化为本页最旧一条的 seq（下一页 beforeSeq 会定位到更早的 dsh 窗口）
        const hasMore = page.hasMore || raw.hasMore === true
        const oldestSeq = page.oldestSeq ?? (hasMore ? historyEntrySeq(page.events[0]) : undefined)
        return {
          events: page.events,
          hasMore,
          ...(oldestSeq === undefined ? {} : { oldestSeq }),
        }
      }
      case 'session.watch': {
        const sessionId = requireString(params, 'sessionId')
        const employeeId = typeof params['employeeId'] === 'string' ? params['employeeId'] : undefined
        if (params['watch'] === false) {
          this.#watchedSessions.delete(sessionId)
        } else {
          this.#watchedSessions.add(sessionId)
          if (employeeId !== undefined) this.#sessionOwner.set(sessionId, employeeId)
        }
        return { watching: this.#watchedSessions.has(sessionId) }
      }

      /* ── dsh 交互：把控制台的裁决/答案回填给 dsh ── */
      case 'dsh.interaction.respond': {
        const rpcId = requireString(params, 'rpcId')
        const value = params['value']
        if (value === undefined || value === null || typeof value !== 'object') {
          throw new Error('dsh.interaction.respond requires an object "value"')
        }
        await this.#requireDownlink().respond(rpcId, value)
        this.#log(`answered dsh rpcId=${rpcId} (${String(params['kind'] ?? 'interaction')})`)
        return { delivered: true }
      }

      /* ── 自升级（Hub 的「升级」按钮经这里落地）──
       *
       * 节点只做**准备**那一半：fetch → 导出 → 校验 → 装依赖 → 冒烟 → 切指针。
       * 重启不在这里做：节点不知道怎么把自己拉起来（Windows 是计划任务、Mac 是启动器），
       * 所以它用**退出码 75** 说"我要重启，这是有意的"—— 启动器/计划任务会把它带回来，
       * 带回时读的已经是新指针。这比让节点自己去操作服务/计划任务稳得多（也不需要提权）。
       */
      case 'node.update': {
        const to = typeof params['to'] === 'string' ? params['to'] : ''
        if (to === '') throw new Error('node.update requires "to" (branch, tag or sha)')
        /* 升级要在 **git clone** 里跑，不是在"我正跑着的那个版本目录"里跑 ——
           后者是冻结产物（按设计没有 .git），`git fetch` 只会报"不是 git 仓库"，
           而那个报错看起来像网络问题（真机第一次跨版本升级后踩到）。 */
        const mine = packageRoot()
        const resolved = await resolveUpdateRepo({
          mine,
          env: process.env,
          paths: releasePaths({ repo: mine, env: process.env }),
        })
        if (resolved === undefined) {
          throw new Error(
            '不知道该在哪个 clone 里升级：启动器没有设 DSE_REPO，指针里也没有 repo 字段，' +
              '而当前包根不是 git 仓库。请用 scripts/run-node.sh（或 Windows 的 start-node.ps1）启动节点。',
          )
        }
        this.#log(`update requested → ${to}（在 ${resolved.repo} 里升级，来源 ${resolved.source}）`)
        const outcome = await prepareRelease({ repo: resolved.repo, to })
        if (outcome.ok !== true) {
          this.#log(`update failed: ${outcome.error ?? 'unknown'}`)
          return { ok: false, error: outcome.error ?? 'unknown', steps: outcome.steps }
        }
        this.#log(
          `update prepared: ${outcome.fingerprint ?? '?'} (switched=${String(outcome.switched)}) — asking to be restarted`,
        )
        /* 只切换到"新版本"才需要重启；已经在目标版本上则什么都不做（幂等）。 */
        if (outcome.switched === true) {
          const timer = setTimeout(() => {
            this.#log('exiting with 75 so the launcher restarts into the new release')
            /* 先停掉托管的 dsh 再退出 —— 这是必须的，不是讲究。
               直接 `process.exit(75)` 会把 dsh（以及它拉起的 MCP 服务器）留成孤儿：
               它们继续占着 dsh 端口，于是**重启后的新节点绑不上端口、起不来**。
               真机踩过（2026-09-25，Windows 那台）：升级本身成功、节点按约定 exit 75，
               然后 23 分钟没回来。那次启动器也卡住了（见 scripts/start-node.ps1 的注释），
               但即便启动器正常，端口被孤儿占着，新节点同样起不来。
               dsh-process 的 stop 在 Windows 上走 `taskkill /T`，所以停 dsh 会连它
               拉起的 MCP 子树一起收掉。兜底：stop 万一卡住也不能永远不退出。 */
            let hardExit: NodeJS.Timeout | undefined
            const quit = (): void => {
              if (hardExit !== undefined) clearTimeout(hardExit)
              process.exit(75)
            }
            hardExit = setTimeout(quit, 15_000)
            void this.stop().then(quit, quit)
          }, 1500)
          timer.unref?.()
        }
        return {
          ok: true,
          fingerprint: outcome.fingerprint,
          switched: outcome.switched,
          steps: outcome.steps,
        }
      }

      /* ── 员工互调 ── */
      case 'employee.invoke': {
        const invokeId = requireString(params, 'invokeId')
        const fromEmployeeId = requireString(params, 'fromEmployeeId')
        const toEmployeeId = requireString(params, 'toEmployeeId')
        const task = requireString(params, 'task')
        if (params['async'] === true) {
          void this.#invokeEmployeeAsync(invokeId, fromEmployeeId, toEmployeeId, task)
          return { accepted: true, invokeId }
        }
        return await this.#invokeEmployee(invokeId, fromEmployeeId, toEmployeeId, task)
      }

      default:
        throw new Error(`node does not implement method "${method}"`)
    }
  }

  /* ────────────────────────── 会话压缩 ────────────────────────── */

  /**
   * 压缩一个会话的早期上下文（dsh `/compact` slash 命令，经 commands/execute 触发）。
   *
   * 返回**如实**的 `{kind, text}`，绝不硬编 success：
   *   - dsh 把命令静默吞掉（value 缺失）= 该会话的 preset 没挂 compact 命令
   *     （实测：minimal 没有，standard/code 才有）→ 给出人话提示；
   *   - result.kind 不是 success/error = dsh 协议变了，原样说明；
   *   - dsh 业务错误（如 session-not-found）照常抛给 toProtocolError，
   *     与 session.cancel 等方法的既有行为一致。
   */
  async #sessionCompact(
    employeeId: string,
    sessionId: string,
  ): Promise<{ kind: 'success' | 'error'; text: string }> {
    const dsh = this.#requireDsh()
    // 确认员工归属：员工不在本节点上时这里就抛掉，不会把请求发给 dsh
    const employee = await this.#findEmployee(employeeId)
    this.#sessionOwner.set(sessionId, employee.id)

    const result = await dsh.sessionCompact(sessionId)
    if (result === undefined) {
      return {
        kind: 'error',
        text:
          '该会话所用 preset 不含压缩能力：dsh 未挂载 /compact 命令' +
          '（minimal preset 没有，standard/code 才有；新建会话可显式带 agentPreset）',
      }
    }
    if (result.kind !== 'success' && result.kind !== 'error') {
      return {
        kind: 'error',
        text: `dsh 返回了无法识别的压缩结果：${JSON.stringify(result).slice(0, 300)}`,
      }
    }
    return { kind: result.kind, text: typeof result.text === 'string' ? result.text : '' }
  }

  /* ────────────────────────── 员工互调的执行端 ────────────────────────── */

  /**
   * 被别的员工调用：开一个会话把任务交给目标员工，等它跑完，取回最终回复。
   *
   * "等它跑完"用的是**轮询会话状态**而不是订阅事件流：事件形状尚未验证，
   * 而轮询 `session.list` 的 `running` 字段是已实测存在的稳定信息。
   * 代价是延迟（默认 1 秒粒度），换来的是不依赖未验证的事件契约。
   * 一旦事件形状确定，这里应当换成事件驱动。
   */
  async #invokeEmployee(
    invokeId: string,
    fromEmployeeId: string,
    toEmployeeId: string,
    task: string,
    options: { onStarted?: (sessionId: string) => Promise<void> } = {},
  ): Promise<{ sessionId: string; resultText?: string; error?: string }> {
    const dsh = this.#requireDsh()
    const employee = await this.#findEmployee(toEmployeeId)
    const workspaceId = employee.workspaceId ?? (await this.#requireStore().ensureRegistered(employee))

    const created = await dsh.sessionCreate({
      ...(workspaceId === undefined ? { cwd: employee.workspacePath } : { workspaceId }),
      ...(employee.agentPreset === undefined ? {} : { agentPreset: employee.agentPreset }),
    })

    if (options.onStarted !== undefined) await options.onStarted(created.sessionId)

    // 把"谁在请求你"如实告诉目标员工 —— 跨员工协作里，来源是必须可见的上下文
    const framed = [
      `【来自员工调用的任务】`,
      `调用方员工：${fromEmployeeId}`,
      `调用编号：${invokeId}`,
      ``,
      task,
    ].join('\n')

    await dsh.sessionPrompt(created.sessionId, framed, 'queue')

    const outcome = await this.#waitForTurnOutcome(created.sessionId)
    return {
      sessionId: created.sessionId,
      ...(outcome.text === undefined ? {} : { resultText: outcome.text }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    }
  }

  async #invokeEmployeeAsync(
    invokeId: string,
    fromEmployeeId: string,
    toEmployeeId: string,
    task: string,
  ): Promise<void> {
    const hub = this.#requireHub()
    try {
      const outcome = await this.#invokeEmployee(invokeId, fromEmployeeId, toEmployeeId, task, {
        onStarted: async (sessionId) => {
          await hub.call(
            'employee.invoke.settle',
            { invokeId, status: 'running', sessionId },
            { idempotencyKey: `invoke-start-${invokeId}` },
          )
        },
      })
      await hub.call(
        'employee.invoke.settle',
        {
          invokeId,
          status: outcome.error === undefined ? 'completed' : 'failed',
          sessionId: outcome.sessionId,
          ...(outcome.resultText === undefined ? {} : { resultText: outcome.resultText }),
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        },
        { idempotencyKey: `invoke-finish-${invokeId}` },
      )
    } catch (error) {
      await hub
        .call(
          'employee.invoke.settle',
          {
            invokeId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          },
          { idempotencyKey: `invoke-finish-${invokeId}` },
        )
        .catch(() => undefined)
    }
  }

  /**
   * 等这一轮跑完，取回**结果或失败原因**。
   *
   * "等它跑完"用轮询 `session.list` 的 `running` 字段：那是已实测存在的稳定信息，
   * 而事件流形状复杂且曾变过。代价是延迟（默认 1.5 秒粒度）。
   */
  async #waitForTurnOutcome(
    sessionId: string,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<{ text?: string; error?: string }> {
    const timeoutMs = options.timeoutMs ?? 10 * 60_000
    const intervalMs = options.intervalMs ?? 1_500
    const deadline = Date.now() + timeoutMs

    let started = false
    while (Date.now() < deadline) {
      const state = await this.#sessionState(sessionId)
      if (state?.running === true) {
        started = true
        break
      }
      await sleep(intervalMs)
    }

    if (started) {
      while (Date.now() < deadline) {
        const state = await this.#sessionState(sessionId)
        if (state?.running === false) break
        await sleep(intervalMs)
      }
    }

    return await this.#readLastTurnOutcome(sessionId)
  }

  async #sessionState(
    sessionId: string,
  ): Promise<{ running: boolean; blank: boolean } | undefined> {
    const dsh = this.#requireDsh()
    try {
      const all = await dsh.sessionList()
      const hit = (all.items as Array<Record<string, unknown>>).find(
        (item) => item['sessionId'] === sessionId,
      )
      if (hit === undefined) return undefined
      return { running: hit['running'] === true, blank: hit['blank'] === true }
    } catch {
      return undefined
    }
  }

  /**
   * 从会话历史里读出**最后一轮的结局**。
   *
   * 事件形状来自实测（`scripts/inspect-session.ts` / `dump-events.ts`）以及
   * dsh 的会话事件词汇（`turn/*`、`step/*`、`user/message`、`assistant/chunk|message`、
   * `tool/call|result`、`approval/*`、`request/*`）：
   *
   *   - `turn/end` → `{ turn, reason: { kind, error?: { message, code } } }`
   *     `reason.kind === 'error'` 时必须把 `error` 暴露出去 —— 否则一次失败的委派
   *     会表现成"跑完了但没结果"，让人无从排查。
   *   - `assistant/message` → 一条**完整的** assistant 消息，优先取它。
   *   - `assistant/chunk` → 流式增量，仅在拿不到完整消息时拼接兜底。
   *
   * 抽取仍是**尽力而为**：拿不到文本就如实返回 undefined，绝不伪造空结果。
   */
  async #readLastTurnOutcome(sessionId: string): Promise<{ text?: string; error?: string }> {
    const dsh = this.#requireDsh()
    try {
      const history = await dsh.sessionHistory(sessionId, { maxMessages: 200 })
      // 互调结果只需要最后一轮的文本/错误，先过瘦身 —— 原文大字段（截图、
      // request/header）在这里没有价值，却会把互调路径也拖进超帧风险
      const events = sanitizeHistoryEvents(history.events)
        .map((entry) => (entry as { event?: { type?: string; data?: unknown } }).event)
        .filter((event): event is { type?: string; data?: unknown } => event !== undefined)

      // 1) 先看是否有失败 —— 失败优先于任何残留文本
      const lastTurnEnd = [...events].reverse().find((event) => event.type === 'turn/end')
      const reason = (
        lastTurnEnd?.data as { reason?: { kind?: string; error?: { message?: string } } }
      )?.reason
      if (reason?.kind === 'error') {
        return { error: reason.error?.message ?? '这一轮以错误结束，但事件里没有给出原因' }
      }

      // 2) 优先取最后一条**完整的** assistant 消息
      const lastMessage = [...events].reverse().find((event) => event.type === 'assistant/message')
      const complete = extractAssistantText(lastMessage?.data)
      if (complete !== undefined) return { text: complete }

      // 3) 兜底：拼接流式增量
      const pieces: string[] = []
      for (const event of events) {
        if (event.type !== 'assistant/chunk') continue
        const chunk = (event.data as { chunk?: { type?: string; text?: string; delta?: string } })
          ?.chunk
        if (chunk === undefined) continue
        if (typeof chunk.text === 'string') pieces.push(chunk.text)
        else if (typeof chunk.delta === 'string') pieces.push(chunk.delta)
      }
      const text = pieces.join('').trim()
      return text === '' ? {} : { text }
    } catch (error) {
      return {
        error: `无法读取会话历史：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /* ────────────────────────── dsh 事件 → Hub ────────────────────────── */

  /**
   * 把 dsh 主动发起的请求帧（审批、提问）转发给 Hub。
   *
   * `rpcId` 必须原样带上：回填答复（POST /api/respond）就靠这个 id 定位。丢了它，
   * 控制端就只能"看到有个审批在等"却无法回答。
   *
   * 归属判断：从 payload 里**尽力**找出 sessionId，据此判断有没有人在看。
   * 找不到 sessionId 时保留广播兜底（按所有被订阅会话各送一份）——
   * 审批/提问是低频高价值帧，宁可多送也不要丢。
   *
   * 除此之外，审批/提问**还必须**上报给 Hub 的审批中心（见 `#reportDshInteraction`）：
   * 它们是"员工卡住了"的唯一信号，而控制台不一定会开着那个员工的对话框。
   */
  async #forwardDshFrame(frame: ServerRequestFrame): Promise<void> {
    // 先把交互抬到 Hub 审批中心：这是"员工卡在审批上"能被人在手机上看见的路径。
    // 失败只告警不抛 —— 会话流的那份转发仍要走完（它是现场证据）。
    await this.#handleInteractionFrame(frame).catch((error: unknown) => {
      this.#log(
        `warning: failed to report dsh interaction "${String(frame.method)}" to hub: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    })

    // 推送前限幅：审批/提问帧同样可能携带大字段（如实测的截图回传），
    // 超 MAX_FRAME_BYTES 会被 Hub 掐线。归属判断仍用原始 payload（不受影响）。
    const event = sanitizeLiveEvent({
      method: frame.method,
      payload: frame.payload,
      rpcId: frame.rpcId,
    }) as { method: string; payload: unknown; rpcId?: string }
    await this.#pushSessionEvent(findSessionId(frame.payload), event, {
      broadcastWhenOrphan: true,
    })
  }

  /* ────────────────────────── dsh 交互（审批 / 提问）→ Hub 审批中心 ────────────────────────── */

  /**
   * 把 dsh 的四类交互帧接到 Hub 的审批生命周期上。
   *
   * 为什么必须做这件事：审批闸在 dsh 里是**进程内的** `approval/request` waterfall，
   * 终端上没人在就 fail-closed（挂到工具信号中止）。Hub 的审批中心是那条
   * "节点 → Hub → 手机 → Hub → 节点"反向通道的中间一站，而 `rpcId` 就是回填坐标。
   *
   * 四类帧的分工：
   *   `approval/requested` / `question/requested` → 在 Hub 落一条待裁决记录；
   *   `approval/resolved`  / `question/resolved`  → 通知 Hub 收尾（有人直接在 dsh Web 里
   *     答了、或那一轮被中止），免得控制台上留一张永远点不掉的假待办。
   */
  async #handleInteractionFrame(frame: ServerRequestFrame): Promise<void> {
    const method = frame.method
    if (method !== 'approval/requested' && method !== 'question/requested' &&
        method !== 'approval/resolved' && method !== 'question/resolved') {
      return
    }
    const hub = this.#hub
    if (hub === undefined || !hub.connected) return

    const payload = (frame.payload ?? {}) as Record<string, unknown>
    const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'] : undefined

    if (method === 'approval/resolved' || method === 'question/resolved') {
      const outcome = typeof payload['outcome'] === 'string' ? payload['outcome'] : 'cancelled'
      const dshApprovalId =
        typeof payload['approvalId'] === 'string' ? payload['approvalId'] : undefined
      const questionRpcId =
        typeof payload['questionRpcId'] === 'string' ? payload['questionRpcId'] : undefined
      if (dshApprovalId === undefined && questionRpcId === undefined) return
      await hub.call(
        'dsh.interaction.settle',
        {
          outcome,
          ...(dshApprovalId === undefined ? {} : { dshApprovalId }),
          ...(questionRpcId === undefined ? {} : { rpcId: questionRpcId }),
        },
        { idempotencyKey: `dsh-settle-${dshApprovalId ?? questionRpcId}-${outcome}` },
      )
      return
    }

    // 请求帧：没有 rpcId / sessionId 就没法回填，如实记日志而不是悄悄丢掉
    if (frame.rpcId === undefined || sessionId === undefined) {
      this.#log(
        `warning: ${method} arrived without ${frame.rpcId === undefined ? 'rpcId' : 'sessionId'}; cannot route it to a human`,
      )
      return
    }

    const employeeId = await this.#resolveSessionOwner(sessionId)
    const kind = method === 'approval/requested' ? 'dsh.approval' : 'dsh.question'
    const result = await hub.call<{ approvalId: string; created: boolean }>(
      'dsh.interaction.request',
      {
        kind,
        sessionId,
        rpcId: frame.rpcId,
        ...(employeeId === undefined ? {} : { employeeId }),
        ...(kind === 'dsh.approval'
          ? {
              toolName: typeof payload['toolName'] === 'string' ? payload['toolName'] : undefined,
              ...(typeof payload['approvalId'] === 'string'
                ? { dshApprovalId: payload['approvalId'] }
                : {}),
              ...(typeof payload['callId'] === 'string' ? { callId: payload['callId'] } : {}),
              ...(typeof payload['reason'] === 'string' ? { reason: payload['reason'] } : {}),
            }
          : { questions: Array.isArray(payload['questions']) ? payload['questions'] : [] }),
      },
      { idempotencyKey: `dsh-int-${frame.rpcId}` },
    )
    this.#log(
      `dsh ${kind} ${result.created ? 'escalated' : 'already known'} → approval ${result.approvalId}` +
        ` (employee=${employeeId ?? 'unknown'}, session=${sessionId})`,
    )
  }

  /**
   * 一次交互属于哪个员工。
   *
   * `#sessionOwner` 只覆盖"我们建过或列过的会话"；而审批可能来自一个我们从未
   * 主动列过的会话（例如员工自己在会话里连续跑）。所以这里兜一层：从 dsh 的
   * 会话清单里取该会话的 cwd，再按工作区路径反查员工，并顺手把结果缓存下来。
   */
  async #resolveSessionOwner(sessionId: string): Promise<string | undefined> {
    const cached = this.#sessionOwner.get(sessionId)
    if (cached !== undefined) return cached
    const dsh = this.#dsh
    const store = this.#store
    if (dsh === undefined || store === undefined) return undefined
    try {
      const all = await dsh.sessionList()
      const item = (all.items as Array<Record<string, unknown>>).find(
        (entry) => entry['sessionId'] === sessionId,
      )
      const cwd = typeof item?.['cwd'] === 'string' ? path.resolve(item['cwd']) : undefined
      if (cwd === undefined) return undefined
      const { employees } = await store.discover()
      const owner = employees.find((employee) => path.resolve(employee.workspacePath) === cwd)
      if (owner === undefined) return undefined
      this.#sessionOwner.set(sessionId, owner.id)
      return owner.id
    } catch (error) {
      this.#log(
        `warning: could not attribute session ${sessionId} to an employee: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return undefined
    }
  }

  /**
   * 把会话事件帧（`session/event`、`session/projection`、`host/session-status` 等
   * 只读通知）转发给 Hub。
   *
   * 与审批帧的区别在兜底策略：实测（dsh 0.1.0-rc.6，docs/04 §10.3）这类帧的
   * payload 顶层**恒有 sessionId**，且量大（一轮任务上千条）；少数不带 sessionId 的
   * （`host/workspace-changed`、`host/remote-event`）没有会话语义，直接丢弃 —
   * 不做"向所有被订阅会话广播"的兜底，避免把主机级噪声复制成 N 份。
   */
  async #forwardDshEvent(frame: DshEventFrame): Promise<void> {
    // 推送前限幅：实时流里的大截图事件与历史整包同理会掐断节点连接
    const event = sanitizeLiveEvent({
      method: frame.method ?? '(unknown)',
      payload: frame.payload,
      ...(frame.rpcId === undefined ? {} : { rpcId: frame.rpcId }),
    }) as { method: string; payload: unknown; rpcId?: string }
    await this.#pushSessionEvent(findSessionId(frame.payload), event, {
      broadcastWhenOrphan: false,
    })
  }

  /**
   * 按订阅归属把一条事件推给 Hub。
   *
   * - 找到 sessionId：仅当该会话被 `session.watch` 订阅时才推；
   * - 找不到：`broadcastWhenOrphan` 决定是丢弃还是对所有被订阅会话兜底广播。
   */
  async #pushSessionEvent(
    sessionId: string | undefined,
    event: { method: string; payload: unknown; rpcId?: string },
    options: { broadcastWhenOrphan: boolean },
  ): Promise<void> {
    const hub = this.#hub
    if (hub === undefined || !hub.connected) return

    if (sessionId !== undefined) {
      /* 先记时间戳再判断有没有订阅：没人看的会话同样要有"最后一次动静"，
         否则"卡死"恰恰在最需要的场景（没人开着对话框）里看不见。 */
      this.#sessionLastEventAt.set(sessionId, Date.now())
      if (!this.#watchedSessions.has(sessionId)) return
      const employeeId = this.#sessionOwner.get(sessionId)
      await hub
        .call('session.push', {
          sessionId,
          ...(employeeId === undefined ? {} : { employeeId }),
          event,
        })
        .catch(() => undefined)
      return
    }

    if (!options.broadcastWhenOrphan) return
    // 没有 sessionId：只有当确实有订阅者时才透传，避免无意义流量
    if (this.#watchedSessions.size === 0) return
    for (const id of this.#watchedSessions) {
      const owner = this.#sessionOwner.get(id)
      await hub
        .call('session.push', {
          sessionId: id,
          ...(owner === undefined ? {} : { employeeId: owner }),
          event,
        })
        .catch(() => undefined)
    }
  }

  /* ────────────────────────── 员工级 LLM 端点 ────────────────────────── */

  /** 读配置：apiKey 只回掩码，永远不出节点。 */
  async #llmGet(employeeId: string): Promise<unknown> {
    const employee = await this.#findEmployee(employeeId)
    return llmViewModel(employeeId, await readLlmFile(employee.workspacePath))
  }

  /**
   * 新增或修改一条"这个员工的模型"，并接线到 dsh。
   *
   * 关键语义（每一条都有理由）：
   *   · `id` 给了就是改那一条（**改别名不动路由** —— 路由按 id 派生，改名不打断会话）；
   *   · `apiKey` 留空 = 不改动已保存的那把；**换了端点则必须给新 key**（旧 key 大概率不适用），
   *     所以换端点时留空会显式清掉旧 key，而不是悄悄留着让别人 401；
   *   · `activate: true` 才改"当前模型"；只有一条时自动设为当前（否则配了却用不上，
   *     这种"看起来配好了"的状态最难查）。
   */
  async #llmSave(employeeId: string, params: Record<string, unknown>): Promise<unknown> {
    const employee = await this.#findEmployee(employeeId)
    const dsh = this.#requireDsh()
    const name = normalizeModelName(params['name'])
    const model = requireString(params, 'model').trim()
    if (model === '') throw new Error('模型 id 不能为空')
    const apiUrl = requireString(params, 'apiUrl').trim()
    assertLlmApiUrl(apiUrl)
    const endpointId = typeof params['endpointId'] === 'string' ? params['endpointId'].trim() : ''
    const wantedId = typeof params['id'] === 'string' && params['id'] !== '' ? params['id'] : undefined

    const file: EmployeeLlmFile = (await readLlmFile(employee.workspacePath)) ?? { version: 2, models: [] }
    const duplicate = file.models.find((entry) => entry.name === name && entry.id !== wantedId)
    if (duplicate !== undefined) {
      throw new Error(`别名「${name}」已经被另一条配置用了（同一个员工内别名必须唯一）`)
    }

    const existing = wantedId === undefined ? undefined : file.models.find((entry) => entry.id === wantedId)
    if (wantedId !== undefined && existing === undefined) throw new Error(`找不到配置 ${wantedId}`)

    const keyFromParams = typeof params['apiKey'] === 'string' ? params['apiKey'] : ''
    const endpointChanged = existing !== undefined && existing.endpointId !== endpointId
    const apiKey =
      keyFromParams !== ''
        ? keyFromParams
        : endpointChanged
          ? undefined
          : existing?.apiKey

    const proxyFromParams =
      params['proxy'] === null ? undefined : (normalizeProxyConfig(params['proxy']) ?? existing?.proxy)
    const entry: EmployeeModelEntry = {
      id: existing?.id ?? newModelId(),
      name,
      endpointId,
      apiUrl,
      ...(proxyFromParams === undefined ? {} : { proxy: proxyFromParams }),
      ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }),
      model,
      /* 迁移来的那条继承它的"老路由"标记：保住旧会话认得的路由名 */
      ...(existing?.legacyRoute === true ? { legacyRoute: true } : {}),
    }
    if (existing === undefined) file.models.push(entry)
    else file.models = file.models.map((item) => (item.id === entry.id ? entry : item))

    try {
      const baseUrl = await this.#baseUrlForEntry(entry)
      entry.wiredAtMs = await wireModelToDsh(dsh, employee.id, employee.name, entry, baseUrl)
    } catch (error) {
      this.#log(
        `warning: 「${name}」接线失败（配置已保存，新建会话仍用默认模型）：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    if (params['activate'] === true || file.models.length === 1) file.activeId = entry.id
    await writeLlmFile(employee.workspacePath, file)
    await this.#refreshLlmRoutes()
    await this.#register()
    return llmViewModel(employeeId, file)
  }

  /**
   * 把"当前模型"切到某一条，**并且**（给了 sessionId 时）把这个会话一起切过去。
   *
   * 为什么切换必须是一次显式动作：dsh 的会话把模型选择记成 durable 状态，
   * "保存配置"不该顺手改掉一段正在进行中的对话的模型。但**光记配置不切会话**
   * 正是真实事故的形状（旧会话天天用一个已经没余额的旧 key，而界面上明明配好了）。
   * 所以：切当前会话是默认动作，切不动就如实说，而不是假装成功。
   */
  async #llmActivate(employeeId: string, params: Record<string, unknown>): Promise<unknown> {
    const employee = await this.#findEmployee(employeeId)
    const dsh = this.#requireDsh()
    const id = requireString(params, 'id')
    const file = await readLlmFile(employee.workspacePath)
    if (file === undefined) throw new Error('这个员工还没有任何模型配置')
    const entry = file.models.find((item) => item.id === id)
    if (entry === undefined) throw new Error(`找不到配置 ${id}`)

    entry.wiredAtMs = await wireModelToDsh(
      dsh,
      employee.id,
      employee.name,
      entry,
      await this.#baseUrlForEntry(entry),
    )
    file.activeId = entry.id
    await writeLlmFile(employee.workspacePath, file)

    const sessionId = typeof params['sessionId'] === 'string' && params['sessionId'] !== '' ? params['sessionId'] : ''
    if (sessionId === '') {
      await this.#register()
      return {
        ...llmViewModel(employeeId, file),
        sessionSwitched: false,
        sessionNote: '没有指定要切的会话：新会话会用它，已有的会话保持原样',
      }
    }

    /* 正在跑回合的会话不切：改模型会让进行中的那一步落在一个前后不一致的状态里。
       与其"切了一半"，不如明说"等它跑完再切"。 */
    const running = await this.#sessionRunning(employeeId, sessionId)
    if (running === true) {
      await this.#register()
      return {
        ...llmViewModel(employeeId, file),
        sessionSwitched: false,
        sessionNote: '这个会话正在跑一个回合 —— 等它结束再切（现在切会让进行中的那一步前后不一致）',
      }
    }
    const switched = await selectModelForSession(dsh, sessionId, modelRouteFor(employee.id, entry), entry.model)
    await this.#register()
    return {
      ...llmViewModel(employeeId, file),
      sessionSwitched: switched.ok,
      ...(switched.note === undefined ? {} : { sessionNote: switched.note }),
    }
  }

  /** 查某个会话是不是正在跑（拿不到就说"不知道"，绝不当作"没在跑"）。 */
  async #sessionRunning(employeeId: string, sessionId: string): Promise<boolean | undefined> {
    try {
      const listed = await this.#requireDsh().call('session.list', {})
      const sessions = (listed as { sessions?: unknown }).sessions
      if (!Array.isArray(sessions)) return undefined
      const hit = sessions.find((item) => (item as { sessionId?: unknown }).sessionId === sessionId)
      if (hit === undefined) return undefined
      return (hit as { running?: unknown }).running === true
    } catch {
      return undefined
    }
  }

  /** 删掉一条模型配置：**连它的路由与凭据一起拆**（否则 dsh 里会攒着没人用的密钥）。 */
  async #llmRemove(employeeId: string, params: Record<string, unknown>): Promise<unknown> {
    const employee = await this.#findEmployee(employeeId)
    const dsh = this.#requireDsh()
    const id = requireString(params, 'id')
    const file = await readLlmFile(employee.workspacePath)
    if (file === undefined) throw new Error('这个员工还没有任何模型配置')
    const entry = file.models.find((item) => item.id === id)
    if (entry === undefined) throw new Error(`找不到配置 ${id}`)

    await unwireModelFromDsh(dsh, employee.id, entry)
    file.models = file.models.filter((item) => item.id !== id)
    if (file.activeId === id) {
      const next = file.models[0]
      if (next === undefined) delete file.activeId
      else {
        file.activeId = next.id
        /* 当前那条被删了：顶上来的那条要真的接上线，不然"当前"是个空名 */
        try {
          next.wiredAtMs = await wireModelToDsh(
            dsh,
            employee.id,
            employee.name,
            next,
            await this.#baseUrlForEntry(next),
          )
        } catch (error) {
          this.#log(`warning: 顶替为当前模型的「${next.name}」接线失败：${String(error)}`)
        }
      }
    }
    if (file.models.length === 0) await deleteLlmConfig(employee.workspacePath)
    else await writeLlmFile(employee.workspacePath, file)
    await this.#register()
    return llmViewModel(employeeId, file.models.length === 0 ? undefined : file)
  }

  async #llmUnset(employeeId: string): Promise<unknown> {
    const employee = await this.#findEmployee(employeeId)
    const dsh = this.#requireDsh()
    const file = await readLlmFile(employee.workspacePath)
    for (const entry of file?.models ?? []) {
      await unwireModelFromDsh(dsh, employee.id, entry)
    }
    await deleteLlmConfig(employee.workspacePath)
    await this.#register()
    return {
      employeeId,
      configured: false,
      models: [],
      note: '已清除全部模型配置与 dsh 里的凭据；该员工的新会话回落到节点默认模型（已存在的会话不受影响）',
    }
  }

  /**
   * 端点库改了 BaseURL / Key：把本地那份换掉并重新接线。
   * `apiKey` 缺省 = 库里没存 key（不需要认证的端点），这时**显式清掉**本地旧 key。
   */
  async #llmEndpointSync(employeeId: string, params: Record<string, unknown>): Promise<unknown> {
    const employee = await this.#findEmployee(employeeId)
    const dsh = this.#requireDsh()
    const endpointId = requireString(params, 'endpointId')
    const apiUrl = requireString(params, 'apiUrl').trim()
    assertLlmApiUrl(apiUrl)
    const apiKey = typeof params['apiKey'] === 'string' && params['apiKey'] !== '' ? params['apiKey'] : undefined

    const file = await readLlmFile(employee.workspacePath)
    if (file === undefined) return { employeeId, changed: 0, note: '这个员工没有模型配置' }
    let changed = 0
    for (const entry of file.models) {
      if (entry.endpointId !== endpointId) continue
      entry.apiUrl = apiUrl
      if (apiKey === undefined) delete entry.apiKey
      else entry.apiKey = apiKey
      /* 代理跟着端点库走：改代理（或取消代理）都要在这里落地 */
      if (params['proxy'] === null) delete entry.proxy
      else {
        const proxy = normalizeProxyConfig(params['proxy'])
        if (proxy !== undefined) entry.proxy = proxy
      }
      try {
        entry.wiredAtMs = await wireModelToDsh(
          dsh,
          employee.id,
          employee.name,
          entry,
          await this.#baseUrlForEntry(entry),
        )
        changed += 1
      } catch (error) {
        this.#log(`warning: 「${entry.name}」按端点库重新接线失败：${String(error)}`)
      }
    }
    if (changed > 0) {
      await writeLlmFile(employee.workspacePath, file)
      await this.#refreshLlmRoutes()
      await this.#register()
    }
    return { employeeId, changed, ...(changed === 0 ? { note: '这个员工没有用到该端点' } : {}) }
  }

  /**
   * 把某条模型所用的端点**交给 Hub 收进端点库**（并在这条上记下库里那条的 id）。
   *
   * 为什么需要这一步：老配置是"一个员工一条端点"，BaseURL 与 Key 只在这台机器上。
   * 要让它们进库（多员工复用、改一处全场生效），密钥就得**从节点上行到 Hub 一次** ——
   * 这是用户明确要的"库在 Hub"的必然代价，所以做成一次**显式动作**：
   * 只有人点了「收进端点库」才会发生，且回报里只说端点名，不回密钥。
   * 路由名不变（条目 id 不动）—— 旧会话照旧。
   */
  async #llmPromote(employeeId: string, params: Record<string, unknown>): Promise<unknown> {
    const employee = await this.#findEmployee(employeeId)
    const id = requireString(params, 'id')
    const file = await readLlmFile(employee.workspacePath)
    const entry = file?.models.find((item) => item.id === id)
    if (file === undefined || entry === undefined) throw new Error(`找不到配置 ${id}`)
    if (entry.endpointId !== '') throw new Error('这条已经指向端点库里的一条了')
    const name = normalizeModelName(params['endpointName'])
    /* apiUrl 与 apiKey **同时**交出去：端点库要能独立接线，缺一不可 */
    return {
      employeeId,
      id: entry.id,
      name,
      apiUrl: entry.apiUrl,
      ...(entry.apiKey === undefined || entry.apiKey === '' ? {} : { apiKey: entry.apiKey }),
      model: entry.model,
    }
  }

  /** 收进库之后把这条指向库里的 id（路由名不变）。 */
  async #llmLinkEndpoint(employeeId: string, params: Record<string, unknown>): Promise<unknown> {
    const employee = await this.#findEmployee(employeeId)
    const id = requireString(params, 'id')
    const endpointId = requireString(params, 'endpointId')
    const file = await readLlmFile(employee.workspacePath)
    const entry = file?.models.find((item) => item.id === id)
    if (file === undefined || entry === undefined) throw new Error(`找不到配置 ${id}`)
    entry.endpointId = endpointId
    await writeLlmFile(employee.workspacePath, file)
    await this.#register()
    return llmViewModel(employeeId, file)
  }

  /** 拉端点的模型列表。payload 缺省时用"当前模型"那条的端点 —— 没配过就要求先填 API URL。 */
  /**
   * 读这台机器的默认权限档位。
   *
   * 只回**事实**：dsh 报什么就是什么；报不上来就 `preset: null` + 说明，
   * 不让界面以为"没设置过 = 工作区可写"。
   */
  async #permissionGet(): Promise<unknown> {
    const preset = await readDefaultPreset(this.#requireDsh())
    return {
      preset: preset ?? null,
      options: [...PERMISSION_PRESETS],
      ...(preset === undefined ? { note: 'dsh 没有报出当前默认档位（版本/组合不同？）' } : {}),
    }
  }

  /** 写这台机器的默认权限档位（**只影响新建会话**，已有会话不受影响）。 */
  async #permissionSet(params: Record<string, unknown>): Promise<unknown> {
    const preset = params['preset']
    if (!isPermissionPreset(preset)) {
      throw new Error(`档位只能是 ${PERMISSION_PRESETS.join(' / ')}，收到 ${String(preset)}`)
    }
    await writeDefaultPreset(this.#requireDsh(), preset)
    this.#log(`permission defaultPreset → ${preset}（整机；只影响新建会话）`)
    return await this.#permissionGet()
  }

  async #llmProbe(employeeId: string, params: Record<string, unknown>): Promise<unknown> {
    const employee = await this.#findEmployee(employeeId)
    const file = await readLlmFile(employee.workspacePath)
    const current = activeModelOf(file) ?? file?.models[0]
    const apiUrl =
      typeof params['apiUrl'] === 'string' && params['apiUrl'] !== '' ? params['apiUrl'] : current?.apiUrl
    if (apiUrl === undefined) throw new Error('该员工还没有配过端点，请先填 API URL')
    const apiKey =
      typeof params['apiKey'] === 'string' && params['apiKey'] !== '' ? params['apiKey'] : current?.apiKey
    /* 代理：显式给了就用给的（表单里刚填、还没保存），否则用这条端点已保存的 */
    const proxy =
      normalizeProxyConfig(params['proxy']) ??
      (params['proxy'] === null ? undefined : current?.proxy)
    return await probeModels(apiUrl, apiKey, 10_000, proxy)
  }

  /* ── 本地转发口：让"某个端点走代理"这件事对 dsh 透明 ──
   *
   * dsh 的 provider 配置里没有代理字段（只有 baseURL），所以带代理的端点
   * 把 baseURL 指到 `http://127.0.0.1:<口>/<路由键>`，由本进程经代理转发过去。
   * 路由键优先用端点库 id（多条员工共用同一个上游），本地条目则用它自己的条目 id。 */
  #llmForwarder: LocalForwarder | undefined

  async #ensureLlmForwarder(): Promise<LocalForwarder> {
    if (this.#llmForwarder !== undefined) return this.#llmForwarder
    const forwarder = await startLocalForwarder({
      port: forwarderPort(),
      onWarn: (message) => this.#log(message),
    })
    this.#llmForwarder = forwarder
    this.#log(`llm forwarder listening on 127.0.0.1:${String(forwarder.port)}（带代理的端点走它）`)
    return forwarder
  }

  /** 按所有员工的 llm.json 重建转发路由表（端点增删改、节点重启后都调一次）。 */
  async #refreshLlmRoutes(): Promise<void> {
    const store = this.#requireStore()
    const discovered = await store.discover()
    const routes = new Map<string, Upstream>()
    for (const employee of discovered.employees) {
      const file = await readLlmFile(employee.workspacePath)
      for (const entry of file?.models ?? []) {
        if (entry.proxy === undefined) continue
        const id = llmRouteKeyFor(entry)
        const existing = routes.get(id)
        if (existing !== undefined && existing.baseUrl !== entry.apiUrl) {
          this.#log(
            `warning: 端点 ${id} 的 baseURL 在两个地方不一致（${existing.baseUrl} vs ${entry.apiUrl}）——` +
              '以先注册的为准；在「模型配置」里重新保存一次即可对齐',
          )
          continue
        }
        routes.set(id, { id, baseUrl: entry.apiUrl, proxy: entry.proxy })
      }
    }
    const forwarder = await this.#ensureLlmForwarder()
    forwarder.update([...routes.values()])
  }

  /** 接线用的 baseURL：带代理的端点指向本机转发口，否则直连它自己的地址。 */
  async #baseUrlForEntry(entry: EmployeeModelEntry): Promise<string | undefined> {
    if (entry.proxy === undefined) return undefined
    const forwarder = await this.#ensureLlmForwarder()
    return `http://127.0.0.1:${String(forwarder.port)}/${llmRouteKeyFor(entry)}`
  }

  /* ────────────────────────── 技能 ────────────────────────── */

  async #listSkills(employeeId: string): Promise<unknown> {
    const store = this.#requireStore()
    const dsh = this.#requireDsh()
    const employee = await this.#findEmployee(employeeId)

    // 员工专属技能：<工作区>/.dsh/skills（dsh 扫描 rank 100，优先级最高）。
    // skills 带 frontmatter 校验（dsh 对不合规技能是「告警 + 忽略」fail-closed，
    // valid/issues 把「写了但没生效」摆到台面上）；workspaceSkills 保留纯名字清单以兼容旧消费方。
    const skills = await store.describeSkills(employee.workspacePath)
    const workspaceSkills = employee.skills

    // dsh 自己的视图需要 sessionId，因此只在已有会话时附加，避免为查技能而建会话
    let dshView: unknown
    try {
      const all = await dsh.sessionList()
      const existing = (all.items as Array<Record<string, unknown>>).find(
        (item) =>
          typeof item['cwd'] === 'string' &&
          path.resolve(item['cwd']) === employee.workspacePath &&
          typeof item['sessionId'] === 'string',
      )
      if (existing !== undefined) {
        dshView = await dsh.skillList(existing['sessionId'] as string)
      }
    } catch {
      /* 查不到 dsh 视图不影响返回专属技能 */
    }

    return {
      employeeId,
      skills,
      workspaceSkills,
      skillsRoot: path.join(employee.workspacePath, '.dsh', 'skills'),
      hasGitAnchor: employee.hasGitAnchor,
      audit: auditPrivateSkills(skills, employee.hasGitAnchor, dshView),
      ...(dshView === undefined ? {} : { dshView }),
      note:
        dshView === undefined
          ? 'dsh 的技能清单是按会话解析的；该员工还没有会话，因此只列出了工作区专属技能'
          : undefined,
    }
  }

  /* ────────────────────────── 辅助 ────────────────────────── */

  /** 打印"这台节点还没被批准"的可执行指引。 */
  #reportPairingRequired(details: Record<string, unknown> | undefined): void {
    const requestId = details?.['requestId']
    this.#log(
      [
        'this node is not paired yet. Ask an already-authorized device to approve it',
        '（在 Hub 所在机器上执行）：',
        `  node dse.mjs pair approve ${typeof requestId === 'string' ? requestId : '<requestId>'}`,
        `  节点名    ${this.options.name}`,
        `  deviceId  ${this.#hub?.identity.deviceId ?? '(unknown)'}`,
        '批准后本进程会自动连上，无需重启。',
      ].join('\n  '),
    )
  }

  async #findEmployee(employeeId: string): Promise<DiscoveredEmployee> {
    const { employees } = await this.#requireStore().discover()
    const hit = employees.find((employee) => employee.id === employeeId)
    if (hit === undefined) throw new Error(`unknown employee "${employeeId}" on this node`)
    return hit
  }

  #requireDsh(): DshClient {
    if (this.#dsh === undefined) throw new Error('dsh client is not ready')
    return this.#dsh
  }

  #requireStore(): EmployeeStore {
    if (this.#store === undefined) throw new Error('employee store is not ready')
    return this.#store
  }

  #requireDownlink(): DshDownlink {
    if (this.#downlink === undefined) throw new Error('dsh downlink is not ready')
    return this.#downlink
  }

  #requireHub(): HubClient {
    if (this.#hub === undefined) throw new Error('hub client is not ready')
    return this.#hub
  }

  #log(message: string): void {
    process.stdout.write(`[node:${this.options.name}] ${message}\n`)
  }
}

/* ────────────────────────────── 工具 ────────────────────────────── */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 节点名 → 状态目录名。导出给 CLI 复用（dse pair-code --hub 要按同一规则定位节点身份）。 */
export function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, '-').slice(0, 48) || 'node'
}

function requireString(
  params: Record<string, unknown>,
  key: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const value = params[key]
  if (typeof value !== 'string' || (!options.allowEmpty && value === '')) {
    throw new Error(`missing or invalid string param "${key}"`)
  }
  return value
}

/**
 * 会话标题的统一校验（session.create 的可选 title 与 session.rename 共用一条规矩）：
 * trim 后 1–200 字符。dsh 侧对标题的持久化以 rename 为准，这里先把明显非法的挡在门外。
 */
function requireSessionTitle(value: unknown): string {
  if (typeof value !== 'string') throw new Error('missing or invalid string param "title"')
  const title = value.trim()
  if (title === '') throw new Error('title must not be empty (after trim)')
  if (title.length > 200) throw new Error('title must be at most 200 characters')
  return title
}

/** 把任意错误翻译成协议错误形状，供回传给 Hub。 */
function toProtocolError(error: unknown): ProtocolErrorShape {
  if (error instanceof HubCallError) {
    return { code: 'internal', message: error.message }
  }
  if (error instanceof DshApiError) {
    // dsh 的业务错误码不一定在我们的枚举里，因此统一映射为 bad-request 并保留原码
    return {
      code: 'bad-request',
      message: `dsh rejected the request: ${error.message}`,
      details: { dshCode: error.code, dshDetails: error.details },
    }
  }
  if (error instanceof DshCarrierError) {
    return {
      code: 'internal',
      message: `dsh carrier failure (${error.status}): ${error.message}`,
    }
  }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}

/** 在任意深度的 payload 里找一个 sessionId 字段。 */
function findSessionId(root: unknown, depth = 0): string | undefined {
  if (depth > 6 || root === null || typeof root !== 'object') return undefined
  if (Array.isArray(root)) {
    for (const item of root) {
      const hit = findSessionId(item, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    if ((key === 'sessionId' || key === 'session_id') && typeof value === 'string') return value
    const hit = findSessionId(value, depth + 1)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * 从 assistant 消息事件的 `data` 里取出文本。
 *
 * **实测形状**（`scripts/e2e-real-turn.ts` 一次真实成功轮次）：
 * ```jsonc
 * { "turn": 1, "step": 1,
 *   "message": { "role": "assistant",
 *                "content": [{ "type": "text", "text": "…" }],
 *                "source": { "kind": "model", "provider": "…", "model": "…" } },
 *   "usage": { "inputTokens": …, "outputTokens": … } }
 * ```
 * 注意文本在 **`data.message.content`**，不是 `data.content` ——
 * 这个差别让第一版实现静默失效（返回 undefined 后落到增量拼接的兜底路径，
 * 结果"看起来能用"，主路径却一直是坏的）。两种形状都认，避免再次踩空。
 *
 * 只取文本段：`content` 里还可能有工具调用等非文本段，把那些当回复吐出去更糟。
 */
export function extractAssistantText(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const outer = data as { message?: { content?: unknown }; content?: unknown }
  const content = outer.message?.content ?? outer.content
  if (!Array.isArray(content)) return undefined

  const pieces: string[] = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    const block = part as { type?: string; text?: string }
    if (block.type === 'text' && typeof block.text === 'string') pieces.push(block.text)
  }
  const text = pieces.join('').trim()
  return text === '' ? undefined : text
}

export { newId }

/**
 * 私有技能可见性核对 —— 「写在磁盘上」与「dsh 真的扫到」是两件事。
 *
 * 背景：私有技能根是 `<projectRoot>/.dsh/skills`，而 `projectRoot` 由 dsh 的
 * `findProjectRoot()` 决定 —— 它从 cwd 往上找第一个含 `.git` 的祖先。工作区没有自己的
 * `.git` 时 projectRoot 落到外层仓库，于是工作区里写好的技能**一个都扫不到，且不报错**。
 * 另一条失败路径是 frontmatter 不合规（dsh 对它是"告警 + 忽略"，fail-closed）。
 * 两种都表现为"员工莫名其妙变笨"，所以这里把它算成一个明确结论交给界面。
 *
 * `checked=false` 表示该员工还没有会话、拿不到 dsh 视图 —— 此时**不下结论**，
 * 只说明"没能核对"，而不是假装没问题。
 */
export function auditPrivateSkills(
  privateSkills: Array<{ name: string; valid: boolean; issues?: string[] }>,
  hasGitAnchor: boolean,
  dshView: unknown,
): {
  privateCount: number
  missing: string[]
  invalid: string[]
  checked: boolean
  hint?: string
} {
  const names = privateSkills.map((skill) => skill.name)
  const invalid = privateSkills.filter((skill) => !skill.valid).map((skill) => skill.name)
  /* BOM 单独点出来：它是"控制台说合规、dsh 却忽略"的那种不一致里最容易被误诊成
     "frontmatter 不合规"的一个（见 employees.ts 的 SKILL_BOM_ISSUE）。
     只认这一条特征串，别把 issues 里别的文案也当 BOM。 */
  const bomNames = privateSkills
    .filter((skill) => (skill.issues ?? []).some((issue) => issue.includes('UTF-8 BOM')))
    .map((skill) => skill.name)

  let visible: string[] | undefined
  if (dshView !== null && typeof dshView === 'object') {
    const list = (dshView as { skills?: unknown }).skills
    if (Array.isArray(list)) {
      visible = list
        .map((entry) =>
          entry !== null && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined,
        )
        .filter((name): name is string => typeof name === 'string')
    }
  }

  const missing =
    visible === undefined ? [] : names.filter((name) => !visible.includes(name))
  const hint =
    missing.length === 0
      ? undefined
      : hasGitAnchor
        ? bomNames.length > 0
          ? `这些技能写在 <工作区>/.dsh/skills 里但 dsh 没扫到：其中 ${bomNames.length} 个（${bomNames
              .slice(0, 3)
              .join('、')}）是文件开头的 UTF-8 BOM —— dsh 不剥 BOM 会直接忽略，去掉开头 3 个字节即可`
          : '这些技能写在 <工作区>/.dsh/skills 里但 dsh 没扫到：多半是 frontmatter 不合规（见 issues）'
        : '工作区缺 .git 锚点：dsh 的 projectRoot 会落到外层仓库，私有技能被静默忽略 —— 在工作区执行 git init 即可'

  return {
    privateCount: names.length,
    missing,
    invalid,
    checked: visible !== undefined,
    ...(hint === undefined ? {} : { hint }),
  }
}
