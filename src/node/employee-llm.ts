/**
 * 员工级 LLM 端点配置 —— 每个数字员工可以挂**多条**"我给它的模型"，随时切。
 *
 * 为什么从"一条"变成"一列"（真实痛点）：原来一个员工只能钉死一个端点 + 一个模型，
 * 想换个模型就得把 BaseURL 与 Key 重新手打一遍 —— 于是"同一个员工用不同模型干不同的活"
 * 事实上做不到，切换成本高到没人愿意切。
 *
 * 落盘：`<工作区>/.dsemployee/llm.json`（0o600，与 employee.json 同目录）。v2 形状：
 *
 *   { "version": 2, "activeId": "m_xxx",
 *     "models": [ { id, name, endpointId, apiUrl, apiKey?, model, wiredAtMs?, legacyRoute? } ] }
 *
 * · **name 是别名**（用户手填，如 `gpt5.6-noelle`），员工内唯一 —— 界面上认的是它；
 * · **endpointId 指向 Hub 的端点库**（BaseURL + Key 在那里输一次、多员工复用）；
 *   `apiUrl`/`apiKey` 是**本节点落地的那一份**：接线与切换不必再问 Hub，
 *   Hub 离线时也能把模型切回来；
 * · apiKey 是机密：**只存在于这个文件与 dsh 的凭据库里**，出节点的接口一律只回掩码。
 *
 * 接线原理（dsh 的 LLM 层是 pi-ai，配置命名空间 `llm-pi-ai`）：
 *   · 每条模型声明**自己的一条** provider 路由 `dse-emp-<id前8位>[-<条目短码>]`，
 *     协议固定 `openai-completions`，端点用这条的 apiUrl，模型用这条的 model；
 *   · apiKey 用 `credentials.set` 写到按"员工+条目"唯一的凭据名，provider 声明里的
 *     `apiKeyEnv` 指到它 —— pi-ai 按请求解析这个引用；
 *   · 切换 = `session.selectModel` 指到另一条路由（**不需要重输任何密钥**），
 *     新建会话时按 `activeId` 自动选。
 *
 * 已知边界（接受，注释在此而非假装不存在）：
 *   · provider 声明与凭据都是 **dsh 实例级**的（settings.yaml / credentials.yaml
 *     按 DSH_HOME 存）——靠路由名/凭据名按员工+条目区分来隔离；
 *   · **已存在的会话不迁移**：改配置只影响"新建会话"与**你显式切换的那个会话**。
 *     会话的模型选择是 durable 状态，悄悄换模型会让同一段对话前后风格突变 ——
 *     所以切换必须是一次明确的动作（见 activate），而不是保存的副作用。
 *   · 迁移来的老配置（v1）**沿用它原来的路由名**（`legacyRoute`）：旧会话记录的是
 *     那个路由名，改名就等于让它们失联（真实事故：一个旧会话因此天天 402）。
 */

import path from 'node:path'
import { randomBytes } from 'node:crypto'

import { pathExists, readJsonFile, writeJsonFile, removeFile } from '../util/fsx.ts'
import { assertLlmApiUrl, maskApiKey } from '../util/llm.ts'
import { httpRequestVia } from './llm-proxy.ts'
import type { DshClient } from './dsh-client.ts'

/** v1（历史形状）：一个员工一条端点。读进来就迁移成 v2，不再写这种形状。 */
export interface EmployeeLlmConfig {
  /** OpenAI 兼容端点（http/https，形如 https://api.example.com/v1） */
  apiUrl: string
  /** 机密：只在节点落盘，出节点只回掩码 */
  apiKey?: string
  /** 选用的模型 id（probe 拉到的列表之一，也可手填） */
  model: string
  /** 上次成功接线到 dsh 的时刻；缺失 = 已保存但尚未（或未能）接线 */
  wiredAtMs?: number
}

/** "我给这个员工配的一条模型"：别名 + 指向端点库的一条 + 真实模型 id。 */
export interface EmployeeModelEntry {
  /** 稳定 id（`m_<12hex>`）；**路由按它派生**，所以改别名不会打断任何会话 */
  id: string
  /** 别名（用户手填，员工内唯一）—— 界面上认的就是它 */
  name: string
  /** 端点库里的 id；'' = 本地端点（迁移来的老配置，还没收进库里） */
  endpointId: string
  /** 本节点落地的那一份端点（切换/接线不再问 Hub） */
  apiUrl: string
  apiKey?: string
  /** 端点上的真实模型 id（如 gpt5.6） */
  model: string
  /** 这条端点的出口代理（缺省 = 直连）。有些域名只有走代理才通得过去 */
  proxy?: { host: string; port: number }
  wiredAtMs?: number
  /** 迁移来的那条沿用它原来的路由名；改了旧会话就失联（见文件头注释） */
  legacyRoute?: boolean
}

