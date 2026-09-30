/**
 * 发送失败的处置：不能"看起来发出去了"，也不能让用户重打一遍。
 *
 * 旧实现的三个问题（都真实存在）：
 *   ① 乐观上屏的气泡留在对话里，像已送达；
 *   ② 输入框在发送时就清空 ⇒ 失败后用户打的字没了，重试要重打；
 *   ③ 只在提示条里报一句英文错误，而提示条会消失。
 *
 * 还有更微妙的一条：**超时 ≠ 没送达**（节点可能已经写进 dsh，只是响应丢了）。
 * 直接重发会让员工收到两条，所以"结果未知"时要先查历史再决定给不给重发入口。
 *
 * 测法：抠交付脚本里的真函数，配替身（假 DOM / 假 rpc）跑。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { readFileSync } from 'node:fs'
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

/* ── 假 DOM ── */

interface FakeNode {
  className: string
  classes: Set<string>
  children: FakeNode[]
  parentNode: FakeNode | null
  textContent: string
  title: string
  onclick: ((event: unknown) => void) | null
  classList: {
    add(name: string): void
    remove(name: string): void
    contains(name: string): boolean
  }
  appendChild(child: FakeNode): FakeNode
  removeChild(child: FakeNode): void
  querySelector(selector: string): FakeNode | null
}

function makeNode(className = ''): FakeNode {
  const node: FakeNode = {
    className,
    classes: new Set(className === '' ? [] : className.split(' ')),
    children: [],
    parentNode: null,
    textContent: '',
    title: '',
    onclick: null,
    classList: {
      add: (name) => void node.classes.add(name),
      remove: (name) => void node.classes.delete(name),
      contains: (name) => node.classes.has(name),
    },
    appendChild(child) {
      child.parentNode = node
      node.children.push(child)
      return child
    },
    removeChild(child) {
      node.children = node.children.filter((item) => item !== child)
      child.parentNode = null
    },
    querySelector(selector) {
      const wanted = selector.replace(/^\./, '')
      const walk = (current: FakeNode): FakeNode | null => {
        for (const child of current.children) {
          if (child.classes.has(wanted)) return child
          const found = walk(child)
          if (found !== null) return found
        }
        return null
      }
      return walk(node)
    },
  }
  return node
}

function makeUndeliveredHarness(): {
  markPromptUndelivered: (row: FakeNode, text: string, pending: unknown[]) => void
  sent: Array<{ text: string; pending: unknown[]; row: FakeNode }>
  row: FakeNode
} {
  const sent: Array<{ text: string; pending: unknown[]; row: FakeNode }> = []
  const scope = {
    el: (tag: string, className?: string, text?: string) => {
      const node = makeNode(className ?? '')
      node.textContent = text ?? ''
      return node
    },
    setRunning: () => undefined,
    deliverPrompt: (text: string, pending: unknown[], row: FakeNode) => {
      sent.push({ text, pending, row })
      return Promise.resolve()
    },
  }
  const factory = new Function(
    'scope',
    `with (scope) { ${extractFunction('markPromptUndelivered')} return { markPromptUndelivered } }`,
  ) as (scope: unknown) => { markPromptUndelivered: (row: FakeNode, text: string, pending: unknown[]) => void }
  return { ...factory(scope), sent, row: makeNode('msg user') }
}

