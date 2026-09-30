/**
 * 岗位目录（Hub 侧共享数据）+ 员工绑定的透传。
 *
 * 这一组守的核心是一句话：**员工身份里存 id、显示名只存在目录里**。
 * 于是"给岗位改个名"只动一处，已绑定的员工不会失联；若身份里存名称，改一次名
 * 全部员工断链，而且「渗透测试」与「渗透」会变成两个互不相干的岗位。
 * 所以「改名不断链」这条必须有测试盯着 —— 它是这个设计唯一的价值所在。
 *
 * 另一条同样重要：岗位**只影响界面与 AGENTS.md 文本，绝不参与鉴权**。
 * 权限仍由方法表/scope 决定，岗位目录的写入口是 employee.manage，与岗位本身无关。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import { HubClient, HubCallError } from '../src/client/hub-client.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'

interface PositionRow {
  id: string
  name: string
  panels: string[]
  layout?: string
  cells?: { tl?: string[]; bl?: string[]; tr?: string[]; top?: string[] }
  builtin?: boolean
}

let tmpRoot = ''
let hub: Hub
let hubUrl = ''
let home = ''

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-positions-'))
  home = path.join(tmpRoot, 'home')
  hub = new Hub({ home, port: 0, verbose: false })
  const address = await hub.start()
  hubUrl = address.wsUrl
})

after(async () => {
  await hub.stop()
  await rm(tmpRoot, { recursive: true, force: true })
})

function makeClient(name: string, role: 'operator' | 'node', scopes: string[]): Promise<HubClient> {
  return HubClient.create({
    identityFile: path.join(home, 'test-clients', `${name}.json`),
    url: hubUrl,
    role,
    scopes: scopes as never,
    clientId: role === 'node' ? 'dse-node' : 'dse-cli',
    displayName: name,
    autoReconnect: false,
  })
}

async function approvedOperator(name: string, scopes: string[]): Promise<HubClient> {
  const first = await makeClient(name, 'operator', scopes)
  await assert.rejects(() => first.connect())
  first.close()

  const store = new HubStore(home)
  await store.load()
  const pending = Object.values(store.state().pending).find(
    (request) => request.deviceId === first.identity.deviceId,
  )
  assert.ok(pending !== undefined)
  await approvePairing(store, pending.requestId, 'test', { approvedScopes: scopes as never })

  const second = await makeClient(name, 'operator', scopes)
  await second.connect()
  return second
}

describe('岗位目录', () => {
  it('默认目录里有内置「通用」且排第一（它就是"和以前一样"的那个界面）', async () => {
    const reader = await approvedOperator('op-pos-default', ['employee.read'])
    const payload = await reader.call<{ positions: PositionRow[] }>('position.list', {})
    assert.ok(payload.positions.length >= 1)
    assert.equal(payload.positions[0]?.id, 'general')
    assert.equal(payload.positions[0]?.builtin, true)
    reader.close()
  })

  it('新增：不给 id 时服务端生成；改名：同 id 更新名称且 id 不变', async () => {
    const editor = await approvedOperator('op-pos-edit', ['employee.read', 'employee.manage'])

    const created = await editor.call<{ position: PositionRow }>(
      'position.upsert',
      { name: '渗透测试' },
      { idempotencyKey: 'pos-create-1' },
    )
    assert.match(created.position.id, /^pos_[a-z0-9]+$/, `服务端应生成合法 id，实际 ${created.position.id}`)
    assert.equal(created.position.name, '渗透测试')
    assert.deepEqual(created.position.panels, [], '面板是预留字段，当前为空')

    const renamed = await editor.call<{ position: PositionRow }>(
      'position.upsert',
      { id: created.position.id, name: '安全测试' },
      { idempotencyKey: 'pos-rename-1' },
    )
    assert.equal(renamed.position.id, created.position.id, '改名不该换 id')
    assert.equal(renamed.position.name, '安全测试')

    const listed = await editor.call<{ positions: PositionRow[] }>('position.list', {})
    const found = listed.positions.filter((row) => row.id === created.position.id)
    assert.equal(found.length, 1, '改名不该产生第二条')
    assert.equal(found[0]?.name, '安全测试')
    editor.close()
  })

  it('外壳与格位：layout/cells 存得住、能改、能清，且缺省不动原有值', async () => {
    const editor = await approvedOperator('op-pos-cells', ['employee.read', 'employee.manage'])

    /* 四宫格岗位 = layout:'quad' + 三个格位各放哪些面板 id */
    const created = await editor.call<{ position: PositionRow }>(
      'position.upsert',
      { name: '渗透测试', layout: 'quad', cells: { tl: ['pentest-target'], bl: ['pentest-plan'] } },
      { idempotencyKey: 'pos-cells-1' },
    )
    assert.equal(created.position.layout, 'quad')
    assert.deepEqual(created.position.cells, { tl: ['pentest-target'], bl: ['pentest-plan'] })

    /* 不给 cells = 保持原样（改名不该顺手把格位清空） */
    const renamed = await editor.call<{ position: PositionRow }>(
      'position.upsert',
      { id: created.position.id, name: '安全测试' },
      { idempotencyKey: 'pos-cells-2' },
    )
    assert.deepEqual(renamed.position.cells, { tl: ['pentest-target'], bl: ['pentest-plan'] }, '没给 cells 时不许清空')
    assert.equal(renamed.position.layout, 'quad', '没给 layout 时不许清空')

    /* 给了空对象 = 显式清空（与 layout 给空串同规矩） */
    const cleared = await editor.call<{ position: PositionRow }>(
      'position.upsert',
      { id: created.position.id, name: '安全测试', cells: {} },
      { idempotencyKey: 'pos-cells-3' },
    )
    assert.deepEqual(cleared.position.cells, {})

    /* 键名写错要当场报错 —— 静默为空的话，页面上就是"这一格什么都没有"，没人查得出来 */
    await assert.rejects(
      () =>
        editor.call(
          'position.upsert',
          { id: created.position.id, name: '安全测试', cells: { left: ['pentest-target'] } },
          { idempotencyKey: 'pos-cells-4' },
        ),
      (error: unknown) => error instanceof HubCallError && error.code === 'bad-request',
      'cells 里出现未知键必须拒绝，不能静默忽略',
    )

    /* 顶部那一格（cells.top）：安全监测的「只读 · 无处置权限」徽章挂在顶部条上 */
    const withTop = await editor.call<{ position: PositionRow }>(
      'position.upsert',
      { id: created.position.id, name: '安全监测', layout: 'quad', cells: { top: ['capability-badge'], tl: ['monitor-post'], bl: ['monitor-findings'], tr: ['monitor-watch'] } },
      { idempotencyKey: 'pos-cells-5' },
    )
    assert.deepEqual(withTop.position.cells, {
      top: ['capability-badge'],
      tl: ['monitor-post'],
      bl: ['monitor-findings'],
      tr: ['monitor-watch'],
    })
    editor.close()
  })

  it('写目录需要 employee.manage（岗位与权限无关，但目录是共享数据）', async () => {
    const reader = await approvedOperator('op-pos-readonly', ['employee.read'])
    await assert.rejects(
      () => reader.call('position.upsert', { name: '偷偷加的岗位' }, { idempotencyKey: 'pos-nope' }),
      (error: unknown) => error instanceof HubCallError && error.code === 'forbidden',
    )
    reader.close()
  })

  it('非法 id 被拒（id 会进员工身份，必须是可校验的稳定标识）', async () => {
    const editor = await approvedOperator('op-pos-bad-id', ['employee.read', 'employee.manage'])
    for (const bad of ['Hello', '有中文', 'a b', '-lead']) {
      await assert.rejects(
        () => editor.call('position.upsert', { id: bad, name: 'x' }, { idempotencyKey: `pos-bad-${bad}` }),
        (error: unknown) => error instanceof HubCallError && error.code === 'bad-request',
        `id "${bad}" 应当被拒`,
      )
    }
    editor.close()
  })

  it('改名不断链：已绑定该岗位的员工仍然指向同一个 id', async () => {
    const editor = await approvedOperator('op-pos-bind', ['employee.read', 'employee.manage'])
    const created = await editor.call<{ position: PositionRow }>(
      'position.upsert',
      { name: '运维值班' },
      { idempotencyKey: 'pos-bind-create' },
    )
    const positionId = created.position.id

    // 节点上报一个绑定该岗位的员工
    const node = await makeClient('node-pos', 'node', [])
    await node.connect()
    await node.call(
      'node.register',
      {
        name: '岗位节点',
        platform: 'test',
        employeeRoot: '/tmp/fake-employees',
        employees: [
          {
            id: 'emp_pos_1',
            name: '值班员',
            role: '负责夜间值班',
            workspacePath: '/tmp/fake-employees/duty',
            position: positionId,
            skills: [],
            status: 'ok',
            createdAtMs: 1,
          },
        ],
      },
      { idempotencyKey: 'reg-pos' },
    )

    const beforeRename = await editor.call<{ employees: Array<{ id: string; position?: string }> }>(
      'employee.list',
      {},
    )
    assert.equal(beforeRename.employees.find((e) => e.id === 'emp_pos_1')?.position, positionId)

    // 改名（显示名变了，id 不变）
    await editor.call(
      'position.upsert',
      { id: positionId, name: '夜间值班' },
      { idempotencyKey: 'pos-bind-rename' },
    )

    const afterRename = await editor.call<{
      employees: Array<{ id: string; position?: string }>
    }>('employee.list', {})
    assert.equal(
      afterRename.employees.find((e) => e.id === 'emp_pos_1')?.position,
      positionId,
      '改名后员工绑定必须原样保持（这就是"存 id 不存名称"的全部意义）',
    )

    const listed = await editor.call<{ positions: PositionRow[] }>('position.list', {})
    const renamed = listed.positions.find((row) => row.id === positionId)
    assert.equal(renamed?.name, '夜间值班', '目录里显示名已更新')

    node.close()
    editor.close()
  })

  it('员工不设岗位时就是「通用」（老员工无需迁移）', async () => {
    const viewer = await approvedOperator('op-pos-absent', ['employee.read'])
    const node = await makeClient('node-pos-absent', 'node', [])
    await node.connect()
    await node.call(
      'node.register',
      {
        name: '无岗位节点',
        platform: 'test',
        employeeRoot: '/tmp/fake-employees',
        employees: [
          {
            id: 'emp_no_pos',
            name: '老员工',
            role: '以前建的',
            workspacePath: '/tmp/fake-employees/old',
            skills: [],
            status: 'ok',
            createdAtMs: 1,
          },
        ],
      },
      { idempotencyKey: 'reg-no-pos' },
    )
    const listed = await viewer.call<{ employees: Array<{ id: string; position?: string }> }>(
      'employee.list',
      {},
    )
    const row = listed.employees.find((e) => e.id === 'emp_no_pos')
    assert.ok(row !== undefined)
    assert.equal(row.position, undefined, '没设岗位就该是缺省 —— 控制台按「通用」渲染')
    node.close()
    viewer.close()
  })
})

