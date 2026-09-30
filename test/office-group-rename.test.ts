/**
 * 给已有分组改名 —— 纯逻辑 + 真实行为的测试。
 *
 * 背景：分组不是实体，它只是每个员工工作区 `.dsemployee/employee.json` 里的 `group` 字段。
 * 所以"给分组改名"本质是一次**跨节点的批量写**（逐个 `employee.update { employeeId, group }`），
 * 这会带来两个容易写错、且错了不容易发现的地方：
 *
 *   1. **排序偏好里的键**必须跟着改（`officePrefs.groupOrder` / `employeeOrder`）——
 *      不迁移的话，用户改完名会发现分组掉到"按名字排"的末尾，以为排序丢了；
 *   2. **部分失败**（某台节点离线）不能装作成功：员工一半在新组、一半在旧组，
 *      这时如果还迁移了偏好，旧组的剩余成员就失去了自己的位置。
 *      正确做法是：不动偏好 + 如实报告几个成功几个失败 + 可重复执行（幂等重试）。
 *
 * 测法沿用 `test/ui-rpc-selfheal.test.ts`：**从交付脚本里抠出真源码**，配替身跑。
 * 复刻一份逻辑只能证明复刻版对 —— 而被测的恰恰是"调用顺序 + 失败分支"。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import vm from 'node:vm'

import { renderControlUiScript } from '../src/web/ui.ts'
import { CONSOLE_SOURCE } from './console-source.ts'

const SCRIPT = renderControlUiScript()

/** 抠出 `function <name>(…) { … }` 的真源码（按花括号配对）。 */
function extractFunction(name: string): string {
  const start = SCRIPT.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `交付脚本里找不到 function ${name}(`)
  let depth = 0
  for (let index = SCRIPT.indexOf('{', start); index < SCRIPT.length; index += 1) {
    const char = SCRIPT[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return SCRIPT.slice(start, index + 1)
    }
  }
  throw new Error(`function ${name} 的花括号没有配对`)
}

interface Harness {
  renameGroup: (fromKey: string, rawName: string) => Promise<boolean>
  normalizeGroupName: (raw: unknown) => string | null
  renameGroupInOrder: (
    prefs: { groupOrder: string[]; employeeOrder: Record<string, string[]> },
    from: string,
    to: string,
  ) => { groupOrder: string[]; employeeOrder: Record<string, string[]> }
  calls: Array<{ method: string; params: Record<string, unknown> }>
  prefs: { groupOrder: string[]; employeeOrder: Record<string, string[]> } | null
  banners: string[]
  toasts: string[]
  refreshed: number
}

/** 造一个受控作用域：rpc 记账、偏好记账、状态可配。 */
function makeHarness(options: {
  employees: Array<{ id: string; name?: string; group?: string }>
  prefs?: { groupOrder: string[]; employeeOrder: Record<string, string[]> }
  scopes?: string[]
  /** 第 n 次 employee.update 调用失败（1 起算） */
  failOn?: number[]
}): Harness {
  const calls: Harness['calls'] = []
  const banners: string[] = []
  const toasts: string[] = []
  let refreshed = 0
  let prefs: Harness['prefs'] = options.prefs ?? { groupOrder: [], employeeOrder: {} }
  let updateCalls = 0

  const scope = {
    state: {
      employees: options.employees,
      officeOrder: prefs,
      scopes: options.scopes ?? ['employee.manage', 'employee.read'],
    },
    rpc: (method: string, params: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, params })
      if (method !== 'employee.update') return Promise.resolve({})
      updateCalls += 1
      if ((options.failOn ?? []).includes(updateCalls)) {
        return Promise.reject(Object.assign(new Error('node offline'), { code: 'node-offline' }))
      }
      return Promise.resolve({})
    },
    describeError: (error: unknown): string =>
      String((error as { code?: string } | null)?.code ?? (error as Error)?.message ?? error),
    pushRaw: (): void => undefined,
    toast: (text: string): void => {
      toasts.push(text)
    },
    setBanner: (text: string): void => {
      banners.push(text)
    },
    listGroupNames: (): string[] => {
      const seen = new Set<string>()
      for (const employee of options.employees) {
        const group = typeof employee.group === 'string' ? employee.group.trim() : ''
        if (group !== '') seen.add(group)
      }
      return [...seen].sort()
    },
    groupKeyOf: (employee: { group?: string }): string =>
      typeof employee.group === 'string' && employee.group.trim() !== '' ? employee.group.trim() : '',
    saveOfficeOrder: (groupOrder: string[], employeeOrder: Record<string, string[]>): void => {
      prefs = { groupOrder: groupOrder.slice(), employeeOrder }
    },
    loadEmployees: (): Promise<unknown[]> => {
      refreshed += 1
      // 模拟服务端改名后的真实结果：把员工的 group 按已成功的调用改写
      for (const call of calls) {
        if (call.method !== 'employee.update') continue
        const target = options.employees.find((employee) => employee.id === call.params['employeeId'])
        if (target !== undefined) target.group = String(call.params['group'])
      }
      return Promise.resolve(options.employees)
    },
    Promise,
  }

  const source = [extractFunction('normalizeGroupName'), extractFunction('renameGroupInOrder'), extractFunction('renameGroup')].join('\n')
  const factory = new Function(
    ...Object.keys(scope),
    `${source}\nreturn { renameGroup, normalizeGroupName, renameGroupInOrder }`,
  ) as (...args: unknown[]) => {
    renameGroup: Harness['renameGroup']
    normalizeGroupName: Harness['normalizeGroupName']
    renameGroupInOrder: Harness['renameGroupInOrder']
  }
  const built = factory(...Object.values(scope))

  return {
    renameGroup: built.renameGroup,
    normalizeGroupName: built.normalizeGroupName,
    renameGroupInOrder: built.renameGroupInOrder,
    calls,
    get prefs() {
      return prefs
    },
    banners,
    toasts,
    get refreshed() {
      return refreshed
    },
  }
}

