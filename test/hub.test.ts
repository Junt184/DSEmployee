/**
 * Hub 集成测试 —— 在进程内起一个真实 Hub，用真实 WebSocket 客户端走完整握手。
 *
 * 覆盖的是**安全边界**而不是业务逻辑：这些断言一旦失守，整套授权模型就形同虚设，
 * 所以宁可在这里写得啰嗦。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { hashPairCode, issuePairCode } from '../src/hub/paircode.ts'
import type { PairingRequest } from '../src/hub/types.ts'
import { HubClient, HubCallError } from '../src/client/hub-client.ts'
import { generateIdentity } from '../src/protocol/index.ts'
import { readJsonFile, writeJsonFile } from '../src/util/fsx.ts'
import { WebSocket } from 'ws'

let tmpRoot = ''
let hub: Hub
let hubUrl = ''
let home = ''

before(async () => {
  tmpRoot = await mkdtemp(path.join(process.cwd(), '.tmp-hub-test-'))
  home = path.join(tmpRoot, 'home')
  hub = new Hub({ home, port: 0, verbose: false })
  const address = await hub.start()
  hubUrl = address.wsUrl
})

after(async () => {
  await hub.stop()
  await rm(tmpRoot, { recursive: true, force: true })
})

function identityPath(name: string): string {
  return path.join(home, 'test-clients', `${name}.json`)
}

async function makeClient(
  name: string,
  role: 'operator' | 'node',
  scopes: string[],
  options: { token?: string; autoReconnect?: boolean; headers?: Record<string, string> } = {},
): Promise<HubClient> {
  return await HubClient.create({
    identityFile: identityPath(name),
    url: hubUrl,
    role,
    scopes: scopes as never,
    clientId: role === 'node' ? 'dse-node' : 'dse-cli',
    displayName: name,
    autoReconnect: options.autoReconnect ?? false,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  })
}

describe('握手与配对', () => {
  it('未配对的 operator 会被要求配对，且拿到 requestId', async () => {
    const client = await makeClient('op-unpaired', 'operator', ['employee.read'])
    let code = ''
    let requestId: unknown
    client.on('handshakeFailed', (error) => {
      code = error.code
      requestId = (error.details as { requestId?: string } | undefined)?.requestId
    })
    await assert.rejects(() => client.connect())
    client.close()

    assert.equal(code, 'pairing-required')
    assert.equal(typeof requestId, 'string', '必须给出 requestId，否则用户没法批准')

    // 台账里应确实躺着这条请求
    const store = new HubStore(home)
    await store.load()
    assert.ok(store.state().pending[requestId as string] !== undefined)
  })

  it('node 角色 + 无 scope + 回环 → 自动批准并签发令牌', async () => {
    const client = await makeClient('node-auto', 'node', [])
    const hello = await client.connect()
    assert.equal(hello.auth.role, 'node')
    assert.equal(typeof hello.auth.deviceToken, 'string', '自动批准应同时签发设备令牌')
    assert.deepEqual(hello.auth.scopes, [])
    client.close()
  })

  it('operator 即使来自回环也不会自动批准（必须人工）', async () => {
    const client = await makeClient('op-loopback', 'operator', [])
    await assert.rejects(() => client.connect())
    client.close()

    const store = new HubStore(home)
    await store.load()
    const pending = Object.values(store.state().pending).filter((r) => r.role === 'operator')
    assert.ok(pending.length >= 1, 'operator 请求应留在待审批里')
  })

  it('本地批准后，设备首次连接即领取令牌；生效 scope 被裁到批准集合内', async () => {
    const client = await makeClient('op-approved', 'operator', [
      'employee.read',
      'employee.prompt',
    ])
    await assert.rejects(() => client.connect())
    client.close()

    const store = new HubStore(home)
    await store.load()
    const request = Object.values(store.state().pending).find(
      (r) => r.deviceId === client.identity.deviceId,
    )
    assert.ok(request !== undefined)

    // 只批准 read，故意不给 prompt
    await approvePairing(store, request.requestId, 'test', {
      approvedScopes: ['employee.read'] as never,
    })

    // 关键：**不带令牌**重连 —— 首次连接会自动领取令牌
    const claimed = await makeClient('op-approved', 'operator', [
      'employee.read',
      'employee.prompt',
    ])
    let issued: string | undefined
    claimed.on('deviceToken', ({ token }) => {
      issued = token
    })
    const hello = await claimed.connect()
    assert.equal(typeof issued, 'string', '首次连接应领取到设备令牌')
    assert.deepEqual(hello.auth.scopes, ['employee.read'], '未被批准的 scope 必须被裁掉')
    claimed.close()
  })

  it('批准时把某个角色拿不到的 scope 写进去，会被拒绝', async () => {
    /* 自己造一条**待配对**的 node 请求，不依赖前面用例留下的台账。
       原实现从 store 里捞"任意一条 role==='node' 的 pending"，捞不到就
       **整个断言都不执行、用例照样 pass** —— 而那正是"批准时的 scope 上限
       钉死在角色能拿到的集合"这条核心不变量的唯一守卫（假通过比没测更危险）。
       要造出 pending：节点的自动批准只在"未索要任何 scope"时触发，
       所以这里刻意要求一个 scope，让请求停在待批准状态。 */
    const probe = await makeClient('node-ceiling', 'node', ['employee.read'])
    await assert.rejects(() => probe.connect())
    probe.close()

    const store = new HubStore(home)
    await store.load()
    const nodePending = Object.values(store.state().pending).find((r) => r.role === 'node')
    assert.ok(nodePending !== undefined, '必须有一条待配对的 node 请求可供断言')

    // node 角色的天花板是 ['employee.read','employee.invoke']，approval.resolve 不在其中
    await assert.rejects(
      () =>
        approvePairing(store, nodePending.requestId, 'test', {
          approvedScopes: ['approval.resolve'] as never,
        }),
      /beyond role/,
    )
  })

  it('伪造签名（换公钥）会被拒', async () => {
    const client = await makeClient('op-forge', 'operator', ['employee.read'])
    const forged = generateIdentity()
    // 直接篡改客户端身份里的公钥，签名就用不上了
    ;(client.identity as { publicKey: string }).publicKey = forged.publicKey

    let code = ''
    client.on('handshakeFailed', (error) => {
      code = error.code
    })
    await assert.rejects(() => client.connect())
    client.close()
    assert.equal(code, 'device-signature-invalid')
  })

  it('已领过令牌的设备，不带令牌重连会被拒并给出下一步提示', async () => {
    // node-auto 在之前的用例里已自动批准并领取过令牌
    const store = new HubStore(home)
    await store.load()
    const paired = Object.values(store.state().paired).find((d) => d.tokenClaimed)
    assert.ok(paired !== undefined, '应存在一个已领过令牌的设备')

    const client = await HubClient.create({
      identityFile: identityPath('node-auto'),
      url: hubUrl,
      role: 'node',
      scopes: [],
      clientId: 'dse-node',
      autoReconnect: false,
    })
    let code = ''
    let details: Record<string, unknown> | undefined
    client.on('handshakeFailed', (error) => {
      code = error.code
      details = error.details
    })
    await assert.rejects(() => client.connect())
    client.close()
    assert.equal(code, 'auth-mismatch')
    assert.ok(details?.['recommendedNextStep'] !== undefined)
  })

  it('令牌只能领一次：第二次用错误令牌必然失败', async () => {
    const store = new HubStore(home)
    await store.load()
    const paired = Object.values(store.state().paired).find((d) => d.tokenClaimed)
    assert.ok(paired !== undefined)

    const client = await HubClient.create({
      identityFile: identityPath('node-auto'),
      url: hubUrl,
      role: 'node',
      scopes: [],
      clientId: 'dse-node',
      autoReconnect: false,
      token: 'obviously-wrong-token-value',
    })
    let code = ''
    client.on('handshakeFailed', (error) => {
      code = error.code
    })
    await assert.rejects(() => client.connect())
    client.close()
    assert.equal(code, 'auth-mismatch')
  })
})

