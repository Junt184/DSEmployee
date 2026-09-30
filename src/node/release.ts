/**
 * 版本指针与回滚判定 —— 节点自升级的**共同地基**。
 *
 * 为什么单独一个平台无关的模块：Mac 的 shell 启动器与 Windows 的 PowerShell 启动器
 * 都要做同一件事（读指针 → 决定跑哪个版本 → 起不来就回滚）。两份实现一定会分叉，
 * 而分叉的后果是"一台机器上回滚生效、另一台不生效"——这种问题在半夜最难查。
 * 所以规则只写在这里一份，两侧的脚本都调 `dse release start-plan`（见 scripts/）。
 *
 * 目录约定（两个平台同构）：
 *
 *     <releases>/
 *       current.json          ← 指针（唯一可变的东西；切换版本 = 原子改这一个文件）
 *       <id>/…                ← 每个版本一份完整检出（各自带 node_modules）
 *
 * `<id>` 就是**代码指纹**（`src/**` + `bin/*.mjs` + `package.json`，CRLF 归一化）——
 * 不另发明版本号：指纹本来就能证明"这份代码是不是 Hub 要的那一份"。
 *
 * 特殊值 `__source__`：直接跑仓库工作区（开发机用；我自己的 Mac 就是这种形态）。
 * 回滚到它没有意义，所以它不参与回滚。
 */

import { readFileSync } from 'node:fs'
import { rename, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

/** 指针里表示"跑仓库工作区"的特殊值。 */
export const SOURCE_RELEASE = '__source__'

/** 连续启动失败多少次就回滚。3 次足够排除"偶发端口占用"，又不会拖到第 999 次。 */
export const MAX_FAILED_STARTS = 3

/** 起了之后多久之内必须连上 Hub，否则算这次启动失败。 */
export const CONNECT_GRACE_MS = 90_000

export interface ReleasePointer {
  /** 当前该跑的版本 id（指纹或 __source__） */
  release: string
  /** 上一个版本 id（回滚目标；没有就是首次安装） */
  previous?: string
  updatedAtMs: number
  /**
   * git clone 的绝对路径 —— **自升级需要它**。
   *
   * 只有真机第一次跨版本升级之后才会暴露这件事：节点跑在 `releases/<指纹>/` 里时，
   * 它的"包根"是那个**冻结产物**（按设计没有 `.git`），于是 `git fetch` 会以
   * "不是 git 仓库"失败 —— 升级能力从此失效，而报错看起来像是网络问题。
   * 指针由升级器写，升级器知道 clone 在哪，顺手记下来最省事（不依赖环境变量）。
   */
  repo?: string
  /**
   * **异常退出**次数（节点进程自己在宽限期内退出，或干脆起不来）。
   *
   * 只数"崩了"，**不数"连不上"**：网络断了、Hub 重启了，进程会好好活着继续重连，
   * 那不是版本的错 —— 要是把这类也计数，一次网络抖动就会把好版本回滚掉。
   * 为什么必须由启动器数：Windows 那边计划任务带 `RestartOnFailure Count=999`，
   * "进程死了就没人拉起了"这种兜底**不成立**（它会被反复拉起）。
   */
  failedStarts?: number
  /** 最近一次"连上 Hub"的时刻（节点连上后自己写；启动器据此清 failedStarts） */
  lastConnectedAtMs?: number
  /** 谁改的指针（审计：手动、升级、回滚） */
  updatedBy?: string
}

export interface ReleasePaths {
  /** releases 根目录 */
  root: string
  /** current.json 的完整路径 */
  pointerFile: string
}

/**
 * 版本目录的默认位置：**仓库的兄弟目录**（`<repo>/../dse-releases`）。
 *
 * 为什么不放在仓库里：升级要换的是"整个代码目录"，把版本目录放进被换的那个目录里
 * 是自指。放兄弟目录还能顺带保证"升级绝不会碰到工作区与 .dse* 状态"。
 * 可用 `DSE_RELEASES` 覆盖（测试与非常规部署用）。
 */
export function releasePaths(options: { repo?: string; env?: Record<string, string | undefined> } = {}): ReleasePaths {
  const env = options.env ?? process.env
  const override = env['DSE_RELEASES']
  const repo = path.resolve(options.repo ?? process.cwd())
  if (override !== undefined && override !== '') {
    const root = path.resolve(override)
    return { root, pointerFile: path.join(root, 'current.json') }
  }
  /* 进程**就跑在某个 release 目录里**时（`<root>/dse-releases/<指纹>/`），
     它的包根的父目录已经是 releases 根 —— 再按"仓库的兄弟目录"算会得到
     `<root>/dse-releases/dse-releases`，于是指针读不到、升级状态永远显示"没有指针"。
     启动器一般会设 DSE_RELEASES，但不能指望（手工启动、旧启动器、别的调用方）。 */
  if (path.basename(path.dirname(repo)) === 'dse-releases') {
    const root = path.dirname(repo)
    return { root, pointerFile: path.join(root, 'current.json') }
  }
  const root = path.join(path.dirname(repo), 'dse-releases')
  return { root, pointerFile: path.join(root, 'current.json') }
}

/** 某个版本的代码目录。`__source__` 指回仓库自身。 */
export function releaseCodeDir(paths: ReleasePaths, release: string, repo: string): string {
  return release === SOURCE_RELEASE ? path.resolve(repo) : path.join(paths.root, release)
}

/** 读指针。文件不存在、空、坏 JSON、字段不对 —— 一律返回 undefined（调用方按"首次"处理）。 */
export function parsePointer(text: string): ReleasePointer | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const release = typeof record['release'] === 'string' ? record['release'] : ''
  if (release === '') return undefined
  const pointer: ReleasePointer = {
    release,
    updatedAtMs: typeof record['updatedAtMs'] === 'number' ? record['updatedAtMs'] : 0,
  }
  if (typeof record['previous'] === 'string' && record['previous'] !== '') pointer.previous = record['previous']
  if (typeof record['failedStarts'] === 'number') pointer.failedStarts = record['failedStarts']
  if (typeof record['lastConnectedAtMs'] === 'number') pointer.lastConnectedAtMs = record['lastConnectedAtMs']
  if (typeof record['updatedBy'] === 'string') pointer.updatedBy = record['updatedBy']
  if (typeof record['repo'] === 'string' && record['repo'] !== '') pointer.repo = record['repo']
  return pointer
}

