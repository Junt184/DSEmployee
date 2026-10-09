import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { renderControlUiScript } from '../src/web/ui.ts'
import { CSS_SOURCE } from './console-source.ts'

/** 去注释后的 CSS：`visibility: hidden` 这类断言不该被注释里的同名文字骗过。 */
const CSS = CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')

const script = renderControlUiScript()
const parsed = ts.createSourceFile('ui.js', script, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
const functions = new Map(parsed.statements.filter(ts.isFunctionDeclaration).map((node) => [node.name?.text, node.getText(parsed)]))

class Element {
  children: Element[] = []
  attributes: Record<string, string> = {}
  className = ''
  textContent = ''
  value = ''
  id = ''
  disabled = false
  onclick?: (event?: { stopPropagation(): void }) => void
  onkeydown?: (event: unknown) => void
  onblur?: () => void
  tagName: string
  constructor(tagName = 'div') { this.tagName = tagName }
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
    toggle: (name: string, on: boolean) => {
      const names = new Set(this.className.split(' ').filter(Boolean))
      if (on) names.add(name)
      else names.delete(name)
      this.className = [...names].join(' ')
    },
  }
  get firstChild(): Element | null { return this.children[0] ?? null }
  appendChild(node: Element): void { this.children.push(node) }
  removeChild(node: Element): void {
    function blur(removed: Element): void {
      removed.onblur?.()
      removed.children.forEach(blur)
    }
    blur(node)
    const index = this.children.indexOf(node)
    assert.ok(index >= 0, '不能重入删除已经移除的节点')
    this.children.splice(index, 1)
  }
  setAttribute(key: string, value: string): void { this.attributes[key] = value }
  /* 属性读写是新增的红绘去重与选中同步要用的：`renderSessions` 现在把树的内容指纹写在
     `data-tree-signature` 上，指纹没变就只同步选中态、不重建 DOM。
     假 DOM 缺 getAttribute 的话，这些断言会以"类型错误"的面目失败，指向完全错误的地方。 */
  getAttribute(key: string): string | null { return this.attributes[key] ?? null }
  removeAttribute(key: string): void { delete this.attributes[key] }
  querySelector(selector: string): Element | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
  /* 选中态同步要按类名批量找会话行（`list.querySelectorAll('.cs-employee')`）。
     只支持这一种用法：以 `.` 开头的单类名选择器 —— 与其它 harness 的约定一致。 */
  querySelectorAll(selector: string): Element[] {
    const found: Element[] = []
    for (const child of this.children) {
      if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) found.push(child)
      found.push(...child.querySelectorAll(selector))
    }
    return found
  }
  focus(): void {}
  /* 焦点落在列表里时 `renderSessions` 要认出"重绘后把焦点还给同一行"（键盘可达性）。
     没有 contains 就只能整段跳过，而那正是它要守的行为。 */
  contains(node: Element): boolean {
    if (node === this) return true
    return this.children.some((child) => child.contains(node))
  }
  closest(selector: string): Element | null {
    /* 只需要"往上找带某个 class 的祖先"这一种用法（找会话行）。 */
    let node: Element | null = this
    while (node !== null) {
      if (node.classList.contains(selector.slice(1))) return node
      node = null
    }
    return null
  }
}

type Session = { sessionId: string; name: string; updatedAt?: number; archived?: boolean; archivedAtMs?: number; running?: boolean }
type Entry = { sessions: Session[] | null; loading: boolean; error: string; request: Promise<Session[]> | null }
type Call = {
  method: string
  params: Record<string, unknown>
  /** 已经 resolve/reject 过 —— 用来结清残留的在途调用（见 settleAll） */
  settled: boolean
  resolve(value: unknown): void
  reject(error: unknown): void
}

