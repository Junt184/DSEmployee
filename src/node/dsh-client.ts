/**
 * dsh `/api` 客户端 —— 终端节点驱动本机 dsh 实例的唯一通道。
 *
 * 为什么必须有这一层，而不是让 Hub 直连 dsh：
 *   dsh 的 `/api` **没有认证层**（官方原文："这道栅栏是可达性策略，而不是认证"），
 *   且 `settings.*` / `credentials.*` / `host.openPath` / `agentPreset.copy|remove`
 *   这批高危方法被故意钉死在回环。所以驱动 dsh 的进程**必须与 dsh 同机**，
 *   对外只暴露经过 Hub 授权的 RPC。本类就是那个同机进程的手。
 *
 * 线契约（逐字对齐 dsh 的 `rpc.schema.js`，这是**外部契约**，不随我们重构而变）：
 *   请求  POST /api/<method>   Content-Type: application/json
 *         { type:'client-request', rpcId, method, payload }
 *   响应  200
 *         { type:'server-response', rpcId, result: { ok:true, value } | { ok:false, error } }
 *   下行  GET /api/events.mux 与 /api/events.host（本客户端用 WebSocket 升级）
 *         帧形如 { type:'server-request', rpcId, method, payload }
 *         实测（dsh 0.1.0-rc.6，docs/04 §10.3）：下行流里**所有**帧都是这个信封，
 *         靠 method 区分语义 —— `session/event`、`session/projection`、`session/queue`、
 *         `session/subscribed`（events.mux）与 `host/session-status`（events.host）
 *         是**只读通知**，不需要回填；其余 method（审批、提问）才需要 `respond`。
 *   回填  POST /api/respond    { type:'client-response', rpcId, result }
 *
 * 特例：`commands/execute` 的 payload 必须把参数包一层 `args`
 *   —— `{ args: { agentId, line } }`（`sessionCompact` 靠它触发 dsh 的 `/compact`）。
 *
 * 关键：**业务错误也是 HTTP 200**，只有载体层错误才用 404/415/400/500。
 * 因此只检查 HTTP 状态码是不够的，必须解析 `result.ok`。
 */

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

import WebSocket from 'ws'

/** dsh 业务错误。`code` 取自 dsh 自己的错误码联合类型。 */
export class DshApiError extends Error {
  readonly code: string
  readonly details: unknown

  constructor(code: string, message: string, details: unknown) {
    super(message)
    this.name = 'DshApiError'
    this.code = code
    this.details = details
  }
}

/** 载体层错误（HTTP 404/415/400/500），与业务错误区分开。 */
export class DshCarrierError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'DshCarrierError'
    this.status = status
  }
}

interface ServerResponseFrame {
  type: 'server-response'
  rpcId: string
  result:
    | { ok: true; value?: unknown }
    | { ok: false; error: { code: string; message: string; details: unknown } }
}

/**
 * dsh 主动发起的请求帧。
 *
 * 必须保留 `rpcId` —— 回填答复（`POST /api/respond`）就是靠它定位的。
 * 审批与提问都走这条通道，所以丢了 rpcId 就等于"看得见、答不了"。
 */
export interface ServerRequestFrame {
  type: 'server-request'
  rpcId: string
  method: string
  payload: unknown
}

export interface DshClientOptions {
  host?: string
  port: number
  /** 单次调用超时 */
  timeoutMs?: number
  /** 调试日志 */
  verbose?: boolean
}

export interface DshCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export class DshClient {
  readonly baseUrl: string
  readonly wsBaseUrl: string
  readonly #timeoutMs: number
  readonly #verbose: boolean

  constructor(options: DshClientOptions) {
    const host = options.host ?? '127.0.0.1'
    this.baseUrl = `http://${host}:${options.port}`
    this.wsBaseUrl = `ws://${host}:${options.port}`
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#verbose = options.verbose ?? false
  }

