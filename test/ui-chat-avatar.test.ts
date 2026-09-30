/**
 * 聊天页顶栏的头像（名字左边那颗）。
 *
 * 需求只有一句："聊天界面 chat-peer 栏名字左边把头像加上"。测试盯的是**别把它做成第二份头像实现**：
 *   · 取数必须走 30-office 的 avatarNode / ensureAvatar（版本判断 + localStorage 缓存 +
 *     缩图 + 占位线稿脸都在那一份里；自己再发一次 employee.avatar.get 就会分叉成
 *     "工位上是新头像、顶栏还是旧的"，而且每次进聊天页白拉几百 KB）；
 *   · 盒子上**不能**写 data-avatar-for —— 那是 paintAvatar 找头像盒的钩子，
 *     写了它就会把外层盒子当头像盒清空重填，内层的尺寸规则随之失效；
 *   · 换人/退出会话要收干净（留着上一任的头像比空着更糟），同一个人不重建（否则会闪）。
 *
 * 行为测试沿用仓库既有做法：从**交付脚本**里抠出真源码（按花括号配对），配替身跑。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { renderControlUi, renderControlUiScript } from '../src/web/ui.ts'
import { CSS_SOURCE } from './console-source.ts'

const SCRIPT = renderControlUiScript()
const MARKUP = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'markup.ts'), 'utf8')

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
  tag: string
  className: string
  textContent: string
  children: FakeEl[]
  attrs: Record<string, string>
  appendChild: (child: FakeEl) => void
  setAttribute: (key: string, value: string) => void
  getAttribute: (key: string) => string | null
  removeAttribute: (key: string) => void
}

function makeEl(tag: string): FakeEl {
  const node = {
    tag,
    className: '',
    textContent: '',
    children: [] as FakeEl[],
    attrs: {} as Record<string, string>,
    appendChild: (child: FakeEl): void => {
      node.children.push(child)
    },
    setAttribute: (key: string, value: string): void => {
      node.attrs[key] = value
    },
    getAttribute: (key: string): string | null => node.attrs[key] ?? null,
    removeAttribute: (key: string): void => {
      delete node.attrs[key]
    },
  }
  return node as FakeEl
}

interface Api {
  updateChatPeerAvatar: () => void
  updateChatHeader: () => void
  getCalls: () => { avatars: number; ensures: string[]; cleared: number }
  setEmployee: (id: string | null) => void
}

/** 只替身"别人的东西"：DOM、员工表、avatarNode/ensureAvatar（30-office 那两份）。 */
function makeHarness(): { api: Api; box: FakeEl } {
  const box = makeEl('span')
  const calls = { avatars: 0, ensures: [] as string[], cleared: 0 }
  const employee = { id: 'emp_x', name: '小张' }
  const state: Record<string, unknown> = { selectedEmployeeId: 'emp_x', employeeNames: new Map() }
  const scope: Record<string, unknown> = {
    state,
    $: (id: string): FakeEl | null => (id === 'chatPeerAvatar' ? box : null),
    el: (tag: string, className?: string, text?: unknown): FakeEl => {
      const node = makeEl(tag)
      if (className) node.className = className
      if (text !== undefined) node.textContent = String(text)
      return node
    },
    clear: (node: FakeEl): void => {
      node.children.length = 0
      calls.cleared += 1
    },
    employeeById: (id: string): unknown => (id === employee.id ? employee : null),
    /* 这两个是真源码在 30-office 里的；这里只记录"被叫过"，因为被测的是 65-chat 的接线 */
    avatarNode: (target: unknown, size: number): FakeEl => {
      calls.avatars += 1
      const node = makeEl('span')
      node.className = 'desk-avatar-box'
      node.setAttribute('data-avatar-for', String((target as { id?: string }).id ?? ''))
      node.setAttribute('data-size', String(size))
      return node
    },
    ensureAvatar: (target: unknown): void => void calls.ensures.push(String((target as { id?: string }).id ?? '')),
  }
  const source = [extractFunction('updateChatPeerAvatar')].join('\n')
  const factory = new Function(
    ...Object.keys(scope),
    source + '\nreturn { updateChatPeerAvatar: updateChatPeerAvatar }',
  ) as (...args: unknown[]) => { updateChatPeerAvatar: () => void }

  return {
    box,
    api: {
      ...factory(...Object.values(scope)),
      getCalls: () => calls,
      setEmployee: (id) => void (state['selectedEmployeeId'] = id),
      /* updateChatHeader 也被真源码调用；这里不重跑它，只暴露接口给将来的用例 */
      updateChatHeader: () => undefined,
    },
  }
}

