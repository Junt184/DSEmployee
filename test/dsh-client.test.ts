/**
 * DshClient.call 的超时覆盖测试。
 *
 * 线上真实事故的形状：dsh 回了 200 响应头但 body 永远不来 ——
 * 修复前 timer 在收到头后就清了，response.json() 会把调用方挂起到永远，
 * 节点的 dispatch 随之卡死（Hub 侧看到的表象是"转发超时"）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createServer, type Server } from 'node:http'

import { DshClient } from '../src/node/dsh-client.ts'

async function withServer(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    await run(port)
  } finally {
    // 挂着不结束的响应会让 close() 等连接排空，直接强断
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('DshClient.call 超时覆盖', () => {
  it('响应头到了但 body 永远不来 → 按超时失败，不挂起到永远', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        // 故意不写 body、不 end —— 模拟挂死的 dsh
      },
      async (port) => {
        const client = new DshClient({ port, timeoutMs: 500 })
        const start = Date.now()
        await assert.rejects(() => client.call('session.list', {}))
        assert.ok(Date.now() - start < 5000, '必须在超时窗口内失败，而不是挂起')
      },
    )
  })

  it('正常响应不受影响（回体型仍走原路径）', async () => {
    await withServer(
      (req, res) => {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          const frame = JSON.parse(body) as { rpcId: string }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'server-response', rpcId: frame.rpcId, result: { ok: true, value: { items: [] } } }))
        })
      },
      async (port) => {
        const client = new DshClient({ port, timeoutMs: 5000 })
        const result = await client.call<{ items: unknown[] }>('session.list', {})
        assert.deepEqual(result, { items: [] })
      },
    )
  })
})
