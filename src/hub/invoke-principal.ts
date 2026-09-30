/**
 * 跨员工调用（`employee.invoke`）里"**谁在发起**"的派生规则。
 *
 * 为什么要单独拎出来：原来 `from` 直接取请求里的 `fromEmployeeId`，handler 把连接
 * 身份丢在一边（`_conn`）。那意味着**任何**持有 `employee.invoke` scope 的设备都能
 * 以任意员工的名义发起调用 —— 实测复现过：用一个 operator 设备、声称"我是小艾"，
 * 就拿到了"小艾→小明"那条 ACL 规则并成功执行，台账里记的发起人是假的。
 * 员工手里一旦有凭据（本方案的下一步就是给它们发凭据），这个洞就从"管理员可以冒充"
 * 升级成"员工之间可以互相冒名派活"。
 *
 * 规则（fail closed，宁可拒绝也不猜）：
 *
 *   1. 设备绑定了员工（员工自己的凭据）→ `from` **只能是**它绑定的那个员工；
 *      请求里写了别的员工，直接拒绝（不是静默改成绑定值 —— 那会让越权尝试悄无声息）。
 *   2. 未绑定的 operator（人用的控制台 / CLI）→ 必须在请求里**显式声明**
 *      `onBehalfOf: true`，并且记下发起设备 id。代员工发起是合法需求（人在环里的
 *      编排、脚本、定时任务），但要留痕，不能和"员工自己的调用"混为一谈。
 *   3. 两者都不满足 → 拒绝。
 *
 * 这里只做**身份派生**，不做 ACL 判定 —— ACL 在 handler 里用派生出的员工 id 去算
 * （evaluateAcl）。两件事分开，是为了让"我是谁"和"我能不能"各自可测。
 */

/** 调用方声明的参数（与 invokeSchema 对应）。 */
export interface InvokeIdentityInput {
  /** 发起员工。绑定设备可省略（就用绑定的那个）；未绑定设备必须给。 */
  fromEmployeeId?: string
  /** 未绑定设备代员工发起时的显式声明（审计用） */
  onBehalfOf?: boolean
}

/** 认证连接里与身份派生有关的部分。 */
export interface InvokeCaller {
  deviceId: string
  role: string
  boundEmployeeId?: string
  /** role=node 时它代表的节点 id（用于校验"只能代表本机上的员工"） */
  nodeId?: string
}

export type InvokePrincipalResult =
  | {
      ok: true
      fromEmployeeId: string
      principal: 'employee-device' | 'operator-delegated'
      delegatedByDeviceId?: string
    }
  | { ok: false; code: 'forbidden' | 'bad-request'; message: string }

export function resolveInvokePrincipal(
  caller: InvokeCaller,
  input: InvokeIdentityInput,
): InvokePrincipalResult {
  const claimed = input.fromEmployeeId === undefined ? '' : String(input.fromEmployeeId)

  if (caller.boundEmployeeId !== undefined && caller.boundEmployeeId !== '') {
    if (claimed !== '' && claimed !== caller.boundEmployeeId) {
      return {
        ok: false,
        code: 'forbidden',
        message:
          '这台设备绑定的是另一个员工，不能以别的员工名义发起调用' +
          '（员工凭据只代表它自己；要代员工发起请用 operator 连接）',
      }
    }
    return {
      ok: true,
      fromEmployeeId: caller.boundEmployeeId,
      principal: 'employee-device',
    }
  }

  if (claimed === '') {
    return {
      ok: false,
      code: 'bad-request',
      message: 'fromEmployeeId 必填（只有绑定到员工的设备才可以省略：那就用它绑定的那个员工）',
    }
  }

  if (input.onBehalfOf !== true) {
    return {
      ok: false,
      code: 'forbidden',
      message:
        'operator 代员工发起调用需要显式声明 onBehalfOf: true —— ' +
        '否则无法区分"员工自己发起的"和"人替它发起的"，台账也就不可信',
    }
  }

  return {
    ok: true,
    fromEmployeeId: claimed,
    principal: 'operator-delegated',
    delegatedByDeviceId: caller.deviceId,
  }
}
