/**
 * 手机（窄屏）办公区布局 —— 把 CSS 文本当契约来测。
 *
 * 为什么值得测：这里同样出过一次真实事故。旧版在窄屏沿用「头像 | 小屏」横排，
 * 而窄屏卡片只有 ~110–190px 宽，头像（曾加到 110px）把同行的小屏挤成 **33px 宽的细条**
 * （紧凑档只剩 14px）—— 而小屏（实时输出）正是窄屏上唯一真正要看的东西。
 * 当时的修法只是把头像缩回去（55px），属于"止血"，小屏依然是 4 个汉字宽的窄条。
 * 现在改成竖排：第一行是「头像 + 名字 + 状态」工牌，**小屏独占整行**吃满卡宽。
 *
 * 这类回归的共同点是**不报错**：CSS 写错了页面照常渲染，只是难用。
 * 而浏览器里的"看起来对不对"没有自动化，所以这里退一步，把**布局契约**钉死：
 * 竖排的 grid 区域、小屏独占整行、头像不再抢宽度、以及**桌面端没有被顺手改坏**。
 *
 * 局限（不掩饰）：文本断言证明不了像素。真正的几何验证是发布前在浏览器里量出来的
 * （实测 169px 卡片：小屏宽 55px → 137px、高 104px；桌面 320px 卡片不变）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { renderControlUiScript } from '../src/web/ui.ts'

/* 控制台拆成多文件之后：断言 CSS 读 css.ts；断言标记/页头这类"某处有没有"读超集。
   （超集 = ui.ts + css.ts + markup.ts + 全部脚本片段；按 id/类名找东西时用它最稳。） */
import { CSS_SOURCE, CONSOLE_SOURCE as UI_SOURCE } from './console-source.ts'

/** 交付给浏览器的同一份脚本（`placeChatTools` 的行为测试要从这里抠真源码）。 */
const SCRIPT = renderControlUiScript()

/** `src/web/css.ts` 里的那段 CSS，**注释先删掉** ——
    否则注释里的 `.foo {` 会被当成规则命中，测出来的就是注释而不是样式。 */
function styleSheet(): string {
  assert.ok(CSS_SOURCE.includes('CONTROL_UI_CSS'), 'css.ts 里找不到样式常量')
  return CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')
}

interface AtRule {
  query: string
  body: string
}

/** 把顶层 CSS 拆成"基础规则"与各个 @media 块（靠花括号配对，不依赖具体写法）。 */
function splitCss(css: string): { base: string; media: AtRule[] } {
  const media: AtRule[] = []
  let base = ''
  let index = 0
  while (index < css.length) {
    const at = css.indexOf('@media', index)
    if (at < 0) {
      base += css.slice(index)
      break
    }
    base += css.slice(index, at)
    const open = css.indexOf('{', at)
    assert.ok(open > at, '@media 后没有找到 {')
    let depth = 0
    let cursor = open
    while (cursor < css.length) {
      if (css[cursor] === '{') depth += 1
      else if (css[cursor] === '}') {
        depth -= 1
        if (depth === 0) break
      }
      cursor += 1
    }
    media.push({ query: css.slice(at, open).replace('@media', '').trim(), body: css.slice(open + 1, cursor) })
    index = cursor + 1
  }
  return { base, media }
}

/** 取选择器**完全相等**的规则体。
    不能只用 indexOf：`.desk-top > .desk-screen {` 里也含 `.desk-screen {`，
    那样会读到 `.desk-top` 子项规则，测试就变成了自我欺骗。 */
function ruleBody(css: string, selector: string): string | undefined {
  const wanted = selector.replace(/\s*\{$/, '').trim()
  for (const chunk of css.split('}')) {
    const open = chunk.indexOf('{')
    if (open < 0) continue
    const head = chunk.slice(0, open)
    const lastBreak = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(';'))
    if (head.slice(lastBreak + 1).trim() !== wanted) continue
    return chunk.slice(open + 1)
  }
  return undefined
}

/** 从规则体里读一个声明的值（分号切分，容忍换行与缩进）。 */
function declaration(body: string, property: string): string | undefined {
  for (const chunk of body.split(';')) {
    const trimmed = chunk.trim()
    if (!trimmed.startsWith(`${property}:`)) continue
    return trimmed.slice(property.length + 1).trim()
  }
  return undefined
}

