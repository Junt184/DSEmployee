/**
 * 定时任务（Hub 侧调度器）。
 *
 * 两条最重要的语义都有意做得**可预测**，所以这一组测试大部分是纯函数：
 *
 *   · **错过的时间点跳过，不补跑** —— 笔电睡了 3 小时，醒来不该被 36 条历史任务淹没。
 *   · **相位不漂** —— "每 30 分钟"必须一直是 :00 与 :30，不能因为每轮耗时变成 31、32 分钟。
 *
 * 另外两层：真 Hub 上的 job.* 协议（含权限、自动停用、记录裁剪），以及
 * "目标机器离线时指令进离线邮箱"这条兜底（Hub 侧就能验，不需要真节点）。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { HubClient } from '../src/client/hub-client.ts'
import {
  AUTO_DISABLE_AFTER_FAILURES,
  MAX_RUNS_PER_JOB,
  MIN_INTERVAL_MS,
  advanceNextRun,
  dueJobs,
  normalizeInterval,
  recordRun,
  rollForwardMissed,
  runsFor,
} from '../src/hub/scheduler.ts'
import type { EmployeeRecord, NodeRecord, ScheduleJob, ScheduleRun } from '../src/hub/types.ts'

const MIN = 60_000

function makeJob(patch: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    jobId: 'job_1',
    name: '测试任务',
    employeeId: 'emp_a',
    prompt: '汇报一下',
    intervalMs: 30 * MIN,
    enabled: true,
    nextRunAtMs: 0,
    consecutiveFailures: 0,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...patch,
  }
}

describe('时间表：跳过错过的时间点，且相位不漂', () => {
  it('晚了 1 小时 20 分（间隔 30 分）→ 排到下一个整相位，只跑一次', () => {
    const base = 10 * 60 * MIN // 想象成 10:00
    const now = base + 80 * MIN // 11:20
    assert.equal(advanceNextRun(base, 30 * MIN, now), base + 90 * MIN) // 11:30
  })

  it('正好到点 → 推到下一个间隔（不是原地不动，否则会连着跑）', () => {
    const base = 10 * 60 * MIN
    assert.equal(advanceNextRun(base, 30 * MIN, base), base + 30 * MIN)
  })

  it('还没到点 → 不动（别把未来的时间表提前）', () => {
    const base = 10 * 60 * MIN
    assert.equal(advanceNextRun(base, 30 * MIN, base - MIN), base)
  })

  it('间隔被夹到合法区间（60 秒 ~ 30 天）', () => {
    assert.equal(normalizeInterval(1000), MIN_INTERVAL_MS)
    assert.equal(normalizeInterval(Number.NaN), MIN_INTERVAL_MS)
    assert.equal(normalizeInterval(30 * 24 * 60 * MIN + 1), 30 * 24 * 60 * MIN)
  })

  it('dueJobs 只挑启用的、且已到点的，按时间先后排', () => {
    const state = {
      jobs: {
        a: makeJob({ jobId: 'a', nextRunAtMs: 100 }),
        b: makeJob({ jobId: 'b', nextRunAtMs: 50 }),
        c: makeJob({ jobId: 'c', nextRunAtMs: 10, enabled: false }),
        d: makeJob({ jobId: 'd', nextRunAtMs: 9999 }),
      },
    } as unknown as Parameters<typeof dueJobs>[0]
    assert.deepEqual(
      dueJobs(state, 200).map((job) => job.jobId),
      ['b', 'a'],
    )
  })

  it('rollForwardMissed 把过期的任务一次推平（不补跑），只动启用的', () => {
    const state = {
      jobs: {
        a: makeJob({ jobId: 'a', nextRunAtMs: 0, intervalMs: 30 * MIN }),
        off: makeJob({ jobId: 'off', nextRunAtMs: 0, enabled: false }),
      },
    } as unknown as Parameters<typeof rollForwardMissed>[0]
    const now = 5 * 60 * MIN
    assert.equal(rollForwardMissed(state, now), 1)
    assert.ok((state.jobs['a']?.nextRunAtMs ?? 0) > now, '启用中的任务必须被推到未来')
    assert.equal(state.jobs['off']?.nextRunAtMs, 0, '停用的任务不动')
  })

  it('执行记录按上限裁剪：每任务最多留最近 N 条', () => {
    const state = { scheduleRuns: {} } as unknown as Parameters<typeof recordRun>[0]
    for (let i = 0; i < MAX_RUNS_PER_JOB + 5; i += 1) {
      const run: ScheduleRun = {
        runId: `run_${i}`,
        jobId: 'job_1',
        startedAtMs: i,
        status: 'dispatched',
      }
      recordRun(state, run)
    }
    const kept = runsFor(state as never, 'job_1', 100)
    assert.equal(kept.length, MAX_RUNS_PER_JOB)
    assert.equal(kept[0]?.runId, `run_${MAX_RUNS_PER_JOB + 4}`, '留下的是最近的')
  })
})

/* ────────────────── 真 Hub：协议、兜底、自动停用 ────────────────── */

