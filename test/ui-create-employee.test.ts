/** 新建员工面板的前端结构契约。 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import path from 'node:path'

import { renderControlUi, renderControlUiScript } from '../src/web/ui.ts'
import { CONSOLE_SOURCE, CSS_SOURCE } from './console-source.ts'

const PAGE = renderControlUi({ hubId: 'create-test', hubName: '测试 Hub', scriptUrl: '/ui.js' })
const SCRIPT = renderControlUiScript()

describe('新建员工面板', () => {
  it('保留原有字段 id，同时改成数字工位的三段式结构', () => {
    assert.match(PAGE, /新建一个数字员工/)
    assert.match(PAGE, /把一位新同事放进办公区/)
    for (const id of ['createPreview', 'createName', 'createRole', 'createGroupSlot', 'createPositionSlot', 'createNode', 'createIntro', 'btnCancelCreateEmployee', 'btnCreateEmployee']) {
      assert.equal(PAGE.split(`id="${id}"`).length - 1, 1, `${id} 应只出现一次`)
    }
    assert.match(PAGE, /① 基本资料/)
    assert.match(PAGE, /② 办公位置/)
    assert.match(PAGE, /③ 同事设定/)
  })

  it('预览会复用手绘头像，并随名字、岗位、分组和节点变化', () => {
    assert.match(SCRIPT, /function renderCreatePreview\(\)/)
    assert.match(SCRIPT, /avatarNode\(employee, 88\)/)
    assert.match(SCRIPT, /createPreviewPositionLabel\(\)/)
    assert.match(SCRIPT, /createPreviewGroupLabel\(\)/)
    assert.match(SCRIPT, /createNameInput\.addEventListener\('input', function \(\)/)
    assert.match(SCRIPT, /createRoleInput\.addEventListener\('input', renderCreatePreview\)/)
    assert.match(SCRIPT, /createNodeSelect\.addEventListener\('change', renderCreatePreview\)/)
  })

  it('仍然只使用原有 employee.create RPC，不改变后端创建协议', () => {
    assert.match(SCRIPT, /rpc\('employee\.create', params\)/)
    assert.doesNotMatch(SCRIPT, /rpc\('employee\.create-preview'/)
  })

  it('桌面端左右分栏，窄屏自动堆叠', () => {
    const style = CSS_SOURCE
    assert.match(style, /\.create-workspace \{ display: grid; grid-template-columns: minmax\(190px, 230px\) minmax\(0, 1fr\)/)
    assert.match(style, /@media \(max-width: 760px\)[\s\S]*?\.create-workspace \{ grid-template-columns: minmax\(0, 1fr\)/)
  })
})