/** grid-template-areas 里的每一行（去掉引号与多余空白）。 */
function areaRows(body: string): string[] {
  const value = declaration(body, 'grid-template-areas')
  assert.ok(value !== undefined, '规则里没有 grid-template-areas')
  return [...value.matchAll(/"([^"]+)"/g)].map((match) => String(match[1]).trim().split(/\s+/).join(' '))
}

const { base, media } = splitCss(styleSheet())
const narrow = media.filter((entry) => entry.query.startsWith('(max-width: 900px)'))
const narrowCss = narrow.map((entry) => entry.body).join('\n')
const wide = media.find((entry) => entry.query.startsWith('(min-width: 1920px)'))

describe('窄屏（≤900px）办公区布局', () => {
  it('存在窄屏断点，且里面定义了工位竖排', () => {
    assert.ok(narrow.length > 0, '没有 (max-width: 900px) 断点')
    const body = ruleBody(narrowCss, '.desk-top {')
    assert.ok(body !== undefined, '窄屏里没有 .desk-top 布局规则')
    assert.ok(declaration(body, 'grid-template-columns') !== undefined, '窄屏 .desk-top 没有列定义')
  })

  it('小屏（实时输出）独占整行 —— 这是本次修复的核心', () => {
    const rows = areaRows(ruleBody(narrowCss, '.desk-top {') ?? '')
    const screenRows = rows.filter((row) => row.split(' ').includes('screen'))
    assert.equal(screenRows.length, 1, '小屏应当只占一行')
    const only = String(screenRows[0])
    const cells = only.split(' ')
    assert.ok(
      cells.length > 1 && cells.every((cell) => cell === 'screen'),
      `小屏没有跨满整行（实际 "${only}"），仍会与头像抢宽度`,
    )
    assert.ok(!String(rows[0]).includes('screen'), '小屏不该挤在头像那一行')
  })

  it('名字与状态上下排（左右排时共用一个窄列，长名字会被挤到逐字换行）', () => {
    const rows = areaRows(ruleBody(narrowCss, '.desk-top {') ?? '')
    const nameRow = rows.findIndex((row) => row.includes('name'))
    const badgeRow = rows.findIndex((row) => row.includes('badge'))
    assert.ok(nameRow >= 0 && badgeRow >= 0, '名字/状态没有入格')
    assert.notEqual(nameRow, badgeRow, '名字与状态仍挤在同一行')
    // 各自占**一列**而不是整行：头像那一列不能被浪费掉
    assert.notEqual(String(rows[nameRow]), 'name name', '名字占了整行，头像列被浪费')
    assert.notEqual(String(rows[badgeRow]), 'badge badge', '状态占了整行，头像列被浪费')
  })

  it('每个工位部件都被显式放进对应区域（漏一个 → 自动放置 → 布局静默错位）', () => {
    const rows = areaRows(ruleBody(narrowCss, '.desk-top {') ?? '')
    const declared = new Set(rows.join(' ').split(' '))
    const mapping: Record<string, string> = {
      'desk-avatar-box': 'avatar',
      'desk-screen': 'screen',
      'desk-name': 'name',
      'desk-badges': 'badge',
      'desk-role': 'role',
      'desk-meta': 'meta',
      'desk-actions': 'act',
    }
    for (const [klass, area] of Object.entries(mapping)) {
      assert.ok(declared.has(area), `区域 ${area} 没有出现在 grid-template-areas 里`)
      const body = ruleBody(narrowCss, `.desk-top > .${klass} {`)
      assert.ok(body !== undefined, `窄屏里没有 .desk-top > .${klass} 的规则`)
      assert.equal(declaration(body, 'grid-area'), area, `.${klass} 的 grid-area 与区域名对不上`)
    }
  })

  it('紧凑档不留空轨道（岗位/节点已隐藏，若仍占轨道会白扔行距）', () => {
    const body = ruleBody(narrowCss, '.office--compact .desk-top {')
    assert.ok(body !== undefined, '紧凑档没有专门的窄屏区域定义')
    const joined = areaRows(body).join(' ')
    assert.ok(!joined.includes('role') && !joined.includes('meta'), '紧凑档仍给隐藏行留了轨道')
    // 紧凑档该有的行一个都不能少：头像/名字/状态/小屏/操作
    for (const area of ['avatar', 'name', 'badge', 'screen', 'act']) {
      assert.ok(joined.includes(area), `紧凑档窄屏区域里缺 ${area}`)
    }
  })

  it('头像不再抢小屏的宽度（缩回"工牌证件照"尺寸）', () => {
    const body = ruleBody(narrowCss, '.desk-avatar-box {')
    assert.ok(body !== undefined, '窄屏里没有头像尺寸规则')
    const width = Number.parseInt(String(declaration(body, 'width')), 10)
    assert.ok(width > 0 && width < 80, `窄屏头像 ${width}px 仍然过大`)
    const compactBody = ruleBody(narrowCss, '.office--compact .desk-avatar-box {')
    assert.ok(compactBody !== undefined)
    const compactWidth = Number.parseInt(String(declaration(compactBody, 'width')), 10)
    assert.ok(compactWidth > 0 && compactWidth < 50, `窄屏紧凑档头像 ${compactWidth}px 仍然过大`)
  })

  it('小屏有足够高度（"看实时输出"才成立）', () => {
    const body = ruleBody(narrowCss, '.desk-screen {')
    assert.ok(body !== undefined, '窄屏里没有小屏尺寸规则')
    const height = Number.parseInt(String(declaration(body, 'min-height')), 10)
    assert.ok(height >= 60, `窄屏小屏高度 ${height}px 太矮`)
  })
})