describe('未送达气泡与重发', () => {
  it('把这行标成 undelivered 并挂上重发按钮', () => {
    const h = makeUndeliveredHarness()
    h.markPromptUndelivered(h.row, '离线时的发送测试', [])
    assert.equal(h.row.classes.has('undelivered'), true, '气泡要能看出没送出去')
    const bar = h.row.querySelector('.msg-retry')
    assert.ok(bar !== null, '要挂上重发入口 —— 否则用户只能重打一遍')
    assert.equal(bar.children.length, 1)
    assert.equal(bar.children[0]?.textContent, '重发这条')
  })

  it('点重发：清掉未送达标记与按钮，并用**原文与附件**再送一次', () => {
    const h = makeUndeliveredHarness()
    const pending = [{ name: '报表.xlsx', path: '收件箱/报表.xlsx' }]
    h.markPromptUndelivered(h.row, '带附件的指令', pending)
    const bar = h.row.querySelector('.msg-retry')
    assert.ok(bar !== null)
    bar.children[0]?.onclick?.({ stopPropagation: () => undefined })

    assert.equal(h.row.classes.has('undelivered'), false, '重发时先恢复干净状态')
    assert.equal(h.row.querySelector('.msg-retry'), null, '按钮要移除，避免重复点')
    assert.equal(h.sent.length, 1)
    assert.equal(h.sent[0]?.text, '带附件的指令')
    assert.deepEqual(h.sent[0]?.pending, pending, '附件要一起重发（失败时附件本来就没清）')
    assert.equal(h.sent[0]?.row, h.row, '重发复用同一行，不能再贴一条气泡')
  })

  it('重复标记不会挂出两个按钮', () => {
    const h = makeUndeliveredHarness()
    h.markPromptUndelivered(h.row, 'x', [])
    h.markPromptUndelivered(h.row, 'x', [])
    const bars = h.row.children.filter((child) => child.classes.has('msg-retry'))
    assert.equal(bars.length, 1)
  })
})

/* ── 送达判定 ── */

function makeDeliveredHarness(events: unknown[], fails = false) {
  const scope = {
    rpc: () => (fails ? Promise.reject({ code: 'node-offline', message: 'down' }) : Promise.resolve({ events })),
    pickArray: (payload: { events?: unknown[] }) => payload.events ?? [],
    normalizeEvent: (item: unknown) => item,
    squash: (text: string) => String(text).replace(/\s+/g, ''),
  }
  const factory = new Function(
    'scope',
    `with (scope) { ${extractFunction('promptAlreadyDelivered')} return { promptAlreadyDelivered } }`,
  ) as (scope: unknown) => { promptAlreadyDelivered: (e: string, s: string, t: string) => Promise<boolean | null> }
  return factory(scope)
}

describe('超时后判断"到底送达没有"', () => {
  it('历史里已经有这条 user 消息 → 判定已送达（于是不给重发按钮）', async () => {
    const h = makeDeliveredHarness([
      { kind: 'assistant', text: '好的' },
      { kind: 'user', text: '帮我查一下日志' },
    ])
    assert.equal(await h.promptAlreadyDelivered('emp_1', 'session-a', '帮我查一下日志'), true)
  })

  it('空白差异不影响判定（历史里的文本可能被规范化过）', async () => {
    const h = makeDeliveredHarness([{ kind: 'user', text: '帮我 查一下\n日志' }])
    assert.equal(await h.promptAlreadyDelivered('emp_1', 'session-a', '帮我查一下日志'), true)
  })

  it('历史里没有 → false（可以安全地给重发）', async () => {
    const h = makeDeliveredHarness([{ kind: 'user', text: '别的指令' }])
    assert.equal(await h.promptAlreadyDelivered('emp_1', 'session-a', '帮我查一下日志'), false)
  })

  it('历史都查不到时返回 null —— 不假装知道，把决定权留给用户', async () => {
    const h = makeDeliveredHarness([], true)
    assert.equal(await h.promptAlreadyDelivered('emp_1', 'session-a', '随便'), null)
  })
})

describe('接线（结构护栏）', () => {
  it('sendPrompt 走 deliverPrompt 并把上屏那一行传下去', () => {
    assert.match(extractFunction('sendPrompt'), /var row = appendUserBubble\(text\)/)
    assert.match(extractFunction('sendPrompt'), /deliverPrompt\(text, pending, row\)/)
  })

  it('明确的拒绝（节点离线）不查历史，直接给重发', () => {
    const deliver = extractFunction('deliverPrompt')
    assert.match(deliver, /code === 'node-offline'/)
    assert.match(deliver, /promptAlreadyDelivered\(employeeId, sessionId, text\)/)
  })

  it('发送失败不再单独弹一条英文错误条（人话提示已覆盖）', () => {
    assert.doesNotMatch(extractFunction('sendPrompt'), /appendErrorBar/)
  })

  it('CSS 有未送达样式（否则标记了也看不出来）', () => {
    assert.match(CONSOLE_SOURCE, /\.msg\.user\.undelivered \.bubble/)
    assert.match(CONSOLE_SOURCE, /\.msg-retry \{/)
  })
})
