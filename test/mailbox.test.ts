/**
 * 离线邮箱：节点离线时把"结果不靠返回值"的请求存下来，节点回来按序送出。
 *
 * 这一组重点守三条语义（写错任何一条都会造成"指令丢失"或"指令重复"）：
 *   1. **只排队该排的**：`session.prompt` 排队；读类方法（`employee.skills.list` 之类）与
 *      "调用方必须拿到返回值"的方法（`session.create` / `employee.invoke`）仍然立即失败 ——
 *      排队会让调用方拿着空洞的成功往前走，比立刻报错更糟。
 *   2. **顺序即语义**：同一节点的待办按入队时间投递；节点整条离线时整批留到下次。
 *   3. **结果未知不无限重试**：超时这类失败记 attempts，达上限后停手 ——
 *      宁可留在队列里被体检显示出来，也不制造重复指令。
 *
 * 投递规则用**假 Hub** 直接跑（可以精确编排 requestToNode 的返回），
 * 端到端那条（离线 → 入队 → 节点上线 → 真的收到）用真 Hub 握手跑。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import { HubClient } from '../src/client/hub-client.ts'
import { approvePairing } from '../src/hub/devices.ts'
import {
  MAILBOX_MAX_ATTEMPTS,
  MAILBOX_MAX_PER_NODE,
  enqueueForNode,
  flushMailbox,
  mailboxItemsFor,
  pruneMailbox,
} from '../src/hub/mailbox.ts'
import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import type { MailboxItem } from '../src/hub/types.ts'

/* ────────────────── 假 Hub：精确编排投递结果 ────────────────── */

interface FakeHub {
  state: () => { mailbox: Record<string, MailboxItem>; nodes: Record<string, unknown> }
  requestToNode: (nodeId: string, method: string, params: unknown) => Promise<unknown>
  store: { saveMailbox: () => Promise<void> }
  log: (message: string) => void
}

function makeFakeHub(
  responses: Array<{ ok: boolean; payload?: unknown; error?: { code: string; message?: string } }>,
): { hub: FakeHub; delivered: Array<{ method: string; params: unknown }>; logs: string[] } {
  const mailbox: Record<string, MailboxItem> = {}
  const delivered: Array<{ method: string; params: unknown }> = []
  const logs: string[] = []
  let index = 0
  const hub: FakeHub = {
    state: () => ({ mailbox, nodes: {} }),
    requestToNode: async (_nodeId, method, params) => {
      delivered.push({ method, params })
      const scripted = responses[index] ?? responses[responses.length - 1]
      index += 1
      return scripted ?? { ok: true, payload: {} }
    },
    store: { saveMailbox: async () => undefined },
    log: (message) => void logs.push(message),
  }
  return { hub, delivered, logs }
}

const NODE = 'node-a'
const asHub = (fake: FakeHub): never => fake as unknown as never

