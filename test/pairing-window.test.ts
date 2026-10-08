/**
 * 注册窗口（配对开关）—— 关着的时候，没有本机设备凭据的 HTTP 访问拿到 404。
 *
 * 这一组守的是那个开关的**语义**，不是 UI：
 *   · 默认**开着**（沿用这个开关之前的行为）：升级不会把老设备锁在门外；
 *   · 关着 ⇒ 陌生人看到的是 nginx 那种 404（不是 401/403："这里需要认证"本身就是线索）；
 *   · 关着 ⇒ **已配对的浏览器照常能用** —— 它带着配对时换来的 dse_device cookie。
 *     这一条是整个开关能成立的前提：没有它，"关闭注册"等于把自己也关在门外；
 *   · 关着 ⇒ `/ws` 升级不受影响（否则所有节点与已配对设备一起掉线）；
 *   · 到点自动关（限时开放）、`dse pairing open` 与窗口无关（cookie 失效时的后路）。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { HubClient } from '../src/client/hub-client.ts'
import { METHODS } from '../src/protocol/methods.ts'
import { readJsonFile } from '../src/util/fsx.ts'
import { callHubLocalControl } from '../src/hub/local-control.ts'

let tmpRoot = ''
let home = ''
let hub: Hub
let hubUrl = ''
let httpUrl = ''

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-pairwindow-'))
  home = path.join(tmpRoot, 'home')
  hub = new Hub({ home, port: 0, verbose: false })
  const address = await hub.start()
  hubUrl = address.wsUrl
  httpUrl = address.url
})

after(async () => {
  await hub.stop()
  await rm(tmpRoot, { recursive: true, force: true })
})

/**
 * 模拟"经过反代的公网请求"：来源 IP 与 https 都在代理头里（闸门本身不看来源，
 * 但 `POST /session` 要靠 x-forwarded-proto 决定 cookie 带不带 Secure）。
 */
const REMOTE_HEADERS = { 'x-real-ip': '203.0.113.9', 'x-forwarded-proto': 'https' }

interface HttpResult {
  status: number
  body: string
  headers: Headers
}

/** 默认带"公网来源"头：闸门只对**未认证的远程**访客生效，测试就得站到那边去。 */
async function get(pathname: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  const response = await fetch(`${httpUrl.replace(/\/$/, '')}${pathname}`, {
    redirect: 'manual',
    headers: { ...REMOTE_HEADERS, ...headers },
  })
  return { status: response.status, body: await response.text(), headers: response.headers }
}

/** 用设备令牌换 cookie（`POST /session`），返回 Set-Cookie 里的那一对。 */
async function session(token: string): Promise<HttpResult> {
  const response = await fetch(`${httpUrl.replace(/\/$/, '')}/session`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...REMOTE_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  return { status: response.status, body: await response.text(), headers: response.headers }
}

/**
 * 配对一台设备时的**准备动作**。
 *
 * 必须先开窗：待配对记录只在「注册窗口开着」或「进门方式是 operator」时才会产生
 * （见 devices.ts 的 pairingApproval 注释与 device-approval.test.ts）。准备动作要的是
 * "账上有条可批准的请求"，所以这里临时开一下窗；**要断言"窗口关着会怎样"的用例
 * 自己再关掉它** —— 别把这个开关的状态带到断言里去。
 */
async function withWindowOpen<T>(run: () => Promise<T>): Promise<T> {
  const wasOpen = hub.pairingWindowOpen()
  if (!wasOpen) await hub.setPairingWindow({ openMinutes: 5 })
  try {
    return await run()
  } finally {
    if (!wasOpen) await hub.setPairingWindow({ close: true })
  }
}


async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', path.join(process.cwd(), 'src/cli.ts'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function pairOperator(name: string, scopes: string[]): Promise<HubClient> {
  const make = async (): Promise<HubClient> =>
    await HubClient.create({
      identityFile: path.join(home, 'clients', `${name}.json`),
      url: hubUrl,
      role: 'operator',
      scopes: scopes as never,
      clientId: 'dse-cli',
      displayName: name,
      autoReconnect: false,
    })
  const deviceId = await withWindowOpen(async () => {
    const probe = await make()
    await assert.rejects(() => probe.connect())
    const id = probe.identity.deviceId
    probe.close()
    return id
  })
  const store = new HubStore(home)
  await store.load()
  const request = Object.values(store.state().pending).find((r) => r.deviceId === deviceId)
  assert.ok(request !== undefined, `窗口开着时应当留下 ${name} 的待配对请求`)
  await approvePairing(store, request.requestId, 'test', { approvedScopes: scopes as never })
  const client = await make()
  await client.connect()
  return client
}