describe('分组名归一化（唯一的校验口）', () => {
  const { normalizeGroupName } = makeHarness({ employees: [] })

  it('trim 前后空白；空/纯空白不接受', () => {
    assert.equal(normalizeGroupName('  渗透组  '), '渗透组')
    assert.equal(normalizeGroupName(''), null)
    assert.equal(normalizeGroupName('   '), null)
    assert.equal(normalizeGroupName(undefined), null)
    assert.equal(normalizeGroupName(null), null)
  })

  it('长度上限 64 与 Hub 侧 schema 一致（65 字拒绝、64 字放行）', () => {
    assert.equal(normalizeGroupName('あ'.repeat(64)), 'あ'.repeat(64))
    assert.equal(normalizeGroupName('あ'.repeat(65)), null)
  })
})

describe('排序偏好里的键迁移（纯函数）', () => {
  const { renameGroupInOrder } = makeHarness({ employees: [] })

  it('保位置：改名后分组仍排在原来的名次', () => {
    const next = renameGroupInOrder(
      { groupOrder: ['甲', '乙', '丙'], employeeOrder: { 乙: ['emp_1', 'emp_2'] } },
      '乙',
      '乙组',
    )
    assert.deepEqual(next.groupOrder, ['甲', '乙组', '丙'])
    assert.deepEqual(next.employeeOrder['乙组'], ['emp_1', 'emp_2'])
  })

  it('目标是已存在的组：groupOrder 去重保首位，employeeOrder 两组 id 依次拼接', () => {
    const next = renameGroupInOrder(
      { groupOrder: ['甲', '乙', '丙'], employeeOrder: { 甲: ['emp_1'], 乙: ['emp_2'] } },
      '乙',
      '甲',
    )
    assert.deepEqual(next.groupOrder, ['甲', '丙'], '并入后不该出现重复键')
    assert.deepEqual(next.employeeOrder['甲'], ['emp_1', 'emp_2'], '两组成员都要留住')
  })

  it('偏好为空/形状不对时不抛（目录是现实、偏好是视图层，读取方要容忍）', () => {
    const next = renameGroupInOrder(
      {} as { groupOrder: string[]; employeeOrder: Record<string, string[]> },
      '甲',
      '乙',
    )
    assert.deepEqual(next.groupOrder, [])
    assert.deepEqual(next.employeeOrder, {})
  })
})

