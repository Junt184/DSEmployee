import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { HubClient } from '../src/client/hub-client.ts'
import { NodeAgent } from '../src/node/agent.ts'
import { SessionArchiveStore } from '../src/node/session-archive.ts'
import { METHODS } from '../src/protocol/methods.ts'

let root: string
let workspace: string
let server: Server
let hub: Hub
let agent: NodeAgent
let operator: HubClient | undefined
let sessions: Array<Record<string, unknown>>
const methods: string[] = []
const history = [{ event: { seq: 1, time: 10, type: 'user/message', data: { content: [{ type: 'text', text: '保留的历史' }] } } }]
const employeeId = 'emp_archive'

before(async () => {
  root = await mkdtemp(path.join(process.cwd(), '.tmp-session-archive-'))
  workspace = path.join(root, 'employees', 'archive')
  await mkdir(path.join(workspace, '.dsemployee'), { recursive: true })
  await writeFile(path.join(workspace, '.dsemployee', 'employee.json'), JSON.stringify({
    id: employeeId, name: '归档测试', role: '测试', createdAtMs: Date.now(),
  }))
  sessions = [{ sessionId: 'a1', cwd: workspace, name: '记录一', running: false },
    { sessionId: 'busy', cwd: workspace, running: true }, { sessionId: 'other', cwd: path.join(root, 'other') }]
  server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const frame = JSON.parse(body)
      const method = (req.url || '').replace(/^\/api\//, '')
      methods.push(method)
      let value: unknown = {}
      if (method === 'host.describe') value = { version: 'test', cwd: workspace }
      if (method === 'workspace.list') value = { items: [], archivedSessionIds: [] }
      if (method === 'workspace.create') value = { workspaceId: 'ws_archive' }
      if (method === 'session.list') value = { items: structuredClone(sessions) }
      if (method === 'session.history') value = { events: history, hasMore: false }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: frame.rpcId, result: { ok: true, value } }))
    })
  })
  server.on('upgrade', (_req, socket) => socket.destroy())
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  hub = new Hub({ home: path.join(root, 'hub'), port: 0, verbose: false })
  const hubUrl = (await hub.start()).wsUrl
  agent = new NodeAgent({ home: path.join(root, 'node'), hubUrl, name: 'archive-node',
    employeeRoot: path.join(root, 'employees'), manageDsh: false, attachPort: address.port, defaultPreset: 'standard' })
  await agent.start()
  const options = { identityFile: path.join(root, 'operator.json'), url: hubUrl,
    role: 'operator' as const, scopes: ['employee.read', 'employee.prompt'] as const,
    clientId: 'archive-test', displayName: '测试', autoReconnect: false }
  const first = await HubClient.create({ ...options, scopes: [...options.scopes] })
  await assert.rejects(() => first.connect())
  first.close()
  const store = new HubStore(path.join(root, 'hub'))
  await store.load()
  const pending = Object.values(store.state().pending).find(row => row.deviceId === first.identity.deviceId)
  assert.ok(pending)
  await approvePairing(store, pending.requestId, 'test', { approvedScopes: [...options.scopes] })
  operator = await HubClient.create({ ...options, scopes: [...options.scopes] })
  await operator.connect()
})

after(async () => {
  operator?.close()
  await agent?.stop()
  await hub?.stop()
  server?.closeAllConnections()
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  if (root) await rm(root, { recursive: true, force: true })
})

