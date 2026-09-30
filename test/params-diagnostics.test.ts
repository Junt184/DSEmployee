/**
 * 「参数不合法」必须说清是哪个字段、错在哪。
 *
 * 为什么专门守这一条（真实事故）：用户改分组时吃到一句
 *   `position.upsert 失败：invalid params for position.upsert`
 * —— 字段没说是哪个，原因是太长、多余还是格式不对也没说，服务端更是一个字都没记。
 * 结果是：看界面的人只能把它当噪声，排障的人无法复查（details.issues 一直带着完整信息，
 * 只是没人把它变成人话）。
 *
 * 这一组同时守两件事：
 *   1. 消息里带**字段路径 + 原因**（而不是那句含糊话）；
 *   2. 被拒的调用在 Hub 日志里**留痕**（method + 谁调的 + 为什么，但**不记 params**）。
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
/** Hub 这一进程打过的日志（用来断言"被拒的调用留痕了"） */
let logs: string[] = []

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-params-'))
  home = path.join(tmpRoot, 'home')
  hub = new Hub({ home, port: 0, verbose: false })
  const originalLog = hub.log.bind(hub)
  hub.log = (message: string): void => {
    logs.push(message)
    originalLog(message)
  }
  const address = await hub.start()
  hubUrl = address.wsUrl

  /* 配一台 operator（走本机批准路径，与 CLI 同一条路） */
  const make = async (): Promise<HubClient> =>
    await HubClient.create({
      identityFile: path.join(home, 'clients', 'op.json'),
      url: hubUrl,
      role: 'operator',
      scopes: ['employee.read', 'employee.manage', 'device.pair'] as never,
      clientId: 'dse-cli',
      displayName: 'op-params',
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
    approvedScopes: ['employee.read', 'employee.manage', 'device.pair'] as never,
  })
  operator = await make()
  await operator.connect()
})

after(async () => {
  operator.close()
  await hub.stop()
  await rm(tmpRoot, { recursive: true, force: true })
})

interface Failure {
  code: string
  message: string
}

/** 调一个必定失败的方法，把错误原样拿回来（不 assert.rejects：这里要看内容）。 */
async function failureOf(method: string, params: unknown): Promise<Failure> {
  try {
    await operator.call(method, params as never, { idempotencyKey: `k-${method}-${logs.length}` })
  } catch (error) {
    const shape = error as { code?: string; message?: string }
    return { code: String(shape.code ?? ''), message: String(shape.message ?? '') }
  }
  throw new Error(`${method} 竟然成功了 —— 这条用例的目的是看"参数被拒"时的说法`)
}

describe('参数校验失败：说法要能直接指向要改的那个字段', () => {
  it('值超上限 ⇒ 报字段名与上限，而不是一句 invalid params', () => {
    return failureOf('position.upsert', { name: 'x'.repeat(40) }).then((failure) => {
      assert.equal(failure.code, 'bad-request')
      assert.match(failure.message, /invalid params for position\.upsert/)
      assert.match(failure.message, /name/, '必须点名是哪个字段')
      assert.match(failure.message, /40|32/, '必须给出上限（32）或实际值')
      assert.notEqual(
        failure.message.trim(),
        'invalid params for position.upsert',
        '这正是事故里那句无从下手的话 —— 不许再出现',
      )
    })
  })

  it('多给了字段 ⇒ 明确说是哪个多余字段（拼错的键会静默为空，必须响）', async () => {
    const failure = await failureOf('position.upsert', { name: '红队', cells: { left: ['a'] } })
    assert.equal(failure.code, 'bad-request')
    assert.match(failure.message, /cells/)
    assert.match(failure.message, /left/)
  })

  it('类型不对 / 字段缺失也会各说各的', async () => {
    const wrongType = await failureOf('position.upsert', { name: 123 })
    assert.match(wrongType.message, /name/)
    const missing = await failureOf('position.upsert', {})
    assert.match(missing.message, /name/)
  })
})

describe('被拒的调用要在日志里留痕（但不许把 params 写进日志）', () => {
  it('参数被拒 ⇒ 服务端记下"哪个方法、谁调的、为什么"', async () => {
    logs = []
    const secret = 'sk-不应该出现在日志里的东西'
    const failure = await failureOf('position.upsert', { name: 'x'.repeat(40), apiKey: secret })
    assert.equal(failure.code, 'bad-request')
    const hit = logs.filter((line) => line.includes('rejected position.upsert'))
    assert.equal(hit.length, 1, `应当恰好留痕一条，实际 ${hit.length} 条：${logs.join(' | ')}`)
    assert.match(hit[0] ?? '', /bad-request/)
    assert.match(hit[0] ?? '', /name/, '日志要含原因，才不用去猜')
    assert.doesNotMatch(hit[0] ?? '', new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '日志里不许出现请求内容')
  })

  it('正常业务错误（如 not-found）不记日志 —— 否则真实问题会被正常操作淹掉', async () => {
    logs = []
    const failure = await failureOf('position.remove', { id: 'pos_nonexistent' })
    assert.equal(failure.code, 'not-found')
    assert.deepEqual(
      logs.filter((line) => line.includes('rejected')),
      [],
    )
  })
})
