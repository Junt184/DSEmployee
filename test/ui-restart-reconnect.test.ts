/**
 * 服务端重启后的自动重连。
 *
 * 现场（"页面显示不及时"的真机制之一）：hub 部署或重启时会先给客户端发一个 `shutdown`
 * 事件，再关闭连接。旧实现把这件事塞进 `state.manualClose`（那个字段的语义是
 * **用户按了「断开」**），而 `onSocketClosed` 恰恰用它判断"要不要重连"——
 * 于是收到 shutdown 之后**再也不重连**：页面停在"服务端正在关闭。"，
 * 审批推送收不到、按钮点了发不出去，在人眼里就是"这页不更新了 / 点了没用"。
 * 而 hub 重启只要几秒。
 *
 * 这个文件盯三件事：
 *   1. 重连节奏（前两次 2 秒、之后 5 秒、试满上限就放弃并叫人刷新）；
 *   2. 重启期间"连不上"不能终止重试（一次失败的尝试会置 expectClose，
 *      判定必须放在那个提前 return 之前）；
 *   3. shutdown 与「断开」两件事不许再共用 manualClose。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderControlUiScript } from '../src/web/ui.ts'

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

interface Harness {
  delays: number[]
  banners: { text: string; kind: string }[]
  state: { restartPending: boolean; restartTries: number }
  run: () => void
}

/** 用交付脚本里的真源码建沙箱：state / setBanner / scheduleReconnect 全换替身。 */
function makeHarness(): Harness {
  const delays: number[] = []
  const banners: { text: string; kind: string }[] = []
  const state = { restartPending: true, restartTries: 0 }
  const factory = new Function(
    'state',
    'setBanner',
    'scheduleReconnect',
    'SERVER_RESTART_RETRY_MAX',
    'isFinite',
    'Number',
    extractFunction('restartReconnectDelay') +
      '\n' +
      extractFunction('scheduleServerRestartReconnect') +
      '\nreturn { scheduleServerRestartReconnect: scheduleServerRestartReconnect }',
  ) as (...args: unknown[]) => { scheduleServerRestartReconnect: () => void }
  const api = factory(
    state,
    (text: string, kind: string) => void banners.push({ text, kind }),
    (delay: number) => void delays.push(delay),
    3,
    isFinite,
    Number,
  )
  return { state, delays, banners, run: api.scheduleServerRestartReconnect }
}

describe('重启重连：节奏', () => {
  it('前两次 2 秒（hub 重启很快），之后 5 秒，试满上限返回 0 = 放弃', () => {
    const delays = new Function(
      'SERVER_RESTART_RETRY_MAX',
      'isFinite',
      'Number',
      extractFunction('restartReconnectDelay') + '\nreturn restartReconnectDelay',
    )(5, isFinite, Number) as (tries: unknown) => number
    assert.equal(delays(1), 2000)
    assert.equal(delays(2), 2000)
    assert.equal(delays(3), 5000)
    assert.equal(delays(5), 5000)
    assert.equal(delays(6), 0, '超过上限 = 放弃')
    assert.equal(delays(0), 2000, '计数异常时给一个可用的节奏，别算出 NaN 让 setTimeout 立刻狂转')
    assert.equal(delays(undefined), 2000)
    assert.equal(delays('x'), 2000)
  })
})

describe('重启重连：一轮一轮试，试满就说人话', () => {
  it('每次重试都排下一次连接，并在横幅里说第几次', () => {
    const h = makeHarness()
    h.run()
    assert.equal(h.state.restartTries, 1)
    assert.deepEqual(h.delays, [2000])
    const first = h.banners[0]
    assert.ok(first !== undefined)
    assert.ok(first.text.indexOf('第 1 次') >= 0, first.text)
    assert.equal(first.kind, 'warn')
    h.run()
    assert.deepEqual(h.delays, [2000, 2000])
  })

  it('试满上限：不再排连接，改成一条"去刷新"的红字', () => {
    const h = makeHarness()
    for (let i = 0; i < 5; i += 1) h.run()
    assert.equal(h.delays.length, 3, '只有 3 次真的排了连接')
    assert.equal(h.state.restartPending, false, '放弃时要收掉"正在重启"标志')
    const last = h.banners[h.banners.length - 1]
    assert.equal(last?.kind, 'bad')
    assert.ok(last?.text.indexOf('刷新') >= 0, String(last?.text))
  })
})

describe('重启重连：接线（源码级）', () => {
  it('shutdown 事件不再冒充「用户断开」，而是转入重启重连', () => {
    const shutdownAt = SCRIPT.indexOf("if (event === 'shutdown') {")
    assert.ok(shutdownAt >= 0)
    const body = SCRIPT.slice(shutdownAt, shutdownAt + 700)
    assert.equal(
      body.indexOf('state.manualClose = true'),
      -1,
      'shutdown 又去动 manualClose 了 —— 那会让 onSocketClosed 判定"不要重连"',
    )
    assert.ok(body.indexOf('state.restartPending = true') >= 0, 'shutdown 要转入重启重连')
  })

  it('onSocketClosed 先看 restartPending，再看 expectClose（否则一次失败就永久放弃）', () => {
    const body = extractFunction('onSocketClosed')
    const restartAt = body.indexOf('if (state.restartPending === true) {')
    const expectAt = body.indexOf('if (state.expectClose) {')
    assert.ok(restartAt >= 0, 'onSocketClosed 没有处理 restartPending')
    assert.ok(expectAt >= 0, 'expectClose 分支不见了？')
    assert.ok(restartAt < expectAt, '重启判定必须在 expectClose 提前 return 之前')
  })

  it('那个分支里必须先把相位搬走 —— connectNow 见到 ready/connecting 会直接返回', () => {
    const body = extractFunction('onSocketClosed')
    const branchAt = body.indexOf('if (state.restartPending === true) {')
    const branch = body.slice(branchAt, body.indexOf('return', branchAt))
    assert.ok(
      branch.indexOf("setPhase('closed'") >= 0,
      '没搬相位：connectNow 会在 phase=ready 时直接返回，重连永远不执行（这道修复自己踩过）',
    )
    /* 顺带钉住那个前提：connectNow 的早退条件真的存在 */
    assert.ok(
      extractFunction('connectNow').indexOf("state.phase === 'connecting' || state.phase === 'ready'") >= 0,
      'connectNow 的早退条件变了，这条测试的前提要重新看',
    )
  })

  it('连上之后清零（否则下一次断开会被误判成"还在重启"）', () => {
    const body = extractFunction('onHelloOk')
    assert.ok(body.indexOf('state.restartPending = false') >= 0)
    assert.ok(body.indexOf('state.restartTries = 0') >= 0)
  })

  it('两个状态在 state 里都有初值（脚本全局守卫也会查，这里把语义钉在测试里）', () => {
    assert.ok(SCRIPT.indexOf('restartPending: false') >= 0)
    assert.ok(SCRIPT.indexOf('restartTries: 0') >= 0)
  })
})
