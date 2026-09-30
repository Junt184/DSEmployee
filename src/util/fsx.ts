/**
 * 文件系统小工具：原子写、JSON 读写、目录保障、家目录解析。
 *
 * 原子写的做法是"写临时文件 → rename"，rename 在同一文件系统内是原子的，
 * 因此进程在任何时刻被杀都不会留下半截 JSON（这比"直接 writeFile"重要得多，
 * 因为设备台账与 ACL 都是安全相关的状态）。
 */

import { constants } from 'node:fs'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    await access(target, constants.R_OK)
    const { stat } = await import('node:fs/promises')
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

/** 原子写入文本。文件权限默认 0600（私钥、令牌等敏感内容都走这里）。 */
export async function writeFileAtomic(
  target: string,
  /* Buffer 是为了二进制落盘（员工头像等）；文本调用方不受影响 */
  data: string | Buffer,
  mode = 0o600,
): Promise<void> {
  await ensureDir(path.dirname(target))
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, data, { mode })
  await rename(tmp, target)
}

/**
 * 去掉 UTF-8 BOM。
 *
 * 不是洁癖：Windows 上的 PowerShell `Set-Content -Encoding utf8`、记事本、
 * 以及不少企业工具都会写 BOM，而 `JSON.parse` 遇到 BOM 直接抛语法错误。
 * 凡是"读文本再解析"的地方都应该先过这一道。
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 读文本文件，容忍 BOM。 */
export async function readTextFile(target: string): Promise<string> {
  return stripBom(await readFile(target, 'utf8'))
}

/** 读 JSON；文件不存在时返回 `fallback`，内容损坏时**抛错**（不静默吞掉损坏状态）。 */
export async function readJsonFile<T>(target: string, fallback: T): Promise<T> {
  let raw: string
  try {
    raw = await readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
  try {
    return JSON.parse(stripBom(raw)) as T
  } catch (error) {
    throw new Error(
      `corrupt JSON at ${target}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function writeJsonFile(target: string, value: unknown, mode = 0o600): Promise<void> {
  await writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`, mode)
}

export async function removeFile(target: string, force = true): Promise<void> {
  await rm(target, { force })
}

/** 展开 `~`、`~/...`、`~\...` 前缀。 */
export function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homedir(), input.slice(2))
  }
  return input
}

/** 本产品的家目录：`$DSE_HOME` 优先，其次 `~/.dsemployee`。 */
export function dseHome(override?: string): string {
  if (override !== undefined && override !== '') return path.resolve(expandHome(override))
  const fromEnv = process.env['DSE_HOME']
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(expandHome(fromEnv))
  return path.join(homedir(), '.dsemployee')
}

/**
 * 把任意字符串规范化成安全的路径片段（不能含分隔符，不能是 `.` / `..`）。
 *
 * 这是**路径穿越的第一道防线**：所有来自网络的 id / 名字都必须先过这里，
 * 再参与任何路径拼接。
 */
export function safeSlug(input: string, fallback = 'item'): string {
  const lowered = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  if (lowered === '' || lowered === '.' || lowered === '..') return fallback
  return lowered
}

/**
 * 判定 `child` 是否位于 `parent` 之内（含自身）。
 *
 * 用于"员工只能读写自己工作区内的文件"这条硬边界。
 * 两边都先 `path.resolve`，再比较时补上分隔符，避免 `/a/bc` 被误判为在 `/a/b` 内。
 */
export function isPathInside(parent: string, child: string): boolean {
  const p = path.resolve(parent)
  const c = path.resolve(child)
  if (p === c) return true
  const withSep = p.endsWith(path.sep) ? p : p + path.sep
  return c.startsWith(withSep)
}

export function nowMs(): number {
  return Date.now()
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`
}

/**
 * 找一个当前空闲的端口。
 *
 * 做法是让 OS 分配（bind 到 0）再立刻释放，然后把这个端口交给子进程去用。
 * 严格说这中间存在窗口期（端口可能被别人抢走），但我们的使用场景是
 * **本地拉起一个服务并立刻占用它**，窗口只有毫秒级；而且真被抢走时
 * 子进程会启动失败并重试，不会静默出现"连错了服务"这种危险结果。
 *
 * 为什么要自己挑端口而不是让子进程报端口：那样就得**捕获子进程的 stdout**
 * 再去解析它打印的 URL 行 —— 既把我们的启动逻辑绑死在别人的日志格式上，
 * 又需要管道 stdio（受限环境下会被禁止）。
 */
export async function findFreePort(host = '127.0.0.1'): Promise<number> {
  const { createServer } = await import('node:net')
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => {
        if (port === 0) reject(new Error('could not obtain a free port'))
        else resolve(port)
      })
    })
  })
}
