/**
 * 皮肤与主题 —— 令牌完整性 + 两处**互不相干**的开关。
 *
 * 这一组钉的是边界，因为这里犯错的代价是"改了不该改的地方"：
 *
 *   1. **平台只有两套主题**（日间 / 夜间），由顶部主题按钮切换；
 *   2. **作业室（黑底霓虹）是页面级皮肤**，只挂在岗位外壳 layout:'quad' 那一页上
 *      （`.skin-neon` 挂在页面容器，令牌在子树里重声明）—— 办公区、审批、体检、秘书页
 *      不该被牵连。所以有两条断言专门盯着"作业室不许跑到 data-theme 上去"。
 *   3. **令牌必须成套**：少写一个变量就是"某处在那套皮肤里看不见"，而且不报错 ——
 *      这是这类改动最典型的死法，所以逐个比变量名。
 *
 * 行为测试沿用仓库既有做法：从**交付脚本**里抠出真源码，配替身跑。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderControlUiScript } from '../src/web/ui.ts'
import { CSS_SOURCE } from './console-source.ts'

const SCRIPT = renderControlUiScript()

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

/** 取某个选择器的声明块（按花括号配对，不按固定缩进）。 */
function blockOf(css: string, selector: string): string {
  const at = css.indexOf(selector)
  assert.ok(at >= 0, `样式表里找不到 ${selector}`)
  let depth = 0
  for (let index = css.indexOf('{', at); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(css.indexOf('{', at) + 1, index)
    }
  }
  throw new Error(`${selector} 的花括号没有配对`)
}

/** 声明块里的自定义属性名（--xxx）。 */
function varNames(block: string): string[] {
  return [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string).sort()
}

