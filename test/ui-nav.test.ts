/**
 * 一级视图标签 —— 把"标签 ↔ 容器 ↔ 进入时拉什么数据"这三方的对应关系钉死。
 *
 * 背景：原来只有两个标签（办公区 / 模型配置），所以 `setView` 里散着写了三遍 if、
 * 标签点击那里硬编码了 `view === 'office' || view === 'llm'`。这轮把审批 / 设备 / 体检
 * 从办公区那一列里提成一级页（原来它们排在所有工位下面，要滚很久才看得见）。
 * 五个视图之后，"散着写"就会漏，而**漏掉的两边都不报错**：
 *
 *   · 标签的 data-view 写错 / 表里没这个容器 → 点了完全没反应；
 *   · 表里有容器但标签忘了加 → 那一页永远打不开（切过去了但内容是空的）。
 *
 * 所以这里测三件事：
 *   1. 结构契约：标签与视图表**双向**对得上（多一个少一个都算错）；
 *   2. 真实行为：从交付脚本里抠出真的 `VIEW_IDS` / `VIEW_LOADERS` / `setView` 跑一遍 ——
 *      每次只显一个容器、进入哪一页就只拉那一页的数据、离开办公区清掉改名意图；
 *   3. 两个已经踩过的坑：标签里的计数 chip 挡住点击（closest）、设备页的 scope 门槛。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import vm from 'node:vm'

import { renderControlUi, renderControlUiScript } from '../src/web/ui.ts'
import { CONSOLE_SOURCE, CSS_SOURCE } from './console-source.ts'

const SCRIPT = renderControlUiScript()

/** 交付给浏览器的整页 HTML（标签条在标记里，不在脚本里）。 */
const PAGE = renderControlUi({ hubId: 'hub-test', hubName: '测试 Hub', scriptUrl: '/ui.js' })

/** 抠出 `var <name> = { … }` 的真源码（按花括号配对，跳过字符串里的花括号）。 */
function extractObjectLiteral(name: string): string {
  const start = SCRIPT.indexOf(`var ${name} = {`)
  assert.ok(start >= 0, `交付脚本里找不到 var ${name} = {`)
  let depth = 0
  let quote = ''
  for (let index = SCRIPT.indexOf('{', start); index < SCRIPT.length; index += 1) {
    const char = SCRIPT[index]
    if (quote !== '') {
      if (char === quote) quote = ''
      continue
    }
    if (char === "'" || char === '"') quote = char
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return SCRIPT.slice(start, index + 1)
    }
  }
  throw new Error(`var ${name} 的花括号没有配对`)
}

/** 抠出 `function <name>(…) { … }` 的真源码。 */
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

/** 标记里出现的 `data-view="x"`，按出现顺序。 */
function tabViews(html: string): string[] {
  return [...html.matchAll(/data-view="([^"]+)"/g)].map((match) => String(match[1]))
}

/** 整页里 `id="viewXxx"` 的容器 id，按出现顺序。 */
function viewContainers(html: string): string[] {
  return [...html.matchAll(/id="(view[A-Za-z]+)"/g)].map((match) => String(match[1]))
}

/** 视图名 → 容器 id（只给测试自己用，与被测的 VIEW_IDS 无关：故意各写一份来对）。 */
const EXPECTED_IDS: Record<string, string> = {
  office: 'viewOffice',
  officeRoom: 'viewOfficeRoom',
  approvals: 'viewApprovals',
  jobs: 'viewJobs',
  devices: 'viewDevices',
  health: 'viewHealth',
  llm: 'viewLlm',
  /* 导航重构后，chat 这一页的容器是**外壳** `#viewChatShell`（窄栏 + 面板 + 工作区），
     `#viewChat` 变成它里面的工作区。视图表指向外壳，这一份预期也要跟着走。 */
  chat: 'viewChatShell',
}

interface FakeNode {
  classes: Set<string>
  attrs: Record<string, string>
  classList: { toggle: (name: string, on: boolean) => void; contains: (name: string) => boolean }
  getAttribute: (name: string) => string | null
  querySelectorAll: (selector: string) => FakeNode[]
}

