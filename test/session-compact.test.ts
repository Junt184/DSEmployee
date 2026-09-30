/**
 * session.compact 的契约与节点侧行为测试。
 *
 * 三层覆盖：
 *   1. 方法表条目（scopes / route / idempotent / roles）—— 权限契约钉死在 methods.ts；
 *   2. 节点 dispatch 的如实返回 —— 进程内假 dsh（HTTP 层）+ 真实 Hub + 真实 NodeAgent；
 *   3. 新建会话的 preset 取值顺序（调用参数 > 员工配置 > 节点默认）。
 *
 * 假 dsh 的应答形状逐字对齐实测（dsh 0.1.0-rc.6）：
 *   - 命令已挂载（standard/code preset 有 compact）：
 *     commands/execute 回 { commandId, result: { kind:'success'|'error', text } }
 *   - 命令未挂载（minimal preset 没有 compact）：回 ok:true 且**没有 value**（静默吞掉）
 *   - sessionId 不存在：业务错误 session-not-found（HTTP 200 + result.ok:false）
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Hub } from '../src/hub/server.ts'
import { NodeAgent } from '../src/node/agent.ts'
import { METHODS } from '../src/protocol/methods.ts'

/** 假 dsh 对 commands/execute 的可编程应答。 */
let compactReply:
  | { kind: 'value'; value: unknown } // ok:true 且带 value
  | { kind: 'no-value' } // ok:true 但没有 value（= 命令未挂载）
  | { kind: 'api-error'; code: string; message: string } = { kind: 'no-value' }

/** 假 dsh 记下的每一次 session.create payload（用于核对 preset 取值顺序）。 */
const sessionCreatePayloads: Array<Record<string, unknown>> = []

let tmpRoot = ''
let employeeRoot = ''
let hub: Hub
let hubUrl = ''
let dshServer: Server
let dshPort = 0
let agent: NodeAgent

const EMP_NO_PRESET = 'emp_compact_nopreset'
const EMP_WITH_PRESET = 'emp_compact_withpreset'

async function writeEmployee(slug: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = path.join(employeeRoot, slug, '.dsemployee')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'employee.json'), JSON.stringify(manifest), 'utf8')
}

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-compact-test-'))

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
        case 'commands/execute':
          if (compactReply.kind === 'api-error') {
            return reply({
              ok: false,
              error: { code: compactReply.code, message: compactReply.message, details: {} },
            })
          }
          if (compactReply.kind === 'no-value') return reply({ ok: true })
          return reply({ ok: true, value: compactReply.value })
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
  await writeEmployee('aaa-nopreset', {
    id: EMP_NO_PRESET,
    name: '无预设员工',
    role: '测试',
    createdAtMs: Date.now(),
  })
  await writeEmployee('bbb-withpreset', {
    id: EMP_WITH_PRESET,
    name: '有预设员工',
    role: '测试',
    createdAtMs: Date.now(),
    agentPreset: 'minimal',
  })

  agent = new NodeAgent({
    home: path.join(tmpRoot, 'node-home'),
    hubUrl,
    name: 'compact-test-node',
    employeeRoot,
    manageDsh: false,
    attachPort: dshPort,
    defaultPreset: 'standard',
  })
  await agent.start()
})

after(async () => {
  await agent.stop()
  await hub.stop()
  dshServer.closeAllConnections()
  await new Promise<void>((resolve) => dshServer.close(() => resolve()))
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('方法表契约', () => {
  it('session.compact 条目：employee.prompt scope、路由到节点、幂等、仅 operator', () => {
    const spec = METHODS['session.compact']
    assert.deepEqual(spec.scopes, ['employee.prompt'])
    assert.equal(spec.route, 'node')
    assert.equal(spec.idempotent, true)
    assert.deepEqual(spec.roles, ['operator'])
  })
})

describe('节点侧 session.compact', () => {
  const compact = (sessionId = 'sess_fake_1'): Promise<{ kind: string; text: string }> =>
    agent.dispatch('session.compact', { employeeId: EMP_NO_PRESET, sessionId }) as Promise<{
      kind: string
      text: string
    }>

  it('dsh 返回 success → 原样透传 {kind, text}', async () => {
    compactReply = {
      kind: 'value',
      value: { commandId: 'cmd-1', result: { kind: 'success', text: 'No compactable history yet.' } },
    }
    assert.deepEqual(await compact(), { kind: 'success', text: 'No compactable history yet.' })
  })

  it('dsh 返回 error → 同样透传（压缩本身的失败是值，不是异常）', async () => {
    compactReply = {
      kind: 'value',
      value: { commandId: 'cmd-2', result: { kind: 'error', text: 'compaction failed: model busy' } },
    }
    assert.deepEqual(await compact(), { kind: 'error', text: 'compaction failed: model busy' })
  })

  it('dsh 静默吞掉（无 value）→ 人话提示 preset 不含压缩能力', async () => {
    compactReply = { kind: 'no-value' }
    const result = await compact()
    assert.equal(result.kind, 'error')
    assert.match(result.text, /不含压缩能力/)
  })

  it('result.kind 异常 → 如实报错，绝不硬编 success', async () => {
    compactReply = { kind: 'value', value: { commandId: 'cmd-3', result: { kind: 'mystery' } } }
    const result = await compact()
    assert.equal(result.kind, 'error')
    assert.match(result.text, /无法识别/)
  })

  it('dsh 业务错误（session-not-found）→ 抛错回传，而不是伪装成结果值', async () => {
    compactReply = { kind: 'api-error', code: 'session-not-found', message: 'session "x" not found' }
    await assert.rejects(() => compact('sess_gone'), /not found/)
  })

  it('员工不属于本节点 → 拒绝，不会把请求发给 dsh', async () => {
    compactReply = {
      kind: 'value',
      value: { commandId: 'cmd-4', result: { kind: 'success', text: 'should not happen' } },
    }
    await assert.rejects(
      () => agent.dispatch('session.compact', { employeeId: 'emp_stranger', sessionId: 'sess_fake_1' }),
      /unknown employee/,
    )
  })
})

describe('session.create 的 preset 取值顺序', () => {
  it('调用参数 > 员工配置 > 节点默认；三者都无 → 不传（落 dsh 部署默认）', async () => {
    // 节点默认（standard）：员工没配、调用没给
    await agent.dispatch('session.create', { employeeId: EMP_NO_PRESET })
    assert.equal(sessionCreatePayloads.at(-1)?.['agentPreset'], 'standard')

    // 调用参数显式指定，压过节点默认
    await agent.dispatch('session.create', { employeeId: EMP_NO_PRESET, agentPreset: 'code' })
    assert.equal(sessionCreatePayloads.at(-1)?.['agentPreset'], 'code')

    // 员工配置（minimal）压过节点默认
    await agent.dispatch('session.create', { employeeId: EMP_WITH_PRESET })
    assert.equal(sessionCreatePayloads.at(-1)?.['agentPreset'], 'minimal')

    // 没有节点默认的节点 + 无预设员工 → 根本不传 agentPreset
    const bare = new NodeAgent({
      home: path.join(tmpRoot, 'node-home-bare'),
      hubUrl,
      name: 'compact-bare-node',
      employeeRoot,
      manageDsh: false,
      attachPort: dshPort,
    })
    try {
      await bare.start()
      await bare.dispatch('session.create', { employeeId: EMP_NO_PRESET })
      assert.equal(
        sessionCreatePayloads.at(-1)?.['agentPreset'],
        undefined,
        '没配默认 preset 时不应编造一个',
      )
    } finally {
      await bare.stop()
    }
  })
})
