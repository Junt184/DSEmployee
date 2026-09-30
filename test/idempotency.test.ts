/** Hub 幂等语义：同一设备的同一 key 只执行一次，并在重启后重放原响应。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import { Hub, type HubAddress } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { HubClient } from '../src/client/hub-client.ts'

let tmpRoot = ''
let home = ''
let hub: Hub
let address: HubAddress

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-idempotency-'))
  home = path.join(tmpRoot, 'home')
  hub = new Hub({ home, port: 0 })
  address = await hub.start()
})

after(async () => {
  await hub.stop()
  await rm(tmpRoot, { recursive: true, force: true })
})

async function makeClient(label: string, token?: string): Promise<HubClient> {
  return await HubClient.create({
    identityFile: path.join(home, 'client', `${label}.json`),
    url: address.wsUrl,
    role: 'operator',
    scopes: ['device.pair'] as never,
    clientId: 'dse-test',
    displayName: label,
    autoReconnect: false,
    ...(token === undefined ? {} : { token }),
  })
}

async function pairClient(label: string): Promise<HubClient> {
  const probe = await makeClient(label)
  await assert.rejects(() => probe.connect())
  probe.close()

  const store = new HubStore(home)
  await store.load()
  const request = Object.values(store.state().pending).find((item) => item.displayName === label)
  assert.ok(request)
  await approvePairing(store, request.requestId, 'test', { approvedScopes: ['device.pair'] as never })

  const client = await makeClient(label)
  await client.connect()
  return client
}

describe('RPC 幂等键', () => {
  it('重复请求重放原响应而不再次执行；参数不同时拒绝；Hub 重启后仍能重放', async () => {
    let client = await pairClient('idempotency-restart')
    const key = 'pairing-window-close-once'
    const closed = (await client.call<{ open: boolean }>(
      'pairing.window.set',
      { open: false },
      { idempotencyKey: key },
    ))
    assert.equal(closed.open, false)
    assert.equal(hub.pairingWindowOpen(), false)

    // 用另一个 key 改变实际状态。重放第一个 key 必须返回缓存结果，但不能再关一次。
    const opened = (await client.call<{ open: boolean }>(
      'pairing.window.set',
      { open: true, minutes: 15 },
      { idempotencyKey: 'pairing-window-open-again' },
    ))
    assert.equal(opened.open, true)
    const replay = (await client.call<{ open: boolean }>(
      'pairing.window.set',
      { open: false },
      { idempotencyKey: key },
    ))
    assert.equal(replay.open, false, '相同 key 重放应返回第一次的响应')
    assert.equal(hub.pairingWindowOpen(), true, '重放不得再次执行 handler')

    await assert.rejects(
      () => client.call('pairing.window.set', { open: true, minutes: 15 }, { idempotencyKey: key }),
      /already used with a different method or params/,
    )
    assert.equal(hub.pairingWindowOpen(), true, '同 key 换参数必须拒绝且不能产生副作用')

    const token = client.deviceToken
    assert.ok(token)
    client.close()
    await hub.stop()
    hub = new Hub({ home, port: 0 })
    address = await hub.start()
    client = await makeClient('idempotency-restart', token)
    await client.connect()

    const replayAfterRestart = (await client.call<{ open: boolean }>(
      'pairing.window.set',
      { open: false },
      { idempotencyKey: key },
    ))
    assert.equal(replayAfterRestart.open, false, '缓存响应须在 Hub 重启后仍存在')
    assert.equal(hub.pairingWindowOpen(), true, '重启后的重放同样不能重新执行副作用')
    client.close()
  })

  it('参数对象键顺序不同的并发重试仍只执行一次', async () => {
    const client = await pairClient('idempotency-stable-order')
    const [first, second] = await Promise.all([
      client.call('pairing.window.set', { open: true, minutes: 15 }, { idempotencyKey: 'stable-order' }),
      client.call('pairing.window.set', { minutes: 15, open: true }, { idempotencyKey: 'stable-order' }),
    ])
    assert.deepEqual(second, first)
    client.close()
  })

  it('重启后遇到未完成的持久化预约时拒绝重跑，避免不确定副作用重复', async () => {
    const client = await pairClient('idempotency-interrupted')
    await hub.setPairingWindow({ openMinutes: 15 })
    const key = 'interrupted-operation'
    const cacheId = createHash('sha256').update(client.identity.deviceId).update('\0').update(key).digest('hex')
    const paramsHash = createHash('sha256').update('pairing.window.set').update('\0').update('{"open":false}').digest('hex')
    hub.state().idempotency[cacheId] = {
      deviceId: client.identity.deviceId,
      key,
      method: 'pairing.window.set',
      paramsHash,
      status: 'running',
      createdAtMs: Date.now(),
    }
    await hub.store.saveIdempotency()
    const token = client.deviceToken
    assert.ok(token)
    client.close()

    await hub.stop()
    hub = new Hub({ home, port: 0 })
    address = await hub.start()
    const afterRestart = await makeClient('idempotency-interrupted', token)
    await afterRestart.connect()
    await assert.rejects(
      () => afterRestart.call('pairing.window.set', { open: false }, { idempotencyKey: key }),
      /previous attempt was interrupted.*refusing to execute it again/,
    )
    assert.equal(hub.pairingWindowOpen(), true, 'outcome unknown 的旧操作不能被再次执行')
    afterRestart.close()
  })
})
