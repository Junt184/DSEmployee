/**
 * 交付脚本里"引用了但没声明"的标识符 —— 用 TypeScript 编译器自己扫一遍。
 *
 * 为什么需要它（本会话两次真事故）：
 *   · 我写岗位面板时引用了 `SKILL_PANEL_IDS` 却忘了定义。`npx tsc --noEmit` **一片绿** ——
 *     客户端 JS 存在 `String.raw` 字符串里，项目里的 tsc 只把那段当字符串看；
 *     而它在浏览器里是一个 ReferenceError，会把整条右栏加载链静默打断。
 *   · 同一个文件里，注释中混进一个反引号会提前截断 `String.raw`，tsc 报的却是**几十行外**
 *     一行无辜代码的语法错（这个陷阱本会话踩了 6 次，只能靠人肉认出来）。
 *
 * 做法：把交付出去的那份脚本当**一个虚拟的 .js 文件**交给 TypeScript 编译器做语义检查
 * （`allowJs` + `checkJs`），然后**只保留 "Cannot find name" 这一类诊断**。
 * 不自己写词法/作用域分析 —— 第一版手写的扫描器被正则字面量（`/&/g` 里的 `g`）和
 * 字符串里的引号带偏，误报一片；编译器是现成依赖，作用域、类型、`lib.dom` 全都现成。
 *
 * 局限（不掩饰）：只查"名字找不到"这一类，不查类型错误（客户端 JS 没有类型标注）。
 * 它抓的是"拼错 / 忘定义"，不是全部错误。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import ts from 'typescript'

import { renderControlUiScript } from '../src/web/ui.ts'

const SCRIPT = renderControlUiScript()

/** TypeScript 的 "找不到名字" 诊断码（2304：Cannot find name；2552：给你个相似建议）。 */
const NAME_ERROR_CODES = new Set([2304, 2552])

/**
 * 把一段 JS 当虚拟文件做语义检查，返回"找不到名字"的诊断。
 * 只开 `allowJs + checkJs`：这样 lib.dom / lib.es 里的浏览器全局（document、localStorage、
 * crypto…）都算已知，不需要维护白名单 —— 白名单那种东西迟早会变成"漏报的借口"。
 */
function missingNames(source: string): Array<{ name: string; line: number }> {
  const fileName = 'delivered-ui.js'
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    skipLibCheck: true,
  }
  const host = ts.createCompilerHost(options)
  const originalGetSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
    if (name === fileName) return ts.createSourceFile(name, source, languageVersion, true, ts.ScriptKind.JS)
    return originalGetSourceFile(name, languageVersion, onError, shouldCreate)
  }
  host.fileExists = (name) => name === fileName || ts.sys.fileExists(name)
  host.readFile = (name) => (name === fileName ? source : ts.sys.readFile(name))

  const program = ts.createProgram([fileName], options, host)
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => NAME_ERROR_CODES.has(diagnostic.code))
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
      const name = /Cannot find name '([^']+)'/.exec(message)?.[1] ?? message
      const line =
        diagnostic.file !== undefined && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
          : 0
      return { name, line }
    })
}

describe('交付脚本里不许有"引用了但没声明"的标识符', () => {
  it('整个交付脚本扫下来，应当是零个 "Cannot find name"', () => {
    const findings = missingNames(SCRIPT)
    assert.deepEqual(
      findings,
      [],
      '以下名字在交付脚本里被引用但没有声明（浏览器里是 ReferenceError）：\n' +
        findings.map((finding) => `  第 ${finding.line} 行  ${finding.name}`).join('\n'),
    )
  })

  it('扫的是交付出去的那一份，不是源码文件的另一份拷贝', () => {
    assert.ok(SCRIPT.length > 100000, '交付脚本长度异常，可能扫到了别的东西')
    assert.ok(SCRIPT.includes('function renderPositionPanels'), '交付脚本里应当有岗位面板渲染函数')
    assert.ok(SCRIPT.includes('function appendDelta'), '交付脚本里应当有流式渲染函数')
  })
})

describe('这条检查自己得有效（否则它是摆设）', () => {
  it('植入一个未声明的标识符会被抓出来，并指出名字与行号', () => {
    const planted = SCRIPT.replace(
      'function renderPositionPanels(aside, employee, snapshot) {',
      'function renderPositionPanels(aside, employee, snapshot) {\n  if (plantedUndefinedThing === 1) return\n',
    )
    assert.notEqual(planted, SCRIPT, '没找到植入点 —— 这条测试自己也失效了')
    const findings = missingNames(planted)
    assert.deepEqual(
      findings.map((finding) => finding.name),
      ['plantedUndefinedThing'],
    )
    assert.ok((findings[0]?.line ?? 0) > 0, '应当带出行号')
  })

  it('历史事故复现：引用了 SKILL_PANEL_IDS 但定义改名了 → 必须报出来', () => {
    /* 只把**定义**改名，引用全部悬空 —— 这正是今天那次事故的形状
       （第一版我用"删掉一段"来构造，结果连带把引用也删了，测试自己失效）。 */
    const renamed = SCRIPT.replace('var SKILL_PANEL_IDS = ', 'var SKILL_PANEL_IDS_DEFINITION_RENAMED = ')
    assert.notEqual(renamed, SCRIPT, '没找到定义那一行 —— 这条复现失效了')
    assert.ok(
      missingNames(renamed).some((finding) => finding.name === 'SKILL_PANEL_IDS'),
      '定义改名后引用居然没报 —— 今天那次事故就会重演',
    )
  })

  it('作用域内的局部名不误报（形参 / var / catch / 解构 / 函数声明）', () => {
    const sample = [
      'function outer(argOne) {',
      '  var local = 1',
      '  var [first, second] = [1, 2]',
      '  try { return argOne + local + first + second } catch (err) { return String(err) }',
      '}',
      'outer(1)',
      'Math.max(1, 2)',
      'document.title',
      'localStorage.getItem(String(1))',
      'const link = /&/g',
      'link.test("x")',
    ].join('\n')
    assert.deepEqual(missingNames(sample), [])
  })

  it('字符串与注释里的词不算引用（第一版手写扫描器就栽在这里）', () => {
    const sample = [
      '// commentedOutName',
      '/* blockCommentedName */',
      'var text = "notAnIdentifier + alsoNotOne"',
      'var re = /^(\\d{4})-W(\\d{2})$/',
      'function read() { return text.length + re.source.length }',
      'read()',
    ].join('\n')
    assert.deepEqual(missingNames(sample), [])
  })
})