export async function readPointer(file: string): Promise<ReleasePointer | undefined> {
  try {
    return parsePointer(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 原子写指针：先写同目录临时文件再 `rename`。
 *
 * 必须原子：这个文件被**另一个进程**在启动时读取，写到一半被读到 ⇒ 机器再也起不来，
 * 而现场（那个半截 JSON）看起来像"配置被人改了"。rename 在同一文件系统内是原子的。
 */
export async function writePointer(file: string, pointer: ReleasePointer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(pointer, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}

export type StartPlan =
  | { action: 'run'; release: string; codeDir: string; reason: string }
  | { action: 'rollback'; release: string; codeDir: string; from: string; reason: string }
  | { action: 'run-anyway'; release: string; codeDir: string; reason: string }

/**
 * 启动器该跑哪个版本 —— **纯函数，启动器只负责执行**。
 *
 * 规则（按优先级）：
 *   1. 没有指针 / 坏指针 ⇒ 跑仓库工作区（首次安装的形态），不打回滚。
 *   2. 上次启动**没连上 Hub**（`lastConnectedAtMs` 早于 `updatedAtMs`）且失败次数 ≥ 上限
 *      ⇒ 回滚到 `previous`；没有 previous 就"照跑并说明原因"（如实上报，不假装成功）。
 *   3. 其余 ⇒ 跑指针指的版本。
 */
export function startPlan(
  pointer: ReleasePointer | undefined,
  options: { repo: string; paths: ReleasePaths; now?: number; maxFailedStarts?: number },
): StartPlan {
  const now = options.now ?? Date.now()
  const max = options.maxFailedStarts ?? MAX_FAILED_STARTS
  const repo = path.resolve(options.repo)

  if (pointer === undefined) {
    return {
      action: 'run',
      release: SOURCE_RELEASE,
      codeDir: releaseCodeDir(options.paths, SOURCE_RELEASE, repo),
      reason: '没有版本指针（首次安装）—— 跑仓库工作区',
    }
  }

  const codeDir = releaseCodeDir(options.paths, pointer.release, repo)
  /* "这个版本曾经连上过 Hub"是它可用的证据；用它把"版本坏了"与"网络不通"分开。 */
  const everConnected = (pointer.lastConnectedAtMs ?? 0) >= pointer.updatedAtMs
  const crashes = pointer.failedStarts ?? 0

  if (!everConnected && crashes >= max) {
    const previous = pointer.previous
    if (previous !== undefined && previous !== SOURCE_RELEASE) {
      return {
        action: 'rollback',
        release: previous,
        codeDir: releaseCodeDir(options.paths, previous, repo),
        from: pointer.release,
        reason: `${pointer.release} 从没连上过 Hub 且已崩 ${crashes} 次 —— 回滚到 ${previous}`,
      }
    }
    return {
      action: 'run-anyway',
      release: pointer.release,
      codeDir,
      reason: `已崩 ${crashes} 次且从没连上过 Hub，但没有可回滚的上一版 —— 照跑（如实上报）`,
    }
  }

  return { action: 'run', release: pointer.release, codeDir, reason: '按指针启动' }
}

/**
 * 记一次**异常退出**（启动器发现进程在宽限期内自己退了就调）。
 *
 * 注意：`updatedAtMs` 不动 —— 它表示"这个版本是什么时候被切成当前的"，
 * 而 `everConnected` 的判据正是拿它跟 `lastConnectedAtMs` 比。这里改了它，
 * 会把"曾经连上过"的证据抹掉，于是网络抖动也能把好版本回滚掉（想清楚才没动）。
 */
export function noteCrash(pointer: ReleasePointer, now = Date.now()): ReleasePointer {
  void now
  return { ...pointer, failedStarts: (pointer.failedStarts ?? 0) + 1, updatedBy: 'launcher' }
}

/** 记一次"连上了"（节点连上 Hub 后调）：清失败计数。 */
export function noteConnected(pointer: ReleasePointer, now = Date.now()): ReleasePointer {
  const next: ReleasePointer = { ...pointer, lastConnectedAtMs: now, updatedBy: 'node' }
  delete next.failedStarts
  return next
}

/** 切换版本（升级成功后调）：把当前记为 previous，并清掉失败计数。 */
export function switchRelease(
  pointer: ReleasePointer | undefined,
  release: string,
  options: { now?: number; updatedBy: string; repo?: string },
): ReleasePointer {
  const now = options.now ?? Date.now()
  /* 切到同一个版本（重复点击"升级"）时**保留原有的 previous** ——
     否则回滚目标会被自己抹掉，之后出问题就没有版本可退了。 */
  const previous =
    pointer === undefined ? undefined : pointer.release === release ? pointer.previous : pointer.release
  const repo = options.repo ?? pointer?.repo
  return {
    release,
    ...(previous === undefined ? {} : { previous }),
    updatedAtMs: now,
    updatedBy: options.updatedBy,
    ...(repo === undefined ? {} : { repo }),
  }
}

/**
 * "自升级该在哪个目录里跑 git" —— 从正在运行的版本反推。
 *
 * 顺序：`DSE_REPO`（启动器给的，最明确）→ 指针里的 `repo`（自描述）→
 * 本进程包根本身（开发机形态：直接跑 clone）。
 * 都拿不到就返回 undefined，调用方**如实拒绝**并说清怎么修 —— 猜一个目录去
 * fetch/checkout 比不做还危险。
 */
export async function resolveUpdateRepo(options: {
  /** 本进程的包根（packageRoot()） */
  mine: string
  env?: Record<string, string | undefined>
  paths: ReleasePaths
}): Promise<{ repo: string; source: 'env' | 'pointer' | 'self' } | undefined> {
  const env = options.env ?? process.env
  const fromEnv = env['DSE_REPO']
  if (fromEnv !== undefined && fromEnv !== '') return { repo: path.resolve(fromEnv), source: 'env' }
  const pointer = await readPointer(options.paths.pointerFile)
  if (pointer?.repo !== undefined && pointer.repo !== '') {
    return { repo: path.resolve(pointer.repo), source: 'pointer' }
  }
  /* 开发机形态：跑的就是 clone（有 .git 或至少有 .git 文件/目录） */
  try {
    const { existsSync: exists } = await import('node:fs')
    if (exists(path.join(options.mine, '.git'))) return { repo: options.mine, source: 'self' }
  } catch {
    /* 落到 undefined */
  }
  return undefined
}

/**
 * 连上 Hub 后给自己盖章 —— 这是"这个版本可用"的唯一证据，回滚判定靠它。
 *
 * 两条要点：
 *   1. **只有正在运行的那个版本能盖章**：指针指的版本必须等于本进程的代码指纹。
 *      否则"跑着旧版本、却把新版本标记成已连上"会直接把回滚机制废掉（升级后
 *      旧进程还在跑，新版本永远不会被判定为坏）。
 *   2. 没有指针（开发机形态）时什么都不做，这不是错误。
 */
export async function markConnected(options: {
  repo: string
  env?: Record<string, string | undefined>
  /** 本进程的代码指纹；算不出来时传 undefined（那就跳过盖章，宁可不盖章也不猜） */
  mine: string | undefined
  now?: number
}): Promise<{ noted: boolean; release?: string; reason?: string }> {
  const paths = releasePaths({ repo: options.repo, ...(options.env === undefined ? {} : { env: options.env }) })
  const pointer = await readPointer(paths.pointerFile)
  if (pointer === undefined) return { noted: false, reason: '没有版本指针（开发机形态）' }
  if (options.mine === undefined) return { noted: false, reason: '算不出本进程的代码指纹' }
  if (pointer.release !== options.mine) {
    return { noted: false, release: pointer.release, reason: `指针指向 ${pointer.release}，而本进程是 ${options.mine}` }
  }
  await writePointer(paths.pointerFile, noteConnected(pointer, options.now ?? Date.now()))
  return { noted: true, release: pointer.release }
}

/** 目录里已有的版本（不含文件与临时目录），用于清理旧版本。 */
export async function listReleases(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

/**
 * 清理旧版本：只保留 `keep` 里点名的那些（当前 + 上一版 + 正在下载的）。
 * 用 `rm -rf` 之前**必须先确认路径在 releases 根下**——这是唯一一处删除操作。
 */
export async function pruneReleases(root: string, keep: readonly string[]): Promise<string[]> {
  const keepSet = new Set(keep)
  const rootResolved = path.resolve(root)
  const removed: string[] = []
  for (const name of await listReleases(root)) {
    if (keepSet.has(name)) continue
    const target = path.join(rootResolved, name)
    if (path.dirname(path.resolve(target)) !== rootResolved) continue
    await rm(target, { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}