function makeNode(attrs: Record<string, string> = {}, hidden = false): FakeNode {
  const classes = new Set<string>(hidden ? ['hidden'] : [])
  return {
    classes,
    attrs,
    classList: {
      toggle: (name: string, on: boolean): void => {
        if (on) classes.add(name)
        else classes.delete(name)
      },
      contains: (name: string): boolean => classes.has(name),
    },
    getAttribute: (name: string): string | null => (name in attrs ? String(attrs[name]) : null),
    /* 空数组就够：员工配置页的入口会给标签挂 onclick，而这一测只问"拉了哪几份数据"。
       给多少个按钮挂上了处理器是 markup 那一侧的事（另有测试盯着）。 */
    querySelectorAll: (_selector: string): FakeNode[] => [],
  }
}

/** 真实 `openEmployeeConfig` / `setConfigPage` 会摸到的 id —— 全是 null 会提前 return。 */
const CONFIG_PAGE_IDS = [
  'configPages',
  'configTabs',
  'configSearch',
  'configMobileEmployee',
  'btnBatchModels',
  'configEmployees',
  'configServices',
  'configNodes',
]

interface Harness {
  setView: (view: unknown) => void
  setConfigPage: (page: unknown) => void
  setScopes: (scopes: string[]) => void
  nodes: Record<string, FakeNode>
  tabButtons: FakeNode[]
  /** 依次记录了哪几页的数据被拉过 */
  loaded: string[]
  /** 依次记录了哪些"只重画、不拉数据"的页面被重绘过 */
  painted: string[]
  /** 模块级 `var groupRenameIntent`（跑在 vm 全局里，所以外面读得到） */
  intent: () => unknown
  setIntent: (value: unknown) => void
}

/**
 * 把真的 `VIEW_IDS` / `VIEW_LOADERS` / `setView` 放进一个 vm 上下文里跑，
 * 只替身掉 `$`（按 id 给假节点）、标签条和四个 loader。
 * 复刻一份 setView 只能证明复刻版对 —— 而被测的恰恰是"表里的对应关系"。
 */
function makeHarness(): Harness {
  const nodes: Record<string, FakeNode> = {}
  for (const [view, id] of Object.entries(EXPECTED_IDS)) nodes[id] = makeNode({}, view !== 'office')
  for (const id of CONFIG_PAGE_IDS) nodes[id] = makeNode()
  const tabButtons = ['office', 'officeRoom', 'approvals', 'jobs', 'devices', 'health', 'llm'].map((view) =>
    makeNode({ 'data-view': view }),
  )
  const loaded: string[] = []
  /* 办公室那一页的加载器**不拉数据**，它只重画场景。所以单独记一笔：
     混进 loaded 会让"进入哪一页就只拉那一页的数据"这句话读起来不成立。 */
  const painted: string[] = []
  const viewTabs = {
    querySelectorAll: (): FakeNode[] => tabButtons,
    contains: (): boolean => true,
  }

  const context = vm.createContext({
    /* configPage / configSearch / configPending 是真实 setConfigPage 与
       openEmployeeConfig 会读的字段；configEmployee 返回 null 表示"没有选中员工"，
       于是它不会去拉单个人的详情 —— 这一测只关心页面级的取数。 */
    state: {
      view: 'office',
      scopes: ['device.pair'],
      configPage: 'employees',
      configSearch: '',
      configPending: {},
    },
    nodes,
    tabButtons,
    loaded,
    painted,
    groupRenameIntent: null,
    LS: { lastView: 'dse.lastView' }, writeLocal: () => {},
    viewTabs,
    $: (id: string): FakeNode | null =>
      id === 'viewTabs' ? (viewTabs as unknown as FakeNode) : (nodes[id] ?? null),
    renderOfficeRoom: (): void => void painted.push('officeRoom'),
    loadApprovals: (): void => void loaded.push('approvals'),
    loadJobs: (): void => void loaded.push('jobs'),
    loadDevices: (): void => void loaded.push('devices'),
    /* 进设备页还要刷「注册窗口」那张卡片（它在 bindEvents 里只加载过一次，
       而那时连接还没建立 —— 见 30-office.ts 里那段注释）。 */
    loadPairingWindow: (): void => void loaded.push('pairingWindow'),
    refreshHealth: (): void => void loaded.push('health'),
    /* 员工配置页：**入口跑真源码**（openEmployeeConfig / setConfigPage），
       只替身掉它拉数据的那几个叶子函数 —— 把入口整个替身掉的话，
       "进入 llm 页会拉哪些数据"就变成在断言替身自己了。 */
    loadLlmEndpoints: (): void => void loaded.push('llm.endpoints'),
    loadNodePermissions: (): void => void loaded.push('llm.nodePermissions'),
    renderLlmConfig: (): void => void loaded.push('llm'),
    configEmployee: (): null => null,
    /* 切走某一页时要收回窄屏的临时导航抽屉（导航重构加的）。
       它不是这一组要测的"进入某页拉什么数据"，替身掉。 */
    closeSessionNavDrawer: (): void => {},
    /* 切回办公区时重画工位（新的 office loader 用它在切换后更新当前员工高亮）。
       这一组测的是"视图表 ↔ 容器 ↔ 拉数"，工位怎么画不在范围内。 */
    renderEmployees: (): void => {},
  })
  vm.runInContext(
    [
      extractObjectLiteral('VIEW_IDS'),
      extractObjectLiteral('VIEW_LOADERS'),
      extractFunction('openEmployeeConfig'),
      extractFunction('setConfigPage'),
      extractFunction('setView'),
      'globalThis.__setView = setView',
      'globalThis.__setConfigPage = setConfigPage',
    ].join('\n'),
    context,
  )

  return {
    setView: (view: unknown): void => {
      vm.runInContext(`__setView(${JSON.stringify(view)})`, context)
    },
    setConfigPage: (page: unknown): void => {
      vm.runInContext(`__setConfigPage(${JSON.stringify(page)})`, context)
    },
    setScopes: (scopes: string[]): void => {
      vm.runInContext(`state.scopes = ${JSON.stringify(scopes)}`, context)
    },
    nodes,
    tabButtons,
    loaded,
    painted,
    intent: (): unknown => vm.runInContext('groupRenameIntent', context),
    setIntent: (value: unknown): void => {
      vm.runInContext(`groupRenameIntent = ${JSON.stringify(value)}`, context)
    },
  }
}

