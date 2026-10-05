import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import { renderControlUiScript } from '../src/web/ui.ts'

// 执行整份交付脚本，保留真实的恢复、存储、事件归一化和消息渲染。
const script = renderControlUiScript().replace(/\ninit\(\)\s*$/, '')

class Element {
  children: Element[] = []
  parentNode: Element | null = null
  className = ''
  private ownText = ''
  value = ''
  disabled = false
  type = ''
  title = ''
  style: Record<string, string> = {}
  attributes: Record<string, string> = {}
  scrollTop = 0
  scrollHeight = 2000
  clientHeight = 400
  onclick?: (event: { stopPropagation(): void }) => void
  listeners: Record<string, () => void> = {}
  tagName: string
  constructor(tagName = 'div') { this.tagName = tagName }
  get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join('') }
  set textContent(value: string) { this.ownText = value; this.children = [] }
  get firstChild(): Element | null { return this.children[0] ?? null }
  get firstElementChild(): Element | null { return this.firstChild }
  get nextElementSibling(): Element | null {
    if (this.parentNode === null) return null
    return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] ?? null
  }
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
    add: (name: string) => { if (!this.classList.contains(name)) this.className += ' ' + name },
    remove: (name: string) => { this.className = this.className.split(' ').filter((item) => item !== name).join(' ') },
    toggle: (name: string, on?: boolean) => {
      if (on ?? !this.classList.contains(name)) this.classList.add(name)
      else this.classList.remove(name)
    },
  }
  appendChild(child: Element): Element { child.parentNode = this; this.children.push(child); return child }
  removeChild(child: Element): void {
    assert.ok(this.children.includes(child))
    this.children.splice(this.children.indexOf(child), 1)
    child.parentNode = null
  }
  insertBefore(child: Element, anchor: Element | null): void {
    child.parentNode?.removeChild(child)
    if (anchor === null) { this.appendChild(child); return }
    child.parentNode = this
    this.children.splice(this.children.indexOf(anchor), 0, child)
  }
  setAttribute(name: string, value: string): void { this.attributes[name] = value }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null }
  addEventListener(name: string, callback: () => void): void { this.listeners[name] = callback }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null }
  querySelectorAll(selector: string): Element[] {
    const found: Element[] = []
    for (const child of this.children) {
      if (selector.startsWith('.') ? child.classList.contains(selector.slice(1)) : child.tagName === selector) found.push(child)
      found.push(...child.querySelectorAll(selector))
    }
    return found
  }
}

type Call = {
  method: string; params: Record<string, unknown>; settled: boolean;
  resolve(value: unknown): void; reject(value: unknown): void;
}

const employees = [
  { id: 'emp_a', name: '小艾', nodeOnline: true },
  { id: 'emp_b', name: '阿澈', nodeOnline: true },
]

