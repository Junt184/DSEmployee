/**
 * 安全监测岗位页（四宫格：顶部徽章 / 哨兵台 / 异常台账 / 值守记录）。
 *
 * 设计稿在 `docs/09-安全监测页设计稿.md`，静态稿在 `docs/mockups/安全监测页-四宫格.html`。
 * 这一页和渗透测试页共用外壳，但它自己的红线更多 —— 测试钉的正是"错了也不会报错、
 * 只会让人误以为一切正常"的那几件：
 *
 *   1. **凡是结论都由控制台现算**：新鲜度、缺轮、两轮差异、证据可信度。
 *      测试里专门喂一份 `"provenance": "external"` 的假字段，证明页面**不读它**。
 *   2. **无数据 != 正常**：陈旧 / 失联 / 从没跑过 / 文件读不到，各自有各自的话。
 *   3. **这一页没有处置动词**：遍历渲染出来的每个按钮的文案，禁止词表里一个都不许有。
 *   4. **监测范围由人写**：没读到 monitor.json 时，空态必须说"盯谁由你定"，
 *      而不是"暂无目标"这种含糊话。
 *
 * 行为测试沿用仓库既有做法（见 ui-quad.test.ts）：从**交付脚本**里抠出真源码，配替身跑。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { renderControlUiScript } from '../src/web/ui.ts'
import { CSS_SOURCE } from './console-source.ts'

const SCRIPT = renderControlUiScript()
const MARKUP = readFileSync(path.join(import.meta.dirname, '..', 'src', 'web', 'markup.ts'), 'utf8')

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

/* ────────────────────────── 替身 ────────────────────────── */

interface FakeEl {
  tag: string
  className: string
  textContent: string
  title: string
  disabled?: boolean
  children: FakeEl[]
  attrs: Record<string, string>
  onclick?: () => void
  classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean }
  appendChild: (child: FakeEl) => void
  setAttribute: (key: string, value: string) => void
  getAttribute: (key: string) => string | null
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

const EMPLOYEE = { id: 'emp_mon', name: '小张', position: 'pos_mon', nodeOnline: true, agentPreset: 'workspace-write' }

interface MonitorApi {
  monitorTimeMs: (value: unknown) => number
  monitorLevelKey: (raw: unknown) => string
  monitorAgoText: (ms: number) => string
  monitorClockText: (ms: number, nowMs: number) => string
  monitorView: (monitor: unknown) => {
    intervalMinutes: number
    intervalFromFile: boolean
    localCount: number
    allow: string[]
    deny: string[]
    label: string
    expectPreset: string
    assets: Array<{ id: string; kind: string; name: string; account: string; intervalMinutes: number }>
  }
  findingsView: (findings: unknown) => {
    rounds: Array<{ atMs: number; assets: Array<{ assetId: string; checkedAtMs: number; snapshot: Record<string, unknown> }>; findings: Array<{ id: string; assetId: string; levelKey: string; title: string }> }>
  }
  monitorAssetState: (
    asset: unknown,
    view: unknown,
    nowMs: number,
    nodeOnline: boolean,
  ) => { state: string; label: string; lastAtMs: number; total: number; provenance: string }
  monitorSlots: (view: unknown, intervalMs: number, nowMs: number, count: number) => Array<{ state: string }>
  monitorDiff: (prev: unknown, next: unknown) => Array<{ assetId: string; key: string; kind: string; added: string[]; removed: string[] }> | null
  monitorPresetVerdict: (view: unknown, employee: unknown) => { kind: string; text: string }
  renderPanelMonitorPost: (container: FakeEl, ctx: unknown) => void
  renderPanelMonitorFindings: (container: FakeEl, ctx: unknown) => void
  renderPanelMonitorWatch: (container: FakeEl, ctx: unknown) => void
  renderPanelCapabilityBadge: (container: FakeEl, ctx: unknown) => void
  monitorTemplateText: () => string
  markMonitorRead: (employeeId: string, findingId: string, read: boolean) => void
  getState: () => Record<string, unknown>
}

interface Harness {
  api: MonitorApi
  rpcCalls: Array<{ method: string; params: Record<string, unknown> }>
  toasts: string[]
  reloads: number
}

/**
 * 把 80-panels 里安全监测那一段的真源码跑起来。
 * 只替身"别人的东西"：DOM、RPC、本地存储、右栏重绘；被测函数一律真源码。
 */
