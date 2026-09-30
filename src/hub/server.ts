/**
 * Hub 服务端 —— 单端口同时承载 HTTP（控制台）与 WebSocket（控制面）。
 *
 * 职责边界（刻意收得很紧）：
 *   · 本文件只管**传输、握手、鉴权、派发**；具体业务在 `handlers.ts`。
 *   · 它不认识 dsh，也不碰任何工作区文件 —— 那些都在终端节点上发生。
 *
 * 鉴权链（任一环失败即拒绝，且失败原因不泄露给未认证方）：
 *   1. 连接建立 → 服务端下发一次性 `challenge` nonce
 *   2. 客户端回 `connect`，带 Ed25519 签名（覆盖 deviceId/role/scopes/nonce/signedAt/platform）
 *   3. 服务端校验：协议版本 → 公钥指纹与 deviceId 自洽 → nonce 未用过 → 时钟偏移 →
 *      签名有效 → 令牌（若有）有效 → 得到生效 role/scopes
 *   4. 之后每个方法再逐条查 `METHODS` 表做 scope 校验
 */

import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Duplex } from 'node:stream'

import { WebSocketServer, type WebSocket } from 'ws'

import {
  DEFAULT_CLOCK_SKEW_MS,
  DEFAULT_TICK_INTERVAL_MS,
  EVENT_NAMES,
  MAX_FRAME_BYTES,
  NonceLedger,
  PROTOCOL_VERSION,
  canonicalConnectPayload,
  connectParamsSchema,
  createNonce,
  encodeFrame,
  fingerprintEquals,
  fingerprintOf,
  isMethodName,
  isProtocolError,
  makeEvent,
  makeResError,
  makeResOk,
  methodSpec,
  methodsVisibleTo,
  normalizeScopes,
  parseFrame,
  protocolError,
  scopeSatisfies,
  verifyConnectPayload,
  scopesExceeding,
  type ConnectParams,
  type ErrorCode,
  type EventName,
  type Frame,
  type ProtocolErrorShape,
  type ReqFrame,
  type ResFrame,
  type Role,
  type Scope,
} from '../protocol/index.ts'
import { HubStore, type HubState } from './store.ts'
import type { PairedDevice } from './types.ts'
import { currentCodeFingerprint, packageRoot } from '../protocol/build.ts'
import { flushMailbox } from './mailbox.ts'
import { startScheduler } from './scheduler.ts'
import { loadOrCreateVapidKeys, sendToAll, type VapidKeys } from './push.ts'
import { readJsonFile, removeFile, writeJsonFile } from '../util/fsx.ts'
import {
  approvePairing,
  canAutoApprove,
  claimToken,
  createPairingRequest,
  findByToken,
  pairingWindowOpen,
  applyPairingWindow,
  touchDevice,
} from './devices.ts'
import { hubHandlers } from './handlers.ts'
import { controlUiScriptUrl, controlUiVersion, renderControlUi, renderControlUiScript } from '../web/ui.ts'
import { PWA_ICONS, renderPwaServiceWorker, renderWebManifest } from '../web/pwa.ts'
import { startHubLocalControl, type LocalControlServer } from './local-control.ts'
import type { IdempotencyRecord } from './types.ts'

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const IDEMPOTENCY_MAX_RECORDS = 10_000
const IDEMPOTENCY_MAX_BYTES = 64 * 1024 * 1024

type HubHandler = (hub: Hub, conn: Connection, params: unknown) => Promise<unknown>

export interface HubOptions {
  home?: string
  port?: number
  host?: string
  name?: string
  verbose?: boolean
  /**
   * 显式确认"我知道这次绑定会暴露到网络，且传输是明文"。
   *
   * 默认 bind 是回环，此时不需要它。一旦 `host` 非回环就必须打开它 ——
   * 否则 Hub **拒绝启动**。
   *
   * 为什么要有这道闸：本方案的认证是"挑战 nonce 签名 + 设备令牌"，
   * **它保护的是身份，不保护传输**。绑到局域网而不加 TLS 意味着
   * 设备令牌、会话内容、员工输出全都以明文经过网络。
   * 静默允许这样启动，等于把"我以为它是安全的"变成默认预期。
   * （对齐 OpenClaw 的做法：非 loopback 绑定且无认证会被直接拒绝。）
   */
  allowNonLoopbackBind?: boolean
  /**
   * 信任反向代理的客户端 IP 头（X-Real-IP / X-Forwarded-For）。
   *
   * 威胁模型：**只在"Hub 前面确实有部署方自己控制的反代"时开启**
   * （如 nginx 终止 TLS 后 proxy_pass 到回环，且反代会覆盖而不是透传这些头）。
   * 直连公网时开启等于把 `fromLoopback` 判定（节点配对的自动批准闸）
   * 交给客户端伪造 —— 任何人写一个 `X-Real-IP: 127.0.0.1` 就能冒充本机。
   *
   * 默认关闭：关闭时这些头一律不信（直连部署下它们是纯伪造面）。
   * 命令行选项，仅本次运行生效、不落盘（与 port/host 的覆盖语义一致）。
   */
  trustProxy?: boolean
  /**
   * tick / ping 清扫的间隔。默认 15s（DEFAULT_TICK_INTERVAL_MS）。
   * 测试里要快速验证僵尸清理时可调小；生产不需要动。
   */
  tickIntervalMs?: number
}

/** 一条已建立的 WS 连接。 */
export class Connection {
  readonly id = randomUUID()
  readonly socket: WebSocket
  readonly remoteIp: string
  readonly connectedAtMs = Date.now()

  phase: 'awaiting-connect' | 'ready' = 'awaiting-connect'
  deviceId = ''
  role: Role = 'operator'
  scopes: Scope[] = []
  clientId = ''
  platform = ''
  displayName: string | undefined
  /**
   * 该连接被绑定的员工 id（设备台账里的 boundEmployeeId，握手时带过来）。
   *
   * 跨员工调用的 `from` **从这里派生**，不听请求里的自报值 —— 否则员工之间
   * 可以互相冒名派活（见 resolveInvokePrincipal 的说明）。
   */
  boundEmployeeId: string | undefined
  /** 该连接代表的终端节点 id（role=node 时） */
  nodeId: string | undefined
  /** 已订阅的会话 id */
  readonly subscriptions = new Set<string>()

  /** 握手用的 nonce（一次性） */
  challengeNonce = ''

  /** 最近一次**入站**活动的时刻（消息帧或 pong）——nodeConnection 的 tie-break 依据 */
  lastActivityAt = Date.now()
  /**
   * 连续未回 pong 的次数。ping/pong 探的是传输层活性（"TCP 通路活着"），
   * 与应用层 tick（"对端逻辑活着"，客户端看门狗据此自愈）是**两层**：
   * 半开连接收不到 tick 但也回不了 pong —— 只有这层能把僵尸连接从
   * 连接表里清出去，否则它会被 nodeConnection() 永远选中、吃掉所有转发请求。
   */
  missedPongs = 0

  /** 承载 `connect` 请求的帧 id —— 完成握手时要原样回带 */
  lastConnectId = 'connect'

  /** 由服务端主动发起的请求的等待者：id → resolver */
  readonly pendingOutbound = new Map<string, (res: ResFrame) => void>()

  constructor(socket: WebSocket, remoteIp: string) {
    this.socket = socket
    this.remoteIp = remoteIp
  }

  get label(): string {
    if (this.displayName !== undefined) return this.displayName
    if (this.nodeId !== undefined) return this.nodeId
    return `${this.clientId || 'unknown'}@${this.remoteIp}`
  }

  send(frame: Frame): void {
    if (this.socket.readyState !== this.socket.OPEN) return
    this.socket.send(encodeFrame(frame))
  }

  sendEvent(event: EventName, payload: unknown, seq?: number): void {
    this.send(makeEvent(event, payload, seq))
  }

  hasScope(scope: Scope): boolean {
    return this.scopes.includes(scope)
  }
}

export interface HubAddress {
  host: string
  port: number
  url: string
  wsUrl: string
}

export class Hub {
  readonly store: HubStore
  readonly options: HubOptions
  readonly verbose: boolean
  #http: HttpServer | undefined
  #wss: WebSocketServer | undefined
  #connections = new Set<Connection>()
  #nonces = new NonceLedger()
  #tickTimer: NodeJS.Timeout | undefined
  /** 定时任务调度循环的停止函数（stop 时调用） */
  #stopScheduler: (() => void) | undefined
  #eventSeq = 0
  #address: HubAddress | undefined
  /** 状态目录独占锁文件；持有期间不允许第二个 Hub 用同一状态目录启动 */
  #lockFile: string | undefined
  #localControl: LocalControlServer | undefined
  #idempotencyInFlight = new Map<string, { method: string; paramsHash: string; promise: Promise<ResFrame> }>()
  /** 配对码防爆破计数（按来源 IP）。见 `noteRedeemFailure` 的取舍说明。 */
  readonly #redeemFailures = new Map<string, { count: number; blockedUntilMs: number }>()

