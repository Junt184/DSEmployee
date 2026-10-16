import path from 'node:path'
import { homedir } from 'node:os'
import { access, readdir, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { protocolError } from '../protocol/index.ts'
import { expandHome } from '../util/fsx.ts'

interface DirectoryLocation { name: string; path: string }
interface BrowseDirectoryOptions { path?: unknown; showHidden?: unknown; offset?: unknown }

/** 只读浏览执行节点的文件夹；不调用客户端文件选择 API，也不上传目录内容。 */
export async function browseProjectDirectories(options: BrowseDirectoryOptions, employeeRoot: string): Promise<unknown> {
  if (options.path !== undefined && (typeof options.path !== 'string' || options.path.trim() === '' || options.path.length > 4096)) {
    throw protocolError('bad-request', '文件夹路径不正确，请重新选择')
  }
  if (options.showHidden !== undefined && typeof options.showHidden !== 'boolean') throw protocolError('bad-request', '隐藏文件夹选项不正确')
  const offset = options.offset ?? 0
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw protocolError('bad-request', '文件夹分页位置不正确')
  }
  const requested = typeof options.path === 'string' ? expandHome(options.path) : homedir()
  if (!path.isAbsolute(requested) || requested.includes('\0')) throw protocolError('bad-request', '需要节点上的绝对目录路径')
  let current: string
  let children
  try {
    current = await realpath(requested)
    children = await readdir(current, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const reason = code === 'EACCES' || code === 'EPERM' ? '节点没有权限读取此文件夹' : code === 'ENOENT' || code === 'ENOTDIR' ? '文件夹不存在或已移动' : '暂时无法读取此文件夹'
    throw protocolError('bad-request', `${reason}：${requested}`)
  }
  const entries: DirectoryLocation[] = []
  for (const child of children) {
    if (options.showHidden !== true && child.name.startsWith('.')) continue
    const childPath = path.join(current, child.name)
    if (!child.isDirectory()) {
      if (!child.isSymbolicLink()) continue
      // Windows 目录联接与其他系统的目录软链接均可浏览；失效链接不当作文件夹显示。
      try { if (!(await stat(childPath)).isDirectory()) continue } catch { continue }
    }
    entries.push({ name: child.name, path: childPath })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
  const visible: DirectoryLocation[] = []
  let next = offset
  let bytes = 0
  // 单页同时限制数量和字节，深目录路径也不会把控制通道撑断。
  while (next < entries.length && visible.length < 200) {
    const entry = entries[next]!
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8')
    if (visible.length > 0 && bytes + size > 384 * 1024) break
    visible.push(entry); bytes += size; next += 1
  }
  const root = path.parse(current).root
  const breadcrumbs: DirectoryLocation[] = [{ name: root, path: root }]
  let prefix = root
  for (const name of current.slice(root.length).split(path.sep).filter(Boolean)) {
    prefix = path.join(prefix, name)
    breadcrumbs.push({ name, path: prefix })
  }
  const shortcuts: DirectoryLocation[] = [
    { name: '主目录', path: homedir() },
    { name: '桌面', path: path.join(homedir(), 'Desktop') },
    { name: '文稿', path: path.join(homedir(), 'Documents') },
    { name: '下载', path: path.join(homedir(), 'Downloads') },
    { name: '员工目录', path: employeeRoot },
    ...(process.platform === 'win32'
      ? Array.from({ length: 26 }, (_, index) => {
        const drive = String.fromCharCode(65 + index)
        return { name: `${drive}:`, path: `${drive}:\\` }
      })
      : [{ name: '文件系统', path: root }, ...(process.platform === 'darwin' ? [{ name: '磁盘', path: '/Volumes' }] : [])]),
  ]
  const available = await Promise.all(shortcuts.map(async location => {
    try {
      const target = await realpath(location.path)
      if (!(await stat(target)).isDirectory()) return null
      await access(target, constants.R_OK)
      return { ...location, path: target }
    } catch { return null }
  }))
  const locations: DirectoryLocation[] = []
  for (const location of available) {
    if (location !== null && !locations.some(item => item.path === location.path)) locations.push(location)
  }
  return { path: current, parentPath: current === root ? null : path.dirname(current), breadcrumbs, locations,
    directories: visible, total: entries.length, nextOffset: next < entries.length ? next : null }
}
