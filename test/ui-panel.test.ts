/**
 * 左栏（会话列表）的折叠：与右栏成对，但档位与"藏起来的地方"都不一样。
 *
 * 右栏早就能收（`aside-collapsed`，见 test/ui-aside.test.ts），左栏以前**常驻不可收** ——
 * 1440 屏上它占 220–260px，而"我正跟这个人说话时要不要一直看着会话列表"是每个人
 * 每块屏幕自己的取舍。这一页补上，并与右栏**完全同款**：一个类 + 一条 localStorage 存档。
 *
 * 三个容易写错、因此逐条钉住的地方：
 *   1. **两条轨道都收**时的组合态必须单独写一条规则。grid-template-columns 是同一条属性，
 *      三条规则靠 specificity 决胜，漏掉组合态的结果是"两个都收了，左栏还留着一条空档"。
 *   2. 折叠规则**必须待在 ≥1200px 里**。中档与窄屏的 #sessionPanel 是顶栏那个「会话」抽屉，
 *      靠 .hidden 开关；若规则在窄屏也生效，"大屏上收了左栏"这个存档会把手机上的抽屉
 *      永久锁死，而按钮还在（死键）。
 *   3. 折叠规则**必须排除别的外壳**（秘书页 / 四宫格）。那几页把 #sessionPanel 重新摆成
 *      一条独立的下拉带，同样是 .hidden 开关；不排除就是同一个死键。
 *
 * 两类断言，与右栏那份一致：
 *   · 结构（CSS 契约）：档位、组合态、媒体查询边界、外壳排除、按钮可见范围；
 *   · 行为（真源码）：把交付脚本里的四个函数抠出来，配假 DOM/localStorage 跑一遍。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import path from 'node:path'

import { renderControlUi, renderControlUiScript } from '../src/web/ui.ts'

const CSS_SOURCE = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'css.ts'), 'utf8')
const SCRIPT = renderControlUiScript()

const LAYOUT_GUARD = ':not([class*="layout-"])'
const PANEL_COLLAPSED = `#viewChat${LAYOUT_GUARD}.panel-collapsed`
const BOTH_COLLAPSED = `#viewChat${LAYOUT_GUARD}.panel-collapsed.aside-collapsed`

function styleSheet(): string {
  assert.ok(CSS_SOURCE.includes('CONTROL_UI_CSS'))
  return CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')
}

interface AtRule {
  query: string
  body: string
  /** 整段（含 `@media ...{...}`）在原文里的区间，用来算"媒体查询之外"的部分 */
  start: number
  end: number
}

function splitCss(css: string): AtRule[] {
  const media: AtRule[] = []
  let index = 0
  while (index < css.length) {
    const at = css.indexOf('@media', index)
    if (at < 0) break
    const open = css.indexOf('{', at)
    let depth = 0
    let cursor = open
    while (cursor < css.length) {
      if (css[cursor] === '{') depth += 1
      else if (css[cursor] === '}') {
        depth -= 1
        if (depth === 0) break
      }
      cursor += 1
    }
    media.push({
      query: css.slice(at, open).replace('@media', '').trim(),
      body: css.slice(open + 1, cursor),
      start: at,
      end: cursor + 1,
    })
    index = cursor + 1
  }
  return media
}

/** 去掉全部 @media 段，只剩"任何档位都生效"的基础样式。 */
function outsideMedia(css: string, media: AtRule[]): string {
  let out = ''
  let cursor = 0
  for (const entry of media) {
    out += css.slice(cursor, entry.start)
    cursor = entry.end
  }
  return out + css.slice(cursor)
}

/** 选择器**完全相等**的规则体（不能只用 indexOf：`.a .b{` 里含 `.b{`）。 */
function ruleBody(css: string, selector: string): string | undefined {
  return allRuleBodies(css, selector)[0]
}