function harness(storage = new Map<string, string>()) {
  const nodes: Record<string, Element> = {}
  for (const id of ['messages', 'promptInput', 'btnSend', 'btnCancel', 'btnChatLatest', 'viewChat']) nodes[id] = new Element()
  nodes['btnChatLatest']!.className = 'hidden'
  const calls: Call[] = [], errors: unknown[] = []
  const scope = vm.createContext({
    document: {
      getElementById: (id: string) => nodes[id] ?? null,
      createElement: (tag: string) => new Element(tag),
      createTextNode: (text: string) => { const node = new Element('#text'); node.textContent = text; return node },
      addEventListener: () => {}, title: '',
    },
    location: { host: 'test.local', search: '' }, navigator: {}, window: {},
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {}, URL, TextEncoder,
  })
  vm.runInContext(script, scope)
  scope.BOOT.hubId = 'hub-test'
  for (const name of [
    'renderEmployees', 'renderSessions', 'renderApprovals', 'renderDevices', 'clearUnread',
    'loadEmployeeAside', 'loadPositions', 'loadNodeOptions', 'loadSessionTree', 'pollDeskStatus',
    'startDeskPolling', 'loadApprovals', 'loadOfficeOrder', 'loadDevices', 'loadPairingWindow',
    'applyPositionShell', 'applyContextFromSessionList', 'updateChatHeader', 'updateEffectivePreset',
    'renderQuadCells', 'stageTurn', 'reconcileSkillDistill', 'reloadQuadFiles', 'stageSpeaking',
    'loadUnread', 'bindEvents', 'placeChatTools', 'renderUiVersion', 'applyTheme', 'applyDensity',
    'applyAsideVisible', 'applyPanelVisible', 'installUiErrorTrap', 'syncSessionCookie',
  ]) scope[name] = () => {}
  scope.shouldAutoConnect = () => false
  scope.reportRpcError = (...args: unknown[]) => errors.push(args)
  scope.rpc = (method: string, params: Record<string, unknown>) => new Promise((resolve, reject) => {
    const call: Call = { method, params, settled: false,
      resolve: (value) => { call.settled = true; resolve(value) },
      reject: (error) => { call.settled = true; reject(error) },
    }
    calls.push(call)
  })
  Object.assign(scope.state, { phase: 'ready', view: 'chat', scopes: ['employee.read', 'employee.prompt'],
    employees, selectedEmployeeId: 'emp_a', selectedSessionId: null })
  function pending(method: string): Call {
    const call = calls.find((entry) => entry.method === method && !entry.settled)
    assert.ok(call, `没有在途 ${method}，实际调用：${calls.map((entry) => entry.method).join(', ')}`)
    return call
  }
  return { scope, state: scope.state, nodes, calls, errors, storage, pending }
}

async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)) }
function history(seq: number, type: string, text = '') {
  return { event: { seq, type, data: type === 'turn/end' ? { reason: { kind: 'completed' } } :
    { message: { content: [{ type: 'text', text }] } } } }
}
function live(seq: number, type: string, text = '', employeeId = 'emp_a', sessionId = 'a1') {
  return { employeeId, sessionId, event: { method: 'session/event', payload: {
    type: 'session/event', sessionId, event: history(seq, type, text).event,
  } } }
}
async function beginHistory(h: ReturnType<typeof harness>, sessionId = 'a1') {
  const start = h.calls.length
  const opening = h.scope.openSession(sessionId)
  h.pending('session.subscribe').resolve({})
  await flush()
  const request = h.calls.slice(start).find((call) => call.method === 'session.history' && !call.settled)
  assert.ok(request)
  return { opening, request }
}

