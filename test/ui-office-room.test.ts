/**
 * 办公室（全景）：一间会自己动的屋子。
 *
 * 需求原话（第二版）："我看到了你制作的效果，太丑了，太无趣了，太没意思了，先这样改，
 * 一堆头像会到处乱走，然后点击一个头像冒气泡：怎么了老板，然后类似这种话弄上 100 条类似的，
 * 每次点击基本都不一样，先做到这种程度。"
 * 第一版是等距伪 3D 的立体工位，被否掉了（像工程图）——所以那一版的几何测试也一并作废，
 * 这里锁的是**新形态里不能坏的五件事**（其余都是审美，改就是了）：
 *   1. 不丢人：人数 → 档位，超过 50 **一个都不许少**；每个人都得有个头像在场上。
 *   2. 不出屋：走位是脚本按场地尺寸算的，起点与三个绕圈点都必须留在场地内。
 *      一个头像走出屋子，比它站得挤难看一百倍。
 *   3. 点一下有话说：点谁谁冒气泡，台词从 100 条以上的表里取，**连着点不重样**。
 *   4. 刷新不打断：忙闲/未读每几秒变一次，若每次刷新都重建节点，满屋人会一起"卡一下"
 *      （走路的动画全部回到起点）。所以"刷新只改属性、不换节点"要能被证明。
 *   5. 状态是真的：打字=真忙、Zzz=真离线、"!"=真卡住（同一个 deskStallMs 看门狗）、
 *      角标数字=真未读（同一个 state.unread）。**不许编等级/经验/金币来哄人**。
 *
 * 为什么跑 vm 里的真源码而不是替身：这一页的价值全在"与办公区共用同一份数据与同一个入口"上，
 * 替身复刻一份只能证明复刻版对。头像、选人、分组这些**外部**依赖才用替身（它们各自有测试）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import vm from 'node:vm'

import { CHUNK_32_OFFICE_ROOM } from '../src/web/script/32-office-room.ts'
import { renderControlUiScript } from '../src/web/ui.ts'
import { CSS_SOURCE, MARKUP_SOURCE } from './console-source.ts'

const SCRIPT = renderControlUiScript()

/** 从交付脚本里抠出某个函数（按花括号配对，跳过字符串）。 */
function extractFunction(name: string): string {
  const start = SCRIPT.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `交付脚本里找不到 function ${name}(`)
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
  throw new Error(`function ${name} 的花括号没有配对`)
}

/** 交付脚本里那个 3 分钟看门狗阈值（测试与它对齐，而不是自己再写一个数）。 */
const STALL_MS = Number((SCRIPT.match(/var DESK_STALL_MS = (\d+)/) || [])[1])
assert.ok(Number.isFinite(STALL_MS) && STALL_MS > 0, '拿不到 DESK_STALL_MS')

/** 台词表：从交付片段里抠出来（测试要断言"真有 100 条以上、而且不重样"）。 */
const LINES: string[] = [...CHUNK_32_OFFICE_ROOM.matchAll(/'([^'\n]*)',?\n/g)]
  .map((match) => match[1] ?? '')
  .filter((line) => line !== '' && !line.includes(' ') === false ? true : true)
/** 只取 ROOM_LINES = [ … ] 那一段里的字符串。 */
const LINES_POOL: string[] = (() => {
  const start = CHUNK_32_OFFICE_ROOM.indexOf('var ROOM_LINES = [')
  const end = CHUNK_32_OFFICE_ROOM.indexOf(']', start)
  assert.ok(start > 0 && end > start, '交付片段里找不到 ROOM_LINES')
  return [...CHUNK_32_OFFICE_ROOM.slice(start, end).matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '')
})()

const TALK_MS = Number((CHUNK_32_OFFICE_ROOM.match(/var ROOM_TALK_MS = (\d+)/) || [])[1])
assert.ok(Number.isFinite(TALK_MS) && TALK_MS > 0, '拿不到 ROOM_TALK_MS')

/* ══════════ 假 DOM ══════════
 *
 * 只实现这一页真的用到的那部分（appendChild / removeChild / querySelector / 属性 /
 * style.setProperty / onclick / addEventListener）。为什么不用 jsdom：仓库零依赖，
 * 测试也不该为了这一页引进一个。
 */
class FakeStyle {
  readonly values = new Map<string, string>()
  setProperty(name: string, value: string): void {
    this.values.set(name, String(value))
  }
  getPropertyValue(name: string): string {
    return this.values.get(name) ?? ''
  }
}

class FakeNode {
  [key: string]: any

  readonly tagName: string
  readonly children: FakeNode[] = []
  readonly classes = new Set<string>()
  readonly attrs = new Map<string, string>()
  readonly style = new FakeStyle()
  readonly listeners = new Map<string, Array<(event: any) => void>>()
  parentNode: FakeNode | null = null
  clientWidth = 0
  clientHeight = 0
  textValue = ''

  constructor(tagName: string) {
    this.tagName = tagName
  }

  get className(): string {
    return [...this.classes].join(' ')
  }
  set className(value: string) {
    this.classes.clear()
    String(value)
      .split(/\s+/)
      .filter((part) => part !== '')
      .forEach((part) => this.classes.add(part))
  }

