/** 复制会话原工具模板，再装配员工上下文。只改本平台生成的副本，不改员工的源 preset。 */
import path from 'node:path'
import { homedir } from 'node:os'
import { stripTypeScriptTypes } from 'node:module'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { expandHome, writeFileAtomic } from '../util/fsx.ts'
import type { DshClient } from './dsh-client.ts'
import type { DiscoveredEmployee } from './employees.ts'
import type { EmployeeContextConfig } from './employee-context-plugin.ts'

const pending = new Map<string, Promise<string>>()
const START = '# dsemployee:employee-context:start'
const END = '# dsemployee:employee-context:end'

export async function prepareEmployeeContext(options: {
  dsh: DshClient; employee: DiscoveredEmployee; workPath: string; projectId?: string; basePreset?: string; dshHome?: string
}): Promise<string> {
  const home = path.resolve(expandHome(options.dshHome ?? process.env['DSH_HOME'] ?? path.join(homedir(), '.dsh')))
  const roster = await options.dsh.call<{ presets: Array<{ id: string; isDefault?: boolean }> }>('agentPreset.list', {})
  const base = options.basePreset ?? options.employee.agentPreset ?? roster.presets.find(preset => preset.isDefault)?.id
  if (base === undefined) throw new Error('节点没有可用的默认工具模板，请设置 default-preset')
  if (base.startsWith('dse-work-')) throw new Error('员工的工具模板应选择原始 preset，不能使用平台生成的会话副本')
  const source = await options.dsh.call<{ content: string }>('agentPreset.read', { agentPreset: base })
  if (typeof source?.content !== 'string' || source.content.includes(START)) throw new Error('员工工具模板无法读取，或已包含会话专用上下文')
  if (/includeRuntimeContext\s*:\s*false/.test(source.content)) throw new Error('此工具模板关闭了运行上下文，无法装配员工身份与记忆；请启用 includeRuntimeContext 或改用 standard/code 模板')
  const config: EmployeeContextConfig = { employeeId: options.employee.id, employeeHome: await realpath(options.employee.workspacePath),
    workPath: await realpath(options.workPath), projectId: options.projectId, skills: options.employee.skills }
  // 随 preset 固化两份独立运行的 JS，旧会话不依赖已被升级清理的源码目录。
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  const [pluginSource, memorySource] = await Promise.all([
    readFile(new URL(`./employee-context-plugin.${extension}`, import.meta.url), 'utf8'),
    readFile(new URL(`./employee-memory.${extension}`, import.meta.url), 'utf8'),
  ])
  const plugin = (extension === 'ts' ? stripTypeScriptTypes(pluginSource) : pluginSource)
    .replace(/(['"])\.\/employee-memory\.(?:ts|js)\1/g, "'./dse-employee-memory.mjs'")
  const memory = extension === 'ts' ? stripTypeScriptTypes(memorySource) : memorySource
  const identity = createHash('sha256').update(JSON.stringify({ config, plugin, memory, base, source: source.content })).digest('hex').slice(0, 24)
  const id = `dse-work-${identity}`, key = home + '/' + id
  const existing = pending.get(key)
  if (existing !== undefined) return existing
  const preparing = (async () => {
    const file = path.join(home, '.agent-presets', id, 'agent.cordis.yml')
    // copy 由 dsh 完成，保留自定义模板中的相对资源；若部署禁用本地创作，明确失败。
    const list = await options.dsh.call<{ presets: Array<{ id: string }> }>('agentPreset.list', {})
    if (!list.presets.some(preset => preset.id === id)) {
      try { await options.dsh.call('agentPreset.copy', { from: base, agentPreset: id, name: `${options.employee.name} · ${options.projectId ? '项目' : '个人'}工作` }) }
      catch (error) {
        const retry = await options.dsh.call<{ presets: Array<{ id: string }> }>('agentPreset.list', {})
        if (!retry.presets.some(preset => preset.id === id)) throw error
      }
    }
    let current: string
    try { current = await readFile(file, 'utf8') }
    catch { throw new Error(`找不到 dsh 生成的工具模板：${file}。请用 --dsh-home 指向所连接 dsh 的实际 DSH_HOME；自定义 preset 根需包含默认的 .agent-presets 目录。`) }
    if (!current.includes(START) && current !== source.content) throw new Error('生成的工具模板与源模板不一致，未覆盖原文件')
    for (const [filename, content] of [['dse-employee-context.mjs', plugin], ['dse-employee-memory.mjs', memory]]) {
      const target = path.join(path.dirname(file), filename!)
      const previous = await readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
      if (previous !== content) await writeFileAtomic(target, content!, 0o600)
    }
    const row = [START, '- id: dse-employee-context', "  name: './dse-employee-context.mjs'", `  config: ${JSON.stringify(config)}`, END].join('\n')
    const start = current.indexOf(START), end = current.indexOf(END)
    let next: string
    if (start < 0 && end < 0) next = current.trimEnd() + '\n\n' + row + '\n'
    else if (start >= 0 && end >= start) next = current.slice(0, start) + row + current.slice(end + END.length)
    else throw new Error('平台工具模板中的员工上下文标记不完整，原文件已保留')
    if (next !== current) await writeFileAtomic(file, next, 0o600)
    return id
  })()
  pending.set(key, preparing)
  try { return await preparing } finally { if (pending.get(key) === preparing) pending.delete(key) }
}
