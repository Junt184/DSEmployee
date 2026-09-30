/**
 * 四宫格外壳（岗位 `layout: 'quad'`）—— 结构契约 + 真实行为。
 *
 * 这一页的设计稿在 `docs/08-渗透测试页设计稿.md`，测试钉的是**最容易做错、且错了不报错**的几件事：
 *
 *   1. **只换外壳、不复制对话页**：三个格位是新的，右下那格（气泡/输入/会话/附件）仍是原来那些元素。
 *   2. **别的岗位这一页逐像素不变**：`.quad-cell / .quad-drawer` 默认 `display: none`，
 *      只有 `#viewChat.layout-quad` 才打开 —— 否则办公区里点开任何同事都会看见三个空格子。
 *   3. **右上格与右栏共用同一份取数**（`appendApprovalBlock` / `appendSkillBlock`）：
 *      两份取数必然分叉成"角标写 1、右栏写 2"。
 *   4. **读不到 != 没问题**：文件不存在、JSON 语法错、投影没收到，三种都要如实说各自的因。
 *
 * 行为测试沿用仓库既有做法：从**交付脚本**里抠出真源码（按花括号配对），配替身跑。
 * 局限（不掩饰）：文本断言证明不了像素。四宫格的几何是在真 Hub + 真节点上用浏览器量出来的
 * （docs/08 §9.2；窄屏用 docs/mockups/四宫格-响应式标尺.html 在 900px 的 iframe 里量）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { renderControlUi, renderControlUiScript } from '../src/web/ui.ts'
import { CSS_SOURCE } from './console-source.ts'

const SCRIPT = renderControlUiScript()
const MARKUP = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'markup.ts'), 'utf8')
const PAGE = renderControlUi({ hubId: 'hub-test', hubName: '测试 Hub', scriptUrl: '/ui.js' })

/** `src/web/css.ts` 的样式文本（注释先删掉，免得注释里的选择器被当成规则命中）。 */
function styleSheet(): string {
  return CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')
}

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

/* ────────────────────────── 替身 ────────────────────────── */

interface FakeEl {
  tag: string
  className: string
  textContent: string
  title: string
  children: FakeEl[]
  attrs: Record<string, string>
  onclick?: () => void
  onkeydown?: (event: { key: string; preventDefault: () => void }) => void
  classList: {
    add: (c: string) => void
    remove: (c: string) => void
    toggle: (c: string, on: boolean) => void
    contains: (c: string) => boolean
  }
  appendChild: (child: FakeEl) => void
  setAttribute: (key: string, value: string) => void
  removeAttribute: (key: string) => void
  getAttribute: (key: string) => string | null
  get firstChild(): FakeEl | null
}

function makeEl(tag: string): FakeEl {
  const classes = new Set<string>()
  const node = {
    tag,
    className: '',
    textContent: '',
    title: '',
    children: [] as FakeEl[],
    attrs: {} as Record<string, string>,
    classList: {
      add: (name: string): void => void classes.add(name),
      remove: (name: string): void => void classes.delete(name),
      toggle: (name: string, on: boolean): void => {
        if (on) classes.add(name)
        else classes.delete(name)
      },
      contains: (name: string): boolean => classes.has(name),
    },
    appendChild: (child: FakeEl): void => {
      node.children.push(child)
    },
    setAttribute: (key: string, value: string): void => {
      node.attrs[key] = value
    },
    removeAttribute: (key: string): void => {
      delete node.attrs[key]
    },
    getAttribute: (key: string): string | null => node.attrs[key] ?? null,
    get firstChild(): FakeEl | null {
      return node.children[0] ?? null
    },
  }
  return node as FakeEl
}

function findAll(node: FakeEl, className: string): FakeEl[] {
  const out: FakeEl[] = []
  const walk = (current: FakeEl): void => {
    if (current.className.split(/\s+/).includes(className)) out.push(current)
    for (const child of current.children) walk(child)
  }
  walk(node)
  return out
}

function allText(node: FakeEl): string {
  return node.textContent + node.children.map((child) => ' ' + allText(child)).join('')
}

function findButtons(node: FakeEl): FakeEl[] {
  return collect(node, (el) => el.tag === 'button')
}

function collect(node: FakeEl, match: (el: FakeEl) => boolean): FakeEl[] {
  const out: FakeEl[] = []
  const walk = (current: FakeEl): void => {
    if (match(current)) out.push(current)
    for (const child of current.children) walk(child)
  }
  walk(node)
  return out
}

const EMPLOYEE = { id: 'emp_quad', name: '栀子', position: 'pos_quad' }

interface QuadApi {
  positionCellsOf: (employee: unknown) => { tl: string[]; bl: string[]; tr: string[]; top: string[] }
  quadFileNeeds: (ids: { tl: string[]; bl: string[]; tr: string[]; top: string[] }) => {
    scope: boolean
    board: boolean
    monitor: boolean
    findings: boolean
    incident: boolean
    actions: boolean
  }
  renderPanelsInto: (container: FakeEl, ctx: unknown, ids: string[]) => void
  renderPanelPentestPlan: (container: FakeEl, ctx: unknown) => void
  renderPanelPentestTarget: (container: FakeEl, ctx: unknown) => void
  readWorkspaceJson: (employeeId: string, filePath: string) => Promise<{ ok: boolean; reason?: string; value?: unknown }>
  scopeView: (scope: unknown) => Record<string, string>
  boardView: (board: unknown) => { done: number | null; total: number | null; findings: Record<string, number> | null }
  renderQuadCells: () => void
  renderQuadPlan: () => void
  applyQuadShell: (employee: unknown) => void
  leaveQuadShell: () => void
  applyQuadDrawer: (cell: string) => void
  toggleQuadDrawer: (cell: string) => void
  applyPlanProjection: (n: unknown) => void
  appendApprovalBlock: (container: FakeEl, employeeId: string, options?: unknown) => number
  appendSkillBlock: (container: FakeEl, employee: unknown, snapshot: unknown, options?: unknown) => void
  getState: () => Record<string, unknown>
}

interface Harness {
  api: QuadApi
  nodes: Record<string, FakeEl>
  area: FakeEl
  rpcCalls: Array<{ method: string; params: Record<string, unknown> }>
  panelCalls: Array<{ cell: string; ids: string[] }>
  approvals: Array<{ id: string; approve: boolean }>
  views: string[]
}

/**
 * 把四宫格那两段（68-quad + 80-panels 的格位面板）+ 共用块（75-aside）的真源码跑起来。
 *
 * 替身的原则：**只替身"别人的东西"**（DOM、RPC、会话切换、右栏重绘），
 * 被测的那几个函数一律用真源码 —— 否则测的是替身而不是产品。
 */
