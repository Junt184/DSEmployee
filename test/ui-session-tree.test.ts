import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { renderControlUiScript } from '../src/web/ui.ts'

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
  querySelector(selector: string): Element | null {
    for (const child of this.children) {
      if (child.classList.contains(selector.slice(1))) return child
      const nested = child.querySelector(selector)
      if (nested !== null) return nested
    }
    return null
  }
  focus(): void {}
}

type Session = { sessionId: string; name: string; updatedAt?: number; archived?: boolean; archivedAtMs?: number; running?: boolean }
type Entry = { sessions: Session[] | null; loading: boolean; error: string; request: Promise<Session[]> | null }
type Call = { method: string; params: Record<string, unknown>; resolve(value: unknown): void; reject(error: unknown): void }

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
  }
  for (const [id, sessions] of [['emp_a', state.sessions], ['emp_b', [{ sessionId: 'b1', name: '会话 B' }]]] as const) {
    state.employeeSessions.set(id, { sessions: [...sessions], loading: false, error: '', request: null })
  }
  const list = new Element('ul')
  const chat = new Element()
  const title = new Element('input')
  const nodes: Record<string, Element> = { sessionList: list, viewChat: chat, newSessionTitle: title }
  const calls: Call[] = []
  const messages: unknown[] = []
  const errors: unknown[] = []
  const scope = vm.createContext({
    state, Promise, Map, Set, Date, JSON,
    $: (id: string) => nodes[id] ?? null,
    document: { createElement: (tag: string) => new Element(tag) },
    rpc: (method: string, params: Record<string, unknown>) => new Promise((resolve, reject) => calls.push({ method, params, resolve, reject })),
    officeSections: () => [{ members: state.employees }],
    LS: {}, writeLocal: () => {}, shortId: (id: string) => id,
    pushRaw: () => {}, toast: () => {}, reportRpcError: (...args: unknown[]) => errors.push(args),
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
  })
  const names = ['el', 'clear', 'pickArray', 'positionList', 'positionName', 'sessionIdOf', 'sessionTitleOf', 'latestSessionId',
    'employeeSessionState', 'cacheEmployeeSessions', 'isRegularSessionTree', 'loadSessionTree',
    'loadSessions', 'reloadEmployeeSessions', 'renderSessions', 'appendSessionRows', 'appendSessionRow', 'renderSessionTree', 'setSessionArchived',
    'selectEmployee', 'createSession', 'renameSession', 'startSessionRename', 'ensureSubscribed', 'openSession',
    'sessionEventSeq', 'mergeSessionHistory', 'renderSessionEvent']
  vm.runInContext(names.map((name) => {
    assert.ok(functions.has(name), `Missing ${name}`)
    return functions.get(name)
  }).join('\n'), scope)
  return { state, list, chat, title, calls, scope, messages, errors }
}

async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)) }

describe('普通聊天页的员工会话树', () => {
  it('高亮与当前标识跟随所选员工，其他员工不带标识', () => {
    const h = harness()
    h.scope.renderSessions()
    assert.equal(h.list.children[0]!.classList.contains('selected'), true)
    assert.equal(h.list.children[0]!.querySelector('.cs-current')!.textContent, '当前')
    assert.equal(h.list.children[1]!.querySelector('.cs-current'), null)
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

  it('秘书页和四宫格页仍显示当前员工的平铺会话', () => {
    for (const layout of ['layout-secretary', 'layout-quad', 'layout-quad layout-quad-chat']) {
      const h = harness()
      h.chat.className = layout
      h.scope.renderSessions()
      assert.equal(h.list.children[0]!.attributes['data-session-id'], 'a1')
      assert.equal(h.list.querySelector('.cs-employee'), null)
      h.scope.loadSessionTree()
      assert.equal(h.calls.length, 0)
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
    const h = harness()
    const selecting = h.scope.selectEmployee('emp_a')
    h.calls[0]!.resolve({ sessions: [{ sessionId: 'a1', name: '归档记录', archived: true }] })
    await selecting
    assert.equal(h.state.selectedSessionId, null)
    assert.equal(h.calls.some(call => ['session.create', 'session.history', 'session.prompt'].includes(call.method)), false)
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