function makeHarness(
  options: { files?: Record<string, string>; scopes?: string[]; employee?: Record<string, unknown> } = {},
): Harness {
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  const toasts: string[] = []
  const stored = new Map<string, string>()
  let reloads = 0
  const employee = { ...EMPLOYEE, ...(options.employee ?? {}) }
  const state = {
    selectedEmployeeId: employee.id,
    approvals: [] as unknown[],
    scopes: options.scopes ?? ['employee.read', 'employee.manage'],
    sessions: [] as unknown[],
    aside: null,
    quad: { employeeId: employee.id, monitorResult: null, findingsResult: null, badgeOpen: false, skillsOpen: false },
  }

  const scope: Record<string, unknown> = {
    el: (tag: string, className?: string, text?: unknown): FakeEl => {
      const node = makeEl(tag)
      if (className) node.className = className
      if (text !== undefined && text !== null) node.textContent = String(text)
      return node
    },
    clear: (node: FakeEl): void => {
      node.children.length = 0
    },
    $: (): FakeEl | null => null,
    rpc: (method: string, params: Record<string, unknown>): Promise<unknown> => {
      rpcCalls.push({ method, params })
      const wanted = String(params['path'] ?? '')
      const content = options.files?.[wanted]
      if (content === undefined) return Promise.reject(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'not-found' }))
      return Promise.resolve({ path: wanted, content })
    },
    describeError: (error: unknown): string => String((error as { message?: string })?.message ?? error),
    readLocal: (key: string): string | null => stored.get(key) ?? null,
    writeLocal: (key: string, value: string): void => void stored.set(key, value),
    toast: (message: string): void => void toasts.push(message),
    reloadQuadFiles: (): void => void (reloads += 1),
    renderQuadCells: (): void => undefined,
    employeeById: (): unknown => employee,
    state,
    /* 顶层常量（交付脚本里是拼接出来的，这里按同样顺序手工带进来 —— 与 80-panels 的 var 段一致） */
    LS: { monitorRead: 'dse.monitorRead' },
    MONITOR_PATH: 'monitor.json',
    FINDINGS_PATH: 'findings.json',
    MONITOR_WINDOW_ROUNDS: 24,
    MONITOR_FINDINGS_MAX: 4,
    MONITOR_LEVELS: [
      { key: 'critical', label: '严重', words: ['严重', 'critical', 'p0'] },
      { key: 'high', label: '高', words: ['高', 'high', 'p1'] },
      { key: 'medium', label: '中', words: ['中', 'medium', 'p2'] },
      { key: 'low', label: '低', words: ['低', 'low', 'p3'] },
    ],
    MONITOR_LEVEL_LABELS: { critical: '严重', high: '高', medium: '中', low: '低' },
    MONITOR_PROV_SELF: '自证',
    MONITOR_PROV_EXT: '可核验',
    MONITOR_HINT: '这一格读工作区里的 monitor.json：盯谁、多久一次、用哪把钥匙，必须由人登记……',
    MONITOR_BADGE_FALLBACK: '权限边界',
    INCIDENT_PATH: 'incident.json',
    INCIDENT_HINT: '（incident.json 的最小写法）',
    ASIDE_ROWS_MAX: 8,
  }

  const source = [
    extractFunction('cellText'),
    extractFunction('asideBlock'),
    extractFunction('asideRow'),
    extractFunction('makeFoldToggle'),
    extractFunction('appendFileState'),
    extractFunction('monitorTimeMs'),
    extractFunction('monitorLevelKey'),
    extractFunction('monitorAgoText'),
    extractFunction('monitorClockText'),
    extractFunction('monitorStringList'),
    extractFunction('monitorView'),
    extractFunction('monitorParseFindings'),
    extractFunction('monitorParseAssetRecord'),
    extractFunction('findingsView'),
    extractFunction('monitorAssetState'),
    extractFunction('monitorSlots'),
    extractFunction('monitorDiff'),
    extractFunction('monitorRoundLevelCounts'),
    extractFunction('monitorReadSet'),
    extractFunction('monitorReadKey'),
    extractFunction('markMonitorRead'),
    extractFunction('monitorFileNote'),
    extractFunction('monitorTitleSub'),
    extractFunction('monitorDotNode'),
    extractFunction('quadPrefillPrompt'),
    extractFunction('monitorPendingCount'),
    extractFunction('monitorPresetVerdict'),
    extractFunction('monitorKeyLines'),
    /* 徽章的"声明从哪个文件读"由这层决定（两个岗位共用同一个面板） */
    extractFunction('incidentView'),
    extractFunction('incidentCapabilityView'),
    extractFunction('capabilitySourceOf'),
    extractFunction('monitorTemplateText'),
    /* 写入模板的按钮现在是两个岗位共用的一条路径 */
    extractFunction('workspaceTemplateButton'),
    extractFunction('monitorTemplateButton'),
    extractFunction('renderPanelCapabilityBadge'),
    extractFunction('renderPanelMonitorPost'),
    extractFunction('monitorFindingNode'),
    extractFunction('renderPanelMonitorFindings'),
    extractFunction('monitorDiffBlock'),
    extractFunction('renderPanelMonitorWatch'),
  ].join('\n')

  const names = Object.keys(scope)
  const factory = new Function(
    ...names,
    source +
      '\nreturn { monitorTimeMs: monitorTimeMs, monitorLevelKey: monitorLevelKey, monitorAgoText: monitorAgoText, ' +
      'monitorClockText: monitorClockText, monitorView: monitorView, findingsView: findingsView, ' +
      'monitorAssetState: monitorAssetState, monitorSlots: monitorSlots, monitorDiff: monitorDiff, ' +
      'monitorPresetVerdict: monitorPresetVerdict, renderPanelMonitorPost: renderPanelMonitorPost, ' +
      'renderPanelMonitorFindings: renderPanelMonitorFindings, renderPanelMonitorWatch: renderPanelMonitorWatch, ' +
      'renderPanelCapabilityBadge: renderPanelCapabilityBadge, monitorTemplateText: monitorTemplateText, ' +
      'markMonitorRead: markMonitorRead, getState: function () { return state } }',
  ) as (...args: unknown[]) => MonitorApi

  return { api: factory(...Object.values(scope)), rpcCalls, toasts, get reloads() { return reloads } }
}

