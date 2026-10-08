/**
 * 线协议帧定义 —— Hub 与客户端之间唯一的契约。
 *
 * 三种帧，与 OpenClaw 的 Gateway 协议同构但按本产品裁剪：
 *   req   { type, id, method, params }
 *   res   { type, id, ok, payload | error }
 *   event { type, event, payload, seq }
 *
 * 握手顺序（服务端主导）：
 *   Hub  → event "challenge" { nonce, ts, hubId }
 *   Cli  → req   "connect"   { protocol, client, role, scopes, device, auth }
 *   Hub  → res   (payload.type === "hello-ok")
 *
 * 所有 schema 都是**严格校验**的：多余字段被剥离，缺失/类型错误的字段导致整个帧被拒。
 */

import { z } from 'zod'
import { ROLES, SCOPES } from './scopes.ts'

/** 本实现支持的协议版本。 */
export const PROTOCOL_VERSION = 1

/** 单帧上限（字节）。握手前与握手后都按此值把关。 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024

/** 心跳间隔（毫秒）。服务端在 hello-ok.policy 中下发权威值。 */
export const DEFAULT_TICK_INTERVAL_MS = 15_000

/* ────────────────────────────── 错误码 ────────────────────────────── */

/**
 * 协议级错误码。
 *
 * 刻意保持小而稳定：客户端按 code 分支，面向人的解释放 message，
 * 需要额外上下文时放 details（绝不放密钥）。
 */
export const ERROR_CODES = [
  /** 请求体不合法（结构/schema 校验失败） */
  'bad-request',
  /** 未知方法（fail-closed） */
  'unknown-method',
  /** 未认证（尚未成功 connect） */
  'unauthenticated',
  /** 权限不足（scope 不覆盖） */
  'forbidden',
  /** 设备需要配对审批 */
  'pairing-required',
  /**
   * 未配对设备在「只认配对码」模式下撞上了关着的注册窗口。
   *
   * 与 `pairing-required` 分开：那一个是"你的请求已经记下了，等批准/输码"，
   * 这一个是"连记录都没落，等窗口开了再来" —— 两者给用户的下一步完全不同。
   */
  'pairing-closed',
  /** 设备令牌/共享密钥不匹配 */
  'auth-mismatch',
  /** 设备令牌被吊销 */
  'token-revoked',
  /** 挑战 nonce 缺失/过期/已用过 */
  'challenge-invalid',
  /** 设备签名校验失败（含指纹不符、时钟偏移、签名非法） */
  'device-signature-invalid',
  /** 请求的对象不存在 */
  'not-found',
  /** 有副作用的方法缺少幂等键 */
  'idempotency-key-required',
  /** 目标节点当前离线且不被允许排队 */
  'node-offline',
  /** 需要人工审批 */
  'approval-required',
  /** 配对码校验失败（错误/过期/已用/触发限流；细分原因放 details.reason） */
  'pair-code-invalid',
  /**
   * 目标节点在超时内没有应答。
   *
   * **必须与 `node-offline` 分开**：节点可能完全健康，只是这个操作本来就慢
   * （例如让某个员工跑完一整轮任务要几分钟）。把超时报成"离线"，上层就会
   * 把它当成"等节点重连后重试"，于是任务状态永远停在排队中 ——
   * 而真相是**任务很可能正在正常运行**。这类"看着正常、其实错报"的缺陷
   * 最难排查，所以宁可多一个错误码。
   */
  'timeout',
  /** 服务端内部错误 */
  'internal',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ProtocolErrorShape {
  code: ErrorCode
  message: string
  details?: Record<string, unknown>
}

/* ────────────────────────────── 基础帧 ────────────────────────────── */

const rpcIdSchema = z.string().min(1).max(128)

const errorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
})

