/**
 * 「给员工发文件」的边界测试。
 *
 * 这条链路是**网络入口 + 落盘**的组合，所以真正要钉死的是两件事：
 *   ① 路径守卫：任何越出员工工作区的路径都必须被拒（`..`、绝对路径、符号链接式逃逸）；
 *   ② 大小上限：Hub 单帧 4 MiB、base64 膨胀 4/3 —— 超限必须在**写盘之前**失败，
 *      而不是写了一半再崩。
 *
 * 另外验证上传真的落在工作区里、且能覆盖二进制字节（不能变成 UTF-8 字符串往返）。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { EmployeeStore, UPLOAD_MAX_BYTES } from '../src/node/employees.ts'

let root = ''
let store: EmployeeStore

/** 假 dsh：workspace 注册直接成功，测试只关心文件落盘。 */
const fakeDsh = {
  async workspaceCreate(workspacePath: string, title: string) {
    return { workspaceId: 'ws-test', path: workspacePath, title }
  },
  async workspaceList() {
    return { items: [] }
  },
} as never

before(async () => {
  root = await mkdtemp(path.join(process.cwd(), '.tmp-hub-test-upload-'))
  store = new EmployeeStore(root, fakeDsh)
  await store.create({ name: '小艾', role: '测试员工' })
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

async function firstEmployeeId(): Promise<string> {
  const { employees } = await store.discover()
  const id = employees[0]?.id
  assert.ok(id !== undefined, '员工应已创建')
  return id
}

describe('employee.files.upload → 落进员工工作区', () => {
  it('二进制原样落盘（不经 UTF-8 字符串往返）', async () => {
    const employeeId = await firstEmployeeId()
    // 含 0x00 / 0xFF 的字节序列：任何"当字符串处理"的实现都会把它改坏
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f, 0x80, 0x0a, 0x0d])
    const result = await store.uploadFile(employeeId, '收件箱/binary.bin', bytes)
    assert.equal(result.size, bytes.length)

    const { employees } = await store.discover()
    const workspace = employees[0]?.workspacePath
    assert.ok(workspace !== undefined)
    const written = await readFile(path.join(workspace, '收件箱', 'binary.bin'))
    assert.deepEqual(Uint8Array.from(written), Uint8Array.from(bytes))
  })

  it('目录不存在时自动创建（"递材料"不该因为少了收件箱而失败）', async () => {
    const employeeId = await firstEmployeeId()
    await store.uploadFile(employeeId, '收件箱/深层/报告.txt', Buffer.from('hi'))
    const { employees } = await store.discover()
    const workspace = String(employees[0]?.workspacePath)
    assert.equal(await readFile(path.join(workspace, '收件箱/深层/报告.txt'), 'utf8'), 'hi')
  })

  it('越界路径被拒（路径穿越是硬边界）', async () => {
    const employeeId = await firstEmployeeId()
    for (const bad of ['../escape.txt', '../../etc/passwd', '收件箱/../../escape.txt']) {
      await assert.rejects(
        () => store.uploadFile(employeeId, bad, Buffer.from('x')),
        /escapes the employee workspace/,
        `应拒绝 ${bad}`,
      )
    }
  })

  it('绝对路径被拒', async () => {
    const employeeId = await firstEmployeeId()
    await assert.rejects(
      () => store.uploadFile(employeeId, '/tmp/abs.txt', Buffer.from('x')),
      /absolute paths are not allowed/,
    )
  })

  it('超过上限在写盘之前失败', async () => {
    const employeeId = await firstEmployeeId()
    const tooBig = Buffer.alloc(UPLOAD_MAX_BYTES + 1, 0x41)
    await assert.rejects(
      () => store.uploadFile(employeeId, '收件箱/big.bin', tooBig),
      /file is too large/,
    )
    // 关键：拒绝之后不该留下半个文件
    const { employees } = await store.discover()
    const workspace = String(employees[0]?.workspacePath)
    await assert.rejects(
      () => readFile(path.join(workspace, '收件箱/big.bin')),
      /ENOENT/,
      '超限文件不该被落盘',
    )
  })

  it('恰好等于上限可以写', async () => {
    const employeeId = await firstEmployeeId()
    const exact = Buffer.alloc(UPLOAD_MAX_BYTES, 0x42)
    const result = await store.uploadFile(employeeId, '收件箱/exact.bin', exact)
    assert.equal(result.size, UPLOAD_MAX_BYTES)
  })

  it('空文件被拒（多半是调用方出了错，不该静默写一个 0 字节文件）', async () => {
    const employeeId = await firstEmployeeId()
    await assert.rejects(
      () => store.uploadFile(employeeId, '收件箱/empty.bin', Buffer.alloc(0)),
      /empty file/,
    )
  })
})

