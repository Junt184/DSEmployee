/**
 * 机器级权限档位（dsh 的 `settings.permission.defaultPreset`）的读写。
 *
 * 为什么是机器级：dsh 0.1.0-rc.6 只有这一个写入口（按会话/按员工设档位的接口逐个试过，
 * 全是 not found）。所以这一组守的就两件事：
 *   1. **读**：dsh 报什么就是什么；报不上来（没这个 namespace / 值不认识）就返回 undefined，
 *      **绝不猜一个"工作区可写"**（猜出来的默认值会让人以为"我设过"）；
 *   2. **写**：写进 `permission` namespace 的 `defaultPreset`，且只接受三档之一。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  isPermissionPreset,
  PERMISSION_PRESETS,
  readDefaultPreset,
  writeDefaultPreset,
} from '../src/node/permission.ts'
import type { DshClient } from '../src/node/dsh-client.ts'

function fakeDsh(describeValue: unknown): { dsh: DshClient; calls: Array<{ method: string; payload: unknown }> } {
  const calls: Array<{ method: string; payload: unknown }> = []
  const dsh = {
    call: async (method: string, payload: unknown) => {
      calls.push({ method, payload })
      if (method === 'settings.describe') return describeValue
      return {}
    },
  } as unknown as DshClient
  return { dsh, calls }
}

describe('机器级权限档位', () => {
  it('三档常量与判定（别让"custom"之类的值混进来）', () => {
    assert.deepEqual([...PERMISSION_PRESETS], ['read-only', 'workspace-write', 'danger-full-access'])
    assert.equal(isPermissionPreset('danger-full-access'), true)
    assert.equal(isPermissionPreset('custom'), false)
    assert.equal(isPermissionPreset(undefined), false)
    assert.equal(isPermissionPreset(1), false)
  })

  it('读：从 settings.describe 的 permission namespace 里取 defaultPreset', async () => {
    const { dsh } = fakeDsh({
      namespaces: [
        { ns: 'ui-theme', value: { preference: 'system' } },
        { ns: 'permission', value: { defaultPreset: 'danger-full-access' } },
      ],
    })
    assert.equal(await readDefaultPreset(dsh), 'danger-full-access')
  })

  it('读不出来 ⇒ undefined（不许猜一个默认值）', async () => {
    const noNs = fakeDsh({ namespaces: [{ ns: 'ui-theme', value: {} }] })
    assert.equal(await readDefaultPreset(noNs.dsh), undefined)
    const weirdValue = fakeDsh({ namespaces: [{ ns: 'permission', value: { defaultPreset: 'custom' } }] })
    assert.equal(await readDefaultPreset(weirdValue.dsh), undefined, '不认识的值不算"读到了"')
    const broken = fakeDsh({ namespaces: 'not an array' })
    assert.equal(await readDefaultPreset(broken.dsh), undefined)
  })

  it('写：落到 permission namespace 的 defaultPreset 这一条路径上', async () => {
    const { dsh, calls } = fakeDsh({ namespaces: [] })
    await writeDefaultPreset(dsh, 'danger-full-access')
    const mutate = calls.find((c) => c.method === 'settings.mutate')
    assert.ok(mutate !== undefined)
    const payload = mutate.payload as { ns: string; ops: Array<{ op: string; path: string[]; value: unknown }> }
    assert.equal(payload.ns, 'permission')
    assert.equal(payload.ops[0]?.op, 'set')
    assert.deepEqual(payload.ops[0]?.path, ['defaultPreset'])
    assert.equal(payload.ops[0]?.value, 'danger-full-access')
  })
})
