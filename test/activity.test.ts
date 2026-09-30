/**
 * 员工活动汇总（`employee.activity`）—— "秘书"汇报的数据来源。
 *
 * 这一组的重点不是"能返回数据"，而是**它不该返回什么**：
 *   · 只有元数据，没有对话正文（要看正文得另外调 session.history，那是另一个决定）；
 *   · 只算窗口内的记录，且每类都有条数上限（汇总是给人/模型看的，不是全量导出）；
 *   · 长文本一律截断。
 * 另外两条"诚实性"要求：节点离线时不许把"没有数据"说成"没有活动"，只记 notes。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ACTIVITY_TEXT_LIMIT, collectActivity } from '../src/hub/activity.ts'
import type { Hub } from '../src/hub/server.ts'
import type { EmployeeRecord, HubSnapshot } from './activity-fixtures.ts'
import { makeFakeHub } from './activity-fixtures.ts'

const NOON = 1_700_000_000_000
const HOUR = 3_600_000

const EMP_A: EmployeeRecord = {
  id: 'emp_a',
  nodeId: 'node_1',
  name: '总控',
  role: 'orchestrator',
  workspacePath: '/tmp/a',
  skills: [],
  status: 'ok',
  createdAtMs: 1,
  updatedAtMs: 1,
  position: 'pos_orch',
}
const EMP_B: EmployeeRecord = {
  id: 'emp_b',
  nodeId: 'node_1',
  name: '秘书',
  role: 'secretary',
  workspacePath: '/tmp/b',
  skills: [],
  status: 'ok',
  createdAtMs: 1,
  updatedAtMs: 1,
}

function snapshot(patch: Partial<HubSnapshot> = {}): HubSnapshot {
  return {
    employees: { emp_a: EMP_A, emp_b: EMP_B },
    nodes: {
      node_1: {
        nodeId: 'node_1',
        name: '本机Mac',
        platform: 'darwin-arm64',
        employeeRoot: '/tmp',
        online: true,
        connectedAtMs: 1,
        lastSeenAtMs: 1,
        dshVersion: 'test',
      },
    },
    jobs: {},
    scheduleRuns: {},
    invokes: {},
    approvals: {},
    ...patch,
  }
}

async function run(
  snap: HubSnapshot,
  options: Parameters<typeof collectActivity>[1] = {},
): Promise<Awaited<ReturnType<typeof collectActivity>>> {
  const sessions = options.listSessions
  return await collectActivity(makeFakeHub(snap) as unknown as Hub, {
    now: NOON,
    listSessions: sessions ?? (async () => []),
    ...options,
  })
}

describe('活动汇总：窗口与上限', () => {
  it('窗口外的记录一律不算（默认 24 小时）', async () => {
    const snap = snapshot({
      jobs: {
        job_1: {
          jobId: 'job_1',
          name: '每小时汇报',
          employeeId: 'emp_a',
          prompt: 'x',
          intervalMs: HOUR,
          enabled: true,
          nextRunAtMs: NOON + HOUR,
          consecutiveFailures: 0,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      },
      scheduleRuns: {
        run_new: { runId: 'run_new', jobId: 'job_1', startedAtMs: NOON - HOUR, status: 'dispatched' },
        run_old: { runId: 'run_old', jobId: 'job_1', startedAtMs: NOON - 30 * HOUR, status: 'failed' },
      },
    })
    const report = await run(snap)
    const a = report.employees.find((item) => item.employeeId === 'emp_a')
    assert.equal(a?.jobRuns.length, 1, '30 小时前那条不该出现')
    assert.equal(a?.jobRuns[0]?.status, 'dispatched')
  })

  it('每类记录按时间倒序并截到上限（先看到的一定是最新的）', async () => {
    const invokes: HubSnapshot['invokes'] = {}
    for (let i = 0; i < 8; i += 1) {
      invokes[`inv_${i}`] = {
        invokeId: `inv_${i}`,
        fromEmployeeId: 'emp_a',
        toEmployeeId: 'emp_b',
        task: `任务 ${i}`,
        status: 'completed',
        createdAtMs: NOON - (8 - i) * 60_000,
      }
    }
    const report = await run(snapshot({ invokes }), { maxItems: 3 })
    const a = report.employees.find((item) => item.employeeId === 'emp_a')
    assert.equal(a?.invokesOut.length, 3)
    assert.deepEqual(
      a?.invokesOut.map((item) => item.task),
      ['任务 7', '任务 6', '任务 5'],
    )
    const b = report.employees.find((item) => item.employeeId === 'emp_b')
    assert.equal(b?.invokesIn.length, 3, '被调方也看得到（从它的视角）')
    assert.equal(b?.invokesIn[0]?.fromName, '总控')
  })

  it('长任务与结果文本会截断（汇总是给人/模型看的，不是全量导出）', async () => {
    const long = 'x'.repeat(2000)
    const report = await run(
      snapshot({
        invokes: {
          inv_1: {
            invokeId: 'inv_1',
            fromEmployeeId: 'emp_a',
            toEmployeeId: 'emp_b',
            task: long,
            status: 'completed',
            createdAtMs: NOON - 60_000,
            resultText: long,
          },
        },
      }),
    )
    const a = report.employees.find((item) => item.employeeId === 'emp_a')
    const task = a?.invokesOut[0]?.task ?? ''
    assert.ok(task.length <= ACTIVITY_TEXT_LIMIT, '任务文本要截断')
    assert.match(task, /…$/)
    assert.ok((a?.invokesOut[0]?.result ?? '').length <= ACTIVITY_TEXT_LIMIT)
  })

  it('窗口参数被夹在 1 分钟 ~ 7 天之间', async () => {
    const tiny = await run(snapshot(), { windowMs: 1 })
    assert.equal(tiny.windowMs, 60_000)
    const huge = await run(snapshot(), { windowMs: 30 * 24 * HOUR })
    assert.equal(huge.windowMs, 7 * 24 * HOUR)
  })
})

describe('活动汇总：诚实性', () => {
  it('节点离线时说明"它的会话活动没算进来"，而不是当成没有活动', async () => {
    const snap = snapshot()
    snap.nodes['node_1'] = { ...snap.nodes['node_1']!, online: false }
    const report = await run(snap)
    assert.ok(
      report.notes.some((note) => /不在线.*没有算进来/.test(note)),
      '离线必须写进 notes',
    )
    const a = report.employees.find((item) => item.employeeId === 'emp_a')
    assert.equal(a?.nodeOnline, false)
    assert.equal(a?.sessions.count, 0)
  })

  it('明说"只有元数据、正文要另外读"（防止汇总被当成全知）', async () => {
    const report = await run(snapshot())
    assert.ok(report.notes.some((note) => /只含.*元数据/.test(note)))
  })

  it('读会话元数据失败不致命：记 note，其余数据照给', async () => {
    const report = await run(snapshot(), {
      listSessions: async () => {
        throw new Error('boom')
      },
    })
    assert.ok(report.notes.some((note) => /读会话元数据失败/.test(note)))
    assert.equal(report.employees.length, 2)
  })

  it('会话元数据只取计数与最近活跃，不含量内容', async () => {
    const report = await run(snapshot(), {
      listSessions: async () => [
        { sessionId: 's1', title: 'x', updatedAtMs: NOON - 60_000 },
        { sessionId: 's2', updatedAtMs: NOON - 5 * HOUR },
        { sessionId: 's3', updatedAtMs: NOON - 3 * 24 * HOUR },
        { sessionId: 's4', updatedAtMs: NOON - 60_000, running: true },
      ],
    })
    const a = report.employees.find((item) => item.employeeId === 'emp_a')
    assert.equal(a?.sessions.count, 3, '只算窗口内活跃的：s1/s2/s4 在 24 小时内，s3 在 3 天前')
    assert.equal(a?.sessions.runningCount, 1)
    assert.equal(a?.sessions.lastActiveAtMs, NOON - 60_000)
    const serialized = JSON.stringify(report)
    assert.doesNotMatch(serialized, /sessionId/, '不该把会话 id 泄给汇总层（元数据足够）')
  })

  it('按 employeeIds 过滤；过滤掉所有人时明说原因', async () => {
    const only = await run(snapshot(), { employeeIds: ['emp_b'] })
    assert.deepEqual(
      only.employees.map((item) => item.employeeId),
      ['emp_b'],
    )
    const none = await run(snapshot(), { employeeIds: ['emp_nope'] })
    assert.equal(none.employees.length, 0)
    assert.ok(none.notes.some((note) => /没有匹配的员工/.test(note)))
  })

  it('审批按种类取"跟谁有关"：互调审批看 from/to，dsh 审批/提问看 employeeId', async () => {
    const report = await run(
      snapshot({
        approvals: {
          appr_invoke: {
            approvalId: 'appr_invoke',
            kind: 'employee.invoke',
            fromEmployeeId: 'emp_a',
            toEmployeeId: 'emp_b',
            task: '帮我查一下',
            status: 'approved',
            requestedAtMs: NOON - HOUR,
            correlationId: 'c1',
          },
          appr_dsh: {
            approvalId: 'appr_dsh',
            kind: 'dsh.approval',
            employeeId: 'emp_b',
            nodeId: 'node_1',
            sessionId: 's1',
            toolName: 'bash',
            status: 'pending',
            requestedAtMs: NOON - 2 * HOUR,
            dshApprovalId: 'd1',
            rpcId: 'r1',
          },
        },
      }),
    )
    const a = report.employees.find((item) => item.employeeId === 'emp_a')
    const b = report.employees.find((item) => item.employeeId === 'emp_b')
    assert.equal(a?.approvals.length, 1, '总控只看到那条互调审批')
    assert.match(a?.approvals[0]?.summary ?? '', /我调「秘书」：帮我查一下/, '要写清方向，别让人误读成对方发起的')
    assert.equal(b?.approvals.length, 2, '秘书看到互调审批 + 自己的 dsh 审批')
    assert.ok(b?.approvals.some((item) => /bash/.test(item.summary)))
    assert.ok(
      b?.approvals.some((item) => /「总控」调我：帮我查一下/.test(item.summary)),
      '被调方看到的也要有方向',
    )
  })
})
