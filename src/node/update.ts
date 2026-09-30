/**
 * 把一个 git 提交**落地成一个可运行的版本目录**（节点自升级的执行器）。
 *
 * 设计要点（每条都是被真实故障逼出来的）：
 *
 *   1. **不改动员工工作区所在的 clone**：`git fetch` 只更新对象库，新版本用
 *      `git archive` **导出一份冻结的树**（不是 `git worktree`）到 releases 下。
 *      两个理由：① `employees/`（未跟踪、且就是员工的工作区）永远不被碰，也
 *      **绝不会**出现 `git clean`（那会连 node_modules 与员工工作区一起删掉）；
 *      ② 版本目录里**没有 .git** —— 它是冻结的产物，不该能提交、也不该被误当成仓库。
 *   2. **版本 id 就是代码指纹**（不是 sha）：导出后**在新目录里**算指纹，把目录
 *      重命名成 `releases/<指纹>/`。为什么非这样不可 —— 真机演练时踩过：目录名用
 *      sha、而"盖章"判定（markConnected）比的是**指纹**，于是任何版本都永远盖不上章，
 *      回滚判定直接失效。指纹是本产品现成的版本证明，sha 只用于 git 取件。
 *      ⚠️ 指纹**不含 node_modules**，所以依赖要单独照看（见第 3 条）。
 *   3. **依赖变化才装**：`package-lock.json` 与当前版本不同才 `npm ci --omit=dev`
 *      （`--omit=dev` 是因为运行只需要 ws + zod）。装不上就拒绝切换 ——
 *      "指纹对了但 import 不到 ws"是最难查的一类。
 *   4. **切换是最后一步，且是原子的**：只有前面全过了才写指针（见 release.ts）。
 *      切换前把当前版本留在 `previous`（回滚目标）。
 *   5. **不在这一步重启**：重启是平台相关动作（Windows 计划任务 / Mac 的 nohup），
 *      由调用方用 `--restart-cmd` 显式给出，或者由外部编排（Hub 的 node.update）。
 *      执行器只负责"把版本准备好并指向它"，这样它可测、可重放。
 */

import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { codeFingerprint } from '../protocol/build.ts'
import { readPointer, releasePaths, switchRelease, writePointer } from './release.ts'

const run = promisify(execFile)

/** 是不是一个合法的 sha（7~40 位十六进制）。 */
function looksLikeShaPattern(text: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(text)
}

/** 一次升级的结果，调用方按它决定要不要重启 / 报错。 */
export interface UpdateOutcome {
  ok: boolean
  /** 目标提交的短 sha（git 语义） */
  ref: string
  /** 目标提交对应的代码指纹（= 版本目录名） */
  fingerprint?: string
  /** 版本目录 */
  codeDir?: string
  /** 是否真的发生了切换（已是该版本时为 false） */
  switched: boolean
  /** 装依赖了吗 */
  installedDependencies?: boolean
  /** 拒绝升级的原因（ok=false 时必有） */
  error?: string
  /** 逐步说明（日志用，出问题时能看出卡在哪一步） */
  steps: string[]
}

export interface UpdateOptions {
  /** 仓库目录（git clone；员工工作区在它下面，绝不被改写） */
  repo: string
  /** 目标：分支名、sha、tag 都行 */
  to: string
  env?: Record<string, string | undefined>
  /** 注入执行器（测试用：不真的跑 git/npm） */
  exec?: (command: string, args: string[], options: { cwd: string }) => Promise<{ stdout: string }>
  /** 注入指纹实现（测试用） */
  fingerprint?: (dir: string) => string
}

/**
 * Windows 上这些命令是 `.cmd` 壳脚本，**不能**用 `execFile` 直接拉起。本机实测三种写法：
 *   `execFile('npm', …)`      → ENOENT（当成可执行文件找不到）
 *   `execFile('npm.cmd', …)`  → EINVAL（Node 对 .bat/.cmd 的硬限制，别想绕）
 *   `execFile('npm', …, { shell: true })` → OK
 * 真机症状：升级走到"装依赖"就 `spawn npm ENOENT` 停住 —— 与 `dsh-process.ts` 里
 * dsh 的 `.cmd` 垫片是同一个坑，那边已有现成写法。
 *
 * **只给壳脚本加 shell**：git / tar / node 都是真 .exe，给它们加 shell 会把带空格或
 * 非 ASCII 的路径交给 cmd.exe 去拆（本机路径就含中文）。这里 args 全是本模块写死的
 * 常量、不含用户输入，所以拼接没有注入面。
 */
