/**
 * 岗位面板「技能台账」—— 周键数学、台账校验、三张图的真实渲染。
 *
 * 背景：这一页要回答的是"我这周是在长本事还是在原地重复"，所以三张图全部建立在
 * 一个**由小艾维护的数据文件**上（`memory/ref/技能表.json`）。这条链上任何一环出错
 * 都不会报错，只会静静地给出一个看起来很有道理的结论：
 *
 *   · 周键算错（跨年、跨月、时区）→ 整张热力网格错一格，而且"新技能"判定跟着错；
 *   · 台账写漏一行的占比 → 新鲜度被系统性低估（她以为自己在深耕，其实数据是残的）；
 *   · 她忘记更新 → 图表照样漂漂亮亮显示上上周的数字（本仓库最恨的"沉默的分叉"）。
 *
 * 测法沿用本仓库的既有约定：**从交付脚本里抠出真源码**，配替身跑。
 * 复刻一份逻辑只能证明复刻版对 —— 而被测的恰恰是"周键推演 + 分段口径 + 渲染结果"。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { renderControlUi, renderControlUiScript } from '../src/web/ui.ts'
import { CONSOLE_SOURCE, CSS_SOURCE } from './console-source.ts'

const SCRIPT = renderControlUiScript()
const PAGE = renderControlUi({ hubId: 'hub-test', hubName: '测试 Hub', scriptUrl: '/ui.js' })

/** 抠出整段「9.7 岗位面板」源码：一次拿到常量、纯函数、渲染函数与注册表。 */
function panelSection(): string {
  const start = SCRIPT.indexOf('/* ═══════════ 9.7 岗位面板')
  const end = SCRIPT.indexOf('/* ─────────────────── 10. 审批')
  assert.ok(start >= 0 && end > start, '交付脚本里找不到岗位面板那一段')
  return SCRIPT.slice(start, end)
}

interface FakeEl {
  tag: string
  className: string
  textContent: string
  title: string
  children: FakeEl[]
  attrs: Record<string, string>
  style: Record<string, string>
  appendChild: (child: FakeEl) => void
  setAttribute: (key: string, value: string) => void
}

function makeEl(tag: string): FakeEl {
  const node: FakeEl = {
    tag,
    className: '',
    textContent: '',
    title: '',
    children: [],
    attrs: {},
    style: {},
    appendChild: (child: FakeEl): void => {
      node.children.push(child)
    },
    setAttribute: (key: string, value: string): void => {
      node.attrs[key] = value
    },
  }
  return node
}

/** 把假节点树按 class 找出来（测试断言的就是交付脚本真实建出来的结构）。 */
function findAll(node: FakeEl, className: string): FakeEl[] {
  const out: FakeEl[] = []
  const walk = (current: FakeEl): void => {
    const classes = (current.className + ' ' + (current.attrs['class'] ?? '')).split(/\s+/)
    if (classes.includes(className)) out.push(current)
    for (const child of current.children) walk(child)
  }
  walk(node)
  return out
}

function findOne(node: FakeEl, className: string): FakeEl | undefined {
  return findAll(node, className)[0]
}

function allText(node: FakeEl): string {
  let text = node.textContent
  for (const child of node.children) text += ' ' + allText(child)
  return text
}

interface Section {
  weekKeyOf: (date: Date) => string
  currentWeekKey: () => string
  weekKeyToTime: (key: string) => number | null
  weekKeyShift: (key: string, delta: number) => string
  weeksBetween: (from: string, to: string) => number | null
  recentWeekKeys: (end: string, count: number) => string[]
  shortWeek: (key: string) => string
  parseSkillTable: (text: unknown) => { ok: boolean; reason?: string; table?: Record<string, unknown> }
  skillAnalysis: (table: Record<string, unknown>, windowEnd?: string) => Record<string, any>
  skillRowIsOther: (row: { id?: string; category?: string }) => boolean
  skillCellLevel: (pct: number) => number
  renderPanelSkillGrid: (aside: FakeEl, ctx: unknown) => void
  renderPanelFreshness: (aside: FakeEl, ctx: unknown) => void
  renderPanelFirstSeen: (aside: FakeEl, ctx: unknown) => void
  renderPanelReportArchive: (aside: FakeEl, ctx: unknown) => void
  renderPositionPanels: (aside: FakeEl, employee: unknown, snapshot: unknown) => void
  loadSkillTable: (employeeId: string) => Promise<{ ok: boolean; reason?: string }>
  loadReportArchive: (employeeId: string) => Promise<Array<{ name: string }>>
  PANEL_RENDERERS: Record<string, unknown>
  SKILL_PANEL_IDS: string[]
  SKILL_WINDOW_WEEKS: number
  SKILL_NEW_WEEKS: number
  SKILL_PANEL_SECTION_SOURCE: string
}

