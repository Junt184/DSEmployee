/**
 * 上下文占用小圈（顶栏那个环）—— 结构契约 + 真实行为。
 *
 * 为什么值得单独钉一组测试：这个功能**曾经整条链路都在、却一个数字都不显示**。
 * dsh 每次都把 `session/projection` 帧推上来了（节点转发 → Hub → 浏览器），
 * 但控制台解包时把 payload 顶层的 `key`/`value` 吃掉了（通用分支只取 payload.data），
 * 于是那一帧谁都不认识、静默落进 hidden —— 没有报错、没有日志，只是"小圈永远不出现"。
 * 所以这里第一条钉的就是解包那一行。
 *
 * 另外钉住三条"不编数字"的规矩（都是 dsh 自己的做法，照抄）：
 *   ① 占用率读 projectedTokens（下一次请求大概要多少），缺了才退回 pressureTokens；
 *   ② contextWindow 缺失就不显示百分比（适配器没报容量时它就是缺的）；
 *   ③ 只认当前会话 —— 翻旧会话时旧帧还在飞，不比对 sessionId 会画错数字。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { readFileSync } from 'node:fs'
import path from 'node:path'

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

interface FakeEl {
  className: string
  textContent: string
  innerHTML: string
  attrs: Record<string, string>
  style: { values: Record<string, string>; setProperty: (key: string, value: string) => void }
  classList: { add: (c: string) => void; remove: (c: string) => void; toggle: (c: string, on?: boolean) => void; contains: (c: string) => boolean }
  setAttribute: (key: string, value: string) => void
}

function makeEl(): FakeEl {
  const classes = new Set<string>()
  const node: FakeEl = {
    className: '',
    textContent: '',
    innerHTML: '',
    attrs: {},
    style: {
      values: {},
      setProperty: (key: string, value: string): void => void (node.style.values[key] = value),
    },
    classList: {
      add: (name: string): void => void classes.add(name),
      remove: (name: string): void => void classes.delete(name),
      toggle: (name: string, on?: boolean): void => {
        const want = on === undefined ? !classes.has(name) : on
        if (want) classes.add(name)
        else classes.delete(name)
      },
      contains: (name: string): boolean => classes.has(name),
    },
    setAttribute: (key: string, value: string): void => void (node.attrs[key] = value),
  }
  return node
}

interface RingHarness {
  $: (id: string) => FakeEl | null
  state: Record<string, unknown>
  nodes: Record<string, FakeEl>
  unpackMethodPayload: (method: string, payload: unknown) => { type: string; data: unknown }
  normalizeEvent: (envelope: unknown) => Record<string, unknown>
  contextOccupancy: () => { used: number; capacity: number | null; percent: number | null } | null
  applyContextProjection: (n: unknown) => void
  applyContextFromSessionList: () => void
  renderContextRing: () => void
  formatContextTokens: (value: unknown) => string
}

function makeHarness(options: { sessionId?: string | null; context?: Record<string, unknown> } = {}): RingHarness {
  const nodes: Record<string, FakeEl> = { ctxRing: makeEl(), ctxPop: makeEl() }
  nodes['ctxRing']?.classList.add('hidden')
  nodes['ctxPop']?.classList.add('hidden')
  const scope = {
    $: (id: string): FakeEl | null => nodes[id] ?? null,
    state: {
      selectedSessionId: options.sessionId === undefined ? 'ses_1' : options.sessionId,
      sessions: [] as Array<Record<string, unknown>>,
      context: options.context ?? { sessionId: '', pressure: null, breakdown: null, usage: null, live: false },
    },
  }
  const source = [
    extractFunction('unpackMethodPayload'),
    extractFunction('unpackEvent'),
    extractFunction('normalizeEvent'),
    extractFunction('formatContextTokens'),
    extractFunction('contextOccupancy'),
    extractFunction('applyContextProjection'),
    extractFunction('applyContextFromSessionList'),
    'function sessionIdOf(item) { return item && typeof item === "object" ? String(item.sessionId || "") : "" }',
    extractFunction('renderContextPop'),
    extractFunction('renderContextRing'),
    /* normalizeEvent 里其它分支用到的工具（本组测试不触发，但要能通过名字解析） */
    'function isInjectedUserMessage() { return false }',
    'function textFromContent() { return "" }',
    'function unpackChunk() { return null }',
  ].join('\n')
  const factory = new Function(
    ...Object.keys(scope),
    source +
      '\nreturn { unpackMethodPayload: unpackMethodPayload, normalizeEvent: normalizeEvent, ' +
      'contextOccupancy: contextOccupancy, applyContextProjection: applyContextProjection, ' +
      'applyContextFromSessionList: applyContextFromSessionList, ' +
      'renderContextRing: renderContextRing, formatContextTokens: formatContextTokens }',
  ) as (...args: unknown[]) => Omit<RingHarness, '$' | 'state' | 'nodes'>
  return { ...factory(...Object.values(scope)), $: scope.$, state: scope.state as Record<string, unknown>, nodes }
}

