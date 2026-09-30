/**
 * 设备配对与令牌 —— 认证链的下半段。
 *
 * 安全不变量（每一条都有对抗性测试覆盖）：
 *  1. **令牌只存哈希**：台账里绝无明文令牌，泄库不等于泄权。
 *  2. **令牌不可自我扩权**：任何签发/轮换的 scope 都必须落在该设备**配对时批准过**的集合内。
 *  3. **配对上限定死在角色上限**：operator 拿不到不存在的 scope，node 永远拿不到
 *     `device.pair` / `approval.resolve`（执行端不能批准自己或别人）。
 *  4. **吊销即失效**：`revoked` 为真时令牌立刻作废，且不可被重新启用。
 */

import { randomBytes, createHash } from 'node:crypto'

import {
  ceilingFor,
  normalizeScopes,
  scopesExceeding,
  type Role,
  type Scope,
} from '../protocol/index.ts'
import type { HubConfig, HubStore } from './store.ts'
import { newId } from '../util/fsx.ts'
import type { PairedDevice, PairingRequest } from './types.ts'

/** 生成一个设备令牌（明文）。只在签发瞬间存在，之后只留哈希。 */
export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export interface CreatePairingInput {
  deviceId: string
  publicKey: string
  role: Role
  scopes: readonly Scope[]
  platform: string
  clientId: string
  displayName?: string
  remoteIp: string
  fromLoopback: boolean
}

export interface PairingOutcome {
  request: PairingRequest
  /** 命中的 scope 上限裁剪说明：请求里有被裁掉的 scope */
  clampedScopes: Scope[]
}

/** 待配对请求的默认有效期。见 `PairingRequest.expiresAtMs` 的说明。 */
export const PAIRING_TTL_MS = 30 * 60_000

/**
 * 清理过期的待配对请求。返回被清理的 requestId。
 *
 * 调用点：握手（每次连接都会产生/刷新请求）与 `device.list`（用户正要看清单时）。
 * 幂等且廉价（内存遍历），因此不需要定时器。
 */
export async function sweepExpiredPairings(
  store: HubStore,
  now: number = Date.now(),
): Promise<string[]> {
  const state = store.state()
  const expired: string[] = []
  for (const [requestId, request] of Object.entries(state.pending)) {
    if (request.expiresAtMs <= now) {
      delete state.pending[requestId]
      expired.push(requestId)
    }
  }
  if (expired.length > 0) await store.savePending()
  return expired
}

/**
 * 记录一条配对请求。
 *
 * 请求里的 scope 会**先按角色上限裁剪**再入账 —— 这样即使后续有人误读请求字段，
 * 也不可能批准出超出该角色能力的权限。
 *
 * **按 deviceId 去重**：同一台设备在获批之前会不断重连重试（这是正常行为，因为
 * 批准动作发生在另一台设备上），若每次都新建请求，台账会被同一个设备刷满，
 * 而且用户手里的 requestId 会在批准途中失效。因此同设备的旧请求会被就地更新，
 * requestId 保持不变。
 */
export async function createPairingRequest(
  store: HubStore,
  input: CreatePairingInput,
): Promise<PairingOutcome> {
  await sweepExpiredPairings(store)

  const state = store.state()
  const ceiling = ceilingFor(input.role)
  const requested = normalizeScopes(input.scopes)
  const clampedScopes = scopesExceeding(requested, ceiling)
  const effective = requested.filter((scope) => !clampedScopes.includes(scope))
  const now = Date.now()

  const existing = Object.values(state.pending).find(
    (candidate) => candidate.deviceId === input.deviceId,
  )
  if (existing !== undefined) {
    existing.role = input.role
    existing.scopes = effective
    existing.platform = input.platform
    existing.clientId = input.clientId
    existing.remoteIp = input.remoteIp
    existing.fromLoopback = input.fromLoopback
    if (input.displayName !== undefined) existing.displayName = input.displayName
    // 每次重试都续期，但 requestedAtMs 保持不变 ——
    // 它记录的是"这台设备最早什么时候来申请过"，是审计信息，不该被重试冲刷。
    existing.expiresAtMs = now + PAIRING_TTL_MS
    await store.savePending()
    return { request: existing, clampedScopes }
  }

  const request: PairingRequest = {
    requestId: newId('pair'),
    deviceId: input.deviceId,
    publicKey: input.publicKey,
    role: input.role,
    scopes: effective,
    platform: input.platform,
    clientId: input.clientId,
    requestedAtMs: now,
    expiresAtMs: now + PAIRING_TTL_MS,
    fromLoopback: input.fromLoopback,
    remoteIp: input.remoteIp,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
  }
  state.pending[request.requestId] = request
  await store.savePending()
  return { request, clampedScopes }
}