/* ────────────────────────── 夹具 ────────────────────────── */

const MONITOR = {
  defaultIntervalMinutes: 60,
  assets: [
    { id: 'local-win', kind: 'local', name: '办公电脑', os: 'Windows 11' },
    { id: 'srv-hub', kind: 'ssh', name: '生产 Hub', host: '10.0.0.10', readonlyAccount: 'dsh_ro', readonlyConstraint: 'restrict,no-pty' },
  ],
  capabilities: {
    label: '只读 · 无处置权限',
    note: '本岗位只报不处置。',
    allow: ['读工作区', '跑只读命令'],
    deny: ['改配置', '杀进程'],
    expectPreset: 'workspace-write',
  },
}

/**
 * 夹具时间一律相对**真实的现在**。
 *
 * 为什么不能写死一个时刻：面板内部调的是 `Date.now()`（页面上必须显示"距今多久"），
 * 写死 2026-09-24 14:12 会让所有数据在真实时钟走到 15:12 之后集体变成"陈旧" ——
 * 测试会随日期自己烂掉，而且烂的样子是"某一格变黄了"，很难查。
 */
const NOW = Date.now()

/** 一轮巡检（每台资产的快照可以分别指定；不指定就用默认那份） */
function roundFixture(
  atMs: number,
  options: { findings?: unknown[]; snapshots?: Record<string, Record<string, unknown>> } = {},
): unknown {
  const snapshotOf = (assetId: string, fallback: Record<string, unknown>): Record<string, unknown> =>
    options.snapshots?.[assetId] ?? fallback
  return {
    atMs: atMs,
    assets: [
      {
        assetId: 'local-win',
        checkedAtMs: atMs,
        summary: { high: 0, medium: 1, low: 0 },
        snapshot: snapshotOf('local-win', { 'listening-ports': [':135'], 'scheduled-tasks': ['OneDrive'] }),
      },
      {
        assetId: 'srv-hub',
        checkedAtMs: atMs,
        summary: { high: 1, medium: 0, low: 0 },
        snapshot: snapshotOf('srv-hub', { 'listening-ports': [':22', ':443'] }),
      },
    ],
    findings: options.findings ?? [
      { id: 'f-1', assetId: 'srv-hub', level: 'high', title: 'sshd 失败登录 214 次', detectedAtMs: atMs, evidence: 'findings/a.md' },
    ],
  }
}

/** 只有一台、什么发现都没有的一轮（空态与轮次带用） */
function quietRound(atMs: number): unknown {
  return { atMs: atMs, assets: [{ assetId: 'srv-hub', checkedAtMs: atMs, summary: {}, snapshot: {} }], findings: [] }
}

const ctxOf = (harness: Harness, findings: unknown, monitor: unknown = MONITOR): Record<string, unknown> => ({
  employee: EMPLOYEE,
  plan: null,
  monitorResult: { ok: true, value: monitor },
  findingsResult: { ok: true, value: findings },
  get state() {
    return harness.api.getState()
  },
})

/* ────────────────────────── 1. 纯函数：时间与等级 ────────────────────────── */