/** dsh 真实帧（逐字对齐 dsh-session-projection 的投影帧构造） */
function pressureFrame(sessionId: string, value: Record<string, unknown>, seq = 42): Record<string, unknown> {
  return { type: 'session/projection', sessionId, key: 'contextPressure', value, seq }
}

describe('解包：projection 帧的 key/value 不许被吃掉', () => {
  it('session/projection 的 payload 顶层字段原样留下（这正是小圈一直不显示的根因）', () => {
    const harness = makeHarness()
    const payload = pressureFrame('ses_1', { projectedTokens: 12000, contextWindow: 128000 })
    const unpacked = harness.unpackMethodPayload('session/projection', payload)
    assert.equal(unpacked.type, 'session/projection')
    const data = unpacked.data as Record<string, unknown>
    assert.equal(data['key'], 'contextPressure', 'key 被吃掉了 → 小圈永远不会出现')
    assert.deepEqual(data['value'], { projectedTokens: 12000, contextWindow: 128000 }, 'value 被吃掉了')
    assert.equal(data['sessionId'], 'ses_1')
  })

  it('走真实实时信封（Hub 推来的 {employeeId, event:{method, payload}}）也是 projection', () => {
    const harness = makeHarness()
    /* 形状逐字对齐：节点 #forwardDshEvent → hub.broadcastSessionEvent({employeeId, event:{method, payload}}) */
    const envelope = {
      employeeId: 'emp_x',
      event: { method: 'session/projection', payload: pressureFrame('ses_1', { projectedTokens: 1, contextWindow: 100 }) },
    }
    const n = harness.normalizeEvent(envelope)
    assert.equal(n['kind'], 'projection', JSON.stringify(n))
    assert.equal(n['key'], 'contextPressure')
    assert.equal(n['sessionId'], 'ses_1')
  })

  it('裸帧（顶层直接是 key/value）也不能丢', () => {
    const harness = makeHarness()
    const n = harness.normalizeEvent(pressureFrame('ses_1', { projectedTokens: 1, contextWindow: 100 }))
    assert.equal(n['kind'], 'projection', JSON.stringify(n))
    assert.equal(n['key'], 'contextPressure')
    assert.equal(n['sessionId'], 'ses_1')
  })

  it('别的投影（标题 / todo / 权限…）一律 hidden：不进消息区、不搅状态机', () => {
    const harness = makeHarness()
    for (const key of ['sessionTitle', 'todo', 'permission', 'contextBreakdownX']) {
      const n = harness.normalizeEvent({ type: 'session/projection', sessionId: 'ses_1', key, value: {} })
      assert.equal(n['kind'], 'hidden', key + ' 不该被当成本页的事')
    }
  })

  it('contextBreakdown 也认（点开那一块要用它）', () => {
    const harness = makeHarness()
    const n = harness.normalizeEvent({ type: 'session/projection', sessionId: 'ses_1', key: 'contextBreakdown', value: { systemTokens: 900 } })
    assert.equal(n['kind'], 'projection')
    assert.equal(n['key'], 'contextBreakdown')
  })
})

