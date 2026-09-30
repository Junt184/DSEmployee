/**
 * 审批「通过/拒绝」按钮 —— 页面上唯一"点一下就改变现实"的入口。
 *
 * 线上事故（渗透测试岗位页）：点「通过」毫无反应，页面上没有提示、hub 日志里没有请求、
 * 控制台也没有报错。根因就在 resolveApproval 的第一行判空：
 *
 *     if (note !== '') params.note = note.slice(0, 500)
 *
 * 四宫格内联按钮和应急卡片都是**两个实参**调它（`resolveApproval(id, true)`），
 * 于是 note 是 undefined，`undefined !== ''` 成立 → `undefined.slice` 抛 TypeError，
 * 而且抛在 toast() 与 rpc() **之前**：整个点击静默失效。只有审批页传了第三个实参，
 * 所以"只有审批页能用"。
 *
 * 这个文件盯死三件事：
 *   1. 两个实参调用必须真的发出 `approval.resolve`（不许再抛）；
 *   2. 失败必须看得见（同步异常也要变成红条），提交期间按钮要锁住；
 *   3. **裁决记录成功 ≠ 卡点解除**：hub 回填 dsh 失败时会回 delivered:false，
 *      那时不许报"已批准"。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

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

interface FakeButton {
  disabled: boolean
  textContent: string
  attrs: Record<string, string>
  getAttribute: (key: string) => string | null
  setAttribute: (key: string, value: string) => void
  removeAttribute: (key: string) => void
}

function fakeButton(approvalId: string, label: string, disabled = false): FakeButton {
  const attrs: Record<string, string> = { 'data-approval-id': approvalId }
  return {
    disabled,
    textContent: label,
    attrs,
    getAttribute: (key: string): string | null => {
      const value = attrs[key]
      return value === undefined ? null : value
    },
    setAttribute: (key: string, value: string): void => {
      attrs[key] = value
    },
    removeAttribute: (key: string): void => {
      delete attrs[key]
    },
  }
}

interface RpcCall {
  method: string
  params: Record<string, unknown>
}

interface Harness {
  resolveApproval: (id?: unknown, approve?: unknown, note?: unknown) => Promise<unknown>
  calls: RpcCall[]
  toasts: { text: string; kind: string }[]
  raw: { label: string; payload: unknown }[]
  buttons: FakeButton[]
}

/** 用交付脚本里的真源码建一个最小沙箱：rpc / toast 全部换成替身。 */
function makeHarness(
  reply: (method: string, params: Record<string, unknown>) => unknown,
  buttons: FakeButton[] = [],
): Harness {
  const calls: RpcCall[] = []
  const toasts: { text: string; kind: string }[] = []
  const raw: { label: string; payload: unknown }[] = []
  const scope: Record<string, unknown> = {
    rpc: (method: string, params: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, params })
      try {
        return Promise.resolve(reply(method, params))
      } catch (error) {
        return Promise.reject(error)
      }
    },
    toast: (text: string, kind: string): void => {
      toasts.push({ text, kind })
    },
    pushRaw: (label: string, payload: unknown): void => {
      raw.push({ label, payload })
    },
    shortId: (value: string): string => String(value).slice(0, 12),
    loadApprovals: (): Promise<unknown> => Promise.resolve(null),
    reportRpcError: (title: string, error: unknown): unknown => {
      toasts.push({ text: '错误条：' + title + '：' + String((error as { message?: string })?.message ?? error), kind: 'bad' })
      raw.push({ label: title + ' 失败', payload: error })
      return error
    },
    document: {
      querySelectorAll: (selector: string): FakeButton[] =>
        selector.indexOf('data-approval-id') >= 0 ? buttons : [],
    },
  }
  const names = Object.keys(scope)
  const source = [
    extractFunction('lockApprovalButtons'),
    extractFunction('unlockApprovalButtons'),
    extractFunction('resolveApproval'),
  ].join('\n')
  const factory = new Function(
    ...names,
    source +
      '\nreturn { resolveApproval: resolveApproval, lockApprovalButtons: lockApprovalButtons, ' +
      'unlockApprovalButtons: unlockApprovalButtons }',
  ) as (...args: unknown[]) => {
    resolveApproval: (id?: unknown, approve?: unknown, note?: unknown) => Promise<unknown>
    lockApprovalButtons: (id: string, label?: string) => void
    unlockApprovalButtons: (id: string) => void
  }
  const api = factory(...Object.values(scope))
  return { resolveApproval: api.resolveApproval, calls, toasts, raw, buttons }
}