/** 某一刻哪些**一级视图容器**是可见的（切完页应当只剩一个）。
 *  只看 `viewXxx` 这层：员工配置页里面还有子容器（configEmployees 等），
 *  它们的显隐由子页标签决定，混进来会让"每次只显一页"这句话读起来不成立。 */
function visibleViews(harness: Harness): string[] {
  const viewIds = new Set(Object.values(EXPECTED_IDS))
  return Object.entries(harness.nodes)
    .filter(([id, node]) => viewIds.has(id) && !node.classes.has('hidden'))
    .map(([id]) => id)
}

describe('标签与视图表必须双向对得上', () => {
  const declared = [...extractObjectLiteral('VIEW_IDS').matchAll(/(\w+):\s*'(view\w+)'/g)].map((match) => ({
    view: String(match[1]),
    id: String(match[2]),
  }))

  it('视图表里每个非 chat 视图都有一个标签按钮', () => {
    const tabOnly = declared.filter((entry) => entry.view !== 'chat').map((entry) => entry.view)
    assert.deepEqual(tabViews(PAGE).sort(), tabOnly.sort(), '标签条与视图表对不上：少了标签这一页就永远打不开')
  })

  it('每个标签按钮都指向页面里真实存在的容器', () => {
    const ids = viewContainers(PAGE)
    for (const view of tabViews(PAGE)) {
      assert.ok(ids.includes(EXPECTED_IDS[view] ?? ''), `标签 ${view} 指向的容器不存在 —— 点了没反应`)
    }
  })

  it('视图表指向的容器 id 与预期一致（改 id 不该悄悄发生）', () => {
    for (const entry of declared) {
      assert.equal(entry.id, EXPECTED_IDS[entry.view], `${entry.view} 的容器 id 变了`)
    }
  })

  it('chat 不进标签条（它从工位进、由返回键退出）', () => {
    assert.ok(!tabViews(PAGE).includes('chat'), 'chat 混进了标签条 —— 点进去会没有返回键可用')
  })

  it('标签顺序：办公区在最前，模型配置在最后', () => {
    const views = tabViews(PAGE)
    assert.equal(views[0], 'office')
    assert.equal(views[views.length - 1], 'llm')
  })

  it('审批 / 设备 / 体检 已经不在办公区那一列里（这就是这次改动的目的）', () => {
    const officeStart = PAGE.indexOf('<section class="col" id="viewOffice">')
    const officeEnd = PAGE.indexOf('<section class="col hidden" id="viewOfficeRoom">')
    assert.ok(officeStart >= 0 && officeEnd > officeStart, '找不到办公区视图的边界')
    const office = PAGE.slice(officeStart, officeEnd)
    for (const flag of ['id="approvalList"', 'id="devicePendingList"', 'id="healthBody"']) {
      assert.ok(!office.includes(flag), `${flag} 还留在办公区里 —— 白改了这一轮`)
    }
    /* 新建员工 / 岗位是"员工"本身的直接操作，应该留在办公区 */
    for (const flag of ['id="cardCreate"', 'id="cardPositions"']) {
      assert.ok(office.includes(flag), `${flag} 不该被搬出办公区`)
    }
    /* 办公室是**独立的一页**，不是塞在办公区里的一个区块：它有自己的视图容器。
       塞进来的话两页的显隐会互相打架（切办公室时办公区整列跟着消失/出现）。 */
    assert.ok(!office.includes('id="roomFloor"'), '办公室的场景落进了办公区那一列 —— 它是独立视图')
  })

  it('办公室有自己的场景容器，且排在办公区之后（它就是"点进去看"的那一页）', () => {
    const room = PAGE.slice(PAGE.indexOf('id="viewOfficeRoom"'), PAGE.indexOf('<section class="col hidden" id="viewApprovals">'))
    for (const flag of ['id="roomRoom"', 'id="roomFloor"', 'id="roomSummary"']) {
      assert.ok(room.includes(flag), `${flag} 不在办公室视图里 —— 场景没有落脚处`)
    }
    const order = tabViews(PAGE)
    assert.equal(order.indexOf('officeRoom'), order.indexOf('office') + 1, '办公室没有紧跟办公区')
  })
})

