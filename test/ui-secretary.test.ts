/**
 * 秘书页外壳（岗位 `layout: 'secretary'`）—— 结构契约 + 真实行为。
 *
 * 这一页的设计稿在 design/秘书页-设计稿.md，测试钉的是稿子里**最容易被做错的三件事**：
 *
 *   1. **只换外壳、不复制对话页**：气泡区、输入区、附件、会话抽屉仍然是原来那几个元素，
 *      这里只重新排它们的位置。所以断言是"#viewChat 里还是那些 id"+"外壳元素只在
 *      layout-secretary 时显示"，而不是"另有一套消息列表"。
 *   2. **别的岗位这一页逐像素不变**：外壳元素默认 `display: none`，只有
 *      `#viewChat.layout-secretary` 才打开 —— 否则办公区里点开任何同事都会看到立绘。
 *   3. **看板是覆盖式「上次结论」**：她没写过就是空白（如实说明），文件里没有时间戳
 *      要**照实说没有**（本项目最防"看起来没问题的旧数据"）。
 *
 * 行为测试沿用仓库既有做法：从**交付脚本**里抠出真源码，配替身跑。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import vm from 'node:vm'

import { renderControlUi, renderControlUiScript } from '../src/web/ui.ts'

const SCRIPT = renderControlUiScript()
const MARKUP = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'markup.ts'), 'utf8')
const CSS = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'css.ts'), 'utf8')
const PAGE = renderControlUi({ hubId: 'hub-test', hubName: '测试 Hub', scriptUrl: '/ui.js' })

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

interface FakeEl {
  tag: string
  className: string
  textContent: string
  title: string
  value: string
  focused: boolean
  children: FakeEl[]
  attrs: Record<string, string>
  style: Record<string, string>
  classList: { add: (c: string) => void; remove: (c: string) => void; toggle: (c: string, on: boolean) => void; contains: (c: string) => boolean }
  /** 图片加载失败的回调（renderStageArt 用它降级成占位剪影） */
  onerror?: () => void
  onload?: () => void
  onclick?: () => void
  appendChild: (child: FakeEl) => void
  setAttribute: (key: string, value: string) => void
  /** 元素事件（输入框的 focus/keydown/input 走这里） */
  addEventListener: (type: string, fn: () => void) => void
  /** 测试里手动触发某个事件 */
  fire: (type: string) => void
  focus: () => void
  setSelectionRange: (start: number, end: number) => void
}

