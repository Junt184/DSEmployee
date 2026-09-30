/**
 * dsh 审批/提问 → Hub 审批中心 → 回填 dsh —— 这条反向通道的端到端测试。
 *
 * 为什么值得单独一个文件：这条链路连着**无人值守终端上唯一的人工出口**。
 * 它断了不会报错，只会表现成"员工看起来在干活、某些操作永远卡住"，而那种
 * 失败现场没有任何日志指向这里。所以下面把每一跳的形状都钉死：
 *
 *   节点上报  dsh.interaction.request（幂等键 = dsh 的 rpcId）
 *   控制台看  approval.list 里那条记录（kind / 工具名 / 理由）
 *   控制台裁  approval.resolve（审批）或 dsh.question.answer（提问）
 *   Hub 回填  dsh.interaction.respond → 节点 POST /api/respond
 *   收尾      dsh.interaction.settle（有人直接在 dsh Web 里答了 / 那一轮被中止）
 *
 * 用的是**真 Hub + 真 WebSocket 握手**，节点是进程内的假节点（只记账并应答转发）。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { HubClient, HubCallError } from '../src/client/hub-client.ts'

let tmpRoot = ''
let hub: Hub
let hubUrl = ''
let home = ''

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-hub-test-'))
  home = path.join(tmpRoot, 'home')
  hub = new Hub({ home, port: 0, verbose: false })
  hubUrl = (await hub.start()).wsUrl
})

after(async () => {
  await hub.stop()
  await rm(tmpRoot, { recursive: true, force: true })
})

/** 进程内假节点：连上 Hub、上报一个员工，并把收到的转发请求记进 `calls`。 */
async function makeNode(name: string): Promise<{
  client: HubClient
  nodeId: string
  employeeId: string
  calls: Array<{ method: string; params: Record<string, unknown> }>
  /** 置为 false 可让转发被拒（模拟"节点侧回填失败"） */
  answerForwarded: (frame: unknown) => void
}> {
  const client = await HubClient.create({
    identityFile: path.join(home, 'clients', `${name}.json`),
    url: hubUrl,
    role: 'node',
    scopes: [],
    clientId: 'dse-node',
    displayName: name,
    autoReconnect: false,
  })
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let failNext = false
  client.on('request', (frame) => {
    calls.push({
      method: frame.method,
      params: (frame.params ?? {}) as Record<string, unknown>,
    })
    if (failNext) {
      failNext = false
      client.respond(frame.id, {
        ok: false,
        error: { code: 'internal', message: 'node refused to answer' },
      })
      return
    }
    client.respond(frame.id, { ok: true, payload: { delivered: true } })
  })
  await client.connect()

  // 每个节点用**自己的**员工 id：Hub 的员工目录是全局聚合的，
  // 两个节点声明同一个 id 会触发"跨节点冲突"（那本身是另一条被守着的边界）。
  const employeeId = `emp_${name.replace(/[^a-z0-9]/g, '_')}`
  await client.call(
    'node.register',
    {
      name,
      platform: 'test',
      employeeRoot: path.join(tmpRoot, 'employees', name),
      employees: [
        {
          id: employeeId,
          name: '小艾',
          role: '测试员工',
          workspacePath: path.join(tmpRoot, 'employees', name, 'xiao-ai'),
          skills: [],
          status: 'ok',
          createdAtMs: Date.now(),
        },
      ],
    },
    { idempotencyKey: `register-${name}` },
  )

  return {
    client,
    nodeId: client.identity.deviceId,
    employeeId,
    calls,
    answerForwarded: (frame) => {
      void frame
      failNext = true
    },
  }
}

/**
 * 已批准的 operator。
 *
 * 注意：**只有节点能自动获批**（回环 + 无 scope），operator 必须走一遍真实配对 ——
 * 这正是生产里的引导流程，测试里也照做，免得绕过那条被反复加固的路径。
 */
async function makeOperator(name: string, scopes: string[]): Promise<HubClient> {
  const probe = await HubClient.create({
    identityFile: path.join(home, 'clients', `${name}.json`),
    url: hubUrl,
    role: 'operator',
    scopes: scopes as never,
    clientId: 'dse-cli',
    displayName: name,
    autoReconnect: false,
  })
  await assert.rejects(() => probe.connect())
  const deviceId = probe.identity.deviceId
  probe.close()

  const store = new HubStore(home)
  await store.load()
  const request = Object.values(store.state().pending).find((item) => item.deviceId === deviceId)
  assert.ok(request !== undefined, `no pending request for ${name}`)
  await approvePairing(store, request.requestId, 'test', { approvedScopes: scopes as never })

  const client = await HubClient.create({
    identityFile: path.join(home, 'clients', `${name}.json`),
    url: hubUrl,
    role: 'operator',
    scopes: scopes as never,
    clientId: 'dse-cli',
    displayName: name,
    autoReconnect: false,
  })
  await client.connect()
  return client
}

