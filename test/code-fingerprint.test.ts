/**
 * 代码指纹 —— "这台机器跑的和我手上这份是不是同一份代码"。
 *
 * 这条能力的存在理由与测法都来自真实事故：节点是手动升级的，跑旧代码时**不报错**
 * （照常连上、照常列员工，只是能力缺失），于是"版本分叉"长期不可见。
 * 所以测试盯的不是"哈希算法对不对"，而是**可比较性与不可欺骗性**：
 *   · 内容变一个字，指纹必须变（否则分叉检测失效）；
 *   · 行尾不同（Windows 检出 CRLF）**不得**改变指纹 —— 跨平台假警报会让整套机制
 *     失去信任，比没有还糟；
 *   · 读不到源码时必须抛错，而不是返回一个看着正常的字符串（那正是要根除的"沉默"）；
 *   · 覆盖范围明确：src/ 与 bin/ 与 package.json 算，test/ 与 docs/ 不算。
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  codeFingerprint,
  contentHash,
  currentCodeFingerprint,
  fingerprintFiles,
  fingerprintListText,
  posixRelative,
  runtimeEntry,
} from '../src/protocol/build.ts'

async function withTree(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-fingerprint-'))
  try {
    await mkdir(path.join(root, 'src'), { recursive: true })
    await mkdir(path.join(root, 'bin'), { recursive: true })
    await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
    /* 真树一定有 src/cli.ts（`bin/dse.mjs` 的源码入口）—— 没有它 runtimeEntry 会是
       unknown，而"入口形态"正是本文件要测的东西之一 */
    await writeFile(path.join(root, 'src', 'cli.ts'), 'export const cli = 1\n')
    await writeFile(path.join(root, 'bin', 'dse.mjs'), '#!/usr/bin/env node\n')
    await writeFile(path.join(root, 'package.json'), '{"name":"x"}\n')
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('内容哈希', () => {
  it('确定性 + 改一个字就变（拼长度让"同长不同内容"更难撞）', () => {
    assert.equal(contentHash('abc'), contentHash('abc'))
    assert.notEqual(contentHash('abc'), contentHash('abd'))
    assert.notEqual(contentHash('abc'), contentHash('abcd'))
  })
})

