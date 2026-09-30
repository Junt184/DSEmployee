/**
 * DshDownlink 分类与透传测试 —— 用进程内的假 dsh WebSocket 服务端喂帧。
 *
 * 覆盖的是 docs/04 §10.3 实测定稿的下行帧词汇：
 *   - `session/*` 与 `host/*` 方法（哪怕信封是 server-request）→ 'event' 事件
 *   - 其余 server-request（审批、提问）→ 'request' 事件，rpcId 原样保留
 *   - 非 server-request 帧（协议将来新增的类型）→ 'event'，不再丢弃
 *   - 解析失败 → 'error'；服务端断开 → 'close'（带 channel）
 *   - 断开后**自动重连**：通道级断开重连、整体不可达时退避重试、恢复后续传；
 *     `close()` 之后绝不再长出新连接
 *
 * 每个用例起独立的服务端：共享服务端会让上一个用例残留的"半关闭" socket
 * 混进连接表，喂帧喂到死 socket 上（偶发超时，踩过）。
 */

import assert from 'node:assert/strict'
import { beforeEach, afterEach, describe, it } from 'node:test'

import { WebSocketServer, type WebSocket } from 'ws'

import {
  DshClient,
  type DshDownlink,
  type DshEventFrame,
  type ServerRequestFrame,
} from '../src/node/dsh-client.ts'

const MUX = '/api/events.mux'
const HOST = '/api/events.host'

let server: WebSocketServer
let port = 0
/** path → 当前连着的 socket（服务端视角） */
let sockets: Map<string, Set<WebSocket>>
let downlink: DshDownlink
let requests: ServerRequestFrame[]
let events: DshEventFrame[]
let errors: Error[]
let closes: Array<{ channel: string }>

/** 把服务端的连接登记进 `sockets`（服务端重启后要对新实例重新挂）。 */
function trackConnections(srv: WebSocketServer): void {
  srv.on('connection', (socket, req) => {
    const key = req.url ?? ''
    const set = sockets.get(key) ?? new Set<WebSocket>()
    set.add(socket)
    sockets.set(key, set)
    socket.on('close', () => set.delete(socket))
  })
}