const approvalPayload = (rpcId: string, employeeId: string) => ({
  kind: 'dsh.approval' as const,
  employeeId,
  sessionId: 'session-abc',
  rpcId,
  toolName: 'bash',
  callId: 'call-1',
  reason: '需要写入工作区之外',
  dshApprovalId: 'dsh-apr-1',
})

describe('dsh 审批：上报 → 裁决 → 回填', () => {
  it('控制台能看到待裁决记录（kind / 工具名 / 理由都在）', async () => {
    const node = await makeNode('node-a')
    const operator = await makeOperator('op-a', ['employee.read', 'approval.resolve'])

    const created = await node.client.call<{ approvalId: string; created: boolean }>(
      'dsh.interaction.request',
      approvalPayload('rpc-1', node.employeeId),
      { idempotencyKey: 'dsh-int-rpc-1' },
    )
    assert.equal(created.created, true)

    const list = await operator.call<{ approvals: Array<Record<string, unknown>> }>('approval.list', {})
    const record = list.approvals.find((item) => item['approvalId'] === created.approvalId)
    assert.ok(record !== undefined, '审批中心必须能列出这条记录')
    assert.equal(record['kind'], 'dsh.approval')
    assert.equal(record['status'], 'pending')
    assert.equal(record['toolName'], 'bash')
    assert.equal(record['reason'], '需要写入工作区之外')
    assert.equal(record['employeeId'], node.employeeId)

    node.client.close()
    operator.close()
  })

  it('批准 → 节点收到 dsh.interaction.respond，载荷逐字为 dsh 要求的形状', async () => {
    const node = await makeNode('node-b')
    const operator = await makeOperator('op-b', ['employee.read', 'approval.resolve'])

    const { approvalId } = await node.client.call<{ approvalId: string }>(
      'dsh.interaction.request',
      approvalPayload('rpc-2', node.employeeId),
      { idempotencyKey: 'dsh-int-rpc-2' },
    )

    const resolved = await operator.call<{ status: string; delivered: boolean }>(
      'approval.resolve',
      { approvalId, approve: true },
      { idempotencyKey: `resolve-${approvalId}` },
    )
    assert.equal(resolved.status, 'approved')
    assert.equal(resolved.delivered, true, '回填成功必须如实上报')

    const forwarded = node.calls.filter((call) => call.method === 'dsh.interaction.respond')
    assert.equal(forwarded.length, 1, '必须恰好回填一次')
    assert.deepEqual(forwarded[0]?.params['value'], {
      sessionId: 'session-abc',
      // 这里要的是 **dsh 侧的** approvalId，不是 Hub 的 approvalId
      approvalId: 'dsh-apr-1',
      outcome: 'allowed-once',
    })
    assert.equal(forwarded[0]?.params['rpcId'], 'rpc-2', 'rpcId 是 dsh pending 表的键，不能丢')

    node.client.close()
    operator.close()
  })

  it('拒绝 → outcome 为 rejected', async () => {
    const node = await makeNode('node-c')
    const operator = await makeOperator('op-c', ['employee.read', 'approval.resolve'])

    const { approvalId } = await node.client.call<{ approvalId: string }>(
      'dsh.interaction.request',
      approvalPayload('rpc-3', node.employeeId),
      { idempotencyKey: 'dsh-int-rpc-3' },
    )
    const resolved = await operator.call<{ status: string }>(
      'approval.resolve',
      { approvalId, approve: false, note: '这一步不该在生产上跑' },
      { idempotencyKey: `resolve-${approvalId}` },
    )
    assert.equal(resolved.status, 'denied')

    const forwarded = node.calls.filter((call) => call.method === 'dsh.interaction.respond')
    assert.equal((forwarded[0]?.params['value'] as { outcome?: string })?.outcome, 'rejected')

    node.client.close()
    operator.close()
  })

  it('同一 rpcId 重复上报（dsh 重放）不新建记录', async () => {
    const node = await makeNode('node-d')
    const operator = await makeOperator('op-d', ['employee.read', 'approval.resolve'])

    const first = await node.client.call<{ approvalId: string; created: boolean }>(
      'dsh.interaction.request',
      approvalPayload('rpc-replay', node.employeeId),
      { idempotencyKey: 'k1' },
    )
    const second = await node.client.call<{ approvalId: string; created: boolean }>(
      'dsh.interaction.request',
      approvalPayload('rpc-replay', node.employeeId),
      { idempotencyKey: 'k2' },
    )
    assert.equal(second.created, false, '重放必须就地更新而不是新建')
    assert.equal(second.approvalId, first.approvalId)

    const list = await operator.call<{ approvals: Array<Record<string, unknown>> }>('approval.list', {})
    const same = list.approvals.filter((item) => item['rpcId'] === 'rpc-replay')
    assert.equal(same.length, 1, '控制台上不能堆出重复的假待办')

    node.client.close()
    operator.close()
  })

  it('节点回填失败 → 如实回报 delivered:false，且记录不留在"待裁决"', async () => {
    const node = await makeNode('node-e')
    const operator = await makeOperator('op-e', ['employee.read', 'approval.resolve'])

    const { approvalId } = await node.client.call<{ approvalId: string }>(
      'dsh.interaction.request',
      approvalPayload('rpc-5', node.employeeId),
      { idempotencyKey: 'dsh-int-rpc-5' },
    )
    node.answerForwarded(null)

    const resolved = await operator.call<{ delivered: boolean; deliveryError?: string }>(
      'approval.resolve',
      { approvalId, approve: true },
      { idempotencyKey: `resolve-${approvalId}` },
    )
    assert.equal(resolved.delivered, false, '回填失败绝不能被报成成功')
    assert.match(String(resolved.deliveryError), /refused/)

    const list = await operator.call<{ approvals: Array<Record<string, unknown>> }>('approval.list', {})
    const record = list.approvals.find((item) => item['approvalId'] === approvalId)
    assert.equal(record?.['status'], 'cancelled', '交付失败要收尾，不留一张点不掉的假待办')

    node.client.close()
    operator.close()
  })

  it('没有 approval.resolve scope 的 operator 不能裁决', async () => {
    const node = await makeNode('node-f')
    const weak = await makeOperator('op-f', ['employee.read'])

    const { approvalId } = await node.client.call<{ approvalId: string }>(
      'dsh.interaction.request',
      approvalPayload('rpc-6', node.employeeId),
      { idempotencyKey: 'dsh-int-rpc-6' },
    )
    await assert.rejects(
      () =>
        weak.call('approval.resolve', { approvalId, approve: true }, { idempotencyKey: 'x' }),
      (error: unknown) => error instanceof HubCallError && error.code === 'forbidden',
    )

    node.client.close()
    weak.close()
  })
})

