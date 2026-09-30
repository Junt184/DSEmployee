/**
 * `job.self.*` —— 员工给自己排任务时的身份派生。
 *
 * 与 `resolveInvokePrincipal` 同一个思路：**目标员工由认证连接派生，不听请求自报**。
 * 理由也一样：员工手里一旦有凭据，自报的 employeeId 就成了"谁能给谁排任务"的口子
 * （排任务 = 让某台机器在某个时刻自动执行一段指令，比一次调用更持久）。
 *
 * 只给一个窄权限（`job.self`）而不是 `employee.manage`：后者能建删改任何员工、还能改
 * ACL，是管理员权限。员工要的只是"给自己挂个每天 9 点的提醒"，多给一分都是多余的面。
 *
 * 未绑定员工身份的设备（普通 operator、节点）即使拿到了 `job.self` scope 也不能用：
 * 它没法回答"这是给谁排的"。要用就显式走 job.upsert（scope employee.manage）——
 * 那是管理动作，本来就该由人来做。
 */

/** 一个员工最多能给自己排多少条任务（防止"自己给自己刷一堆定时任务"）。 */
export const SELF_JOB_LIMIT = 10

export interface SelfJobCaller {
  deviceId: string
  role: string
  boundEmployeeId?: string
}

export interface SelfJobInput {
  jobId?: string
  employeeId?: string
}

export type SelfJobResolution =
  | { ok: true; employeeId: string }
  | { ok: false; code: 'forbidden' | 'bad-request'; message: string }

/**
 * 解析"这次操作针对哪个员工"。
 *
 * 规则（fail closed）：
 *   1. 连接必须绑定到一个员工 —— 否则无从谈起（`job.self` 的语义就是"自己的"）。
 *   2. 请求里若写了 employeeId，必须与绑定的那个**一致**；不一致直接拒绝，
 *      不静默改写 —— 越权尝试必须看得见。
 */
export function resolveSelfJobEmployee(
  caller: SelfJobCaller,
  input: SelfJobInput = {},
): SelfJobResolution {
  const bound = caller.boundEmployeeId ?? ''
  if (bound === '') {
    return {
      ok: false,
      code: 'forbidden',
      message:
        '这台设备没有绑定员工身份，不能用 job.self.*（它只代表"某个员工自己的任务"）。' +
        '要替员工排任务请用 operator 凭据调 job.upsert。',
    }
  }
  const claimed = input.employeeId === undefined ? '' : String(input.employeeId)
  if (claimed !== '' && claimed !== bound) {
    return {
      ok: false,
      code: 'forbidden',
      message: '只能给自己排任务：这台设备绑定的是另一个员工',
    }
  }
  return { ok: true, employeeId: bound }
}