/** 造一个受控作用域：`el` / `document` 用假节点，其余依赖按需替身。 */
function makeSection(options: { files?: Record<string, string>; listing?: Record<string, unknown[]> } = {}): {
  api: Section
  rpcCalls: Array<{ method: string; params: Record<string, unknown> }>
  aside: FakeEl
} {
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  const files = options.files ?? {}
  const listing = options.listing ?? {}
  const aside = makeEl('aside')

  const scope = {
    el: (tag: string, className?: string, text?: unknown): FakeEl => {
      const node = makeEl(tag)
      if (className) node.className = className
      if (text !== undefined && text !== null) node.textContent = String(text)
      return node
    },
    document: { createElement: (tag: string): FakeEl => makeEl(tag), createElementNS: (_ns: string, tag: string): FakeEl => makeEl(tag) },
    ASIDE_ROWS_MAX: 8,
    formatBytes: (bytes: number): string => String(bytes) + 'B',
    describeError: (error: unknown): string => String((error as { code?: string })?.code ?? error),
    pickArray: (payload: unknown, keys: string[]): unknown[] => {
      if (payload === null || typeof payload !== 'object') return []
      for (const key of keys) {
        const value = (payload as Record<string, unknown>)[key]
        if (Array.isArray(value)) return value
      }
      return []
    },
    positionList: (): unknown[] => [{ id: 'pos_report', name: '汇报助理', panels: ['skill-grid'] }],
    rpc: (method: string, params: Record<string, unknown>): Promise<unknown> => {
      rpcCalls.push({ method, params })
      if (method === 'employee.files.get') {
        const wanted = String(params['path'] ?? '')
        if (!(wanted in files)) return Promise.reject(Object.assign(new Error('not found'), { code: 'not-found' }))
        return Promise.resolve({ path: wanted, content: files[wanted] })
      }
      if (method === 'employee.files.list') {
        const wanted = String(params['path'] ?? '')
        if (!(wanted in listing)) return Promise.reject(Object.assign(new Error('enoent'), { code: 'not-found' }))
        return Promise.resolve({ entries: listing[wanted] })
      }
      return Promise.resolve({})
    },
    asideBlock: (target: FakeEl, title: string, badgeText?: string, badgeKind?: string): FakeEl => {
      const block = makeEl('div')
      block.className = 'aside-block'
      const head = makeEl('div')
      head.className = 'aside-title'
      head.textContent = title
      if (typeof badgeText === 'string' && badgeText !== '') {
        const badge = makeEl('span')
        badge.className = 'badge ' + (badgeKind ?? '')
        badge.textContent = badgeText
        head.appendChild(badge)
      }
      block.appendChild(head)
      target.appendChild(block)
      return block
    },
    asideRow: (box: FakeEl, key: string, value: string): FakeEl => {
      const row = makeEl('div')
      row.className = 'aside-row'
      const keyNode = makeEl('span')
      keyNode.className = 'k'
      keyNode.textContent = key
      const valueNode = makeEl('span')
      valueNode.className = 'v'
      valueNode.textContent = value
      row.appendChild(keyNode)
      row.appendChild(valueNode)
      box.appendChild(row)
      return row
    },
  }

  const source = panelSection()
  const names = Object.keys(scope)
  const factory = new Function(
    ...names,
    source +
      '\nreturn { weekKeyOf: weekKeyOf, currentWeekKey: currentWeekKey, weekKeyToTime: weekKeyToTime, weekKeyShift: weekKeyShift, ' +
      'weeksBetween: weeksBetween, recentWeekKeys: recentWeekKeys, shortWeek: shortWeek, parseSkillTable: parseSkillTable, ' +
      'skillAnalysis: skillAnalysis, skillRowIsOther: skillRowIsOther, skillCellLevel: skillCellLevel, ' +
      'renderPanelSkillGrid: renderPanelSkillGrid, renderPanelFreshness: renderPanelFreshness, renderPanelFirstSeen: renderPanelFirstSeen, ' +
      'renderPanelReportArchive: renderPanelReportArchive, renderPositionPanels: renderPositionPanels, loadSkillTable: loadSkillTable, ' +
      'loadReportArchive: loadReportArchive, PANEL_RENDERERS: PANEL_RENDERERS, SKILL_PANEL_IDS: SKILL_PANEL_IDS, ' +
      'SKILL_WINDOW_WEEKS: SKILL_WINDOW_WEEKS, SKILL_NEW_WEEKS: SKILL_NEW_WEEKS }',
  ) as (...args: unknown[]) => Section

  const api = factory(...Object.values(scope))
  return { api, rpcCalls, aside }
}

/* ── 一份真实形状的台账：每周占比合计正好 100，含一个杂事档 ──
 *
 * 设计成"W35 接触新东西 → 冲到 W38 峰值 38% → W39 回落到 12%"，因为这就是这块面板
 * 存在的意义：一眼看出"最近在长本事还是回到老本行"。 */
const WEEKS = ['2026-W32', '2026-W33', '2026-W34', '2026-W35', '2026-W36', '2026-W37', '2026-W38', '2026-W39']

const TABLE_JSON = JSON.stringify({
  version: 1,
  updatedWeek: '2026-W39',
  skills: {
    'api-mgmt': {
      name: 'API 管控',
      aliases: ['API管控'],
      category: '领域',
      firstWeek: '2026-W32',
      weeks: { '2026-W32': 60, '2026-W33': 55, '2026-W34': 50, '2026-W35': 45, '2026-W36': 40, '2026-W37': 35, '2026-W38': 30, '2026-W39': 25 },
    },
    webhook: { name: 'Webhook 对接', category: '工具', firstWeek: '2026-W35', weeks: { '2026-W35': 20, '2026-W36': 25, '2026-W37': 30, '2026-W38': 20, '2026-W39': 15 } },
    'uptime-kuma': { name: 'Uptime Kuma', aliases: ['服务监控'], category: '平台', firstWeek: '2026-W38', weeks: { '2026-W38': 18, '2026-W39': 12 } },
    other: { name: '其他（无技能）', category: '其他', firstWeek: '2026-W32', weeks: { '2026-W32': 40, '2026-W33': 45, '2026-W34': 50, '2026-W35': 35, '2026-W36': 35, '2026-W37': 35, '2026-W38': 32, '2026-W39': 48 } },
  },
})

function parsedTable(): Record<string, unknown> {
  const { api } = makeSection()
  const parsed = api.parseSkillTable(TABLE_JSON)
  assert.equal(parsed.ok, true, '夹具台账应当是合法的')
  assert.deepEqual((parsed.table as { sumIssues: string[] }).sumIssues, [], '夹具每周合计应当正好 100')
  return parsed.table as Record<string, unknown>
}

