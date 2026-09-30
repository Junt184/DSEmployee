/**
 * 工位级「疑似卡死」（线上事故的补课）。
 *
 * 事故现场：员工卡在一个 bash 上，界面一直显示"忙碌/运行中"，**没人发现**——
 * 因为原来的看门狗只在你正开着那个对话时才提示。这一组钉住新的判据：
 *   · 只认「回合在跑 **且** 很久没有事件」；
 *   · 没有 lastEventAtMs（旧节点不报）时**不猜**，不误报；
 *   · 阈值与聊天页看门狗一致（3 分钟），两处不能各说各的。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import vm from 'node:vm'

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

function extractNumber(name: string): number {
  const match = new RegExp(`var ${name} = (\\d+)`).exec(SCRIPT)
  assert.ok(match !== null, `交付脚本里找不到 var ${name}`)
  return Number(match[1])
}

interface Harness {
  deskStallMs: (info: unknown) => number | null
  setNow: (value: number) => void
}

function makeHarness(): Harness {
  /* 用普通对象而不是 Proxy：`with (scope)` 解析名字时走的是 `has` 陷阱，
     没写 has 的 Proxy 会被当成"scope 里没有 Date"，于是悄悄用了真的 Date.now ——
     测试因此看着在跑、其实根本没注入时间（第一次就踩了这个坑）。 */
  let nowValue = 0
  const scope = {
    DESK_STALL_MS: extractNumber('DESK_STALL_MS'),
    Date: { now: (): number => nowValue },
  }
  const factory = new Function(
    'scope',
    `with (scope) {
      ${extractFunction('deskStallMs')}
      return { deskStallMs: deskStallMs }
    }`,
  ) as (scope: unknown) => { deskStallMs: (info: unknown) => number | null }
  const api = factory(scope)
  return {
    deskStallMs: api.deskStallMs,
    setNow: (value: number) => {
      nowValue = value
    },
  }
}

describe('工位级「疑似卡死」', () => {
  it('忙碌且很久没事件 ⇒ 报出卡了多久', () => {
    const h = makeHarness()
    h.setNow(1_000_000)
    const idle = h.deskStallMs({ busy: true, lastEventAtMs: 1_000_000 - 5 * 60_000 })
    assert.equal(idle, 5 * 60_000)
  })

  it('忙碌但刚刚有事件 ⇒ 不报（正常跑着的回合不能被误伤）', () => {
    const h = makeHarness()
    h.setNow(1_000_000)
    assert.equal(h.deskStallMs({ busy: true, lastEventAtMs: 1_000_000 - 30_000 }), null)
  })

  it('空闲 ⇒ 不报（它本来就没在跑）', () => {
    const h = makeHarness()
    h.setNow(1_000_000)
    assert.equal(h.deskStallMs({ busy: false, lastEventAtMs: 1_000_000 - 60 * 60_000 }), null)
  })

  it('没有 lastEventAtMs（旧节点不报这个字段）⇒ 不猜、不误报', () => {
    const h = makeHarness()
    h.setNow(1_000_000)
    assert.equal(h.deskStallMs({ busy: true }), null)
    assert.equal(h.deskStallMs({ busy: true, lastEventAtMs: null }), null)
    assert.equal(h.deskStallMs(undefined), null)
  })

  it('阈值与聊天页看门狗一致：都是 3 分钟（两处不能各说各的）', () => {
    assert.equal(extractNumber('DESK_STALL_MS'), 180_000)
    assert.equal(extractNumber('TURN_STALL_MS'), 180_000)
  })
})

describe('接线（结构护栏）', () => {
  const SOURCE = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'script', '30-office.ts'), 'utf8')

  it('工位轮询把「最后一次事件」一起存下来，并交给桌牌/小屏判定', () => {
    assert.match(SOURCE, /lastEventAtMs: best === null \? null : best\.lastEventAtMs/)
    assert.match(SOURCE, /var stalled = deskStallMs\(deskInfo\)/)
    assert.match(SOURCE, /var stalled = deskStallMs\(info\)/)
  })

  it('卡死徽章优先于「忙碌」（否则用户分不清在动还是死了）', () => {
    assert.match(SOURCE, /formatIdleMinutes\(stalled\) \+ '无输出'/, '徽章陈述事实，不下结论')
    assert.match(SOURCE, /可能在跑长命令，也可能卡住了/, '判断与下一步放在小屏上')
    const css = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'css.ts'), 'utf8')
    assert.match(css, /\.badge\.stall \{ color: var\(--bad\)/, '卡死徽章要用警告色，且**不加**忙碌那个呼吸动画')
  })
})
