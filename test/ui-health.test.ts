/**
 * 体检工作台：总览、问题队列、详情与重复声明护栏。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { renderControlUi, renderControlUiScript } from '../src/web/ui.ts'

const MARKUP = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'markup.ts'), 'utf8')
const CSS = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'css.ts'), 'utf8')
const HEALTH = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'script', '50-health.ts'), 'utf8')
const SCRIPT = renderControlUiScript()
const PAGE = renderControlUi({ hubId: 'hub-test', hubName: '测试 Hub', scriptUrl: '/ui.js' })

describe('体检页：工作台结构', () => {
  it('发出总览、筛选、问题队列和详情区域', () => {
    for (const id of [
      'healthState',
      'healthStateTitle',
      'healthStateText',
      'healthBadCount',
      'healthWarnCount',
      'healthInfoCount',
      'healthLastChecked',
      'healthFilterAll',
      'healthFilterOpen',
      'healthFilterOk',
      'healthBody',
      'healthDetail',
      'healthDetailEmpty',
    ]) {
      assert.ok(MARKUP.includes(`id="${id}"`), `体检页缺少 ${id}`)
    }
    assert.ok(MARKUP.includes('class="health-workspace"'), '缺少体检工作区')
    assert.ok(MARKUP.includes('class="health-queue"'), '缺少体检问题队列')
  })

  it('桌面端两栏、窄屏单列，状态颜色和任务页/审批页一致', () => {
    const workspace = /\.health-workspace \{([^}]*)\}/.exec(CSS)?.[1] ?? ''
    assert.ok(/display:\s*grid/.test(workspace), '体检工作区没有使用网格')
    assert.ok(/grid-template-columns:\s*minmax\(250px, 320px\)/.test(workspace), '左侧问题队列没有稳定宽度')
    assert.ok(/\.health-workspace \{\s*grid-template-columns:\s*minmax\(0, 1fr\);/.test(CSS), '窄屏没有收成单列')
    assert.ok(/\.health-detail \{\s*order:\s*-1;/.test(CSS), '窄屏详情没有置顶')
    assert.ok(/\.health-state\.bad \.health-state-dot/.test(CSS), '缺少阻断状态')
    assert.ok(/\.health-state\.warn \.health-state-dot/.test(CSS), '缺少需处理状态')
  })
})

describe('体检页：统一问题模型', () => {
  it('问题从同一份 healthIssues 驱动总览、筛选和详情', () => {
    assert.ok(/var healthIssues = \[\]/.test(HEALTH))
    assert.ok(/function healthSetOverview\(\)/.test(HEALTH))
    assert.ok(/function healthRenderQueue\(\)/.test(HEALTH))
    assert.ok(/function healthRenderDetail\(issue\)/.test(HEALTH))
    assert.ok(/healthSetOverview\(\)\s*\n\s*healthRenderQueue\(\)/.test(HEALTH))
    assert.ok(/healthFilterMode === 'open'/.test(HEALTH))
    assert.ok(/healthFilterMode === 'ok'/.test(HEALTH))
  })

  it('Hub 指纹未知也会进入“需处理”统计，避免正文和标签不一致', () => {
    assert.ok(/hubSeverity = 'warn'/.test(HEALTH), 'Hub 指纹未知应是 warn')
    assert.ok(/var problems = open/.test(HEALTH), '标签计数应来自统一问题模型')
    assert.ok(!/if \(hubRuntime === 'dist'\) problems \+= 1/.test(HEALTH), '不应再单独维护旧 problems 计数')
  })

  it('保留节点升级动作和现有 RPC', () => {
    assert.ok(/rpc\('node\.list'/.test(HEALTH))
    assert.ok(/rpc\('node\.update'/.test(HEALTH))
    assert.ok(/function buildNodeUpdateButton\(node\)/.test(HEALTH))
    assert.ok(/healthRenderDetail\(selected\)/.test(HEALTH))
  })
})

describe('体检页：脚本完整性', () => {
  it('浏览器脚本可解析，base64url 编码函数只有一份', () => {
    assert.doesNotThrow(() => new Function(SCRIPT))
    assert.equal((SCRIPT.match(/function bytesToBase64Url\(/g) ?? []).length, 1)
    assert.ok(PAGE.includes('id="healthDetail"'))
  })
})
