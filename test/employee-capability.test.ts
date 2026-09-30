/**
 * 给员工装"调用其他员工"的入口（`dse employee-capability`）。
 *
 * 为什么入口要装在工作区里：身份是**绑定员工**的（令牌只能以它自己名义发起调用），
 * 所以身份文件、包装脚本、hub 地址都锁在这个工作区里 —— 把"能不能冒名"从提示词
 * 约束变成文件系统约束。这组测试就守这几件事：装了什么、装的东西指哪儿、
 * 以及**凭据不许进 git**。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  provisionDailyDigest,
  provisionEmployeeCapability,
  provisionOrchestrateSkill,
} from '../src/node/capability.ts'

let root = ''
let ws = ''

before(async () => {
  root = await mkdtemp(path.join(process.cwd(), '.tmp-capability-'))
  ws = path.join(root, '小艾')
  await mkdir(path.join(ws, '.dsemployee'), { recursive: true })
  await writeFile(
    path.join(ws, '.dsemployee', 'employee.json'),
    JSON.stringify({ id: 'emp_xiaoai_abc', name: '小艾' }),
    'utf8',
  )
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

async function provision(overrides: Record<string, unknown> = {}) {
  return await provisionEmployeeCapability({
    workspace: ws,
    hubUrl: 'ws://127.0.0.1:19791/ws',
    dseBin: '/repo/bin/dse.mjs',
    ...overrides,
  })
}

describe('给员工装互调入口', () => {
  it('写出三样东西，并回给人"接下来要执行的批准命令"', async () => {
    const result = await provision()
    assert.equal(result.employeeId, 'emp_xiaoai_abc')
    assert.equal(result.employeeName, '小艾')
    assert.deepEqual(result.files.sort(), [
      '.dse/config.json',
      '.dsh/skills/employee-call/SKILL.md',
      '.gitignore',
      'tools/employee-call',
      'tools/employee-call.mjs',
    ])
    // 下一步里必须包含"由人批准并绑定"这一步 —— 信任锚点不能在脚本里自动完成
    const steps = result.nextSteps.join('\n')
    assert.match(steps, /dse pair approve/)
    assert.match(steps, /--employee 小艾/)
  })

  it('配置里记下 hub 地址与员工 id（脚本据此走这条通道）', async () => {
    const config = JSON.parse(await readFile(path.join(ws, '.dse', 'config.json'), 'utf8'))
    assert.equal(config.hubUrl, 'ws://127.0.0.1:19791/ws')
    assert.equal(config.employeeId, 'emp_xiaoai_abc')
    assert.deepEqual(config.scopes, ['employee.read', 'employee.invoke'])
  })

  it('POSIX 包装可执行；hub 地址与身份落在 .dse/config.json（agent 换不了凭据）', async () => {
    const wrapper = path.join(ws, 'tools', 'employee-call')
    const mode = (await stat(wrapper)).mode & 0o777
    assert.ok((mode & 0o100) !== 0, '必须有执行位，否则 agent 跑不起来')

    /* 设计变更说明：hub 地址与 dse 入口从"写死在包装里"改成"写进 .dse/config.json"，
       由 employee-call.mjs 读取 —— 因为中文工作区路径写进 shell/批处理会被 CP936 解坏。
       安全性不打折：身份仍固定为同目录 .dse/ 下那一把，agent 依然换不了凭据。 */
    const config = JSON.parse(await readFile(path.join(ws, '.dse', 'config.json'), 'utf8'))
    assert.equal(config.hubUrl, 'ws://127.0.0.1:19791/ws')
    assert.equal(config.dseBin, '/repo/bin/dse.mjs')
    assert.equal(config.employeeId, 'emp_xiaoai_abc')
  })

  it('身份与令牌所在目录进了 .gitignore（工作区自己是 git 仓库）', async () => {
    const ignore = await readFile(path.join(ws, '.gitignore'), 'utf8')
    assert.match(ignore, /^\.dse\/$/m)
  })

  it('技能说明写清了异步语义与"不许编造"（这是最容易出错的地方）', async () => {
    const skill = await readFile(path.join(ws, '.dsh', 'skills', 'employee-call', 'SKILL.md'), 'utf8')
    assert.match(skill, /employee\.invoke/)
    assert.match(skill, /employee\.invoke\.list/)
    assert.match(skill, /发起即返回|已经派出去/)
    assert.match(skill, /不要在一个回合里反复轮询/)
    assert.match(skill, /不许编造/)
    assert.match(skill, /小艾/, '要写明这条路只代表它自己')
  })

  it('重复执行是幂等的（.gitignore 不会越写越多行）', async () => {
    await provision()
    await provision()
    const ignore = await readFile(path.join(ws, '.gitignore'), 'utf8')
    assert.equal(ignore.split('\n').filter((line) => line.trim() === '.dse/').length, 1)
  })

  it('还没装互调入口时不给装汇总技能（两套凭据会让人搞不清以谁的身份调）', async () => {
    const fresh = path.join(root, '秘书')
    await mkdir(path.join(fresh, '.dsemployee'), { recursive: true })
    await writeFile(
      path.join(fresh, '.dsemployee', 'employee.json'),
      JSON.stringify({ id: 'emp_secretary', name: '秘书' }),
      'utf8',
    )
    await assert.rejects(() => provisionDailyDigest({ workspace: fresh }), /employee-capability/)
  })

  it('汇总技能写清了取数来源、四段结构与"不许编造"，并给出建任务的命令', async () => {
    const result = await provisionDailyDigest({ workspace: ws, atTime: '08:30' })
    assert.deepEqual(result.files, ['.dsh/skills/daily-digest/SKILL.md'])
    assert.match(result.scheduleCommand, /job\.upsert/)
    assert.match(result.scheduleCommand, /emp_xiaoai_abc/)
    assert.match(result.scheduleCommand, /1440/, '默认按天（1440 分钟）')

    const skill = await readFile(path.join(ws, '.dsh', 'skills', 'daily-digest', 'SKILL.md'), 'utf8')
    assert.match(skill, /employee\.activity/, '取数要走元数据接口')
    assert.match(skill, /notes/, 'data 不全时必须照实说')
    assert.match(skill, /不许编造/)
    /* 这条断言以前是"推送走 dws（钉钉）" —— 错的：那台机器从没登录过钉钉。
       现在断言的是"不许假设本机有聊天工具"，以及"没渠道就请有渠道的同事代发"。 */
    assert.match(skill, /不要假设本机装了任何聊天工具/, '不许假设有钉钉')
    assert.match(skill, /请有渠道的同事代发/, '没渠道时的正当出路：请同事代发')
    assert.match(skill, /08:30/, '写进技能的默认时间要跟着 --at 走')
    assert.match(skill, /小艾/, '要写明这是谁的活')
  })

  it('--at 传入非法时间时 CLI 层拦下（这里直测 provisioner 的默认值）', async () => {
    const result = await provisionDailyDigest({ workspace: ws })
    assert.match(result.scheduleCommand, /09:00/)
  })

  it('入口逻辑放在纯 ASCII 的 .mjs 里；两个包装各一行、不含任何字面路径', async () => {
    const winWs = path.join(root, 'win-secretary')
    await mkdir(path.join(winWs, '.dsemployee'), { recursive: true })
    await writeFile(
      path.join(winWs, '.dsemployee', 'employee.json'),
      JSON.stringify({ id: 'emp_win', name: '测试员工' }),
      'utf8',
    )
    await provisionEmployeeCapability({
      workspace: winWs,
      hubUrl: 'wss://hub.example.test/ws',
      dseBin: 'C:/Users/developer/工作目录/digital-employees/bin/dse.mjs',
      platform: 'win32',
    })

    const fs = await import('node:fs/promises')
    const entry = await fs.readFile(path.join(winWs, 'tools', 'employee-call.mjs'), 'utf8')
    const posix = await fs.readFile(path.join(winWs, 'tools', 'employee-call'), 'utf8')
    const cmd = await fs.readFile(path.join(winWs, 'tools', 'employee-call.cmd'), 'utf8')

    /* 三个文件都必须是纯 ASCII：工作区路径含中文，落成字面量就会被 CP936 解成乱码
       （员工实测报回来的真事故：digital-employees 变成 tal-employees）。 */
    const filesToCheck: Array<[string, string]> = [
      ['employee-call.mjs', entry],
      ['employee-call', posix],
      ['employee-call.cmd', cmd],
    ]
    for (const [name, text] of filesToCheck) {
      assert.ok(!/[^\x00-\x7f]/.test(text), `${name} 必须是纯 ASCII（中文路径不能落字面量）`)
    }
    /* .cmd 必须**单行**：只写 LF 的多行 .cmd 会被 cmd 读错位（报 'oint.' is not recognized）。 */
    assert.equal(cmd.trimEnd().split('\n').length, 1, '.cmd 要单行，避免行尾问题')
    assert.match(cmd, /node "%~dp0employee-call\.mjs" %\*/, '.cmd 必须带 node 前缀（直接执行 .mjs 会挂死）')
    assert.match(cmd, /%~dp0/, '路径靠运行时展开，不落字面量')
    assert.match(posix, /exec node "\$\(dirname "\$0"\)\/employee-call\.mjs"/, 'POSIX 包装同理')
    assert.match(entry, /config\.json/, '配置从 .dse/config.json 读')
    assert.match(entry, /employee-identity\.json/, '身份固定为同目录 .dse/ 下的那份')
    assert.ok(!/(工作目录|employees\\测试员工)/.test(entry), '入口脚本里不该出现具体工作区路径')
  })

  it('总控技能：拆活/派活/收结果的纪律写清楚（尤其"发起即返回、不许死等"）', async () => {
    const result = await provisionOrchestrateSkill({ workspace: ws })
    assert.deepEqual(result.files, ['.dsh/skills/orchestrate/SKILL.md'])
    const skill = await readFile(path.join(ws, '.dsh', 'skills', 'orchestrate', 'SKILL.md'), 'utf8')
    assert.match(skill, /employee\.invoke/)
    assert.match(skill, /employee\.invoke\.list/)
    assert.match(skill, /发起即返回/)
    assert.match(skill, /不要在一个回合里反复轮询/)
    assert.match(skill, /不许编造/)
    assert.match(skill, /nodeOnline/, '派活前要先看对方在不在线')
    assert.match(skill, /小艾/)
  })

  it('没装互调入口时也不给总控技能', async () => {
    const fresh = path.join(root, '光杆总控')
    await mkdir(path.join(fresh, '.dsemployee'), { recursive: true })
    await writeFile(
      path.join(fresh, '.dsemployee', 'employee.json'),
      JSON.stringify({ id: 'emp_bare', name: '光杆总控' }),
      'utf8',
    )
    await assert.rejects(() => provisionOrchestrateSkill({ workspace: fresh }), /employee-capability/)
  })

  it('目录不是员工工作区时明确报错，而不是装出一套用不了的入口', async () => {
    const empty = path.join(root, 'not-an-employee')
    await mkdir(empty, { recursive: true })
    await assert.rejects(
      () =>
        provisionEmployeeCapability({
          workspace: empty,
          hubUrl: 'ws://127.0.0.1:19791/ws',
          dseBin: '/repo/bin/dse.mjs',
        }),
      /employee\.json/,
    )
  })
})
