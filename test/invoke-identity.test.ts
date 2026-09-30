/**
 * 跨员工调用里"**谁在发起**"这条规则。
 *
 * 为什么值得一组独立测试：被测出来的那次事故是"用 operator 设备声称自己是小艾，
 * 就拿到了小艾→小明的授权"（handler 直接读请求里的 fromEmployeeId，把连接身份丢在
 * 一边）。员工凭据一旦发下去，这个洞就从"管理员可冒充"升级成"员工互相冒名派活"，
 * 而台账里记的发起人全是假的 —— 事后追责都追不了。
 *
 * 分两层验：
 *   · 纯函数层：resolveInvokePrincipal 的每条分支（毫秒级，穷举边界）
 *   · 真机层：起真 Hub、真配一台**绑定员工**的设备、真调 employee.invoke，
 *     看它能不能以别人的名义发起，以及台账里记的发起方式对不对。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { resolveInvokePrincipal } from '../src/hub/invoke-principal.ts'
import { HubClient } from '../src/client/hub-client.ts'
import type { EmployeeRecord } from '../src/hub/types.ts'

/* ────────────────── 一、纯函数：身份派生 ────────────────── */

const BOUND = { deviceId: 'dev-xiaai', role: 'operator', boundEmployeeId: 'emp_xiaoai' }
const PLAIN = { deviceId: 'dev-op', role: 'operator' }

describe('发起人身份派生（resolveInvokePrincipal）', () => {
  it('绑定设备不写 from → 用它绑定的那个员工（员工自己发起的最简形态）', () => {
    const r = resolveInvokePrincipal(BOUND, {})
    assert.equal(r.ok, true)
    assert.equal(r.ok === true ? r.fromEmployeeId : '', 'emp_xiaoai')
    assert.equal(r.ok === true ? r.principal : '', 'employee-device')
  })

  it('绑定设备写明自己的 id → 通过（脚本里显式写出来是好习惯）', () => {
    const r = resolveInvokePrincipal(BOUND, { fromEmployeeId: 'emp_xiaoai' })
    assert.equal(r.ok, true)
  })

  it('绑定设备声称是别人 → 拒绝，且明确指出"绑定的是另一个员工"（不静默改写）', () => {
    const r = resolveInvokePrincipal(BOUND, { fromEmployeeId: 'emp_xiaoming', onBehalfOf: true })
    assert.equal(r.ok, false)
    assert.equal(r.ok === false ? r.code : '', 'forbidden')
    assert.match(r.ok === false ? r.message : '', /绑定/)
  })

  it('未绑定设备（operator）不写 from → 参数错，而不是猜一个', () => {
    const r = resolveInvokePrincipal(PLAIN, {})
    assert.equal(r.ok, false)
    assert.equal(r.ok === false ? r.code : '', 'bad-request')
  })

  it('未绑定设备不给 onBehalfOf → 拒绝：代员工发起必须留痕', () => {
    const r = resolveInvokePrincipal(PLAIN, { fromEmployeeId: 'emp_xiaoai' })
    assert.equal(r.ok, false)
    assert.equal(r.ok === false ? r.code : '', 'forbidden')
    assert.match(r.ok === false ? r.message : '', /onBehalfOf/)
  })

  it('未绑定设备显式声明 → 通过，并记下是哪台设备代发的', () => {
    const r = resolveInvokePrincipal(PLAIN, { fromEmployeeId: 'emp_xiaoai', onBehalfOf: true })
    assert.equal(r.ok, true)
    assert.equal(r.ok === true ? r.principal : '', 'operator-delegated')
    assert.equal(r.ok === true ? r.delegatedByDeviceId : '', 'dev-op')
  })

  it('绑定字段是空串时按"未绑定"处理（别把空值当成一个员工 id）', () => {
    const r = resolveInvokePrincipal({ ...BOUND, boundEmployeeId: '' }, {
      fromEmployeeId: 'emp_xiaoai',
    })
    assert.equal(r.ok, false, '空绑定 + 未声明 onBehalfOf ⇒ 应当走 operator 的严格要求')
  })
})

/* ────────────────── 二、真机：真 Hub + 真配对 ────────────────── */

let tmpRoot = ''
let hub: Hub
let hubUrl = ''
let home = ''
let store: HubStore