function makeHarness(
  options: {
    files?: Record<string, string>
    failDetail?: string
    cells?: unknown
    layout?: string
    positions?: unknown[]
    approvals?: unknown[]
    canResolve?: boolean
    sessions?: unknown[]
    selectedSessionId?: string
  } = {},
): Harness {
  const area = makeEl('div')
  const nodes: Record<string, FakeEl> = {
    viewChat: makeEl('section'),
    quadTl: makeEl('div'),
    quadBl: makeEl('div'),
    quadTr: makeEl('div'),
    quadTop: makeEl('div'),
    quadDrawer_tl: makeEl('button'),
    quadDrawer_bl: makeEl('button'),
    quadDrawer_tr: makeEl('button'),
    sessionPanel: makeEl('div'),
    btnChatSessions: makeEl('button'),
  }
  nodes['viewChat']?.classList.add('layout-quad')
  nodes['sessionPanel']?.classList.add('hidden')
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  const panelCalls: Array<{ cell: string; ids: string[] }> = []
  const approvals: Array<{ id: string; approve: boolean }> = []
  const views: string[] = []
  const stored = new Map<string, string>()

  const cellOf = (container: FakeEl): string =>
    container === nodes['quadTl'] ? 'tl' : container === nodes['quadBl'] ? 'bl' : 'tr'
  const employee = { ...EMPLOYEE }
  const state = {
    view: 'chat',
    selectedEmployeeId: employee.id,
    selectedSessionId: options.selectedSessionId ?? 'sess_1',
    quad: { employeeId: employee.id, scopeResult: null, boardResult: null, skillsOpen: false, drawer: '' },
    plan: { sessionId: options.selectedSessionId ?? 'sess_1', todos: null, prev: null, prevAtMs: 0, live: false },
    approvals: options.approvals ?? [],
    canResolve: options.canResolve !== false,
    sessions: options.sessions ?? [],
    aside: null,
  }

  const scope: Record<string, unknown> = {
    document: {
      createElement: (tag: string): FakeEl => makeEl(tag),
    },
    el: (tag: string, className?: string, text?: unknown): FakeEl => {
      const node = makeEl(tag)
      if (className) node.className = className
      if (text !== undefined && text !== null) node.textContent = String(text)
      return node
    },
    clear: (node: FakeEl): void => {
      node.children.length = 0
      node.textContent = ''
    },
    $: (id: string): FakeEl | null => nodes[id] ?? null,
    rpc: (method: string, params: Record<string, unknown>): Promise<unknown> => {
      rpcCalls.push({ method, params })
      const wanted = String(params['path'] ?? '')
      const content = options.files?.[wanted]
      if (content === undefined) {
        const message = options.failDetail ?? 'ENOENT: no such file or directory'
        return Promise.reject(Object.assign(new Error(message), { code: 'not-found' }))
      }
      return Promise.resolve({ path: wanted, content })
    },
    describeError: (error: unknown): string => String((error as { message?: string })?.message ?? error),
    readLocal: (key: string): string | null => stored.get(key) ?? null,
    writeLocal: (key: string, value: string): void => void stored.set(key, value),
    employeeById: (): unknown => employee,
    /* 岗位目录：唯一的真源，cells 从 options 来（引擎侧另有 positions.test.ts 盯着 upsert） */
    positionEntryOf: (target: unknown): unknown => {
      if (target === null || typeof target !== 'object') return null
      const wanted = String((target as { position?: string }).position ?? '')
      if (wanted === '') return null
      if (options.positions !== undefined) {
        return (options.positions as Array<{ id?: string }>).find((entry) => entry.id === wanted) ?? null
      }
      return {
        id: wanted,
        name: '渗透测试',
        layout: options.layout ?? 'quad',
        cells: options.cells ?? { tl: ['pentest-target'], bl: ['pentest-plan'] },
      }
    },
    /* 面板注册表：renderPanelsInto 是**真源码**（它会查这张表），所以替身给的是注册表本身。
       记下"哪一格拿到了哪些 id" —— 那是外壳的职责；面板自己怎么画由各自的用例盯。 */
    PANEL_RENDERERS: {
      'pentest-target': (container: FakeEl): void => {
        panelCalls.push({ cell: cellOf(container), ids: ['pentest-target'] })
        container.appendChild(makeEl('div'))
      },
      'pentest-plan': (container: FakeEl): void => {
        panelCalls.push({ cell: cellOf(container), ids: ['pentest-plan'] })
        container.appendChild(makeEl('div'))
      },
      /* 安全监测那几格：本文件只关心"外壳把它们放对了位置"，内容由 ui-monitor.test.ts 盯 */
      'monitor-watch': (container: FakeEl): void => {
        panelCalls.push({ cell: cellOf(container), ids: ['monitor-watch'] })
        const block = makeEl('div')
        block.className = 'aside-block'
        const title = makeEl('div')
        title.className = 'aside-title'
        title.textContent = '巡检轮次'
        block.appendChild(title)
        container.appendChild(block)
      },
      'capability-badge': (container: FakeEl): void => {
        panelCalls.push({ cell: cellOf(container), ids: ['capability-badge'] })
        const badge = makeEl('button')
        badge.className = 'quad-badge'
        badge.textContent = '只读'
        container.appendChild(badge)
      },
    },
    toggleSessionPanel: (show?: boolean): void => {
      const hidden = nodes['sessionPanel']?.classList.contains('hidden') === true
      const want = typeof show === 'boolean' ? show : hidden
      nodes['sessionPanel']?.classList.toggle('hidden', !want)
    },
    sessionIdOf: (item: unknown): string => String((item as { id?: string })?.id ?? ''),
    sessionTitleOf: (item: unknown): string => String((item as { title?: string })?.title ?? ''),
    renderQuadPlan: (): void => undefined,
    resolveApproval: (approvalId: string, approve: boolean): void => void approvals.push({ id: approvalId, approve }),
    setView: (view: string): void => void views.push(view),
    approvalKindLabel: (kind: string): string => kind,
    approvalSummaryText: (item: unknown): string => String((item as { summary?: string })?.summary ?? ''),
    approvalRelativeTime: (): string => '刚刚',
    renderContextRing: (): void => undefined,
    state,
    SCOPE_PATH: 'scope.json',
    BOARD_PATH: 'board.json',
    SCOPE_HINT: 'scope.json 最小写法……',
    QUAD_LAYOUT: 'quad',
    QUAD_DRAWER_KEY: 'dse.quadDrawer',
    "QUAD_DRAWER_CELLS": ['tl', 'bl', 'tr'],
  }

  const source = [
    extractFunction('positionCellsOf'),
    extractFunction('renderPanelsInto'),
    extractFunction('cellText'),
    extractFunction('scopeView'),
    extractFunction('boardView'),
    extractFunction('readWorkspaceJson'),
    extractFunction('appendFileState'),
    extractFunction('renderPanelPentestTarget'),
    extractFunction('renderPanelPentestPlan'),
    extractFunction('quadCellNodes'),
    extractFunction('clearQuadCells'),
    extractFunction('quadActive'),
    extractFunction('resetQuadState'),
    extractFunction('applyQuadDrawer'),
    extractFunction('toggleQuadDrawer'),
    extractFunction('applyQuadSkin'),
    extractFunction('toggleQuadSkin'),
    extractFunction('clearQuadSkin'),
    extractFunction('quadContext'),
    extractFunction('withCell'),
    extractFunction('quadEmptyNote'),
    extractFunction('renderQuadCells'),
    extractFunction('renderQuadPlan'),
    extractFunction('renderQuadTrCell'),
    extractFunction('sessionPanelExpanded'),
    extractFunction('currentSessionTitle'),
    extractFunction('quadFileNeeds'),
    extractFunction('loadQuadFiles'),
    extractFunction('reloadQuadFiles'),
    extractFunction('applyQuadShell'),
    extractFunction('leaveQuadShell'),
    extractFunction('applyPlanProjection'),
    /* 共用块：审批与技能（右栏与右上格同一份取数） */
    extractFunction('asideBlock'),
    extractFunction('asideRow'),
    extractFunction('makeFoldToggle'),
    extractFunction('appendApprovalBlock'),
    extractFunction('appendSkillBlock'),
    /* 顶层 var 与常量（交付脚本里是拼接出来的，这里按同样顺序手工带进来） */
    "var ASIDE_ROWS_MAX = 8",
    "var SCOPE_PATH = 'scope.json'",
    "var BOARD_PATH = 'board.json'",
    "var SCOPE_HINT = 'scope.json 最小写法……'",
    'var FINDING_LEVELS = [{ key: "critical", label: "严重", cls: "lv1" }, { key: "high", label: "高", cls: "lv2" }, { key: "medium", label: "中", cls: "lv3" }, { key: "low", label: "低", cls: "lv4" }]',
    "var QUAD_LAYOUT = 'quad'",
    "var QUAD_DRAWER_KEY = 'dse.quadDrawer'",
    "var QUAD_DRAWER_CELLS = ['tl', 'bl', 'tr']",
    "var QUAD_CHAT_LAYOUT = 'quad-chat'",
    "var QUAD_SKIN_KEY = 'dse.quadSkin'",
    "var QUAD_INCIDENT_PANELS = ['incident-post', 'incident-steps', 'incident-timeline']",
    "var QUAD_SKINS = ['day', 'neon']",
    'var quadBound = false',
    'var turnRunning = false',
  ].join('\n')

  const names = Object.keys(scope)
  const factory = new Function(
    ...names,
    source +
      '\nreturn { positionCellsOf: positionCellsOf, renderPanelsInto: renderPanelsInto, ' +
      'renderPanelPentestTarget: renderPanelPentestTarget, renderPanelPentestPlan: renderPanelPentestPlan, ' +
      'readWorkspaceJson: readWorkspaceJson, scopeView: scopeView, boardView: boardView, ' +
      'renderQuadCells: renderQuadCells, renderQuadPlan: renderQuadPlan, applyQuadShell: applyQuadShell, leaveQuadShell: leaveQuadShell, ' +
      'applyQuadDrawer: applyQuadDrawer, toggleQuadDrawer: toggleQuadDrawer, applyPlanProjection: applyPlanProjection, ' +
      'appendApprovalBlock: appendApprovalBlock, appendSkillBlock: appendSkillBlock, quadFileNeeds: quadFileNeeds, ' +
      'getState: function () { return state } }',
  ) as (...args: unknown[]) => QuadApi

  return { api: factory(...Object.values(scope)), nodes, area, rpcCalls, panelCalls, approvals, views }
}