const SHIM_COMMANDS = new Set(['npm', 'npx', 'pnpm', 'yarn'])

async function execDefault(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<{ stdout: string }> {
  const shell = process.platform === 'win32' && SHIM_COMMANDS.has(command)
  const result = await run(command, args, {
    cwd: options.cwd,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60_000,
    ...(shell ? { shell: true } : {}),
  })
  return { stdout: String(result.stdout) }
}

type ExecLike = NonNullable<UpdateOptions['exec']>

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 跑一次 `git fetch`：**先按本机 git 配置（可能配了代理），不通再直连一次**。
 *
 * 为什么不干脆一律绕开代理：代理在某些网络里是**唯一**出口，一律绕开会把那些本来
 * 能用的机器弄坏。而"先按配置、失败再直连"两种情况都过得去：
 *   · 只有代理能通 → 第一次就成功，根本不会走到第二次；
 *   · 只有直连能通 → 第一次失败、第二次成功。本机就是这样：git 全局配了给 GitHub
 *     用的 `http.proxy=127.0.0.1:7892`，而它当前没开，于是升级按钮每次都卡在 fetch
 *     （真机日志：`Failed to connect to gitee.com port 443 via 127.0.0.1`）。
 * 代价是失败的那一次白等几秒（实测连接超时约 2s），换来的是不必猜每台机器的网络。
 *
 * `-c http.proxy=` 是**置空**（不是删配置），git 因此不再走代理。
 */
async function fetchWithProxyFallback(
  exec: ExecLike,
  args: string[],
  options: { cwd: string },
  steps: string[],
): Promise<void> {
  try {
    await exec('git', args, options)
    return
  } catch (error) {
    steps.push(`git fetch 按本机配置失败（${message(error)}）—— 改用直连重试`)
  }
  await exec('git', ['-c', 'http.proxy=', '-c', 'https.proxy=', ...args], options)
}

function lockHash(text: string): string {
  /* 只用来判断"依赖有没有变"：不必是密码学哈希（指纹负责代码，这里负责依赖）。 */
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return String(hash)
}

/**
 * 把 `repo` 的某个提交准备成一个可运行的版本目录。
 *
 * 顺序即安全：fetch → 解析 sha → 建目录（已存在则跳过）→ 校验指纹 → 装依赖 →
 * 切指针。任何一步失败都会**保持现状**（指针不动 = 继续跑旧版本），并把原因原样带回。
 */
export async function prepareRelease(options: UpdateOptions): Promise<UpdateOutcome> {
  const exec = options.exec ?? execDefault
  const fingerprint = options.fingerprint ?? codeFingerprint
  const repo = path.resolve(options.repo)
  const env = options.env ?? process.env
  const paths = releasePaths({ repo, env })
  const steps: string[] = []

  const fail = (error: string): UpdateOutcome => ({ ok: false, ref: options.to, switched: false, error, steps })

  /* 目标是 sha 还是引用，取法不同：
       · 分支/标签：`git fetch --tags origin <ref>` 然后看 FETCH_HEAD；
       · 裸 sha：**很多服务器（含 gitee）不允许按 sha fetch**（实测：
         "无法找到远程引用"）。这时退化成整仓 fetch（本仓库很小），
         再用 rev-parse 确认那个提交真的到手了。
     两种都失败才认输 —— 失败一律不动指针。 */
  /* ⚠️ `to` 会被原样交给 git（`git fetch ... origin <to>`）。以 `-` 开头的东西是
     **选项**而不是引用：`--upload-pack=<命令>` 这类能借 git 执行命令（审计报告
     FINDING-013 在本地真的复现了执行，只是因为 origin 是 HTTPS 的 gitee 才没打通 ——
     哪天 remote 换成 SSH，它就会回来）。所以这里**白名单**：
       引用/分支/标签：字母数字与 . _ / -（且不能以 - 开头）
       sha：7~40 位十六进制
     其余一律拒绝，并说清为什么。 */
  const REF_PATTERN = /^(?![.-])[A-Za-z0-9._/-]{1,200}$/
  if (!looksLikeShaPattern(options.to) && !REF_PATTERN.test(options.to)) {
    return fail(
      `拒绝这个升级目标：${JSON.stringify(options.to)} —— 只接受分支/标签名或提交 sha（` +
        `不能以 - 开头，因为那会被 git 当成选项执行命令）`,
    )
  }
  const looksLikeSha = /^[0-9a-f]{7,40}$/i.test(options.to)
  let sha = ''
  if (looksLikeSha) {
    steps.push(`git fetch origin ${options.to}`)
    try {
      await fetchWithProxyFallback(exec, ['fetch', 'origin', options.to], { cwd: repo }, steps)
    } catch {
      steps.push('按 sha fetch 被拒 —— 改为整仓 fetch（本仓库很小）')
      try {
        await fetchWithProxyFallback(exec, ['fetch', '--tags', 'origin'], { cwd: repo }, steps)
      } catch (error) {
        return fail(`git fetch 失败：${message(error)}`)
      }
    }
    try {
      const resolved = await exec('git', ['rev-parse', '--short=12', `${options.to}^{commit}`], { cwd: repo })
      sha = resolved.stdout.trim()
    } catch (error) {
      return fail(`本地没有这个提交：${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    steps.push(`git fetch --tags origin ${options.to}`)
    try {
      await fetchWithProxyFallback(exec, ['fetch', '--tags', 'origin', options.to], { cwd: repo }, steps)
    } catch (error) {
      /* 两次都失败（先按本机配置、再直连）：最常见是网络，也可能是引用拼错。
         两者都不该动指针。 */
      return fail(`git fetch 失败：${message(error)}`)
    }
    try {
      const resolved = await exec('git', ['rev-parse', '--short=12', 'FETCH_HEAD'], { cwd: repo })
      sha = resolved.stdout.trim()
    } catch (error) {
      return fail(`解析提交失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (sha === '') return fail('解析提交得到空 sha')

  await mkdir(paths.root, { recursive: true })
  const staging = path.join(paths.root, `.staging-${sha}`)
  let codeDir = ''
  let fp = ''
  try {
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    const tarPath = path.join(paths.root, `.staging-${sha}.tar`)
    steps.push(`git archive ${sha} → staging`)
    await exec('git', ['archive', '--format=tar', '-o', tarPath, sha], { cwd: repo })
    /* 解包用系统 tar：Windows 10+ 自带 C:\Windows\System32\tar.exe（已确认该机有），
       macOS 自带 bsdtar。**不用 worktree** —— 版本目录里不该有 .git。 */
    await exec('tar', ['-xf', tarPath, '-C', staging], { cwd: repo })
    await rm(tarPath, { force: true })
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    return fail(`导出这个提交失败：${error instanceof Error ? error.message : String(error)}`)
  }

  /* 指纹就是版本 id：算出来之后再决定目录名。同一个提交两次导出得到同一指纹，
     所以重复升级是幂等的（下面 alreadyThere 分支）。 */
  try {
    fp = fingerprint(staging)
    const again = fingerprint(staging)
    if (fp !== again) return fail(`代码指纹不稳定：${fp} vs ${again}`)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    return fail(`算指纹失败：${error instanceof Error ? error.message : String(error)}`)
  }

  codeDir = path.join(paths.root, fp)
  const alreadyThere = existsSync(path.join(codeDir, 'src'))
  if (alreadyThere) {
    steps.push(`版本 ${fp} 已经准备好，丢掉这次导出`)
    await rm(staging, { recursive: true, force: true })
  } else {
    try {
      await rename(staging, codeDir)
      steps.push(`版本目录：${codeDir}（id 就是代码指纹）`)
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      return fail(`重命名版本目录失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /* 依赖：lock 变了才装。装不上就拒绝切换（宁可继续跑旧的可用版本）。 */
  let installed = false
  const lockPath = path.join(codeDir, 'package-lock.json')
  let lockText = ''
  try {
    lockText = await readFile(lockPath, 'utf8')
  } catch {
    steps.push('没有 package-lock.json —— 跳过依赖步骤（按"代码即全部"处理）')
  }
  if (lockText !== '') {
    const wanted = lockHash(lockText)
    const stampFile = path.join(codeDir, '.deps-lock-hash')
    let have = ''
    try {
      have = (await readFile(stampFile, 'utf8')).trim()
    } catch {
      have = ''
    }
    const nodeModules = path.join(codeDir, 'node_modules')
    if (have !== wanted || !existsSync(nodeModules)) {
      if (!existsSync(nodeModules)) {
        /* 版本目录是新的：先把当前版本的 node_modules 复制过去当基线，能省掉一次联网安装。
           复制失败不致命 —— 后面还有 npm ci 兜底。 */
        const current = await readPointer(paths.pointerFile)
        if (current !== undefined) {
          const from = path.join(paths.root, current.release, 'node_modules')
          if (existsSync(from)) {
            try {
              steps.push(`从 ${current.release} 复制 node_modules 作基线`)
              await exec(process.platform === 'win32' ? 'xcopy' : 'cp', process.platform === 'win32'
                ? [from, nodeModules, '/E', '/I', '/Q']
                : ['-R', from, nodeModules], { cwd: codeDir })
            } catch {
              steps.push('复制 node_modules 失败，稍后用 npm ci 装')
            }
          }
        }
      }
      try {
        steps.push('npm ci --omit=dev')
        await exec('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: codeDir })
        installed = true
      } catch (error) {
        return fail(`依赖安装失败：${error instanceof Error ? error.message : String(error)}`)
      }
      await copyFile(lockPath, stampFile).catch(() => undefined)
    } else {
      steps.push('依赖没变，跳过安装')
    }
  }

  /* 冒烟：能不能加载 CLI（比"文件都在"强得多 —— 语法错、缺依赖都在这一步暴露）。 */
  try {
    steps.push('冒烟：node bin/dse.mjs --help')
    await exec(process.execPath, [path.join(codeDir, 'bin', 'dse.mjs'), '--help'], { cwd: codeDir })
  } catch (error) {
    return fail(`冒烟失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const pointer = await readPointer(paths.pointerFile)
  if (pointer !== undefined && pointer.release === fp) {
    steps.push('指针已经指向这个版本，无需切换')
    return { ok: true, ref: sha, fingerprint: fp, codeDir, switched: false, installedDependencies: installed, steps }
  }
  /* 顺手把 clone 路径记进指针：节点以后跑在 release 目录里时，就靠它找到这个 clone
     才能继续升级（release 是冻结产物，没有 .git）。 */
  await writePointer(paths.pointerFile, switchRelease(pointer, fp, { updatedBy: 'update', repo }))
  steps.push(`指针切换：${pointer?.release ?? '(无)'} → ${fp}`)
  return { ok: true, ref: sha, fingerprint: fp, codeDir, switched: true, installedDependencies: installed, steps }
}

/** 版本目录是否齐全（给 `release status` 与 Hub 侧检查用）。 */
export async function releaseLooksRunnable(codeDir: string): Promise<boolean> {
  try {
    const entry = await stat(path.join(codeDir, 'bin', 'dse.mjs'))
    if (!entry.isFile()) return false
  } catch {
    return false
  }
  try {
    await stat(path.join(codeDir, 'src', 'cli.ts'))
    return true
  } catch {
    return false
  }
}

/** 删掉一个准备失败的版本目录（失败品不该留在 releases 里让人误以为可用）。 */
export async function discardRelease(root: string, id: string): Promise<void> {
  const rootResolved = path.resolve(root)
  const target = path.resolve(path.join(rootResolved, id))
  /* 唯一一处删除：先确认它真的在 releases 根下，再删。 */
  if (path.dirname(target) !== rootResolved) throw new Error(`refusing to remove ${target} (outside ${rootResolved})`)
  await rm(target, { recursive: true, force: true })
  const repoRoot = path.dirname(rootResolved)
  const clone = path.join(repoRoot, 'digital-employees')
  if (existsSync(path.join(clone, '.git'))) {
    await run('git', ['worktree', 'prune'], { cwd: clone }).catch(() => undefined)
  }
}
