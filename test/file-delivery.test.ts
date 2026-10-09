import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises'
import path from 'node:path'
import { ensureFileDeliveryInstructions } from '../src/node/file-delivery.ts'
import { EmployeeStore, UPLOAD_MAX_BYTES } from '../src/node/employees.ts'
import type { DshClient } from '../src/node/dsh-client.ts'

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-file-delivery-'))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

describe('员工文件交付指令', () => {
  it('存量员工补齐交付约定；不改自定义岗位说明、本地指令；重复安装不重复写', async () => {
    await withWorkspace(async (workspace) => {
      const agents = '# 自定义岗位说明\n保持我的设定。\n', local = '# 本机补充\n用中文回答。\n'
      await writeFile(path.join(workspace, 'AGENTS.md'), agents)
      const overlay = path.join(workspace, 'AGENTS.local.md')
      await writeFile(overlay, local)
      await ensureFileDeliveryInstructions(workspace)
      const first = await readFile(overlay, 'utf8'), firstStat = await stat(overlay)
      assert.ok(first.startsWith(local))
      assert.match(first, /\[报告.pdf\]\(dse-file:交付物\/报告.pdf\)/)
      assert.equal(await readFile(path.join(workspace, 'AGENTS.md'), 'utf8'), agents)
      await ensureFileDeliveryInstructions(workspace)
      assert.equal(await readFile(overlay, 'utf8'), first)
      assert.equal((await stat(overlay)).mtimeMs, firstStat.mtimeMs)
    })
  })

  it('更新平台管理的块时保留前后的手工指令', async () => {
    await withWorkspace(async (workspace) => {
      const overlay = path.join(workspace, 'AGENTS.local.md')
      await writeFile(overlay, '之前\n<!-- dsemployee:file-delivery:start -->\n旧约定\n<!-- dsemployee:file-delivery:end -->\n之后\n')
      await ensureFileDeliveryInstructions(workspace)
      const current = await readFile(overlay, 'utf8')
      assert.ok(current.startsWith('之前\n'))
      assert.ok(current.endsWith('\n之后\n'))
      assert.ok(!current.includes('旧约定'))
    })
  })

  it('新建员工自动装配；员工生成的二进制与空文件可原样下载，拒绝越界和超限', async () => {
    await withWorkspace(async (root) => {
      const fakeDsh = { workspaceCreate: async () => ({ workspaceId: 'w' }) } as unknown as DshClient
      const store = new EmployeeStore(path.join(root, 'employees'), fakeDsh)
      await store.init()
      const employee = await store.create({ name: '小艾', role: '生成报告' })
      assert.match(await readFile(path.join(employee.workspacePath, 'AGENTS.local.md'), 'utf8'), /dse-file:/)
      await mkdir(path.join(employee.workspacePath, '交付物'))
      const bytes = Buffer.from([0, 255, 42, 1])
      await writeFile(path.join(employee.workspacePath, '交付物/报告.pdf'), bytes)
      const received = await store.downloadFile(employee.id, '交付物/报告.pdf')
      assert.deepEqual(received.data, bytes)
      assert.equal(received.mimeType, 'application/pdf')
      await writeFile(path.join(employee.workspacePath, 'empty.txt'), '')
      assert.equal((await store.downloadFile(employee.id, 'empty.txt')).size, 0)
      await writeFile(path.join(employee.workspacePath, 'big.zip'), Buffer.alloc(UPLOAD_MAX_BYTES + 1))
      await assert.rejects(() => store.downloadFile(employee.id, 'big.zip'), /too large to download/)
      await assert.rejects(() => store.downloadFile(employee.id, '../secret'), /escapes the employee workspace/)
      await writeFile(path.join(root, 'secret'), 'outside')
      await symlink(path.join(root, 'secret'), path.join(employee.workspacePath, 'shortcut.txt'))
      await assert.rejects(() => store.downloadFile(employee.id, 'shortcut.txt'), /escapes the employee workspace/)
    })
  })
})
