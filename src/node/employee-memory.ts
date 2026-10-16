/** 员工记忆由宿主工具写回主目录；项目分区固定在会话装配中，不接受任意文件路径。 */
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'

// 此模块会随会话 preset 一同复制，保持仅依赖 Node 内置模块。
function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}
function stripBom(text: string): string { return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text }

export type MemoryScope = 'global' | 'project'
export interface MemoryEntry { key: string; text: string; updatedAtMs: number; sourceSessionId: string }
interface MemoryFile { version: 1; entries: MemoryEntry[] }
export interface EmployeeMemoryContext {
  employeeId: string
  employeeHome: string
  workPath: string
  projectId?: string
}
const MAX_FILE_BYTES = 128 * 1024
const MAX_ENTRIES = 80

/** 有界读取；既用于上下文，也用于工具，避免先读完整个大文件再截断。 */
export function readEmployeeText(file: string, root: string, limit: number, optional = false): string {
  let fd: number | undefined
  try {
    const resolved = realpathSync(file)
    if (!isPathInside(realpathSync(root), resolved)) throw new Error('员工资料路径超出主目录')
    fd = openSync(resolved, constants.O_RDONLY)
    if (!fstatSync(fd).isFile()) throw new Error('员工资料不是普通文件')
    const buffer = Buffer.alloc(limit + 1)
    let length = 0
    while (length <= limit) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length > limit) throw new Error(`文件过大，读取上限 ${limit} 字节`)
    return stripBom(buffer.subarray(0, length).toString('utf8'))
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  } finally { if (fd !== undefined) closeSync(fd) }
}

export function verifyEmployeeHome(context: EmployeeMemoryContext): void {
  const manifest = JSON.parse(readEmployeeText(path.join(context.employeeHome, '.dsemployee', 'employee.json'), context.employeeHome, 64 * 1024)) as { id?: string }
  if (manifest.id !== context.employeeId) throw new Error('员工主目录的身份已改变，请重新选择员工')
}

export function memoryPath(context: EmployeeMemoryContext, scope: MemoryScope): string {
  if (scope !== 'global' && scope !== 'project') throw new Error('记忆分区只能是 global 或 project')
  if (scope === 'project' && (context.projectId === undefined || !/^[A-Za-z0-9_-]{1,128}$/.test(context.projectId))) {
    throw new Error('此会话没有项目记忆分区，请使用 global')
  }
  return scope === 'global' ? path.join(context.employeeHome, 'memory', 'dse', 'global.json')
    : path.join(context.employeeHome, 'memory', 'dse', 'projects', `${context.projectId}.json`)
}

function parseMemory(text: string): MemoryFile {
  let file: MemoryFile
  try { file = JSON.parse(text) as MemoryFile }
  catch { throw new Error('员工记忆内容无法解析，原文件已保留') }
  if (file?.version !== 1 || !Array.isArray(file.entries) || file.entries.length > MAX_ENTRIES || file.entries.some(entry =>
    !entry || typeof entry.key !== 'string' || entry.key.trim() === '' || entry.key.length > 80 ||
    typeof entry.text !== 'string' || entry.text.length > 4000 || !Number.isFinite(entry.updatedAtMs) || typeof entry.sourceSessionId !== 'string') ||
    new Set(file.entries.map(entry => entry.key)).size !== file.entries.length) throw new Error('员工记忆格式损坏，原文件已保留')
  return file
}

function revision(entry: MemoryEntry): string { return createHash('sha256').update(JSON.stringify(entry)).digest('hex') }

export function readEmployeeMemory(context: EmployeeMemoryContext, scope: MemoryScope): { scope: MemoryScope; entries: Array<MemoryEntry & { revision: string }> } {
  verifyEmployeeHome(context)
  const file = memoryPath(context, scope)
  // 记忆文件本身不能是软链接；平台只替换自己的普通文件。
  try { if (lstatSync(file).isSymbolicLink()) throw new Error('员工记忆文件不能是符号链接') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { scope, entries: [] }
  }
  const data = parseMemory(readEmployeeText(file, context.employeeHome, MAX_FILE_BYTES))
  return { scope, entries: data.entries.map(entry => ({ ...entry, revision: revision(entry) })) }
}