function harness() {
  const state = {
    phase: 'ready', view: 'chat', scopes: ['employee.read', 'employee.prompt'],
    positions: [],
    employees: [{ id: 'emp_a', name: '小艾' }, { id: 'emp_b', name: '阿澈' }],
    selectedEmployeeId: 'emp_a' as string | null, selectedSessionId: 'a1' as string | null,
    sessions: [{ sessionId: 'a1', name: '会话 A' }] as Session[],
    /* 本组操作会话行的场景从用户已主动展开的状态开始。 */
    employeeSessions: new Map<string, Entry>(), expandedSessionEmployees: new Set<string>(['emp_a', 'emp_b']),
    expandedArchives: new Set<string>(), sessionArchivePending: new Map<string, Promise<boolean>>(),
    employeeSelectionVersion: 0, sessionOpenVersion: 0, subscribed: null as string | null, attachments: [],
    historySync: null, sessionEventSeqs: new Set(),
    /* 工作台快照那批新加的 state 字段：openSession 会读它来恢复阅读位置。
       假 DOM 的契约是"给足以让被测函数跑完的那部分状态"，所以新字段要跟着补。 */
    chatViews: new Map<string, unknown>(), employeeDrafts: new Map<string, string>(),
    asideCache: new Map<string, unknown>(), quadCache: new Map<string, unknown>(),
    sessionLiveVersion: 0, workspaceAnimation: null,
  }
  for (const [id, sessions] of [['emp_a', state.sessions], ['emp_b', [{ sessionId: 'b1', name: '会话 B' }]]] as const) {
    state.employeeSessions.set(id, { sessions: [...sessions], loading: false, error: '', request: null })
  }
  const local = new Map<string, string>()
  const list = new Element('ul')
  const chat = new Element()
  const title = new Element('input')
  const preset = new Element('input')
  const nodes: Record<string, Element> = { sessionList: list, viewChat: chat, newSessionTitle: title, presetInput: preset }
  const calls: Call[] = []
  const toasts: string[] = []
  const messages: unknown[] = []
  const errors: unknown[] = []
  const scope = vm.createContext({
    state, Promise, Map, Set, Date, JSON, setTimeout, clearTimeout,
    $: (id: string) => nodes[id] ?? null,
    /* activeElement 是真实浏览器里恒有的属性（哪怕没有焦点也是 body）：
       renderSessions 现在靠它认出"重绘后把焦点还给同一行"。不建模它，
       代码里的 `document.activeElement.classList` 会在假 DOM 上直接抛。 */
    document: { createElement: (tag: string) => new Element(tag), activeElement: null },
    rpc: (method: string, params: Record<string, unknown>) => new Promise((resolve, reject) => {
      const call: Call = {
        method, params, settled: false,
        resolve: (value: unknown) => { call.settled = true; resolve(value) },
        reject: (error: unknown) => { call.settled = true; reject(error) },
      }
      calls.push(call)
    }),
    officeSections: () => [{ members: state.employees }],
    LS: { preset: 'dse.agentPreset' }, shortId: (id: string) => id,
    pushRaw: () => {}, toast: (message: string) => void toasts.push(message),
    reportRpcError: (...args: unknown[]) => errors.push(args),
    writeLocal: (key: string, value: string) => {
      /* 复刻真实现的关键语义：**空值 = 删掉这一条**（见 00-core 的 writeLocal）。
         "清空输入框就能把存档一起清掉"正是这条 bug 的修复点，替身必须同语义。 */
      if (value === null || value === undefined || value === '') local.delete(key)
      else local.set(key, String(value))
    },
    readLocal: (key: string) => local.get(key) ?? null,
    applyContextFromSessionList: () => {}, updateChatHeader: () => {}, renderAttachStrip: () => {},
    clearUnread: () => {}, bindChatUi: () => {}, renderEmployees: () => {}, toggleSessionPanel: () => {},
    syncControls: () => {}, updateEffectivePreset: () => {}, updateSendButton: () => {},
    updateCompactButton: () => {}, updateDistillButton: () => {}, loadEmployeeAside: () => {},
    applyPositionShell: () => {}, employeeById: (id: string) => state.employees.find((e) => e.id === id),
    setView: (view: string) => { state.view = view },
    selectedNodeOnline: () => true, recallSession: () => '', adoptOfflineSession: () => '',
    rememberSession: () => {}, forgetSession: () => {}, setRunning: () => {}, renderQuadCells: () => {},
    readCachedSessions: () => null, rememberSessionList: () => {}, readCachedHistory: () => null, rememberHistory: () => {},
    clearMessages: (message: string) => messages.push(message), normalizeEvent: (event: unknown) => event,
    renderNormalized: (event: unknown) => messages.push(event), historyCursor: () => null,
    syncHistoryMore: () => {}, scrollMessages: () => {}, describeError: () => 'error',
    turnRunning: false, distilling: false, distillSnapshot: null, chatFollowTail: true, historyRendering: false,
    /* 导航重构后 selectEmployee 会顺带刷新公共员工导航；工作台快照那批会记本页阅读位置。
       两者都不是这一组要测的东西，按 harness 的惯例替身掉。 */
    updateEmployeeNavigation: () => {}, closeSessionNavDrawer: () => {}, rememberChatView: () => {},
    autoGrowPrompt: () => {},
    /* 切员工时的过渡动画（工作台切换那批）：与"会话树长什么样"无关，替身掉。 */
    animateEmployeeWorkspace: () => {},
  })
  /* 这里的名字必须与交付脚本里真实存在的函数一一对应 —— 少一个就整份文件起不来
     （harness 构造期就 assert）。导航重构删掉了 `isRegularSessionTree`：
     四个岗位现在共用同一份会话树，"是不是普通会话树"这个分叉不存在了。 */
  const names = ['el', 'clear', 'pickArray', 'positionList', 'positionName', 'sessionIdOf', 'sessionTitleOf', 'latestSessionId',
    'employeeSessionState', 'cacheEmployeeSessions', 'loadSessionTree',
    'loadSessions', 'reloadEmployeeSessions', 'renderSessions', 'appendSessionRows', 'appendSessionRow', 'renderSessionTree', 'setSessionArchived',
    'sessionTreeSignature', 'syncSessionSelection', 'chatViewKey',
    'selectEmployee', 'createSession', 'renameSession', 'startSessionRename', 'ensureSubscribed', 'openSession',
    'sessionEventSeq', 'mergeSessionHistory', 'renderSessionEvent']
  vm.runInContext(names.map((name) => {
    assert.ok(functions.has(name), `Missing ${name}`)
    return functions.get(name)
  }).join('\n'), scope)
  return { state, list, chat, title, preset, calls, scope, messages, errors, toasts, local }
}

