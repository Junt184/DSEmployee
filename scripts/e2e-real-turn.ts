/**
 * 真实回合端到端验证。
 *
 * 一次跑通完整链路，并且**每一环都是真的**：
 *   Hub（进程内）← 节点代理（进程内，托管真 dsh）← 真 dsh web ← 真模型调用
 *
 * 它验证三件此前从未被验证过的事：
 *   1. **模型那一跳**：员工在它自己的工作区里、带着自己的 AGENTS.md 真跑一轮
 *   2. **`assistant/message` 抽取路径**：此前所有轮次都因缺凭据而失败，
 *      这条路径从未在**成功**的轮次上跑过
 *   3. **实时事件流**：dsh 下行 → `session.push` → Hub 广播 → 控制端
 *
 * 用法：node scripts/e2e-real-turn.ts [--keep]
 *   --keep  跑完不清理状态目录，便于事后翻看
 */

import { rm } from 'node:fs/promises'
import path from 'node:path'

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { NodeAgent } from '../src/node/agent.ts'
import { HubClient } from '../src/client/hub-client.ts'

/**
 * 工作目录。
 *
 * 默认 `.dse-live`，但**清理失败时自动改用带时间戳的目录**：
 * dsh 的 cwd 就是这个目录，若上一次运行遗留了 dsh 进程（例如调试时直接杀掉 node，
 * 而用 `shell:true` 启动的 dsh 孙进程变成孤儿存活），Windows 会锁住该目录，
 * `rm` 报 EBUSY。为一个测试脚本去手动找孤儿进程不值得 —— 换目录即可，
 * 并在日志里说清楚发生了什么。
 */
const PREFERRED_ROOT = path.resolve('.dse-live')
let ROOT = PREFERRED_ROOT
try {
  await rm(PREFERRED_ROOT, { recursive: true, force: true })
} catch (error) {
  ROOT = path.resolve(`.dse-live-${Date.now().toString(36)}`)
  process.stdout.write(
    `[e2e] 注意：无法清理 ${PREFERRED_ROOT}（${
      error instanceof Error ? error.message.split('\n')[0] : String(error)
    }）\n` +
      `[e2e] 通常意味着上一次运行遗留的 dsh 进程仍持有该目录；本次改用 ${ROOT}\n`,
  )
}
/**
 * 隔离的 DSH_HOME（里面放着凭据）。
 *
 * **必须用绝对路径**：`path.resolve('.dshdev')` 是相对**进程 cwd** 解析的，
 * 而这个脚本是从 `dsemployee/` 目录跑的 —— 于是它会指向 `dsemployee/.dshdev`
 * （一个空目录），dsh 便找不到凭据，整轮以 `MISSING_CREDENTIAL` 失败。
 * 这个坑我踩过一次，症状是"凭据明明在，模型却说没有"。
 */
const DSH_HOME = path.resolve('..', '.dshdev')
const EMPLOYEE_ROOT = path.join(ROOT, 'employees')
const keep = process.argv.includes('--keep')

const log = (message: string): void => process.stdout.write(`[e2e] ${message}\n`)
const step = (title: string): void => process.stdout.write(`\n=== ${title} ===\n`)

// 硬看门狗：dsh 子进程、socket 或定时器都可能留下句柄，
// 让脚本"干完了却不退出"。自动化脚本挂死比报错更难排查，所以兜底强退。
const watchdog = setTimeout(() => {
  process.stderr.write('\n[e2e] 看门狗触发：脚本超时，强制退出\n')
  process.exit(2)
}, 240_000)
watchdog.unref()

let hub: Hub | undefined
let node: NodeAgent | undefined