describe('setView 的真实行为（跑交付脚本里的真源码）', () => {
  it('切到任何一页都恰好只显这一个容器', () => {
    for (const view of Object.keys(EXPECTED_IDS)) {
      const harness = makeHarness()
      harness.setView(view)
      assert.deepEqual(visibleViews(harness), [EXPECTED_IDS[view]], `${view} 的显隐不对`)
    }
  })

  it('未知视图回落到办公区（否则所有页面一起隐身 → 一屏空白且不报错）', () => {
    const harness = makeHarness()
    harness.setView('nope')
    assert.deepEqual(visibleViews(harness), ['viewOffice'])
  })

  it('标签的 active 与当前视图一一对应（留下旧的 active 会骗人）', () => {
    const harness = makeHarness()
    harness.setView('health')
    for (const button of harness.tabButtons) {
      assert.equal(
        button.classes.has('active'),
        button.attrs['data-view'] === 'health',
        `data-view=${button.attrs['data-view']} 的 active 状态不对`,
      )
    }
  })

  it('进入哪一页就只拉那一页的数据', () => {
    const harness = makeHarness()
    harness.setView('health')
    assert.deepEqual(harness.loaded, ['health'])
    harness.setView('approvals')
    assert.deepEqual(harness.loaded, ['health', 'approvals'])
    harness.setView('llm')
    /* 员工配置页：端点库是共享事实，进页面就得拉；员工那半用注册摘要直接渲染。
       节点权限**不在这里拉** —— 它归「节点设置」子页，进去才读（见下一条）。 */
    assert.deepEqual(harness.loaded, ['health', 'approvals', 'llm.endpoints', 'llm'])
  })

  it('节点权限只在进入「节点设置」子页时才读', () => {
    /* 重构前是进页面就无条件拉三份（端点库 + 节点权限 + 员工配置），
       而其中两份在另外两个子页里 —— 重构正是为了"只看你现在这一页"。 */
    const harness = makeHarness()
    harness.setView('llm')
    assert.deepEqual(harness.loaded, ['llm.endpoints', 'llm'])
    harness.setConfigPage('nodes')
    assert.deepEqual(harness.loaded, ['llm.endpoints', 'llm', 'llm.nodePermissions'])
  })

  it('办公区 / 对话这两页不重复拉数据（它们靠连接与事件推送维护）', () => {
    const harness = makeHarness()
    harness.setView('office')
    harness.setView('chat')
    assert.deepEqual(harness.loaded, [])
    assert.deepEqual(harness.painted, [], '办公区/对话不该触发办公室的重绘')
  })

  it('进办公室只重画场景，一个请求都不发（它用的是办公区那一份数据）', () => {
    const harness = makeHarness()
    harness.setView('officeRoom')
    assert.deepEqual(harness.loaded, [], '办公室发了 RPC —— 它不该有自己的取数')
    assert.deepEqual(harness.painted, ['officeRoom'], '切进办公室没有重画场景（会停在离开那一刻的忙闲状态）')
  })

  it('离开办公室再回来会再重画一次（忙闲/在线状态在此期间可能变了）', () => {
    const harness = makeHarness()
    harness.setView('officeRoom')
    harness.setView('office')
    harness.setView('officeRoom')
    assert.deepEqual(harness.painted, ['officeRoom', 'officeRoom'])
  })

  it('进设备页要刷新「注册窗口」卡片（只随连接前的 bindEvents 加载过一次 = 永久停在"需要权限"）', () => {
    /* 实机冒烟撞出来的：卡片在 bindEvents 里加载，而那时脚本跑在连接建立之前，
       于是它永远停在"（需要 device.pair 权限）"—— 开关看起来根本不存在。 */
    const harness = makeHarness()
    harness.setView('devices')
    assert.deepEqual(harness.loaded, ['devices', 'pairingWindow'])
  })

  it('没有 device.pair scope 时进设备页不发请求（标签本身也是藏着的）', () => {
    const harness = makeHarness()
    harness.setScopes([])
    harness.setView('devices')
    assert.deepEqual(harness.loaded, [], '没权限还发了 device.list —— 用户只会看到一串权限报错')
  })

  it('离开办公区就清掉"正在改名"的意图（回到办公区时编辑器不该自己弹回来）', () => {
    const harness = makeHarness()
    harness.setIntent({ key: '渗透组', value: '红队' })
    harness.setView('approvals')
    assert.equal(harness.intent(), null, '切到审批页后改名意图还在')
  })

  it('留在办公区（含未知视图回落）时不动改名意图', () => {
    const harness = makeHarness()
    harness.setIntent({ key: '渗透组', value: '红队' })
    harness.setView('office')
    assert.notEqual(harness.intent(), null, '回办公区把自己的意图清掉了')
  })
})

