/**
 * 配对批准 UX 的端到端验证 —— 模拟两台控制台设备：
 *   设备 A 已授权 → 设备 B 发配对请求 → A 用 device.pair.approve 批准
 *   → B **不需要任何令牌输入**，下次握手自动领令牌进入。
 * 同时断言：approve 的响应里**没有**令牌字段（UI 不再有"请复制令牌"的依据）。
 *
 * 用法：node scripts/e2e-pair-approve.ts
 */

import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { HubClient } from '../src/client/hub-client.ts'

const ROOT = await mkdtemp(path.join(process.cwd(), '.tmp-pair-e2e-'))
const log = (m: string): void => process.stdout.write(`[pair-e2e] ${m}\n`)

const hub = new Hub({ home: ROOT, port: 0 })
try {
  const address = await hub.start()
  log(`hub ${address.wsUrl}`)

  const makeConsole = (name: string) =>
    HubClient.create({
      identityFile: path.join(ROOT, name, 'identity.json'),
      url: address.wsUrl,
      role: 'operator',
      scopes: ['employee.read', 'device.pair'],
      clientId: 'dse-web',
      displayName: name,
      autoReconnect: false,
    })

  /* ── 设备 A：本机批准引导（第一台设备的既有路径）── */
  const aProbe = await makeConsole('console-a')
  await aProbe.connect().catch(() => undefined)
  const store = new HubStore(ROOT)
  await store.load()
  const pendingA = Object.values(store.state().pending).find((r) => r.deviceId === aProbe.identity.deviceId)
  if (pendingA === undefined) throw new Error('A 的配对请求不在台账里')
  await approvePairing(store, pendingA.requestId, 'e2e-bootstrap')
  aProbe.close()

  const a = await makeConsole('console-a')
  const helloA = await a.connect()
  log(`A 已授权进入（令牌已领取=${helloA.auth.deviceToken !== undefined}）`)

  /* ── 设备 B：发配对请求，被 A 批准 ── */
  const bProbe = await makeConsole('console-b')
  let requestIdB = ''
  bProbe.on('handshakeFailed', (error) => {
    requestIdB = String((error.details as { requestId?: string } | undefined)?.requestId ?? '')
  })
  await bProbe.connect().catch(() => undefined)
  bProbe.close()
  if (requestIdB === '') throw new Error('B 没有拿到 requestId')
  log(`B 已提交配对请求 ${requestIdB}（未持任何令牌）`)

  const approveResult = await a.call<Record<string, unknown>>(
    'device.pair.approve',
    { requestId: requestIdB },
    { idempotencyKey: `approve-${Date.now()}` },
  )
  log(`A 批准返回：${JSON.stringify(approveResult)}`)
  if ('deviceToken' in approveResult || 'token' in approveResult) {
    throw new Error('approve 响应里不应有令牌字段（令牌只在设备自己握手时下发）')
  }
  log('approve 响应无令牌字段 ✅（UI 无令牌可复制是协议的如实反映）')

  /* ── B 重连：不带任何令牌，签名握手即自动领取 ── */
  const b = await makeConsole('console-b')
  const helloB = await b.connect()
  if (helloB.auth.deviceToken === undefined) throw new Error('B 应在这次握手领到令牌')
  log(`B 未输入任何令牌，握手即领到令牌并进入（scopes=${helloB.auth.scopes.join(',')}）✅`)

  a.close()
  b.close()
  log('全部通过')
} catch (error) {
  process.stderr.write(`\n[pair-e2e] 失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await hub.stop().catch(() => undefined)
  await rm(ROOT, { recursive: true, force: true })
  process.exit(process.exitCode ?? 0)
}
