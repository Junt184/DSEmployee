/**
 * 全景微缩办公室：验证六人工位分页不丢员工、真实状态、独立的本地互动，
 * 并在真实交付脚本上检查选择、键盘和刷新不重建的边界。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import vm from 'node:vm'

import { CHUNK_32_OFFICE_ROOM } from '../src/web/script/32-office-room.ts'
import { renderControlUiScript } from '../src/web/ui.ts'
import { MARKUP_SOURCE } from './console-source.ts'

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
    if (name === 'class') this.className = String(value)
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
    if (selector.startsWith('[')) {
      const match = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/)
      if (match === null) return false
      return match[2] === undefined ? this.attrs.has(match[1] ?? '') : this.getAttribute(match[1] ?? '') === match[2]
    }
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
  querySelectorAll(selector: string): FakeNode[] {
    return this.root.querySelectorAll(selector)
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
  getMonth(): number { return 9 }
  getDate(): number { return 16 }
  getDay(): number { return 5 }
  getMinutes(): number { return FakeDate.minute }
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
  for (const id of ['roomPrevPage', 'roomNextPage', 'roomPageLabel', 'roomStudioName', 'roomDayLabel', 'roomSceneMessage', 'roomEventTitle', 'roomEventText', 'roomSelectedName', 'roomSelectedRole', 'roomSelectedStatus', 'roomSelectedAvatar', 'roomSelectedTalk', 'roomSelectedQuote', 'roomMotionLabel']) {
    const node = doc.createElement(id.includes('Talk') || id.includes('Page') ? 'button' : 'span')
    node.setAttribute('id', id)
    doc.root.appendChild(node)
  }
  for (const mode of ['day', 'dusk', 'night']) {
    const button = doc.createElement('button')
    button.setAttribute('data-room-light', mode)
    doc.root.appendChild(button)
  }
  for (const action of ['coffee', 'plane', 'plant']) {
    const button = doc.createElement('button')
    button.setAttribute('data-room-action', action)
    doc.root.appendChild(button)
  }
  const pause = doc.createElement('button')
  pause.setAttribute('data-room-ambience', '')
  doc.root.appendChild(pause)

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

const ROOM_MARKUP = (() => {
  const start = MARKUP_SOURCE.indexOf('<section class="col hidden" id="viewOfficeRoom">')
  assert.ok(start >= 0, '标记里找不到全景那一节')
  const end = MARKUP_SOURCE.indexOf('<section class="col hidden"', start + 1)
  assert.ok(end > start, '全景那一节的收尾没找对')
  return MARKUP_SOURCE.slice(start, end)
})()

/* ══════════════════ 1. 六人工位与工作室分页 ══════════════════ */

