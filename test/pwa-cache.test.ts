/**
 * service worker 的缓存策略 —— 直接把生成的 SW 源码丢进 vm 里跑，验行为而不是验文字。
 *
 * 为什么值得一条**行为**测试：这里出过一次真实事故，而且是最难查的那种 ——
 * 上一版对非导航请求用 cache-first，并把 `/ui.js` 放进 precache。SW 只在脚本自身
 * 字节变化时才更新，于是"缓存名写死 + SW 内容不再变"⇒ SW 永不换代 ⇒ `/ui.js`
 * 永远命中旧缓存、**网络请求根本不发生**。现象是：页面 HTML（network-first）每次
 * 都是新的、CSS 是新的，只有 JS 停在装上那天。手机上办公区卡片与电脑完全不同
 * （旧 JS 不建 `.desk-top` 网格，新样式整块空转），刷新/重启/重装 PWA 都不自愈。
 *
 * 这类 bug 的共同特征是"**没有任何报错**"，所以它必须由测试盯着，而不是靠人记得：
 *   1. 缓存里有 /ui.js 且网络可用 ⇒ 必须返回**网络**那份（cache-first 会返回旧的）；
 *   2. 网络不可用 ⇒ 必须还能拿到缓存那份（离线兜底不能因为改成 network-first 就丢）；
 *   3. 网络与缓存都没有 ⇒ 回明确的 503，而不是让浏览器抛网络错误；
 *   4. /ws 与 /api 永不拦截（控制面必须直连 Hub）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import vm from 'node:vm'

import { assetVersion, renderPwaServiceWorker } from '../src/web/pwa.ts'

const ORIGIN = 'https://hub.test'
const VERSION = 'testver-1'
const SCRIPT_URL = `/ui.js?v=${VERSION}`
/** 缓存按绝对 URL 认键（浏览器行为），断言里也必须用绝对键。 */
const absolute = (url: string): string => new URL(url, ORIGIN).href

class FakeResponse {
  readonly body: string
  readonly status: number
  constructor(body: string, status = 200) {
    this.body = body
    this.status = status
  }
  get ok(): boolean {
    return this.status >= 200 && this.status < 300
  }
  clone(): FakeResponse {
    return new FakeResponse(this.body, this.status)
  }
}

interface Harness {
  /** 触发一次 fetch 事件，返回 SW 交给浏览器的响应（passthrough 时为 null）。 */
  fetch(input: { url: string; method?: string; mode?: string }): Promise<FakeResponse | null>
  /** 当前缓存内容（键 → 响应体）。 */
  snapshot(): Record<string, string>
  /** 触发一次 install 事件（precache 是否成功）。 */
  install(): Promise<{ ok: boolean; error?: string }>
  /** 触发一次 activate 事件（旧缓存清理 + 接管页面）。 */
  activate(): Promise<void>
  /** activate 时被删掉的缓存名。 */
  deleted: string[]
}

/** 真实的 Cache 与 Response 都按**绝对 URL** 认键、接受 init 对象 —— 替身必须照做，
    否则测出来的是替身的怪癖而不是产品行为。 */
type ResponseInitLike = number | { status?: number }

function makeSandboxResponse(body: string, init?: ResponseInitLike): FakeResponse {
  const status = typeof init === 'number' ? init : (init?.status ?? 200)
  return new FakeResponse(body, status)
}