describe('离线邮箱：投递规则（假 Hub）', () => {
  it('异步互调投递时加 async 标记，节点确认接收后出队', async () => {
    const { hub, delivered } = makeFakeHub([{ ok: true, payload: { accepted: true } }])
    await enqueueForNode(asHub(hub), NODE, 'employee.invoke', {
      invokeId: 'inv-1',
      fromEmployeeId: 'emp-a',
      toEmployeeId: 'emp-b',
      task: '做一件事',
    })

    const result = await flushMailbox(asHub(hub), NODE)
    assert.equal(result.delivered, 1)
    assert.equal((delivered[0]?.params as Record<string, unknown>)['async'], true)
    assert.equal(mailboxItemsFor(hub.state() as never, NODE).length, 0)
  })

  it('投递成功即出队，且按入队顺序', async () => {
    const { hub, delivered } = makeFakeHub([{ ok: true, payload: {} }, { ok: true, payload: {} }])
    await enqueueForNode(asHub(hub), NODE, 'session.prompt', { text: '第一条' })
    await enqueueForNode(asHub(hub), NODE, 'session.prompt', { text: '第二条' })

    const result = await flushMailbox(asHub(hub), NODE)
    assert.equal(result.delivered, 2)
    assert.equal(result.remaining, 0)
    assert.deepEqual(
      delivered.map((item) => (item.params as { text: string }).text),
      ['第一条', '第二条'],
      '必须按用户发送顺序投递',
    )
    assert.deepEqual(mailboxItemsFor(hub.state() as never, NODE), [])
  })

  it('投递时节点又离线 → 整批留下，不记 attempts（不是这条的问题）', async () => {
    const { hub } = makeFakeHub([
      { ok: true, payload: {} },
      { ok: false, error: { code: 'node-offline', message: 'gone again' } },
    ])
    await enqueueForNode(asHub(hub), NODE, 'session.prompt', { text: 'A' })
    await enqueueForNode(asHub(hub), NODE, 'session.prompt', { text: 'B' })

    const first = await flushMailbox(asHub(hub), NODE)
    assert.equal(first.delivered, 1)
    assert.equal(first.skippedOffline, 1)
    const left = mailboxItemsFor(hub.state() as never, NODE)
    assert.equal(left.length, 1)
    assert.equal(left[0]?.attempts, 0, '节点离线不该记成这条的失败')
  })

  it('结果未知（超时等）→ 记 attempts，到上限后不再重试', async () => {
    const { hub } = makeFakeHub([{ ok: false, error: { code: 'timeout', message: 'no answer' } }])
    const { item } = await enqueueForNode(asHub(hub), NODE, 'session.prompt', { text: 'C' })

    for (let round = 1; round <= MAILBOX_MAX_ATTEMPTS; round += 1) {
      const result = await flushMailbox(asHub(hub), NODE)
      assert.equal(result.uncertain, 1, `第 ${round} 轮应当记为"结果未知"`)
      assert.equal(hub.state().mailbox[item.mailId]?.attempts, round)
    }
    const after = await flushMailbox(asHub(hub), NODE)
    assert.equal(after.uncertain, 0, '达上限后不再投递')
    assert.equal(after.giveUp, 1)
    const kept = hub.state().mailbox[item.mailId]
    assert.ok(kept !== undefined, '不静默丢弃：留在队列里让体检显示出来')
    assert.equal(kept?.lastError, 'no answer', '失败原因要留下')
  })

  it('队列有界：满了丢最旧的一条并如实上报', async () => {
    const { hub } = makeFakeHub([{ ok: true, payload: {} }])
    for (let i = 0; i < MAILBOX_MAX_PER_NODE; i += 1) {
      await enqueueForNode(asHub(hub), NODE, 'session.prompt', { text: `#${i}` })
    }
    const overflow = await enqueueForNode(asHub(hub), NODE, 'session.prompt', { text: '最新一条' })
    assert.equal(overflow.dropped.length, 1, '要上报丢了哪一条')
    assert.equal((overflow.dropped[0]?.params as { text: string }).text, '#0', '丢的是最旧的')
    const left = mailboxItemsFor(hub.state() as never, NODE)
    assert.equal(left.length, MAILBOX_MAX_PER_NODE)
    assert.equal((left[left.length - 1]?.params as { text: string }).text, '最新一条')
  })

  it('超龄条目在入队与投递时被清掉（陈旧指令不该几天后突然发出去）', async () => {
    const { hub } = makeFakeHub([{ ok: true, payload: {} }])
    const { item } = await enqueueForNode(asHub(hub), NODE, 'session.prompt', { text: '陈年旧事' })
    // 手工把它改成 25 小时前
    const stored = hub.state().mailbox[item.mailId]
    assert.ok(stored !== undefined)
    stored.createdAtMs = Date.now() - 25 * 60 * 60 * 1000
    const dropped = pruneMailbox(hub.state() as never)
    assert.equal(dropped.length, 1)
    assert.equal(mailboxItemsFor(hub.state() as never, NODE).length, 0)
  })
})

/* ────────────────── 端到端：真 Hub 握手 ────────────────── */

let tmpRoot = ''
let hub: Hub
let hubUrl = ''
let home = ''

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-mailbox-'))
  home = path.join(tmpRoot, 'home')
  hub = new Hub({ home, port: 0, verbose: false })
  const address = await hub.start()
  hubUrl = address.wsUrl
})

after(async () => {
  await hub.stop()
  await rm(tmpRoot, { recursive: true, force: true })
})