export interface EmployeeLlmFile {
  version: 2
  activeId?: string
  models: EmployeeModelEntry[]
}

const LLM_FILE = path.join('.dsemployee', 'llm.json')

/** pi-ai 路由名 / 凭据名都从员工 id 派生，保证同一 dsh 实例上互不冲突。 */
export function llmRouteFor(employeeId: string): string {
  return `dse-emp-${shortCode(employeeId)}`
}

export function llmEnvRefFor(employeeId: string): string {
  return `DSE_EMP_${shortCode(employeeId).toUpperCase()}_API_KEY`
}

/** 某条模型自己的路由名 / 凭据名（同一条目永远算出同一个名字）。 */
export function modelRouteFor(employeeId: string, entry: Pick<EmployeeModelEntry, 'id' | 'legacyRoute'>): string {
  if (entry.legacyRoute === true) return llmRouteFor(employeeId)
  return `${llmRouteFor(employeeId)}-${entrySuffix(entry.id)}`
}

export function modelEnvRefFor(
  employeeId: string,
  entry: Pick<EmployeeModelEntry, 'id' | 'legacyRoute'>,
): string {
  if (entry.legacyRoute === true) return llmEnvRefFor(employeeId)
  return `${llmEnvRefFor(employeeId).replace(/_API_KEY$/, '')}_${entrySuffix(entry.id).toUpperCase()}_API_KEY`
}

/** employeeId 形如 emp_a30a359d723e...，取其稳定短码。 */
function shortCode(employeeId: string): string {
  return employeeId.replace(/^emp_/, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'unknown'
}

/**
 * 本地转发口里的路由键：**优先端点库 id**（多个员工共用同一个上游就共用一条路由），
 * 老的"本地端点"（没入库）用它自己的条目 id。
 */
export function llmRouteKeyFor(entry: Pick<EmployeeModelEntry, 'id' | 'endpointId'>): string {
  return entry.endpointId !== '' ? entry.endpointId : entry.id
}

/** 条目短码：路由名的后缀，取自 id 末尾 6 位（只留字母数字，避免进 URL 时被转义）。 */
function entrySuffix(id: string): string {
  const cleaned = String(id).replace(/[^a-zA-Z0-9]/g, '')
  return (cleaned.slice(-6) || 'x').toLowerCase()
}

export function newModelId(): string {
  return `m_${randomBytes(6).toString('hex')}`
}

/* 掩码与 URL 策略在 util/llm.ts（Hub 也要用同一份）；这里再导出一次，
   免得每个调用点都记住"这两件事住在 util 里"。 */
export { assertLlmApiUrl, maskApiKey } from '../util/llm.ts'

/** 别名规则：trim 后 1~64 字；空/过长一律拒绝（别让界面上的名字变成空白）。 */
export function normalizeModelName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name === '') throw new Error('别名不能为空（它是你在界面上认出这条配置的名字）')
  if (name.length > 64) throw new Error(`别名最多 64 字，收到 ${name.length} 字`)
  return name
}

/* ────────────────────────────── 存取 ────────────────────────────── */

function isV1(config: unknown): config is EmployeeLlmConfig {
  const c = config as Partial<EmployeeLlmConfig> | undefined
  return (
    c !== null &&
    typeof c === 'object' &&
    typeof c.apiUrl === 'string' &&
    typeof c.model === 'string' &&
    Array.isArray((c as { models?: unknown }).models) === false
  )
}

/** v1 → v2：一条端点变成一条模型条目，**沿用原来的路由名**（旧会话不能失联）。 */
export function migrateV1(config: EmployeeLlmConfig): EmployeeLlmFile {
  const id = newModelId()
  return {
    version: 2,
    activeId: id,
    models: [
      {
        id,
        name: config.model,
        endpointId: '',
        apiUrl: config.apiUrl,
        ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
        model: config.model,
        ...(config.wiredAtMs === undefined ? {} : { wiredAtMs: config.wiredAtMs }),
        legacyRoute: true,
      },
    ],
  }
}

/**
 * 读配置。**读的时候顺手迁移**：v1 文件读完立刻按 v2 写回（一次性，幂等）。
 *
 * 为什么不"等下次保存再迁移"：迁移要保路由名，而"什么时候被保存"是不确定的 ——
 * 拖到某次编辑再迁，中间任何一次 `applyLlmToSession` 都得同时处理两种形状，
 * 而两种形状的分叉正是这类功能最容易长出的静默 bug。
 */
