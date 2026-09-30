/**
 * 技能清单校验（EmployeeStore.describeSkills，employee.skills.list 的数据源）单元测试。
 *
 * 校验规则对齐 dsh（docs/02 §12.2）：必填 name（kebab-case）与 description，
 * 旧驼峰键、非法布尔、缺 frontmatter 都算问题 —— dsh 对不合规技能是「告警 + 忽略」，
 * 这里要保证「写了但没生效」能被如实报出来，且坏文件不会炸掉整个清单。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { EmployeeStore } from '../src/node/employees.ts'
import type { DshClient } from '../src/node/dsh-client.ts'

const fakeDsh = {
  workspaceCreate: async () => ({ workspaceId: 'w-test' }),
} as unknown as DshClient

async function withStore(run: (store: EmployeeStore, workspacePath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-skills-test-'))
  try {
    const store = new EmployeeStore(root, fakeDsh)
    await store.init()
    const employee = await store.create({ name: '小测', role: '测试' })
    await run(store, employee.workspacePath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 写一个目录形态技能：<工作区>/.dsh/skills/<name>/SKILL.md */
async function writeBundleSkill(workspacePath: string, name: string, content: string): Promise<void> {
  const dir = path.join(workspacePath, '.dsh', 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), content)
}

/** 写一个平铺形态技能：<工作区>/.dsh/skills/<name>.md */
async function writeFlatSkill(workspacePath: string, name: string, content: string): Promise<void> {
  await writeFile(path.join(workspacePath, '.dsh', 'skills', `${name}.md`), content)
}

const VALID_FRONTMATTER = (name: string) => `---
name: ${name}
description: 测试技能
---

# 正文
`