function makeEl(tag: string): FakeEl {
  const classes = new Set<string>()
  const handlers: Record<string, Array<() => void>> = {}
  const node: FakeEl = {
    tag,
    className: '',
    textContent: '',
    title: '',
    value: '',
    focused: false,
    children: [],
    attrs: {},
    style: {},
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
    addEventListener: (type: string, fn: () => void): void => {
      handlers[type] = (handlers[type] ?? []).concat(fn)
    },
    fire: (type: string): void => {
      for (const fn of handlers[type] ?? []) fn()
    },
    focus: (): void => {
      node.focused = true
    },
    setSelectionRange: (): void => undefined,
  }
  return node
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

/** 被测函数对外的形状（显式写出来，测试里调用才有类型；替身内部仍是动态的） */
interface SecretaryApi {
  positionLayoutOf: (employee: unknown) => string
  applyPositionShell: (employee: unknown) => void
  parseConclusion: (raw: string) => { stamp: string; text: string }
  loadConclusion: (employeeId: string) => Promise<void>
  renderBoard: () => void
  openBoard: () => void
  resumeBoardConversation: (seed: string) => void
  renderStageArt: (frame?: string) => void
  setStageState: (state: string) => void
  stopStageRevert: () => void
  /** 立绘与真实的联动入口（65-chat 在回合起止/开始吐字时调） */
  stageTurn: (running: boolean) => void
  stageSpeaking: () => void
  stageStandby: () => void
  stageTouch: () => void
  setSecretaryKeyboardOpen: (open: boolean, narrowOverride?: boolean) => boolean
  hasStandbyTimer: () => boolean
  bindSecretaryUi: () => void
  stageAssetUrl: (file: string) => string
  getStageFrame: () => string
  hasRevertTimer: () => boolean
  closeBoard: () => void
  toggleBoard: () => void
  updateBoardDot: (dot?: FakeEl) => void
  conclusionAgeDays: () => number | null
  getState: () => Record<string, unknown>
}

interface Harness {
  api: SecretaryApi
  nodes: Record<string, FakeEl>
  rpcCalls: Array<{ method: string; params: Record<string, unknown> }>
  runTimers: () => void
}

/** 把秘书页那一段的真源码跑起来，只替身掉 DOM 与 RPC。 */
function makeHarness(
  options: {
    files?: Record<string, string>
    positions?: unknown[]
    employee?: Record<string, unknown>
    failCode?: string
    failMessage?: string
    narrow?: boolean
  } = {},
): Harness {
  const nodes: Record<string, FakeEl> = {
    viewChat: makeEl('section'),
    secretaryStage: makeEl('div'),
    stageArt: makeEl('div'),
    stageName: makeEl('span'),
    stageState: makeEl('span'),
    btnBoard: makeEl('button'),
    boardDot: makeEl('span'),
    boardSheet: makeEl('div'),
    boardMeta: makeEl('span'),
    boardBody: makeEl('div'),
    boardLabel: makeEl('span'),
    boardAuthor: makeEl('span'),
    boardSignature: makeEl('strong'),
    btnBoardClose: makeEl('button'),
    btnBoardResume: makeEl('button'),
    btnBoardFollowup: makeEl('button'),
    promptInput: makeEl('textarea'),
  }
  nodes['boardSheet']?.classList.add('hidden')
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  const stored = new Map<string, string>()
  const timers: Array<{ id: number; fn: () => void; ms: number }> = []
  const employee = options.employee ?? { id: 'emp_sec', name: '秘书', position: 'pos_sec' }

  const scope = {
    document: {
      createElement: (tag: string): FakeEl => makeEl(tag),
      createElementNS: (_ns: string, tag: string): FakeEl => makeEl(tag),
      addEventListener: (): void => undefined,
    },
    /* 定时器替身：只记下来，测试里手动触发（"一次性动作到点回 idle"要能被测到）。
       注意 window.setTimeout 也指到这里 —— 客户端代码两种写法都有。 */
    matchMedia: (query?: string): { matches: boolean } => ({ matches: query?.includes('max-width') === true && options.narrow === true }),
    setTimeout: (fn: () => void, ms: number): number => {
      const id = timers.length + 1
      timers.push({ id, fn, ms })
      return id
    },
    clearTimeout: (id: number): void => {
      const at = timers.findIndex((entry) => entry.id === id)
      if (at >= 0) timers.splice(at, 1)
    },
    requestAnimationFrame: (fn: () => void): void => void fn(),
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
      if (method !== 'employee.files.get') return Promise.resolve({})
      const wanted = String(params['path'] ?? '')
      const content = options.files?.[wanted]
      if (content === undefined) {
        const error = Object.assign(new Error(options.failMessage ?? 'not found'), { code: options.failCode ?? 'not-found' })
        return Promise.reject(error)
      }
      return Promise.resolve({ path: wanted, content })
    },
    describeError: (error: unknown): string => String((error as { code?: string })?.code ?? error),
    readLocal: (key: string): string | null => stored.get(key) ?? null,
    writeLocal: (key: string, value: string): void => void stored.set(key, value),
    /* 替身本身是**测试文件作用域**里的闭包：它只能看到这里的变量，
       看不到 new Function 的参数 —— 所以不能用 el2 这种"参数名"（第一版就栽在这）。 */
    renderMarkdown: (container: FakeEl, text: string): void => {
      const node = makeEl('div')
      node.className = 'md-body'
      node.textContent = text
      container.appendChild(node)
    },
    positionEntryOf: (target: unknown): unknown => {
      if (target === null || typeof target !== 'object') return null
      const id = String((target as { position?: string }).position ?? '')
      return (options.positions ?? []).find((entry) => (entry as { id?: string }).id === id) ?? null
    },
    employeeById: (): unknown => employee,
    /* 当前视图：秘书页的联动只在 state.view === 'chat' 时生效 */
    state: { view: 'chat', selectedEmployeeId: 'emp_sec' },
    CONCLUSION_PATH: 'memory/ref/结论.md',
    CONCLUSION_STALE_DAYS: 7,
  }

  const source = [
    extractFunction('positionLayoutOf'),
    extractFunction('applyPositionShell'),
    extractFunction('setHidden'),
    extractFunction('renderStageArt'),
    extractFunction('stageAssetUrl'),
    extractFunction('stagePrefersStill'),
    extractFunction('stopStageTransition'),
    extractFunction('placeholderArt'),
    extractFunction('stopStageRevert'),
    extractFunction('setStageState'),
    extractFunction('setStageState'),
    extractFunction('loadConclusion'),
    extractFunction('parseConclusion'),
    extractFunction('conclusionAgeDays'),
    extractFunction('renderBoard'),
    extractFunction('updateBoardDot'),
    extractFunction('markBoardSeen'),
    extractFunction('openBoard'),
    extractFunction('closeBoard'),
    extractFunction('toggleBoard'),
    extractFunction('resumeBoardConversation'),
    extractFunction('setSecretaryKeyboardOpen'),
    extractFunction('bindSecretaryUi'),
    /* 立绘与真实的联动（65-chat 在运行时调这几个） */
    extractFunction('stageOnScreen'),
    extractFunction('stopStandbyTimer'),
    extractFunction('stageTouch'),
    extractFunction('stageStandby'),
    extractFunction('stageSpeaking'),
    extractFunction('stageTurn'),
    /* 状态对象与常量：交付脚本里是顶层 var，这里手工带进来（顺序与原文件一致） */
    "var STAGE_NS = 'http://www.w3.org/2000/svg'",
    "var UI_VERSION = 'testver'",
    'var stageFrame = ""',
    'var stageRevertTimer = null',
    'var stageRenderToken = 0',
    'var stageImgNode = null',
    "var stageVisibleSrc = ''",
    'var stageTransitionTimer = null',
    'var STAGE_TRANSITION_MS = 220',
    'var STAGE_STANDBY_MS = 30000',
    'var stageStandbyTimer = null',
    "var STAGE_ANIM = { idle: { file: 'stage-idle.webp', still: 'stage-idle-still.webp', holdMs: 0 }, thinking: { file: 'stage-typing.webp', still: 'stage-typing-still.webp', holdMs: 0 }, speaking: { file: 'stage-typing.webp', still: 'stage-typing-still.webp', holdMs: 0 }, notify: { file: 'stage-notify.webp', still: 'stage-notify-still.webp', holdMs: 1400, then: 'idle' }, standby: { file: 'stage-standby.webp', still: 'stage-standby-still.webp', holdMs: 0 } }",
    "var SECRETARY_LAYOUT = 'secretary'",
    "var CONCLUSION_PATH = 'memory/ref/结论.md'",
    'var CONCLUSION_STAMP_RE = /<!--\\s*更新于\\s*(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}:\\d{2})/',
    'var CONCLUSION_STALE_DAYS = 7',
    'var secretaryState = { employeeId: "", text: null, stamp: "", error: "", missing: false, loaded: false, open: false }',
  ].join('\n')
  const names = Object.keys(scope)
  const factory = new Function(
    ...names,
    source +
      '\nreturn { positionLayoutOf: positionLayoutOf, applyPositionShell: applyPositionShell, parseConclusion: parseConclusion, ' +
      'renderBoard: renderBoard, loadConclusion: loadConclusion, openBoard: openBoard, closeBoard: closeBoard, toggleBoard: toggleBoard, ' +
      'resumeBoardConversation: resumeBoardConversation, ' +
      'renderStageArt: renderStageArt, stageAssetUrl: stageAssetUrl, setStageState: setStageState, stopStageRevert: stopStageRevert, ' +
      'stageTurn: stageTurn, stageSpeaking: stageSpeaking, stageStandby: stageStandby, stageTouch: stageTouch, ' +
      'setSecretaryKeyboardOpen: setSecretaryKeyboardOpen, bindSecretaryUi: bindSecretaryUi, ' +
      'getStageFrame: function () { return stageFrame }, hasRevertTimer: function () { return stageRevertTimer !== null }, ' +
      'hasStandbyTimer: function () { return stageStandbyTimer !== null }, ' +
      'updateBoardDot: updateBoardDot, conclusionAgeDays: conclusionAgeDays, getState: function () { return secretaryState } }',
  ) as (...args: unknown[]) => SecretaryApi

  return {
    api: factory(...Object.values(scope)),
    nodes,
    rpcCalls,
    /** 手动跑掉所有已登记的定时器（替身不真的等时间） */
    runTimers: (): void => {
      const pending = timers.splice(0, timers.length)
      for (const timer of pending) timer.fn()
    },
  }
}

