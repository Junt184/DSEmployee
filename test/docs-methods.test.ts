/**
 * `docs/03 §3.6 方法表` ↔ `src/protocol/methods.ts` 的逐条一致性。
 *
 * 为什么值得一条独立测试：这两份清单在**两个文件、两种载体**里（markdown 表格 vs 代码常量），
 * 靠人记得同步。而该文档开头明确写着"实现与本文冲突时以本文为准，并同步修订" ——
 * 也就是**文档是规范**。规范里列出不存在的方法，照它写脚本的人会直接吃 `unknown-method`；
 * 漏掉已实现的方法，读者会以为那能力不存在。实测两类都发生过：
 *   · 幽灵方法：`node.rename`（`node.admin`）、`employee.runs.list`；
 *   · 漏列 18 条：`employee.llm.*`、`employee.avatar.*`、`session.subscribe`/`unsubscribe`/`push`、
 *     `office.order.*`、`employee.files.upload`、`node.register`、`node.paircode.offer`、`device.pair.redeem`。
 *
 * 与 `test/ui-idempotency.test.ts` 同一套路（那份守的是控制台的幂等键清单）：
 * 文档表格用机器可解析的写法，测试逐条比对，两个方向都要相等。
 *
 * ⚠️ 文档只存在本地、不入库（见 `.gitignore` 的 `docs/` 一条），所以**公开 clone 里没有这个文件**。
 * 因此这里是**惰性读取 + 整组跳过**，而不是在模块加载时 readFileSync ——
 * 否则光是把仓库 clone 下来，`npm test` 就会以 ENOENT 直接红（实测过：253/254）。
 * 在作者本机（文档在）这条测试的牙齿一点不减。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import path from 'node:path'

import { METHODS } from '../src/protocol/methods.ts'

const DOC_PATH = path.join(import.meta.dirname, '..', 'docs', '03-总体设计契约.md')

/** 文档不在（公开 clone）时为 undefined —— 下面整组跳过，并说明原因。 */
const DOC = existsSync(DOC_PATH) ? readFileSync(DOC_PATH, 'utf8') : undefined

/** 取文档文本；本函数只在未被跳过的用例里被调用。 */
function docText(): string {
  assert.ok(DOC !== undefined, 'docs/03 不存在 —— 该组本该被跳过，不该走到这里')
  return DOC
}

/** §3.6 的表格正文（到下一个 `###` 标题为止）。 */
function methodTableSection(): string {
  const DOC = docText()
  const start = DOC.indexOf('### 3.6 方法表')
  assert.ok(start >= 0, 'docs/03 里找不到 §3.6 方法表')
  const end = DOC.indexOf('### 3.7', start)
  assert.ok(end > start, '§3.6 之后找不到 §3.7')
  return DOC.slice(start, end)
}

/** 表格"方法"列里列出的方法名（第二列；`event:` 开头的是事件，不算方法）。
    先剥掉括号里的补充说明 —— 例如 `session.create`（可选 `title`）里的 `title` 不是方法。 */
function documentedMethods(): string[] {
  const names: string[] = []
  for (const line of methodTableSection().split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|')
    if (cells.length < 3) continue
    const methodCell = String(cells[2])
    if (methodCell.includes('event:')) continue
    const withoutNotes = methodCell.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '')
    for (const match of withoutNotes.matchAll(/`([a-z][A-Za-z.]*)`/g)) names.push(String(match[1]))
  }
  return names
}

describe(
  'docs/03 §3.6 方法表与代码一致',
  { skip: DOC === undefined ? '本机没有 docs/03（内部文档不入库，只存本地）—— 跳过' : false },
  () => {
    it('文档里不该有代码里不存在的方法（幽灵方法会让人写出必然失败的脚本）', () => {
      const real = new Set(Object.keys(METHODS))
      const ghosts = documentedMethods().filter((name) => !real.has(name))
      assert.deepEqual(ghosts, [], `文档列了但代码里没有：${ghosts.join(', ')}`)
    })

    it('代码里不该有文档没列的方法（漏列会让人以为那个能力不存在）', () => {
      const documented = new Set(documentedMethods())
      const missing = Object.keys(METHODS).filter((name) => !documented.has(name))
      assert.deepEqual(missing, [], `代码里有但文档没列：${missing.join(', ')}`)
    })

    it('表格本身可解析（防"表格改成了别的写法导致上面两条空转"）', () => {
      const names = documentedMethods()
      assert.ok(names.length >= 40, `只解析到 ${names.length} 条 —— 表格写法多半变了，测试会失去牙齿`)
      assert.ok(names.includes('session.prompt'), '解析结果里没有 session.prompt，解析规则需要更新')
    })
  },
)