describe('办公室全景：六人工位与工作室分页', () => {
  it('任何规模的名册都完整分配，超过 50 人也没有遗漏或重复', () => {
    for (const count of [0, 1, 6, 7, 10, 50, 51, 80, 200]) {
      const room = makeRoom({ employees: many(count) })
      const pages = room.call<number>('roomPageCount', count)
      assert.equal(pages, Math.max(1, Math.ceil(count / 6)))
      const found: string[] = []
      for (let page = 0; page < pages; page += 1) {
        room.view().page = page
        room.call('renderOfficeRoom')
        const list = walkers(room.scene)
        assert.ok(list.length <= 6, '每间工作室最多六位员工')
        found.push(...list.map((walker) => walker.getAttribute('data-emp') || ''))
      }
      assert.deepEqual(found, many(count).map((employee) => employee.id))
      assert.equal(new Set(found).size, count)
    }
  })

  it('下一间与上一间按钮按办公区顺序翻页，边界禁用且页码准确', () => {
    const room = makeRoom({ employees: many(8) })
    room.sections[0] = { key: '', name: '排好序', members: [...room.state.employees].reverse() }
    room.call('renderOfficeRoom')
    const prev = one(room.doc.root, '#roomPrevPage')
    const next = one(room.doc.root, '#roomNextPage')
    assert.equal(prev.disabled, true)
    assert.equal(next.disabled, false)
    assert.equal(one(room.doc.root, '#roomPageLabel').textContent, '01 / 02')
    assert.deepEqual(walkers(room.scene).map((walker) => walker.getAttribute('data-emp')), ['e7', 'e6', 'e5', 'e4', 'e3', 'e2'])
    click(next)
    assert.equal(prev.disabled, false)
    assert.equal(next.disabled, true)
    assert.equal(one(room.doc.root, '#roomPageLabel').textContent, '02 / 02')
    assert.equal(one(room.doc.root, '#roomStudioName').textContent, '02 号工作室')
    assert.deepEqual(walkers(room.scene).map((walker) => walker.getAttribute('data-emp')), ['e1', 'e0'])
    click(prev)
    assert.equal(room.view().page, 0)
    assert.equal(room.selected.length, 0, '翻页不能进入真实会话')
  })

  it('分组目录尚未跟上时，追加新员工也会出现在名册中', () => {
    const employees = many(6)
    const room = makeRoom({ employees })
    room.sections[0] = { key: '', name: '旧分组', members: employees.slice() }
    room.state.employees.push(employeeOf('fresh'))
    room.view().page = 1
    room.call('renderOfficeRoom')
    assert.deepEqual(walkers(room.scene).map((walker) => walker.getAttribute('data-emp')), ['fresh'])
  })

  it('删除最后一间工作室的员工时自动回到有效页', () => {
    const employees = many(7)
    const room = makeRoom({ employees })
    room.view().page = 1
    room.call('renderOfficeRoom')
    employees.splice(6, 1)
    room.call('renderOfficeRoom')
    assert.equal(room.view().page, 0)
    assert.equal(walkers(room.scene).length, 6)
    assert.equal(one(room.doc.root, '#roomPageLabel').textContent, '01 / 01')
  })

  it('人物落在六个等距工位锚点，家具拥有独立的静态 SVG', () => {
    const room = makeRoom({ employees: many(6) })
    room.call('renderOfficeRoom')
    const anchors = [[444, 335], [568, 395], [692, 455], [306, 405], [430, 465], [554, 525]]
    walkers(room.scene).forEach((walker, index) => {
      const point = at(anchors, index)
      assert.ok(Math.abs(cssNumber(walker, 'left') * 10 - at(point, 0)) < 0.001)
      assert.ok(Math.abs(cssNumber(walker, 'top') * 7.2 - at(point, 1)) < 0.001)
      assert.equal(one(one(walker, '.room-desk-object'), 'svg').getAttribute('viewBox'), '0 0 170 130')
      assert.ok(one(walker, '.walker-torso'))
      assert.ok(one(walker, '.walker-role'))
    })
  })
})

/* ══════════════════ 2. 本地装饰互动与观景选择 ══════════════════ */

