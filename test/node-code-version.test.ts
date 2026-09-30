/**
 * 节点代码指纹与控制台「体检」的数据面（真 Hub + 真 WebSocket 握手）。
 *
 * 守的是一条以前**没有**的能力：节点跑的是不是同一份代码，能不能被机器自己回答。
 * 之所以要有测试：这条链路两端都在"手动升级"的现实里工作（节点 git pull + 重启），
 * 而分叉本身不报错 —— 一旦比对逻辑写错（比如老节点不报字段时被判成"一致"），
 * 症状就会退回到"界面上一切正常，只是某台机器少了一半能力"。
 *
 * 三种状态必须都能出现，且**老节点必须落在 unknown**：
 *   match（内容一致）/ mismatch（跑的是旧代码）/ unknown（没上报，不假装一致）。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import { HubClient } from '../src/client/hub-client.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { currentCodeFingerprint } from '../src/protocol/build.ts'

interface NodeView {
  name: string
  codeVersion?: string
  codeStatus: 'match' | 'mismatch' | 'unknown'
  employeeCount: number
}

let tmpRoot = ''
let hub: Hub
let hubUrl = ''
let home = ''

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-code-version-'))
  home = path.join(tmpRoot, 'home')
  hub = new Hub({ home, port: 0, verbose: false })
  const address = await hub.start()
  hubUrl = address.wsUrl
})

after(async () => {
  await hub.stop()
  await rm(tmpRoot, { recursive: true, force: true })
})

function makeClient(
  name: string,
  role: 'operator' | 'node',
  scopes: string[],
): Promise<HubClient> {
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

/** 走完"先连一次拿待审批 → 本地批准 → 带令牌重连"的既有套路。 */
async function approvedOperator(name: string, scopes: string[]): Promise<HubClient> {
  const first = await makeClient(name, 'operator', scopes)
  await assert.rejects(() => first.connect())
  first.close()

  const store = new HubStore(home)
  await store.load()
  const pending = Object.values(store.state().pending).find(
    (request) => request.deviceId === first.identity.deviceId,
  )
  assert.ok(pending !== undefined, '待审批请求应当留在台账里')
  await approvePairing(store, pending.requestId, 'test', {
    approvedScopes: scopes as never,
  })

  const second = await makeClient(name, 'operator', scopes)
  await second.connect()
  return second
}

describe('节点代码指纹', () => {
  it('match / mismatch / unknown 三态都对，且老节点不报字段时算 unknown', async () => {
    const hubCode = currentCodeFingerprint()
    assert.equal(typeof hubCode, 'string', '测试进程应当能算出本仓库指纹')

    const node = await makeClient('node-code', 'node', [])
    await node.connect()
    const register = async (codeVersion?: string): Promise<void> => {
      await node.call(
        'node.register',
        {
          name: '代码版本节点',
          platform: 'test',
          employeeRoot: '/tmp/fake-employees',
          ...(codeVersion === undefined ? {} : { codeVersion }),
          employees: [],
        },
        { idempotencyKey: `reg-${Math.random()}` },
      )
    }
    const viewer = await approvedOperator('op-code-viewer', ['employee.read'])
    const readNode = async (): Promise<{ hubCodeVersion: string | null; record: NodeView }> => {
      const payload = await viewer.call<{ hubCodeVersion: string | null; nodes: NodeView[] }>(
        'node.list',
        {},
      )
      const record = payload.nodes.find((item) => item.name === '代码版本节点')
      assert.ok(record !== undefined, 'node.list 里应当有刚注册的节点')
      return { hubCodeVersion: payload.hubCodeVersion, record }
    }

    // 1) 跑着别的代码
    await register('some-old-code')
    const mismatched = await readNode()
    assert.equal(mismatched.hubCodeVersion, hubCode, '控制台要知道 Hub 自己的指纹')
    assert.equal(mismatched.record.codeVersion, 'some-old-code')
    assert.equal(mismatched.record.codeStatus, 'mismatch')

    // 2) 与 Hub 一致
    await register(hubCode)
    assert.equal((await readNode()).record.codeStatus, 'match')

    // 3) 老节点（升级前）不报这个字段 → unknown，**不能**被当成一致
    await register(undefined)
    const unknown = await readNode()
    assert.equal(unknown.record.codeVersion, undefined)
    assert.equal(unknown.record.codeStatus, 'unknown')

    node.close()
    viewer.close()
  })
})

describe('员工工作区锚点上报', () => {
  it('hasGitAnchor 随 node.register 落库并随 employee.list 带出', async () => {
    const node = await makeClient('node-anchor', 'node', [])
    await node.connect()
    await node.call(
      'node.register',
      {
        name: '锚点节点',
        platform: 'test',
        employeeRoot: '/tmp/fake-employees',
        employees: [
          {
            id: 'emp_anchor_yes',
            name: '有锚点',
            role: '测试',
            workspacePath: '/tmp/fake-employees/yes',
            hasGitAnchor: true,
            skills: [],
            status: 'ok',
            createdAtMs: 1,
          },
          {
            id: 'emp_anchor_no',
            name: '没锚点',
            role: '测试',
            workspacePath: '/tmp/fake-employees/no',
            hasGitAnchor: false,
            skills: ['private-one'],
            status: 'ok',
            createdAtMs: 1,
          },
        ],
      },
      { idempotencyKey: 'reg-anchor' },
    )

    const viewer = await approvedOperator('op-anchor-viewer', ['employee.read'])
    const listed = await viewer.call<{
      employees: Array<{ id: string; hasGitAnchor?: boolean; skills: string[] }>
    }>('employee.list')
    const withAnchor = listed.employees.find((item) => item.id === 'emp_anchor_yes')
    const withoutAnchor = listed.employees.find((item) => item.id === 'emp_anchor_no')
    assert.equal(withAnchor?.hasGitAnchor, true)
    assert.equal(withoutAnchor?.hasGitAnchor, false)
    assert.deepEqual(withoutAnchor?.skills, ['private-one'], '技能清单本身照旧要报')

    node.close()
    viewer.close()
  })
})
