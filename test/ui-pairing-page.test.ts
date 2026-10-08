/**
 * 授权页只画**走得通**的那条路。
 *
 * 背景：授权页是给未配对设备看的（Hub 的"登录页"）。它原来固定给两条路——
 * 「方式一：输入配对码」「方式二：在另一台已授权设备上批准」。
 * 而 Hub 现在默认只认配对码（`pairingApproval: 'code-only'`）：**方式二在服务端是被拒的**
 * （见 `devices.ts` 的 `operatorApprovalAllowed` 与 `device.pair.approve` 的处理）。
 * 画一条点了必然报错的路，比不画更糟：用户会以为是界面坏了，而不是"这条路关了"。
 *
 * 为什么这份状态必须由服务端随页面注入：授权页是**未配对设备**在看的，
 * 而它没有任何 scope —— `pairing.approval` 要 `device.pair`，它读不到。
 * 所以进门方式写进 `#dse-boot` 的 `data-pairing-approval`，脚本按它决定画什么。
 *
 * 缺省方向刻意选保守：服务端没说话 = 按"只认配对码"处理。猜错只是少画一条其实
 * 能走的路（用户还有配对码那条），反过来则是画出一条会被拒的路。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderControlUi, renderControlUiScript } from '../src/web/ui.ts'

const SCRIPT = renderControlUiScript()

function page(options: { pairingApproval?: 'code-only' | 'operator' } = {}): string {
  return renderControlUi({
    hubId: 'hub-test',
    hubName: '测试 Hub',
    scriptUrl: '/ui.js',
    ...(options.pairingApproval === undefined ? {} : { pairingApproval: options.pairingApproval }),
  })
}

/** 抠出交付脚本里的函数源码（按花括号配对）。 */
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

class FakeNode {
  classes = new Set<string>()
  textContent = ''
  classList = {
    toggle: (name: string, on: boolean): void => {
      if (on) this.classes.add(name)
      else this.classes.delete(name)
    },
    contains: (name: string): boolean => this.classes.has(name),
  }
}

/** 跑真的 `syncAuthGate()`，只把 DOM 与状态替身掉。 */
function runAuthGate(pairingApproval: 'code-only' | 'operator'): Record<string, FakeNode> {
  const ids = [
    'authGate', 'authHubName', 'authHubAddr', 'authRequestId', 'authNoCrypto', 'authPairArea',
    'authApprovePath', 'authCodeOnlyNote',
  ]
  const nodes: Record<string, FakeNode> = {}
  for (const id of ids) nodes[id] = new FakeNode()
  const scope = {
    state: { phase: 'waiting-pair', authGateForced: false, identity: {}, tokenMode: false, pairing: null },
    BOOT: { hubName: '测试 Hub', pairingApproval },
    location: { host: 'hub.test' },
    $: (id: string) => nodes[id] ?? null,
  }
  const factory = new Function(
    'scope',
    `with (scope) {
      ${extractFunction('syncAuthGate')}
      return { syncAuthGate }
    }`,
  ) as (scope: unknown) => { syncAuthGate: () => void }
  factory(scope).syncAuthGate()
  return nodes
}

describe('授权页：进门方式决定画哪条路', () => {
  it('只认配对码（默认）：不画"去另一台设备批准"，改为说明怎么开窗输码', () => {
    const nodes = runAuthGate('code-only')
    assert.equal(nodes['authApprovePath']!.classes.has('hidden'), true, '这条路服务端会拒，不该画出来')
    assert.equal(nodes['authCodeOnlyNote']!.classes.has('hidden'), false, '要告诉用户真正可行的那一步')
  })

  it('允许人工批准：方式二照常给出来', () => {
    const nodes = runAuthGate('operator')
    assert.equal(nodes['authApprovePath']!.classes.has('hidden'), false)
    assert.equal(nodes['authCodeOnlyNote']!.classes.has('hidden'), true)
  })

  it('服务端注入进门方式：只认配对码时不写 operator，允许时写 operator', () => {
    assert.ok(
      /id="dse-boot"[^>]*data-pairing-approval=""/.test(page()),
      '缺省（只认配对码）应当留空 —— 脚本按"没说就是只认配对码"兜底',
    )
    assert.ok(
      /id="dse-boot"[^>]*data-pairing-approval="operator"/.test(page({ pairingApproval: 'operator' })),
      '允许人工批准时要把它带进页面（未配对设备读不到接口，只能靠页面注入）',
    )
  })

  it('配对码那条路永远都在（它是唯一不需要别的设备配合的路）', () => {
    for (const html of [page(), page({ pairingApproval: 'operator' })]) {
      for (const id of ['pairCodeInput', 'btnRedeem', 'authPairArea']) {
        assert.ok(html.includes(`id="${id}"`), `授权页缺 ${id} —— 配对码这条路不能因为模式而消失`)
      }
    }
  })
})