describe('周键：必须能连续推演（跨年、跨月都不能错）', () => {
  const { api } = makeSection()

  it('ISO 周归属：周四定周（2026-01-01 是周四 ⇒ 2026-W01）', () => {
    assert.equal(api.weekKeyOf(new Date(Date.UTC(2026, 0, 1))), '2026-W01')
    assert.equal(api.weekKeyOf(new Date(Date.UTC(2025, 11, 29))), '2026-W01', '2025-12-29 是 W01 的周一')
    assert.equal(api.weekKeyOf(new Date(Date.UTC(2025, 11, 28))), '2025-W52', '2025-12-28 是周日，属于上一周')
    assert.equal(api.weekKeyOf(new Date(Date.UTC(2026, 11, 31))), '2026-W53', '2026 有 53 个 ISO 周')
    assert.equal(api.weekKeyOf(new Date(Date.UTC(2026, 2, 2))), '2026-W10')
  })

  it('跨年推演：W01 往前一周是上一年的最后一周，不是 W00', () => {
    assert.equal(api.weekKeyShift('2026-W01', -1), '2025-W52')
    assert.equal(api.weekKeyShift('2025-W52', 1), '2026-W01')
    assert.equal(api.weekKeyShift('2026-W53', 1), '2027-W01', 'W53 之后是下一年的 W01')
    assert.equal(api.weekKeyShift('2027-W01', -1), '2026-W53')
  })

  it('周键与时间戳互为逆运算（周一 00:00 UTC）', () => {
    for (const key of WEEKS) {
      const time = api.weekKeyToTime(key)
      assert.ok(time !== null, key + ' 应当能解析')
      assert.equal(api.weekKeyOf(new Date(time as number)), key)
      assert.equal(new Date(time as number).getUTCDay(), 1, key + ' 应当是周一')
    }
  })

  it('最近 N 周：含末尾那一周、旧的在前、连续', () => {
    const keys = api.recentWeekKeys('2026-W39', 8)
    assert.deepEqual(keys, WEEKS)
    assert.deepEqual(api.recentWeekKeys('2026-W02', 3), ['2025-W52', '2026-W01', '2026-W02'])
  })

  it('周差可正可负；非法周键返回 null（不许悄悄当成 0）', () => {
    assert.equal(api.weeksBetween('2026-W38', '2026-W39'), 1, '第二个参数更晚 → 正')
    assert.equal(api.weeksBetween('2025-W52', '2026-W39'), 39)
    assert.equal(api.weeksBetween('2026-W01', '2026-W52'), 51)
    assert.equal(api.weeksBetween('2026-W39', '2026-W38'), -1, '倒过来就是负的（不许取绝对值蒙混）')
    assert.equal(api.weeksBetween('nonsense', '2026-W01'), null)
    assert.equal(api.weekKeyToTime('2026-W54'), null, 'W54 不存在')
  })

  it('展示用短周键', () => {
    assert.equal(api.shortWeek('2026-W39'), 'W39')
    assert.equal(api.shortWeek('乱码'), '乱码')
  })
})

describe('台账校验：读不出来就说读不出来，不猜', () => {
  const { api } = makeSection()

  it('合法台账能解析出全部行', () => {
    const table = parsedTable() as { rows: Array<{ id: string }>; issues: string[] }
    assert.equal(table.rows.length, 4)
    assert.deepEqual(table.issues, [])
  })

  it('各种坏输入各有各的原因码（界面据此给不同文案）', () => {
    assert.equal(api.parseSkillTable('').reason, 'empty')
    assert.equal(api.parseSkillTable('   ').reason, 'empty')
    assert.equal(api.parseSkillTable('{oops').reason, 'bad-json')
    assert.equal(api.parseSkillTable('[1,2]').reason, 'bad-shape')
    assert.equal(api.parseSkillTable('{"skills":{}}').reason, 'bad-week', '缺 updatedWeek')
    assert.equal(api.parseSkillTable('{"updatedWeek":"2026-39","skills":{}}').reason, 'bad-week')
    assert.equal(api.parseSkillTable('{"updatedWeek":"2026-W39","skills":[]}').reason, 'bad-skills')
  })

  it('占比合计不是 100 时如实报出来，但仍然照画（不静默、也不假装没法画）', () => {
    const text = JSON.stringify({
      updatedWeek: '2026-W39',
      skills: { a: { name: 'A', firstWeek: '2026-W32', weeks: { '2026-W39': 40 } } },
    })
    const parsed = api.parseSkillTable(text)
    assert.equal(parsed.ok, true)
    assert.deepEqual((parsed.table as { sumIssues: string[] }).sumIssues, ['W39 合计 40%'])
  })

  it('firstWeek 晚于 updatedWeek（台账自相矛盾）如实记一条：面板不许照单渲染', () => {
    /* 实测踩到：夹具把 weeks 裁到 W36 却没动 firstWeek(W38)，于是同一块面板上
       一边写"数据截至 W36（落后 3 周）"、一边写"最近一次接触新技能：W38"。 */
    const text = JSON.stringify({
      updatedWeek: '2026-W36',
      skills: { a: { name: 'A', firstWeek: '2026-W38', weeks: { '2026-W36': 100 } } },
    })
    const table = api.parseSkillTable(text).table as { issues: string[] }
    assert.equal(table.issues.length, 1)
    assert.ok(String(table.issues[0]).includes('晚于 updatedWeek'), table.issues[0])
    assert.ok(String(table.issues[0]).includes('2026-W38'), table.issues[0])
  })

  it('firstWeek 正常（早于或等于 updatedWeek）不报', () => {
    const same = api.parseSkillTable(
      JSON.stringify({ updatedWeek: '2026-W39', skills: { a: { name: 'A', firstWeek: '2026-W39', weeks: { '2026-W39': 100 } } } }),
    ).table as { issues: string[] }
    assert.deepEqual(same.issues, [])
  })

  it('容差 ±1.5 个百分点：99 与 101 放行，97 报出来', () => {
    const withSum = (value: number): string =>
      JSON.stringify({ updatedWeek: '2026-W39', skills: { a: { name: 'A', weeks: { '2026-W39': value } } } })
    assert.deepEqual((api.parseSkillTable(withSum(99)).table as { sumIssues: string[] }).sumIssues, [])
    assert.deepEqual((api.parseSkillTable(withSum(101)).table as { sumIssues: string[] }).sumIssues, [])
    assert.deepEqual((api.parseSkillTable(withSum(97)).table as { sumIssues: string[] }).sumIssues, ['W39 合计 97%'])
  })

  it('单行里的脏数据（非法周键 / 超范围占比 / weeks 不是对象）逐条记下来，不影响其他行', () => {
    const text = JSON.stringify({
      updatedWeek: '2026-W39',
      skills: {
        good: { name: '好的', firstWeek: '2026-W38', weeks: { '2026-W39': 100 } },
        badKey: { name: '坏键', weeks: { 'W39': 10 } },
        badPct: { name: '坏占比', weeks: { '2026-W39': 120 } },
        badWeeks: { name: '坏结构', weeks: [1, 2] },
        badFirst: { name: '坏首现', firstWeek: '上周', weeks: {} },
        badEntry: 'not-an-object',
      },
    })
    const parsed = api.parseSkillTable(text)
    const table = parsed.table as { rows: unknown[]; issues: string[] }
    assert.equal(table.rows.length, 5, '除了裸字符串那一条，其余都该保留')
    assert.equal(table.issues.length, 5)
    assert.ok(table.issues.some((issue) => issue.includes('周键')), '非法周键要记下来')
    assert.ok(table.issues.some((issue) => issue.includes('不在 0–100')), '超范围占比要记下来')
    assert.ok(table.issues.some((issue) => issue.includes('weeks 不是对象')))
  })
})

