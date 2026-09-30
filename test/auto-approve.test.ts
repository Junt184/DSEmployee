/**
 * 员工级"审批自动放行"（Hub 侧策略）—— 只对 dsh 审批生效，且必须留痕。
 *
 * 背景：用户想要"给某些员工开 full access"，而 dsh 0.1.0-rc.6 没暴露"按会话/按员工
 * 设权限档位"的接口（逐个候选名试过，全是 not found），唯一写入口是机器级默认
 * （settings.permission.defaultPreset）—— 那会把一台机器上**所有**员工一起放开。
 * 所以改从我们本来就拥有的那一层下手：**审批的裁决点本来就在 Hub**。
 *
 * 这一组守三条边界（写错任何一条都等于悄悄拆掉刹车）：
 *   1. 开了 ⇒ dsh 审批**立刻**被裁决为 approved，并**回填给 dsh**（不回填，员工那一轮还卡着）；
 *   2. 没开 ⇒ 照旧 pending（不能"顺手"把所有人都放开）；
 *   3. **dsh.question 不受影响**（那是模型在问人问题，自动编答案等于替人做决定）。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { HubClient } from '../src/client/hub-client.ts'

let tmpRoot = ''
let home = ''
let hub: Hub
let hubUrl = ''
let operator: HubClient
let node: HubClient
let nodeIdOfNode = ''

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-autoapprove-'))
  home = path.join(tmpRoot, 'home')
  hub = new Hub({ home, port: 0, verbose: false })
  const address = await hub.start()
  hubUrl = address.wsUrl

  /* 一台节点（零 scope，node 角色）+ 一个 operator（employee.read/manage + approval.resolve） */
  node = await HubClient.create({
    identityFile: path.join(home, 'clients', 'node.json'),
    url: hubUrl,
    role: 'node',
    scopes: [] as never,
    clientId: 'dse-node',
    displayName: '测试节点',
    autoReconnect: false,
  })
  await node.connect()
  /* 像真节点那样注册一次：Hub 要知道这个 nodeId 对应哪台机器，
     否则 dsh 裁决根本回填不出去（回填失败会被记成 cancelled）。 */
  const registered = (await node.call(
    'node.register',
    {
      name: '测试节点',
      platform: 'test',
      employeeRoot: '/tmp/emps',
      employees: [] as never,
    } as never,
    { idempotencyKey: 'reg-1' },
  )) as { nodeId: string }
  nodeIdOfNode = registered.nodeId

  const make = async (): Promise<HubClient> =>
    await HubClient.create({
      identityFile: path.join(home, 'clients', 'op.json'),
      url: hubUrl,
      role: 'operator',
      scopes: ['employee.read', 'employee.manage', 'approval.resolve'] as never,
      clientId: 'dse-cli',
      displayName: 'op-auto',
      autoReconnect: false,
    })
  const probe = await make()
  await assert.rejects(() => probe.connect())
  probe.close()
  const store = new HubStore(home)
  await store.load()
  const request = Object.values(store.state().pending)[0]
  assert.ok(request !== undefined)
  await approvePairing(store, request.requestId, 'test', {
    approvedScopes: ['employee.read', 'employee.manage', 'approval.resolve'] as never,
  })
  operator = await make()
  await operator.connect()

  /* 摆一个员工（审批记录里要能解析出员工名） */
  hub.state().employees['emp_auto_1'] = {
    id: 'emp_auto_1',
    nodeId: nodeIdOfNode,
    name: '阿柠',
    role: '',
    workspacePath: '/tmp/aning',
    skills: [],
    status: 'ok',
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  }
})

after(async () => {
  operator.close()
  node.close()
  await hub.stop()
  await rm(tmpRoot, { recursive: true, force: true })
})