describe('方法派发与权限', () => {
  /**
   * 造一个已配对且已领取令牌的 operator 客户端。
   *
   * 走的是真实流程：先连一次（被要求配对）→ 本地批准 → 再连一次（自动领取令牌）。
   */
  async function approvedOperator(name: string, scopes: string[]): Promise<HubClient> {
    const probe = await makeClient(name, 'operator', scopes)
    await assert.rejects(() => probe.connect())
    const deviceId = probe.identity.deviceId
    probe.close()

    const store = new HubStore(home)
    await store.load()
    const request = Object.values(store.state().pending).find((r) => r.deviceId === deviceId)
    assert.ok(request !== undefined, `no pending request for ${name}`)
    await approvePairing(store, request.requestId, 'test', { approvedScopes: scopes as never })

    const client = await makeClient(name, 'operator', scopes)
    await client.connect()
    return client
  }

  it('未知方法一律拒绝（fail-closed）', async () => {
    const client = await approvedOperator('op-unknown', ['employee.read'])
    await assert.rejects(
      () => client.call('evil.method'),
      (error: unknown) => error instanceof HubCallError && error.code === 'unknown-method',
    )
    client.close()
  })

  it('scope 不足时拒绝，并回报所需与已有 scope', async () => {
    const client = await approvedOperator('op-readonly', ['employee.read'])
    // 员工派活走 session.prompt（不存在 employee.prompt 这种"按员工"的写法）
    await assert.rejects(
      () => client.call('session.prompt', { employeeId: 'x', sessionId: 'y', text: 'hi' }),
      (error: unknown) =>
        error instanceof HubCallError &&
        error.code === 'forbidden' &&
        Array.isArray((error.details as { requiredScopes?: string[] })?.requiredScopes),
    )
    client.close()
  })

  it('operator 专属方法对 node 角色不可见也不可调', async () => {
    const node = await makeClient('node-perm', 'node', [])
    await node.connect()
    await assert.rejects(
      () => node.call('device.pair.approve', { requestId: 'x' }),
      (error: unknown) => error instanceof HubCallError && error.code === 'forbidden',
    )
    const hello = node.hello
    assert.ok(hello !== undefined)
    assert.ok(
      !hello.features.methods.includes('device.pair.approve'),
      'node 的发现清单里不应出现 operator 专属方法',
    )
    node.close()
  })

  it('health / whoami 认证后即可用', async () => {
    const client = await approvedOperator('op-health', ['employee.read'])
    const health = await client.call<{ ok: boolean; counts: { nodes: number } }>('health')
    assert.equal(health.ok, true)
    const whoami = await client.call<{ role: string }>('whoami')
    assert.equal(whoami.role, 'operator')
    client.close()
  })

  it('有副作用的方法缺幂等键会被拒', async () => {
    // 注意必须给够 scope：派发顺序是「角色 → scope → 幂等键 → 业务」，
    // 权限不足的调用方只会看到 forbidden，看不到"你缺幂等键"这种细节。
    const client = await approvedOperator('op-idem', ['employee.read', 'employee.manage'])
    await assert.rejects(
      () => client.call('acl.set', { from: '*', to: '*', effect: 'deny' }),
      (error: unknown) =>
        error instanceof HubCallError && error.code === 'idempotency-key-required',
    )
    client.close()
  })
})