describe('新鲜度口径：新 / 深耕 / 其余 三段', () => {
  const { api } = makeSection()
  const analysis = api.skillAnalysis(parsedTable(), '2026-W39')

  it('窗口是 8 周且顺序正确', () => {
    assert.deepEqual(analysis.weeks, WEEKS)
    assert.equal(analysis.coveredWeeks, 8)
  })

  it('三段互不重叠、加起来正好 100（W39：新 12 / 深耕 40 / 其余 48）', () => {
    const w39 = analysis.freshness[7]
    assert.equal(w39.newPct, 12, 'W38 首现的 Uptime Kuma 是"新"')
    assert.equal(w39.deepPct, 40, 'API 管控 25 + Webhook 15 = 深耕')
    assert.equal(w39.restPct, 48, '杂事档 48 落在"其余"')
    for (const entry of analysis.freshness) {
      assert.equal(Math.round(entry.newPct + entry.deepPct + entry.restPct), 100, entry.key + ' 三段应当加满 100')
    }
  })

  it('"新"的口径是首现 ≤4 周：3 周前算新（W38 的 Webhook），4 周前不算（W39 的 Webhook）', () => {
    assert.equal(analysis.freshness[6].newPct, 38, 'W38：Uptime Kuma 18 + Webhook 20')
    assert.equal(analysis.freshness[7].newPct, 12, 'W39：Webhook 已满 4 周，只剩 Uptime Kuma')
    const webhook = analysis.rows.find((row: { id: string }) => row.id === 'webhook')
    assert.equal(webhook.isNew, false, '首现正好 4 周前不算"新"')
    const kuma = analysis.rows.find((row: { id: string }) => row.id === 'uptime-kuma')
    assert.equal(kuma.isNew, true)
  })

  it('"深耕"要求连续 ≥3 周，中间断一周就不算', () => {
    const { api: fresh } = makeSection()
    const table = fresh.parseSkillTable(
      JSON.stringify({
        updatedWeek: '2026-W39',
        skills: { a: { name: '断续的', firstWeek: '2026-W32', weeks: { '2026-W37': 30, '2026-W39': 70 } } },
      }),
    ).table as Record<string, unknown>
    const result = fresh.skillAnalysis(table, '2026-W39')
    assert.equal(result.freshness[7].deepPct, 0, 'W37/W38/W39 不连续，不该算深耕')
    assert.equal(result.freshness[7].restPct, 100)
  })

  it('杂事档永远是"其余"，不会被算成深耕（否则"没技能含量的一天"会被美化成成长）', () => {
    const other = analysis.rows.find((row: { id: string }) => row.id === 'other')
    assert.equal(api.skillRowIsOther(other), true)
    assert.equal(analysis.freshness[7].deepPct, 40, '深耕里不该含杂事档的 48')
    assert.equal(other.total, 320, '但它照样计入占比分母（8 周合计）')
  })

  it('杂事档不算"新技能"：不进时间轴、不参与"最近一次接触新技能"、不给绿框', () => {
    /* 实测踩到的那个：夹具里 other 的 firstWeek 落在窗口第一周，于是时间轴上多了一个
       "新技能"、热力网格里多了一个绿框 —— "我多久没碰新东西"就会被杂事满足掉。 */
    const other = analysis.rows.find((row: { id: string }) => row.id === 'other')
    assert.equal(other.isOther, true)
    assert.equal(other.isNew, false)
    const w32 = analysis.firstSeen[0]
    assert.deepEqual(w32.names, ['API 管控'], '杂事档不该出现在"新技能"里')
    assert.equal(analysis.lastNewWeek, '2026-W38')
  })

  it('"最近一次接触新技能"不受杂事档影响：本周才建的 other 条目不算"接触新东西"', () => {
    /* 独立覆盖 lastNewWeek 那条过滤：如果 other 是本周第一次出现，而所有真技能都很老，
       正确答案是"没有新技能"，不是"本周接触了新东西"。 */
    const text = JSON.stringify({
      updatedWeek: '2026-W39',
      skills: {
        old: { name: '老本行', firstWeek: '2026-W05', weeks: { '2026-W38': 60, '2026-W39': 40 } },
        other: { name: '其他（无技能）', category: '其他', firstWeek: '2026-W39', weeks: { '2026-W38': 40, '2026-W39': 60 } },
      },
    })
    const { api: fresh } = makeSection()
    const result = fresh.skillAnalysis(fresh.parseSkillTable(text).table as Record<string, unknown>, '2026-W39')
    assert.equal(result.lastNewWeek, '2026-W05', 'only 的 firstWeek 不该被 other 顶掉')
    assert.deepEqual(result.firstSeen[7].names, [], 'W39 不该有"新技能"')
    const { aside } = makeSection()
    fresh.renderPanelFirstSeen(aside, {
      snapshot: { skillTable: fresh.parseSkillTable(text), skillTableError: '', reports: null, reportsError: '', panels: [] },
      analysis: result,
      employee: null,
    })
    assert.equal(findAll(aside, 'has').length, 0, '时间轴上不该有本周的点')
  })

  it('排序：占比降序、杂事档钉在最后', () => {
    assert.deepEqual(
      analysis.rows.map((row: { id: string }) => row.id),
      ['api-mgmt', 'webhook', 'uptime-kuma', 'other'],
    )
  })

  it('首现时间轴：每周各自列出首现的技能；最近一次新技能 = W38', () => {
    assert.deepEqual(analysis.firstSeen[0], { key: '2026-W32', names: ['API 管控'] })
    assert.deepEqual(analysis.firstSeen[3], { key: '2026-W35', names: ['Webhook 对接'] })
    assert.deepEqual(analysis.firstSeen[6], { key: '2026-W38', names: ['Uptime Kuma'] })
    assert.equal(analysis.lastNewWeek, '2026-W38')
  })

  it('没有覆盖到的那一周是空格子（不是 0）—— "没记"和"记了 0"必须分得开', () => {
    const kuma = analysis.rows.find((row: { id: string }) => row.id === 'uptime-kuma')
    assert.equal(kuma.cells[0].pct, null)
    assert.equal(kuma.cells[6].pct, 18)
  })

  it('陈旧判定用"今天"这一周：台账停在 2 周前就报落后 2 周', () => {
    const { api: fresh } = makeSection()
    const current = fresh.currentWeekKey()
    const updated = fresh.weekKeyShift(current, -2)
    const table = fresh.parseSkillTable(
      JSON.stringify({ updatedWeek: updated, skills: { a: { name: 'A', firstWeek: updated, weeks: { [updated]: 100 } } } }),
    ).table as Record<string, unknown>
    assert.equal(fresh.skillAnalysis(table, current).staleWeeks, 2)
    const inTime = fresh.parseSkillTable(
      JSON.stringify({ updatedWeek: current, skills: { a: { name: 'A', firstWeek: current, weeks: { [current]: 100 } } } }),
    ).table as Record<string, unknown>
    assert.equal(fresh.skillAnalysis(inTime, current).staleWeeks, 0)
  })
})

