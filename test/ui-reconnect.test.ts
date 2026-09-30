/**
 * 控制台「断线重连后能不能接着用」的护栏。
 *
 * 为什么需要它：节点侧有 `test/downlink.test.ts`、客户端库有 `test/hub-client.test.ts`，
 * 偏偏**最常断的那一层**（浏览器 ↔ Hub）没有任何测试 —— 而它恰好承载着"重连后接着聊"：
 *   1. 重连 → `loadSessions()` + `openSession(选中会话)`（重订订阅 + 重拉历史 + 校正回合态）；
 *   2. `openSession` 里的 `ensureSubscribed()` 必须**重新**订阅（旧订阅随旧连接消失）。
 * 第 2 条的失败方式是静默的：界面看起来"已连接"，但**实时输出永远不再来**，
 * 只有重新点一次会话才会恢复。所以这条必须有测试盯着。
 *
 * 测法沿用本仓库对控制台的做法：把交付脚本里的真函数抠出来，配替身跑。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import path from 'node:path'

import { renderControlUiScript } from '../src/web/ui.ts'
import { CONSOLE_SOURCE } from './console-source.ts'

const SCRIPT = renderControlUiScript()

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

interface SubscribeHarness {
  ensureSubscribed: () => Promise<boolean>
  calls: Array<{ method: string; params: Record<string, unknown> }>
  state: { selectedEmployeeId: string | null; selectedSessionId: string | null; subscribed: string | null }
}

function makeHarness(options: { subscribeFails?: boolean } = {}): SubscribeHarness {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const state = {
    selectedEmployeeId: 'emp_1' as string | null,
    selectedSessionId: 'session-a' as string | null,
    subscribed: null as string | null,
  }
  const scope = {
    state,
    rpc: (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (options.subscribeFails === true) return Promise.reject({ code: 'node-offline', message: 'down' })
      return Promise.resolve({ ok: true })
    },
    pushRaw: () => undefined,
    reportRpcError: () => undefined,
    Promise,
  }
  const factory = new Function(
    'scope',
    `with (scope) { ${extractFunction('ensureSubscribed')} return { ensureSubscribed } }`,
  ) as (scope: unknown) => { ensureSubscribed: () => Promise<boolean> }
  return { ...factory(scope), calls, state }
}

describe('重连后的会话续订（ensureSubscribed）', () => {
  it('未选员工/会话时不订阅（也不报错）', async () => {
    const h = makeHarness()
    h.state.selectedEmployeeId = null
    assert.equal(await h.ensureSubscribed(), false)
    h.state.selectedEmployeeId = 'emp_1'
    h.state.selectedSessionId = null
    assert.equal(await h.ensureSubscribed(), false)
    assert.deepEqual(h.calls, [], '没选会话就不该发请求')
  })

  it('首次订阅：调 session.subscribe 并记住已订阅的会话', async () => {
    const h = makeHarness()
    assert.equal(await h.ensureSubscribed(), true)
    assert.deepEqual(h.calls, [
      { method: 'session.subscribe', params: { employeeId: 'emp_1', sessionId: 'session-a' } },
    ])
    assert.equal(h.state.subscribed, 'session-a')
  })

  it('同一会话重复调用不重复订阅（避免每次渲染都打一次 RPC）', async () => {
    const h = makeHarness()
    await h.ensureSubscribed()
    await h.ensureSubscribed()
    assert.equal(h.calls.length, 1)
  })

  it('**断线重连后必须重新订阅** —— 订阅随旧连接一起消失，不重订就再也收不到实时输出', async () => {
    const h = makeHarness()
    await h.ensureSubscribed()
    // 重连：连接换了，服务端那份 conn.subscriptions 是空的，本地标记也必须清掉
    h.state.subscribed = null
    assert.equal(await h.ensureSubscribed(), true)
    assert.equal(h.calls.length, 2, '重连后必须再发一次 session.subscribe')
    assert.equal(h.state.subscribed, 'session-a')
  })

  it('切会话后订阅跟着切（旧订阅标记不能挡住新会话）', async () => {
    const h = makeHarness()
    await h.ensureSubscribed()
    h.state.selectedSessionId = 'session-b'
    assert.equal(await h.ensureSubscribed(), true)
    assert.equal(h.calls[1]?.params.sessionId, 'session-b')
    assert.equal(h.state.subscribed, 'session-b')
  })

  it('订阅失败时如实返回 false（调用方据此不假装已订阅）', async () => {
    const h = makeHarness({ subscribeFails: true })
    assert.equal(await h.ensureSubscribed(), false)
    assert.equal(h.state.subscribed, null, '失败不能把标记写成已订阅')
  })
})

describe('连接成功后的恢复块（结构护栏）', () => {
  /* 这段是"重连后接着用"的入口：少任何一行，症状都是"看起来已连接、实际没有实时输出"
     或"历史停在断线那一刻"。用源码断言钉住它 —— 它没法用单元测试跑（全是 DOM/网络）。 */
  const block = CONSOLE_SOURCE.slice(
    CONSOLE_SOURCE.indexOf("  if (state.selectedEmployeeId !== null) {\n    loadSessions()"),
    CONSOLE_SOURCE.indexOf('  if (state.selectedEmployeeId !== null) {\n    loadSessions()') + 220,
  )

  it('重连后会重拉会话列表并重新打开选中会话', () => {
    assert.ok(block.length > 0, '找不到连接成功后的恢复块（这段代码可能被挪走了，请同步更新本测试）')
    assert.match(block, /loadSessions\(\)/, '恢复块里必须重拉会话列表')
    assert.match(block, /openSession\(state\.selectedSessionId\)/, '恢复块里必须重新打开选中会话')
  })

  it('openSession 会重新订阅并重拉历史（恢复的另一半）', () => {
    const openSession = extractFunction('openSession')
    assert.match(openSession, /ensureSubscribed\(\)/, 'openSession 必须调 ensureSubscribed')
    assert.match(openSession, /session\.history/, 'openSession 必须重拉历史（断线期间的输出靠它补齐）')
    assert.match(openSession, /setRunning\(/, 'openSession 要按服务端的 running 校正回合态（否则会一直卡"运行中"）')
  })

  it('断线时会清掉订阅标记（否则重连后 ensureSubscribed 会以为还订着）', () => {
    /* closeSocket / 断线路径里必须把 state.subscribed 置回 null */
    const index = CONSOLE_SOURCE.indexOf('function closeSocket()')
    assert.ok(index >= 0, '找不到 closeSocket')
    const body = CONSOLE_SOURCE.slice(index, index + 600)
    assert.match(body, /state\.subscribed = null/, 'closeSocket 里要把订阅标记清空')
  })
})

