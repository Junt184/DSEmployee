/**
 * 会话载荷瘦身与分页 —— 纯函数模块（不碰 dsh / Hub，便于单测）。
 *
 * 为什么存在（实测定案）：员工会话历史可达数十 MB / 数万条事件（base64 截图、
 * 单条 33KB 的 tool/result、每轮一条 37KB 的 request/header）。节点把整包历史
 * 经 `session.history` 回给 Hub 时会超过协议单帧上限 `MAX_FRAME_BYTES = 4MiB`
 * （src/protocol/frames.ts），Hub 的 ws 服务端直接掐断节点连接 —— 控制端看到
 * node-offline / connection closed，节点反复掉线。实时流 `session.push` 里的
 * 大截图事件同理掐线。
 *
 * 三道闸，全部 fail-safe（宁占位、不掐线）：
 *   1. `sanitizeHistoryEvents` —— 回历史前逐事件瘦身：
 *      丢系统事件 / 截长字符串 / 图片 base64 占位 / 超大事件整体占位；
 *   2. `pageEvents` —— 从最新端按「条数 + 字节」双预算切一页，给出翻页游标；
 *   3. `sanitizeLiveEvent` —— 实时推送前的同款限幅（阈值更紧）。
 *
 * 输入一律按 `unknown` 处理：历史行、实时信封、垃圾输入都不许抛异常。
 */

/** 历史里对话区不需要的系统事件类型（request/header 每轮一条可达 37KB）。 */
const DROPPED_HISTORY_TYPES = new Set(['request/header', 'request/context'])

/** 图片占位符：data:image/...;base64 与独立超长 base64 串统一换成它。 */
export const IMAGE_PLACEHOLDER = '[图片]'

/** 历史版单字符串字段长度上限（字符数），超过即截断。 */
export const HISTORY_MAX_STRING_CHARS = 4_000
/** 完整用户/助手正文使用独立预算，避免刷新后把普通长报告裁成工具摘要。 */
export const MESSAGE_MAX_STRING_CHARS = 64_000
export const MESSAGE_MAX_EVENT_BYTES = 512 * 1_024
/** 实时版单字符串字段长度上限（字符数），比历史版更紧 —— 实时帧逐条上线。 */
export const LIVE_MAX_STRING_CHARS = 2_000
/** 递归遍历深度上限（spec：深度 ≤ 6；dsh 事件文本实测都在这个深度内）。 */
export const SANITIZE_MAX_DEPTH = 6
/** 历史单事件序列化字节上限，超过则整个 data 换占位。 */
export const HISTORY_MAX_EVENT_BYTES = 64 * 1_024
/** 历史分页默认条数预算。 */
export const DEFAULT_PAGE_MAX_EVENTS = 400
/** 历史分页默认字节预算（远小于 4MiB 帧上限，给信封与 Hub 转发留足余量）。 */
export const DEFAULT_PAGE_MAX_BYTES = 2_000_000
/** 实时单事件序列化字节上限。 */
export const DEFAULT_LIVE_MAX_BYTES = 1_000_000

/**
 * 独立 base64 串的判定下限（字符数）。
 *
 * 截图 base64 动辄数千字符；阈值定在 512 是为了不误伤短哈希（sha256 hex 64）
 * 与令牌（JWT 是 base64url，含 `-`/`_`，本就匹配不上）。长度达标且去空白后
 * 是纯 base64 字符集的串，在会话事件里只可能是内嵌文件/图片。
 */
const BASE64_MIN_CHARS = 512

export interface SanitizeHistoryOptions {
  /** 单字符串字段截断阈值（字符数），默认 {@link HISTORY_MAX_STRING_CHARS} */
  maxStringChars?: number
  /** 单事件序列化字节上限，默认 {@link HISTORY_MAX_EVENT_BYTES} */
  maxEventBytes?: number
}

export interface PageOptions {
  /** 条数预算（从最新端取），默认 {@link DEFAULT_PAGE_MAX_EVENTS} */
  maxEvents?: number
  /** 总字节预算（各事件序列化字节之和），默认 {@link DEFAULT_PAGE_MAX_BYTES} */
  maxBytes?: number
}

export interface PageResult {
  /** 切片，seq 升序（与输入相对顺序一致） */
  events: unknown[]
  /** 切片之外（更老的方向上）还有事件吗 */
  hasMore: boolean
  /**
   * 本页最旧一条事件的 seq —— 仅当 `hasMore` 时出现。
   *
   * 客户端以 `beforeSeq = oldestSeq` 拉下一页（节点取 `seq < beforeSeq` 再分页），
   * 页与页之间无缝无重。注意它必须是**切片内**最旧一条的 seq：若取切片外那条，
   * 严格小于过滤会把它永久跳过。
   */
  oldestSeq?: number
}

export interface SanitizeLiveOptions {
  /** 序列化字节上限，默认 {@link DEFAULT_LIVE_MAX_BYTES} */
  maxBytes?: number
}