/** 模拟节点上报一个 dsh 审批请求（node 角色专属入口）。 */
async function reportApproval(rpcId: string, employeeId: string): Promise<{ approvalId: string; autoApproved?: boolean }> {
  return (await node.call(
    'dsh.interaction.request',
    {
      kind: 'dsh.approval',
      rpcId,
      sessionId: 'session-x',
      employeeId,
      dshApprovalId: `apr-${rpcId}`,
      toolName: 'bash',
      reason: 'rm -rf build',
    } as never,
    { idempotencyKey: `req-${rpcId}` },
  )) as { approvalId: string; autoApproved?: boolean }
}

/**
 * 节点是否收到回填：`deliverDshInteraction` 会给节点发一条 `dsh.interaction.respond` 请求。
 * **要像真节点那样应答**（`respond()`），否则 Hub 会把它记成"回填失败 → cancelled"，
 * 而那正是这个测试要区分的东西。
 */
function waitForRespond(timeoutMs = 3000): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    const handler = (frame: { id: string; method?: string; params?: unknown }): void => {
      if (frame.method !== 'dsh.interaction.respond') return
      node.off('request', handler)
      clearTimeout(timer)
      node.respond(frame.id, { ok: true, payload: {} })
      resolve(frame.params as Record<string, unknown>)
    }
    node.on('request', handler)
  })
}

describe('审批自动放行：按员工、只放审批、必须留痕', () => {
  it('没开 ⇒ 照旧 pending（不能顺手把所有人都放开）', async () => {
    const created = await reportApproval('rpc-off-1', 'emp_auto_1')
    assert.equal(created.autoApproved, undefined)
    const approval = hub.state().approvals[created.approvalId]
    assert.equal(approval?.status, 'pending')
  })

  it('开了 ⇒ 立刻裁决为 approved，并把裁决**回填给 dsh**（不回填等于员工还卡着）', async () => {
    const set = (await operator.call(
      'employee.autoApprove.set',
      { employeeId: 'emp_auto_1', enabled: true } as never,
      { idempotencyKey: 'on-1' },
    )) as { autoApprove: boolean }
    assert.equal(set.autoApprove, true)

    const respondPromise = waitForRespond()
    const created = await reportApproval('rpc-on-1', 'emp_auto_1')
    assert.equal(created.autoApproved, true)

    const approval = hub.state().approvals[created.approvalId]
    assert.equal(approval?.status, 'approved', '实际 note: ' + String(approval?.resolutionNote))
    assert.equal(approval?.resolvedBy, 'auto:emp_auto_1', '要留痕：谁放的、为什么')
    assert.match(String(approval?.resolutionNote ?? ''), /自动放行/)

    const responded = await respondPromise
    assert.ok(responded !== undefined, '必须给 dsh 回填，否则员工那一轮一直挂着')
    assert.equal(responded['kind'], 'dsh.approval')
    assert.deepEqual((responded['value'] as { outcome?: string }).outcome, 'allowed-once')
  })

  it('提问（dsh.question）**不受**自动放行影响 —— 那是在问人，不该替人做决定', async () => {
    const created = (await node.call(
      'dsh.interaction.request',
      {
        kind: 'dsh.question',
        rpcId: 'rpc-q-1',
        sessionId: 'session-x',
        employeeId: 'emp_auto_1',
        questions: [{ question: '用哪个库？' }],
      } as never,
      { idempotencyKey: 'req-q-1' },
    )) as { approvalId: string; autoApproved?: boolean }
    assert.equal(created.autoApproved, undefined)
    assert.equal(hub.state().approvals[created.approvalId]?.status, 'pending')
  })

  it('关掉之后立刻恢复"等人批"，而且员工视图里能看出当前状态', async () => {
    await operator.call(
      'employee.autoApprove.set',
      { employeeId: 'emp_auto_1', enabled: false } as never,
      { idempotencyKey: 'off-1' },
    )
    const created = await reportApproval('rpc-off-2', 'emp_auto_1')
    assert.equal(hub.state().approvals[created.approvalId]?.status, 'pending')

    const listed = (await operator.call('employee.list', {})) as {
      employees: Array<{ id: string; autoApprove?: boolean }>
    }
    assert.equal(listed.employees.find((e) => e.id === 'emp_auto_1')?.autoApprove, false)
  })
})