describe('刷新与重新打开后的工作连续性', () => {
  it('启动、连接、加载目录后恢复原页面和原会话，较新的后台会话不会抢走选择', async () => {
    const h = harness(new Map([
      ['dse.lastView', 'chat'], ['dse.lastEmployeeId', 'emp_a'],
      ['dse.lastSessions', JSON.stringify({ emp_a: 'a1' })],
    ]))
    h.scope.init()
    assert.equal(h.state.phase, 'idle')
    assert.equal(h.state.view, 'chat')
    h.scope.onHelloOk({ type: 'hello-ok', auth: { role: 'operator', scopes: ['employee.read', 'employee.prompt'] } })
    h.pending('employee.list').resolve({ employees })
    await flush()
    h.pending('session.list').resolve({ sessions: [{ sessionId: 'a1', updatedAt: 10 }, { sessionId: 'background', updatedAt: 20 }] })
    await flush()
    assert.equal(h.state.selectedSessionId, 'a1')
    h.pending('session.subscribe').resolve({})
    await flush()
    h.pending('session.history').resolve({ events: [history(1, 'assistant/message', '原来的对话')], hasMore: false })
    await flush()
    assert.match(h.nodes['messages']!.textContent, /原来的对话/)
    assert.equal(h.calls.some((call) => call.method === 'session.create'), false)
    assert.deepEqual(h.errors, [])
  })

  it('目录请求返回前用户切换员工，恢复流程不能把选择改回去', async () => {
    const h = harness()
    h.scope.onHelloOk({ type: 'hello-ok', auth: { scopes: ['employee.read', 'employee.prompt'] } })
    h.state.selectedEmployeeId = 'emp_b'
    h.state.employeeSelectionVersion += 1
    h.pending('employee.list').resolve({ employees })
    await flush()
    assert.equal(h.state.selectedEmployeeId, 'emp_b')
    assert.equal(h.calls.some((call) => call.method === 'session.list'), false)
  })

  it('恢复任务、体检等页面时，连接成功后补拉该页面的数据', async () => {
    for (const view of ['jobs', 'health', 'llm', 'officeRoom']) {
      const h = harness(new Map([['dse.lastView', view]]))
      h.state.phase = 'idle'
      const phases: string[] = []
      h.scope.VIEW_LOADERS[view] = () => phases.push(h.state.phase)
      h.scope.init()
      assert.equal(h.state.view, view)
      h.scope.onHelloOk({ type: 'hello-ok', auth: { scopes: ['employee.read', 'employee.prompt'] } })
      h.pending('employee.list').resolve({ employees })
      await flush()
      assert.deepEqual(phases, ['idle', 'ready'])
    }
  })

  it('列表超时或响应格式错误都不能被当作空列表并自动新建', async () => {
    for (const malformed of [false, true]) {
      const h = harness()
      const selection = h.scope.selectEmployee('emp_a')
      if (malformed) h.pending('session.list').resolve({ wrongField: [] })
      else h.pending('session.list').reject({ code: 'timeout' })
      await selection
      assert.equal(h.state.selectedSessionId, null)
      assert.equal(h.calls.some((call) => call.method === 'session.create'), false)
      assert.match(h.nodes['messages']!.textContent, /无法读取会话列表/)
    }
  })

  it('列表失败后保留上次成功读取的列表', async () => {
    const h = harness()
    const first = h.scope.loadSessions()
    h.pending('session.list').resolve({ sessions: [{ sessionId: 'a1' }] })
    await first
    const retry = h.scope.loadSessions()
    h.pending('session.list').resolve({ wrongField: [] })
    await retry
    assert.equal(h.state.sessions[0].sessionId, 'a1')
    assert.equal(h.state.employeeSessions.get('emp_a').sessions[0].sessionId, 'a1')
  })
})