let tmpRoot = ''
let home = ''
let hub: Hub
let hubUrl = ''

const EMP: EmployeeRecord = {
  id: 'emp_sched',
  nodeId: 'node_off',
  name: '小艾',
  role: '总控',
  workspacePath: '/tmp/nonexistent-sched',
  skills: [],
  status: 'ok',
  createdAtMs: 1,
  updatedAtMs: 1,
}
const OFFLINE_NODE: NodeRecord = {
  nodeId: 'node_off',
  name: '笔电',
  platform: 'darwin-arm64',
  employeeRoot: '/tmp/nonexistent-root',
  online: false,
  connectedAtMs: 1,
  lastSeenAtMs: 1,
  dshVersion: 'test',
}

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-scheduler-'))
  home = path.join(tmpRoot, 'home')
  const store = new HubStore(home)
  await store.load()
  store.state().employees[EMP.id] = EMP
  store.state().nodes[OFFLINE_NODE.nodeId] = OFFLINE_NODE
  await store.saveEmployees()
  await store.saveNodes()
  hub = new Hub({ home, port: 0, verbose: false })
  const address = await hub.start()
  hubUrl = address.wsUrl
})

after(async () => {
  await hub.stop()
  await rm(tmpRoot, { recursive: true, force: true })
})

async function makeOperator(name: string, scopes: string[]): Promise<HubClient> {
  const probe = await HubClient.create({
    identityFile: path.join(home, 'clients', `${name}.json`),
    url: hubUrl,
    role: 'operator',
    scopes: scopes as never,
    clientId: 'dse-cli',
    displayName: name,
    autoReconnect: false,
  })
  await assert.rejects(() => probe.connect())
  probe.close()

  const store = new HubStore(home)
  await store.load()
  const request = Object.values(store.state().pending).find(
    (r) => store.state().paired[r.deviceId] === undefined,
  )
  assert.ok(request !== undefined)
  await approvePairing(store, request.requestId, 'test', { approvedScopes: scopes as never })

  const client = await HubClient.create({
    identityFile: path.join(home, 'clients', `${name}.json`),
    url: hubUrl,
    role: 'operator',
    scopes: scopes as never,
    clientId: 'dse-cli',
    displayName: name,
    autoReconnect: false,
  })
  await client.connect()
  return client
}

