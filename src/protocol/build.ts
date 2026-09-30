/**
 * 代码指纹 —— 回答一个排查时最常问、以前却**无法回答**的问题：
 *
 *   「这台机器上正在跑的，和我手上这份代码，是同一份吗？」
 *
 * 为什么需要它：节点是**手动升级**的（git pull + 重启），Hub 与各节点的代码版本会
 * 悄悄分叉，而且分叉**不会报错** —— 旧节点照常连上、照常列员工，只是某些能力缺失或
 * 行为不同。真实的两次教训：
 *   · 控制台脚本被 PWA 缓存冻住，手机上跑着旧 JS，页面却一切正常
 *     （见 `docs/05` §13.5）；
 *   · Windows 那台节点长时间跑着旧代码，从界面上完全看不出来。
 * 两者的共同点是"沉默的版本分叉"。前者的解法是内容指纹（`/ui.js?v=<指纹>`），
 * 这条则是把同一招用到节点侧：**让每个节点在连接时自报代码指纹，Hub 与自己的比对。**
 *
 * 指纹的定义（可比较性优先，不追求密码学强度）：
 *   · 覆盖 `src` 下全部 `.ts`、`bin` 下全部 `.mjs`、外加 `package.json` ——
 *     也就是"决定运行时行为的全部源码"；不含 `node_modules`、`test/`、`docs/`。
 *   · 逐文件算 FNV-1a 32 位（拼长度），再对"路径:哈希"的清单算一次；
 *   · **行尾统一成 `\n` 再算** —— 否则 Windows 检出（CRLF）会和 macOS/Linux 误报不一致，
 *     而这种假报警会让整个机制失去信任。
 *
 * 注意它衡量的是"内容是否相同"，不是"谁更新"：同样的改动顺序不同、git 历史不同，
 * 只要文件内容一致，指纹就一致。这正是我们想要的（Hub 与节点应当内容一致）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 内容哈希：FNV-1a 32 位（base36）+ 长度。
 *
 * 目的是**比较与缓存失效**，不是防篡改，所以不需要密码学哈希；但必须满足一个硬要求：
 * **改一个字，值就要变**。拼上长度是为了让"同长度不同内容"的极小概率碰撞再降一档。
 */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(36)}-${text.length.toString(36)}`
}

/** 行尾归一：Windows 检出不该让指纹与 mac/Linux 不一致（那会变成天天误报的假警报）。 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** 递归收集目录下匹配后缀的文件（相对路径），按需过滤。 */
function collect(
  root: string,
  relativeDir: string,
  match: (name: string) => boolean,
  out: string[],
): void {
  let entries
  try {
    entries = readdirSync(path.join(root, relativeDir), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const relative = path.join(relativeDir, entry.name)
    if (entry.isDirectory()) {
      collect(root, relative, match, out)
    } else if (entry.isFile() && match(entry.name)) {
      /* 收集时就归一成 POSIX 写法：下游（指纹清单、treeText、UI 版本号）不必各自再处理一遍，
         而且**Windows 上必须归一的那个点只有一个**（见 posixRelative 的注释）。 */
      out.push(posixRelative(relative))
    }
  }
}

/**
 * 参与指纹的文件清单（相对 `root` 的路径，已排序）。
 *
 * 刻意**不含** `package-lock.json`：npm 在不同平台上会写入平台相关的可选依赖，
 * 拿它做跨平台比对会误报。`package.json`（依赖声明本身）要算。
 *
 * 编译产物（`dist/src`）**只在真的会被加载时**才算进来（`bin/dse.mjs` 的规则：
 * 有 `dist/src/cli.js` 就用它）。两个方向的错都不能犯：
 *   · 不算：一台跑 dist、一台跑 src 的机器会报"同一份代码"，其实不是 —— 漏报；
 *   · 无脑算：别人顺手 `npm run build` 一次，两台跑着**同一份源码**的进程就会报不一致
 *     —— 假警报比漏报更糟，它会让整套机制失去信任（本仓库是共享工作区，真发生过）。
 * 按"会不会真的加载"来决定，两种情况都归位。
 */
export function fingerprintFiles(root: string): string[] {
  const files: string[] = []
  collect(root, 'src', (name) => name.endsWith('.ts'), files)
  collect(root, 'bin', (name) => name.endsWith('.mjs'), files)
  if (runtimeEntry(root) === 'dist') {
    collect(root, 'dist/src', (name) => name.endsWith('.js'), files)
  }
  if (files.length === 0) return files
  try {
    readFileSync(path.join(root, 'package.json'))
    files.push('package.json')
  } catch {
    /* 没有 package.json 就不算它 */
  }
  return files.sort()
}

/**
 * 某个目录下全部匹配文件的文本（`相对路径:内容` 逐行拼接，路径已排序）。
 * 目录不存在或没有匹配文件时返回 `undefined`（调用方决定回退策略）。
 */
export function treeText(root: string, relativeDir: string, suffix: string): string | undefined {
  const files: string[] = []
  collect(root, relativeDir, (name) => name.endsWith(suffix), files)
  if (files.length === 0) return undefined
  return files
    .sort()
    .map((relative) => `${relative}:${readFileSync(path.join(root, ...relative.split('/')), 'utf8')}`)
    .join('\n')
}

/**
 * 本进程**实际会加载**的入口形态 —— `bin/dse.mjs` 的规则：有 `dist/src/cli.js` 就用它。
 *
 * 为什么要让这件事可见：编译产物与源码是两套东西，"只更新源码、dist 还是旧的"会让
 * 部署看起来生效了、实际一行都没跑上（真实踩过）。把它作为一行事实报出去，
 * 好过让下一个人重新推一遍这个坑。
 */
export function runtimeEntry(root = packageRoot()): 'dist' | 'src' | 'unknown' {
  try {
    readFileSync(path.join(root, 'dist', 'src', 'cli.js'))
    return 'dist'
  } catch {
    /* dist 不在，看源码 */
  }
  try {
    readFileSync(path.join(root, 'src', 'cli.ts'))
    return 'src'
  } catch {
    return 'unknown'
  }
}

/**
 * 指纹里的相对路径**一律用 POSIX 写法**（`/`）。
 *
 * 为什么必须归一（真机踩到，2026-09-25）：收集文件用的是 `path.join`，Windows 上给出
 * `src\web\ui.ts`，而 macOS/Linux 给出 `src/web/ui.ts` —— 同一份代码**算出两个指纹**。
 * 后果不是"少报一次不一致"，而是**这个检查对 Windows 节点永远不可能通过**：
 * Windows 节点明明已经升到 Hub 同一个提交（e6b123d），体检却一直显示"代码不一致"，
 * 而两边的真实差异只是 57 条路径里的分隔符（实测：同一棵树 POSIX 算 67bb9c-1hv、
 * 反斜杠算 1gifhh6-1hv，正是它上报的那个值）。
 *
 * 行尾早就归一过（CRLF → LF，"否则 Windows 检出天天误报"）—— 分隔符是同一类坑。
 * 不依赖 `path.sep`：两种写法都归一，这样"Windows 写法"在 mac 上也能被喂进来测。
 * （代价：POSIX 上文件名里真含反斜杠会被误归一 —— 本仓库没有这种文件。）
 */
export function posixRelative(relative: string): string {
  return relative.split('\\').join('/')
}

/**
 * 指纹清单文本：`路径:内容哈希` 逐行拼接（路径已归一为 POSIX、内容已归一化行尾）。
 *
 * 单独导出**只为可测**：这样"Windows 写法与 POSIX 写法必须同指纹"这条断言能在
 * 任何平台上跑（把反斜杠写法的清单喂进来，读文件时再拆回 POSIX 段）。
 */
export function fingerprintListText(root: string, files: string[]): string {
  return files
    .map((relative) => {
      const posix = posixRelative(relative)
      const text = normalizeNewlines(readFileSync(path.join(root, ...posix.split('/')), 'utf8'))
      return `${posix}:${contentHash(text)}`
    })
    .join('\n')
}

/**
 * 某个代码树的内容指纹。
 *
 * 读不到源码（例如被裁剪过的交付形态）时**抛错** —— 由调用方决定是"未知"还是失败，
 * 不在这里悄悄返回一个看起来正常的字符串（那正是我们想根除的"沉默分叉"）。
 */
export function codeFingerprint(root: string): string {
  const files = fingerprintFiles(root)
  if (files.length === 0) throw new Error(`no source files under ${root} (src/ + bin/)`)
  return contentHash(fingerprintListText(root, files))
}

/**
 * 本仓库根目录。
 *
 * 不能简单"往上两级"：源码里是 `<root>/src/protocol/build.ts`（两级到 root ✓），
 * 但编译产物是 `<root>/dist/src/protocol/build.js`（两级只到 `<root>/dist` ✗）——
 * 那会让 dist 形态去 `<root>/dist/src/web/` 找源码，什么都找不到，
 * 于是指纹悄悄退回另一套算法（真实踩到：本地与公网指纹对不上）。
 * 所以改为**向上找真正的包根**：既有 `package.json`、又有 `bin/` 或 `src/` 的那一层。
 */
export function packageRoot(): string {
  const start = path.dirname(fileURLToPath(import.meta.url))
  let dir = start
  for (let depth = 0; depth < 6; depth += 1) {
    if (isPackageRoot(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(start, '..', '..')
}

function isPackageRoot(dir: string): boolean {
  try {
    readFileSync(path.join(dir, 'package.json'))
  } catch {
    return false
  }
  return existsSync(path.join(dir, 'bin')) || existsSync(path.join(dir, 'src'))
}

let cachedCurrent: string | undefined | null = null

/**
 * 本进程**正在运行**的代码指纹。算不出来时返回 `undefined`（调用方按"未知"处理）。
 *
 * 进程内只算一次：源码在运行期间不会变（改了要重启才生效），重复读盘没有意义。
 */
export function currentCodeFingerprint(): string | undefined {
  if (cachedCurrent === null) {
    try {
      cachedCurrent = codeFingerprint(packageRoot())
    } catch {
      cachedCurrent = undefined
    }
  }
  return cachedCurrent ?? undefined
}
