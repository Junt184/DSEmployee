/**
 * 端到端验证：dsh 审批 / 提问 → Hub 审批中心 → 回填 dsh。
 *
 * 这条链路就是"无人值守终端上唯一的人工出口"：
 *   dsh 的审批闸是进程内的 `approval/request` waterfall，没人应答就 fail-closed。
 *   本脚本用**真 Hub + 真节点 + 真 dsh + 真模型**验证它现在能被人在控制台解除。
 *
 * 两段验证：
 *   ① 提问（确定性）：让员工调用 `ask_user_question` → 控制台收到待回答记录 →
 *      提交答案 → 员工把答案用进回复。
 *   ② 审批（尽力而为）：让员工做一件需要提权的事 → 控制台收到待批准记录 →
 *      批准 → 那一步真正执行成功。
 *      第二段依赖模型愿意申请提权，所以"未触发"会**如实报告**而不是伪装成通过。
 *
 * 用法：node scripts/e2e-approval.ts [--keep]
 *
 * 注意：本脚本会往 DSH_HOME 里写会话日志，所以默认用隔离的 `.dshdev`
 * （与 scripts/e2e-real-turn.ts 同一个家目录），不碰 ~/.dsh。
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { NodeAgent } from '../src/node/agent.ts'
import { HubClient } from '../src/client/hub-client.ts'

const KEEP = process.argv.includes('--keep')
const ROOT = path.resolve('.dse-e2e-approval')
const DSH_HOME = path.resolve('..', '.dshdev')

const log = (message: string): void => process.stdout.write(`[e2e] ${message}\n`)
const step = (title: string): void => process.stdout.write(`\n=== ${title} ===\n`)

const watchdog = setTimeout(() => {
  process.stderr.write('\n[e2e] 看门狗触发：脚本超时，强制退出\n')
  process.exit(2)
}, 600_000)
watchdog.unref()

type Approval = Record<string, unknown> & { approvalId: string; kind: string; status: string }

/** 轮询审批中心，等一条指定 kind 的待裁决记录出现。 */
async function waitForPending(
  client: HubClient,
  kind: string,
  timeoutMs: number,
): Promise<Approval | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const listed = await client.call<{ approvals: Approval[] }>('approval.list', {})
    const found = listed.approvals.find((item) => item.kind === kind && item.status === 'pending')
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return undefined
}