/* ────────────────── 失败文案：node-offline 要说人话 ────────────────── */

interface FailureHarness {
  describeFailure: (title: string, error: unknown) => string
}

function makeFailureHarness(employees: Array<Record<string, unknown>>, selectedEmployeeId: string | null) {
  const scope = {
    state: { employees, selectedEmployeeId },
    shortenIds: (text: string) => String(text).replace(/[0-9a-f]{16,}/g, (id: string) => id.slice(0, 8) + '…'),
  }
  const factory = new Function(
    'scope',
    `with (scope) {
      ${extractOfflineLabels()}
      ${extractFunction('nodeLabelFromOfflineMessage')}
      ${extractFunction('selectedEmployeeOnNode')}
      ${extractFunction('describeFailure')}
      return { describeFailure }
    }`,
  ) as (scope: unknown) => FailureHarness
  return factory(scope)
}

/** 取 OFFLINE_ACTION_LABELS 字面量：按行找到收尾的 }，不数花括号（值里有中文顿号、键里有下划线）。 */
function extractOfflineLabels(): string {
  const start = CONSOLE_SOURCE.indexOf('var OFFLINE_ACTION_LABELS = {')
  assert.ok(start >= 0, '找不到 OFFLINE_ACTION_LABELS')
  return CONSOLE_SOURCE.slice(start, CONSOLE_SOURCE.indexOf('\n}', start) + 2)
}

const NODE_ID = 'a'.repeat(64)
const EMPLOYEES = [
  { id: 'emp_1', name: '小明', nodeId: NODE_ID, nodeName: '本机Mac' },
  { id: 'emp_2', name: '小艾', nodeId: 'b'.repeat(64), nodeName: '另一台' },
]

describe('失败文案（node-offline 必须说人话）', () => {
  it('报出节点名与员工名，而不是 64 位十六进制', () => {
    const h = makeFailureHarness(EMPLOYEES, 'emp_1')
    const text = h.describeFailure('session.prompt', {
      code: 'node-offline',
      message: `node ${NODE_ID} is not connected`,
    })
    assert.match(text, /本机Mac/, '要说出是哪个节点离线')
    assert.match(text, /小明/, '选中员工正好在那台节点上，要把名字带上')
    assert.doesNotMatch(text, /[0-9a-f]{16,}/, '不能把 64 位 id 原样糊出来')
    assert.match(text, /没有发出去/, '要明确"没发出去"，用户才知道该怎么办')
  })

  /* 文案按"失败的到底是什么动作"分两种：发指令才说"指令没发出去"。
     曾经一律说"指令没发出去"，于是 session.list（刷新页面时）失败也这么说 ——
     那会把人引到"我的消息是不是丢了"，见 test/ui-offline-session.test.ts。 */
  it('不针对当前员工的操作不说成"他的指令没发出去"（employee.create 与选中的员工无关）', () => {
    const h = makeFailureHarness(EMPLOYEES, 'emp_2')
    const text = h.describeFailure('employee.create', {
      code: 'node-offline',
      message: `node ${NODE_ID} is not connected`,
    })
    assert.match(text, /本机Mac/)
    assert.doesNotMatch(text, /小艾/, '当前选中的员工不在这台节点上，不能把它的名字写进来')
    assert.doesNotMatch(text, /指令没有发出去/, '这里没在发指令')
    assert.match(text, /新建员工没能完成/)
  })

  it('消息里没有可识别的节点 id 时，也不退回英文原文', () => {
    const h = makeFailureHarness(EMPLOYEES, null)
    const text = h.describeFailure('session.prompt', { code: 'node-offline', message: 'node is offline' })
    assert.match(text, /没有发出去/)
    assert.doesNotMatch(text, /is offline/, '不要把英文原文透出去')
  })

  it('其它错误照旧：方法名 + 原因，但长 id 要截断', () => {
    const h = makeFailureHarness(EMPLOYEES, 'emp_1')
    const text = h.describeFailure('session.history', {
      code: 'internal',
      message: `session ${'c'.repeat(64)} not found`,
    })
    assert.match(text, /^session\.history 失败：/)
    assert.doesNotMatch(text, /c{16,}/, '长 id 要截断')
    assert.match(text, /cccccccc…/)
  })
})
