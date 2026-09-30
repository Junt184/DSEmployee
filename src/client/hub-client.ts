/**
 * Hub 客户端 —— 终端节点与命令行工具共用的连接层。
 *
 * 负责把"密钥身份 + 挑战签名握手 + 请求响应关联 + 重连"这套东西收在一处，
 * 让上层（节点代理、CLI、控制台）只需要 `connect()` 和 `call()`。
 *
 * 重连语义刻意做成显式：`connect()` 成功返回后，若连接后来断开，
 * 会**自动重连**（指数退避），并在每次重连成功后发 `reconnected` 事件 ——
 * 因为节点重连后必须重新上报员工目录，这个动作不能靠调用方记得做。
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

import WebSocket from 'ws'

import {
  PROTOCOL_VERSION,
  canonicalConnectPayload,
  createNonce,
  parseFrame,
  signConnectPayload,
  type EventFrame,
  type EventName,
  type ProtocolErrorShape,
  type ReqFrame,
  type ResFrame,
  type Role,
  type Scope,
} from '../protocol/index.ts'
import { loadOrCreateIdentity, type IdentityFile } from '../util/identity.ts'

export interface HubClientOptions {
  /** 设备身份文件路径。不存在则自动生成。 */
  identityFile: string
  /** Hub 的 WS 地址，例如 ws://127.0.0.1:19790/ws */
  url: string
  role: Role
  /** 期望的 scope。实际生效的会被服务端按配对批准集合裁剪。 */
  scopes: readonly Scope[]
  clientId: string
  /** 显示名，会出现在设备台账里 */
  displayName?: string
  /** 已配对设备令牌 */
  token?: string
  /** 单次调用超时 */
  timeoutMs?: number
  /** 调试日志 */
  verbose?: boolean
  /** 断开后是否自动重连 */
  autoReconnect?: boolean
  /**
   * 额外的 WS 握手头。**只给测试/探测用**（例如验证 trust-proxy 行为）——
   * 生产客户端自己设置 X-Real-IP 之类的头没有任何正当用途，
   * 服务端是否信这些头由 `--trust-proxy` 决定（见 HubOptions.trustProxy 的威胁模型）。
   */
  headers?: Record<string, string>
  /**
   * 存活性看门狗的"无帧容忍窗口"。默认 2.5 × hello 下发的 tickIntervalMs。
   * 测试与极端部署可覆盖；一般不需要动（见 #startWatchdog 的注释）。
   */
  maxSilenceMs?: number
}

export interface HelloOk {
  hubId: string
  protocol: number
  server: { version: string; connId: string }
  features: { methods: string[]; events: string[] }
  auth: { deviceToken?: string; role: Role; scopes: Scope[]; pairingId?: string }
  policy: { maxPayload: number; tickIntervalMs: number }
}

export interface HubClientEvents {
  hello: [HelloOk]
  /** 重连并再次握手成功（区别于首次 hello） */
  reconnected: [HelloOk]
  /**
   * 服务端下发了一次性的设备令牌。
   *
   * 单独成事件而不是塞在 `hello` 里，是因为调用方**必须**把它持久化下来 ——
   * Hub 只保留哈希，丢了就只能重新配对。给它一个显眼的事件名，避免被忽略。
   */
  deviceToken: [{ token: string }]
  event: [EventFrame]
  /**
   * Hub 主动发来的请求（`req` 帧）。
   *
   * 节点必须处理它 —— 这就是"终端执行服务器下发的指令"的落点。
   * 处理完调用 `respond()` 回填结果；抛错会被自动转成错误响应。
   */
  request: [ReqFrame]
  /**
   * 收到了一个不属于任何待处理请求的协议级响应。
   *
   * 刻意**不叫 `error`**：EventEmitter 对 `error` 事件有特殊语义（无监听者时直接抛异常），
   * 用它来传"迟到的响应"这类非致命信息会让进程莫名其妙崩掉。给一个普通事件名。
   */
  unmatched: [{ id: string; error?: ProtocolErrorShape }]
  close: [{ code: number; reason: string }]
  error: [Error]
  /** 握手被拒。`pairing-required` 时会附带 requestId。 */
  handshakeFailed: [ProtocolErrorShape]
}

export class HubCallError extends Error {
  readonly code: string
  readonly details: Record<string, unknown> | undefined

  constructor(error: ProtocolErrorShape) {
    super(error.message)
    this.name = 'HubCallError'
    this.code = error.code
    this.details = error.details
  }
}

