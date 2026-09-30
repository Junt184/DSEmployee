/**
 * 离线时的两件事：**话要说对**，**路要走得通**。
 *
 * 真机验证里发现的两个问题（都不是崩溃，而是"看起来正常其实是坏的"）：
 *   ① 节点离线时刷新页面 → `session.list` 失败 → 提示条却说「「小艾」的指令没有发出去」。
 *      根本没在发指令，那句话把人往"我的消息是不是丢了"上引。
 *   ② 会话 id 不落地（只记了 lastEmployee）→ 刷新后 `session.create` 必然失败 →
 *      `state.selectedSessionId` 永远是 null → 发送键一直灰着 —— "先排队"这条路
 *      在门口就断了（只有"会话已经开着时节点才掉线"这一种情形能排队）。
 *
 * 这一组同时护住这两条：文案按**失败的到底是什么动作**来说，会话 id 记在本地下，
 * 且只在"节点确实离线"时才沿用（在线时列表为空 = 会话真的没了，不能复活一个死 id）。
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

/**
 * 取出一个模块级声明（`var X = {…}` 或 `var X = 值`）。
 * 用"行尾的 }"而不是数花括号：这些声明旁边的注释里就带着 {}（LS 那个键名注释），
 * 数花括号会把切片切在注释中间 —— 那会得到一个"看起来像语法错误"的假失败。
 */
function extractVar(name: string): string {
  const start = SCRIPT.indexOf(`var ${name} = `)
  assert.ok(start >= 0, `交付脚本里找不到 var ${name}`)
  const lineEnd = SCRIPT.indexOf('\n', start)
  if (!SCRIPT.slice(start, lineEnd).trimEnd().endsWith('{')) return SCRIPT.slice(start, lineEnd)
  return SCRIPT.slice(start, SCRIPT.indexOf('\n}', start) + 2)
}

/* ── 一个够用的假环境：只放这几个函数真正用到的东西 ─────────────────────────── */

interface FailEnv {
  state: { employees: Array<Record<string, unknown>>; selectedEmployeeId: string | null }
  describeFailure: (title: string, error: unknown) => string
  adoptOfflineSession: (sessions: unknown[], nodeOnline: boolean, remembered: string) => string
  rememberSession: (employeeId: string, sessionId: string) => void
  recallSession: (employeeId: string) => string
  store: Map<string, string>
}

