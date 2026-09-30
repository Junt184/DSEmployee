/**
 * 发布面卫生：**本机绝对路径不许进公开仓库**。
 *
 * 为什么值得一条独立测试：这类泄漏不是"忘了删"，而是**搜不出来**。
 * 真事（本轮审计）：`test/ui-secretary.test.ts` 的夹具里留着一条生产上真实见到的报错原文 ——
 *
 *     ENOENT: ..., stat 'C:\\Users\\<真实用户名>\\<真实目录>\\employees\\<真实员工名>\\memory\\ref\\结论.md'
 *
 * 它在源码里写成**转义双反斜杠**，所以 `grep 'C:\Users'` 匹配不到；审计第一轮就是这么漏掉它的。
 * 靠"下次记得搜一下"是不行的 —— 搜索式打扫每次都会漏，因为它依赖搜索者当时想到的那个写法。
 * 所以这里改成**结构判据**：先把源码里的转义还原，再认"绝对路径 + 用户目录段"这个形状。
 *
 * 允许的只有占位用户名（`developer` / `example`）与产品自己的示例路径。
 * 真要写一条"生产上见到的那条报错"，把用户名换成占位符即可 —— 被测的形状（转义反斜杠、
 * Windows 盘符、中文路径段、`employees/<员工名>` 层级）一个都不用丢。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
const SCAN_DIRS = ['src', 'scripts', 'bin', 'test', 'design']
const SCAN_ROOT_FILES = ['README.md', 'README.en.md', 'package.json', 'tsconfig.json']
const SCAN_EXT = new Set(['.ts', '.mjs', '.js', '.sh', '.ps1', '.md', '.json', '.yml', '.yaml'])

/** 占位用户名：只有这些允许出现（真实用户名一律拦下，包括 `user` 这种看着像占位的）。 */
const PLACEHOLDER_USERS = new Set(['developer', 'example'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (SCAN_EXT.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

function publishedFiles(): string[] {
  const files = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)))
  for (const name of SCAN_ROOT_FILES) files.push(path.join(ROOT, name))
  return files
}

/**
 * 源码里的转义还原成"运行时看到的文本"。
 *
 * 这是本条测试存在的理由：`C:\\Users\\<用户名>` 在文件里看起来不像路径，在运行时才是路径。
 * 只还原这两个转义（`\\` → `\`、`\/` → `/`）—— 还原全部 JS 转义会把 `\n` 之类也吃掉，
 * 反而制造假路径。
 */
function unescape(text: string): string {
  return text.replace(/\\\\/g, '\\').replace(/\\\//g, '/')
}

interface Hit {
  file: string
  line: number
  text: string
}

/** 找"绝对路径 + 用户目录段"的形状（Windows 盘符与 POSIX 家目录两种）。 */
function userPathHits(file: string, raw: string): Hit[] {
  const text = unescape(raw)
  const hits: Hit[] = []
  const patterns = [
    /[A-Za-z]:[\\/]+Users[\\/]+([A-Za-z0-9._-]+)/g,
    /\/(?:Users|home)[\\/]+\/?([A-Za-z0-9._-]+)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const user = (match[1] ?? '').toLowerCase()
      if (PLACEHOLDER_USERS.has(user)) continue
      const line = text.slice(0, match.index).split('\n').length
      hits.push({ file, line, text: match[0] })
    }
  }
  return hits
}

describe('发布面卫生：本机绝对路径不进仓库', () => {
  it('没有"绝对路径 + 用户目录段"（转义写法也算）', () => {
    const hits = publishedFiles().flatMap((file) => userPathHits(path.relative(ROOT, file), readFileSync(file, 'utf8')))
    assert.deepEqual(
      hits,
      [],
      '这些位置写着本机绝对路径，把用户名换成占位符（developer）后形状仍可保留：\n' +
        hits.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join('\n'),
    )
  })

  it('判据自检：转义写法必须能被还原并认出（否则这条守卫是假的）', () => {
    /* 探针在运行时拼出来，源码里不出现完整路径 —— 否则这条自检自己会被上一条断言拦下。 */
    const probe = `ENOENT: stat 'C:${'\\'}\\Users\\someone\\工作\\employees\\甲\\x.md'`
    const hits = userPathHits('<probe>', probe)
    assert.equal(hits.length, 1, '转义的双反斜杠写法必须被认出来')
    assert.match(hits[0]!.text, /Users/)

    /* 占位用户名必须放过，否则守卫会逼着人删掉本来正确的夹具。 */
    assert.deepEqual(userPathHits('<probe>', `'C:${'\\'}\\Users\\developer\\工作\\x.md'`), [])
    assert.deepEqual(userPathHits('<probe>', "'/Users/developer/work/x.md'"), [])
    /* 相对路径与产品自己的部署示例不是家目录，不该误报。 */
    assert.deepEqual(userPathHits('<probe>', "'src/web/ui.ts'"), [])
    assert.deepEqual(userPathHits('<probe>', "':/srv/dsemployee/'"), [])
  })

  it('扫描范围自检：确实扫到了多个文件', () => {
    const files = publishedFiles()
    assert.ok(files.length > 50, '扫描到的文件太少，路径可能算错了：' + files.length)
    assert.ok(files.some((f) => f.endsWith('ui-secretary.test.ts')), '夹具文件必须在扫描范围内')
  })
})
