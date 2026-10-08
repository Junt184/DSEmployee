/**
 * 新设备进门的方式（默认「只认配对码」）+ 给已配对设备改名。
 *
 * 为什么值得一整组测试：这两件事都在**安全边界**上，而且都是"看起来能用、
 * 其实少了一层"的那种改动。
 *
 *   1. 「只认配对码」要同时管住两件事，缺一件就等于没改：
 *      · 窗口**关着** ⇒ 未配对设备连**待配对记录都不产生**（否则陌生人照样能往
 *        台账里写字、往你手机上推"有新设备请求注册"，而你根本没有可处理的入口）；
 *      · 窗口**开着** ⇒ 记录照落（配对码要兑换的就是它），但人工批准必须**被服务端拒绝**
 *        —— 只在界面上藏掉按钮不算数：接口还在，谁都能调。
 *   2. 回环 node 的自动放行**不受窗口影响**：那是另一条窄路（无 scope 的节点首连），
 *      窗口关着也必须在，否则"关掉注册"会顺手把节点重连也一起掐死。
 *   3. 改名只动显示名，不动 role/scope/令牌 —— 改名不能成为任何形式的提权路径。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import {
  applyPairingApproval,
  approvePairing,
  operatorApprovalAllowed,
  pairingApprovalMode,
  rejectPairing,
} from '../src/hub/devices.ts'
import { HubCallError, HubClient } from '../src/client/hub-client.ts'

let tmpRoot = ''
let home = ''
let hub: Hub
let hubUrl = ''

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-devapproval-'))
  home = path.join(tmpRoot, 'home')
  hub = new Hub({ home, port: 0, verbose: false })
  const address = await hub.start()
  hubUrl = address.wsUrl
})

after(async () => {
  await hub.stop()
  await rm(tmpRoot, { recursive: true, force: true })
})

function identityPath(name: string): string {
  return path.join(home, 'clients', `${name}.json`)
}

async function makeClient(name: string, role: 'operator' | 'node', scopes: string[]): Promise<HubClient> {
  return await HubClient.create({
    identityFile: identityPath(name),
    url: hubUrl,
    role,
    scopes: scopes as never,
    clientId: role === 'node' ? 'dse-node' : 'dse-cli',
    displayName: name,
    autoReconnect: false,
  })
}

async function store(): Promise<HubStore> {
  const fresh = new HubStore(home)
  await fresh.load()
  return fresh
}

/** 未配对设备连一次，返回它被拒的 code 与 details。 */
async function unpairedAttempt(
  name: string,
  role: 'operator' | 'node',
  scopes: string[],
): Promise<{ code: string; requestId: unknown; deviceId: string }> {
  const client = await makeClient(name, role, scopes)
  let code = ''
  let requestId: unknown
  client.on('handshakeFailed', (error) => {
    code = error.code
    requestId = (error.details as { requestId?: string } | undefined)?.requestId
  })
  await assert.rejects(() => client.connect())
  const deviceId = client.identity.deviceId
  client.close()
  return { code, requestId, deviceId }
}

/** 走完整的「连一次 → 本地批准 → 再连一次领令牌」流程，拿一个能调接口的 operator。 */
async function approvedOperator(name: string, scopes: string[]): Promise<HubClient> {
  const probe = await makeClient(name, 'operator', scopes)
  await assert.rejects(() => probe.connect())
  probe.close()
  const current = await store()
  const request = Object.values(current.state().pending).find((r) => r.deviceId === probe.identity.deviceId)
  assert.ok(request !== undefined, `没有 ${name} 的待配对请求`)
  await approvePairing(current, request.requestId, 'test', { approvedScopes: scopes as never })
  const client = await makeClient(name, 'operator', scopes)
  await client.connect()
  return client
}

