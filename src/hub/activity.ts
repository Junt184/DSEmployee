/**
 * 员工活动汇总（`employee.activity`）—— 给"秘书"这类角色用的**元数据**视图。
 *
 * 为什么需要它、而不是让秘书直接读别人的会话历史：
 *   · 汇报需要的是"谁在什么时候干了什么、成没成"，不是别人的逐字对话；
 *   · 会话历史可能很大（一条会话几千个事件），拉全量既慢又没必要；
 *   · 元数据是**可枚举、可截断**的，隐私面小得多 —— 谁真的要看正文，
 *     可以另外调 session.history（那是另一个决定，不该被"汇总"顺手做掉）。
 *
 * 数据来源全在 Hub 自己手里（定时任务的执行记录、互调记录、审批记录）+ 各节点的
 * 会话**元数据**（session.list：id/标题/最近活跃/是否在跑）。节点离线时不编造，
 * 只在 notes 里说明"这台机器的数据没算进来"。
 */

import type { Hub } from './server.ts'
import type { HubState } from './store.ts'
import type { EmployeeRecord } from './types.ts'

/** 默认看最近 24 小时。 */
export const ACTIVITY_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000
/** 最久 7 天（再久就不是"最近"了，而且记录本身会被裁剪）。 */
export const ACTIVITY_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** 每个员工每类记录最多给几条。 */
export const ACTIVITY_MAX_ITEMS = 20
/** 任务/结果文本的截断长度：汇总是给模型看的，长文本既贵又没必要。 */
export const ACTIVITY_TEXT_LIMIT = 240

export interface ActivityOptions {
  windowMs?: number
  /** 只看这些员工（不给 = 全部） */
  employeeIds?: readonly string[]
  maxItems?: number
  now?: number
  /** 覆盖"取会话元数据"的实现（测试用；默认打节点 RPC） */
  listSessions?: (employee: EmployeeRecord) => Promise<SessionSummary[]>
}

/** 节点的会话元数据（只取这几个字段，不碰事件内容）。 */
export interface SessionSummary {
  sessionId: string
  title?: string
  updatedAtMs?: number
  running?: boolean
}

export interface EmployeeActivity {
  employeeId: string
  name: string
  role: string
  position?: string
  nodeName?: string
  nodeOnline: boolean
  /** 定时任务的执行记录（按时间倒序，窗口内） */
  jobRuns: Array<{ jobName: string; status: string; startedAtMs: number; note?: string }>
  /** 这位员工**发起**的互调 */
  invokesOut: Array<{ toName: string; task: string; status: string; atMs: number; result?: string }>
  /** **别人调它**的互调 */
  invokesIn: Array<{ fromName: string; task: string; status: string; atMs: number; result?: string }>
  /** 与它相关的审批（它请求的 / 要调它的） */
  approvals: Array<{ kind: string; status: string; summary: string; atMs: number }>
  /** 会话元数据（不含量内容） */
  sessions: { count: number; lastActiveAtMs?: number; runningCount: number }
}

export interface ActivityReport {
  windowMs: number
  since: number
  employees: EmployeeActivity[]
  /** 数据不全的地方（例如某台机器离线）—— 必须如实说，不许让汇总看起来"什么都有" */
  notes: string[]
}

function truncate(text: string, limit = ACTIVITY_TEXT_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + '…'
}

function inWindow(atMs: number | undefined, since: number): boolean {
  return typeof atMs === 'number' && atMs >= since
}

/** 默认取会话元数据的实现：打该员工所在节点的 session.list（短超时，失败不致命）。 */
export function nodeSessionLister(hub: Hub): (employee: EmployeeRecord) => Promise<SessionSummary[]> {
  return async (employee) => {
    const res = await hub.requestToNode(employee.nodeId, 'session.list', { employeeId: employee.id }, 5000)
    if (res.ok !== true) return []
    const raw = (res.payload as { sessions?: unknown } | undefined)?.sessions
    if (!Array.isArray(raw)) return []
    return raw
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item) => ({
        sessionId: String(item['sessionId'] ?? ''),
        ...(typeof item['title'] === 'string' ? { title: item['title'] } : {}),
        ...(typeof item['updatedAt'] === 'number'
          ? { updatedAtMs: item['updatedAt'] }
          : typeof item['updatedAtMs'] === 'number'
            ? { updatedAtMs: item['updatedAtMs'] }
            : {}),
        ...(item['running'] === true ? { running: true } : {}),
      }))
      .filter((item) => item.sessionId !== '')
  }
}

/**
 * 收集活动汇总。
 *
 * 排序：每类都按时间**倒序**（最近的在最前），并截到 `maxItems` 条 ——
 * 汇总的人（或模型）先看到的一定是最新的。
 */