async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)) }

/**
 * 把在途调用用一个合理形状的值全部结清。
 *
 * 为什么需要：`createSession` 成功后会接着拉列表、订阅会话…… 只 resolve 第一跳的话，
 * 用例结束时还挂着未决 promise —— 报出来的是"这个测试之后的所有测试都 pending"，
 * 指向完全错误的地方（第一版就是这么踩的）。
 */
async function settleAll(h: ReturnType<typeof harness>): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    /* 先让微任务跑完再数：下一步的请求是在上一步的 .then 里发出来的，
       不 flush 就直接看会看到"没有在途请求"而提前返回（第一版就是这么漏的）。 */
    await flush()
    const open = h.calls.filter((call) => !call.settled)
    if (open.length === 0) return
    for (const call of open) {
      if (call.method === 'session.list') call.resolve({ sessions: [] })
      else if (call.method === 'session.history') call.resolve({ events: [], hasMore: false })
      else call.resolve({})
    }
  }
}

describe('普通聊天页的员工会话树', () => {
  it('高亮与当前标识跟随所选员工，其他员工的标识不可见也不可读', () => {
    const h = harness()
    h.scope.renderSessions()
    assert.equal(h.list.children[0]!.classList.contains('selected'), true)
    assert.equal(h.list.children[0]!.querySelector('.cs-current')!.textContent, '当前')
    /* 「当前」这枚标记现在是**每行都建、由 CSS 决定可不可见**
       （`.cs-current { visibility: hidden }` + `.cs-employee.selected .cs-current { visibility: visible }`），
       不再是"只给选中的那行建一个"。所以这里断的是**可观察的不变量**，不是 DOM 里有没有那个节点：
         · 未选中的行绝不能把标记显示出来 —— 靠上面那条 CSS（下面单独钉住它）；
         · 标记对读屏器一律隐藏（aria-hidden），否则每行都会被念一遍"当前"。
       断"节点不存在"会把实现细节当成契约：换一种同样正确的写法就会假红。 */
    assert.equal(h.list.children[1]!.classList.contains('selected'), false)
    assert.equal(h.list.children[1]!.querySelector('.cs-current')!.getAttribute('aria-hidden'), 'true')
    assert.ok(
      /\.cs-employee\.selected \.cs-current \{ visibility: visible; \}/.test(CSS),
      '只有选中的员工行才该把「当前」显示出来 —— 这条 CSS 没了，标记会挂在每一行上',
    )
    assert.ok(
      /\.cs-current \{[^}]*visibility: hidden/.test(CSS),
      '「当前」默认必须是隐藏的（否则每行都显示它）',
    )
    h.state.selectedEmployeeId = 'emp_b'
    h.scope.renderSessions()
    assert.equal(h.list.children[0]!.classList.contains('selected'), false)
    assert.equal(h.list.children[1]!.classList.contains('selected'), true)
    assert.equal(h.list.children[1]!.querySelector('.cs-current')!.textContent, '当前')
  })
  it('按员工显示会话，折叠不会切换员工，重绘保留折叠状态', () => {
    const h = harness()
    h.scope.renderSessions()
    assert.equal(h.list.children.length, 2)
    const group = h.list.children[0]!
    assert.equal(group.attributes['data-employee-id'], 'emp_a')
    assert.equal(group.children[1]!.children[0]!.attributes['aria-current'], 'true')
    group.children[0]!.children[0]!.onclick!()
    assert.equal(h.state.selectedEmployeeId, 'emp_a')
    assert.equal(h.state.selectedSessionId, 'a1')
    assert.equal(h.list.children[0]!.children[0]!.children[0]!.attributes['aria-expanded'], 'false')
    assert.equal(h.list.children[0]!.children[1]!.classList.contains('hidden'), true)
    h.scope.renderSessions()
    assert.equal(h.state.expandedSessionEmployees.has('emp_a'), false)
    assert.equal(h.list.children[1]!.children[1]!.children[0]!.attributes['aria-current'], undefined)
  })

  it('点击另一员工的会话直接打开该会话，不自动新建或打开最近会话', async () => {
    const h = harness()
    h.scope.renderSessions()
    h.list.children[1]!.children[1]!.children[0]!.onclick!()
    assert.equal(h.state.selectedEmployeeId, 'emp_b')
    h.calls[0]!.resolve({ sessions: [{ sessionId: 'b1', name: '指定会话' }, { sessionId: 'b2', name: '最近会话', updatedAt: 20 }] })
    await flush()
    assert.equal(h.state.selectedSessionId, 'b1')
    assert.equal(h.calls.some((call) => call.method === 'session.create'), false)
  })

  it('点击员工名字切换员工并恢复最近会话，保留其他员工的折叠状态', async () => {
    const h = harness()
    h.state.expandedSessionEmployees.delete('emp_a')
    h.scope.renderSessions()
    h.list.children[1]!.children[0]!.children[1]!.onclick!()
    h.calls[0]!.resolve({ sessions: [{ sessionId: 'b1', name: '最近会话', updatedAt: 20 }] })
    await flush()
    assert.equal(h.state.selectedEmployeeId, 'emp_b')
    assert.equal(h.state.selectedSessionId, 'b1')
    assert.equal(h.state.expandedSessionEmployees.has('emp_a'), false)
  })

  it('agentPreset 栏被填进显示名时：不发请求，并说清该清哪一栏', async () => {
    /* 真实事故：这一栏被浏览器自动填充成了设备显示名「MacBook 的 Chrome 浏览器」，
       于是每次新建会话都吃 dsh 的 "preset ... not found"（英文），用户不知道该动哪里。 */
    const h = harness()
    h.preset.value = 'MacBook 的 Chrome 浏览器'
    await h.scope.createSession()
    assert.equal(
      h.calls.some((call) => call.method === 'session.create'),
      false,
      '明显不是 id 的值不该发出去 —— 那必然失败，还把一句英文错误甩给用户',
    )
    assert.equal(h.toasts.length, 1, '必须当场说明，而不是静默什么都不做')
    assert.match(h.toasts[0] ?? '', /agentPreset/)
    assert.match(h.toasts[0] ?? '', /preset id/)
    assert.match(h.toasts[0] ?? '', /清空/)
    assert.equal(h.local.has('dse.agentPreset'), false, '坏值不许被存进本地偏好')
  })

  it('清空 agentPreset 栏 = 恢复默认，并且把存档一起清掉（否则刷新又回来）', async () => {
    const h = harness()
    h.local.set('dse.agentPreset', 'MacBook 的 Chrome 浏览器')
    h.preset.value = ''
    const creating = h.scope.createSession()
    const call = h.calls.find((entry) => entry.method === 'session.create')
    assert.ok(call !== undefined)
    assert.equal(call.params['agentPreset'], undefined, '空值不该被当成"指定了一个空 preset"发出去')
    assert.equal(h.local.has('dse.agentPreset'), false, '空值要顺手清掉存档 —— 否则下次刷新它又回来了')
    call.resolve({ sessionId: 'a9' })
    await settleAll(h)
    await creating.catch(() => undefined)
  })

  it('合法的 preset id（含空格的都不行，CJK 目录名可以）原样发出去', async () => {
    const h = harness()
    for (const preset of ['standard', '我的秘书']) {
      const fresh = harness()
      fresh.preset.value = preset
      const creating = fresh.scope.createSession()
      const call = fresh.calls.find((entry) => entry.method === 'session.create')
      assert.ok(call !== undefined, `${preset} 应当被发出去`)
      assert.equal(call.params['agentPreset'], preset)
      assert.equal(fresh.local.get('dse.agentPreset'), preset, '用过的值记下来，下次预填')
      call.resolve({ sessionId: 'a9' })
      await settleAll(fresh)
      await creating.catch(() => undefined)
    }
    void h
  })

  it('在另一员工分组下新建会话只为该员工创建一次', async () => {
    const h = harness()
    h.scope.renderSessions()
    h.list.children[1]!.children[1]!.children.at(-1)!.children[0]!.onclick!()
    h.calls[0]!.resolve({ sessions: [] })
    await flush()
    const create = h.calls.find((call) => call.method === 'session.create')!
    assert.equal(create.params.employeeId, 'emp_b')
    assert.equal(h.calls.filter((call) => call.method === 'session.create').length, 1)
  })

  it('四个岗位共用同一份员工会话树（不再按 layout 分叉）', () => {
    /* 这条**改过**：原先秘书页与四宫格走的是"当前员工的平铺会话"（没有员工分组），
       于是同一个列表在四个岗位里有两种结构、两套渲染分支。导航重构把分叉删了 ——
       `isRegularSessionTree()` 与那条平铺分支都不存在，四个岗位都是员工→会话两级树。
       所以这里断的是"结构一致"，不是"某个 layout 特殊"。 */
    for (const layout of ['', 'layout-secretary', 'layout-quad', 'layout-quad layout-quad-chat']) {
      const h = harness()
      h.chat.className = layout
      h.scope.renderSessions()
      const groups = h.list.querySelectorAll('.cs-employee')
      assert.equal(groups.length, 2, `${layout || '(默认)'} 应当是两位员工各一个分组`)
      assert.equal(groups[0]!.attributes['data-employee-id'], 'emp_a')
      /* 会话行住在员工分组里，不再平铺在顶层。 */
      assert.equal(h.list.children[0]!.attributes['data-session-id'], undefined)
      h.scope.loadSessionTree()
      assert.equal(h.calls.length, 0, '展开的员工都有缓存，不该补拉')
    }
  })

  it('仅为展开且没有缓存的员工补拉会话', () => {
    const h = harness()
    h.state.employeeSessions.delete('emp_b')
    h.state.expandedSessionEmployees.delete('emp_b')
    h.scope.loadSessionTree()
    assert.equal(h.calls.length, 0)
    h.scope.renderSessions()
    h.list.children[1]!.children[0]!.children[0]!.onclick!()
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0]!.params.employeeId, 'emp_b')
  })

  it('轮询复用列表缓存，且不会抹掉正在输入的会话名称', async () => {
    const h = harness()
    h.scope.renderSessions()
    const item = h.list.children[1]!.children[1]!.children[0]!
    const edit = item.querySelector('.cs-edit')!
    edit.onclick!({ stopPropagation() {} })
    const editor = item.children[0]!
    editor.children[0]!.value = '正在输入的名称'
    h.scope.cacheEmployeeSessions('emp_b', [{ sessionId: 'b1', name: '后台更新' }])
    assert.equal(h.list.querySelector('.cs-rename'), editor)
    assert.equal(editor.children[0]!.value, '正在输入的名称')
    editor.children[0]!.onblur!()
    await flush()
    assert.equal(h.list.querySelector('.cs-rename'), null)
  })

  it('保存行内会话名称后清理编辑器，移除输入框触发的 blur 不会重复删除节点', async () => {
    const h = harness()
    h.scope.renderSessions()
    const item = h.list.children[1]!.children[1]!.children[0]!
    item.querySelector('.cs-edit')!.onclick!({ stopPropagation() {} })
    const editor = item.children[0]!
    editor.children[0]!.value = '修改后的会话名称'
    editor.children[1]!.onclick!({ stopPropagation() {} })
    h.calls[0]!.resolve({})
    await flush()
    h.calls[1]!.resolve({ sessions: [{ sessionId: 'b1', name: '修改后的会话名称' }] })
    await flush()
    assert.equal(h.list.querySelector('.cs-rename'), null)
    assert.equal(h.state.selectedEmployeeId, 'emp_a')
    assert.equal(h.state.employeeSessions.get('emp_b')!.sessions![0]!.name, '修改后的会话名称')
    assert.deepEqual(h.errors, [])
  })
})

