import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dispatchJob } from '../src/hub/scheduler.ts'
import type { Hub } from '../src/hub/server.ts'
import type { ScheduleJob } from '../src/hub/types.ts'

type Response = Awaited<ReturnType<Hub['requestToNode']>>
function success(payload: unknown): Response { return { type: 'res', id: 'test', ok: true, payload } }
function makeJob(patch: Partial<ScheduleJob> = {}): ScheduleJob {
  return { jobId: 'job_a', name: '每日汇报', employeeId: 'emp_a', prompt: '整理今日进度',
    intervalMs: 60_000, enabled: true, nextRunAtMs: 0, consecutiveFailures: 0,
    createdAtMs: 0, updatedAtMs: 0, ...patch }
}

function fixture() {
  const calls: Array<{ nodeId: string; method: string; params: Record<string, unknown> }> = []
  const sessions = [{ sessionId: 'human-chat', updatedAt: 999, running: false }]
  let createResponse: Response | Error | undefined
  const hub = {
    state: () => ({ employees: { emp_a: { id: 'emp_a', nodeId: 'node_a', name: '小艾' } },
      nodes: { node_a: { nodeId: 'node_a', name: '工作机', online: true } } }),
    requestToNode: async (nodeId: string, method: string, params: Record<string, unknown>) => {
      calls.push({ nodeId, method, params })
      if (method === 'session.create') {
        if (createResponse instanceof Error) throw createResponse
        if (createResponse !== undefined) return createResponse
        const sessionId = String(params['sessionId'])
        if (!sessions.some((session) => session.sessionId === sessionId)) {
          sessions.push({ sessionId, updatedAt: 0, running: false })
        }
        return success({ sessionId })
      }
      if (method === 'session.list') return success({ sessions })
      assert.equal(method, 'session.prompt')
      return success({ accepted: true })
    },
  } as unknown as Hub
  return { hub, calls, sessions, setCreateResponse: (value: Response | Error | undefined) => { createResponse = value } }
}

describe('定时任务会话隔离', () => {
  it('首次派发为任务创建独立会话，较新的人工会话不会被借用', async () => {
    const h = fixture(), job = makeJob()
    const outcome = await dispatchJob(h.hub, job)
    assert.equal(outcome.status, 'dispatched')
    assert.equal(h.calls[0]?.method, 'session.create')
    assert.equal(h.calls[0]?.params['title'], '定时任务：每日汇报')
    assert.ok(job.sessionId)
    assert.notEqual(job.sessionId, 'human-chat')
    assert.equal(h.calls.find((call) => call.method === 'session.prompt')?.params['sessionId'], job.sessionId)
    assert.equal(outcome.sessionId, job.sessionId)
  })

  it('两个任务有各自的会话，重复派发复用各自的绑定', async () => {
    const h = fixture(), a = makeJob(), b = makeJob({ jobId: 'job_b' })
    await dispatchJob(h.hub, a)
    await dispatchJob(h.hub, b)
    await dispatchJob(h.hub, a)
    assert.notEqual(a.sessionId, b.sessionId)
    assert.equal(h.calls.filter((call) => call.method === 'session.create').length, 2)
    assert.deepEqual(h.calls.filter((call) => call.method === 'session.prompt').map((call) => call.params['sessionId']),
      [a.sessionId, b.sessionId, a.sessionId])
  })

  it('显式绑定的既有会话保持绑定', async () => {
    const h = fixture(), job = makeJob({ sessionId: 'human-chat' })
    await dispatchJob(h.hub, job)
    assert.equal(h.calls.some((call) => call.method === 'session.create'), false)
    assert.equal(h.calls.find((call) => call.method === 'session.prompt')?.params['sessionId'], 'human-chat')
  })

  it('创建失败不能回退到人工会话；缺少会话 id 也不能派发', async () => {
    for (const response of [
      { type: 'res', id: 'test', ok: false, error: { code: 'internal', message: '创建失败' } } as Response,
      success({}), new Error('连接断开'),
    ]) {
      const h = fixture(), job = makeJob()
      h.setCreateResponse(response)
      const outcome = await dispatchJob(h.hub, job)
      assert.equal(outcome.status, 'failed')
      assert.equal(job.sessionId, undefined)
      assert.equal(h.calls.some((call) => call.method === 'session.prompt'), false)
    }
  })

  it('创建回执丢失后的下一次派发使用相同预分配 id', async () => {
    const h = fixture(), job = makeJob()
    h.setCreateResponse(new Error('回执超时'))
    await dispatchJob(h.hub, job)
    const requested = h.calls[0]!.params['sessionId']
    h.setCreateResponse(undefined)
    await dispatchJob(h.hub, job)
    assert.equal(h.calls.filter((call) => call.method === 'session.create')[1]!.params['sessionId'], requested)
    assert.equal(job.sessionId, requested)
  })

  it('任务的上一轮仍在运行时跳过，人工会话忙碌不会阻止独立任务', async () => {
    const h = fixture(), job = makeJob()
    h.sessions[0]!.running = true
    assert.equal((await dispatchJob(h.hub, job)).status, 'dispatched')
    h.sessions.find((session) => session.sessionId === job.sessionId)!.running = true
    assert.equal((await dispatchJob(h.hub, job)).status, 'skipped')
    assert.equal(h.calls.filter((call) => call.method === 'session.prompt').length, 1)
  })
})
