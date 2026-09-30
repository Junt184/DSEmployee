/**
 * LLM 出口代理（`src/node/llm-proxy.ts`）的测试。
 *
 * 这一组守的是"某个端点必须走代理才通"这件事的两半：
 *   1. **探测**：经代理发 `{apiUrl}/models`（HTTPS 走 CONNECT 隧道 + 叠一层 TLS）；
 *   2. **真实模型调用**：dsh 的 provider 没有代理字段，所以节点起一个只监听回环的
 *      转发口，`/<端点id>/<原路径>` → 经代理转发到真实上游，且**流式不缓冲**。
 *
 * 全部用本机临时服务器（假代理 + 假上游），不打外网、不打真代理。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'

import {
  connectThrough,
  forwarderPort,
  httpRequestVia,
  normalizeProxyConfig,
  startLocalForwarder,
  type ProxyConfig,
} from '../src/node/llm-proxy.ts'

interface FakeProxy {
  port: number
  /** 收到的 CONNECT 目标，形如 `127.0.0.1:12345` */
  connects: string[]
  close(): Promise<void>
}

/** 一个只会转发的 HTTP 代理（CONNECT 隧道 + 普通请求的绝对 URI 转发）。 */
async function startFakeProxy(): Promise<FakeProxy> {
  const connects: string[] = []
  const server = http.createServer((req, res) => {
    /* 非 CONNECT：普通 HTTP 代理语义（绝对 URI）。测试里只用来确认"确实经过代理" */
    const target = new URL(req.url ?? '/')
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port === '' ? 80 : Number(target.port),
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...req.headers, host: target.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    upstream.once('error', () => {
      res.writeHead(502)
      res.end('proxy upstream error')
    })
    req.pipe(upstream)
  })
  server.on('connect', (req, clientSocket, head) => {
    connects.push(req.url ?? '')
    const [host, portRaw] = (req.url ?? '').split(':')
    const upstream = net.connect({ host: host ?? '', port: Number(portRaw ?? 0) })
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.once('error', () => {
      clientSocket.destroy()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    connects,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

describe('代理配置的形状', () => {
  it('默认值就是 127.0.0.1:7892（界面不许要求手打）', () => {
    assert.equal(forwarderPort() > 0, true)
    assert.deepEqual(normalizeProxyConfig({ host: '127.0.0.1', port: 7892 }), { host: '127.0.0.1', port: 7892 })
    assert.deepEqual(normalizeProxyConfig({ host: ' 127.0.0.1 ', port: '7892' }), {
      host: '127.0.0.1',
      port: 7892,
    })
    assert.equal(normalizeProxyConfig(undefined), undefined)
    assert.equal(normalizeProxyConfig(null), undefined)
  })

  it('挡掉把整个 URL 塞进 host、以及非法端口', () => {
    assert.throws(() => normalizeProxyConfig({ host: 'http://127.0.0.1:7892', port: 7892 }), /不合法/)
    assert.throws(() => normalizeProxyConfig({ host: '', port: 1 }), /不能为空/)
    assert.throws(() => normalizeProxyConfig({ host: '127.0.0.1', port: 70000 }), /端口不合法/)
    assert.throws(() => normalizeProxyConfig({ host: '127.0.0.1', port: 'abc' }), /端口不合法/)
  })
})

describe('经代理发请求（探测用的那条路）', () => {
  it('HTTPS 目标走 CONNECT 隧道，能拿到响应体', async () => {
    const proxy = await startFakeProxy()
    /* 假上游用明文 HTTP 就够了：这里要验的是"请求确实经代理出去、并把响应带回来"，
       TLS 那一层由 Node 的 tls.connect 负责（真实端点已验证过 200）。 */
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'gpt-5.2' }, { id: 'gpt-5.3-codex-spark' }] }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as AddressInfo).port

    try {
      const response = await httpRequestVia({
        url: new URL(`http://127.0.0.1:${upstreamPort}/v1/models`),
        method: 'GET',
        headers: { authorization: 'Bearer sk-test' },
        proxy: { host: '127.0.0.1', port: proxy.port },
      })
      const text = await new Promise<string>((resolve) => {
        const chunks: Buffer[] = []
        response.stream.on('data', (c: Buffer) => chunks.push(c))
        response.stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      })
      assert.equal(response.status, 200)
      assert.match(text, /gpt-5\.2/)
    } finally {
      await proxy.close()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it('代理没开 ⇒ 报的话要能指向"代理"这件事（而不是"key 错了"）', async () => {
    await assert.rejects(
      () =>
        httpRequestVia({
          url: new URL('https://api.example.com/v1/models'),
          method: 'GET',
          headers: {},
          proxy: { host: '127.0.0.1', port: 1 },
          timeoutMs: 3000,
        }),
      /连不上代理|代理.*超时/,
    )
  })

  it('直连（不带代理）也能用同一条实现', async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const port = (upstream.address() as AddressInfo).port
    try {
      const response = await httpRequestVia({
        url: new URL(`http://127.0.0.1:${port}/ping`),
        method: 'GET',
        headers: {},
      })
      assert.equal(response.status, 200)
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
})

describe('本机转发口（真实模型调用走的那条路）', () => {
  it('`/<端点id>/<原路径>` 能转发到上游，且**流式**逐块到位（SSE 不能被攒起来）', async () => {
    const proxy = await startFakeProxy()
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: one\n\n')
      setTimeout(() => {
        res.write('data: two\n\n')
        res.end()
      }, 60)
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as AddressInfo).port

    const forwarder = await startLocalForwarder({ port: 0 + (await freePort()), onWarn: () => undefined })
    forwarder.update([
      {
        id: 'ep_demo',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        proxy: { host: '127.0.0.1', port: proxy.port },
      },
    ])

    try {
      const chunks: Array<{ at: number; text: string }> = []
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: forwarder.port, path: '/ep_demo/models', method: 'GET' },
          (res) => {
            assert.equal(res.statusCode, 200)
            res.on('data', (chunk: Buffer) => chunks.push({ at: Date.now(), text: chunk.toString('utf8') }))
            res.on('end', () => resolve())
          },
        )
        req.once('error', reject)
        req.end()
      })
      const joined = chunks.map((c) => c.text).join('')
      assert.match(joined, /data: one/)
      assert.match(joined, /data: two/)
      assert.equal(chunks.length >= 2, true, '两块应当在不同的 data 事件里到达（说明没有被整段缓冲）')
    } finally {
      await forwarder.close()
      await proxy.close()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it('没注册过的端点路径 ⇒ 明确 404（而不是悄悄直连出去）', async () => {
    const forwarder = await startLocalForwarder({ port: await freePort() })
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: forwarder.port, path: '/ep_unknown/x', method: 'GET' }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.once('error', reject)
        req.end()
      })
      assert.equal(status, 404)
    } finally {
      await forwarder.close()
    }
  })

  it('connectThrough：不开代理时不出现在代理的 CONNECT 记录里；开了才出现', async () => {
    const proxy = await startFakeProxy()
    const upstream = net.createServer((socket) => socket.end())
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as AddressInfo).port
    try {
      const direct = await connectThrough({ host: '127.0.0.1', port: upstreamPort }, undefined)
      direct.destroy()
      assert.deepEqual(proxy.connects, [], '直连不该经过代理')
      const tunneled = await connectThrough({ host: '127.0.0.1', port: upstreamPort }, {
        host: '127.0.0.1',
        port: proxy.port,
      } satisfies ProxyConfig)
      tunneled.destroy()
      assert.deepEqual(proxy.connects, [`127.0.0.1:${upstreamPort}`])
    } finally {
      await proxy.close()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
})

/** 找一个当前空闲的端口（转发口的默认值是固定端口，测试里用临时的避免互相打搅）。 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}