describe('安全监测：时间与等级的容忍度（员工写的文件不是数据库）', () => {
  it('秒级时间戳按秒算（2026 年的秒级写成 1.75e9，当毫秒会变成 1970 年）', () => {
    const harness = makeHarness()
    assert.equal(harness.api.monitorTimeMs(1758603300), 1758603300000)
    assert.equal(harness.api.monitorTimeMs(1758603300000), 1758603300000)
    assert.equal(harness.api.monitorTimeMs('2026-09-24T06:00:00Z'), Date.UTC(2026, 8, 24, 6))
    assert.equal(harness.api.monitorTimeMs('1758603300000'), 1758603300000)
    assert.equal(harness.api.monitorTimeMs(''), 0, '没有时间就是 0（= 没有），不编一个"现在"')
    assert.equal(harness.api.monitorTimeMs('昨天'), 0)
  })

  it('等级中英文都认；不认识的返回空串（如实显示原文，不塞进"中"里）', () => {
    const harness = makeHarness()
    assert.equal(harness.api.monitorLevelKey('高'), 'high')
    assert.equal(harness.api.monitorLevelKey('HIGH'), 'high')
    assert.equal(harness.api.monitorLevelKey('严重'), 'critical')
    assert.equal(harness.api.monitorLevelKey('中'), 'medium')
    assert.equal(harness.api.monitorLevelKey('low'), 'low')
    assert.equal(harness.api.monitorLevelKey('紧急'), '', '不认识的等级不能被猜成某一档')
  })

  it('"多久以前"与时刻的写法', () => {
    const harness = makeHarness()
    assert.equal(harness.api.monitorAgoText(30 * 1000), '刚刚')
    assert.equal(harness.api.monitorAgoText(12 * 60 * 1000), '12 分钟前')
    assert.equal(harness.api.monitorAgoText(3 * 3600 * 1000 + 12 * 60 * 1000), '3 小时 12 分钟前')
    assert.equal(harness.api.monitorAgoText(-5000), '刚刚', '时钟偏差不能显示成"未来"')
    /* 时刻按本地时区显示，所以期望值也从同一个 Date 现算（写死 14:08 会让 UTC 上的 CI 挂掉） */
    const at = Date.UTC(2026, 8, 24, 6, 8)
    const sameDay = new Date(at)
    const pad = (n: number): string => (n < 10 ? '0' + String(n) : String(n))
    assert.equal(
      harness.api.monitorClockText(at, at),
      pad(sameDay.getHours()) + ':' + pad(sameDay.getMinutes()),
    )
    assert.ok(harness.api.monitorClockText(at, at + 3 * 86400000).startsWith('09-24'), '不是今天就要带上日期')
  })
})

/* ────────────────────────── 2. 纯函数：新鲜度与缺轮 ────────────────────────── */

