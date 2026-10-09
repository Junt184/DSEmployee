import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import { renderControlUiScript } from '../src/web/ui.ts'

const script = renderControlUiScript().replace(/\ninit\(\)\s*$/, '')

class Element {
  children: Element[] = []
  parentNode: Element | null = null
  className = ''
  private ownText = ''
  attributes: Record<string, string> = {}
  disabled = false
  type = ''
  title = ''
  href = ''
  download = ''
  onclick?: () => void
  tag: string
  constructor(tag: string) { this.tag = tag }
  get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join('') }
  set textContent(value: string) { this.ownText = value; this.children = [] }
  get firstChild(): Element | null { return this.children[0] ?? null }
  appendChild(child: Element): Element { child.parentNode = this; this.children.push(child); return child }
  removeChild(child: Element): void {
    assert.ok(this.children.includes(child))
    this.children.splice(this.children.indexOf(child), 1)
    child.parentNode = null
  }
  setAttribute(key: string, value: string): void { this.attributes[key] = value }
  getAttribute(key: string): string | null { return this.attributes[key] ?? null }
  click(): void { this.onclick?.() }
}

function find(root: Element, className: string): Element[] {
  return root.children.flatMap((child) => [
    ...(child.className.split(' ').includes(className) ? [child] : []), ...find(child, className),
  ])
}

function harness() {
  const messages = new Element('div'), body = new Element('body')
  const calls: Array<{ method: string; params: Record<string, unknown>; resolve(value: unknown): void; reject(error: unknown): void }> = []
  const downloads: Element[] = [], blobs: Blob[] = [], timers: Array<() => void> = [], revoked: string[] = []
  const scope = vm.createContext({
    document: {
      body,
      getElementById: (id: string) => id === 'messages' ? messages : null,
      createElement: (tag: string) => {
        const node = new Element(tag)
        if (tag === 'a') node.onclick = () => { downloads.push(node) }
        return node
      },
      createTextNode: (text: string) => { const node = new Element('#text'); node.textContent = text; return node },
      addEventListener: () => {},
    },
    location: { host: 'test.local', search: '' }, navigator: {}, window: {},
    localStorage: { getItem: () => null },
    setTimeout: (callback: () => void) => { timers.push(callback); return timers.length }, clearTimeout: () => {},
    setInterval: () => 1, clearInterval: () => {}, Blob, atob,
    URL: {
      createObjectURL: (blob: Blob) => { blobs.push(blob); return 'blob:test-file' },
      revokeObjectURL: (url: string) => { revoked.push(url) },
    },
  })
  vm.runInContext(script, scope)
  scope.scrollMessages = () => {}
  scope.stageSpeaking = () => {}
  scope.toast = () => {}
  scope.rpc = (method: string, params: Record<string, unknown>) => new Promise((resolve, reject) => {
    calls.push({ method, params, resolve, reject })
  })
  scope.state.selectedEmployeeId = 'emp_a'
  scope.state.selectedSessionId = 'session_a'
  return { scope, messages, body, calls, downloads, blobs, timers, revoked }
}

async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)) }
const report = '[报告.pdf](dse-file:交付物/报告.pdf)'

