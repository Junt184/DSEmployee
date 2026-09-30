/**
 * 员工自定义头像（employee.avatar.*）的节点侧单元测试。
 *
 * dsh 用最小假对象（avatar 存取本不碰 dsh，只有 create 会注册工作区）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { EmployeeStore, AVATAR_MAX_BYTES } from '../src/node/employees.ts'
import type { DshClient } from '../src/node/dsh-client.ts'

const fakeDsh = {
  workspaceCreate: async () => ({ workspaceId: 'w-test' }),
} as unknown as DshClient

describe('员工自定义头像', () => {
  async function withStore(run: (store: EmployeeStore, employeeId: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-avatar-test-'))
    try {
      const store = new EmployeeStore(root, fakeDsh)
      await store.init()
      const employee = await store.create({ name: '小测', role: '测试' })
      await run(store, employee.id)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  const PNG = Buffer.from('89504e470d0a1a0a0000000d', 'hex') // PNG 魔数开头的一小段

  it('set → get 回读（mimeType/大小/内容一致），discover 上报 hasAvatar', async () => {
    await withStore(async (store, employeeId) => {
      const written = await store.avatarSet(employeeId, { mimeType: 'image/png', data: PNG })
      assert.equal(written.size, PNG.length)

      const avatar = await store.avatarGet(employeeId)
      assert.ok(avatar !== undefined)
      assert.equal(avatar.mimeType, 'image/png')
      assert.ok(avatar.data.equals(PNG))
      assert.ok(avatar.updatedAtMs > 0)

      const { employees } = await store.discover()
      assert.equal(employees.find((e) => e.id === employeeId)?.hasAvatar, true)
    })
  })

  it('没有头像 → get 返回 undefined；remove 幂等', async () => {
    await withStore(async (store, employeeId) => {
      assert.equal(await store.avatarGet(employeeId), undefined)
      assert.deepEqual(await store.avatarRemove(employeeId), { removed: false })
      await store.avatarSet(employeeId, { mimeType: 'image/png', data: PNG })
      assert.deepEqual(await store.avatarRemove(employeeId), { removed: true })
      assert.deepEqual(await store.avatarRemove(employeeId), { removed: false }, '二次删除幂等')
      assert.equal(await store.avatarGet(employeeId), undefined)
    })
  })

  it('mimeType 白名单与 2MB 上限', async () => {
    await withStore(async (store, employeeId) => {
      await assert.rejects(
        () => store.avatarSet(employeeId, { mimeType: 'image/svg+xml', data: PNG }),
        /不支持的图片类型/,
      )
      await assert.rejects(
        () => store.avatarSet(employeeId, { mimeType: 'image/png', data: Buffer.alloc(AVATAR_MAX_BYTES + 1) }),
        /上限/,
      )
      await assert.rejects(
        () => store.avatarSet(employeeId, { mimeType: 'image/png', data: Buffer.alloc(0) }),
        /为空/,
      )
    })
  })

  it('换格式时旧文件被清掉（avatar.png 与 avatar.webp 不并存）', async () => {
    await withStore(async (store, employeeId) => {
      await store.avatarSet(employeeId, { mimeType: 'image/png', data: PNG })
      await store.avatarSet(employeeId, { mimeType: 'image/webp', data: PNG })
      const { employees } = await store.discover()
      const dir = path.join(employees[0]?.workspacePath ?? '', '.dsemployee')
      const files = (await readdir(dir)).filter((f) => f.startsWith('avatar.'))
      assert.deepEqual(files, ['avatar.webp'], '同一员工只留一个头像文件')
      assert.equal((await store.avatarGet(employeeId))?.mimeType, 'image/webp')
      const info = await stat(path.join(dir, 'avatar.webp'))
      // 权限位的断言只在类 POSIX 平台上做（与 employee-llm.test.ts 同一套判断）：
      // Windows 的 fs.stat().mode 不反映 POSIX 位，那里的文件访问由 ACL 决定。
      if (process.platform !== 'win32') {
        assert.equal(info.mode & 0o777, 0o600)
      } else {
        assert.ok(info.isFile(), '头像必须落盘为普通文件')
      }
    })
  })
})