/** 等那一轮结束（用 session.history 里的 turn/end 判定，与实机行为一致）。 */
async function waitForTurnEnd(
  client: HubClient,
  employeeId: string,
  sessionId: string,
  timeoutMs: number,
): Promise<{ completed: boolean; assistantText: string; errorText: string }> {
  const deadline = Date.now() + timeoutMs
  let last: { completed: boolean; assistantText: string; errorText: string } = {
    completed: false,
    assistantText: '',
    errorText: '',
  }
  while (Date.now() < deadline) {
    const history = await client.call<{ events: Array<Record<string, unknown>> }>('session.history', {
      employeeId,
      sessionId,
      maxEvents: 400,
    })
    let assistantText = ''
    let errorText = ''
    let completed = false
    for (const entry of history.events) {
      const event = entry['event'] as { type?: string; data?: Record<string, unknown> } | undefined
      if (event?.type === 'assistant/message') {
        const message = event.data?.['message'] as { content?: Array<{ type?: string; text?: string }> } | undefined
        const text = (message?.content ?? [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => String(block.text))
          .join('')
        if (text !== '') assistantText = text
      }
      if (event?.type === 'turn/end') {
        const reason = event.data?.['reason'] as { kind?: string; error?: { message?: string } } | undefined
        completed = reason?.kind === 'completed'
        if (reason?.kind === 'error') errorText = String(reason.error?.message ?? 'unknown')
      }
    }
    last = { completed, assistantText, errorText }
    if (completed || errorText !== '') return last
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  return last
}

let hub: Hub | undefined
let node: NodeAgent | undefined

try {
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(path.join(ROOT, 'employees'), { recursive: true })

  /* ── 1. Hub ── */
  step('1. 启动 Hub')
  hub = new Hub({ home: ROOT, port: 0 })
  const address = await hub.start()
  log(`Hub 就绪 ${address.wsUrl}`)

  /* ── 2. 节点（托管真 dsh）── */
  step(`2. 启动节点（托管真 dsh，DSH_HOME=${DSH_HOME}）`)
  node = new NodeAgent({
    home: ROOT,
    hubUrl: address.wsUrl,
    name: '本机终端',
    employeeRoot: path.join(ROOT, 'employees'),
    dshHome: DSH_HOME,
    // **必须显式给**：类本身没有默认值，不给就会落到 dsh 的部署默认
    //（本机实测是 `minimal` —— 没有 ask_user_question、没有沙箱提权参数，
    // 于是审批/提问这两条链路根本无从触发）。CLI 的 `dse node` 默认传 standard。
    defaultPreset: 'standard',
    verbose: process.argv.includes('--verbose'),
  })
  await node.start()
  log(`节点就绪，dsh 端口 ${String(node.dshPort)}`)

  /* ── 3. 控制端配对 ── */
  step('3. 控制端配对')
  const SCOPES = [
    'employee.read',
    'employee.prompt',
    'employee.manage',
    'approval.resolve',
  ] as const
  const identityFile = path.join(ROOT, 'operator', 'identity.json')
  const probe = await HubClient.create({
    identityFile,
    url: address.wsUrl,
    role: 'operator',
    scopes: [...SCOPES],
    clientId: 'dse-e2e-approval',
    displayName: 'E2E 审批控制端',
    autoReconnect: false,
  })
  await probe.connect().catch(() => undefined)
  const store = new HubStore(ROOT)
  await store.load()
  const pendingPairing = Object.values(store.state().pending).find(
    (request) => request.deviceId === probe.identity.deviceId,
  )
  if (pendingPairing === undefined) throw new Error('未找到待审批的配对请求')
  await approvePairing(store, pendingPairing.requestId, 'e2e', { approvedScopes: [...SCOPES] })
  probe.close()

  const client = await HubClient.create({
    identityFile,
    url: address.wsUrl,
    role: 'operator',
    scopes: [...SCOPES],
    clientId: 'dse-e2e-approval',
    displayName: 'E2E 审批控制端',
    autoReconnect: false,
  })
  await client.connect()
  log('控制端已连上')

  // 记下审批生命周期事件的到达情况（这是控制台看到的推送）
  const lifecycle: string[] = []
  client.onEvent('approval.requested', (payload) => {
    const kind = (payload as { kind?: string }).kind
    lifecycle.push(`requested:${String(kind)}`)
  })
  client.onEvent('approval.resolved', (payload) => {
    const status = (payload as { status?: string }).status
    lifecycle.push(`resolved:${String(status)}`)
  })

  /* ── 4. 员工与会话 ── */
  step('4. 创建员工与会话')
  const nodes = await client.call<{ nodes: Array<{ nodeId: string }> }>('node.list')
  const nodeId = nodes.nodes[0]?.nodeId
  if (nodeId === undefined) throw new Error('Hub 上没有节点')
  const employee = await client.call<{ id: string; workspacePath: string }>(
    'employee.create',
    { nodeId, name: '小验', role: '负责端到端验证' },
    { idempotencyKey: `emp-${Date.now()}` },
  )
  log(`员工 ${employee.id} 工作区 ${employee.workspacePath}`)

  const failures: string[] = []

  /* ── 5. 提问链路 ── */
  step('5. 提问：员工问 → 控制台答 → 员工用上答案')
  const qSession = await client.call<{ sessionId: string }>(
    'session.create',
    { employeeId: employee.id, title: '提问验证' },
    { idempotencyKey: `sess-q-${Date.now()}` },
  )
  log(`会话 ${qSession.sessionId}`)
  const qPromptResult = await client.call(
    'session.prompt',
    {
      employeeId: employee.id,
      sessionId: qSession.sessionId,
      text:
        '请立刻调用 ask_user_question 工具向我提一个问题：' +
        '问题 id 用 env，问题正文是「这次发到哪个环境？」，' +
        '选项给两个：预发、生产。不要自己猜答案，也不要做别的事。',
    },
    { idempotencyKey: `prompt-q-${Date.now()}` },
  )
  log(`session.prompt 已受理：${JSON.stringify(qPromptResult)}`)

  const question = await waitForPending(client, 'dsh.question', 180_000)
  if (question === undefined) {
    // 没等到审批时**同样**要报告那一轮的结局 —— 否则"没触发"与"整轮根本没跑"
    // 混为一谈，而这个区别决定了该修哪一边。
    const turn = await waitForTurnEnd(client, employee.id, qSession.sessionId, 30_000)
    log(`❌ 未等到提问；那一轮：completed=${String(turn.completed)} 错误=${turn.errorText || '(无)'}`)
    log(`   员工回复（若有）：${turn.assistantText.slice(0, 300).replace(/\n+/g, ' ') || '(空)'}`)
    failures.push(
      `提问链路：未等到待回答的提问（那一轮 completed=${String(turn.completed)}，错误=${turn.errorText || '无'}）`,
    )
  } else {
    log(`✅ 审批中心收到提问 ${question.approvalId}（员工 ${String(question.employeeId)}）`)
    const questions = question['questions'] as Array<Record<string, unknown>> | undefined
    log(`   问题内容：${JSON.stringify(questions?.[0] ?? null)}`)
    const answer = { answers: [{ id: 'env', selected: ['预发'] }] }
    const answered = await client.call<{ status: string; delivered: boolean; deliveryError?: string }>(
      'dsh.question.answer',
      { approvalId: question.approvalId, answer },
      { idempotencyKey: `ans-${question.approvalId}` },
    )
    log(`   提交回答 → status=${answered.status} delivered=${String(answered.delivered)}`)
    if (answered.delivered !== true) {
      failures.push(`提问链路：回填失败 ${String(answered.deliveryError)}`)
    }
    const turn = await waitForTurnEnd(client, employee.id, qSession.sessionId, 180_000)
    log(`   那一轮：completed=${String(turn.completed)} 错误=${turn.errorText || '(无)'}`)
    log(`   员工回复：${turn.assistantText.slice(0, 200).replace(/\n+/g, ' ')}`)
    if (!turn.completed) failures.push(`提问链路：那一轮没有正常完成（${turn.errorText || '未知'}）`)
    if (!/预发/.test(turn.assistantText)) {
      failures.push('提问链路：员工回复里没有出现我们提交的答案「预发」—— 答案可能没真正送达')
    } else {
      log('   ✅ 答案被员工用进了回复（出现「预发」）')
    }
  }

  /* ── 6. 审批链路 ── */
  step('6. 审批：员工要提权 → 控制台批准 → 那一步真的执行')
  const targetFile = path.join(homedir(), 'dse-approval-e2e.txt')
  await rm(targetFile, { force: true })
  const aSession = await client.call<{ sessionId: string }>(
    'session.create',
    { employeeId: employee.id, title: '审批验证' },
    { idempotencyKey: `sess-a-${Date.now()}` },
  )
  log(`会话 ${aSession.sessionId}`)
  const aPromptResult = await client.call(
    'session.prompt',
    {
      employeeId: employee.id,
      sessionId: aSession.sessionId,
      text:
        `请用 bash 工具把文本 hello-approval 写到 ${targetFile}（这是工作区**之外**的路径）。` +
        '如果被沙箱拦下，请用同一个 bash 工具、带上 sandbox_permissions=danger-full-access 再试一次 —— ' +
        '提权请求会送到审批中心，我会批准。不要改用别的办法绕开，也不要把文件写到别的位置。',
    },
    { idempotencyKey: `prompt-a-${Date.now()}` },
  )
  log(`session.prompt 已受理：${JSON.stringify(aPromptResult)}`)

  const approval = await waitForPending(client, 'dsh.approval', 240_000)
  if (approval === undefined) {
    const turn = await waitForTurnEnd(client, employee.id, aSession.sessionId, 30_000)
    log(`❌ 未等到审批；那一轮：completed=${String(turn.completed)} 错误=${turn.errorText || '(无)'}`)
    log(`   员工回复（若有）：${turn.assistantText.slice(0, 300).replace(/\n+/g, ' ') || '(空)'}`)
    failures.push(
      `审批链路：未等到待批准的审批（那一轮 completed=${String(turn.completed)}，错误=${turn.errorText || '无'}）`,
    )
  } else {
    log(`✅ 审批中心收到审批 ${approval.approvalId}`)
    log(`   动作=${String(approval.toolName)} 理由=${String(approval.reason ?? '(无)')}`)
    const resolved = await client.call<{ status: string; delivered: boolean; deliveryError?: string }>(
      'approval.resolve',
      { approvalId: approval.approvalId, approve: true, note: 'e2e 自动批准' },
      { idempotencyKey: `res-${approval.approvalId}` },
    )
    log(`   批准 → status=${resolved.status} delivered=${String(resolved.delivered)}`)
    if (resolved.delivered !== true) {
      failures.push(`审批链路：回填失败 ${String(resolved.deliveryError)}`)
    }
    const turn = await waitForTurnEnd(client, employee.id, aSession.sessionId, 240_000)
    log(`   那一轮：completed=${String(turn.completed)} 错误=${turn.errorText || '(无)'}`)
    const written = await readFile(targetFile, 'utf8').catch(() => '')
    if (written.includes('hello-approval')) {
      log(`   ✅ 提权后的写入真的成功了（${targetFile}）`)
    } else {
      failures.push('审批链路：批准后目标文件没有出现 —— 回填可能没真正解除阻塞')
      log('   ❌ 目标文件不存在')
    }
  }

  /* ── 7. 结论 ── */
  step('7. 结论')
  log(`审批生命周期事件：${lifecycle.join(', ') || '(无)'}`)
  if (failures.length === 0) {
    log('✅ 全部通过')
  } else {
    log(`❌ ${failures.length} 项未通过：`)
    for (const failure of failures) log(`   - ${failure}`)
  }
  await writeFile(path.join(ROOT, 'result.json'), JSON.stringify({ failures, lifecycle }, null, 2))
  process.exitCode = failures.length === 0 ? 0 : 1
} catch (error) {
  process.stderr.write(`[e2e] 失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exitCode = 1
} finally {
  await node?.stop().catch(() => undefined)
  await hub?.stop().catch(() => undefined)
  if (!KEEP) await rm(ROOT, { recursive: true, force: true }).catch(() => undefined)
  clearTimeout(watchdog)
}
