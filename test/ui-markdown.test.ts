/**
 * 聊天气泡的极小 Markdown 渲染器。
 *
 * 测法：从交付脚本抠出真源码（`renderMarkdown` 及其帮手），配替身 DOM 跑。
 * 不复刻一份解析器 —— 复刻版只能证明复刻版对，而「表格当正文」恰恰藏在真扫描器里。
 *
 * 钉的是员工回复里最常见、原先子集又漏掉的一块：GFM 表格。加粗/链接必须仍走
 * 同一套行内通道，否则会出现「表出来了、单元格里的 **加粗** 又原样显示」。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { renderControlUiScript } from '../src/web/ui.ts'

const SCRIPT = renderControlUiScript()
const CSS = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'css.ts'), 'utf8')

interface FakeEl {
  tag: string
  className: string
  children: FakeEl[]
  attrs: Record<string, string>
  ownText: string
  textContent: string
  appendChild: (child: FakeEl) => FakeEl
  setAttribute: (key: string, value: string) => void
}

function makeEl(tag: string): FakeEl {
  const node: FakeEl = {
    tag,
    className: '',
    children: [],
    attrs: {},
    ownText: '',
    get textContent(): string {
      if (node.children.length === 0) return node.ownText
      return node.children.map((child) => child.textContent).join('')
    },
    set textContent(value: string) {
      node.ownText = value
      node.children = []
    },
    appendChild: (child: FakeEl): FakeEl => {
      node.children.push(child)
      return child
    },
    setAttribute: (key: string, value: string): void => {
      node.attrs[key] = value
    },
  }
  return node
}

function findAll(node: FakeEl, pred: (current: FakeEl) => boolean): FakeEl[] {
  const out: FakeEl[] = []
  const walk = (current: FakeEl): void => {
    if (pred(current)) out.push(current)
    for (const child of current.children) walk(child)
  }
  walk(node)
  return out
}

function tags(node: FakeEl): string[] {
  return findAll(node, () => true).map((item) => item.tag)
}

function makeRenderer(): (text: string) => FakeEl {
  const start = SCRIPT.indexOf('var MD_TICK = String.fromCharCode(96)')
  const end = SCRIPT.indexOf('function clearMessages(', start)
  assert.ok(start >= 0 && end > start, '交付脚本里找不到 markdown 渲染器这段')
  const source = SCRIPT.slice(start, end) + '\nreturn renderMarkdown'
  const scope = {
    document: {
      createElement: (tag: string): FakeEl => makeEl(tag),
      createTextNode: (text: string): FakeEl => {
        const node = makeEl('#text')
        node.textContent = text
        return node
      },
    },
    el: (tag: string, className?: string, text?: unknown): FakeEl => {
      const node = makeEl(tag)
      if (className) node.className = className
      if (text !== undefined && text !== null) node.textContent = String(text)
      return node
    },
  }
  const render = new Function('scope', `with (scope) {\n${source}\n}`)(scope) as (container: FakeEl, text: string) => void
  return (text: string): FakeEl => {
    const container = makeEl('div')
    render(container, text)
    return container
  }
}

const render = makeRenderer()

describe('markdown 表格（聊天气泡原先当正文）', () => {
  it('表头 + 分隔行 + 数据行变成 table/thead/tbody，不是一段带竖线的 p', () => {
    const root = render(['| 姓名 | 岗位 |', '| --- | --- |', '| 小艾 | 后端 |', '| 阿澈 | 前端 |'].join('\n'))
    assert.equal(findAll(root, (node) => node.tag === 'p').length, 0, '整表被当成段落了')
    assert.equal(findAll(root, (node) => node.tag === 'table' && node.className === 'md-table').length, 1)
    assert.equal(findAll(root, (node) => node.tag === 'div' && node.className === 'md-table-wrap').length, 1)
    const heads = findAll(root, (node) => node.tag === 'th')
    const cells = findAll(root, (node) => node.tag === 'td')
    assert.deepEqual(
      heads.map((node) => node.textContent),
      ['姓名', '岗位'],
    )
    assert.deepEqual(
      cells.map((node) => node.textContent),
      ['小艾', '后端', '阿澈', '前端'],
    )
    assert.ok(tags(root).includes('thead') && tags(root).includes('tbody'))
  })

  it('单元格里的加粗、行内代码、http(s) 链接走同一套行内通道', () => {
    const root = render(['| 项 | 说明 |', '| --- | --- |', '| **重要** | 见 [文档](https://example.com) 与 `code` |'].join('\n'))
    const strong = findAll(root, (node) => node.tag === 'strong')
    const code = findAll(root, (node) => node.tag === 'code')
    const link = findAll(root, (node) => node.tag === 'a')
    assert.equal(strong.length, 1)
    assert.equal(strong[0]?.textContent, '重要')
    assert.equal(code.length, 1)
    assert.equal(code[0]?.textContent, 'code')
    assert.equal(link.length, 1)
    assert.equal(link[0]?.textContent, '文档')
    assert.equal(link[0]?.attrs['href'], 'https://example.com')
    assert.equal(link[0]?.attrs['rel'], 'noopener noreferrer')
  })

  it('分隔行的冒号决定对齐 class（:--- / :---: / ---:）', () => {
    const root = render(['| 左 | 中 | 右 |', '| :--- | :---: | ---: |', '| a | b | c |'].join('\n'))
    const heads = findAll(root, (node) => node.tag === 'th')
    assert.equal(heads[0]?.className, 'md-th md-align-left')
    assert.equal(heads[1]?.className, 'md-th md-align-center')
    assert.equal(heads[2]?.className, 'md-th md-align-right')
    const cells = findAll(root, (node) => node.tag === 'td')
    assert.equal(cells[2]?.className, 'md-td md-align-right')
  })

  it('列数以表头为准：多的丢掉、少的补空单元格（否则列对不齐）', () => {
    const root = render(['| A | B |', '| --- | --- |', '| 1 | 2 | 3 |', '| 只一列 |'].join('\n'))
    const rows = findAll(root, (node) => node.tag === 'tr').slice(1)
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.children.length, 2, '多出来的第三列应当丢掉')
    assert.deepEqual(
      rows[0]?.children.map((cell) => cell.textContent),
      ['1', '2'],
    )
    assert.equal(rows[1]?.children.length, 2, '缺列要补空 td，不能让这一行少一格')
    assert.equal(rows[1]?.children[0]?.textContent, '只一列')
    assert.equal(rows[1]?.children[1]?.textContent, '')
  })

  it('没有分隔行的竖线文本仍是段落，不能误当成表', () => {
    const root = render('价格 | 12 元')
    assert.equal(findAll(root, (node) => node.tag === 'table').length, 0)
    assert.equal(findAll(root, (node) => node.tag === 'p').length, 1)
    assert.equal(findAll(root, (node) => node.tag === 'p')[0]?.textContent, '价格 | 12 元')
  })

  it('javascript: 链接不能进 href（单元格同样走这道闸）', () => {
    const root = render(['| x | y |', '| --- | --- |', '| [点我](javascript:alert(1)) | ok |'].join('\n'))
    assert.equal(findAll(root, (node) => node.tag === 'a').length, 0, '非 http(s) 链接被做成了 <a>')
    const cells = findAll(root, (node) => node.tag === 'td')
    assert.equal(cells[0]?.textContent, '[点我](javascript:alert(1))')
  })

  it('代码围栏里的表格原文必须原样留下，不能被扫成 table', () => {
    const fence = String.fromCharCode(96, 96, 96)
    const root = render([fence, '| a | b |', '| --- | --- |', '| 1 | 2 |', fence].join('\n'))
    assert.equal(findAll(root, (node) => node.tag === 'table').length, 0)
    const pre = findAll(root, (node) => node.tag === 'pre')
    assert.equal(pre.length, 1)
    assert.match(pre[0]?.textContent ?? '', /\| a \| b \|/)
  })

  it('配套样式在（缺样式就是"能渲染但看起来还是挤在一起的字"）', () => {
    for (const cls of ['.md-table-wrap {', '.md-table {', '.md-th, .md-td {', '.md-th {', '.md-align-center {', '.md-align-right {']) {
      assert.ok(CSS.includes(cls), '缺样式 ' + cls)
    }
    assert.match(CSS, /\.md-table-wrap \{[^}]*overflow-x:\s*auto/, '窄气泡必须能横向滚，否则多列表格会被挤没')
  })
})