describe('岗位删除', () => {
  it('内置「通用」不可删（它是缺省项）', async () => {
    const editor = await approvedOperator('op-pos-del-builtin', ['employee.read', 'employee.manage'])
    await assert.rejects(
      () => editor.call('position.remove', { id: 'general' }, { idempotencyKey: 'pos-del-general' }),
      (error: unknown) => error instanceof HubCallError && error.code === 'bad-request',
    )
    editor.close()
  })

  it('删不存在的岗位 → not-found；删掉的立即从目录消失', async () => {
    const editor = await approvedOperator('op-pos-del-missing', ['employee.read', 'employee.manage'])
    await assert.rejects(
      () => editor.call('position.remove', { id: 'pos_nope' }, { idempotencyKey: 'pos-del-nope' }),
      (error: unknown) => error instanceof HubCallError && error.code === 'not-found',
    )
    const created = await editor.call<{ position: PositionRow }>(
      'position.upsert',
      { name: '临时岗位' },
      { idempotencyKey: 'pos-del-tmp' },
    )
    await editor.call('position.remove', { id: created.position.id }, { idempotencyKey: 'pos-del-tmp-2' })
    const listed = await editor.call<{ positions: PositionRow[] }>('position.list', {})
    assert.equal(listed.positions.some((row) => row.id === created.position.id), false)
    editor.close()
  })

  it('删除时把仍绑着的员工改回「通用」（真的转发到节点，不是只改本地视图）', async () => {
    const editor = await approvedOperator('op-pos-del-unbind', ['employee.read', 'employee.manage'])
    const created = await editor.call<{ position: PositionRow }>(
      'position.upsert',
      { name: '待删岗位' },
      { idempotencyKey: 'pos-unbind-create' },
    )

    const node = await makeClient('node-pos-unbind', 'node', [])
    await node.connect()
    /* 扮演节点：接住 Hub 转发来的 employee.update，记下参数并回 ok */
    const forwarded: Array<Record<string, unknown>> = []
    node.on('request', (frame) => {
      if (frame.method !== 'employee.update') {
        node.respond(frame.id, { ok: false, error: { code: 'unknown-method', message: frame.method } })
        return
      }
      forwarded.push(frame.params as Record<string, unknown>)
      node.respond(frame.id, { ok: true, payload: { updated: true } })
    })
    await node.call(
      'node.register',
      {
        name: '解绑节点',
        platform: 'test',
        employeeRoot: '/tmp/fake-employees',
        employees: [
          {
            id: 'emp_unbind_1',
            name: '绑定员',
            role: '测试',
            workspacePath: '/tmp/fake-employees/bound',
            position: created.position.id,
            skills: [],
            status: 'ok',
            createdAtMs: 1,
          },
        ],
      },
      { idempotencyKey: 'reg-unbind' },
    )

    const result = await editor.call<{ unbound: string[]; failed: string[] }>(
      'position.remove',
      { id: created.position.id },
      { idempotencyKey: 'pos-unbind-remove' },
    )
    assert.deepEqual(result.unbound, ['emp_unbind_1'], '绑定的员工应当被解绑')
    assert.deepEqual(result.failed, [])
    assert.deepEqual(
      forwarded,
      [{ employeeId: 'emp_unbind_1', position: null }],
      '解绑必须是**真的**把 position: null 发给节点 —— 否则节点上的 manifest 仍指向已删除的岗位',
    )

    node.close()
    editor.close()
  })

  it('节点离线时如实报告没解绑成功（不假装干净）', async () => {
    const editor = await approvedOperator('op-pos-del-offline', ['employee.read', 'employee.manage'])
    const created = await editor.call<{ position: PositionRow }>(
      'position.upsert',
      { name: '离线岗位' },
      { idempotencyKey: 'pos-offline-create' },
    )

    const node = await makeClient('node-pos-offline', 'node', [])
    await node.connect()
    await node.call(
      'node.register',
      {
        name: '离线节点',
        platform: 'test',
        employeeRoot: '/tmp/fake-employees',
        employees: [
          {
            id: 'emp_offline_1',
            name: '离线员工',
            role: '测试',
            workspacePath: '/tmp/fake-employees/offline',
            position: created.position.id,
            skills: [],
            status: 'ok',
            createdAtMs: 1,
          },
        ],
      },
      { idempotencyKey: 'reg-offline' },
    )
    node.close()
    // 等 Hub 感知断开
    await new Promise((resolve) => setTimeout(resolve, 200))

    const result = await editor.call<{ unbound: string[]; failed: string[]; note?: string }>(
      'position.remove',
      { id: created.position.id },
      { idempotencyKey: 'pos-offline-remove' },
    )
    assert.deepEqual(result.unbound, [])
    assert.deepEqual(result.failed, ['emp_offline_1'], '离线节点的员工要落进 failed')
    assert.equal(typeof result.note, 'string', '要给人话说明怎么收尾')
    editor.close()
  })
})