  constructor(options: HubOptions = {}) {
    this.options = options
    this.verbose = options.verbose ?? false
    this.store = new HubStore(options.home)
    /* 启动时就把本进程的代码指纹算出来（函数内部带缓存）。**必须在这里算**：
       `currentCodeFingerprint()` 读的是磁盘上的源码 —— 若等第一次用到时才懒算，
       而那之前恰好发生"只更新文件、没重启进程"的部署，Hub 就会拿**磁盘上的新代码**
       去和节点比对，于是"Hub 自己旧了"会被误报成"节点旧了"，方向刚好搞反。
       在这里算，得到的是"本进程真正加载的那份代码"。 */
    currentCodeFingerprint()
  }

  state(): HubState {
    return this.store.state()
  }

  get connections(): Iterable<Connection> {
    return this.#connections
  }

  get address(): HubAddress {
    if (this.#address === undefined) throw new Error('hub is not listening yet')
    return this.#address
  }

  /* ────────────────────────── 生命周期 ────────────────────────── */

  /**
   * 拒绝"无意中把控制面暴露到网络"的启动。
   *
   * 见 `HubOptions.allowNonLoopbackBind` 的长注释：认证保护身份、不保护传输。
   */
  #assertBindIsDeliberate(host: string): void {
    if (isLoopback(host) || host === 'localhost') return
    if (this.options.allowNonLoopbackBind === true) {
      this.log(
        `WARNING: binding to ${host} with no TLS — device tokens, session content and ` +
          `employee output will travel in cleartext. Put a TLS-terminating reverse proxy ` +
          `(or a WireGuard/Tailscale tunnel) in front of this port.`,
      )
      return
    }
    throw new Error(
      [
        `refusing to bind ${host}: this hub authenticates callers but does not encrypt transport,`,
        `so exposure beyond loopback would put device tokens and session content on the wire in cleartext.`,
        ``,
        `Choose one:`,
        `  · keep the default loopback bind and reach it through an SSH/WireGuard/Tailscale tunnel, or`,
        `  · terminate TLS in a reverse proxy in front of this port, or`,
        `  · pass --allow-non-loopback to accept the risk deliberately.`,
      ].join('\n'),
    )
  }

  /**
   * 状态目录独占锁。
   *
   * 为什么必须要有：两个 Hub 进程指向同一个状态目录、只是端口不同时，
   * TCP 绑定不会冲突，于是两个进程会**同时读写同一批 JSON 文件**。
   * 原子写能防止文件写坏，却挡不住"读—改—写"互相覆盖（比如两台各自批准了不同的设备，
   * 后写的一方把前者的批准抹掉）。这类丢状态极难排查。
   *
   * 陈旧锁的处理：读出的 pid 若已不存在，就认为锁是陈旧的并接管 ——
   * 否则一次崩溃会让 Hub 永远起不来。
   */
  async #acquireStateLock(): Promise<void> {
    const lockFile = this.store.files.lock
    const existing = await readJsonFile<{ pid?: number; startedAtMs?: number } | undefined>(
      lockFile,
      undefined,
    )

    if (existing?.pid !== undefined && isProcessAlive(existing.pid)) {
      throw new Error(
        `another hub appears to be running on this state directory (pid ${existing.pid}). ` +
          `Two hubs sharing one state directory would overwrite each other's device and employee records. ` +
          `Stop it first, or point this one at a different --home.`,
      )
    }

