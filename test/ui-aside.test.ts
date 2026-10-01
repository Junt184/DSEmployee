/**
 * 右栏（员工上下文）的中档布局与折叠。
 *
 * 背景（实测驱动，见 docs/05 §13.9）：旧规则只有 640 / 1200 两个断点，
 * **iPad 横屏 1024×768、折叠屏展开 884×1104 落在中间带** —— 那里左栏和右栏都拿不到，
 * 退回单栏，等于"比手机宽一倍却和手机一样"。现在中档补两栏（对话 + 右栏），
 * 左会话列表仍走抽屉；右栏在各档都能折叠，偏好按设备存。
 *
 * 两类断言：
 *   · 结构（CSS 契约）：中档真的是两栏、折叠规则两档都在、按钮窄屏藏起来；
 *   · 行为（真源码）：把交付脚本里的折叠函数抠出来，配假 DOM/localStorage 跑一遍 ——
 *     切类、写存档、aria 状态、往返切换都要对。复刻逻辑测不了这些。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import path from 'node:path'

import { renderControlUi, renderControlUiScript } from '../src/web/ui.ts'

/* 样式拆到 src/web/css.ts 之后，断言 CSS 的都读它 */
const CSS_SOURCE = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'css.ts'), 'utf8')
const SCRIPT = renderControlUiScript()

function styleSheet(): string {
  assert.ok(CSS_SOURCE.includes('CONTROL_UI_CSS'))
  return CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')
}

interface AtRule {
  query: string
  body: string
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
    media.push({ query: css.slice(at, open).replace('@media', '').trim(), body: css.slice(open + 1, cursor) })
    index = cursor + 1
  }
  return media
}

/** 选择器**完全相等**的规则体（不能只用 indexOf：`.a .b{` 里含 `.b{`）。 */
function ruleBody(css: string, selector: string): string | undefined {
  const wanted = selector.replace(/\s*\{$/, '').trim()
  for (const chunk of css.split('}')) {
    const open = chunk.indexOf('{')
    if (open < 0) continue
    const head = chunk.slice(0, open)
    const lastBreak = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(';'))
    if (head.slice(lastBreak + 1).trim() !== wanted) continue
    return chunk.slice(open + 1)
  }
  return undefined
}

function declaration(body: string, property: string): string | undefined {
  for (const chunk of body.split(';')) {
    const trimmed = chunk.trim()
    if (trimmed.startsWith(`${property}:`)) return trimmed.slice(property.length + 1).trim()
  }
  return undefined
}

const CSS = styleSheet()
const MEDIA = splitCss(CSS)
const mid = MEDIA.filter((entry) =>
  entry.query.startsWith('(min-width: 641px) and (max-width: 1199px)'),
)
const wide = MEDIA.filter((entry) => entry.query.startsWith('(min-width: 1200px)'))
const midCss = mid.map((entry) => entry.body).join('\n')
const wideCss = wide.map((entry) => entry.body).join('\n')

describe('中档（641–1199px）：iPad 横屏 / 折叠屏展开也拿得到右栏', () => {
  it('存在这个断点，且 #viewChat 变成两栏网格 —— 但带高度前提（横屏手机不参与）', () => {
    assert.ok(
      mid.every((entry) => entry.query.includes('min-height')),
      '中档两栏必须带高度前提：844×390 这类横屏手机加了右栏会让输入框从 476 掉到 266',
    )
    assert.ok(mid.length > 0, '没有 (min-width: 641px) and (max-width: 1199px) 断点')
    const body = ruleBody(midCss, '#viewChat {')
    assert.ok(body !== undefined, '中档没有 #viewChat 布局规则')
    assert.equal(declaration(body, 'display'), 'grid')
    const columns = String(declaration(body, 'grid-template-columns'))
    assert.equal(columns.split(/\s+(?![^(]*\))/).length, 2, `中档应当是两栏，实际 "${columns}"`)
  })

  it('右栏在中档是显示的（这正是这次要补的缺口）', () => {
    const body = ruleBody(midCss, '#employeeAside {')
    assert.ok(body !== undefined, '中档没有 #employeeAside 规则')
    assert.equal(declaration(body, 'display'), 'flex !important', '右栏在中档必须可见')
    assert.equal(declaration(body, 'grid-area'), 'aside')
  })

  it('左栏在中档**不**常驻（退回抽屉，否则中间列会被挤干）', () => {
    assert.equal(
      ruleBody(midCss, '#sessionPanel {'),
      undefined,
      '中档不该把 #sessionPanel 设成常驻；「会话」按钮要留给抽屉用',
    )
    assert.equal(ruleBody(midCss, '#btnChatSessions {'), undefined, '中档不该把「会话」按钮藏起来')
  })
})

