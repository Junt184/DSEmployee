/**
 * 应急响应岗位页（四宫格第三个用法：事件台 / 处置队列 / 时间线）。
 *
 * 这一页与安全监测**正好相反**：监测岗不能动手，应急岗**能动手、但每一步都要你批**。
 * 所以测试盯的是这个岗位特有的几条：
 *
 *   1. **不做批量批准**：页面上不许存在"全部批准"（批量拒绝可以有 —— 拒绝只会让事情变慢）；
 *   2. **五要素缺失要标红点名**（缺回滚的步骤不该被一键点过去）；
 *   3. **提案 ↔ 审批单的对照**：dsh 执行时另发一条审批（带的是要跑的命令），
 *      两者不一致必须红着说 —— 真机上见过"提案封单个 IP、审批单封整个网段"；
 *   4. **超授权的动作红标**；**被拒的步骤不许消失**；
 *   5. 没有事件时只说三件真事，不摆假仪表盘。
 *
 * 行为测试沿用仓库既有做法：从**交付脚本**里抠出真源码（按花括号配对），配替身跑。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderControlUiScript } from '../src/web/ui.ts'

const SCRIPT = renderControlUiScript()

function extractFunction(name: string): string {
  const start = SCRIPT.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `交付脚本里找不到 function ${name}(`)
  let depth = 0
  for (let index = SCRIPT.indexOf('{', start); index < SCRIPT.length; index += 1) {
    const char = SCRIPT[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return SCRIPT.slice(start, index + 1)
    }
  }
  throw new Error(`function ${name} 的花括号没有配对`)
}

interface FakeEl {
  tag: string
  className: string
  textContent: string
  title: string
  disabled?: boolean
  children: FakeEl[]
  attrs: Record<string, string>
  onclick?: () => void
  closest?: (sel: string) => FakeEl | null
  appendChild: (child: FakeEl) => void
  setAttribute: (key: string, value: string) => void
  getAttribute: (key: string) => string | null
  removeAttribute: (key: string) => void
  get firstChild(): FakeEl | null
}

function makeEl(tag: string): FakeEl {
  const classes = new Set<string>()
  const node = {
    tag,
    className: '',
    textContent: '',
    title: '',
    children: [] as FakeEl[],
    attrs: {} as Record<string, string>,
    classList: {
      add: (name: string): void => void classes.add(name),
      remove: (name: string): void => void classes.delete(name),
      contains: (name: string): boolean => classes.has(name),
    },
    appendChild: (child: FakeEl): void => {
      node.children.push(child)
    },
    setAttribute: (key: string, value: string): void => {
      node.attrs[key] = value
    },
    getAttribute: (key: string): string | null => node.attrs[key] ?? null,
    removeAttribute: (key: string): void => {
      delete node.attrs[key]
    },
    get firstChild(): FakeEl | null {
      return node.children[0] ?? null
    },
  }
  return node as FakeEl
}

function allText(node: FakeEl): string {
  return node.textContent + node.children.map((child) => ' ' + allText(child)).join('')
}

function collect(node: FakeEl, match: (el: FakeEl) => boolean): FakeEl[] {
  const out: FakeEl[] = []
  const walk = (current: FakeEl): void => {
    if (match(current)) out.push(current)
    for (const child of current.children) walk(child)
  }
  walk(node)
  return out
}

const EMPLOYEE = { id: 'emp_ir', name: '青禾', position: 'pos_ir', nodeOnline: true, agentPreset: 'workspace-write' }
const NOW = Date.now()

/* 常备层：允许处置什么、禁止什么、谁定的 —— 它**不**描述"这一次事件" */
const INCIDENT = {
  stages: ['发现', '遏制', '清除', '恢复', '复盘'],
  authorizedBy: '张总',
  authorizedAtMs: NOW - 24 * 60 * 60 * 1000,
  standing: { assets: ['srv-hub'], allow: ['改防火墙规则', '停用账号', '跑只读命令'], deny: ['重装系统', '删除数据'] },
  capabilities: {
    label: '可处置 · 逐步审批',
    note: '每一步动手前都要提案并等我批准；只读排查不用批。',
    allow: ['读工作区', '跑只读命令', '按批准执行单步处置'],
    deny: ['未经批准的任何写操作', '重装/删数据'],
    expectPreset: 'workspace-write',
    account: 'dsh_ir',
    constraint: 'restrict,no-pty',
  },
}

function step(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's3',
    proposedAtMs: NOW - 12 * 60 * 1000,
    action: 'iptables -I INPUT -s 203.0.113.7 -j DROP',
    assetId: 'srv-hub',
    why: '证据 f-01：该 IP 1 小时内 214 次失败登录',
    impact: '只挡该源 IP 的新连接',
    rollback: 'iptables -D INPUT -s 203.0.113.7 -j DROP',
    etaSec: 5,
    status: 'pending',
    ...over,
  }
}

