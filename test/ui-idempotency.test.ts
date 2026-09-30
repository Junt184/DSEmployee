/**
 * 控制台幂等表 ↔ 服务端方法表的一致性。
 *
 * 为什么值得一条独立的测试：这两份清单在**两个文件、两种语言里**，靠人记得同步。
 * 漏一条的后果不是"报个错"，而是**那个功能整条不可用** —— 控制台不带幂等键，
 * Hub 直接回 `idempotency-key-required`，而那个错误很容易被当成偶发问题略过。
 *
 * 真实事故：`employee.files.upload` 与 `dsh.question.answer` 就是这么漏的 ——
 * 用 CLI 测（它自动补键）一切正常，控制台上却必然失败。
 *
 * 另外 rpc() 里也加了一层自愈兜底（服务端说缺键就补一个重发），
 * 但兜底不该替代这份清单：多一次往返、且自愈只在真出问题时才被发现。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import path from 'node:path'

import { METHODS } from '../src/protocol/methods.ts'
import { CONSOLE_SOURCE } from './console-source.ts'


/** 方法表是 `as const`，逐条的字面量类型里没有 `idempotent` 键 —— 放宽一份视图再读。 */
const SPECS = METHODS as unknown as Record<
  string,
  { readonly idempotent?: boolean; readonly roles: readonly string[] }
>

/** 从 ui.ts 里抠出 IDEMPOTENT_METHODS 这张表的键。 */
function consoleIdempotentMethods(): Set<string> {
  const start = CONSOLE_SOURCE.indexOf('var IDEMPOTENT_METHODS = {')
  assert.ok(start >= 0, 'ui.ts 里应能找到 IDEMPOTENT_METHODS')
  const end = CONSOLE_SOURCE.indexOf('}', start)
  const block = CONSOLE_SOURCE.slice(start, end)
  const keys = new Set<string>()
  for (const match of block.matchAll(/'([a-zA-Z.]+)'\s*:\s*true/g)) {
    if (match[1] !== undefined) keys.add(match[1])
  }
  return keys
}

describe('控制台幂等表与服务端方法表一致', () => {
  const table = consoleIdempotentMethods()

  it('方法表里 operator 能调用、且要求幂等键的方法，控制台表里必须都有', () => {
    const missing: string[] = []
    for (const [name, spec] of Object.entries(SPECS)) {
      if (spec.idempotent !== true) continue
      if (!spec.roles.includes('operator')) continue
      if (!table.has(name)) missing.push(name)
    }
    assert.deepEqual(
      missing,
      [],
      `这些方法要求幂等键、控制台又会调用，但 IDEMPOTENT_METHODS 里没有：${missing.join(', ')}`,
    )
  })

  it('控制台表里不该有多余项（方法表里已不要求幂等键的应删掉）', () => {
    const extra: string[] = []
    for (const name of table) {
      const spec = SPECS[name]
      if (spec === undefined) {
        extra.push(`${name}（方法表里已无此方法）`)
        continue
      }
      if (spec.idempotent !== true) extra.push(`${name}（方法表未标记 idempotent）`)
    }
    assert.deepEqual(extra, [], `IDEMPOTENT_METHODS 里这些项已过期：${extra.join(', ')}`)
  })
})