describe('会话归档交互', () => {
  it('归档会话隐藏在可展开的已归档列表中，恢复后回到普通列表', async () => {
    const h = harness()
    const archived = { sessionId: 'a2', name: '旧记录', archived: true }
    h.state.sessions.push(archived)
    h.state.employeeSessions.get('emp_a')!.sessions!.push(archived)
    h.scope.renderSessions()
    const group = h.list.children[0]!.querySelector('.cs-archives')!
    assert.equal(group.children[1]!.classList.contains('hidden'), true)
    group.children[0]!.onclick!()
    const expanded = h.list.children[0]!.querySelector('.cs-archives')!
    assert.equal(expanded.children[1]!.classList.contains('hidden'), false)
    const restore = expanded.children[1]!.children[0]!.querySelector('.cs-archive')!
    restore.onclick!({ stopPropagation() {} })
    assert.deepEqual({ ...h.calls[0]!.params }, { employeeId: 'emp_a', sessionId: 'a2', archived: false })
    h.calls[0]!.resolve({ sessionId: 'a2', archived: false })
    await flush()
    assert.equal(h.list.children[0]!.querySelector('.cs-archives'), null)
    assert.equal(h.state.sessions[1]!.archived, false)
    assert.equal(h.state.selectedSessionId, 'a1')
  })

  it('归档失败保留原会话；重复点击只发一次请求', async () => {
    const h = harness()
    const first = h.scope.setSessionArchived('a1', true, 'emp_a')
    const second = h.scope.setSessionArchived('a1', true, 'emp_a')
    assert.equal(first, second)
    assert.equal(h.calls.length, 1)
    h.calls[0]!.reject(new Error('node offline'))
    assert.equal(await first, false)
    assert.equal(h.state.selectedSessionId, 'a1')
    assert.equal(h.state.sessions[0]!.archived, undefined)
    assert.equal(h.state.sessionArchivePending.size, 0)
  })

  it('归档当前会话只退出选择，不创建会话、不发送任务；历史仍可打开', async () => {
    const h = harness()
    const saving = h.scope.setSessionArchived('a1', true, 'emp_a')
    h.calls[0]!.resolve({ sessionId: 'a1', archived: true, archivedAtMs: 100 })
    assert.equal(await saving, true)
    assert.equal(h.state.selectedSessionId, null)
    assert.equal(h.state.sessions[0]!.archived, true)
    assert.equal(h.calls.some(call => call.method === 'session.create' || call.method === 'session.prompt'), false)
    const historyRow = h.list.children[0]!.querySelector('.cs-archives')!.children[1]!.children[0]!
    historyRow.onclick!()
    assert.equal(h.state.selectedSessionId, 'a1')
    assert.equal(h.calls.at(-1)!.method, 'session.subscribe')
  })

  it('A 的归档回执晚到不能清空 B 的当前会话', async () => {
    const h = harness()
    const saving = h.scope.setSessionArchived('a1', true, 'emp_a')
    h.state.selectedEmployeeId = 'emp_b'
    h.state.selectedSessionId = 'b1'
    h.state.sessions = h.state.employeeSessions.get('emp_b')!.sessions!
    h.calls[0]!.resolve({ sessionId: 'a1', archived: true })
    assert.equal(await saving, true)
    assert.equal(h.state.selectedSessionId, 'b1')
    assert.equal(h.state.sessions[0]!.sessionId, 'b1')
    assert.equal(h.state.employeeSessions.get('emp_a')!.sessions![0]!.archived, true)
    assert.equal(h.messages.length, 0)
  })

  it('归档之前发出的列表与轮询不能把会话状态盖回未归档', async () => {
    const h = harness()
    const loading = h.scope.loadSessions('emp_a')
    const saving = h.scope.setSessionArchived('a1', true, 'emp_a')
    h.calls[1]!.resolve({ sessionId: 'a1', archived: true })
    await saving
    h.calls[0]!.resolve({ sessions: [{ sessionId: 'a1', name: '旧快照' }] })
    await loading
    h.scope.cacheEmployeeSessions('emp_a', [{ sessionId: 'a1', name: '更旧快照' }], 0)
    assert.equal(h.state.sessions[0]!.archived, true)
  })

  it('所有会话已归档时不自动打开旧记录或创建新会话', async () => {
    /* 这条**改过**：流程从"等列表回来再决定打开哪个会话"改成了
       "先用缓存把可读内容摆出来，再拿列表核对"（切员工不再等网络响应串起来）。
       于是进入时**可能**先订阅缓存里的那个会话 —— 这是新流程明确接受的代价；
       要守的不变量是**最终状态**：不留在归档会话上、不凭空新建、不自动发指令。 */
    const h = harness()
    /* 从"没有打开任何会话"进入：这条测的是自动挑默认会话的那条路，
       而 `selectEmployee` 对"已在同一员工同一会话"现在是空操作（省掉一次无谓的整页刷新）。 */
    h.state.selectedSessionId = null
    const selecting = h.scope.selectEmployee('emp_a')
    const subscribe = h.calls.find((call) => call.method === 'session.subscribe')
    assert.ok(subscribe !== undefined, '缓存里有会话时应当先订阅它，把内容摆出来')
    subscribe.resolve({})
    await flush()
    const history = h.calls.find((call) => call.method === 'session.history')
    if (history !== undefined) history.resolve({ events: [], hasMore: false })
    await flush()
    const list = h.calls.find((call) => call.method === 'session.list')
    assert.ok(list !== undefined, '随后要用列表核对缓存是否还成立')
    list.resolve({ sessions: [{ sessionId: 'a1', name: '归档记录', archived: true }] })
    await selecting
    assert.equal(h.state.selectedSessionId, null, '列表确认它已归档后，必须从归档会话上退出来')
    assert.equal(h.calls.some((call) => call.method === 'session.create'), false, '不许凭空新建会话')
    assert.equal(h.calls.some((call) => call.method === 'session.prompt'), false, '不许自动发指令')
  })
})