describe('dsh 提问：答案不是批准/拒绝', () => {
  const questionPayload = (rpcId: string, employeeId: string) => ({
    kind: 'dsh.question' as const,
    employeeId,
    sessionId: 'session-abc',
    rpcId,
    questions: [
      {
        id: 'q1',
        header: '发布方式',
        question: '这次发到哪个环境？',
        options: [{ label: '预发' }, { label: '生产' }],
      },
    ],
  })

  it('对提问调用 approval.resolve 会被明确拒绝（而不是把人引到错误的动作上）', async () => {
    const node = await makeNode('node-g')
    const operator = await makeOperator('op-g', ['employee.read', 'approval.resolve'])

    const { approvalId } = await node.client.call<{ approvalId: string }>(
      'dsh.interaction.request',
      questionPayload('rpc-q1', node.employeeId),
      { idempotencyKey: 'q1' },
    )
    await assert.rejects(
      () => operator.call('approval.resolve', { approvalId, approve: true }, { idempotencyKey: 'q1r' }),
      (error: unknown) => error instanceof HubCallError && error.code === 'bad-request',
    )

    node.client.close()
    operator.close()
  })

  it('dsh.question.answer → 节点收到 {sessionId, answer}，记录变 answered', async () => {
    const node = await makeNode('node-h')
    const operator = await makeOperator('op-h', ['employee.read', 'approval.resolve'])

    const { approvalId } = await node.client.call<{ approvalId: string }>(
      'dsh.interaction.request',
      questionPayload('rpc-q2', node.employeeId),
      { idempotencyKey: 'q2' },
    )

    const answer = { answers: [{ id: 'q1', selected: ['预发'] }] }
    const result = await operator.call<{ status: string; delivered: boolean }>(
      'dsh.question.answer',
      { approvalId, answer },
      { idempotencyKey: `ans-${approvalId}` },
    )
    assert.equal(result.delivered, true)

    const forwarded = node.calls.filter((call) => call.method === 'dsh.interaction.respond')
    assert.deepEqual(forwarded[0]?.params['value'], { sessionId: 'session-abc', answer })
    assert.equal(forwarded[0]?.params['rpcId'], 'rpc-q2')

    const list = await operator.call<{ approvals: Array<Record<string, unknown>> }>('approval.list', {})
    const record = list.approvals.find((item) => item['approvalId'] === approvalId)
    assert.equal(record?.['status'], 'answered')
    assert.deepEqual(record?.['answer'], answer)

    node.client.close()
    operator.close()
  })
})