describe('历史、实时输出与阅读位置', () => {
  it('请求期间的新输出与历史重叠时只渲染一次，历史之后的新输出不会被覆盖', async () => {
    const h = harness()
    const { opening, request } = await beginHistory(h)
    h.scope.onSessionEvent(live(2, 'assistant/message', '重叠回复'))
    h.scope.onSessionEvent(live(3, 'assistant/message', '新的回复'))
    request.resolve({ events: [history(1, 'user/message', '问题'), history(2, 'assistant/message', '重叠回复')], hasMore: false })
    await opening
    const text = h.nodes['messages']!.textContent
    assert.equal(text.split('重叠回复').length - 1, 1)
    assert.equal(text.split('新的回复').length - 1, 1)
    h.scope.onSessionEvent(live(3, 'assistant/message', '新的回复'))
    assert.equal(h.nodes['messages']!.textContent, text)
  })

  it('重叠的实时 turn/end 仍能恢复空闲状态', async () => {
    const h = harness()
    h.state.sessions = [{ sessionId: 'a1', running: true }]
    const { opening, request } = await beginHistory(h)
    h.scope.onSessionEvent(live(3, 'turn/end'))
    request.resolve({ events: [history(3, 'turn/end')], hasMore: false })
    await opening
    assert.equal(h.scope.turnRunning, false)
  })

  it('同一会话重连同步失败，旧消息和请求期间的新输出都保留，并能就地重试', async () => {
    const h = harness()
    const first = await beginHistory(h)
    first.request.resolve({ events: [history(1, 'assistant/message', '已有消息')], hasMore: false })
    await first.opening
    const second = await beginHistory(h)
    h.scope.onSessionEvent(live(2, 'assistant/message', '新输出'))
    second.request.reject({ code: 'timeout' })
    await second.opening
    assert.match(h.nodes['messages']!.textContent, /已有消息/)
    assert.match(h.nodes['messages']!.textContent, /新输出/)
    h.nodes['messages']!.querySelector('.history-error')!.querySelector('button')!.onclick!({ stopPropagation() {} })
    assert.equal(h.pending('session.subscribe').params.sessionId, 'a1')
  })

  it('无法识别的历史响应不能清空之前的消息', async () => {
    const h = harness()
    const first = await beginHistory(h)
    first.request.resolve({ events: [history(1, 'assistant/message', '必须保留')], hasMore: false })
    await first.opening
    const retry = await beginHistory(h)
    retry.request.resolve({ wrongField: [] })
    await retry.opening
    assert.match(h.nodes['messages']!.textContent, /必须保留/)
    assert.ok(h.nodes['messages']!.querySelector('.history-error'))
  })

  it('同步请求发出后才向上阅读，也不能在请求完成时跳回底部', async () => {
    const h = harness()
    h.scope.bindChatUi()
    const first = await beginHistory(h)
    first.request.resolve({ events: [history(1, 'assistant/message', '当前消息')], hasMore: false })
    await first.opening
    const retry = await beginHistory(h)
    h.nodes['messages']!.scrollTop = 200
    h.nodes['messages']!.listeners['scroll']!()
    retry.request.resolve({ events: [history(1, 'assistant/message', '当前消息')], hasMore: false })
    await retry.opening
    assert.equal(h.nodes['messages']!.scrollTop, 200)
    assert.equal(h.scope.chatFollowTail, false)
  })

  it('快速离开再回到原会话时，旧分页请求不能插入或改掉新页面的加载状态', async () => {
    const h = harness()
    const first = await beginHistory(h)
    first.request.resolve({ events: [history(10, 'assistant/message', '当前页')], hasMore: true, oldestSeq: 10 })
    await first.opening
    h.scope.loadEarlierHistory()
    const earlier = h.pending('session.history')
    const second = await beginHistory(h)
    second.request.resolve({ events: [history(10, 'assistant/message', '当前页')], hasMore: true, oldestSeq: 10 })
    await second.opening
    h.scope.loadEarlierHistory()
    const current = h.calls.find((call) => call.method === 'session.history' && !call.settled && call !== earlier)!
    earlier.resolve({ events: [history(1, 'assistant/message', '过期旧页')], hasMore: false })
    await flush()
    assert.doesNotMatch(h.nodes['messages']!.textContent, /过期旧页/)
    assert.equal(h.scope.historyLoading, true)
    current.resolve({ events: [history(9, 'assistant/message', '正确旧页')], hasMore: false })
    await flush()
    assert.match(h.nodes['messages']!.textContent, /正确旧页/)
  })

  it('按真实 event.seq 获取历史游标，包含序号零', () => {
    const h = harness()
    assert.equal(h.scope.historyCursor({}, [history(5, 'user/message')]), 5)
    assert.equal(h.scope.historyCursor({ oldestSeq: 0 }, []), 0)
  })

  it('重连同步期间读到的更早记录，也必须保留在合并结果里', async () => {
    const h = harness()
    const first = await beginHistory(h)
    first.request.resolve({ events: [history(10, 'assistant/message', '当前页')], hasMore: true, oldestSeq: 10 })
    await first.opening
    const syncing = await beginHistory(h)
    h.scope.loadEarlierHistory()
    const earlier = h.calls.find((call) => call.method === 'session.history' && !call.settled && call !== syncing.request)!
    earlier.resolve({ events: [history(9, 'assistant/message', '刚加载的更早记录')], hasMore: false })
    await flush()
    syncing.request.resolve({ events: [history(10, 'assistant/message', '当前页')], hasMore: true, oldestSeq: 10 })
    await syncing.opening
    assert.match(h.nodes['messages']!.textContent, /刚加载的更早记录/)
  })

  it('向上阅读时新输出不抢滚动，回到最新按钮可以恢复跟随', () => {
    const h = harness()
    h.state.selectedSessionId = 'a1'
    h.scope.bindChatUi()
    h.nodes['messages']!.scrollTop = 100
    h.nodes['messages']!.listeners['scroll']!()
    h.scope.onSessionEvent(live(1, 'assistant/message', '继续输出'))
    assert.equal(h.nodes['messages']!.scrollTop, 100)
    assert.equal(h.nodes['btnChatLatest']!.classList.contains('hidden'), false)
    h.nodes['btnChatLatest']!.onclick!({ stopPropagation() {} })
    assert.equal(h.nodes['messages']!.scrollTop, 2000)
  })
})

