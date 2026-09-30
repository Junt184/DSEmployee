/**
 * 配对码 —— 设备引导的第二条信任锚。
 *
 * 为什么要有它：`dse pair approve` 的信任锚是"能在 Hub 本机读写状态文件"，
 * 这在单人自用、Hub 跑在云服务器上的形态里体验很差 —— 为了批准自己的手机，
 * 用户得先 SSH 上去跑命令。配对码把同一个信任锚换成更好用的形式：
 * **能看到 Hub 终端输出（或能在 Hub 本机执行 `dse pair-code`）的人**，
 * 与"能读写状态文件的人"本就是同一信任级别。
 *
 * 安全设计（每一环都对应一个明确的威胁）：
 *   · 只存 sha256，明文只出现在生成那一次的终端输出里 —— 状态目录被读 ≠ 拿到码；
 *   · 一次性：批准成功即标记 used，重放直接拒；
 *   · 24h 过期：启动输出/日志截图不会成为长期敞开的口子；
 *   · 6 位数字只有 ~20 bit 熵，所以**防爆破计数是本方案的一部分**而不是装饰 ——
 *     见 server.ts 的 redeem 限流（同一 IP 连错 5 次断连并短暂拒绝）。
 *   · 每次校验都从磁盘重读：`dse pair-code` 换码后对运行中的 Hub 立即生效，
 *     不需要重启（与 refreshDevices() 让 `dse pair approve` 立即生效同理）。
 */

import { createHash, randomInt } from 'node:crypto'

import { newId, pathExists, readJsonFile, writeJsonFile } from '../util/fsx.ts'
import type { HubStore } from './store.ts'

/** 配对码有效期：24 小时。 */
export const PAIR_CODE_TTL_MS = 24 * 60 * 60_000

/** `<状态目录>/hub/pair-code.json` 的内容。刻意不含明文。 */
export interface PairCodeFile {
  /** 配对码的 sha256（hex） */
  sha256: string
  createdAtMs: number
  expiresAtMs: number
  /** 已用即作废 —— 一个码只放行一次配对 */
  used: boolean
}

/** 生成 6 位数字配对码（明文，只交给调用方打印一次）。 */
export function newPairCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

export function hashPairCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

/** 生成新码并落盘（旧码随之作废 —— 同一时间只有一个有效码）。返回明文用于打印。 */
export async function issuePairCode(store: HubStore): Promise<string> {
  const code = newPairCode()
  const now = Date.now()
  const file: PairCodeFile = {
    sha256: hashPairCode(code),
    createdAtMs: now,
    expiresAtMs: now + PAIR_CODE_TTL_MS,
    used: false,
  }
  await writeJsonFile(store.files.pairCode, file)
  return code
}

/**
 * 读取当前配对码。**每次调用都重读磁盘**，不做内存缓存 ——
 * 这样 CLI 新生成的码对正在运行的 Hub 立即生效。
 */
export async function readPairCode(store: HubStore): Promise<PairCodeFile | undefined> {
  if (!(await pathExists(store.files.pairCode))) return undefined
  const file = await readJsonFile<PairCodeFile | undefined>(store.files.pairCode, undefined)
  // 形状不对当作"没有码"处理：宁可让人重新生成，也不拿损坏状态做安全判断
  if (typeof file?.sha256 !== 'string' || typeof file.expiresAtMs !== 'number') return undefined
  return file
}

/** 把当前配对码标记为已用。 */
export async function markPairCodeUsed(store: HubStore): Promise<void> {
  const file = await readPairCode(store)
  if (file === undefined) return
  await writeJsonFile(store.files.pairCode, { ...file, used: true })
}

/* ────────────────────────────── 节点码池 ──────────────────────────────
 *
 * 场景：Hub 在云上（看启动输出要 SSH），而人总在某台终端旁边 ——
 * 让每台终端节点也能出码（dse pair-code --hub ...），任一码都能完成配对。
 *
 * 与 Hub 码刻意**分文件**存储：Hub 码的信任锚是"能看到 Hub 终端输出"，
 * 节点码的信任锚是"能操作一台已配对的节点"——后者本来就持有能驱动所有员工的
 * 节点身份，给它出码权不扩大攻击面。但节点码必须是**短命**的（上限 30 分钟），
 * 因为节点分布在现场，码被旁人瞥见的风险比机房里的 Hub 高。
 */

/** 节点码有效期上限：30 分钟。 */
export const NODE_PAIR_CODE_MAX_TTL_MS = 30 * 60_000

/** 每个节点同时活跃（未用且未过期）的码上限 —— 防节点端脚本失控刷码把池子灌满。 */
export const NODE_PAIR_CODE_MAX_PER_NODE = 3

/** `pair-code-nodes.json` 里一条节点码。 */
export interface NodePairCode {
  sha256: string
  /** 上报它的节点（审计用：批准日志里要能说出"这是哪台终端出的码"） */
  nodeId: string
  /** 人类可读的来源说明（如「公司 Mac」），可选 */
  label?: string
  createdAtMs: number
  expiresAtMs: number
  used: boolean
}

/** 读节点码池。与 Hub 码一样每次重读磁盘：节点随时可能上报新码。 */
export async function readNodePairCodes(store: HubStore): Promise<Record<string, NodePairCode>> {
  if (!(await pathExists(store.files.nodePairCodes))) return {}
  const pool = await readJsonFile<Record<string, NodePairCode>>(store.files.nodePairCodes, {})
  return typeof pool === 'object' && pool !== null ? pool : {}
}

