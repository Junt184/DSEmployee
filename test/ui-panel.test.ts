/**
 * 左栏（会话列表）的折叠：与右栏成对，但档位与"藏起来的地方"都不一样。
 *
 * 右栏早就能收（`aside-collapsed`，见 test/ui-aside.test.ts），左栏以前**常驻不可收** ——
 * 1440 屏上它占 220–260px，而"我正跟这个人说话时要不要一直看着会话列表"是每个人
 * 每块屏幕自己的取舍。左栏每次进入页面默认收起，点击展开；右栏保留设备偏好。
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

describe('左栏折叠：CSS 契约', () => {
  it('只收左栏：左轨道压 0，右轨道原样留着', () => {
    const body = ruleBody(wideCss, `${PANEL_COLLAPSED} {`)
    assert.ok(body !== undefined, '宽屏缺少"只收左栏"的列定义')
    const columns = tracks(String(declaration(body, 'grid-template-columns')))
    assert.equal(columns.length, 3, '宽屏仍是三栏栅格（只把左轨道收成 0）')
    assert.equal(columns[0], '0', `左轨道应为 0，实际 "${columns[0]}"`)
    assert.ok(String(columns[2]).includes('340px'), '右栏轨道必须原样保留（收左栏不该动右栏）')
  })

  it('两条轨道都收：组合态必须单独写（否则左栏会留一条 220–260px 的空档）', () => {
    const body = ruleBody(wideCss, `${BOTH_COLLAPSED} {`)
    assert.ok(body !== undefined, '缺少"两栏都收"的组合规则')
    const columns = tracks(String(declaration(body, 'grid-template-columns')))
    assert.deepEqual(columns, ['0', 'minmax(0, 1fr)', '0'], '两栏都收时只剩中间那一列')
  })

  it('组合态的 specificity 必须高过单收 —— 否则两栏都收时左栏收不掉', () => {
    /* 三条规则写的是同一条属性，CSS 只认 specificity（不认书写顺序）。
       数 id / 类 / 属性选择器的个数即可：#viewChat.aside-collapsed 是 (1,1)，
       本页两条依次是 (1,3) 与 (1,4)。 */
    const count = (selector: string): number => {
      const id = (selector.match(/#/g) ?? []).length
      const cls = (selector.match(/\./g) ?? []).length
      const attr = (selector.match(/\[/g) ?? []).length
      return id * 100 + (cls + attr) * 10
    }
    assert.ok(
      count(BOTH_COLLAPSED) > count('#viewChat.aside-collapsed'),
      '组合态必须比"只收右栏"更 specific，否则两栏都收时右栏的规则会赢、左栏收不掉',
    )
    assert.ok(count(PANEL_COLLAPSED) > count('#viewChat.aside-collapsed'))
  })

  it('折叠规则待在 ≥1200px 里 —— 窄屏那条抽屉不能被大屏的存档锁死', () => {
    assert.ok(
      ruleBody(wideCss, `${PANEL_COLLAPSED} > #sessionPanel {`) !== undefined,
      '≥1200px 里缺少"藏掉左栏"的规则',
    )
    assert.equal(
      ruleBody(BASE, `${PANEL_COLLAPSED} > #sessionPanel {`),
      undefined,
      '基础样式里不许有它：中档/窄屏的 #sessionPanel 是「会话」抽屉（靠 .hidden 开关），' +
        '在窄屏生效会让抽屉再也打不开 —— 按钮变死键',
    )
  })

  it('排除别的外壳：秘书页 / 四宫格里的会话带不能被它藏掉', () => {
    /* 用 [class*="layout-"] 一次排除，而不是逐个列举 layout-secretary / layout-quad ——
       以后再加一个 layout-* 外壳，逐条列举那种写法必漏，漏了就是死键。 */
    assert.ok(
      ruleBody(wideCss, `${PANEL_COLLAPSED} > #sessionPanel {`) !== undefined,
      '排除条件必须写在选择器里（本用例的 PANEL_COLLAPSED 自带 :not([class*="layout-"])）',
    )
    assert.ok(
      CSS.includes('#viewChat:not([class*="layout-"]).panel-collapsed.aside-collapsed'),
      '组合态同样要排除别的外壳',
    )
  })

  it('中档没有左栏，因此中档不许出现 panel-collapsed 的列定义', () => {
    assert.equal(
      ruleBody(midCss, `${PANEL_COLLAPSED} {`),
      undefined,
      '中档是"对话 + 右栏"两栏，左栏走抽屉，不该有左栏折叠规则',
    )
    assert.equal(ruleBody(midCss, '#btnPanel {'), undefined, '中档不该把左栏开关显示出来')
  })

  it('左栏开关只在 ≥1200px 出现（与"常驻左栏"存在的档位严格一致）', () => {
    const base = ruleBody(BASE, '#btnPanel {')
    assert.ok(base !== undefined, '缺少 #btnPanel 基础规则')
    assert.equal(declaration(base, 'display'), 'none', '默认藏起来')

    const shown = wide.map((entry) => ruleBody(entry.body, '#btnPanel {')).filter((body) => body !== undefined)
    assert.ok(shown.length > 0, '≥1200px 缺少显示左栏开关的规则')
    /* inline-block 而不是 inline-flex：后者会把 button 自带的"内容居中盒"顶掉、文字贴顶
       （实测上下偏移 -6.5px，与旁边「新会话」差 6.2px）。详见下面那条守卫。 */
    assert.equal(declaration(String(shown[0]), 'display'), 'inline-block')

    /* 别的外壳里左栏不是常驻列，按钮也不该出现 */
    const hiddenInShell = wide
      .map((entry) => ruleBody(entry.body, '#viewChat[class*="layout-"] > .chat-top #btnPanel {'))
      .filter((body) => body !== undefined)
    assert.ok(hiddenInShell.length > 0, '秘书页/四宫格里必须把左栏开关藏掉（不给死键）')
    assert.equal(declaration(String(hiddenInShell[0]), 'display'), 'none')
  })

  it('页面里 #btnPanel 只出现一次（重复 id 会让 JS 只绑到第一个）', () => {
    const html = renderControlUi({ hubId: 'h', hubName: 'n', scriptUrl: '/ui.js' })
    const occurrences = html.split('id="btnPanel"').length - 1
    assert.equal(occurrences, 1, `页面里出现了 ${occurrences} 次 #btnPanel`)
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
      '#btnPanel {',
      '#viewChat.layout-secretary > .chat-top #btnChatSessions {',
      '#viewChat.layout-quad > .chat-top #btnChatSessions {',
      '#viewChat.layout-quad > .chat-top #btnQuadSkin {',
      '#viewChat.layout-quad-chat > .chat-top #btnChatSessions {',
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
  classes: Set<string>
  setAttribute(name: string, value: string): void
  classList: { toggle(name: string, on: boolean): void; contains(name: string): boolean }
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
    classList: {
      toggle(name, on) {
        if (on) element.classes.add(name)
        else element.classes.delete(name)
      },
      contains(name) {
        return element.classes.has(name)
      },
    },
  }
  return element
}

function makePanelHarness() {
  const chat = makeElement()
  const button = makeElement()
  const store = new Map<string, string>()
  const scope = {
    state: { panelVisible: false } as { panelVisible: boolean },
    LS: { panel: 'dse.panelVisible' },
    $: (id: string) => (id === 'viewChat' ? chat : id === 'btnPanel' ? button : null),
    readLocal: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    writeLocal: (key: string, value: string) => void store.set(key, value),
  }
  const factory = new Function(
    'scope',
    `with (scope) {
      ${extractFunction('currentPanelVisible')}
      ${extractFunction('syncPanelToggle')}
      ${extractFunction('applyPanelVisible')}
      ${extractFunction('togglePanel')}
      return { currentPanelVisible, syncPanelToggle, applyPanelVisible, togglePanel, state }
    }`,
  ) as (scope: unknown) => {
    currentPanelVisible: () => boolean
    applyPanelVisible: (visible: boolean) => void
    togglePanel: () => void
    state: { panelVisible: boolean }
  }
  const api = factory(scope)
  return { ...api, chat, button, store }
}

describe('左栏折叠行为（跑交付脚本里的真源码）', () => {
  it('默认收起：挂折叠类，点击后才展开', () => {
    const h = makePanelHarness()
    h.applyPanelVisible(h.currentPanelVisible())
    assert.equal(h.chat.classes.has('panel-collapsed'), true)
    assert.equal(h.button.attrs['aria-pressed'], 'false')
    assert.equal(h.button.classes.has('primary'), false)
    h.togglePanel()
    assert.equal(h.chat.classes.has('panel-collapsed'), false)
    assert.equal(h.button.attrs['aria-pressed'], 'true')
  })

  it('切换一次即收起：挂类 + 写 localStorage + aria 翻转', () => {
    const h = makePanelHarness()
    h.applyPanelVisible(true)
    h.togglePanel()
    assert.equal(h.state.panelVisible, false)
    assert.equal(h.chat.classes.has('panel-collapsed'), true, '收起时 #viewChat 要挂 panel-collapsed')
    assert.equal(h.store.has('dse.panelVisible'), false)
    assert.equal(h.button.attrs['aria-pressed'], 'false')
    assert.equal(h.button.classes.has('primary'), false)
  })

  it('再切一次恢复展开（往返不丢状态）', () => {
    const h = makePanelHarness()
    h.applyPanelVisible(true)
    h.togglePanel()
    h.togglePanel()
    assert.equal(h.state.panelVisible, true)
    assert.equal(h.chat.classes.has('panel-collapsed'), false)
    assert.equal(h.store.has('dse.panelVisible'), false)
  })

  it('刷新后再次收起，旧版展开存档也不能自动打开', () => {
    const previous = makePanelHarness()
    previous.togglePanel()
    assert.equal(previous.currentPanelVisible(), true)
    const h = makePanelHarness()
    h.store.set('dse.panelVisible', 'shown')
    h.applyPanelVisible(h.currentPanelVisible())
    assert.equal(h.currentPanelVisible(), false)
    assert.equal(h.chat.classes.has('panel-collapsed'), true)
  })

  it('左右两栏互不牵连：不同的类、不同的存档键、不同的 state 字段', () => {
    /* 合成一个键/一个类的后果很具体："我只想收左栏"会顺手把右栏也收掉，
       而且换一块屏幕时会一起被带回来 —— 这是最容易图省事写错的一步。 */
    assert.ok(SCRIPT.includes("classList.toggle('panel-collapsed'"), '左栏挂 panel-collapsed')
    assert.ok(SCRIPT.includes("classList.toggle('aside-collapsed'"), '右栏挂 aside-collapsed')
    assert.ok(SCRIPT.includes("panel: 'dse.panelVisible'"), '左栏有自己的存档键')
    assert.ok(SCRIPT.includes("aside: 'dse.asideVisible'"), '右栏的存档键原样保留')
    assert.ok(SCRIPT.includes('panelVisible: false'), '左栏有自己的 state 字段，默认收起')
    assert.ok(SCRIPT.includes('asideVisible: true'), '右栏的 state 字段原样保留')

    const h = makePanelHarness()
    h.togglePanel()
    assert.equal(h.store.has('dse.asideVisible'), false, '收左栏不该去动右栏的存档')
  })

  it('绑定点在"总会执行"的 bindEvents 里，而不是只在点过工位之后', () => {
    /* 右栏当初踩过这个坑（见 90-devices.ts 的注释）：绑在 bindChatUi 里，
       深链/通知直接进聊天页时按钮就是死键。左栏必须绑在同一处。 */
    assert.ok(SCRIPT.includes("$('btnPanel')"), '交付脚本里要有 #btnPanel 的查找')
    assert.ok(/var panelToggle = \$\('btnPanel'\)/.test(SCRIPT), '按 #btnAside 同款写法绑定')
    assert.ok(SCRIPT.includes('panelToggle.onclick = togglePanel'))
  })

  it('文案必须说清"这是个折叠栏的开关"，且跟着状态改口', () => {
    /* 真实反馈：原来只写「会话」，和上面的「会话」抽屉、和"切到某某页"长得一样，
       用户找了一圈说"没看到收侧边栏的按钮"。所以文案里必须有"栏折叠"。 */
    const html = renderControlUi({ hubId: 'h', hubName: 'n', scriptUrl: '/ui.js' })
    assert.ok(
      html.includes('id="btnPanel" class="ghost" aria-pressed="false" title="展开左侧的会话栏">会话栏展开</button>'),
      '页面里的初始文案应当是「会话栏展开」（脚本没起来之前也该是对的）',
    )
    const h = makePanelHarness()
    h.applyPanelVisible(true)
    assert.equal(h.button.textContent, '会话栏折叠', '展开时写"折叠"——那一下点下去确实是收')
    h.togglePanel()
    assert.equal(h.button.textContent, '会话栏展开', '收起后必须改口：动作已经是展开了，还喊"折叠"就是假话')
    assert.equal(h.button.title, '展开左侧的会话栏')
    h.togglePanel()
    assert.equal(h.button.textContent, '会话栏折叠', '再点回来要恢复原文案')
  })
})