  get classList() {
    return {
      add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
      contains: (name: string) => this.classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const on = force === undefined ? !this.classes.has(name) : force
        if (on) this.classes.add(name)
        else this.classes.delete(name)
        return on
      }
    }
  }

  get firstChild(): FakeNode | null {
    const first = this.children[0]
    return first === undefined ? null : first
  }

  get textContent(): string {
    if (this.children.length > 0) return this.children.map((child) => child.textContent).join('')
    return this.textValue
  }
  set textContent(value: string) {
    this.textValue = String(value)
    this.children.length = 0
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value))
  }
  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? (this.attrs.get(name) as string) : null
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }

  appendChild(node: FakeNode): FakeNode {
    /* 与真 DOM 一致：已经在树里的节点是"移动"，不是复制 */
    if (node.parentNode !== null) node.parentNode.removeChild(node)
    this.children.push(node)
    node.parentNode = this
    return node
  }
  removeChild(node: FakeNode): FakeNode {
    const at = this.children.indexOf(node)
    if (at >= 0) this.children.splice(at, 1)
    node.parentNode = null
    return node
  }

  addEventListener(type: string, handler: (event: any) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  dispatch(type: string, event: any = {}): void {
    ;(this.listeners.get(type) ?? []).forEach((handler) => handler(event))
  }

  querySelector(selector: string): FakeNode | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child
      const found = child.querySelector(selector)
      if (found !== null) return found
    }
    return null
  }
  querySelectorAll(selector: string): FakeNode[] {
    const found: FakeNode[] = []
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child)
      found.push(...child.querySelectorAll(selector))
    }
    return found
  }
  private matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.classes.has(selector.slice(1))
    if (selector.startsWith('#')) return this.getAttribute('id') === selector.slice(1)
    return this.tagName === selector
  }
}

class FakeDocument {
  readonly root = new FakeNode('body')
  createElement(tagName: string): FakeNode {
    return new FakeNode(tagName)
  }
  createElementNS(_ns: string, tagName: string): FakeNode {
    return new FakeNode(tagName)
  }
  getElementById(id: string): FakeNode | null {
    return this.root.querySelector(`#${id}`)
  }
}

/** 取列表里的第 index 项（索引访问的结果可能是 undefined，测试里就地断言，别用 `!` 糊过去）。 */
function at<T>(list: T[], index: number): T {
  const value = list[index]
  assert.ok(value !== undefined, `第 ${index} 项不存在（共 ${list.length} 项）`)
  return value
}

/** 取第一个匹配的子孙（找不到就是这一页没画出来，就地报出选择器）。 */
function one(node: FakeNode, selector: string): FakeNode {
  const found = node.querySelector(selector)
  assert.ok(found !== null, `找不到 ${selector}`)
  return found
}

/** 真实时钟的替身：日期固定（天色要能断言），Date.now 可推（模拟"卡住三分钟"）。 */
class FakeDate {
  static nowMs = 1700000000000
  static hour = 10
  static minute = 30
  static now(): number {
    return FakeDate.nowMs
  }
  getHours(): number {
    return FakeDate.hour
  }
}

const PRELUDE = [
  extractFunction('$'),
  extractFunction('el'),
  extractFunction('clear'),
  extractFunction('formatIdleMinutes'),
  extractFunction('availabilityBadge'),
  extractFunction('avatarNode'),
  extractFunction('fillAvatarBox'),
  extractFunction('deskStallMs'),
  `var DESK_STALL_MS = ${STALL_MS}`
].join('\n\n')

const ROOM_SOURCE = `${PRELUDE}\n\n${CHUNK_32_OFFICE_ROOM}`

function employeeOf(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: `同事${id}`, available: true, nodeOnline: true, hasAvatar: false, ...extra }
}

type RoomOptions = {
  employees?: Array<Record<string, unknown>>
  desk?: Record<string, unknown>
  unread?: Record<string, number>
  view?: string
  phase?: string
  stage?: { w: number; h: number }
  selectedEmployeeId?: string
  window?: boolean
}

/** 起一套"真脚本 + 假 DOM"的房间，返回断言要用的把手。 */
function makeRoom(options: RoomOptions = {}) {
  const doc = new FakeDocument()
  const stage = doc.createElement('div')
  stage.setAttribute('id', 'roomRoom')
  stage.clientWidth = options.stage?.w ?? 900
  stage.clientHeight = options.stage?.h ?? 600
  const scene = doc.createElement('div')
  scene.setAttribute('id', 'roomFloor')
  stage.appendChild(scene)
  const summary = doc.createElement('span')
  summary.setAttribute('id', 'roomSummary')
  doc.root.appendChild(stage)
  doc.root.appendChild(summary)

  const employees = (options.employees ?? [employeeOf('a1'), employeeOf('a2')]) as any[]
  const state: any = {
    view: options.view ?? 'officeRoom',
    phase: options.phase ?? 'ready',
    employees,
    desk: options.desk ?? {},
    unread: options.unread ?? {},
    avatars: {},
    selectedEmployeeId: options.selectedEmployeeId ?? ''
  }
  const sections = [{ key: '', name: '默认', members: employees }]
  const selected: string[] = []
  const calls = { ensureAvatar: 0, interval: 0 }
  /* 定时器收在手里（不是立刻执行、也不是永不执行）："点一下冒出来、过一会儿自己收回去"
     这类交互只有真的把回调跑一遍才算验过。 */
  const timers: Array<{ fn: () => void; ms: number } | null> = []
  const pending = () => timers.filter((item) => item !== null).length
  const intervals: Array<() => void> = []
  const windowListeners = new Map<string, Array<() => void>>()

  const context: Record<string, unknown> = {
    state,
    document: doc,
    Date: FakeDate,
    Math,
    Number,
    String,
    Object,
    Array,
    console,
    setTimeout: (fn: () => void, ms?: number) => {
      timers.push({ fn, ms: Number(ms) || 0 })
      return timers.length
    },
    clearTimeout: (handle: unknown) => {
      if (typeof handle === 'number') timers[handle - 1] = null
    },
    setInterval: (fn: () => void) => {
      calls.interval += 1
      intervals.push(fn)
      return calls.interval
    },
    clearInterval: () => {},
    officeSections: () => sections,
    selectEmployee: (id: string) => {
      selected.push(String(id))
      state.selectedEmployeeId = String(id)
    },
    ensureAvatar: () => {
      calls.ensureAvatar += 1
    },
    /* 线稿脸是办公区那边的事（它有自己的一套测试），这里只要一个能认出"是头像"的替身 */
    doodleFaceSvg: () => doc.createElement('svg')
  }
  if (options.window !== false) {
    context.window = {
      addEventListener: (type: string, handler: () => void) => {
        const list = windowListeners.get(type) ?? []
        list.push(handler)
        windowListeners.set(type, list)
      }
    }
  }
  vm.createContext(context)
  vm.runInContext(ROOM_SOURCE, context)

  const call = <T>(name: string, ...args: unknown[]): T => {
    const fn = context[name]
    assert.equal(typeof fn, 'function', `交付脚本里没有 ${name}()`)
    return (fn as (...rest: unknown[]) => T)(...args)
  }
  const view = () => (context as any).roomView

  /** 把攒下的定时器全部跑一遍（跑完清空）。返回跑过的个数。 */
  const runTimers = (): number => {
    const due = timers.splice(0, timers.length)
    let ran = 0
    due.forEach((item) => {
      if (item === null) return
      ran += 1
      item.fn()
    })
    return ran
  }
  const lastTimerMs = (): number => {
    for (let index = timers.length - 1; index >= 0; index -= 1) {
      const item = timers[index]
      if (item !== undefined && item !== null) return item.ms
    }
    return -1
  }
  const resize = (): void => {
    ;(windowListeners.get('resize') ?? []).forEach((handler) => handler())
  }

  return {
    doc,
    stage,
    scene,
    summary,
    state,
    sections,
    selected,
    calls,
    context,
    call,
    view,
    runTimers,
    pending,
    lastTimerMs,
    intervals,
    resize
  }
}

