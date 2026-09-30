/**
 * 审批中心布局契约。
 *
 * 审批页是高频操作面：它不能退回成一条把待处理和历史记录混在一起的长列表。
 * 这里锁住页面骨架与交互边界；真实数据裁决仍由 Hub/RPC 测试覆盖。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import path from 'node:path'

import { renderControlUi, renderControlUiScript } from '../src/web/ui.ts'
import { CONSOLE_SOURCE, CSS_SOURCE } from './console-source.ts'

const PAGE = renderControlUi({ hubId: 'approval-test', hubName: '测试 Hub', scriptUrl: '/ui.js' })
const SCRIPT = renderControlUiScript()

function extractFunction(name: string): string {
  const start = SCRIPT.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `交付脚本里找不到 function ${name}(`)
  let depth = 0
  let quote = ''
  for (let index = SCRIPT.indexOf('{', start); index < SCRIPT.length; index += 1) {
    const char = SCRIPT[index]
    if (quote !== '') {
      if (char === quote && SCRIPT[index - 1] !== '\\') quote = ''
      continue
    }
    if (char === "'" || char === '"') quote = char
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return SCRIPT.slice(start, index + 1)
    }
  }
  throw new Error(`function ${name} 的花括号没有配对`)
}

describe('审批中心布局', () => {
  it('把待处理与已处理拆成两个可切换的工作区', () => {
    assert.equal(PAGE.match(/id="viewApprovals"/g)?.length, 1)
    assert.equal(PAGE.match(/id="approvalList"/g)?.length, 1)
    assert.equal(PAGE.match(/id="approvalHistoryList"/g)?.length, 1)
    assert.equal(PAGE.match(/id="approvalDetail"/g)?.length, 1)
    assert.equal(PAGE.match(/id="approvalHistoryDetail"/g)?.length, 1)
    assert.match(PAGE, /id="approvalTabPending"[^>]+aria-controls="approvalPendingPanel"/)
    assert.match(PAGE, /id="approvalTabHistory"[^>]+aria-controls="approvalHistoryPanel"/)
  })

  it('详情区是审批动作的唯一落点，列表只负责选择请求', () => {
    assert.match(CONSOLE_SOURCE, /function renderApprovalQueue\(/)
    assert.match(CONSOLE_SOURCE, /function renderApprovalDetail\(/)
    assert.match(CONSOLE_SOURCE, /button\.onclick = function \(\) \{\s*state\.selectedApprovalId = key\s*renderApprovals\(\)/)
    assert.match(CONSOLE_SOURCE, /function setApprovalView\(view\)/)
    assert.match(CONSOLE_SOURCE, /approvalTabPending\.onclick = function \(\) \{ setApprovalView\('pending'\) \}/)
    assert.match(CONSOLE_SOURCE, /approvalTabHistory\.onclick = function \(\) \{ setApprovalView\('history'\) \}/)
  })

  it('状态文案与颜色覆盖 Hub 的全部审批状态', () => {
    const labels = extractFunction('approvalStatusLabel')
    for (const status of ['pending', 'approved', 'denied', 'expired', 'cancelled', 'answered']) {
      assert.match(labels, new RegExp(`status === '${status}'`))
    }
    const classes = extractFunction('approvalStatusClass')
    assert.match(classes, /status === 'approved' \|\| status === 'answered'/)
    assert.match(classes, /status === 'denied' \|\| status === 'expired'/)
  })

  it('待处理筛选严格使用 pending，历史区不会误显示未决请求', () => {
    const source = extractFunction('approvalItems')
    const scope = {
      state: {
        approvals: [
          { approvalId: 'pending', status: 'pending', requestedAtMs: 3 },
          { approvalId: 'done', status: 'approved', requestedAtMs: 2, resolvedAtMs: 4 },
          { approvalId: 'cancelled', status: 'cancelled', requestedAtMs: 1, resolvedAtMs: 5 },
        ],
      },
      approvalTimestamp: (item: { requestedAtMs: number; resolvedAtMs?: number }, history: boolean): number =>
        history ? item.resolvedAtMs ?? item.requestedAtMs : item.requestedAtMs,
    }
    const factory = new Function(
      'scope',
      `with (scope) { ${source}; return approvalItems }`,
    ) as (scope: unknown) => (history: boolean) => Array<{ approvalId: string }>
    const approvalItems = factory(scope)
    assert.deepEqual(approvalItems(false).map((item) => item.approvalId), ['pending'])
    assert.deepEqual(approvalItems(true).map((item) => item.approvalId), ['cancelled', 'done'])
  })

  it('保留移动端单列回流，并保留真实 RPC 裁决入口', () => {
    const style = CSS_SOURCE
    assert.match(style, /@media \(max-width: 760px\)[\s\S]*?\.approval-workspace \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    assert.match(CONSOLE_SOURCE, /rpc\('approval\.resolve', params\)/)
    assert.match(CONSOLE_SOURCE, /rpc\('dsh\.question\.answer', \{ approvalId: approvalId, answer: answer \}\)/)
  })

  it('交付脚本仍然可以被浏览器解析', () => {
    assert.doesNotThrow(() => new vm.Script(SCRIPT))
  })
})
