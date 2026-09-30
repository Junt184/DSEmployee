/**
 * "这页跑的是旧脚本" —— 部署之后最容易被误判成"没修好"的那件事。
 *
 * 现场：hub 部署了新控制台，可**已经开着的标签页只会断线重连，不会重新取 JS**。
 * 于是页面上的一切都还是旧的：按钮点的还是旧逻辑、布局还是旧的，而人看到的是
 * "你说修好了，我这儿一样没变"。真实踩过：审批「通过」按钮修完并部署之后，
 * 旧标签页里依然点不动 —— 差一点又把同一个 bug 修第二遍。
 *
 * 页面上原有两道防线都不覆盖这种情况：
 *   · renderUiVersion：比的是"本页 HTML 印章 vs 本页脚本"，而旧标签页两边**都是旧的、相等**；
 *   · service worker 换代刷新：只在 SW 脚本字节变化（真取了新资源）时才触发。
 * 所以补上第三道：握手时服务器把**此刻**的指纹告诉页面，对不上就自曝并叫人刷新。
 *
 * 这里测两件事：文案函数的行为，以及"两边真的接上了"（协议字段 + 握手处调用）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { helloOkSchema } from '../src/protocol/frames.ts'
import { renderControlUiScript } from '../src/web/ui.ts'

const SCRIPT = renderControlUiScript()
const HUB_SERVER = readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'hub', 'server.ts'),
  'utf8',
)

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

function mismatcher(): (client: unknown, hub: unknown) => string {
  const factory = new Function(
    extractFunction('uiVersionMismatchText') + '\nreturn uiVersionMismatchText',
  ) as () => (client: unknown, hub: unknown) => string
  return factory()
}

describe('旧脚本自曝：文案函数', () => {
  it('指纹一致 / 服务器没报 / 本页没有 → 都不提示（不许误报）', () => {
    const text = mismatcher()
    assert.equal(text('abc-123', 'abc-123'), '')
    assert.equal(text('abc-123', ''), '')
    assert.equal(text('abc-123', undefined), '')
    assert.equal(text('abc-123', null), '')
    assert.equal(text('', 'abc-123'), '')
    assert.equal(text(undefined, 'abc-123'), '')
  })

  it('指纹不同 → 两个指纹都写出来，并给出可执行的一步（刷新）', () => {
    const text = mismatcher()
    const message = text('1gifhh6-1hv', '11kmj3y-fdm7')
    assert.ok(message.indexOf('11kmj3y-fdm7') >= 0, '要说清服务器上是哪一版：' + message)
    assert.ok(message.indexOf('1gifhh6-1hv') >= 0, '要说清这页跑的是哪一版：' + message)
    assert.ok(/刷新|F5|⌘R/.test(message), '要告诉人怎么办：' + message)
    assert.ok(message.indexOf('新功能') >= 0, '要说清刷新之后才有新功能：' + message)
  })
})

describe('旧脚本自曝：两边真的接上了', () => {
  it('握手成功后调用 applyServerUiVersion，并把服务器指纹传进去', () => {
    assert.ok(
      SCRIPT.indexOf('applyServerUiVersion(payload.ui.hub)') >= 0,
      'onHelloOk 里没有用握手里的服务器指纹（那这道提示就是死的）',
    )
    /* 必须在 setBanner('') 清屏之后 —— 否则提示会被自己抹掉 */
    const clearAt = SCRIPT.indexOf("setBanner('', 'info')\n  setPhase('ready'")
    const applyAt = SCRIPT.indexOf('applyServerUiVersion(payload.ui.hub)')
    assert.ok(clearAt >= 0 && applyAt > clearAt, '提示要挂在清屏之后')
  })

  it('hello-ok 里带 ui 块，且 stale 由服务器当前指纹算出来', () => {
    assert.ok(HUB_SERVER.indexOf('ui: (() => {') >= 0, 'hub 的 hello-ok 里没有 ui 块')
    assert.ok(
      HUB_SERVER.indexOf('stale: input.uiVersion !== undefined && input.uiVersion !== hubUiVersion') >= 0,
      'stale 的判据不对（必须是"客户端自报的指纹 ≠ 当前指纹"）',
    )
  })

  it('协议 schema 认这个字段（老控制端不发 ui 也必须照常握手）', () => {
    const base = {
      type: 'hello-ok',
      hubId: 'hub-1',
      protocol: 1,
      server: { version: '0.1.0', connId: 'c1' },
      features: { methods: [], events: [] },
      auth: { role: 'operator', scopes: [] },
      policy: { maxPayload: 1024, tickIntervalMs: 15000 },
    }
    assert.equal(helloOkSchema.safeParse(base).success, true, '不带 ui 的老响应要能解析')
    const withUi = { ...base, ui: { client: 'old-1', hub: 'new-2', stale: true } }
    const parsed = helloOkSchema.safeParse(withUi)
    assert.equal(parsed.success, true, '带 ui 的响应要能解析')
    assert.deepEqual(parsed.success ? parsed.data.ui : null, { client: 'old-1', hub: 'new-2', stale: true })
  })
})
