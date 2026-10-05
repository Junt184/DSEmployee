/**
 * session-payload 纯函数测试：历史瘦身（丢系统事件 / 截断 / base64 占位 / 超大占位）、
 * 分页（条数 / 字节 / hasMore / oldestSeq / beforeSeq 翻页链 / 保序）、实时限幅，
 * 以及空输入 / 垃圾输入的 fail-safe。
 *
 * 全部不打网络：被测模块是纯函数（src/node/session-payload.ts）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  HISTORY_MAX_EVENT_BYTES,
  IMAGE_PLACEHOLDER,
  historyEntrySeq,
  pageEvents,
  sanitizeHistoryEvents,
  sanitizeLiveEvent,
} from '../src/node/session-payload.ts'

/** 造一条历史行 `{event:{type, seq, time, data}}`（dsh 实测形状）。 */
function entry(seq: number, type = 'assistant/chunk', data: unknown = { text: `event ${seq}` }): {
  event: { type: string; seq: number; time: number; data: unknown }
} {
  return { event: { type, seq, time: 1_800_000_000_000 + seq, data } }
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/* ────────────────────────── sanitizeHistoryEvents ────────────────────────── */

describe('sanitizeHistoryEvents', () => {
  it('长报告与长指令在历史和实时定稿中保留完整正文，工具摘要仍限幅', () => {
    const text = '这是一份需要完整回看的报告。'.repeat(800)
    for (const type of ['user/message', 'assistant/message']) {
      const event = entry(1, type, { message: { content: [{ type: 'text', text }] } })
      const history = sanitizeHistoryEvents([event]) as typeof event[]
      assert.deepEqual(history[0], event)
      const live = { method: 'session/event', payload: { type: 'session/event', sessionId: 's1', event: event.event } }
      assert.deepEqual(sanitizeLiveEvent(live), live)
    }
    const limited = sanitizeHistoryEvents([entry(2, 'tool/result', { text })]) as ReturnType<typeof entry>[]
    assert.ok((limited[0]!.event.data as { text: string }).text.includes('截断'))
  })

  it('丢弃 request/header 与 request/context，其余事件保留且保序', () => {
    const out = sanitizeHistoryEvents([
      entry(1, 'request/header', { headers: 'x'.repeat(10_000) }),
      entry(2, 'user/message'),
      entry(3, 'request/context', { context: 'y'.repeat(10_000) }),
      entry(4, 'assistant/message'),
    ])
    assert.equal(out.length, 2)
    assert.deepEqual(
      out.map((e) => historyEntrySeq(e)),
      [2, 4],
    )
  })

  it('长字符串截断：前 4000 字符 + 截断标注（嵌套字段同样生效）', () => {
    const long = `汉字${'x'.repeat(10)}`.repeat(400) // 4800 字符，含非 base64 字符
    assert.ok(long.length > 4000)
    const out = sanitizeHistoryEvents([
      entry(1, 'tool/result', { result: long, nested: { list: ['ok', long] } }),
    ])
    const data = (out[0] as { event: { data: { result: string; nested: { list: string[] } } } })
      .event.data
    const expectPrefix = long.slice(0, 4000)
    assert.equal(data.result, `${expectPrefix}…[截断，原 ${long.length} 字符]`)
    assert.equal(data.nested.list[0], 'ok')
    assert.equal(data.nested.list[1], `${expectPrefix}…[截断，原 ${long.length} 字符]`)
  })

  it('未超长的字符串原样保留', () => {
    const text = 'a'.repeat(3999)
    const out = sanitizeHistoryEvents([entry(1, 'assistant/message', { text })])
    assert.equal((out[0] as { event: { data: { text: string } } }).event.data.text, text)
  })

  it('data:image/...;base64 数据 URL 换 [图片] 占位（含嵌套数组）', () => {
    const dataUrl = `data:image/png;base64,${'QUJDRA'.repeat(500)}==`
    const out = sanitizeHistoryEvents([
      entry(1, 'tool/result', { shots: [dataUrl, { inline: dataUrl }] }),
    ])
    const shots = (out[0] as { event: { data: { shots: [string, { inline: string }] } } }).event
      .data.shots
    assert.equal(shots[0], IMAGE_PLACEHOLDER)
    assert.equal(shots[1].inline, IMAGE_PLACEHOLDER)
  })

  it('独立超长 base64 串换 [图片]；纯字母散文与短哈希不误伤', () => {
    const screenshotLike = 'Ab+C/d0'.repeat(200) // 1400 字符，纯 base64 字符集且含 + /
    const prose = 'word '.repeat(150) // 750 字符：去空白后纯字母，不得误判
    const hash = 'a'.repeat(600) // 无 +/=，不得误判
    const out = sanitizeHistoryEvents([
      entry(1, 'tool/result', { shot: screenshotLike, note: prose, hash }),
    ])
    const data = (out[0] as { event: { data: Record<string, string> } }).event.data
    assert.equal(data['shot'], IMAGE_PLACEHOLDER)
    assert.equal(data['note'], prose)
    assert.equal(data['hash'], hash)
  })

  it('单事件序列化超 64KB：整个 data 换 {oversized, bytes}，type/seq 保留', () => {
    // 20 × 3900 字符：单字段都没到截断线，总量 ~78KB 必超 64KB
    const bulk: Record<string, string> = {}
    for (let index = 0; index < 20; index++) bulk[`f${index}`] = `值${index}${'z'.repeat(3_890)}`
    const out = sanitizeHistoryEvents([entry(7, 'tool/result', bulk)])
    const event = (out[0] as { event: { type: string; seq: number; data: unknown } }).event
    assert.equal(event.type, 'tool/result')
    assert.equal(event.seq, 7)
    assert.deepEqual(
      typeof (event.data as { bytes: unknown }).bytes === 'number' &&
        (event.data as { oversized: unknown }).oversized === true,
      true,
    )
    assert.ok((event.data as { bytes: number }).bytes > HISTORY_MAX_EVENT_BYTES)
    assert.ok(bytesOf(out[0]) < HISTORY_MAX_EVENT_BYTES, '占位后必须回到预算内')
  })

  it('不修改入参（纯函数）', () => {
    const original = entry(1, 'tool/result', {
      shot: `data:image/png;base64,${'A+BC'.repeat(400)}`,
      text: `汉字${'y'.repeat(5_000)}`,
    })
    const snapshot = JSON.stringify(original)
    sanitizeHistoryEvents([original])
    assert.equal(JSON.stringify(original), snapshot)
  })

  it('垃圾输入不炸：非数组 → []；畸形条目原样放行', () => {
    assert.deepEqual(sanitizeHistoryEvents(undefined), [])
    assert.deepEqual(sanitizeHistoryEvents(null), [])
    assert.deepEqual(sanitizeHistoryEvents(42), [])
    assert.deepEqual(sanitizeHistoryEvents('events'), [])
    assert.deepEqual(sanitizeHistoryEvents({ events: [] }), [])
    const out = sanitizeHistoryEvents([null, 42, 'x', { weird: 1 }, entry(1)])
    assert.equal(out.length, 5, '没有 event.type 的畸形条目不丢（只丢明确的系统事件）')
  })

  it('循环引用不炸', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic['self'] = cyclic
    const out = sanitizeHistoryEvents([entry(1, 'tool/result', cyclic)])
    assert.equal(out.length, 1)
    assert.doesNotThrow(() => JSON.stringify(out[0]))
  })
})

