/**
 * 定时任务调度器（Hub 侧）。
 *
 * 放在 Hub 的三个理由：它一直醒着（节点常是笔电）、它知道全部员工目录、
 * 而且它已经有**离线邮箱**——目标机器不在线时，`session.prompt` 会自动进队列，
 * 等节点回来按序送出。于是"定时叫某个员工干活"这件事不需要任何新通道。
 *
 * 语义（有意选简单、可预测的那一种）：
 *
 *   · **错过的时间点跳过**，不补跑。笔电睡了 3 小时，醒来不该被 36 条历史任务淹没；
 *     一台机器的离线不该在它上线后变成一场雪崩。
 *   · 节奏钉在原来的相位上（`nextRunAtMs += k × interval`），不是"每次从 now 重新计时"——
 *     否则每轮的执行耗时都会让时间慢慢漂走，"每 30 分钟"会变成"每 31、32…分钟"。
 *   · 只记**派发结果**，不冒充"任务成功"：Hub 刻意不解析会话事件（设计如此），
 *     所以它只知道"指令交出去了没有"。结果在被调员工的会话里，谁要看谁去读。
 *   · 连续失败到上限**自动停用并写明原因**：不停用会变成每分钟一次的无用功，
 *     静默停用又等于骗人 —— 所以停用 + 在控制台把原因摆出来。
 *   · 派发成功后把会话 id 记进任务里：下次目标机器离线时，仍能把指令排进那个会话
 *     （否则"不知道发哪儿"会让离线兜底根本用不上）。
 */

import { newId } from '../util/fsx.ts'
import { QUEUEABLE_METHODS, enqueueForNode, mailboxItemsFor } from './mailbox.ts'
import type { Hub } from './server.ts'
import type { HubState } from './store.ts'
import type { ScheduleJob, ScheduleRun } from './types.ts'

/** 扫描间隔：15 秒足够准（最小任务间隔是 1 分钟），也不会让 Hub 空转。 */
export const SCHEDULER_TICK_MS = 15_000
/** 最小任务间隔：比一次真实回合还短的间隔只会堆队列。 */
export const MIN_INTERVAL_MS = 60_000
/** 最大任务间隔：30 天（再长就不是"定时"了，用户其实想要一次性的）。 */
export const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000
/** 连续失败几次后自动停用。 */
export const AUTO_DISABLE_AFTER_FAILURES = 5
/** 执行记录上限（全局，超出丢最旧的）。 */
export const MAX_RUNS = 500
/** 每个任务保留的执行记录条数（列表里够看"最近几次"就行）。 */
export const MAX_RUNS_PER_JOB = 20

/** 把间隔夹到合法区间。 */
export function normalizeInterval(intervalMs: number): number {
  if (!Number.isFinite(intervalMs)) return MIN_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(intervalMs)))
}

/**
 * 把 `nextRunAtMs` 推到**未来**，并保持原相位（错过的时间点一律跳过）。
 *
 * 例：interval=30min、next=10:00，现在 11:20 → 11:30（跳过 10:30、11:00 两个点），
 * 而不是 11:50（从 now 重新计时会漂）。
 */
export function advanceNextRun(nextRunAtMs: number, intervalMs: number, now: number): number {
  const interval = normalizeInterval(intervalMs)
  if (!Number.isFinite(nextRunAtMs) || nextRunAtMs > now) return nextRunAtMs
  const missed = Math.floor((now - nextRunAtMs) / interval)
  return nextRunAtMs + (missed + 1) * interval
}

/** 当前到点的任务（按 nextRunAtMs 升序 —— 先到点的先跑）。 */
export function dueJobs(state: HubState, now: number): ScheduleJob[] {
  return Object.values(state.jobs)
    .filter((job) => job.enabled === true && job.nextRunAtMs <= now)
    .sort((a, b) => a.nextRunAtMs - b.nextRunAtMs)
}

/**
 * Hub 启动时把**过去的时间点**一次性推平：不补跑，但要保证 nextRunAtMs 在未来。
 * 返回被顺延的任务数（调用方记日志，避免"为什么没跑"变成谜）。
 */
export function rollForwardMissed(state: HubState, now: number): number {
  let moved = 0
  for (const job of Object.values(state.jobs)) {
    if (job.enabled !== true) continue
    if (job.nextRunAtMs > now) continue
    job.nextRunAtMs = advanceNextRun(job.nextRunAtMs, job.intervalMs, now)
    job.updatedAtMs = now
    moved += 1
  }
  return moved
}

