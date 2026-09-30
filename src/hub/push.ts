/**
 * Web Push（手机通知）—— 让"有事发生"能推到人的手机上。
 *
 * 为什么走 Web Push 而不是钉钉/微信：控制台本身就是 PWA（manifest + service worker
 * 都在 ✓），"添加到主屏幕"之后就是一个正规的应用形态；Web Push 是它的标准能力，
 * **不需要任何第三方登录态**。这一点很实在：终端节点那台机器往往从来没登录过钉钉，
 * 而"让员工自己发钉钉"这种设计在那种机器上等于不存在（真实教训）。
 *
 * 这一层只做三件事：
 *   1. 保管 VAPID 密钥与每个设备的订阅（订阅会过期，见 `sendToAll` 里的 404/410 处理）；
 *   2. 按 RFC 8291（aes128gcm）把载荷加密成推送服务能转发的密文；
 *   3. 按 RFC 8292 用 ES256 JWT 做 VAPID 鉴权后 POST 出去。
 *
 * ⚠️ 加密部分**故意不引第三方依赖**（本仓运行时只有 ws + zod）：这套格式一旦写错，
 * 症状是"推送静默不到"——最难查的一类。所以 test/push.test.ts 用接收方的私钥**解密回来**
 * 验往返（RFC 8291 的字段顺序、HKDF 的 info 串、record 结束标记全都得对才行）。
 *
 * ⚠️ 隐私：推送内容会经由浏览器厂商的推送服务（Apple/Google/Mozilla）转发。所以
 * `push.notify` 的正文刻意限制得很短（默认只给一句提示 + 计数），**不要把汇报正文塞进去**。
 */

import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'

import type { Hub } from './server.ts'
import type { PushSubscriptionRecord } from './types.ts'

/** 单条推送的超时：推送服务不响应时**不能拖住调用方**（通知是顺手提醒，不是投递）。 */
export const PUSH_TIMEOUT_MS = 10_000

/** 推送载荷上限：厂商各有上限（约 4KB），正文本身也该短。 */
export const PUSH_MAX_PAYLOAD_BYTES = 3500
/** 默认的 TTL：推不出去就丢，别在厂商那边积压太久。 */
export const PUSH_TTL_SECONDS = 12 * 60 * 60
/** VAPID JWT 有效期（规范上限 24h）。 */
const VAPID_JWT_TTL_SECONDS = 12 * 60 * 60

export interface VapidKeys {
  publicKey: string
  privateKey: string
  subject: string
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(text: string): Buffer {
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/**
 * 取（或首次生成）VAPID 密钥。
 *
 * 公钥要交给浏览器（`applicationServerKey`），私钥只留在 Hub 上。密钥必须**持久**：
 * 换了密钥，所有已存在的订阅都会被推送服务拒掉（表现同样是"静默不到"）。
 */
export async function loadOrCreateVapidKeys(options: {
  stateDir: string
  subject?: string
}): Promise<VapidKeys> {
  const file = path.join(options.stateDir, 'push-keys.json')
  /* VAPID 的 sub（RFC 8292 要求 mailto: 或 https:）。默认给 mailto，但**允许用环境变量
     换成 https URI** —— Apple 的推送服务对 mailto 里的域名相当挑，403 就是它给的回应。 */
  const subject = options.subject ?? process.env['DSE_PUSH_SUBJECT'] ?? 'mailto:dse@localhost'
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<VapidKeys>
    if (typeof raw.publicKey === 'string' && typeof raw.privateKey === 'string') {
      /* subject 以"环境变量显式给出的"为准：只读文件里的旧值会让改了配置也不生效
         （而症状是"推送一直 403"，完全看不出是 subject 没更新）。 */
      const stored = options.subject ?? raw.subject ?? subject
      return { publicKey: raw.publicKey, privateKey: raw.privateKey, subject: stored }
    }
  } catch {
    /* 不存在或坏了 —— 走生成 */
  }
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  const keys: VapidKeys = {
    publicKey: base64url(ecdh.getPublicKey()),
    privateKey: base64url(ecdh.getPrivateKey()),
    subject,
  }
  await mkdir(options.stateDir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, file)
  return keys
}

/** HKDF-SHA256（RFC 5869）。`info` 用 Buffer 拼，避免字符串编码歧义。 */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length))
}

/**
 * 按 RFC 8291 加密一条推送载荷（`aes128gcm` 内容编码，RFC 8188 的记录格式）。
 *
 * 算法步骤（顺序与串都要对，错一点就是"推不出去且没有明显报错"）：
 *   1. ECDH(as_private, ua_public) → 共享密钥
 *   2. ikm  = HKDF(auth_secret, 共享密钥, "WebPush: info\0" || ua_public || as_public, 32)
 *   3. cek  = HKDF(salt, ikm, "Content-Encoding: aes128gcm\0", 16)
 *      nonce= HKDF(salt, ikm, "Content-Encoding: nonce\0", 12)
 *   4. 明文 = payload || 0x02（最后一条记录的定界符）
 *   5. 正文 = salt(16) || rs(4, 大端) || idlen(1)=65 || as_public(65) || AES-128-GCM 密文
 */