describe('窄屏改动不许碰桌面端', () => {
  it('基础（>900px）仍是「头像 | 小屏」两栏横排', () => {
    const body = ruleBody(base, '.desk-top {')
    assert.ok(body !== undefined, '基础样式里没有 .desk-top')
    assert.equal(declaration(body, 'grid-template-columns'), 'auto minmax(0, 1fr)')
    assert.equal(declaration(body, 'grid-template-areas'), undefined, '基础样式不该用区域重排')
  })

  it('基础头像仍是 110px 主体（用户明确要的视觉重心）', () => {
    const body = ruleBody(base, '.desk-avatar-box {')
    assert.ok(body !== undefined)
    assert.equal(declaration(body, 'width'), '110px')
    assert.equal(declaration(body, 'height'), '110px')
  })

  it('竖排只出现在 ≤900px 断点里（宽屏断点不参与）', () => {
    assert.ok(wide !== undefined, '没有 (min-width: 1920px) 断点')
    assert.ok(!wide.body.includes('grid-template-areas'), '超宽屏断点里混进了竖排区域定义')
  })
})

/* ────────────────────────── 聊天输入区与宽屏三栏（手机 vs 电脑）──────────────────────────
 *
 * 为什么值得测：这里出过一次**只能靠量才能发现**的毛病。工具键是
 * `flex: 0 0 auto` + `white-space: nowrap`，宽度固定（附件 34 / 压缩 82 / 沉淀 82 /
 * 发送 44 + 4×8 间隙 = 274px），于是被挤的只有输入框 —— 实测 375px 屏上只剩 78px
 * （去掉左右 padding 后 ≈3 个汉字），320px 屏只剩 34px 并把整行撑出横向溢出。
 * 修法是**窄屏把两个工具键搬进会话抽屉**（会话级动作跟着会话列表走），
 * 搬的是同一批 DOM 节点（见 placeChatTools），输入区高度不变。
 *
 * 同批钉住的还有：输入框字号 ≥16px（iOS 低于它会在聚焦时自动放大整页且不还原）、
 * 横屏左右 safe-area（iPhone 横屏刘海在侧边，只处理上下会被压住）、
 * 以及宽屏三栏（左会话常驻 + 中对话 + 右员工上下文）。
 */

const phone = media.filter((entry) => entry.query.startsWith('(max-width: 640px)'))
const phoneCss = phone.map((entry) => entry.body).join('\n')
/**
 * ≥1200px 的**全部**规则体。
 *
 * 为什么从"取第一块"改成"全都要"：导航重构之后宽屏规则拆成了两块 ——
 * 外层壳（`#viewChatShell`：导航 + 工作区）与工作区内部（`#viewChat`：对话 + 右栏）。
 * 只取第一块会让"右栏在宽屏怎么摆"这类断言凭空失败（规则明明在，只是搬到了下一块），
 * 而报出来的话是"宽屏断点里没有 #employeeAside 规则"——指向完全错误的地方。
 */