describe('皮肤与主题：令牌完整性', () => {
  it('日间与夜间的令牌集合完全一致（少一个 = 那套主题里某处看不见，且不报错）', () => {
    const css = styleSheet()
    const light = varNames(blockOf(css, ':root, [data-theme="light"]'))
    const dark = varNames(blockOf(css, '[data-theme="dark"]'))
    assert.ok(light.length >= 25, '日间那套令牌太少，选择器可能改过：' + String(light.length))
    assert.deepEqual(dark, light, '夜间与日间的令牌集合必须一致')
  })

  it('作业室皮肤的令牌集合与日间一致（页面级皮肤也要成套）', () => {
    const css = styleSheet()
    const light = varNames(blockOf(css, ':root, [data-theme="light"]'))
    const skin = varNames(blockOf(css, '.skin-neon'))
    assert.ok(skin.length >= 25, '.skin-neon 那套令牌太少：' + String(skin.length))
    assert.deepEqual(
      skin,
      light,
      '作业室与日间的令牌集合必须一致；差的就是没适配的：' +
        JSON.stringify(light.filter((name) => !skin.includes(name))),
    )
  })

  it('作业室**不许**挂在 data-theme 上（平台只有日间/夜间两套，免得牵连别的页）', () => {
    const css = styleSheet()
    assert.ok(!/\[data-theme="neon"\]/.test(css), '样式表里不该再有 [data-theme="neon"]：那是"第四套主题"的做法')
    assert.ok(/\.skin-neon\s*\{/.test(css), '作业室应当以 .skin-neon 的形式挂在页面容器上')
    const themeSource = (extractFunction('currentTheme') + extractFunction('applyTheme') + extractFunction('toggleTheme')).replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    assert.ok(!/neon/i.test(themeSource), '全局主题的代码里不该出现 neon（注释里说明"存量值回落"是允许的）：它只属于四宫格那一页')
  })

  it('作业室的外观条条锁在 .skin-neon 子树里（漏一条就会改到别的页面）', () => {
    const css = styleSheet()
    /* 从"形状与质感"那一段的第一条规则开始扫描（不能按注释里的标题找 ——
       注释已经被 styleSheet() 删了，按注释找会静默变成空串，测试就白测了）。
       皮肤段后面可以继续追加其他页面的 CSS，所以只取连续的 .skin-neon 规则，
       不把后续页面的合法样式误当成皮肤泄漏。 */
    const skinAt = css.indexOf('.skin-neon {')
    const section = css.slice(css.indexOf('.skin-neon {', skinAt + 1))
    /* 逗号分组要**逐个**看：只看每组最后一行的话，前面那几条泄漏了也查不出来 */
    const selectors = [...section.matchAll(/([^{}]+)\{/g)]
      .flatMap((match) => (match[1] as string).split(','))
      .map((selector) => selector.trim().split('\n').pop()?.trim() ?? '')
      .filter((selector) => selector !== '' && !selector.startsWith('@'))
    const firstUnscoped = selectors.findIndex((selector) => !selector.includes('.skin-neon'))
    const skinSelectors = firstUnscoped < 0 ? selectors : selectors.slice(0, firstUnscoped)
    assert.ok(skinSelectors.length >= 8, '作业室那段选择器太少，解析可能失效：' + String(skinSelectors.length))
    for (const selector of skinSelectors) {
      assert.ok(selector.includes('.skin-neon'), `这条没锁在 .skin-neon 子树里，会改到别的页面：${selector}`)
    }
    /* 扫描线不能挡点击 —— 挡了整页就点不动了 */
    const scan = section.slice(section.indexOf('::after'))
    assert.ok(/pointer-events:\s*none/.test(scan.slice(0, 400)), '扫描线浮层必须 pointer-events: none')
  })

  it('皮肤开关只在四宫格那一页露出来（别的页面与从前逐像素相同）', () => {
    const css = styleSheet()
    assert.ok(
      /\.quad-cell,\s*\.quad-drawer,\s*\.quad-skin-btn\s*\{\s*display:\s*none;?\s*\}/.test(css),
      '基础规则里必须把皮肤按钮也关掉 —— 否则每个岗位页的顶栏都会多出一个按钮',
    )
  })
})

/* ────────────────────────── 全局主题：两态 ────────────────────────── */

interface ThemeApi {
  currentTheme: () => string
  applyTheme: (theme: string) => void
  toggleTheme: () => void
  htmlTheme: () => string | null
  metaScheme: () => string | null
  buttonText: () => string
  stored: () => string | null
}

function makeThemeHarness(initial?: string): ThemeApi {
  const attrs: Record<string, string> = {}
  const metaAttrs: Record<string, string> = {}
  const button: { textContent: string; title: string } = { textContent: '', title: '' }
  let stored: string | null = initial ?? null
  const scope: Record<string, unknown> = {
    document: {
      documentElement: {
        setAttribute: (key: string, value: string): void => void (attrs[key] = value),
        getAttribute: (key: string): string | null => attrs[key] ?? null,
      },
      querySelector: (selector: string): unknown =>
        selector.includes('color-scheme')
          ? {
              setAttribute: (key: string, value: string): void => void (metaAttrs[key] = value),
              getAttribute: (key: string): string | null => metaAttrs[key] ?? null,
            }
          : null,
    },
    $: (id: string): unknown => (id === 'btnTheme' ? button : null),
    btnTheme: button,
    LS: { theme: 'dse.theme' },
    readLocal: (): string | null => stored,
    writeLocal: (_key: string, value: string): void => void (stored = value === '' ? null : value),
  }
  const source = [extractFunction('currentTheme'), extractFunction('applyTheme'), extractFunction('toggleTheme')].join('\n')
  const factory = new Function(
    ...Object.keys(scope),
    source +
      '\nreturn { currentTheme: currentTheme, applyTheme: applyTheme, toggleTheme: toggleTheme, ' +
      'htmlTheme: function () { return document.documentElement.getAttribute("data-theme") }, ' +
      'metaScheme: function () { return document.querySelector("meta[name=color-scheme]").getAttribute("content") }, ' +
      'buttonText: function () { return btnTheme.textContent }, stored: function () { return readLocal(LS.theme) } }',
  ) as (...args: unknown[]) => ThemeApi
  return factory(...Object.values(scope))
}

describe('全局主题：日间 / 夜间两态', () => {
  it('默认日间；存量 dark 要认；认不出来的值（含历史遗留的 neon）回落日间', () => {
    assert.equal(makeThemeHarness().currentTheme(), 'light', '没存过 → 日间（用户明确要求浅色为默认）')
    assert.equal(makeThemeHarness('dark').currentTheme(), 'dark')
    assert.equal(makeThemeHarness('neon').currentTheme(), 'light', '作业室不是主题：存量值要回落，不留半套')
  })

  it('一个按钮来回切，且永远只在两态之间', () => {
    const harness = makeThemeHarness()
    const seen: string[] = []
    for (let i = 0; i < 4; i += 1) {
      harness.toggleTheme()
      seen.push(harness.htmlTheme() ?? '')
    }
    assert.deepEqual(seen, ['dark', 'light', 'dark', 'light'], '平台只有两套皮肤')
  })

  it('按钮文案"点一下会切到哪边"、color-scheme 跟着走、选择落盘', () => {
    const harness = makeThemeHarness()
    harness.applyTheme('light')
    assert.equal(harness.buttonText(), '🌙 夜间')
    assert.equal(harness.metaScheme(), 'light')
    harness.applyTheme('dark')
    assert.equal(harness.buttonText(), '☀️ 日间')
    assert.equal(harness.metaScheme(), 'dark')
    assert.equal(harness.stored(), 'dark', '换主题要记住（偏好按设备走）')
  })
})

/* ────────────────────────── 四宫格的页面级皮肤 ────────────────────────── */

interface SkinApi {
  applyQuadSkin: (skin: string) => void
  toggleQuadSkin: () => void
  clearQuadSkin: () => void
  hasSkin: () => boolean
  buttonText: () => string
  buttonTitle: () => string
  buttonPressed: () => string
  stored: () => string | null
  skin: () => string
}

function makeSkinHarness(initial?: string): SkinApi {
  const classes = new Set<string>()
  const chat = {
    classList: {
      toggle: (name: string, on: boolean): void => {
        if (on) classes.add(name)
        else classes.delete(name)
      },
      remove: (name: string): void => void classes.delete(name),
      add: (name: string): void => void classes.add(name),
      contains: (name: string): boolean => classes.has(name),
    },
  }
  const button = {
    textContent: '',
    title: '',
    attrs: {} as Record<string, string>,
    setAttribute(key: string, value: string): void {
      button.attrs[key] = value
    },
  }
  let stored: string | null = initial ?? null
  const state = { quad: { employeeId: 'emp_1', skin: 'day' } }
  const scope: Record<string, unknown> = {
    $: (id: string): unknown => (id === 'viewChat' ? chat : id === 'btnQuadSkin' ? button : null),
    /* 返回体里要用这两个替身；new Function 的参数名就是这里注入的名字 */
    viewChat: chat,
    btnQuadSkin: button,
    state,
    QUAD_SKINS: ['day', 'neon'],
    QUAD_SKIN_KEY: 'dse.quadSkin',
    readLocal: (): string | null => stored,
    writeLocal: (_key: string, value: string): void => void (stored = value === '' ? null : value),
  }
  const source = [extractFunction('applyQuadSkin'), extractFunction('toggleQuadSkin'), extractFunction('clearQuadSkin')].join('\n')
  const factory = new Function(
    ...Object.keys(scope),
    source +
      '\nreturn { applyQuadSkin: applyQuadSkin, toggleQuadSkin: toggleQuadSkin, clearQuadSkin: clearQuadSkin, ' +
      'hasSkin: function () { return viewChat.classList.contains("skin-neon") }, ' +
      'buttonText: function () { return btnQuadSkin.textContent }, buttonTitle: function () { return btnQuadSkin.title }, ' +
      'buttonPressed: function () { return btnQuadSkin.attrs["aria-pressed"] }, ' +
      'stored: function () { return readLocal(QUAD_SKIN_KEY) }, skin: function () { return state.quad.skin } }',
  ) as (...args: unknown[]) => SkinApi
  return factory(...Object.values(scope))
}

describe('四宫格：本页皮肤（日间 / 作业室）', () => {
  it('切到作业室：给这一页加类、按钮文案说"点一下会切到哪边"、选择落盘', () => {
    const skin = makeSkinHarness()
    skin.applyQuadSkin('neon')
    assert.equal(skin.hasSkin(), true, '皮肤类要加在页面容器上（令牌在子树里重声明）')
    assert.equal(skin.buttonText(), '☀️ 日间', '在作业室时，按钮要说明会切回日间')
    assert.ok(skin.buttonTitle().includes('只影响这一页'), 'title 要说清它只影响这一页：' + skin.buttonTitle())
    assert.equal(skin.buttonPressed(), 'true', '开关状态要写在 aria-pressed 上')
    assert.equal(skin.stored(), 'neon', '偏好按设备记住')
  })

  it('来回切与退出：翻两次回到日间；离开这一页要把皮肤摘掉', () => {
    const skin = makeSkinHarness()
    skin.toggleQuadSkin()
    assert.equal(skin.hasSkin(), true)
    skin.toggleQuadSkin()
    assert.equal(skin.hasSkin(), false, '再点一次回到日间')
    assert.equal(skin.buttonText(), '🖥️ 作业室')
    skin.applyQuadSkin('neon')
    skin.clearQuadSkin()
    assert.equal(skin.hasSkin(), false, '切到别的同事/别的页时不许带着作战室的样子')
  })

  it('认不出来的值一律当日间（不留半套皮肤）', () => {
    const skin = makeSkinHarness()
    skin.applyQuadSkin('乱写的')
    assert.equal(skin.hasSkin(), false)
    assert.equal(skin.skin(), 'day')
  })
})

/* ────────────────────────── 顺带修掉的一个卡死 ────────────────────────── */

/** loadEmployeeAside 的最小替身环境：只替身 DOM/RPC/岗位目录，被测函数用真源码。 */
function makeAsideHarness(): {
  api: { loadEmployeeAside: () => Promise<void>; setPhase: (phase: string) => void; snapshot: () => { skills: unknown; files: unknown } | null }
  rpcCalls: Array<{ method: string }>
} {
  const rpcCalls: Array<{ method: string }> = []
  const state = { phase: 'connecting', selectedEmployeeId: 'emp_1', aside: null as { skills: unknown; files: unknown } | null }
  const scope: Record<string, unknown> = {
    state,
    employeeById: (): unknown => ({ id: 'emp_1', name: '栀子', position: '' }),
    rpc: (method: string): Promise<unknown> => {
      rpcCalls.push({ method })
      return Promise.resolve(method === 'employee.skills.list' ? { skills: [{ name: 'x', valid: true, issues: [] }] } : { entries: [] })
    },
    renderEmployeeAside: (): void => undefined,
    parseSkillList: (): unknown[] => [],
    pickArray: (): unknown[] => [],
    describeError: (error: unknown): string => String(error),
    positionList: (): unknown[] => [],
    positionPanelsOf: (): string[] => [],
    loadPositions: (): Promise<void> => Promise.resolve(),
    SKILL_PANEL_IDS: ['skill-grid'],
  }
  const source = [extractFunction('loadEmployeeAside')].join('\n')
  const factory = new Function(
    ...Object.keys(scope),
    source +
      '\nreturn { loadEmployeeAside: loadEmployeeAside, setPhase: function (p) { state.phase = p }, snapshot: function () { return state.aside } }',
  ) as (...args: unknown[]) => { loadEmployeeAside: () => Promise<void>; setPhase: (p: string) => void; snapshot: () => { skills: unknown; files: unknown } | null }
  return { api: factory(...Object.values(scope)), rpcCalls }
}

describe('右栏快照的补拉（点工位早于连接就绪时不许永久停在「正在载入…」）', () => {
  it('phase 未就绪时 loadEmployeeAside 只建空快照、不发请求；就绪后要能补上', () => {
    const { api, rpcCalls } = makeAsideHarness()
    api.setPhase('connecting')
    api.loadEmployeeAside()
    assert.equal(rpcCalls.length, 0, '连接没就绪时不该发请求（它自己会早退）')
    assert.equal(api.snapshot()?.skills, null)

    api.setPhase('ready')
    api.loadEmployeeAside()
    assert.ok(
      rpcCalls.some((call) => call.method === 'employee.skills.list'),
      '就绪后补拉必须真的发出技能请求，否则那两块永远停在「正在载入…」',
    )
    assert.ok(rpcCalls.some((call) => call.method === 'employee.files.list'))
  })

  it('连上时的补拉只在"快照不完整"时触发（不许每次重连都白拉两遍）', () => {
    const source = extractFunction('onHelloOk')
    assert.ok(
      /aside\.skills === null \|\| aside\.files === null/.test(source),
      'onHelloOk 里必须保留那条"快照不完整才补拉"的判断：既修卡死，又不重复拉取',
    )
    assert.ok(/loadEmployeeAside\(\)/.test(source), 'onHelloOk 里要真的调用补拉')
  })
})
