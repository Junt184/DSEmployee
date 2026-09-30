/**
 * Web Push（手机通知）—— 加密与鉴权这两块最容易"静默写错"的地方。
 *
 * 为什么这一组重点是**解密回来**：推送格式（RFC 8291 / RFC 8188）一旦某个字段顺序、
 * HKDF 的 info 串、record 结束标记或 JWT 的签名编码写错，症状全都一样 ——
 * 推送服务回 4xx 或干脆丢掉，手机上什么都不出现，而日志里看不出"是哪一步错了"。
 * 所以这里用**接收方的私钥**把密文解回明文，把每一步都钉住。
 *
 * VAPID 的 JWT 同样验到底：解出 header/claims，并用公钥**验签**。
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { tmpdir } from 'node:os'

import {
  encryptPushPayload,
  loadOrCreateVapidKeys,
  sendToAll,
  upsertSubscription,
  vapidAuthHeader,
} from '../src/hub/push.ts'
import type { PushSubscriptionRecord } from '../src/hub/types.ts'

function b64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(text: string): Buffer {
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/** 造一对"浏览器侧"的密钥（p256dh + auth），并能解密收到的推送。 */
function makeReceiver(): { record: { p256dh: string; auth: string }; decrypt: (body: Buffer) => string } {
  const ua = crypto.createECDH('prime256v1')
  ua.generateKeys()
  const authSecret = crypto.randomBytes(16)
  return {
    record: { p256dh: b64url(ua.getPublicKey()), auth: b64url(authSecret) },
    decrypt: (body: Buffer): string => {
      /* 解析 RFC 8188 记录：salt(16) | rs(4) | idlen(1) | keyid(65) | ciphertext */
      const salt = body.subarray(0, 16)
      const rs = body.readUInt32BE(16)
      assert.equal(rs, 4096, 'rs（记录大小）应为 4096')
      const idlen = body[20] ?? 0
      assert.equal(idlen, 65, 'keyid 必须是 65 字节的未压缩公钥')
      const asPublic = body.subarray(21, 21 + idlen)
      const ciphertext = body.subarray(21 + idlen)

      const shared = ua.computeSecret(asPublic)
      const ikm = Buffer.from(
        crypto.hkdfSync(
          'sha256',
          shared,
          authSecret,
          Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]),
          32,
        ),
      )
      const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
      const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))

      const tag = ciphertext.subarray(ciphertext.length - 16)
      const data = ciphertext.subarray(0, ciphertext.length - 16)
      const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce)
      decipher.setAuthTag(tag)
      const plain = Buffer.concat([decipher.update(data), decipher.final()])
      /* 去掉最后一条记录的定界符 0x02 */
      assert.equal(plain[plain.length - 1], 0x02, '最后一条记录要以 0x02 结尾')
      return plain.subarray(0, plain.length - 1).toString('utf8')
    },
  }
}

describe('载荷加密（RFC 8291）能用接收方的私钥解回来', () => {
  it('往返成功：字段顺序、HKDF info、记录定界符全都对才行', () => {
    const receiver = makeReceiver()
    const payload = Buffer.from(JSON.stringify({ title: '审批来了', body: '小艾在等你批准' }), 'utf8')
    const body = encryptPushPayload({ payload, p256dh: receiver.record.p256dh, auth: receiver.record.auth })
    const roundTrip = receiver.decrypt(body)
    assert.deepEqual(JSON.parse(roundTrip), { title: '审批来了', body: '小艾在等你批准' })
  })

  it('每次加密用新盐与新临时密钥（否则同一段明文密文相同，可被关联）', () => {
    const receiver = makeReceiver()
    const payload = Buffer.from('一样的内容', 'utf8')
    const a = encryptPushPayload({ payload, p256dh: receiver.record.p256dh, auth: receiver.record.auth })
    const b = encryptPushPayload({ payload, p256dh: receiver.record.p256dh, auth: receiver.record.auth })
    assert.notEqual(a.toString('base64'), b.toString('base64'))
    assert.notEqual(a.subarray(0, 16).toString('hex'), b.subarray(0, 16).toString('hex'), '盐不能复用')
  })

  it('中文与 emoji 也能原样往返（按 UTF-8 字节走，不是按字符）', () => {
    const receiver = makeReceiver()
    const text = '浅夏的汇报好了 ✅ 3 条需要你决定'
    const body = encryptPushPayload({
      payload: Buffer.from(text, 'utf8'),
      p256dh: receiver.record.p256dh,
      auth: receiver.record.auth,
    })
    assert.equal(receiver.decrypt(body), text)
  })
})