/** 某个节点上的一个样式变量（数值化；单位一律剥掉，'s' 与 'px' 都可能出现）。 */
function cssNumber(node: FakeNode, name: string): number {
  return Number.parseFloat(String(node.style.getPropertyValue(name)))
}

/** 场上的所有人（打头的顺序 = 办公区的排位顺序）。 */
function walkers(scene: FakeNode): FakeNode[] {
  return scene.querySelectorAll('.walker')
}

/** 点一下某个头像（走它自己的 onclick —— 交付脚本挂的就是这个）。 */
function click(node: FakeNode, event: any = {}): void {
  assert.equal(typeof node.onclick, 'function', '这个头像没挂点击行为')
  node.onclick(event)
}

function lineOf(walker: FakeNode): string {
  return one(walker, '.walker-line').textContent
}

function many(count: number): Array<Record<string, unknown>> {
  const list: Array<Record<string, unknown>> = []
  for (let index = 0; index < count; index += 1) list.push(employeeOf(`e${index}`))
  return list
}

const ROOM_CSS_START = '/* ═══ 办公室（全景）'
const SKIN_CSS_START = '/* ══════════ 作业室皮肤：形状与质感'
const ROOM_CSS = (() => {
  const start = CSS_SOURCE.indexOf(ROOM_CSS_START)
  const end = CSS_SOURCE.indexOf(SKIN_CSS_START)
  assert.ok(start >= 0, '样式里找不到全景那一段')
  assert.ok(end > start, '全景那一段没有在作业室皮肤之前结束')
  return CSS_SOURCE.slice(start, end)
})()

const ROOM_MARKUP = (() => {
  const start = MARKUP_SOURCE.indexOf('<section class="col hidden" id="viewOfficeRoom">')
  assert.ok(start >= 0, '标记里找不到全景那一节')
  const end = MARKUP_SOURCE.indexOf('</section>', MARKUP_SOURCE.indexOf('id="roomFloor"'))
  assert.ok(end > start, '全景那一节的收尾没找对')
  return MARKUP_SOURCE.slice(start, end)
})()

/** 取一条规则的内容（按花括号配对，能穿过 @media 这类嵌套）。 */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(selector)
  assert.ok(at >= 0, `样式里找不到 ${selector}`)
  const open = css.indexOf('{', at)
  assert.ok(open > 0, `${selector} 后面没有 {`)
  let depth = 0
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, index)
    }
  }
  throw new Error(`${selector} 的花括号没有配对`)
}

/** CSS 里的声明（"这条规则真的写了这个属性"这样断言，别只断言字符串出现过）。
 *  注释必须先剥掉：注释里为了讲清道理常常会写出属性名，不剥掉就会把注释当成声明。 */
function hasDecl(body: string, property: string, value?: string): boolean {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .some((part) => {
      const colon = part.indexOf(':')
      if (colon < 0) return false
      const name = part.slice(0, colon).trim()
      if (name !== property) return false
      if (value === undefined) return true
      return part.slice(colon + 1).trim().replace(/\s+/g, ' ') === value
    })
}

/** 从 @keyframes 里取某一帧的声明（关键帧里是嵌套块，不能按 ';' 直接切）。 */
function keyframeStep(name: string, step: string): string {
  const frames = ruleBody(ROOM_CSS, `@keyframes ${name}`)
  const at = frames.indexOf(step + ' {')
  assert.ok(at >= 0, `${name} 里没有 ${step} 这一帧`)
  const open = frames.indexOf('{', at)
  const close = frames.indexOf('}', open)
  assert.ok(close > open, `${name} 的 ${step} 帧没有收尾`)
  return frames.slice(open + 1, close)
}

/* ══════════════════ 1. 人数 → 档位与撒点 ══════════════════ */