/**
 * 判定一条请求是否可自动批准。
 *
 * 三个条件**全部**满足才行，对齐 OpenClaw 的保守姿态：
 *   - 请求来自回环地址，或来源 IP 落在显式配置的 CIDR 白名单内；
 *   - 是 `role: node`（控制端永不自批）；
 *   - 请求**没有**索要任何 scope。
 * 另外：设备此前从未被配对过（升级/重配不走此路径）。
 */
export function canAutoApprove(store: HubStore, request: PairingRequest): boolean {
  const state = store.state()
  if (state.paired[request.deviceId] !== undefined) return false
  if (request.role !== 'node') return false
  if (request.scopes.length > 0) return false
  if (request.fromLoopback) return true
  return state.config.autoApproveCidrs.some((cidr) => ipInCidr(request.remoteIp, cidr))
}

export interface ApproveResult {
  device: PairedDevice
  /**
   * 该设备尚未领取令牌，将在它下一次成功握手时由服务端签发并随 `hello-ok` 下发。
   *
   * 这样设计是为了省掉"把令牌从 Hub 机器抄到终端上"这一步：
   * 设备已经用私钥签了挑战，能签就证明它确实是那台设备，令牌只是后续连接的凭据。
   */
  tokenClaimable: true
}

/**
 * 批准配对。**不在这里签发令牌** —— 见 `PairedDevice.tokenClaimed` 的说明。
 *
 * `approvedScopes` 若给出，必须是请求里已经过上限裁剪的子集；
 * 若省略，则采用请求的 scope（可能为空 —— 那是"可以连上但什么都不能做"的合法状态）。
 */
export async function approvePairing(
  store: HubStore,
  requestId: string,
  approverDeviceId: string,
  options: {
    approvedScopes?: readonly Scope[]
    displayName?: string
    /** 把设备绑定到某个员工（员工自己的凭据就是这么发的，见 PairedDevice.boundEmployeeId） */
    boundEmployeeId?: string
  } = {},
): Promise<ApproveResult> {
  const state = store.state()
  const request = state.pending[requestId]
  if (request === undefined) throw new Error(`unknown pairing request ${requestId}`)
  if (request.expiresAtMs <= Date.now()) {
    // 过期请求不可批准：先清掉，再明确报错（而不是让用户以为批准成功了）
    delete state.pending[requestId]
    await store.savePending()
    throw new Error(
      `pairing request ${requestId} expired; the device will file a fresh request on its next retry`,
    )
  }

  /* 绑定前先确认这个员工真的存在：把一个不存在的 id 写进设备台账，会得到一台
     "看着配好了、一调用就 not-found"的设备 —— 失败点离原因太远，排查很贵。 */
  if (options.boundEmployeeId !== undefined) {
    if (request.role !== 'operator') {
      throw new Error(
        `refusing to bind an employee to a "${request.role}" device: 只有 operator 设备代表"某个人"`,
      )
    }
    if (state.employees[options.boundEmployeeId] === undefined) {
      throw new Error(
        `unknown employee "${options.boundEmployeeId}"; 先用 dse rpc employee.list 看确切 id`,
      )
    }
  }

  const ceiling = ceilingFor(request.role)
  const desired =
    options.approvedScopes === undefined
      ? request.scopes
      : normalizeScopes(options.approvedScopes)

  // 双保险：即使调用方传了越权 scope，也在这里再裁一次
  const exceeding = scopesExceeding(desired, ceiling)
  if (exceeding.length > 0) {
    throw new Error(
      `refusing to approve scopes beyond role "${request.role}" ceiling: ${exceeding.join(', ')}`,
    )
  }

  const now = Date.now()
  const displayName = options.displayName ?? request.displayName
  const device: PairedDevice = {
    deviceId: request.deviceId,
    publicKey: request.publicKey,
    role: request.role,
    approvedScopes: desired,
    platform: request.platform,
    clientId: request.clientId,
    pairedAtMs: now,
    pairedBy: approverDeviceId,
    tokenHash: '',
    tokenClaimed: false,
    tokenIssuedAtMs: 0,
    revoked: false,
    ...(displayName === undefined ? {} : { displayName }),
    ...(options.boundEmployeeId === undefined ? {} : { boundEmployeeId: options.boundEmployeeId }),
  }

  state.paired[device.deviceId] = device
  delete state.pending[requestId]
  await store.savePaired()
  await store.savePending()
  return { device, tokenClaimable: true }
}

