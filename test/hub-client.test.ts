/**
 * HubClient 存活性看门狗测试。
 *
 * 用最小的假 Hub（只完成握手、之后一帧不发）模拟公网反代下的半开连接：
 * 连接建立后再无任何帧。看门狗必须在 ~2.5×tickInterval 的窗口内主动拆掉
 * 连接并触发既有重连退避（以"第二个连接到来"为证据）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'node:http'

import { WebSocketServer, type WebSocket } from 'ws'

import { HubClient } from '../src/client/hub-client.ts'

const TICK_MS = 300

/** 假 Hub：握手照章应答（不验签 —— 它是测试替身），之后彻底静默。 */
async function withSilentHub(
  run: (url: string, state: { connections: number }) => Promise<void>,
): Promise<void> {
  const state = { connections: 0 }
  const http = createServer()
  const wss = new WebSocketServer({ server: http })
  const sockets = new Set<WebSocket>()
  wss.on('connection', (socket) => {
    sockets.add(socket)
    state.connections += 1
    socket.send(
      JSON.stringify({ type: 'event', event: 'challenge', payload: { nonce: 'test-nonce', ts: Date.now(), hubId: 'hub_fake', protocol: 1 } }),
    )
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as { type: string; id?: string; method?: string }
      if (frame.type !== 'req' || frame.method !== 'connect') return
      socket.send(
        JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: true,
          payload: {
            type: 'hello-ok',
            hubId: 'hub_fake',
            protocol: 1,
            server: { version: '0.0.0-test', connId: 'c1' },
            features: { methods: [], events: [] },
            auth: { role: 'operator', scopes: [] },
            policy: { maxPayload: 1048576, tickIntervalMs: TICK_MS },
          },
        }),
      )
      // 之后一帧不发 —— 这就是"半开"
    })
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    await run(`ws://127.0.0.1:${port}/ws`, state)
  } finally {
    for (const socket of sockets) socket.terminate()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
}

describe('HubClient 存活性看门狗', () => {
  it('连接建立后再无帧 → 窗口内断开并自动重连（第二个连接到来）', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-watchdog-'))
    try {
      await withSilentHub(async (url, state) => {
        const client = await HubClient.create({
          identityFile: path.join(root, 'identity.json'),
          url,
          role: 'operator',
          scopes: [],
          clientId: 'dse-test',
          displayName: 'watchdog-test',
          autoReconnect: true,
        })
        await client.connect()
        assert.equal(state.connections, 1)

        // 看门狗窗口：maxSilence = 2.5×300=750ms，检查间隔 375ms，重连退避首跳 500ms
        // 给足 6s 余量（CI 抖动），但正常应在 ~2s 内发生
        const deadline = Date.now() + 6000
        while (state.connections < 2 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.ok(
          state.connections >= 2,
          '看门狗应在静默窗口内拆掉半开连接并触发重连（应看到第二个连接）',
        )
        client.close()
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('一次性调用（autoReconnect:false）不启用看门狗', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-watchdog-'))
    try {
      await withSilentHub(async (url, state) => {
        const client = await HubClient.create({
          identityFile: path.join(root, 'identity.json'),
          url,
          role: 'operator',
          scopes: [],
          clientId: 'dse-test',
          displayName: 'watchdog-off',
          autoReconnect: false,
        })
        await client.connect()
        assert.equal(state.connections, 1)
        // 等超过两个看门狗窗口：连接必须还活着、也没有重连发生
        await new Promise((resolve) => setTimeout(resolve, 2000))
        assert.equal(client.connected, true, '一次性连接不该被看门狗拆')
        assert.equal(state.connections, 1, '一次性连接不该发生重连')
        client.close()
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