describe('进门方式：默认值与切换', () => {
  it('配置里没有这个字段时就是「只认配对码」——默认值是安全的那一个', () => {
    assert.equal(pairingApprovalMode({}), 'code-only')
    assert.equal(pairingApprovalMode({ pairingApproval: 'operator' }), 'operator')
    assert.equal(pairingApprovalMode({ pairingApproval: 'code-only' }), 'code-only')
    /* 坏值一律按最保守的那个理解：宁可让人来问"我的设置怎么没生效"，
       也不能让一个拼错的值把人工批准这条路悄悄打开。 */
    assert.equal(pairingApprovalMode({ pairingApproval: 'nonsense' as never }), 'code-only')
  })

  it('切换会就地写回配置对象，两个判断函数同源', () => {
    const config = { pairingApproval: undefined } as never as { pairingApproval?: 'code-only' | 'operator' }
    assert.equal(operatorApprovalAllowed(config), false)
    assert.equal(applyPairingApproval(config as never, 'operator'), 'operator')
    assert.equal(config.pairingApproval, 'operator')
    assert.equal(operatorApprovalAllowed(config), true)
  })
})

describe('窗口关着 + 只认配对码：连待配对记录都不该产生', () => {
  it('未配对 operator 拿到的是 pairing-closed，台账里一个字都不留', async () => {
    await hub.setPairingWindow({ close: true })
    const before = Object.keys((await store()).state().pending).length

    const attempt = await unpairedAttempt('closed-op', 'operator', ['employee.read'])
    assert.equal(attempt.code, 'pairing-closed')
    assert.equal(attempt.requestId, undefined, '窗口关着时不该给 requestId —— 没有任何东西可以批准')

    const after_ = await store()
    assert.equal(
      Object.keys(after_.state().pending).length,
      before,
      '窗口关着时陌生设备不能往台账里写待配对记录（否则就是一条刷得满、又无人能处理的垃圾）',
    )
    assert.equal(
      Object.values(after_.state().pending).some((r) => r.deviceId === attempt.deviceId),
      false,
    )
  })

  it('回环 node（零 scope）不受窗口影响：自动放行那条窄路必须还在', async () => {
    /* 反例的价值：如果闸门写在自动放行之前，"关掉注册"就会顺手把节点重连也掐死，
       表现是"好好的节点突然连不上了，而控制台说注册窗口关着"。 */
    const node = await makeClient('closed-node', 'node', [])
    const hello = await node.connect()
    assert.equal(hello.auth.role, 'node')
    assert.equal(typeof hello.auth.deviceToken, 'string')
    node.close()
  })

  it('回到旧行为（允许人工批准）后，窗口关着也会留下待审批 —— 说明上面那条不是"永远不落"', async () => {
    await hub.setPairingApproval('operator')
    const attempt = await unpairedAttempt('legacy-op', 'operator', ['employee.read'])
    assert.equal(attempt.code, 'pairing-required')
    assert.equal(typeof attempt.requestId, 'string')
    const current = await store()
    assert.ok(current.state().pending[attempt.requestId as string] !== undefined)
    /* 收尾：把这一条清掉并回到默认模式 —— 留着它会干扰后面"取第一条待配对"的用例。 */
    await rejectPairing(current, attempt.requestId as string)
    await hub.setPairingApproval('code-only')
  })
})

describe('窗口开着 + 只认配对码：记录照落，但人工批准必须被服务端拒绝', () => {
  it('配对码那条路仍然是完整的（这是唯一允许的进门方式）', async () => {
    await hub.setPairingWindow({ openMinutes: 15 })
    const attempt = await unpairedAttempt('code-op', 'operator', ['employee.read'])
    assert.equal(attempt.code, 'pairing-required')
    assert.equal(typeof attempt.requestId, 'string', '没有 requestId 的话配对码也无处可兑')
    const current = await store()
    assert.ok(current.state().pending[attempt.requestId as string] !== undefined)
  })

  it('device.pair.approve 被拒，并说清下一步该做什么', async () => {
    const operator = await approvedOperator('op-approve', ['device.pair', 'employee.read'])
    const pending = Object.values((await store()).state().pending)[0]
    assert.ok(pending !== undefined)
    await assert.rejects(
      () =>
        operator.call(
          'device.pair.approve',
          { requestId: pending.requestId },
          { idempotencyKey: `approve-${pending.requestId}` },
        ),
      (error: unknown) => {
        assert.ok(error instanceof HubCallError)
        assert.equal(error.code, 'bad-request')
        /* 报错必须能直接指向下一步（"只认配对码"而不是"权限不足"那种废话）。 */
        assert.match(error.message, /配对码|注册/)
        return true
      },
    )
    /* 拒绝之后那条请求仍在（它还能被配对码兑换，不是被丢弃）。 */
    assert.ok((await store()).state().pending[pending.requestId] !== undefined)
    operator.close()
  })

  it('切回「允许人工批准」后同一个调用就成了 —— 证明拒绝来自模式，不是别的原因', async () => {
    const operator = await approvedOperator('op-approve2', ['device.pair', 'employee.read'])
    const pending = Object.values((await store()).state().pending)[0]
    assert.ok(pending !== undefined)
    await hub.setPairingApproval('operator')
    const approved = (await operator.call(
      'device.pair.approve',
      { requestId: pending.requestId },
      { idempotencyKey: `approve2-${pending.requestId}` },
    )) as { deviceId: string }
    assert.equal(approved.deviceId, pending.deviceId)
    await hub.setPairingApproval('code-only')
    operator.close()
  })
})

