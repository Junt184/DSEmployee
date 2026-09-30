/**
 * `job.self.*` —— 员工给自己排任务。
 *
 * 为什么单列一组：排任务 = 让某台机器在某个时刻**自动执行一段指令**，比一次调用更持久，
 * 所以身份必须由服务端派生（与 employee.invoke 同一条原则）。这一组同时钉住三件事：
 *   1. 只有**绑定了员工**的凭据能用（否则无从回答"这是给谁排的"）；
 *   2. 只能动**自己**的任务：改/删别人的一律拒绝，且不静默改写请求里的 id；
 *   3. 权限是窄的（`job.self`），不是 `employee.manage` —— 员工不该能建删改员工或改 ACL。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { HubClient } from '../src/client/hub-client.ts'
import { SELF_JOB_LIMIT, resolveSelfJobEmployee } from '../src/hub/self-jobs.ts'
import { ceilingFor } from '../src/protocol/scopes.ts'
import type { EmployeeRecord } from '../src/hub/types.ts'

/* ────────────────── 一、纯函数：目标员工从哪来 ────────────────── */

describe('给自己排任务：目标员工由绑定身份派生', () => {
  const bound = { deviceId: 'dev_sec', role: 'operator', boundEmployeeId: 'emp_sec' }

  it('绑定了员工 → 用它（不写 employeeId 也行）', () => {
    const r = resolveSelfJobEmployee(bound, {})
    assert.equal(r.ok, true)
    assert.equal(r.ok === true ? r.employeeId : '', 'emp_sec')
  })

  it('写了别人的 id → 拒绝，并明说"只能给自己排"（不静默改写）', () => {
    const r = resolveSelfJobEmployee(bound, { employeeId: 'emp_other' })
    assert.equal(r.ok, false)
    assert.equal(r.ok === false ? r.code : '', 'forbidden')
    assert.match(r.ok === false ? r.message : '', /只能给自己/)
  })

  it('没绑定员工 → 拒绝，并指出该走哪条路（job.upsert）', () => {
    const r = resolveSelfJobEmployee({ deviceId: 'dev_op', role: 'operator' }, { employeeId: 'emp_x' })
    assert.equal(r.ok, false)
    assert.match(r.ok === false ? r.message : '', /job\.upsert/)
  })

  it('node 角色的天花板里没有 job.self（执行端不该给自己排任务）', () => {
    assert.ok(!ceilingFor('node').includes('job.self'))
    assert.ok(ceilingFor('operator').includes('job.self'))
  })
})

/* ────────────────── 二、真 Hub：只能动自己的 ────────────────── */

let tmpRoot = ''
let home = ''
let hub: Hub
let hubUrl = ''

function employee(id: string, name: string): EmployeeRecord {
  return {
    id,
    nodeId: 'node_1',
    name,
    role: '通用',
    workspacePath: `/tmp/${id}`,
    skills: [],
    status: 'ok',
    createdAtMs: 1,
    updatedAtMs: 1,
  }
}

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-self-jobs-'))
  home = path.join(tmpRoot, 'home')
  const store = new HubStore(home)
  await store.load()
  store.state().employees['emp_sec'] = employee('emp_sec', '秘书')
  store.state().employees['emp_other'] = employee('emp_other', '别人')
  await store.saveEmployees()
  hub = new Hub({ home, port: 0, verbose: false })
  const address = await hub.start()
  hubUrl = address.wsUrl
})

after(async () => {
  await hub.stop()
  await rm(tmpRoot, { recursive: true, force: true })
})

async function pairBound(name: string, employeeId: string | undefined, scopes: string[]): Promise<HubClient> {
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
  await approvePairing(store, request.requestId, 'test', {
    approvedScopes: scopes as never,
    ...(employeeId === undefined ? {} : { boundEmployeeId: employeeId }),
  })
  const client = await make()
  await client.connect()
  return client
}