export async function readLlmFile(workspacePath: string): Promise<EmployeeLlmFile | undefined> {
  const file = path.join(workspacePath, LLM_FILE)
  if (!(await pathExists(file))) return undefined
  const raw = await readJsonFile<unknown>(file, undefined)
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  if (isV1(raw)) {
    const migrated = migrateV1(raw)
    await writeLlmFile(workspacePath, migrated)
    return migrated
  }
  const file2 = raw as Partial<EmployeeLlmFile>
  if (!Array.isArray(file2.models)) return undefined
  const models = file2.models.filter(
    (entry): entry is EmployeeModelEntry =>
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.id === 'string' &&
      typeof entry.name === 'string' &&
      typeof entry.model === 'string' &&
      typeof entry.apiUrl === 'string',
  )
  if (models.length === 0) return { version: 2, models: [] }
  const activeId =
    typeof file2.activeId === 'string' && models.some((m) => m.id === file2.activeId)
      ? file2.activeId
      : undefined
  return { version: 2, ...(activeId === undefined ? {} : { activeId }), models }
}

export async function writeLlmFile(workspacePath: string, file: EmployeeLlmFile): Promise<void> {
  await writeJsonFile(path.join(workspacePath, LLM_FILE), file, 0o600)
}

export async function deleteLlmConfig(workspacePath: string): Promise<void> {
  await removeFile(path.join(workspacePath, LLM_FILE))
}

export function activeModelOf(file: EmployeeLlmFile | undefined): EmployeeModelEntry | undefined {
  if (file === undefined) return undefined
  if (file.activeId === undefined) return undefined
  return file.models.find((entry) => entry.id === file.activeId)
}

/* ────────────────────────────── 探测（拉模型列表）────────────────────────────── */

/**
 * 直接由节点向 `{apiUrl}/models` 发 OpenAI 标准 GET（Bearer key）。
 *
 * 刻意**不经过 dsh**：配置还没保存时就要能试填试拉，而 dsh 的 discoverModels
 * 要先有 provider 声明才顺手。自己发 HTTP 让 probe 与接线解耦。
 */