/* ────────────────────────── 载体往返（真 Hub + 真 WebSocket）──────────────────────────
 *
 * 为什么单独测这一段：上传是**唯一会把 MB 级载荷塞进单帧**的路径，而 Hub 协议对
 * 单帧有 4 MiB 硬上限、base64 还会膨胀 4/3。这种"小文件一切正常、大文件在真实
 * 网络里被掐线"的问题，只有真的把满上限的载荷发过去才验得出来。
 */

import { Hub } from '../src/hub/server.ts'
import { HubStore } from '../src/hub/store.ts'
import { approvePairing } from '../src/hub/devices.ts'
import { HubClient } from '../src/client/hub-client.ts'

describe('2MB 文件经 Hub 转发（真 WS，验载体上限）', () => {
  let tmp = ''
  let hub: Hub
  let url = ''
  let home = ''

  before(async () => {
    tmp = await mkdtemp(path.join(process.cwd(), '.tmp-hub-test-upload-wire-'))
    home = path.join(tmp, 'home')
    hub = new Hub({ home, port: 0, verbose: false })
    url = (await hub.start()).wsUrl
  })
  after(async () => {
    await hub.stop()
    await rm(tmp, { recursive: true, force: true })
  })

  it('满上限 2MB 的 base64 原样到达节点侧（字节数一致）', async () => {
    // 假节点：只解码 base64 并回报长度，用来验证载荷没被截断
    const node = await HubClient.create({
      identityFile: path.join(home, 'clients', 'upload-node.json'),
      url,
      role: 'node',
      scopes: [],
      clientId: 'dse-node',
      displayName: 'upload-node',
      autoReconnect: false,
    })
    let received = -1
    node.on('request', (frame) => {
      const params = (frame.params ?? {}) as Record<string, unknown>
      if (frame.method === 'employee.files.upload') {
        received = Buffer.from(String(params['dataBase64'] ?? ''), 'base64').length
        node.respond(frame.id, { ok: true, payload: { path: params['path'], size: received } })
        return
      }
      node.respond(frame.id, { ok: true, payload: {} })
    })
    await node.connect()
    await node.call(
      'node.register',
      {
        name: 'upload-node',
        platform: 'test',
        employeeRoot: path.join(tmp, 'employees'),
        employees: [
          {
            id: 'emp_upload',
            name: '小艾',
            role: '',
            workspacePath: path.join(tmp, 'employees', 'a'),
            skills: [],
            status: 'ok',
            createdAtMs: Date.now(),
          },
        ],
      },
      { idempotencyKey: 'reg-upload' },
    )

    // 操作端（走真实配对流程）
    const probe = await HubClient.create({
      identityFile: path.join(home, 'clients', 'upload-op.json'),
      url,
      role: 'operator',
      scopes: ['employee.manage', 'employee.read'] as never,
      clientId: 'dse-cli',
      displayName: 'upload-op',
      autoReconnect: false,
    })
    await assert.rejects(() => probe.connect())
    const deviceId = probe.identity.deviceId
    probe.close()
    const store = new HubStore(home)
    await store.load()
    const pending = Object.values(store.state().pending).find((item) => item.deviceId === deviceId)
    assert.ok(pending !== undefined)
    await approvePairing(store, pending.requestId, 'test', {
      approvedScopes: ['employee.manage', 'employee.read'] as never,
    })
    const operator = await HubClient.create({
      identityFile: path.join(home, 'clients', 'upload-op.json'),
      url,
      role: 'operator',
      scopes: ['employee.manage', 'employee.read'] as never,
      clientId: 'dse-cli',
      displayName: 'upload-op',
      autoReconnect: false,
    })
    await operator.connect()

    // 满上限的一帧：2 MiB 原文 → 约 2.7 MB base64，加上 JSON 仍未越过 4 MiB 单帧上限
    const payload = Buffer.alloc(UPLOAD_MAX_BYTES, 0x5a)
    const result = await operator.call<{ size: number }>(
      'employee.files.upload',
      {
        employeeId: 'emp_upload',
        path: '收件箱/满上限.bin',
        dataBase64: payload.toString('base64'),
      },
      { idempotencyKey: 'upload-wire' },
    )
    assert.equal(received, UPLOAD_MAX_BYTES, '节点侧解出的字节数必须与原文一致（没有被截断）')
    assert.equal(result.size, UPLOAD_MAX_BYTES)

    node.close()
    operator.close()
  })
})
