/**
 * 复现「页面 session.create 卡死」：独立 hub + node + .dev-employees，
 * 模拟页面操作顺序（llm.set → session.create → session.list），逐步加压。
 *
 * 用法：node scripts/repro-create-hang.ts
 */

import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { NodeAgent } from '../src/node/agent.ts'
import { HubClient } from '../src/client/hub-client.ts'

const ROOT = await mkdtemp(path.join(process.cwd(), '.tmp-repro-'))
const CRED_SOURCE = path.join(homedir(), '.dsh', '.credentials.yaml')
const log = (m: string): void => process.stdout.write(`[repro ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`)
const t0 = Date.now()

const SCOPES = ['employee.read', 'employee.prompt', 'employee.manage'] as const

let hub: Hub | undefined
let agent: NodeAgent | undefined
try {
  await mkdir(path.join(ROOT, 'dsh'), { recursive: true })
  await copyFile(CRED_SOURCE, path.join(ROOT, 'dsh', '.credentials.yaml')).catch(() => undefined)

  hub = new Hub({ home: ROOT, port: 0 })
  const address = await hub.start()
  agent = new NodeAgent({
    home: ROOT,
    hubUrl: address.wsUrl,
    name: '复现节点',
    employeeRoot: path.resolve('.dev-employees'),
    dshHome: path.join(ROOT, 'dsh'),
  })
  await agent.start()
  log(`就绪 hub=${address.wsUrl} dsh=${agent.dshPort}`)

  // operator 配对（测试惯例的本机批准）
  const idFile = path.join(ROOT, 'op', 'identity.json')
  const probe = await HubClient.create({
    identityFile: idFile, url: address.wsUrl, role: 'operator', scopes: [...SCOPES],
    clientId: 'dse-repro', displayName: 'repro', autoReconnect: false,
  })
  await probe.connect().catch(() => undefined)
  const store = new HubStore(ROOT)
  await store.load()
  const pending = Object.values(store.state().pending).find((r) => r.deviceId === probe.identity.deviceId)
  if (pending === undefined) throw new Error('无 pending')
  await approvePairing(store, pending.requestId, 'repro', { approvedScopes: [...SCOPES] })
  probe.close()

  const client = await HubClient.create({
    identityFile: idFile, url: address.wsUrl, role: 'operator', scopes: [...SCOPES],
    clientId: 'dse-repro', displayName: 'repro', autoReconnect: false,
  })
  await client.connect()
  log('operator 已连接')

  const employees = await client.call<{ employees: Array<{ id: string; name: string }> }>('employee.list', {})
  const employee = employees.employees.find((e) => e.name === '阿澈') ?? employees.employees[0]
  if (employee === undefined) throw new Error('没有员工')
  log(`目标员工 ${employee.name} (${employee.id})`)

  /** 带计时的调用：每次调用独立计时，绝不挂死脚本 */
  async function timed<T>(label: string, method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    const start = Date.now()
    try {
      const result = await client.call<T>(method, params, {
        idempotencyKey: `repro-${method}-${start}-${Math.random()}`,
        timeoutMs,
      })
      log(`${label} → OK（${Date.now() - start}ms）`)
      return result
    } catch (error) {
      log(`${label} → FAIL（${Date.now() - start}ms）${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  /* 1. llm.set（与线上一致的起点：阿澈配了自定义端点） */
  await timed('llm.set', 'employee.llm.set', {
    employeeId: employee.id,
    apiUrl: 'http://127.0.0.1:9/v1', // 不可达即可：selectModel 只记选择不打请求
    apiKey: 'sk-repro',
    model: 'repro-model',
  })

  /* 2. 会话列表（页面进对话框的第一步） */
  await timed('session.list#1', 'session.list', { employeeId: employee.id })

  /* 3. 新建会话（线上卡死点） */
  const created = await timed<{ sessionId: string }>('session.create', 'session.create', { employeeId: employee.id }, 20_000)
  log(`会话建成 ${created.sessionId}`)

  /* 4. 加压：让它跑一个长任务（制造事件风暴），同时再 list/create */
  await timed('session.prompt（长任务）', 'session.prompt', {
    employeeId: employee.id,
    sessionId: created.sessionId,
    text: '从 1 数到 5000，每个数字单独一行输出，中间不要停，不要调用任何工具。',
  }, 20_000)
  await new Promise((r) => setTimeout(r, 3000))
  await timed('session.list#2（流式风暴中）', 'session.list', { employeeId: employee.id }, 20_000)
  await timed('session.create#2（流式风暴中）', 'session.create', { employeeId: employee.id }, 20_000)
  await timed('session.list#3', 'session.list', { employeeId: employee.id }, 20_000)

  await timed('session.cancel', 'session.cancel', { employeeId: employee.id, sessionId: created.sessionId }, 20_000)
  log('全部通过：create/list 在风暴中也没有挂死')
  client.close()
} catch (error) {
  process.stderr.write(`\n[repro] 失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await agent?.stop().catch(() => undefined)
  await hub?.stop().catch(() => undefined)
  await rm(ROOT, { recursive: true, force: true })
  process.exit(process.exitCode ?? 0)
}