describe('节点注册与目录聚合', () => {
  it('节点上报员工后，operator 能聚合看到；重复上报会全量收敛', async () => {
    const node = await makeClient('node-reg', 'node', [])
    await node.connect()

    const register = async (employees: unknown[]): Promise<{ registeredEmployees: number }> =>
      await node.call(
        'node.register',
        {
          name: '测试节点',
          platform: 'test',
          employeeRoot: 'C:\\fake\\employees',
          employees,
        },
        { idempotencyKey: `reg-${Math.random()}` },
      )

    const first = await register([
      {
        id: 'emp_test_1',
        name: '小艾',
        role: '负责周报整理',
        workspacePath: 'C:\\fake\\employees\\alice',
        group: '运营组',
        hasAvatar: true,
        /* 头像版本：控制台的本地缓存据此判断"要不要重新下载这几百 KB 的图" */
        avatarUpdatedAtMs: 1790239081643,
        avatarBytes: 367001,
        skills: ['weekly-report'],
        status: 'ok',
        createdAtMs: Date.now(),
      },
    ])
    assert.equal(first.registeredEmployees, 1)

    // 让一个 operator 看到目录：先连一次拿到待审批请求，本地批准，再带令牌重连
    const viewer = await makeClient('op-listing', 'operator', ['employee.read'])
    await assert.rejects(() => viewer.connect())
    viewer.close()

    const store = new HubStore(home)
    await store.load()
    const pending = Object.values(store.state().pending).find(
      (r) => r.deviceId === viewer.identity.deviceId,
    )
    assert.ok(pending !== undefined)
    await approvePairing(store, pending.requestId, 'test', {
      approvedScopes: ['employee.read'] as never,
    })

    const connected = await makeClient('op-listing', 'operator', ['employee.read'])
    await connected.connect()
    const listed = await connected.call<{
      employees: Array<{
        id: string
        name: string
        nodeName: string
        group?: string
        hasAvatar?: boolean
        avatarUpdatedAtMs?: number
        avatarBytes?: number
      }>
    }>('employee.list')
    const alice = listed.employees.find((e) => e.id === 'emp_test_1')
    assert.ok(alice !== undefined, '聚合列表里应有刚上报的员工')
    assert.equal(alice.name, '小艾')
    assert.equal(alice.nodeName, '测试节点')
    assert.equal(alice.group, '运营组', 'node.register 携带的 group 应落库并随 employee.list 带出')
    assert.equal(alice.hasAvatar, true, 'node.register 携带的 hasAvatar 应落库并随 employee.list 带出')
    /* 头像版本必须一路透出来：控制台靠它决定"一个字节都不用传"还是重新下载。
       少了它，每次刷新都会把所有人的头像重拉一遍（实测 9 人约 4.2 MB）。 */
    assert.equal(alice.avatarUpdatedAtMs, 1790239081643, '头像版本（mtime）要随 employee.list 带出')
    assert.equal(alice.avatarBytes, 367001, '头像字节数要随 employee.list 带出')

    // 第二次只报一个完全不同的员工 → 上一个应被收敛掉（全量替换语义）
    const second = await register([
      {
        id: 'emp_test_2',
        name: '小博',
        role: '负责数据核对',
        workspacePath: 'C:\\fake\\employees\\bob',
        skills: [],
        status: 'ok',
        createdAtMs: Date.now(),
      },
    ])
    assert.equal(second.registeredEmployees, 1)

    const after = await connected.call<{ employees: Array<{ id: string }> }>('employee.list')
    assert.equal(after.employees.find((e) => e.id === 'emp_test_1'), undefined, '陈旧员工应被移除')
    assert.ok(after.employees.find((e) => e.id === 'emp_test_2') !== undefined)

    connected.close()
    node.close()
  })
})