/**
 * 配一台设备并拿到它的**明文令牌** —— 等价于浏览器配对成功后存在 localStorage 里的那个
 * （HubClient 在 hello-ok 里领到令牌，`deviceToken` 就是它）。
 */
async function pairDeviceWithToken(name: string, scopes: string[]): Promise<string> {
  const client = await pairOperator(name, scopes)
  const token = client.deviceToken
  assert.ok(typeof token === 'string' && token !== '', '配对成功应当领到设备令牌')
  client.close()
  return token
}

describe('运行中 Hub 的本机配对窗口控制', () => {
  it('dse pairing CLI 在 Hub 运行时走本机 IPC，不直接改 hub.json', async () => {
    const configPath = path.join(home, 'hub', 'hub.json')
    const before = await readJsonFile<Record<string, unknown>>(configPath, {})
    const result = await runCli(['pairing', 'close', '--home', home])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /注册窗口：已关闭/)
    assert.equal(hub.pairingWindowOpen(), false, '内存状态必须随 CLI 调用立即更新')
    const after = await readJsonFile<Record<string, unknown>>(configPath, {})
    assert.equal(after['pairingMode'], 'closed', 'Hub IPC 应将变更落盘')
    assert.notDeepEqual(after, before, 'Hub 对内存状态更新后应负责持久化')
  })

  it('Hub 停止时 CLI 拒绝离线开关，避免直接写文件造成启动竞态', async () => {
    const offlineHome = path.join(tmpRoot, 'offline-home')
    const offlineStore = new HubStore(offlineHome)
    await offlineStore.load()
    const result = await runCli(['pairing', 'open', '--minutes', '10', '--home', offlineHome])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /请先启动 Hub/)
    const reloaded = new HubStore(offlineHome)
    await reloaded.load()
    assert.equal(reloaded.state().config.pairingMode, undefined, 'CLI 不得在 Hub 停止时改写配置')
    assert.equal(reloaded.state().config.pairingWindowUntilMs, undefined)
  })

  it('CLI 本机通道直接更新正在运行的 Hub 内存状态与磁盘状态', async () => {
    const state = path.join(home, 'hub')
    const closed = (await callHubLocalControl(state, 'pairing.window.set', { open: false })) as { open: boolean }
    assert.equal(closed.open, false)
    assert.equal(hub.pairingWindowOpen(), false, '运行中的 Hub 必须立即看到变更')

    const opened = (await callHubLocalControl(state, 'pairing.window.set', { open: true, minutes: 15 })) as { open: boolean }
    assert.equal(opened.open, true)
    assert.equal(hub.pairingWindowOpen(), true)
    assert.equal((await callHubLocalControl(state, 'pairing.window', {}) as { open: boolean }).open, true)
  })

  it('本机通道不是通用 RPC，只开放配对窗口的两个操作', async () => {
    await assert.rejects(() => callHubLocalControl(path.join(home, 'hub'), 'device.pair.remove', {}), /not allowed/)
  })
})

