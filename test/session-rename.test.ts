/**
 * session.rename 与 session.create 可选命名的契约与节点侧行为测试。
 *
 * 三层覆盖（写法对齐 test/session-compact.test.ts）：
 *   1. 方法表条目（scopes / route / idempotent / roles）—— 权限契约钉死在 methods.ts；
 *   2. 节点 dispatch —— 进程内假 dsh（HTTP 层）+ 真实 Hub + 真实 NodeAgent；
 *   3. 经真 Hub 的端到端透传（operator 客户端 → forwarder → 节点 → 假 dsh）。
 *
 * 假 dsh 的应答形状逐字对齐实测（dsh 0.1.0-rc.6）：
 *   - session.create 的 payload 里塞 title 会被**静默忽略**（不落标题）——
 *     所以节点侧绝不能把 title 塞进 create，命名必须是第二步 session.rename；
 *   - session.rename 收 {sessionId, title} → 回 {title, seq}，持久化生效；
 *   - sessionId 不存在：业务错误 session-not-found（HTTP 200 + result.ok:false）。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { HubClient, HubCallError } from '../src/client/hub-client.ts'
import { NodeAgent } from '../src/node/agent.ts'
import { METHODS } from '../src/protocol/methods.ts'

/** 假 dsh 对 session.rename 的可编程应答。 */
let renameReply:
  | { kind: 'value'; value: unknown } // ok:true 且带 value（{title, seq}）
  | { kind: 'api-error'; code: string; message: string } = {
  kind: 'value',
  value: { title: '占位标题', seq: 1 },
}

/** 假 dsh 记下的每一次 session.rename / session.create payload。 */
const renamePayloads: Array<Record<string, unknown>> = []
const sessionCreatePayloads: Array<Record<string, unknown>> = []

let tmpRoot = ''
let employeeRoot = ''
let hub: Hub
let hubUrl = ''
let dshServer: Server
let dshPort = 0
let agent: NodeAgent
let operator: HubClient | undefined

const EMP = 'emp_rename'

async function writeEmployee(slug: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = path.join(employeeRoot, slug, '.dsemployee')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'employee.json'), JSON.stringify(manifest), 'utf8')
}

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-rename-test-'))

  hub = new Hub({ home: path.join(tmpRoot, 'hub-home'), port: 0, verbose: false })
  hubUrl = (await hub.start()).wsUrl

  // 假 dsh：只实现 NodeAgent 启动与本测试用到的端点；WS 下行流直接断开（节点只记日志）
  dshServer = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const frame = JSON.parse(body) as { rpcId: string; payload?: Record<string, unknown> }
      const reply = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: frame.rpcId, result }))
      }
      switch ((req.url ?? '').replace(/^\/api\//, '')) {
        case 'host.describe':
          return reply({
            ok: true,
            value: {
              version: '0.0.1-fake',
              cwd: employeeRoot,
              provider: 'test',
              model: 'test',
              attachedSessions: 0,
              canOpenPath: false,
            },
          })
        case 'workspace.list':
          return reply({ ok: true, value: { items: [], archivedSessionIds: [] } })
        case 'workspace.create':
          return reply({ ok: true, value: { workspaceId: 'ws_fake' } })
        case 'session.list':
          return reply({ ok: true, value: { items: [] } })
        case 'session.create':
          sessionCreatePayloads.push(frame.payload ?? {})
          return reply({
            ok: true,
            value: { sessionId: `sess_fake_${sessionCreatePayloads.length}` },
          })
        case 'session.rename':
          renamePayloads.push(frame.payload ?? {})
          if (renameReply.kind === 'api-error') {
            return reply({
              ok: false,
              error: { code: renameReply.code, message: renameReply.message, details: {} },
            })
          }
          return reply({ ok: true, value: renameReply.value })
        default:
          return reply({ ok: true, value: {} })
      }
    })
  })
  dshServer.on('upgrade', (socket) => socket.destroy())
  await new Promise<void>((resolve) => dshServer.listen(0, '127.0.0.1', resolve))
  const address = dshServer.address()
  dshPort = typeof address === 'object' && address !== null ? address.port : 0

  employeeRoot = path.join(tmpRoot, 'employees')
  await writeEmployee('aaa-rename', {
    id: EMP,
    name: '命名测试员工',
    role: '测试',
    createdAtMs: Date.now(),
  })

  agent = new NodeAgent({
    home: path.join(tmpRoot, 'node-home'),
    hubUrl,
    name: 'rename-test-node',
    employeeRoot,
    manageDsh: false,
    attachPort: dshPort,
  })
  await agent.start()
})

