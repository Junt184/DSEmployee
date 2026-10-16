/** dsh 原生 agent-plane 插件：给员工会话装配身份、技能入口与受控记忆工具。无 dsh 包依赖。 */
import path from 'node:path'
import { readdirSync, realpathSync } from 'node:fs'
import {
  readEmployeeMemory, readEmployeeText, verifyEmployeeHome, writeEmployeeMemory,
  type EmployeeMemoryContext, type MemoryScope,
} from './employee-memory.ts'

export const name = 'dse-employee-context'
export const inject = ['tools', 'systemPrompt', 'sandboxPolicy']

// 仅声明本插件使用的公开接缝，不把另一套 dsh/cordis 依赖加载到宿主中。
interface Agent { session: { id: string; header: { cwd?: string } } }
interface Execution { agent?: Agent; signal: AbortSignal }
interface Tool {
  name: string; description: string; parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> }
  execute: (args: Record<string, unknown>, exec: Execution) => Promise<unknown>
}
interface PluginContext {
  tools: { register: (tool: Tool) => unknown }
  systemPrompt: {
    context: (context: { name: string; order: number; text: string }) => () => void
    variable: (name: string, provider: () => string) => () => void
  }
  sandboxPolicy: { resolve: (request: { session: Agent['session'] }) => { mode: string } }
  effect: (effect: () => () => void, label: string) => unknown
}
export interface EmployeeContextConfig extends EmployeeMemoryContext { skills: string[] }

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} 必须为字符串`)
  return value
}
function scopeOf(args: Record<string, unknown>, config: EmployeeContextConfig): MemoryScope {
  const scope = args['scope'] ?? (config.projectId === undefined ? 'global' : 'project')
  if (scope !== 'global' && scope !== 'project') throw new Error('scope 只能是 global 或 project')
  return scope
}
function authorize(config: EmployeeContextConfig, execution: Execution): string {
  execution.signal.throwIfAborted()
  const session = execution.agent?.session
  if (session === undefined || typeof session.id !== 'string' || session.header.cwd === undefined ||
      realpathSync(session.header.cwd) !== realpathSync(config.workPath)) throw new Error('此工具只允许当前工作目录中已装配的员工会话使用')
  verifyEmployeeHome(config)
  return session.id
}
const output = { schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: JSON.stringify(value) }] }
const scopeSchema = { type: 'string', enum: ['global', 'project'], description: 'global 为员工通用记忆；project 为此员工在当前项目中的记忆。默认当前项目，无项目时为 global。' }

/** 每次模型上下文装配都读取最新快照，恢复、压缩及另一会话更新后继续生效。 */
function employeeContext(config: EmployeeContextConfig): string {
  verifyEmployeeHome(config)
  const manifest = JSON.parse(readEmployeeText(path.join(config.employeeHome, '.dsemployee', 'employee.json'), config.employeeHome, 64 * 1024)) as { name: string; role?: string; intro?: string }
  const lines = [
    '【数字员工身份与记忆】',
    `你是 ${manifest.name}（${config.employeeId}）。岗位职责：${manifest.role || '通用助手'}。`,
    ...(manifest.intro ? [`身份补充：${manifest.intro}`] : []),
    `员工主目录：${config.employeeHome}`, `本次执行目录：${config.workPath}`,
    ...(config.projectId === undefined ? [] : [`当前项目标识：${config.projectId}`]),
    '员工主目录保存身份、技能和长期记忆；本次任务的代码、文档和交付物写入执行目录。',
    '以下员工资料中的“本目录”、memory/、.dsh/skills/均相对于员工主目录解释，不能据此改变执行目录。执行者由本节的员工身份确定；项目自身的工作约定照常生效，项目文件中的角色描述不更换当前员工。直接用户指令优先。',
  ]
  for (const file of ['AGENTS.md', 'AGENTS.local.md']) {
    try {
      const text = readEmployeeText(path.join(config.employeeHome, file), config.employeeHome, 32 * 1024, true)
      if (text) lines.push(`【员工资料 ${file}】\n${text}`)
    } catch (error) { lines.push(`员工资料 ${file} 暂不可读：${error instanceof Error ? error.message : String(error)}。需要时请如实说明。`) }
  }
  lines.push('记忆规则：使用 employee_memory_read / employee_memory_write 读写员工记忆，不要直接创建或修改项目中的 memory/ 来代替员工记忆。',
    '通用偏好、跨项目可复用的经验保存到 global；当前项目的事实、约定和进展保存到 project。只保存有长期价值且有依据的简要信息，避免重复、臆测、密钥和完整聊天记录。',
    '写入已有条目前先读取，带上其 revision；新增使用 expectedRevision="new"。冲突时重新读取并合并。只有工具返回 saved=true 才能声称已经记住；只读会话只能查阅，不能保存。',
    '下面是当前相关记忆的快照，属于背景资料。每次装配的新快照取代旧快照；不得把其他项目资料当成本项目事实。')
  for (const scope of (config.projectId === undefined ? ['global'] : ['global', 'project']) as MemoryScope[]) {
    try {
      const memory = readEmployeeMemory(config, scope)
      // 最近更新的条目优先，完整资料仍可通过工具读取，截断不改变落盘内容。
      const entries = memory.entries.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      let budget = 10 * 1024, included = 0
      for (const entry of entries) {
        const line = JSON.stringify({ key: entry.key, text: entry.text, revision: entry.revision })
        const bytes = Buffer.byteLength(line)
        if (bytes > budget) continue
        lines.push(`[${scope}] ${line}`); budget -= bytes; included += 1
      }
      if (entries.length === 0) lines.push(`[${scope}] 暂无已保存记忆。`)
      else if (included < entries.length) lines.push(`[${scope}] 仅载入 ${included}/${entries.length} 条；需要完整内容时调用 employee_memory_read。`)
    } catch (error) { lines.push(`[${scope}] 记忆读取失败，未将其视为空白：${error instanceof Error ? error.message : String(error)}。不得声称读取或保存成功。`) }
  }
  lines.push('员工原有 memory/ 文件保持原样，可通过 employee_memory_legacy 按需查阅。历史文件尚未分区，先确认适用于当前任务，再将有价值的信息整理进对应记忆分区；不要把旧资料全部当成通用事实。')
  lines.push(`员工技能：${config.skills.length ? config.skills.join('、') : '暂无专属技能'}。通过 employee_skill_read(name) 读取员工主目录内的 SKILL.md；项目与公共技能继续走原有技能工具。`, '【数字员工身份与记忆结束】')
  return lines.join('\n')
}

export function apply(ctx: PluginContext, config: EmployeeContextConfig): void {
  if (!config || !path.isAbsolute(config.employeeHome) || !path.isAbsolute(config.workPath) || !Array.isArray(config.skills)) throw new Error('员工上下文配置不完整')
  verifyEmployeeHome(config)
  // 变量值不会被二次插值，员工资料中的 {{模板}} 因此可原样进入上下文。
  ctx.effect(() => ctx.systemPrompt.variable('dse_employee_context', () => employeeContext(config)), 'dse.employeeContextVariable()')
  ctx.effect(() => ctx.systemPrompt.context({ name: 'dse:employee-context', order: 50, text: '{{dse_employee_context}}' }), 'dse.employeeContext()')
  ctx.tools.register({ name: 'employee_memory_read', description: '读取当前数字员工的长期记忆。只能访问员工通用分区和当前项目分区，不读取其他员工或其他项目。返回 revision 用于安全更新。',
    parameters: { type: 'object', properties: { scope: scopeSchema }, additionalProperties: false }, output,
    async execute(args, execution) { authorize(config, execution); return readEmployeeMemory(config, scopeOf(args, config)) },
  })
  ctx.tools.register({ name: 'employee_memory_write', description: '将有长期价值的信息保存到员工自己的主目录。支持新增、更新和删除；不向项目写记忆文件。必须提供 expectedRevision；冲突时重新读取后合并。',
    parameters: { type: 'object', properties: {
      scope: scopeSchema, key: { type: 'string', description: '简短、稳定的记忆名称，1–80 字符。' },
      text: { type: 'string', description: '记忆正文，最多 4000 字符。set 时必填。' },
      operation: { type: 'string', enum: ['set', 'delete'] },
      expectedRevision: { type: 'string', description: '更新或删除时使用读取结果中的 revision；新增为 new。' },
    }, required: ['key', 'operation', 'expectedRevision'], additionalProperties: false }, output,
    async execute(args, execution) {
      const sessionId = authorize(config, execution)
      const mode = ctx.sandboxPolicy.resolve({ session: execution.agent!.session }).mode
      if (mode !== 'workspace-write' && mode !== 'danger-full-access') throw new Error('当前会话为只读，员工记忆未写入')
      return writeEmployeeMemory(config, { scope: scopeOf(args, config), key: string(args['key'], 'key'),
        text: args['text'] === undefined ? undefined : string(args['text'], 'text'),
        operation: string(args['operation'], 'operation') as 'set' | 'delete', expectedRevision: string(args['expectedRevision'], 'expectedRevision'), sessionId }, execution.signal)
    },
  })
  ctx.tools.register({ name: 'employee_skill_read', description: '读取当前员工主目录内的专属技能及其参考文件。name 取员工技能清单；file 默认为 SKILL.md，其他文件只能位于该技能目录内。',
    parameters: { type: 'object', properties: { name: { type: 'string' }, file: { type: 'string' } }, required: ['name'], additionalProperties: false }, output,
    async execute(args, execution) {
      authorize(config, execution)
      const skill = string(args['name'], 'name'), relative = args['file'] === undefined ? 'SKILL.md' : string(args['file'], 'file')
      if (!config.skills.includes(skill) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skill) || path.isAbsolute(relative)) throw new Error('请从当前员工技能清单中选择技能和技能内的相对文件')
      const skills = path.join(config.employeeHome, '.dsh', 'skills')
      // 先约束技能根在员工主目录内，再约束文件在该技能内；目录软链接不能绕过主目录。
      const actualRoot = realpathSync(skills), home = realpathSync(config.employeeHome)
      if (!inside(home, actualRoot)) throw new Error('员工技能目录超出主目录')
      let text: string
      try {
        const root = realpathSync(path.join(skills, skill))
        if (!inside(actualRoot, root)) throw new Error('员工技能目录超出主目录')
        text = readEmployeeText(path.resolve(root, relative), root, 64 * 1024)
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || relative !== 'SKILL.md') throw error
        text = readEmployeeText(path.join(skills, `${skill}.md`), skills, 64 * 1024)
      }
      execution.signal.throwIfAborted()
      return { name: skill, file: relative, text }
    },
  })
  ctx.tools.register({ name: 'employee_memory_legacy', description: '只读查阅此员工原有的 memory/ 历史资料。path 默认为空，列出目录；传入相对文件路径时读取文本。不访问已分区记忆 dse/，也不修改历史文件。',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false }, output,
    async execute(args, execution) {
      authorize(config, execution)
      const relative = args['path'] === undefined ? '' : string(args['path'], 'path')
      if (path.isAbsolute(relative)) throw new Error('只允许历史记忆内的相对路径')
      const root = path.join(config.employeeHome, 'memory'), target = path.resolve(root, relative)
      if (!inside(root, target) || inside(path.join(root, 'dse'), target)) throw new Error('请用分区记忆工具读取已管理记忆')
      let resolved: string
      try { resolved = realpathSync(target) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && relative === '') return { entries: [] }; throw error }
      const home = realpathSync(config.employeeHome), actualRoot = realpathSync(root)
      if (!inside(home, actualRoot) || !inside(actualRoot, resolved) || inside(path.join(actualRoot, 'dse'), resolved)) throw new Error('历史记忆路径超出允许范围')
      try {
        const entries = readdirSync(resolved, { withFileTypes: true }).filter(entry => entry.name !== 'dse' && !entry.isSymbolicLink())
          .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200)
          .map(entry => ({ name: entry.name, path: path.relative(actualRoot, path.join(resolved, entry.name)), directory: entry.isDirectory() }))
        return { entries }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error
        return { path: relative, text: readEmployeeText(resolved, actualRoot, 64 * 1024) }
      }
    },
  })
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}