/**
 * 设备首次领取令牌。仅在 `tokenClaimed` 为假时有效，且**只能领一次**。
 *
 * 调用点必须已经完成签名校验 —— 这个前提由 `Hub#handleConnect` 保证。
 */
export async function claimToken(
  store: HubStore,
  deviceId: string,
): Promise<{ device: PairedDevice; token: string }> {
  const state = store.state()
  const device = state.paired[deviceId]
  if (device === undefined) throw new Error(`device ${deviceId} is not paired`)
  if (device.revoked) throw new Error(`device ${deviceId} token is revoked`)
  if (device.tokenClaimed) throw new Error(`device ${deviceId} has already claimed its token`)

  const token = newDeviceToken()
  device.tokenHash = hashToken(token)
  device.tokenClaimed = true
  device.tokenIssuedAtMs = Date.now()
  await store.savePaired()
  return { device, token }
}

export async function rejectPairing(
  store: HubStore,
  requestId: string,
): Promise<PairingRequest> {
  const state = store.state()
  const request = state.pending[requestId]
  if (request === undefined) throw new Error(`unknown pairing request ${requestId}`)
  delete state.pending[requestId]
  await store.savePending()
  return request
}

/** 移除配对记录（令牌随之失效，因为记录已不存在）。 */
export async function removePairing(store: HubStore, deviceId: string): Promise<boolean> {
  const state = store.state()
  if (state.paired[deviceId] === undefined) return false
  delete state.paired[deviceId]
  await store.savePaired()
  return true
}

/* ────────────────────────── 「允许新设备注册」窗口 ──────────────────────────
 *
 * 逻辑放在这里（而不是只写在 Hub 类里）是因为**两条入口必须同源**：
 * 控制台与运行中的 `dse pairing open/close` 都通过 Hub 写内存并落盘。Hub 停止时 CLI
 * 只读状态，不离线写配置，避免启动竞态让 Hub 内存与磁盘分叉。
 */

/** 窗口现在开着吗。默认**开着**（配置里没这个字段时）＝ 沿用旧行为，不会把老设备锁在门外。 */
export function pairingWindowOpen(config: Pick<HubConfig, 'pairingMode' | 'pairingWindowUntilMs'>, now = Date.now()): boolean {
  if (config.pairingMode === 'closed') return false
  const until = config.pairingWindowUntilMs
  /* 限时开放到点自关：只看截止时刻，不起定时器 —— 进程重启也不会把窗口"忘成"开着的。 */
  return !(typeof until === 'number' && until <= now)
}