after(async () => {
  operator?.close()
  await agent.stop()
  await hub.stop()
  dshServer.closeAllConnections()
  await new Promise<void>((resolve) => dshServer.close(() => resolve()))
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('方法表契约', () => {
  it('session.rename 条目：employee.prompt scope、路由到节点、幂等、仅 operator', () => {
    const spec = METHODS['session.rename']
    assert.deepEqual(spec.scopes, ['employee.prompt'])
    assert.equal(spec.route, 'node')
    assert.equal(spec.idempotent, true)
    assert.deepEqual(spec.roles, ['operator'])
    assert.equal(spec.summary, '重命名一个会话')
  })

  it('session.create 条目注明可选命名', () => {
    assert.match(METHODS['session.create'].summary, /可选命名/)
  })
})

describe('节点侧 session.rename', () => {
  const rename = (params: Record<string, unknown>): Promise<unknown> =>
    agent.dispatch('session.rename', params)

  it('dsh 回 {title, seq} → 原样透传；发往 dsh 的 title 是 trim 后的', async () => {
    renameReply = { kind: 'value', value: { title: '周报助手', seq: 7 } }
    const result = await rename({ employeeId: EMP, sessionId: 'sess_fake_1', title: '  周报助手  ' })
    assert.deepEqual(result, { title: '周报助手', seq: 7 })
    assert.deepEqual(renamePayloads.at(-1), { sessionId: 'sess_fake_1', title: '周报助手' })
  })

  it('title 空白（空串 / 纯空格）→ 拒绝，请求不会发到 dsh', async () => {
    const beforeCalls = renamePayloads.length
    await assert.rejects(
      () => rename({ employeeId: EMP, sessionId: 'sess_fake_1', title: '' }),
      /title/,
    )
    await assert.rejects(
      () => rename({ employeeId: EMP, sessionId: 'sess_fake_1', title: '   ' }),
      /empty/,
    )
    await assert.rejects(
      () => rename({ employeeId: EMP, sessionId: 'sess_fake_1' }),
      /title/,
    )
    assert.equal(renamePayloads.length, beforeCalls, '非法 title 不应触达 dsh')
  })

  it('title 超 200 字符 → 拒绝，请求不会发到 dsh', async () => {
    const beforeCalls = renamePayloads.length
    await assert.rejects(
      () => rename({ employeeId: EMP, sessionId: 'sess_fake_1', title: '长'.repeat(201) }),
      /200/,
    )
    assert.equal(renamePayloads.length, beforeCalls, '超长 title 不应触达 dsh')
  })

  it('200 字符整 → 放行（边界值）', async () => {
    renameReply = { kind: 'value', value: { title: '界'.repeat(200), seq: 8 } }
    const result = await rename({
      employeeId: EMP,
      sessionId: 'sess_fake_1',
      title: '界'.repeat(200),
    })
    assert.deepEqual(result, { title: '界'.repeat(200), seq: 8 })
  })

  it('员工不属于本节点 → 拒绝，不会把请求发给 dsh', async () => {
    const beforeCalls = renamePayloads.length
    await assert.rejects(
      () => rename({ employeeId: 'emp_stranger', sessionId: 'sess_fake_1', title: '改名' }),
      /unknown employee/,
    )
    assert.equal(renamePayloads.length, beforeCalls, '陌生员工的 rename 不应触达 dsh')
  })

  it('dsh 业务错误（session-not-found）→ 抛错回传，而不是伪装成结果值', async () => {
    renameReply = { kind: 'api-error', code: 'session-not-found', message: 'session "x" not found' }
    await assert.rejects(
      () => rename({ employeeId: EMP, sessionId: 'sess_gone', title: '改名' }),
      /not found/,
    )
  })
})

describe('session.create 的可选命名（两步法）', () => {
  it('带 title：create payload 不含 title（dsh 会静默忽略），创建成功后第二步 rename 落名', async () => {
    renameReply = { kind: 'value', value: { title: '例会纪要员', seq: 9 } }
    const createCallsBefore = sessionCreatePayloads.length
    const renameCallsBefore = renamePayloads.length

    const result = (await agent.dispatch('session.create', {
      employeeId: EMP,
      title: '  例会纪要员  ',
    })) as Record<string, unknown>

    assert.equal(sessionCreatePayloads.length, createCallsBefore + 1)
    assert.equal(
      sessionCreatePayloads.at(-1)?.['title'],
      undefined,
      'title 绝不能塞进 create payload —— dsh 会静默忽略它',
    )
    const createdId = sessionCreatePayloads.length // sess_fake_<n>
    assert.equal(result['sessionId'], `sess_fake_${createdId}`)
    assert.equal(renamePayloads.length, renameCallsBefore + 1, '创建成功后必须补一步 rename')
    assert.deepEqual(renamePayloads.at(-1), {
      sessionId: `sess_fake_${createdId}`,
      title: '例会纪要员',
    })
    assert.equal(result['title'], '例会纪要员', '返回值应带上落成的标题')
    assert.equal(result['titleError'], undefined)
  })

  it('不带 title：根本不发 rename', async () => {
    const renameCallsBefore = renamePayloads.length
    const result = (await agent.dispatch('session.create', { employeeId: EMP })) as Record<
      string,
      unknown
    >
    assert.equal(renamePayloads.length, renameCallsBefore)
    assert.equal(result['title'], undefined)
    assert.equal(result['titleError'], undefined)
  })

  it('title 非法（空白 / 超长）→ 在建会话之前就拒绝，dsh 侧零副作用', async () => {
    const createCallsBefore = sessionCreatePayloads.length
    const renameCallsBefore = renamePayloads.length
    await assert.rejects(
      () => agent.dispatch('session.create', { employeeId: EMP, title: '   ' }),
      /empty/,
    )
    await assert.rejects(
      () => agent.dispatch('session.create', { employeeId: EMP, title: '长'.repeat(201) }),
      /200/,
    )
    assert.equal(sessionCreatePayloads.length, createCallsBefore, '非法 title 不应建出会话')
    assert.equal(renamePayloads.length, renameCallsBefore)
  })

  it('rename 失败不静默：会话如实建成，返回值带 titleError 说明', async () => {
    renameReply = { kind: 'api-error', code: 'internal', message: 'disk full' }
    const result = (await agent.dispatch('session.create', {
      employeeId: EMP,
      title: '落不上去的名',
    })) as Record<string, unknown>
    assert.equal(typeof result['sessionId'], 'string', '会话已建成，sessionId 必须如实返回')
    assert.match(String(result['titleError']), /命名失败/)
    assert.match(String(result['titleError']), /disk full/)
    assert.equal(result['title'], undefined, '命名没成就不该谎称有标题')
  })
})

describe('经 Hub 端到端（operator → forwarder → 节点 → dsh）', () => {
  it('先完成 operator 配对（回环也不会自动批准 operator）', async () => {
    const identityFile = path.join(tmpRoot, 'op-clients', 'op.json')
    const options = {
      identityFile,
      url: hubUrl,
      role: 'operator' as const,
      scopes: ['employee.prompt' as const],
      clientId: 'dse-cli',
      displayName: 'rename-test-op',
      autoReconnect: false,
    }
    const first = await HubClient.create(options)
    await assert.rejects(() => first.connect())
    first.close()

    const store = new HubStore(path.join(tmpRoot, 'hub-home'))
    await store.load()
    const request = Object.values(store.state().pending).find(
      (r) => r.deviceId === first.identity.deviceId,
    )
    assert.ok(request !== undefined, '待审批里应躺着这条 operator 请求')
    await approvePairing(store, request.requestId, 'test', {
      approvedScopes: ['employee.prompt'] as never,
    })

    operator = await HubClient.create(options)
    const hello = await operator.connect()
    assert.deepEqual(hello.auth.scopes, ['employee.prompt'])
  })

  it('session.rename 全链路透传 {title, seq}', async () => {
    renameReply = { kind: 'value', value: { title: '端到端改名', seq: 11 } }
    const result = await operator!.call(
      'session.rename',
      { employeeId: EMP, sessionId: 'sess_fake_1', title: ' 端到端改名 ' },
      { idempotencyKey: 'e2e-rename-1' },
    )
    assert.deepEqual(result, { title: '端到端改名', seq: 11 })
    assert.deepEqual(renamePayloads.at(-1), { sessionId: 'sess_fake_1', title: '端到端改名' })
  })

  it('session.create 带 title 经 Hub 两步落名', async () => {
    renameReply = { kind: 'value', value: { title: '经Hub命名', seq: 12 } }
    const result = (await operator!.call(
      'session.create',
      { employeeId: EMP, title: '经Hub命名' },
      { idempotencyKey: 'e2e-create-1' },
    )) as Record<string, unknown>
    assert.equal(typeof result['sessionId'], 'string')
    assert.equal(result['title'], '经Hub命名')
    assert.equal(sessionCreatePayloads.at(-1)?.['title'], undefined)
    assert.deepEqual(renamePayloads.at(-1), {
      sessionId: result['sessionId'],
      title: '经Hub命名',
    })
  })

  it('hub 层缺 title → bad-request（forwarder 的参数校验在转发前挡住）', async () => {
    const renameCallsBefore = renamePayloads.length
    await assert.rejects(
      () =>
        operator!.call(
          'session.rename',
          { employeeId: EMP, sessionId: 'sess_fake_1' },
          { idempotencyKey: 'e2e-rename-bad' },
        ),
      (error: unknown) => error instanceof HubCallError && error.code === 'bad-request',
    )
    assert.equal(renamePayloads.length, renameCallsBefore, '缺参不应触达 dsh')
  })
})
