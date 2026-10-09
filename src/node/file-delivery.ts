import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '../util/fsx.ts'

const START = '<!-- dsemployee:file-delivery:start -->'
const END = '<!-- dsemployee:file-delivery:end -->'
const INSTRUCTIONS = [
  START,
  '向用户发送文件：先把真实文件写入本工作区（建议放交付物/），再在回复正文中写 [文件名](dse-file:相对路径)，控制台会显示下载卡片。',
  '例如：[报告.pdf](dse-file:交付物/报告.pdf)。路径中的空格、括号、#、? 用 URL 编码；不要把链接放进代码块，不要使用绝对路径或 file://，不要链接尚未生成的文件。单文件下载上限 2 MB，超过时先拆分。',
  END,
].join('\n')

/** dsh 自动加载本地 overlay；只管理自己的块，保留用户的岗位说明与本机补充。 */
export async function ensureFileDeliveryInstructions(workspacePath: string): Promise<void> {
  const file = path.join(workspacePath, 'AGENTS.local.md')
  const current = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const start = current.indexOf(START)
  const end = current.indexOf(END)
  let next: string
  if (start < 0 && end < 0) {
    next = current + (current === '' ? '' : current.endsWith('\n') ? '\n' : '\n\n') + INSTRUCTIONS + '\n'
  } else if (start >= 0 && end >= start) {
    next = current.slice(0, start) + INSTRUCTIONS + current.slice(end + END.length)
  } else {
    throw new Error('AGENTS.local.md 的文件交付指令块不完整，请保留成对的 start/end 标记')
  }
  if (next !== current) await writeFileAtomic(file, next, 0o600)
}