describe('dsh 侧自行收尾 → 通知 Hub 撤下卡片', () => {
  it('approval/resolved 按 dshApprovalId 定位并标记', async () => {
    const node = await makeNode('node-i')
    const operator = await makeOperator('op-i', ['employee.read', 'approval.resolve'])

    const { approvalId } = await node.client.call<{ approvalId: string }>(
      'dsh.interaction.request',
      { ...approvalPayload('rpc-7', node.employeeId), dshApprovalId: 'dsh-apr-7' },
      { idempotencyKey: 'dsh-int-rpc-7' },
    )

    const settled = await node.client.call<{ settled: boolean; status: string }>(
      'dsh.interaction.settle',
      { dshApprovalId: 'dsh-apr-7', outcome: 'cancelled' },
      { idempotencyKey: 'settle-7' },
    )
    assert.equal(settled.settled, true)
    assert.equal(settled.status, 'cancelled')

    const list = await operator.call<{ approvals: Array<Record<string, unknown>> }>('approval.list', {})
    assert.equal(list.approvals.find((item) => item['approvalId'] === approvalId)?.['status'], 'cancelled')

    node.client.close()
    operator.close()
  })

  it('question/resolved 按 questionRpcId 定位并标记', async () => {
    const node = await makeNode('node-j')
    const operator = await makeOperator('op-j', ['employee.read', 'approval.resolve'])

    const { approvalId } = await node.client.call<{ approvalId: string }>(
      'dsh.interaction.request',
      {
        kind: 'dsh.question',
        employeeId: node.employeeId,
        sessionId: 'session-abc',
        rpcId: 'rpc-q3',
        questions: [],
      },
      { idempotencyKey: 'q3' },
    )

    const settled = await node.client.call<{ settled: boolean }>(
      'dsh.interaction.settle',
      { rpcId: 'rpc-q3', outcome: 'cancelled' },
      { idempotencyKey: 'settle-q3' },
    )
    assert.equal(settled.settled, true)

    const list = await operator.call<{ approvals: Array<Record<string, unknown>> }>('approval.list', {})
    assert.equal(list.approvals.find((item) => item['approvalId'] === approvalId)?.['status'], 'cancelled')

    node.client.close()
    operator.close()
  })

  it('已经裁决过的记录不会被节点的迟到 settle 复活', async () => {
    const node = await makeNode('node-k')
    const operator = await makeOperator('op-k', ['employee.read', 'approval.resolve'])

    const { approvalId } = await node.client.call<{ approvalId: string }>(
      'dsh.interaction.request',
      { ...approvalPayload('rpc-8', node.employeeId), dshApprovalId: 'dsh-apr-8' },
      { idempotencyKey: 'dsh-int-rpc-8' },
    )
    await operator.call(
      'approval.resolve',
      { approvalId, approve: true },
      { idempotencyKey: `resolve-${approvalId}` },
    )
    const settled = await node.client.call<{ settled: boolean; status: string }>(
      'dsh.interaction.settle',
      { dshApprovalId: 'dsh-apr-8', outcome: 'rejected' },
      { idempotencyKey: 'settle-8' },
    )
    assert.equal(settled.settled, false, '终态记录不再被改写')
    assert.equal(settled.status, 'approved')

    node.client.close()
    operator.close()
  })
})

describe('归属校验', () => {
  it('节点不能替别的节点的员工上报交互', async () => {
    const owner = await makeNode('node-owner')
    const other = await makeNode('node-other')
    const operator = await makeOperator('op-l', ['employee.read'])

    // other 试图替 owner 名下的员工上报 —— 这正是"被攻陷的节点伪造别人的审批"
    await assert.rejects(
      () =>
        other.client.call(
          'dsh.interaction.request',
          approvalPayload('rpc-cross', owner.employeeId),
          { idempotencyKey: 'cross' },
        ),
      (error: unknown) => error instanceof HubCallError && error.code === 'forbidden',
    )

    // 而它报自己的员工必须是通的（否则上面那条断言可能只是"一律拒绝"）
    const own = await other.client.call<{ created: boolean }>(
      'dsh.interaction.request',
      approvalPayload('rpc-own', other.employeeId),
      { idempotencyKey: 'own' },
    )
    assert.equal(own.created, true)

    owner.client.close()
    other.client.close()
    operator.close()
  })
})