export class HubClient extends EventEmitter<HubClientEvents> {
  readonly identity: IdentityFile
  #options: HubClientOptions
  #socket: WebSocket | undefined
  #hello: HelloOk | undefined
  #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  #connectWaiters: Array<{ resolve: (hello: HelloOk) => void; reject: (error: Error) => void }> = []
  #closedByUs = false
  /**
   * 抑制**下一次** close 触发的自动重连。
   *
   * 必要性：握手被拒（未配对、令牌错等）时我们会主动关闭 socket，
   * 但 `close` 事件是**异步**投递的 —— 如果用一个同步重置的布尔标志来表示
   * "这次关闭是我干的"，事件到达时标志早就被重置了，于是自动重连照常启动，
   * 与调用方自己的重试逻辑打架（两套退避互相叠加）。
   *
   * 更重要的原则：**自动重连是为"传输掉线"设计的，不是为"鉴权被拒"设计的。**
   * 后者需要人来处理，狂重连只会刷屏日志并堆积无用的配对请求。
   */
  #suppressReconnectOnce = false
  #reconnectTimer: NodeJS.Timeout | undefined
  #reconnectAttempts = 0
  #hadHello = false
  #token: string | undefined
  #eventHandlers = new Map<EventName, Array<(payload: unknown) => void>>()
  /** 最近一次收到任何入站帧的时刻 —— 存活性看门狗的判据（见 #startWatchdog） */
  #lastActivityAt = 0
  #watchdogTimer: NodeJS.Timeout | undefined

  constructor(identity: IdentityFile, options: HubClientOptions) {
    super()
    this.identity = identity
    this.#options = options
    this.#token = options.token
  }

  static async create(options: HubClientOptions): Promise<HubClient> {
    const identity = await loadOrCreateIdentity(
      options.identityFile,
      options.role === 'node' ? 'node' : 'device',
      options.displayName,
    )
    return new HubClient(identity, options)
  }

  get hello(): HelloOk | undefined {
    return this.#hello
  }

  get connected(): boolean {
    return this.#hello !== undefined && this.#socket?.readyState === WebSocket.OPEN
  }

  get deviceToken(): string | undefined {
    return this.#token
  }

  /** 建立连接并完成握手。失败时抛出，`pairing-required` 会带 `details.requestId`。 */
  connect(): Promise<HelloOk> {
    this.#closedByUs = false
    return new Promise<HelloOk>((resolve, reject) => {
      this.#connectWaiters.push({ resolve, reject })
      this.#openSocket()
    })
  }

  #openSocket(): void {
    const { url } = this.#options
    const socket = new WebSocket(url, {
      ...(this.#options.headers === undefined ? {} : { headers: this.#options.headers }),
    })
    this.#socket = socket

    socket.on('message', (data) => {
      void this.#onMessage(data.toString())
    })
    socket.on('close', (code, reasonBuf) => {
      const reason = reasonBuf.toString()
      this.#hello = undefined
      this.#stopWatchdog()
      this.emit('close', { code, reason })
      this.#failPendingCalls(new HubCallError({ code: 'internal', message: `connection closed (${code})` }))
      const suppressed = this.#suppressReconnectOnce
      this.#suppressReconnectOnce = false
      if (!this.#closedByUs && !suppressed && this.#options.autoReconnect !== false) {
        this.#scheduleReconnect()
      }
    })
    socket.on('error', (error) => {
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
    })
  }