/** 只创建主目录内的记忆子目录，不追随目录软链接。 */
async function ensureMemoryDirectory(context: EmployeeMemoryContext, directory: string): Promise<void> {
  const home = await realpath(context.employeeHome)
  const relative = path.relative(context.employeeHome, directory)
  let current = home
  for (const part of relative.split(path.sep)) {
    if (!part || part === '.' || part === '..') throw new Error('记忆目录不正确')
    current = path.join(current, part)
    await mkdir(current, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('员工记忆目录必须是主目录内的真实文件夹')
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** 串行回收死进程的锁，避免两个等待者同时清理时误删新持有者的锁。 */
async function recoverLock(lockPath: string, employeeHome: string): Promise<void> {
  const recoveryPath = lockPath + '.recovery'
  let recovery
  try { recovery = await open(recoveryPath, 'wx', 0o600) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error }
  try {
    const info = await stat(lockPath)
    let pid: number | undefined
    try { pid = (JSON.parse(readEmployeeText(lockPath, employeeHome, 1024)) as { pid?: number }).pid } catch { /* 创建中或崩溃留下的空锁。 */ }
    const stale = typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? !alive(pid) && Date.now() - info.mtimeMs > 1000 : Date.now() - info.mtimeMs > 30_000
    if (stale) await rm(lockPath, { force: true })
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  finally { await recovery.close(); await rm(recoveryPath, { force: true }) }
}

/** 文件锁覆盖不同 dsh/节点进程；遇到并发修改返回冲突，绝不最后写入覆盖。 */
export async function writeEmployeeMemory(context: EmployeeMemoryContext, input: {
  scope: MemoryScope; key: string; text?: string; operation: 'set' | 'delete'; expectedRevision: string; sessionId: string
}, signal?: AbortSignal): Promise<{ saved: true; scope: MemoryScope; key: string; revision: string }> {
  verifyEmployeeHome(context)
  const key = input.key.trim()
  if (!key || key.length > 80) throw new Error('记忆名称需要 1–80 个字符')
  if (input.operation !== 'set' && input.operation !== 'delete') throw new Error('记忆操作不正确')
  if (input.operation === 'set' && (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000)) throw new Error('每条记忆需要 1–4000 个字符')
  if (typeof input.expectedRevision !== 'string') throw new Error('请先读取记忆，再带上 expectedRevision 更新；新增使用 new')
  const file = memoryPath(context, input.scope)
  await ensureMemoryDirectory(context, path.dirname(file))
  const lockPath = file + '.lock', token = randomUUID(), deadline = Date.now() + 5000
  let locked = false
  while (!locked) {
    signal?.throwIfAborted()
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })) }
      catch (error) { await rm(lockPath, { force: true }); throw error }
      finally { await handle.close() }
      locked = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await recoverLock(lockPath, context.employeeHome)
      if (Date.now() >= deadline) throw new Error('员工记忆正在被其他会话更新，请稍后重新读取再保存')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  const temporary = `${file}.${token}.tmp`
  try {
    signal?.throwIfAborted()
    verifyEmployeeHome(context)
    const current = readEmployeeMemory(context, input.scope)
    const previous = current.entries.find(entry => entry.key === key)
    if ((previous?.revision ?? 'new') !== input.expectedRevision) throw new Error('记忆已被其他会话修改，请重新读取并合并后再保存')
    const entries: MemoryEntry[] = current.entries.filter(entry => entry.key !== key).map(({ revision: _revision, ...entry }) => entry)
    const next = input.operation === 'set' ? { key, text: input.text!.trim(), updatedAtMs: Date.now(), sourceSessionId: input.sessionId } : undefined
    if (next !== undefined) entries.push(next)
    if (entries.length > MAX_ENTRIES) throw new Error(`此记忆分区最多保存 ${MAX_ENTRIES} 条，请先合并或删除旧条目`)
    const text = JSON.stringify({ version: 1, entries }, null, 2) + '\n'
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('此记忆分区已满，请先整理旧记忆')
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
    signal?.throwIfAborted()
    await rename(temporary, file)
    return { saved: true, scope: input.scope, key, revision: next === undefined ? 'new' : revision(next) }
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
    const owner = await readFile(lockPath, 'utf8').then(text => JSON.parse(text) as { token?: string }).catch(() => undefined)
    if (owner?.token === token) await rm(lockPath, { force: true })
  }
}
