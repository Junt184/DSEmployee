/**
 * 交付脚本必须能当 **ES module** 解析，且**跨片段不许有同名顶层声明**
 * —— 它就是这么加载的（`<script type="module" src="/ui.js">`）。
 *
 * 为什么单独立一条：原来那条守卫用的是 `new vm.Script(SCRIPT)`，那是**普通脚本**模式，
 * 而普通脚本里重复的函数声明是合法的（后者覆盖前者）；模块顶层是词法作用域，重复即 `SyntaxError`。
 * 守了脚本模式等于没守。
 *
 * 真实事故（2026-09-24，手机通知那次）：`90-devices` 里加了一个和 `00-core` **同名**的
 * `bytesToBase64Url`（而且根本没人调用它）→ 整份脚本在浏览器里解析失败 →
 * **页面只剩静态骨架**：不连 WS、不渲染工位、标签点了没反应、原始日志一条都没有，
 * 而控制台里只有一行 `Identifier 'x' has already been declared`，看起来像"网络问题"。
 * 这条测试就是让这类改动在 `npm test` 阶段当场炸掉。
 *
 * 两条互补的检查（**都留着**，因为抓到的东西不一样）：
 *   · 模块语义解析（ts.transpileModule）：抓词法层面的模块错误；
 *   · 跨片段同名顶层声明扫描：抓"两个片段各写了一份同名 function/var" —— 这次的事故就是它抓到的。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import ts from 'typescript'

import { renderControlUiScript } from '../src/web/ui.ts'

const SCRIPT = renderControlUiScript()
const SCRIPT_DIR = path.join(import.meta.dirname, '..', 'src', 'web', 'script')

/** 按模块语义解析，返回全部**错误**诊断（转成"第 N 行：消息"，便于直接读） */
function moduleErrors(source: string): string[] {
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, allowJs: true, checkJs: false },
    reportDiagnostics: true,
    fileName: 'ui-check.mjs',
  })
  return (result.diagnostics ?? [])
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => {
      const line =
        d.file !== undefined && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0
      return '第 ' + String(line) + ' 行：' + ts.flattenDiagnosticMessageText(d.messageText, ' ')
    })
}

/**
 * 跨片段查同名顶层声明。
 *
 * 片段是**拼成一份脚本**的，所以两个片段各声明一次同名顶层函数 = 模块模式下整份脚本挂掉。
 * 只统计顶格写的 `function` / `var`（片段里的代码都是顶格；缩进的是函数内部的东西）。
 */
function clashingTopLevelNames(files: Array<{ file: string; text: string }>): string[] {
  const declared = new Map<string, string[]>()
  for (const { file, text } of files) {
    for (const match of text.matchAll(/^(?:function|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = match[1] ?? ''
      if (name === '') continue
      declared.set(name, [...(declared.get(name) ?? []), file])
    }
  }
  return [...declared.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([name, owners]) => name + ' ← ' + owners.join(' + '))
}

describe('交付脚本按模块语义必须能解析（重复顶层声明会让整页死掉）', () => {
  it('模块语义解析不报错', () => {
    const errors = moduleErrors(SCRIPT)
    assert.deepEqual(errors, [], '交付脚本当模块解析时报错：\n' + errors.slice(0, 8).join('\n'))
  })

  it('跨片段没有同名顶层声明（这次事故的直接原因）', () => {
    const files = readdirSync(SCRIPT_DIR)
      .filter((name) => name.endsWith('.ts'))
      .sort()
      .map((file) => ({ file, text: readFileSync(path.join(SCRIPT_DIR, file), 'utf8') }))
    assert.ok(files.length >= 10, '片段没扫到，路径要跟着改：' + String(files.length))
    const clashes = clashingTopLevelNames(files)
    assert.deepEqual(clashes, [], '这些名字在多个片段里各声明了一次（模块模式下会 SyntaxError）：\n' + clashes.join('\n'))
  })

  it('同名扫描本身是有效的（拿一段反例自测，避免它哪天变空转）', () => {
    const clashes = clashingTopLevelNames([
      { file: '00-core.ts', text: 'function bytesToBase64Url(bytes) { return bytes }\nvar sharedThing = 1\n' },
      { file: '90-devices.ts', text: 'function bytesToBase64Url(buffer) { return buffer }\n' },
    ])
    assert.deepEqual(clashes, ['bytesToBase64Url ← 00-core.ts + 90-devices.ts'], '守卫抓不到重复声明，就是假的')
  })
})