async function writeNodePairCodes(
  store: HubStore,
  pool: Record<string, NodePairCode>,
): Promise<void> {
  await writeJsonFile(store.files.nodePairCodes, pool)
}

/**
 * 登记一个节点码。约束（fail-closed，全部拒绝而非悄悄修改）：
 *   · 有效期必须是未来、且不超过 30 分钟 —— 长寿的节点码违背了它的威胁模型；
 *   · 每节点最多 3 个活跃码；
 *   · 哈希不得与池中另一个活跃码重复 —— 否则 redeem 的"标记 used"会歧义。
 * 返回 offerId（码池里的键）。
 */
export async function offerNodePairCode(
  store: HubStore,
  nodeId: string,
  input: { codeHash: string; expiresAtMs: number; label?: string },
): Promise<{ offerId: string; expiresAtMs: number }> {
  const now = Date.now()
  if (input.expiresAtMs <= now) {
    throw new Error('expiresAtMs is in the past; node pair codes must be short-lived')
  }
  if (input.expiresAtMs > now + NODE_PAIR_CODE_MAX_TTL_MS) {
    throw new Error(
      `node pair codes may live at most ${NODE_PAIR_CODE_MAX_TTL_MS / 60_000} minutes; ` +
        `generate a fresh one when needed instead of minting a long-lived one`,
    )
  }

  const pool = await readNodePairCodes(store)
  // 顺手清扫过期项：码池没有定时器，写路径是唯一合理的清扫点
  for (const [offerId, code] of Object.entries(pool)) {
    if (code.expiresAtMs <= now) {
      delete pool[offerId]
    }
  }

  const active = Object.values(pool).filter((code) => !code.used)
  if (active.filter((code) => code.nodeId === nodeId).length >= NODE_PAIR_CODE_MAX_PER_NODE) {
    throw new Error(
      `node ${nodeId} already has ${NODE_PAIR_CODE_MAX_PER_NODE} active pair codes; ` +
        `wait for them to expire or be used`,
    )
  }
  if (active.some((code) => code.sha256 === input.codeHash)) {
    throw new Error('an identical pair code is already active in the pool')
  }

  const offerId = newId('pc')
  pool[offerId] = {
    sha256: input.codeHash,
    nodeId,
    createdAtMs: now,
    expiresAtMs: input.expiresAtMs,
    used: false,
    ...(input.label === undefined ? {} : { label: input.label }),
  }
  await writeNodePairCodes(store, pool)
  return { offerId, expiresAtMs: input.expiresAtMs }
}

/** 把池里某个节点码标记为已用。 */
export async function markNodePairCodeUsed(store: HubStore, offerId: string): Promise<void> {
  const pool = await readNodePairCodes(store)
  const code = pool[offerId]
  if (code === undefined) return
  pool[offerId] = { ...code, used: true }
  await writeNodePairCodes(store, pool)
}

/* ────────────────────────────── redeem 的统一查找 ────────────────────────────── */

/** 配对码查找结果。把"没配过码 / 没命中 / 命中但已用 / 命中但过期 / 可用"分开，
 *  是为了让 redeem 能给出准确的失败原因，而不是一律"不正确"。 */
export type PairCodeLookup =
  | { status: 'ok'; source: { kind: 'hub' } | { kind: 'node'; offerId: string; nodeId: string; label?: string } }
  | { status: 'used' }
  | { status: 'expired' }
  | { status: 'no-match' }
  | { status: 'no-codes' }

/**
 * 在 Hub 码 + 全部节点码里查找一个明文码。
 *
 * 先按哈希找**任何**匹配（不管状态）：命中但不可用（used/expired）要如实告知 ——
 * 那是"拿到过真码"的情形，与"瞎猜"（no-match）必须区分开，因为只有后者计入爆破。
 */
export async function lookupPairCode(store: HubStore, code: string): Promise<PairCodeLookup> {
  const digest = hashPairCode(code)
  const now = Date.now()

  type Candidate = { used: boolean; expiresAtMs: number; source: { kind: 'hub' } | { kind: 'node'; offerId: string; nodeId: string; label?: string } }
  const matches: Candidate[] = []

  const hubCode = await readPairCode(store)
  if (hubCode !== undefined && timingSafeEqualHex(digest, hubCode.sha256)) {
    matches.push({ used: hubCode.used, expiresAtMs: hubCode.expiresAtMs, source: { kind: 'hub' } })
  }
  const pool = await readNodePairCodes(store)
  for (const [offerId, nodeCode] of Object.entries(pool)) {
    if (!timingSafeEqualHex(digest, nodeCode.sha256)) continue
    matches.push({
      used: nodeCode.used,
      expiresAtMs: nodeCode.expiresAtMs,
      source: {
        kind: 'node',
        offerId,
        nodeId: nodeCode.nodeId,
        ...(nodeCode.label === undefined ? {} : { label: nodeCode.label }),
      },
    })
  }

  const anyCodeExists = hubCode !== undefined || Object.keys(pool).length > 0
  if (matches.length === 0) return anyCodeExists ? { status: 'no-match' } : { status: 'no-codes' }
  const usable = matches.find((match) => !match.used && match.expiresAtMs > now)
  if (usable !== undefined) return { status: 'ok', source: usable.source }
  if (matches.every((match) => match.used)) return { status: 'used' }
  return { status: 'expired' }
}

/** 等长 hex 的常量时间比较（配对码哈希比对用，避免时序侧信道）。 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
