/**
 * HTTP 代理与"本地转发口" —— 让**每个端点**走自己的代理。
 *
 * 为什么需要它（真实需求）：有些端点的域名在 Cloudflare 后面，从国内直连一律 403，
 * 只有走本机代理（如 Clash 的 127.0.0.1:7892）才通。而两件事都必须经过代理：
 *   1. **探测**（拉 `/models`）：这是我们自己发的 HTTP，直接支持代理即可；
 *   2. **真实模型调用**：那是 **dsh** 发的，而 dsh 的 provider 配置里**没有代理字段**
 *      （`dsh-llm-pi-ai` 的 `baseURL` 是"端点"，不是"代理"）。所以这里退一步：
 *      本机起一个**只监听回环的转发口**，把某条端点的 baseURL 指到
 *      `http://127.0.0.1:<port>/<端点id>`，由它**经代理**转发到真实上游。
 *      回环这一段是明文 HTTP，不涉及证书，dsh 那边一无所知 —— 它只看到一个普通的
 *      OpenAI 兼容端点。
 *
 * 只支持 HTTP 代理（含 CONNECT）：这是用户实际在用的形态（Clash / Surge / 公司代理），
 * SOCKS5 需要额外握手实现，留给真的有人需要时再加。
 *
 * 流式响应必须**逐块透传**（SSE 是 LLM 的主路径）：所以这里不做任何整段缓冲。
 */

import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { URL } from 'node:url'

export interface ProxyConfig {
  host: string
  port: number
}

/** 代理端点字符集：host 只允许主机名/IP（挡掉把整个 URL 塞进来的写法）。 */
export function normalizeProxyConfig(raw: unknown): ProxyConfig | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw !== 'object') throw new Error('proxy 必须是 {host, port} 或 null')
  const shape = raw as { host?: unknown; port?: unknown }
  const host = typeof shape.host === 'string' ? shape.host.trim() : ''
  if (host === '') throw new Error('代理地址不能为空（默认 127.0.0.1）')
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) throw new Error(`代理地址不合法：${host}`)
  const port = typeof shape.port === 'number' ? shape.port : Number.parseInt(String(shape.port ?? ''), 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`代理端口不合法：${String(shape.port)}`)
  }
  return { host, port }
}