export async function probeModels(
  apiUrl: string,
  apiKey: string | undefined,
  timeoutMs = 10_000,
  proxy?: { host: string; port: number },
): Promise<{ models: string[] }> {
  const base = assertLlmApiUrl(apiUrl)
  const endpoint = new URL(`${base.pathname.replace(/\/+$/, '')}/models`, base)

  /* 走代理时不能用全局 fetch（undici 不认 HTTP_PROXY，也没有 per-request 代理），
     用自家那套"CONNECT 隧道 + 裸 HTTP/1.1"的实现；直连时也走同一条路 ——
     两条路径一个实现，免得"直连能过、代理挂"这种只在某一边出现的怪毛病。 */
  let status: number
  let headers: Record<string, string | string[] | undefined>
  let text: string
  try {
    const response = await httpRequestVia({
      url: endpoint,
      method: 'GET',
      headers: apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
      proxy,
      timeoutMs,
    })
    status = response.status
    headers = response.headers
    text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      response.stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      response.stream.once('error', reject)
    })
  } catch (error) {
    throw new Error(
      `端点连不通：${error instanceof Error ? error.message : String(error)}（URL 写错？服务没起？代理没开？）`,
    )
  }
  const response = {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name: string): string | null {
        const value = headers[name.toLowerCase()]
        if (value === undefined) return null
        return Array.isArray(value) ? value.join(', ') : value
      },
    },
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('端点拒绝了凭据（HTTP 401）—— API Key 不对或没填')
    }
    if (response.status === 403) {
      /* 403 **不是**"key 错了"的同义词。真实案例：用户的端点在 Cloudflare 后面，
         CF 对所有非浏览器来源直接 403（浏览器 UA、HTTP/1.1、换路径、换机器都一样），
         密钥根本没被送到服务端 —— 而错误消息当时说的是"API Key 不对或没填"，
         把人送去查一个完全无辜的 key。**别把没验证过的原因说成结论。** */
      const edge = response.headers.get('cf-ray') !== null || /cloudflare/i.test(String(response.headers.get('server') ?? ''))
      throw new Error(
        `端点拒绝了这个来源（HTTP 403）${edge ? '，而且是 Cloudflare 在边缘给的 —— 请求根本没到模型服务' : ''}。` +
          '**这不一定是 key 错了**：常见原因是服务方套了 WAF / 按地区或 IP 拦截 / Bot 模式，' +
          '或这把 key 没有访问该端点的权限。请让服务方对 API 域名关掉拦截、或把你的出口 IP 加白名单。',
      )
    }
    throw new Error(`端点返回 HTTP ${response.status}——确认这是 OpenAI 兼容接口（应有 /models）`)
  }

  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    throw new Error('响应不是 JSON —— 这不是 OpenAI 兼容端点（/models 应返回 JSON）')
  }
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) {
    throw new Error('响应里没有 data 数组 —— 这不是 OpenAI 兼容的 /models 形状')
  }
  const models = data
    .map((item) => (item as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string' && id !== '')
  return { models }
}

/* ────────────────────────────── 接线到 dsh ────────────────────────────── */

/**
 * 把**某一条**模型的端点接线到 dsh：声明它自己的 provider 路由 + 写入凭据。
 * 返回更新 wiredAtMs 用的时刻。失败抛错（调用方决定措辞）。
 */
export async function wireModelToDsh(
  dsh: DshClient,
  employeeId: string,
  employeeName: string,
  entry: EmployeeModelEntry,
  /** 这条端点该走哪个 baseURL。带代理的端点在节点里注册了本地转发口，
      于是这里传进来的是 `http://127.0.0.1:<口>/<端点id>`（见 llm-proxy.ts）。 */
  baseUrlOverride?: string,
): Promise<number> {
  const route = modelRouteFor(employeeId, entry)
  const ref = modelEnvRefFor(employeeId, entry)
  const profile: Record<string, unknown> = {
    api: 'openai-completions',
    baseURL: baseUrlOverride ?? entry.apiUrl,
    displayName:
      `${employeeName} · ${entry.name}` +
      (baseUrlOverride === undefined ? '' : `（经 ${entry.proxy?.host ?? '?'}:${String(entry.proxy?.port ?? '')} 代理）`),
    models: [{ id: entry.model }],
  }
  if (entry.apiKey !== undefined && entry.apiKey !== '') {
    await dsh.call('credentials.set', { ref, value: entry.apiKey })
    profile['apiKeyEnv'] = ref
  }
  await dsh.call('settings.mutate', {
    ns: 'llm-pi-ai',
    ops: [{ op: 'set', path: ['providers', route], value: profile }],
  })
  return Date.now()
}

/** 拆除**某一条**模型的接线：删它的 provider 声明与凭据。幂等（不存在也算成功）。 */
export async function unwireModelFromDsh(
  dsh: DshClient,
  employeeId: string,
  entry: Pick<EmployeeModelEntry, 'id' | 'legacyRoute'>,
): Promise<void> {
  await dsh
    .call('settings.mutate', {
      ns: 'llm-pi-ai',
      ops: [{ op: 'unset', path: ['providers', modelRouteFor(employeeId, entry)] }],
    })
    .catch(() => undefined)
  await dsh
    .call('credentials.unset', { ref: modelEnvRefFor(employeeId, entry) })
    .catch(() => undefined)
}

/**
 * 把某个会话选到指定路由。返回 { ok, note }：失败**不抛**（调用方决定怎么报）。
 */
export async function selectModelForSession(
  dsh: DshClient,
  sessionId: string,
  route: string,
  model: string,
): Promise<{ ok: boolean; note?: string }> {
  try {
    await dsh.call('session.selectModel', { sessionId, provider: route, model })
    return { ok: true }
  } catch (error) {
    return { ok: false, note: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 新建会话后：若该员工有"当前模型"，把会话选到它。返回是否真的选了。
 * 失败只告警不抛错 —— 会话已经建成，模型选不上不该让建会话整体失败。
 */
export async function applyLlmToSession(
  dsh: DshClient,
  workspacePath: string,
  employeeId: string,
  sessionId: string,
  log: (message: string) => void,
): Promise<boolean> {
  const entry = activeModelOf(await readLlmFile(workspacePath))
  if (entry === undefined) return false
  const result = await selectModelForSession(dsh, sessionId, modelRouteFor(employeeId, entry), entry.model)
  if (result.ok) return true
  log(`warning: session ${sessionId} 选择「${entry.name}」失败（沿用默认模型）：${result.note ?? ''}`)
  return false
}

/** 出节点的视图（apiKey 只回掩码）—— 所有对外的形状都从这里生成，别各写一份。 */
export function llmViewModel(
  employeeId: string,
  file: EmployeeLlmFile | undefined,
): {
  employeeId: string
  configured: boolean
  activeId?: string
  activeName?: string
  models: Array<{
    id: string
    name: string
    endpointId: string
    model: string
    apiUrl: string
    hasKey: boolean
    keyMask?: string
    wired: boolean
    active: boolean
  }>
} {
  const models = (file?.models ?? []).map((entry) => ({
    id: entry.id,
    name: entry.name,
    endpointId: entry.endpointId,
    model: entry.model,
    apiUrl: entry.apiUrl,
    hasKey: entry.apiKey !== undefined && entry.apiKey !== '',
    ...(entry.apiKey === undefined || entry.apiKey === ''
      ? {}
      : { keyMask: maskApiKey(entry.apiKey) }),
    wired: entry.wiredAtMs !== undefined,
    active: file?.activeId === entry.id,
  }))
  const active = models.find((entry) => entry.active === true)
  return {
    employeeId,
    configured: models.length > 0,
    ...(active === undefined ? {} : { activeId: active.id, activeName: active.name }),
    models,
  }
}
