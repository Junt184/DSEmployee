/**
 * 员工级 LLM 端点的端到端验证：employee.llm.set → dsh provider 声明 →
 * 新建会话自动 selectModel → employee.llm.unset → 声明与凭据清理。
 *
 * 用法：node scripts/e2e-llm-endpoint.ts
 */

import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { NodeAgent } from '../src/node/agent.ts'
import { HubClient } from '../src/client/hub-client.ts'
import { llmRouteFor } from '../src/node/employee-llm.ts'
import { DshClient } from '../src/node/dsh-client.ts'

const ROOT = await mkdtemp(path.join(process.cwd(), '.tmp-llm-e2e-'))
const SCOPES = ['employee.read', 'employee.prompt', 'employee.manage'] as const

const log = (m: string): void => process.stdout.write(`[llm-e2e] ${m}\n`)

let hub: Hub | undefined
let agent: NodeAgent | undefined
try {
  hub = new Hub({ home: ROOT, port: 0 })
  const address = await hub.start()

  agent = new NodeAgent({
    home: ROOT,
    hubUrl: address.wsUrl,
    name: 'llm-e2e 节点',
    employeeRoot: path.resolve('.dev-employees'),
    dshHome: path.join(ROOT, 'dsh'),
  })
  await agent.start()
  log(`节点就绪，dsh 端口 ${agent.dshPort}`)

  // operator：直接本机批准（测试惯例，与 hub.test.ts 相同）
  const probe = await HubClient.create({
    identityFile: path.join(ROOT, 'op', 'identity.json'),
    url: address.wsUrl,
    role: 'operator',
    scopes: [...SCOPES],
    clientId: 'dse-llm-e2e',
    displayName: 'llm-e2e',
    autoReconnect: false,
  })
  await probe.connect().catch(() => undefined)
  const store = new HubStore(ROOT)
  await store.load()
  const pending = Object.values(store.state().pending).find((r) => r.deviceId === probe.identity.deviceId)
  if (pending === undefined) throw new Error('没有待审批的配对请求')
  await approvePairing(store, pending.requestId, 'llm-e2e', { approvedScopes: [...SCOPES] })
  probe.close()

  const client = await HubClient.create({
    identityFile: path.join(ROOT, 'op', 'identity.json'),
    url: address.wsUrl,
    role: 'operator',
    scopes: [...SCOPES],
    clientId: 'dse-llm-e2e',
    displayName: 'llm-e2e',
    autoReconnect: false,
  })
  await client.connect()

  const employees = await client.call<{ employees: Array<{ id: string; name: string }> }>('employee.list', {})
  const employee = employees.employees[0]
  if (employee === undefined) throw new Error('没有员工')
  log(`员工 ${employee.name} (${employee.id})`)
  const route = llmRouteFor(employee.id)

  /* ── set：保存 + 接线 ── */
  const set = await client.call<{ configured: boolean; wired: boolean; keyMask?: string }>(
    'employee.llm.set',
    { employeeId: employee.id, apiUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-e2e-test-key', model: 'e2e-model' },
    { idempotencyKey: `llm-set-${Date.now()}` },
  )
  log(`set → configured=${set.configured} wired=${set.wired} keyMask=${set.keyMask ?? '—'}`)
  if (set.configured !== true || set.wired !== true) throw new Error('set 后应已配置且已接线')
  if (set.keyMask === undefined || set.keyMask.includes('e2e-test')) throw new Error('keyMask 泄露了明文')

  /* ── dsh 侧：provider 路由声明在册 ── */
  const dsh = new DshClient({ port: agent.dshPort ?? 0 })
  const providers = await dsh.call<{ providers: Array<{ provider: string; declared: boolean; active: boolean }> }>(
    'llm.providers',
    {},
  )
  const mine = providers.providers.find((p) => p.provider === route)
  log(`dsh provider ${route}: ${JSON.stringify(mine)}`)
  if (mine === undefined || mine.declared !== true) throw new Error('provider 未声明到 dsh')

  /* ── 新建会话应自动选到专用模型 ── */
  const session = await client.call<{ sessionId: string }>(
    'session.create',
    { employeeId: employee.id },
    { idempotencyKey: `llm-sess-${Date.now()}` },
  )
  const models = await dsh.call<{ current: { provider: string; modelId?: string; model?: string } }>(
    'session.models',
    { sessionId: session.sessionId },
  )
  log(`新会话当前模型：${JSON.stringify(models.current)}`)
  if (models.current.provider !== route) throw new Error(`新会话没有选到 ${route}`)

  /* ── unset：声明与凭据都清掉 ── */
  await client.call('employee.llm.unset', { employeeId: employee.id }, { idempotencyKey: `llm-unset-${Date.now()}` })
  const after = await dsh.call<{ providers: Array<{ provider: string }> }>('llm.providers', {})
  if (after.providers.some((p) => p.provider === route)) throw new Error('unset 后 provider 仍在')
  const cred = await dsh.call<{ credentials: Record<string, { configured: boolean }> }>(
    'credentials.describe',
    { refs: [`DSE_EMP_${employee.id.replace(/^emp_/, '').slice(0, 8).toUpperCase()}_API_KEY`] },
  )
  const credEntry = Object.values(cred.credentials)[0]
  if (credEntry?.configured === true) throw new Error('unset 后凭据仍在')
  const get = await client.call<{ configured: boolean }>('employee.llm.get', { employeeId: employee.id })
  if (get.configured !== false) throw new Error('unset 后 get 仍报已配置')
  log('unset 后 provider/凭据/配置全部清理 ✅')

  log('全部通过')
  client.close()
} catch (error) {
  process.stderr.write(`\n[llm-e2e] 失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await agent?.stop().catch(() => undefined)
  await hub?.stop().catch(() => undefined)
  await rm(ROOT, { recursive: true, force: true })
  process.exit(process.exitCode ?? 0)
}