describe('办公室全景：人数 → 档位与撒点', () => {
  it('10/20/30/40/50 各落一档', () => {
    const cases: Array<[number, string, number]> = [
      [10, 't10', 72],
      [20, 't20', 62],
      [30, 't30', 54],
      [40, 't40', 48],
      [50, 't50', 42]
    ]
    for (const [count, tier, avatar] of cases) {
      const room = makeRoom({ employees: many(count) })
      room.call('renderOfficeRoom')
      assert.equal(room.stage.getAttribute('data-tier'), tier, `${count} 人应当落在 ${tier}`)
      assert.equal(cssNumber(room.stage, '--walker-av'), avatar, `${count} 人的头像尺寸`)
    }
  })

  it('超过 50 人一个都不许少（回落到最密的一档）', () => {
    for (const count of [51, 80, 200]) {
      const room = makeRoom({ employees: many(count) })
      room.call('renderOfficeRoom')
      assert.equal(room.stage.getAttribute('data-tier'), 't50')
      assert.equal(walkers(room.scene).length, count, `${count} 个人里少了人`)
    }
  })

  it('一个人一个头像，位置互不相同', () => {
    const room = makeRoom({ employees: many(24), stage: { w: 1200, h: 700 } })
    room.call('renderOfficeRoom')
    const list = walkers(room.scene)
    assert.equal(list.length, 24)
    const ids = new Set(list.map((walker) => walker.getAttribute('data-emp')))
    assert.equal(ids.size, 24, '有重复的人')
    const xs = new Set(list.map((walker) => walker.style.getPropertyValue('--w-x')))
    assert.ok(xs.size >= 18, `站位太集中了：只有 ${xs.size} 个不同的横坐标`)
  })

  it('起点与三个绕圈点都留在场地内（不会走出屋子）', () => {
    for (const [count, w, h] of [
      [10, 900, 600],
      [50, 1400, 800],
      [30, 360, 260]
    ] as Array<[number, number, number]>) {
      const room = makeRoom({ employees: many(count), stage: { w, h } })
      room.call('renderOfficeRoom')
      const avatar = cssNumber(room.stage, '--walker-av')
      const half = avatar / 2
      for (const walker of walkers(room.scene)) {
        const x = cssNumber(walker, '--w-x')
        const y = cssNumber(walker, '--w-y')
        const points = [
          { x, y },
          { x: x + cssNumber(walker, '--w-1x'), y: y + cssNumber(walker, '--w-1y') },
          { x: x + cssNumber(walker, '--w-2x'), y: y + cssNumber(walker, '--w-2y') },
          { x: x + cssNumber(walker, '--w-3x'), y: y + cssNumber(walker, '--w-3y') }
        ]
        for (const point of points) {
          assert.ok(
            point.x - half >= -0.51 && point.x + half <= w + 0.51,
            `${count} 人 ${w}×${h}：横坐标 ${point.x} 让头像出界了`
          )
          assert.ok(
            point.y - half >= -0.51 && point.y + half <= h + 0.51,
            `${count} 人 ${w}×${h}：纵坐标 ${point.y} 让头像出界了`
          )
        }
      }
    }
  })

  it('同一份数据每次渲染得到同一套走位（刷新不该换个人站你面前）', () => {
    const first = makeRoom({ employees: many(12), stage: { w: 1000, h: 600 } })
    first.call('renderOfficeRoom')
    const second = makeRoom({ employees: many(12), stage: { w: 1000, h: 600 } })
    second.call('renderOfficeRoom')
    const positions = (room: ReturnType<typeof makeRoom>) =>
      walkers(room.scene).map((walker) => `${walker.style.getPropertyValue('--w-x')}|${walker.style.getPropertyValue('--w-y')}`)
    assert.deepEqual(positions(first), positions(second))
  })

  it('场地尺寸变了要重新撒一遍（不然人挤在一角）', () => {
    const room = makeRoom({ employees: many(12), stage: { w: 900, h: 600 } })
    room.call('renderOfficeRoom')
    const before = walkers(room.scene).map((walker) => walker.style.getPropertyValue('--w-x')).join(',')
    room.stage.clientWidth = 1600
    room.stage.clientHeight = 700
    room.call('renderOfficeRoom')
    assert.equal(cssNumber(room.scene, '--room-w'), 1600)
    const after = walkers(room.scene).map((walker) => walker.style.getPropertyValue('--w-x')).join(',')
    assert.notEqual(before, after, '场地变宽了但走位没重排')
  })
})

/* ══════════════════ 2. 走位是动画，不是定时器 ══════════════════ */