describe('占用率：不编数字', () => {
  it('优先读 projectedTokens（压缩之后 pressureTokens 会停在压缩前，看起来像没生效）', () => {
    const harness = makeHarness({
      context: { sessionId: 'ses_1', pressure: { pressureTokens: 90000, projectedTokens: 12000, contextWindow: 128000 }, breakdown: null },
    })
    const occupancy = harness.contextOccupancy()
    assert.equal(occupancy?.used, 12000)
    assert.equal(occupancy?.percent, 9)
  })

  it('没有 projectedTokens 才退回 pressureTokens', () => {
    const harness = makeHarness({ context: { sessionId: 'ses_1', pressure: { pressureTokens: 64000, contextWindow: 128000 }, breakdown: null } })
    assert.equal(harness.contextOccupancy()?.percent, 50)
  })

  it('capacity 缺失 → percent 为 null（适配器没报容量时它就是缺的）', () => {
    const harness = makeHarness({ context: { sessionId: 'ses_1', pressure: { projectedTokens: 5000 }, breakdown: null } })
    const occupancy = harness.contextOccupancy()
    assert.equal(occupancy?.used, 5000)
    assert.equal(occupancy?.percent, null)
  })

  it('超过容量夹到 100（dsh 自己也是这么夹的）', () => {
    const harness = makeHarness({ context: { sessionId: 'ses_1', pressure: { projectedTokens: 300000, contextWindow: 128000 }, breakdown: null } })
    assert.equal(harness.contextOccupancy()?.percent, 100)
  })

  it('一个数字都没有 → null（不显示 0%）', () => {
    const harness = makeHarness({ context: { sessionId: 'ses_1', pressure: {}, breakdown: null } })
    assert.equal(harness.contextOccupancy(), null)
  })

  it('帧属于别的会话 → 不采信（翻旧会话时旧帧还在飞）', () => {
    const harness = makeHarness({ sessionId: 'ses_2' })
    harness.applyContextProjection({ kind: 'projection', key: 'contextPressure', sessionId: 'ses_1', value: { projectedTokens: 1, contextWindow: 10 } })
    assert.equal(harness.contextOccupancy(), null)
    assert.equal((harness.state['context'] as Record<string, unknown>)['pressure'], null)
  })

  it('同一会话的帧收下；换会话时把上一份作废', () => {
    const harness = makeHarness({ sessionId: 'ses_1' })
    harness.applyContextProjection({ kind: 'projection', key: 'contextPressure', sessionId: 'ses_1', value: { projectedTokens: 1000, contextWindow: 10000 } })
    assert.equal(harness.contextOccupancy()?.percent, 10)
    harness.state['selectedSessionId'] = 'ses_2'
    assert.equal(harness.contextOccupancy(), null, '换了会话，旧数字不许继续显示')
    harness.applyContextProjection({ kind: 'projection', key: 'contextPressure', sessionId: 'ses_2', value: { projectedTokens: 5000, contextWindow: 10000 } })
    assert.equal(harness.contextOccupancy()?.percent, 50)
  })
})

describe('小圈的显示', () => {
  it('没有数据 → 藏着（不是显示 0%）', () => {
    const harness = makeHarness()
    harness.renderContextRing()
    assert.equal(harness.nodes['ctxRing']?.classList.contains('hidden'), true)
  })

  it('有数据 → 显示，并把百分比写进 data-pct / --ctx-pct', () => {
    const harness = makeHarness({ context: { sessionId: 'ses_1', pressure: { projectedTokens: 32000, contextWindow: 128000 }, breakdown: null } })
    harness.renderContextRing()
    const ring = harness.nodes['ctxRing'] as FakeEl
    assert.equal(ring.classList.contains('hidden'), false)
    assert.equal(ring.attrs['data-pct'], '25')
    assert.equal(ring.style.values['--ctx-pct'], '25')
    assert.equal(ring.attrs['data-unknown'], '0')
    assert.ok(String(ring.attrs['title']).includes('32k'), '悬停要说清用了多少：' + String(ring.attrs['title']))
    assert.ok(String(ring.attrs['title']).includes('128k'), '也要说清容量')
  })

  it('快满（≥85%）转告警色 —— 那是"该压缩了"的唯一提示', () => {
    const harness = makeHarness({ context: { sessionId: 'ses_1', pressure: { projectedTokens: 120000, contextWindow: 128000 }, breakdown: null } })
    harness.renderContextRing()
    assert.equal(harness.nodes['ctxRing']?.classList.contains('hot'), true)
  })

  it('容量缺失 → 标成"未知"（斜纹）而不是画成 0%', () => {
    const harness = makeHarness({ context: { sessionId: 'ses_1', pressure: { projectedTokens: 9000 }, breakdown: null } })
    harness.renderContextRing()
    const ring = harness.nodes['ctxRing'] as FakeEl
    assert.equal(ring.attrs['data-unknown'], '1')
    assert.ok(String(ring.attrs['title']).includes('没报容量'), String(ring.attrs['title']))
  })

  it('点开那块给总量与估算构成，并标明"估算"', () => {
    const harness = makeHarness({
      context: {
        sessionId: 'ses_1',
        pressure: { projectedTokens: 12000, contextWindow: 128000 },
        breakdown: { systemTokens: 3000, toolsTokens: 6000, messageTokens: 2500 },
      },
    })
    harness.nodes['ctxPop']?.classList.add('open')
    harness.renderContextRing()
    const html = String(harness.nodes['ctxPop']?.innerHTML)
    assert.ok(html.includes('已用'), html)
    assert.ok(html.includes('系统提示'), html)
    assert.ok(html.includes('估算'), '估算构成必须标注是估算（三项之和 ≠ 总量）：' + html)
  })
})