interface Api {
  incidentView: (raw: unknown) => Record<string, unknown>
  actionsView: (raw: unknown) => { steps: Array<Record<string, unknown>>; stage: string }
  incidentMissingFields: (step: unknown) => string[]
  incidentCounts: (steps: unknown[]) => Record<string, number>
  incidentClock: (steps: unknown[], nowMs: number) => { waitingCount: number; oldestWaitedMs: number }
  incidentScopeCheck: (step: unknown, view: unknown) => { kind: string; text: string }
  incidentMatchApproval: (step: unknown, pending: unknown[]) => { kind: string; text: string }
  incidentStatusLabel: (step: unknown) => string
  incidentLogRows: (steps: unknown[]) => Array<{ text: string; bad?: boolean }>
  incidentsView: (raw: unknown) => Array<{ incidentId: string; title: string; outcome: string }>
  incidentRegistration: (actions: unknown) => { incidentId: string; title: string; level: string; assets: string[]; openedAtMs: number; stage: string }
  renderPanelIncidentPost: (container: FakeEl, ctx: unknown) => void
  renderPanelIncidentSteps: (container: FakeEl, ctx: unknown) => void
  renderPanelIncidentTimeline: (container: FakeEl, ctx: unknown) => void
  renderPanelCapabilityBadge: (container: FakeEl, ctx: unknown) => void
  getState: () => Record<string, unknown>
}

interface Harness {
  api: Api
  resolved: Array<{ id: string; approve: boolean }>
  toasts: string[]
  rpcCalls: Array<{ method: string; params: Record<string, unknown> }>
}

function makeHarness(
  options: { approvals?: unknown[]; canResolve?: boolean; incident?: unknown; actions?: unknown; scopes?: string[] } = {},
): Harness {
  const resolved: Array<{ id: string; approve: boolean }> = []
  const toasts: string[] = []
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  const state: Record<string, unknown> = {
    selectedEmployeeId: EMPLOYEE.id,
    approvals: options.approvals ?? [],
    canResolve: options.canResolve !== false,
    quad: { employeeId: EMPLOYEE.id, incidentDoneOpen: false },
    scopes: options.scopes ?? ['employee.read', 'employee.manage'],
  }
  const scope: Record<string, unknown> = {
    state,
    el: (tag: string, className?: string, text?: unknown): FakeEl => {
      const node = makeEl(tag)
      if (className) node.className = className
      if (text !== undefined && text !== null) node.textContent = String(text)
      return node
    },
    clear: (node: FakeEl): void => void (node.children.length = 0),
    $: (): FakeEl | null => null,
    employeeById: (id: string): unknown => (id === EMPLOYEE.id ? EMPLOYEE : null),
    resolveApproval: (approvalId: string, approve: boolean): void => void resolved.push({ id: approvalId, approve }),
    rpc: (method: string, params: Record<string, unknown>): Promise<unknown> => {
      rpcCalls.push({ method, params })
      return Promise.resolve({ path: params['path'], size: String(params['content'] ?? '').length })
    },
    describeError: (error: unknown): string => String((error as { message?: string })?.message ?? error),
    reloadQuadFiles: (): void => undefined,
    toast: (message: string): void => void toasts.push(message),
    renderQuadCells: (): void => undefined,
    asideBlock, asideRow, makeFoldToggle, appendFileState,
    cellText,
    monitorTimeMs,
    monitorStringList,
    monitorAgoText,
    monitorClockText,
    monitorFileNote,
    monitorTitleSub,
    monitorPendingCount,
    monitorPresetVerdict,
    monitorKeyLines,
    monitorView,
    MONITOR_PATH: 'monitor.json',
    MONITOR_HINT: '（monitor.json 的最小写法）',
    FINDINGS_PATH: 'findings.json',
    MONITOR_BADGE_FALLBACK: '权限边界',
    INCIDENT_PATH: 'incident.json',
    ACTIONS_PATH: 'actions.json',
    INCIDENTS_PATH: 'incidents.json',
    INCIDENT_HINT: '（incident.json 的最小写法）',
    INCIDENT_LOG_MAX: 3,
    INCIDENT_HISTORY_MAX: 3,
    INCIDENT_FIELDS: [
      { key: 'action', label: '动作原文' },
      { key: 'why', label: '依据' },
      { key: 'impact', label: '影响面' },
      { key: 'rollback', label: '回滚办法' },
      { key: 'etaSec', label: '预计耗时' },
    ],
    INCIDENT_STATUS: {
      pending: { label: '待你批准', cls: 'pending' },
      approved: { label: '已批准', cls: 'running' },
      running: { label: '执行中', cls: 'running' },
      done: { label: '已完成', cls: 'done' },
      failed: { label: '失败', cls: 'rollback' },
      'rolled-back': { label: '已回滚', cls: 'rollback' },
      rejected: { label: '已拒绝', cls: 'rejected' },
      todo: { label: '待办', cls: '' },
    },
    INCIDENT_STATUS_ALIAS: {
      待批准: 'pending', 已批准: 'approved', 执行中: 'running', 已完成: 'done', 已拒绝: 'rejected', 回滚: 'rolled-back',
    },
  }
  const source = [
    extractFunction('incidentView'),
    extractFunction('incidentParseSteps'),
    extractFunction('actionsView'),
    extractFunction('incidentMissingFields'),
    extractFunction('incidentStatusLabel'),
    extractFunction('incidentStatusClass'),
    extractFunction('incidentStepWaiting'),
    extractFunction('incidentStepRunning'),
    extractFunction('incidentClock'),
    extractFunction('incidentCounts'),
    extractFunction('incidentScopeCheck'),
    extractFunction('incidentApprovalText'),
    extractFunction('incidentNormalizeCommand'),
    extractFunction('incidentMatchApproval'),
    extractFunction('incidentPendingApprovals'),
    extractFunction('incidentLogRows'),
    extractFunction('workspaceTemplateButton'),
    extractFunction('monitorTemplateText'),
    extractFunction('monitorTemplateButton'),
    extractFunction('incidentTemplateText'),
    extractFunction('incidentTemplateButton'),
    extractFunction('incidentRegistration'),
    extractFunction('incidentsView'),
    extractFunction('incidentCurrentBox'),
    extractFunction('incidentHistoryBox'),
    extractFunction('renderPanelIncidentPost'),
    extractFunction('incidentFieldRows'),
    extractFunction('incidentMiniRow'),
    extractFunction('incidentOpenCard'),
    extractFunction('renderPanelIncidentSteps'),
    extractFunction('renderPanelIncidentTimeline'),
    extractFunction('incidentCapabilityView'),
    extractFunction('capabilitySourceOf'),
    extractFunction('renderPanelCapabilityBadge'),
  ].join('\n')
  const names = Object.keys(scope)
  const factory = new Function(
    ...names,
    source +
      '\nreturn { incidentView: incidentView, actionsView: actionsView, incidentMissingFields: incidentMissingFields, ' +
      'incidentCounts: incidentCounts, incidentClock: incidentClock, ' +
      'incidentMatchApproval: incidentMatchApproval, incidentStatusLabel: incidentStatusLabel, incidentLogRows: incidentLogRows, ' +
      'incidentScopeCheck: incidentScopeCheck, incidentsView: incidentsView, incidentRegistration: incidentRegistration, ' +
      'renderPanelIncidentPost: renderPanelIncidentPost, renderPanelIncidentSteps: renderPanelIncidentSteps, ' +
      'renderPanelIncidentTimeline: renderPanelIncidentTimeline, renderPanelCapabilityBadge: renderPanelCapabilityBadge, ' +
      'getState: function () { return state } }',
  ) as (...args: unknown[]) => Api

  return { api: factory(...Object.values(scope)), resolved, toasts, rpcCalls }
}