describe('安全监测：新鲜度、缺轮、差异都由控制台现算', () => {
  it('monitor.json：认 local/ssh、每台自己的周期、缺省 60 分钟并标注"没写周期"', () => {
    const harness = makeHarness()
    const view = harness.api.monitorView({
      assets: [{ id: 'a', kind: 'local', name: '本机' }, { id: 'b', kind: 'ssh', name: '服务器', host: '1.2.3.4', intervalMinutes: 15 }],
    })
    assert.equal(view.intervalFromFile, false)
    assert.equal(view.intervalMinutes, 60)
    assert.equal(view.localCount, 1)
    assert.equal(view.assets[1]?.intervalMinutes, 15, '每台可以有自己的周期')
  })

  it('资产状态的四态优先级：失联 > 没跑过 > 陈旧 > 有异常 > 正常', () => {
    const harness = makeHarness()
    const asset = { id: 'srv-hub', kind: 'ssh', name: '生产 Hub', intervalMinutes: 60 }
    const fresh = harness.api.findingsView({ rounds: [roundFixture(NOW - 4 * 60 * 1000)] })

    assert.equal(harness.api.monitorAssetState(asset, fresh, NOW, false).state, 'off', '节点离线：读不到就是读不到，不许显示正常')
    assert.equal(harness.api.monitorAssetState(asset, fresh, NOW, true).state, 'bad', '在周期内且有"高"以上 → 有异常')
    assert.equal(harness.api.monitorAssetState(asset, harness.api.findingsView({ rounds: [] }), NOW, true).state, 'none', '从没跑过 ≠ 正常')
    assert.equal(
      harness.api.monitorAssetState(asset, harness.api.findingsView({ rounds: [roundFixture(NOW - 4 * 3600 * 1000)] }), NOW, true).state,
      'stale',
      '过了周期还没新数据 → 陈旧（黄），不是绿',
    )
  })

  it('证据可信度按资产种类判，**不读员工写的 provenance 字段**', () => {
    const harness = makeHarness()
    /* 被投毒的员工只要写一句 provenance: external 就想骗过标签 —— 这里证明骗不过 */
    const findings = {
      rounds: [
        {
          atMs: NOW - 60 * 1000,
          assets: [{ assetId: 'local-win', checkedAtMs: NOW - 60 * 1000, summary: {}, snapshot: {} }],
          findings: [{ id: 'f-9', assetId: 'local-win', level: 'high', title: 'x', provenance: 'external-verifiable' }],
        },
      ],
    }
    const view = harness.api.findingsView(findings)
    const local = harness.api.monitorAssetState({ id: 'local-win', kind: 'local', name: '本机', intervalMinutes: 60 }, view, NOW, true)
    const remote = harness.api.monitorAssetState({ id: 'srv-hub', kind: 'ssh', name: '服务器', intervalMinutes: 60 }, view, NOW, true)
    assert.equal(local.provenance, '自证', '本机结论只作线索 —— 报告可以是它自己改过的')
    assert.equal(remote.provenance, '可核验')
  })

  it('轮次带：跑过的格子按结果着色，没跑的是缺轮，当前那格"还没到点"不算缺轮', () => {
    const harness = makeHarness()
    const intervalMs = 60 * 60 * 1000
    /* monitorSlots 收 nowMs，所以这里用**固定相位**（本地"整点后 5 分钟"）钉判定。
       别用真实的 Date.now()：槽是按"整点切"的，相位一变，同一份断言就会自己变红
       （我第一版就是这么写的，跑了半天才在某个整点后翻车 —— 那种红是最浪费时间的红）。 */
    const at5 = Math.floor(NOW / intervalMs) * intervalMs + 5 * 60 * 1000

    /* 最近 6 个周期槽里跑了 3 次：4 分钟前（当前槽）、125 / 245 分钟前，中间是缺口。
       老的那几轮不给发现，否则整条带子都是红的，看不出"有异常"是哪一格。 */
    const view = harness.api.findingsView({
      rounds: [quietRound(at5 - 4 * 60 * 1000), quietRound(at5 - 125 * 60 * 1000), quietRound(at5 - 245 * 60 * 1000)],
    })
    const slots = harness.api.monitorSlots(view, intervalMs, at5, 6)
    assert.equal(slots.length, 6)
    const states = slots.map((slot) => slot.state)
    assert.equal(states[5], 'ok', '最近这一格是刚跑过的')
    assert.equal(states.filter((state) => state === 'ok').length, 3, '三次跑过的巡检 → 三格有数据：' + JSON.stringify(states))
    assert.equal(states.filter((state) => state === 'miss').length, 3, '缺口必须自己冒出来（员工漏跑时它当然不会自己报告）：' + JSON.stringify(states))

    /* 上一轮在**上一个槽**里（整点前 25 分钟），而现在只是整点后 5 分钟：
       当前这一格还没到点，不能算缺轮 */
    const notDueYet = harness.api.monitorSlots(
      harness.api.findingsView({ rounds: [quietRound(at5 - 30 * 60 * 1000)] }),
      intervalMs,
      at5,
      2,
    )
    assert.deepEqual(notDueYet.map((slot) => slot.state), ['ok', 'due'], '刚过周期边界：这一格是"还没到点"，不冤枉员工')

    /* 上一轮 200 分钟前：早就该跑了却没跑 */
    const late = harness.api.monitorSlots(harness.api.findingsView({ rounds: [quietRound(at5 - 200 * 60 * 1000)] }), intervalMs, at5, 2)
    assert.deepEqual(late.map((slot) => slot.state), ['miss', 'miss'], '早就该跑了却没跑 → 缺轮')

    /* 有"高"以上发现的那一轮，格子是红的 */
    const bad = harness.api.monitorSlots(harness.api.findingsView({ rounds: [roundFixture(at5 - 4 * 60 * 1000)] }), intervalMs, at5, 1)
    assert.equal(bad[0]?.state, 'bad')
  })

  it('两轮差异：列表比新增/消失、标量比值；上一轮没有快照就说"比不了"', () => {
    const harness = makeHarness()
    const view = harness.api.findingsView({
      rounds: [
        roundFixture(NOW - 3600 * 1000, {
          snapshots: { 'srv-hub': { 'listening-ports': [':22', ':443'], sshd: 'ok' }, 'local-win': { 'scheduled-tasks': [] } },
        }),
        roundFixture(NOW, {
          snapshots: { 'srv-hub': { 'listening-ports': [':22', ':443', ':8080'], sshd: 'warn' }, 'local-win': { 'scheduled-tasks': ['OneDrive'] } },
        }),
      ],
    })
    const rounds = view.rounds
    const diffs = harness.api.monitorDiff(rounds[0], rounds[1]) ?? []
    const port = diffs.find((one) => one.key === 'listening-ports')
    assert.deepEqual(port?.added, [':8080'], '新增的端口要单独列出来')
    assert.deepEqual(port?.removed, [])
    assert.equal(diffs.find((one) => one.key === 'sshd')?.kind, 'scalar', '标量按值比')
    assert.deepEqual(diffs.find((one) => one.key === 'scheduled-tasks')?.added, ['OneDrive'])

    /* 上一轮那一台没写 snapshot → 只说"比不了"，不编出"无变化" */
    const noPrev = harness.api.monitorDiff(
      { assets: [{ assetId: 'srv-hub', snapshot: {} }] },
      { assets: [{ assetId: 'srv-hub', snapshot: { 'listening-ports': [':22'] } }] },
    ) ?? []
    assert.equal(noPrev[0]?.kind, 'unknown')

    /* 畸形输入不许抛：差异计算挂掉会让整格白屏 */
    assert.deepEqual(harness.api.monitorDiff({ assets: [{}] }, { assets: [{ assetId: 'a', snapshot: { x: 1 } }] })?.length, 1)
  })

  it('声明 ↔ 生效：一致、不一致、节点默认（校验不了）三种说法分开', () => {
    const harness = makeHarness()
    const view = harness.api.monitorView(MONITOR)
    assert.equal(harness.api.monitorPresetVerdict(view, { agentPreset: 'workspace-write' }).kind, 'ok')
    const bad = harness.api.monitorPresetVerdict(view, { agentPreset: 'danger-full-access' })
    assert.equal(bad.kind, 'bad', '声明"不能动手"而实际是 danger-full-access —— 这行是唯一会发现它的地方')
    assert.ok(bad.text.includes('danger-full-access') && bad.text.includes('workspace-write'), '要同时说出声明与实际：' + bad.text)
    assert.equal(harness.api.monitorPresetVerdict(view, {}).kind, 'unknown', '没单独指定 preset 时校验不了，不假装校验过')
  })
})