/** 开/关窗口（**就地把 config 改掉**，落盘由调用方负责）。`openMinutes` 缺省 = 一直开着。 */
export function applyPairingWindow(
  config: HubConfig,
  options: { openMinutes?: number; close?: boolean },
  now = Date.now(),
): { open: boolean; untilMs?: number } {
  if (options.close === true) {
    config.pairingMode = 'closed'
    delete config.pairingWindowUntilMs
  } else if (options.openMinutes === undefined) {
    config.pairingMode = 'open'
    delete config.pairingWindowUntilMs
  } else {
    const minutes = Math.min(120, Math.max(1, Math.round(options.openMinutes)))
    config.pairingMode = 'open'
    config.pairingWindowUntilMs = now + minutes * 60_000
  }
  return {
    open: pairingWindowOpen(config, now),
    ...(config.pairingWindowUntilMs === undefined ? {} : { untilMs: config.pairingWindowUntilMs }),
  }
}

/** 用令牌查已配对设备。只做哈希比对，失败返回 undefined（不区分"不存在"与"令牌错"）。 */
export function findByToken(store: HubStore, token: string): PairedDevice | undefined {
  const digest = hashToken(token)
  for (const device of Object.values(store.state().paired)) {
    if (device.revoked) continue
    if (timingSafeHexEquals(device.tokenHash, digest)) return device
  }
  return undefined
}

/**
 * 轮换令牌。新令牌的 scope 仍受**配对时批准过的集合**约束 —— 这一步是
 * "轮换不能扩权"的强制点。
 */
export async function rotateToken(
  store: HubStore,
  deviceId: string,
  requestedScopes?: readonly Scope[],
): Promise<{ device: PairedDevice; token: string }> {
  const state = store.state()
  const device = state.paired[deviceId]
  if (device === undefined) throw new Error(`device ${deviceId} is not paired`)
  if (device.revoked) throw new Error(`device ${deviceId} token is revoked`)

  if (requestedScopes !== undefined) {
    const exceeding = scopesExceeding(normalizeScopes(requestedScopes), device.approvedScopes)
    if (exceeding.length > 0) {
      throw new Error(
        `refusing to rotate token with scopes beyond the approved set: ${exceeding.join(', ')}`,
      )
    }
    device.approvedScopes = normalizeScopes(requestedScopes)
  }

  const token = newDeviceToken()
  device.tokenHash = hashToken(token)
  device.tokenClaimed = true
  device.tokenIssuedAtMs = Date.now()
  await store.savePaired()
  return { device, token }
}

/** 吊销令牌。保留配对记录但令其失效。 */
export async function revokeToken(store: HubStore, deviceId: string): Promise<void> {
  const state = store.state()
  const device = state.paired[deviceId]
  if (device === undefined) throw new Error(`device ${deviceId} is not paired`)
  device.revoked = true
  await store.savePaired()
}

export async function touchDevice(
  store: HubStore,
  deviceId: string,
  remoteIp: string,
): Promise<void> {
  const device = store.state().paired[deviceId]
  if (device === undefined) return
  device.lastSeenAtMs = Date.now()
  device.lastSeenIp = remoteIp
  await store.savePaired()
}

/* ────────────────────────────── 辅助 ────────────────────────────── */

function timingSafeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * 极简 CIDR 判定，仅支持 IPv4（`a.b.c.d/n`）与裸 IPv4。
 *
 * 刻意不引入依赖：这个判定只用于"要不要自动批准配对"这一条窄用途，
 * IPv6 场景一律返回 false（= 仍需人工审批），是安全的失败方向。
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const v4 = toIpv4Int(ip)
  if (v4 === undefined) return false

  const [network, bitsRaw] = cidr.includes('/') ? cidr.split('/', 2) : [cidr, '32']
  const base = toIpv4Int(network ?? '')
  if (base === undefined) return false
  const bits = Number.parseInt(bitsRaw ?? '32', 10)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false

  if (bits === 0) return true
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (v4 & mask) === (base & mask)
}

function toIpv4Int(ip: string): number | undefined {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number.parseInt(part, 10)
    if (octet > 255) return undefined
    value = (value << 8) | octet
  }
  return value >>> 0
}