/** 记一条执行记录，并按上限裁剪（全局 + 每任务各一条）。 */
export function recordRun(
  state: HubState,
  run: ScheduleRun,
  options: { maxRuns?: number; maxPerJob?: number } = {},
): ScheduleRun {
  state.scheduleRuns[run.runId] = run
  const maxRuns = options.maxRuns ?? MAX_RUNS
  const maxPerJob = options.maxPerJob ?? MAX_RUNS_PER_JOB

  const all = Object.values(state.scheduleRuns).sort((a, b) => a.startedAtMs - b.startedAtMs)
  for (const stale of all.slice(0, Math.max(0, all.length - maxRuns))) {
    delete state.scheduleRuns[stale.runId]
  }

  const mine = Object.values(state.scheduleRuns)
    .filter((item) => item.jobId === run.jobId)
    .sort((a, b) => a.startedAtMs - b.startedAtMs)
  for (const stale of mine.slice(0, Math.max(0, mine.length - maxPerJob))) {
    delete state.scheduleRuns[stale.runId]
  }
  return run
}

/** 某任务的执行记录（新的在前）。 */
export function runsFor(state: HubState, jobId: string, limit = MAX_RUNS_PER_JOB): ScheduleRun[] {
  return Object.values(state.scheduleRuns)
    .filter((run) => run.jobId === jobId)
    .sort((a, b) => b.startedAtMs - a.startedAtMs)
    .slice(0, limit)
}

export interface DispatchOutcome {
  status: ScheduleRun['status']
  sessionId?: string
  detail?: string
  error?: string
}

/**
 * 真正派发一轮：把任务的指令作为一条普通消息发给目标员工。
 *
 * 会话怎么定：任务里记着就用它；否则问节点的会话列表取最近活跃的那个，
 * 一个都没有就新建一个 —— 然后把 id 记回任务里（离线兜底要用）。
 */