const APPROVED = { approvalId: 'apr_1', status: 'approved', delivered: true, note: '裁决已回填给 dsh' }

describe('审批按钮：两个实参也必须能批（线上事故的回归）', () => {
  it('resolveApproval(id, true)：不发 note、不抛异常、请求真的发出去', async () => {
    const h = makeHarness(() => APPROVED)
    await h.resolveApproval('apr_prod', true)
    assert.equal(h.calls.length, 1, '必须发出一次 approval.resolve')
    assert.equal(h.calls[0]?.method, 'approval.resolve')
    assert.deepEqual(h.calls[0]?.params, { approvalId: 'apr_prod', approve: true }, 'note 不该出现')
    assert.ok(
      h.toasts.some((one) => one.text.indexOf('正在提交裁决') >= 0),
      '点了必须有即时反馈',
    )
    assert.ok(h.toasts.some((one) => one.kind === 'ok' && one.text.indexOf('已批准') >= 0))
  })

  it('note 显式传 undefined / null 也不许炸（三种实参写法都要活）', async () => {
    const h = makeHarness(() => APPROVED)
    await h.resolveApproval('apr_a', true, undefined)
    await h.resolveApproval('apr_b', false, null)
    assert.equal(h.calls.length, 2)
    assert.equal('note' in (h.calls[0]?.params ?? {}), false)
    assert.equal('note' in (h.calls[1]?.params ?? {}), false)
  })

  it('有备注时进 note，且截断到 500 字（hub 的上限）', async () => {
    const h = makeHarness(() => APPROVED)
    await h.resolveApproval('apr_c', true, '  这次破例，因为线上在烧  ')
    assert.equal(h.calls[0]?.params['note'], '这次破例，因为线上在烧')
    const long = 'x'.repeat(900)
    await h.resolveApproval('apr_d', true, long)
    assert.equal(String(h.calls[1]?.params['note']).length, 500)
  })
})

describe('审批按钮：失败与回填失败都要看得见', () => {
  it('回填 dsh 失败（delivered:false）不许说"已批准"', async () => {
    const h = makeHarness(() => ({
      approvalId: 'apr_2',
      status: 'cancelled',
      delivered: false,
      deliveryError: 'node does not implement method "dsh.interaction.respond"',
      note: '裁决已记录，但回填失败——员工那一轮可能仍在等待',
    }))
    await h.resolveApproval('apr_2', true)
    const bad = h.toasts.filter((one) => one.kind === 'bad')
    assert.equal(bad.length, 1, '必须有一条红条')
    const first = bad[0]
    assert.ok(first !== undefined)
    assert.ok(first.text.indexOf('没能回填') >= 0, '要说清是回填失败：' + first.text)
    assert.ok(
      /仍在等|还挂着|还在等/.test(first.text),
      '要点明员工那一轮可能还卡着：' + first.text,
    )
    assert.equal(
      h.toasts.some((one) => one.kind === 'ok'),
      false,
      '卡点没解除就不许报成功',
    )
  })

  it('rpc 失败要报错，并且把锁住的按钮放开（不能锁死了让人没法重试）', async () => {
    const button = fakeButton('apr_3', '通过')
    const h = makeHarness(() => {
      throw new Error('bad-request: approval apr_3 is already approved')
    }, [button])
    await h.resolveApproval('apr_3', true)
    assert.ok(h.toasts.some((one) => one.kind === 'bad'), '要有一条错误提示')
    assert.equal(button.disabled, false, '失败后按钮要能再点')
    assert.equal(button.textContent, '通过', '标签要还原')
  })

  it('同步异常不许逃逸出 resolveApproval（旧实现在这里静默）', async () => {
    /* 造一个会在 rpc 之外抛的场景：document 本身炸掉 */
    const scope = {
      document: {
        querySelectorAll: (): never => {
          throw new Error('boom')
        },
      },
    }
    const source = [extractFunction('lockApprovalButtons'), extractFunction('unlockApprovalButtons'), extractFunction('resolveApproval')].join('\n')
    const factory = new Function(
      'document',
      'rpc',
      'toast',
      'pushRaw',
      'shortId',
      'loadApprovals',
      'reportRpcError',
      source + '\nreturn { resolveApproval: resolveApproval }',
    ) as (...args: unknown[]) => { resolveApproval: (id: string, approve: boolean) => Promise<unknown> }
    const toasts: { text: string; kind: string }[] = []
    const api = factory(
      scope.document,
      () => Promise.resolve(APPROVED),
      (text: string, kind: string) => void toasts.push({ text, kind }),
      () => undefined,
      (value: string) => value,
      () => Promise.resolve(null),
      (title: string) => void toasts.push({ text: '错误条：' + title, kind: 'bad' }),
    )
    await api.resolveApproval('apr_4', true)
    assert.ok(toasts.some((one) => one.kind === 'bad'), '锁按钮时炸了也要有红条，不能静默')
  })

  it('空 id 不发请求，直接说清"数据可能过期，刷新"', async () => {
    const h = makeHarness(() => APPROVED)
    await h.resolveApproval('', true)
    assert.equal(h.calls.length, 0)
    assert.ok(h.toasts.some((one) => one.kind === 'bad' && one.text.indexOf('刷新') >= 0))
  })
})