/** 建立到 `host:port` 的连接：需要代理就先在代理上开一条 CONNECT 隧道。 */
export function connectThrough(
  target: { host: string; port: number },
  proxy: ProxyConfig | undefined,
  timeoutMs = 20_000,
): Promise<net.Socket> {
  if (proxy === undefined) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: target.host, port: target.port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`直连 ${target.host}:${target.port} 超时`))
      }, timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(socket)
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`直连 ${target.host}:${target.port} 失败：${error.message}`))
      })
    })
  }

  return new Promise((resolve, reject) => {
    const request = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.host}:${target.port}`,
      // CONNECT 不需要 Host 之外的头部；代理自己会解析 path
      headers: { host: `${target.host}:${target.port}` },
      timeout: timeoutMs,
    })
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(
          new Error(
            `代理 ${proxy.host}:${proxy.port} 拒绝 CONNECT（HTTP ${String(response.statusCode)}）` +
              '—— 代理地址/端口写对了么？它允许 CONNECT 出去么？',
          ),
        )
        return
      }
      resolve(socket)
    })
    request.once('timeout', () => {
      request.destroy()
      reject(new Error(`代理 ${proxy.host}:${proxy.port} 在 ${timeoutMs}ms 内没响应`))
    })
    request.once('error', (error) => {
      reject(new Error(`连不上代理 ${proxy.host}:${proxy.port}：${error.message}（代理没开？端口写错？）`))
    })
    request.end()
  })
}

/**
 * 经（或不经过）代理发一个 HTTP 请求，把**响应对象**交回调用方。
 *
 * 实现方式：自己在新 socket 上写一份 HTTP/1.1 报文（`http.ClientRequest` 支持传入
 * 已有的 socket —— 这就是 CONNECT 之后的标准做法），因此拿到了完整的流式能力，
 * 不需要 undici 之类的新依赖。
 */
export function httpRequestVia(options: {
  url: URL
  method: string
  headers: Record<string, string>
  body?: Buffer | undefined
  proxy?: ProxyConfig | undefined
  timeoutMs?: number
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; stream: http.IncomingMessage }> {
  const target = {
    host: options.url.hostname,
    port: options.url.port === '' ? (options.url.protocol === 'https:' ? 443 : 80) : Number(options.url.port),
  }
  const timeoutMs = options.timeoutMs ?? 20_000
  return connectThrough(target, options.proxy, timeoutMs).then((rawSocket) => {
    return new Promise((resolve, reject) => {
      const path = `${options.url.pathname}${options.url.search}`
      const cleanup = (socket: net.Socket): void => {
        socket.destroy()
      }
      if (options.url.protocol === 'https:') {
        /* 隧道里再叠一层 TLS：证书校验走系统 CA（与直连一致，不做任何放宽） */
        const secure = tls.connect({ socket: rawSocket, servername: target.host })
        secure.once('error', (error) => {
          cleanup(rawSocket)
          reject(new Error(`与 ${target.host} 的 TLS 握手失败：${error.message}`))
        })
        secure.once('secureConnect', () => {
          dispatch(secure)
        })
      } else {
        dispatch(rawSocket)
      }

      function dispatch(socket: net.Socket): void {
        const request = http.request(
          {
            createConnection: () => socket,
            method: options.method,
            path,
            headers: { host: options.url.host, ...options.headers },
          },
          (response) => {
            resolve({ status: response.statusCode ?? 0, headers: response.headers, stream: response })
          },
        )
        request.setTimeout(timeoutMs, () => {
          request.destroy(new Error(`${timeoutMs}ms 内无响应（超时）`))
        })
        request.once('error', (error) => {
          cleanup(socket)
          reject(new Error(`请求 ${options.url.href} 失败：${error.message}`))
        })
        if (options.body !== undefined) request.write(options.body)
        request.end()
      }
    })
  })
}

/* ────────────────────── 本机转发口（给 dsh 用）────────────────────── */

export interface Upstream {
  /** 端点 id —— 它就是转发口路径的第一段 */
  id: string
  /** 真实上游，如 https://api.example.com/v1 */
  baseUrl: string
  /** 走出去时用的代理；缺省 = 直连 */
  proxy?: ProxyConfig
}

export interface LocalForwarder {
  port: number
  /** 更新路由表（端点增删改后调用） */
  update(upstreams: Upstream[]): void
  close(): Promise<void>
}

/**
 * 起一个只监听 127.0.0.1 的转发口：`/<端点id>/<原始路径>` → 经代理转发到真实上游。
 *
 * 为什么一个口服务所有端点、而不是每条端点一个口：端口越少越不容易撞、
 * 也更容易让人看懂（`ss -ltnp` 里只有一行）。路径第一段就是端点 id。
 *
 * 刻意**不做**的事：不解密、不改写请求体、不缓存、不做任何 OpenAI 语义处理 ——
 * 它只是一段"从回环到代理"的管子。任何在这里"顺手"做的智能都会让排障时
 * 分不清是 dsh 的问题、端点的问题还是我们中间插了一手。
 */
export async function startLocalForwarder(options: {
  port: number
  /** 没有匹配路由时的兜底上游（一般不需要） */
  onWarn?: (message: string) => void
}): Promise<LocalForwarder> {
  let routes = new Map<string, Upstream>()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const segments = url.pathname.split('/').filter((part) => part !== '')
    const routeId = segments.shift() ?? ''
    const upstream = routes.get(routeId)
    if (upstream === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `转发口里没有端点 ${routeId}（路由未注册或已删除）` } }))
      return
    }

    const base = new URL(upstream.baseUrl)
    const target = new URL(
      `${base.pathname.replace(/\/+$/, '')}/${segments.join('/')}${url.search}`,
      base,
    )

    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks)
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue
        const lower = key.toLowerCase()
        /* 逐跳头部不能转发；host 由上游决定；长度由我们自己算 */
        if (['host', 'connection', 'proxy-connection', 'transfer-encoding', 'content-length', 'upgrade'].includes(lower)) {
          continue
        }
        headers[lower] = Array.isArray(value) ? value.join(', ') : value
      }
      if (body !== undefined) headers['content-length'] = String(body.length)

      httpRequestVia({
        url: target,
        method: req.method ?? 'GET',
        headers,
        body,
        proxy: upstream.proxy,
        /* LLM 的流式响应可以很久没有新字节，但**不能**在第一个字节上就超时：
           这里给的是"连不上/首包"的宽松上限，读流阶段的超时交给 dsh 自己。 */
        timeoutMs: 60_000,
      })
        .then((upstreamResponse) => {
          /* 逐跳头部同样不能回传（transfer-encoding 交给 Node 重新决定） */
          const out: Record<string, string | string[]> = {}
          for (const [key, value] of Object.entries(upstreamResponse.headers)) {
            if (value === undefined) continue
            const lower = key.toLowerCase()
            if (['connection', 'transfer-encoding', 'content-length', 'keep-alive'].includes(lower)) continue
            out[key] = value
          }
          res.writeHead(upstreamResponse.status, out)
          upstreamResponse.stream.pipe(res)
          upstreamResponse.stream.once('error', () => {
            res.destroy()
          })
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          options.onWarn?.(`llm 转发口：${routeId} 请求失败：${message}`)
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' })
          }
          res.end(JSON.stringify({ error: { message: `本地转发口连不上上游：${message}` } }))
        })
    })
    req.once('error', () => {
      res.destroy()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          `本地转发口绑不上 127.0.0.1:${options.port}：${error.message}` +
            (error.code === 'EADDRINUSE' ? '（端口被占了 —— 换 DSE_LLM_FORWARD_PORT 或关掉占用的进程）' : ''),
        ),
      )
    })
    server.listen(options.port, '127.0.0.1', () => resolve())
  })

  return {
    port: options.port,
    update(upstreams: Upstream[]): void {
      routes = new Map(upstreams.map((item) => [item.id, item]))
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve())
        /* 长连接（SSE）不主动断，close 会等到它们结束；这里不强杀 */
      })
    },
  }
}

/** 转发口的默认端口（可用 DSE_LLM_FORWARD_PORT 覆盖）。 */
export function forwarderPort(): number {
  const raw = process.env['DSE_LLM_FORWARD_PORT']
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed
  return 17892
}