/* ────────────────────────── 3. 三个面板 + 徽章的真实渲染 ────────────────────────── */

describe('安全监测：面板渲染（如实优先于好看）', () => {
  it('读不到 monitor.json：说"盯谁由你定"，并给一个写模板的入口', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    harness.api.renderPanelMonitorPost(box, { employee: EMPLOYEE, monitorResult: { ok: false, reason: 'missing' }, findingsResult: null })
    const text = allText(box)
    assert.ok(text.includes('盯谁由你定'), '监测范围必须由人写 —— 空态文案是产品的一部分：' + text)
    assert.ok(text.includes('员工不能自己决定监测范围'), '要说清为什么不能是员工自己填：' + text)
    const button = collect(box, (node) => node.tag === 'button').find((node) => node.textContent.includes('模板'))
    assert.ok(button !== undefined, '得有个能开始的地方')
    button?.onclick?.()
    assert.equal(harness.rpcCalls.length, 1)
    assert.equal(harness.rpcCalls[0]?.method, 'employee.files.set')
    assert.equal(harness.rpcCalls[0]?.params['path'], 'monitor.json')
    const written = JSON.parse(String(harness.rpcCalls[0]?.params['content'])) as { assets?: unknown[]; capabilities?: { deny?: string[] } }
    assert.ok(Array.isArray(written.assets) && written.assets.length > 0, '模板要给出 assets 的形状')
    assert.ok((written.capabilities?.deny ?? []).length > 0, '模板要带上一份"不能做"的声明')
  })

  it('没有 employee.manage 权限时不画那个按钮（按了会失败的按钮等于骗人）', () => {
    const harness = makeHarness({ scopes: ['employee.read'] })
    const box = makeEl('div')
    harness.api.renderPanelMonitorPost(box, { employee: EMPLOYEE, monitorResult: { ok: false, reason: 'missing' }, findingsResult: null })
    assert.equal(collect(box, (node) => node.tag === 'button').length, 0)
    assert.ok(allText(box).includes('employee.manage'), '要说清为什么没有这个按钮：' + allText(box))
  })

  it('哨兵台：每台一行带新鲜度、状态与"自证/可核验"', () => {
    const harness = makeHarness()
    const findings = { rounds: [roundFixture(NOW - 4 * 60 * 1000)] }
    const box = makeEl('div')
    harness.api.renderPanelMonitorPost(box, ctxOf(harness, findings))
    const text = allText(box)
    assert.ok(text.includes('办公电脑') && text.includes('生产 Hub'), '两台资产都要在：' + text)
    assert.ok(text.includes('上次巡检'), '新鲜度是这一格的一等公民：' + text)
    assert.ok(text.includes('自证') && text.includes('可核验'), '证据可信度标签必须在：' + text)
    assert.ok(text.includes('不采信员工自报'), '口径要写在页面上：' + text)
  })

  it('节点离线：横幅说"监测中断"，不显示"在岗"', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    harness.api.renderPanelMonitorPost(box, {
      employee: { ...EMPLOYEE, nodeOnline: false },
      monitorResult: { ok: true, value: MONITOR },
      findingsResult: { ok: true, value: { rounds: [roundFixture(NOW - 4 * 60 * 60 * 1000)] } },
    })
    const text = allText(box)
    assert.ok(text.includes('监测中断'), text)
    assert.ok(!text.includes('在岗'), '中断时不许同时说在岗')
    assert.ok(text.includes('没有说话'), '要说清"中断"意味着什么：' + text)
  })

  it('异常台账：陈旧时敢说"无法判断"，并把上一轮的结果标出来', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    harness.api.renderPanelMonitorFindings(box, {
      employee: EMPLOYEE,
      monitorResult: { ok: true, value: MONITOR },
      findingsResult: { ok: true, value: { rounds: [roundFixture(NOW - 4 * 3600 * 1000)] } },
    })
    const text = allText(box)
    assert.ok(text.includes('无法判断'), text)
    assert.ok(text.includes('无数据 != 正常'), '要说清为什么不能读成"没异常"：' + text)
    assert.ok(text.includes('上一轮'), '旧数据要标明是旧的：' + text)
  })

  it('异常台账：数据新鲜时才敢说"本轮无新增异常"', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    harness.api.renderPanelMonitorFindings(box, {
      employee: EMPLOYEE,
      monitorResult: { ok: true, value: MONITOR },
      findingsResult: { ok: true, value: { rounds: [roundFixture(NOW - 4 * 60 * 1000, { findings: [] })] } },
    })
    const text = allText(box)
    assert.ok(text.includes('本轮无新增异常'), text)
    assert.ok(text.includes('有数据才敢这么说'), '空态本身要交代口径：' + text)
  })

  it('**这一页的按钮词表里没有处置动词**（红线的机器版）', () => {
    const harness = makeHarness()
    const forbidden = ['修复', '处置掉', '清理', '隔离', '封禁', '重启', '杀掉', '删除', '改配置', '一键']
    const findings = { rounds: [roundFixture(NOW - 4 * 60 * 1000)] }
    const boxes: FakeEl[] = []
    for (const render of [harness.api.renderPanelMonitorPost, harness.api.renderPanelMonitorFindings, harness.api.renderPanelMonitorWatch, harness.api.renderPanelCapabilityBadge] as const) {
      const box = makeEl('div')
      render(box, ctxOf(harness, findings))
      boxes.push(box)
    }
    const labels = boxes.flatMap((box) => collect(box, (node) => node.tag === 'button').map((node) => node.textContent))
    assert.ok(labels.length > 0, '至少要有按钮，否则这条测试是空的')
    for (const label of labels) {
      for (const word of forbidden) {
        assert.ok(!label.includes(word), `按钮「${label}」里有处置动词「${word}」—— 监测岗没有处置权限，按钮词表就是这条边界的证明`)
      }
    }
    assert.ok(labels.includes('看证据'), '该有的三个入口：' + JSON.stringify(labels))
    assert.ok(labels.includes('生成处置申请'), '处置要变成"申请一段文本给你"，不是它自己动手：' + JSON.stringify(labels))
  })

  it('「看证据」只把话说进输入框，不替你发送（花额度的事必须由人按键）', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    harness.api.renderPanelMonitorFindings(box, ctxOf(harness, { rounds: [roundFixture(NOW - 4 * 60 * 1000)] }))
    const see = collect(box, (node) => node.tag === 'button').find((node) => node.textContent === '看证据')
    see?.onclick?.()
    assert.equal(harness.rpcCalls.filter((call) => call.method === 'session.prompt').length, 0, '点一下就往会话里发指令 = 未经同意花你的额度')
    assert.ok(harness.toasts.length > 0, '没有会话可选时要说清原因：' + JSON.stringify(harness.toasts))
  })

  it('「已阅」写本机、并明确说没写回工作区', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    harness.api.renderPanelMonitorFindings(box, ctxOf(harness, { rounds: [roundFixture(NOW - 4 * 60 * 1000)] }))
    const mark = collect(box, (node) => node.tag === 'button').find((node) => node.textContent === '已阅')
    mark?.onclick?.()
    assert.equal(harness.rpcCalls.length, 0, '控制台不写员工的工作区文件（一份数据两个写者 = 两份真相）')
    assert.ok(allText(box).includes('只存在这台设备上'), '代价要说出来：' + allText(box))

    const again = makeEl('div')
    harness.api.renderPanelMonitorFindings(again, ctxOf(harness, { rounds: [roundFixture(NOW - 4 * 60 * 1000)] }))
    assert.ok(allText(again).includes('取消已阅'), '标记过就要能取消（而且刷新后还在）')
  })

  it('值守记录：轮次带 + 缺口统计 + 与上一轮的差异（没有可比的两轮就如实说）', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    const findings = {
      rounds: [
        roundFixture(NOW - 3600 * 1000, { snapshots: { 'srv-hub': { 'listening-ports': [':22', ':443'] } } }),
        roundFixture(NOW - 4 * 60 * 1000, { snapshots: { 'srv-hub': { 'listening-ports': [':22', ':443', ':8080'] } } }),
      ],
    }
    harness.api.renderPanelMonitorWatch(box, ctxOf(harness, findings))
    const text = allText(box)
    assert.ok(text.includes('缺轮'), '缺口统计必须在：' + text)
    assert.ok(text.includes('缺口由控制台按周期推'), '口径要写出来：' + text)
    assert.ok(text.includes('listening-ports') && text.includes(':8080'), '差异要落到具体的键与值上：' + text)
    assert.ok(text.includes('生产 Hub'), '多台机器同名键时，差异行必须写明是哪一台：' + text)

    const one = makeEl('div')
    harness.api.renderPanelMonitorWatch(one, ctxOf(harness, { rounds: [roundFixture(NOW - 4 * 60 * 1000)] }))
    assert.ok(allText(one).includes('还比不了'), '只有一轮时说"比不了"，不要编一个"无变化"：' + allText(one))
  })

  it('顶部徽章：药丸上只放标签第一段（顶部条放不下长标签），完整标签在弹层与 title 里', () => {
    const harness = makeHarness()
    const good = makeEl('div')
    harness.api.renderPanelCapabilityBadge(good, ctxOf(harness, { rounds: [] }))
    const button = good.children[0]?.children[0]
    assert.equal(button?.textContent, '只读', '药丸上只留第一段 —— 实测整条标签（114px）会把顶部条推出 67px')
    assert.ok(button?.title.includes('只读 · 无处置权限'), '完整标签要在 title 里（鼠标停一下就能看全）：' + button?.title)

    const bad = makeEl('div')
    harness.api.renderPanelCapabilityBadge(bad, {
      employee: { ...EMPLOYEE, agentPreset: 'danger-full-access' },
      monitorResult: { ok: true, value: MONITOR },
      findingsResult: { ok: false, reason: 'missing' },
    })
    const badButton = bad.children[0]?.children[0]
    assert.ok(badButton?.className.includes('bad'), '不一致时徽章本身要变红')
    assert.equal(badButton?.textContent, '声明不符', '不一致时药丸改说"声明不符" —— 那才是它需要被看见的时刻')

    const opened = makeEl('div')
    harness.api.getState()['quad'] = { employeeId: EMPLOYEE.id, badgeOpen: true, monitorResult: null, findingsResult: null, skillsOpen: false }
    harness.api.renderPanelCapabilityBadge(opened, ctxOf(harness, { rounds: [] }))
    const text = allText(opened)
    assert.ok(text.includes('只读 · 无处置权限'), '弹层标题用完整标签：' + text)
    assert.ok(text.includes('不能做') && text.includes('杀进程'), '弹层里是完整的权限边界：' + text)
    assert.ok(text.includes('dsh_ro') && text.includes('restrict,no-pty'), '钥匙要连同授权约束原文一起给：' + text)
    assert.ok(text.includes('审批'), '要解释审批为什么不常驻：' + text)
  })

  it('没有 label 时徽章用中性默认词，控制台不替岗位编产品口径', () => {
    const harness = makeHarness()
    const box = makeEl('div')
    harness.api.renderPanelCapabilityBadge(box, {
      employee: EMPLOYEE,
      monitorResult: { ok: true, value: { assets: [] } },
      findingsResult: null,
    })
    assert.equal(box.children[0]?.children[0]?.textContent, '权限边界')
  })
})