/* ────────────────────────── pageEvents ────────────────────────── */

describe('pageEvents', () => {
  it('条数预算：从最新端取，hasMore 与 oldestSeq（本页最旧一条）正确', () => {
    const all = Array.from({ length: 10 }, (_, i) => entry(i + 1))
    const page = pageEvents(all, { maxEvents: 3 })
    assert.deepEqual(
      page.events.map((e) => historyEntrySeq(e)),
      [8, 9, 10],
    )
    assert.equal(page.hasMore, true)
    assert.equal(page.oldestSeq, 8)
  })

  it('恰好取完：hasMore=false 且无 oldestSeq', () => {
    const all = [entry(1), entry(2), entry(3)]
    const page = pageEvents(all, { maxEvents: 10 })
    assert.equal(page.events.length, 3)
    assert.equal(page.hasMore, false)
    assert.equal(page.oldestSeq, undefined)
  })

  it('字节预算：装不下即停，哪怕条数还有余量', () => {
    const big = (seq: number): ReturnType<typeof entry> =>
      entry(seq, 'tool/result', { text: `汉${'z'.repeat(997)}` }) // 每条 ~1KB
    const all = [big(1), big(2), big(3), big(4), big(5)]
    const budget = bytesOf(all[4]) + bytesOf(all[3]) + 1
    const page = pageEvents(all, { maxEvents: 100, maxBytes: budget })
    assert.deepEqual(
      page.events.map((e) => historyEntrySeq(e)),
      [4, 5],
    )
    assert.equal(page.hasMore, true)
    assert.equal(page.oldestSeq, 4)
  })

  it('保底：单条就超预算也取回最新一条（翻页不死锁）', () => {
    const all = [entry(1), entry(2, 'tool/result', { text: 'x'.repeat(50_000) })]
    const page = pageEvents(all, { maxEvents: 10, maxBytes: 10 })
    assert.deepEqual(page.events.map((e) => historyEntrySeq(e)), [2])
    assert.equal(page.hasMore, true)
    assert.equal(page.oldestSeq, 2)
  })

  it('保序：乱序输入按 seq 升序输出', () => {
    const all = [entry(5), entry(1), entry(3), entry(2), entry(4)]
    const page = pageEvents(all, { maxEvents: 3 })
    assert.deepEqual(
      page.events.map((e) => historyEntrySeq(e)),
      [3, 4, 5],
    )
  })

  it('beforeSeq 翻页链：三页无缝无重覆盖全部', () => {
    const all = Array.from({ length: 25 }, (_, i) => entry(i + 1))
    const seen: number[] = []

    let beforeSeq: number | undefined
    let pages = 0
    for (;;) {
      const cursor = beforeSeq
      const candidates =
        cursor === undefined
          ? all
          : all.filter((e) => {
              const seq = historyEntrySeq(e)
              return seq !== undefined && seq < cursor
            })
      const page = pageEvents(candidates, { maxEvents: 10 })
      seen.unshift(...page.events.map((e) => historyEntrySeq(e) as number))
      pages += 1
      if (!page.hasMore) break
      beforeSeq = page.oldestSeq
      assert.notEqual(beforeSeq, undefined, 'hasMore 时必须给出翻页游标')
    }

    assert.equal(pages, 3)
    assert.deepEqual(
      seen,
      Array.from({ length: 25 }, (_, i) => i + 1),
      '25 条事件应完整覆盖、无缝无重',
    )
  })

  it('空 / 垃圾输入不炸', () => {
    assert.deepEqual(pageEvents([]), { events: [], hasMore: false })
    assert.deepEqual(pageEvents(null), { events: [], hasMore: false })
    assert.deepEqual(pageEvents('nope'), { events: [], hasMore: false })
    // 无 seq 的条目也能分页（不参与游标）
    const page = pageEvents([{ a: 1 }, { b: 2 }], { maxEvents: 1 })
    assert.equal(page.events.length, 1)
    assert.equal(page.hasMore, true)
    assert.equal(page.oldestSeq, undefined)
  })
})

