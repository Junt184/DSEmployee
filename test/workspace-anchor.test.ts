/**
 * 工作区 git 锚点 + 私有技能可见性审计。
 *
 * 这一组守的是同一个失效模式：**写了私有技能却没生效，而且不报错**。
 *
 *   · dsh 的私有技能根是 `<projectRoot>/.dsh/skills`，projectRoot 由 `findProjectRoot()`
 *     决定 —— 只认 `.git`（从 cwd 往上找第一个含 `.git` 的祖先）。工作区没有自己的
 *     `.git` 时，projectRoot 落到外层仓库 ⇒ 工作区的技能被静默忽略；
 *   · 因此 `create()` 必须自建锚点（实测发现的真缺陷：原来**从不** `git init`，
 *     而它却会预先建好 `.dsh/skills` 目录 —— 等于邀请人写一个永远不会生效的技能）；
 *   · 发现阶段把锚点状态报上去，审计函数把"磁盘上有 / dsh 扫不到"算成明确结论。
 *
 * 审计刻意有第三种结果：**没核对**（员工还没有会话，拿不到 dsh 视图）。
 * "不知道"必须与"没问题"分开 —— 假装没问题正是这套体检要消灭的东西。
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { auditPrivateSkills } from '../src/node/agent.ts'
import { EmployeeStore } from '../src/node/employees.ts'
import type { DshClient } from '../src/node/dsh-client.ts'

const fakeDsh = {
  workspaceCreate: async () => ({ workspaceId: 'w-test' }),
} as unknown as DshClient

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-anchor-test-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function writeSkill(workspacePath: string, name: string, body: string): Promise<void> {
  const dir = path.join(workspacePath, '.dsh', 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), body)
}

const VALID_SKILL = '---\nname: weekly-report\ndescription: 整理周报\n---\n正文\n'

describe('新建员工的工作区锚点', () => {
  it('create() 会 git init（否则该员工的私有技能永远扫不到）', async () => {
    await withRoot(async (root) => {
      const store = new EmployeeStore(root, fakeDsh)
      await store.init()
      const employee = await store.create({ name: '小锚', role: '测试' })
      assert.equal(employee.hasGitAnchor, true, 'create() 之后工作区应有 .git')

      const { employees } = await store.discover()
      const found = employees.find((e) => e.id === employee.id)
      assert.ok(found !== undefined)
      assert.equal(found.hasGitAnchor, true, '发现阶段也要如实上报锚点')
    })
  })

  it('手工造的工作区（没有 .git）会被如实报为没有锚点', async () => {
    await withRoot(async (root) => {
      const workspace = path.join(root, '手工员工')
      await mkdir(path.join(workspace, '.dsemployee'), { recursive: true })
      await writeFile(
        path.join(workspace, '.dsemployee', 'employee.json'),
        JSON.stringify({ id: 'emp_manual_1', name: '手工', role: '测试', createdAtMs: 1 }),
      )
      await writeSkill(workspace, 'private-one', VALID_SKILL)

      const store = new EmployeeStore(root, fakeDsh)
      await store.init()
      const { employees } = await store.discover()
      const found = employees.find((e) => e.id === 'emp_manual_1')
      assert.ok(found !== undefined)
      assert.equal(found.hasGitAnchor, false)
      assert.deepEqual(found.skills, ['private-one'], '磁盘上的私有技能仍应被列出')
    })
  })
})

describe('私有技能可见性审计', () => {
  const privates = [{ name: 'private-one', valid: true }]

  it('没核对时必须说"没核对"，不能假装没问题', () => {
    const audit = auditPrivateSkills(privates, true, undefined)
    assert.equal(audit.checked, false)
    assert.deepEqual(audit.missing, [])
    assert.equal(audit.hint, undefined)
  })

  it('dsh 视图里能看到 → 无问题', () => {
    const audit = auditPrivateSkills(privates, true, { skills: [{ name: 'private-one' }] })
    assert.equal(audit.checked, true)
    assert.deepEqual(audit.missing, [])
    assert.equal(audit.hint, undefined)
  })

  it('写了但 dsh 没扫到 + 缺锚点 → 直接点名 .git 锚点', () => {
    const audit = auditPrivateSkills(privates, false, { skills: [{ name: '别的技能' }] })
    assert.equal(audit.checked, true)
    assert.deepEqual(audit.missing, ['private-one'])
    assert.match(String(audit.hint), /\.git 锚点/)
  })

  it('写了但没扫到 + 有锚点 → 指向 frontmatter 不合规', () => {
    const audit = auditPrivateSkills(privates, true, { skills: [] })
    assert.deepEqual(audit.missing, ['private-one'])
    assert.match(String(audit.hint), /frontmatter/)
  })

  it('dsh 视图形状不认识（旧版/异常）→ 视为没核对，而不是"全都没扫到"', () => {
    const audit = auditPrivateSkills(privates, true, { unexpected: true })
    assert.equal(audit.checked, false)
    assert.deepEqual(audit.missing, [])
  })

  it('frontmatter 不合规的技能被单独列出（dsh 对它是告警+忽略）', () => {
    const audit = auditPrivateSkills(
      [
        { name: 'good-one', valid: true },
        { name: 'bad-one', valid: false },
      ],
      true,
      { skills: [{ name: 'good-one' }, { name: 'bad-one' }] },
    )
    assert.deepEqual(audit.invalid, ['bad-one'])
    assert.deepEqual(audit.missing, [], '都在 dsh 视图里可见（是否生效由 invalid 表达）')
  })

  it('没扫到 + 问题是 BOM → 提示直接点名 BOM，不说"多半 frontmatter 不合规"', () => {
    /* 真机上就是这样：文件其实完全合规，只是开头多了 3 个字节，dsh 直接忽略。
       含糊的提示会把人指向错误的排查方向（去改 frontmatter，怎么改都没用）。 */
    const audit = auditPrivateSkills(
      [
        { name: 'windows-baseline', valid: false, issues: ['文件开头有 UTF-8 BOM（\\uFEFF）：dsh 的解析器不剥 BOM，会把这个技能整个忽略'] },
      ],
      true,
      { skills: [] },
    )
    assert.deepEqual(audit.missing, ['windows-baseline'])
    assert.deepEqual(audit.invalid, ['windows-baseline'])
    assert.match(String(audit.hint), /BOM/)
    assert.match(String(audit.hint), /windows-baseline/)
    assert.ok(!String(audit.hint).includes('多半是 frontmatter'), 'BOM 已确诊时不该再给含糊提示：' + audit.hint)
  })

  it('有锚点、没 BOM、没扫到 → 仍旧指向 frontmatter（原有行为不许变）', () => {
    const audit = auditPrivateSkills([{ name: 'x', valid: false, issues: ['缺少必填字段 name'] }], true, { skills: [] })
    assert.match(String(audit.hint), /frontmatter/)
    assert.ok(!String(audit.hint).includes('BOM'))
  })
})