  /** 发一次一元调用。业务失败抛 `DshApiError`，载体失败抛 `DshCarrierError`。 */
  async call<T = unknown>(
    method: string,
    payload: unknown = {},
    options: DshCallOptions = {},
  ): Promise<T> {
    const rpcId = randomUUID()
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs

    // 组合"调用超时"与"外部取消"两个信号，任一触发即中止。
    // 关键：超时必须覆盖到**响应体读完**为止。只守住 fetch 的响应头，
    // 一个"回了 200 头但 body 永远不来"的 dsh 会把 response.json() 挂起到永远
    // （线上真实事故：节点对 session.create 的应答就断在这一环）。
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('dsh call timed out')), timeoutMs)
    timer.unref?.()
    const onExternalAbort = (): void => controller.abort(options.signal?.reason)
    if (options.signal !== undefined) {
      if (options.signal.aborted) onExternalAbort()
      else options.signal.addEventListener('abort', onExternalAbort, { once: true })
    }

    let frame: ServerResponseFrame
    try {
      const response = await fetch(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new DshCarrierError(
          response.status,
          `dsh carrier error ${response.status} for "${method}": ${text.slice(0, 500)}`,
        )
      }

      frame = (await response.json()) as ServerResponseFrame
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onExternalAbort)
    }
    if (this.#verbose) {
      this.#log(`← ${method} ${JSON.stringify(frame).slice(0, 400)}`)
    }
    if (frame.rpcId !== rpcId) {
      // 响应对不上请求：可能是并发串包或协议变更，宁可报错也不要张冠李戴
      throw new DshCarrierError(
        200,
        `dsh response rpcId mismatch for "${method}" (sent ${rpcId}, got ${frame.rpcId})`,
      )
    }
    if (!frame.result.ok) {
      throw new DshApiError(frame.result.error.code, frame.result.error.message, frame.result.error.details)
    }
    return frame.result.value as T
  }

  /* ────────────────────────── 常用方法的薄封装 ────────────────────────── */

  hostDescribe(): Promise<{
    version: string
    cwd: string
    provider: string
    model: string
    attachedSessions: number
    canOpenPath: boolean
  }> {
    return this.call('host.describe', {})
  }

  /** 实测返回 `{ items, archivedSessionIds }`（注意是 items，不是 workspaces）。 */
  workspaceList(): Promise<{ items: unknown[]; archivedSessionIds: string[] }> {
    return this.call('workspace.list', {})
  }

  workspaceCreate(path: string, title?: string): Promise<{ workspaceId: string }> {
    return this.call('workspace.create', title === undefined ? { path } : { path, title })
  }

  sessionList(): Promise<{ items: unknown[] }> {
    return this.call('session.list', {})
  }

  sessionCreate(input: {
    workspaceId?: string
    cwd?: string
    sessionId?: string
    agentPreset?: string
  }): Promise<{ sessionId: string; agentPreset?: string }> {
    return this.call('session.create', input)
  }

  sessionPrompt(sessionId: string, text: string, mode: 'queue' | 'steer' = 'queue'): Promise<unknown> {
    return this.call('session.prompt', {
      sessionId,
      mode,
      content: [{ type: 'text', text }],
    })
  }

  /**
   * 带内容块下达指令（文本 + 内联图片）。
   *
   * 契约（`dsh-host-apiproxy` 的 `PromptContentPart`）：
   *   { type:'text',  text }
   *   { type:'image', mediaType, data, name? }   ← data 为 base64
   * 注释原话是「Browser-submitted prompt content; the host promotes image bytes to
   * durable references」—— 也就是说**不必先上传再引用**，直接把字节放进内容块即可，
   * 由宿主负责提升为持久附件。图片本身有部署级上限（`imageLimits` 投影发布），
   * 越界会在 dsh 侧被拒，错误原样回传。
   */
  sessionPromptContent(
    sessionId: string,
    content: readonly Record<string, unknown>[],
    mode: 'queue' | 'steer' = 'queue',
  ): Promise<unknown> {
    return this.call('session.prompt', { sessionId, mode, content })
  }

  sessionCancel(sessionId: string): Promise<unknown> {
    return this.call('session.cancel', { sessionId })
  }

  /**
   * 触发 dsh 的手动压缩（`/compact` slash 命令 → dsh-command-compact → ctx.compaction.compactNow）。
   *
   * 实测（dsh 0.1.0-rc.6）：
   *   - payload 必须把参数包一层 `args`（平铺会被静默忽略）；
   *   - 命令已挂载（standard/code preset 有 compact）→ 同步返回
   *     `{ commandId, result: { kind:'success'|'error', text } }`，本方法透传 `result`
   *     （空历史时 text = 'No compactable history yet.'）；
   *   - 命令未挂载（minimal preset 没有 compact）→ dsh 静默吞掉这行命令，
   *     回 `ok:true` 但**没有 value**，本方法返回 `undefined` ——
   *     「该会话的 preset 不含压缩能力」的判断由调用方据此做出。
   */
  async sessionCompact(sessionId: string): Promise<{ kind?: unknown; text?: unknown } | undefined> {
    const response = await this.call<
      { commandId?: string; result?: { kind?: unknown; text?: unknown } } | undefined
    >('commands/execute', { args: { agentId: sessionId, line: '/compact' } })
    return response?.result
  }

  /**
   * 给会话落标题（实测 dsh 0.1.0-rc.6：返回 `{title, seq}`，持久化生效）。
   *
   * 为什么必须是独立的一步：`session.create` 的 payload 里塞 `title` 会被 dsh
   * **静默忽略**（不落标题），命名只能走这个第二步。标题在 `session.list` 里
   * 出现在 `item.projections.values.title`（顶层没有 title 字段）。
   */
  sessionRename(sessionId: string, title: string): Promise<{ title: string; seq: number }> {
    return this.call('session.rename', { sessionId, title })
  }

  sessionHistory(
    sessionId: string,
    options: { beforeSeq?: number; maxMessages?: number } = {},
  ): Promise<{ events: unknown[]; hasMore: boolean; projections?: unknown }> {
    return this.call('session.history', { sessionId, ...options })
  }

  /** 实测 `skill.list` **要求 sessionId** —— 技能可见性是按会话解析的，不是全局清单。 */
  skillList(sessionId: string): Promise<unknown> {
    return this.call('skill.list', { sessionId })
  }

  /**
   * 打开下行流。
   *
   * dsh 提供两条只下行通道（`events.mux` 与 `events.host`）。
   * 客户端**不在这两条 socket 上发业务数据**；服务端主动发起的请求（提问、审批）
   * 要走 `POST /api/respond` 回填。
   */
  openDownlink(): DshDownlink {
    return new DshDownlink(this)
  }

  #log(message: string): void {
    process.stdout.write(`[dsh-client] ${message}\n`)
  }
}