describe('审批按钮：提交期间锁住，但只锁自己上锁的那些', () => {
  it('提交中把这条的按钮禁掉并显示"正在提交…"', async () => {
    const approve = fakeButton('apr_5', '通过')
    const reject = fakeButton('apr_5', '拒绝')
    const other = fakeButton('apr_9', '通过')
    const gate: { release: (() => void) | null } = { release: null }
    const h = makeHarness(
      () =>
        new Promise((resolve) => {
          gate.release = () => resolve(APPROVED)
        }),
      [approve, reject, other],
    )
    void h.resolveApproval('apr_5', true)
    assert.equal(approve.disabled, true)
    assert.equal(reject.disabled, true)
    assert.equal(approve.textContent, '正在提交…')
    assert.equal(other.disabled, false, '别的审批不许被连坐')
    if (gate.release !== null) gate.release()
  })

  it('本来就被业务禁用的按钮（提案与审批单不一致）失败后不许被解锁', async () => {
    const differ = fakeButton('apr_6', '通过', true)
    const reject = fakeButton('apr_6', '拒绝')
    const h = makeHarness(() => {
      throw new Error('boom')
    }, [differ, reject])
    await h.resolveApproval('apr_6', true)
    assert.equal(differ.disabled, true, '这道闸门不是一次失败的提交该拆的')
    assert.equal(reject.disabled, false, '自己锁的要放开')
  })
})

describe('交付脚本里的调用点：都与这套语义对齐', () => {
  it('所有 resolveApproval 调用点都在三实参以内（两个实参是常态）', () => {
    const matches = [...SCRIPT.matchAll(/resolveApproval\(([^)]*)\)/g)].map((one) => one[1] ?? '')
    assert.ok(matches.length >= 6, '调用点数量不对：' + String(matches.length))
    for (const args of matches) {
      const count = args.split(',').length
      assert.ok(count <= 3, '有调用点传了 ' + String(count) + ' 个实参：' + args)
    }
  })

  it('每处裁决按钮都带 data-approval-id（否则提交期间锁不住、连点会撞 already-approved）', () => {
    /* 三处按钮：四宫格内联 2 个、应急卡片 2 个、审批页 2 个 */
    const occurrences = SCRIPT.split('data-approval-id').length - 1
    assert.ok(occurrences >= 6, 'data-approval-id 只出现 ' + String(occurrences) + ' 次，按钮漏了')
  })
})