/* ────────────────────────── 1. 结构与样式契约 ────────────────────────── */

describe('四宫格：结构契约（CSS 与标记）', () => {
  it('默认关闭：非四宫格的岗位这一页与从前完全一样（格子与抽屉都不出现）', () => {
    const css = styleSheet()
    assert.ok(
      /\.quad-cell,\s*\.quad-drawer,\s*\.quad-skin-btn\s*\{\s*display:\s*none;?\s*\}/.test(css),
      '基础规则里必须把 .quad-cell / .quad-drawer / .quad-skin-btn 一起关掉 —— ' +
        '否则办公区里点开任何同事都会看见三个空格子和一个皮肤按钮',
    )
  })

  it('四宫格是 5 行网格，区域与轨道数一致（少写一行就会被塞进隐含行，把格子顶走）', () => {
    const css = styleSheet()
    const start = css.indexOf('#viewChat.layout-quad {')
    assert.ok(start > 0, '找不到 #viewChat.layout-quad 的规则')
    const block = css.slice(start, css.indexOf('}', start))
    const areas = /grid-template-areas:\s*((?:"[^"]+"\s*)+)/.exec(block)?.[1] ?? ''
    const rows = areas.match(/"[^"]+"/g) ?? []
    assert.deepEqual(
      /* 多条空格只是对齐用的（"tl  tr"），比较前归一化 */
      rows.map((row) => row.replace(/"/g, '').trim().replace(/\s+/g, ' ')),
      ['top top', 'tl tr', 'bl ss', 'bl msgs', 'bl composer'],
      '四格与对话格的网格区域必须是这一份（左上/左下/右上/右下 + 会话带）',
    )
    const tracks = /grid-template-rows:\s*([^;]+);/.exec(block)?.[1] ?? ''
    /* 数轨道要按括号配对切：`minmax(0, 1fr)` 里本身带空格 */
    const tokens: string[] = []
    let depth = 0
    let current = ''
    for (const char of tracks.trim()) {
      if (char === '(') depth += 1
      if (char === ')') depth -= 1
      if (/\s/.test(char) && depth === 0) {
        if (current !== '') tokens.push(current)
        current = ''
        continue
      }
      current += char
    }
    if (current !== '') tokens.push(current)
    assert.equal(tokens.length, rows.length, `区域 ${rows.length} 行，却写了 ${tokens.length} 条轨道（${tracks.trim()}）`)
  })

  it('右上那行有下限：会话列表展开时挤压的是对话，不是"批准/拒绝"', () => {
    const css = styleSheet()
    const start = css.indexOf('#viewChat.layout-quad {')
    const block = css.slice(start, css.indexOf('}', start))
    assert.ok(
      /grid-template-rows:[^;]*minmax\(240px,\s*1fr\)/.test(block),
      '右上格所在行必须带下限 —— 实测不给下限时它会从 274px 掉到 168px，正好把裁决按钮挤没',
    )
  })

  it('四宫格里没有右栏：同一份数据不许有两块地方（技能/审批都在右上格）', () => {
    const css = styleSheet()
    assert.ok(
      /#viewChat\.layout-quad\s*>\s*#employeeAside\s*\{\s*display:\s*none\s*!important;?\s*\}/.test(css),
      '四宫格必须把 #employeeAside 藏掉，否则技能与审批会出现两处，状态迟早不一致',
    )
  })

  it('格位复用的是同一批 aside-block，所以样式必须一起覆盖', () => {
    const css = styleSheet()
    assert.ok(
      /\.chat-aside \.aside-block,\s*\.quad-cell \.aside-block\s*\{/.test(css),
      '.aside-block 的样式原来只写在 .chat-aside 下；不给 .quad-cell 同样的规则，格子里的块会没有边框与间距（不报错，只是看着像坏了）',
    )
  })

  it('窄屏（≤959px）：三格收进抽屉，一次摊开一格，抽屉里那格是浮层且限高', () => {
    const css = styleSheet()
    /* 样式表里有**多个** `@media (max-width: 959px)`（秘书页也有一个），
       所以要挑"里面写着四宫格"的那一个 —— 取第一个会量到别人家的规则，而且不报错。 */
    const blocks: string[] = []
    let cursor = 0
    for (;;) {
      const at = css.indexOf('@media (max-width: 959px)', cursor)
      if (at < 0) break
      let depth = 0
      let end = at
      for (let index = css.indexOf('{', at); index < css.length; index += 1) {
        if (css[index] === '{') depth += 1
        else if (css[index] === '}') {
          depth -= 1
          if (depth === 0) {
            end = index + 1
            break
          }
        }
      }
      blocks.push(css.slice(at, end))
      cursor = end
    }
    const block = blocks.find((one) => one.includes('#viewChat.layout-quad')) ?? ''
    assert.ok(block !== '', '找不到四宫格的窄屏媒体查询')
    assert.ok(/#viewChat\.layout-quad\s*\{/.test(block), '窄屏没有四宫格的降级规则')
    for (const cell of ['tl', 'bl', 'tr']) {
      assert.ok(
        new RegExp(`#viewChat\\.layout-quad\\[data-drawer="${cell}"\\]\\s*>\\s*\\.quad-${cell}`).test(block),
        `窄屏缺 [data-drawer="${cell}"] 的规则：点那一格的按钮会没有任何反应`,
      )
    }
    assert.ok(/max-height:\s*46vh/.test(block), '抽屉里那格必须限高，否则会把对话挤没')
    assert.ok(/\.quad-drawer\s*\{[^}]*display:\s*flex/.test(block), '窄屏要显示抽屉按钮条')
  })

  it('标记里三个格位与三个抽屉按钮都在 #viewChat 内（而不是页面别处）', () => {
    const section = MARKUP.slice(MARKUP.indexOf('id="viewChat"'))
    const body = section.slice(0, section.indexOf('</section>\n\n'))
    for (const id of ['quadTl', 'quadBl', 'quadTr', 'quadDrawer_tl', 'quadDrawer_bl', 'quadDrawer_tr']) {
      assert.ok(body.includes(`id="${id}"`), `#viewChat 里找不到 ${id}`)
    }
    assert.ok(PAGE.includes('#quadTl') === false, '格位是脚本渲染的，页面模板里不该出现它的内容')
  })
})

/* ────────────────────────── 2. 外壳行为 ────────────────────────── */

describe('四宫格：外壳行为', () => {
  it('岗位的 cells 决定每一格放什么；没绑岗位/没配 cells 时是四个空数组', () => {
    const harness = makeHarness({ cells: { tl: ['pentest-target'], bl: ['pentest-plan'], tr: ['x'] } })
    assert.deepEqual(harness.api.positionCellsOf(EMPLOYEE), { tl: ['pentest-target'], bl: ['pentest-plan'], tr: ['x'], top: [] })

    const none = makeHarness({ positions: [{ id: 'pos_quad', name: '渗透测试', layout: 'quad' }] })
    assert.deepEqual(none.api.positionCellsOf(EMPLOYEE), { tl: [], bl: [], tr: [], top: [] }, '没配 cells 必须是空数组，而不是抛错')

    const noPosition = makeHarness({ positions: [] })
    assert.deepEqual(noPosition.api.positionCellsOf(EMPLOYEE), { tl: [], bl: [], tr: [], top: [] }, '岗位不在目录里也不能抛错')
  })

  it('按面板 id 决定读哪些工作区文件：没配这些面板的岗位不为它们花一次请求', () => {
    const harness = makeHarness({})
    const empty = { tl: [], bl: [], tr: [], top: [] }
    const none = { scope: false, board: false, monitor: false, findings: false, incident: false, actions: false, incidents: false }
    assert.deepEqual(harness.api.quadFileNeeds(empty), none)
    assert.deepEqual(harness.api.quadFileNeeds({ ...empty, tl: ['pentest-target'] }), { ...none, scope: true, board: true })
    assert.deepEqual(
      harness.api.quadFileNeeds({ ...empty, tl: ['monitor-post'], bl: ['monitor-findings'] }),
      { ...none, monitor: true, findings: true },
      '监测面板要 monitor.json + findings.json',
    )
    assert.deepEqual(
      harness.api.quadFileNeeds({ ...empty, tl: ['incident-post'], bl: ['incident-steps'] }),
      { ...none, incident: true, actions: true, incidents: true },
      '应急面板要 incident.json + actions.json；事件台那一格还要历史档案 incidents.json',
    )
    assert.deepEqual(
      harness.api.quadFileNeeds({ ...empty, top: ['capability-badge'] }),
      { ...none, monitor: true },
      '单独的顶部徽章（监测岗那种配法）只要 monitor.json',
    )
    assert.deepEqual(
      harness.api.quadFileNeeds({ ...empty, top: ['capability-badge'], tl: ['incident-post'] }),
      { ...none, incident: true, actions: true, incidents: true },
      '应急岗的徽章读的是 incident.json —— 不该去读另一个岗位的文件',
    )
  })

  it('渲染进格位：配了的格子出面板，没配的格子如实说明（不是空白）', async () => {
    const harness = makeHarness({ cells: { tl: ['pentest-target'], bl: [] } })
    harness.api.renderQuadCells()
    assert.deepEqual(harness.panelCalls, [
      { cell: 'tl', ids: ['pentest-target'] },
    ], '左上渲染配置的面板；没配的格子不进注册表（右上的固有三段由别的用例盯）')
    assert.ok(
      allText(harness.nodes['quadBl']!).includes('没有给这一格配内容'),
      '没配内容的格子要如实说明（cells.bl），不能留一块白板让人以为坏了',
    )
  })

  it('顶部条上的徽章位：只有 cells.top 配了才画（别的岗位那一块永远是空的）', () => {
    const harness = makeHarness({ cells: { tl: [], bl: [], tr: [], top: ['capability-badge'] } })
    harness.api.renderQuadCells()
    assert.deepEqual(harness.panelCalls, [{ cell: 'tr', ids: ['capability-badge'] }], '顶部徽章进的是顶部那一块（这里由替身记成 tr：它没有自己的格位名）')
    assert.equal(harness.nodes['quadTop']?.children.length, 1, '徽章必须落在 #quadTop 里')
    assert.ok(allText(harness.nodes['quadTop']!).includes('只读'), '徽章文案来自面板：' + allText(harness.nodes['quadTop']!))

    const plain = makeHarness({ cells: { tl: ['pentest-target'], bl: [] } })
    plain.api.renderQuadCells()
    assert.equal(plain.nodes['quadTop']?.children.length, 0, '没配 cells.top 就不该往顶部条塞东西')
  })

  it('控制台不认识的 panel id：如实说出来，不静默跳过', () => {
    const harness = makeHarness({ cells: { tl: ['future-panel-x'], bl: [] } })
    harness.api.renderQuadCells()
    const text = allText(harness.nodes['quadTl']!)
    assert.ok(text.includes('future-panel-x'), '不认识的 id 必须出现在页面上（静默跳过 = 配了但没出现，没人查得出来）')
    assert.ok(text.includes('不认识'), '要明说是控制台不认识这个面板：' + text)
  })

  it('右上格：审批（可裁决）+ 会话折叠栏 + 专属技能折叠栏', () => {
    const harness = makeHarness({
      cells: { tl: [], bl: [] },
      approvals: [{ approvalId: 'ap_1', kind: 'dsh.approval', status: 'pending', summary: '请求执行 nmap', requestedAtMs: Date.now(), employeeId: EMPLOYEE.id }],
      sessions: [{ id: 'sess_1', title: '端口爆破复盘' }],
    })
    harness.api.getState()['aside'] = { employeeId: EMPLOYEE.id, skills: [{ name: 'clown-src-6k', valid: false, issues: ['frontmatter 缺 name'] }], skillsError: '' }
    harness.api.renderQuadCells()
    const tr = harness.nodes['quadTr']!
    const text = allText(tr)
    assert.ok(findButtons(tr).some((button) => button.textContent === '通过'), '右上格的审批要带行内裁决入口（这一格就是"人动手的地方"）：' + text)
    assert.ok(text.includes('未决审批'), '审批块要在右上格：' + text)
    assert.ok(text.includes('会话'), '右上格要有会话折叠栏')
    assert.ok(text.includes('当前：端口爆破复盘'), '会话折叠时要交代当前在哪个会话：' + text)
    assert.ok(text.includes('专属技能') && text.includes('1 个有问题'), '专属技能的"有问题"必须留在标题上（折的是列表，不是问题）：' + text)
  })

  it('窄屏抽屉：设置/取消 data-drawer，三颗按钮的 aria-pressed 跟着走，偏好记在本机', () => {
    const harness = makeHarness()
    const chat = harness.nodes['viewChat']!
    harness.api.applyQuadDrawer('bl')
    assert.equal(chat.getAttribute('data-drawer'), 'bl')
    assert.equal(harness.nodes['quadDrawer_bl']?.getAttribute('aria-pressed'), 'true')
    assert.equal(harness.nodes['quadDrawer_tl']?.getAttribute('aria-pressed'), 'false')
    assert.equal(harness.nodes['quadDrawer_tr']?.getAttribute('aria-pressed'), 'false')
    harness.api.toggleQuadDrawer('bl')
    assert.equal(chat.getAttribute('data-drawer'), null, '同一格再点一次 = 收起（窄屏要能一键回到"只看对话"）')
    harness.api.applyQuadDrawer('乱写的值')
    assert.equal(chat.getAttribute('data-drawer'), null, '不认识的值一律当收起，不能把页面留在半开状态')
  })

  it('切走再切回：状态清干净、格位重画（不许闪上一位员工的授权范围）', () => {
    const harness = makeHarness({ cells: { tl: ['pentest-target'], bl: ['pentest-plan'] } })
    harness.api.applyQuadShell(EMPLOYEE)
    assert.equal((harness.api.getState()['quad'] as { employeeId: string }).employeeId, EMPLOYEE.id)
    harness.nodes['quadTl']!.appendChild(makeEl('div'))
    harness.api.leaveQuadShell()
    assert.equal((harness.api.getState()['quad'] as { employeeId: string }).employeeId, '')
    assert.equal(harness.nodes['quadTl']?.children.length, 0, '离开外壳要清空格位 DOM')
  })
})

/* ────────────────────────── 3. 数据：读到什么就说什么 ────────────────────────── */

describe('四宫格：数据来源与如实失败', () => {
  it('文件不存在 → missing（引导人去写），其它错误 → unreadable（报出真正的原因）', async () => {
    const missing = makeHarness({ files: {} })
    const missingResult = await missing.api.readWorkspaceJson('emp_quad', 'scope.json')
    assert.equal(missingResult.ok, false)
    assert.equal(missingResult.reason, 'missing', 'ENOENT 是"人还没登记"，不是"读不到"')

    const offline = makeHarness({ files: {}, failDetail: 'node-offline: 节点未连接' })
    const offlineResult = await offline.api.readWorkspaceJson('emp_quad', 'scope.json')
    assert.equal(offlineResult.ok, false)
    assert.equal(offlineResult.reason, 'unreadable', '节点离线必须与"文件不存在"分开说')
    assert.ok(JSON.stringify(offlineResult).includes('node-offline'), '要带上原文，否则用户不知道该找谁')
  })

  it('JSON 语法错 → bad-json（并带出错原因）；顶层是数组 → shape', async () => {
    const bad = makeHarness({ files: { 'board.json': '{ "progress": ' } })
    const badResult = await bad.api.readWorkspaceJson('emp_quad', 'board.json')
    assert.equal(badResult.reason, 'bad-json')

    const array = makeHarness({ files: { 'board.json': '[1,2,3]' } })
    const arrayResult = await array.api.readWorkspaceJson('emp_quad', 'board.json')
    assert.equal(arrayResult.reason, 'shape', '顶层必须是对象，数组要如实说格式不对')

    const empty = makeHarness({ files: { 'board.json': '   ' } })
    assert.equal((await empty.api.readWorkspaceJson('emp_quad', 'board.json')).reason, 'empty', '0 字节与"没有文件"是两件事')
  })

  it('左上格：scope.json 说授权、board.json 说进度；语法错时一个数字都不显示', () => {
    const box = makeEl('div')
    makeHarness({}).api.renderPanelPentestTarget(box, {
      scopeResult: { ok: true, value: { targets: ['app.demo.local'], range: '10.20.30.0/24', window: { from: '2026-09-01', to: '2026-10-15' }, allow: ['端口扫描'], deny: ['拒绝服务'] } },
      boardResult: { ok: true, value: { progress: { done: 7, total: 12 }, findings: { critical: 2, high: 3, medium: 5, low: 4 } } },
    })
    const text = allText(box)
    assert.ok(text.includes('app.demo.local'), '目标名要出现：' + text)
    assert.ok(text.includes('10.20.30.0/24'), '范围要出现')
    assert.ok(text.includes('7 / 12'), '进度要出现')
    assert.ok(text.includes('严重'), '发现分级要出现')

    const broken = makeEl('div')
    makeHarness({}).api.renderPanelPentestTarget(broken, {
      scopeResult: { ok: false, reason: 'missing' },
      boardResult: { ok: false, reason: 'bad-json', detail: 'Unexpected token } in JSON at position 12' },
    })
    const brokenText = allText(broken)
    assert.ok(brokenText.includes('工作区里还没有这个文件'), '没有 scope.json 要如实说，并给出最小写法：' + brokenText)
    assert.ok(brokenText.includes('JSON 语法错'), 'board.json 语法错要说清是语法错')
    assert.ok(!/\d+ \/ \d+/.test(brokenText), '读不到时一个数字都不许显示（那是在编数字）')
  })

  it('board.json 也接受"发现清单数组"（员工更可能顺手写成数组）', () => {
    const view = makeHarness({}).api.boardView({
      findings: [{ severity: 'critical' }, { severity: 'high' }, { severity: 'high' }, { severity: '低' }],
    })
    assert.deepEqual(view.findings, { critical: 1, high: 2, medium: 0, low: 1 })
  })

  it('左下格：todos 投影 → ✓/▶/○，并把"上一轮"留在下面', () => {
    const box = makeEl('div')
    makeHarness({}).api.renderPanelPentestPlan(box, {
      plan: {
        sessionId: 'sess_1',
        todos: [
          { content: '读 scope.json 核对授权边界', status: 'completed' },
          { content: '速率确认', status: 'in_progress' },
          { content: '越权验证', status: 'pending' },
        ],
        prev: [{ content: '上一轮的一件事', status: 'completed' }],
        prevAtMs: Date.now() - 60_000,
        live: true,
      },
    })
    const text = allText(box)
    assert.ok(text.includes('1 / 3'), '标题要给出完成度：' + text)
    for (const marker of ['✓', '▶', '○']) assert.ok(text.includes(marker), `计划条目缺 ${marker}：` + text)
    assert.ok(text.includes('上一轮：1 / 1 完成'), '上一轮的收尾要留在页面上（不然干完就忘了）：' + text)
    const now = collect(box, (el) => el.className.includes('quad-todo') && el.className.includes('now'))
    assert.equal(now.length, 1, '进行中的那条要有所不同（它是"下一步"这个词的唯一落点）')
  })

  it('左下格：没有计划时如实说是"这一轮没有"，不假装有内容', () => {
    const box = makeEl('div')
    makeHarness({}).api.renderPanelPentestPlan(box, { plan: { sessionId: 'sess_1', todos: null, prev: null, prevAtMs: 0, live: true } })
    const text = allText(box)
    assert.ok(text.includes('没有计划'), '空闲时的空态文案：' + text)
    assert.ok(text.includes('todos 投影'), '要交代这一格的数据从哪来（用户才敢信它）')
  })

  it('投影只推不补：快照（live=false）时必须写出来，别让它看起来是实时的', () => {
    const box = makeEl('div')
    makeHarness({}).api.renderPanelPentestPlan(box, {
      plan: { sessionId: 'sess_1', todos: [{ content: 'x', status: 'pending' }], prev: null, prevAtMs: 0, live: false },
    })
    assert.ok(allText(box).includes('还没收到实时帧'), '快照与实时是两件事：' + allText(box))
  })

  it('applyPlanProjection：写下计划；本轮清空时把上一轮挪进 prev；别的会话一律不采信', () => {
    const harness = makeHarness()
    const planOf = (): { todos: unknown; prev: unknown; live: boolean } => harness.api.getState()['plan'] as { todos: unknown; prev: unknown; live: boolean }

    harness.api.applyPlanProjection({ key: 'todos', sessionId: 'sess_1', value: [{ content: 'a', status: 'completed' }] })
    assert.deepEqual(planOf().todos, [{ content: 'a', status: 'completed' }])
    assert.equal(planOf().live, true, '收到实时帧才算 live')

    harness.api.applyPlanProjection({ key: 'todos', sessionId: 'sess_1', value: null })
    assert.equal(planOf().todos, null, 'turn/start 会把 todos 置回 null')
    assert.deepEqual(planOf().prev, [{ content: 'a', status: 'completed' }], '刚干完那一轮必须先存成 prev，否则下一轮开场它就消失了')

    harness.api.applyPlanProjection({ key: 'todos', sessionId: 'sess_别人', value: [{ content: 'b', status: 'pending' }] })
    assert.equal(planOf().todos, null, '不是当前会话的投影帧一个字都不能采信')
  })

  it('只有配了 pentest-target 才去读工作区文件（别的岗位不花这个请求）', async () => {
    const plain = makeHarness({ cells: { tl: [], bl: ['pentest-plan'] } })
    plain.api.applyQuadShell(EMPLOYEE)
    await Promise.resolve()
    assert.equal(plain.rpcCalls.length, 0, '没配 pentest-target 就不该读 scope.json/board.json')

    const wants = makeHarness({ cells: { tl: ['pentest-target'], bl: ['pentest-plan'] }, files: { 'scope.json': '{}', 'board.json': '{}' } })
    wants.api.applyQuadShell(EMPLOYEE)
    await Promise.resolve()
    assert.deepEqual(
      wants.rpcCalls.map((call) => call.params['path']),
      ['scope.json', 'board.json'],
      '配了就要读这两份（且只读这两份）',
    )
  })
})

/* ────────────────────────── 4. 共用取数：审批与技能 ────────────────────────── */

describe('四宫格：审批与技能与右栏共用同一份取数', () => {
  const pendingInvoke = { approvalId: 'ap_1', kind: 'employee.invoke', status: 'pending', summary: '小艾调用阿澈', requestedAtMs: Date.now(), employeeId: 'emp_quad' }

  it('行内裁决：通过/拒绝各自带上正确的 approvalId', () => {
    const harness = makeHarness({ approvals: [pendingInvoke] })
    const box = makeEl('div')
    const count = harness.api.appendApprovalBlock(box, 'emp_quad', { actions: true })
    assert.equal(count, 1, '返回未决条数（标题徽章要用）')
    const buttons = findButtons(box)
    assert.deepEqual(buttons.map((button) => button.textContent), ['拒绝', '通过'])
    buttons[1]?.onclick?.()
    buttons[0]?.onclick?.()
    assert.deepEqual(harness.approvals, [
      { id: 'ap_1', approve: true },
      { id: 'ap_1', approve: false },
    ], '按钮必须落在自己那条审批上（循环变量串味过一次就会批错人）')
  })

  it('提问不是二值裁决：dsh.question 不给通过/拒绝，只给"去审批页回答"', () => {
    const harness = makeHarness({ approvals: [{ ...pendingInvoke, approvalId: 'ap_q', kind: 'dsh.question' }] })
    const box = makeEl('div')
    harness.api.appendApprovalBlock(box, 'emp_quad', { actions: true })
    const labels = findButtons(box).map((button) => button.textContent)
    assert.ok(!labels.includes('通过') && !labels.includes('拒绝'), '提问给二值按钮 = 逼人用"批准"回答一个问题：' + JSON.stringify(labels))
    const go = findButtons(box).find((button) => button.textContent.includes('审批页'))
    assert.ok(go !== undefined, '但要有一个能去回答的入口')
    go?.onclick?.()
    assert.deepEqual(harness.views, ['approvals'])
  })

  it('没有 approval.resolve 权限时不给按钮，如实说需要权限', () => {
    const harness = makeHarness({ approvals: [pendingInvoke], canResolve: false })
    const box = makeEl('div')
    harness.api.appendApprovalBlock(box, 'emp_quad', { actions: true })
    assert.equal(findButtons(box).length, 0, '没权限就不该给按了会失败的按钮')
    assert.ok(allText(box).includes('权限'), '要如实说原因：' + allText(box))
  })

  it('右栏那份（不带 actions）仍然是只读的：两处取数相同、形态不同', () => {
    const harness = makeHarness({ approvals: [pendingInvoke] })
    const box = makeEl('div')
    harness.api.appendApprovalBlock(box, 'emp_quad', {})
    assert.equal(findButtons(box).length, 0, '右栏不提供裁决按钮（裁决在审批页）')
    assert.ok(allText(box).includes('审批'), '右栏要指路：' + allText(box))
  })

  it('对话占半屏的排法（layout: quad-chat）：网格不同，其余全共用', () => {
    /* 用户的原话："应急响应重对话，所以对话肯定要占半个屏幕，而不能是 1/4 个屏幕"。
       这一排法只在**网格**上与 quad 不同：右侧整列给对话，会话/技能折成顶栏下的一条。
       格位、面板、皮肤、窄屏抽屉全部共用同一份实现 —— 所以这里钉的就是那两件事。 */
    const css = styleSheet()
    const start = css.indexOf('#viewChat.layout-quad-chat {')
    assert.ok(start > 0, '找不到 quad-chat 的网格规则')
    const block = css.slice(start, css.indexOf('}', start))
    const areas = /grid-template-areas:\s*((?:"[^"]+"\s*)+)/.exec(block)?.[1] ?? ''
    const rows = (areas.match(/"[^"]+"/g) ?? []).map((row) => row.replace(/"/g, '').trim().replace(/\s+/g, ' '))
    assert.deepEqual(
      rows,
      ['top top', 'side side', 'tl msgs', 'bl msgs', 'bl composer'],
      '对话（msgs）必须跨两行、占右半边；事件台与处置队列在左列上下排',
    )
    assert.ok(
      /grid-template-rows:\s*auto auto auto minmax\(0, 1fr\) auto/.test(block),
      '第三行是 auto（事件台按内容高度）、第四行 1fr 全给处置队列：要动手的地方才该拿到弹性空间',
    )
    /* 事件台再长也不许把队列挤没 */
    assert.ok(
      /#viewChat\.layout-quad-chat > \.quad-tl \{[^}]*max-height/.test(css),
      '事件台要有 max-height（超了格内滚动），否则它会把处置队列挤掉',
    )
    /* 会话/技能在这一排法里是一条横条，块要横着排 */
    assert.ok(
      /#viewChat\.layout-quad-chat > \.quad-tr \{[^}]*flex-direction:\s*row/.test(css),
      '右上那格在这一排法里是顶栏下的横条（会话/技能/时间线折成一行）',
    )
    /* 会话面板在 ≥1200px 那条"左栏常驻"规则下会掉进隐含行（quad 踩过一模一样的坑），
       所以这一排法必须显式给它一个格子 */
    assert.ok(
      /#viewChat\.layout-quad-chat > #sessionPanel \{[^}]*grid-area:\s*msgs/.test(css),
      '会话列表要显式放进 msgs 格（否则被 ≥1200px 那条规则拽进隐含行）',
    )
  })

  it('切换外壳：quad-chat 也走 applyQuadShell（只差网格），类名由 applyPositionShell 一起开', () => {
    /* 两层各管一件事，所以分两处钉：
       · applyQuadShell 负责格位/面板/皮肤/抽屉 —— 它对两种排法完全一样（这里实测）；
       · 类名（layout-quad + layout-quad-chat）由 applyPositionShell 开（那里的源码断言）。
       混在一起钉的话，测试会依赖一个它其实没跑的层级。 */
    const harness = makeHarness({ cells: { tl: ['pentest-target'], bl: [] }, layout: 'quad-chat' })
    harness.api.applyQuadShell(EMPLOYEE)
    assert.ok(
      harness.nodes['viewChat']?.classList.contains('layout-quad'),
      'quad-chat 必须也带 layout-quad 类：网格以外的规则（格位外观、会话带、皮肤）全部共用那一份',
    )
    assert.deepEqual(harness.panelCalls, [{ cell: 'tl', ids: ['pentest-target'] }], '格位渲染与 quad 完全一致')
    harness.api.leaveQuadShell()
    assert.equal(harness.panelCalls.length, 1, '切走之后不再重画格位')

    const shell = SCRIPT.slice(SCRIPT.indexOf('function applyPositionShell('))
    const body = shell.slice(0, shell.indexOf('\n}\n'))
    assert.ok(body.includes('QUAD_CHAT_LAYOUT'), 'applyPositionShell 要认出 quad-chat 这个外壳 id')
    assert.ok(body.includes("classList.toggle('layout-quad-chat'"), '并把类名开到 #viewChat 上')
    assert.ok(
      /\(isQuad \|\| isQuadChat\) && typeof applyQuadShell/.test(body),
      '两种排法都要走同一个 applyQuadShell —— 不许为 quad-chat 复制一份外壳逻辑',
    )
    assert.ok(
      /!isQuad && !isQuadChat && typeof leaveQuadShell/.test(body),
      '离开任一种排法都要清干净（否则切到别的员工会带着旧数字）',
    )
  })

  it('右上格：没有未决审批就整段不出现；真出现时才冒出来（常驻一个永远不变的 0 = 白占位置）', () => {
    const quiet = makeHarness({ cells: { tl: [], bl: [] } })
    quiet.api.renderQuadCells()
    assert.ok(
      !allText(quiet.nodes['quadTr']!).includes('未决审批'),
      '没有未决项时不该画那一段（用户 2026-09-24 的判词：那些静态数据一辈子也不变）',
    )
    assert.ok(allText(quiet.nodes['quadTr']!).includes('会话'), '但会话与技能照常在')

    const busy = makeHarness({ cells: { tl: [], bl: [] }, approvals: [pendingInvoke] })
    busy.api.renderQuadCells()
    const text = allText(busy.nodes['quadTr']!)
    assert.ok(text.includes('未决审批'), '有未决项时它必须冒出来（那是唯一能解除阻塞的地方）：' + text)
    assert.deepEqual(findButtons(busy.nodes['quadTr']!).map((button) => button.textContent), ['拒绝', '通过'], '出来时要带行内裁决')
  })

  it('右上格的顺序：岗位面板 → 审批 → 会话 → 技能（面板在最上：它是唯一每轮都变的东西）', () => {
    const harness = makeHarness({
      cells: { tl: [], bl: [], tr: ['monitor-watch'] },
      approvals: [pendingInvoke],
      sessions: [{ id: 'sess_1', title: '第三轮例行巡检' }],
    })
    harness.api.getState()['aside'] = { employeeId: EMPLOYEE.id, skills: [], skillsError: '' }
    harness.api.renderQuadCells()
    const titles = (harness.nodes['quadTr']?.children ?? []).map((child) =>
      allText(child.firstChild ?? child)
        .replace(/[⌄⌃]/g, '')
        .replace(/\s*\d+\s*(待处理)?$/, '')
        .trim(),
    )
    assert.deepEqual(titles, ['巡检轮次', '未决审批', '会话', '专属技能'], '四个块的出现顺序就是这一格的信息层级')
  })

  it('技能快照到位后，右上格要跟着重画（否则那一格永远停在「正在载入…」）', () => {
    /* 生产上真实发生过：格位先画、技能后到，而没有任何人叫格位重画 ——
       表现是右上格一直显示"正在载入…"，看不出是 bug（像"还没好"）。
       这条钉的是 renderEmployeeAside 里那次 renderQuadCells()。 */
    const harness = makeHarness({ cells: { tl: [], bl: [] } })
    harness.api.getState()['aside'] = null
    harness.api.renderQuadCells()
    assert.ok(allText(harness.nodes['quadTr']!).includes('正在载入'), '先渲染时快照还没到，如实显示"正在载入"')

    /* 数据到位（loadEmployeeAside 会把快照写进 state.aside 然后重绘右栏）——这里模拟那次重绘 */
    harness.api.getState()['aside'] = { employeeId: EMPLOYEE.id, skills: [{ name: 'clown-src-6k', valid: true, issues: [] }], skillsError: '' }
    harness.api.renderQuadCells()
    const text = allText(harness.nodes['quadTr']!)
    assert.ok(!text.includes('正在载入'), '快照到位后不许再显示"正在载入"：' + text)
    assert.ok(text.includes('专属技能'), '技能块要在：' + text)
  })

  it('右栏每次重绘都要顺手重画四宫格（那条 bug 的唯一防线就在这一行）', () => {
    /* 这条直接钉 renderEmployeeAside 里的那次调用：技能是异步到的，右栏重绘时
       四宫格右上格必须跟着重画，否则它永远停在「正在载入…」——
       而"永远正在载入"看起来只是"还没好"，不会有人报 bug。 */
    const aside = makeEl('div')
    const nodes: Record<string, FakeEl> = { employeeAside: aside }
    let quadRepaints = 0
    const scope: Record<string, unknown> = {
      document: { createElement: (tag: string): FakeEl => makeEl(tag) },
      el: (tag: string, className?: string, text?: unknown): FakeEl => {
        const node = makeEl(tag)
        if (className) node.className = className
        if (text !== undefined && text !== null) node.textContent = String(text)
        return node
      },
      clear: (node: FakeEl): void => {
        node.children.length = 0
      },
      $: (id: string): FakeEl | null => nodes[id] ?? null,
      renderQuadCells: (): void => void (quadRepaints += 1),
      employeeById: (): unknown => EMPLOYEE,
      availabilityBadge: (): { text: string; kind: string } => ({ text: '在线', kind: 'ok' }),
      positionName: (): string => '渗透测试',
      shortId: (): string => 'emp_qua',
      renderPositionPanels: (): void => undefined,
      asideBlock: (): FakeEl => makeEl('div'),
      appendApprovalBlock: (): number => 0,
      appendSkillBlock: (): void => undefined,
      state: { selectedEmployeeId: EMPLOYEE.id, aside: null },
    }
    const factory = new Function(
      ...Object.keys(scope),
      extractFunction('renderEmployeeAside') + '\nreturn renderEmployeeAside',
    ) as (...args: unknown[]) => () => void
    factory(...Object.values(scope))()
    assert.equal(quadRepaints, 1, '右栏重绘时必须同时重画四宫格右上那格（少了这一行，技能永远停在"正在载入…"）')
    assert.ok(allText(aside).includes('栀子'), '右栏自己该画的还是要画：' + allText(aside))
  })

  it('专属技能折起时：行列表收起，但"有几个有问题"留在标题徽章上', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    harness.api.appendSkillBlock(box, EMPLOYEE, {
      skills: [{ name: 'clown-src-6k', valid: true, issues: [] }, { name: 'report-template', valid: false, issues: ['frontmatter 缺 name'] }],
      skillsError: '',
    }, { fold: true })
    const text = allText(box)
    assert.ok(text.includes('1 个有问题'), '折的是列表，不是问题：' + text)
    assert.ok(!text.includes('clown-src-6k'), '折起时不该列技能名（四宫格那格只有 1/4 屏）')
    const titles = findAll(box, 'aside-title')
    assert.equal(titles.length, 1, '技能块只有一个标题行')
    assert.ok(
      titles[0]?.classList.contains('aside-title-fold') === true,
      '标题行要带折叠标记（整行可点，右侧一个箭头交代状态）',
    )
    assert.ok(collect(box, (el) => el.className.includes('fold-chev')).length === 1, '折叠箭头要在标题行上')
    /* 键盘可达：折叠行是 div，只挂 onclick 的话键盘用户按不动它 —— 而它是"看技能清单"的唯一入口 */
    const head = titles[0]
    assert.equal(head?.getAttribute('aria-expanded'), 'false', '折叠状态要写在 aria-expanded 上')
    head?.onkeydown?.({ key: 'Enter', preventDefault: () => undefined } as never)
    assert.equal((harness.api.getState()['quad'] as { skillsOpen: boolean }).skillsOpen, true, 'Enter 应当展开技能清单')
    head?.onkeydown?.({ key: ' ', preventDefault: () => undefined } as never)
    assert.equal((harness.api.getState()['quad'] as { skillsOpen: boolean }).skillsOpen, false, '空格应当收起（两个键都要能用）')
  })
})