const wideAll = media.filter((entry) => entry.query.startsWith('(min-width: 1200px)'))
const wideChat = { body: wideAll.map((entry) => entry.body).join('\n') }

describe('聊天输入区：手机（≤640px）', () => {
  it('输入框字号 ≥16px —— iOS 低于它会在聚焦时把整页放大且不还原', () => {
    assert.ok(phone.length > 0, '没有 (max-width: 640px) 断点')
    const body = ruleBody(phoneCss, '.composer textarea {')
    assert.ok(body !== undefined, '手机断点里没有输入框字号规则')
    const size = Number.parseInt(String(declaration(body, 'font-size')), 10)
    assert.ok(size >= 16, `手机输入框字号 ${size}px 会触发 iOS 聚焦缩放`)
  })

  it('输入区在手机上**不再**重排成网格（工具键搬走，输入行保持单行）', () => {
    const body = ruleBody(phoneCss, '.composer-inner {')
    assert.equal(body, undefined, '手机上不该再给输入区做网格重排：工具键应当搬进抽屉')
  })

  it('会话抽屉里有工具槽，且空着时不占位（桌面端按钮在输入区，槽是空的）', () => {
    const slot = ruleBody(base, '.chat-session-tools {')
    assert.ok(slot !== undefined, '基础样式里没有 .chat-session-tools')
    assert.equal(declaration(slot, 'display'), 'flex')
    const empty = ruleBody(base, '.chat-session-tools:empty {')
    assert.ok(empty !== undefined, '工具槽缺 :empty 规则 —— 桌面端会白占一行')
    assert.equal(declaration(empty, 'display'), 'none')
    assert.ok(UI_SOURCE.includes('id="sessionTools"'), '抽屉里没有 #sessionTools 槽位')
  })

  it('附件键有 44px 触控目标（emoji 内容只有 ~18px 宽）', () => {
    const body = ruleBody(base, '.chat-attach {')
    assert.ok(body !== undefined, '基础样式里没有 .chat-attach')
    const minWidth = Number.parseInt(String(declaration(body, 'min-width')), 10)
    assert.ok(minWidth >= 44, `附件键最小宽度 ${minWidth}px 低于 44px 触控下限`)
  })
})

/* ── 工具键「搬家」的行为（抠真源码 + 假 DOM 跑，不是复刻一份逻辑）── */

interface FakeNode {
  id: string
  parent: FakeNode | null
  children: FakeNode[]
  appendChild(child: FakeNode): void
  insertBefore(child: FakeNode, ref: FakeNode): void
}

function fakeNode(id: string): FakeNode {
  return {
    id,
    parent: null,
    children: [],
    appendChild(child: FakeNode): void {
      if (child.parent !== null) child.parent.children = child.parent.children.filter((n) => n !== child)
      child.parent = this
      this.children.push(child)
    },
    insertBefore(child: FakeNode, ref: FakeNode): void {
      if (child.parent !== null) child.parent.children = child.parent.children.filter((n) => n !== child)
      const at = this.children.indexOf(ref)
      child.parent = this
      this.children.splice(at < 0 ? this.children.length : at, 0, child)
    },
  }
}