describe('办公室全景：本地小互动', () => {
  it('咖啡、纸飞机、绿萝各有不同的本地剧情，重播有变化，员工状态保持真实', () => {
    const room = makeRoom({ employees: many(6), desk: { e0: { busy: true } }, unread: { e1: 4 } })
    room.call('renderOfficeRoom')
    const first = at(walkers(room.scene), 0)
    const deskBefore = JSON.stringify(room.state.desk)
    const unreadBefore = JSON.stringify(room.state.unread)
    const narratives = new Set<string>()
    for (const action of ['coffee', 'plane', 'plant']) {
      const button = one(room.doc.root, '[data-room-action="' + action + '"]')
      click(button)
      const firstText = one(room.doc.root, '#roomSceneMessage').textContent
      assert.ok(firstText.length > 12)
      assert.equal(one(room.doc.root, '#roomEventText').textContent, '场景彩蛋 · 一段办公室里的即兴小插曲。')
      assert.ok(ROOM_MARKUP.includes('小剧场与场景彩蛋是虚构演出'))
      assert.equal(room.stage.getAttribute('data-event'), action)
      assert.equal(first.getAttribute('data-talk'), '1')
      narratives.add(firstText)
      click(button)
      assert.notEqual(one(room.doc.root, '#roomSceneMessage').textContent, firstText)
    }
    assert.equal(narratives.size, 3)
    assert.equal(room.selected.length, 0, '装饰互动不应向员工发送消息或启动真实会话')
    assert.equal(JSON.stringify(room.state.desk), deskBefore)
    assert.equal(JSON.stringify(room.state.unread), unreadBefore)
    assert.equal(first.getAttribute('data-lamp'), 'busy')
    assert.equal(first.getAttribute('data-pose'), 'type')
    room.runTimers()
    assert.equal(room.stage.getAttribute('data-event'), '')
  })

  it('白天、黄昏、夜晚按钮选中态准确，轮询不会覆盖手动天色', () => {
    const room = makeRoom()
    room.call('renderOfficeRoom')
    for (const part of ['night', 'day', 'dusk']) {
      const button = one(room.doc.root, '[data-room-light="' + part + '"]')
      click(button)
      assert.equal(room.stage.getAttribute('data-daypart'), part)
      assert.equal(button.getAttribute('aria-pressed'), 'true')
      const other = one(room.doc.root, '[data-room-light="' + (part === 'night' ? 'day' : 'night') + '"]')
      assert.equal(other.getAttribute('aria-pressed'), 'false')
    }
    FakeDate.hour = 23
    at(room.intervals, 0)()
    assert.equal(room.stage.getAttribute('data-daypart'), 'dusk')
    assert.equal(room.selected.length, 0)
    FakeDate.hour = 10
  })

  it('每次彩蛋只由一位同事接话，轮换发言者并同步人物卡，不触发真实会话', () => {
    const room = makeRoom({ employees: many(6) })
    room.call('renderOfficeRoom')
    const coffee = one(room.doc.root, '[data-room-action="coffee"]')
    const list = walkers(room.scene)
    for (let index = 0; index < 8; index += 1) {
      click(coffee)
      const open = list.filter((walker) => walker.getAttribute('data-talk') === '1')
      assert.equal(open.length, 1, '彩蛋不能同时撑开多个气泡')
      assert.equal(at(open, 0), at(list, index % 6), '重复彩蛋应轮换接话的同事')
      assert.equal(one(room.doc.root, '#roomSelectedName').textContent, '同事e' + String(index % 6))
      assert.ok(one(room.doc.root, '#roomSelectedQuote').textContent.includes(lineOf(at(open, 0))))
    }
    assert.equal(room.state.selectedEmployeeId, '')
    assert.equal(room.selected.length, 0)
  })

  it('暂停按钮只停止装饰动效，不更改员工或进入会话', () => {
    const room = makeRoom({ employees: many(2), desk: { e0: { busy: true } } })
    room.call('renderOfficeRoom')
    const before = JSON.stringify(room.state)
    const pause = one(room.doc.root, '[data-room-ambience]')
    click(pause)
    assert.equal(room.stage.getAttribute('data-paused'), 'true')
    assert.equal(pause.getAttribute('aria-pressed'), 'true')
    assert.equal(one(room.doc.root, '#roomMotionLabel').textContent, '继续小动作')
    click(pause)
    assert.equal(room.stage.getAttribute('data-paused'), 'false')
    assert.equal(pause.getAttribute('aria-pressed'), 'false')
    assert.equal(JSON.stringify(room.state), before)
    assert.equal(room.selected.length, 0)
  })

  it('日期标题展示本地日期、星期与时间', () => {
    const room = makeRoom()
    room.call('renderOfficeRoom')
    assert.equal(one(room.doc.root, '#roomDayLabel').textContent, '10 月 16 日 · 星期五 · 10:30')
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
    assert.ok(new Set(said).size >= 5, `六个人说出了 ${new Set(said).size} 种话，撞得太厉害`)
  })

  it('气泡过一会儿自己收回去', () => {
    const room = makeRoom({ employees: [employeeOf('a1')] })
    room.call('renderOfficeRoom')
    const walker = at(walkers(room.scene), 0)
    const talk = one(walker, '.walker-talk')
    assert.equal(talk.getAttribute('tabindex'), '-1', '隐藏的气泡按钮不能占用 Tab 顺序')
    click(walker)
    assert.equal(talk.getAttribute('tabindex'), '0', '显示气泡后按钮应当可以由键盘进入')
    assert.equal(room.lastTimerMs(), TALK_MS, '收回去的时间与 ROOM_TALK_MS 不一致')
    assert.equal(room.runTimers(), 1)
    assert.equal(walker.getAttribute('data-talk'), '0', '时间到了气泡还挂着')
    assert.equal(talk.getAttribute('tabindex'), '-1', '气泡收起后按钮应当退出 Tab 顺序')
  })

  it('连点两次不会留下两个定时器（后一次接管）', () => {
    const room = makeRoom({ employees: [employeeOf('a1')] })
    room.call('renderOfficeRoom')
    const walker = at(walkers(room.scene), 0)
    click(walker)
    click(walker)
    assert.equal(room.pending(), 1, `攒了 ${room.pending()} 个定时器`)
  })

  it('点另一位同事会收起前一个气泡、移出其按钮的 Tab 顺序并取消旧计时', () => {
    const room = makeRoom({ employees: many(3) })
    room.call('renderOfficeRoom')
    const list = walkers(room.scene)
    const first = at(list, 0)
    const second = at(list, 1)
    click(first)
    const firstLine = lineOf(first)
    click(second)
    assert.equal(list.filter((walker) => walker.getAttribute('data-talk') === '1').length, 1)
    assert.equal(first.getAttribute('data-talk'), '0')
    assert.equal(one(first, '.walker-talk').getAttribute('tabindex'), '-1')
    assert.equal(second.getAttribute('data-talk'), '1')
    assert.equal(one(second, '.walker-talk').getAttribute('tabindex'), '0')
    assert.equal(lineOf(first), firstLine, '收起只改变显示，不删除前一句话')
    assert.equal(room.pending(), 1, '前一位同事的气泡计时应当取消')
    assert.equal(room.runTimers(), 1)
    assert.equal(second.getAttribute('data-talk'), '0')
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

  it('气泡按钮的键盘事件不被外层头像截走，保留按钮的原生激活行为', () => {
    const room = makeRoom({ employees: [employeeOf('a1')] })
    room.call('renderOfficeRoom')
    const walker = at(walkers(room.scene), 0)
    click(walker)
    const talk = one(walker, '.walker-talk')
    const line = lineOf(walker)
    let prevented = 0
    for (const key of ['Enter', ' ']) walker.onkeydown({ key, target: talk, preventDefault: () => (prevented += 1) })
    assert.equal(prevented, 0, '外层不能取消子按钮的 Enter / 空格默认行为')
    assert.equal(lineOf(walker), line, '按子按钮不能让外层重新说话')
    assert.equal(room.selected.length, 0)
    click(talk, { stopPropagation: () => {} })
    assert.deepEqual(room.selected, ['a1'], '键盘产生的原生点击仍能进入真实会话')
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
    assert.equal(one(walker, '.walker-fiction').textContent, '即兴台词')
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

/* ══════════════════ 5. 刷新保留人物与工位 ══════════════════ */

describe('办公室全景：刷新保留人物与工位', () => {
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
  it('窗口宽度变动只调整比例，工位和人物都不重建', () => {
    const room = makeRoom({ employees: many(5), stage: { w: 900, h: 600 } })
    room.call('renderOfficeRoom')
    const first = at(walkers(room.scene), 0)
    room.stage.clientWidth = 1400
    room.call('renderOfficeRoom')
    assert.equal(at(walkers(room.scene), 0), first)
    assert.equal(cssNumber(room.stage, '--office-scale'), 1.4)
  })

  it('窗口尺寸变了自动调整场景比例（只在正看着这一页时动手）', () => {
    const room = makeRoom({ employees: many(5), stage: { w: 900, h: 600 } })
    room.call('renderOfficeRoom')
    const before = at(walkers(room.scene), 0)
    room.state.view = 'office'
    room.stage.clientWidth = 1500
    room.resize()
    assert.equal(at(walkers(room.scene), 0), before, '不在这一页时不该重排')
    room.state.view = 'officeRoom'
    room.resize()
    assert.equal(at(walkers(room.scene), 0), before, '人物节点保持原位')
    assert.equal(cssNumber(room.stage, '--office-scale'), 1.5)
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
    offline.state.phase = 'ready'
    offline.call('renderOfficeRoom')
    assert.ok(one(offline.scene, '.empty').textContent.includes('暂无员工'))
    assert.ok(!one(offline.scene, '.empty').textContent.includes('未连接'))
  })
})

/* ══════════════════ 7. 本地选择与真实会话的边界 ══════════════════ */

describe('办公室全景：本地选择与真实会话', () => {
  it('场景矢量图的片段引用在整页里只有一个目标，不会撞上办公区容器', () => {
    const sceneStart = MARKUP_SOURCE.indexOf('id="viewOfficeRoom"')
    const sceneEnd = MARKUP_SOURCE.indexOf('id="viewApprovals"', sceneStart)
    const sceneMarkup = MARKUP_SOURCE.slice(sceneStart, sceneEnd)
    const references = [...sceneMarkup.matchAll(/(?:url\(#|href="#)([A-Za-z][\w-]*)/g)].map((match) => match[1])
    assert.ok(references.length > 0, '场景应当包含实际的 SVG 渐变与图形引用')
    for (const id of references) {
      assert.equal(MARKUP_SOURCE.split('id="' + id + '"').length - 1, 1, 'SVG 引用 ' + id + ' 的目标必须在整页唯一')
    }
  })

  it('移除最后一位员工会清空旧台词，人物卡回到中性的等待状态', () => {
    const employees = [employeeOf('last', { name: '米粒' })]
    const room = makeRoom({ employees })
    room.call('renderOfficeRoom')
    click(at(walkers(room.scene), 0))
    const quote = one(room.doc.root, '#roomSelectedQuote')
    assert.ok(quote.textContent.includes('即兴台词'))
    employees.splice(0, 1)
    room.call('renderOfficeRoom')
    assert.equal(quote.textContent, '等待同事入座，一起创造办公室里的小故事。')
    assert.equal(one(room.doc.root, '#roomSelectedName').textContent, '等待同事入座')
    assert.equal(one(room.doc.root, '#roomSelectedTalk').disabled, true)
    assert.equal(one(room.doc.root, '#roomSelectedTalk').onclick, null)
    assert.equal(one(room.doc.root, '#roomSelectedAvatar').children.length, 0)
    assert.equal(room.selected.length, 0)
  })

  it('默认选择第一位，单击更新人物卡与气泡，不触发真实对话', () => {
    const room = makeRoom({ employees: [employeeOf('a', { name: '米粒', role: '内容策划' }), employeeOf('b', { name: '阿树', role: '开发工程师' })], desk: { b: { busy: true } } })
    room.call('renderOfficeRoom')
    assert.equal(one(room.doc.root, '#roomSelectedName').textContent, '米粒')
    const list = walkers(room.scene)
    click(at(list, 1))
    assert.equal(one(room.doc.root, '#roomSelectedName').textContent, '阿树')
    assert.equal(one(room.doc.root, '#roomSelectedRole').textContent, '开发工程师')
    assert.equal(one(room.doc.root, '#roomSelectedStatus').textContent, '忙碌')
    assert.equal(at(list, 0).classList.contains('active'), false)
    assert.equal(at(list, 1).classList.contains('active'), true)
    assert.equal(at(list, 1).getAttribute('aria-pressed'), 'true')
    assert.ok(one(room.doc.root, '#roomSelectedQuote').textContent.includes('即兴台词'))
    assert.equal(room.state.selectedEmployeeId, '', '本地观景选择不改真实会话选择')
    assert.equal(room.selected.length, 0)
    click(one(room.doc.root, '#roomSelectedTalk'))
    assert.deepEqual(room.selected, ['b'])
  })

  it('状态刷新会更新人物卡，且不会替换人物、家具和头像节点', () => {
    const room = makeRoom({ employees: many(3) })
    room.call('renderOfficeRoom')
    const person = at(walkers(room.scene), 0)
    const furniture = one(person, '.room-desk-object')
    const avatar = one(one(room.doc.root, '#roomSelectedAvatar'), '.desk-avatar-box')
    room.state.desk.e0 = { busy: true }
    room.state.unread.e0 = 2
    room.call('renderOfficeRoom')
    assert.equal(at(walkers(room.scene), 0), person)
    assert.equal(one(person, '.room-desk-object'), furniture)
    assert.equal(one(one(room.doc.root, '#roomSelectedAvatar'), '.desk-avatar-box'), avatar)
    assert.equal(one(room.doc.root, '#roomSelectedStatus').textContent, '忙碌 · 2 条未读')
  })
})