/* ────────────────────────── 历史：瘦身 ────────────────────────── */

/** 取历史行（`{event:{seq}}`）或实时通知体里内层事件的 seq；取不到返回 undefined。 */
export function historyEntrySeq(entry: unknown): number | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const event = (entry as { event?: unknown }).event
  if (event === null || typeof event !== 'object') return undefined
  const seq = (event as { seq?: unknown }).seq
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : undefined
}

/** 历史行的内层事件类型（`{event:{type}}`）；取不到返回 undefined。 */
function historyEntryType(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const event = (entry as { event?: unknown }).event
  if (event === null || typeof event !== 'object') return undefined
  const type = (event as { type?: unknown }).type
  return typeof type === 'string' ? type : undefined
}

/**
 * 回历史前的逐事件瘦身：
 *   ① 丢弃 `request/header`、`request/context`（对话区不需要，且单条可达 37KB）；
 *   ② 任意字符串字段超 `maxStringChars` 截断为「前 N 字符 + …[截断，原 M 字符]」
 *     （递归遍历，深度 ≤ 6）；
 *   ③ base64 图片 / 数据 URL（`data:image/...;base64,…` 及独立超长 base64 串）
 *     替换为 `[图片]`；
 *   ④ 单事件序列化后仍超 `maxEventBytes` 的，整个 data 换 `{oversized:true, bytes}`。
 *
 * 不修改入参（返回新对象）；非数组输入、畸形条目都不抛异常。
 */
export function sanitizeHistoryEvents(
  events: unknown,
  options: SanitizeHistoryOptions = {},
): unknown[] {
  if (!Array.isArray(events)) return []
  const maxStringChars = options.maxStringChars ?? HISTORY_MAX_STRING_CHARS
  const maxEventBytes = options.maxEventBytes ?? HISTORY_MAX_EVENT_BYTES

  const out: unknown[] = []
  for (const entry of events) {
    const type = historyEntryType(entry)
    if (type !== undefined && DROPPED_HISTORY_TYPES.has(type)) continue
    const isMessage = type === 'user/message' || type === 'assistant/message'
    const stringBudget = isMessage && options.maxStringChars === undefined ? MESSAGE_MAX_STRING_CHARS : maxStringChars
    const eventBudget = isMessage && options.maxEventBytes === undefined ? MESSAGE_MAX_EVENT_BYTES : maxEventBytes
    const slim = sanitizeValue(entry, stringBudget, 0, new Set())
    const bytes = byteLength(slim)
    out.push(bytes <= eventBudget ? slim : replaceEntryData(slim, bytes))
  }
  return out
}

/* ────────────────────────── 历史：分页 ────────────────────────── */

/**
 * 按 seq 升序保序后，从**最新端**往前取一页，同时满足条数与字节双预算。
 *
 * 保底规则：只要输入非空，至少取回最新一条（哪怕它一条就超字节预算）——
 * 否则翻页会永远停在原地。（接线路径里事件已被 64KB 单事件上限罩住，这条
 * 只在 pageEvents 被独立调用时才有感。）
 *
 * 无 seq 的条目按「比一切 seq 更老」参与排序（稳定），真实 dsh 数据恒有 seq。
 */
export function pageEvents(events: unknown, options: PageOptions = {}): PageResult {
  if (!Array.isArray(events) || events.length === 0) return { events: [], hasMore: false }
  const maxEvents = clampInt(options.maxEvents, DEFAULT_PAGE_MAX_EVENTS, 1)
  const maxBytes = clampInt(options.maxBytes, DEFAULT_PAGE_MAX_BYTES, 0)

  const sorted = events.map((entry, index) => ({ entry, index, seq: historyEntrySeq(entry) }))
  sorted.sort((a, b) => {
    const sa = a.seq ?? Number.NEGATIVE_INFINITY
    const sb = b.seq ?? Number.NEGATIVE_INFINITY
    if (sa !== sb) return sa - sb
    return a.index - b.index
  })

  const taken: unknown[] = []
  let bytes = 0
  let cursor = sorted.length - 1
  for (; cursor >= 0; cursor--) {
    const entry = (sorted[cursor] as (typeof sorted)[number]).entry
    const entryBytes = byteLength(entry)
    if (taken.length > 0 && (taken.length >= maxEvents || bytes + entryBytes > maxBytes)) break
    taken.push(entry)
    bytes += entryBytes
  }

  taken.reverse()
  const hasMore = cursor >= 0
  const result: PageResult = { events: taken, hasMore }
  if (hasMore) {
    const oldestSeq = historyEntrySeq(taken[0])
    if (oldestSeq !== undefined) result.oldestSeq = oldestSeq
  }
  return result
}

/* ────────────────────────── 实时：限幅 ────────────────────────── */

/**
 * 实时推送前的同款限幅：字符串阈值收紧到 {@link LIVE_MAX_STRING_CHARS} 字符，
 * base64 同样换 `[图片]`；序列化后仍超 `maxBytes` 的把 data 换
 * `{oversized:true, bytes}` 占位（保留 type / sessionId / rpcId 等路由与
 * 归一化字段 —— UI 归一化会把不认识的 data 归 hidden，不会炸）。
 */