export async function collectActivity(hub: Hub, options: ActivityOptions = {}): Promise<ActivityReport> {
  const state: HubState = hub.state()
  const now = options.now ?? Date.now()
  const windowMs = Math.min(
    ACTIVITY_MAX_WINDOW_MS,
    Math.max(60_000, options.windowMs ?? ACTIVITY_DEFAULT_WINDOW_MS),
  )
  const since = now - windowMs
  const maxItems = Math.max(1, options.maxItems ?? 10)
  const listSessions = options.listSessions ?? nodeSessionLister(hub)

  const wanted = options.employeeIds === undefined ? undefined : new Set(options.employeeIds)
  const employees = Object.values(state.employees)
    .filter((employee) => wanted === undefined || wanted.has(employee.id))
    .sort((a, b) => a.name.localeCompare(b.name))

  const nameOf = (id: string): string => state.employees[id]?.name ?? id

  const report: ActivityReport = { windowMs, since, employees: [], notes: [] }

  for (const employee of employees) {
    const node = state.nodes[employee.nodeId]
    const nodeOnline = node?.online === true

    /* 定时任务执行记录：jobs 里属于它的 + runs 里窗口内的 */
    const jobRuns: EmployeeActivity['jobRuns'] = []
    for (const job of Object.values(state.jobs)) {
      if (job.employeeId !== employee.id) continue
      for (const run of Object.values(state.scheduleRuns)) {
        if (run.jobId !== job.jobId || !inWindow(run.startedAtMs, since)) continue
        jobRuns.push({
          jobName: job.name,
          status: run.status,
          startedAtMs: run.startedAtMs,
          ...(run.error !== undefined ? { note: truncate(run.error) } : {}),
          ...(run.error === undefined && run.detail !== undefined ? { note: truncate(run.detail) } : {}),
        })
      }
    }
    jobRuns.sort((a, b) => b.startedAtMs - a.startedAtMs)

    const invokesOut: EmployeeActivity['invokesOut'] = []
    const invokesIn: EmployeeActivity['invokesIn'] = []
    for (const invoke of Object.values(state.invokes)) {
      const atMs = invoke.finishedAtMs ?? invoke.createdAtMs
      if (!inWindow(atMs, since)) continue
      const base = {
        task: truncate(invoke.task),
        status: invoke.status,
        atMs,
        ...(invoke.resultText === undefined ? {} : { result: truncate(invoke.resultText) }),
      }
      if (invoke.fromEmployeeId === employee.id) {
        invokesOut.push({ toName: nameOf(invoke.toEmployeeId), ...base })
      } else if (invoke.toEmployeeId === employee.id) {
        invokesIn.push({ fromName: nameOf(invoke.fromEmployeeId), ...base })
      }
    }
    invokesOut.sort((a, b) => b.atMs - a.atMs)
    invokesIn.sort((a, b) => b.atMs - a.atMs)

    /* 审批有三类（互调审批 / dsh 审批 / dsh 提问），后两类只认 employeeId，
       所以要分情况取"这件事跟谁有关"——不能一律当互调审批读字段。 */
    const approvals: EmployeeActivity['approvals'] = []
    for (const approval of Object.values(state.approvals)) {
      const atMs = approval.resolvedAtMs ?? approval.requestedAtMs
      if (!inWindow(atMs, since)) continue
      let summary = ''
      if (approval.kind === 'employee.invoke') {
        const mine = approval.fromEmployeeId === employee.id
        if (!mine && approval.toEmployeeId !== employee.id) continue
        const counterparty = nameOf(mine ? approval.toEmployeeId : approval.fromEmployeeId)
        /* 写清"我与对方的关系"：只写「小明：…」会被读成"小明是发起方" ——
           演练时汇总的模型就把它当成字段口径不一致报了上来（措辞该修，不是数据错）。 */
        summary = (mine ? '我调「' : '「') + counterparty + (mine ? '」：' : '」调我：') + approval.task
      } else if (approval.kind === 'dsh.approval') {
        if (approval.employeeId !== employee.id) continue
        summary = approval.toolName + (approval.reason === undefined ? '' : '（' + approval.reason + '）')
      } else {
        if (approval.employeeId !== employee.id) continue
        summary = '员工提问（' + String(approval.questions.length) + ' 个问题）'
      }
      approvals.push({
        kind: String(approval.kind),
        status: String(approval.status),
        summary: truncate(summary),
        atMs,
      })
    }
    approvals.sort((a, b) => b.atMs - a.atMs)

    /* 会话元数据：节点离线就没有 —— 如实记进 notes，而不是当作"没有活动" */
    let sessions: EmployeeActivity['sessions'] = { count: 0, runningCount: 0 }
    if (nodeOnline) {
      try {
        const listed = await listSessions(employee)
        const active = listed.filter((item) => item.updatedAtMs === undefined || inWindow(item.updatedAtMs, since))
        const lastActive = active.reduce<number | undefined>(
          (best, item) =>
            item.updatedAtMs !== undefined && (best === undefined || item.updatedAtMs > best)
              ? item.updatedAtMs
              : best,
          undefined,
        )
        sessions = {
          count: active.length,
          runningCount: listed.filter((item) => item.running === true).length,
          ...(lastActive === undefined ? {} : { lastActiveAtMs: lastActive }),
        }
      } catch (error) {
        report.notes.push(
          `${employee.name}：读会话元数据失败（${error instanceof Error ? error.message : String(error)}）`,
        )
      }
    } else {
      report.notes.push(
        `${employee.name}：所在节点「${node?.name ?? employee.nodeId}」当前不在线，它的会话活动没有算进来`,
      )
    }

    report.employees.push({
      employeeId: employee.id,
      name: employee.name,
      role: employee.role,
      ...(employee.position === undefined ? {} : { position: employee.position }),
      ...(node === undefined ? {} : { nodeName: node.name }),
      nodeOnline,
      jobRuns: jobRuns.slice(0, maxItems),
      invokesOut: invokesOut.slice(0, maxItems),
      invokesIn: invokesIn.slice(0, maxItems),
      approvals: approvals.slice(0, maxItems),
      sessions,
    })
  }

  if (report.employees.length === 0) {
    report.notes.push('没有匹配的员工（目录为空，或过滤条件把人都排除了）')
  }
  /* 这条说明很重要：汇总的读者需要知道"这里只有元数据，正文要另外去读" */
  report.notes.push('本汇总只含**元数据**（谁/何时/干了什么/成或败）；要看具体对话内容需另外读该员工的会话历史')
  return report
}
