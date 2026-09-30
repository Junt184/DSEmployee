/**
 * LLM 端点库（Hub 级）的语义测试。
 *
 * 用户要的是"BaseURL + Key 输一次、多个员工复用、改一处全场生效"——
 * 所以这里守三件最要紧的事：
 *   1. **密钥只往下游传，绝不回给界面**（视图里只有掩码）；
 *   2. **还在被用的端点不许删**，而且报错要点名是谁在用（否则删完就是"某个员工某天开始全部 401"）；
 *   3. **改了 BaseURL/Key 要同步到所有在用的员工**，同步失败逐个点名（节点离线是常态，不能假装成功）。
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

interface EndpointView {
  id: string
  name: string
  apiUrl: string
  hasKey: boolean
  keyMask?: string
  models: string[]
  usedBy: Array<{ employeeId: string; name: string }>
}

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-llm-ep-'))
  home = path.join(tmpRoot, 'home')
  hub = new Hub({ home, port: 0, verbose: false })
  const address = await hub.start()
  hubUrl = address.wsUrl

  const make = async (): Promise<HubClient> =>
    await HubClient.create({
      identityFile: path.join(home, 'clients', 'op.json'),
      url: hubUrl,
      role: 'operator',
      scopes: ['employee.read', 'employee.manage'] as never,
      clientId: 'dse-cli',
      displayName: 'op-llm',
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
    approvedScopes: ['employee.read', 'employee.manage'] as never,
  })
  operator = await make()
  await operator.connect()
})

after(async () => {
  operator.close()
  await hub.stop()
  await rm(tmpRoot, { recursive: true, force: true })
})

/** 直接往 Hub 状态里摆一个员工（端点库的"谁在用"取自员工目录里的注册摘要）。 */
function seedEmployee(employeeId: string, name: string, endpointIds: string[]): void {
  hub.state().employees[employeeId] = {
    id: employeeId,
    nodeId: 'node-x',
    name,
    role: '',
    workspacePath: `/tmp/${name}`,
    skills: [],
    status: 'ok',
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    llmEndpointIds: endpointIds,
  }
}

async function upsert(params: Record<string, unknown>): Promise<{ endpoint: EndpointView; synced: unknown[] }> {
  return (await operator.call('llm.endpoint.upsert', params as never, {
    idempotencyKey: `ep-${Math.random()}`,
  })) as { endpoint: EndpointView; synced: unknown[] }
}