describe('办公室全景：走位与动画', () => {
  it('每个人都有自己的速度与相位（不会像仪仗队一样同步）', () => {
    const room = makeRoom({ employees: many(30), stage: { w: 1100, h: 700 } })
    room.call('renderOfficeRoom')
    const durations = new Set<string>()
    for (const walker of walkers(room.scene)) {
      const duration = Number(walker.style.getPropertyValue('--walk-dur').replace('s', ''))
      assert.ok(duration >= 13 && duration <= 31, `一圈 ${duration} 秒不合适（太快像被追，太慢像卡住）`)
      assert.ok(cssNumber(walker, '--walk-delay') <= 0, '相位应当是负的（他已经在路上了）')
      durations.add(String(duration))
    }
    assert.ok(durations.size >= 6, `速度太单一：只有 ${durations.size} 种`)
  })

  it('走位用 translate 的闭环动画，没有定时器在算位置', () => {
    for (const step of ['0%', '25%', '50%', '75%', '100%']) {
      const frame = keyframeStep('walk-loop', step)
      assert.ok(hasDecl(frame, 'translate'), `walk-loop 的 ${step} 帧没有位移`)
    }
    assert.equal(
      keyframeStep('walk-loop', '0%'),
      keyframeStep('walk-loop', '100%'),
      '起点与终点必须重合（否则一圈走完会跳回原点）'
    )
    const middle = keyframeStep('walk-loop', '50%')
    for (const name of ['--w-2x', '--w-2y']) {
      assert.ok(middle.includes(name), `walk-loop 没用到 ${name}`)
    }
    for (const step of ['25%', '75%']) {
      const frame = keyframeStep('walk-loop', step)
      assert.ok(frame.includes('--w-1') || frame.includes('--w-3'), `${step} 没有对应的绕圈点`)
    }
    const frames = ruleBody(ROOM_CSS, '@keyframes walk-loop').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(!/\b(left|top|margin)\s*:/.test(frames), '走路不能动画 left/top（那是主线程上的布局）')
    const walker = ruleBody(ROOM_CSS, '.walker {')
    assert.ok(walker.includes('walk-loop'), '.walker 没有跑 walk-loop')
    assert.ok(walker.includes('infinite'), '走路应当是无限循环')
    assert.ok(hasDecl(walker, 'will-change', 'translate'), '应当提前声明 translate 会被反复动')
    const room = makeRoom({ employees: many(3) })
    room.call('renderOfficeRoom')
    assert.equal(room.calls.interval, 1, '除了"十分钟看一次天色"，这页不该有别的定时器')
  })

  it('起伏与影子跟着走，用的是独立属性（不与走路的 translate 打架）', () => {
    assert.ok(
      hasDecl(keyframeStep('walk-bob', '50%'), 'translate', '0 -5px'),
      '起伏应当在独立的 translate 上'
    )
    const bob = ruleBody(ROOM_CSS, '@keyframes walk-bob').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(!bob.includes('transform'), '用 transform 会和走路的 translate 叠在一起')
    assert.ok(keyframeStep('walk-shadow', '50%').includes('scale'))
  })

  it('动效敏感的人看到的是静止的一屋子（走路也停）', () => {
    const reduce = ROOM_CSS.slice(ROOM_CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    assert.ok(reduce.includes('.walker'), '走路没有列进静止名单')
    assert.ok(reduce.includes('animation: none'), '没有把动画停掉')
    assert.ok(reduce.includes('translate: none'), '没有把位移清掉（否则会停在半路）')
    for (const part of ['.walker-body', '.walker-shadow', '.walker-prop']) {
      assert.ok(reduce.includes(part), `${part} 没被停掉`)
    }
  })
})

/* ══════════════════ 3. 点一下他说句话 ══════════════════ */

describe('办公室全景：点一下他说句话', () => {
  it('台词表 100 条以上，全部不重复、不长到放不进气泡', () => {
    assert.ok(LINES_POOL.length >= 100, `台词只有 ${LINES_POOL.length} 条`)
    assert.equal(new Set(LINES_POOL).size, LINES_POOL.length, '台词里有重复的')
    for (const line of LINES_POOL) {
      assert.ok(line.trim() === line && line !== '', `台词「${line}」两端有空白`)
      assert.ok(line.length <= 20, `台词「${line}」太长（气泡放不下）`)
      assert.ok(!line.includes('`') && !line.includes('${'), `台词「${line}」会破坏模板`)
    }
    assert.equal(LINES_POOL[0], '怎么了老板', '第一句应当是老板要的那句')
    assert.ok(LINES.includes('怎么了老板'))
  })

  it('点一下冒气泡，气泡里是表里的一句真台词', () => {
    const room = makeRoom({ employees: [employeeOf('a1', { name: '阿一' })] })
    room.call('renderOfficeRoom')
    const walker = at(walkers(room.scene), 0)
    assert.equal(walker.getAttribute('data-talk'), null, '初始不该有气泡')
    click(walker)
    assert.equal(walker.getAttribute('data-talk'), '1')
    const line = lineOf(walker)
    assert.ok(LINES_POOL.includes(line), `气泡里出现了表外的台词：「${line}」`)
  })

  it('连着点不会重样（点满一轮能覆盖整张表）', () => {
    const room = makeRoom({ employees: [employeeOf('a1')] })
    room.call('renderOfficeRoom')
    const walker = at(walkers(room.scene), 0)
    const seen: string[] = []
    for (let index = 0; index < LINES_POOL.length; index += 1) {
      click(walker)
      seen.push(lineOf(walker))
    }
    for (let index = 1; index < seen.length; index += 1) {
      assert.notEqual(seen[index], seen[index - 1], `第 ${index + 1} 次和上一次说了同一句`)
    }
    assert.equal(new Set(seen).size, LINES_POOL.length, '连着点一百下没能说遍整张表')
  })

  it('两个人同时点，说的话不一样', () => {
    const room = makeRoom({ employees: many(10) })
    room.call('renderOfficeRoom')
    const said = walkers(room.scene).map((walker) => {
      click(walker)
      return lineOf(walker)
    })
    assert.ok(new Set(said).size >= 8, `十个人说出了 ${new Set(said).size} 种话，撞得太厉害`)
  })

  it('气泡过一会儿自己收回去', () => {
    const room = makeRoom({ employees: [employeeOf('a1')] })
    room.call('renderOfficeRoom')
    const walker = at(walkers(room.scene), 0)
    click(walker)
    assert.equal(room.lastTimerMs(), TALK_MS, '收回去的时间与 ROOM_TALK_MS 不一致')
    assert.equal(room.runTimers(), 1)
    assert.equal(walker.getAttribute('data-talk'), '0', '时间到了气泡还挂着')
  })

  it('连点两次不会留下两个定时器（后一次接管）', () => {
    const room = makeRoom({ employees: [employeeOf('a1')] })
    room.call('renderOfficeRoom')
    const walker = at(walkers(room.scene), 0)
    click(walker)
    click(walker)
    assert.equal(room.pending(), 1, `攒了 ${room.pending()} 个定时器`)
  })

  it('气泡头部写的是这个人此刻的真实姓名与状态', () => {
    const room = makeRoom({
      employees: [employeeOf('a1', { name: '晚晴' })],
      desk: { a1: { busy: true } }
    })
    room.call('renderOfficeRoom')
    const walker = at(walkers(room.scene), 0)
    click(walker)
    assert.equal(one(walker, '.walker-bubble-head').textContent, '晚晴 · 忙碌')
    assert.equal(walker.getAttribute('data-pose'), 'type')
  })

  it('键盘也能让他说话（回车 / 空格），别的键不乱动', () => {
    const room = makeRoom({ employees: [employeeOf('a1')] })
    room.call('renderOfficeRoom')
    const walker = at(walkers(room.scene), 0)
    let prevented = 0
    walker.onkeydown({ key: 'a', preventDefault: () => (prevented += 1) })
    assert.equal(walker.getAttribute('data-talk'), null, '按 a 不该有反应')
    walker.onkeydown({ key: 'Enter', preventDefault: () => (prevented += 1) })
    assert.equal(walker.getAttribute('data-talk'), '1')
    assert.equal(prevented, 1, '回车应当被拦下来（不然页面会滚）')
    walker.onkeydown({ key: ' ', preventDefault: () => (prevented += 1) })
    assert.equal(prevented, 2)
  })

  it('气泡里的「聊两句」真的进对话，而且不顺手再冒一句', () => {
    const room = makeRoom({ employees: [employeeOf('a1')] })
    room.call('renderOfficeRoom')
    const walker = at(walkers(room.scene), 0)
    const talk = one(walker, '.walker-talk')
    assert.equal(talk.getAttribute('type'), 'button', '「聊两句」应当是按钮（键盘点得到）')
    let stopped = 0
    talk.onclick({ stopPropagation: () => (stopped += 1) })
    assert.deepEqual(room.selected, ['a1'])
    assert.equal(stopped, 1, '应当拦住冒泡，否则边说边跳页')
    assert.equal(walker.getAttribute('data-talk'), null, '点按钮不该顺手冒出气泡')
  })

  it('双击头像直接进对话（想干活的人不用先听一句话）', () => {
    const room = makeRoom({ employees: [employeeOf('a7')] })
    room.call('renderOfficeRoom')
    const walker = at(walkers(room.scene), 0)
    assert.equal(typeof walker.ondblclick, 'function', '没挂双击')
    walker.ondblclick({})
    assert.deepEqual(room.selected, ['a7'])
  })

  it('头像本身是可点的、有名字可读的（读屏用户也点得到）', () => {
    const room = makeRoom({ employees: [employeeOf('a1', { name: '阿一' })], desk: { a1: { busy: true } } })
    room.call('renderOfficeRoom')
    const walker = at(walkers(room.scene), 0)
    assert.equal(walker.getAttribute('role'), 'button')
    assert.equal(walker.getAttribute('tabindex'), '0')
    const label = walker.getAttribute('aria-label') || ''
    assert.ok(label.includes('阿一') && label.includes('忙碌'), `读屏标签没说清是谁、什么状态：${label}`)
    assert.ok(String(walker.title).includes('双击'), '提示里应当说清"双击进对话"')
  })

  it('头像用的是员工自己的头像（这一页不生图）', () => {
    const room = makeRoom({ employees: [employeeOf('a1')] })
    room.call('renderOfficeRoom')
    const walker = at(walkers(room.scene), 0)
    const box = one(one(walker, '.walker-face'), '.desk-avatar-box')
    assert.equal(box.getAttribute('data-avatar-for'), 'a1')
    assert.equal(room.calls.ensureAvatar, 1, '应当去要一次头像（否则全是线稿脸）')
    assert.ok(!ROOM_CSS.includes('url('), '样式里出现了图片地址')
  })
})

/* ══════════════════ 4. 状态是真的 ══════════════════ */

describe('办公室全景：状态与真实数据', () => {
  it('忙碌 / 在线 / 离线都对得上，且带对应的小道具', () => {
    const room = makeRoom({
      employees: [employeeOf('b1'), employeeOf('b2'), employeeOf('b3', { available: false, nodeOnline: false })],
      desk: { b1: { busy: true } }
    })
    room.call('renderOfficeRoom')
    const list = walkers(room.scene)
    assert.equal(at(list, 0).getAttribute('data-lamp'), 'busy')
    assert.equal(at(list, 0).getAttribute('data-pose'), 'type')
    assert.equal(one(at(list, 0), '.walker-prop').textContent, '')
    assert.equal(at(list, 1).getAttribute('data-lamp'), 'ok')
    assert.equal(at(list, 1).getAttribute('data-pose'), 'work')
    assert.equal(at(list, 2).getAttribute('data-lamp'), 'off')
    assert.equal(at(list, 2).getAttribute('data-pose'), 'sleep')
    assert.equal(one(at(list, 2), '.walker-prop').textContent, 'Zzz')
  })

  it('未读数字来自真数据，点开了就没有了', () => {
    const room = makeRoom({ employees: [employeeOf('c1')], unread: { c1: 7 } })
    room.call('renderOfficeRoom')
    const walker = at(walkers(room.scene), 0)
    assert.equal(one(walker, '.walker-badge').textContent, '7')
    assert.equal(walker.getAttribute('data-unread'), '1')
    assert.equal(walker.getAttribute('data-pose'), 'call', '有未读应当举手（这是他唯一求你的事）')
    room.state.unread.c1 = 0
    room.call('renderOfficeRoom')
    assert.equal(one(walker, '.walker-badge').textContent, '')
    assert.equal(walker.getAttribute('data-unread'), '0')
  })

  it('未读超过两位数折成 99+（角标不该被撑开）', () => {
    const room = makeRoom({ employees: [employeeOf('c1')], unread: { c1: 128 } })
    room.call('renderOfficeRoom')
    assert.equal(one(at(walkers(room.scene), 0), '.walker-badge').textContent, '99+')
  })

  it('卡住的人（同一个三分钟看门狗）头顶冒「!」，并写清卡了多久', () => {
    const room = makeRoom({
      employees: [employeeOf('d1')],
      desk: { d1: { busy: true, lastEventAtMs: FakeDate.now() - STALL_MS - 60000 } }
    })
    room.call('renderOfficeRoom')
    const walker = at(walkers(room.scene), 0)
    assert.equal(walker.getAttribute('data-lamp'), 'bad')
    assert.equal(walker.getAttribute('data-pose'), 'alert')
    assert.equal(one(walker, '.walker-prop').textContent, '!')
    assert.ok((walker.getAttribute('aria-label') || '').includes('无响应'), '卡住的人应当在标签里说清')
  })

  it('工作区没了的人画成灰的、标一个「×」', () => {
    const room = makeRoom({ employees: [employeeOf('e0', { status: 'missing-dir' })] })
    room.call('renderOfficeRoom')
    const walker = at(walkers(room.scene), 0)
    assert.equal(walker.getAttribute('data-pose'), 'gone')
    assert.equal(one(walker, '.walker-prop').textContent, '×')
  })

  it('选中的人有记号（跟办公区选中的是同一个）', () => {
    const room = makeRoom({ employees: [employeeOf('a1'), employeeOf('a2')], selectedEmployeeId: 'a2' })
    room.call('renderOfficeRoom')
    const list = walkers(room.scene)
    assert.equal(at(list, 0).classList.contains('active'), false)
    assert.equal(at(list, 1).classList.contains('active'), true)
  })

  it('门牌上写的是真数据，只列非零的项', () => {
    const room = makeRoom({
      employees: [employeeOf('a1'), employeeOf('a2'), employeeOf('a3', { available: false, nodeOnline: false })],
      desk: { a1: { busy: true } },
      unread: { a2: 2 }
    })
    room.call('renderOfficeRoom')
    assert.equal(room.summary.textContent, '3 位同事 · 1 位在忙 · 1 位离线 · 2 条未读')
    const quiet = makeRoom({ employees: [employeeOf('a1')] })
    quiet.call('renderOfficeRoom')
    assert.equal(quiet.summary.textContent, '1 位同事', '没有空闲的人就不该写"0 条未读"')
  })

  it('这页不编数据：没有等级、经验、金币、积分这类哄人的东西', () => {
    for (const word of ['等级', '经验值', '金币', '积分', '排名', '成就']) {
      assert.ok(!CHUNK_32_OFFICE_ROOM.includes(word), `片段里出现了「${word}」`)
      assert.ok(!ROOM_MARKUP.includes(word), `标记里出现了「${word}」`)
    }
  })
})

/* ══════════════════ 5. 刷新不打断走位 ══════════════════ */

describe('办公室全景：刷新不打断走位', () => {
  it('忙闲/未读变了只改属性，节点一个都不换（动画不会回到起点）', () => {
    const room = makeRoom({ employees: many(6), desk: {} })
    room.call('renderOfficeRoom')
    const before = walkers(room.scene)
    const first = at(before, 0)
    const position = first.style.getPropertyValue('--w-x')
    room.state.desk.e0 = { busy: true }
    room.state.unread.e1 = 3
    room.call('renderOfficeRoom')
    const after = walkers(room.scene)
    assert.equal(after.length, 6)
    assert.equal(at(after, 0), first, '节点被换掉了（动画会从头开始）')
    assert.equal(at(after, 0).getAttribute('data-lamp'), 'busy', '状态没跟上')
    assert.equal(at(after, 0).style.getPropertyValue('--w-x'), position, '走位不该被刷新改动')
    assert.equal(at(after, 1).getAttribute('data-unread'), '1')
  })

  /* 人变了必然要重排（格子要重切），所以这两条不锁"节点不变"，只锁"名册一个不多一个不少"。
     真正要守住的是"只是状态变了就别动节点"，那一条在上面。 */
  it('多了一个人：名册多一个，而且不重不漏', () => {
    const employees = many(4)
    const room = makeRoom({ employees })
    room.call('renderOfficeRoom')
    employees.push(employeeOf('e9'))
    room.sections[0] = { key: '', name: '默认', members: employees }
    room.call('renderOfficeRoom')
    const after = walkers(room.scene)
    assert.equal(after.length, 5)
    const ids = after.map((walker) => walker.getAttribute('data-emp'))
    assert.deepEqual([...ids].sort(), ['e0', 'e1', 'e2', 'e3', 'e9'])
    assert.equal(room.summary.textContent, '5 位同事')
    /* 新人也要有完整的一套（头像、名字、点击行为），不能只是个空壳 */
    const fresh = at(after, 4)
    assert.ok(one(fresh, '.walker-face').children.length > 0, '新来的人没画头像')
    assert.equal(typeof fresh.onclick, 'function', '新来的人点不动')
  })

  it('少了一个人：他不见了，别人都还在', () => {
    const employees = many(5)
    const room = makeRoom({ employees })
    room.call('renderOfficeRoom')
    employees.splice(0, 1)
    room.sections[0] = { key: '', name: '默认', members: employees }
    room.call('renderOfficeRoom')
    const ids = walkers(room.scene).map((walker) => walker.getAttribute('data-emp'))
    assert.deepEqual([...ids].sort(), ['e1', 'e2', 'e3', 'e4'])
    assert.equal(room.summary.textContent, '4 位同事')
  })
  it('场地尺寸变了才重建（走位本来就要重排）', () => {
    const room = makeRoom({ employees: many(5), stage: { w: 900, h: 600 } })
    room.call('renderOfficeRoom')
    const first = at(walkers(room.scene), 0)
    room.stage.clientWidth = 1400
    room.call('renderOfficeRoom')
    assert.notEqual(at(walkers(room.scene), 0), first)
  })

  it('窗口尺寸变了会自动重排（只在正看着这一页时动手）', () => {
    const room = makeRoom({ employees: many(5), stage: { w: 900, h: 600 } })
    room.call('renderOfficeRoom')
    const before = at(walkers(room.scene), 0)
    room.state.view = 'office'
    room.stage.clientWidth = 1500
    room.resize()
    assert.equal(at(walkers(room.scene), 0), before, '不在这一页时不该重排')
    room.state.view = 'officeRoom'
    room.resize()
    assert.notEqual(at(walkers(room.scene), 0), before, '回到这一页后应当重排')
    assert.equal(cssNumber(room.scene, '--room-w'), 1500)
  })

  it('只有正看着这一页才跟着数据重画', () => {
    const room = makeRoom({ employees: many(3), view: 'office' })
    room.call('maybeRenderOfficeRoom')
    assert.equal(walkers(room.scene).length, 0, '没在看这一页却动手画了')
    room.state.view = 'officeRoom'
    room.call('maybeRenderOfficeRoom')
    assert.equal(walkers(room.scene).length, 3)
  })
})

/* ══════════════════ 6. 天色与空场景 ══════════════════ */

describe('办公室全景：天色与空场景', () => {
  it('天色跟着你电脑上的钟走', () => {
    const cases: Array<[number, string]> = [
      [6, 'dawn'],
      [10, 'day'],
      [18, 'dusk'],
      [22, 'night']
    ]
    for (const [hour, part] of cases) {
      FakeDate.hour = hour
      const room = makeRoom({ employees: many(3) })
      room.call('renderOfficeRoom')
      assert.equal(room.stage.getAttribute('data-daypart'), part, `${hour} 点应当是 ${part}`)
    }
    FakeDate.hour = 10
  })

  it('每十分钟看一眼天色，而且只在自己这一页可见时改', () => {
    const room = makeRoom({ employees: many(3) })
    room.call('renderOfficeRoom')
    assert.equal(room.intervals.length, 1, '应当只有一个"看天色"的定时器')
    const tick = at(room.intervals, 0)
    FakeDate.hour = 23
    room.state.view = 'office'
    tick()
    assert.equal(room.stage.getAttribute('data-daypart'), 'day', '不在这一页时不该动 DOM')
    room.state.view = 'officeRoom'
    tick()
    assert.equal(room.stage.getAttribute('data-daypart'), 'night')
    FakeDate.hour = 10
  })

  it('一个员工都没有时给一句人话，而不是空场地', () => {
    const room = makeRoom({ employees: [] })
    room.call('renderOfficeRoom')
    assert.equal(walkers(room.scene).length, 0)
    assert.equal(room.summary.textContent, '')
    const empty = one(room.scene, '.empty')
    assert.ok(empty.textContent.includes('暂无员工'))
    const offline = makeRoom({ employees: [], phase: 'offline' })
    offline.call('renderOfficeRoom')
    assert.ok(one(offline.scene, '.empty').textContent.includes('未连接'))
  })
})

/* ══════════════════ 7. 样式契约（看得见的部分） ══════════════════ */

describe('办公室全景：样式契约', () => {
  it('浅色 / 深色两套天色都写全了', () => {
    for (const name of [
      '--scene-sky-1',
      '--scene-sky-2',
      '--scene-ground',
      '--scene-shadow',
      '--scene-ring',
      '--scene-tint',
      '--scene-bubble',
      '--scene-bubble-ink',
      '--scene-bubble-edge'
    ]) {
      const count = ROOM_CSS.split(name + ':').length - 1
      assert.ok(count >= 2, `${name} 只在一套主题里定义（浅色/深色各要一份）`)
    }
  })

  it('四个时段都有罩色，夜里最重', () => {
    for (const part of ['dawn', 'day', 'dusk', 'night']) {
      const body = ruleBody(ROOM_CSS, `.room[data-daypart="${part}"]`)
      assert.ok(body.includes('--scene-tint'), `${part} 没有罩色`)
    }
    const night = ruleBody(ROOM_CSS, '.room[data-daypart="night"]')
    const alpha = Number((night.match(/rgba\([^)]*?([\d.]+)\)/) || [])[1])
    assert.ok(alpha >= 0.3, `夜里的罩色太淡（${alpha}）`)
  })

  it('藏起来的气泡与姓名不参与点击（不然会挡住后面的人）', () => {
    const bubble = ruleBody(ROOM_CSS, '.walker-bubble {')
    assert.ok(hasDecl(bubble, 'pointer-events', 'none'), '气泡默认必须放过点击')
    const open = ruleBody(ROOM_CSS, '.walker[data-talk="1"] .walker-bubble')
    assert.ok(hasDecl(open, 'pointer-events', 'auto'), '气泡打开后要被点到（里面还有按钮）')
    const name = ruleBody(ROOM_CSS, '.walker-name {')
    assert.ok(hasDecl(name, 'pointer-events', 'none'), '隐形的姓名牌会挡住别人')
    assert.ok(hasDecl(name, 'opacity', '0'), '姓名牌默认应当隐身（人多了会糊成一团）')
  })

  it('小灯四色齐全，未读角标有自己的颜色', () => {
    for (const lamp of ['ok', 'busy', 'bad', 'off']) {
      const body = ruleBody(ROOM_CSS, `.walker[data-lamp="${lamp}"] .walker-dot`)
      assert.ok(body.includes('background'), `${lamp} 这颗灯没有颜色`)
    }
    assert.ok(ruleBody(ROOM_CSS, '.walker-badge {').includes('background'))
  })

  it('说明里写清了"点一下说话、双击进对话"', () => {
    assert.ok(ROOM_MARKUP.includes('点一下谁'), '说明里没写点一下会怎样')
    assert.ok(ROOM_MARKUP.includes('双击'), '说明里没写双击')
    assert.ok(ROOM_MARKUP.includes('聊两句'), '说明里没写气泡里的入口')
  })

  it('场地、门牌、场景层三个容器都还在（导航与脚本按 id 找它们）', () => {
    for (const id of ['roomRoom', 'roomFloor', 'roomSummary']) {
      assert.ok(ROOM_MARKUP.includes(`id="${id}"`), `标记里缺 #${id}`)
    }
    assert.ok(!ROOM_MARKUP.includes('roomMini'), '小地图已经去掉了，标记里不该留着')
  })

  it('窄屏有自己的一套尺寸（气泡不该在小屏上撑破）', () => {
    const narrow = ROOM_CSS.slice(ROOM_CSS.indexOf('@media (max-width: 720px)'))
    assert.ok(narrow.includes('.room'), '窄屏没有调整场地')
    assert.ok(narrow.includes('.walker-bubble'), '窄屏没有调整气泡')
  })
})