describe('真 Hub：job.* 协议', () => {
  it('新建任务：nextRun 排在"现在 + 间隔"（不是立刻跑）', async () => {
    const op = await makeOperator('op-jobs', ['employee.read', 'employee.manage'])
    const before = Date.now()
    const created = (await op.call(
      'job.upsert',
      {
        name: '每小时汇报',
        employeeId: EMP.id,
        prompt: '把最近一小时的事汇总一下',
        intervalMinutes: 60,
      },
      { idempotencyKey: 'job-create-1' },
    )) as { job?: Record<string, unknown> }
    const job = created.job ?? {}
    assert.equal(job['employeeName'], '小艾')
    assert.equal(job['enabled'], true)
    const next = Number(job['nextRunAtMs'])
    assert.ok(next >= before + 60 * MIN - 5000 && next <= before + 60 * MIN + 5000, '下一次应当在一个间隔之后')
    assert.equal(job['nodeOnline'], false, '节点离线的状态要如实带出来')

    const listed = (await op.call('job.list', {})) as { jobs?: Array<Record<string, unknown>> }
    assert.equal((listed.jobs ?? []).length, 1)
    op.close()
  })

  it('员工不存在 → 直接拒绝（不留下一条"每次到点都失败"的任务）', async () => {
    const op = await makeOperator('op-jobs-2', ['employee.read', 'employee.manage'])
    await assert.rejects(
      () =>
        op.call(
          'job.upsert',
          { name: 'x', employeeId: 'emp_nope', prompt: 'y', intervalMinutes: 5 },
          { idempotencyKey: 'job-bad-1' },
        ),
      /not-found|unknown employee/,
    )
    op.close()
  })

  it('机器离线 + 没有已记住的会话 → 如实记成失败并说明原因（不假装派发成功）', async () => {
    const op = await makeOperator('op-jobs-3', ['employee.read', 'employee.manage'])
    const created = (await op.call(
      'job.upsert',
      {
        name: '离线任务的立刻跑',
        employeeId: EMP.id,
        prompt: '试试',
        intervalMinutes: 5,
      },
      { idempotencyKey: 'job-off-1' },
    )) as { job?: { jobId?: string } }
    const jobId = created.job?.jobId ?? ''
    const result = (await op.call('job.runNow', { jobId }, { idempotencyKey: 'job-off-run' })) as {
      run?: ScheduleRun
      job?: Record<string, unknown>
    }
    assert.equal(result.run?.status, 'failed')
    assert.match(String(result.run?.error ?? ''), /不在线/)
    /* 手动运行不动时间表 */
    const next = Number((result.job ?? {})['nextRunAtMs'])
    assert.ok(next > Date.now(), '下次时间不该被手动运行推到过去')
    op.close()
  })

  it('机器离线**但已记住会话** → 走离线邮箱排队（不是失败，等机器回来自动送出）', async () => {
    const op = await makeOperator('op-jobs-3b', ['employee.read', 'employee.manage'])
    const created = (await op.call(
      'job.upsert',
      {
        name: '记住会话后的离线派发',
        employeeId: EMP.id,
        prompt: '离线也要送到',
        intervalMinutes: 5,
        sessionId: 'session-known-1',
      },
      { idempotencyKey: 'job-off2-1' },
    )) as { job?: { jobId?: string } }
    const jobId = created.job?.jobId ?? ''

    const result = (await op.call('job.runNow', { jobId }, { idempotencyKey: 'job-off2-run' })) as {
      run?: ScheduleRun
    }
    assert.equal(result.run?.status, 'queued-offline', '离线时应当进邮箱排队')
    assert.match(String(result.run?.detail ?? ''), /已排队/)

    const queued = Object.values(hub.state().mailbox).filter(
      (item) => item.nodeId === OFFLINE_NODE.nodeId,
    )
    assert.equal(queued.length, 1, '邮箱里应当正好有一条待发指令')
    assert.equal(queued[0]?.method, 'session.prompt')
    assert.equal((queued[0]?.params as { sessionId?: string })?.sessionId, 'session-known-1')
    op.close()
  })

  it('连续失败到上限 → 自动停用并写明原因（不静默、也不无限重试）', async () => {
    const op = await makeOperator('op-jobs-4', ['employee.read', 'employee.manage'])
    const created = (await op.call(
      'job.upsert',
      { name: '必然失败的任务', employeeId: EMP.id, prompt: 'x', intervalMinutes: 1 },
      { idempotencyKey: 'job-fail-1' },
    )) as { job?: { jobId?: string } }
    const jobId = created.job?.jobId ?? ''

    let last: Record<string, unknown> = {}
    for (let i = 0; i < AUTO_DISABLE_AFTER_FAILURES; i += 1) {
      const res = (await op.call('job.runNow', { jobId }, { idempotencyKey: `job-fail-run-${i}` })) as {
        job?: Record<string, unknown>
      }
      last = res.job ?? {}
    }
    assert.equal(last['enabled'], false, '到上限就该自动停用')
    assert.match(String(last['disabledReason'] ?? ''), /连续失败/)
    assert.equal(last['consecutiveFailures'], AUTO_DISABLE_AFTER_FAILURES)

    /* 停用之后不该再被扫描到 */
    const state = hub.state()
    const due = dueJobs(state, Date.now() + 10 * MIN).filter((job) => job.jobId === jobId)
    assert.deepEqual(due, [])

    /* 重新启用：时间推到未来、失败计数清零、原因清掉 */
    const reopened = (await op.call(
      'job.upsert',
      { jobId, name: '必然失败的任务', employeeId: EMP.id, prompt: 'x', intervalMinutes: 1, enabled: true },
      { idempotencyKey: 'job-reopen-1' },
    )) as { job?: Record<string, unknown> }
    assert.equal(reopened.job?.['enabled'], true)
    assert.equal(reopened.job?.['consecutiveFailures'], 0)
    assert.equal(reopened.job?.['disabledReason'], undefined)
    op.close()
  })

  it('删任务会连它的执行记录一起清掉', async () => {
    const op = await makeOperator('op-jobs-5', ['employee.read', 'employee.manage'])
    const created = (await op.call(
      'job.upsert',
      { name: '待删', employeeId: EMP.id, prompt: 'x', intervalMinutes: 5 },
      { idempotencyKey: 'job-del-1' },
    )) as { job?: { jobId?: string } }
    const jobId = created.job?.jobId ?? ''
    await op.call('job.runNow', { jobId }, { idempotencyKey: 'job-del-run' })

    const removed = (await op.call('job.remove', { jobId }, { idempotencyKey: 'job-del-2' })) as {
      removed?: boolean
    }
    assert.equal(removed.removed, true)
    assert.equal(hub.state().jobs[jobId], undefined)
    assert.equal(
      Object.values(hub.state().scheduleRuns).filter((run) => run.jobId === jobId).length,
      0,
    )
    await assert.rejects(() => op.call('job.remove', { jobId }, { idempotencyKey: 'job-del-3' }), /unknown job/)
    op.close()
  })

  it('没有 employee.read 的设备看不到任务表（权限照旧走 scope）', async () => {
    const op = await makeOperator('op-jobs-6', ['employee.manage'])
    await assert.rejects(() => op.call('job.list', {}), /requires scope/)
    op.close()
  })
})