describe('技能清单校验（describeSkills）', () => {
  it('合规目录形态 → valid，无 issues', async () => {
    await withStore(async (store, workspacePath) => {
      await writeBundleSkill(workspacePath, 'weekly-report', VALID_FRONTMATTER('weekly-report'))
      const skills = await store.describeSkills(workspacePath)
      assert.deepEqual(skills, [{ name: 'weekly-report', valid: true, issues: [] }])
    })
  })

  it('合规平铺形态（<name>.md）→ valid，无 issues', async () => {
    await withStore(async (store, workspacePath) => {
      await writeFlatSkill(workspacePath, 'daily-sync', VALID_FRONTMATTER('daily-sync'))
      const skills = await store.describeSkills(workspacePath)
      assert.deepEqual(skills, [{ name: 'daily-sync', valid: true, issues: [] }])
    })
  })

  it('缺 description → invalid，issues 点名 description', async () => {
    await withStore(async (store, workspacePath) => {
      await writeFlatSkill(workspacePath, 'no-desc', `---\nname: no-desc\n---\n`)
      const [skill] = await store.describeSkills(workspacePath)
      assert.equal(skill?.valid, false)
      assert.ok(skill?.issues.some((issue) => issue.includes('description')))
    })
  })

  it('name 非 kebab-case → invalid，issues 点名 kebab-case', async () => {
    await withStore(async (store, workspacePath) => {
      await writeFlatSkill(workspacePath, 'bad-name', VALID_FRONTMATTER('WeeklyReport'))
      const [skill] = await store.describeSkills(workspacePath)
      assert.equal(skill?.valid, false)
      assert.ok(skill?.issues.some((issue) => issue.includes('kebab-case')))
    })
  })

  it('旧驼峰键（disableModelInvocation/userInvocable）→ invalid，issues 点名旧键', async () => {
    await withStore(async (store, workspacePath) => {
      await writeFlatSkill(
        workspacePath,
        'legacy-keys',
        `---\nname: legacy-keys\ndescription: 测试技能\ndisableModelInvocation: true\nuserInvocable: false\n---\n`,
      )
      const [skill] = await store.describeSkills(workspacePath)
      assert.equal(skill?.valid, false)
      assert.ok(skill?.issues.some((issue) => issue.includes('disableModelInvocation')))
      assert.ok(skill?.issues.some((issue) => issue.includes('userInvocable')))
    })
  })

  it('无 frontmatter → invalid，issues 说明须以 --- 开头', async () => {
    await withStore(async (store, workspacePath) => {
      await writeFlatSkill(workspacePath, 'no-frontmatter', `# 只是个标题\n`)
      const [skill] = await store.describeSkills(workspacePath)
      assert.equal(skill?.valid, false)
      assert.ok(skill?.issues.some((issue) => issue.includes('frontmatter')))
    })
  })

  it('非法布尔值 → invalid，issues 点名布尔字段', async () => {
    await withStore(async (store, workspacePath) => {
      await writeFlatSkill(
        workspacePath,
        'bad-bool',
        `---\nname: bad-bool\ndescription: 测试技能\ndisable-model-invocation: maybe\n---\n`,
      )
      const [skill] = await store.describeSkills(workspacePath)
      assert.equal(skill?.valid, false)
      assert.ok(skill?.issues.some((issue) => issue.includes('disable-model-invocation')))
    })
  })

  it('合法布尔值的各种写法都不算问题', async () => {
    await withStore(async (store, workspacePath) => {
      await writeFlatSkill(
        workspacePath,
        'good-bool',
        `---\nname: good-bool\ndescription: 测试技能\ndisable-model-invocation: yes\nuser-invocable: OFF\n---\n`,
      )
      const [skill] = await store.describeSkills(workspacePath)
      assert.deepEqual(skill, { name: 'good-bool', valid: true, issues: [] })
    })
  })

  it('目录与平铺两种形态混合 → 都列出且按名排序；discover 的名字清单不受影响', async () => {
    await withStore(async (store, workspacePath) => {
      await writeBundleSkill(workspacePath, 'z-bundle', VALID_FRONTMATTER('z-bundle'))
      await writeFlatSkill(workspacePath, 'a-flat', VALID_FRONTMATTER('a-flat'))
      const skills = await store.describeSkills(workspacePath)
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ['a-flat', 'z-bundle'],
      )
      assert.ok(skills.every((skill) => skill.valid))

      // 旧字段（DiscoveredEmployee.skills）仍是纯名字清单
      const { employees } = await store.discover()
      assert.deepEqual(employees[0]?.skills, ['a-flat', 'z-bundle'])
    })
  })

  it('SKILL.md 读不出来（此处：SKILL.md 是个目录）→ 落进 issues，不炸掉其他技能', async () => {
    await withStore(async (store, workspacePath) => {
      // pathExists 对目录也返回 true，readFile 才会炸 —— 可移植地模拟读取失败
      await mkdir(path.join(workspacePath, '.dsh', 'skills', 'broken', 'SKILL.md'), { recursive: true })
      await writeFlatSkill(workspacePath, 'fine', VALID_FRONTMATTER('fine'))

      const skills = await store.describeSkills(workspacePath)
      assert.equal(skills.length, 2)
      const broken = skills.find((skill) => skill.name === 'broken')
      assert.equal(broken?.valid, false)
      assert.ok(broken?.issues.some((issue) => issue.includes('无法读取')))
      assert.deepEqual(skills.find((skill) => skill.name === 'fine'), {
        name: 'fine',
        valid: true,
        issues: [],
      })
    })
  })

  it('没有技能目录 → 空清单', async () => {
    await withStore(async (store, workspacePath) => {
      await rm(path.join(workspacePath, '.dsh', 'skills'), { recursive: true, force: true })
      assert.deepEqual(await store.describeSkills(workspacePath), [])
    })
  })

  it('文件开头有 UTF-8 BOM → invalid，并直接点名 BOM（dsh 不剥 BOM，会整个忽略）', async () => {
    /* 真机事故（员工「小满」）：这台校验器**剥** BOM 所以判"合规"，而 dsh 的 provider
       **不剥** —— 它看到 \uFEFF--- 就判"没有 frontmatter"，技能被静默忽略。
       两边判定不一致的后果最难查：控制台说没问题，员工却变笨。
       所以这里对齐到更严的那一边：BOM 也算不合格，且必须点名原因。 */
    await withStore(async (store, workspacePath) => {
      await writeBundleSkill(workspacePath, 'bom-skill', '\uFEFF' + VALID_FRONTMATTER('bom-skill'))
      const [skill] = await store.describeSkills(workspacePath)
      assert.equal(skill?.valid, false, 'BOM 必须判不合格 —— 否则控制台在替 dsh 撒谎')
      assert.ok(
        skill?.issues.some((issue) => issue.includes('UTF-8 BOM')),
        '要点名 BOM，而不是含糊说"frontmatter 不合规"：' + JSON.stringify(skill?.issues),
      )
      assert.ok(
        skill?.issues.some((issue) => issue.includes('去掉')),
        '要给出可执行的修法：' + JSON.stringify(skill?.issues),
      )
    })
  })

  it('BOM 与其他问题并存时一次说全，且 BOM 排在最前', async () => {
    await withStore(async (store, workspacePath) => {
      await writeFlatSkill(workspacePath, 'bom-no-desc', '\uFEFF---\nname: bom-no-desc\n---\n')
      const [skill] = await store.describeSkills(workspacePath)
      assert.equal(skill?.valid, false)
      assert.ok(skill?.issues[0]?.includes('UTF-8 BOM'), '先说 BOM（它最容易被误诊）：' + JSON.stringify(skill?.issues))
      assert.ok(
        skill?.issues.some((issue) => issue.includes('description')),
        '别的问题也要说：' + JSON.stringify(skill?.issues),
      )
    })
  })
})