function makeHarness(options: {
  version?: string
  cache?: Record<string, string>
  /** 网络内容；'down' 表示离线（fetch 一律 reject）。 */
  network: Record<string, string> | 'down'
}): Harness {
  const version = options.version ?? VERSION
  const scriptUrl = `/ui.js?v=${version}`
  const source = renderPwaServiceWorker({ version, scriptUrl })
  const cacheName = `dse-pwa-${version}`
  /** 绝对化：浏览器把相对键按 SW 的 base URL 归一化后才入库。 */
  const norm = (key: string): string => new URL(key, ORIGIN).href
  const entries = new Map<string, FakeResponse>(
    Object.entries(options.cache ?? {}).map(([key, body]) => [norm(key), new FakeResponse(body)]),
  )
  const deleted: string[] = []

  const keyOf = (input: unknown): string =>
    norm(typeof input === 'string' ? input : (input as { url: string }).url)

  const cache = {
    async addAll(urls: string[]): Promise<void> {
      for (const url of urls) entries.set(norm(url), new FakeResponse(`precached:${url}`))
    },
    async put(key: unknown, response: FakeResponse): Promise<void> {
      entries.set(keyOf(key), response)
    },
    async match(key: unknown): Promise<FakeResponse | undefined> {
      return entries.get(keyOf(key))
    },
  }

  const sandbox = {
    URL,
    Response: makeSandboxResponse as unknown as typeof Response,
    location: { origin: ORIGIN },
    self: {
      listeners: {} as Record<string, (event: unknown) => void>,
      addEventListener(type: string, listener: (event: unknown) => void) {
        sandbox.self.listeners[type] = listener
      },
      skipWaiting: async () => undefined,
      clients: { claim: async () => undefined },
    },
    caches: {
      async open(): Promise<unknown> {
        return cache
      },
      async keys(): Promise<string[]> {
        return ['dse-pwa-stale-cache', cacheName]
      },
      async delete(name: string): Promise<boolean> {
        deleted.push(name)
        return true
      },
      async match(key: unknown): Promise<FakeResponse | undefined> {
        return entries.get(keyOf(key))
      },
    },
    fetch: async (request: { url: string }): Promise<FakeResponse> => {
      if (options.network === 'down') throw new Error('network down')
      const body = options.network[request.url]
      if (body === undefined) return new FakeResponse('', 404)
      return new FakeResponse(body)
    },
  }

  vm.runInNewContext(source, sandbox, { filename: 'sw.js' })
  const listeners = sandbox.self.listeners

  async function runListener(type: string, event: Record<string, unknown>): Promise<void> {
    const pending: Promise<unknown>[] = []
    const listener = listeners[type]
    assert.ok(listener !== undefined, `SW 没有注册 ${type} 监听器`)
    listener({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) })
    await Promise.all(pending)
  }

  return {
    deleted,
    install: async () => {
      try {
        await runListener('install', {})
        return { ok: true }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    activate: async () => {
      await runListener('activate', {})
    },
    snapshot: () => Object.fromEntries([...entries].map(([key, value]) => [key, value.body])),
    fetch: async (input) => {
      const request = {
        url: input.url.startsWith('http') ? input.url : `${ORIGIN}${input.url}`,
        method: input.method ?? 'GET',
        mode: input.mode ?? 'cors',
      }
      let responded: Promise<FakeResponse> | null = null
      const listener = listeners.fetch
      assert.ok(listener !== undefined, 'SW 没有注册 fetch 监听器')
      listener({ request, respondWith: (p: Promise<FakeResponse>) => (responded = p) })
      if (responded === null) return null
      return await responded
    },
  }
}

describe('service worker 缓存策略', () => {
  it('缓存里有新旧两份时，在线必须给网络那份（cache-first 的回归守卫）', async () => {
    const sw = makeHarness({
      cache: { [SCRIPT_URL]: 'OLD-SCRIPT', '/': 'OLD-HTML' },
      network: { [`${ORIGIN}${SCRIPT_URL}`]: 'NEW-SCRIPT' },
    })
    const response = await sw.fetch({ url: SCRIPT_URL })
    assert.equal(response?.body, 'NEW-SCRIPT', '在线时返回了缓存的旧脚本 —— 这正是手机/电脑界面不一致的成因')
  })

  it('网络不可用时回落到缓存（离线仍要能打开控制台）', async () => {
    const sw = makeHarness({ cache: { [SCRIPT_URL]: 'CACHED-SCRIPT' }, network: 'down' })
    const response = await sw.fetch({ url: SCRIPT_URL })
    assert.equal(response?.body, 'CACHED-SCRIPT')
  })

  it('网络与缓存都没有时回 503，而不是抛网络错误', async () => {
    const sw = makeHarness({ network: 'down' })
    const response = await sw.fetch({ url: '/icon-192.png' })
    assert.equal(response?.status, 503)
    assert.equal(response?.ok, false)
  })

  it('拿到网络响应后顺手更新缓存（离线兜底不会停在旧内容）', async () => {
    const sw = makeHarness({
      cache: { [SCRIPT_URL]: 'OLD-SCRIPT' },
      network: { [`${ORIGIN}${SCRIPT_URL}`]: 'NEW-SCRIPT' },
    })
    await sw.fetch({ url: SCRIPT_URL })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(sw.snapshot()[absolute(SCRIPT_URL)], 'NEW-SCRIPT')
  })

  it('页面导航也是网络优先，离线回落到缓存的壳', async () => {
    const online = makeHarness({ cache: { '/': 'OLD-SHELL' }, network: { [`${ORIGIN}/`]: 'NEW-SHELL' } })
    const fresh = await online.fetch({ url: '/', mode: 'navigate' })
    assert.equal(fresh?.body, 'NEW-SHELL')

    const offline = makeHarness({ cache: { '/': 'CACHED-SHELL' }, network: 'down' })
    const fallback = await offline.fetch({ url: '/', mode: 'navigate' })
    assert.equal(fallback?.body, 'CACHED-SHELL')
  })

  it('/ws 与 /api 一律不拦截（控制面必须直连 Hub）', async () => {
    const sw = makeHarness({ network: {} })
    assert.equal(await sw.fetch({ url: '/ws' }), null)
    assert.equal(await sw.fetch({ url: '/api/respond', method: 'POST' }), null)
    assert.equal(await sw.fetch({ url: 'https://other.example/ui.js' }), null)
  })

  it('install 会把带指纹的脚本地址放进 precache', async () => {
    const sw = makeHarness({ network: {} })
    const result = await sw.install()
    assert.equal(result.ok, true)
    assert.equal(
      sw.snapshot()[absolute(SCRIPT_URL)],
      `precached:${SCRIPT_URL}`,
      'precache 没包含带版本号的 /ui.js，离线兜底会落空',
    )
  })

  it('activate 会删掉旧缓存（换代后不留旧壳），并接管已开的页面', async () => {
    const sw = makeHarness({ network: {} })
    await sw.activate()
    assert.deepEqual(sw.deleted, ['dse-pwa-stale-cache'])
  })
})

describe('脚本指纹驱动缓存失效', () => {
  it('脚本改一个字，指纹就变（否则 SW 不会换代）', () => {
    assert.notEqual(assetVersion('var a = 1\n'), assetVersion('var a = 2\n'))
  })

  it('指纹写进缓存名与 precache 地址（两边必须同源）', () => {
    const source = renderPwaServiceWorker({ version: 'abc-1', scriptUrl: '/ui.js?v=abc-1' })
    assert.match(source, /var CACHE = 'dse-pwa-abc-1'/)
    assert.match(source, /var SCRIPT = '\/ui\.js\?v=abc-1'/)
    assert.match(source, /var PRECACHE = \[SCRIPT, /)
  })

  it('不同指纹生成不同的 SW 字节（SW 换代 = 旧缓存被清 + 客户端自愈）', () => {
    const a = renderPwaServiceWorker({ version: 'v1', scriptUrl: '/ui.js?v=v1' })
    const b = renderPwaServiceWorker({ version: 'v2', scriptUrl: '/ui.js?v=v2' })
    assert.notEqual(a, b)
  })
})
