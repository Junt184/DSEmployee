/**
 * 协议层测试 —— 重点覆盖认证根基（Ed25519 身份、指纹、挑战签名、防重放）。
 * 认证是整套系统的信任基础，这里必须比别处更严。
 *
 * 运行：npm test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  NonceLedger,
  canonicalConnectPayload,
  createNonce,
  fingerprintEquals,
  fingerprintOf,
  generateIdentity,
  normalizeScopes,
  parseFrame,
  publicKeyFromWire,
  scopeSatisfies,
  scopesExceeding,
  signConnectPayload,
  verifyConnectPayload,
  type ConnectPayloadInput,
} from '../src/protocol/index.ts'

function payloadInput(overrides: Partial<ConnectPayloadInput> = {}): ConnectPayloadInput {
  return {
    deviceId: '',
    clientId: 'dse-web',
    role: 'operator',
    scopes: ['employee.read', 'employee.prompt'],
    nonce: createNonce(),
    signedAt: Date.now(),
    platform: 'win32',
    ...overrides,
  }
}

describe('Ed25519 身份', () => {
  it('生成的 deviceId 等于公钥指纹', () => {
    const id = generateIdentity()
    assert.equal(id.deviceId, fingerprintOf(id.publicKey))
    assert.match(id.deviceId, /^[0-9a-f]{64}$/)
  })

  it('两次生成的身份互不相同', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    assert.notEqual(a.deviceId, b.deviceId)
    assert.notEqual(a.privateKeyPem, b.privateKeyPem)
  })

  it('公钥可被解析回 KeyObject', () => {
    const id = generateIdentity()
    const key = publicKeyFromWire(id.publicKey)
    assert.equal(key.asymmetricKeyType, 'ed25519')
  })
})

describe('挑战签名', () => {
  it('签名可被对应公钥验证通过', () => {
    const id = generateIdentity()
    const input = payloadInput({ deviceId: id.deviceId })
    const payload = canonicalConnectPayload(input)
    const signature = signConnectPayload(id.privateKeyPem, payload)
    assert.equal(verifyConnectPayload(id.publicKey, payload, signature), true)
  })

  it('换一把无关公钥验签失败', () => {
    const signer = generateIdentity()
    const attacker = generateIdentity()
    const payload = canonicalConnectPayload(payloadInput({ deviceId: signer.deviceId }))
    const signature = signConnectPayload(signer.privateKeyPem, payload)
    assert.equal(verifyConnectPayload(attacker.publicKey, payload, signature), false)
  })

  it('篡改载荷任一字段都会导致验签失败', () => {
    const id = generateIdentity()
    const input = payloadInput({ deviceId: id.deviceId })
    const payload = canonicalConnectPayload(input)
    const signature = signConnectPayload(id.privateKeyPem, payload)

    // 攻击者试图把自己提权成 employee.manage
    const tampered = canonicalConnectPayload({
      ...input,
      scopes: [...input.scopes, 'employee.manage'],
    })
    assert.notEqual(tampered, payload)
    assert.equal(verifyConnectPayload(id.publicKey, tampered, signature), false)

    // 试图换角色
    const tamperedRole = canonicalConnectPayload({ ...input, role: 'node' })
    assert.equal(verifyConnectPayload(id.publicKey, tamperedRole, signature), false)

    // 试图换 nonce
    const tamperedNonce = canonicalConnectPayload({ ...input, nonce: createNonce() })
    assert.equal(verifyConnectPayload(id.publicKey, tamperedNonce, signature), false)
  })

  it('签名载荷对 scopes 顺序不敏感（排序后签名）', () => {
    const id = generateIdentity()
    // 关键：两次比较必须用同一个 nonce，否则比较的是 nonce 而不是 scopes 顺序
    const base = payloadInput({ deviceId: id.deviceId })
    const a = canonicalConnectPayload({
      ...base,
      scopes: ['employee.prompt', 'employee.read'],
    })
    const b = canonicalConnectPayload({
      ...base,
      scopes: ['employee.read', 'employee.read', 'employee.prompt'],
    })
    assert.equal(a, b)
  })

  it('规范载荷的键顺序固定', () => {
    const id = generateIdentity()
    const payload = canonicalConnectPayload(payloadInput({ deviceId: id.deviceId }))
    const keys = Object.keys(JSON.parse(payload))
    assert.deepEqual(keys, [
      'v',
      'deviceId',
      'clientId',
      'role',
      'scopes',
      'nonce',
      'signedAt',
      'platform',
    ])
  })

  it('非法签名输入返回 false 而不是抛异常', () => {
    const id = generateIdentity()
    const payload = canonicalConnectPayload(payloadInput({ deviceId: id.deviceId }))
    assert.equal(verifyConnectPayload(id.publicKey, payload, 'not-base64!!'), false)
    assert.equal(verifyConnectPayload('!!!not-a-key!!!', payload, 'AAAA'), false)
  })
})

describe('指纹比较', () => {
  it('相同指纹为真，不同为假，长度不同也不抛', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    assert.equal(fingerprintEquals(a.deviceId, a.deviceId), true)
    assert.equal(fingerprintEquals(a.deviceId, b.deviceId), false)
    assert.equal(fingerprintEquals(a.deviceId, 'short'), false)
  })
})

describe('一次性 nonce 台账（防重放）', () => {
  it('同一个 nonce 只能占用一次', () => {
    const ledger = new NonceLedger()
    const nonce = createNonce()
    assert.equal(ledger.claim(nonce), true)
    assert.equal(ledger.claim(nonce), false, '重放必须被拒')
  })

  it('过期后可清理', () => {
    const ledger = new NonceLedger(1000)
    const nonce = createNonce()
    assert.equal(ledger.claim(nonce, 10_000), true)
    assert.equal(ledger.sweep(10_500), 0)
    assert.equal(ledger.sweep(12_000), 1)
    assert.equal(ledger.size, 0)
  })
})

describe('帧解析', () => {
  it('接受合法的 req / res / event', () => {
    const req = parseFrame(JSON.stringify({ type: 'req', id: '1', method: 'health' }))
    assert.equal(req.ok, true)

    const res = parseFrame(
      JSON.stringify({ type: 'res', id: '1', ok: true, payload: { ok: 1 } }),
    )
    assert.equal(res.ok, true)

    const evt = parseFrame(JSON.stringify({ type: 'event', event: 'tick', payload: {} }))
    assert.equal(evt.ok, true)
  })

  it('拒绝未知事件名（fail-closed）', () => {
    const result = parseFrame(JSON.stringify({ type: 'event', event: 'evil.event' }))
    assert.equal(result.ok, false)
  })

  it('拒绝未知错误码', () => {
    const result = parseFrame(
      JSON.stringify({ type: 'res', id: '1', ok: false, error: { code: 'nope', message: 'x' } }),
    )
    assert.equal(result.ok, false)
  })

  it('拒绝非 JSON 与未知帧类型', () => {
    assert.equal(parseFrame('{oops').ok, false)
    assert.equal(parseFrame(JSON.stringify({ type: 'weird' })).ok, false)
    assert.equal(parseFrame(JSON.stringify({ type: 'req', method: 'x' })).ok, false, '缺 id')
  })
})

describe('权限域', () => {
  it('normalizeScopes 过滤非法项、去重、排序', () => {
    assert.deepEqual(
      normalizeScopes(['employee.prompt', 'bogus', 'employee.read', 'employee.prompt']),
      ['employee.prompt', 'employee.read'],
    )
  })

  it('空 required 表示认证后即可用', () => {
    assert.equal(scopeSatisfies([], []), true)
  })

  it('缺少任一 required 即不足', () => {
    assert.equal(scopeSatisfies(['employee.read'], ['employee.read', 'employee.prompt']), false)
    assert.equal(
      scopeSatisfies(['employee.read', 'employee.prompt'], ['employee.read', 'employee.prompt']),
      true,
    )
  })

  it('能算出越权的 scope（用于"令牌不可自我扩权"）', () => {
    assert.deepEqual(scopesExceeding(['employee.read', 'device.pair'], ['employee.read']), [
      'device.pair',
    ])
    assert.deepEqual(scopesExceeding(['employee.read'], ['employee.read']), [])
  })
})