  #scheduleReconnect(): void {
    this.#reconnectAttempts += 1
    const delayMs = Math.min(500 * 2 ** (this.#reconnectAttempts - 1), 20_000)
    process.stdout.write(`[hub-client] reconnecting in ${delayMs}ms (attempt ${this.#reconnectAttempts})\n`)
    this.#reconnectTimer = setTimeout(() => {
      this.#openSocket()
    }, delayMs)
    this.#reconnectTimer.unref?.()
  }

  /**
   * 存活性看门狗 —— 与 Web 控制台（ui.ts 的 livenessCheck）同款。
   *
   * 为什么必须有：公网反代（nginx 终结 TLS 后转发 wss）拓扑下连接会"半开" ——
   * 实际已断，但两端 TCP 都以为还活着，永远没有 close 事件。节点代理一旦进入
   * 这个状态，Hub 侧看它离线/请求全进虚空，员工全部不可用且**不会自愈**
   * （线上真实事故：云 Hub 经 systemd 重启后，本机节点永远以为自己连着）。
   *
   * 判据：Hub 每 tickIntervalMs 给**所有** ready 连接（含 node 角色）发 tick，
   * 超过 2.5 个间隔没有任何入站帧 → 判定半开。
   *
   * 只在 autoReconnect 开启（常驻连接）时启用：一次性 CLI 调用进程即起即退，
   * 看门狗对它只有干扰没有收益。
   */
  #startWatchdog(): void {
    this.#stopWatchdog()
    if (this.#options.autoReconnect === false) return
    const tickMs = this.#hello?.policy.tickIntervalMs ?? 15_000
    const maxSilence = this.#options.maxSilenceMs ?? Math.round(tickMs * 2.5)
    this.#lastActivityAt = Date.now()
    this.#watchdogTimer = setInterval(
      () => {
        const socket = this.#socket
        if (socket === undefined || this.#hello === undefined) return
        if (Date.now() - this.#lastActivityAt < maxSilence) return
        /* 半开连接上 close() 的关闭握手可能永远等不到对端 —— terminate 直接拆；
           随后的 close 事件会触发既有的重连退避（#scheduleReconnect） */
        process.stdout.write(
          `[hub-client] no inbound frames for ${maxSilence}ms; connection presumed half-open, forcing reconnect\n`,
        )
        socket.terminate()
      },
      Math.min(Math.max(Math.round(maxSilence / 2), 250), 10_000),
    )
    this.#watchdogTimer.unref?.()
  }

  #stopWatchdog(): void {
    if (this.#watchdogTimer !== undefined) clearInterval(this.#watchdogTimer)
    this.#watchdogTimer = undefined
  }

  async #onMessage(raw: string): Promise<void> {
    /* 有字节进来就是活着的证据（哪怕是坏帧）——看门狗只关心"有没有帧" */
    this.#lastActivityAt = Date.now()
    const parsed = parseFrame(raw)
    if (!parsed.ok) {
      this.emit('error', new Error(`malformed frame from hub: ${parsed.error.message}`))
      return
    }
    const frame = parsed.frame

    if (frame.type === 'event') {
      // 握手挑战 → 立刻回 connect
      if (frame.event === 'challenge') {
        await this.#sendConnect(frame.payload as { nonce?: string })
        return
      }
      this.emit('event', frame)
      for (const handler of this.#eventHandlers.get(frame.event) ?? []) {
        handler(frame.payload)
      }
      return
    }

    if (frame.type === 'req') {
      // 服务端下发的请求：交给业务层处理，结果用 respond() 回填
      this.emit('request', frame)
      return
    }

    if (frame.type === 'res') {
      const hello = extractHelloOk(frame)
      if (hello !== undefined) {
        this.#onHello(hello, frame)
        return
      }

      // 顺序很重要：**必须先按 id 找待处理调用**，再看是不是握手失败。
      // 反过来的话，任何 `ok:false` 的普通调用响应都会被当成握手失败吞掉，
      // 调用方只能干等到超时（这个错误曾经真的发生过）。
      const waiter = this.#pending.get(frame.id)
      if (waiter !== undefined) {
        this.#pending.delete(frame.id)
        clearTimeout(waiter.timer)
        if (frame.ok) waiter.resolve(frame.payload)
        else {
          waiter.reject(
            new HubCallError(frame.error ?? { code: 'internal', message: 'unknown error' }),
          )
        }
        return
      }

      if (this.#connectWaiters.length > 0) {
        const error = frame.error ?? {
          code: 'bad-request' as const,
          message: 'hub rejected the connection',
        }
        const waiters = this.#connectWaiters
        this.#connectWaiters = []
        this.emit('handshakeFailed', error)
        const failure = new HubCallError(error)
        for (const pending of waiters) pending.reject(failure)
        // 配对/鉴权被拒是"要人来处理"的结果，不是崩溃：关掉本次连接，
        // 并抑制自动重连 —— 由调用方决定何时、以什么节奏再试。
        this.#suppressReconnectOnce = true
        this.#socket?.close(1000, 'handshake rejected')
        return
      }

      // 既不是待处理调用、也没有握手等待者：可能是超时后才到的迟到响应，仅记录
      this.emit('unmatched', {
        id: frame.id,
        ...(frame.error === undefined ? {} : { error: frame.error }),
      })
      return
    }
  }

  async #sendConnect(challenge: { nonce?: string }): Promise<void> {
    const nonce = challenge.nonce ?? createNonce()
    const signedAt = Date.now()
    const payload = canonicalConnectPayload({
      deviceId: this.identity.deviceId,
      clientId: this.#options.clientId,
      role: this.#options.role,
      scopes: this.#options.scopes,
      nonce,
      signedAt,
      platform: `${process.platform}-${process.arch}`,
    })
    const signature = signConnectPayload(this.identity.privateKeyPem, payload)

    const frame: ReqFrame = {
      type: 'req',
      id: randomUUID(),
      method: 'connect',
      params: {
        protocol: PROTOCOL_VERSION,
        client: {
          id: this.#options.clientId,
          version: '0.1.0',
          platform: `${process.platform}-${process.arch}`,
          mode: this.#options.role,
          ...(this.#options.displayName === undefined
            ? {}
            : { displayName: this.#options.displayName }),
        },
        role: this.#options.role,
        scopes: [...this.#options.scopes],
        device: {
          id: this.identity.deviceId,
          publicKey: this.identity.publicKey,
          signature,
          signedAt,
          nonce,
        },
        ...(this.#token === undefined ? {} : { auth: { token: this.#token } }),
      },
    }
    this.#socket?.send(JSON.stringify(frame))
  }

  #onHello(hello: HelloOk, frame: ResFrame): void {
    void frame
    this.#hello = hello
    this.#reconnectAttempts = 0
    this.#startWatchdog()
    if (hello.auth.deviceToken !== undefined) {
      this.#token = hello.auth.deviceToken
      this.emit('deviceToken', { token: hello.auth.deviceToken })
    }
    const waiters = this.#connectWaiters
    this.#connectWaiters = []
    const event: HelloOk = hello
    if (this.#hadHello) this.emit('reconnected', event)
    else this.emit('hello', event)
    this.#hadHello = true
    for (const waiter of waiters) waiter.resolve(event)
  }

  /** 发一次 RPC。有副作用的方法建议传 `idempotencyKey`。 */
  async call<T = unknown>(
    method: string,
    params: unknown = {},
    options: { idempotencyKey?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    if (!this.connected) {
      throw new HubCallError({ code: 'unauthenticated', message: 'not connected to the hub' })
    }
    const id = randomUUID()
    const timeoutMs = options.timeoutMs ?? this.#options.timeoutMs ?? 30_000

    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(
          new HubCallError({
            code: 'internal',
            message: `hub did not answer "${method}" within ${timeoutMs}ms`,
          }),
        )
      }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, { resolve, reject, timer })
    })

    const frame: ReqFrame = {
      type: 'req',
      id,
      method,
      params,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    }
    this.#socket?.send(JSON.stringify(frame))
    return (await promise) as T
  }

  /** 回填一个 Hub 下发的请求。 */
  respond(id: string, result: { ok: true; payload?: unknown } | { ok: false; error: ProtocolErrorShape }): void {
    const frame: ResFrame =
      result.ok === true
        ? { type: 'res', id, ok: true, payload: result.payload }
        : { type: 'res', id, ok: false, error: result.error }
    this.#socket?.send(JSON.stringify(frame))
  }

  /** 注册一个事件处理器。返回取消注册的函数。 */
  onEvent(event: EventName, handler: (payload: unknown) => void): () => void {
    const list = this.#eventHandlers.get(event) ?? []
    list.push(handler)
    this.#eventHandlers.set(event, list)
    return () => {
      const current = this.#eventHandlers.get(event) ?? []
      const index = current.indexOf(handler)
      if (index >= 0) current.splice(index, 1)
    }
  }

  close(): void {
    this.#closedByUs = true
    this.#stopWatchdog()
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer)
    this.#failPendingCalls(new HubCallError({ code: 'internal', message: 'client closed' }))
    this.#socket?.close(1000, 'client closing')
    this.#socket = undefined
  }

  #failPendingCalls(error: Error): void {
    for (const [, waiter] of this.#pending) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.#pending.clear()
  }
}

/** 从 `res` 帧里认出 `hello-ok`。 */
function extractHelloOk(frame: ResFrame): HelloOk | undefined {
  if (!frame.ok) return undefined
  const payload = frame.payload as { type?: string } | undefined
  if (payload === undefined || payload.type !== 'hello-ok') return undefined
  return payload as unknown as HelloOk
}