/* ────────────────────────── sanitizeLiveEvent ────────────────────────── */

describe('sanitizeLiveEvent', () => {
  it('阈值收紧到 2000 字符（历史版能过的 3000 字符在实时版被截断）', () => {
    const long = `汉${'x'.repeat(2_999)}` // 3000 字符
    const out = sanitizeLiveEvent({
      method: 'session/event',
      payload: { type: 'session/event', sessionId: 's1', event: { type: 'assistant/chunk', seq: 1, data: { text: long } } },
    }) as { payload: { event: { data: { text: string } } } }
    assert.equal(
      out.payload.event.data.text,
      `${long.slice(0, 2000)}…[截断，原 ${long.length} 字符]`,
    )
  })

  it('base64 图片换占位（实时同款）', () => {
    const out = sanitizeLiveEvent({
      method: 'session/event',
      payload: {
        type: 'session/event',
        sessionId: 's1',
        event: { type: 'tool/result', seq: 2, data: { shot: `data:image/jpeg;base64,/9j/${'A'.repeat(2_000)}` } },
      },
    }) as { payload: { event: { data: { shot: string } } } }
    assert.equal(out.payload.event.data.shot, IMAGE_PLACEHOLDER)
  })

  it('超 maxBytes：session/event 信封换最内层 data 占位，sessionId 与 type 保留', () => {
    const huge = Array.from({ length: 30 }, (_, i) => `块${i}${'q'.repeat(1_900)}`)
    const out = sanitizeLiveEvent(
      {
        method: 'session/event',
        payload: {
          type: 'session/event',
          sessionId: 'session-xyz',
          event: { type: 'tool/result', seq: 9, data: { chunks: huge } },
        },
      },
      { maxBytes: 4_000 },
    ) as { method: string; payload: { sessionId: string; event: { type: string; data: unknown } } }
    assert.equal(out.method, 'session/event')
    assert.equal(out.payload.sessionId, 'session-xyz', '路由字段必须活着')
    assert.equal(out.payload.event.type, 'tool/result', 'UI 归一化靠它，必须保留')
    const data = out.payload.event.data as { oversized: boolean; bytes: number }
    assert.equal(data.oversized, true)
    assert.ok(data.bytes > 4_000)
    assert.ok(bytesOf(out) < 4_000 + 256, '占位后必须回到预算内')
  })

  it('超 maxBytes：{type, data} 形状保留 type', () => {
    const out = sanitizeLiveEvent(
      { type: 'tool/result', data: { text: 'w'.repeat(3_000), more: 'v'.repeat(3_000) } },
      { maxBytes: 500 },
    ) as { type: string; data: { oversized: boolean } }
    assert.equal(out.type, 'tool/result')
    assert.equal(out.data.oversized, true)
  })

  it('小事件原样通过（内容不变）', () => {
    const event = {
      method: 'session/event',
      payload: { type: 'session/event', sessionId: 's1', event: { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } } },
    }
    assert.deepEqual(sanitizeLiveEvent(event), event)
  })

  it('垃圾输入不炸', () => {
    assert.equal(sanitizeLiveEvent(null), null)
    assert.equal(sanitizeLiveEvent(42), 42)
    assert.equal(sanitizeLiveEvent('short'), 'short')
    const cyclic: Record<string, unknown> = { method: 'x' }
    cyclic['payload'] = cyclic
    assert.doesNotThrow(() => sanitizeLiveEvent(cyclic))
  })
})