describe('标签里的计数 chip 不许挡住点击', () => {
  it('点击处理用 closest 找按钮，而不是看 event.target.tagName', () => {
    /* 这坑是这么来的：审批 / 体检 的标签里放了计数 chip，点在那个 span 上时
       target 是 span —— 按 `target.tagName !== 'BUTTON'` 判会当场 return，
       表现为"点标签里的数字没反应，只有点字才有反应"。 */
    const start = CONSOLE_SOURCE.indexOf('function bindEvents()')
    assert.ok(start >= 0, '找不到 bindEvents')
    const body = CONSOLE_SOURCE.slice(start, CONSOLE_SOURCE.indexOf("var btnDisconnect = $('btnDisconnect')", start))
    assert.ok(body.includes("node.closest('button.tab')"), '标签点击没有用 closest —— chip 会变成点击死区')
    assert.ok(!body.includes("tagName !== 'BUTTON'"), '标签点击还在按 tagName 判 —— chip 会变成点击死区')
    assert.ok(body.includes('tabs.contains(button)'), '没有确认按钮属于这个标签条')
  })

  it('两个计数 chip 都住在标签里（同一个 id 不做第二份，避免页面里出现重复 id）', () => {
    const tabs = PAGE.slice(
      PAGE.indexOf('<div class="tabs" id="viewTabs">'),
      PAGE.indexOf('<section class="col" id="viewOffice">'),
    )
    assert.ok(tabs.includes('id="approvalCount"'), '审批计数没在标签里')
    assert.ok(tabs.includes('id="healthChip"'), '体检结论没在标签里')
    assert.equal(PAGE.split('id="approvalCount"').length - 1, 1, '页面里出现了重复的 approvalCount')
    assert.equal(PAGE.split('id="healthChip"').length - 1, 1, '页面里出现了重复的 healthChip')
  })

  it('chip 为空时整块藏掉（空胶囊比没有更难看），有数字时不覆盖 .chip 的原色', () => {
    const css = CSS_SOURCE.replace(/\s+/g, ' ')
    assert.ok(/button\.tab \.chip:empty \{ display: none; \}/.test(css), '空的标签 chip 没有隐藏')
    const rule = css.slice(css.indexOf('button.tab .chip {'), css.indexOf('button.tab .chip:empty'))
    assert.ok(!rule.includes('color:'), '标签 chip 覆盖了 color —— 体检的问题数就不会变红了')
  })

  it('体检标签的胶囊只在有问题时出现（常驻的"正常"只是占位置）', () => {
    /* 这条是源码断言而不是行为断言，如实说明原因：renderHealth 的入参是一份 node.list
       结果 + 一堆 DOM（healthBody 的每一行），把它塞进替身里跑等于把被测的东西换成替身。
       真实行为是在浏览器里看出来的（切到体检页后标签上没有胶囊）。 */
    assert.ok(
      /chip\.textContent = problems === 0 \? '' : String\(problems\) \+ ' 项待处理'/.test(CONSOLE_SOURCE),
      '体检胶囊在没问题时仍然显示文字 —— 常驻的"正常"会训练人忽略这个标签',
    )
  })
})