describe('会话归档的权限、归属与持久化', () => {
  it('方法仅允许有 employee.prompt 权限的 operator，且要求幂等键', () => {
    const spec = METHODS['session.archive']
    assert.deepEqual(spec.scopes, ['employee.prompt'])
    assert.deepEqual(spec.roles, ['operator'])
    assert.equal(spec.route, 'node')
    assert.equal(spec.idempotent, true)
  })

  it('通过真实 Hub 归档和恢复，历史原样保留，新实例也能读到归档记录', async () => {
    const before = methods.length
    const archived = await operator!.call('session.archive', { employeeId, sessionId: 'a1', archived: true }, { idempotencyKey: 'archive-a1' }) as { archived: boolean; archivedAtMs: number }
    assert.equal(archived.archived, true)
    assert.equal(typeof archived.archivedAtMs, 'number')
    assert.equal((await new SessionArchiveStore().list(workspace)).get('a1'), archived.archivedAtMs)
    const listed = await operator!.call('session.list', { employeeId }) as { sessions: Array<Record<string, unknown>> }
    assert.equal(listed.sessions.find(row => row.sessionId === 'a1')?.archived, true)
    assert.equal(listed.sessions.some(row => row.sessionId === 'other'), false)
    const replay = await operator!.call('session.history', { employeeId, sessionId: 'a1' }) as { events: unknown[] }
    assert.deepEqual(replay.events, history)
    assert.equal(methods.slice(before).some(method => ['session.cancel', 'session.prompt', 'session.create', 'session.delete'].includes(method)), false)
    const restored = await operator!.call('session.archive', { employeeId, sessionId: 'a1', archived: false }, { idempotencyKey: 'restore-a1' }) as { archived: boolean }
    assert.equal(restored.archived, false)
    assert.equal((await new SessionArchiveStore().list(workspace)).has('a1'), false)
    const afterRestore = await agent.dispatch('session.list', { employeeId }) as { sessions: Array<Record<string, unknown>> }
    assert.equal(afterRestore.sessions.find(row => row.sessionId === 'a1')?.archived, false)
  })

  it('拒绝其他员工的会话、未知会话和非法归档值，不写入元数据', async () => {
    for (const sessionId of ['other', 'unknown']) {
      await assert.rejects(() => agent.dispatch('session.archive', { employeeId, sessionId, archived: true }), { code: 'not-found', message: '该员工下不存在此会话' })
    }
    await assert.rejects(() => agent.dispatch('session.archive', { employeeId: 'unknown', sessionId: 'a1', archived: true }), /unknown employee/)
    await assert.rejects(() => agent.dispatch('session.archive', { employeeId, sessionId: 'a1', archived: 'true' }), { code: 'bad-request', message: 'archived 必须为布尔值' })
    assert.equal((await new SessionArchiveStore().list(workspace)).size, 0)
  })

  it('运行中的回合不会被归档或中止', async () => {
    const before = methods.length
    await assert.rejects(() => agent.dispatch('session.archive', { employeeId, sessionId: 'busy', archived: true }), { code: 'bad-request', message: '运行中的会话暂不能归档，请等回合结束' })
    assert.equal(methods.slice(before).includes('session.cancel'), false)
    assert.equal((await new SessionArchiveStore().list(workspace)).has('busy'), false)
  })

  it('同一工作区并发归档不丢记录，重复归档保留原始时间，恢复幂等', async () => {
    const location = path.join(root, 'parallel')
    const store = new SessionArchiveStore()
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.set(location, 's' + i, true)))
    assert.equal((await new SessionArchiveStore().list(location)).size, 10)
    const at = (await store.list(location)).get('s0')
    assert.equal(await store.set(location, 's0', true), at)
    await Promise.all([store.set(location, 's0', false), store.set(location, 's1', false)])
    await store.set(location, 's0', false)
    assert.equal((await store.list(location)).size, 8)
  })

  it('损坏或形状不正确的归档记录报错，不能被当作空列表覆盖', async () => {
    const location = path.join(root, 'corrupt')
    const file = path.join(location, '.dsemployee', 'session-archives.json')
    await mkdir(path.dirname(file), { recursive: true })
    const store = new SessionArchiveStore()
    for (const raw of ['{', '{"version":1,"sessions":{}}']) {
      await writeFile(file, raw)
      await assert.rejects(() => store.set(location, 'new', true))
      assert.equal(await readFile(file, 'utf8'), raw)
    }
    await writeFile(file, '{"version":1,"sessions":[]}')
    await store.set(location, 'new', true)
    assert.equal((await store.list(location)).has('new'), true)
  })
})
