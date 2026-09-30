/**
 * `employee.activity` 测试用的假 Hub。
 *
 * 为什么用假 Hub 而不是起真 Hub：这一组要验的是**筛选/截断/诚实性**这些纯逻辑，
 * 真 Hub 只会让每条用例多花几百毫秒；而"真 Hub 上这个方法能不能调"由
 * `test/invoke-identity.test.ts` 那种端到端用例负责（那边已经有真握手与真配对）。
 * 这里的假对象只实现 collectActivity 真正用到的那一个方法（`state()`）——
 * 少一样就让类型报错，免得假对象悄悄偏离真实接口。
 */

import type {
  ApprovalRecord,
  EmployeeRecord,
  InvokeRecord,
  NodeRecord,
  ScheduleJob,
  ScheduleRun,
} from '../src/hub/types.ts'

export type { EmployeeRecord }

export interface HubSnapshot {
  employees: Record<string, EmployeeRecord>
  nodes: Record<string, NodeRecord>
  jobs: Record<string, ScheduleJob>
  scheduleRuns: Record<string, ScheduleRun>
  invokes: Record<string, InvokeRecord>
  approvals: Record<string, ApprovalRecord>
}

/** 只提供 collectActivity 用到的 `state()`；requestToNode 由调用方显式注入替身。 */
export function makeFakeHub(snapshot: HubSnapshot): { state: () => unknown } {
  return { state: () => snapshot }
}