/** 事件名白名单之外的事件一律不投递（fail-closed）。 */
export const EVENT_NAMES = [
  /** 握手挑战（唯一允许在 connect 之前出现的事件） */
  'challenge',
  /** 心跳 */
  'tick',
  /** 员工目录变化 */
  'employee.changed',
  /** 终端节点上线/下线/改名 */
  'node.changed',
  /** 会话事件（员工输出的实时流） */
  'session.event',
  /** 审批请求生命周期 */
  'approval.requested',
  'approval.resolved',
  /**
   * 一次员工互调**结算**了（完成或失败）。
   *
   * 为什么必须有这个事件：互调是长任务（可能几分钟），而 RPC 的调用超时只有 30 秒。
   * 若让发起方同步等待结果，任何超过 30 秒的任务都会变成"调用方看到超时，
   * 但活其实还在干"—— 这是最糟糕的一类体验。所以
   * **发起即返回 `accepted`，结果通过这个事件与 `employee.invoke.list` 异步送达。**
   * 这也是 OpenClaw 的 announce 做法（幂等键 + 唤醒/steer + 队列路由 + 退避重试）。
   */
  'invoke.settled',
  /** 设备配对生命周期 */
  'pair.requested',
  'pair.resolved',
  /** 已配对设备改名了（别的控制台要跟着换显示名，否则两台设备看到的名字不一致） */
  'device.renamed',
  /** 新设备进门方式变了（只认配对码 / 也允许人工批准）—— 设备页据此换掉那一排按钮 */
  'pairing.approval.changed',
  /**
   * 定时任务的定义变了（新建/改/删/启停）。
   *
   * 单列一个事件而不是复用 employee.changed：控制台"定时"页据此刷新列表，
   * 而员工目录变化与任务无关 —— 混在一起会让两边都多做无用的重绘。
   */
  'job.changed',
  /** 一轮定时任务跑完了（派发结果；不是"任务成功"）。 */
  'job.ran',
  /** 办公区排序偏好变化（跨控制台实时同步） */
  'office.order.changed',
  /** 服务端即将关闭 */
  'shutdown',
] as const

export type EventName = (typeof EVENT_NAMES)[number]

export const reqFrameSchema = z.object({
  type: z.literal('req'),
  id: rpcIdSchema,
  method: z.string().min(1).max(96),
  params: z.unknown().optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
})

export const resFrameSchema = z.object({
  type: z.literal('res'),
  id: rpcIdSchema,
  ok: z.boolean(),
  payload: z.unknown().optional(),
  error: errorSchema.optional(),
})

export const eventFrameSchema = z.object({
  type: z.literal('event'),
  event: z.enum(EVENT_NAMES),
  payload: z.unknown().optional(),
  seq: z.number().int().nonnegative().optional(),
})

export const frameSchema = z.discriminatedUnion('type', [
  reqFrameSchema,
  resFrameSchema,
  eventFrameSchema,
])

export type ReqFrame = z.infer<typeof reqFrameSchema>
export type ResFrame = z.infer<typeof resFrameSchema>
export type EventFrame = z.infer<typeof eventFrameSchema>
export type Frame = z.infer<typeof frameSchema>

/* ────────────────────────────── 握手 ────────────────────────────── */

export const challengePayloadSchema = z.object({
  nonce: z.string().min(16).max(256),
  ts: z.number().int(),
  hubId: z.string().min(1).max(128),
  protocol: z.number().int().positive(),
})

export type ChallengePayload = z.infer<typeof challengePayloadSchema>

export const clientInfoSchema = z.object({
  /** 客户端种类，如 "dse-cli" / "dse-node" / "dse-web" */
  id: z.string().min(1).max(64),
  version: z.string().min(1).max(32),
  /**
   * 控制台**界面脚本**的内容指纹（只有 dse-web 会带）。
   *
   * 与 `version` 分开的理由：`version` 是"客户端种类"的版本（改代码不一定改它），
   * 而这一串**逐字节跟着 /ui.js 变**。它让 Hub 端日志直接回答一个以前只能靠猜的问题：
   * "这台设备此刻跑的是哪一版界面脚本？"—— 手机与电脑布局不一致时，第一个要看的
   * 就是两边这个值是否相同（不同 ⇒ 有一端被缓存冻在旧脚本上）。
   * 不参与签名载荷（签名只覆盖 clientId），因此老客户端不带它也不会握手失败。
   */
  ui: z.string().min(1).max(64).optional(),
  /** 平台标识，参与签名载荷，如 "win32" / "darwin" / "android" */
  platform: z.string().min(1).max(32),
  /** 连接模式，与 role 保持一致但独立声明（便于将来 operator 走 node 传输） */
  mode: z.enum(ROLES),
  /** 人类可读的显示名，如 "我的手机"、"办公PC" */
  displayName: z.string().min(1).max(64).optional(),
})

export type ClientInfo = z.infer<typeof clientInfoSchema>