describe('token 数字的写法', () => {
  it('按 dsh 的读法缩写：12k / 128k / 1.2M', () => {
    const harness = makeHarness()
    assert.equal(harness.formatContextTokens(12000), '12k')
    assert.equal(harness.formatContextTokens(128000), '128k')
    assert.equal(harness.formatContextTokens(1200000), '1.2M')
    assert.equal(harness.formatContextTokens(940), '940')
  })

  it('拿不到数字就不编（undefined / null / NaN / 负数都返回空串）', () => {
    const harness = makeHarness()
    for (const bad of [undefined, null, Number.NaN, -1, '123']) {
      assert.equal(harness.formatContextTokens(bad), '', String(bad) + ' 不该被编成一个数字')
    }
  })
})

describe('环的尺寸：全局 button 规则不许把它撑成椭圆', () => {
  it('CSS 里必须把按钮的 min-height / padding / border 显式清零', () => {
    const css = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'css.ts'), 'utf8')
    const block = /\.ctx-ring \{([^}]*)\}/.exec(css)?.[1] ?? ''
    assert.ok(block !== '', '找不到 .ctx-ring 规则')
    assert.ok(/min-height:\s*0/.test(block), '全局 button 有 min-height:36px —— 不压掉环会变成 20×36 的椭圆：' + block)
    assert.ok(/padding:\s*0/.test(block), '要清掉 button 的 padding')
    assert.ok(/border:\s*none/.test(block), '要清掉 button 的边框（否则环上会多一圈方框）')
    assert.ok(/border-radius:\s*50%/.test(block), '圆环得是圆的')
  })
})

describe('打开会话就先填上（会话列表里本来就带着投影）', () => {
  /** dsh 的 SessionSummary：items[].projections.values —— 已用真实 /api/session.list 逐字确认 */
  const summary = (sessionId: string, values: Record<string, unknown>): Record<string, unknown> => ({
    sessionId,
    cwd: '/tmp/x',
    projections: { asOfSeq: 12, values },
  })

  it('选中会话 → 从会话列表取 contextPressure / contextBreakdown 填进 state', () => {
    const harness = makeHarness({ sessionId: 'ses_1' })
    harness.state['sessions'] = [
      summary('ses_9', { contextPressure: { projectedTokens: 999, contextWindow: 1000 } }),
      summary('ses_1', {
        contextPressure: { projectedTokens: 25000, contextWindow: 100000 },
        contextBreakdown: { systemTokens: 1000, toolsTokens: 20000, messageTokens: 4000 },
      }),
    ]
    harness.applyContextFromSessionList()
    assert.equal(harness.contextOccupancy()?.percent, 25, '应当用选中会话那一行，不是列表第一行')
    assert.equal((harness.state['context'] as Record<string, unknown>)['live'], false, '这是快照，不是实时帧')
  })

  it('会话还没跑过回合（contextPressure 是空对象）→ 环继续藏着，不编 0%', () => {
    const harness = makeHarness({ sessionId: 'ses_1' })
    harness.state['sessions'] = [summary('ses_1', { contextPressure: {}, contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 } })]
    harness.applyContextFromSessionList()
    assert.equal(harness.contextOccupancy(), null)
    harness.renderContextRing()
    assert.equal(harness.nodes['ctxRing']?.classList.contains('hidden'), true)
  })

  it('收到过实时帧就不许被列表快照盖回去（列表是打开那一刻的旧数）', () => {
    const harness = makeHarness({ sessionId: 'ses_1' })
    harness.state['sessions'] = [summary('ses_1', { contextPressure: { projectedTokens: 1000, contextWindow: 10000 } })]
    harness.applyContextProjection({ kind: 'projection', key: 'contextPressure', sessionId: 'ses_1', value: { projectedTokens: 8000, contextWindow: 10000 } })
    assert.equal(harness.contextOccupancy()?.percent, 80)
    harness.applyContextFromSessionList()
    assert.equal(harness.contextOccupancy()?.percent, 80, '实时帧更可信，列表快照不许把它顶成 10%')
  })

  it('列表里没有这一会话 / 没有 projections 字段 → 什么都不做（不抛错）', () => {
    const harness = makeHarness({ sessionId: 'ses_1' })
    harness.state['sessions'] = [{ sessionId: 'ses_2' }, { sessionId: 'ses_1' }]
    harness.applyContextFromSessionList()
    assert.equal(harness.contextOccupancy(), null)
  })
})