    await writeJsonFile(lockFile, { pid: process.pid, startedAtMs: Date.now() })
    this.#lockFile = lockFile
  }

  async #releaseStateLock(): Promise<void> {
    const lockFile = this.#lockFile
    if (lockFile === undefined) return
    this.#lockFile = undefined
    // 只在锁仍属于自己时删除，避免把后来者的锁误删
    const current = await readJsonFile<{ pid?: number } | undefined>(lockFile, undefined)
    if (current?.pid === process.pid) await removeFile(lockFile)
  }

  async start(): Promise<HubAddress> {
    const state = await this.store.load(this.options)

    this.#assertBindIsDeliberate(state.config.host)
    await this.#acquireStateLock()

    const http = createServer((req, res) => {
      /* 之所以是 async：闸门在窗口关着时要先 `refreshDevices()` —— 别人在服务器上
         执行 `dse token revoke` 之后，**这一次请求**就得按吊销算（否则"吊销即失效"
         在页面这条路上是打折的）。异常必须在这里收口：async 回调里的拒绝没人接
         就是进程级未捕获异常。 */
      void this.#handleHttp(req, res).catch((error: unknown) => {
        this.log(`http handler failed: ${String(error)}`)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        if (!res.writableEnded) res.end('internal error\n')
      })
    })
    this.#http = http

    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
    this.#wss = wss

    http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://placeholder')
      if (url.pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket as Duplex, head, (ws) => {
        this.#onConnection(ws, req)
      })
    })

    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(state.config.port, state.config.host, () => {
        http.off('error', reject)
        resolve()
      })
    })

    const addr = http.address()
    const port = typeof addr === 'object' && addr !== null ? addr.port : state.config.port
    const host = state.config.host
    const shownHost = host === '0.0.0.0' ? '127.0.0.1' : host
    this.#address = {
      host,
      port,
      url: `http://${shownHost}:${port}/`,
      wsUrl: `ws://${shownHost}:${port}/ws`,
    }

    try {
      this.#localControl = await startHubLocalControl(this.store.root, (method, params) =>
        this.#handleLocalControl(method, params),
      )
    } catch (error) {
      await this.stop()
      throw new Error(`failed to start Hub local control channel: ${error instanceof Error ? error.message : String(error)}`)
    }

    const tickMs = this.options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
    this.#tickTimer = setInterval(() => {
      const payload = { ts: Date.now() }
      for (const conn of this.#connections) {
        /* 传输层活性：ping 所有连接（含握手未完成），两次未 pong 即 terminate。
           别等 close 握手 —— 僵尸连接的定义就是它永远不会回答。 */
        conn.missedPongs += 1
        if (conn.missedPongs >= 2) {
          this.log(`connection ${conn.id} (${conn.label}) missed 2 pongs; terminating zombie`)
          conn.socket.terminate()
          continue
        }
        conn.socket.ping()
        /* 应用层活性：tick 只发 ready 连接（客户端看门狗的判据） */
        if (conn.phase === 'ready') conn.sendEvent('tick', payload)
      }
    }, tickMs)
    this.#tickTimer.unref?.()

    /* 定时任务：Hub 一直醒着，所以"每隔 N 分钟叫某个员工一次"记在这里（见 scheduler.ts）。
       启动时会把错过的时间点一次推平（跳过，不补跑）。 */
    this.#stopScheduler = startScheduler(this)

    this.log(
      `hub "${state.config.name}" listening on ${host}:${port} (device ${state.identity.deviceId.slice(0, 12)}…)`,
    )
    return this.#address
  }

  async stop(): Promise<void> {
    const localControl = this.#localControl
    this.#localControl = undefined
    if (localControl !== undefined) {
      await localControl.close().catch((error) => this.log(`local control shutdown failed: ${String(error)}`))
    }
    if (this.#tickTimer !== undefined) clearInterval(this.#tickTimer)
    if (this.#stopScheduler !== undefined) {
      this.#stopScheduler()
      this.#stopScheduler = undefined
    }
    for (const conn of this.#connections) {
      try {
        conn.sendEvent('shutdown', { ts: Date.now() })
        conn.socket.close(1001, 'hub shutting down')
      } catch {
        /* 关闭失败不影响退出 */
      }
    }
    await new Promise<void>((resolve) => {
      const wss = this.#wss
      if (wss === undefined) return resolve()
      wss.close(() => resolve())
    })
    await new Promise<void>((resolve) => {
      const http = this.#http
      if (http === undefined) return resolve()
      http.close(() => resolve())
      http.closeAllConnections?.()
    })
    this.#connections.clear()
    await this.#releaseStateLock()
  }

  /**
   * 这个 Hub 是从哪个提交部署的（`<state>/deployed-commit.txt`，部署脚本写）。
   *
   * 为什么需要：升级按钮要把节点升到"和 Hub 同一个版本"，而 Hub 只知道自己的
   * **代码指纹**（指纹不是 git 引用，节点没法拿它去 fetch）。部署时顺手写下提交，
   * 按钮就有确切目标；没写就返回空串，调用方**如实拒绝**而不是猜一个。
   */
  async readDeployedCommit(): Promise<string> {
    try {
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(this.store.files.deployedCommit, 'utf8')
      return raw.trim().split('\n')[0]?.trim() ?? ''
    } catch {
      return ''
    }
  }

  /**
   * VAPID 密钥（手机通知用）：首次调用时生成并落盘，之后固定不变。
   *
   * 惰性生成是刻意的：不用推送的部署不该被塞一对密钥；而一旦生成就必须**持久**
   * —— 换密钥会让所有已存在的订阅被推送服务拒掉，症状同样是"静默收不到"。
   */
  async vapidKeys(): Promise<VapidKeys | undefined> {
    return await loadOrCreateVapidKeys({ stateDir: this.store.root })
  }

  log(message: string): void {
    process.stdout.write(`[hub] ${message}\n`)
  }

  debug(message: string): void {
    if (this.verbose) process.stdout.write(`[hub:debug] ${message}\n`)
  }

  /* ────────────────────────── HTTP ────────────────────────── */

  /**
   * 「允许新设备注册」现在开着吗（判断逻辑在 devices.ts，与命令行的 `dse pairing` 同源）。
   */
  pairingWindowOpen(now = Date.now()): boolean {
    return pairingWindowOpen(this.store.state().config, now)
  }

  /** 开/关注册窗口并落盘；返回写入后的状态（`untilMs` 缺省 = 一直开着）。 */
  async setPairingWindow(options: { openMinutes?: number; close?: boolean }): Promise<{
    open: boolean
    untilMs?: number
  }> {
    const result = applyPairingWindow(this.store.state().config, options)
    await this.store.saveConfig()
    return result
  }

  async #handleLocalControl(method: string, params: unknown): Promise<unknown> {
    const status = () => {
      const config = this.store.state().config
      const until = config.pairingWindowUntilMs
      const open = this.pairingWindowOpen()
      return {
        open,
        ...(open && typeof until === 'number'
          ? { untilMs: until, remainingSec: Math.round((until - Date.now()) / 1000) }
          : {}),
        pairedCount: Object.keys(this.store.state().paired).length,
        mode: config.pairingMode === 'closed' ? 'closed' : 'open',
      }
    }
    if (method === 'pairing.window') return status()
    if (method !== 'pairing.window.set') throw new Error(`unsupported local control method: ${method}`)
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      throw new Error('pairing.window.set params must be an object')
    }
    const input = params as { open?: unknown; minutes?: unknown }
    if (typeof input.open !== 'boolean') throw new Error('pairing.window.set requires boolean open')
    if (input.minutes !== undefined &&
      (typeof input.minutes !== 'number' || !Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 120)) {
      throw new Error('pairing.window.set minutes must be an integer from 1 to 120')
    }
    const result = await this.setPairingWindow(
      input.open
        ? { ...(input.minutes === undefined ? {} : { openMinutes: input.minutes }) }
        : { close: true },
    )
    this.log(input.open ? 'pairing window opened via local CLI' : 'pairing window closed via local CLI')
    this.broadcastToScope('device.pair', 'pair.requested', { windowOpen: result.open, untilMs: result.untilMs ?? null })
    return status()
  }

  /**
   * 本机 IPC 只开放配对窗口读写，不是一个绕过 scope 的通用 RPC。
   * CLI 与 WS handler 都走同一个 setPairingWindow 内存状态更新，避免双进程改 JSON 后内存分叉。
   */

  /**
   * 这个请求带的是不是**本机已配对设备的凭据**（配对时发的 `dse_device` cookie）。
   *
   * 为什么要 cookie：控制台页面 / 脚本 / 图标都是未认证的 HTTP 请求（浏览器不会在
   * 顶层导航上带设备令牌），而闸门又必须放行"我自己这台已配对的浏览器"。
   * 令牌是同一个令牌（只是换了个携带方式），校验走 `findByToken`：**吊销即失效**。
   */
  #deviceCookie(req: IncomingMessage): PairedDevice | undefined {
    const token = readCookie(req.headers.cookie, DEVICE_COOKIE)
    if (token === '') return undefined
    return findByToken(this.store, token)
  }

  /**
   * 未认证的 HTTP 访问：注册窗口关着就**装作这里什么都没有**。
   *
   * 为什么要"装作没有"而不是回 401/403：401/403 等于告诉扫描器"这里有一套需要
   * 认证的服务"，接下来它就只差一个 6 位码了（审计的结论）。404 让它无从下手。
   *
   * 与 nginx 的 404 保持**逐字节一致**（同一份 body 与响应头）—— 否则响应差异本身
   * 就是指纹（"门关着"和"这里什么都没有"能被区分开）。
   *
   * 放行三类：窗口开着、带 `dse_device` cookie（自己这台已配对的浏览器）、
   * `POST /session`（换 cookie 的那一步，见 `#handleSession`）。
   *
   * 注意 `/ws` 升级不受影响（见 `http.on('upgrade')`）：已配对的设备照常连、照常干活；
   * 未配对的连接会在握手时被要求配对（而那时窗口已被本闸门挡住页面，拿不到码）。
   */
  #maybeHideFromStrangers(req: IncomingMessage, res: import('node:http').ServerResponse): boolean {
    if (this.pairingWindowOpen()) return false
    if (this.#deviceCookie(req) !== undefined) return false
    res.writeHead(404, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(NGINX_STYLE_404)
    return true
  }

  /**
   * `POST /session`：用设备令牌换一个 `dse_device` cookie。
   *
   * 这一步**不受窗口影响**（否则"窗口关着 + cookie 失效"就永久失联了）：
   * 令牌对且设备未被吊销 ⇒ 200 + Set-Cookie；否则回**与 nginx 逐字节一致的 404**
   * （连"令牌错"这件事都不告诉陌生人；而能问出区别的人手里已经有有效令牌了）。
   *
   * 控制台每次连上都会来调一次，所以"配对时窗口是开的"这件事
   * 会留下一份能长期用的凭据。`DELETE` = 清掉它（「清除本地令牌」按钮）。
   */
  #handleSession(req: IncomingMessage, res: import('node:http').ServerResponse): void {
    if (req.method === 'DELETE') {
      /* 「清除本地令牌」时一起把这个 cookie 抹掉：否则界面上说"已清除"，
         浏览器却还揣着一把能打开控制台的钥匙 —— 说法和行为不一致就是坑。 */
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': `${DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      })
      res.end('{"ok":true}')
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST, DELETE' })
      res.end('method not allowed\n')
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > SESSION_MAX_BYTES) {
        aborted = true
        /* 不 destroy：直接把结论写回去，免得客户端看到的是"连接被重置"这种噪声 */
        req.pause()
        this.#denySession(res)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      const token = readTokenFromBody(Buffer.concat(chunks).toString('utf8'))
      if (token === '' || findByToken(this.store, token) === undefined) {
        this.#denySession(res)
        return
      }
      const secure = forwardedProtoIsHttps(req)
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie':
          `${DEVICE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_COOKIE_MAX_AGE_SEC}` +
          (secure ? '; Secure' : ''),
      })
      res.end('{"ok":true}')
    })
    req.on('error', () => {
      if (!res.writableEnded) this.#denySession(res)
    })
  }

  #denySession(res: import('node:http').ServerResponse): void {
    res.writeHead(404, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(NGINX_STYLE_404)
  }

  async #handleHttp(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://placeholder')

    /* 换 cookie 的入口：必须在闸门**之前**（它是窗口关着时唯一的自救路径），
       但它自己按令牌校验，没令牌的回的还是那个一模一样的 404。 */
    if (url.pathname === '/session') {
      this.#handleSession(req, res)
      return
    }

    /* 窗口关着 = 门要用到设备台账 ⇒ 先从磁盘对一次账（CLI 的吊销/批准要立刻算数）。
       开着的时候不必付这个代价：那时候谁都能进来，台账只用在校验 cookie 上。 */
    if (!this.pairingWindowOpen()) await this.store.refreshDevices()

    /* 其余所有 HTTP 路由：窗口关着且没带本机设备凭据 ⇒ 对陌生人 404。
       healthz 也一起挡（它虽然只回存活状态，但"这里活着"本身就是线索）。 */
    if (this.#maybeHideFromStrangers(req, res)) return

    if (url.pathname === '/healthz') {
      // 刻意**只回存活状态**：这是未认证端点，任何能连上端口的人都能访问。
      // hubId、节点数、员工数都属于拓扑信息，不该在握手之前泄露出去 ——
      // 需要这些信息的调用方用 `health` RPC（已认证，且返回得更详细）。
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }

    if (url.pathname === '/ui.js') {
      // 控制台脚本从同源路径提供，而不是内联进 HTML ——
      // 这样 CSP 可以保持 `script-src 'self'`，不必开 'unsafe-inline'。
      // 查询串（?v=内容指纹）只用于缓存失效，路由匹配刻意忽略它。
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        // 交付版本随响应暴露：curl 一眼就能看出服务器在发哪一版脚本，
        // 和页面上印的、连接时上报的指纹是同一个值。
        'x-dse-ui-version': controlUiVersion(),
      })
      res.end(renderControlUiScript())
      return
    }

    if (url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, {
        'content-type': 'application/manifest+json; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      })
      res.end(renderWebManifest({ hubName: this.store.state().config.name }))
      return
    }

    if (url.pathname.startsWith('/assets/')) {
      /* 页面素材（立绘帧图等）：从仓库里的 src/web/assets/ 提供。
       *
       * 为什么单独一条路由而不是塞进脚本：图是二进制，塞进 JS 只能 base64 ——
       * 体积涨 1/3、还要过一次 WebSocket/RPC。这里直接走 HTTP，能进浏览器缓存与 SW 预缓存。
       * 为什么不用 base64 常量（像图标那样）：图标是几 KB 的代码生成物，立绘是几十上百 KB 的图。
       *
       * 安全：只允许 assets 目录**内**的文件。这里不用"字符串前缀比较"——
       * 那是被 ../ 与符号链接绕过的经典写法；用 resolve + 前缀校验，并拒绝任何 .. 段。 */
      /* ⚠️ decodeURIComponent 会为**畸形转义**抛异常（`/assets/%`、`/assets/%zz`）。
         这个抛出点在一次未认证的 HTTP 请求里面 —— 没有 try/catch 就等于把进程交给
         陌生人：审计用组合证据指出这条路径可达（本地抛异常 + 实测 nginx 会转发畸形转义），
         只是当时没真去打挂服务。**畸形请求不是异常，是 400。** */
      let rel = ''
      try {
        rel = decodeURIComponent(url.pathname.slice('/assets/'.length))
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('bad request')
        return
      }
      const assetsRoot = path.resolve(packageRoot(), 'src', 'web', 'assets')
      const target = path.resolve(assetsRoot, rel)
      const inside = target === assetsRoot || target.startsWith(assetsRoot + path.sep)
      const suspicious = rel.split('/').some((seg) => seg === '..' || seg === '')
      if (!inside || suspicious || !existsSync(target) || !statSync(target).isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      const ext = path.extname(target).toLowerCase()
      const types: Record<string, string> = {
        '.webp': 'image/webp',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.gif': 'image/gif',
      }
      const contentType = types[ext]
      if (contentType === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      /* 素材名固定、靠查询串（?v=界面指纹）失效 ⇒ 可以长缓存。
         不这么写的话，换了立绘但文件名没变时，浏览器会一直用旧的 —— 又是"看起来生效了"。 */
      res.writeHead(200, {
        'content-type': contentType,
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      })
      res.end(readFileSync(target))
      return
    }

    if (url.pathname === '/sw.js') {
      // service worker 必须从根路径提供（作用域 = 所在路径），
      // 且每次都要回源校验更新，所以用 no-cache。
      //
      // 缓存名与 precache 列表都由控制台脚本的内容指纹派生（controlUiVersion）：
      // **脚本一改，sw.js 的字节就跟着变** ⇒ 浏览器判定 SW 需要更新 ⇒ 旧缓存被清、
      // 新 SW 立刻接管。这是"客户端 JS 被缓存冻住却毫无报错"那类故障的结构性解法，
      // 千万别把这里改回写死的版本号。
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      })
      res.end(
        renderPwaServiceWorker({
          version: controlUiVersion(),
          scriptUrl: controlUiScriptUrl(),
        }),
      )
      return
    }

    const iconBase64 = PWA_ICONS[url.pathname]
    if (iconBase64 !== undefined) {
      // 图标内容固定（内嵌常量），可以长缓存；换图标时改文件名即可。
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
      })
      res.end(Buffer.from(iconBase64, 'base64'))
      return
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = renderControlUi({
        hubId: this.store.state().config.hubId,
        hubName: this.store.state().config.name,
        // 带内容指纹的地址；renderControlUi 里也会兜底补上，双保险
        scriptUrl: controlUiScriptUrl(),
      })
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // 控制台只允许同源脚本；脚本走 /ui.js，因此策略可以保持很紧。
        // manifest-src / worker-src 是 PWA 壳（manifest + service worker）需要的两项。
        'content-security-policy':
          "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      res.end(html)
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found\n')
  }

  /* ────────────────────────── 连接与握手 ────────────────────────── */

  #onConnection(ws: WebSocket, req: IncomingMessage): void {
    const remoteIp = clientIp(req, this.options.trustProxy === true)
    const conn = new Connection(ws, remoteIp)
    this.#connections.add(conn)
    this.debug(`connection ${conn.id} from ${remoteIp}`)

    ws.on('pong', () => {
      /* pong = 传输层活着的证据（见 Connection.missedPongs 的注释） */
      conn.missedPongs = 0
      conn.lastActivityAt = Date.now()
    })
    ws.on('message', (data) => {
      void this.#onMessage(conn, data.toString())
    })
    ws.on('close', (code, reason) => {
      this.#connections.delete(conn)
      this.debug(`connection ${conn.id} closed`)
      // 帧超上限（1009）等异常关闭要留痕：节点被自己的大输出掐线时，
      // 没有这行日志就只剩"节点老在闪断"的表象（docs/04 的 22MB 会话事故）
      if (code !== 1000 && code !== 1001) {
        this.log(
          `connection closed abnormally: code=${code} reason=${reason.toString().slice(0, 200)}` +
            ` role=${conn.role ?? 'unknown'} node=${conn.nodeId ?? '-'} device=${conn.deviceId ?? '-'}` +
            (code === 1009 ? '（帧超过 MAX_FRAME_BYTES：检查节点侧输出体积管理）' : ''),
        )
      }
      this.#onDisconnect(conn)
    })
    ws.on('error', (error) => {
      this.debug(`connection ${conn.id} error: ${String(error)}`)
    })

    // 服务端先发挑战。客户端在收到它之前不应发送任何业务帧。
    conn.challengeNonce = createNonce()
    conn.sendEvent('challenge', {
      nonce: conn.challengeNonce,
      ts: Date.now(),
      hubId: this.store.state().config.hubId,
      protocol: PROTOCOL_VERSION,
    })
  }

  async #onMessage(conn: Connection, raw: string): Promise<void> {
    conn.lastActivityAt = Date.now()
    const parsed = parseFrame(raw)
    if (!parsed.ok) {
      if (conn.phase === 'ready') {
        conn.send(makeResError('unknown', parsed.error))
      } else {
        this.#closeWith(conn, parsed.error.code, parsed.error.message)
      }
      return
    }

    if (parsed.frame.type === 'res') {
      const waiter = conn.pendingOutbound.get(parsed.frame.id)
      if (waiter !== undefined) {
        conn.pendingOutbound.delete(parsed.frame.id)
        waiter(parsed.frame)
      }
      return
    }

    if (parsed.frame.type !== 'req') {
      // 客户端不应向服务端发事件
      conn.send(makeResError('unknown', protocolError('bad-request', 'clients may not send events')))
      return
    }

    const frame = parsed.frame as ReqFrame

    if (conn.phase === 'awaiting-connect') {
      // 配对码兑换是握手前唯一放行的业务方法：它是 bootstrap 通道，
      // 安全性论证见 methods.ts 里 `device.pair.redeem` 的条目注释。
      // 其余方法一律要求先 connect。
      if (frame.method === 'device.pair.redeem') {
        await this.#handlePairRedeem(conn, frame)
        return
      }
      if (frame.method !== 'connect') {
        this.#closeWith(conn, 'unauthenticated', 'the first request must be "connect"')
        return
      }
      await this.#handleConnect(conn, frame)
      return
    }

    const response = await this.dispatch(conn, frame)
    conn.send(response)
  }

  async #handleConnect(conn: Connection, frame: ReqFrame): Promise<void> {
    conn.lastConnectId = frame.id

    // 设备台账可能被本机的 `dse pair approve` 改过 —— 那是独立的进程。
    // 不重新读盘的话，用户批准完之后设备重连依然会被判为未配对。
    await this.store.refreshDevices()

    const parsed = connectParamsSchema.safeParse(frame.params)
    if (!parsed.success) {
      this.#closeWith(conn, 'bad-request', 'connect params failed schema validation', {
        issues: parsed.error.issues,
      })
      return
    }
    const params: ConnectParams = parsed.data

    if (params.protocol !== PROTOCOL_VERSION) {
      this.#closeWith(
        conn,
        'bad-request',
        `unsupported protocol ${params.protocol}; this hub speaks ${PROTOCOL_VERSION}`,
      )
      return
    }

    const failure = this.#verifyDevice(params)
    if (failure !== undefined) {
      this.#closeWith(conn, failure.code, failure.message, failure.details)
      return
    }

    // nonce 一次性：必须在签名校验通过之后才消费它吗？
    // 不 —— 必须在**校验签名之前**就尝试占用，否则攻击者可以拿同一个 nonce
    // 反复试签名。这里先占有，失败就作废该 nonce（代价只是客户端要重连）。
    if (!this.#nonces.claim(params.device.nonce)) {
      this.#closeWith(conn, 'challenge-invalid', 'nonce was already used or expired')
      return
    }

    const payload = canonicalConnectPayload({
      deviceId: params.device.id,
      clientId: params.client.id,
      role: params.role,
      scopes: params.scopes,
      nonce: params.device.nonce,
      signedAt: params.device.signedAt,
      platform: params.client.platform,
    })
    if (!verifyConnectPayload(params.device.publicKey, payload, params.device.signature)) {
      this.#closeWith(conn, 'device-signature-invalid', 'device signature verification failed')
      return
    }

    const state = this.store.state()
    const paired = state.paired[params.device.id]

    // 未配对 → 走配对流程
    if (paired === undefined) {
      const { request, clampedScopes } = await createPairingRequest(this.store, {
        deviceId: params.device.id,
        publicKey: params.device.publicKey,
        role: params.role,
        scopes: params.scopes,
        platform: params.client.platform,
        clientId: params.client.id,
        remoteIp: conn.remoteIp,
        fromLoopback: isLoopback(conn.remoteIp),
        ...(params.client.displayName === undefined
          ? {}
          : { displayName: params.client.displayName }),
      })

      this.broadcastToScope('device.pair', 'pair.requested', {
        requestId: request.requestId,
        deviceId: request.deviceId,
        role: request.role,
        scopes: request.scopes,
        platform: request.platform,
        clientId: request.clientId,
        displayName: request.displayName,
        remoteIp: request.remoteIp,
        fromLoopback: request.fromLoopback,
      })

      /* 顺手推手机：窗口开着的时候有人来请求注册 —— 这件事你必须知道
         （窗口是"你有意开的一条缝"，那就得知道有没有人正往里看）。
         推送失败不影响配对流程本身。 */
      void sendToAll(this, {
        title: '有新设备请求注册',
        body: `${request.clientId}${request.platform === '' ? '' : ' · ' + request.platform} 来自 ${request.remoteIp}（${request.scopes.length} 个 scope）`,
        tag: `pair-${request.requestId}`,
      }).catch(() => undefined)

      // 只有在极窄条件下才自动批准（回环/白名单 + node 角色 + 无 scope 请求 + 首次）
      if (canAutoApprove(this.store, request)) {
        const approved = await approvePairing(this.store, request.requestId, 'auto')
        const claimed = await claimToken(this.store, approved.device.deviceId)
        const autoPair = this.#completeHandshake(conn, {
          deviceId: claimed.device.deviceId,
          role: claimed.device.role,
          scopes: claimed.device.approvedScopes,
          clientId: claimed.device.clientId,
          platform: claimed.device.platform,
          deviceToken: claimed.token,
          pairingId: request.requestId,
          ...(claimed.device.displayName === undefined
            ? {}
            : { displayName: claimed.device.displayName }),
          ...(claimed.device.boundEmployeeId === undefined
            ? {}
            : { boundEmployeeId: claimed.device.boundEmployeeId }),
          ...(params.client.ui === undefined ? {} : { uiVersion: params.client.ui }),
        })
        this.log(`auto-approved node pairing for ${claimed.device.deviceId.slice(0, 12)}…`)
        this.debug(`handshake ${autoPair ? 'ok' : 'failed'} (auto-approved)`)
        return
      }

      this.#closeWith(
        conn,
        'pairing-required',
        'this device is not paired yet; an operator must approve the request',
        {
          requestId: request.requestId,
          ...(clampedScopes.length > 0
            ? {
                clampedScopes,
                note: 'some requested scopes exceed this role ceiling and were dropped',
              }
            : {}),
        },
      )
      return
    }

    // 已配对 → 令牌校验。两种合法情形：
    //   (a) 该设备还没领过令牌 → 这次就是"领取"，签发并通过（它已用私钥签了挑战）
    //   (b) 已领过 → 必须带对令牌
    if (paired.revoked) {
      this.#closeWith(conn, 'token-revoked', 'this device token has been revoked')
      return
    }

    const token = params.auth?.token

    if (!paired.tokenClaimed) {
      const claimed = await claimToken(this.store, paired.deviceId)
      const granted = normalizeScopes(params.scopes).filter((scope) =>
        claimed.device.approvedScopes.includes(scope),
      )
      this.#completeHandshake(conn, {
        deviceId: claimed.device.deviceId,
        role: claimed.device.role,
        scopes: granted,
        clientId: params.client.id,
        platform: params.client.platform,
        pairingId: claimed.device.deviceId,
        deviceToken: claimed.token,
        ...(claimed.device.displayName === undefined
          ? {}
          : { displayName: claimed.device.displayName }),
        ...(claimed.device.boundEmployeeId === undefined
          ? {}
          : { boundEmployeeId: claimed.device.boundEmployeeId }),
        ...(params.client.ui === undefined ? {} : { uiVersion: params.client.ui }),
      })
      this.log(
        `device ${claimed.device.deviceId.slice(0, 12)}… claimed its token on first connect after approval`,
      )
      await touchDevice(this.store, claimed.device.deviceId, conn.remoteIp)
      return
    }

    if (token === undefined || token === '') {
      this.#closeWith(
        conn,
        'auth-mismatch',
        'this device is paired but no token was supplied',
        { recommendedNextStep: 'supply the device token issued when this device first connected' },
      )
      return
    }
    if (findByToken(this.store, token)?.deviceId !== paired.deviceId) {
      this.#closeWith(conn, 'auth-mismatch', 'device token does not match')
      return
    }

    // 生效 scope = 请求的 scope ∩ 配对时批准过的 scope。
    // 这样"配对时只批了 read"的设备即使请求 manage 也只能拿到 read。
    const granted = normalizeScopes(params.scopes).filter((scope) =>
      paired.approvedScopes.includes(scope),
    )
    const dropped = scopesExceeding(normalizeScopes(params.scopes), paired.approvedScopes)

    this.#completeHandshake(conn, {
      deviceId: paired.deviceId,
      role: paired.role,
      scopes: granted,
      clientId: params.client.id,
      platform: params.client.platform,
      pairingId: paired.deviceId,
      ...(paired.displayName === undefined ? {} : { displayName: paired.displayName }),
      ...(paired.boundEmployeeId === undefined ? {} : { boundEmployeeId: paired.boundEmployeeId }),
      ...(dropped.length > 0 ? { droppedScopes: dropped } : {}),
      ...(params.client.ui === undefined ? {} : { uiVersion: params.client.ui }),
    })

    await touchDevice(this.store, paired.deviceId, conn.remoteIp)
  }

  /** 校验设备证明中与"签名"无关的结构性事实。返回 undefined 表示通过。 */
  #verifyDevice(params: ConnectParams): ProtocolErrorShape | undefined {
    const now = Date.now()
    const drift = Math.abs(now - params.device.signedAt)
    if (drift > DEFAULT_CLOCK_SKEW_MS) {
      return protocolError(
        'device-signature-invalid',
        `signedAt is outside the allowed clock skew (±${DEFAULT_CLOCK_SKEW_MS}ms)`,
        { driftMs: drift },
      )
    }

    // deviceId 必须真的是公钥的指纹，否则任何人都能自封一个 id
    let actual: string
    try {
      actual = fingerprintOf(params.device.publicKey)
    } catch {
      return protocolError('device-signature-invalid', 'device.publicKey is not a valid SPKI key')
    }
    if (!fingerprintEquals(actual, params.device.id)) {
      return protocolError(
        'device-signature-invalid',
        'device.id does not match the supplied public key fingerprint',
      )
    }

    // role 与 client.mode 必须一致，避免"声明 node 却按 operator 用"
    if (params.client.mode !== params.role) {
      return protocolError(
        'bad-request',
        `client.mode "${params.client.mode}" does not match role "${params.role}"`,
      )
    }

    return undefined
  }

  #completeHandshake(
    conn: Connection,
    input: {
      deviceId: string
      role: Role
      scopes: Scope[]
      clientId: string
      platform: string
      deviceToken?: string
      pairingId?: string
      droppedScopes?: Scope[]
      displayName?: string
      /** 设备台账里绑定的员工（员工自己的凭据）：跨员工调用的 from 由它派生 */
      boundEmployeeId?: string
      /** 控制台界面脚本指纹（dse-web 才带）。只用于日志与排障，不参与鉴权。 */
      uiVersion?: string
    },
  ): boolean {
    conn.phase = 'ready'
    conn.deviceId = input.deviceId
    conn.role = input.role
    conn.scopes = input.scopes
    conn.clientId = input.clientId
    conn.platform = input.platform
    if (input.displayName !== undefined) conn.displayName = input.displayName
    conn.boundEmployeeId = input.boundEmployeeId
    if (input.role === 'node') {
      conn.nodeId = input.deviceId
      /* 同一 nodeId 只保留**最新**的连接：老的那条多半是半开僵尸
         （节点看门狗重连成功、服务端却没收到旧连接 close 的场景），
         留着会被 nodeConnection() 选中、把所有转发请求吃进虚空。
         operator 连接不做 deviceId 去重 —— 多个 CLI 进程共享同一身份是合法的。 */
      for (const other of this.#connections) {
        if (other === conn || other.phase !== 'ready' || other.nodeId !== conn.nodeId) continue
        this.log(`terminating superseded node connection ${other.id} (node ${conn.nodeId.slice(0, 12)}… reconnected)`)
        other.socket.terminate()
      }

      /* 节点上线 = 把离线期间存下的指令按序送出。
         必须在 **conn.nodeId 赋值之后**：requestToNode 是按 nodeId 找连接的，
         放前面会找不到这条刚握手完的连接、被判成 node-offline，一条都投不出去
         （实测踩过：入队正常、重连后 attempts 仍是 0）。异步执行，不阻塞握手。 */
      void flushMailbox(this, input.deviceId)
        .then((flushed) => {
          if (flushed.delivered > 0 || flushed.skippedOffline > 0 || flushed.uncertain > 0) {
            this.log(
              `mailbox flush for ${input.deviceId.slice(0, 12)}…: delivered=${flushed.delivered} ` +
                `offline=${flushed.skippedOffline} uncertain=${flushed.uncertain} remaining=${flushed.remaining}`,
            )
          }
        })
        .catch((error: unknown) => this.log(`mailbox flush failed: ${String(error)}`))
    }

    conn.send(
      makeResOk(conn.lastConnectId, {
        type: 'hello-ok',
        hubId: this.store.state().config.hubId,
        protocol: PROTOCOL_VERSION,
        server: { version: '0.1.0', connId: conn.id },
        features: {
          methods: methodsVisibleTo(input.role),
          // `challenge` 只在握手前由服务端主动下发，不属于"可广播事件"，故从发现清单里排除
          events: EVENT_NAMES.filter((name) => name !== 'challenge'),
        },
        auth: {
          role: input.role,
          scopes: input.scopes,
          ...(input.deviceToken === undefined ? {} : { deviceToken: input.deviceToken }),
          ...(input.pairingId === undefined ? {} : { pairingId: input.pairingId }),
        },
        policy: {
          maxPayload: MAX_FRAME_BYTES,
          tickIntervalMs: this.options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
        },
        /* 控制端自报的界面指纹 vs 当前指纹。部署后开着的标签页只会重连、**不会重新取 JS**，
           于是"修好了但他看到的还是旧的"（真实事故：审批按钮修完后旧标签页仍然点不动）。
           对不上就当场告诉它，由页面自己提示刷新 —— 别让人去猜"是不是没修"。 */
        ui: (() => {
          const hubUiVersion = controlUiVersion()
          return {
            client: input.uiVersion ?? '',
            hub: hubUiVersion,
            stale: input.uiVersion !== undefined && input.uiVersion !== hubUiVersion,
          }
        })(),
      }),
    )

    this.log(
      `connected ${input.role} "${input.clientId}" device=${input.deviceId.slice(0, 12)}… scopes=[${input.scopes.join(',')}]` +
        // 界面脚本指纹：与服务器当前版本不一致 ⇒ 这台设备跑的是缓存的旧脚本
        // （布局/功能对不上时的第一现场证据）
        (input.uiVersion === undefined
          ? ''
          : ` ui=${input.uiVersion}${input.uiVersion === controlUiVersion() ? '' : ` (stale; hub serves ${controlUiVersion()})`}`),
    )
    if (input.droppedScopes !== undefined && input.droppedScopes.length > 0) {
      this.log(
        `  note: dropped scopes not covered by this device's approval: ${input.droppedScopes.join(', ')}`,
      )
    }

    // 节点上线 → 广播给有 employee.read 的控制端
    if (input.role === 'node') {
      this.broadcastToScope('employee.read', 'node.changed', {
        nodeId: input.deviceId,
        online: true,
        clientId: input.clientId,
        platform: input.platform,
      })
    }
    return true
  }

  #closeWith(
    conn: Connection,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    conn.send(makeResError('connect', protocolError(code, message, details)))
    conn.socket.close(1008, code)
  }

  /* ────────────────────────── 配对码兑换（bootstrap）────────────────────────── */

  /**
   * 未认证阶段受理 `device.pair.redeem`。
   *
   * 与正常派发的差别仅在于：此时连接还没有 role/scope，因此跳过 `dispatch()`
   * 的角色与 scope 检查，直接进 handler（zod 校验与配对码校验一个不少）。
   * 成功后连接仍停在 awaiting-connect —— 设备要拿到令牌，仍需完成一次完整的
   * 签名握手（challenge → connect → claimToken），配对码只是"批准"这一步。
   */
  async #handlePairRedeem(conn: Connection, frame: ReqFrame): Promise<void> {
    // hubHandlers 的类型是 Partial（缺 handler 的方法在 dispatch 里报 internal），这里明确判空
    const handler = hubHandlers['device.pair.redeem']
    if (handler === undefined) {
      conn.send(makeResError(frame.id, protocolError('internal', 'device.pair.redeem has no handler')))
      return
    }
    try {
      const payload = await handler(this, conn, frame.params)
      conn.send(makeResOk(frame.id, payload))
    } catch (error) {
      conn.send(
        makeResError(
          frame.id,
          isProtocolError(error)
            ? error
            : protocolError('internal', error instanceof Error ? error.message : String(error)),
        ),
      )
    }
  }

  /** 该 IP 的配对码限流截止时刻；0 或过去时刻 = 未被限流。 */
  redeemBlockedUntil(ip: string): number {
    const entry = this.#redeemFailures.get(ip)
    if (entry === undefined) return 0
    if (entry.blockedUntilMs <= Date.now()) return 0
    return entry.blockedUntilMs
  }

  /**
   * 记一次配对码猜错。同一 IP 连续错 5 次 → 断开当前连接并拒绝该 IP 60 秒。
   *
   * 取舍：6 位数字码只有 ~20 bit 熵，不限流的话在线爆破几分钟就能撞开。
   * "错 5 次锁 60 秒"把期望爆破时间拉到数百年量级，而单人自用场景下
   * 真正的用户几乎不可能连错 5 次。不引入持久化黑名单等更重机制 ——
   * 进程重启即清零，对这个威胁模型已经足够。
   */
  noteRedeemFailure(conn: Connection): void {
    const now = Date.now()
    const entry = this.#redeemFailures.get(conn.remoteIp) ?? { count: 0, blockedUntilMs: 0 }
    entry.count += 1
    if (entry.count >= 5) {
      entry.count = 0
      entry.blockedUntilMs = now + 60_000
      this.log(`pair-code: 5 consecutive failures from ${conn.remoteIp}, blocking for 60s`)
      conn.socket.close(1008, 'pair-code rate limited')
    }
    this.#redeemFailures.set(conn.remoteIp, entry)
  }

  /** 配对成功即清零该 IP 的计数（正常用户不该背着别人的失败记录）。 */
  noteRedeemSuccess(ip: string): void {
    this.#redeemFailures.delete(ip)
  }

  #onDisconnect(conn: Connection): void {
    // 挂起的出站请求全部以失败结算，避免调用方永久等待
    for (const [, waiter] of conn.pendingOutbound) {
      waiter(makeResError('outbound', protocolError('node-offline', 'connection closed')))
    }
    conn.pendingOutbound.clear()

    if (conn.role === 'node' && conn.nodeId !== undefined) {
      /* 被淘汰的旧连接（同 nodeId 去重或僵尸清理）不该把新连接标记成离线：
         只在"该节点已没有任何就绪连接"时才标离线。
         注意此刻本连接已从连接表删除（close 处理先删再调这里），
         所以 nodeConnection 若返回了连接，那一定是**别的**（更新的）连接。 */
      if (this.nodeConnection(conn.nodeId) !== undefined) {
        this.debug(
          `stale node connection ${conn.id} closed; node ${conn.nodeId.slice(0, 12)}… still online via a newer connection`,
        )
        return
      }
      const node = this.store.state().nodes[conn.nodeId]
      if (node !== undefined) {
        node.online = false
        node.lastSeenAtMs = Date.now()
        void this.store.saveNodes()
      }
      this.broadcastToScope('employee.read', 'node.changed', {
        nodeId: conn.nodeId,
        online: false,
      })
    }
  }

  /* ────────────────────────── 派发 ────────────────────────── */

  async dispatch(conn: Connection, frame: ReqFrame): Promise<ResFrame> {
    const { method } = frame

    // 1. 未知方法 fail-closed
    if (!isMethodName(method)) {
      return makeResError(frame.id, protocolError('unknown-method', `unknown method "${method}"`))
    }
    const spec = methodSpec(method)

    // 2. 角色
    if (!(spec.roles as readonly string[]).includes(conn.role)) {
      return makeResError(
        frame.id,
        protocolError('forbidden', `role "${conn.role}" may not call "${method}"`),
      )
    }

    // 3. scope（逐方法强制，节点自报的能力不被信任）
    if (!scopeSatisfies(conn.scopes, spec.scopes)) {
      /* 被拒的调用必须留痕。以前这里静默返回 —— 于是"某个功能整条不可用"在服务端
         一个字都没有，排障只能靠客户端 souvenir（真实事故：一句含糊的
         "invalid params for position.upsert" 既进不了日志，也无从复查）。 */
      this.#logRejected(method, conn, `forbidden: requires ${spec.scopes.join(', ')}`)
      return makeResError(
        frame.id,
        protocolError('forbidden', `"${method}" requires scope(s): ${spec.scopes.join(', ')}`, {
          requiredScopes: spec.scopes,
          grantedScopes: conn.scopes,
        }),
      )
    }

    // 4. 幂等键
    if (spec.idempotent === true && (frame.idempotencyKey ?? '') === '') {
      return makeResError(
        frame.id,
        protocolError('idempotency-key-required', `"${method}" requires an idempotencyKey`),
      )
    }

    // 5. 业务
    const handler = hubHandlers[method]
    if (handler === undefined) {
      return makeResError(
        frame.id,
        protocolError('internal', `method "${method}" is declared but has no handler`),
      )
    }
    if (spec.idempotent === true) return await this.#dispatchIdempotent(conn, frame, handler)
    return await this.#executeHandler(conn, frame, handler)
  }

  async #executeHandler(conn: Connection, frame: ReqFrame, handler: HubHandler): Promise<ResFrame> {
    try {
      const payload = await handler(this, conn, frame.params)
      return makeResOk(frame.id, payload)
    } catch (error) {
      if (isProtocolError(error)) {
        /* `bad-request`（参数校验失败）与 `internal` 都要留痕：这两类都是**代码/契约**
           出了问题，静默返回等于把排查成本全推给看界面的人。其余错误码（not-found、
           node-offline…）是正常业务分支，不记 —— 否则日志会被正常操作淹掉。 */
        const code = (error as { code?: string }).code ?? ''
        if (code === 'bad-request' || code === 'internal') {
          this.#logRejected(frame.method, conn, `${code}: ${(error as { message?: string }).message ?? ''}`)
        }
        return makeResError(frame.id, error)
      }
      this.#logRejected(
        frame.method,
        conn,
        `internal: ${error instanceof Error ? error.message : String(error)}`,
      )
      return makeResError(
        frame.id,
        protocolError('internal', error instanceof Error ? error.message : String(error)),
      )
    }
  }

  #canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
    if (Array.isArray(value)) return `[${value.map((item) => this.#canonicalJson(item)).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${this.#canonicalJson(record[key])}`).join(',')}}`
  }

  #idempotencyResponse(response: ResFrame, requestId: string): ResFrame {
    return { ...response, id: requestId }
  }

  #idempotencyConflict(frame: ReqFrame): ResFrame {
    return makeResError(
      frame.id,
      protocolError('bad-request', 'idempotencyKey was already used with a different method or params'),
    )
  }

  async #dispatchIdempotent(conn: Connection, frame: ReqFrame, handler: HubHandler): Promise<ResFrame> {
    const key = frame.idempotencyKey ?? ''
    const cacheId = createHash('sha256').update(conn.deviceId).update('\0').update(key).digest('hex')
    const paramsHash = createHash('sha256')
      .update(frame.method)
      .update('\0')
      .update(this.#canonicalJson(frame.params ?? null))
      .digest('hex')

    const inFlight = this.#idempotencyInFlight.get(cacheId)
    if (inFlight !== undefined) {
      if (inFlight.method !== frame.method || inFlight.paramsHash !== paramsHash) return this.#idempotencyConflict(frame)
      return this.#idempotencyResponse(await inFlight.promise, frame.id)
    }

    const cached = this.store.state().idempotency[cacheId]
    if (cached !== undefined && cached.createdAtMs > Date.now() - IDEMPOTENCY_TTL_MS) {
      if (cached.method !== frame.method || cached.paramsHash !== paramsHash) return this.#idempotencyConflict(frame)
      if (cached.status === 'running') {
        // 若 Hub 在副作用执行后、响应落盘前崩溃，结果无法确定。拒绝重跑比重复执行安全。
        return makeResError(
          frame.id,
          protocolError('bad-request', 'the previous attempt was interrupted; outcome is unknown, refusing to execute it again'),
        )
      }
      return this.#idempotencyResponse(cached.response, frame.id)
    }

    const now = Date.now()
    const running: IdempotencyRecord = {
      deviceId: conn.deviceId,
      key,
      method: frame.method,
      paramsHash,
      status: 'running',
      createdAtMs: now,
    }
    const state = this.store.state()
    const live = Object.entries(state.idempotency)
      .filter(([, record]) => record.createdAtMs > now - IDEMPOTENCY_TTL_MS)
      .sort((a, b) => b[1].createdAtMs - a[1].createdAtMs)
    const keep: Array<[string, IdempotencyRecord]> = [[cacheId, running]]
    let bytes = Buffer.byteLength(JSON.stringify(running))
    for (const [id, item] of live) {
      if (id === cacheId || keep.length >= IDEMPOTENCY_MAX_RECORDS) continue
      const itemBytes = Buffer.byteLength(JSON.stringify(item))
      if (bytes + itemBytes > IDEMPOTENCY_MAX_BYTES) continue
      keep.push([id, item])
      bytes += itemBytes
    }
    const nextState: Record<string, IdempotencyRecord> = {}
    for (const [id, item] of keep) nextState[id] = item
    state.idempotency = nextState

    const pending = (async () => {
      try {
        // Reserve and fsync the intent before a handler can perform a side effect.
        await this.store.saveIdempotency()
      } catch (error) {
        delete state.idempotency[cacheId]
        this.#logRejected(frame.method, conn, `internal: failed to persist idempotency reservation: ${String(error)}`)
        return makeResError(frame.id, protocolError('internal', 'could not persist idempotency reservation; method was not executed'))
      }

      const response = await this.#executeHandler(conn, frame, handler)
      state.idempotency[cacheId] = { ...running, status: 'completed', response, createdAtMs: Date.now() }
      try {
        await this.store.saveIdempotency()
      } catch (error) {
        // The durable reservation remains. A retry after restart will be reported as
        // indeterminate rather than re-running a possibly completed side effect.
        this.#logRejected(frame.method, conn, `internal: failed to persist idempotency response: ${String(error)}`)
      }
      return response
    })()
    this.#idempotencyInFlight.set(cacheId, { method: frame.method, paramsHash, promise: pending })
    try {
      return this.#idempotencyResponse(await pending, frame.id)
    } finally {
      this.#idempotencyInFlight.delete(cacheId)
    }
  }

  /**
   * 记一条"这个方法被拒了"。
   *
   * **不记 params**：那里面可能有提示词、口令、文件内容（日志是长期留存的东西）。
   * 记方法名 + 谁调的 + 为什么，足以定位到具体的一行代码。
   */
  #logRejected(method: string, conn: Connection, reason: string): void {
    const device = conn.deviceId === '' ? '(未配对)' : conn.deviceId.slice(0, 12) + '…'
    this.log(`rejected ${method} from ${conn.role} ${device}: ${reason.slice(0, 400)}`)
  }

  /* ────────────────────────── 广播与路由 ────────────────────────── */

  /**
   * 把事件推给所有持有指定 scope 的已就绪连接。
   *
   * 门控对**两种角色一视同仁**。原先是 `conn.role === 'operator' && !conn.hasScope(scope)`，
   * 即节点角色一律放行 —— 那等于给每个终端（通常以"零 scope"配对）免费发放全部广播：
   * 审批请求、配对请求、员工目录变化、互调结算…… 这与本仓库明文写的契约
   * "事件广播也按 scope 门控；未知事件族默认不投递（fail-closed）"（docs/03 §3.6、
   * frames.ts）直接冲突。
   *
   * 现在按 scope 判：节点默认零 scope ⇒ 收不到任何广播（它本来也不消费事件 ——
   * node/agent.ts 只监听 deviceToken/hello/reconnected/request/error）；
   * 将来若真需要给某台节点推事件，就在配对时明确授予对应 scope，而不是靠角色后门。
   */
  broadcastToScope(scope: Scope, event: EventName, payload: unknown): void {
    this.#eventSeq += 1
    for (const conn of this.#connections) {
      if (conn.phase !== 'ready') continue
      if (!conn.hasScope(scope)) continue
      conn.sendEvent(event, payload, this.#eventSeq)
    }
  }

  /** 把会话事件推给订阅了它的控制端。 */
  broadcastSessionEvent(sessionId: string, payload: unknown): void {
    this.#eventSeq += 1
    for (const conn of this.#connections) {
      if (conn.phase !== 'ready') continue
      if (!conn.subscriptions.has(sessionId)) continue
      conn.sendEvent('session.event', { sessionId, ...(payload as object) }, this.#eventSeq)
    }
  }

  /** 找承载某员工的在线节点连接。 */
  nodeConnection(nodeId: string): Connection | undefined {
    /* 同 nodeId 理论上只剩一条（握手时去重），但僵尸被淘汰前可能有短暂重叠：
       防御性地选**最近活跃**的那条，而不是遍历顺序里最先注册的。 */
    let best: Connection | undefined
    for (const conn of this.#connections) {
      if (conn.phase !== 'ready' || conn.role !== 'node' || conn.nodeId !== nodeId) continue
      if (best === undefined || conn.lastActivityAt > best.lastActivityAt) best = conn
    }
    return best
  }

  onlineNodeCount(): number {
    let count = 0
    for (const conn of this.#connections) {
      if (conn.phase === 'ready' && conn.role === 'node') count += 1
    }
    return count
  }

  /**
   * 向一个节点发请求并等待它的响应。
   *
   * 超时是必须的：网络中断时 socket 未必立刻报错，没有超时就会永久挂住调用方。
   */
  async requestToNode(
    nodeId: string,
    method: string,
    params: unknown,
    timeoutMs = 30_000,
  ): Promise<ResFrame> {
    const conn = this.nodeConnection(nodeId)
    if (conn === undefined) {
      return makeResError('outbound', protocolError('node-offline', `node ${nodeId} is not connected`))
    }
    const id = randomUUID()
    return await new Promise<ResFrame>((resolve) => {
      const timer = setTimeout(() => {
        conn.pendingOutbound.delete(id)
        resolve(
          makeResError(
            id,
            protocolError(
              'timeout',
              `node ${nodeId} did not answer "${method}" within ${timeoutMs}ms ` +
                `(the node is connected; the operation may still be running)`,
              { method, nodeId, timeoutMs },
            ),
          ),
        )
      }, timeoutMs)
      timer.unref?.()

      conn.pendingOutbound.set(id, (res) => {
        clearTimeout(timer)
        resolve(res)
      })
      conn.send({ type: 'req', id, method, params })
    })
  }
}

/* ────────────────────────────── 辅助 ────────────────────────────── */

/**
 * 解析一条新连接（WS 升级请求）的客户端 IP。
 *
 * 默认只信 TCP 对端。`X-Real-IP` / `X-Forwarded-For` 是客户端可以随便写的头，
 * 直连部署时信它们等于把 `fromLoopback` 判定（节点配对自动批准的唯一依据）
 * 交给发起方伪造。
 *
 * 仅在 `trustProxy` 开启、且 TCP 对端是回环时才读头：对端是回环说明请求确实
 * 经过了同机反代（直连公网的请求对端不可能是 127.0.0.1）。两层条件缺一不可 ——
 * 反代后面直连 Hub 回环端口的本地进程仍然有伪造余地，但那已经是"本机访问"
 * 的信任级别，与 `dse pair approve` 同级。
 */
/**
 * "门关着"时回的 404 —— **与本部署的 nginx 逐字节一致**。
 *
 * 实测过本机 nginx 对未知路径的响应：`content-type: text/plain; charset=utf-8` + body
 * `not found`（安全头由 nginx 的 add_header 统一加，proxied 响应也一样带 ✓）。
 * 逐字节一致是有意的：任何差异（长度、大小写、换行、content-type）本身就是指纹 ——
 * 攻击者据此能判断"这后面藏着一套需要认证的服务"，于是又回到"只差一个 6 位码"的处境。
 *
 * ⚠️ 换部署（别的 nginx 配置 / 别的反代）时，这段要跟着改；
 * 判断方法：`curl -i https://<域名>/<不存在的路径>`。
 */