/* ────────────────────────────── 下行流 ────────────────────────────── */

export interface DshDownlinkEvents {
  /** 服务端主动发起的请求（需要调用方决定如何处理） */
  request: [ServerRequestFrame]
  /**
   * 会话事件帧（只读通知，不需要回填答复）。
   *
   * 实测（dsh 0.1.0-rc.6）：会话事件也是 `server-request` 信封，靠 method 区分 ——
   * `session/event`、`session/projection`、`session/queue`、`session/subscribed`、
   * `host/session-added`、`host/session-status`，payload 顶层都带 `sessionId`。
   * 任何非 `server-request` 的帧（协议将来新增的类型）也从这里出来，不再被丢弃。
   */
  event: [DshEventFrame]
  /** 某条通道连接建立（含自动重连成功） */
  open: [{ channel: string }]
  /** 两条流之一断开（随后会自动重连） */
  close: [{ channel: string }]
  /** 解析失败或传输错误 */
  error: [Error]
}

/**
 * 下行流里的会话事件帧。
 *
 * 与 `ServerRequestFrame` 的区别只在语义：它描述"发生了什么"而不是"请你回答什么"，
 * 因此 `rpcId`/`method`/`payload` 都标为可选 —— 实测它们其实都在，但通知帧的
 * rpcId 只是信封的一部分，**不要**拿它去 `POST /api/respond`。
 */
export interface DshEventFrame {
  /** 实测恒为 'server-request'；不钉死字面量，给协议新增帧类型留余地 */
  type?: string
  /** 事件方法名，如 'session/event'、'host/session-status' */
  method?: string
  /** 实测顶层恒有 `sessionId`（docs/04 §10.3） */
  payload?: unknown
  rpcId?: string
  /** 帧来自哪条通道：'events.mux' 或 'events.host' */
  channel: string
}

/**
 * 判断一个 server-request 是不是**只读通知**（会话事件）。
 *
 * 实测命中的方法全部以 `session/` 或 `host/` 开头；其余 method（审批、提问）
 * 保持走 `request` 事件，行为与之前完全一致。
 */
function isEventMethod(method: string): boolean {
  return method.startsWith('session/') || method.startsWith('host/')
}