describe('注册窗口：默认开着；关掉之后陌生人看到的是 404', () => {
  it('默认开着（沿用旧行为）：全新 Hub 上首页能打开，且自己会说"开着"', async () => {
    /* 为什么默认开：这个开关出现之前，控制台一直是可访问的。默认关掉 = 升级那一刻
       所有人的浏览器（包括运维自己）一起变成 404，而拿到 cookie 的前提又是"能打开页面"——
       那就只能靠 SSH 救了。默认值要照顾的是"别把自己锁死"，不是"默认最安全"。 */
    assert.equal(hub.pairingWindowOpen(), true, '默认必须是开的')
    const page = await get('/')
    assert.equal(page.status, 200)
    const window = (await (await pairOperator('op-default', ['device.pair'])).call('pairing.window', {})) as {
      open?: boolean
      pairedCount?: number
    }
    assert.equal(window.open, true)
    assert.equal(typeof window.pairedCount, 'number')
  })

  it('关着 ⇒ 控制台首页 404（而不是 401/403）', async () => {
    await hub.setPairingWindow({ close: true })
    assert.equal(hub.pairingWindowOpen(), false)
    const page = await get('/')
    assert.equal(page.status, 404)
    /* 与本部署 nginx 的 404 一致（实测是 text/plain 的 "not found"），
       且不泄露任何 DSH 痕迹 —— 差异本身就是指纹。 */
    assert.equal(page.body.trim(), 'not found')
    assert.doesNotMatch(page.body, /DSEmployee|dse|hub/i, '不能泄露"这里有套员工系统"')
  })

  it('关着时其它未认证路由也一致 404（门关着但灯还亮着最糟）', async () => {
    await hub.setPairingWindow({ close: true })
    for (const pathname of ['/ui.js', '/sw.js', '/manifest.webmanifest', '/healthz', '/assets/%', '/icon-192.png']) {
      const response = await get(pathname)
      assert.equal(response.status, 404, `${pathname} 应当 404`)
      assert.equal(response.body, 'not found\n', `${pathname} 的 404 body 必须与 nginx 逐字节一致`)
    }
  })

  it('开着 ⇒ 首页正常返回（新设备才看得到授权码入口）', async () => {
    await hub.setPairingWindow({ openMinutes: 15 })
    assert.equal(hub.pairingWindowOpen(), true)
    const page = await get('/')
    assert.equal(page.status, 200)
    await hub.setPairingWindow({ close: true })
    assert.equal((await get('/')).status, 404, '关掉之后立刻恢复 404')
  })

  it('限时开放有上下限，到点自动关；不带分钟数 = 一直开着', async () => {
    const timed = await hub.setPairingWindow({ openMinutes: 999 })
    assert.equal(timed.open, true)
    assert.ok(timed.untilMs !== undefined && timed.untilMs - Date.now() <= 120 * 60_000 + 1000, '上限 120 分钟')
    /* 把截止时刻挪到过去 = 到点自动关（不起定时器也能有效） */
    hub.state().config.pairingWindowUntilMs = Date.now() - 1
    assert.equal(hub.pairingWindowOpen(), false)
    assert.equal((await get('/')).status, 404, '到点之后必须真的 404')

    const forever = await hub.setPairingWindow({})
    assert.equal(forever.open, true)
    assert.equal(forever.untilMs, undefined, '不带分钟数 = 无到期时间')
    assert.equal((await get('/')).status, 200)
  })
})

describe('注册窗口：凭据（cookie）与窗口的配合', () => {
  it('配对时换来的 cookie 让**自己的浏览器**在窗口关着时照常打开控制台', async () => {
    const token = await pairDeviceWithToken('op-cookie', ['device.pair', 'employee.read'])
    const exchange = await session(token)
    assert.equal(exchange.status, 200)
    const cookie = exchange.headers.get('set-cookie') ?? ''
    assert.match(cookie, /^dse_device=/)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Lax/)
    assert.match(cookie, /Secure/, '经 https 反代时 cookie 必须是 Secure')

    await hub.setPairingWindow({ close: true })
    const jar = cookie.split(';')[0] ?? ''
    const mine = await get('/', { cookie: jar })
    assert.equal(mine.status, 200, '已配对的浏览器不能被自己的开关关在门外')
    assert.equal((await get('/ui.js', { cookie: jar })).status, 200)
    assert.equal((await get('/', { cookie: 'dse_device=whatever' })).status, 404, '假 cookie 无效')
  })

  it('令牌被吊销 ⇒ cookie 立刻失效（吊销不能只是"WS 那半边"的事）', async () => {
    const token = await pairDeviceWithToken('op-revoke', ['device.pair'])
    const cookie = ((await session(token)).headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    assert.equal((await get('/', { cookie })).status, 200)

    const store = new HubStore(home)
    await store.load()
    const { findByToken, revokeToken } = await import('../src/hub/devices.ts')
    const device = findByToken(store, token)
    assert.ok(device !== undefined)
    await revokeToken(store, device.deviceId)

    await hub.setPairingWindow({ close: true })
    assert.equal((await get('/', { cookie })).status, 404, '吊销之后 cookie 不能再开门')
  })

  it('`POST /session` 不受窗口影响（窗口关着 + cookie 失效时的自救路径）', async () => {
    const token = await pairDeviceWithToken('op-rescue', ['device.pair'])
    await hub.setPairingWindow({ close: true })
    assert.equal((await get('/')).status, 404)
    const exchange = await session(token)
    assert.equal(exchange.status, 200, '令牌有效就必须能换回 cookie（否则只能上服务器）')
    const cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    assert.equal((await get('/', { cookie })).status, 200)
  })

  it('`POST /session` 拿不到令牌时，回的是**同一个** 404（不告诉陌生人这里有什么）', async () => {
    await hub.setPairingWindow({ close: true })
    for (const body of ['{"token":"nope"}', 'nope', '', '{"token":123}']) {
      const response = await fetch(`${httpUrl.replace(/\/$/, '')}/session`, {
        method: 'POST',
        redirect: 'manual',
        headers: { ...REMOTE_HEADERS, 'content-type': 'application/json' },
        body,
      })
      assert.equal(response.status, 404, `body=${body}`)
      assert.equal(await response.text(), 'not found\n')
      assert.equal(response.headers.get('set-cookie'), null)
    }
  })

  it('DELETE /session 抹掉 cookie（「清除本地令牌」不能只清一半）', async () => {
    const token = await pairDeviceWithToken('op-clear', ['device.pair'])
    const cleared = await fetch(`${httpUrl.replace(/\/$/, '')}/session`, {
      method: 'DELETE',
      redirect: 'manual',
      headers: REMOTE_HEADERS,
    })
    assert.equal(cleared.status, 200)
    assert.match(cleared.headers.get('set-cookie') ?? '', /Max-Age=0/)
  })
})