function makeClient(name: string, role: 'operator' | 'node', scopes: string[]): Promise<HubClient> {
  return HubClient.create({
    identityFile: path.join(home, 'test-clients', `${name}.json`),
    url: hubUrl,
    role,
    scopes: scopes as never,
    clientId: role === 'node' ? 'dse-node' : 'dse-cli',
    displayName: name,
    autoReconnect: false,
  })
}

async function approvedOperator(name: string, scopes: string[]): Promise<HubClient> {
  const first = await makeClient(name, 'operator', scopes)
  await assert.rejects(() => first.connect())
  first.close()
  const store = new HubStore(home)
  await store.load()
  const pending = Object.values(store.state().pending).find(
    (request) => request.deviceId === first.identity.deviceId,
  )
  assert.ok(pending !== undefined)
  await approvePairing(store, pending.requestId, 'test', { approvedScopes: scopes as never })
  const second = await makeClient(name, 'operator', scopes)
  await second.connect()
  return second
}

describe('离线邮箱：端到端（真 Hub）', () => {
  it('节点离线时 session.prompt 入队；节点上线后自动送出并清空队列', async () => {
    const viewer = await approvedOperator('op-mailbox', ['employee.read', 'employee.prompt'])
    // 先注册一个节点（拿到 nodeId 与员工目录）
    const node = await makeClient('node-mailbox', 'node', [])
    const hello = await node.connect()
    /* 首次连接会签发设备令牌；重连必须带上它（已配对设备无令牌会被拒） */
    const token = hello.auth.deviceToken ?? ''
    await node.call(
      'node.register',
      {
        name: '邮箱节点',
        platform: 'test',
        employeeRoot: '/tmp/fake-employees',
        employees: [
          {
            id: 'emp_mail_1',
            name: '收件人',
            role: '测试',
            workspacePath: '/tmp/fake-employees/inbox',
            skills: [],
            status: 'ok',
            createdAtMs: 1,
          },
        ],
      },
      { idempotencyKey: 'reg-mailbox' },
    )

    /* 节点下线：prompt 应当入队，而不是报 node-offline */
    node.close()
    await new Promise((resolve) => setTimeout(resolve, 250))
    const queued = await viewer.call<{ queued?: boolean; mailId?: string; queueLength?: number }>(
      'session.prompt',
      { employeeId: 'emp_mail_1', sessionId: 'session-x', text: '离线时发的指令' },
      { idempotencyKey: 'prompt-offline-1' },
    )
    assert.equal(queued.queued, true, '离线时的 prompt 应当入队')
    assert.equal(queued.queueLength, 1)

    /* 读类方法不进队列：它需要立刻拿到数据，排队只会让界面显示空洞的成功 */
    await assert.rejects(
      () => viewer.call('employee.skills.list', { employeeId: 'emp_mail_1' }),
      (error: unknown) => (error as { code?: string }).code === 'node-offline',
      '读类方法必须仍然立即失败',
    )

    /* 节点回来：握手时自动投递 */
    const back = await HubClient.create({
      identityFile: path.join(home, 'test-clients', 'node-mailbox.json'),
      url: hubUrl,
      role: 'node',
      scopes: [] as never,
      clientId: 'dse-node',
      displayName: 'node-mailbox',
      autoReconnect: false,
      ...(token === '' ? {} : { token }),
    })
    const received: Array<Record<string, unknown>> = []
    back.on('request', (frame) => {
      received.push({ method: frame.method, ...(frame.params as Record<string, unknown>) })
      back.respond(frame.id, { ok: true, payload: { delivered: true } })
    })
    await back.connect()
    await new Promise((resolve) => setTimeout(resolve, 600))

    assert.equal(received.length, 1, '队列里的那条应当在节点上线时被送出')
    assert.equal(received[0]?.method, 'session.prompt')
    assert.equal(received[0]?.text, '离线时发的指令')
    assert.equal(received[0]?.sessionId, 'session-x')

    /* 队列清空（Hub 侧状态 + 磁盘） */
    const store = new HubStore(home)
    await store.load()
    const left = Object.values(store.state().mailbox)
    assert.equal(left.length, 0, '投递成功后必须出队')

    back.close()
    viewer.close()
  })
})