describe('三张图真的画出来了什么（跑交付脚本里的真渲染函数）', () => {
  function ctxFor(table?: string): { api: Section; aside: FakeEl; ctx: Record<string, unknown> } {
    const { api, aside } = makeSection()
    const parsed = table === undefined ? api.parseSkillTable(TABLE_JSON) : api.parseSkillTable(table)
    const snapshot = {
      panels: ['skill-grid', 'skill-freshness', 'skill-firstseen', 'report-archive'],
      skillTable: parsed,
      skillTableError: '',
      reports: null,
      reportsError: '',
    }
    const analysis = parsed.ok === true ? api.skillAnalysis(parsed.table as Record<string, unknown>, '2026-W39') : null
    return { api, aside, ctx: { snapshot, analysis, employee: { id: 'emp_x', name: '小艾' } } }
  }

  it('① 热力网格：9 列表头 + 每行 1 名字 8 格；空周是空格子、首现那一格带 first', () => {
    const { api, aside, ctx } = ctxFor()
    api.renderPanelSkillGrid(aside, ctx)
    const grid = findOne(aside, 'skill-grid')
    assert.ok(grid !== undefined, '没有画出 .skill-grid')
    const heads = findAll(grid as FakeEl, 'head')
    assert.equal(heads.length, 9, '1 个名字列表头 + 8 个周表头')
    assert.equal(heads[1]?.textContent, 'W32')
    assert.equal(heads[8]?.textContent, 'W39')
    const cells = findAll(grid as FakeEl, 'cell')
    assert.equal(cells.length, 4 * 8, '4 个技能 × 8 周')
    assert.equal(findAll(grid as FakeEl, 'empty').length, 3 + 6, '台账没覆盖的周画成空格子（Webhook 缺 3 周 + Kuma 缺 6 周）')
    const first = findAll(grid as FakeEl, 'first')
    assert.deepEqual(first.map((node) => node.title.split(' · ')[1]), ['2026-W32', '2026-W35', '2026-W38'])
  })

  it('① 绿框只给真技能的首次出现，杂事档不给（它不是"接触了新东西"）', () => {
    const { api, aside, ctx } = ctxFor()
    api.renderPanelSkillGrid(aside, ctx)
    const rings = findAll(aside, 'first').map((node) => String(node.title).split(' · ')[0])
    assert.deepEqual(rings, ['API 管控', 'Webhook 对接', 'Uptime Kuma'], '杂事档混进绿框了：' + rings.join('、'))
  })

  it('① 行首「新」标记只给首现 ≤4 周的技能', () => {
    const { api, aside, ctx } = ctxFor()
    api.renderPanelSkillGrid(aside, ctx)
    const marks = findAll(findOne(aside, 'skill-grid') as FakeEl, 'skill-new')
    assert.equal(marks.length, 1, '夹具里只有 Uptime Kuma 算"新"')
    assert.equal(marks[0]?.textContent, '新')
  })

  it('① 色阶随占比变深，且四档都出现过', () => {
    const { api } = makeSection()
    assert.deepEqual([1, 5, 6, 15, 16, 30, 31, 100].map((pct) => api.skillCellLevel(pct)), [1, 1, 2, 2, 3, 3, 4, 4])
    const { aside, ctx } = ctxFor()
    api.renderPanelSkillGrid(aside, ctx)
    /* 夹具里的占比是 12–60：最低 12 落在 l2，所以 l1 不该出现（这一条是"照数据算"，
       不是"凑齐四档"）。四档各自的分界由上面那行断言钉着。 */
    for (const level of ['l2', 'l3', 'l4']) {
      assert.ok(findAll(aside, level).length > 0, level + ' 档没有出现')
    }
    assert.equal(findAll(aside, 'l1').length, 0, '夹具里没有 ≤5% 的格子，l1 就不该出现')
  })

  it('三块共用一条数据状态：整栏只说一次，不重复三遍（实测三遍像界面坏了）', () => {
    const { api, aside, ctx } = ctxFor()
    api.renderPositionPanels(aside, { id: 'emp_x', position: 'pos_report' }, (ctx as { snapshot: unknown }).snapshot)
    const notes = [...findAll(aside, 'aside-bad'), ...findAll(aside, 'aside-note')].map((node) => node.textContent)
    const stale = notes.filter((text) => text.includes('数据截至'))
    assert.equal(stale.length, 1, '状态行应当只出现一次，实际：' + stale.join(' / '))
    assert.ok(String(stale[0]).includes('2026-W39'), stale[0])
  })

  it('① 台账读不到时如实说明，并指向"让小艾回填"，而不是画一张空图', () => {
    const { api, aside } = makeSection()
    api.renderPanelSkillGrid(aside, {
      snapshot: { panels: ['skill-grid'], skillTable: { ok: false, reason: 'missing' }, skillTableError: '', reports: null, reportsError: '' },
      analysis: null,
      employee: null,
    })
    const text = allText(aside)
    assert.ok(text.includes('还没有技能台账'), text)
    assert.ok(text.includes('skill-ledger'), '要告诉她按哪个技能回填')
    assert.equal(findOne(aside, 'skill-grid'), undefined, '不该画出空网格')
  })

  it('② 新鲜度：三段宽度加起来 100%，折线 8 个点，并标出刻度与覆盖周数', () => {
    const { api, aside, ctx } = ctxFor()
    api.renderPanelFreshness(aside, ctx)
    const segments = findAll(aside, 'fresh-seg')
    assert.equal(segments.length, 3)
    const widths = segments.map((node) => Number.parseFloat(String(node.style['width'] ?? '')))
    assert.deepEqual(widths, [12, 40, 48])
    assert.equal(Math.round(widths.reduce((sum, value) => sum + value, 0)), 100)
    const line = findOne(aside, 'fresh-line') as FakeEl
    assert.ok(line !== undefined)
    const svgChildren = line.children
    const polyline = svgChildren.find((node) => node.tag === 'polyline')
    assert.ok(polyline !== undefined, '没有画出折线')
    assert.equal(String(polyline.attrs['points']).split(' ').length, 8, '折线应当有 8 个点')
    assert.equal(svgChildren.filter((node) => node.tag === 'circle').length, 8, '每个点一个圆')
    /* 纵轴跟着窗口内的最大值走（夹具里峰值是 W35 的 65% → 取整到 70%），
       固定 0–100 的话 12% 和 20% 会挤在底部一条线里，读不出变化。 */
    assert.ok(allText(aside).includes('刻度 0–70%'), '纵轴刻度要写出来（不写就没法读折线）: ' + allText(aside).slice(0, 200))
    assert.ok(allText(aside).includes('8/8 周有数据'))
  })

  it('② 台账停在很久以前（窗口里没有它）时，不硬算三段，而是说明这一周没数据', () => {
    const stale = JSON.stringify({
      updatedWeek: '2026-W10',
      skills: { a: { name: '老早的技能', firstWeek: '2026-W08', weeks: { '2026-W10': 100 } } },
    })
    const { api, aside, ctx } = ctxFor(stale)
    api.renderPanelFreshness(aside, ctx)
    assert.ok(allText(aside).includes('台账没有覆盖这一周'), allText(aside))
    assert.ok(allText(aside).includes('落后'), '同时要说明落后了几周')
  })

  it('③ 新技能时间轴：8 个格子、3 个有点、列出最近 3 次首现、"最近一次"带周差', () => {
    const { api, aside, ctx } = ctxFor()
    api.renderPanelFirstSeen(aside, ctx)
    const track = findOne(aside, 'firstseen-track') as FakeEl
    assert.equal(track.children.length, 8)
    assert.equal(findAll(track, 'has').length, 3, 'W32 / W35 / W38 三周各有新技能')
    assert.ok(allText(aside).includes('最近一次接触新技能：W38'))
    const rows = findAll(aside, 'aside-row')
    assert.deepEqual(rows.map((row) => allText(row).trim().split(/\s+/)[0]), ['W38', 'W35', 'W32'], '最近的排在最前')
  })

  it('③ 最近 8 周没有新技能时说清是"深耕"还是"重复"', () => {
    const text = JSON.stringify({
      updatedWeek: '2026-W39',
      skills: { a: { name: '老本行', firstWeek: '2026-W10', weeks: { '2026-W39': 100 } } },
    })
    const { api, aside, ctx } = ctxFor(text)
    api.renderPanelFirstSeen(aside, ctx)
    assert.ok(allText(aside).includes('最近 8 周没有新技能'), allText(aside))
    assert.equal(findAll(aside, 'has').length, 0)
  })

  it('④ 周报归档：列出文件与大小；空目录与读取失败各有各的说法', () => {
    const { api, aside } = makeSection()
    api.renderPanelReportArchive(aside, { snapshot: { reports: [{ path: '周报/周报_a.md', name: '周报_a.md', size: 2048 }], reportsError: '' } })
    assert.ok(allText(aside).includes('周报_a.md'))
    assert.ok(allText(aside).includes('2048B'))

    const empty = makeEl('aside')
    api.renderPanelReportArchive(empty, { snapshot: { reports: [], reportsError: '' } })
    assert.ok(allText(empty).includes('还没有归档的周报'), allText(empty))

    const failed = makeEl('aside')
    api.renderPanelReportArchive(failed, { snapshot: { reports: null, reportsError: 'node-offline' } })
    assert.ok(allText(failed).includes('拉取失败：node-offline'), allText(failed))
  })
})