/** 结论文件：首行时间戳 + markdown 正文（她维护的格式） */
function conclusionFile(stamp: string, body: string): string {
  return `<!-- 更新于 ${stamp} -->\n\n${body}\n`
}

describe('外壳默认关闭：别的岗位这一页不许变样', () => {
  it('标记里外壳元素都在，但 CSS 默认全部 display:none', () => {
    for (const id of ['secretaryStage', 'btnBoard', 'boardSheet']) {
      assert.ok(MARKUP.includes(`id="${id}"`), `标记里缺 ${id}`)
    }
    assert.ok(MARKUP.includes('id="btnChatSessions" class="ghost" aria-haspopup="true" aria-expanded="false" aria-controls="sessionPanel"'), '会话按钮缺少下拉菜单无障碍状态')
    assert.ok(/\.secretary-stage, \.board-sheet \{ display: none; \}/.test(CSS), '外壳元素没有默认隐藏')
    assert.ok(/\.board-pull \{ display: none; \}/.test(CSS), '下拉箭头没有默认隐藏')
  })

  it('只有 #viewChat.layout-secretary 才打开两栏外壳', () => {
    assert.ok(/#viewChat\.layout-secretary \{/.test(CSS), '缺少秘书页的网格规则')
    assert.ok(/#viewChat\.layout-secretary > \.secretary-stage \{ grid-area: stage/.test(CSS), '立绘没有进 stage 格')
    assert.ok(/#viewChat\.layout-secretary > \.board-pull \{ grid-area: pull/.test(CSS), '下拉箭头没有进 pull 格')
  })

  it('上次结论是「浅夏递交的纸张简报」：桌面只盖右栏，手机才全屏', () => {
    for (const id of ['boardAuthor', 'boardTitle', 'boardSignature', 'btnBoardResume', 'btnBoardFollowup']) {
      assert.ok(MARKUP.includes(`id="${id}"`), `简报结构缺 ${id}`)
    }
    assert.ok(MARKUP.includes('class="board-paper"'), '结论正文缺少独立纸张容器')
    const desktopAt = CSS.indexOf('@media (min-width: 960px)')
    assert.ok(desktopAt > 0, '缺少秘书简报桌面断点')
    const desktop = CSS.slice(desktopAt, desktopAt + 600)
    assert.ok(/grid-column:\s*2/.test(desktop), '桌面端简报应当只覆盖右侧对话列')
    assert.ok(/grid-row:\s*1 \/ -1/.test(desktop), '桌面端简报应当纵跨右侧整列')
    assert.ok(/\.board-paper \{[^}]*background:\s*#fffdf8/.test(CSS), '简报应当有独立的暖白纸面')
    assert.ok(/\.board-sheet\.open \.board-paper/.test(CSS), '纸面缺少随下拉进入的轻过渡')
  })

  it('网格行数与区域行数一致（实测踩过：少写一行，箭头被撑成 359px 高）', () => {
    const block = CSS.slice(CSS.indexOf('#viewChat.layout-secretary {'), CSS.indexOf('}', CSS.indexOf('#viewChat.layout-secretary {')))
    const areas = /grid-template-areas:\s*((?:"[^"]+"\s*)+)/.exec(block)?.[1] ?? ''
    const areaRows = [...areas.matchAll(/"[^"]+"/g)].length
    const rows = /grid-template-rows:\s*([^;]+);/.exec(block)?.[1] ?? ''
    /* 数轨道要按**括号配对**切，不能按空白切：`minmax(0, 1fr)` 里本身带空格
       （第一版就是按空白切的，于是把 4 行数成 5 个 token 而误报）。 */
    const tokens: string[] = []
    let depth = 0
    let current = ''
    for (const char of rows.trim()) {
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
    assert.equal(tokens.length, areaRows, `区域 ${areaRows} 行，但只写了 ${tokens.length} 条轨道（${rows.trim()}）`)
    assert.equal(tokens.filter((token) => token.includes('1fr')).length, 1, '只允许一条可伸缩轨道（气泡区）')
  })

  it('每一页里的直接子元素都必须有交代（否则会被自动塞进隐含行，把立绘顶掉）', () => {
    /* 实测 BUG：会话抽屉原来写的是「grid-area: unset」，于是它被自动放进第 5 行（隐含行），
       而立绘跨 1–4 行 —— 抽屉每长高一点就把立绘往上顶一点，点「新会话」后一路顶到看不见。
       这条测试把不变量钉死：**#viewChat 的每个直接子元素，要么进格子、要么藏起来、要么脱离文档流**。 */
    /* 取 #viewChat 的**整段**（按 <section> 配对切，不能切到第一个 </section>：
       页面里新加了嵌套的 <section>（四宫格的三个格位）之后，那样切会当场截断，
       这条不变量就悄悄只检查了半页 —— 测试自己也会变成"看起来没问题"的那种坏掉）。 */
    const start = MARKUP.indexOf('id="viewChat"')
    assert.ok(start > 0, '标记里找不到 #viewChat')
    const open = MARKUP.indexOf('>', start) + 1
    let depth = 1
    let cursor = open
    while (cursor < MARKUP.length && depth > 0) {
      const nextOpen = MARKUP.indexOf('<section', cursor)
      const nextClose = MARKUP.indexOf('</section>', cursor)
      if (nextClose < 0) break
      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth += 1
        cursor = nextOpen + 8
        continue
      }
      depth -= 1
      cursor = nextClose + 10
    }
    const body = MARKUP.slice(open, depth === 0 ? cursor - 10 : MARKUP.length)
    /* 直接子元素 = 缩进恰好 4 个空格的标签 */
    const children = [...body.matchAll(/^ {4}<(\w+)[^>]*>/gm)].map((match) => match[0])
    assert.ok(children.length >= 6, '没抓到 #viewChat 的直接子元素，正则要跟着标记改：' + String(children.length))
    /* 不变量对所有**网格外壳**成立（秘书页、四宫格…），所以规则集不只看秘书页：
       只认 layout-secretary 的话，新外壳里的元素会被误判成"没交代"（真实踩过）。 */
    const shellBodies = [...CSS.matchAll(/#viewChat\.layout-[a-z]+[^{]*\{[^}]*\}/g)].map((match) => match[0])
    for (const tag of children) {
      const id = /id="([^"]+)"/.exec(tag)?.[1] ?? ''
      const className = /class="([^"]+)"/.exec(tag)?.[1]?.split(/\s+/)[0] ?? ''
      /* 选择器可能用 id 也可能用类（如 #secretaryStage 的规则写在 .secretary-stage 上），两个都要认 */
      const words = [id === '' ? '' : `#${id}`, className === '' ? '' : `.${className}`].filter((word) => word !== '')
      const mine = shellBodies.filter((rule) => words.some((word) => rule.includes(word)))
      const hidden = mine.some((rule) => /display:\s*none/.test(rule))
      const placed = mine.some((rule) => /grid-area:\s*(?!unset|auto)[a-z-]+/.test(rule))
      /* 脱离文档流的（如 .board-sheet）在任何布局里都不占格子，看基础规则即可 */
      const outOfFlow = words.some((word) => {
        const escaped = word.replace(/[.#]/g, (char) => '\\' + char)
        return new RegExp(`${escaped}\\s*\\{[^}]*position:\\s*(fixed|absolute)`).test(CSS)
      })
      assert.ok(
        hidden || placed || outOfFlow,
        `${words.join(' / ')} 在任何网格外壳里都既没进格子、也没藏起来、也没脱离文档流 —— 它会被自动塞进隐含行（把别的格子顶掉）`,
      )
    }
  })

  it('会话栏是右侧对话上方的独立下拉区：展开时挤压对话，不遮挡气泡和立绘', () => {
    const rule = /#viewChat\.layout-secretary > #sessionPanel \{([^}]*)\}/.exec(CSS)?.[1] ?? ''
    assert.ok(rule !== '', '秘书页里找不到会话栏的规则')
    assert.ok(/grid-area:\s*session/.test(rule), '会话栏应当拥有独立的 session 网格行：' + rule)
    assert.ok(/max-height:\s*min\(30vh, 300px\)/.test(rule), '会话列表要限制高度，不能把对话挤没')
    assert.ok(/overflow-y:\s*auto/.test(rule), '会话过多时应在下拉区内部滚动')
    assert.ok(!/z-index:\s*\d/.test(rule), '独立网格行不应靠 z-index 覆盖消息')
    assert.ok(!/grid-area:\s*unset/.test(CSS.slice(CSS.indexOf('#viewChat.layout-secretary > #sessionPanel'))), '又写回 unset 了')
  })

  it('手机 ≤640px：立绘是独立停靠舞台，不再和输入框共格', () => {
    assert.ok(/#viewChat\.layout-secretary \{[^}]*38fr[^}]*62fr/.test(CSS), '桌面两栏应当是 38/62')
    const secretaryAt = CSS.indexOf('/* ══════════ 秘书页外壳')
    const mobileAt = CSS.indexOf('@media (max-width: 640px),', secretaryAt)
    assert.ok(mobileAt > secretaryAt, '秘书页缺少 ≤640px 手机断点')
    const mobile = CSS.slice(mobileAt, CSS.indexOf('@media (prefers-reduced-motion: reduce)', mobileAt))
    assert.ok(
      /grid-template-areas:\s*"top"\s*"session"\s*"pull"\s*"stage"\s*"messages"\s*"composer"/.test(mobile),
      '手机应当按「顶栏→会话→结论→立绘→消息→输入」排列',
    )
    const stage = /#viewChat\.layout-secretary > \.secretary-stage \{([^}]*)\}/.exec(mobile)?.[1] ?? ''
    assert.ok(/grid-area:\s*stage/.test(stage), '手机立绘必须进入独立 stage 行')
    assert.ok(/height:\s*clamp\(138px, 22dvh, 180px\)/.test(stage), '手机立绘舞台应有克制的固定高度')
    assert.ok(!/grid-area:\s*composer/.test(stage), '立绘不能再和输入框共格')
    assert.ok(/object-fit:\s*cover/.test(mobile), '手机立绘应裁成近景，而不是把完整 2:3 图缩成小人')
    assert.ok(/secretary-keyboard-open > \.secretary-stage \{ height:\s*78px; \}/.test(mobile), '键盘出现时舞台应缩成窄带')
    assert.ok(/#btnNewSession \{ display:\s*none; \}/.test(mobile), '手机顶栏应收起重复的新会话按钮')
    assert.ok(!mobile.includes('linear-gradient(180deg, transparent'), '输入区不应再靠渐变盖住立绘')
  })

  it('641–959px：平板保留轻量两栏，不跟手机一起退化', () => {
    const tabletAt = CSS.indexOf('@media (min-width: 641px) and (max-width: 959px) and (min-height: 500px)')
    assert.ok(tabletAt > 0, '缺少平板秘书页断点')
    const tablet = CSS.slice(tabletAt, CSS.indexOf('@media (max-width: 640px)', tabletAt))
    assert.ok(/grid-template-columns:\s*minmax\(220px, 34fr\) minmax\(0, 66fr\)/.test(tablet), '平板应保持立绘/对话两栏')
    assert.ok(CSS.includes('@media (max-width: 640px), (min-width: 641px) and (max-width: 959px) and (max-height: 499px)'), '横屏矮屏应走手机停靠舞台布局')
  })

  it('呼吸是 CSS 做的（不占素材帧）：4.2s 上下 5px，且在 reduced-motion 下停掉', () => {
    assert.ok(/\.stage-art \.stage-img \{[^}]*animation: stage-breathe/.test(CSS), '立绘没有呼吸动画')
    assert.ok(/@keyframes stage-breathe/.test(CSS), '缺少呼吸关键帧')
    const kf = CSS.slice(CSS.indexOf('@keyframes stage-breathe'))
    assert.ok(kf.includes('translateY(-5px)'), '呼吸幅度应当是 5px（再大就晕，再小看不出）')
    /* 文件里有多个 reduced-motion 块，要取**含看板过渡**的那一个（秘书页自己的） */
    const rmAt = CSS.indexOf('.board-sheet { transition: none; }')
    assert.ok(rmAt > 0, '找不到秘书页的 reduced-motion 块')
    const rm = CSS.slice(CSS.lastIndexOf('@media (prefers-reduced-motion: reduce)', rmAt), rmAt + 400)
    assert.ok(/\.stage-art \.stage-img \{ animation: none; \}/.test(rm), '关掉动效时呼吸没停')
  })

  it('立绘列是白画布：不跟随主题（黑白线稿抠了底在夜间等于看不见）', () => {
    /* 从规则本体切：注释里也提到过 .secretary-stage，不能切到注释 */
    const ruleStart = CSS.lastIndexOf('\n.secretary-stage {')
    const block = CSS.slice(ruleStart, CSS.indexOf('}', ruleStart))
    assert.ok(block.includes('background: #ffffff'), '立绘列应当是白画布（不能用 var(--panel)，夜间会变黑）')
    assert.ok(!block.includes('linear-gradient'), '立绘列不该再用主题渐变（白底会露出边界）')
    /* 数据依据：人物像素 9.3% 近黑、84.4% 近白、0% 有彩度 —— 这是线稿，
       抠掉白底后黑线落在 #161a22 上对比度只有 1.2:1。 */
    assert.ok(CSS.includes('box-shadow: inset -10px 0 18px -14px'), '白画布要有边界感（否则像漏出来的一块白）')
  })

  it('顶栏在秘书页必须留着（返回办公区的按钮在它里面 —— 实测踩过"进得去出不来"）', () => {
    assert.ok(
      !/layout-secretary > \.chat-top \{ grid-area: top; display: none; \}/.test(CSS),
      '秘书页把顶栏隐掉了 —— 返回按钮跟着消失',
    )
    const secretary = CSS.slice(CSS.indexOf('#viewChat.layout-secretary {'))
    assert.ok(/grid-template-areas:\s*"stage top"/.test(secretary), '顶栏应当在秘书页的第一行')
    assert.ok(
      /layout-secretary > \.chat-top #btnAside \{ display: none; \}/.test(CSS),
      '秘书页收起右栏后，"上下文"开关是死键，应当藏起来',
    )
  })

  it('秘书页不吃右栏那一套（右栏信息进全屏看板）', () => {
    assert.ok(/layout-secretary > #employeeAside \{ display: none !important; \}/.test(CSS), '秘书页应当收起右栏')
  })
})

describe('岗位 layout 决定外壳（真实行为）', () => {
  it('layout=secretary → 加上类、显示立绘与箭头；其它 layout → 全部收回', () => {
    const harness = makeHarness({ positions: [{ id: 'pos_sec', name: '秘书', layout: 'secretary' }] })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    assert.equal(harness.nodes['viewChat']?.classList.contains('layout-secretary'), true)
    assert.equal(harness.nodes['secretaryStage']?.classList.contains('hidden'), false)
    assert.equal(harness.nodes['btnBoard']?.classList.contains('hidden'), false)
    assert.equal(harness.nodes['stageName']?.textContent, '秘书')
    assert.equal(harness.nodes['boardAuthor']?.textContent, '秘书')
    assert.equal(harness.nodes['boardSignature']?.textContent, '秘书')

    harness.api.applyPositionShell({ id: 'emp_x', name: '小艾', position: 'pos_other' })
    assert.equal(harness.nodes['viewChat']?.classList.contains('layout-secretary'), false)
    assert.equal(harness.nodes['secretaryStage']?.classList.contains('hidden'), true)
    assert.equal(harness.nodes['btnBoard']?.classList.contains('hidden'), true)
  })

  it('岗位目录里没有 layout（或没绑岗位）→ 默认对话页', () => {
    const bare = makeHarness({ positions: [{ id: 'pos_sec', name: '秘书' }] })
    bare.api.applyPositionShell({ id: 'emp_sec', position: 'pos_sec' })
    assert.equal(bare.nodes['viewChat']?.classList.contains('layout-secretary'), false)

    const unbound = makeHarness({ positions: [{ id: 'pos_sec', layout: 'secretary' }] })
    unbound.api.applyPositionShell({ id: 'emp_sec' })
    assert.equal(unbound.nodes['viewChat']?.classList.contains('layout-secretary'), false)
  })

  it('立绘默认走素材：img 指向 /assets/secretary/… 并带界面指纹（长缓存靠它失效）', () => {
    const harness = makeHarness({ positions: [{ id: 'pos_sec', layout: 'secretary' }] })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    const art = harness.nodes['stageArt'] as FakeEl
    const img = art.children[0] as FakeEl
    assert.equal(img?.tag, 'img', '应当是一张 img（每状态一张完整图）')
    assert.equal(img.attrs['src'], '/assets/secretary/stage-idle.webp?v=testver')
    assert.equal(harness.api.getStageFrame(), 'idle')
  })

  it('状态切换先保留上一帧，下一帧加载完成后再淡入（不出现白闪）', () => {
    const harness = makeHarness({ positions: [{ id: 'pos_sec', layout: 'secretary' }] })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    const idle = (harness.nodes['stageArt'] as FakeEl).children[0] as FakeEl
    idle.onload?.()

    harness.api.setStageState('thinking')
    const art = harness.nodes['stageArt'] as FakeEl
    const next = art.children[0] as FakeEl
    assert.ok(String(art.style.backgroundImage ?? '').includes('stage-idle.webp'), '切换期间应保留上一帧作为背景')
    assert.ok(next.className.includes('stage-img-enter'), '新图应从透明状态开始')

    next.onload?.()
    assert.equal(next.classList.contains('stage-img-ready'), true, '新图加载后应进入可见状态')
    assert.equal(art.classList.contains('is-switching'), true, '淡出计时结束前仍应保留切换标记')
  })

  it('素材缺失/加载失败 → 降级成占位剪影 + 写明缺哪个文件（绝不留破图）', () => {
    const harness = makeHarness({ positions: [{ id: 'pos_sec', layout: 'secretary' }] })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    const art = harness.nodes['stageArt'] as FakeEl
    const img = art.children[0] as FakeEl
    assert.equal(typeof img.onerror, 'function', 'img 必须有 onerror 兜底')
    img.onerror?.()
    assert.equal(art.children[0]?.className, 'stage-placeholder', '失败后应当换成占位剪影')
    assert.ok(allText(art).includes('stage-idle.webp'), '要说清缺的是哪个文件：' + allText(art))
  })

  it('某状态的图还没出 → 退回 idle（不是把人物换成灰剪影）', () => {
    const harness = makeHarness({ positions: [{ id: 'pos_sec', layout: 'secretary' }] })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    harness.api.setStageState('thinking')            // stage-typing.webp 还没出
    const art = harness.nodes['stageArt'] as FakeEl
    const img = art.children[0] as FakeEl
    img.onerror?.()                                   // 浏览器报加载失败
    const after = (harness.nodes['stageArt'] as FakeEl).children[0] as FakeEl
    assert.equal(after.tag, 'img', '应当换回 idle 的图，而不是占位剪影')
    assert.ok(String(after.attrs['src']).includes('stage-idle.webp'), '实际: ' + String(after.attrs['src']))
    assert.ok(allText(harness.nodes['stageArt'] as FakeEl).includes('还没出'), '要说明为什么还是常态')
  })

  it('idle 自己也缺 → 才用占位剪影（并写明缺哪个文件）', () => {
    const harness = makeHarness({ positions: [{ id: 'pos_sec', layout: 'secretary' }] })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    const img = (harness.nodes['stageArt'] as FakeEl).children[0] as FakeEl
    img.onerror?.()
    assert.equal((harness.nodes['stageArt'] as FakeEl).children[0]?.className, 'stage-placeholder')
  })

  it('切状态换图：状态机只要给状态名，CSS/结构都不动', () => {
    const harness = makeHarness({ positions: [{ id: 'pos_sec', layout: 'secretary' }] })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    harness.api.setStageState('thinking')
    let img = (harness.nodes['stageArt'] as FakeEl).children[0] as FakeEl
    assert.equal(harness.api.getStageFrame(), 'thinking')
    assert.ok(harness.nodes['stageState']?.textContent === '正在处理', '状态文字没跟上')
    void img
  })

  it('一次性动作到点自己回 idle（不需要帧里写"回到第一帧"）', () => {
    const harness = makeHarness({ positions: [{ id: 'pos_sec', layout: 'secretary' }] })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    harness.api.setStageState('notify')
    let img = (harness.nodes['stageArt'] as FakeEl).children[0] as FakeEl
    assert.ok(String(img.attrs['src']).includes('stage-notify.webp'), '应当先放一次性动作那一帧：' + String(img.attrs['src']))
    harness.runTimers()
    img = (harness.nodes['stageArt'] as FakeEl).children[0] as FakeEl
    assert.ok(String(img.attrs['src']).includes('stage-idle.webp'), '到点应当回到 idle：' + String(img.attrs['src']))
    assert.equal(harness.api.hasRevertTimer(), false)
  })

  it('切状态会清掉上一个回退定时器（两个动作不许打架）', () => {
    const harness = makeHarness({ positions: [{ id: 'pos_sec', layout: 'secretary' }] })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    harness.api.setStageState('notify')
    assert.equal(harness.api.hasRevertTimer(), true)
    harness.api.setStageState('speaking')
    const img = (harness.nodes['stageArt'] as FakeEl).children[0] as FakeEl
    assert.ok(String(img.attrs['src']).includes('stage-typing.webp'), '输出中应当是"敲笔记本"那一组')
    harness.runTimers()
    assert.ok(
      String(((harness.nodes['stageArt'] as FakeEl).children[0] as FakeEl).attrs['src']).includes('stage-typing.webp'),
      '旧定时器不该把 speaking 顶掉',
    )
  })

  it('待命是"保持住"的姿态：没有回退定时器，到点也不会自己回常态', () => {
    const harness = makeHarness({ positions: [{ id: 'pos_sec', layout: 'secretary' }] })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    harness.api.setStageState('standby')
    assert.equal(harness.api.getStageFrame(), 'standby')
    assert.equal(harness.api.hasRevertTimer(), false, '待命不该有回退定时器')
    assert.equal(harness.nodes['stageState']?.textContent, '待命')
    harness.runTimers()
    assert.equal(harness.api.getStageFrame(), 'standby', '跑掉所有定时器之后她仍然趴着待命')
  })
})

describe('立绘与真实的联动：她什么时候动', () => {
  const sec = { positions: [{ id: 'pos_sec', layout: 'secretary' }] }
  const onPage = (harness: Harness): void => {
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
  }
  /** 让内部的 Promise 链（读结论）跑完 */
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  it('回合开始 → 敲笔记本；开始吐字 → 说话中；回合结束 → 回常态', () => {
    const harness = makeHarness(sec)
    onPage(harness)
    harness.api.stageTurn(true)
    assert.equal(harness.api.getStageFrame(), 'thinking')
    assert.ok(
      String(((harness.nodes['stageArt'] as FakeEl).children[0] as FakeEl).attrs['src']).includes('stage-typing.webp'),
      '回合开始应当是"敲笔记本"那一组',
    )
    harness.api.stageSpeaking()
    assert.equal(harness.api.getStageFrame(), 'speaking')
    assert.equal(harness.nodes['stageState']?.textContent, '说话中')
    harness.api.stageTurn(false)
    assert.equal(harness.api.getStageFrame(), 'idle')
  })

  it('没在秘书页（切到办公区 / 别的岗位）时，一个状态都不许动', () => {
    const harness = makeHarness(sec)
    onPage(harness)
    /* 切走：外壳摘掉 */
    harness.api.applyPositionShell({ id: 'emp_other', name: '小明', position: 'pos_general' })
    harness.api.stageTurn(true)
    harness.api.stageSpeaking()
    harness.api.stageStandby()
    assert.equal(harness.api.getStageFrame(), 'idle', '不在这一页时立绘必须一动不动')
  })

  it('她写完新结论 → 播一次「抬头给你看」，到点自己回常态', async () => {
    const files: Record<string, string> = { 'memory/ref/结论.md': conclusionFile('2026-09-23 09:30', '- 老结论') }
    const harness = makeHarness({ ...sec, files })
    onPage(harness)
    await harness.api.loadConclusion('emp_sec')
    assert.equal(harness.api.getStageFrame(), 'idle')
    /* 她干完活，文件被覆盖成新的一版 */
    files['memory/ref/结论.md'] = conclusionFile('2026-09-23 10:05', '- 新结论')
    harness.api.stageTurn(false)
    await settle()
    assert.equal(harness.api.getStageFrame(), 'notify', '写了新结论就该抬头给用户看')
    harness.runTimers()
    assert.equal(harness.api.getStageFrame(), 'idle', '看过了就回常态')
  })

  it('结论没变 → 不播一次性动作（不能每轮都抬头）', async () => {
    const files: Record<string, string> = { 'memory/ref/结论.md': conclusionFile('2026-09-23 09:30', '- 老结论') }
    const harness = makeHarness({ ...sec, files })
    onPage(harness)
    await harness.api.loadConclusion('emp_sec')
    harness.api.stageTurn(false)
    await settle()
    assert.equal(harness.api.getStageFrame(), 'idle')
  })

  it('进来第一次读到的旧结论不算"她刚写了"（否则一进页面就抬头）', async () => {
    const files: Record<string, string> = { 'memory/ref/结论.md': conclusionFile('2026-09-23 09:30', '- 老结论') }
    const harness = makeHarness({ ...sec, files })
    onPage(harness)
    harness.api.stageTurn(false)
    await settle()
    assert.equal(harness.api.getStageFrame(), 'idle', '这一页还没读过结论时，读到的内容不等于"她刚写了新结论"')
  })

  it('手机点输入框 → 舞台收缩并趴下待命；失焦后舞台恢复', () => {
    const harness = makeHarness({ ...sec, narrow: true })
    onPage(harness)
    harness.api.bindSecretaryUi()
    ;(harness.nodes['promptInput'] as FakeEl).fire('focus')
    assert.equal(harness.nodes['viewChat']?.classList.contains('secretary-keyboard-open'), true)
    assert.equal(harness.api.getStageFrame(), 'standby')
    ;(harness.nodes['promptInput'] as FakeEl).fire('blur')
    assert.equal(harness.nodes['viewChat']?.classList.contains('secretary-keyboard-open'), false)
    harness.api.stageTurn(true)
    assert.equal(harness.api.getStageFrame(), 'thinking', '开始干活就该从待命里起来')
  })

  it('闲着 30 秒 → 自己趴下待命；期间有动作就重新计时', () => {
    const harness = makeHarness(sec)
    onPage(harness)
    /* 进页面就排了一次"闲着就趴下" */
    assert.equal(harness.api.hasStandbyTimer(), true)
    harness.runTimers()
    assert.equal(harness.api.getStageFrame(), 'standby')
    /* 她开始干活 → 计时停掉；干完 → 重新排上 */
    harness.api.stageTurn(true)
    assert.equal(harness.api.hasStandbyTimer(), false, '干活时不该还盯着"她闲不闲"')
    harness.api.stageTurn(false)
    assert.equal(harness.api.hasStandbyTimer(), true, '干完这一轮要重新开始计时')
  })
})

describe('看板 = 覆盖式「上次结论」', () => {
  it('她没写过 → 空白 + 说明去哪儿找（不是"没有内容"这句含糊话）', async () => {
    const harness = makeHarness({ positions: [{ id: 'pos_sec', layout: 'secretary' }] })
    /* 真实流程：进对话页时先 applyPositionShell（它记住当前员工），再读结论 */
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    await harness.api.loadConclusion('emp_sec')
    const text = allText(harness.nodes['boardBody'] as FakeEl)
    assert.ok(text.includes('她还没写过结论'), text)
    assert.ok(text.includes('memory/ref/结论.md'), '要告诉她写到哪个文件')
    assert.equal(harness.nodes['boardDot']?.classList.contains('hidden'), true, '没内容就不该有红点')
  })

  it('写过 → 正文渲染出来、元信息带"更新于 + 几天前"', async () => {
    const today = new Date()
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')} 09:30`
    const harness = makeHarness({
      positions: [{ id: 'pos_sec', layout: 'secretary' }],
      files: { 'memory/ref/结论.md': conclusionFile(stamp, '## 本周\n\n- 三件事') },
    })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    await harness.api.loadConclusion('emp_sec')
    assert.ok(allText(harness.nodes['boardBody'] as FakeEl).includes('三件事'))
    const meta = String(harness.nodes['boardMeta']?.textContent)
    assert.ok(meta.includes(`更新于 ${stamp}`), meta)
    assert.ok(meta.includes('今天'), meta)
  })

  it('文件里没有时间戳 → 照实说"文件里没有更新于"，不假装知道它有多旧', async () => {
    const harness = makeHarness({
      positions: [{ id: 'pos_sec', layout: 'secretary' }],
      files: { 'memory/ref/结论.md': '## 本周\n\n- 三件事\n' },
    })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    await harness.api.loadConclusion('emp_sec')
    const meta = String(harness.nodes['boardMeta']?.textContent)
    assert.ok(meta.includes('没有「更新于」时间戳'), meta)
    assert.ok(allText(harness.nodes['boardBody'] as FakeEl).includes('三件事'), '正文照样要显示')
  })

  it('超过 7 天没更新 → 黄字告警（她忘了写时不许看起来一切正常）', async () => {
    const old = new Date(Date.now() - 10 * 86400000)
    const stamp = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}-${String(old.getDate()).padStart(2, '0')} 09:30`
    const harness = makeHarness({
      positions: [{ id: 'pos_sec', layout: 'secretary' }],
      files: { 'memory/ref/结论.md': conclusionFile(stamp, '- 老结论') },
    })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    await harness.api.loadConclusion('emp_sec')
    const meta = harness.nodes['boardMeta'] as FakeEl
    assert.ok(String(meta.textContent).includes('超过 7 天没更新'), String(meta.textContent))
    assert.equal(meta.className.includes('warn'), true)
  })

  it('文件不存在但错误码不叫 not-found（生产实测：Windows 节点只把 ENOENT 放在 message 里）→ 仍算"还没写过"', async () => {
    const harness = makeHarness({
      positions: [{ id: 'pos_sec', layout: 'secretary' }],
      /* 生产上真见到的那一 shape：code 是别的值，message 里带 ENOENT 与路径 */
      failCode: 'internal',
      failMessage: "ENOENT: no such file or directory, stat 'C:\\Users\\developer\\工作目录\\employees\\测试员工\\memory\\ref\\结论.md'",
    })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    await harness.api.loadConclusion('emp_sec')
    const text = allText(harness.nodes['boardBody'] as FakeEl)
    assert.ok(text.includes('她还没写过结论'), '应当显示"还没写过"，实际：' + text)
    assert.ok(!text.includes('ENOENT'), '不该把 ENOENT 报错甩给用户')
  })

  it('读失败（不是"文件不存在"）→ 如实说读不到，别说成"她还没写过"', async () => {
    const harness = makeHarness({ positions: [{ id: 'pos_sec', layout: 'secretary' }], failCode: 'node-offline' })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    await harness.api.loadConclusion('emp_sec')
    const text = allText(harness.nodes['boardBody'] as FakeEl)
    assert.ok(text.includes('读不到她的结论：node-offline'), text)
    assert.ok(!text.includes('她还没写过'), '读失败不能被说成"还没写过"')
  })

  it('有新结论没看过 → 红点；打开看板后红点消失（且只记在本地）', async () => {
    const today = new Date()
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')} 09:30`
    const harness = makeHarness({
      positions: [{ id: 'pos_sec', layout: 'secretary' }],
      files: { 'memory/ref/结论.md': conclusionFile(stamp, '- 新结论') },
    })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    await harness.api.loadConclusion('emp_sec')
    assert.equal(harness.nodes['boardDot']?.classList.contains('hidden'), false, '有新结论应当有红点')
    harness.api.openBoard()
    assert.equal(harness.nodes['boardDot']?.classList.contains('hidden'), true, '打开过就不该再提醒')
    assert.equal(harness.nodes['boardSheet']?.classList.contains('open'), true)
  })

  it('开/关看板：铺开时 aria-expanded=true，收起后 false', () => {
    const harness = makeHarness({ positions: [{ id: 'pos_sec', layout: 'secretary' }] })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '秘书', position: 'pos_sec' })
    harness.api.toggleBoard()
    assert.equal(harness.nodes['boardSheet']?.classList.contains('open'), true, '看板应当被铺开（靠强制回流触发，不靠 rAF）')
    assert.equal(harness.nodes['btnBoard']?.attrs['aria-expanded'], 'true')
    harness.api.toggleBoard()
    assert.equal(harness.nodes['btnBoard']?.attrs['aria-expanded'], 'false')
  })

  it('围绕结论继续追问：只预填输入框并聚焦，绝不自动发送', () => {
    const harness = makeHarness({ positions: [{ id: 'pos_sec', layout: 'secretary' }] })
    harness.api.applyPositionShell({ id: 'emp_sec', name: '浅夏', position: 'pos_sec' })
    harness.api.bindSecretaryUi()
    harness.api.openBoard()
    harness.api.resumeBoardConversation('基于上次结论，')
    assert.equal(harness.nodes['promptInput']?.value, '基于上次结论，')
    assert.equal(harness.nodes['promptInput']?.focused, true)
    assert.equal(harness.nodes['boardSheet']?.classList.contains('open'), false)
    assert.equal(harness.rpcCalls.some((call) => call.method === 'session.prompt'), false, '这个按钮只预填，不能替用户发送')
  })
})

describe('markdown 标题（秘书页的主要内容就是它）', () => {
  it('渲染器认 # ~ ###，并渲染成 h3~h5（不跟卡片标题 h2 抢层级）', () => {
    const start = SCRIPT.indexOf('function renderMarkdown(')
    const body = SCRIPT.slice(start, SCRIPT.indexOf('function clearMessages(', start))
    assert.ok(/var heading = \/\^\(#\{1,3\}\)/.test(body), '渲染器没有标题分支')
    assert.ok(body.includes("'h' + String(level + 2)"), '标题应当渲染成 h3~h5')
  })

  it('配套样式在（缺样式就是"能渲染但看起来还是正文"）', () => {
    for (const cls of ['.md-h {', '.md-h1 {', '.md-h2 {', '.md-h3 {']) {
      assert.ok(CSS.includes(cls), '缺样式 ' + cls)
    }
  })

  it('标题字号克制（正文 12–13px 的气泡里不能出现 20px 的大标题）', () => {
    const sizes = [...CSS.matchAll(/\.md-h[123] \{ font-size: (\d+)px/g)].map((m) => Number(m[1]))
    assert.equal(sizes.length, 3, '三级标题样式不齐：' + JSON.stringify(sizes))
    assert.ok(Math.max(...sizes) <= 16, '标题太大：' + JSON.stringify(sizes))
  })
})

describe('接线：不调 applyPositionShell 就等于没做这一页', () => {
  it('进对话页（selectEmployee）时应用外壳', () => {
    assert.ok(
      SCRIPT.includes('applyPositionShell(employeeById(employeeId))'),
      'selectEmployee 没有应用岗位外壳 —— 配置了秘书页也不会生效',
    )
  })

  it('岗位目录刷新后重新应用（改配置不必重进页面）', () => {
    const start = SCRIPT.indexOf('function loadPositions(')
    const body = SCRIPT.slice(start, SCRIPT.indexOf('function createPosition(', start))
    assert.ok(body.includes('applyPositionShell('), 'loadPositions 没有重新应用外壳')
  })

  it('控件绑定放在 bindEvents（点过工位才会跑的路径都不算）', () => {
    const start = SCRIPT.indexOf('function bindEvents(')
    const body = SCRIPT.slice(start, start + 600)
    assert.ok(body.includes('bindSecretaryUi()'), 'bindEvents 没有绑定秘书页控件')
  })

  it('交付脚本能通过 JS 解析（片段内容里的反引号会截断 String.raw）', () => {
    assert.doesNotThrow(() => new vm.Script(SCRIPT))
  })

  it('整页把外壳元素真的发出去了', () => {
    assert.ok(PAGE.includes('id="secretaryStage"') && PAGE.includes('id="boardSheet"'), '页面里没有秘书页外壳')
  })
})

describe('素材路由服务端（/assets/…）—— 只许读 assets 目录里的图', () => {
  it('路径穿越被挡住（../ 与前缀比较那套经典写法不接受）', () => {
    const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'hub', 'server.ts'), 'utf8')
    const start = source.indexOf("if (url.pathname.startsWith('/assets/'))")
    const body = source.slice(start, source.indexOf("if (url.pathname === '/sw.js')", start))
    assert.ok(start >= 0 && body.length > 200, '找不到 /assets/ 路由')
    assert.ok(body.includes("seg === '..'"), '没有拒绝 .. 段')
    assert.ok(body.includes('assetsRoot + path.sep'), '没有做"解析后仍在前缀内"的校验')
    assert.ok(body.includes("'cache-control': 'public, max-age=31536000, immutable'"), '素材应当长缓存（靠查询串换版本）')
    for (const ext of ['.webp', '.png']) assert.ok(body.includes(`'${ext}'`), '没有认领 ' + ext)
  })
})