describe('注册窗口：不能把自己的设备关在门外', () => {
  it('关着窗口时，已配对的设备照常连、照常调方法', async () => {
    /* 先配对（需要开窗，见 pairOperator），再关窗做断言 —— 顺序不能反：
       反了就成了"窗口关着还想配一台新设备"，而那条路现在是故意封住的。 */
    const op = await pairOperator('op-window', ['employee.read', 'device.pair'])
    await hub.setPairingWindow({ close: true })
    const health = (await op.call('health', {})) as { ok?: boolean }
    assert.ok(health !== undefined, '已配对设备必须照常可用（否则这个开关会把自己锁死）')
    const window = (await op.call('pairing.window', {})) as { open?: boolean }
    assert.equal(window.open, false)
    op.close()
  })

  it('只有 device.pair 能用这个开关', async () => {
    const spec = METHODS['pairing.window.set'] as { scopes: readonly string[] }
    assert.deepEqual([...spec.scopes], ['device.pair'])
    const op = await pairOperator('op-window-2', ['employee.read'])
    await assert.rejects(
      () => op.call('pairing.window.set', { open: true }, { idempotencyKey: 'w1' }),
      /requires scope/,
    )
    op.close()
  })

  it('窗口关着时，未配对设备被告知"窗口关着"，而不是拿到一个永远批不了的 requestId', async () => {
    /* 这条**改过**（原先是"仍然给 pairing-required"）。改的理由：
       配对码那条路要能走通，设备必须拿得到输码的页面，而窗口关着时 HTTP 那半边对
       陌生人 404 —— 于是"等配对码"的请求根本没有兑现的途径。留下它只有一个后果：
       陌生设备往你的台账里写字、给你推一条你无法处理的手机通知。
       现在窗口关着就直说关着（pairing-closed），**连记录都不落**。 */
    await hub.setPairingWindow({ close: true })
    let code = ''
    let requestId: unknown = 'unset'
    const probe = await HubClient.create({
      identityFile: path.join(home, 'clients', 'stranger.json'),
      url: hubUrl,
      role: 'operator',
      scopes: ['employee.read'] as never,
      clientId: 'dse-cli',
      displayName: 'stranger',
      autoReconnect: false,
    })
    probe.on('handshakeFailed', (error) => {
      code = error.code
      requestId = (error.details as { requestId?: string } | undefined)?.requestId
    })
    await assert.rejects(() => probe.connect())
    const deviceId = probe.identity.deviceId
    probe.close()
    assert.equal(code, 'pairing-closed', '窗口关着就该说"窗口关着"')
    assert.equal(requestId, undefined, '不该给一个没法兑现的 requestId')
    const store = new HubStore(home)
    await store.load()
    assert.equal(store.state().pending[deviceId] !== undefined, false)
    assert.equal(
      Object.values(store.state().pending).some((r) => r.deviceId === deviceId),
      false,
      '窗口关着时不该留下待配对记录',
    )
  })

  it('窗口开着时照旧给 pairing-required 与 requestId（配对码要兑换的就是它）', async () => {
    await hub.setPairingWindow({ openMinutes: 15 })
    let code = ''
    let requestId: unknown
    const probe = await HubClient.create({
      identityFile: path.join(home, 'clients', 'stranger2.json'),
      url: hubUrl,
      role: 'operator',
      scopes: ['employee.read'] as never,
      clientId: 'dse-cli',
      displayName: 'stranger2',
      autoReconnect: false,
    })
    probe.on('handshakeFailed', (error) => {
      code = error.code
      requestId = (error.details as { requestId?: string } | undefined)?.requestId
    })
    await assert.rejects(() => probe.connect())
    probe.close()
    assert.equal(code, 'pairing-required')
    assert.equal(typeof requestId, 'string')
    /* 收尾：清掉这条请求，别影响"取第一条待配对"的相邻用例。 */
    const { rejectPairing } = await import('../src/hub/devices.ts')
    const store = new HubStore(home)
    await store.load()
    await rejectPairing(store, requestId as string)
    await hub.setPairingWindow({ close: true })
  })
})