describe('设备页的 scope 门槛', () => {
  it('没有 device.pair 时把标签一起藏掉（不只是藏内容）', () => {
    assert.ok(CONSOLE_SOURCE.includes("$('tabDevices')"), '找不到设备标签的引用')
    assert.ok(
      /tabDevices\.classList\.toggle\('hidden',\s*!canPair\)/.test(CONSOLE_SOURCE),
      '设备标签没有按 device.pair 隐藏 —— 会留下一个点开全是报错的入口',
    )
  })

  it('正停在设备页而权限没了，退回办公区', () => {
    assert.ok(
      CONSOLE_SOURCE.includes("if (!canPair && state.view === 'devices') setView('office')"),
      '权限消失后没有退回办公区 —— 用户会盯着一页永远拉不动的内容',
    )
  })

  it('设备页不再靠卡片自己的 hidden 控制显隐（改由视图表统一管，避免两处打架）', () => {
    assert.ok(!CONSOLE_SOURCE.includes("$('cardDevices')"), '旧的 cardDevices 显隐逻辑还在')
    assert.ok(!PAGE.includes('id="cardDevices"'), '页面里还留着 cardDevices 这个容器')
  })
})

describe('交付脚本与整页仍是自洽的', () => {
  it('交付脚本能通过 JS 解析（内联 JS 是字符串，tsc 不检查它）', () => {
    assert.doesNotThrow(() => new vm.Script(SCRIPT))
  })

  it('每个视图容器都是 main.grid 里的 .col，且只有办公区初始可见', () => {
    const main = PAGE.slice(PAGE.indexOf('<main class="grid">'), PAGE.indexOf('</main>'))
    for (const id of Object.values(EXPECTED_IDS)) {
      /* 对话页是**刻意的例外**：它是铺满视口的独立房间（`#viewChatShell` 是
         `position: fixed; inset: 0` 的网格外壳 —— 员工导航常驻在它左边），
         不再是 main.grid 里的一列。见下面那条"必须有返回入口"。 */
      if (id === 'viewChatShell') continue
      const at = main.indexOf(`id="${id}"`)
      assert.ok(at >= 0, `${id} 不在 main.grid 里`)
      const openTag = main.slice(main.lastIndexOf('<section', at), main.indexOf('>', at))
      assert.ok(openTag.includes('class="col'), `${id} 不是 .col —— 卡片间距会不对`)
      assert.equal(openTag.includes('hidden'), id !== 'viewOffice', `${id} 的初始可见性不对`)
    }
  })

  it('对话页铺满视口时，它自己必须带返回办公区的入口（否则进去就出不来）', () => {
    /* 为什么单列一条：`#viewChatShell` 盖住整屏 = 连**标签条**都盖住了。
       所以"返回"这件事不能再指望上面的标签条，只能在对话页自己的顶栏里。
       这条断了，用户进对话页后就只剩浏览器后退键能出去。 */
    const shellAt = PAGE.indexOf('id="viewChatShell"')
    assert.ok(shellAt >= 0, '找不到对话页外壳')
    /* 切到外壳开始处一直到 main 结束：`viewLlm` 在外壳**之前**，拿它当右边界会切出空串
       （第一版就是这么写的，于是这条断言永远失败）。 */
    const shell = PAGE.slice(shellAt, PAGE.indexOf('</main>'))
    assert.ok(shell.includes('id="btnBackOffice"'), '对话页必须有自己的返回办公区按钮')
    assert.ok(
      /#viewChatShell \{[^}]*position:\s*fixed/.test(CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')),
      '外壳的定位方式变了（不再是铺满视口的房间）—— 那这条"必须有返回入口"的理由也要重新审',
    )
  })
})
