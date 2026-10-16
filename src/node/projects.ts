import path from 'node:path'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { expandHome, isPathInside, newId, readJsonFile, writeJsonFile } from '../util/fsx.ts'
import { protocolError } from '../protocol/index.ts'
import type { DshClient } from './dsh-client.ts'
import type { DiscoveredEmployee, EmployeeStore } from './employees.ts'
import { applyLlmToSession } from './employee-llm.ts'
import { SessionArchiveStore } from './session-archive.ts'
import { FILE_DELIVERY_TEXT } from './file-delivery.ts'
import { browseProjectDirectories } from './directories.ts'
import { prepareEmployeeContext } from './employee-context.ts'
import { historyEntrySeq, pageEvents, sanitizeHistoryEvents } from './session-payload.ts'

export interface ProjectRecord {
  projectId: string
  nodeId: string
  name: string
  path: string
  createdAtMs: number
  lastOpenedAtMs: number
}

/** 路径只属于项目；员工是会话的可选执行者，创建后不能换人或换目录。 */
export interface ProjectSession {
  sessionId: string
  projectId: string
  nodeId: string
  employeeId?: string
  employeeName?: string
  /** 员工主目录与执行目录独立，记录新会话实际装配的位置。 */
  employeeHome?: string
  employeeContextVersion?: 1
  createdAtMs: number
  archivedAtMs?: number
  setupError?: string
  instructions: string
}

interface ProjectFile { version: 1; projects: ProjectRecord[]; sessions: ProjectSession[] }

/** 登记信息放在节点状态目录，接入项目不往用户目录写配置、AGENTS.md 或 .git。 */
export class ProjectStore {
  readonly file: string
  readonly nodeId: string
  #data: ProjectFile = { version: 1, projects: [], sessions: [] }
  #writes: Promise<unknown> = Promise.resolve()

  constructor(file: string, nodeId: string) { this.file = file; this.nodeId = nodeId }