describe('点开那块：累计用量', () => {
  const withUsage = (usage: Record<string, unknown>) => ({
    sessionId: 'ses_1',
    pressure: { projectedTokens: 12000, contextWindow: 128000 },
    breakdown: { systemTokens: 3000, toolsTokens: 6000, messageTokens: 2500 },
    usage,
    live: true,
  })

  it('实时帧里的 tokenUsage 存下来，点开就显示累计输入/输出', () => {
    /* 真实链路里两者一起来（同一次 provider 用量同时推 tokenUsage 与 contextPressure）；
       环要先有占用才画得出来，点开那块才有地方写累计 —— 所以这里也给上 pressure。 */
    const harness = makeHarness({
      sessionId: 'ses_1',
      context: { sessionId: 'ses_1', pressure: { projectedTokens: 12000, contextWindow: 128000 }, breakdown: null, usage: null, live: true },
    })
    harness.applyContextProjection({ kind: 'projection', key: 'tokenUsage', sessionId: 'ses_1', value: { uncachedInputTokens: 191, outputTokens: 1593, cacheReadTokens: 123264 } })
    assert.deepEqual((harness.state['context'] as Record<string, unknown>)['usage'], { uncachedInputTokens: 191, outputTokens: 1593, cacheReadTokens: 123264 })
    harness.nodes['ctxPop']?.classList.add('open')
    harness.renderContextRing()
    const html = String(harness.nodes['ctxPop']?.innerHTML)
    assert.ok(html.includes('累计输入'), html)
    assert.ok(html.includes('未命中 191'), '未命中要单独列：' + html)
    assert.ok(html.includes('命中 123.3k'), '缓存命中要单独列（和未命中不是一个价）：' + html)
    assert.ok(html.includes('累计输出'), html)
    assert.ok(html.includes('1.6k'), html)
    assert.ok(html.includes('此刻的占用'), '要说清累计与"已用"口径不同：' + html)
  })

  it('列表快照里的 tokenUsage 也带上（打开就点开也有数）', () => {
    const harness = makeHarness({ sessionId: 'ses_1' })
    harness.state['sessions'] = [
      { sessionId: 'ses_1', projections: { asOfSeq: 9, values: { contextPressure: { projectedTokens: 5000, contextWindow: 100000 }, tokenUsage: { uncachedInputTokens: 10, outputTokens: 20 } } } },
    ]
    harness.applyContextFromSessionList()
    harness.nodes['ctxPop']?.classList.add('open')
    harness.renderContextRing()
    const html = String(harness.nodes['ctxPop']?.innerHTML)
    assert.ok(html.includes('累计输入'), html)
    assert.ok(html.includes('累计输出'), html)
  })

  it('没有累计数据时不编：那两行根本不出现', () => {
    const harness = makeHarness({ context: withUsage({}) })
    harness.nodes['ctxPop']?.classList.add('open')
    harness.renderContextRing()
    const html = String(harness.nodes['ctxPop']?.innerHTML)
    assert.ok(!html.includes('累计输入'), '一个数字都没有就不该有这一行：' + html)
    assert.ok(!html.includes('累计输出'), html)
  })

  it('只有输出、没有输入时也照实显示（缺的那半边不编 0）', () => {
    const harness = makeHarness({ context: withUsage({ outputTokens: 700 }) })
    harness.nodes['ctxPop']?.classList.add('open')
    harness.renderContextRing()
    const html = String(harness.nodes['ctxPop']?.innerHTML)
    assert.ok(html.includes('累计输出'), html)
    assert.ok(!html.includes('累计输入'), '没有输入数据就别显示这一行：' + html)
  })
})

describe('浮层的排版：标签不许折行', () => {
  it('标签单行 + 浮层够宽（实测踩过：190px 时"累计输入"被折成"累计/输入"，读起来像两个词）', () => {
    const css = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'css.ts'), 'utf8')
    const label = /\.ctx-pop-row > span \{([^}]*)\}/.exec(css)?.[1] ?? ''
    assert.ok(/white-space:\s*nowrap/.test(label), '标签必须禁止折行：' + label)
    assert.ok(/flex:\s*0 0 auto/.test(label), '标签不许被长数字挤扁：' + label)
    const pop = /\.ctx-pop \{([^}]*)\}/.exec(css)?.[1] ?? ''
    const minWidth = Number(/\.ctx-pop \{[^}]*min-width:\s*(\d+)px/.exec(css)?.[1] ?? '0')
    assert.ok(minWidth >= 240, '浮层要放得下"未命中 81.1k · 命中 4.2M · 写入 0"这种长值，实测至少 240px：' + String(minWidth))
    assert.ok(/max-width:\s*min\(/.test(pop), '窄屏要限宽，别顶出屏幕：' + pop)
  })
})