describe('浏览器历史副本', () => {
  it('刷新后节点离线仍能显示之前读过的消息，失败也不会抹掉缓存', async () => {
    const original = harness()
    original.scope.rememberSession('emp_a', 'a1')
    original.scope.rememberSessionList('emp_a', [{ sessionId: 'a1' }])
    original.scope.rememberHistory('emp_a', 'a1', { events: [history(1, 'assistant/message', '已保存的报告')], hasMore: false })
    const h = harness(original.storage)
    h.state.employees = [{ ...employees[0], nodeOnline: false }]
    const selection = h.scope.selectEmployee('emp_a')
    h.pending('session.list').reject({ code: 'node-offline' })
    await flush()
    assert.match(h.nodes['messages']!.textContent, /已保存的报告/)
    h.pending('session.subscribe').resolve({})
    await flush()
    h.pending('session.history').reject({ code: 'node-offline' })
    await selection
    assert.match(h.nodes['messages']!.textContent, /已保存的报告/)
    assert.equal(h.calls.some((call) => call.method === 'session.create'), false)
  })

  it('不同 Hub 的缓存隔离，损坏数据不影响正常加载', () => {
    const h = harness()
    h.scope.rememberHistory('emp_a', 'a1', { events: [history(1, 'assistant/message', 'Hub A')], hasMore: false })
    const other = harness(h.storage)
    other.scope.BOOT.hubId = 'other'
    assert.equal(other.scope.readCachedHistory('emp_a', 'a1'), null)
    const broken = harness(new Map([['dse.workspaceCache.hub-test', '{broken']]))
    assert.equal(broken.scope.readCachedSessions('emp_a'), null)
  })

  it('最近历史数量和总存储体积受限', () => {
    const h = harness()
    for (let i = 0; i < 12; i += 1) h.scope.rememberHistory('emp_a', 'a' + i, {
      events: [history(i, 'assistant/message', '报告'.repeat(100_000))], hasMore: false,
    })
    const stored = h.storage.get('dse.workspaceCache.hub-test')!
    assert.ok(stored.length <= 1000000)
    assert.ok(JSON.parse(stored).histories.length <= 8)
    assert.equal(h.scope.readCachedHistory('emp_a', 'a0'), null)
  })
})

describe('发送回执与附件的会话归属', () => {
  it('只发附件时发送按钮可用', () => {
    const h = harness()
    h.state.selectedSessionId = 'a1'
    h.state.attachments = [{ name: 'report.xlsx' }]
    h.scope.updateSendButton()
    assert.equal(h.nodes['btnSend']!.disabled, false)
  })

  it('A 的回执不清除 B 的附件；同一会话新增的附件也不被清除', async () => {
    for (const switchEmployee of [false, true]) {
      const h = harness()
      const attachment = { name: 'old.xlsx' }, added = { name: 'new.xlsx' }
      h.state.selectedSessionId = 'a1'
      h.state.attachments = [attachment]
      const sending = h.scope.deliverPrompt('原指令', [attachment], null)
      h.pending('session.subscribe').resolve({})
      await flush()
      const prompt = h.pending('session.prompt')
      if (switchEmployee) {
        h.state.selectedEmployeeId = 'emp_b'; h.state.selectedSessionId = 'b1'; h.state.employeeSelectionVersion += 1
        h.state.attachments = [added]
      } else h.state.attachments.push(added)
      prompt.resolve({ accepted: true })
      await sending
      assert.equal(h.state.attachments.length, 1)
      assert.equal(h.state.attachments[0], added)
      assert.equal(prompt.params.employeeId, 'emp_a')
    }
  })

  it('切换后的失败回执不改 B 的运行状态，重发仍发送给 A', async () => {
    const h = harness()
    h.state.selectedSessionId = 'a1'
    const row = new Element()
    const sending = h.scope.deliverPrompt('给 A 的消息', [], row)
    h.pending('session.subscribe').resolve({})
    await flush()
    h.state.selectedEmployeeId = 'emp_b'; h.state.selectedSessionId = 'b1'; h.state.employeeSelectionVersion += 1
    h.scope.setRunning(true)
    h.pending('session.prompt').reject({ code: 'node-offline' })
    await sending
    assert.equal(h.scope.turnRunning, true)
    assert.deepEqual(h.errors, [])
    row.querySelector('button')!.onclick!({ stopPropagation() {} })
    await flush()
    const retry = h.pending('session.prompt')
    assert.equal(retry.params.employeeId, 'emp_a')
    assert.equal(retry.params.sessionId, 'a1')
    retry.resolve({ accepted: true })
    await flush()
    assert.equal(h.scope.turnRunning, true)
  })
})