export const deviceProofSchema = z.object({
  /** 公钥指纹（sha256(SPKI DER) 小写 hex） */
  id: z.string().regex(/^[0-9a-f]{64}$/, 'device.id must be a 64-char lowercase hex fingerprint'),
  /** SPKI DER 的 base64url */
  publicKey: z.string().min(16).max(512),
  /** 规范载荷的 Ed25519 签名，base64url */
  signature: z.string().min(16).max(512),
  signedAt: z.number().int().positive(),
  /** 必须等于本次 challenge 的 nonce */
  nonce: z.string().min(16).max(256),
})

export type DeviceProofWire = z.infer<typeof deviceProofSchema>

export const connectParamsSchema = z.object({
  protocol: z.number().int().positive(),
  client: clientInfoSchema,
  role: z.enum(ROLES),
  scopes: z.array(z.enum(SCOPES)).max(SCOPES.length),
  device: deviceProofSchema,
  auth: z
    .object({
      /** 已配对设备令牌 */
      token: z.string().min(8).max(256).optional(),
    })
    .optional(),
})

export type ConnectParams = z.infer<typeof connectParamsSchema>

export const helloOkSchema = z.object({
  type: z.literal('hello-ok'),
  hubId: z.string().min(1),
  protocol: z.number().int().positive(),
  server: z.object({ version: z.string(), connId: z.string() }),
  features: z.object({
    methods: z.array(z.string()),
    events: z.array(z.string()),
  }),
  auth: z.object({
    /** 首次配对成功时签发；后续连接不再重复下发 */
    deviceToken: z.string().optional(),
    role: z.enum(ROLES),
    scopes: z.array(z.enum(SCOPES)),
    /** 该设备在台账里的配对记录 id（已配对时） */
    pairingId: z.string().optional(),
  }),
  policy: z.object({
    maxPayload: z.number().int().positive(),
    tickIntervalMs: z.number().int().positive(),
  }),
  /**
   * 界面脚本指纹：控制端自报的（client）vs 服务器当前的（hub）。
   *
   * 为什么要在握手里回这一句：部署新代码后，**已经开着的标签页只会断线重连、不会重新
   * 取 JS**，于是"修好了但你看不到"—— 页面看起来一切正常，点的还是旧逻辑。真实踩过：
   * 审批「通过」按钮修完之后，旧标签页里依然点不动。
   * 页面拿到 stale=true 就自己挂出"刷新一下"的提示。
   */
  ui: z
    .object({
      client: z.string(),
      hub: z.string(),
      stale: z.boolean(),
    })
    .optional(),
})

export type HelloOk = z.infer<typeof helloOkSchema>

/* ────────────────────────────── 构造/解析辅助 ────────────────────────────── */

export function makeResOk(id: string, payload: unknown): ResFrame {
  return { type: 'res', id, ok: true, payload }
}

export function makeResError(id: string, error: ProtocolErrorShape): ResFrame {
  return { type: 'res', id, ok: false, error }
}

export function makeEvent(event: EventName, payload: unknown, seq?: number): EventFrame {
  return seq === undefined
    ? { type: 'event', event, payload }
    : { type: 'event', event, payload, seq }
}

/** 把任意帧对象序列化为线格式字符串。 */
export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame)
}

export type ParseFrameResult =
  | { ok: true; frame: Frame }
  | { ok: false; error: ProtocolErrorShape }

/** 解析一个线格式帧。任何不合法输入都返回错误而不抛异常。 */
export function parseFrame(raw: string): ParseFrameResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return {
      ok: false,
      error: { code: 'bad-request', message: 'frame is not valid JSON' },
    }
  }
  const parsed = frameSchema.safeParse(json)
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'bad-request',
        message: 'frame failed schema validation',
        details: { issues: parsed.error.issues },
      },
    }
  }
  return { ok: true, frame: parsed.data }
}

/** 判断一个错误对象是否符合协议错误形状。 */
export function isProtocolError(value: unknown): value is ProtocolErrorShape {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { code?: unknown; message?: unknown }
  return (
    typeof candidate.code === 'string' &&
    (ERROR_CODES as readonly string[]).includes(candidate.code) &&
    typeof candidate.message === 'string'
  )
}

export function protocolError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ProtocolErrorShape {
  return details === undefined ? { code, message } : { code, message, details }
}