  async init(): Promise<void> {
    const data = await readJsonFile<ProjectFile>(this.file, this.#data)
    if (data?.version !== 1 || !Array.isArray(data.projects) || !Array.isArray(data.sessions) ||
        data.projects.some(p => !p || typeof p.projectId !== 'string' || p.nodeId !== this.nodeId ||
          typeof p.name !== 'string' || typeof p.path !== 'string' || !path.isAbsolute(p.path) ||
          !Number.isFinite(p.createdAtMs) || !Number.isFinite(p.lastOpenedAtMs)) ||
        data.sessions.some(s => !s || typeof s.sessionId !== 'string' || s.nodeId !== this.nodeId ||
          typeof s.instructions !== 'string' || !Number.isFinite(s.createdAtMs) ||
          !data.projects.some(p => p.projectId === s.projectId) ||
          (s.employeeId !== undefined && typeof s.employeeId !== 'string') ||
          (s.employeeHome !== undefined && (typeof s.employeeHome !== 'string' || !path.isAbsolute(s.employeeHome))) ||
          (s.employeeContextVersion !== undefined && s.employeeContextVersion !== 1) ||
          (s.setupError !== undefined && typeof s.setupError !== 'string') ||
          (s.archivedAtMs !== undefined && !Number.isFinite(s.archivedAtMs))) ||
        new Set(data.projects.map(p => p.projectId)).size !== data.projects.length ||
        new Set(data.sessions.map(s => s.sessionId)).size !== data.sessions.length) {
      throw new Error('项目记录格式不正确，未覆盖已有数据')
    }
    this.#data = data
  }

  projects(): ProjectRecord[] { return this.#data.projects.map(p => ({ ...p })).sort((a, b) => b.lastOpenedAtMs - a.lastOpenedAtMs) }
  binding(sessionId: string): ProjectSession | undefined {
    const found = this.#data.sessions.find(s => s.sessionId === sessionId)
    return found === undefined ? undefined : { ...found }
  }
  project(projectId: string): ProjectRecord {
    const found = this.#data.projects.find(p => p.projectId === projectId)
    if (found === undefined) throw protocolError('not-found', '找不到这个项目，请重新打开项目列表')
    return { ...found }
  }
  async directory(project: ProjectRecord): Promise<string> {
    try {
      const canonical = await realpath(project.path)
      if (canonical !== project.path || !(await stat(canonical)).isDirectory()) throw new Error('目录已移动或被替换')
      await access(canonical, constants.R_OK)
      return canonical
    } catch (error) {
      throw protocolError('not-found', `项目目录无法访问：${project.path}（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
  async open(inputPath: string, name?: string): Promise<ProjectRecord> {
    const expanded = expandHome(inputPath)
    if (!path.isAbsolute(expanded) || expanded.includes('\0')) throw protocolError('bad-request', '请先选择执行节点上的文件夹')
    let canonical: string
    try {
      canonical = await realpath(expanded)
      if (!(await stat(canonical)).isDirectory()) throw new Error('该路径不是目录')
      await access(canonical, constants.R_OK)
    } catch (error) {
      throw protocolError('bad-request', `无法打开目录：${error instanceof Error ? error.message : String(error)}`)
    }
    return this.#change(data => {
      let project = data.projects.find(p => p.path === canonical)
      if (project === undefined) {
        project = { projectId: newId('project'), nodeId: this.nodeId, name: name?.trim() || path.basename(canonical) || canonical,
          path: canonical, createdAtMs: Date.now(), lastOpenedAtMs: Date.now() }
        data.projects.push(project)
      } else project.lastOpenedAtMs = Date.now()
      return { ...project }
    })
  }
  async reserve(session: ProjectSession): Promise<void> {
    await this.#change(data => {
      if (data.sessions.some(s => s.sessionId === session.sessionId)) throw protocolError('bad-request', '会话编号已存在')
      data.sessions.push({ ...session })
    })
  }
  async adopt(sessions: ProjectSession[]): Promise<void> {
    if (sessions.length === 0) return
    await this.#change(data => {
      const known = new Set(data.sessions.map(s => s.sessionId))
      for (const session of sessions) {
        if (!known.has(session.sessionId)) { data.sessions.push(session); known.add(session.sessionId) }
      }
    })
  }
  async archive(sessionId: string, archived: boolean): Promise<number | undefined> {
    return this.#change(data => {
      const row = data.sessions.find(s => s.sessionId === sessionId)
      if (row === undefined) throw protocolError('not-found', '找不到这个项目会话')
      if (archived) row.archivedAtMs ??= Date.now()
      else delete row.archivedAtMs
      return row.archivedAtMs
    })
  }
  async setup(sessionId: string, error?: string): Promise<void> {
    await this.#change(data => {
      const row = data.sessions.find(s => s.sessionId === sessionId)
      if (row === undefined) throw protocolError('not-found', '找不到这个项目会话')
      if (error === undefined) delete row.setupError
      else row.setupError = error
    })
  }
  async #change<T>(change: (data: ProjectFile) => T): Promise<T> {
    const writing = this.#writes.catch(() => undefined).then(async () => {
      const next = structuredClone(this.#data)
      const value = change(next)
      await writeJsonFile(this.file, next)
      this.#data = next
      return value
    })
    this.#writes = writing
    return writing
  }
}

const PROJECT_SESSION_METHODS = new Set(['session.list', 'session.create', 'session.history', 'session.prompt',
  'session.cancel', 'session.rename', 'session.archive', 'session.compact', 'session.watch'])

function required(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.trim() === '') throw protocolError('bad-request', `${key} 不能为空`)
  return value
}
function titleOf(params: Record<string, unknown>): string | undefined {
  if (params['title'] === undefined) return undefined
  const title = required(params, 'title').trim()
  if (title.length > 200) throw protocolError('bad-request', '会话名称最长 200 个字符')
  return title
}

/** 项目会话复用原有 session 协议；旧员工会话与定时任务仍走原有路径。 */
export class ProjectRuntime {
  readonly store: ProjectStore
  readonly #dsh: DshClient
  readonly #employees: EmployeeStore
  readonly #defaultPreset: string | undefined
  readonly #dshHome: string | undefined
  readonly #watch: (sessionId: string, employeeId: string | undefined, watching: boolean) => void
  readonly #log: (message: string) => void

  constructor(options: { store: ProjectStore; dsh: DshClient; employees: EmployeeStore; defaultPreset?: string; dshHome?: string;
    watch: (sessionId: string, employeeId: string | undefined, watching: boolean) => void; log: (message: string) => void }) {
    this.store = options.store; this.#dsh = options.dsh; this.#employees = options.employees
    this.#defaultPreset = options.defaultPreset; this.#dshHome = options.dshHome; this.#watch = options.watch; this.#log = options.log
  }
  handles(method: string, params: Record<string, unknown>): boolean {
    return method.startsWith('project.') || (PROJECT_SESSION_METHODS.has(method) &&
      (params['projectId'] !== undefined || (typeof params['sessionId'] === 'string' && this.store.binding(params['sessionId']) !== undefined)))
  }
  decorate(row: Record<string, unknown>): Record<string, unknown> {
    const binding = this.store.binding(String(row['sessionId'] || ''))
    if (binding === undefined) return row
    const project = this.store.project(binding.projectId)
    return { ...row, projectId: project.projectId, projectName: project.name, projectPath: project.path,
      nodeId: binding.nodeId, employeeId: binding.employeeId, employeeName: binding.employeeName,
      employeeHome: binding.employeeHome, employeeContextVersion: binding.employeeContextVersion,
      createdAtMs: binding.createdAtMs,
      setupError: binding.setupError,
      archived: binding.archivedAtMs !== undefined, archivedAtMs: binding.archivedAtMs }
  }
  async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (params['nodeId'] !== undefined && params['nodeId'] !== this.store.nodeId) throw protocolError('forbidden', '项目不属于这个节点')
    if (method === 'project.list') return { projects: this.store.projects() }
    if (method === 'project.browse') return browseProjectDirectories(params, this.#employees.root)
    if (method === 'project.open') {
      const project = await this.store.open(required(params, 'path'), typeof params['name'] === 'string' ? params['name'] : undefined)
      // 接入已有目录时一次性登记其已有 dsh 会话，不重建会话、不重发提示词、不改模型。
      let historyWarning: string | undefined
      try {
        const employee = (await this.#employees.discover()).employees.find(e => path.resolve(e.workspacePath) === project.path)
        const archives = employee === undefined ? new Map<string, number>() : await new SessionArchiveStore().list(employee.workspacePath)
        const all = (await this.#dsh.sessionList()).items as Array<Record<string, unknown>>
        await this.store.adopt(all.filter(row => typeof row['sessionId'] === 'string' && typeof row['cwd'] === 'string' &&
          path.resolve(row['cwd']) === project.path && this.store.binding(row['sessionId']) === undefined).map(row => ({
            sessionId: String(row['sessionId']), projectId: project.projectId, nodeId: this.store.nodeId,
            employeeId: employee?.id, employeeName: employee?.name, instructions: '',
            archivedAtMs: archives.get(String(row['sessionId'])),
            createdAtMs: typeof row['createdAtMs'] === 'number' ? row['createdAtMs'] : Date.now(),
          })))
      } catch (error) { historyWarning = `目录已接入，但原有会话暂未登记；重新打开此目录可重试：${error instanceof Error ? error.message : String(error)}` }
      return { project, historyWarning }
    }
    if (method === 'project.files.download') return this.#download(params)
    const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : undefined
    const binding = sessionId === undefined ? undefined : this.store.binding(sessionId)
    const projectId = typeof params['projectId'] === 'string' ? params['projectId'] : binding?.projectId
    if (projectId === undefined) throw protocolError('bad-request', '需要指定项目')
    const project = this.store.project(projectId)
    if (sessionId !== undefined && (binding === undefined || binding.projectId !== projectId ||
        (params['employeeId'] !== undefined && params['employeeId'] !== binding.employeeId))) {
      throw protocolError('forbidden', '会话不属于指定的项目或员工')
    }
    if (method === 'session.create') return this.#create(project, params)
    const all = (await this.#dsh.sessionList()).items as Array<Record<string, unknown>>
    if (method === 'session.list') {
      return { sessions: all.filter(row => this.store.binding(String(row['sessionId']))?.projectId === projectId).map(row => this.decorate(row)) }
    }
    const summary = all.find(row => row['sessionId'] === sessionId)
    if (summary === undefined || typeof summary['cwd'] !== 'string' || path.resolve(summary['cwd']) !== project.path || binding === undefined) {
      throw protocolError('not-found', '项目会话不存在或工作目录不匹配')
    }
    switch (method) {
      case 'session.watch': {
        this.#watch(binding.sessionId, binding.employeeId, params['watch'] !== false)
        return { watching: params['watch'] !== false }
      }
      case 'session.cancel': return this.#dsh.sessionCancel(binding.sessionId)
      case 'session.rename': return this.#dsh.sessionRename(binding.sessionId, titleOf(params) ?? required(params, 'title'))
      case 'session.archive': {
        if (typeof params['archived'] !== 'boolean') throw protocolError('bad-request', 'archived 必须为布尔值')
        if (params['archived'] && summary['running'] === true) throw protocolError('bad-request', '运行中的会话暂不能归档')
        return { sessionId, archived: params['archived'], archivedAtMs: await this.store.archive(binding.sessionId, params['archived']) }
      }
      case 'session.compact': {
        const result = await this.#dsh.sessionCompact(binding.sessionId)
        return result ?? { kind: 'error', text: '这个会话未提供上下文压缩能力' }
      }
      case 'session.history': {
        const beforeSeq = typeof params['beforeSeq'] === 'number' ? params['beforeSeq'] : undefined
        const raw = await this.#dsh.sessionHistory(binding.sessionId, { beforeSeq })
        const events = sanitizeHistoryEvents(raw.events).filter(event => beforeSeq === undefined || (historyEntrySeq(event) ?? Infinity) < beforeSeq)
        const page = pageEvents(events, { maxEvents: typeof params['maxEvents'] === 'number' ? params['maxEvents'] : undefined })
        return { ...page, hasMore: page.hasMore || raw.hasMore === true,
          oldestSeq: page.oldestSeq ?? historyEntrySeq(page.events[0]) }
      }
      case 'session.prompt': {
        if (binding.setupError !== undefined) throw protocolError('bad-request', binding.setupError)
        if (binding.archivedAtMs !== undefined) throw protocolError('bad-request', '请先恢复归档会话，再继续发送')
        await this.store.directory(project)
        let text = required(params, 'text')
        // 背景随首次用户输入发送，不生成空白回合，也不写入项目的持久指令文件。
        if (summary['blank'] === true && binding.instructions !== '') text = `${binding.instructions}\n\n【本次任务】\n${text}`
        return (await this.#dsh.sessionPrompt(binding.sessionId, text, params['mode'] === 'steer' ? 'steer' : 'queue')) ?? { accepted: true }
      }
      default: throw protocolError('unknown-method', `项目不支持此操作：${method}`)
    }
  }
  async #create(project: ProjectRecord, params: Record<string, unknown>): Promise<unknown> {
    await this.store.directory(project)
    await this.store.open(project.path)
    const title = titleOf(params)
    let employee: DiscoveredEmployee | undefined
    if (params['employeeId'] !== undefined) {
      const id = required(params, 'employeeId')
      employee = (await this.#employees.discover()).employees.find(e => e.id === id)
      if (employee === undefined) throw protocolError('not-found', '请选择当前节点上的员工')
    }
    const sessionId = newId('session')
    const basePreset = typeof params['agentPreset'] === 'string' ? params['agentPreset'] : employee?.agentPreset ?? this.#defaultPreset
    // 员工上下文与工具随会话装配，执行目录始终是项目目录；通用助手不增加员工身份。
    const preset = employee === undefined ? basePreset : await prepareEmployeeContext({
      dsh: this.#dsh, employee, workPath: project.path, projectId: project.projectId, basePreset, dshHome: this.#dshHome,
    })
    const instructions = [
      '【DSE 项目背景】',
      `本次工作目录：${project.path}。项目自身的 AGENTS.md 和目录约定照常生效。`,
      ...(employee === undefined ? [] : ['员工身份、技能与相关记忆由平台独立提供，员工长期记忆通过 employee_memory_read / employee_memory_write 保存到员工主目录。']),
      FILE_DELIVERY_TEXT,
      '【项目背景结束】',
    ].join('\n')
    // 先记不可变归属，再调用 dsh；超时也不会出现靠 cwd 猜执行者的会话。
    await this.store.reserve({ sessionId, projectId: project.projectId, nodeId: this.store.nodeId,
      employeeId: employee?.id, employeeName: employee?.name,
      employeeHome: employee?.workspacePath, employeeContextVersion: employee === undefined ? undefined : 1,
      createdAtMs: Date.now(), instructions,
      setupError: '会话的初始配置尚未完成，请重新载入；若持续出现，请新建任务。' })
    const created = await this.#dsh.sessionCreate({ cwd: project.path, sessionId, ...(preset === undefined ? {} : { agentPreset: preset }) })
    if (created.sessionId !== sessionId) throw new Error('dsh 返回的会话编号与登记编号不一致')
    let modelError: string | undefined
    if (employee !== undefined) {
      try { await applyLlmToSession(this.#dsh, employee.workspacePath, employee.id, sessionId, this.#log) }
      catch (error) { modelError = `会话已创建，但员工模型未能应用：${error instanceof Error ? error.message : String(error)}` }
    }
    await this.store.setup(sessionId, modelError)
    let titleError: string | undefined
    if (title !== undefined) {
      try { await this.#dsh.sessionRename(sessionId, title) }
      catch (error) { titleError = `会话已创建，但命名失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return { ...created, projectId: project.projectId, nodeId: this.store.nodeId, employeeId: employee?.id,
      employeeHome: employee?.workspacePath, employeeContextVersion: employee === undefined ? undefined : 1, modelError, titleError }
  }
  async #download(params: Record<string, unknown>): Promise<unknown> {
    const project = this.store.project(required(params, 'projectId'))
    const root = await this.store.directory(project)
    const relative = required(params, 'path')
    if (path.isAbsolute(relative)) throw protocolError('bad-request', '只允许项目内的相对文件路径')
    const target = await realpath(path.resolve(root, relative))
    if (!isPathInside(root, target)) throw protocolError('forbidden', '文件路径超出当前项目')
    const info = await stat(target)
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw protocolError('bad-request', '只能下载不超过 2MB 的项目文件')
    const bytes = await readFile(target)
    if (bytes.length > 2 * 1024 * 1024) throw protocolError('bad-request', '项目文件超过 2MB')
    return { path: relative, name: path.basename(target), size: bytes.length, dataBase64: bytes.toString('base64') }
  }
}