describe('代码指纹', () => {
  it('同一棵树 → 同一指纹；两次调用稳定', async () => {
    await withTree(async (root) => {
      assert.equal(codeFingerprint(root), codeFingerprint(root))
    })
  })

  it('改一行源码 → 指纹变（分叉检测的前提）', async () => {
    await withTree(async (root) => {
      const before = codeFingerprint(root)
      await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 2\n')
      assert.notEqual(codeFingerprint(root), before)
    })
  })

  it('行尾 CRLF 与 LF 必须同指纹 —— 否则 Windows 检出天天误报', async () => {
    await withTree(async (root) => {
      const lf = codeFingerprint(root)
      await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1\r\n')
      await writeFile(path.join(root, 'bin', 'dse.mjs'), '#!/usr/bin/env node\r\n')
      await writeFile(path.join(root, 'package.json'), '{"name":"x"}\r\n')
      assert.equal(codeFingerprint(root), lf)
    })
  })

  it('路径分隔符：Windows 的反斜杠写法必须与 POSIX 同指纹（否则 Windows 节点永远"不一致"）', async () => {
    /* 真机踩到（2026-09-25）：收集文件用 path.join，Windows 给出 `src\web\ui.ts`。
       同一份代码于是算出两个指纹 —— Windows 节点明明已经升到 Hub 同一个提交（e6b123d），
       体检却一直红着；两边的真实差异只是 57 条路径里的分隔符
       （同一棵树：POSIX 算 67bb9c-1hv、反斜杠算 1gifhh6-1hv，正是它上报的那个值）。
       这条断言在 mac/Linux 上也能跑 —— 把反斜杠写法的清单喂进 fingerprintListText。 */
    await withTree(async (root) => {
      const files = fingerprintFiles(root)
      const posix = contentHash(fingerprintListText(root, files))
      const windowsStyle = contentHash(fingerprintListText(root, files.map((file) => file.split('/').join('\\'))))
      assert.equal(windowsStyle, posix, '同一份代码，两种路径写法必须同指纹')
      assert.equal(posix, codeFingerprint(root), 'codeFingerprint 走的就是这条清单')
    })
  })

  it('posixRelative 只做分隔符归一（两种写法都收敛到同一种）', () => {
    assert.equal(posixRelative('src\\web\\ui.ts'), 'src/web/ui.ts')
    assert.equal(posixRelative('src/web/ui.ts'), 'src/web/ui.ts')
    assert.equal(posixRelative('bin\\dse.mjs'), 'bin/dse.mjs')
  })

  it('test/ 与 docs/ 的变化不影响指纹（覆盖范围是"运行时代码"）', async () => {
    await withTree(async (root) => {
      const before = codeFingerprint(root)
      await mkdir(path.join(root, 'test'), { recursive: true })
      await mkdir(path.join(root, 'docs'), { recursive: true })
      await writeFile(path.join(root, 'test', 'x.test.ts'), '// 测试改动\n')
      await writeFile(path.join(root, 'docs', 'x.md'), '# 文档\n')
      assert.equal(codeFingerprint(root), before)
    })
  })

  it('dist 只有"真的会被加载"时才算进指纹 —— 否则顺手 build 一次就成假警报', async () => {
    await withTree(async (root) => {
      const before = codeFingerprint(root)
      assert.ok(!fingerprintFiles(root).some((file) => file.startsWith('dist/')))

      // 只有零散编译产物、没有入口 dist/src/cli.js ⇒ bin/dse.mjs 仍会加载源码
      await mkdir(path.join(root, 'dist', 'src'), { recursive: true })
      await writeFile(path.join(root, 'dist', 'src', 'a.js'), 'export const a = 1;\n')
      assert.equal(runtimeEntry(root), 'src')
      assert.equal(codeFingerprint(root), before, '不会加载的东西不该影响指纹（否则是假警报）')

      // 入口出现了 ⇒ 之后启动的进程会加载 dist，那时它**本来就**不是同一份代码
      await writeFile(path.join(root, 'dist', 'src', 'cli.js'), '// 入口\n')
      assert.equal(runtimeEntry(root), 'dist')
      const files = fingerprintFiles(root)
      assert.ok(
        files.some((file) => file === 'dist/src/a.js'),
        '会加载 dist 时，编译产物必须计入指纹（路径一律 POSIX 写法）',
      )
      assert.notEqual(codeFingerprint(root), before)
    })
  })

  it('runtimeEntry 按 bin/dse.mjs 的规则判断入口（dist 优先）', async () => {
    await withTree(async (root) => {
      await mkdir(path.join(root, 'src'), { recursive: true })
      await writeFile(path.join(root, 'src', 'cli.ts'), '// 入口\n')
      assert.equal(runtimeEntry(root), 'src', '只有源码时是 src')
      await mkdir(path.join(root, 'dist', 'src'), { recursive: true })
      await writeFile(path.join(root, 'dist', 'src', 'cli.js'), '// 编译产物\n')
      assert.equal(runtimeEntry(root), 'dist', '有编译产物时 bin/dse.mjs 会优先加载它')
    })
  })

  it('没有源码时抛错，而不是返回一个看起来正常的字符串', async () => {
    const empty = await mkdtemp(path.join(process.cwd(), '.tmp-fingerprint-empty-'))
    try {
      assert.throws(() => codeFingerprint(empty))
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('本仓库能算出指纹（非空、稳定）', () => {
    const first = currentCodeFingerprint()
    assert.equal(typeof first, 'string')
    assert.ok((first ?? '').length > 0)
    assert.equal(currentCodeFingerprint(), first, '进程内应缓存同一个值')
  })
})