const NOW = 1_700_000_000_000
const XIAOAI: EmployeeRecord = {
  id: 'emp_xiaoai',
  nodeId: 'node_a',
  name: '小艾',
  role: '总控',
  workspacePath: '/tmp/nonexistent-xiaoai',
  skills: [],
  status: 'ok',
  createdAtMs: NOW,
  updatedAtMs: NOW,
}
const XIAOMING: EmployeeRecord = {
  id: 'emp_xiaoming',
  nodeId: 'node_a',
  name: '小明',
  role: '研发',
  workspacePath: '/tmp/nonexistent-xiaoming',
  skills: [],
  status: 'ok',
  createdAtMs: NOW,
  updatedAtMs: NOW,
}

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-invoke-identity-'))
  home = path.join(tmpRoot, 'home')
  store = new HubStore(home)
  await store.load()
  store.state().employees[XIAOAI.id] = XIAOAI
  store.state().employees[XIAOMING.id] = XIAOMING
  await store.saveEmployees()
  hub = new Hub({ home, port: 0, verbose: false })
  const address = await hub.start()
  hubUrl = address.wsUrl
})

after(async () => {
  await hub.stop()
  await rm(tmpRoot, { recursive: true, force: true })
})

async function makeClient(
  name: string,
  scopes: string[],
  options: { token?: string } = {},
): Promise<HubClient> {
  return await HubClient.create({
    identityFile: path.join(home, 'clients', `${name}.json`),
    url: hubUrl,
    role: 'operator',
    scopes: scopes as never,
    clientId: 'dse-cli',
    displayName: name,
    autoReconnect: false,
    ...(options.token === undefined ? {} : { token: options.token }),
  })
}

/** 配一台设备并把它绑定到某个员工；返回已领到令牌的客户端。 */
async function pairBound(name: string, employeeId: string | undefined, scopes: string[]): Promise<HubClient> {
  const probe = await makeClient(name, scopes)
  await assert.rejects(() => probe.connect())
  probe.close()

  const fresh = new HubStore(home)
  await fresh.load()
  const request = Object.values(fresh.state().pending).find((r) => r.clientId === 'dse-cli' && fresh.state().paired[r.deviceId] === undefined)
  assert.ok(request !== undefined, '应当有一条待审批的配对请求')
  await approvePairing(fresh, request.requestId, 'test', {
    approvedScopes: scopes as never,
    ...(employeeId === undefined ? {} : { boundEmployeeId: employeeId }),
  })

  const bound = await makeClient(name, scopes)
  const hello = await bound.connect()
  assert.equal(typeof hello.auth.deviceToken, 'string', '首次连接应领到令牌')
  return bound
}