const NGINX_STYLE_404 = 'not found\n'

/** 已配对设备的浏览器凭据（页面 / 脚本 / 图标这些没有 Authorization 头的请求靠它认人）。 */
export const DEVICE_COOKIE = 'dse_device'
/** cookie 有效期一年：设备令牌本身可以随时吊销，cookie 只是"携带方式"。 */
const DEVICE_COOKIE_MAX_AGE_SEC = 365 * 24 * 3600
/** `/session` 的请求体上限：只装一个令牌，超过就是有人在拿它当上传口。 */
const SESSION_MAX_BYTES = 4096

/** 从 Cookie 头里取一个键的值。只做最小解析：不引依赖，也不做解码（令牌是 base64url）。 */
function readCookie(header: string | undefined, name: string): string {
  if (header === undefined || header === '') return ''
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    return part.slice(eq + 1).trim()
  }
  return ''
}

/** `POST /session` 的请求体：`{"token":"…"}`，也接受没引号的裸令牌。 */
function readTokenFromBody(body: string): string {
  const trimmed = body.trim()
  if (trimmed === '') return ''
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const token = (parsed as { token?: unknown }).token
      return typeof token === 'string' ? token.trim() : ''
    } catch {
      return ''
    }
  }
  return trimmed
}

/** 反代是否终结了 TLS（决定 cookie 要不要带 Secure）。直连时按 socket 是否加密判断。 */
function forwardedProtoIsHttps(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto']
  const value = Array.isArray(proto) ? proto[0] : proto
  if (typeof value === 'string' && value.trim() !== '') return value.trim().toLowerCase() === 'https'
  return (req.socket as { encrypted?: boolean }).encrypted === true
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const tcp = normalizeIp(req.socket.remoteAddress)
  if (!trustProxy) return tcp
  if (!isLoopback(tcp)) return tcp
  const realIp = req.headers['x-real-ip']
  if (typeof realIp === 'string' && realIp.trim() !== '') return realIp.trim()
  // X-Forwarded-For 是逗号分隔链，最左是原始客户端
  const forwarded = req.headers['x-forwarded-for']
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  return first !== undefined && first !== '' ? first : tcp
}

function normalizeIp(raw: string | undefined): string {
  if (raw === undefined || raw === '') return 'unknown'
  // IPv4-mapped IPv6，例如 ::ffff:127.0.0.1
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw)
  return mapped?.[1] ?? raw
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost'
}

/**
 * 进程是否还活着。用于判定状态目录锁是否陈旧。
 *
 * `signal 0` 只做权限/存在性探测，不真的发信号。
 * EPERM 意味着"进程存在但我不被允许碰它" —— 那也算活着。
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export { isLoopback, normalizeIp }