/* ── 替身用的两个小工具（与产品里那两个是同一份语义，测试自己带一份最小的） ── */
function el(tag: string, className?: string, text?: unknown): FakeEl {
  const node = makeEl(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}
function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}
function monitorStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((one) => cellText(one)).filter((text) => text !== '')
}
function monitorTimeMs(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') return isFinite(value) && value > 0 ? (value < 1e11 ? Math.round(value * 1000) : Math.round(value)) : 0
  const parsed = Date.parse(String(value))
  return isFinite(parsed) && parsed > 0 ? parsed : 0
}
function monitorAgoText(ms: number): string {
  const minutes = Math.floor(Math.max(0, Number(ms)) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return String(minutes) + ' 分钟前'
  const hours = Math.floor(minutes / 60)
  return String(hours) + ' 小时' + (minutes % 60 > 0 ? ' ' + String(minutes % 60) + ' 分钟' : '') + '前'
}
function monitorClockText(ms: number, _nowMs: number): string {
  const at = Number(ms)
  if (!isFinite(at) || at <= 0) return ''
  const date = new Date(at)
  const pad = (n: number): string => (n < 10 ? '0' + String(n) : String(n))
  return pad(date.getHours()) + ':' + pad(date.getMinutes())
}
function asideBlock(aside: FakeEl, title: string, badgeText?: string, badgeKind?: string): FakeEl {
  const block = el('div', 'aside-block')
  const head = el('div', 'aside-title', title)
  if (typeof badgeText === 'string' && badgeText !== '') head.appendChild(el('span', 'badge ' + (badgeKind ?? ''), badgeText))
  block.appendChild(head)
  aside.appendChild(block)
  return block
}
function asideRow(box: FakeEl, key: string, value: string): FakeEl {
  const row = el('div', 'aside-row')
  row.appendChild(el('span', 'k', key))
  row.appendChild(el('span', 'v', value))
  box.appendChild(row)
  return row
}
function makeFoldToggle(head: FakeEl, expanded: boolean, toggle: () => void): void {
  head.onclick = toggle
  head.setAttribute('aria-expanded', expanded ? 'true' : 'false')
}
function appendFileState(box: FakeEl, result: { ok?: boolean; reason?: string } | null, hint: string): void {
  if (result === null || result === undefined) {
    box.appendChild(el('div', 'aside-note', '（正在载入…）'))
    return
  }
  if (result.ok === true) return
  if (result.reason === 'missing') {
    box.appendChild(el('div', 'quad-empty', '工作区里还没有这个文件。'))
    box.appendChild(el('div', 'aside-note', hint))
    return
  }
  box.appendChild(el('div', 'aside-bad', '读不到：' + String(result.reason)))
}
function monitorFileNote(box: FakeEl, result: unknown, hint: string): boolean {
  if (result !== null && result !== undefined && (result as { ok?: boolean }).ok === true) return false
  appendFileState(box, result as never, hint)
  return true
}
function monitorTitleSub(box: FakeEl, text: string): void {
  if (text === '' || box.firstChild === null) return
  box.firstChild.appendChild(el('span', 'quad-sub', text))
}
function monitorPendingCount(employeeId: string): number {
  return 0
}
function monitorPresetVerdict(_view: unknown, employee: { agentPreset?: string }): { kind: string; text: string } {
  return { kind: 'ok', text: '生效 preset：' + String(employee?.agentPreset ?? '') + ' · 与声明一致' }
}
function monitorKeyLines(view: { assets?: Array<{ name: string; account: string; constraint: string }> }): string[] {
  return (view.assets ?? []).map((asset) => asset.name + ' · ' + asset.account + ' · ' + asset.constraint)
}
function monitorView(): null {
  return null
}

function ctxOf(incident: unknown, actions: unknown, incidents: unknown = null): Record<string, unknown> {
  return {
    employee: EMPLOYEE,
    plan: null,
    incidentsResult: incidents === null ? { ok: false, reason: 'missing' } : { ok: true, value: incidents },
    incidentResult: incident === 'missing' ? { ok: false, reason: 'missing' } : { ok: true, value: incident },
    actionsResult: actions === 'missing' ? { ok: false, reason: 'missing' } : { ok: true, value: actions },
    monitorResult: { ok: false, reason: 'missing' },
    findingsResult: null,
    scopeResult: null,
    boardResult: null,
  }
}

/* 事件登记在 actions.incident 里（**员工写**：这次事件的编号/标题/级别/影响面/发现时间） */
const actionsOf = (steps: unknown[], stage = '遏制'): unknown => ({
  incident: {
    incidentId: 'IR-2026-0925-01',
    title: '生产 Hub 疑似 SSH 爆破后成功登录',
    level: '高',
    assets: ['srv-hub'],
    openedAtMs: NOW - 48 * 60 * 1000,
  },
  stage,
  steps,
})

/* ────────────────────────── 纯函数 ────────────────────────── */

describe('应急响应：五要素、计数与时钟（都现算）', () => {
  it('五要素缺项点名（回滚与耗时最常缺）', () => {
    const harness = makeHarness()
    assert.deepEqual(harness.api.incidentMissingFields(step()), [])
    assert.deepEqual(harness.api.incidentMissingFields(step({ rollback: '', etaSec: 0 })), ['回滚办法', '预计耗时'])
    assert.deepEqual(harness.api.incidentMissingFields(step({ why: '  ', impact: '' })), ['依据', '影响面'])
  })

  it('状态认中文别名；不认识的如实显示原文', () => {
    const harness = makeHarness()
    const steps = harness.api.actionsView(actionsOf([step({ status: '已完成' }), step({ status: '执行中' }), step({ status: '莫名其妙的词' })])).steps
    assert.equal(steps[0]?.status, 'done')
    assert.equal(steps[1]?.status, 'running')
    assert.equal(steps[2]?.status, 'unknown')
    assert.equal(harness.api.incidentStatusLabel(steps[2] as never), '莫名其妙的词', '不认识的词不许被塞进"待批"里')
  })

  it('计数：待批/执行中/完成/被拒/回滚分开数', () => {
    const harness = makeHarness()
    const steps = harness.api.actionsView(
      actionsOf([
        step({ status: 'pending' }),
        step({ id: 's4', status: 'running' }),
        step({ id: 's1', status: 'done' }),
        step({ id: 's2', status: 'rejected' }),
        step({ id: 's5', status: 'rolled-back' }),
      ]),
    ).steps
    const counts = harness.api.incidentCounts(steps)
    assert.deepEqual(
      { pending: counts.pending, running: counts.running, done: counts.done, rejected: counts.rejected, rollback: counts.rollback },
      { pending: 1, running: 1, done: 1, rejected: 1, rollback: 1 },
    )
  })

  it('时钟只算"待批最久的那条"（不把没人提案的时间算成你的锅）', () => {
    const harness = makeHarness()
    const steps = harness.api.actionsView(
      actionsOf([step({ id: 'a', proposedAtMs: NOW - 30 * 60 * 1000 }), step({ id: 'b', proposedAtMs: NOW - 5 * 60 * 1000 }), step({ id: 'c', status: 'done' })]),
    ).steps
    const clock = harness.api.incidentClock(steps, NOW)
    assert.equal(clock.waitingCount, 2)
    assert.ok(clock.oldestWaitedMs >= 29 * 60 * 1000 && clock.oldestWaitedMs <= 31 * 60 * 1000, '取最早那条提案等了多久')
  })

  it('授权依据：成员检查（在清单里 / 不在 → 超授权 / 没写 → 不下结论）', () => {
    /* 为什么是成员检查而不是"从命令里猜意图"：rm -rf /data 与 deny 里的"删除数据"之间
       没有任何可靠的字符串关系。猜错的代价是误报，而红标一旦会误报就没人看了。 */
    const harness = makeHarness()
    const view = harness.api.incidentView(INCIDENT)
    assert.equal(harness.api.incidentScopeCheck(step({ under: '改防火墙规则' }), view).kind, 'ok')
    assert.equal(harness.api.incidentScopeCheck(step({ under: '删除数据库' }), view).kind, 'out', '不在你允许的清单里 → 超授权')
    assert.equal(harness.api.incidentScopeCheck(step({ under: '' }), view).kind, 'unknown', '没写依据 → 不下结论（但界面上会点名）')
    assert.equal(harness.api.incidentScopeCheck(step({ under: '改防火墙规则' }), harness.api.incidentView({ scope: {} })).kind, 'unknown', '人没写 allow 时无从核对')
  })

  it('提案 ↔ 审批单：一致 / 同类但不同（红字）/ 没有对应审批单', () => {
    const harness = makeHarness()
    const same = harness.api.incidentMatchApproval(step(), [{ approvalId: 'ap_1', kind: 'dsh.approval', summary: 'iptables -I INPUT -s 203.0.113.7 -j DROP' }])
    assert.equal(same.kind, 'match')
    const differ = harness.api.incidentMatchApproval(step(), [{ approvalId: 'ap_2', kind: 'dsh.approval', summary: 'iptables -I INPUT -s 203.0.113.0/24 -j DROP' }])
    assert.equal(differ.kind, 'differ', '网段 vs 单个 IP 必须被认出来')
    assert.ok(differ.text.includes('/24'))
    assert.equal(harness.api.incidentMatchApproval(step(), [{ approvalId: 'ap_3', summary: '重启 nginx' }]).kind, 'none')
    assert.equal(harness.api.incidentMatchApproval(step(), []).kind, 'none')
  })

  it('日志只追加不覆盖：提案/批准/完成/回滚各留一条，倒序', () => {
    const harness = makeHarness()
    const steps = harness.api.actionsView(
      actionsOf([
        step({ id: 's1', proposedAtMs: NOW - 45 * 60 * 1000, status: 'done', approvedAtMs: NOW - 40 * 60 * 1000, finishedAtMs: NOW - 38 * 60 * 1000, evidence: 'evidence/s1.txt' }),
        step({ id: 's2', proposedAtMs: NOW - 30 * 60 * 1000, status: 'running', approvedAtMs: NOW - 20 * 60 * 1000 }),
      ]),
    ).steps
    const rows = harness.api.incidentLogRows(steps)
    assert.ok(rows.length >= 4, '至少提案 + 批准 + 完成各一条：' + JSON.stringify(rows.map((r) => r.text)))
    assert.ok(rows[0]!.text.includes('你批准') || rows[0]!.text.includes('完成'), '倒序：最新的在最上面')
    assert.ok(rows.some((row) => row.text.includes('evidence/s1.txt')), '完成的那条要带证据路径')
  })
})

/* ────────────────────────── 面板渲染 ────────────────────────── */

describe('应急响应：面板渲染（审批是这一页的核心）', () => {
  it('左上事件台：当前事件（她提的）+ 阶段 + 计数，并标明事实的来源', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    harness.api.renderPanelIncidentPost(box, ctxOf(INCIDENT, actionsOf([step()])))
    const text = allText(box)
    assert.ok(text.includes('生产 Hub 疑似 SSH 爆破后成功登录'), '标题来自**她写的**事件登记：' + text)
    assert.ok(text.includes('事件登记：她提的'), '来源必须标出来（否则人会以为是自己的登记）：' + text)
    assert.ok(text.includes('从发现到现在'), '处置时钟要在：' + text)
    assert.ok(text.includes('等待你批准'), '球在谁手里要在：' + text)
    assert.ok(text.includes('遏制'), '阶段要在：' + text)
    assert.ok(text.includes('张总'), '授权是谁定的要写出来（常备层）：' + text)
    assert.ok(text.includes('禁止'), '禁止项要在（任何一步都不许越过）：' + text)
    assert.ok(!text.includes('预案'), '这一格不放预案 —— 要干什么由人当场告诉她：' + text)
  })

  it('历史事件：读 incidents.json，倒序、带结果与报告路径；没有就如实说没有', () => {
    const harness = makeHarness()
    const history = [
      { incidentId: 'IR-2026-09-21-02', title: 'sshd 端口暴露', level: '中', openedAtMs: NOW - 4 * 86400000, closedAtMs: NOW - 3.9 * 86400000, outcome: '已封禁并复核', report: '复盘/IR-2026-09-21-02.md', steps: { total: 11, rejected: 1, rolledBack: 1 } },
      { incidentId: 'IR-2026-09-18-01', title: '弱口令', level: '低', closedAtMs: NOW - 7 * 86400000, outcome: '已改密', steps: { total: 3 } },
    ]
    const box = makeEl('div')
    harness.api.renderPanelIncidentPost(box, ctxOf(INCIDENT, actionsOf([step()]), history))
    const text = allText(box)
    assert.ok(text.includes('历史事件'), text)
    assert.ok(text.includes('sshd 端口暴露') && text.includes('弱口令'), '两次历史都要在：' + text)
    assert.ok(text.includes('被拒 1') && text.includes('回滚 1'), '历史里也要带上"被拒/回滚"的计数：' + text)
    assert.ok(text.includes('报告'), '有报告就给入口：' + text)

    const empty = makeEl('div')
    harness.api.renderPanelIncidentPost(empty, ctxOf(INCIDENT, actionsOf([step()]), { incidents: [] }))
    assert.ok(allText(empty).includes('还没有历史事件'), '空态要如实说：' + allText(empty).slice(-60))
  })

  it('超出常备授权：不要求你回去改配置 —— 通过即记录一次破例', () => {
    /* 真实的应急就是这样（break-glass 要有账）。原来的设计是"红标超授权 → 你去改 incident.json"，
       那等于在最忙的时候要求人写配置。 */
    const harness = makeHarness({
      approvals: [{ approvalId: 'ap_7', kind: 'dsh.approval', status: 'pending', employeeId: EMPLOYEE.id, summary: 'iptables -I INPUT -s 198.51.100.9 -j DROP' }],
    })
    const box = makeEl('div')
    harness.api.renderPanelIncidentSteps(
      box,
      ctxOf(INCIDENT, actionsOf([step({ action: 'iptables -I INPUT -s 198.51.100.9 -j DROP', under: '扩大封禁范围' })])),
    )
    const text = allText(box)
    assert.ok(text.includes('超出常备授权'), '要如实标红：' + text)
    assert.ok(text.includes('破例'), '并说清"通过"意味着什么：' + text)
    const approve = collect(box, (node) => node.tag === 'button' && node.textContent === '通过')[0]
    assert.notEqual(approve?.disabled, true, '仍然批得动（紧急时不该被配置卡住）')
  })

  it('没有事件登记：说清"必须由人登记"，不猜', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    harness.api.renderPanelIncidentPost(box, ctxOf('missing', 'missing'))
    const text = allText(box)
    assert.ok(text.includes('incident.json'), text)
    assert.ok(text.includes('必须由人定一次'), '这一格的空态文案是产品的一部分（常备层定一次，不是每次事件都写）：' + text)
    assert.ok(text.includes('常备层') || text.includes('长期不变'), '要说清这份文件的定位：' + text)
  })

  it('空闲（没有当前事件）：当前无事件 + 历史事件，不摆仪表盘、不放预案', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    /* 空闲的判定：actions.json 里没有事件登记、也没有步骤 */
    harness.api.renderPanelIncidentPost(box, ctxOf(INCIDENT, { incident: {}, steps: [] }, { incidents: [{ incidentId: 'IR-1', title: '上次那次', closedAtMs: NOW - 86400000, outcome: '已关闭' }] }))
    const text = allText(box)
    assert.ok(text.includes('当前无进行中的事件'), text)
    assert.ok(text.includes('上次那次'), '历史事件要摆出来：' + text)
    assert.ok(!text.includes('预案'), '不放预案：要干什么由人当场告诉她')
    assert.ok(!text.includes('健康度'), '不显示健康度这类编出来的安心感')
  })

  it('处置队列：展开一条（等得最久的待批），其余折成两行', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    const steps = [
      step({ id: 's1', proposedAtMs: NOW - 30 * 60 * 1000, action: '封禁 1.2.3.4' }),
      step({ id: 's2', proposedAtMs: NOW - 10 * 60 * 1000, action: '停用 deploy', rollback: '', etaSec: 0 }),
    ]
    harness.api.renderPanelIncidentSteps(box, ctxOf(INCIDENT, actionsOf(steps)))
    const open = collect(box, (node) => node.className.includes('quad-step') && node.className.includes('open'))
    const mini = collect(box, (node) => node.className.includes('quad-step') && node.className.includes('mini'))
    assert.equal(open.length, 1, '一次只摊开一条')
    assert.equal(mini.length, 1, '其余折成两行')
    assert.ok(allText(open[0]!).includes('封禁 1.2.3.4'), '摊开的是等得最久的那条')
    const miniText = allText(mini[0]!)
    assert.ok(miniText.includes('停用 deploy'))
    assert.ok(miniText.includes('缺'), '**风险标记必须留在折叠行上**（缺回滚、缺授权依据都算）：' + miniText)
  })

  it('五要素缺失：标红点名，并且"通过"不加强调', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    const pending = [{ approvalId: 'ap_1', kind: 'dsh.approval', status: 'pending', employeeId: EMPLOYEE.id, summary: 'usermod -L deploy' }]
    harness.api.renderPanelIncidentSteps(box, ctxOf(INCIDENT, actionsOf([step({ action: 'usermod -L deploy', rollback: '', etaSec: 0 })])))
    const text = allText(box)
    assert.ok(text.includes('回滚办法') && text.includes('未提供'), text)
    assert.ok(text.includes('提案缺'), '要说清缺什么：' + text)
    /* 缺要素时"通过"按钮不该带 primary 强调（这里没有对应审批单，所以只有提示文案） */
    const harness2 = makeHarness({ approvals: pending })
    const box2 = makeEl('div')
    harness2.api.renderPanelIncidentSteps(box2, ctxOf(INCIDENT, actionsOf([step({ action: 'usermod -L deploy', rollback: '', etaSec: 0 })])))
    const approve = collect(box2, (node) => node.tag === 'button' && node.textContent === '通过')[0]
    assert.ok(approve !== undefined, '有对应审批单就该给按钮')
    assert.ok(!approve!.className.includes('primary'), '缺回滚的步骤不给"通过"加强调')
  })

  it('行内裁决：通过/拒绝各自带正确的 approvalId（复用平台的 approval.resolve）', () => {
    const harness = makeHarness({
      approvals: [{ approvalId: 'ap_42', kind: 'dsh.approval', status: 'pending', employeeId: EMPLOYEE.id, summary: 'iptables -I INPUT -s 203.0.113.7 -j DROP' }],
    })
    const box = makeEl('div')
    harness.api.renderPanelIncidentSteps(box, ctxOf(INCIDENT, actionsOf([step()])))
    const buttons = collect(box, (node) => node.tag === 'button')
    const approve = buttons.find((node) => node.textContent === '通过')
    const reject = buttons.find((node) => node.textContent === '拒绝')
    assert.ok(approve !== undefined && reject !== undefined, '按钮要给齐：' + JSON.stringify(buttons.map((b) => b.textContent)))
    approve!.onclick?.()
    reject!.onclick?.()
    assert.deepEqual(harness.resolved, [
      { id: 'ap_42', approve: true },
      { id: 'ap_42', approve: false },
    ])
  })

  it('不一致时**不能直接批**：通过按钮不可用、折叠行上也看得见', () => {
    /* 一个能一键放行"和你批的不一样"的按钮，等于把对照这件事做成装饰。 */
    const harness = makeHarness({
      approvals: [{ approvalId: 'ap_9', kind: 'dsh.approval', status: 'pending', employeeId: EMPLOYEE.id, summary: 'iptables -I INPUT -s 203.0.113.0/24 -j DROP' }],
    })
    const box = makeEl('div')
    harness.api.renderPanelIncidentSteps(box, ctxOf(INCIDENT, actionsOf([step()])))
    const approve = collect(box, (node) => node.tag === 'button' && node.textContent === '通过')[0]
    const reject = collect(box, (node) => node.tag === 'button' && node.textContent === '拒绝')[0]
    assert.equal(approve?.disabled, true, '不一致时"通过"必须不可用（先问清）')
    assert.notEqual(reject?.disabled, true, '但"拒绝"随时可用')
    assert.ok(String(approve?.title).includes('不一致'), '要说清为什么不可用：' + String(approve?.title))

    /* 折起来的那条也要带标记：不一致不能只藏在展开卡里 */
    const many = [step({ id: 'a', proposedAtMs: NOW - 40 * 60 * 1000, action: 'iptables -I INPUT -s 1.2.3.4 -j DROP' }), step({ id: 'b' })]
    const box2 = makeEl('div')
    harness.api.renderPanelIncidentSteps(box2, ctxOf(INCIDENT, actionsOf(many)))
    const chips = collect(box2, (node) => node.className.includes('quad-risky')).map((node) => node.textContent)
    assert.ok(chips.includes('不一致'), '折叠行上要有「不一致」标记：' + JSON.stringify(chips))
  })

  it('提案与审批单不一致：红着说，并列出两边原文', () => {
    const harness = makeHarness({
      approvals: [{ approvalId: 'ap_9', kind: 'dsh.approval', status: 'pending', employeeId: EMPLOYEE.id, summary: 'iptables -I INPUT -s 203.0.113.0/24 -j DROP' }],
    })
    const box = makeEl('div')
    harness.api.renderPanelIncidentSteps(box, ctxOf(INCIDENT, actionsOf([step()])))
    const diff = collect(box, (node) => node.className.includes('quad-step-diff'))
    assert.equal(diff.length, 1, '不一致必须红着摆出来')
    const text = allText(diff[0]!)
    assert.ok(text.includes('/24') && text.includes('203.0.113.7'), '两边原文都要给：' + text)
    assert.ok(text.includes('不一致'), text)
  })

  it('**页面上没有"全部批准"**，只有"全部拒绝并停手"', () => {
    const harness = makeHarness({
      approvals: [
        { approvalId: 'ap_1', kind: 'dsh.approval', status: 'pending', employeeId: EMPLOYEE.id, summary: 'a' },
        { approvalId: 'ap_2', kind: 'dsh.approval', status: 'pending', employeeId: EMPLOYEE.id, summary: 'b' },
      ],
    })
    const box = makeEl('div')
    harness.api.renderPanelIncidentSteps(box, ctxOf(INCIDENT, actionsOf([step()])))
    const labels = collect(box, (node) => node.tag === 'button').map((node) => node.textContent)
    for (const label of labels) {
      assert.ok(!/全部批准|批准全部|一键批准|批量批准/.test(label), `不该存在「${label}」——批量批准等于把审批变成橡皮图章`)
    }
    const freeze = collect(box, (node) => node.tag === 'button').find((node) => node.textContent.includes('全部拒绝'))
    assert.ok(freeze !== undefined, '但批量拒绝必须有（拒绝只会让事情变慢）：' + JSON.stringify(labels))
    freeze!.onclick?.()
    assert.deepEqual(harness.resolved, [
      { id: 'ap_1', approve: false },
      { id: 'ap_2', approve: false },
    ], '批量拒绝要把待批的全部拒掉')
  })

  it('被拒的步骤不许消失：计数常显，可展开看明细', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    harness.api.renderPanelIncidentSteps(
      box,
      ctxOf(INCIDENT, actionsOf([step({ status: 'pending' }), step({ id: 's9', status: 'rejected', action: '重启 sshd', result: '会断掉当前连接' })])),
    )
    const text = allText(box)
    assert.ok(text.includes('已结束'), text)
    assert.ok(text.includes('拒绝也是决策'), '被拒的也要留痕，并说明为什么留着：' + text)
    assert.ok(text.includes('✗ 1'), '被拒计数常显：' + text)
  })

  it('执行中优先展开（正在跑的那一步最需要你看）', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    harness.api.renderPanelIncidentSteps(
      box,
      ctxOf(INCIDENT, actionsOf([step({ id: 's1', proposedAtMs: NOW - 40 * 60 * 1000, action: '很老的待批' }), step({ id: 's2', status: 'running', action: '正在跑的那一步' })])),
    )
    const open = collect(box, (node) => node.className.includes('open'))
    assert.ok(allText(open[0]!).includes('正在跑的那一步'), '执行中优先：' + allText(open[0]!))
  })

  it('时间线：一条 = 一步 + 颜色统计 + 日志', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    harness.api.renderPanelIncidentTimeline(
      box,
      ctxOf(INCIDENT, actionsOf([step({ status: 'done', finishedAtMs: NOW - 30 * 60 * 1000 }), step({ id: 's2', status: 'pending' })])),
    )
    const cells = collect(box, (node) => node.className.includes('quad-tl-cell'))
    assert.equal(cells.length, 2, '几步就是几格')
    const text = allText(box)
    assert.ok(text.includes('待你批准 1') && text.includes('完成 1'), text)
    assert.ok(text.includes('只追加不覆盖'), '口径要写在页面上：' + text)
  })

  it('空态里的「写入 incident.json 模板」按钮：写的是**常备层**（授权 + 署名），不是一次事件', async () => {
    const harness = makeHarness()
    const box = makeEl('div')
    harness.api.renderPanelIncidentPost(box, ctxOf('missing', 'missing'))
    const button = collect(box, (node) => node.tag === 'button').find((node) => node.textContent.includes('模板'))
    assert.ok(button !== undefined, '空态要有一个能开始的地方：' + JSON.stringify(collect(box, (n) => n.tag === 'button').map((b) => b.textContent)))
    button!.onclick?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(harness.rpcCalls[0]?.method, 'employee.files.set')
    assert.equal(harness.rpcCalls[0]?.params['path'], 'incident.json')
    const written = JSON.parse(String(harness.rpcCalls[0]?.params['content'])) as {
      standing?: { allow?: string[]; deny?: string[] }
      authorizedBy?: string
      playbooks?: unknown
    }
    assert.ok((written.standing?.allow ?? []).length > 0, '模板要带上一份常备授权（allow）')
    assert.ok((written.standing?.deny ?? []).length > 0, '以及明确的禁止项（deny）')
    assert.ok(String(written.authorizedBy).length > 0, '要留"谁定的"这一栏')
    assert.equal(written.playbooks, undefined, '不放预案：要干什么由人当场告诉她')
  })

  it('没有 employee.manage 权限：不画按钮，并说清为什么', () => {
    const harness = makeHarness({ scopes: ['employee.read'] })
    const box = makeEl('div')
    harness.api.renderPanelIncidentPost(box, ctxOf('missing', 'missing'))
    assert.equal(collect(box, (node) => node.tag === 'button').length, 0, '按了会失败的按钮等于骗人')
    assert.ok(allText(box).includes('employee.manage'), '要说清原因：' + allText(box))
  })

  it('status 字段（常备层）：没写时按老规矩退化，写了就以它为准', () => {
    const harness = makeHarness()
    assert.equal(harness.api.incidentView({ status: 'standby' }).running, false)
    assert.equal(harness.api.incidentView({ status: 'open' }).running, true)
    assert.equal(harness.api.incidentView({ status: 'closed' }).running, false)
    assert.equal(harness.api.incidentView({}).running, true, '没写 status 时：没有 closedAtMs 就算进行中（兼容旧写法）')
    assert.equal(harness.api.incidentView({ closedAtMs: NOW }).running, false)

    const box = makeEl('div')
    harness.api.renderPanelIncidentPost(box, ctxOf({ ...INCIDENT, status: 'standby' }, { incident: {}, steps: [] }))
    assert.ok(allText(box).includes('当前无进行中的事件'), '没有事件登记时就是"当前无事件"：' + allText(box).slice(0, 120))
  })

  it('顶部徽章读 incident.json 的声明（不是 monitor.json）', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    harness.api.getState()['quad'] = { employeeId: EMPLOYEE.id, badgeOpen: true, incidentDoneOpen: false }
    harness.api.renderPanelCapabilityBadge(box, ctxOf(INCIDENT, actionsOf([step()])))
    const text = allText(box)
    assert.equal(box.children[0]?.children[0]?.textContent, '可处置', '药丸只放声明标签的第一段：' + String(box.children[0]?.children[0]?.textContent))
    assert.ok(text.includes('可处置 · 逐步审批'), '弹层标题用完整标签：' + text)
    assert.ok(text.includes('未经批准的任何写操作'), '不能做的那一栏来自 incident.json：' + text)
    assert.ok(text.includes('dsh_ir'), '钥匙要在：' + text)
    assert.ok(!text.includes('monitor.json'), '不许提到另一个岗位的文件名：' + text)
  })
})