describe('renameGroup：逐个员工改写 + 失败如实报告', () => {
  const employees = [
    { id: 'emp_1', name: '小艾', group: '渗透组' },
    { id: 'emp_2', name: '阿澈', group: '渗透组' },
    { id: 'emp_3', name: '小博', group: '运营组' },
  ]

  it('全成功：每个成员各发一次 employee.update(group=新名)，并迁移排序键', async () => {
    const harness = makeHarness({
      employees: employees.map((employee) => ({ ...employee })),
      prefs: { groupOrder: ['运营组', '渗透组'], employeeOrder: { 渗透组: ['emp_2', 'emp_1'] } },
    })
    const ok = await harness.renameGroup('渗透组', '红队')
    assert.equal(ok, true)

    const updates = harness.calls.filter((call) => call.method === 'employee.update')
    assert.equal(updates.length, 2, '只应改这一组的成员')
    assert.deepEqual(
      updates.map((call) => call.params['employeeId']).sort(),
      ['emp_1', 'emp_2'],
    )
    for (const call of updates) assert.equal(call.params['group'], '红队')
    assert.ok(!updates.some((call) => call.params['employeeId'] === 'emp_3'), '别的组不该被动到')

    assert.deepEqual(harness.prefs?.groupOrder, ['运营组', '红队'], '排序键要跟着改名')
    assert.deepEqual(harness.prefs?.employeeOrder['红队'], ['emp_2', 'emp_1'], '组内顺序要保持')
    assert.equal(harness.refreshed, 1, '改完要刷新员工目录')
    assert.ok(harness.toasts.some((text) => text.includes('已改名')), '成功要给正向反馈')
  })

  it('部分失败：不动排序偏好、如实报出失败的人、返回 false（可再执行一次）', async () => {
    const harness = makeHarness({
      employees: employees.map((employee) => ({ ...employee })),
      prefs: { groupOrder: ['渗透组'], employeeOrder: { 渗透组: ['emp_1', 'emp_2'] } },
      failOn: [2],
    })
    const ok = await harness.renameGroup('渗透组', '红队')
    assert.equal(ok, false)
    assert.deepEqual(harness.prefs?.groupOrder, ['渗透组'], '部分失败时偏好必须原样不动')
    assert.ok(
      harness.banners.some((text) => text.includes('部分完成') && text.includes('阿澈')),
      `提示里要点出失败的人（实际横幅：${JSON.stringify(harness.banners)}）`,
    )
    assert.equal(harness.refreshed, 1, '即使部分失败也要刷新，让用户看到现状')
  })

  it('目标名是已存在的分组 → 并入，并在提示里说清是"并入"而不是"改名"', async () => {
    const harness = makeHarness({
      employees: [
        { id: 'emp_1', name: '小艾', group: '渗透组' },
        { id: 'emp_2', name: '阿澈', group: '红队' },
      ],
      prefs: { groupOrder: ['渗透组', '红队'], employeeOrder: {} },
    })
    const ok = await harness.renameGroup('渗透组', '红队')
    assert.equal(ok, true)
    assert.ok(
      harness.toasts.some((text) => text.includes('并入')),
      `应提示"并入"（实际：${JSON.stringify(harness.toasts)}）`,
    )
    assert.deepEqual(harness.prefs?.groupOrder, ['红队'], '并入后两个键合成一个')
  })

  it('非法名 / 未改名 / 空分组 / 缺权限：都不发 RPC，直接如实拒绝', async () => {
    const base = employees.map((employee) => ({ ...employee }))

    const tooLong = makeHarness({ employees: base.map((e) => ({ ...e })) })
    assert.equal(await tooLong.renameGroup('渗透组', 'あ'.repeat(65)), false)
    assert.ok(tooLong.banners.some((text) => text.includes('64')), '超长要说清限制')

    const same = makeHarness({ employees: base.map((e) => ({ ...e })) })
    assert.equal(await same.renameGroup('渗透组', ' 渗透组 '), false)
    assert.equal(same.calls.length, 0, '名字没变（trim 后相同）就不该发请求')

    const empty = makeHarness({ employees: base.map((e) => ({ ...e })) })
    assert.equal(await empty.renameGroup('不存在组', '红队'), false)
    assert.equal(empty.calls.length, 0)

    const noScope = makeHarness({ employees: base.map((e) => ({ ...e })), scopes: ['employee.read'] })
    assert.equal(await noScope.renameGroup('渗透组', '红队'), false)
    assert.equal(noScope.calls.length, 0, '没有 employee.manage 时不该发请求')
    assert.ok(noScope.banners.some((text) => text.includes('employee.manage')))
  })
})