describe('跨员工的异步请求隔离', () => {
  it('两个员工的列表乱序返回，旧员工响应只更新自己的缓存', async () => {
    const h = harness()
    const first = h.scope.loadSessions()
    h.state.selectedEmployeeId = 'emp_b'
    const second = h.scope.loadSessions()
    h.calls[1]!.resolve({ sessions: [{ sessionId: 'b2', name: 'B 新会话' }] })
    await second
    h.calls[0]!.resolve({ sessions: [{ sessionId: 'a2', name: 'A 新会话' }] })
    await first
    assert.equal(h.state.sessions[0]!.sessionId, 'b2')
    assert.equal(h.state.employeeSessions.get('emp_a')!.sessions![0]!.sessionId, 'a2')
  })

  it('同一员工的在途列表请求复用；读取失败保留历史缓存并允许重试', async () => {
    const h = harness()
    const first = h.scope.loadSessions('emp_a', true)
    const second = h.scope.loadSessions('emp_a', true)
    assert.equal(first, second)
    assert.equal(h.calls.length, 1)
    h.calls[0]!.reject(new Error('offline'))
    await first
    assert.equal(h.state.sessions[0]!.sessionId, 'a1')
    assert.equal(h.errors.length, 0)
    assert.ok(h.state.employeeSessions.get('emp_a')!.error)
    const retry = h.scope.loadSessions('emp_a', true)
    h.calls[1]!.resolve({ sessions: [] })
    await retry
    assert.equal(h.state.employeeSessions.get('emp_a')!.error, '')
  })

  it('后台员工重命名始终使用该员工 id，不切换当前聊天', async () => {
    const h = harness()
    const rename = h.scope.renameSession('b1', 'B 的新名字', 'emp_b')
    assert.equal(h.calls[0]!.params.employeeId, 'emp_b')
    h.calls[0]!.resolve({})
    await flush()
    assert.equal(h.calls[1]!.params.employeeId, 'emp_b')
    h.calls[1]!.resolve({ sessions: [{ sessionId: 'b1', name: 'B 的新名字' }] })
    await rename
    assert.equal(h.state.selectedEmployeeId, 'emp_a')
    assert.equal(h.state.sessions[0]!.sessionId, 'a1')
  })

  it('新建会话返回前切换员工，不会抢回选择或打开旧员工的会话', async () => {
    const h = harness()
    const creating = h.scope.createSession()
    h.state.selectedEmployeeId = 'emp_b'
    h.state.selectedSessionId = 'b1'
    h.state.employeeSelectionVersion += 1
    h.calls[0]!.resolve({ sessionId: 'a2' })
    await flush()
    h.calls[1]!.resolve({ sessions: [{ sessionId: 'a2', name: '新建会话' }] })
    await creating
    assert.equal(h.state.selectedEmployeeId, 'emp_b')
    assert.equal(h.state.selectedSessionId, 'b1')
    assert.equal(h.calls.some((call) => call.method === 'session.subscribe'), false)
  })

  it('新建会话返回前手动打开同一员工的其他会话，不会覆盖手动选择', async () => {
    const h = harness()
    const creating = h.scope.createSession()
    h.state.selectedSessionId = 'a3'
    h.state.sessionOpenVersion += 1
    h.calls[0]!.resolve({ sessionId: 'a2' })
    await flush()
    h.calls[1]!.resolve({ sessions: [{ sessionId: 'a2', name: '新会话' }, { sessionId: 'a3', name: '手选会话' }] })
    await creating
    assert.equal(h.state.selectedSessionId, 'a3')
    assert.equal(h.calls.some((call) => call.method === 'session.subscribe'), false)
  })

  it('变更后的刷新等待旧列表完成后再次请求，不能复用变更前的结果', async () => {
    const h = harness()
    const previous = h.scope.loadSessions('emp_b', true)
    const refresh = h.scope.reloadEmployeeSessions('emp_b')
    h.calls[0]!.resolve({ sessions: [{ sessionId: 'b1', name: '旧名字' }] })
    await previous
    await flush()
    assert.equal(h.calls.length, 2)
    h.calls[1]!.resolve({ sessions: [{ sessionId: 'b1', name: '新名字' }] })
    await refresh
    assert.equal(h.state.employeeSessions.get('emp_b')!.sessions![0]!.name, '新名字')
  })

  it('早于主动刷新发出的轮询响应不能盖回旧的会话标题', async () => {
    const h = harness()
    const refresh = h.scope.loadSessions('emp_b')
    h.calls[0]!.resolve({ sessions: [{ sessionId: 'b1', name: '新名字' }] })
    await refresh
    h.scope.cacheEmployeeSessions('emp_b', [{ sessionId: 'b1', name: '旧名字' }], 0)
    assert.equal(h.state.employeeSessions.get('emp_b')!.sessions![0]!.name, '新名字')
  })

  it('切换后旧订阅响应不能把当前订阅标记改回去', async () => {
    const h = harness()
    const subscribing = h.scope.ensureSubscribed()
    h.state.selectedEmployeeId = 'emp_b'
    h.state.selectedSessionId = 'b1'
    h.state.subscribed = 'b1'
    h.calls[0]!.resolve({})
    assert.equal(await subscribing, false)
    assert.equal(h.state.subscribed, 'b1')
  })

  it('旧历史晚到或失败都不能覆盖新员工的聊天记录', async () => {
    for (const fails of [false, true]) {
      const h = harness()
      const opening = h.scope.openSession('a1')
      h.calls[0]!.resolve({})
      await flush()
      assert.equal(h.calls[1]!.method, 'session.history')
      h.state.selectedEmployeeId = 'emp_b'
      h.state.selectedSessionId = 'b1'
      h.messages.length = 0
      if (fails) h.calls[1]!.reject(new Error('late error'))
      else h.calls[1]!.resolve({ events: ['A 的历史'] })
      await opening
      assert.deepEqual(h.messages, [])
      assert.deepEqual(h.errors, [])
    }
  })

  it('快速离开再回到同一会话时，仍丢弃第一次读取的历史', async () => {
    const h = harness()
    const first = h.scope.openSession('a1')
    h.calls[0]!.resolve({})
    await flush()
    const second = h.scope.openSession('a1')
    h.calls[2]!.resolve({})
    await flush()
    h.calls[3]!.resolve({ events: ['最新历史'] })
    await second
    h.messages.length = 0
    h.calls[1]!.resolve({ events: ['旧历史'] })
    await first
    assert.deepEqual(h.messages, [])
  })
})
