/**
 * 机器级权限档位（dsh 的 `settings.permission.defaultPreset`）—— 读与写。
 *
 * 为什么是**机器级**：dsh 0.1.0-rc.6 只暴露了这一个写入口。按会话/按员工设档位的接口
 * 我们逐个候选名试过（`session.permissions`、`session.setPermission`、
 * `session.permissionPresets`…）全是 not found；而按员工的"别老是问我"需求
 * 已经由 Hub 侧的 `employee.autoApprove.set` 覆盖（见 handlers.ts 那段注释）。
 *
 * 语义必须说清（界面上也要写）：它只改**新建会话**的默认值，
 * **已有会话不受影响**（dsh 在会话创建时就把档位钉进去了），
 * 而且它影响的是**这台机器上所有员工**，不是某一个。
 */

import type { DshClient } from './dsh-client.ts'

/** dsh 认得的三档（`dsh-permission-presets` 的表）。 */
export const PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type PermissionPreset = (typeof PERMISSION_PRESETS)[number]

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return typeof value === 'string' && (PERMISSION_PRESETS as readonly string[]).includes(value)
}

/** 读当前默认档位；dsh 不给（或答非所问）时返回 undefined，绝不猜一个值。 */
export async function readDefaultPreset(dsh: DshClient): Promise<PermissionPreset | undefined> {
  const described = await dsh.call('settings.describe', {})
  const namespaces = (described as { namespaces?: unknown }).namespaces
  if (!Array.isArray(namespaces)) return undefined
  for (const entry of namespaces) {
    const ns = entry as { ns?: unknown; value?: unknown }
    if (ns.ns !== 'permission') continue
    const preset = (ns.value as { defaultPreset?: unknown } | undefined)?.defaultPreset
    return isPermissionPreset(preset) ? preset : undefined
  }
  return undefined
}

/** 写默认档位。传进来的值必须先过 `isPermissionPreset`（调用方负责）。 */
export async function writeDefaultPreset(dsh: DshClient, preset: PermissionPreset): Promise<void> {
  await dsh.call('settings.mutate', {
    ns: 'permission',
    ops: [{ op: 'set', path: ['defaultPreset'], value: preset }],
  })
}
