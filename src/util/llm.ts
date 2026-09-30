/**
 * LLM 端点的两件共享小事：密钥掩码 与 URL 策略。
 *
 * 为什么单独放一个文件：**Hub 与节点都要用**，而 Hub 不能 import 节点的模块
 * （`src/hub/*` 不认识 dsh 与工作区，这是本仓库的分层）。这两条又都是"只该有一处实现"
 * 的规矩 —— 各写一份的话，某天 Hub 回给界面的是全码、或者只在一侧拦住了 file://，
 * 都不会有人立刻发现。
 */

/**
 * 校验端点 URL：只允许 http/https。
 *
 * SSRF 取舍：这是单人自用工具，内网端点（如 http://192.168.x.x:11434 的 Ollama）
 * 是正当用法，所以不做内网拦截；但 file://、gopher:// 之类非 HTTP 协议
 * 没有任何正当理由，直接拒掉。
 */
export function assertLlmApiUrl(apiUrl: string): URL {
  let url: URL
  try {
    url = new URL(apiUrl)
  } catch {
    throw new Error(`端点不是合法 URL：${apiUrl}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`端点只允许 http/https，收到 ${url.protocol}`)
  }
  return url
}

/** apiKey 掩码：露前三后四，其余打码（短 key 全码）。 */
export function maskApiKey(key: string): string {
  if (key.length <= 7) return '***'
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}