export async function dispatchJob(hub: Hub, job: ScheduleJob): Promise<DispatchOutcome> {
  const state = hub.state()
  const employee = state.employees[job.employeeId]
  if (employee === undefined) {
    return { status: 'failed', error: `员工不存在（${job.employeeId}）` }
  }

  const node = state.nodes[employee.nodeId]
  const online = node?.online === true

  let sessionId = job.sessionId ?? ''
  if (sessionId === '') {
    if (!online) {
      /* 没有会话可投、机器又不在线：这一轮只能算"没派出去"。
         不是静默失败 —— 记录里写清原因，控制台能看到。 */
      return {
        status: 'failed',
        error: `节点「${node?.name ?? employee.nodeId}」不在线，且这个任务还没有已记住的会话`,
      }
    }
    try {
      const listed = await hub.requestToNode(employee.nodeId, 'session.list', {
        employeeId: employee.id,
      })
      const sessions = Array.isArray((listed.payload as { sessions?: unknown })?.sessions)
        ? ((listed.payload as { sessions: Array<Record<string, unknown>> }).sessions ?? [])
        : []
      const newest = sessions
        .slice()
        .sort((a, b) => Number(b['updatedAt'] ?? b['updatedAtMs'] ?? 0) - Number(a['updatedAt'] ?? a['updatedAtMs'] ?? 0))[0]
      sessionId = typeof newest?.['sessionId'] === 'string' ? String(newest['sessionId']) : ''
      if (sessionId === '') {
        const created = await hub.requestToNode(employee.nodeId, 'session.create', {
          employeeId: employee.id,
          title: `定时任务：${job.name}`,
        })
        sessionId =
          typeof (created.payload as { sessionId?: unknown })?.sessionId === 'string'
            ? String((created.payload as { sessionId: string }).sessionId)
            : ''
      }
    } catch (error) {
      return {
        status: 'failed',
        error: `拿不到会话：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (sessionId === '') {
      return { status: 'failed', error: '节点没有给出可用的会话 id' }
    }
    /* 记住它：下次机器离线时，指令还能排进这个会话的队列 */
    job.sessionId = sessionId
  }

  const params = { employeeId: employee.id, sessionId, mode: 'queue', text: job.prompt }

  /* 机器不在线：走 **Hub 的离线邮箱**，而不是直接调 requestToNode。
     这是有意的：requestToNode 是"现在就问节点要答案"，节点不在线只会立刻报
     node-offline；而邮箱会把这条指令存下来，等节点重新注册时按序送出 ——
     与控制台里用户手打一句指令走的是**同一条路**（见 handlers.ts 的 forwardToNode）。
     实测踩过：早先直接调 requestToNode，于是"机器不在线"被记成了派发失败。 */
  if (!online) {
    if (QUEUEABLE_METHODS['session.prompt'] !== true) {
      return { status: 'failed', sessionId, error: '目标方法不支持离线排队' }
    }
    const { dropped } = await enqueueForNode(hub, employee.nodeId, 'session.prompt', params)
    const waiting = mailboxItemsFor(state, employee.nodeId).length
    return {
      status: 'queued-offline',
      sessionId,
      detail:
        `→ ${employee.name}（机器不在线，已排队，待发 ${waiting} 条）` +
        (dropped.length === 0 ? '' : `；队列已满，丢掉了最旧的 ${dropped.length} 条`),
    }
  }

  const res = await hub.requestToNode(employee.nodeId, 'session.prompt', params, 30_000)

  if (res.ok === true) {
    const queued = (res.payload as { queued?: unknown } | undefined)?.queued === true
    return {
      status: queued ? 'queued-offline' : 'dispatched',
      sessionId,
      detail: `→ ${employee.name}${queued ? '（节点刚掉线，已进队列）' : '（节点在线）'}`,
    }
  }

  /* 刚刚掉线（状态还没更新到节点台账）也要能排队，而不是记成失败 */
  if ((res.error?.code ?? '') === 'node-offline' && QUEUEABLE_METHODS['session.prompt'] === true) {
    await enqueueForNode(hub, employee.nodeId, 'session.prompt', params)
    return {
      status: 'queued-offline',
      sessionId,
      detail: `→ ${employee.name}（发送瞬间节点掉线，已排队）`,
    }
  }

  const code = res.error?.code ?? 'internal'
  return {
    status: 'failed',
    sessionId,
    error: `${code}: ${res.error?.message ?? '派发失败'}`,
  }
}

export interface RunJobOptions {
  /** 是否按计划推进 nextRunAtMs（手动"立即运行"不动时间表） */
  advanceSchedule?: boolean
  now?: number
}

/** 跑一轮任务：派发 → 记账 → 推进时间表（或停用）。 */
export async function runJob(
  hub: Hub,
  job: ScheduleJob,
  options: RunJobOptions = {},
): Promise<ScheduleRun> {
  const state = hub.state()
  const now = options.now ?? Date.now()
  const run: ScheduleRun = {
    runId: newId('run'),
    jobId: job.jobId,
    startedAtMs: now,
    status: 'skipped',
  }

  const outcome = await dispatchJob(hub, job)
  run.status = outcome.status
  if (outcome.sessionId !== undefined) run.sessionId = outcome.sessionId
  if (outcome.detail !== undefined) run.detail = outcome.detail
  if (outcome.error !== undefined) run.error = outcome.error
  run.finishedAtMs = Date.now()

  if (outcome.status === 'failed') {
    job.consecutiveFailures += 1
    if (job.consecutiveFailures >= AUTO_DISABLE_AFTER_FAILURES) {
      job.enabled = false
      job.disabledReason = `连续失败 ${job.consecutiveFailures} 次，已自动停用（最近一次：${outcome.error ?? '未知原因'}）`
      hub.log(`job ${job.jobId} auto-disabled after ${job.consecutiveFailures} failures`)
    }
  } else {
    job.consecutiveFailures = 0
    if (job.disabledReason !== undefined && job.enabled === true) delete job.disabledReason
    job.lastRunAtMs = run.finishedAtMs
  }

  if (options.advanceSchedule !== false) {
    job.nextRunAtMs = advanceNextRun(job.nextRunAtMs, job.intervalMs, now)
  }
  job.updatedAtMs = Date.now()

  recordRun(state, run)
  await hub.store.saveJobs()
  await hub.store.saveScheduleRuns()
  hub.broadcastToScope('employee.read', 'job.ran', {
    jobId: job.jobId,
    runId: run.runId,
    status: run.status,
    ...(run.error === undefined ? {} : { error: run.error }),
    nextRunAtMs: job.nextRunAtMs,
  })
  if (job.enabled !== true) {
    hub.broadcastToScope('employee.read', 'job.changed', { jobId: job.jobId, enabled: false })
  }
  return run
}

/**
 * 启动调度循环，返回停止函数（Hub 关闭时调用）。
 *
 * 为什么用 `setTimeout` 链而不是 `setInterval`：一次扫描里可能有多次派发（各自要
 * 几秒），固定间隔会让上一轮还没跑完下一轮就叠上来。链式调度天然串行。
 */
export function startScheduler(hub: Hub): () => void {
  let stopped = false
  let timer: NodeJS.Timeout | undefined

  const moved = rollForwardMissed(hub.state(), Date.now())
  if (moved > 0) {
    hub.log(`scheduler: rolled ${moved} job(s) forward (missed slots are skipped, not replayed)`)
    void hub.store.saveJobs()
  }
  const total = Object.keys(hub.state().jobs).length
  if (total > 0) hub.log(`scheduler: started with ${total} job(s)`)

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const now = Date.now()
      for (const job of dueJobs(hub.state(), now)) {
        if (stopped) return
        hub.log(`scheduler: running job ${job.jobId} (${job.name}) → ${job.employeeId.slice(0, 12)}…`)
        await runJob(hub, job)
      }
    } catch (error) {
      hub.log(`scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (stopped) return
    timer = setTimeout(() => void tick(), SCHEDULER_TICK_MS)
    timer.unref?.()
  }

  timer = setTimeout(() => void tick(), 1000)
  timer.unref?.()

  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
}