describe('面板由岗位决定（注册表 + 未知 id 不许静默跳过）', () => {
  it('面板 id 都在注册表里（技能图 + 四宫格格位面板 + 安全监测），且三个技能图共用同一份台账数据', () => {
    const { api } = makeSection()
    /* 加一条面板 = 这里加一个 id。清单短、可枚举，是"漏一种类型 = 静默不渲染"的兜底。 */
    assert.deepEqual(Object.keys(api.PANEL_RENDERERS).sort(), [
      'capability-badge',
      'incident-post',
      'incident-steps',
      'incident-timeline',
      'monitor-findings',
      'monitor-post',
      'monitor-watch',
      'pentest-plan',
      'pentest-target',
      'report-archive',
      'skill-firstseen',
      'skill-freshness',
      'skill-grid',
    ])
    assert.deepEqual(api.SKILL_PANEL_IDS.slice().sort(), ['skill-firstseen', 'skill-freshness', 'skill-grid'])
    for (const id of api.SKILL_PANEL_IDS) {
      assert.ok(Object.keys(api.PANEL_RENDERERS).includes(id), id + ' 在清单里但注册表没有')
    }
  })

  it('按声明顺序渲染；岗位没配面板就整段不出现', () => {
    const { api, aside } = makeSection()
    const snapshot = {
      panels: ['skill-grid', 'report-archive'],
      skillTable: api.parseSkillTable(TABLE_JSON),
      skillTableError: '',
      reports: [],
      reportsError: '',
    }
    api.renderPositionPanels(aside, { id: 'emp_x', position: 'pos_report' }, snapshot)
    const titles = findAll(aside, 'aside-title').map((node) => node.textContent)
    assert.deepEqual(titles, ['技能 × 周', '周报归档'])
    assert.equal(findOne(aside, 'fresh-bar'), undefined, '没声明的新鲜度图不该出现')

    const none = makeEl('aside')
    api.renderPositionPanels(none, { id: 'emp_x', position: 'pos_report' }, { ...snapshot, panels: [] })
    assert.equal(none.children.length, 0, '没有面板就不该加块')
  })

  it('岗位配了控制台不认识的 id：如实说出来，不静默跳过', () => {
    const { api, aside } = makeSection()
    api.renderPositionPanels(aside, { id: 'emp_x' }, {
      panels: ['skill-grid', 'some-future-panel'],
      skillTable: api.parseSkillTable(TABLE_JSON),
      skillTableError: '',
      reports: null,
      reportsError: '',
    })
    const text = allText(aside)
    assert.ok(text.includes('some-future-panel'), '要把不认识的 id 打出来（否则没人查得出来）')
    assert.ok(text.includes('控制台不认识'), text.slice(0, 120))
  })
})