describe('真 Hub：员工给自己排任务', () => {
  it('秘书用自己的凭据排一条 → 落到自己名下；管理员的 job.list 也看得到', async () => {
    const sec = await pairBound('sec', 'emp_sec', ['employee.read', 'job.self'])
    const created = (await sec.call(
      'job.self.upsert',
      { name: '每天汇总', prompt: '按 daily-digest 做今天的汇总', intervalMinutes: 1440 },
      { idempotencyKey: 'self-1' },
    )) as { job?: Record<string, unknown> }
    const job = created.job ?? {}
    assert.equal(job['employeeId'], 'emp_sec')
    assert.equal(job['employeeName'], '秘书')
    assert.match(String(job['createdBy'] ?? ''), /^employee-device:/, '台账要能看出是员工自己排的')

    const mine = (await sec.call('job.self.list', {})) as { jobs?: unknown[]; limit?: number }
    assert.equal((mine.jobs ?? []).length, 1)
    assert.equal(mine.limit, SELF_JOB_LIMIT)

    const admin = await pairBound('admin', undefined, ['employee.read', 'employee.manage'])
    const all = (await admin.call('job.list', {})) as { jobs?: Array<Record<string, unknown>> }
    assert.equal((all.jobs ?? []).length, 1)
    admin.close()
    sec.close()
  })

  it('想排到别人名下 → 拒绝（连记录都不该产生）', async () => {
    const sec = await pairBound('sec2', 'emp_sec', ['employee.read', 'job.self'])
    await assert.rejects(
      () =>
        sec.call(
          'job.self.upsert',
          { name: '越权任务', prompt: 'x', intervalMinutes: 30, employeeId: 'emp_other' },
          { idempotencyKey: 'self-2' },
        ),
      /只能给自己/,
    )
    const mine = (await sec.call('job.self.list', {})) as { jobs?: Array<Record<string, unknown>> }
    assert.ok(
      (mine.jobs ?? []).every((job) => job['name'] !== '越权任务'),
      '被拒的请求不该留下任务',
    )
    sec.close()
  })

  it('改 / 删别人的任务 → 拒绝', async () => {
    const admin = await pairBound('admin2', undefined, ['employee.read', 'employee.manage'])
    const others = (await admin.call(
      'job.upsert',
      { name: '别人的任务', employeeId: 'emp_other', prompt: 'x', intervalMinutes: 30 },
      { idempotencyKey: 'other-1' },
    )) as { job?: { jobId?: string } }
    const otherJobId = others.job?.jobId ?? ''
    admin.close()

    const sec = await pairBound('sec3', 'emp_sec', ['employee.read', 'job.self'])
    await assert.rejects(
      () =>
        sec.call(
          'job.self.upsert',
          { jobId: otherJobId, name: '改别人的', prompt: 'x', intervalMinutes: 30 },
          { idempotencyKey: 'self-3' },
        ),
      /不属于你/,
    )
    await assert.rejects(
      () => sec.call('job.self.remove', { jobId: otherJobId }, { idempotencyKey: 'self-4' }),
      /不属于你/,
    )
    sec.close()
  })

  it('没绑定员工的凭据拿 job.self scope 也用不了（要说清该走哪条路）', async () => {
    const op = await pairBound('op-self', undefined, ['employee.read', 'job.self'])
    await assert.rejects(
      () => op.call('job.self.list', {}),
      /没有绑定员工身份/,
    )
    op.close()
  })

  it('自己的任务数有上限（防止一条指令把自己刷成任务工厂）', async () => {
    const sec = await pairBound('sec4', 'emp_sec', ['employee.read', 'job.self'])
    const mine = (await sec.call('job.self.list', {})) as { jobs?: unknown[] }
    const already = (mine.jobs ?? []).length
    let created = already
    for (let i = already; i < SELF_JOB_LIMIT; i += 1) {
      await sec.call(
        'job.self.upsert',
        { name: `填充 ${i}`, prompt: 'x', intervalMinutes: 60 },
        { idempotencyKey: `fill-${i}` },
      )
      created += 1
    }
    assert.equal(created, SELF_JOB_LIMIT)
    await assert.rejects(
      () =>
        sec.call(
          'job.self.upsert',
          { name: '再来一条', prompt: 'x', intervalMinutes: 60 },
          { idempotencyKey: 'over-1' },
        ),
      /最多能排/,
    )
    /* 删掉一条后又能建（上限是"当前条数"，不是"累计次数"） */
    const list = (await sec.call('job.self.list', {})) as { jobs?: Array<{ jobId?: string }> }
    const victim = String(list.jobs?.[0]?.jobId ?? '')
    await sec.call('job.self.remove', { jobId: victim }, { idempotencyKey: 'trim-1' })
    await sec.call(
      'job.self.upsert',
      { name: '删完再建', prompt: 'x', intervalMinutes: 60 },
      { idempotencyKey: 'refill-1' },
    )
    const after = (await sec.call('job.self.list', {})) as { jobs?: unknown[] }
    assert.equal((after.jobs ?? []).length, SELF_JOB_LIMIT)
    sec.close()
  })
})