describe('回合故障的来源与发生时间', () => {
  const atMs = 1790985637372
  function failedEvent(code = 'PI_AI_ERROR', message = 'The service is temporarily unavailable. Please retry later.') {
    return { event: { seq: 4694, time: atMs, type: 'turn/end', data: {
      turn: 1, reason: { kind: 'error', error: { code, message } },
    } } }
  }

  it('历史错误显示原始发生时间、中文说明，并保留原始错误码和文案', async () => {
    const h = harness()
    const first = await beginHistory(h)
    first.request.resolve({ events: [failedEvent()], hasMore: false })
    await first.opening
    const text = h.nodes['messages']!.textContent
    assert.match(text, /历史回合失败/)
    assert.ok(text.includes(new Date(atMs).toLocaleString('zh-CN', { hour12: false })))
    assert.match(text, /模型服务或接入网关暂时不可用/)
    const details = h.nodes['messages']!.querySelector('details')!
    assert.match(details.textContent, /PI_AI_ERROR/)
    assert.match(details.textContent, /The service is temporarily unavailable/)
    assert.equal(h.calls.some(call => call.method === 'session.prompt'), false)
  })

  it('实时嵌套事件仍保留原始时间与错误码，并结束当前运行状态', () => {
    const h = harness()
    h.state.selectedSessionId = 'a1'
    h.scope.setRunning(true)
    const event = { employeeId: 'emp_a', sessionId: 'a1', event: { method: 'session/event',
      payload: { type: 'session/event', event: failedEvent().event } } }
    const normalized = h.scope.normalizeEvent(event)
    assert.equal(normalized.code, 'PI_AI_ERROR')
    assert.equal(normalized.atMs, atMs)
    h.scope.onSessionEvent(event)
    assert.match(h.nodes['messages']!.textContent, /本次回合失败/)
    assert.doesNotMatch(h.nodes['messages']!.textContent, /历史回合失败/)
    assert.equal(h.scope.turnRunning, false)
  })

  it('回看旧的认证错误不停止当前回合，也不自动重新发送指令', () => {
    const h = harness()
    h.scope.setRunning(true)
    h.scope.renderSessionEvent(failedEvent('AUTH', '401 status code (no body)'), false)
    assert.match(h.nodes['messages']!.textContent, /模型接口认证失败/)
    assert.equal(h.scope.turnRunning, true)
    assert.equal(h.calls.length, 0)
  })

  it('未知故障保留原始信息，不被误判为服务不可用；缺失时间时也不编造日期', () => {
    const h = harness()
    h.scope.renderSessionEvent({ event: { seq: 1, type: 'turn/end', data: { reason: {
      kind: 'error', error: { code: 'CUSTOM_FAILURE', message: '<script>故障信息</script>' },
    } } } }, false)
    const messages = h.nodes['messages']!
    assert.equal(messages.querySelector('.err-title')!.textContent, '历史回合失败')
    assert.equal(messages.querySelector('.err-message')!.textContent, '<script>故障信息</script>')
    assert.equal(messages.querySelector('script'), null)
  })
})
