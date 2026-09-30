/**
 * 定时页工作台：结构契约与交付脚本保护。
 *
 * 定时页只重构前端信息架构，job.* 协议和字段 id 保持不变：
 * 左侧任务列表负责扫一眼，右侧详情负责编辑与执行。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { renderControlUi, renderControlUiScript } from '../src/web/ui.ts'

const MARKUP = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'markup.ts'), 'utf8')
const CSS = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'css.ts'), 'utf8')
const JOBS = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'script', '45-jobs.ts'), 'utf8')
const PAGE = renderControlUi({ hubId: 'hub-test', hubName: '测试 Hub', scriptUrl: '/ui.js' })
const SCRIPT = renderControlUiScript()

describe('定时页：任务工作台结构', () => {
  it('保留原有协议字段，同时发出列表、详情和概览区域', () => {
    for (const id of ['viewJobs', 'jobList', 'jobForm', 'jobName', 'jobEmployee', 'jobInterval', 'jobPrompt', 'btnSaveJob', 'btnResetJob']) {
      assert.ok(MARKUP.includes(`id="${id}"`), `缺少既有控件 ${id}`)
    }
    for (const id of ['jobEnabledSummary', 'jobNextSummary', 'jobOfflineSummary', 'btnNewJob', 'jobDetail', 'jobDetailEmpty', 'jobFormTitle', 'jobFormState']) {
      assert.ok(MARKUP.includes(`id="${id}"`), `缺少工作台区域 ${id}`)
    }
    assert.ok(MARKUP.includes('class="jobs-workspace"'), '缺少任务工作区')
    assert.ok(MARKUP.includes('class="jobs-queue"'), '缺少左侧任务列表')
    assert.ok(MARKUP.includes('class="job-detail"'), '缺少右侧任务详情')
    assert.ok(JOBS.includes("rpc('job.upsert'"), '保存仍应走 job.upsert')
    assert.ok(JOBS.includes("rpc('job.list'"), '列表仍应走 job.list')
    assert.ok(JOBS.includes("rpc('job.runNow'"), '立即运行仍应走 job.runNow')
    assert.ok(JOBS.includes("rpc('job.remove'"), '删除仍应走 job.remove')
  })

  it('桌面端是列表 + 详情两栏，窄屏收成单列', () => {
    const workspace = /\.jobs-workspace \{([^}]*)\}/.exec(CSS)?.[1] ?? ''
    assert.ok(/display:\s*grid/.test(workspace), '工作区没有使用网格')
    assert.ok(/grid-template-columns:\s*minmax\(240px, 34%\)/.test(workspace), '桌面端左侧列表没有稳定宽度')
    assert.ok(/\.jobs-workspace \{\s*grid-template-columns:\s*minmax\(0, 1fr\);/.test(CSS), '窄屏没有收成单列')
    assert.ok(/\.job-detail \{\s*order:\s*-1;/.test(CSS), '窄屏详情没有置于任务列表前，编辑流程会很长')
  })

  it('任务行有选中态、键盘入口和摘要截断，不把指令全文铺满列表', () => {
    assert.ok(/selected = jobDetailMode === 'edit'/.test(JOBS), '任务行没有选中态装配')
    assert.ok(/setAttribute\('role', 'button'\)/.test(JOBS), '任务行没有可访问角色')
    assert.ok(/setAttribute\('tabindex', '0'\)/.test(JOBS), '任务行没有键盘焦点入口')
    assert.ok(/-webkit-line-clamp:\s*2/.test(CSS), '指令摘要没有限制行数')
  })

  it('概览数字随任务列表重绘，而不是写死在模板里', () => {
    assert.ok(/function renderJobSummary\(\)/.test(JOBS), '缺少任务概览重绘函数')
    assert.ok(/jobEnabledSummary/.test(JOBS), '没有更新启用数量')
    assert.ok(/jobNextSummary/.test(JOBS), '没有更新下一次运行')
    assert.ok(/jobOfflineSummary/.test(JOBS), '没有更新离线数量')
  })
})

describe('定时页：交付完整性', () => {
  it('整页真的包含工作台标记，交付脚本能解析', () => {
    assert.ok(PAGE.includes('id="jobDetail"'), '完整页面没有发出任务详情')
    assert.ok(PAGE.includes('id="jobEnabledSummary"'), '完整页面没有发出任务概览')
    assert.doesNotThrow(() => new Function(SCRIPT), '交付脚本必须能通过 JavaScript 解析')
  })
})
