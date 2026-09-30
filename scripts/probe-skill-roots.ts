/**
 * 技能根体检：用**真实的** dsh skill-filesystem provider，逐个员工工作区跑一遍
 * 「默认配置」下的技能发现，回答一个具体问题：
 *
 *   **`<工作区>/.dsh/skills` 里的私有技能，究竟有没有被扫到？**
 *
 * 为什么需要这个探针：dsh 默认的私有根是 `<projectRoot>/.dsh/skills`，而
 * `projectRoot` 由 `findProjectRoot()` 决定 —— 它只认 `.git`（从 cwd 往上找第一个
 * 含 `.git` 的祖先，找不到才用 cwd 本身，见 dsh-skill-filesystem/lib/index.js:799）。
 * 于是「工作区嵌在别的 git 仓库里」会让 projectRoot 变成那个外层仓库，
 * 私有技能**静默失效**（不报错，只是扫不到）。
 *
 * 用法：
 *   node scripts/probe-skill-roots.ts [员工根目录]
 *
 * 只读：不创建、不修改任何文件（provider 以 watch:false 构造）。
 */

import path from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { pathExists, isDirectory } from '../src/util/fsx.ts'
import { readdir } from 'node:fs/promises'

/**
 * dsh 安装位置：`DSH_ROOT` 优先，否则按平台猜几个常见的全局安装前缀。
 *
 * Windows 与 POSIX 的 npm 全局前缀不一样 —— Windows 是 `%APPDATA%\npm`，
 * macOS/Linux 常见的是 `~/.npm-global` 与 `/usr/local/lib`（Intel Homebrew、
 * 官方 pkg 安装器都用后者）。猜不中不影响正确性：`loadProvider` 会把
 * 试过的候选原样报出来。
 */
const POSIX_DEFAULT_DSH_ROOT = path.join(
  homedir(),
  '.npm-global/lib/node_modules/@deepseek-ai/dsh',
)