describe('右栏折叠：各档都能收，窄屏不给按钮', () => {
  it('折叠时右栏隐藏（通用规则，不放进媒体查询）', () => {
    const body = ruleBody(CSS, '#viewChat.aside-collapsed > #employeeAside {')
    assert.ok(body !== undefined, '缺少折叠时隐藏右栏的规则')
    assert.equal(declaration(body, 'display'), 'none !important')
  })

  it('两档各自把右栏轨道压成 0（保留 areas，只收轨道）', () => {
    const wideBody = ruleBody(wideCss, '#viewChat.aside-collapsed {')
    assert.ok(wideBody !== undefined, '宽屏缺少折叠后的列定义')
    const wideColumns = String(declaration(wideBody, 'grid-template-columns'))
    assert.ok(wideColumns.trim().endsWith(' 0'), `宽屏折叠后右栏轨道应为 0，实际 "${wideColumns}"`)
    assert.ok(wideColumns.includes('260px'), '宽屏折叠后左栏仍要常驻')

    const midBody = ruleBody(midCss, '#viewChat.aside-collapsed {')
    assert.ok(midBody !== undefined, '中档缺少折叠后的列定义')
    const midColumns = String(declaration(midBody, 'grid-template-columns'))
    assert.equal(midColumns.split(/\s+(?![^(]*\))/).length, 2)
    assert.ok(midColumns.trim().endsWith(' 0'), `中档折叠后应只剩一栏，实际 "${midColumns}"`)
  })

  it('窄屏没有右栏，因此按钮也不出现（不给按了没反应的按钮）', () => {
    const base = ruleBody(CSS, '#btnAside {')
    assert.ok(base !== undefined, '缺少 #btnAside 基础规则')
    assert.equal(declaration(base, 'display'), 'none')
    const shown = MEDIA.filter((entry) => entry.query.startsWith('(min-width: 641px)') && entry.query.includes('min-height'))
      .map((entry) => ruleBody(entry.body, '#btnAside {'))
      .filter((body) => body !== undefined)
    assert.ok(shown.length > 0, '缺少 ≥641px 时显示按钮的规则')
    /* inline-block 而不是 inline-flex：后者会顶掉 button 自带的"内容居中盒"、文字贴顶
       （实测上下偏移 -6.5px）。详见 test/ui-panel.test.ts 的守卫。 */
    assert.equal(declaration(String(shown[0]), 'display'), 'inline-block')
  })

  it('页面里 #btnAside 只出现一次（重复 id 会让 JS 只绑到第一个）', () => {
    const html = renderControlUi({ hubId: 'h', hubName: 'n', scriptUrl: '/ui.js' })
    const occurrences = html.split('id="btnAside"').length - 1
    assert.equal(occurrences, 1, `页面里出现了 ${occurrences} 次 #btnAside`)
  })
})

/** 抠出交付脚本里的函数源码（按花括号配对；这两个函数体内没有字符串花括号）。 */
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
  className: string
  classes: Set<string>
  attrs: Record<string, string>
  title: string
  textContent: string
  setAttribute(name: string, value: string): void
  classList: { toggle(name: string, on: boolean): void; contains(name: string): boolean }
}