/**
 * 在未认证阶段直接发一帧 redeem —— Web 控制台的配对码通道就是这样走的
 * （server.ts 的 awaiting-connect 分支单独受理这个方法）。
 */
async function redeemRaw(
  requestId: string,
  code: string,
): Promise<{ ok: boolean; error?: { code: string; details?: { reason?: string } } }> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(hubUrl)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('redeem timeout'))
    }, 5000)
    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          type: 'req',
          id: 'redeem-1',
          method: 'device.pair.redeem',
          params: { requestId, code },
        }),
      )
    })
    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(String(data)) as { type: string; id?: string }
      if (frame.type !== 'res' || frame.id !== 'redeem-1') return
      clearTimeout(timer)
      socket.close()
      resolve(frame as never)
    })
    socket.on('error', reject)
  })
}

/** 造一个未配对设备并拿到它的 pairing requestId。 */
async function nextPairingRequest(name: string): Promise<string> {
  const client = await makeClient(name, 'operator', ['employee.read'])
  let requestId = ''
  client.on('handshakeFailed', (error) => {
    requestId = String((error.details as { requestId?: string } | undefined)?.requestId ?? '')
  })
  await assert.rejects(() => client.connect())
  client.close()
  assert.ok(requestId !== '', 'pairing-required 必须带 requestId')
  return requestId
}

/** 另开一个 HubStore 实例读最新台账（本实例的 load() 有缓存，看不到 Hub 进程内的变更）。 */
async function freshStore(): Promise<HubStore> {
  const store = new HubStore(home)
  await store.load()
  return store
}

describe('配对码引导（device.pair.redeem）', () => {
  it('正确码批准成功、码随即作废（重放被拒）、设备随后能领到令牌', async () => {
    const requestId = await nextPairingRequest('op-redeem-ok')
    const store = await freshStore()
    const code = await issuePairCode(store)

    const ok = await redeemRaw(requestId, code)
    assert.equal(ok.ok, true, '正确码应批准成功')
    assert.equal((await freshStore()).state().pending[requestId], undefined, '批准后 pending 应清空')

    // 重放同一个码 → used（一次性）
    const replay = await redeemRaw(requestId, code)
    assert.equal(replay.ok, false)
    assert.equal(replay.error?.code, 'pair-code-invalid')
    assert.equal(replay.error?.details?.reason, 'used')

    // 设备完成签名握手后自行领取令牌（approve 不签发令牌，见 devices.ts）
    const client = await makeClient('op-redeem-ok', 'operator', ['employee.read'])
    const hello = await client.connect()
    assert.equal(typeof hello.auth.deviceToken, 'string', '批准后首次连接应领到令牌')
    client.close()
  })

  it('错码被拒且 pending 请求保留', async () => {
    const requestId = await nextPairingRequest('op-redeem-wrong')
    const store = await freshStore()
    const code = await issuePairCode(store)
    const wrong = code === '000000' ? '000001' : '000000'

    const res = await redeemRaw(requestId, wrong)
    assert.equal(res.ok, false)
    assert.equal(res.error?.code, 'pair-code-invalid')
    assert.equal(res.error?.details?.reason, 'wrong')
    assert.ok((await freshStore()).state().pending[requestId] !== undefined, '错码不应消耗配对请求')
  })

  it('过期码被拒', async () => {
    const requestId = await nextPairingRequest('op-redeem-expired')
    const store = await freshStore()
    const code = await issuePairCode(store)
    // 直接把文件改成已过期 —— 等价于"时间过去了 24h"，比等它真过期现实得多
    await writeJsonFile(store.files.pairCode, {
      sha256: hashPairCode(code),
      createdAtMs: Date.now() - 25 * 3600_000,
      expiresAtMs: Date.now() - 1000,
      used: false,
    })

    const res = await redeemRaw(requestId, code)
    assert.equal(res.ok, false)
    assert.equal(res.error?.details?.reason, 'expired')
  })
})