beforeEach(async () => {
  sockets = new Map()
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  trackConnections(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(typeof address === 'object' && address !== null)
  port = address.port

  downlink = new DshClient({ port }).openDownlink()
  requests = []
  events = []
  errors = []
  closes = []
  downlink.on('request', (frame) => requests.push(frame))
  downlink.on('event', (frame) => events.push(frame))
  downlink.on('error', (error) => errors.push(error))
  downlink.on('close', (info) => closes.push(info))
  downlink.open()
  // 等两条通道都真的连上（服务端视角），否则喂帧会丢
  await waitFor(() => (sockets.get(MUX)?.size ?? 0) > 0 && (sockets.get(HOST)?.size ?? 0) > 0)
})

afterEach(async () => {
  downlink.close()
  for (const set of sockets.values()) for (const socket of set) socket.terminate()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('waitFor timed out')
}

/** 给某条通道上的所有连接喂一帧（对象会 JSON 序列化；字符串原样发）。 */
function sendTo(path: string, frame: unknown): void {
  const set = sockets.get(path)
  assert.ok(set !== undefined && set.size > 0, `no socket connected on ${path}`)
  for (const socket of set) {
    socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
  }
}

/** 断言"没有发生"需要一点时间窗口 —— 150ms 足以让帧穿过本机回路。 */
async function settle(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('DshDownlink 帧分类', () => {
  it('session/* 与 host/* 方法是只读通知 → event 事件，带 channel 与原 payload', async () => {
    // 与实测样例同形（docs/04 §10.3）：信封是 server-request，sessionId 在 payload 顶层
    sendTo(MUX, {
      type: 'server-request',
      rpcId: 'rpc-evt-1',
      method: 'session/event',
      payload: {
        type: 'session/event',
        sessionId: 'session-abc',
        event: { type: 'assistant/chunk', seq: 7, data: { chunk: { type: 'text-delta', text: '1' } } },
      },
    })
    sendTo(HOST, {
      type: 'server-request',
      rpcId: 'rpc-evt-2',
      method: 'host/session-status',
      payload: { type: 'host/session-status', sessionId: 'session-abc', running: true },
    })

    await waitFor(() => events.length === 2)
    const [muxEvent, hostEvent] = events
    assert.equal(muxEvent?.method, 'session/event')
    assert.equal(muxEvent?.channel, 'events.mux')
    assert.equal(muxEvent?.rpcId, 'rpc-evt-1')
    assert.equal(
      (muxEvent?.payload as { sessionId?: string }).sessionId,
      'session-abc',
    )
    assert.equal(hostEvent?.method, 'host/session-status')
    assert.equal(hostEvent?.channel, 'events.host')

    await settle()
    assert.equal(requests.length, 0, '通知帧不应再触发 request 事件')
  })

  it('其余 server-request（审批、提问）→ request 事件，rpcId 原样保留', async () => {
    sendTo(MUX, {
      type: 'server-request',
      rpcId: 'rpc-approval-1',
      method: 'approval/ask',
      payload: { sessionId: 'session-abc', tool: 'bash' },
    })

    await waitFor(() => requests.length === 1)
    assert.equal(requests[0]?.rpcId, 'rpc-approval-1')
    assert.equal(requests[0]?.method, 'approval/ask')

    await settle()
    assert.equal(events.length, 0, '审批请求不应落入 event 事件')
  })

  it('非 server-request 帧不再被丢弃，归入 event 事件', async () => {
    // 协议将来新增的帧类型（如 stream/error）—— 当初"只放行 server-request"
    // 是实时事件流断裂的嫌疑点之一，这里钉死新行为。
    sendTo(MUX, { type: 'stream', stream: 'stdout', data: 'hello' })

    await waitFor(() => events.length === 1)
    assert.equal(events[0]?.type, 'stream')
    assert.equal(events[0]?.channel, 'events.mux')
  })

  it('无法解析的帧 → error 事件，不影响后续帧', async () => {
    sendTo(MUX, 'this is not json')
    await waitFor(() => errors.length === 1)

    sendTo(MUX, {
      type: 'server-request',
      rpcId: 'rpc-evt-3',
      method: 'session/projection',
      payload: { type: 'session/projection', sessionId: 'session-abc', key: 'k', value: 1 },
    })
    await waitFor(() => events.length === 1)
    assert.equal(events[0]?.method, 'session/projection')
  })

  it('服务端断开 → close 事件带通道名', async () => {
    const set = sockets.get(MUX)
    assert.ok(set !== undefined && set.size > 0)
    for (const socket of set) socket.close()

    await waitFor(() => closes.length === 1)
    assert.equal(closes[0]?.channel, 'events.mux')
  })
})

describe('DshDownlink 自动重连', () => {
  it('通道断开后自动重连：新连接建立、帧继续可达、不产生重复连接', async () => {
    const set = sockets.get(MUX)
    assert.ok(set !== undefined && set.size > 0)
    for (const socket of set) socket.terminate()

    await waitFor(() => closes.some((info) => info.channel === 'events.mux'))
    // 首次退避 500ms，服务端仍在监听，重连应很快成功
    await waitFor(() => (sockets.get(MUX)?.size ?? 0) > 0)

    // 重连后的新 socket 上帧照常分类分发
    sendTo(MUX, {
      type: 'server-request',
      rpcId: 'rpc-evt-reconnect',
      method: 'session/event',
      payload: { type: 'session/event', sessionId: 'session-abc', event: { type: 'assistant/chunk' } },
    })
    await waitFor(() => events.length === 1)
    assert.equal(events[0]?.channel, 'events.mux')

    // HOST 通道不受影响：没有多余的断开；MUX 也不会长出并行重复连接
    await settle(700)
    assert.equal(sockets.get(MUX)?.size, 1, '同一通道不应出现并行重复连接')
    assert.equal(sockets.get(HOST)?.size, 1)
    assert.equal(closes.filter((info) => info.channel === 'events.host').length, 0)
  })

  it('对端整体不可达时按退避持续重试，服务端恢复后自动重连', async () => {
    // 模拟 dsh 进程整体消失：杀掉所有连接并关闭监听
    for (const set of sockets.values()) for (const socket of set) socket.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await waitFor(() => closes.length >= 2)

    // 期间的重试全部 ECONNREFUSED；1.2s 后（第二次退避窗口内）服务端回来
    await settle(1_200)
    server = new WebSocketServer({ port, host: '127.0.0.1' })
    trackConnections(server)
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })

    // 两条通道都应自动重连上（dsh 被 DshProcess 在同一端口自愈后的情形）
    await waitFor(
      () => (sockets.get(MUX)?.size ?? 0) > 0 && (sockets.get(HOST)?.size ?? 0) > 0,
      8_000,
    )
    sendTo(MUX, {
      type: 'server-request',
      rpcId: 'rpc-evt-back',
      method: 'session/event',
      payload: { type: 'session/event', sessionId: 'session-abc' },
    })
    await waitFor(() => events.length === 1)
    assert.equal(events[0]?.method, 'session/event')
  })

  it('close() 之后不再自动重连', async () => {
    const set = sockets.get(MUX)
    assert.ok(set !== undefined && set.size > 0)
    for (const socket of set) socket.close()
    await waitFor(() => closes.length >= 1)

    downlink.close()
    // 越过首次退避（500ms）：若重连没被取消，这里会看到新连接长出来
    await settle(1_200)
    assert.equal(sockets.get(MUX)?.size ?? 0, 0, 'close() 后不应再出现新连接')
    assert.equal(sockets.get(HOST)?.size ?? 0, 0, 'close() 后既有连接应全部断开')
  })
})