function makeElement(): FakeElement {
  const element: FakeElement = {
    className: '',
    classes: new Set<string>(),
    attrs: {},
    title: '',
    textContent: '',
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

function makeAsideHarness() {
  const chat = makeElement()
  const button = makeElement()
  const store = new Map<string, string>()
  const scope = {
    state: { asideVisible: true } as { asideVisible: boolean },
    LS: { aside: 'dse.asideVisible' },
    $: (id: string) => (id === 'viewChat' ? chat : id === 'btnAside' ? button : null),
    readLocal: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    writeLocal: (key: string, value: string) => void store.set(key, value),
  }
  const factory = new Function(
    'scope',
    `with (scope) {
      ${extractFunction('currentAsideVisible')}
      ${extractFunction('syncAsideToggle')}
      ${extractFunction('applyAsideVisible')}
      ${extractFunction('toggleAside')}
      return { currentAsideVisible, syncAsideToggle, applyAsideVisible, toggleAside, state }
    }`,
  ) as (scope: unknown) => {
    currentAsideVisible: () => boolean
    applyAsideVisible: (visible: boolean) => void
    toggleAside: () => void
    state: { asideVisible: boolean }
  }
  const api = factory(scope)
  return { ...api, chat, button, store }
}

describe('折叠行为（跑交付脚本里的真源码）', () => {
  it('默认展开：不挂折叠类，按钮 aria-pressed=true', () => {
    const h = makeAsideHarness()
    h.applyAsideVisible(h.currentAsideVisible())
    assert.equal(h.chat.classes.has('aside-collapsed'), false)
    assert.equal(h.button.attrs['aria-pressed'], 'true')
    assert.equal(h.button.classes.has('primary'), true)
  })

  it('切换一次即收起：挂类 + 写 localStorage + aria 翻转', () => {
    const h = makeAsideHarness()
    h.applyAsideVisible(true)
    h.toggleAside()
    assert.equal(h.state.asideVisible, false)
    assert.equal(h.chat.classes.has('aside-collapsed'), true, '收起时 #viewChat 要挂 aside-collapsed')
    assert.equal(h.store.get('dse.asideVisible'), 'hidden')
    assert.equal(h.button.attrs['aria-pressed'], 'false')
    assert.equal(h.button.classes.has('primary'), false)
  })

  it('再切一次恢复展开（往返不丢状态）', () => {
    const h = makeAsideHarness()
    h.applyAsideVisible(true)
    h.toggleAside()
    h.toggleAside()
    assert.equal(h.state.asideVisible, true)
    assert.equal(h.chat.classes.has('aside-collapsed'), false)
    assert.equal(h.store.get('dse.asideVisible'), 'shown')
  })

  it('刷新后沿用存档（收起过的设备不该自己变回展开）', () => {
    const h = makeAsideHarness()
    h.store.set('dse.asideVisible', 'hidden')
    assert.equal(h.currentAsideVisible(), false)
    h.applyAsideVisible(h.currentAsideVisible())
    assert.equal(h.chat.classes.has('aside-collapsed'), true)
  })

  it('文案必须说清"这是个折叠栏的开关"，且跟着状态改口', () => {
    /* 真实反馈：原来只写「上下文」，用户找了一圈说"没看到收侧边栏的按钮" ——
       它长得像"切到上下文页"，而不像"把这一栏收起来"。 */
    const html = renderControlUi({ hubId: 'h', hubName: 'n', scriptUrl: '/ui.js' })
    assert.ok(
      html.includes('id="btnAside" class="ghost" aria-pressed="false" title="收起右侧的上下文栏">上下文栏折叠</button>'),
      '页面里的初始文案应当是「上下文栏折叠」（脚本没起来之前也该是对的）',
    )
    const h = makeAsideHarness()
    h.applyAsideVisible(true)
    assert.equal(h.button.textContent, '上下文栏折叠', '展开时写"折叠"——那一下点下去确实是收')
    h.toggleAside()
    assert.equal(h.button.textContent, '上下文栏展开', '收起后必须改口，否则按钮在说假话')
    assert.equal(h.button.title, '展开右侧的上下文栏')
    h.toggleAside()
    assert.equal(h.button.textContent, '上下文栏折叠')
  })

  it('四宫格那两页不给死键：右栏恒隐藏，这个开关也必须藏起来', () => {
    /* layout-quad / layout-quad-chat 里 #employeeAside 是 display:none !important，
       按钮点下去不会有任何变化。秘书页早就藏了，这两页原来漏了。
       规则写成"任何 width 都生效"（不放进媒体查询）：641px 以上按钮本来是显示的。 */
    const body = ruleBody(CSS, '#viewChat[class*="layout-"] > .chat-top #btnAside {')
    assert.ok(body !== undefined, '缺少"其他外壳里藏掉上下文开关"的规则')
    assert.equal(declaration(body, 'display'), 'none')
  })
})