describe('数据装载：只拉需要的那份，读不到与"没有"分得开', () => {
  it('台账文件不存在 → reason=missing（不是"读到了空台账"）', async () => {
    const { api, rpcCalls } = makeSection()
    const result = await api.loadSkillTable('emp_x')
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'missing')
    assert.equal(rpcCalls[0]?.method, 'employee.files.get')
    assert.equal(rpcCalls[0]?.params['path'], 'memory/ref/技能表.json')
  })

  it('台账存在 → 走同一套校验', async () => {
    const { api } = makeSection({ files: { 'memory/ref/技能表.json': TABLE_JSON } })
    const result = await api.loadSkillTable('emp_x')
    assert.equal(result.ok, true)
  })

  it('归档：优先 周报/ 目录；目录不存在时回落到工作区根目录按名字挑', async () => {
    const withDir = makeSection({
      listing: {
        周报: [
          { path: '周报/周报_2026-09-16_至_09-23.md', type: 'file', size: 2894 },
          { path: '周报/README.md', type: 'file', size: 10 },
        ],
      },
    })
    const fromDir = await withDir.api.loadReportArchive('emp_x')
    assert.deepEqual(fromDir.map((entry) => entry.name), ['周报_2026-09-16_至_09-23.md'], '目录里的非周报文件要被过滤掉')

    const rootOnly = makeSection({
      listing: {
        '.': [
          { path: '周报_2026-09-16_至_09-23.md', type: 'file', size: 2894 },
          { path: 'AGENTS.md', type: 'file', size: 534 },
          { path: 'tools', type: 'dir' },
          { path: '.git', type: 'dir' },
        ],
      },
    })
    const fromRoot = await rootOnly.api.loadReportArchive('emp_x')
    assert.deepEqual(fromRoot.map((entry) => entry.name), ['周报_2026-09-16_至_09-23.md'], '根目录里只挑周报/日报')
    assert.equal(rootOnly.rpcCalls.filter((call) => call.params['path'] === '.').length, 1)
  })

  it('两处都读不到 → 直接抛错（由调用方记成 reportsError，不是"还没有归档"）', async () => {
    const { api } = makeSection()
    await assert.rejects(() => api.loadReportArchive('emp_x'))
  })
})