/** 从交付脚本里抠出 placeChatTools 的真源码（按花括号配对），配上假 DOM 跑一次。 */
function runPlaceChatTools(narrow: boolean): { order: string[]; home: string } {
  const start = SCRIPT.indexOf('function placeChatTools(')
  assert.ok(start >= 0, '交付脚本里找不到 placeChatTools')
  let depth = 0
  let end = -1
  for (let i = SCRIPT.indexOf('{', start); i < SCRIPT.length; i += 1) {
    if (SCRIPT[i] === '{') depth += 1
    else if (SCRIPT[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  assert.ok(end > start, 'placeChatTools 的花括号没有配对')

  const inner = fakeNode('composer-inner')
  const slot = fakeNode('sessionTools')
  const compact = fakeNode('btnCompact')
  const distill = fakeNode('btnDistill')
  const send = fakeNode('btnSend')
  inner.appendChild(compact)
  inner.appendChild(distill)
  inner.appendChild(send)

  const byId: Record<string, FakeNode> = {
    btnCompact: compact,
    btnDistill: distill,
    btnSend: send,
    sessionTools: slot,
  }
  const scope = {
    $: (id: string): FakeNode | null => byId[id] ?? null,
    document: { querySelector: (): FakeNode | null => inner },
    window: { matchMedia: (): { matches: boolean } => ({ matches: narrow }) },
    CHAT_TOOLS_MOVE_QUERY: '(max-width: 640px)',
  }
  const factory = new Function(
    ...Object.keys(scope),
    `${SCRIPT.slice(start, end)}\nreturn placeChatTools`,
  ) as (...args: unknown[]) => (arg?: boolean) => boolean
  const place = factory(...Object.values(scope))
  const result = place(narrow)
  assert.equal(result, narrow, 'placeChatTools 的返回值应当如实反映"当前是否窄屏"')
  const home = compact.parent
  assert.ok(home !== null && compact.parent === distill.parent, '两个工具键必须待在同一个容器里')
  return { order: (home as FakeNode).children.map((n) => n.id), home: (home as FakeNode).id }
}

describe('工具键搬家（窄屏进抽屉 / 宽屏回输入区）', () => {
  it('窄屏：两个键都在会话抽屉里', () => {
    const { home, order } = runPlaceChatTools(true)
    assert.equal(home, 'sessionTools', '窄屏下工具键没有进抽屉')
    assert.deepEqual(order, ['btnCompact', 'btnDistill'])
  })

  it('宽屏：搬回输入区，且恢复「压缩 → 沉淀 → 发送」的原顺序', () => {
    const { home, order } = runPlaceChatTools(false)
    assert.equal(home, 'composer-inner', '宽屏下工具键没有回到输入区')
    assert.deepEqual(order, ['btnCompact', 'btnDistill', 'btnSend'], '顺序错了：发送键的前面才是它们的位置')
  })

  it('搬的是同一批节点（不复制第二份按钮）—— DOM 里各只有一个 id', () => {
    for (const id of ['btnCompact', 'btnDistill']) {
      const hits = UI_SOURCE.split(`id="${id}"`).length - 1
      assert.equal(hits, 1, `#${id} 在页面里出现了 ${hits} 次；搬家方案不该有第二份按钮`)
    }
  })
})

describe('宽屏（≥1200px）聊天三栏', () => {
  it('宽屏是「导航常驻 + 对话 + 右上下文」：外壳两列，工作区内部两列', () => {
    /* 导航重构把原来的一张三栏网格拆成了两层：外层壳管「导航 | 工作区」，
       工作区内部管「对话 | 右栏」。两个层次各有各的列定义，所以这里分别断。 */
    const shell = ruleBody(wideChat.body, '#viewChatShell {')
    assert.ok(shell !== undefined, '宽屏断点里没有外壳（导航 + 工作区）的列定义')
    const shellTracks = String(declaration(shell, 'grid-template-columns'))
      .replace(/\([^)]*\)/g, 'X').trim().split(/\s+/)
    assert.equal(shellTracks.length, 2, `外壳应当是两列（导航 + 工作区），实际 "${shellTracks}"`)

    const body = ruleBody(wideChat.body, '#viewChat {')
    assert.ok(body !== undefined, '宽屏断点里没有 #viewChat 布局规则')
    assert.equal(declaration(body, 'display'), 'grid')
    const columns = String(declaration(body, 'grid-template-columns'))
    /* 先把 minmax(…) 这类函数整体收成一个词再数轨道 —— 直接按空格切会把
       `minmax(220px, 260px)` 逗号后的空格也算成一条轨道。 */
    const tracks = columns.replace(/\([^)]*\)/g, 'X').trim().split(/\s+/)
    assert.equal(tracks.length, 2, `工作区是「对话 + 右栏」两列（实际 "${columns}"）`)
    const rows = areaRows(body)
    for (const area of ['top', 'messages', 'composer', 'aside']) {
      assert.ok(rows.join(' ').includes(area), `区域 ${area} 没有出现在 grid-template-areas 里`)
    }
    /* `panel` 这个区域**不该**再出现在工作区里：会话面板已经搬去外壳的第一列。 */
    assert.ok(!rows.join(' ').includes('panel'), '工作区里还留着 panel 区域 —— 会话面板又分叉出一份？')
  })

  it('宽屏时导航是第一列，工作区在第二列；收起后靠窄栏回来', () => {
    const panel = ruleBody(wideChat.body, '#viewChatShell > #sessionPanel {')
    assert.ok(panel !== undefined, '宽屏断点里没有「面板进外壳第一列」的规则')
    assert.equal(declaration(panel, 'grid-column'), '1')
    const workspace = ruleBody(wideChat.body, '#viewChatShell > #viewChat {')
    assert.ok(workspace !== undefined, '宽屏断点里没有「工作区进第二列」的规则')
    assert.equal(declaration(workspace, 'grid-column'), '2')
    /* 收起态下的入口是窄栏（`.chat-nav-rail`），不是顶栏那个「会话」按钮 ——
       展开时窄栏藏着，收起时才放出来（见 test/ui-panel.test.ts 的那一对）。 */
    const rail = ruleBody(wideChat.body, '#viewChatShell:not(.panel-collapsed) > .chat-nav-rail {')
    assert.ok(rail !== undefined, '缺少"展开时藏窄栏"的规则')
    assert.equal(declaration(rail, 'display'), 'none')
  })

  it('右栏：窄屏隐藏、宽屏显示，并且不再受 920px 封顶', () => {
    assert.ok(wideChat !== undefined)
    const aside = ruleBody(wideChat.body, '#employeeAside {')
    assert.ok(aside !== undefined, '宽屏断点里没有 #employeeAside 规则')
    assert.equal(declaration(aside, 'display'), 'flex !important')
    assert.equal(declaration(aside, 'grid-area'), 'aside')
    assert.ok(
      UI_SOURCE.includes('class="chat-aside hidden" id="employeeAside"'),
      '右栏默认必须是 hidden（窄屏不能出现，否则把对话挤没）',
    )
    const view = ruleBody(wideChat.body, '#viewChat {')
    assert.ok(view !== undefined, '宽屏断点里没有 #viewChat 规则')
    assert.equal(declaration(view, 'max-width'), 'none', '宽屏不能继续被 920px 封顶')
  })

  it('中间列放宽到 860px（消息与输入区同步，保持左右对齐）', () => {
    assert.ok(wideChat !== undefined)
    const body = ruleBody(wideChat.body, '#viewChat .msg, #viewChat .composer-inner {')
    assert.ok(body !== undefined, '宽屏没有放宽消息列')
    assert.equal(declaration(body, 'max-width'), '860px')
  })
})

describe('聊天输入区：桌面端不被顺手改坏', () => {
  it('基础（<1200px）仍是单行 flex，输入框弹性伸缩', () => {
    const body = ruleBody(base, '.composer-inner {')
    assert.ok(body !== undefined, '基础样式里没有 .composer-inner')
    assert.equal(declaration(body, 'display'), 'flex', '桌面输入区不该被改成网格')
    assert.equal(declaration(body, 'grid-template-areas'), undefined, '桌面输入区不该出现区域重排')
    const ta = ruleBody(base, '.composer textarea {')
    assert.ok(ta !== undefined)
    assert.equal(declaration(ta, 'flex'), '1 1 auto')
  })

  it('顶栏与输入区都吃左右 safe-area（横屏刘海在侧边）', () => {
    /* 规则体里可能先有普通值再有 max()（渐进增强），所以这里断言"规则里有这个 env 声明"，
       而不是读第一条声明 —— 读第一条会把兜底值当成契约。 */
    for (const [selector, prop] of [
      ['.chat-top {', 'padding-left'],
      ['.chat-top {', 'padding-right'],
      ['.composer {', 'padding-left'],
      ['.composer {', 'padding-right'],
    ] as const) {
      const body = ruleBody(base, selector)
      assert.ok(body !== undefined, `基础样式里没有 ${selector}`)
      const declarations = body
        .split(';')
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.startsWith(`${prop}:`))
      assert.ok(declarations.length > 0, `${selector} 里没有 ${prop}`)
      const side = prop.endsWith('left') ? 'safe-area-inset-left' : 'safe-area-inset-right'
      assert.ok(
        declarations.some((value) => value.includes(`env(${side})`)),
        `${selector} 的 ${prop} 没有用 ${side}（实际 "${declarations.join(' | ')}"）`,
      )
    }
  })

  it('viewport 打开 resizes-content —— 安卓键盘弹出时缩内容而不是盖住输入框', () => {
    assert.ok(
      UI_SOURCE.includes('interactive-widget=resizes-content'),
      'viewport meta 里缺 interactive-widget=resizes-content',
    )
  })
})