describe('端点库：输一次、多员工复用', () => {
  it('新增后能列出来，且**只回掩码**', async () => {
    const created = await upsert({
      name: 'noelle',
      apiUrl: 'https://noelle.example.com/v1',
      apiKey: 'sk-1234567890abcdef',
      models: ['gpt5.6'],
    })
    assert.equal(created.endpoint.name, 'noelle')
    assert.equal(created.endpoint.hasKey, true)
    assert.equal(created.endpoint.keyMask, 'sk-…cdef')
    assert.deepEqual(created.endpoint.models, ['gpt5.6'])
    assert.equal(JSON.stringify(created).includes('sk-1234567890abcdef'), false, '回给界面的东西里不许有完整 key')

    const listed = (await operator.call('llm.endpoint.list', {})) as { endpoints: EndpointView[] }
    const hit = listed.endpoints.find((entry) => entry.id === created.endpoint.id)
    assert.ok(hit !== undefined)
    assert.equal(hit.keyMask, 'sk-…cdef')
    assert.equal(JSON.stringify(listed).includes('sk-1234567890abcdef'), false)
  })

  it('同名端点被拒（库里的名字是给人认的，重名等于没有名字）', async () => {
    await assert.rejects(
      () =>
        operator.call(
          'llm.endpoint.upsert',
          { name: 'noelle', apiUrl: 'https://other.example.com/v1' } as never,
          { idempotencyKey: 'dupe' },
        ),
      /已被另一条用了/,
    )
  })

  it('URL 策略与员工级一致：只允许 http/https', async () => {
    await assert.rejects(
      () =>
        operator.call(
          'llm.endpoint.upsert',
          { name: '坏端点', apiUrl: 'file:///etc/passwd' } as never,
          { idempotencyKey: 'bad-url' },
        ),
      /只允许 http\/https/,
    )
  })

  it('还有员工在用 ⇒ 拒绝删除并点名是谁', async () => {
    const created = await upsert({ name: '待删', apiUrl: 'https://del.example.com/v1' })
    seedEmployee('emp_use_1', '小明', [created.endpoint.id])
    seedEmployee('emp_use_2', '椰椰', [created.endpoint.id])

    const listed = (await operator.call('llm.endpoint.list', {})) as { endpoints: EndpointView[] }
    const view = listed.endpoints.find((entry) => entry.id === created.endpoint.id)
    assert.equal(view?.usedBy.length, 2, '"谁在用"要能算出来（取自员工注册摘要）')

    await assert.rejects(
      () =>
        operator.call('llm.endpoint.remove', { id: created.endpoint.id } as never, {
          idempotencyKey: 'del-in-use',
        }),
      (error: unknown) => {
        const message = String((error as { message?: string }).message ?? '')
        assert.match(message, /还有 2 个员工在用/)
        assert.match(message, /小明/)
        assert.match(message, /椰椰/)
        return true
      },
    )

    /* 把两个员工改到别的端点后就能删了 */
    seedEmployee('emp_use_1', '小明', [])
    seedEmployee('emp_use_2', '椰椰', [])
    const removed = (await operator.call('llm.endpoint.remove', { id: created.endpoint.id } as never, {
      idempotencyKey: 'del-ok',
    })) as { removed: string }
    assert.equal(removed.removed, created.endpoint.id)
    const after = (await operator.call('llm.endpoint.list', {})) as { endpoints: EndpointView[] }
    assert.equal(after.endpoints.some((entry) => entry.id === created.endpoint.id), false)
  })

  it('删不存在的端点报 not-found（不静默成功）', async () => {
    await assert.rejects(
      () =>
        operator.call('llm.endpoint.remove', { id: 'ep_nope' } as never, { idempotencyKey: 'del-none' }),
      /unknown endpoint/,
    )
  })

  it('改了 BaseURL 或 Key ⇒ 同步到所有在用的员工；节点离线则逐个点名', async () => {
    const created = await upsert({ name: '要改的', apiUrl: 'https://before.example.com/v1', apiKey: 'sk-old-0000' })
    /* 员工挂在 node-x 上，而 node-x 从没连过 —— 同步必然失败，正好验证"如实点名" */
    seedEmployee('emp_sync_1', '小艾', [created.endpoint.id])

    const updated = await upsert({
      id: created.endpoint.id,
      name: '要改的',
      apiUrl: 'https://after.example.com/v1',
      apiKey: 'sk-brandnew-9999',
    })
    assert.equal(updated.endpoint.apiUrl, 'https://after.example.com/v1')
    assert.equal(updated.endpoint.keyMask, 'sk-…9999', '换 key 后掩码要跟着变（确认真的换掉了）')
    assert.equal(updated.synced.length, 1, '在用的员工都要试着同步')
    const first = updated.synced[0] as { name: string; ok: boolean }
    assert.equal(first.name, '小艾')
    assert.equal(first.ok, false, '节点不在线 ⇒ 如实报失败，而不是假装同步好了')

    /* 只改名字不该打扰任何节点 */
    seedEmployee('emp_sync_1', '小艾', [created.endpoint.id])
    const renamed = await upsert({
      id: created.endpoint.id,
      name: '改过名的',
      apiUrl: 'https://after.example.com/v1',
      apiKey: 'sk-brandnew-9999',
    })
    assert.deepEqual(renamed.synced, [], '只改名字不必同步')
  })

  it('apiKey 留空 = 不改动已保存的那把（界面上密码框留空的语义）', async () => {
    const created = await upsert({ name: '留空测试', apiUrl: 'https://keep.example.com/v1', apiKey: 'sk-keepme-1234' })
    const updated = await upsert({
      id: created.endpoint.id,
      name: '留空测试',
      apiUrl: 'https://keep.example.com/v1',
    })
    assert.equal(updated.endpoint.hasKey, true, 'key 应当还在')
    assert.equal(updated.endpoint.keyMask, 'sk-…1234')
  })
})