describe('CSS 契约：宽度预算与列数', () => {
  const css = CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')
  const flat = css.replace(/\s+/g, ' ')

  function body(selector: string): string {
    const at = flat.indexOf(selector + ' {')
    assert.ok(at >= 0, '找不到规则 ' + selector)
    return flat.slice(at + selector.length + 2, flat.indexOf('}', at))
  }

  it('热力网格是 9 列：1 列名字 + 8 周（与脚本里的 SKILL_WINDOW_WEEKS 一致）', () => {
    const rule = body('.skill-grid')
    assert.ok(rule.includes('repeat(8, minmax(0, 1fr))'), '周列数必须与窗口周数一致')
    const { api } = makeSection()
    assert.equal(api.SKILL_WINDOW_WEEKS, 8, '脚本窗口变了就要连着改 CSS（这里就是那道闸）')
  })

  it('名字列封顶、周列均分（右栏只有 216–316px，名字不许把格子挤没）', () => {
    const rule = body('.skill-grid')
    assert.ok(/grid-template-columns: minmax\(0, [\d.]+fr\)/.test(rule), '名字列要能收缩')
  })

  it('首现高亮走"框线"这条通道，和深浅（背景色）分开', () => {
    assert.ok(body('.skill-cell.cell.first').includes('box-shadow: inset'), '首现那一格用内阴影做框')
    for (const level of ['l1', 'l2', 'l3', 'l4']) {
      assert.ok(body('.skill-cell.cell.' + level).includes('background:'), level + ' 档没有背景色')
    }
  })

  it('三段条与时间轴的结构类都在（缺一个就是静默不渲染）', () => {
    for (const selector of ['.fresh-bar', '.fresh-seg.seg-new', '.fresh-seg.seg-deep', '.fresh-seg.seg-rest', '.firstseen-track', '.firstseen-dot']) {
      assert.ok(flat.includes(selector + ' {'), '缺样式 ' + selector)
    }
    assert.ok(body('.firstseen-track').includes('repeat(8'), '时间轴列数也要与窗口周数一致')
  })

  it('岗位面板只在右栏出现（手机不做）：没有把 .skill-grid 之类放进任何窄屏媒体查询', () => {
    const mediaBlocks = [...flat.matchAll(/@media[^{]+\{/g)].map((match) => match[0])
    assert.ok(mediaBlocks.length > 0)
    for (const block of mediaBlocks) {
      if (!block.includes('max-width: 640px') && !block.includes('max-width: 900px')) continue
      const start = flat.indexOf(block)
      const nextRule = flat.indexOf('#viewChat', start)
      const slice = flat.slice(start, nextRule < 0 ? flat.length : nextRule)
      assert.ok(!slice.includes('.skill-grid'), '窄屏媒体查询里不该出现岗位面板的样式')
    }
  })
})

describe('接点：整栏重绘与数据装载都接上了', () => {
  it('renderEmployeeAside 调用了 renderPositionPanels', () => {
    const start = CONSOLE_SOURCE.indexOf('function renderEmployeeAside()')
    const end = CONSOLE_SOURCE.indexOf('/* ═══════════ 9.7 岗位面板', start)
    assert.ok(start >= 0 && end > start)
    assert.ok(CONSOLE_SOURCE.slice(start, end).includes('renderPositionPanels(aside, employee'), '右栏没有渲染岗位面板')
  })

  it('loadEmployeeAside：先等岗位目录，再按顺序拉需要的数据', () => {
    const start = CONSOLE_SOURCE.indexOf('function loadEmployeeAside()')
    const end = CONSOLE_SOURCE.indexOf('function renderEmployeeAside()', start)
    const bodyText = CONSOLE_SOURCE.slice(start, end)
    assert.ok(bodyText.includes('positionPanelsOf(employee)'), '没有读岗位声明的面板')
    assert.ok(bodyText.includes("positionsReady"), '没有等岗位目录 —— 目录没到位时面板会一直空着')
    assert.ok(bodyText.includes("panels.indexOf('report-archive') >= 0"), '归档块没有按声明按需拉取')
    assert.ok(bodyText.includes('SKILL_PANEL_IDS.indexOf(id)'), '技能图没有按声明按需拉取台账')
  })

  it('台账路径与归档目录只定义一次（两处写死迟早分叉）', () => {
    assert.equal(CONSOLE_SOURCE.split("var SKILL_TABLE_PATH = 'memory/ref/技能表.json'").length - 1, 1)
    assert.equal(CONSOLE_SOURCE.split("var REPORT_ARCHIVE_DIR = '周报'").length - 1, 1)
    assert.ok(PAGE.includes('id="employeeAside"'), '右栏容器还在')
  })

  it('交付脚本能通过 JS 解析（字符串里的 JS，tsc 不检查）', async () => {
    const vm = await import('node:vm')
    assert.doesNotThrow(() => new vm.Script(SCRIPT))
  })
})