describe('员工在会话里交付文件', () => {
  it('真实流式回复定稿后生成下载卡片；切换选择也保留原员工归属', async () => {
    const h = harness()
    h.scope.appendDelta(0, '报告已完成。\n' + report)
    assert.equal(find(h.messages, 'employee-file-card').length, 0)
    h.scope.state.selectedEmployeeId = 'emp_b'
    h.scope.finalizeStream()
    const cards = find(h.messages, 'employee-file-card')
    assert.equal(cards.length, 1)
    assert.equal(cards[0]!.attributes['data-employee-id'], 'emp_a')
    const button = find(cards[0]!, 'employee-file-download')[0]!
    button.click()
    button.click() // 在途点击不重复请求
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0]!.method, 'employee.files.download')
    assert.equal(h.calls[0]!.params.employeeId, 'emp_a')
    assert.equal(h.calls[0]!.params.path, '交付物/报告.pdf')
    assert.equal(button.disabled, true)
    h.calls[0]!.resolve({ dataBase64: Buffer.from([0, 255, 42]).toString('base64'), size: 3, mimeType: 'application/pdf' })
    await flush()
    assert.equal(button.disabled, false)
    assert.equal(button.textContent, '再次下载')
    assert.equal(h.downloads[0]!.download, '报告.pdf')
    assert.equal(h.blobs[0]!.type, 'application/pdf')
    assert.deepEqual(new Uint8Array(await h.blobs[0]!.arrayBuffer()), new Uint8Array([0, 255, 42]))
    assert.equal(h.body.children.length, 0, '临时下载节点应回收')
    h.timers.forEach((callback) => callback())
    assert.deepEqual(h.revoked, ['blob:test-file'])
  })

  it('刷新后的历史事件经原有归一化与渲染流程恢复文件卡片', () => {
    const h = harness()
    const event = { event: { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: report }] } } } }
    h.scope.renderNormalized(h.scope.normalizeEvent(event), false)
    const cards = find(h.messages, 'employee-file-card')
    assert.equal(cards.length, 1)
    assert.equal(cards[0]!.attributes['data-file-path'], '交付物/报告.pdf')
  })

  it('支持普通相对文件链接、中文和编码后的空格/括号', () => {
    const h = harness(), root = new Element('div')
    h.scope.renderMarkdown(root, '[表格](./交付物/周报%20%281%29.xlsx)\n[图](<交付物/趋势 图.png>)', 'emp_a')
    assert.deepEqual(find(root, 'employee-file-card').map((card) => card.attributes['data-file-path']), [
      '交付物/周报 (1).xlsx', '交付物/趋势 图.png',
    ])
  })

  it('代码中的文件示例保持原文；没有员工归属时不生成卡片', () => {
    const h = harness(), root = new Element('div')
    const tick = String.fromCharCode(96), fence = tick.repeat(3)
    h.scope.renderMarkdown(root, tick + report + tick + '\n\n' + fence + '\n' + report + '\n' + fence, 'emp_a')
    assert.equal(find(root, 'employee-file-card').length, 0)
    h.scope.renderMarkdown(root, report)
    assert.equal(find(root, 'employee-file-card').length, 0)
    assert.ok(root.textContent.includes(report))
  })

  it('外部网页仍走安全链接；绝对路径、穿越、任意协议不能变成下载入口', () => {
    const h = harness(), root = new Element('div')
    const bad = ['../secret', 'dse-file:../secret', 'dse-file:%2e%2e/secret', '/etc/passwd', 'file:///etc/passwd',
      'dse-file:/etc/passwd', 'dse-file:%2fetc/passwd', 'C:%5cUsers%5csecret', 'javascript:alert(1)',
      'dse-file:dir%5c..%5csecret', 'dse-file:dir/%00file', 'dir/', '//example.com/file', '#anchor', 'dir/%ZZ']
    h.scope.renderMarkdown(root, bad.map((url) => '[文件](' + url + ')').join('\n') + '\n[文档](https://example.com)', 'emp_a')
    assert.equal(find(root, 'employee-file-card').length, 0)
    assert.equal(find(root, 'md-link').length, 1)
    assert.equal(find(root, 'md-link')[0]!.attributes['rel'], 'noopener noreferrer')
    assert.equal(h.calls.length, 0, '渲染时不自动读取或下载文件')
  })

  it('节点离线在卡片内提示，重试仍下载同一个员工的文件', async () => {
    const h = harness()
    h.scope.assistantMessage(report)
    const card = find(h.messages, 'employee-file-card')[0]!, button = find(card, 'employee-file-download')[0]!
    button.click()
    h.calls[0]!.reject({ code: 'node-offline', message: 'connection closed' })
    await flush()
    assert.match(find(card, 'employee-file-status')[0]!.textContent, /离线/)
    assert.equal(button.textContent, '重试下载')
    assert.equal(button.disabled, false)
    h.scope.state.selectedEmployeeId = 'emp_b'
    button.click()
    assert.equal(h.calls[1]!.params.employeeId, 'emp_a')
    h.calls[1]!.resolve({ dataBase64: '', size: 0 })
    await flush()
    assert.equal(h.blobs[0]!.size, 0, '员工创建的空文件也可下载')
    assert.equal(button.textContent, '再次下载')
  })

  it('不存在、超限、缺少文件载荷均不显示下载成功', async () => {
    for (const [error, hint] of [
      [{ message: 'ENOENT: no such file or directory' }, /不存在/],
      [{ message: 'file is too large to download: 3000000 bytes' }, /2 MB/],
    ] as const) {
      const h = harness()
      h.scope.assistantMessage(report)
      const card = find(h.messages, 'employee-file-card')[0]!, button = find(card, 'employee-file-download')[0]!
      button.click(); h.calls[0]!.reject(error); await flush()
      assert.match(find(card, 'employee-file-status')[0]!.textContent, hint)
      assert.equal(h.downloads.length, 0)
    }
    const h = harness()
    h.scope.assistantMessage(report)
    const card = find(h.messages, 'employee-file-card')[0]!
    find(card, 'employee-file-download')[0]!.click()
    h.calls[0]!.resolve({}); await flush()
    assert.match(find(card, 'employee-file-status')[0]!.textContent, /没有返回文件内容/)
    assert.equal(h.downloads.length, 0)
  })
})