export function encryptPushPayload(options: {
  payload: Buffer
  p256dh: string
  auth: string
}): Buffer {
  const uaPublic = fromBase64url(options.p256dh)
  const authSecret = fromBase64url(options.auth)

  const as = crypto.createECDH('prime256v1')
  as.generateKeys()
  const asPublic = as.getPublicKey()
  const shared = as.computeSecret(uaPublic)

  const ikm = hkdf(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32)
  const salt = crypto.randomBytes(16)
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12)

  const record = Buffer.concat([options.payload, Buffer.from([0x02])])
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce)
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()])

  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(4096, 0)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ciphertext])
}

/** RFC 8292 的 VAPID 鉴权头。 */
export function vapidAuthHeader(options: { keys: VapidKeys; endpoint: string; now?: number }): string {
  const audience = new URL(options.endpoint).origin
  const now = options.now ?? Date.now()
  const header = base64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = base64url(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(now / 1000) + VAPID_JWT_TTL_SECONDS,
        sub: options.keys.subject,
      }),
    ),
  )
  const signingInput = `${header}.${claims}`
  /* 用 JWK 形态导入私钥：它需要 x/y（公钥坐标）与 d（私钥标量）。
     VAPID 公钥是未压缩点 `04 || x || y`，坐标直接从里面切 —— 早先试图只给 d
     而把 x/y 留空，createPrivateKey 直接拒绝（而报错发生在推送那一刻，很难联想到密钥形态）。 */
  const publicBytes = fromBase64url(options.keys.publicKey)
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    throw new Error(`VAPID 公钥形态不对（应为 65 字节未压缩点）：${publicBytes.length} 字节`)
  }
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: base64url(publicBytes.subarray(1, 33)),
    y: base64url(publicBytes.subarray(33, 65)),
    d: options.keys.privateKey,
  }
  /* JWT 的 ES256 签名是 r||s（raw），不是 DER —— 用 dsaEncoding 指定。 */
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  })
  return `vapid t=${signingInput}.${base64url(signature)}, k=${options.keys.publicKey}`
}

export interface PushSendResult {
  sent: number
  /** 订阅已失效（404/410）被清掉的条数 */
  dropped: number
  failed: number
}

/**
 * 给所有订阅发一条通知。
 *
 * 404/410 表示**订阅已失效**（换机、清站点数据、iOS 换端点都会这样）⇒ 必须删掉，
 * 否则每次推送都在打电话给空号，而且用户永远收不到、也没人知道为什么。
 * 其它错误只记日志：推送失败不该影响主流程（它是"提醒"，不是"投递"）。
 */
export async function sendToAll(
  hub: Hub,
  payload: { title: string; body: string; tag?: string; url?: string },
  options: { fetchImpl?: typeof fetch; now?: number; vapid?: VapidKeys } = {},
): Promise<PushSendResult> {
  const state = hub.state()
  const subscriptions = Object.values(state.pushSubscriptions)
  const result: PushSendResult = { sent: 0, dropped: 0, failed: 0 }
  if (subscriptions.length === 0) return result

  const keys = options.vapid ?? (await hub.vapidKeys())
  if (keys === undefined) return result
  const doFetch = options.fetchImpl ?? fetch

  const text = JSON.stringify(payload)
  const body = text.length > PUSH_MAX_PAYLOAD_BYTES ? JSON.stringify({ ...payload, body: payload.body.slice(0, 200) + '…' }) : text

  for (const record of subscriptions) {
    try {
      const response = await doFetch(record.endpoint, {
        method: 'POST',
        /* 必须有超时：真实事故里，一个不再有人接听的 endpoint 让整条 push.notify
           卡到调用方 30 秒超时 —— 而它只是"顺手拍一下用户"，不该阻塞任何正事。 */
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        headers: {
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(PUSH_TTL_SECONDS),
          authorization: vapidAuthHeader({ keys, endpoint: record.endpoint, ...(options.now === undefined ? {} : { now: options.now }) }),
        },
        body: encryptPushPayload({
          payload: Buffer.from(body),
          p256dh: record.keys.p256dh,
          auth: record.keys.auth,
        }),
      })
      if (response.status === 404 || response.status === 410) {
        delete state.pushSubscriptions[record.endpoint]
        result.dropped += 1
        hub.log(`push: subscription gone (${response.status}) — removed ${record.endpoint.slice(0, 40)}…`)
        continue
      }
      if (!response.ok) {
        result.failed += 1
        /* 把响应正文也记下来：推送服务（尤其 Apple）会在正文里说清原因
           （BadJwtToken / BadAudience …）。只记状态码会让人对着 403 猜半天。 */
        const detail = await response.text().catch(() => '')
        hub.log(`push: ${response.status} for ${record.endpoint.slice(0, 40)}… — ${detail.slice(0, 200)}`)
        continue
      }
      result.sent += 1
    } catch (error) {
      result.failed += 1
      hub.log(`push: send failed — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (result.dropped > 0) await hub.store.savePushSubscriptions()
  return result
}

/** 存一条订阅（同一 endpoint 幂等覆盖：浏览器重订阅会给新 endpoint，旧的靠 404 清掉）。 */
export function upsertSubscription(
  state: { pushSubscriptions: Record<string, PushSubscriptionRecord> },
  record: PushSubscriptionRecord,
): PushSubscriptionRecord {
  state.pushSubscriptions[record.endpoint] = record
  return record
}
