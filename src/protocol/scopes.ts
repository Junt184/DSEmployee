/**
 * 角色与权限域模型。
 *
 * 沿用 OpenClaw 的"role + scope 二维"设计，并按本产品的域重命名：
 *  - role 决定"你是谁"（控制端 / 执行端）
 *  - scope 决定"你能做什么"，且**服务端逐方法强制**，节点自我声明的能力只当"声明"看
 *
 * 安全姿态：未知 scope / 未知方法一律 fail-closed（拒绝）。
 */

/** 连接角色。 */
export const ROLES = ['operator', 'node'] as const
export type Role = (typeof ROLES)[number]

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/**
 * 权限域清单。
 *
 * 命名规则：`<域>.<动作>`，域与产品概念对齐（employee/node/device/acl/approval）。
 */
export const SCOPES = [
  /** 看员工目录、会话历史、运行记录 */
  'employee.read',
  /** 给员工下指令 / 建会话 / 打断 */
  'employee.prompt',
  /** 建删改员工、改知识库与技能 */
  'employee.manage',
  /** 以"员工"身份调用另一个员工（互调） */
  'employee.invoke',
  /**
   * 管理**自己**的定时任务（只对"绑定了员工"的凭据有意义）。
   *
   * 为什么单列一个窄 scope，而不是发 employee.manage：后者能建删改**任何**员工、
   * 还能改 ACL —— 那是管理员的权限。员工要的只是"给自己挂个每天 9 点的提醒",
   * 多给一分都是多余的面（见 job.self.* 的 handler：目标员工一律从绑定身份派生）。
   */
  'job.self',
  /** 管理终端节点（改名、改配置、重启 dsh） */
  'node.admin',
  /** 批准/拒绝新设备、轮换吊销令牌 */
  'device.pair',
  /** 裁决审批请求 */
  'approval.resolve',
] as const

export type Scope = (typeof SCOPES)[number]

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES)

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && SCOPE_SET.has(value)
}

/** 过滤出合法 scope 并去重排序；非法项被丢弃（调用方若需报错应自行校验）。 */
export function normalizeScopes(values: readonly unknown[]): Scope[] {
  const out = new Set<Scope>()
  for (const value of values) {
    if (isScope(value)) out.add(value)
  }
  return [...out].sort()
}

/**
 * 一个 scope 集合是否覆盖所需 scope。
 * 空的 `required` 表示"认证后即可用"（如 health / whoami）。
 */
export function scopeSatisfies(granted: readonly Scope[], required: readonly Scope[]): boolean {
  if (required.length === 0) return true
  const have = new Set<string>(granted)
  for (const need of required) {
    if (!have.has(need)) return false
  }
  return true
}

/** 计算 `granted` 相对于 `ceiling` 越权的 scope。用于"令牌不可自我扩权"的校验。 */
export function scopesExceeding(granted: readonly Scope[], ceiling: readonly Scope[]): Scope[] {
  const allowed = new Set<string>(ceiling)
  return granted.filter((scope) => !allowed.has(scope))
}

/**
 * 各角色的 scope 上限（ceiling）。
 *
 * 这是"有界令牌"的根据：一次配对批准的 role/scopes 就是上限，
 * 之后签发的任何令牌都只能是它的子集，永远无法自我扩权。
 */
export const ROLE_SCOPE_CEILING: Readonly<Record<Role, readonly Scope[]>> = {
  operator: [
    'employee.read',
    'employee.prompt',
    'employee.manage',
    'employee.invoke',
    'job.self',
    'node.admin',
    'device.pair',
    'approval.resolve',
  ],
  // 终端节点只需要"上报自己"和"以员工身份被调用"，
  // 刻意不给 device.pair / approval.resolve —— 执行端不应能批准自己或别人。
  node: ['employee.read', 'employee.invoke'],
}

export function ceilingFor(role: Role): readonly Scope[] {
  return ROLE_SCOPE_CEILING[role]
}