describe('节点配对码（node.paircode.offer）', () => {
  it('节点上报的码可 redeem 成功、随即作废（重放被拒）', async () => {
    // 节点角色 + 回环 + 无 scope 请求 → 走既有的自动批准通道连上
    const node = await makeClient('node-pc', 'node', [])
    await node.connect()

    const code = '314159'
    const offered = await node.call<{ offerId: string }>('node.paircode.offer', {
      codeHash: hashPairCode(code),
      expiresAtMs: Date.now() + 10 * 60_000,
      label: '公司Mac',
    })
    assert.equal(typeof offered.offerId, 'string')

    const requestId = await nextPairingRequest('op-redeem-node')
    const ok = await redeemRaw(requestId, code)
    assert.equal(ok.ok, true, '节点码应能完成配对')

    // 重放 → used（与 Hub 码同语义）
    const replay = await redeemRaw(requestId, code)
    assert.equal(replay.ok, false)
    assert.equal(replay.error?.details?.reason, 'used')

    // 审计：码池里这条记录应带 nodeId 且已标记 used
    const poolFile = await readJsonFile<Record<string, { nodeId: string; used: boolean }>>(
      (await freshStore()).files.nodePairCodes,
      {},
    )
    const entry = Object.values(poolFile).find((item) => item.nodeId === node.identity.deviceId)
    assert.ok(entry !== undefined, '码池里应有该节点的记录')
    assert.equal(entry.used, true)

    node.close()
  })

  it('过期的节点码被拒（expired）', async () => {
    const store = await freshStore()
    const code = '271828'
    // 直接写一条已过期的节点码 —— 等价于"码放久了"，比真等 30 分钟现实
    await writeJsonFile(store.files.nodePairCodes, {
      pc_expired: {
        sha256: hashPairCode(code),
        nodeId: 'node_fake',
        createdAtMs: Date.now() - 40 * 60_000,
        expiresAtMs: Date.now() - 1000,
        used: false,
      },
    })

    const requestId = await nextPairingRequest('op-redeem-node-expired')
    const res = await redeemRaw(requestId, code)
    assert.equal(res.ok, false)
    assert.equal(res.error?.details?.reason, 'expired')
  })

  it('非 node 角色调 offer 被拒（forbidden）', async () => {
    // 先造一个已批准的 operator（走本地批准兜底路径）
    const name = 'op-not-node'
    const requestId = await nextPairingRequest(name)
    const store = await freshStore()
    await approvePairing(store, requestId, 'test')

    const operator = await makeClient(name, 'operator', ['employee.read'])
    await operator.connect()
    const error = await operator
      .call('node.paircode.offer', {
        codeHash: hashPairCode('999999'),
        expiresAtMs: Date.now() + 60_000,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )
    assert.ok(error instanceof HubCallError)
    assert.equal(error.code, 'forbidden')
    operator.close()
  })
})

describe('trust-proxy（反代后的真实客户端 IP）', () => {
  /* 独立于主 Hub：主 Hub 没开 trust-proxy，这组用例需要两套行为对照 */
  let proxyHub: Hub
  let proxyUrl = ''
  let proxyHome = ''

  before(async () => {
    proxyHome = path.join(tmpRoot, 'home-proxy')
    proxyHub = new Hub({ home: proxyHome, port: 0, trustProxy: true })
    proxyUrl = (await proxyHub.start()).wsUrl
  })
  after(async () => {
    await proxyHub.stop()
  })

  async function proxiedNode(
    name: string,
    headers?: Record<string, string>,
  ): Promise<HubClient> {
    return await HubClient.create({
      identityFile: identityPath(name),
      url: proxyUrl,
      role: 'node',
      scopes: [],
      clientId: 'dse-node',
      displayName: name,
      autoReconnect: false,
      ...(headers === undefined ? {} : { headers }),
    })
  }

  async function pendingOf(homeDir: string, deviceId: string): Promise<PairingRequest | undefined> {
    const store = new HubStore(homeDir)
    await store.load()
    return Object.values(store.state().pending).find((r) => r.deviceId === deviceId)
  }

  it('开启后：带 X-Real-IP 的节点不再被 fromLoopback 自动批准（进 pending）', async () => {
    const client = await proxiedNode('node-via-proxy', { 'x-real-ip': '203.0.113.66' })
    let code = ''
    client.on('handshakeFailed', (error) => {
      code = error.code
    })
    await assert.rejects(() => client.connect())
    client.close()
    assert.equal(code, 'pairing-required', '公网 IP 的节点必须进人工审批，不能自动批准')

    const request = await pendingOf(proxyHome, client.identity.deviceId)
    assert.ok(request !== undefined)
    assert.equal(request.remoteIp, '203.0.113.66', '台账应记真实客户端 IP')
    assert.equal(request.fromLoopback, false)
  })

  it('开启后：X-Forwarded-For 取链首（最左是原始客户端）', async () => {
    const client = await proxiedNode('node-via-xff', { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' })
    await assert.rejects(() => client.connect())
    client.close()
    const request = await pendingOf(proxyHome, client.identity.deviceId)
    assert.equal(request?.remoteIp, '198.51.100.7')
    assert.equal(request?.fromLoopback, false)
  })

  it('开启后：不带头的直连回环仍自动批准（反代之外的本地流量不变）', async () => {
    const client = await proxiedNode('node-direct-loopback')
    const hello = await client.connect()
    assert.equal(typeof hello.auth.deviceToken, 'string', '直连回环节点应照常自动批准')
    client.close()
  })

  it('关闭时（主 Hub）：伪造 X-Real-IP 无效，仍按 TCP 对端判定', async () => {
    /* 主 Hub 没开 trust-proxy：头一律不信。带头说自己是公网 IP，
       也仍按 TCP 回环处理 → 自动批准（若头被信，这里会是 pairing-required）。 */
    const client = await makeClient('node-spoofed-header', 'node', [], {
      headers: { 'x-real-ip': '203.0.113.99' },
    })
    const hello = await client.connect()
    assert.equal(typeof hello.auth.deviceToken, 'string', 'trust-proxy 关闭时头必须被忽略')
    client.close()
  })
})

describe('办公区排序偏好（office.order.*）', () => {
  /** 造一个已批准、带指定 scope 的 operator 客户端（本机批准引导路径）。 */
  async function approvedOperator(name: string, scopes: string[]): Promise<HubClient> {
    const probe = await makeClient(name, 'operator', scopes)
    await assert.rejects(() => probe.connect())
    probe.close()
    const store = await freshStore()
    const request = Object.values(store.state().pending).find(
      (r) => r.deviceId === probe.identity.deviceId,
    )
    assert.ok(request !== undefined)
    await approvePairing(store, request.requestId, 'test', {
      approvedScopes: scopes as never,
    })
    const client = await makeClient(name, 'operator', scopes)
    await client.connect()
    return client
  }

  it('set → get 回读一致；未知组/员工 id 容忍不报错', async () => {
    const client = await approvedOperator('op-office-1', ['employee.read', 'employee.manage'])
    const prefs = {
      groupOrder: ['运营组', '幽灵组'], // 幽灵组：目录里不存在，应被容忍
      employeeOrder: { 运营组: ['emp_ghost_1', 'emp_ghost_2'] },
    }
    const set = await client.call<{ saved: boolean }>('office.order.set', prefs, {
      idempotencyKey: `office-set-${Date.now()}`,
    })
    assert.equal(set.saved, true)

    const got = await client.call<{
      groupOrder: string[]
      employeeOrder: Record<string, string[]>
    }>('office.order.get', {})
    assert.deepEqual(got.groupOrder, prefs.groupOrder)
    assert.deepEqual(got.employeeOrder, prefs.employeeOrder)

    /* 换一台控制台读到的是同一份（跨设备一致的核心断言） */
    const second = await approvedOperator('op-office-2', ['employee.read'])
    const got2 = await second.call<{ groupOrder: string[] }>('office.order.get', {})
    assert.deepEqual(got2.groupOrder, prefs.groupOrder)
    second.close()
    client.close()
  })

  it('写后广播 office.order.changed；无 employee.manage 的写入被拒', async () => {
    const writer = await approvedOperator('op-office-3', ['employee.read', 'employee.manage'])
    const reader = await approvedOperator('op-office-4', ['employee.read'])

    let gotEvent = false
    reader.onEvent('office.order.changed', () => {
      gotEvent = true
    })
    await writer.call(
      'office.order.set',
      { groupOrder: ['甲'], employeeOrder: {} },
      { idempotencyKey: `office-set2-${Date.now()}` },
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(gotEvent, true, '其它在线控制台应收到 office.order.changed')

    /* 只有 read 没有 manage：读可以，写必须 forbidden */
    await assert.rejects(
      () =>
        reader.call('office.order.set', { groupOrder: [], employeeOrder: {} }, {
          idempotencyKey: `office-deny-${Date.now()}`,
        }),
      (error: unknown) => error instanceof HubCallError && error.code === 'forbidden',
    )
    reader.close()
    writer.close()
  })
})

describe('僵尸连接清理（ping/pong + 同 nodeId 去重）', () => {
  /*
   * 线上事故形状：节点看门狗检测到半开后重连成功，但 Hub 连接表里的旧连接
   * 永远收不到 close（半开的定义），nodeConnection() 选中僵尸 → 转发全超时。
   * 这里用短 tick 间隔（150ms）快速驱动 ping 清扫。
   */
  let zHub: Hub
  let zUrl = ''
  let zHome = ''

  before(async () => {
    zHome = path.join(tmpRoot, 'home-zombie')
    zHub = new Hub({ home: zHome, port: 0, tickIntervalMs: 150 })
    zUrl = (await zHub.start()).wsUrl
  })
  after(async () => {
    await zHub.stop()
  })

  const zClient = (name: string, token?: string) =>
    HubClient.create({
      identityFile: path.join(zHome, 'clients', `${name}.json`),
      url: zUrl,
      role: 'node',
      scopes: [],
      clientId: 'dse-node',
      displayName: name,
      autoReconnect: false,
      ...(token === undefined ? {} : { token }),
    })

  it('同 nodeId 重连：旧连接被淘汰，转发请求落到新连接', async () => {
    const first = await zClient('node-z')
    let token = ''
    first.on('deviceToken', ({ token: t }) => {
      token = t
    })
    await first.connect()
    assert.ok(token !== '', '首次连接应领到令牌')
    const nodeId = first.identity.deviceId

    // 同一身份再连（模拟"看门狗重连成功而旧连接变僵尸"）；
    // 第二条连接握手完成的瞬间，Hub 应 terminate 第一条
    const second = await zClient('node-z', token)
    let secondGotRequest: unknown = null
    second.on('request', (frame) => {
      secondGotRequest = frame
      second.respond(frame.id, { ok: true, payload: { answeredBy: 'second' } })
    })
    await second.connect()

    // 等淘汰生效（terminate 的 close 事件是异步的）
    await new Promise((r) => setTimeout(r, 300))
    const ready = [...zHub.connections].filter(
      (c) => c.phase === 'ready' && c.role === 'node' && c.nodeId === nodeId,
    )
    assert.equal(ready.length, 1, '同一 nodeId 只应剩一条连接')

    // 转发必须落到新连接上
    const res = await zHub.requestToNode(nodeId, 'session.watch', { watch: true })
    assert.equal(res.ok, true)
    assert.equal(
      (res.payload as { answeredBy?: string } | undefined)?.answeredBy,
      'second',
      '转发应答必须来自新连接',
    )
    assert.ok(secondGotRequest !== null)

    first.close()
    second.close()
  })

  it('不回 pong 的僵尸连接在两个清扫周期内被 terminate', async () => {
    // ws 客户端默认自动回 pong；autoPong:false 模拟"TCP 通了但协议栈死了"的僵尸
    const zombie = new WebSocket(zUrl, { autoPong: false })
    await new Promise<void>((resolve, reject) => {
      zombie.on('open', () => resolve())
      zombie.on('error', reject)
    })
    assert.ok([...zHub.connections].length > 0)

    const closed = new Promise<number>((resolve) => {
      zombie.on('close', (code) => resolve(code))
    })
    const code = await Promise.race([
      closed,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('僵尸连接 3s 内未被清理')), 3000),
      ),
    ])
    assert.equal(typeof code, 'number', '僵尸应收到 close（被 terminate）')
  })
})

describe('启动守卫', () => {
  it('拒绝在非回环地址上静默启动（认证不保护传输）', async () => {
    const guardHome = path.join(tmpRoot, 'guard-home')
    const guarded = new Hub({ home: guardHome, port: 0, host: '0.0.0.0' })
    await assert.rejects(() => guarded.start(), /refusing to bind 0\.0\.0\.0/)
    // 被拒后不应留下锁
    const afterStop = new Hub({ home: guardHome, port: 0 })
    await afterStop.start()
    await afterStop.stop()
  })

  it('显式确认后允许非回环绑定', async () => {
    const optInHome = path.join(tmpRoot, 'optin-home')
    const hub2 = new Hub({
      home: optInHome,
      port: 0,
      host: '0.0.0.0',
      allowNonLoopbackBind: true,
    })
    const address = await hub2.start()
    assert.equal(address.host, '0.0.0.0')
    await hub2.stop()
  })

  it('同一状态目录不允许两个 Hub 同时启动', async () => {
    const sharedHome = path.join(tmpRoot, 'shared-home')
    const first = new Hub({ home: sharedHome, port: 0 })
    await first.start()

    const second = new Hub({ home: sharedHome, port: 0 })
    await assert.rejects(
      () => second.start(),
      /another hub appears to be running/,
      '两个 Hub 共用状态目录会互相覆盖设备与员工记录，必须拒绝',
    )

    // 第一个停掉后应能正常接管（锁被释放）
    await first.stop()
    const third = new Hub({ home: sharedHome, port: 0 })
    await third.start()
    await third.stop()
  })

  it('陈旧锁（进程已不存在）会被接管，而不是把 Hub 永久挡在门外', async () => {
    const staleHome = path.join(tmpRoot, 'stale-home')
    const store = new HubStore(staleHome)
    await store.load()
    // 造一个几乎不可能存在的 pid
    await writeJsonFile(store.files.lock, { pid: 999_999_999, startedAtMs: 0 })

    const hub3 = new Hub({ home: staleHome, port: 0 })
    await hub3.start()
    await hub3.stop()
  })
})

describe('员工互调授权（ACL）', () => {
  it('默认策略是需要审批，而不是直接放行', async () => {
    const { evaluateAcl } = await import('../src/hub/acl.ts')
    const decision = evaluateAcl([], 'emp_a', 'emp_b')
    assert.equal(decision.effect, 'approve')
  })

  it('精确规则优先于通配规则；同具体度时 deny 胜出', async () => {
    const { evaluateAcl } = await import('../src/hub/acl.ts')
    const rules = [
      { id: 'r1', from: '*', to: '*', effect: 'deny' as const, createdAtMs: 0, createdBy: 't' },
      { id: 'r2', from: 'emp_a', to: 'emp_b', effect: 'allow' as const, createdAtMs: 0, createdBy: 't' },
      { id: 'r3', from: 'emp_a', to: 'emp_c', effect: 'allow' as const, createdAtMs: 0, createdBy: 't' },
      { id: 'r4', from: 'emp_a', to: 'emp_c', effect: 'deny' as const, createdAtMs: 0, createdBy: 't' },
    ]
    assert.equal(evaluateAcl(rules, 'emp_a', 'emp_b').effect, 'allow')
    assert.equal(evaluateAcl(rules, 'emp_a', 'emp_c').effect, 'deny', 'deny 必须优先')
    assert.equal(evaluateAcl(rules, 'emp_x', 'emp_y').effect, 'deny', '通配 deny 兜底')
  })

  it('CI 之外的来源不会被误判为回环', async () => {
    const { ipInCidr } = await import('../src/hub/devices.ts')
    assert.equal(ipInCidr('127.0.0.1', '127.0.0.0/8'), true)
    assert.equal(ipInCidr('192.168.1.5', '192.168.1.0/24'), true)
    assert.equal(ipInCidr('192.168.2.5', '192.168.1.0/24'), false)
    assert.equal(ipInCidr('10.0.0.1', '192.168.1.0/24'), false)
    // IPv6 一律返回 false —— 安全的失败方向（仍需人工审批）
    assert.equal(ipInCidr('::1', '::1/128'), false)
  })
})

describe('设备台账', () => {
  it('令牌只存哈希，台账文件里不含明文', async () => {
    const store = new HubStore(home)
    await store.load()
    const listed = await import('node:fs/promises').then((fs) =>
      fs.readFile(store.files.paired, 'utf8'),
    )
    assert.ok(!listed.includes('"token"'), '不得出现明文 token 字段')
    assert.ok(listed.includes('tokenHash'), '应保存 tokenHash')
  })

  it('身份文件与台账都可被重新载入（幂等）', async () => {
    const store = new HubStore(home)
    const first = await store.load()
    const second = await new HubStore(home).load()
    assert.equal(first.config.hubId, second.config.hubId)
    assert.equal(first.identity.deviceId, second.identity.deviceId)
  })

  it('过期的待配对请求既不能被批准，也会被清理', async () => {
    const { sweepExpiredPairings, approvePairing: approve, PAIRING_TTL_MS } = await import(
      '../src/hub/devices.ts'
    )
    const { makeExpiredPending } = await import('./helpers.ts')

    const store = new HubStore(home)
    await store.load()

    // 1) 批准过期请求必须失败，且失败后该请求被清掉
    const expiredId = 'pair_expired_test'
    store.state().pending[expiredId] = makeExpiredPending(expiredId, PAIRING_TTL_MS)
    await store.savePending()

    await assert.rejects(() => approve(store, expiredId, 'test'), /expired/, '过期请求不可批准')
    assert.equal(store.state().pending[expiredId], undefined, '过期请求应被清除')

    // 2) 清扫器能识别并移除过期条目
    const alsoExpiredId = 'pair_also_expired'
    store.state().pending[alsoExpiredId] = makeExpiredPending(alsoExpiredId, PAIRING_TTL_MS)
    await store.savePending()

    const swept = await sweepExpiredPairings(store)
    assert.ok(swept.includes(alsoExpiredId))
    assert.equal(store.state().pending[alsoExpiredId], undefined)
  })
})

describe('PWA 壳', () => {
  const httpBase = (): string => hubUrl.replace(/^ws/, 'http').replace(/\/ws$/, '')

  it('HTML 引用 manifest 与图标，CSP 放行 manifest-src 与 worker-src', async () => {
    const res = await fetch(httpBase() + '/')
    assert.equal(res.status, 200)
    const csp = res.headers.get('content-security-policy') ?? ''
    assert.ok(csp.includes("manifest-src 'self'"), 'CSP 需含 manifest-src')
    assert.ok(csp.includes("worker-src 'self'"), 'CSP 需含 worker-src')
    const html = await res.text()
    assert.ok(html.includes('<link rel="manifest" href="/manifest.webmanifest">'))
    assert.ok(html.includes('apple-touch-icon'))
    assert.ok(html.includes('/sw.js') === false, '注册逻辑在 /ui.js 里，HTML 不直接引用')
  })

  it('/manifest.webmanifest 以 hub 名为应用名，声明 standalone', async () => {
    const res = await fetch(httpBase() + '/manifest.webmanifest')
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /manifest\+json/)
    const manifest = JSON.parse(await res.text())
    assert.equal(manifest.display, 'standalone')
    assert.equal(manifest.start_url, '/')
    assert.ok(String(manifest.name).includes(hub.store.state().config.name))
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2)
  })

  it('/sw.js 可执行且不拦截 /ws 与 /api', async () => {
    const res = await fetch(httpBase() + '/sw.js')
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/javascript/)
    const source = await res.text()
    assert.ok(source.includes("url.pathname === '/ws'"), 'WS 控制面必须绕过缓存')
    assert.ok(source.includes("'/api'"), 'RPC 必须绕过缓存')
  })

  it('应用图标是合法 PNG（魔数 + 尺寸）', async () => {
    const expected: Record<string, number> = {
      '/icon-180.png': 180,
      '/icon-192.png': 192,
      '/icon-512.png': 512,
    }
    for (const [route, size] of Object.entries(expected)) {
      const res = await fetch(httpBase() + route)
      assert.equal(res.status, 200, route)
      assert.equal(res.headers.get('content-type'), 'image/png')
      const bytes = Buffer.from(await res.arrayBuffer())
      assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], route)
      assert.equal(bytes.readUInt32BE(16), size, route + ' 宽度')
      assert.equal(bytes.readUInt32BE(20), size, route + ' 高度')
    }
  })
})