/* ────────────────────────── 4. 样式与标记契约 ────────────────────────── */

describe('安全监测：结构与样式契约', () => {
  it('顶部徽章位默认不显示：非四宫格岗位这一页与从前一样', () => {
    /* 注释先删掉，免得注释里的选择器被当成规则命中 */
    const css = CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(/\.chat-top-cell\s*\{\s*display:\s*none;?\s*\}/.test(css), '顶部徽章位默认必须是关的')
    assert.ok(/#viewChat\.layout-quad > \.chat-top \.chat-top-cell\s*\{[^}]*display:\s*flex/.test(css), '只有四宫格那一页打开它')
  })

  it('页面里有 #quadTop 这个位置（岗位的 cells.top 要有地方落）', () => {
    assert.ok(MARKUP.includes('id="quadTop"'), 'markup.ts 里必须有 #quadTop')
    assert.ok(/class="chat-top-cell"[^>]*id="quadTop"|id="quadTop"[^>]*class="chat-top-cell"/.test(MARKUP), '#quadTop 要带 chat-top-cell 这个类（CSS 靠它开关）')
  })

  it('状态点的四态在样式里各有颜色（少一种就会有人把"陈旧"看成"正常"）', () => {
    const css = CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const state of ['ok', 'bad', 'warn', 'stale', 'off', 'none']) {
      assert.ok(css.includes(`.quad-dot.${state}`), `样式里缺 .quad-dot.${state}`)
    }
    assert.ok(css.includes('.quad-slot.miss'), '缺轮那格要有自己的样子（虚线）')
  })

  it('monitor.json / findings.json 两个路径只在一处定义（面板与装载不能各记一份）', () => {
    assert.ok(SCRIPT.includes("var MONITOR_PATH = 'monitor.json'"))
    assert.ok(SCRIPT.includes("var FINDINGS_PATH = 'findings.json'"))
    assert.equal(SCRIPT.split("'monitor.json'").length - 1, 1, 'monitor.json 字面量只该出现一次')
    assert.equal(SCRIPT.split("'findings.json'").length - 1, 1, 'findings.json 字面量只该出现一次')
  })
})