function makeEnv(): FailEnv {
  const store = new Map<string, string>()
  const box = {
    state: {
      /* nodeId 必须和下面 OFFLINE 消息里的那个 64 位 id 对上 —— 节点名就是这么反查出来的 */
      employees: [
        {
          id: 'emp_1',
          name: '小艾',
          nodeId: '740fbeb3652bb58b78349541f855019c7219e659e9217f08cfcd8ef95f9823b2',
          nodeName: '本机Mac',
        },
      ] as Array<Record<string, unknown>>,
      selectedEmployeeId: 'emp_1' as string | null,
    },
    localStorage: {
      getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    console: { log: () => {} },
  }
  const names = [
    'readLocal',
    'writeLocal',
    'readSessionMemory',
    'rememberSession',
    'recallSession',
    'adoptOfflineSession',
    'selectedEmployeeOnNode',
    'nodeLabelFromOfflineMessage',
    'shortenIds',
    'describeFailure',
  ]
  const body = names
    .filter((name) => SCRIPT.includes(`function ${name}(`))
    .map((name) => extractFunction(name))
    .concat([extractVar('OFFLINE_ACTION_LABELS'), extractVar('SESSION_MEMORY_MAX')])
    .join('\n')
  const lsDecl = extractVar('LS')
  const factory = new Function(
    'scope',
    `with (scope) {
      ${lsDecl}
      ${body}
      return { describeFailure, adoptOfflineSession, rememberSession, recallSession }
    }`,
  ) as (scope: unknown) => Pick<FailEnv, 'describeFailure' | 'adoptOfflineSession' | 'rememberSession' | 'recallSession'>
  const api = factory(box)
  return { ...api, state: box.state, store }
}

/* 文案形状照抄 Hub：server.ts 的 `node ${nodeId} is not connected` */
const OFFLINE = { code: 'node-offline', message: 'node 740fbeb3652bb58b78349541f855019c7219e659e9217f08cfcd8ef95f9823b2 is not connected' }

describe('节点离线时的话要说对', () => {
  it('拉会话列表失败 ≠ 指令没发出去', () => {
    const env = makeEnv()
    const text = env.describeFailure('session.list', OFFLINE)
    assert.doesNotMatch(text, /指令没有发出去/, '这里根本没在发指令，不能这么说')
    assert.match(text, /会话列表/)
    assert.match(text, /离线/)
  })

  it('新建会话失败也不该说成"指令没发出去"', () => {
    const env = makeEnv()
    assert.doesNotMatch(env.describeFailure('session.create', OFFLINE), /指令没有发出去/)
  })

  it('真在发指令时，仍然点明是谁的指令没发出去（这条是有用的信息）', () => {
    const env = makeEnv()
    const text = env.describeFailure('session.prompt', OFFLINE)
    assert.match(text, /小艾/)
    assert.match(text, /指令没有发出去/)
    assert.match(text, /本机Mac/)
  })

  it('没见过的操作给一句兜底话，不静默也不乱认领', () => {
    const env = makeEnv()
    const text = env.describeFailure('position.upsert', OFFLINE)
    assert.ok(text.length > 0)
    assert.doesNotMatch(text, /指令没有发出去/)
  })
})

describe('离线时沿用上次打开的会话', () => {
  it('节点离线 + 列表为空 + 本地记着 → 沿用（否则刷新后根本发不出指令）', () => {
    const env = makeEnv()
    assert.equal(env.adoptOfflineSession([], false, 'ses_9'), 'ses_9')
  })

  it('节点在线 + 列表为空 → 不沿用（那说明会话真的没了，复活死 id 只会让指令卡在队列里）', () => {
    const env = makeEnv()
    assert.equal(env.adoptOfflineSession([], true, 'ses_9'), '')
  })

  it('列表拿到了就按列表走（最近活跃优先），与本地记忆无关', () => {
    const env = makeEnv()
    assert.equal(env.adoptOfflineSession([{ sessionId: 'ses_1' }], false, 'ses_9'), '')
  })

  it('本地没记过 → 空串（宁可什么都不做，也不要编一个 id）', () => {
    const env = makeEnv()
    assert.equal(env.adoptOfflineSession([], false, ''), '')
  })
})

describe('会话记忆本身', () => {
  it('记住 / 取回；只记指定员工的那一个', () => {
    const env = makeEnv()
    env.rememberSession('emp_1', 'ses_a')
    env.rememberSession('emp_2', 'ses_b')
    assert.equal(env.recallSession('emp_1'), 'ses_a')
    assert.equal(env.recallSession('emp_2'), 'ses_b')
    assert.equal(env.recallSession('emp_3'), '')
  })

  it('存坏了（手改 / 旧格式）当成没记过，不能让页面打不开', () => {
    const env = makeEnv()
    env.store.set('dse.lastSessions', '{不是 JSON')
    assert.equal(env.recallSession('emp_1'), '')
    env.rememberSession('emp_1', 'ses_a')
    assert.equal(env.recallSession('emp_1'), 'ses_a')
  })
})

describe('接线（结构护栏）', () => {
  it('selectEmployee 在拉不到会话时会尝试沿用本地记忆', () => {
    assert.match(extractFunction('selectEmployee'), /adoptOfflineSession\(/)
  })

  it('openSession 打开会话时把 id 记到本地', () => {
    assert.match(extractFunction('openSession'), /rememberSession\(/)
  })

  it('loadEmployees 收尾时按"离线→在线"这一次翻转决定要不要重接会话', () => {
    const body = extractFunction('loadEmployees')
    /* 必须在 state.employees 更新**之后**判：判定读的就是那里的 nodeOnline */
    assert.match(body, /if \(noteNodeOnline\(state\.employees\) === true\) resumeSelectedSession\(\)/)
    assert.ok(
      body.indexOf('resumeSelectedSession()') > body.indexOf('state.employees = list.filter'),
      '重接会话要排在员工列表赋值之后',
    )
  })

  it('重接会话必须**强制重订**：Hub 的 subscribe 在节点离线时也会"成功"', () => {
    const resume = extractFunction('resumeSelectedSession')
    assert.match(resume, /selectedNodeOnline\(\)/)
    assert.match(resume, /state\.subscribed = null/, '不能靠 state.subscribed 判断订没订上')
    assert.match(resume, /openSession\(/)
    /* 队列里还剩东西要照实说一句，否则失败的那条会随气泡一起消失 */
    assert.match(resume, /queued/)
  })

  it('只有翻转那一刻才重接，别的事件（改名/加人/重报目录）不能触发清屏', () => {
    assert.match(extractFunction('noteNodeOnline'), /lastNodeOnline\[id\] === false/)
  })
})
