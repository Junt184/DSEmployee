/**
 * 双终端端到端验证 —— "5 个员工分布在 2 台终端、经一台服务器中转"的最小忠实复现。
 *
 * 为什么必须单独做这个：单终端测试**无法暴露**多终端才会出现的问题 ——
 * 员工 id 冲突、请求路由到错误的节点、跨节点互调、
 * 以及"两个 dsh 实例共用状态目录"导致的相互覆盖。
 *
 * 忠实度要点：**每个终端一个独立 DSH_HOME 与独立 employeeRoot**。
 * 这不是形式主义 —— dsh 的工作区注册表是按 DSH_HOME 存的，
 * 两个实例共用一个 DSH_HOME 会同时读写同一批 JSON 文件而互相覆盖，
 * 那正是生产里最该避免的情况（也是本项目 Hub 加独占锁的同一类理由）。
 *
 * 用法：node scripts/e2e-two-nodes.ts
 */

import { copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { NodeAgent } from '../src/node/agent.ts'
import { HubClient } from '../src/client/hub-client.ts'

const ROOT = path.resolve('.dse-two-nodes')
const CRED_SOURCE = process.env['DSE_CREDENTIALS_SOURCE'] ?? path.join(homedir(), '.dsh', '.credentials.yaml')

const log = (message: string): void => process.stdout.write(`[two] ${message}\n`)
const step = (title: string): void => process.stdout.write(`\n=== ${title} ===\n`)

const watchdog = setTimeout(() => {
  process.stderr.write('\n[two] 看门狗触发：超时强制退出\n')
  process.exit(2)
}, 420_000)
watchdog.unref()

interface Terminal {
  readonly label: string
  readonly dshHome: string
  readonly employeeRoot: string
  agent?: NodeAgent
}

const terminals: Terminal[] = [
  {
    label: '终端A',
    dshHome: path.resolve('.dshterm-a'),
    employeeRoot: path.join(ROOT, 'terminal-a', 'employees'),
  },
  {
    label: '终端B',
    dshHome: path.resolve('.dshterm-b'),
    employeeRoot: path.join(ROOT, 'terminal-b', 'employees'),
  },
]

let hub: Hub | undefined

try {
  await rm(ROOT, { recursive: true, force: true })

  /* ── 0. 给每个终端准备独立的 DSH_HOME（含凭据）── */
  step('0. 准备两个独立 DSH_HOME')
  for (const terminal of terminals) {
    await rm(terminal.dshHome, { recursive: true, force: true })
    // 只做文件到文件复制，绝不读取或打印内容
    await copyFile(CRED_SOURCE, path.join(await ensure(terminal.dshHome), '.credentials.yaml')).catch(
      () => {
        throw new Error(
          `凭据源不可读：${CRED_SOURCE}（可用 DSE_CREDENTIALS_SOURCE 指定）`,
        )
      },
    )
    log(`${terminal.label}: DSH_HOME=${terminal.dshHome}`)
  }

  /* ── 1. 一台服务器 ── */
  step('1. 启动 Hub（服务器）')
  hub = new Hub({ home: ROOT, port: 0 })
  const address = await hub.start()
  log(`Hub 就绪 ${address.wsUrl}`)

  /* ── 2. 两台终端各自拉起自己的 dsh ── */
  step('2. 启动两个终端节点（各自一个 dsh 实例）')
  for (const terminal of terminals) {
    terminal.agent = new NodeAgent({
      home: ROOT,
      hubUrl: address.wsUrl,
      name: terminal.label,
      employeeRoot: terminal.employeeRoot,
      dshHome: terminal.dshHome,
    })
    await terminal.agent.start()
    log(`${terminal.label} 就绪，dsh 端口 ${terminal.agent.dshPort}`)
  }
  const ports = terminals.map((t) => t.agent?.dshPort)
  if (new Set(ports).size !== ports.length) {
    throw new Error(`两个终端用了同一个 dsh 端口：${ports.join(', ')}`)
  }
  log(`两个 dsh 实例端口互不相同：${ports.join(' / ')}`)

  /* ── 3. 控制端配对 ── */
  step('3. 控制端配对')
  const SCOPES = ['employee.read', 'employee.prompt', 'employee.manage', 'employee.invoke', 'approval.resolve'] as const
  const probe = await HubClient.create({
    identityFile: path.join(ROOT, 'operator', 'identity.json'),
    url: address.wsUrl,
    role: 'operator',
    scopes: [...SCOPES],
    clientId: 'dse-two',
    displayName: '双终端测试端',
    autoReconnect: false,
  })
  await probe.connect().catch(() => undefined)
  const store = new HubStore(ROOT)
  await store.load()
  const pending = Object.values(store.state().pending).find(
    (request) => request.deviceId === probe.identity.deviceId,
  )
  if (pending === undefined) throw new Error('未找到待审批的配对请求')
  await approvePairing(store, pending.requestId, 'two', { approvedScopes: [...SCOPES] })
  probe.close()

  const client = await HubClient.create({
    identityFile: path.join(ROOT, 'operator', 'identity.json'),
    url: address.wsUrl,
    role: 'operator',
    scopes: [...SCOPES],
    clientId: 'dse-two',
    displayName: '双终端测试端',
    autoReconnect: false,
  })
  await client.connect()

  /* ── 4. 两个终端都应在册且在线 ── */
  step('4. 节点聚合')
  const nodes = await client.call<{
    nodes: Array<{ nodeId: string; name: string; online: boolean; dshPort: number; employeeCount: number }>
  }>('node.list', {})
  for (const node of nodes.nodes) {
    log(`节点 ${node.name}  在线=${node.online}  dsh端口=${node.dshPort}  员工数=${node.employeeCount}`)
  }
  if (nodes.nodes.length !== 2) throw new Error(`期望 2 个节点，实际 ${nodes.nodes.length}`)
  if (nodes.nodes.some((node) => !node.online)) throw new Error('有节点不在线')

  const nodeIdFor = (name: string): string => {
    const hit = nodes.nodes.find((node) => node.name === name)
    if (hit === undefined) throw new Error(`找不到节点 ${name}`)
    return hit.nodeId
  }

  /* ── 5. 员工分散到两台终端 ── */
  step('5. 在终端A 建「小艾」，在终端B 建「小博」')
  const alice = await client.call<{ id: string; workspacePath: string }>(
    'employee.create',
    { nodeId: nodeIdFor('终端A'), name: '小艾', role: '负责每周整理周报、核对数据' },
    { idempotencyKey: `alice-${Date.now()}` },
  )
  log(`小艾 → ${alice.workspacePath}`)
  const bob = await client.call<{ id: string; workspacePath: string }>(
    'employee.create',
    { nodeId: nodeIdFor('终端B'), name: '小博', role: '负责数据核对与异常排查' },
    { idempotencyKey: `bob-${Date.now()}` },
  )
  log(`小博 → ${bob.workspacePath}`)

  // 关键断言：员工的工作区确实落在**各自终端**的根目录下
  for (const [employee, terminal] of [
    [alice, terminals[0]],
    [bob, terminals[1]],
  ] as const) {
    if (terminal === undefined || !employee.workspacePath.startsWith(terminal.employeeRoot)) {
      throw new Error(`员工的工区不在预期终端下：${employee.workspacePath}`)
    }
  }
  log('工作区与终端归属一致 ✅')

  const listed = await client.call<{
    employees: Array<{ id: string; name: string; nodeName: string; available: boolean }>
  }>('employee.list', {})
  for (const employee of listed.employees) {
    log(`员工 ${employee.name}  所在终端=${employee.nodeName}  可用=${employee.available}`)
  }
  const aliceRow = listed.employees.find((e) => e.id === alice.id)
  const bobRow = listed.employees.find((e) => e.id === bob.id)
  if (aliceRow?.nodeName !== '终端A' || bobRow?.nodeName !== '终端B') {
    throw new Error('Hub 聚合的员工归属不正确')
  }

  /* ── 6. 路由正确性：会话必须落在正确的 dsh 实例上 ── */
  step('6. 验证请求路由到正确的终端')
  const promptEmployee = async (employeeId: string, task: string): Promise<string> => {
    const created = await client.call<{ sessionId: string }>(
      'session.create',
      { employeeId },
      { idempotencyKey: `sess-${Date.now()}-${Math.random()}` },
    )
    await client.call(
      'session.prompt',
      { employeeId, sessionId: created.sessionId, text: task },
      { idempotencyKey: `prompt-${Date.now()}-${Math.random()}` },
    )
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      const list = await client.call<{ sessions: Array<{ sessionId: string; running: boolean }> }>(
        'session.list',
        { employeeId },
      )
      if (list.sessions.find((s) => s.sessionId === created.sessionId)?.running === false) break
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
    return created.sessionId
  }

  const aliceSession = await promptEmployee(alice.id, '用一句话说明你是谁、负责什么。不要调用任何工具。')
  log(`小艾的会话：${aliceSession}`)

  // 该会话只应出现在终端A 的员工名下，不应出现在终端B 的员工名下
  const aliceSessions = await client.call<{ sessions: Array<{ sessionId: string }> }>('session.list', {
    employeeId: alice.id,
  })
  const bobSessions = await client.call<{ sessions: Array<{ sessionId: string }> }>('session.list', {
    employeeId: bob.id,
  })
  const inAlice = aliceSessions.sessions.some((s) => s.sessionId === aliceSession)
  const inBob = bobSessions.sessions.some((s) => s.sessionId === aliceSession)
  log(`小艾的会话在终端A 名下: ${inAlice}；误在终端B 名下: ${inBob}`)
  if (!inAlice || inBob) throw new Error('会话路由错误：会话出现在错误的终端上')

  /* ── 7. 跨终端员工互调 ── */
  step('7. 跨终端互调：小艾（终端A）→ 小博（终端B）')
  const invoked = await client.call<{ invokeId: string; status: string; approvalId?: string }>(
    'employee.invoke',
    {
      fromEmployeeId: alice.id,
      toEmployeeId: bob.id,
      task: '用一句话说明你是谁、负责什么。不要调用任何工具。',
    },
    { idempotencyKey: `invoke-${Date.now()}` },
  )
  log(`调用返回 status=${invoked.status}`)
  if (invoked.approvalId !== undefined) {
    await client.call(
      'approval.resolve',
      { approvalId: invoked.approvalId, approve: true, note: '双终端测试授权' },
      { idempotencyKey: `appr-${Date.now()}` },
    )
    log('已批准（立即返回，不阻塞）')
  }

  let settled: { status?: string; resultText?: string; resultSessionId?: string; error?: string } | undefined
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const records = await client.call<{
      invocations: Array<{
        invokeId: string
        status: string
        resultText?: string
        resultSessionId?: string
        error?: string
      }>
    }>('employee.invoke.list', {})
    const row = records.invocations.find((r) => r.invokeId === invoked.invokeId)
    if (row !== undefined && ['completed', 'failed', 'denied'].includes(row.status)) {
      settled = row
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  process.stdout.write('\n--- 跨终端互调结算 ---\n')
  process.stdout.write(`${JSON.stringify(settled ?? { note: '超时未结算' }, null, 2)}\n`)

  if (settled?.resultSessionId !== undefined) {
    const onBob = await client.call<{ sessions: Array<{ sessionId: string }> }>('session.list', {
      employeeId: bob.id,
    })
    const landed = onBob.sessions.some((s) => s.sessionId === settled?.resultSessionId)
    log(`被调员工的会话落在终端B 名下: ${landed}`)
    if (!landed) throw new Error('互调执行落在了错误的终端上')
  }

  /* ── 8. 结语 ── */
  step('8. 结论')
  const finalNodes = await client.call<{ nodes: Array<{ name: string; employeeCount: number }> }>(
    'node.list',
    {},
  )
  for (const node of finalNodes.nodes) {
    log(`${node.name}: ${node.employeeCount} 个员工`)
  }
  log(`互调结果: ${settled?.status ?? '未结算'}`)
  if (settled?.resultText !== undefined) log(`回复: ${settled.resultText}`)
} catch (error) {
  process.stderr.write(
    `\n[two] 失败：${error instanceof Error ? error.message : String(error)}\n`,
  )
  if (error instanceof Error && error.stack !== undefined) {
    process.stderr.write(`${error.stack.split('\n').slice(1, 4).join('\n')}\n`)
  }
  process.exitCode = 1
} finally {
  for (const terminal of terminals) await terminal.agent?.stop().catch(() => undefined)
  await hub?.stop().catch(() => undefined)
  process.exit(process.exitCode ?? 0)
}

async function ensure(dir: string): Promise<string> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  return dir
}