/** 同一个选择器可能出现多次（基础是 display:none、媒体查询里才是显示态），全都要看。 */
function allRuleBodies(css: string, selector: string): string[] {
  const wanted = selector.replace(/\s*\{$/, '').trim()
  const found: string[] = []
  for (const chunk of css.split('}')) {
    const open = chunk.indexOf('{')
    if (open < 0) continue
    const head = chunk.slice(0, open)
    const lastBreak = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(';'))
    if (head.slice(lastBreak + 1).trim() !== wanted) continue
    found.push(chunk.slice(open + 1))
  }
  return found
}

function declaration(body: string, property: string): string | undefined {
  for (const chunk of body.split(';')) {
    const trimmed = chunk.trim()
    if (trimmed.startsWith(`${property}:`)) return trimmed.slice(property.length + 1).trim()
  }
  return undefined
}

/** `grid-template-columns` 的轨道数（跳过 minmax() 里的空格）。 */
function tracks(value: string): string[] {
  return value.split(/\s+(?![^(]*\))/)
}

const CSS = styleSheet()
const MEDIA = splitCss(CSS)
const BASE = outsideMedia(CSS, MEDIA)
const wide = MEDIA.filter((entry) => entry.query.startsWith('(min-width: 1200px)'))
const mid = MEDIA.filter((entry) => entry.query.startsWith('(min-width: 641px) and (max-width: 1199px)'))
const wideCss = wide.map((entry) => entry.body).join('\n')
const midCss = mid.map((entry) => entry.body).join('\n')