function dshRootCandidates(): string[] {
  const appData = process.env.APPDATA
  return [
    ...(appData === undefined
      ? []
      : [path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh')]),
    POSIX_DEFAULT_DSH_ROOT,
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/usr/lib/node_modules/@deepseek-ai/dsh',
  ]
}

const DSH_ROOT =
  process.env.DSH_ROOT ??
  dshRootCandidates().find((dir) => existsSync(dir)) ??
  POSIX_DEFAULT_DSH_ROOT

type Candidate = {
  name: string
  source: string
  rank: number
  path: string
}

async function loadProvider(): Promise<new (ctx: unknown, control: unknown, config: unknown) => {
  roots(cwd: string): Promise<Array<{ path: string; source: string; rank: number }>>
  list(options: { cwd: string }): Promise<{ candidates?: Candidate[] } | Candidate[]>
}> {
  const file = path.join(DSH_ROOT, 'node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js')
  if (!existsSync(file)) {
    throw new Error(
      `找不到 dsh 的 skill provider：${file}\n` +
        `用 DSH_ROOT 指向 dsh 安装目录即可（当前 DSH_ROOT=${DSH_ROOT}）。试过的候选：\n` +
        dshRootCandidates()
          .map((dir) => `  - ${dir}`)
          .join('\n'),
    )
  }
  // 必须转成 file:// URL 再 import：ESM 加载器只认 file:/data:/node: 三种 scheme，
  // 直接 `import('C:\\…')` 在 Windows 上报 ERR_UNSUPPORTED_ESM_URL_SCHEME
  // （'C:' 被当成 scheme），而 `import('/Users/…')` 在 POSIX 上同样不安全。
  const mod = (await import(pathToFileURL(file).href)) as { FileSystemSkillProvider: never }
  return mod.FileSystemSkillProvider
}

/**
 * provider 只用到 ctx 的两层：可选 fs（给 undefined 就走 node:fs）与一个 logger。
 *
 * ⚠️ logger **不能省**：dsh 的 provider 在**任何**"技能被忽略"的情形下都会
 * `ctx.logger.warn(...)`（dsh-skill-filesystem/lib/index.js 里共 10 处：frontmatter 缺字段、
 * 名字非法、带 BOM 导致解析不出 frontmatter、文件读不了……）。
 * 原先这里只有 `{ get: () => undefined }`，于是探针**恰恰在它最该报告的情形下崩栈**：
 * `TypeError: Cannot read properties of undefined (reading 'warn')`、退出码 1，
 * 而人看到的是"探针挂了"，不是"这个技能为什么没生效"。
 *
 * 所以这里不只是把 warn 接住：把它**收集起来**当结论用（见 probe 的返回值与 main 的输出）。
 */
function makeCtxStub(warnings: string[]): unknown {
  const noop = (): void => undefined
  return {
    get: () => undefined,
    logger: {
      debug: noop,
      info: noop,
      error: noop,
      warn: (...args: unknown[]): void => {
        warnings.push(args.map((value) => String(value)).join(' '))
      },
    },
  }
}

async function probe(workspace: string, Provider: Awaited<ReturnType<typeof loadProvider>>) {
  const abort = new AbortController()
  const warnings: string[] = []
  // watch:false —— 探针不留 watcher，进程结束即退出
  const provider = new Provider(makeCtxStub(warnings), { invalidate: () => undefined, signal: abort.signal }, {
    watch: false,
  })

  const roots = await provider.roots(workspace)
  const listed = await provider.list({ cwd: workspace })
  const candidates: Candidate[] = Array.isArray(listed) ? listed : (listed.candidates ?? [])
  abort.abort()

  // 同一个技能名可能在多个根里出现：dsh 取 rank 最小的那个（低 rank 赢）
  const winners = new Map<string, Candidate>()
  for (const candidate of [...candidates].sort((a, b) => a.rank - b.rank)) {
    if (!winners.has(candidate.name)) winners.set(candidate.name, candidate)
  }
  return { roots, winners, warnings }
}

async function main(): Promise<number> {
  const employeeRoot = path.resolve(process.argv[2] ?? '.dev-employees')
  if (!(await isDirectory(employeeRoot))) {
    process.stderr.write(`not a directory: ${employeeRoot}\n`)
    return 2
  }
  const Provider = await loadProvider()
  const entries = (await readdir(employeeRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()

  let failures = 0
  for (const name of entries) {
    const workspace = path.join(employeeRoot, name)
    if (!(await pathExists(path.join(workspace, '.dsemployee', 'employee.json')))) continue

    const { roots, winners, warnings } = await probe(workspace, Provider)
    const private_root = roots.find((root) => root.source === 'project-dsh')
    const anchored = private_root !== undefined && path.resolve(private_root.path) === path.join(workspace, '.dsh', 'skills')

    const bySource = new Map<string, string[]>()
    for (const candidate of winners.values()) {
      const list = bySource.get(candidate.source) ?? []
      list.push(candidate.name)
      bySource.set(candidate.source, list)
    }

    process.stdout.write(`\n=== ${name}\n`)
    process.stdout.write(`  私有根锚定于工作区: ${anchored ? '✅' : '❌'}  ${private_root?.path ?? '(无 project-dsh 根)'}\n`)
    for (const root of roots) {
      process.stdout.write(`    rank ${String(root.rank).padStart(3)}  ${root.source.padEnd(14)} ${root.path}\n`)
    }
    for (const [source, names] of [...bySource].sort()) {
      if (source.startsWith('user-')) continue // 公共技能：几十个，不逐条列
      process.stdout.write(`  ${source}: ${names.sort().join(', ')}\n`)
    }
    /* dsh 的警告就是"哪个文件为什么不生效"的唯一证据 —— 原来它连日志都打不出来
       （没有 logger 就直接崩），现在原样摆出来。最多 3 条，多的给个总数。 */
    if (warnings.length > 0) {
      process.stdout.write(`  dsh 忽略了 ${warnings.length} 处（这就是"技能没生效"的原因）：\n`)
      for (const line of warnings.slice(0, 3)) process.stdout.write(`    · ${line}\n`)
      if (warnings.length > 3) process.stdout.write(`    · …另有 ${warnings.length - 3} 条\n`)
    }
    const privateNames = [...winners.values()].filter((c) => c.source === 'project-dsh').map((c) => c.name)
    process.stdout.write(`  私有技能生效: ${privateNames.length > 0 ? `✅ ${privateNames.join(', ')}` : '❌ 0 个 —— 私有根没被扫到'}\n`)
    if (privateNames.length === 0) failures += 1
  }

  process.stdout.write(`\n${failures === 0 ? '✅ 全部员工私有技能可见' : `❌ ${failures} 个员工的私有技能不可见`}\n`)
  return failures === 0 ? 0 : 1
}

process.exitCode = await main()