/**
 * dsh 的两条只下行 WebSocket。
 *
 * 自动重连：任一条通道断开都以指数退避重建（同一 URL），直到 `close()` 被调用。
 * 每条通道独立计退避 —— 一条断了不影响另一条。节奏与 hub-client 的重连一致
 * （500ms 翻倍、封顶 20s）：对回环端口这是极低的轮询成本，而 dsh 由 DshProcess
 * 在**同一端口**自愈重启，所以"进程崩溃"与"网络抖动"在这里是同一种情况 ——
 * 重试到端口重新监听为止，上层不需要为 dsh 重启做任何额外动作。
 *
 * 断开到重连成功之间的事件**丢了就是丢了**（dsh 的 mux 没有回放）：
 * 上层靠每次 `close` 事件判断"这段时间的输出可能不完整"。
 * 订阅与归属状态全部保留在调用方（agent 侧过滤），重连后无需重建任何状态。
 */
export class DshDownlink extends EventEmitter<DshDownlinkEvents> {
  readonly #client: DshClient
  #sockets: WebSocket[] = []
  #closed = false
  /** 每条通道的连续重连次数（退避依据）；该通道连接成功即复位 */
  readonly #reconnectAttempts = new Map<string, number>()
  readonly #reconnectTimers = new Set<NodeJS.Timeout>()

  constructor(client: DshClient) {
    super()
    this.#client = client
  }

  open(): void {
    this.#closed = false
    for (const channel of ['events.mux', 'events.host'] as const) {
      this.#openChannel(channel)
    }
  }

  #openChannel(channel: string): void {
    if (this.#closed) return
    const socket = new WebSocket(`${this.#client.wsBaseUrl}/api/${channel}`)
    this.#sockets.push(socket)

    socket.on('open', () => {
      this.#reconnectAttempts.delete(channel)
      this.emit('open', { channel })
    })
    socket.on('message', (data) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(data.toString())
      } catch (error) {
        this.emit('error', error instanceof Error ? error : new Error(String(error)))
        return
      }
      const frame = parsed as { type?: string; method?: string }
      // 实测（dsh 0.1.0-rc.6，docs/04 §10.3）：会话事件与审批请求共用
      // `server-request` 信封，靠 method 区分。session/* 与 host/* 是只读通知，
      // 走 'event'；其余 server-request（审批、提问）保持走 'request'，
      // rpcId 原样保留 —— 回填答复（POST /api/respond）就靠它定位。
      if (frame.type === 'server-request' && (frame.method === undefined || !isEventMethod(frame.method))) {
        this.emit('request', parsed as ServerRequestFrame)
        return
      }
      // 会话事件帧，以及任何非 server-request 的帧（协议将来新增的类型），
      // 都不再丢弃 —— 当初"只放行 server-request"正是实时事件流断裂的嫌疑点之一。
      const event = parsed as Omit<DshEventFrame, 'channel'>
      this.emit('event', { ...event, channel })
    })
    socket.on('close', () => {
      this.#sockets = this.#sockets.filter((candidate) => candidate !== socket)
      if (this.#closed) return
      this.emit('close', { channel })
      this.#scheduleReconnect(channel)
    })
    socket.on('error', (error) => {
      /* 传输错误只上报，不在这里重连：ws 在 error 之后必然紧跟 close，
         重连统一由 close 处理（连接被拒 ECONNREFUSED 也是 error → close）。 */
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
    })
  }

  /** 指数退避重建一条通道（500ms 翻倍、封顶 20s，节奏与 hub-client 一致）。 */
  #scheduleReconnect(channel: string): void {
    if (this.#closed) return
    const attempt = (this.#reconnectAttempts.get(channel) ?? 0) + 1
    this.#reconnectAttempts.set(channel, attempt)
    const delayMs = Math.min(500 * 2 ** (attempt - 1), 20_000)
    const timer = setTimeout(() => {
      this.#reconnectTimers.delete(timer)
      this.#openChannel(channel)
    }, delayMs)
    timer.unref?.()
    this.#reconnectTimers.add(timer)
  }

  /** 回填一个服务端发起的请求（例如向用户的提问、审批裁决）。 */
  async respond(rpcId: string, value: unknown): Promise<void> {
    const body = {
      type: 'client-response',
      rpcId,
      result: { ok: true, value },
    }
    const response = await fetch(`${this.#client.baseUrl}/api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new DshCarrierError(response.status, `failed to respond to ${rpcId}`)
    }
  }

  close(): void {
    this.#closed = true
    // 挂起的重连一律取消 —— close() 之后绝不能再有新连接长出来
    for (const timer of this.#reconnectTimers) clearTimeout(timer)
    this.#reconnectTimers.clear()
    for (const socket of this.#sockets) {
      try {
        socket.close()
      } catch {
        /* 关闭失败不影响退出 */
      }
    }
    this.#sockets = []
  }
}