try {
  /* ── 1. Hub ── */
  step('1. 启动 Hub')
  hub = new Hub({ home: ROOT, port: 0 })
  const address = await hub.start()
  log(`Hub 就绪 ${address.wsUrl}`)

  /* ── 2. 节点（自己拉起真 dsh）── */
  step('2. 启动节点代理（托管真 dsh，DSH_HOME=.dshdev）')
  node = new NodeAgent({
    home: ROOT,
    hubUrl: address.wsUrl,
    name: '本机终端',
    employeeRoot: EMPLOYEE_ROOT,
    dshHome: DSH_HOME,
    // 不传 dshPort：让节点自己挑一个空闲端口，
    // 这样它就不需要捕获 dsh 的 stdout 去解析端口（受限环境下管道 spawn 会被拒）。
    verbose: false,
  })
  await node.start()
  log(`节点就绪，dsh 端口 ${node.dshPort}`)

  /* ── 3. 控制端（未配对 → 本机批准 → 自动领取令牌）── */
  step('3. 控制端配对')
  // 控制端需要的 scope：建员工(manage) + 开会话与下指令(prompt) + 读(read)
  //                  + 互调(invoke) + 裁决审批(approval.resolve)
  const OPERATOR_SCOPES = [
    'employee.read',
    'employee.prompt',
    'employee.manage',
    'employee.invoke',
    'approval.resolve',
  ] as const

  const operator = await HubClient.create({
    identityFile: path.join(ROOT, 'operator', 'identity.json'),
    url: address.wsUrl,
    role: 'operator',
    scopes: [...OPERATOR_SCOPES],
    clientId: 'dse-e2e',
    displayName: 'E2E 控制端',
    autoReconnect: false,
  })
  await operator.connect().catch(() => undefined)

  const store = new HubStore(ROOT)
  await store.load()
  const pending = Object.values(store.state().pending).find(
    (request) => request.deviceId === operator.identity.deviceId,
  )
  if (pending === undefined) throw new Error('未找到待审批的配对请求')
  await approvePairing(store, pending.requestId, 'e2e', {
    approvedScopes: [...OPERATOR_SCOPES],
  })
  operator.close()

  const client = await HubClient.create({
    identityFile: path.join(ROOT, 'operator', 'identity.json'),
    url: address.wsUrl,
    role: 'operator',
    scopes: [...OPERATOR_SCOPES],
    clientId: 'dse-e2e',
    displayName: 'E2E 控制端',
    autoReconnect: false,
  })
  await client.connect()
  log('控制端已连上（首次连接自行领取了令牌）')

  // 收集实时事件 —— 验证 dsh → 节点 → Hub → 控制端 这条通道
  const streamed: Array<{ method: string; at: number }> = []
  let streamedChars = 0
  client.onEvent('session.event', (payload) => {
    const event = (payload as { event?: { method?: string; payload?: unknown } }).event
    if (event?.method === undefined) return
    streamed.push({ method: event.method, at: Date.now() })
    streamedChars += JSON.stringify(event.payload ?? '').length
  })

  /* ── 4. 建员工 ── */
  step('4. 创建数字员工')
  const nodes = await client.call<{ nodes: Array<{ nodeId: string }> }>('node.list')
  const nodeId = nodes.nodes[0]?.nodeId
  if (nodeId === undefined) throw new Error('Hub 上没有节点')

  const employee = await client.call<{ id: string; workspacePath: string; name: string }>(
    'employee.create',
    {
      nodeId,
      name: '小艾',
      role: '负责每周整理周报、核对数据，并把结果汇总成表格',
    },
    { idempotencyKey: `emp-${Date.now()}` },
  )
  log(`员工已创建 ${employee.name} (${employee.id})`)
  log(`工作区 ${employee.workspacePath}`)

  /* ── 5. 会话 + 真实指令 ── */
  step('5. 开会话并下指令（真实模型调用）')
  const session = await client.call<{ sessionId: string }>(
    'session.create',
    { employeeId: employee.id },
    { idempotencyKey: `sess-${Date.now()}` },
  )
  log(`会话 ${session.sessionId}`)

  await client
    .call(
      'session.subscribe',
      { employeeId: employee.id, sessionId: session.sessionId },
      // session.subscribe 在方法表里是 idempotent: true —— 缺幂等键会被 Hub
      // 拒为 idempotency-key-required。§10.3 的教训：这个错误曾被 catch 静默吞掉，
      // 导致 session.watch 从未到达节点，实时事件流表现为"0 条 session.event"。
      { idempotencyKey: `sub-${Date.now()}` },
    )
    .catch((error: unknown) => {
      // 订阅失败不等于整轮失败（历史回放仍可验证），但必须留痕
      log(`⚠️ session.subscribe 失败：${error instanceof Error ? error.message : String(error)}`)
    })

  const task = '用一句话说明：你是谁、你负责什么。不要调用任何工具。'
  log(`指令：${task}`)
  const acceptedAt = Date.now()
  await client.call(
    'session.prompt',
    { employeeId: employee.id, sessionId: session.sessionId, text: task },
    { idempotencyKey: `prompt-${Date.now()}` },
  )

  /* ── 6. 等它跑完 ── */
  step('6. 等待员工完成')
  const deadline = Date.now() + 180_000
  let running = true
  while (Date.now() < deadline) {
    const listed = await client.call<{ sessions: Array<{ sessionId: string; running: boolean }> }>(
      'session.list',
      { employeeId: employee.id },
    )
    const row = listed.sessions.find((item) => item.sessionId === session.sessionId)
    running = row?.running === true
    if (!running) break
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  const elapsed = ((Date.now() - acceptedAt) / 1000).toFixed(1)
  log(`轮次结束（running=${running}，耗时 ${elapsed}s）`)

  /* ── 7. 读历史，检查抽取 ── */
  step('7. 读取会话历史并检查文本抽取')
  const history = await client.call<{
    events: Array<{ event?: { type?: string; seq?: number; data?: unknown } }>
  }>('session.history', { employeeId: employee.id, sessionId: session.sessionId })
  const types = new Map<string, number>()
  for (const entry of history.events) {
    const type = entry.event?.type ?? '(unknown)'
    types.set(type, (types.get(type) ?? 0) + 1)
  }
  log(`事件总数 ${history.events.length}，类型分布：`)
  for (const [type, count] of [...types].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`    ${String(count).padStart(3)}  ${type}\n`)
  }

  // 结局：**失败原因优先于任何文本**。这是这一轮最该看清的东西。
  const turnEnd = [...history.events].reverse().find((entry) => entry.event?.type === 'turn/end')
  const reason = (turnEnd?.event?.data as { reason?: { kind?: string; error?: { message?: string; code?: string } } })
    ?.reason
  process.stdout.write('\n--- turn/end 结局 ---\n')
  process.stdout.write(`${JSON.stringify(reason, null, 2)}\n`)

  // assistant 事件的原始形状：验证 assistant/message 与 assistant/chunk 谁真的会出现，
  // 以及文本到底挂在哪个字段上（抽取逻辑就是据此写的）。
  process.stdout.write('\n--- assistant 事件原始形状 ---\n')
  for (const entry of history.events) {
    const type = entry.event?.type ?? ''
    if (!type.startsWith('assistant/')) continue
    process.stdout.write(`\n[seq ${entry.event?.seq}] ${type}\n`)
    process.stdout.write(`${JSON.stringify(entry.event?.data, null, 2).slice(0, 1200)}\n`)
  }

  /* ── 8. 员工互调（验证抽取路径 + ACL + 异步结算 + 结果回流）── */
  step('8. 员工互调：小艾 → 小博')
  const second = await client.call<{ id: string; name: string }>(
    'employee.create',
    { nodeId, name: '小博', role: '负责数据核对与异常排查' },
    { idempotencyKey: `emp2-${Date.now()}` },
  )
  log(`第二个员工已创建 ${second.name} (${second.id})`)

  const invoked = await client.call<{ invokeId: string; status: string; approvalId?: string }>(
    'employee.invoke',
    {
      fromEmployeeId: employee.id,
      toEmployeeId: second.id,
      task: '用一句话说明你是谁、负责什么。不要调用任何工具。',
    },
    { idempotencyKey: `invoke-${Date.now()}` },
  )
  log(`调用返回 status=${invoked.status} approvalId=${invoked.approvalId ?? '—'}`)

  if (invoked.approvalId !== undefined) {
    log('默认 ACL 要求审批 —— 批准它')
    const resolved = await client.call<{ status: string; dispatch?: string }>(
      'approval.resolve',
      { approvalId: invoked.approvalId, approve: true, note: 'e2e 授权' },
      { idempotencyKey: `appr-${Date.now()}` },
    )
    // 关键：批准**立刻返回**，不等目标员工跑完（否则长任务必然撞上 30 秒调用超时）
    log(`批准返回 status=${resolved.status} dispatch=${resolved.dispatch ?? '—'}（未阻塞）`)
  }

  // 等 invoke.settled 事件，或轮询记录 —— 两条路都验证
  let settled: { status?: string; resultText?: string; error?: string } | undefined
  const settleDeadline = Date.now() + 120_000
  while (Date.now() < settleDeadline) {
    const records = await client.call<{
      invocations: Array<{ invokeId: string; status: string; resultText?: string; error?: string }>
    }>('employee.invoke.list', {})
    const row = records.invocations.find((item) => item.invokeId === invoked.invokeId)
    if (row !== undefined && row.status !== 'running' && row.status !== 'queued' && row.status !== 'pending-approval') {
      settled = row
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  process.stdout.write('\n--- 互调结算 ---\n')
  process.stdout.write(`${JSON.stringify(settled ?? { note: '等待超时，未结算' }, null, 2)}\n`)

  /* ── 9. 结论 ── */
  step('9. 结论')
  log(`实时事件流：收到 ${streamed.length} 条 session.event（${streamedChars} 字符）`)
  if (streamed.length > 0) {
    const byMethod = new Map<string, number>()
    for (const item of streamed) byMethod.set(item.method, (byMethod.get(item.method) ?? 0) + 1)
    for (const [method, count] of [...byMethod].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      process.stdout.write(`    ${String(count).padStart(3)}  ${method}\n`)
    }
  } else {
    log('⚠️ 一条都没收到 —— dsh 下行 → session.push → Hub 广播 这条通道没有工作')
  }
} catch (error) {
  process.stderr.write(
    `\n[e2e] 失败：${error instanceof Error ? error.message : String(error)}\n`,
  )
  if (error instanceof Error && error.stack !== undefined) {
    process.stderr.write(`${error.stack.split('\n').slice(1, 4).join('\n')}\n`)
  }
  process.exitCode = 1
} finally {
  await node?.stop().catch(() => undefined)
  await hub?.stop().catch(() => undefined)
  if (keep) {
    process.stdout.write('\n[--keep] 已保留状态目录（Hub 与节点已停止）\n')
  }
  // 显式退出：dsh 子进程、socket 或定时器可能仍有句柄，
  // 让脚本"跑完了但不退出"会把自动化流程挂死。
  process.exit(process.exitCode ?? 0)
}
