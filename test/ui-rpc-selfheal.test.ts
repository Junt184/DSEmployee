/**
 * 控制台 rpc() 的自愈兜底 —— 「要么给结果，要么给错误」，绝不永久挂起。
 *
 * 背景（真实缺陷，这一条是**我上一轮自己引入的**）：为了让"IDEMPOTENT_METHODS 表漏项"
 * 不至于让功能整条不可用，rpc() 加了一层自愈：服务端回 `idempotency-key-required` 时
 * 补一个键重发一次。但 `onResponse` 在调用 reject 之前**已经把这个 id 从 pending 里删掉、
 * 并清掉了超时定时器**，而重发沿用了同一个 id ⇒ 重发的应答到达时找不到挂账，被当成
 * "未匹配的响应"丢掉 ⇒ 这个 Promise **既不 resolve 也不 reject**（超时也已经被清了）。
 * 结论：自愈没把功能救回来，反而把"报一条红字"变成了"页面永久卡住"—— 比原来的错误更糟。
 *
 * 测法：**从交付脚本里抠出真实的 `rpc`/`onResponse` 源码**，放进一个受控作用域里跑
 * （`state`/`socket`/`randomId` 都是替身，被测的是真代码）。这样做而不是复刻一份逻辑，
 * 是因为"复刻版测试"只能证明复刻版对 —— 而这个 bug 恰恰藏在真代码的调用顺序里。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderControlUiScript } from '../src/web/ui.ts'

const SCRIPT = renderControlUiScript()

/**
 * 抠出 `function <name>(…) { … }` 的源码（按花括号配对截取）。
 * 前提：这两个函数体内没有"字符串里的花括号"—— 抠不出来时下面的断言会当场失败，
 * 不会静默变成一个空测试。
 */
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

interface Harness {
  rpc: (method: string, params?: unknown, options?: unknown) => Promise<unknown>
  onResponse: (frame: unknown) => void
  state: { pending: Map<string, unknown> }
  /** 已发出去的帧（JSON 解好的） */
  sent: Array<Record<string, unknown>>
}

function makeHarness(): Harness {
  let keySeq = 0
  const sent: Array<Record<string, unknown>> = []
  const state = {
    socket: {
      readyState: 1,
      send: (text: string): void => {
        sent.push(JSON.parse(text) as Record<string, unknown>)
      },
    },
    pending: new Map<string, unknown>(),
    seq: 0,
    rawCount: 0,
  }
  const scope = {
    state,
    sent,
    /* 故意"漏项"：逼着走自愈分支（真实场景里就是表漏了某个方法） */
    IDEMPOTENT_METHODS: {} as Record<string, boolean>,
    randomId: (): string => `key-${(keySeq += 1)}`,
    pushRaw: (): void => undefined,
    describeError: (error: unknown): string => String(error),
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
  }
  /* `with` 让真代码里的自由变量落到替身上；这里刻意不复刻任何业务逻辑 */
  const factory = new Function(
    'scope',
    `with (scope) {
      ${extractFunction('rpc')}
      ${extractFunction('onResponse')}
      return { rpc: rpc, onResponse: onResponse, state: state, sent: sent }
    }`,
  ) as (scope: unknown) => Harness
  return factory(scope)
}

/** 在很短的时间内看这个 Promise 有没有 settle（用来抓"永久挂起"）。 */
async function settleState(promise: Promise<unknown>): Promise<'resolved' | 'rejected' | 'pending'> {
  return await Promise.race<'resolved' | 'rejected' | 'pending'>([
    promise.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 40)),
  ])
}

describe('控制台 rpc 自愈（幂等键兜底）', () => {
  it('抠出来的是真代码（含自愈分支），不是空壳', () => {
    assert.match(extractFunction('rpc'), /idempotency-key-required/)
    assert.match(extractFunction('onResponse'), /state\.pending/)
  })

  it('自愈重发后，重发的应答必须能把 Promise 结掉（旧的永久挂起）', async () => {
    const h = makeHarness()
    const promise = h.rpc('employee.create', { name: '小测' })

    assert.equal(h.sent.length, 1)
    const id = String(h.sent[0]?.id)
    assert.equal(h.sent[0]?.idempotencyKey, undefined, '第一帧本就不该带键（表漏项才需要自愈）')

    // 服务端在派发之前拒了：没有任何副作用，补键重发是安全的
    h.onResponse({ id, ok: false, error: { code: 'idempotency-key-required' } })

    assert.equal(h.sent.length, 2, '应当自动重发一次')
    assert.equal(String(h.sent[1]?.id), id, '重发沿用同一个 id')
    assert.equal(typeof h.sent[1]?.idempotencyKey, 'string', '重发必须带上幂等键')
    assert.equal(await settleState(promise), 'pending', '重发在途时不该提前 settle')

    // 关键断言：重发的应答要能被接上 —— 旧实现在这里永久挂起
    h.onResponse({ id, ok: true, payload: { created: true } })
    assert.deepEqual(await promise, { created: true })
    assert.equal(h.state.pending.size, 0, '结掉之后不该留挂账')
  })

  it('只自愈一次：第二次仍是同类错误就如实报错，不再重发', async () => {
    const h = makeHarness()
    const promise = h.rpc('employee.create', {})
    const id = String(h.sent[0]?.id)

    h.onResponse({ id, ok: false, error: { code: 'idempotency-key-required' } })
    assert.equal(h.sent.length, 2)

    h.onResponse({ id, ok: false, error: { code: 'idempotency-key-required' } })
    assert.equal(h.sent.length, 2, '不该无限重发')
    await assert.rejects(promise, (error: { code?: string }) => error.code === 'idempotency-key-required')
    assert.equal(h.state.pending.size, 0)
  })

  it('自愈之后超时依然有效（重发的应答不来，也不能永远挂着）', async () => {
    const h = makeHarness()
    const promise = h.rpc('employee.create', {}, { timeoutMs: 25 })
    const id = String(h.sent[0]?.id)

    h.onResponse({ id, ok: false, error: { code: 'idempotency-key-required' } })
    assert.equal(h.sent.length, 2)

    await assert.rejects(promise, (error: { code?: string }) => error.code === 'timeout')
    assert.equal(h.state.pending.size, 0, '超时也要出册')
  })

  it('普通失败照旧：立刻 reject 且不留挂账', async () => {
    const h = makeHarness()
    const promise = h.rpc('employee.list', {})
    const id = String(h.sent[0]?.id)

    h.onResponse({ id, ok: false, error: { code: 'forbidden', message: 'nope' } })
    await assert.rejects(promise, (error: { code?: string }) => error.code === 'forbidden')
    assert.equal(h.state.pending.size, 0)
  })

  it('成功路径照旧：resolve payload，缺 payload 时给空对象', async () => {
    const h = makeHarness()
    const withPayload = h.rpc('health', {})
    h.onResponse({ id: String(h.sent[0]?.id), ok: true, payload: { ok: true } })
    assert.deepEqual(await withPayload, { ok: true })

    const withoutPayload = h.rpc('health', {})
    h.onResponse({ id: String(h.sent[1]?.id), ok: true })
    assert.deepEqual(await withoutPayload, {})
  })
})