describe('聊天页顶栏头像（chat-peer）', () => {
  it('标记：#chatPeerAvatar 在 .chat-peer 里、且在名字**左边**', () => {
    const peer = MARKUP.indexOf('<div class="chat-peer">')
    assert.ok(peer > 0, '标记里找不到 .chat-peer')
    const avatar = MARKUP.indexOf('id="chatPeerAvatar"', peer)
    const name = MARKUP.indexOf('id="employeeTitle"', peer)
    assert.ok(avatar > 0, '#chatPeerAvatar 不在 .chat-peer 里')
    assert.ok(avatar < name, '头像必须在名字左边（需求原话就是"名字左边"）')
    assert.ok(MARKUP.includes('class="chat-peer-avatar" id="chatPeerAvatar"'), '头像位要带 chat-peer-avatar 类（CSS 靠它定尺寸）')
  })

  it('页面里真的渲染出来了（不是只写在注释里）', () => {
    const page = renderControlUi({ hubId: 'h', hubName: 'H', scriptUrl: '/ui.js' })
    assert.ok(page.includes('id="chatPeerAvatar"'), '渲染出来的页面里没有头像位')
  })

  it('取数走 30-office 那一套：avatarNode + ensureAvatar，不自己发 employee.avatar.get', () => {
    const harness = makeHarness()
    harness.api.updateChatPeerAvatar()
    assert.equal(harness.api.getCalls().avatars, 1, '要用 avatarNode 建盒子（自定义头像/线稿脸同一套）')
    assert.deepEqual(harness.api.getCalls().ensures, ['emp_x'], '要叫 ensureAvatar 去取图（它自带版本判断与本地缓存）')
    const body = extractFunction('updateChatPeerAvatar')
    assert.ok(
      !body.includes("rpc('employee.avatar.get'"),
      '这里不许自己拉头像 —— 第二份取数必然分叉（工位上新、顶栏旧），而且每次进聊天页白拉几百 KB',
    )
  })

  it('外层盒子不写 data-avatar-for（那是 paintAvatar 的钩子，写了内层的尺寸规则会失效）', () => {
    const harness = makeHarness()
    harness.api.updateChatPeerAvatar()
    assert.equal(harness.box.getAttribute('data-avatar-for'), null, '外层盒子不能带 data-avatar-for')
    assert.equal(harness.box.getAttribute('data-peer'), 'emp_x', '外层用 data-peer 记"现在是哪一位"')
    assert.equal(harness.box.children.length, 1, '头像节点要落进盒子里')
    assert.equal(
      harness.box.children[0]?.getAttribute('data-avatar-for'),
      'emp_x',
      '钩子写在内层头像盒上 —— paintAvatar 才能找到它并原地换内容',
    )
  })

  it('同一个人不重建（updateChatHeader 一次回合里会被叫好几次，重建会闪）', () => {
    const harness = makeHarness()
    harness.api.updateChatPeerAvatar()
    harness.api.updateChatPeerAvatar()
    harness.api.updateChatPeerAvatar()
    assert.equal(harness.api.getCalls().avatars, 1, '同一位员工只该建一次头像节点')
    assert.equal(harness.api.getCalls().ensures.length, 1, '取图也只该叫一次')
  })

  it('换人：重建头像（旧头像不能留在新同事头上）', () => {
    const harness = makeHarness()
    harness.api.updateChatPeerAvatar()
    harness.api.setEmployee(null)
    harness.api.updateChatPeerAvatar()
    assert.equal(harness.box.children.length, 0, '没选员工时必须收干净')
    assert.equal(harness.box.getAttribute('data-peer'), null)
  })

  it('没选员工时是空的（CSS 的 :empty 会把那一列收成 0）', () => {
    const harness = makeHarness()
    harness.api.setEmployee(null)
    harness.api.updateChatPeerAvatar()
    assert.equal(harness.box.children.length, 0)
    assert.equal(harness.api.getCalls().avatars, 0, '没员工就不该建头像')
  })

  it('样式：顶栏用 grid 让头像跨两行、文本仍在右侧上下排；空时整列收起', () => {
    const css = CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')
    const peer = /\.chat-peer \{([^}]*)\}/.exec(css)?.[1] ?? ''
    assert.ok(peer !== '', '找不到 .chat-peer 的规则')
    assert.ok(/display:\s*grid/.test(peer), '名字与状态是兄弟节点：改成 grid 才不会把它们排成一行')
    assert.ok(/grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)/.test(peer), '头像列 auto（=头像宽度）、文本列吃剩余宽度')
    const avatar = /\.chat-peer-avatar \{([^}]*)\}/.exec(css)?.[1] ?? ''
    assert.ok(/grid-row:\s*1\s*\/\s*span\s*2/.test(avatar), '头像要跨名字与状态两行')
    assert.ok(/\.chat-peer-avatar:empty\s*\{\s*display:\s*none/.test(css), '空头像位不能白占位置')
    const box = /\.chat-peer-avatar \.desk-avatar-box \{([^}]*)\}/.exec(css)?.[1] ?? ''
    assert.ok(/width:\s*30px/.test(box) && /height:\s*30px/.test(box), '头像盒要在这里定尺寸（复用 .desk-avatar-box 那套）')
  })
})
