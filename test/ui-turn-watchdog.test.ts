/**
 * 回合看门狗：回合在跑、却长时间没有任何事件 ⇒ 提示可能卡住。
 *
 * 为什么需要：dsh 或模型侧卡住时，`turn/end` 永远不会来，界面就一直显示"运行中"——
 * 用户不知道该等还是该处理。看门狗只做两件事：**提示一次**，并给出可执行的下一步
 * （点停止后重发）；它**不自动取消**（自动取消会打断一个只是慢的回合，风险更大）。
 *
 * 这一组用真源码 + 假环境跑：时间、回合状态、员工列表都由替身控制，
 * 于是"卡住 3 分钟"这种场景能在毫秒内验完。
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

interface WatchHarness {
  checkTurnWatchdog: () => void
  sys: string[]
  env: {
    turnRunning: boolean
    turnStallWarned: boolean
    turnLastEventAt: number
    TURN_STALL_MS: number
    state: { employees: Array<Record<string, unknown>>; selectedEmployeeId: string | null }
    now: number
  }
}

function makeHarness(options: {
  running: boolean
  idleMs: number
  nodeOnline?: boolean
  warned?: boolean
}): WatchHarness {
  const sys: string[] = []
  const env = {
    turnRunning: options.running,
    turnStallWarned: options.warned === true,
    turnLastEventAt: 0,
    TURN_STALL_MS: 180_000,
    state: {
      employees: [{ id: 'emp_1', name: '小明', nodeOnline: options.nodeOnline !== false }],
      selectedEmployeeId: 'emp_1' as string | null,
    },
    now: 1_000_000_000,
  }
  env.turnLastEventAt = env.now - options.idleMs
  const scope = {
    appendSystem: (text: string) => void sys.push(text),
    Date: { now: () => env.now },
    state: env.state,
    get turnRunning() {
      return env.turnRunning
    },
    get turnStallWarned() {
      return env.turnStallWarned
    },
    get turnLastEventAt() {
      return env.turnLastEventAt
    },
    get TURN_STALL_MS() {
      return env.TURN_STALL_MS
    },
    setTurnStallWarned: (value: boolean) => {
      env.turnStallWarned = value
    },
  }
  /* 真源码里对 turnStallWarned 有写操作（= true），with + getter 无法接收赋值，
     所以这里用一个可写代理对象承载这几个模块级变量 */
  const box = {
    appendSystem: scope.appendSystem,
    Date: scope.Date,
    state: env.state,
    turnRunning: env.turnRunning,
    turnStallWarned: env.turnStallWarned,
    turnLastEventAt: env.turnLastEventAt,
    TURN_STALL_MS: env.TURN_STALL_MS,
  }
  const factory = new Function(
    'scope',
    `with (scope) {
      ${extractFunction('checkTurnWatchdog')}
      return { checkTurnWatchdog: checkTurnWatchdog, read: () => turnStallWarned }
    }`,
  ) as (scope: unknown) => { checkTurnWatchdog: () => void; read: () => boolean }
  const api = factory(box)
  return {
    checkTurnWatchdog: api.checkTurnWatchdog,
    sys,
    env: {
      ...env,
      get turnStallWarned() {
        return api.read()
      },
      set turnStallWarned(value: boolean) {
        box.turnStallWarned = value
      },
    } as WatchHarness['env'],
  }
}

describe('回合看门狗', () => {
  it('回合没在跑 → 不提示（空闲不该被当成卡住）', () => {
    const h = makeHarness({ running: false, idleMs: 10 * 60_000 })
    h.checkTurnWatchdog()
    assert.deepEqual(h.sys, [])
  })

  it('刚有事件 → 不提示（正常情况下 dsh 会持续吐 chunk）', () => {
    const h = makeHarness({ running: true, idleMs: 30_000 })
    h.checkTurnWatchdog()
    assert.deepEqual(h.sys, [])
  })

  it('静默超过阈值 → 提示一次，并给出"点停止后重发"的下一步', () => {
    const h = makeHarness({ running: true, idleMs: 4 * 60_000 })
    h.checkTurnWatchdog()
    assert.equal(h.sys.length, 1)
    assert.match(h.sys[0] ?? '', /4 分钟/)
    assert.match(h.sys[0] ?? '', /停止/)
    assert.match(h.sys[0] ?? '', /只提示一次/)
  })

  it('只提示一次（每 5 秒扫一次，不能刷屏）', () => {
    const h = makeHarness({ running: true, idleMs: 4 * 60_000 })
    h.checkTurnWatchdog()
    h.checkTurnWatchdog()
    h.checkTurnWatchdog()
    assert.equal(h.sys.length, 1)
  })

  it('节点离线时提示里点明这一点（用户得先知道节点不通）', () => {
    const h = makeHarness({ running: true, idleMs: 4 * 60_000, nodeOnline: false })
    h.checkTurnWatchdog()
    assert.match(h.sys[0] ?? '', /节点当前离线/)
  })

  it('已经提示过就不再重复（警示标志由 setRunning/事件复位）', () => {
    const h = makeHarness({ running: true, idleMs: 4 * 60_000, warned: true })
    h.checkTurnWatchdog()
    assert.deepEqual(h.sys, [])
  })
})

describe('看门狗的接线（结构护栏）', () => {
  it('存活检查里会顺带扫一次看门狗（每 5 秒）', () => {
    const index = SCRIPT.indexOf('function livenessCheck()')
    assert.ok(index >= 0)
    const body = SCRIPT.slice(index, index + 700)
    assert.match(body, /checkTurnWatchdog\(\)/, 'livenessCheck 里要调看门狗')
  })

  it('回合起止与事件到达都要复位计时（否则会对着空闲回合误报）', () => {
    const setRunning = extractFunction('setRunning')
    assert.match(setRunning, /turnLastEventAt = running === true \? Date\.now\(\) : 0/)
    assert.match(setRunning, /turnStallWarned = false/)
    const onSessionEvent = extractFunction('onSessionEvent')
    assert.match(onSessionEvent, /turnLastEventAt = Date\.now\(\)/)
    assert.match(onSessionEvent, /turnStallWarned = false/)
  })
})