describe('设备改名', () => {
  it('改得动，且只动显示名（role / scope / 令牌原样）', async () => {
    const operator = await approvedOperator('op-rename', ['device.pair', 'employee.read'])
    const target = await approvedOperator('op-victim', ['device.pair', 'employee.read'])
    const before = (await store()).state().paired[target.identity.deviceId]
    assert.ok(before !== undefined)

    const renamed = (await operator.call(
      'device.rename',
      { deviceId: target.identity.deviceId, name: '  客厅的 iPad  ' },
      { idempotencyKey: 'rename-1' },
    )) as { displayName: string; changed: boolean }
    assert.equal(renamed.displayName, '客厅的 iPad', '首尾空白要去掉')
    assert.equal(renamed.changed, true)

    const after_ = (await store()).state().paired[target.identity.deviceId]
    assert.ok(after_ !== undefined)
    assert.equal(after_.displayName, '客厅的 iPad')
    assert.equal(after_.role, before.role, '改名不许动角色')
    assert.deepEqual(after_.approvedScopes, before.approvedScopes, '改名不许动权限')
    assert.equal(after_.tokenHash, before.tokenHash, '改名不许动令牌')
    operator.close()
    target.close()
  })

  it('改成同一个名字是幂等的（changed=false，且不报错）', async () => {
    const operator = await approvedOperator('op-rename2', ['device.pair'])
    const target = await approvedOperator('op-victim2', ['employee.read'])
    await operator.call(
      'device.rename',
      { deviceId: target.identity.deviceId, name: '书房电脑' },
      { idempotencyKey: 'rename-2a' },
    )
    const again = (await operator.call(
      'device.rename',
      { deviceId: target.identity.deviceId, name: '书房电脑' },
      { idempotencyKey: 'rename-2b' },
    )) as { changed: boolean }
    assert.equal(again.changed, false)
    operator.close()
    target.close()
  })

  it('不存在的设备、空名字、超长名字、控制字符都被拒', async () => {
    const operator = await approvedOperator('op-rename3', ['device.pair'])
    const bad = async (params: Record<string, unknown>): Promise<string> => {
      try {
        await operator.call('device.rename', params, { idempotencyKey: `bad-${Math.random()}` })
        assert.fail('本该被拒绝')
      } catch (error) {
        assert.ok(error instanceof HubCallError)
        return error.code
      }
    }
    assert.equal(await bad({ deviceId: 'f'.repeat(64), name: '无所谓' }), 'not-found')
    assert.equal(await bad({ deviceId: operator.identity.deviceId, name: '   ' }), 'bad-request')
    assert.equal(await bad({ deviceId: operator.identity.deviceId, name: '' }), 'bad-request')
    assert.equal(await bad({ deviceId: operator.identity.deviceId, name: 'x'.repeat(41) }), 'bad-request')
    assert.equal(await bad({ deviceId: operator.identity.deviceId, name: '上\n下行' }), 'bad-request')
    operator.close()
  })

  it('没有 device.pair scope 的 operator 改不动（改名是管理动作）', async () => {
    const weak = await approvedOperator('op-weak', ['employee.read'])
    const target = await approvedOperator('op-victim3', ['employee.read'])
    await assert.rejects(
      () =>
        weak.call(
          'device.rename',
          { deviceId: target.identity.deviceId, name: '偷偷改名' },
          { idempotencyKey: 'rename-weak' },
        ),
      (error: unknown) => error instanceof HubCallError && error.code === 'forbidden',
    )
    weak.close()
    target.close()
  })
})