describe('员工导航：CSS 契约', () => {
  /* 导航重构后，"左栏折叠"这件事的**宿主**换了：
     以前折叠类是挂在 `#viewChat` 上的（左栏是那一页网格里的一条轨道）；
     现在员工导航属于公共外壳 `#viewChatShell`（窄栏 + 面板 + 工作区），
     折叠类挂在**外壳**上，工作区在展开与收起两种状态下都占第二列。
     于是这一组断的东西整体换了一份 —— 换的是宿主，不是"能不能收"这个契约。 */

  it('宽屏展开：面板占第一列，工作区占第二列', () => {
    const body = ruleBody(wideCss, '#viewChatShell {')
    assert.ok(body !== undefined, '≥1200px 缺少外壳的列定义')
    const columns = tracks(String(declaration(body, 'grid-template-columns')))
    assert.equal(columns.length, 2, '外壳是"导航 + 工作区"两列')
    assert.ok(String(columns[0]).includes('clamp(240px'), `第一列应是常驻面板宽度，实际 "${columns[0]}"`)
    assert.equal(columns[1], 'minmax(0, 1fr)')
  })

  it('宽屏收起：面板轨道压到 52px，工作区仍是第二列（收的是面板，不是整页）', () => {
    const body = ruleBody(wideCss, '#viewChatShell.panel-collapsed {')
    assert.ok(body !== undefined, '≥1200px 缺少"收起面板"的列定义')
    const columns = tracks(String(declaration(body, 'grid-template-columns')))
    assert.deepEqual(columns, ['52px', 'minmax(0, 1fr)'], '收起后第一列收成窄栏宽度')
  })

  it('收起后窄栏必须露出来 —— 这是"还能打开"的唯一入口', () => {
    /* 展开时窄栏是藏着的（面板本身就是导航）；收起时若不把它放出来，
       宽屏上收起一次就再也点不回来了 —— 按钮跟着面板一起消失。 */
    const body = ruleBody(wideCss, '#viewChatShell:not(.panel-collapsed) > .chat-nav-rail {')
    assert.ok(body !== undefined, '缺少"展开时藏窄栏"的规则')
    assert.equal(declaration(body, 'display'), 'none')
    assert.ok(
      ruleBody(wideCss, '#viewChatShell.panel-collapsed > .chat-nav-rail {') === undefined,
      '收起态不该再藏窄栏（那正是要它出现的状态）',
    )
  })

  it('窄栏的宽度在三档里都有定义（收起态 52px、手机 44px）', () => {
    const base = ruleBody(BASE, '#viewChatShell {')
    assert.ok(base !== undefined, '缺少外壳的基础规则')
    assert.equal(declaration(base, 'grid-template-columns'), '52px minmax(0, 1fr)')
    const narrow = MEDIA.filter((entry) => entry.query.startsWith('(max-width: 640px)'))
    assert.ok(narrow.length > 0, '缺少手机档')
    const phone = narrow.map((entry) => ruleBody(entry.body, '#viewChatShell {')).filter((body) => body !== undefined)
    assert.ok(phone.length > 0, '手机档缺少外壳列定义')
    assert.equal(declaration(String(phone[0]), 'grid-template-columns'), '44px minmax(0, 1fr)')
  })

  it('桌面偏好只在宽屏生效：折叠列的规则必须待在 ≥1200px 里', () => {
    /* 中档与窄屏的导航是**抽屉**（靠 .drawer-open + .hidden 开关）。
       若面板列的折叠规则在窄屏也生效，"大屏上收起了面板"这条存档会把抽屉永久锁死，
       而按钮还在 —— 又一个死键。 */
    assert.equal(
      ruleBody(BASE, '#viewChatShell.panel-collapsed {'),
      undefined,
      '基础样式里不许有它：窄屏的导航是抽屉，不是被压成 0 的轨道',
    )
    for (const entry of MEDIA) {
      if (entry.query.startsWith('(min-width: 1200px)')) continue
      assert.equal(
        ruleBody(entry.body, '#viewChatShell.panel-collapsed {'),
        undefined,
        `${entry.query} 里不该有面板列折叠规则`,
      )
    }
  })

  it('导航是四个岗位共用的：折叠规则不许按 layout-* 分叉', () => {
    /* 以前要写 `:not([class*="layout-"])` 把秘书页与四宫格排除掉 ——
       那几页把左栏重摆成了自己的下拉带。现在导航在外壳上、四个岗位共用一份，
       分叉的理由不存在了；折叠规则里再出现 layout-* 就说明又长出第二份实现。 */
    const selectors = [...CSS.matchAll(/([^{}]*\.panel-collapsed[^{}]*)\{/g)]
      .map((match) => String(match[1]).trim())
    assert.ok(selectors.length > 0, '一条折叠规则都没有？')
    for (const selector of selectors) {
      assert.ok(!selector.includes('layout-'), `折叠规则按岗位分叉了：${selector}`)
    }
  })

  it('收起键只有一个（面板标题栏里的 ‹），且两档都能按到', () => {
    const html = renderControlUi({ hubId: 'h', hubName: 'n', scriptUrl: '/ui.js' })
    const occurrences = html.split('id="btnPanel"').length - 1
    assert.equal(occurrences, 1, `页面里出现了 ${occurrences} 次 #btnPanel`)
    assert.ok(
      html.includes('id="btnPanel" class="ghost cs-nav-close"'),
      '收起键应当住在面板标题栏里（cs-nav-close）—— 它同时是宽屏的收起与窄屏的关闭',
    )
    /* 面板里的收起键在两个档位都是同一个动作：宽屏 = 收起常驻面板；窄屏 = 关抽屉。
       所以它**不该**被任何档位藏掉（藏了那个档位就再也收不起导航）。 */
    const scopes = [BASE, ...MEDIA.map((entry) => entry.body)]
    const hidden = scopes.flatMap((scope) => allRuleBodies(scope, '.cs-nav-close {'))
      .map((body) => declaration(body, 'display'))
      .filter((one) => one === 'none')
    assert.equal(hidden.length, 0, '.cs-nav-close 被某个档位藏掉了')
  })

  it('控可见性的 display 必须是 inline-block —— 写成 flex 会让按钮文字贴顶', () => {
    /* 真实反馈："新会话 / 会话 / 上下文 这块的文字不对齐"，量出来是这样（1440px，
       文字行盒中心 − 按钮盒中心，真浏览器量的）：
         display:inline-flex  → 上下偏移 -6.50px   ← 用户说的"上下居上"
         display:inline-block → 上下偏移 -0.34px，与旁边的「新会话」一模一样
       成因：button 的内容默认装在一个 align-items:center 的匿名盒里，作者一给 button 设 flex
       就把那个盒子顶掉了，匿名文字项按 stretch 靠到顶部。
       这条测不了像素（要真浏览器），但能钉住"别再写回 inline-flex"。 */
    const selectors = [
      '#btnAside {',
      '#viewChat.layout-quad > .chat-top #btnQuadSkin {',
      '#viewChat.layout-quad-chat > .chat-top #btnQuadSkin {',
    ]
    for (const selector of selectors) {
      /* 必须分「基础样式」与「各 @media 体内」两处搜：ruleBody 取的是 chunk 里第一个 `{`，
         媒体查询里的规则整段会被算成 @media 那个选择器，直接在全文里搜是找不到的。 */
      const scopes = [BASE, ...MEDIA.map((entry) => entry.body)]
      const bodies = scopes.flatMap((scope) => allRuleBodies(scope, selector))
      assert.ok(bodies.length > 0, `缺少规则 ${selector}`)
      const displays = bodies.map((body) => declaration(body, 'display')).filter((one) => one !== undefined)
      for (const one of displays) {
        assert.ok(
          one !== 'inline-flex' && one !== 'flex',
          `${selector} 的 display 不许是 ${one} —— 那会让按钮文字贴顶（实测差 6.5px）`,
        )
      }
      const shown = displays.filter((one) => one !== 'none')
      assert.ok(shown.length > 0, `${selector} 少了显示态的规则`)
      assert.ok(
        shown.every((one) => one === 'inline-block'),
        `${selector} 显示态的 display 必须是 inline-block，实际 ${shown.join('/')}`,
      )
    }
  })
})

/** 抠出交付脚本里的函数源码（按花括号配对；这几个函数体内没有字符串花括号）。 */
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

interface FakeElement {
  attrs: Record<string, string>
  title: string
  textContent: string
  inert?: boolean
  classes: Set<string>
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
  contains(node: unknown): boolean
  classList: { toggle(name: string, on: boolean): void; contains(name: string): boolean }
  focus(): void
}

function makeElement(): FakeElement {
  const element: FakeElement = {
    attrs: {},
    title: '',
    textContent: '',
    classes: new Set<string>(),
    setAttribute(name, value) {
      element.attrs[name] = value
    },
    removeAttribute(name) {
      delete element.attrs[name]
    },
    getAttribute(name) {
      return element.attrs[name] ?? null
    },
    contains() {
      return false
    },
    classList: {
      toggle(name, on) {
        if (on) element.classes.add(name)
        else element.classes.delete(name)
      },
      contains(name) {
        return element.classes.has(name)
      },
    },
    focus() {},
  }
  return element
}

/**
 * 员工导航的假 DOM：外壳、面板、遮罩、工作区、窄栏 + 三个按钮。
 *
 * `docked` 控制 matchMedia 的答案（宽屏常驻 / 窄屏抽屉），
 * 两个档位的代码路径完全不同，所以两组用例各挑一边。
 */
function makePanelHarness(options: { docked?: boolean } = {}) {
  const shell = makeElement()
  const panel = makeElement()
  const backdrop = makeElement()
  const workspace = makeElement()
  const rail = makeElement()
  const openButton = makeElement()
  const closeButton = makeElement()
  const nodes: Record<string, FakeElement> = {
    viewChatShell: shell, sessionPanel: panel, employeeNavBackdrop: backdrop,
    viewChat: workspace, employeeNavRail: rail, btnChatSessions: openButton, btnPanel: closeButton,
  }
  const store = new Map<string, string>()
  const calls = { loadSessions: 0, loadSessionTree: 0, updateEffectivePreset: 0 }
  const docked = options.docked ?? true
  const scope = {
    state: { panelVisible: true, sessionNavOpen: false, view: 'chat' },
    LS: { panel: 'dse.panelVisible' },
    $: (id: string) => nodes[id] ?? null,
    readLocal: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    writeLocal: (key: string, value: string) => void store.set(key, value),
    window: { matchMedia: () => ({ matches: docked, addEventListener: () => {}, addListener: () => {} }) },
    document: { activeElement: null },
    /* toggleSessionPanel 打开导航时会顺手刷新这些；导航显隐不是它们的职责，
       但"有没有被叫到"要能数出来（见最后一条用例）。 */
    updateEffectivePreset: () => void (calls.updateEffectivePreset += 1),
    loadSessions: () => { calls.loadSessions += 1; return Promise.resolve([]) },
    loadSessionTree: () => void (calls.loadSessionTree += 1),
  }
  /* 断点从交付脚本里**抠出来**，不在测试里复刻一份 —— 复刻的那份迟早与源码分叉，
     而这条断点决定了"常驻"与"抽屉"两条完全不同的代码路径。 */
  const dockQuery = /var CHAT_NAV_DOCK_QUERY = '([^']+)'/.exec(SCRIPT)?.[1]
  assert.ok(dockQuery !== undefined, '交付脚本里找不到 CHAT_NAV_DOCK_QUERY')
  const factory = new Function(
    'scope',
    `with (scope) {
      var CHAT_NAV_DOCK_QUERY = ${JSON.stringify(dockQuery)};
      ${extractFunction('sessionNavDocked')}
      ${extractFunction('currentPanelVisible')}
      ${extractFunction('syncPanelToggle')}
      ${extractFunction('applyPanelVisible')}
      ${extractFunction('closeSessionNavDrawer')}
      ${extractFunction('toggleSessionPanel')}
      return { sessionNavDocked, currentPanelVisible, syncPanelToggle, applyPanelVisible,
        closeSessionNavDrawer, toggleSessionPanel, state }
    }`,
  ) as (scope: unknown) => {
    sessionNavDocked: () => boolean
    currentPanelVisible: () => boolean
    syncPanelToggle: () => void
    applyPanelVisible: (visible: boolean) => void
    closeSessionNavDrawer: () => void
    toggleSessionPanel: (show?: boolean) => void
    state: { panelVisible: boolean; sessionNavOpen: boolean; view: string }
  }
  const api = factory(scope)
  return { ...api, shell, panel, backdrop, workspace, rail, openButton, closeButton, store, calls }
}