describe('VAPID 鉴权头（RFC 8292）', () => {
  it('JWT 三段齐全，claims 里有 aud/exp/sub，且签名能用公钥验过', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dse-push-'))
    try {
      const keys = await loadOrCreateVapidKeys({ stateDir: dir, subject: 'mailto:me@example.com' })
      const header = vapidAuthHeader({ keys, endpoint: 'https://push.example.com/x/y/z', now: 1_700_000_000_000 })
      const match = /^vapid t=([^,]+), k=(.+)$/.exec(header)
      assert.ok(match !== null, 'VAPID 头形如 "vapid t=<jwt>, k=<公钥>"')
      const jwt = match[1] ?? ''
      const [h, c, s] = jwt.split('.')
      assert.ok(h !== undefined && c !== undefined && s !== undefined, 'JWT 必须三段')
      const decodedHeader = JSON.parse(fromB64url(h).toString('utf8'))
      const claims = JSON.parse(fromB64url(c).toString('utf8'))
      assert.deepEqual(decodedHeader, { typ: 'JWT', alg: 'ES256' })
      assert.equal(claims.aud, 'https://push.example.com', 'aud 是推送服务的 origin，不是完整路径')
      assert.equal(claims.sub, 'mailto:me@example.com')
      assert.ok(claims.exp > 1_700_000_000, 'exp 在未来')
      assert.ok(claims.exp <= 1_700_000_000 + 24 * 3600, 'exp 不超过 24 小时（规范上限）')

      /* 验签：把公钥（未压缩点）转成 JWK 再验，确保签名是 raw r||s 而非 DER */
      const publicBytes = fromB64url(match[2] ?? '')
      assert.equal(publicBytes.length, 65)
      const verified = crypto.verify(
        'sha256',
        Buffer.from(`${h}.${c}`),
        {
          key: crypto.createPublicKey({
            key: {
              kty: 'EC',
              crv: 'P-256',
              x: b64url(publicBytes.subarray(1, 33)),
              y: b64url(publicBytes.subarray(33, 65)),
            },
            format: 'jwk',
          }),
          /* JWS 的 ES256 签名是 raw r||s（RFC 7518），不是 DER —— 验签这一侧也要说明，
             否则默认按 DER 解，结果永远是 false（第一次就踩了这个，且看起来像"签名错了"）。 */
          dsaEncoding: 'ieee-p1363',
        },
        fromB64url(s),
      )
      assert.equal(verified, true, 'ES256 签名要能验过（raw r||s 编码）')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('密钥持久化：第二次读到的还是同一对（换密钥会让所有订阅失效）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dse-push-'))
    try {
      const first = await loadOrCreateVapidKeys({ stateDir: dir })
      const second = await loadOrCreateVapidKeys({ stateDir: dir })
      assert.deepEqual(second, first)
      const raw = JSON.parse(await readFile(path.join(dir, 'push-keys.json'), 'utf8'))
      assert.equal(raw.publicKey, first.publicKey)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('发送：失效订阅要清掉，其它失败不影响主流程', () => {
  function makeHubStub(): {
    hub: unknown
    state: { pushSubscriptions: Record<string, PushSubscriptionRecord> }
    saved: number
    logs: string[]
  } {
    const state = { pushSubscriptions: {} as Record<string, PushSubscriptionRecord> }
    const box = { saved: 0, logs: [] as string[] }
    const hub = {
      state: () => state,
      store: {
        savePushSubscriptions: async () => {
          box.saved += 1
        },
      },
      log: (message: string) => void box.logs.push(message),
      vapidKeys: async () => ({ publicKey: '', privateKey: '', subject: 'mailto:x@y' }),
    }
    return { hub, state, get saved() { return box.saved }, logs: box.logs } as never
  }

  it('410/404 ⇒ 删掉那条订阅（否则一直打电话给空号）', async () => {
    const stub = makeHubStub() as unknown as {
      hub: unknown
      state: { pushSubscriptions: Record<string, PushSubscriptionRecord> }
      saved: number
    }
    const receiver = makeReceiver()
    upsertSubscription(stub.state, {
      endpoint: 'https://push.example.com/gone',
      keys: receiver.record,
      createdAtMs: 1,
    })
    const dir = await mkdtemp(path.join(tmpdir(), 'dse-push-'))
    const keys = await loadOrCreateVapidKeys({ stateDir: dir })
    const result = await sendToAll(
      stub.hub as never,
      { title: 't', body: 'b' },
      {
        vapid: keys,
        fetchImpl: (async () => new Response('gone', { status: 410 })) as unknown as typeof fetch,
      },
    )
    await rm(dir, { recursive: true, force: true })
    assert.equal(result.dropped, 1)
    assert.equal(Object.keys(stub.state.pushSubscriptions).length, 0, '失效订阅必须被删掉')
    assert.equal(result.sent, 0)
  })

  it('5xx ⇒ 只记失败，不删订阅（对方可能只是暂时抽风）', async () => {
    const stub = makeHubStub() as unknown as {
      hub: unknown
      state: { pushSubscriptions: Record<string, PushSubscriptionRecord> }
    }
    const receiver = makeReceiver()
    upsertSubscription(stub.state, {
      endpoint: 'https://push.example.com/boom',
      keys: receiver.record,
      createdAtMs: 1,
    })
    const dir2 = await mkdtemp(path.join(tmpdir(), 'dse-push-'))
    const keys2 = await loadOrCreateVapidKeys({ stateDir: dir2 })
    const result = await sendToAll(
      stub.hub as never,
      { title: 't', body: 'b' },
      {
        vapid: keys2,
        fetchImpl: (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch,
      },
    )
    await rm(dir2, { recursive: true, force: true })
    assert.equal(result.failed, 1)
    assert.equal(Object.keys(stub.state.pushSubscriptions).length, 1, '暂时失败不该删订阅')
  })

  it('发送时真的带上了 aes128gcm 与 VAPID 头，且正文是能解回来的密文', async () => {
    const stub = makeHubStub() as unknown as {
      hub: unknown
      state: { pushSubscriptions: Record<string, PushSubscriptionRecord> }
    }
    const receiver = makeReceiver()
    upsertSubscription(stub.state, {
      endpoint: 'https://push.example.com/ok',
      keys: receiver.record,
      createdAtMs: 1,
    })
    /* 用真实的 VAPID 密钥（sign 需要合法私钥），但 fetch 用替身 */
    const dir = await mkdtemp(path.join(tmpdir(), 'dse-push-'))
    try {
      const keys = await loadOrCreateVapidKeys({ stateDir: dir })
      let captured: { headers: Headers; body: Buffer } | undefined
      const result = await sendToAll(
        stub.hub as never,
        { title: '调度器', body: '浅夏的汇报好了' },
        {
          vapid: keys,
          fetchImpl: (async (_url: string, init: RequestInit) => {
            captured = { headers: new Headers(init.headers as Record<string, string>), body: Buffer.from(init.body as Buffer) }
            return new Response('ok', { status: 201 })
          }) as unknown as typeof fetch,
        },
      )
      assert.equal(result.sent, 1)
      assert.equal(captured?.headers.get('content-encoding'), 'aes128gcm')
      assert.match(captured?.headers.get('authorization') ?? '', /^vapid t=/)
      const plain = receiver.decrypt(captured?.body ?? Buffer.alloc(0))
      assert.deepEqual(JSON.parse(plain), { title: '调度器', body: '浅夏的汇报好了' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
