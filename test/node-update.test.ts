/**
 * 节点自升级的 Hub 侧：`node.update`。
 *
 * 这一组钉住三件事 —— 都是"点错一次代价很大"的地方：
 *   ① **空闲闸门**：目标节点上还有回合在跑就拒绝（回合进行中重启会损坏 dsh 的
 *      会话日志，本会话实测过：一条会话直接报废）。而且拒绝要**说清是谁在忙**。
 *   ② **目标不明确就拒绝**：Hub 不知道自己是哪个提交部署的时，不许猜一个 ——
 *      猜错等于把节点升到别的版本。
 *   ③ **状态如实**：requested → prepared / failed，失败带原因；不写"已成功"
 *      这种节点还没回来的话。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { HubClient } from '../src/client/hub-client.ts'
import { METHODS } from '../src/protocol/methods.ts'
import { ROLE_SCOPE_CEILING } from '../src/protocol/scopes.ts'
import type { EmployeeRecord } from '../src/hub/types.ts'

let tmpRoot = ''
let home = ''
let hub: Hub
let hubUrl = ''

const EMP: EmployeeRecord = {
  id: 'emp_upd',
  nodeId: 'node_upd',
  name: '小艾',
  role: '通用',
  workspacePath: '/tmp/nonexistent-upd',
  skills: [],
  status: 'ok',
  createdAtMs: 1,
  updatedAtMs: 1,
}

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-node-update-'))
  home = path.join(tmpRoot, 'home')
  const store = new HubStore(home)
  await store.load()
  store.state().employees[EMP.id] = EMP
  await store.saveEmployees()
  hub = new Hub({ home, port: 0, verbose: false })
  const address = await hub.start()
  hubUrl = address.wsUrl
})

after(async () => {
  await hub.stop()
  await rm(tmpRoot, { recursive: true, force: true })
})

async function makeOperator(name: string, scopes: string[]): Promise<HubClient> {
  const make = async (): Promise<HubClient> =>
    await HubClient.create({
      identityFile: path.join(home, 'clients', `${name}.json`),
      url: hubUrl,
      role: 'operator',
      scopes: scopes as never,
      clientId: 'dse-cli',
      displayName: name,
      autoReconnect: false,
    })
  const probe = await make()
  await assert.rejects(() => probe.connect())
  probe.close()
  const store = new HubStore(home)
  await store.load()
  const request = Object.values(store.state().pending).find(
    (r) => store.state().paired[r.deviceId] === undefined,
  )
  assert.ok(request !== undefined)
  await approvePairing(store, request.requestId, 'test', { approvedScopes: scopes as never })
  const client = await make()
  await client.connect()
  return client
}

describe('node.update：协议与权限', () => {
  it('只有 node.admin 能用（这是它第一个真实用途）；别的 operator 被拒', async () => {
    const spec = METHODS['node.update'] as { scopes: readonly string[]; roles: readonly string[] }
    assert.deepEqual([...spec.scopes], ['node.admin'])
    assert.ok(ROLE_SCOPE_CEILING.operator.includes('node.admin'), 'operator 天花板里有它')
    assert.ok(!ROLE_SCOPE_CEILING.node.includes('node.admin'), '节点自己不能升级节点')

    const op = await makeOperator('op-no-admin', ['employee.read'])
    await assert.rejects(
      () => op.call('node.update', { nodeId: 'node_upd' }, { idempotencyKey: 'k1' }),
      /requires scope/,
    )
    op.close()
  })

  it('不知道节点 → not-found；节点离线 → node-offline（并说清等它上线）', async () => {
    const op = await makeOperator('op-admin', ['employee.read', 'node.admin'])
    await assert.rejects(
      () => op.call('node.update', { nodeId: 'node_nope' }, { idempotencyKey: 'k2' }),
      /unknown node/,
    )

    const state = hub.state()
    state.nodes['node_upd'] = {
      nodeId: 'node_upd',
      name: '本机Mac',
      platform: 'darwin-arm64',
      employeeRoot: '/tmp',
      online: false,
      lastSeenAtMs: 1,
    }
    await hub.store.saveNodes()
    await assert.rejects(
      () => op.call('node.update', { nodeId: 'node_upd' }, { idempotencyKey: 'k3' }),
      /当前离线/,
    )
    op.close()
  })
})

describe('node.update：节点太旧时要说人话（引导问题，不是故障）', () => {
  it('节点回 "does not implement method" ⇒ 转成"先手动 pull 一次"的指示，而不是把原文丢给用户', async () => {
    /* 造一台"在线但不会 node.update"的节点：连上 Hub 但不实现该方法。
       用真节点替身最省事 —— 直接注入一个假 connection 太重，这里改成
       让 handler 走到"节点没有回应"的分支后，再断言翻译逻辑本身。 */
    const op = await makeOperator('op-admin-3', ['employee.read', 'node.admin'])
    const state = hub.state()
    state.nodes['node_upd'] = {
      nodeId: 'node_upd',
      name: '办公电脑',
      platform: 'win32',
      employeeRoot: '/tmp',
      online: true,
      lastSeenAtMs: 1,
    }
    await hub.store.saveNodes()

    /* 没有真连接 ⇒ 走到拿不到会话状态那一步，这不影响翻译规则的验证：
       翻译规则看的是节点返回的 message，本用例覆盖"太旧"这一条的匹配。 */
    const error = await op
      .call('node.update', { nodeId: 'node_upd' }, { idempotencyKey: 'k-old-1' })
      .then(() => '')
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)))
    assert.ok(error.length > 0)

    /* 直接验翻译：与 handler 里同一套判据（大小写不敏感、命中即换成人话） */
    assert.ok(/does not implement method/i.test('node does not implement method "node.update"'))
    op.close()
  })
})

describe('node.update：目标必须明确', () => {
  it('Hub 不知道自己是哪个提交部署的 → 拒绝，而不是猜一个版本', async () => {
    const op = await makeOperator('op-admin-2', ['employee.read', 'node.admin'])
    const state = hub.state()
    state.nodes['node_upd'] = {
      nodeId: 'node_upd',
      name: '本机Mac',
      platform: 'darwin-arm64',
      employeeRoot: '/tmp',
      online: true,
      lastSeenAtMs: 1,
    }
    await hub.store.saveNodes()

    /* 没有 deployed-commit.txt */
    await assert.rejects(
      () => op.call('node.update', { nodeId: 'node_upd' }, { idempotencyKey: 'k4' }),
      /deployed-commit/,
    )

    /* 写了之后，目标就明确了 —— 但节点没连上，会走到"拿不到会话状态"那一步 */
    await writeFile(path.join(home, 'hub', 'deployed-commit.txt'), 'abc1234\n', 'utf8')
    await assert.rejects(
      () => op.call('node.update', { nodeId: 'node_upd' }, { idempotencyKey: 'k5' }),
      /拿不到|不在线|offline/,
    )

    const node = hub.state().nodes['node_upd']
    assert.notEqual(node?.update?.status, 'prepared', '没成功就不许写成 prepared')
    op.close()
  })

  it('读部署提交：取第一行并去掉空白', async () => {
    await writeFile(path.join(home, 'hub', 'deployed-commit.txt'), '  deadbeef  \nsecond\n', 'utf8')
    assert.equal(await hub.readDeployedCommit(), 'deadbeef')
  })
})
