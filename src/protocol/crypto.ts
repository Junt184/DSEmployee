/**
 * Ed25519 身份与挑战签名 —— DSEmployee 的认证根基。
 *
 * 设计要点（与 `docs/03-总体设计契约.md` §3.3 严格对应，改动须同步改文档）：
 *  - 只用 Ed25519：32 字节密钥、签名快、无参数陷阱。
 *  - `deviceId` = sha256(SPKI DER) 的小写 hex。这是"公钥指纹"，不可伪造。
 *  - 线上传输的公钥是 SPKI DER 的 base64url；私钥是 PKCS#8 PEM。
 *  - 签名对象是**规范 JSON 的 UTF-8 字节**，键顺序固定，杜绝序列化歧义。
 *  - 载荷里的 `v` 字段为将来换算法留位（当前只接受 v1）。
 *
 * 本文件不依赖任何第三方库，只用 node:crypto。
 */

import {
  createPrivateKey,
  createPublicKey,
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto'

/** 当前签名载荷版本。服务器只接受本版本。 */
export const SIGN_PAYLOAD_VERSION = 1

/** 允许的时钟偏移（毫秒）。双方 signedAt 差值超过此值即拒绝。 */
export const DEFAULT_CLOCK_SKEW_MS = 120_000

/** 挑战 nonce 的字节长度。 */
export const NONCE_BYTES = 32

export interface DeviceIdentity {
  /** sha256(SPKI DER) 小写 hex —— 公钥指纹，设备唯一标识 */
  deviceId: string
  /** SPKI DER 的 base64url 编码（可安全放进 JSON / URL） */
  publicKey: string
  /** PKCS#8 PEM 私钥。必须 0600 保管，**绝不**上线传输 */
  privateKeyPem: string
  /** 创建时间（毫秒） */
  createdAtMs: number
}

/** 连接握手时客户端提交的设备证明。 */
export interface DeviceProof {
  id: string
  publicKey: string
  signature: string
  signedAt: number
  nonce: string
}

/** 待签名载荷的输入。 */
export interface ConnectPayloadInput {
  deviceId: string
  clientId: string
  role: string
  scopes: readonly string[]
  nonce: string
  signedAt: number
  platform: string
}

/* ────────────────────────────── 编解码工具 ────────────────────────────── */

export function toBase64Url(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function fromBase64Url(text: string): Buffer {
  return Buffer.from(text, 'base64url')
}

/** sha256 → 小写 hex。 */
export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 生成一个密码学随机的挑战 nonce（base64url）。 */
export function createNonce(): string {
  return toBase64Url(randomBytes(NONCE_BYTES))
}

/* ────────────────────────────── 身份生成与解析 ────────────────────────────── */

export function generateIdentity(now: number = Date.now()): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return {
    deviceId: sha256Hex(der),
    publicKey: toBase64Url(der),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    createdAtMs: now,
  }
}

/** 从 base64url 公钥解析出 KeyObject；格式非法时抛错。 */
export function publicKeyFromWire(publicKeyB64Url: string): KeyObject {
  const der = fromBase64Url(publicKeyB64Url)
  return createPublicKey({ key: der, format: 'der', type: 'spki' })
}

/** 由公钥 base64url 计算指纹。用于校验 `device.id` 与公钥是否自洽。 */
export function fingerprintOf(publicKeyB64Url: string): string {
  return sha256Hex(fromBase64Url(publicKeyB64Url))
}

/**
 * 常量时间比较两个 hex 指纹，避免时序侧信道。
 * 长度不同直接返回 false（长度本身不是秘密）。
 */
export function fingerprintEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/* ────────────────────────── 规范载荷与签名 ────────────────────────── */

/**
 * 构造待签名的规范 JSON 字符串。
 *
 * **键顺序是线协议的一部分**：`v, deviceId, clientId, role, scopes, nonce, signedAt, platform`。
 * `scopes` 会先排序并去重，因此调用方给出的顺序不影响签名结果。
 * 任何字段的增删改都必须提升 `SIGN_PAYLOAD_VERSION`。
 */
export function canonicalConnectPayload(input: ConnectPayloadInput): string {
  const scopes = [...new Set(input.scopes)].sort()
  return JSON.stringify({
    v: SIGN_PAYLOAD_VERSION,
    deviceId: input.deviceId,
    clientId: input.clientId,
    role: input.role,
    scopes,
    nonce: input.nonce,
    signedAt: input.signedAt,
    platform: input.platform,
  })
}

/** 用 PKCS#8 PEM 私钥对规范载荷签名，返回 base64url 签名。 */
export function signConnectPayload(privateKeyPem: string, payload: string): string {
  const key = createPrivateKey(privateKeyPem)
  return toBase64Url(cryptoSign(null, Buffer.from(payload, 'utf8'), key))
}

/**
 * 验签。任何一步失败都返回 false，**不抛错**，且不泄露失败原因
 * （原因分类由调用方在通过结构校验后按需推导）。
 */
export function verifyConnectPayload(
  publicKeyB64Url: string,
  payload: string,
  signatureB64Url: string,
): boolean {
  try {
    const key = publicKeyFromWire(publicKeyB64Url)
    return cryptoVerify(
      null,
      Buffer.from(payload, 'utf8'),
      key,
      fromBase64Url(signatureB64Url),
    )
  } catch {
    return false
  }
}

/* ────────────────────────── 一次性 nonce 台账 ────────────────────────── */

/**
 * 挑战 nonce 的一次性台账，防重放。
 *
 * 每个 nonce 只能成功使用一次；过期条目由 `sweep()` 清理。
 * 刻意保持极简：内存态即可 —— nonce 的有效期只有一次握手那么长，
 * 进程重启导致台账丢失时，旧 nonce 也已超过时钟偏移窗口。
 */
export class NonceLedger {
  readonly #used = new Map<string, number>()
  readonly #ttlMs: number

  constructor(ttlMs: number = DEFAULT_CLOCK_SKEW_MS * 2) {
    this.#ttlMs = ttlMs
  }

  /** 尝试占用一个 nonce。返回 false 表示已被用过（重放）。 */
  claim(nonce: string, now: number = Date.now()): boolean {
    this.sweep(now)
    if (this.#used.has(nonce)) return false
    this.#used.set(nonce, now)
    return true
  }

  /** 清理过期条目，返回清理数量。 */
  sweep(now: number = Date.now()): number {
    let removed = 0
    for (const [nonce, at] of this.#used) {
      if (now - at > this.#ttlMs) {
        this.#used.delete(nonce)
        removed += 1
      }
    }
    return removed
  }

  get size(): number {
    return this.#used.size
  }
}