describe('交付脚本必须是可编译的 JS', () => {
  /**
   * 这条守的是一个**没有别的东西守得住**的边界：`CONTROL_UI_SCRIPT` 是 `String.raw`
   * 里的字符串 —— tsc 只把它当字符串看，里面的 JS 写错（漏括号、注释里混进反引号
   * 把模板提前截断）**类型检查一律不报**，只会在浏览器里变成白屏。
   * 文件末尾原本写着"改动后请手动跑 node --check"，这里把它自动化。
   */
  it('renderControlUiScript() 能通过 JS 解析（等同 node --check）', () => {
    assert.doesNotThrow(() => new vm.Script(SCRIPT), '交付给浏览器的脚本无法解析 —— 检查 String.raw 模板里是否混进了反引号')
  })

  it('脚本里带着本轮新增的关键函数（防"改了别的文件/漏了导出"）', () => {
    for (const name of ['normalizeGroupName', 'renameGroupInOrder', 'renameGroup', 'startGroupRename', 'buildGroupRenameButton']) {
      assert.ok(SCRIPT.includes(`function ${name}(`), `交付脚本里缺 function ${name}(`)
    }
  })
})

describe('编辑器要能扛住办公区的自动重建', () => {
  
  /**
   * 这三条是机制的**接点**，缺一个就会出现"用户正在输入，编辑器忽然没了"或"恢复了旧值"：
   *   · 提交时同步意图 —— 程序化改值不触发 input 事件，只在 input 上同步会恢复成旧名字（实测踩过）；
   *   · renderEmployees 收尾恢复 —— 否则任何一次重建（工位轮询 / employee.changed）都会吃掉编辑器；
   *   · 离开办公区作废意图 —— 否则回到办公区时编辑器会莫名其妙弹回来。
   */
  it('提交时把意图同步成"这一次要改成的名字"', () => {
    assert.ok(
      CONSOLE_SOURCE.includes('groupRenameIntent = { key: section.key, value: attempted }'),
      'submit 没有在提交瞬间同步意图 —— 部分失败恢复出来的会是旧名字',
    )
  })

  it('renderEmployees 收尾按意图恢复编辑器', () => {
    assert.ok(CONSOLE_SOURCE.includes('restoreGroupRenameEditor()'), 'renderEmployees 没有收尾恢复')
    assert.ok(CONSOLE_SOURCE.includes('function restoreGroupRenameEditor()'), '缺少 restoreGroupRenameEditor 实现')
  })

  it('离开办公区作废意图', () => {
    /* 改名只发生在办公区，所以 setView 比的是**解析后的视图名**（target）：
       视图表以外的入参会被回落成 office，拿原始入参判断会出现"传了怪值就没清掉"。
       真实行为（切到审批 / 设备 / 体检页后意图确实清空）在 test/ui-nav.test.ts 里跑真源码验证。 */
    assert.ok(
      CONSOLE_SOURCE.includes("if (target !== 'office') groupRenameIntent = null"),
      'setView 没有作废意图 —— 回到办公区时编辑器会突然弹回来',
    )
  })

  it('有编辑器开着时不重建工位（轮询不该打断输入）', () => {
    assert.ok(CONSOLE_SOURCE.includes('function officeHasOpenEditor()'), '缺少 officeHasOpenEditor')
    const start = CONSOLE_SOURCE.indexOf('function maybeRenderDesks()')
    const body = CONSOLE_SOURCE.slice(start, CONSOLE_SOURCE.indexOf('/* ── 未读红点', start))
    assert.ok(body.includes('if (officeHasOpenEditor()) return'), 'maybeRenderDesks 没先检查编辑器')
  })
})

describe('组头只给真实分组提供改名入口', () => {
  
  it('renderEmployees 里按 section.key !== "" 决定是否给笔（未分组不可改名）', () => {
    const start = CONSOLE_SOURCE.indexOf('function renderEmployees()')
    assert.ok(start >= 0, '找不到 renderEmployees')
    const body = CONSOLE_SOURCE.slice(start, CONSOLE_SOURCE.indexOf('function officeSections()', start))
    assert.ok(
      body.includes("if (section.key !== '') head.appendChild(buildGroupRenameButton(section, head))"),
      '组头没有按 section.key 区分"未分组"',
    )
  })

  it('未分组那一档（key === ""）确实存在，所以这条判断不是多余的', () => {
    assert.ok(CONSOLE_SOURCE.includes("return { key: key, name: key === '' ? '未分组' : key, members: members }"))
  })
})