describe('真机：绑定设备的跨员工调用', () => {
  it('绑定到小艾的设备：以自己名义发起 → 走到 ACL（未配节点 ⇒ 留在队列，不报身份错）', async () => {
    await store.load()
    store.state().acl = []
    hub.state().acl = []
    await store.saveAcl()

    const xiaoai = await pairBound('emp-xiaoai', XIAOAI.id, [
      'employee.read',
      'employee.invoke',
    ])
    const res = (await xiaoai.call(
      'employee.invoke',
      { toEmployeeId: XIAOMING.id, task: '以自己名义发起' },
      { idempotencyKey: 'k-self-1' },
    )) as { status?: string }
    assert.equal(res.status, 'pending-approval', '默认策略需审批（这里只验身份通过）')

    const list = (await xiaoai.call('employee.invoke.list', {})) as {
      invocations?: Array<Record<string, unknown>>
    }
    const record = (list.invocations ?? []).find((r) => r['task'] === '以自己名义发起')
    assert.ok(record !== undefined)
    assert.equal(record['fromEmployeeId'], XIAOAI.id)
    assert.equal(record['principal'], 'employee-device', '台账要记清"这是员工自己发起的"')
    xiaoai.close()
  })

  it('绑定到小艾的设备：声称自己是小明 → 拒绝（这就是修掉的那个洞）', async () => {
    const xiaoai = await pairBound('emp-xiaoai-2', XIAOAI.id, [
      'employee.read',
      'employee.invoke',
    ])
    await assert.rejects(
      () =>
        xiaoai.call(
          'employee.invoke',
          {
            fromEmployeeId: XIAOMING.id,
            onBehalfOf: true,
            toEmployeeId: XIAOAI.id,
            task: '冒名发起',
          },
          { idempotencyKey: 'k-forge-1' },
        ),
      /绑定/,
    )
    xiaoai.close()
  })

  it('未绑定的 operator：不声明 onBehalfOf 就发 → 拒绝；声明了则可代发起并留痕', async () => {
    await store.load()
    store.state().acl = []
    hub.state().acl = []
    await store.saveAcl()

    const op = await pairBound('op-plain', undefined, ['employee.read', 'employee.invoke'])
    // 不给 --employee 就没有绑定字段（approvePairing 只在给了值时才写）
    const device = Object.values(hub.state().paired).find((d) => d.displayName === 'op-plain')
    assert.equal(device?.boundEmployeeId, undefined, '没给 --employee 就不该有绑定字段')

    await assert.rejects(
      () =>
        op.call(
          'employee.invoke',
          { fromEmployeeId: XIAOAI.id, toEmployeeId: XIAOMING.id, task: '不声明就代发起' },
          { idempotencyKey: 'k-op-1' },
        ),
      /onBehalfOf/,
    )

    const ok = (await op.call(
      'employee.invoke',
      {
        fromEmployeeId: XIAOAI.id,
        onBehalfOf: true,
        toEmployeeId: XIAOMING.id,
        task: '显式代发起',
      },
      { idempotencyKey: 'k-op-2' },
    )) as { status?: string }
    assert.equal(ok.status, 'pending-approval')

    const list = (await op.call('employee.invoke.list', {})) as {
      invocations?: Array<Record<string, unknown>>
    }
    const record = (list.invocations ?? []).find((r) => r['task'] === '显式代发起')
    assert.ok(record !== undefined)
    assert.equal(record['principal'], 'operator-delegated')
    assert.equal(record['delegatedByDeviceId'], op.identity.deviceId, '代发起必须记下是哪台设备')
    op.close()
  })
})

describe('真机：employee.activity（秘书的数据来源）', () => {
  it('能读到两位员工的元数据；节点不在线时如实写进 notes', async () => {
    const op = await pairBound('op-activity', undefined, ['employee.read'])
    const report = (await op.call('employee.activity', { windowHours: 24 })) as {
      employees?: Array<Record<string, unknown>>
      notes?: string[]
    }
    const names = (report.employees ?? []).map((item) => String(item['name'])).sort()
    /* 按集合比，不按顺序：排序规则（中文按码位）不是这条用例要断言的东西 */
    assert.deepEqual([...names].sort(), ['小艾', '小明'].sort())
    assert.ok((report.notes ?? []).some((note) => /不在线/.test(note)), '没有节点时必须说明数据不全')
    assert.ok((report.notes ?? []).some((note) => /只含.*元数据/.test(note)))
    op.close()
  })

  it('没有 employee.read 的设备读不到（权限照旧走 scope）', async () => {
    const op = await pairBound('op-activity-2', undefined, ['employee.invoke'])
    await assert.rejects(() => op.call('employee.activity', {}), /requires scope/)
    op.close()
  })
})

describe('真机：acl.remove（以前只能加不能删）', () => {
  it('写一条再删一条，列表回到原样', async () => {
    const op = await pairBound('op-acl', undefined, [
      'employee.read',
      'employee.manage',
    ])
    const before = (await op.call('acl.get', {})) as { rules?: unknown[] }
    const count = (before.rules ?? []).length

    const set = (await op.call(
      'acl.set',
      { from: XIAOAI.id, to: XIAOMING.id, effect: 'allow', note: 'acl.remove 用例' },
      { idempotencyKey: 'k-acl-set-1' },
    )) as { rule?: { id?: string } }
    const ruleId = set.rule?.id ?? ''
    assert.ok(ruleId !== '')

    const removed = (await op.call('acl.remove', { ruleId }, { idempotencyKey: 'k-acl-rm-1' })) as { removed?: boolean }
    assert.equal(removed.removed, true)
    const after = (await op.call('acl.get', {})) as { rules?: unknown[] }
    assert.equal((after.rules ?? []).length, count, '删完应当回到写入前的条数')

    await assert.rejects(() => op.call('acl.remove', { ruleId }, { idempotencyKey: 'k-acl-rm-2' }), /unknown acl rule/)
    op.close()
  })
})