export function sanitizeLiveEvent(event: unknown, options: SanitizeLiveOptions = {}): unknown {
  const maxBytes = options.maxBytes ?? DEFAULT_LIVE_MAX_BYTES
  const payload = isPlainObject(event) ? event['payload'] : undefined
  const inner = isPlainObject(payload) ? payload['event'] : undefined
  const type = isPlainObject(inner) ? inner['type'] : isPlainObject(event) ? event['type'] : undefined
  const isMessage = type === 'user/message' || type === 'assistant/message'
  const slim = sanitizeValue(event, isMessage ? MESSAGE_MAX_STRING_CHARS : LIVE_MAX_STRING_CHARS, 0, new Set())
  const bytes = byteLength(slim)
  return bytes <= maxBytes ? slim : replaceLiveData(slim, bytes)
}

/* ────────────────────────── 内部工具 ────────────────────────── */

function clampInt(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.floor(value))
}

/** 递归清洗：字符串截断 + base64 占位。深度超过 6 的子树原样共享（不再深入）。 */
function sanitizeValue(
  value: unknown,
  maxStringChars: number,
  depth: number,
  seen: Set<object>,
): unknown {
  if (typeof value === 'string') return sanitizeString(value, maxStringChars)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[循环引用]'
  if (depth >= SANITIZE_MAX_DEPTH) return value

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = new Array(value.length)
      for (let index = 0; index < value.length; index++) {
        out[index] = sanitizeValue(value[index], maxStringChars, depth + 1, seen)
      }
      return out
    }
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeValue(child, maxStringChars, depth + 1, seen)
    }
    return out
  } finally {
    seen.delete(value)
  }
}

function sanitizeString(text: string, maxStringChars: number): string {
  if (isImageDataUrl(text)) return IMAGE_PLACEHOLDER
  if (isStandaloneBase64(text)) return IMAGE_PLACEHOLDER
  if (text.length > maxStringChars) {
    return `${text.slice(0, maxStringChars)}…[截断，原 ${text.length} 字符]`
  }
  return text
}

function isImageDataUrl(text: string): boolean {
  return /^data:image\/[a-z0-9.+-]*;base64,/i.test(text)
}

/**
 * 独立超长 base64 串（允许换行包装）：去空白后纯 base64 字符集且长度达标。
 *
 * 额外要求至少一个 `+`/`/`/`=`：二进制内容（截图）的 base64 几乎必然含 `+` 或 `/`，
 * 而「纯字母 + 空格」的长段散文去空白后也满足字符集 —— 没有这一条会把 prose
 * 误判成图片。
 */
function isStandaloneBase64(text: string): boolean {
  if (text.length < BASE64_MIN_CHARS) return false
  const compact = text.includes('\n') || text.includes('\r') || text.includes(' ')
    ? text.replace(/\s+/g, '')
    : text
  if (compact.length < BASE64_MIN_CHARS) return false
  if (!/[+/=]/.test(compact)) return false
  return /^[A-Za-z0-9+/]+={0,2}$/.test(compact)
}

/** UTF-8 字节数（与 ws 帧计量口径一致）；序列化失败视为无穷大（触发占位兜底）。 */
function byteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return 0
    return Buffer.byteLength(json, 'utf8')
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function oversizedPlaceholder(bytes: number): { oversized: true; bytes: number } {
  return { oversized: true, bytes }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 历史条目超大时换 data 占位；形状不符时整个条目占位 —— 绝不放行超帧内容。 */
function replaceEntryData(entry: unknown, bytes: number): unknown {
  if (isPlainObject(entry)) {
    const event = entry['event']
    if (isPlainObject(event) && 'data' in event) {
      return { ...entry, event: { ...event, data: oversizedPlaceholder(bytes) } }
    }
  }
  return oversizedPlaceholder(bytes)
}

/**
 * 实时信封超大时的分层占位：优先换最内层 data
 * （`{method, payload:{type, sessionId, event:{type, data}}}` 信封换 `payload.event.data`），
 * 依次退到顶层 `data`、顶层 `payload`，最后才是整体占位。
 */
function replaceLiveData(event: unknown, bytes: number): unknown {
  if (!isPlainObject(event)) return oversizedPlaceholder(bytes)
  const payload = event['payload']
  if (isPlainObject(payload)) {
    const inner = payload['event']
    if (isPlainObject(inner) && 'data' in inner) {
      return {
        ...event,
        payload: { ...payload, event: { ...inner, data: oversizedPlaceholder(bytes) } },
      }
    }
  }
  if ('data' in event) return { ...event, data: oversizedPlaceholder(bytes) }
  if ('payload' in event) return { ...event, payload: oversizedPlaceholder(bytes) }
  return oversizedPlaceholder(bytes)
}