describe('员工导航行为（跑交付脚本里的真源码）', () => {
  it('宽屏默认展开：不挂折叠类，面板可见、窄栏藏着', () => {
    const h = makePanelHarness({ docked: true })
    h.applyPanelVisible(h.currentPanelVisible())
    assert.equal(h.shell.classes.has('panel-collapsed'), false)
    assert.equal(h.panel.classes.has('hidden'), false)
    assert.equal(h.openButton.attrs['aria-expanded'], 'true')
    assert.equal(h.closeButton.attrs['aria-expanded'], 'true')
  })

  it('宽屏收起一次：外壳挂上折叠类 + 写存档 + aria 翻转', () => {
    const h = makePanelHarness({ docked: true })
    h.applyPanelVisible(true)
    h.toggleSessionPanel()
    assert.equal(h.shell.classes.has('panel-collapsed'), true)
    assert.equal(h.store.get('dse.panelVisible'), 'hidden')
    assert.equal(h.panel.classes.has('hidden'), true)
    assert.equal(h.openButton.attrs['aria-expanded'], 'false')
    assert.equal(h.closeButton.attrs['aria-expanded'], 'false')
  })

  it('再点一次恢复展开（往返不丢状态）', () => {
    const h = makePanelHarness({ docked: true })
    h.applyPanelVisible(true)
    h.toggleSessionPanel()
    h.toggleSessionPanel()
    assert.equal(h.shell.classes.has('panel-collapsed'), false)
    assert.equal(h.store.get('dse.panelVisible'), 'shown')
    assert.equal(h.panel.classes.has('hidden'), false)
  })

  it('刷新后沿用存档：收起过的设备不该自己变回展开', () => {
    const first = makePanelHarness({ docked: true })
    first.applyPanelVisible(true)
    first.toggleSessionPanel()
    /* 同一份 localStorage 换一个内存态 = 刷新页面 */
    const second = makePanelHarness({ docked: true })
    second.store.set('dse.panelVisible', String(first.store.get('dse.panelVisible')))
    second.applyPanelVisible(second.currentPanelVisible())
    assert.equal(second.currentPanelVisible(), false)
    assert.equal(second.shell.classes.has('panel-collapsed'), true)
  })

  it('窄屏是抽屉：打开只改临时状态，绝不动桌面偏好那份存档', () => {
    const h = makePanelHarness({ docked: false })
    h.applyPanelVisible(true)
    h.toggleSessionPanel()
    assert.equal(h.state.sessionNavOpen, true)
    assert.equal(h.shell.classes.has('drawer-open'), true)
    assert.equal(h.shell.classes.has('panel-collapsed'), false, '窄屏开抽屉不该动折叠类')
    assert.equal(h.store.get('dse.panelVisible'), 'shown', '窄屏开关不许写桌面偏好')
    assert.equal(h.panel.classes.has('hidden'), false)
    assert.equal(h.panel.attrs['role'], 'dialog')
    assert.equal(h.panel.attrs['aria-modal'], 'true')
    assert.equal(h.backdrop.classes.has('hidden'), false, '抽屉要带遮罩')
    assert.equal(h.workspace.inert, true, '抽屉打开时工作区不可交互')
    assert.equal(h.rail.inert, true)
  })

  it('窄屏关闭抽屉：临时状态清掉、遮罩收起、工作区解禁，桌面偏好依然不动', () => {
    const h = makePanelHarness({ docked: false })
    h.toggleSessionPanel()
    h.closeSessionNavDrawer()
    assert.equal(h.state.sessionNavOpen, false)
    assert.equal(h.shell.classes.has('drawer-open'), false)
    assert.equal(h.panel.classes.has('hidden'), true)
    assert.equal(h.backdrop.classes.has('hidden'), true)
    assert.equal(h.workspace.inert, false)
    assert.equal(h.rail.inert, false)
    assert.equal(h.store.has('dse.panelVisible'), false, '全程没有写过桌面偏好')
  })

  it('宽屏收起后窄栏是"还能打开"的那条路：收起态下窄栏不被藏、展开态才藏', () => {
    /* 这条测的是状态机的意图（CSS 负责把它画出来，见上面那组契约）：
       收起 = 面板藏、窄栏露；展开 = 面板露、窄栏藏。 */
    const h = makePanelHarness({ docked: true })
    h.applyPanelVisible(true)
    assert.equal(h.panel.classes.has('hidden'), false)
    h.applyPanelVisible(false)
    assert.equal(h.panel.classes.has('hidden'), true, '收起后常驻面板必须让位')
    assert.equal(h.shell.classes.has('panel-collapsed'), true, '收起态靠这个类把窄栏放出来')
  })

  it('打开导航会顺手刷新会话列表与生效 preset（否则首屏是空的）', () => {
    /* 这三个取数不在这一组的范围里，但"把导航打开却什么都不拉"是真实的空屏事故：
       面板露出来了，里面还是上一轮的旧列表。 */
    const h = makePanelHarness({ docked: true })
    h.applyPanelVisible(false)
    const before = { ...h.calls }
    h.toggleSessionPanel()
    assert.ok(h.calls.loadSessions > before.loadSessions, '打开导航要刷新会话列表')
    assert.ok(h.calls.loadSessionTree > before.loadSessionTree, '打开导航要补拉展开员工的会话')
    assert.ok(h.calls.updateEffectivePreset > before.updateEffectivePreset, '打开导航要重算生效 preset')
  })
})
