/**
 * Hub 方法处理器。
 *
 * 分三类，与 `METHODS[m].route` 一一对应：
 *   · `hub`   —— 在 Hub 本地执行（设备台账、目录聚合、ACL、审批）
 *   · `node`  —— 把请求**转发**给员工所在的终端节点，由节点去驱动 dsh
 *   · `relay` —— 员工互调：先过 ACL 与审批，再转发
 *
 * 这一层是"Hub 不认识 dsh"的边界：凡是要碰工作区、会话、dsh 的事，
 * 都只以 RPC 形式转发出去，Hub 自己绝不碰文件系统。
 */

import { z } from 'zod'

import {
  isProtocolError,
  normalizeScopes,
  protocolError,
  type Scope,
} from '../protocol/index.ts'
import { newId } from '../util/fsx.ts'
import { QUEUEABLE_METHODS, enqueueForNode, mailboxItemsFor } from './mailbox.ts'
import { currentCodeFingerprint, runtimeEntry } from '../protocol/build.ts'
import { evaluateAcl, removeAclRule, upsertAclRule } from './acl.ts'
import { resolveInvokePrincipal } from './invoke-principal.ts'
import { ACTIVITY_DEFAULT_WINDOW_MS, ACTIVITY_MAX_WINDOW_MS, collectActivity } from './activity.ts'
import { SELF_JOB_LIMIT, resolveSelfJobEmployee } from './self-jobs.ts'
import { PUSH_MAX_PAYLOAD_BYTES, sendToAll, upsertSubscription } from './push.ts'
import {
  MAX_RUNS_PER_JOB,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  dueJobs,
  normalizeInterval,
  recordRun,
  rollForwardMissed,
  runJob,
  runsFor,
} from './scheduler.ts'
import {
  approvePairing,
  rejectPairing,
  removePairing,
  revokeToken,
  rotateToken,
  sweepExpiredPairings,
  operatorApprovalAllowed,
  pairingApprovalMode,
} from './devices.ts'
import {
  lookupPairCode,
  markNodePairCodeUsed,
  markPairCodeUsed,
  offerNodePairCode,
} from './paircode.ts'
import type { Connection, Hub } from './server.ts'
import type { HubState } from './store.ts'
import { assertLlmApiUrl, maskApiKey } from '../util/llm.ts'
import type { ScheduleJob } from './types.ts'
import type {
  AclEffect,
  ApprovalRecord,
  ApprovalStatus,
  DshInteraction,
  EmployeeRecord,
  InvokeRecord,
  LlmEndpointRecord,
  NodeRecord,
  PositionEntry,
} from './types.ts'

type Handler = (hub: Hub, conn: Connection, params: unknown) => Promise<unknown>

/* ────────────────────────────── 参数校验 ────────────────────────────── */

const employeeIdSchema = z.string().min(1).max(128)
const nodeIdSchema = z.string().min(1).max(128)
const sessionIdSchema = z.string().min(1).max(256)

const empty = z.object({}).passthrough()

const employeeRef = z.object({ employeeId: employeeIdSchema })

const aclEffectSchema = z.enum(['allow', 'approve', 'deny'])

function parse<T extends z.ZodTypeAny>(schema: T, params: unknown, method: string): z.infer<T> {
  const result = schema.safeParse(params ?? {})
  if (!result.success) {
    /* 消息里必须带**是哪个字段、错在哪**。
       只说 "invalid params for X" 的话，拿到错误的人（用户、排障的人）知道的是
       "参数不合法"，却不知道改哪里 —— 本仓库已经为这句含糊话付过一次学费
       （employee.files.upload 的文件上限，见 forwarder 的注释）；
       真实事故里它又出现了一次：用户改分组时吃到 `position.upsert 失败：
       invalid params for position.upsert`，而这一句既没说是哪个字段，也没说是太长还是多余，
       当场无从下手。details.issues 一直带着完整信息，只是没人把它变成人话。 */
    throw protocolError('bad-request', `invalid params for ${method}: ${describeZodIssues(result.error)}`, {
      issues: result.error.issues,
    })
  }
  return result.data as z.infer<T>
}

/** 把 zod 的 issues 压成一行人话：字段路径在前，最多三条。 */
function describeZodIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.length === 0 ? '(整体)' : issue.path.join('.')
    const detail = issue as { code?: string; maximum?: number; minimum?: number; expected?: string; keys?: string[] }
    switch (detail.code) {
      case 'too_big':
        return `${path} 超出上限${detail.maximum === undefined ? '' : ` ${detail.maximum}`}`
      case 'too_small':
        return `${path} 低于下限${detail.minimum === undefined ? '' : ` ${detail.minimum}`}`
      case 'invalid_type':
        return `${path} 类型不对${detail.expected === undefined ? '' : `（应为 ${detail.expected}）`}`
      case 'unrecognized_keys':
        return `${path} 有多余字段：${(detail.keys ?? []).join('/')}`
      case 'invalid_string':
        return `${path} 格式不合法`
      default:
        return `${path} ${issue.message}`
    }
  })
  const more = error.issues.length > parts.length ? `；另有 ${error.issues.length - parts.length} 处` : ''
  return parts.join('；') + more
}

/**
 * 把任意抛出物转成一句人话。
 *
 * 为什么不直接用 `error instanceof Error ? error.message : String(error)`：
 * 本文件里 `forwardToNode` / `forwardToEmployeeNode` 抛的是 `protocolError()`
 * 造的**普通对象**（`{code, message}`，不是 Error 实例），于是 `String(error)`
 * 会得到 `'[object Object]'` —— 真正的原因当场丢失，日志和回报里只剩一个空壳。
 * 这类"看着有错误信息、其实什么都没说"的缺陷排查成本极高，所以统一从这里过。
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object') {
    const candidate = error as { message?: unknown; code?: unknown }
    if (typeof candidate.message === 'string' && candidate.message !== '') {
      return typeof candidate.code === 'string' && candidate.code !== ''
        ? `${candidate.code}: ${candidate.message}`
        : candidate.message
    }
  }
  return String(error)
}

/* ────────────────────────────── 目录查询辅助 ────────────────────────────── */

/**
 * 找到员工并确认它所在的节点在线。
 * 员工不在目录里 → not-found；节点离线 → node-offline（调用方据此决定是否排队）。
 */
function requireEmployee(hub: Hub, employeeId: string): EmployeeRecord {
  const employee = hub.state().employees[employeeId]
  if (employee === undefined) {
    throw protocolError('not-found', `unknown employee "${employeeId}"`)
  }
  return employee
}

/** 把请求转发给承载某员工的节点。 */
async function forwardToEmployeeNode(
  hub: Hub,
  employeeId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const employee = requireEmployee(hub, employeeId)
  return await forwardToNode(hub, employee.nodeId, method, { ...params, employeeId })
}

/** 把请求转发到**指定节点**（用于还没有 employeeId 的操作，例如创建员工）。 */
async function forwardToNode(
  hub: Hub,
  nodeId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (hub.state().nodes[nodeId] === undefined) {
    throw protocolError('not-found', `unknown node "${nodeId}"`)
  }
  const res = await hub.requestToNode(nodeId, method, params)
  if (!res.ok) {
    const code = res.error?.code ?? 'internal'
    /* 节点离线 + 该方法"结果不靠返回值" → 存进离线邮箱，等节点回来按序送出。
       其余情况（含超时这种"结果未知"）仍然立刻报错：排队会让调用方拿着空洞的成功往前走。 */
    if (code === 'node-offline' && QUEUEABLE_METHODS[method] === true) {
      const { item, dropped } = await enqueueForNode(hub, nodeId, method, params)
      hub.log(`mailbox: queued ${method} for offline node ${nodeId.slice(0, 12)}… (${item.mailId})`)
      const queued = mailboxItemsFor(hub.state(), nodeId).length
      return {
        queued: true,
        mailId: item.mailId,
        queuedAtMs: item.createdAtMs,
        queueLength: queued,
        ...(dropped.length === 0
          ? {}
          : {
              droppedOldest: dropped.length,
              note: '该节点的队列已满，丢掉了最旧的一条待发指令（新指令优先）。',
            }),
      }
    }
    throw res.error ?? protocolError('internal', `node call "${method}" failed`)
  }
  return res.payload
}

/* ────────────────────────────── 本地方法 ────────────────────────────── */

const health: Handler = async (hub, conn) => {
  const state = hub.state()
  const online = new Set<string>()
  for (const c of hub.connections) {
    if (c.phase === 'ready' && c.role === 'node' && c.nodeId !== undefined) online.add(c.nodeId)
  }
  const employees = Object.values(state.employees)
  return {
    ok: true,
    hubId: state.config.hubId,
    name: state.config.name,
    version: '0.1.0',
    listening: { host: hub.address.host, port: hub.address.port },
    counts: {
      nodes: Object.keys(state.nodes).length,
      nodesOnline: online.size,
      employees: employees.length,
      employeesAvailable: employees.filter((e) => online.has(e.nodeId) && e.status === 'ok').length,
      pairedDevices: Object.values(state.paired).filter((d) => !d.revoked).length,
      pendingPairings: Object.keys(state.pending).length,
      pendingApprovals: Object.values(state.approvals).filter((a) => a.status === 'pending').length,
    },
    you: {
      deviceId: conn.deviceId,
      role: conn.role,
      scopes: conn.scopes,
      clientId: conn.clientId,
      remoteIp: conn.remoteIp,
    },
  }
}

const whoami: Handler = async (_hub, conn) => ({
  deviceId: conn.deviceId,
  role: conn.role,
  scopes: conn.scopes,
  clientId: conn.clientId,
  platform: conn.platform,
  displayName: conn.displayName,
  nodeId: conn.nodeId,
  subscriptions: [...conn.subscriptions],
  connectedAtMs: conn.connectedAtMs,
})

/* ── 设备 ── */

const deviceList: Handler = async (hub) => {
  // 用户正要看清单，正是清理过期请求的时机 —— 列表里不该出现早就作废的条目
  const expired = await sweepExpiredPairings(hub.store)
  if (expired.length > 0) hub.debug(`swept ${expired.length} expired pairing request(s)`)
  const state = hub.state()
  return {
    /* 进门方式：控制台据此决定待配对那一段是"给批准按钮"还是"只等下一个人输码"。
       放在这里而不是单独一个查询接口：设备页本来就是一次取全的。 */
    approval: pairingApprovalMode(state.config),
    pending: Object.values(state.pending).map((request) => ({
      requestId: request.requestId,
      deviceId: request.deviceId,
      role: request.role,
      scopes: request.scopes,
      platform: request.platform,
      clientId: request.clientId,
      displayName: request.displayName,
      remoteIp: request.remoteIp,
      fromLoopback: request.fromLoopback,
      requestedAtMs: request.requestedAtMs,
    })),
    paired: Object.values(state.paired).map((device) => ({
      deviceId: device.deviceId,
      role: device.role,
      approvedScopes: device.approvedScopes,
      platform: device.platform,
      clientId: device.clientId,
      displayName: device.displayName,
      pairedAtMs: device.pairedAtMs,
      revoked: device.revoked,
      lastSeenAtMs: device.lastSeenAtMs,
      lastSeenIp: device.lastSeenIp,
    })),
  }
}

const devicePairApprove: Handler = async (hub, conn, params) => {
  const input = parse(
    z.object({
      requestId: z.string().min(1).max(128),
      approvedScopes: z.array(z.string()).optional(),
      displayName: z.string().min(1).max(64).optional(),
    }),
    params,
    'device.pair.approve',
  )
  /* 只认配对码时，这条路必须**拒绝**，而不是"警告一下照做"。
     为什么：这条路的判断依据只有 clientId / 平台 / 来源 IP，而这几样在多台同类设备
     之间根本分不出谁是谁（真实反馈：一整列「Mac 浏览器」）。安全性挂在人的注意力上
     的门，迟早会被一次随手点击打开。配对码那条路是限时 + 一次性 + 防爆破的。
     注意这**不影响** Hub 本机的 `dse pair approve`（它直接改状态文件，是 SSH 后路）。 */
  if (!operatorApprovalAllowed(hub.state().config)) {
    throw protocolError(
      'bad-request',
      '当前是「只允许配对码」模式：新设备必须在「允许新设备注册」窗口开着时用配对码加入。' +
        '要人工批准，先在设备页把进门方式改成「允许人工批准」（或在 Hub 本机执行 dse pairing approval operator）',
    )
  }
  const approved = await approvePairing(hub.store, input.requestId, conn.deviceId, {
    ...(input.approvedScopes === undefined
      ? {}
      : { approvedScopes: normalizeScopes(input.approvedScopes) }),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
  })
  hub.log(
    `approved pairing for ${approved.device.deviceId.slice(0, 12)}… role=${approved.device.role} scopes=[${approved.device.approvedScopes.join(',')}]`,
  )
  hub.broadcastToScope('device.pair', 'pair.resolved', {
    requestId: input.requestId,
    deviceId: approved.device.deviceId,
    approved: true,
  })
  return {
    deviceId: approved.device.deviceId,
    role: approved.device.role,
    scopes: approved.device.approvedScopes,
    /**
     * 刻意**不在这里返回令牌**：令牌由该设备在批准后的首次连接时自行领取
     * （它已用私钥签过挑战，足以证明身份）。这样调用方不必把令牌转交给设备，
     * 也避免了"令牌在中转过程中被谁看到"的问题。
     */
    tokenClaimable: true,
    note: 'the approved device will claim its token automatically on its next connect',
  }
}

/**
 * 配对码兑换。安全性论证见 methods.ts 条目与 paircode.ts 头部注释。
 *
 * 校验顺序刻意安排为「先码后请求」：码不对时绝不泄露某个 requestId 是否存在。
 * Hub 码与所有节点码一起查（lookupPairCode）；任一命中即批准。
 * 只有**完全没命中**才计入防爆破 —— 命中但过期/已用说明对方拿到过真码，
 * 那不是爆破行为，不该把正常用户推向限流。
 */
const devicePairRedeem: Handler = async (hub, conn, params) => {
  const input = parse(
    z.object({
      requestId: z.string().min(1).max(128),
      code: z.string().regex(/^\d{6}$/, 'pair code must be 6 digits'),
    }),
    params,
    'device.pair.redeem',
  )

  const blockedUntil = hub.redeemBlockedUntil(conn.remoteIp)
  if (blockedUntil > Date.now()) {
    throw protocolError('pair-code-invalid', '尝试次数过多，请一分钟后再试', {
      reason: 'rate-limited',
      retryAfterMs: blockedUntil - Date.now(),
    })
  }

  const lookup = await lookupPairCode(hub.store, input.code)
  if (lookup.status !== 'ok') {
    /* 命中但不可用（used/expired）如实告知；只有完全没命中（瞎猜）才计爆破 */
    if (lookup.status === 'no-match') hub.noteRedeemFailure(conn)
    const message =
      lookup.status === 'no-codes'
        ? '尚未生成任何配对码（在 Hub 或任一终端本机执行 dse pair-code）'
        : lookup.status === 'no-match'
          ? '配对码不正确'
          : lookup.status === 'used'
            ? '配对码已被使用，请重新生成'
            : '配对码已过期，请重新生成'
    // reason 与 Web 控制台的文案映射保持一致（ui.ts 的 redeemErrorText）
    const reason =
      lookup.status === 'no-codes' ? 'no-code' : lookup.status === 'no-match' ? 'wrong' : lookup.status
    throw protocolError('pair-code-invalid', message, { reason })
  }

  const request = hub.state().pending[input.requestId]
  if (request === undefined) {
    throw protocolError('not-found', '配对请求不存在或已过期；请重连一次刷新请求后再试')
  }

  // scopes 用设备请求的原样集合：请求入账时已按角色上限裁剪过（createPairingRequest），
  // approvePairing 内部还有一道裁剪做双保险，这里不需要也不应该再改权限。
  const approved = await approvePairing(hub.store, input.requestId, 'pair-code')
  // 命中哪个码就作废哪个码（Hub 码与节点码分文件存储）
  if (lookup.source.kind === 'hub') await markPairCodeUsed(hub.store)
  else await markNodePairCodeUsed(hub.store, lookup.source.offerId)
  hub.noteRedeemSuccess(conn.remoteIp)
  // 审计：批准日志必须能说清"用的是哪台机器出的码"
  const sourceText =
    lookup.source.kind === 'hub'
      ? 'hub pair code'
      : `node pair code from ${lookup.source.nodeId.slice(0, 12)}…${lookup.source.label === undefined ? '' : ` (${lookup.source.label})`}`
  hub.log(
    `approved pairing for ${approved.device.deviceId.slice(0, 12)}… via ${sourceText} (role=${approved.device.role})`,
  )
  hub.broadcastToScope('device.pair', 'pair.resolved', {
    requestId: input.requestId,
    deviceId: approved.device.deviceId,
    approved: true,
  })
  return {
    deviceId: approved.device.deviceId,
    role: approved.device.role,
    scopes: approved.device.approvedScopes,
    tokenClaimable: true,
    note: 'the approved device will claim its token automatically on its next connect',
  }
}

/**
 * 节点上报一个配对码（本机 `dse pair-code --hub ...` 生成）。
 *
 * 只认 role=node 的连接（方法表 roles 强制），nodeId 取连接身份而不是参数 ——
 * 节点只能给自己挂码，不能冒充别的节点。
 */
const nodePaircodeOffer: Handler = async (hub, conn, params) => {
  const input = parse(
    z.object({
      codeHash: z.string().regex(/^[0-9a-f]{64}$/, 'codeHash must be a sha256 hex'),
      expiresAtMs: z.number().int().positive(),
      label: z.string().max(64).optional(),
    }),
    params,
    'node.paircode.offer',
  )
  if (conn.role !== 'node' || conn.nodeId === undefined) {
    throw protocolError('forbidden', 'node.paircode.offer is only for node-role connections')
  }
  let offered: { offerId: string; expiresAtMs: number }
  try {
    offered = await offerNodePairCode(hub.store, conn.nodeId, {
      codeHash: input.codeHash,
      expiresAtMs: input.expiresAtMs,
      ...(input.label === undefined ? {} : { label: input.label }),
    })
  } catch (error) {
    // 池约束（有效期/数量/重复）违反 → 参数层面拒绝，不泄露池内容
    throw protocolError('bad-request', describeError(error))
  }
  hub.log(
    `node ${conn.nodeId.slice(0, 12)}… offered a pair code (valid until ${new Date(offered.expiresAtMs).toISOString()})`,
  )
  return { offerId: offered.offerId, expiresAtMs: offered.expiresAtMs }
}

const devicePairReject: Handler = async (hub, _conn, params) => {
  const input = parse(z.object({ requestId: z.string().min(1).max(128) }), params, 'device.pair.reject')
  const request = await rejectPairing(hub.store, input.requestId)
  hub.log(`rejected pairing request ${input.requestId} from ${request.remoteIp}`)
  hub.broadcastToScope('device.pair', 'pair.resolved', {
    requestId: input.requestId,
    deviceId: request.deviceId,
    approved: false,
  })
  return { requestId: input.requestId, rejected: true }
}

const devicePairRemove: Handler = async (hub, _conn, params) => {
  const input = parse(z.object({ deviceId: z.string().min(1) }), params, 'device.pair.remove')
  const removed = await removePairing(hub.store, input.deviceId)
  if (!removed) throw protocolError('not-found', `device ${input.deviceId} is not paired`)
  return { deviceId: input.deviceId, removed: true }
}

/**
 * 给已配对设备改名。
 *
 * 为什么必须有：`displayName` 只在配对那一刻由客户端自报，之后没有任何写入口 ——
 * 于是清单上是清一色的「Mac 浏览器」「iPhone 浏览器」，人分不出谁是谁（真实反馈）。
 * 而"分不清谁是谁"会直接削弱上一个动作：看到一条可疑记录时不敢吊销，
 * 怕吊销的是自己。名字可改，这台设备才是一条**可辨认、可处置**的记录。
 *
 * 只改名字，不动 role / scope / 令牌 —— 改名不该是任何形式的提权路径。
 */
const deviceRename: Handler = async (hub, conn, params) => {
  const input = parse(
    z.object({
      deviceId: z.string().min(1).max(128),
      /* 收敛在 1..40：名字是给人看的，够长就行；同时挡掉空字符串与纯空白
         （空名字等于把"分不清谁是谁"原样还回去）。控制字符会污染日志与列表。 */
      name: z
        .string()
        .min(1)
        .max(40)
        .refine((value) => value.trim() !== '', 'name must not be blank')
        .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'name must not contain control characters'),
    }),
    params,
    'device.rename',
  )
  const state = hub.state()
  const device = state.paired[input.deviceId]
  if (device === undefined) throw protocolError('not-found', `device ${input.deviceId} is not paired`)
  const name = input.name.trim()
  /* 幂等：改成同一个名字不算变更，也不写盘 —— 否则重试会把落盘次数放大。 */
  if (device.displayName === name) return { deviceId: device.deviceId, displayName: name, changed: false }
  device.displayName = name
  await hub.store.savePaired()
  hub.log(`renamed device ${device.deviceId.slice(0, 12)}… to "${name}" (by ${conn.deviceId.slice(0, 12)}…)`)
  hub.broadcastToScope('device.pair', 'device.renamed', { deviceId: device.deviceId, displayName: name })
  return { deviceId: device.deviceId, displayName: name, changed: true }
}

const deviceTokenRotate: Handler = async (hub, conn, params) => {
  const input = parse(
    z.object({ deviceId: z.string().min(1), scopes: z.array(z.string()).optional() }),
    params,
    'device.token.rotate',
  )
  const { device, token } = await rotateToken(
    hub.store,
    input.deviceId,
    input.scopes === undefined ? undefined : normalizeScopes(input.scopes),
  )
  hub.log(
    `rotated token for ${device.deviceId.slice(0, 12)}… by ${conn.deviceId.slice(0, 12)}…`,
  )
  return {
    deviceId: device.deviceId,
    scopes: device.approvedScopes,
    deviceToken: token,
    note: 'store this token now; the hub keeps only its hash',
  }
}

const deviceTokenRevoke: Handler = async (hub, conn, params) => {
  const input = parse(z.object({ deviceId: z.string().min(1) }), params, 'device.token.revoke')
  await revokeToken(hub.store, input.deviceId)
  hub.log(`revoked token for ${input.deviceId.slice(0, 12)}… by ${conn.deviceId.slice(0, 12)}…`)
  return { deviceId: input.deviceId, revoked: true }
}

/* ── 节点 ── */

const nodeRegisterSchema = z.object({
  name: z.string().min(1).max(64),
  platform: z.string().min(1).max(32),
  employeeRoot: z.string().min(1),
  dshVersion: z.string().max(64).optional(),
  /** 节点自身代码的内容指纹（见 `src/protocol/build.ts`）；老节点不给 */
  codeVersion: z.string().min(1).max(64).optional(),
  /** 节点实际加载的入口形态（dist 编译产物 / src 源码） */
  runtime: z.enum(['dist', 'src', 'unknown']).optional(),
  dshPort: z.number().int().positive().max(65535).optional(),
  employees: z
    .array(
      z.object({
        id: employeeIdSchema,
        name: z.string().min(1).max(128),
        role: z.string().max(2000),
        workspacePath: z.string().min(1),
        workspaceId: z.string().max(128).optional(),
        agentPreset: z.string().max(64).optional(),
        group: z.string().max(64).optional(),
        intro: z.string().max(500).optional(),
        hasAvatar: z.boolean().optional(),
        /** 头像版本（文件 mtime 与字节数）—— 控制台本地缓存的失效依据，见 EmployeeRecord */
        avatarUpdatedAtMs: z.number().int().nonnegative().optional(),
        avatarBytes: z.number().int().nonnegative().optional(),
        /** 当前模型别名（如 gpt5.6-noelle）+ 用到的端点库 id，见 EmployeeRecord */
        llmActiveName: z.string().max(64).optional(),
        llmEndpointIds: z.array(z.string().max(64)).max(64).optional(),
        /** 工作区自己是否是 git 仓库（私有技能可见性的前提，见 EmployeeRecord） */
        hasGitAnchor: z.boolean().optional(),
        /** 岗位 id（Hub 侧岗位目录条目；缺省 = 通用） */
        position: z.string().max(64).optional(),
        skills: z.array(z.string().max(128)).max(512),
        status: z.enum(['ok', 'missing-dir']),
        createdAtMs: z.number().int().nonnegative(),
      }),
    )
    .max(512),
})

/**
 * 终端节点上报自身与承载的员工目录。
 *
 * 语义是**全量替换该节点的员工集合**：节点是权威来源，Hub 只做聚合与缓存。
 * 这样节点上删掉一个员工目录，Hub 下次上报就会自然收敛，不会留下幽灵条目。
 */
const nodeRegister: Handler = async (hub, conn, params) => {
  const input = parse(nodeRegisterSchema, params, 'node.register')
  if (conn.role !== 'node' || conn.nodeId === undefined) {
    throw protocolError('forbidden', 'node.register is only for node-role connections')
  }
  const state = hub.state()
  const now = Date.now()

  const node: NodeRecord = {
    nodeId: conn.nodeId,
    name: input.name,
    platform: input.platform,
    employeeRoot: input.employeeRoot,
    online: true,
    connectedAtMs: state.nodes[conn.nodeId]?.connectedAtMs ?? now,
    lastSeenAtMs: now,
    ...(input.dshVersion === undefined ? {} : { dshVersion: input.dshVersion }),
    ...(input.codeVersion === undefined ? {} : { codeVersion: input.codeVersion }),
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    ...(input.dshPort === undefined ? {} : { dshPort: input.dshPort }),
  }
  state.nodes[conn.nodeId] = node

  // 代码分叉必须"响"一声：节点是手动升级的，跑着旧代码的节点与正常节点在界面上
  // 长得一模一样（照常在线、照常列员工），只是能力缺失或行为不同 —— 这种沉默正是
  // 之前踩过的坑。这里把它变成启动日志里的一行明确告警。
  const hubCode = currentCodeFingerprint()
  if (input.codeVersion === undefined) {
    /* 别把"没上报"直接断言成"它跑的是旧代码"：对方也可能只是**算不出**指纹
       （交付里没有 src/ 的打包形态），甚至 Hub 自己也算不出来。如实给出两种可能
       与下一步 —— 这个特性存在的意义就是消灭"沉默 / 误判的分叉"，
       在日志里制造一个新的误判就本末倒置了。 */
    hub.log(
      `note: node "${input.name}" did not report a code fingerprint — ` +
        '要么它跑的是不报版本的旧代码（升级并重启该节点），要么它算不出指纹（交付里没有 src/）。' +
        `Hub 自己的指纹：${hubCode ?? '也算不出来'}`,
    )
  } else if (hubCode !== undefined && input.codeVersion !== hubCode) {
    hub.log(
      `warning: node "${input.name}" runs different code (node=${input.codeVersion} hub=${hubCode}) ` +
        '—— 两侧升级并**重启**落后的一方；差异见控制台「体检」',
    )
  }

  // 全量替换该节点的员工
  let removed = 0
  for (const [id, employee] of Object.entries(state.employees)) {
    if (employee.nodeId === conn.nodeId) {
      delete state.employees[id]
      removed += 1
    }
  }

  // 冲突检测：员工 id 全局唯一。若别的节点也声明了同一个 id，说明工作区被复制过，
  // 这必须让人看见 —— 静默覆盖会让"哪个才是真的"变得无法回答。
  const conflicts: string[] = []
  for (const incoming of input.employees) {
    const owner = state.employees[incoming.id]
    if (owner !== undefined && owner.nodeId !== conn.nodeId) {
      conflicts.push(incoming.id)
      continue
    }
    state.employees[incoming.id] = {
      id: incoming.id,
      nodeId: conn.nodeId,
      name: incoming.name,
      role: incoming.role,
      workspacePath: incoming.workspacePath,
      skills: incoming.skills,
      status: incoming.status,
      createdAtMs: incoming.createdAtMs,
      updatedAtMs: now,
      ...(incoming.workspaceId === undefined ? {} : { workspaceId: incoming.workspaceId }),
      ...(incoming.agentPreset === undefined ? {} : { agentPreset: incoming.agentPreset }),
      ...(incoming.group === undefined ? {} : { group: incoming.group }),
      ...(incoming.intro === undefined ? {} : { intro: incoming.intro }),
      ...(incoming.hasAvatar === undefined ? {} : { hasAvatar: incoming.hasAvatar }),
      ...(incoming.avatarUpdatedAtMs === undefined
        ? {}
        : { avatarUpdatedAtMs: incoming.avatarUpdatedAtMs, avatarBytes: incoming.avatarBytes ?? 0 }),
      ...(incoming.llmActiveName === undefined ? {} : { llmActiveName: incoming.llmActiveName }),
      ...(incoming.llmEndpointIds === undefined ? {} : { llmEndpointIds: incoming.llmEndpointIds }),
      ...(incoming.hasGitAnchor === undefined ? {} : { hasGitAnchor: incoming.hasGitAnchor }),
      ...(incoming.position === undefined ? {} : { position: incoming.position }),
    }
  }

  await hub.store.saveNodes()
  await hub.store.saveEmployees()

  hub.broadcastToScope('employee.read', 'employee.changed', {
    nodeId: conn.nodeId,
    added: input.employees.length,
    removed,
  })

  if (conflicts.length > 0) {
    hub.log(
      `warning: node "${input.name}" declared employee ids already owned by another node: ${conflicts.join(', ')}`,
    )
  }

  return {
    nodeId: conn.nodeId,
    registeredEmployees: input.employees.length - conflicts.length,
    removedStale: removed,
    ...(conflicts.length === 0 ? {} : { conflictedEmployeeIds: conflicts }),
  }
}

const nodeList: Handler = async (hub) => {
  const state = hub.state()
  const online = new Set<string>()
  for (const c of hub.connections) {
    if (c.phase === 'ready' && c.role === 'node' && c.nodeId !== undefined) online.add(c.nodeId)
  }
  const employees = Object.values(state.employees)
  /**
   * 代码指纹比对放在服务端算，不交给每个消费方各写一遍 ——
   * "什么算不一致"是一条契约，只该有一个定义。`unknown` 表示有一侧没上报
   * （老节点，或 Hub 自己算不出指纹），**不假装一致**。
   */
  const hubCodeVersion = currentCodeFingerprint()
  const codeStatusOf = (node: { codeVersion?: string }): 'match' | 'mismatch' | 'unknown' => {
    if (node.codeVersion === undefined || hubCodeVersion === undefined) return 'unknown'
    return node.codeVersion === hubCodeVersion ? 'match' : 'mismatch'
  }
  return {
    hubCodeVersion: hubCodeVersion ?? null,
    /** Hub 自己实际加载的入口形态（dist = 编译产物）。与节点同样的字段，方便对照 */
    hubRuntime: runtimeEntry(),
    nodes: Object.values(state.nodes).map((node) => ({
      ...node,
      online: online.has(node.nodeId),
      employeeCount: employees.filter((e) => e.nodeId === node.nodeId).length,
      codeStatus: codeStatusOf(node),
      /* 待发队列长度：节点离线期间存下的指令数（体检里显示，0 时不必关心） */
      queued: mailboxItemsFor(state, node.nodeId).length,
    })),
  }
}

const nodeDescribe: Handler = async (hub, _conn, params) => {
  const input = parse(z.object({ nodeId: nodeIdSchema }), params, 'node.describe')
  const state = hub.state()
  const node = state.nodes[input.nodeId]
  if (node === undefined) throw protocolError('not-found', `unknown node "${input.nodeId}"`)
  const online = hub.nodeConnection(input.nodeId) !== undefined
  return {
    ...node,
    online,
    employees: Object.values(state.employees).filter((e) => e.nodeId === input.nodeId),
  }
}

/* ── 员工 ── */

const employeeList: Handler = async (hub) => {
  const state = hub.state()
  const online = new Set<string>()
  for (const c of hub.connections) {
    if (c.phase === 'ready' && c.role === 'node' && c.nodeId !== undefined) online.add(c.nodeId)
  }
  const nodes = state.nodes
  return {
    employees: Object.values(state.employees)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .map((employee) => ({
        ...employee,
        nodeName: nodes[employee.nodeId]?.name ?? employee.nodeId,
        nodeOnline: online.has(employee.nodeId),
        available: online.has(employee.nodeId) && employee.status === 'ok',
        /* 审批自动放行：界面上要一眼看得出谁开着（这是"刹车被解开"的事实） */
        autoApprove: state.autoApprove[employee.id] !== undefined,
      })),
  }
}

const employeeGet: Handler = async (hub, _conn, params) => {
  const input = parse(employeeRef, params, 'employee.get')
  const state = hub.state()
  const employee = requireEmployee(hub, input.employeeId)
  const online = hub.nodeConnection(employee.nodeId) !== undefined
  return {
    ...employee,
    nodeName: state.nodes[employee.nodeId]?.name ?? employee.nodeId,
    nodeOnline: online,
    available: online && employee.status === 'ok',
  }
}

/* ── 会话订阅（Hub 本地维护订阅关系，事件由节点推送）── */

const sessionSubscribe: Handler = async (hub, conn, params) => {
  const input = parse(
    z.object({ employeeId: employeeIdSchema, sessionId: sessionIdSchema }),
    params,
    'session.subscribe',
  )
  requireEmployee(hub, input.employeeId)
  conn.subscriptions.add(input.sessionId)
  // 让节点开始把该会话的事件推给 Hub
  await hub
    .requestToNode(requireEmployee(hub, input.employeeId).nodeId, 'session.watch', {
      employeeId: input.employeeId,
      sessionId: input.sessionId,
      watch: true,
    })
    .catch(() => undefined)
  return { subscribed: true, sessionId: input.sessionId }
}

const sessionUnsubscribe: Handler = async (hub, conn, params) => {
  const input = parse(
    z.object({ employeeId: employeeIdSchema, sessionId: sessionIdSchema }),
    params,
    'session.unsubscribe',
  )
  conn.subscriptions.delete(input.sessionId)
  return { subscribed: false, sessionId: input.sessionId }
}

/**
 * 节点上报会话事件。
 *
 * 只做"鉴权 + 转发"：Hub 不解析、不存储事件内容（会话日志的权威副本在 dsh 自己那里），
 * 因此这里没有任何持久化动作 —— 这也让 Hub 的磁盘占用与员工输出量无关。
 */
const sessionPush: Handler = async (hub, conn, params) => {
  if (conn.nodeId === undefined) {
    throw protocolError('forbidden', 'session.push is only for node-role connections')
  }
  const input = parse(
    z.object({
      sessionId: sessionIdSchema,
      /** 该事件属于哪个员工 —— 控制端据此校验自己是否真的有权看 */
      employeeId: employeeIdSchema.optional(),
      event: z.unknown(),
    }),
    params,
    'session.push',
  )

  // 归属校验：节点只能推自己名下员工的事件，防止一个被攻陷的节点伪造别人的会话输出
  if (input.employeeId !== undefined) {
    const employee = hub.state().employees[input.employeeId]
    if (employee !== undefined && employee.nodeId !== conn.nodeId) {
      throw protocolError(
        'forbidden',
        `node may not push events for employee "${input.employeeId}" owned by another node`,
      )
    }
  }

  hub.broadcastSessionEvent(input.sessionId, {
    employeeId: input.employeeId,
    event: input.event,
  })
  return { forwarded: true }
}

/* ── 转发类方法 ── */

/** 生成把参数转交给员工所属节点的方法。 */
/**
 * 按 `employeeId` 转发到员工所在节点的通用转发器。
 *
 * `limits` 用来放宽个别字段的长度上限。**默认 256 字符不是一个随意的数字**：
 * 这些字段是 id / 路径 / 标题这类标识，给它们一个显式上限能让"把一坨二进制
 * 塞进 id 字段"这类误用当场被拒。但 HTTP 上传这类方法天然要带 MB 级字符串，
 * 于是必须显式说明 —— 这就是 `limits` 存在的理由。
 *
 * 教训（本仓库实测）：`employee.files.upload` 最初直接套用默认上限，结果
 * **任何超过 192 字节的文件都发不出去**，而且报的是含糊的 "invalid params"。
 * 是 test/employee-upload.test.ts 里那条"满上限 2MB 经真 Hub 往返"的用例抓出来的 ——
 * 小文件一切正常、大文件在真实网络里才失败，正是这类缺陷的典型形状。
 */
function forwarder(
  method: string,
  required: readonly string[],
  limits: Record<string, number> = {},
): Handler {
  return async (hub, _conn, params) => {
    const input = parse(
      z
        .object(
          Object.fromEntries(
            required.map((key) => [key, z.string().min(1).max(limits[key] ?? 256)]),
          ),
        )
        .passthrough(),
      params,
      method,
    ) as Record<string, string> & Record<string, unknown>
    const employeeId = input['employeeId']
    if (employeeId === undefined) throw protocolError('bad-request', 'employeeId is required')
    return await forwardToEmployeeNode(hub, employeeId, method, input)
  }
}

/**
 * 单次上传的 base64 长度上限。
 *
 * 与节点侧 `UPLOAD_MAX_BYTES`（2 MiB）对齐：2 MiB 原文的 base64 是约 2.80 M 字符
 * （4/3 膨胀 + 无填充），留 64 KiB 余量。**它必须小于协议单帧上限**（`MAX_FRAME_BYTES`
 * = 4 MiB），否则超限的文件会先被帧校验掐线，报出与"文件太大"无关的错误。
 */
const UPLOAD_BASE64_MAX_CHARS = Math.ceil((2 * 1024 * 1024 * 4) / 3) + 64 * 1024

/**
 * `employee.create` 不能按 employeeId 转发 —— 员工此刻还不存在。
 * 它按调用方指定的 `nodeId` 落到某台终端上，由那台终端建工作区。
 */
const employeeCreate: Handler = async (hub, _conn, params) => {
  const input = parse(
    z
      .object({
        nodeId: nodeIdSchema,
        name: z.string().min(1).max(128),
        role: z.string().max(2000).optional(),
        slug: z.string().max(64).optional(),
        agentPreset: z.string().max(64).optional(),
        group: z.string().max(64).optional(),
        /** 岗位 id（Hub 侧目录条目）；缺省 = 通用 */
        position: z.string().max(64).optional(),
      })
      .passthrough(),
    params,
    'employee.create',
  )
  return await forwardToNode(hub, input.nodeId, 'employee.create', input)
}

const employeeRemove: Handler = async (hub, _conn, params) => {
  const input = parse(
    z.object({ employeeId: employeeIdSchema, deleteFiles: z.boolean().optional() }).passthrough(),
    params,
    'employee.remove',
  )
  const employee = requireEmployee(hub, input.employeeId)
  const result = await forwardToEmployeeNode(hub, employee.id, 'employee.remove', input)
  const state = hub.state()
  const now = Date.now()

  for (const [jobId, job] of Object.entries(state.jobs)) {
    if (job.employeeId !== employee.id) continue
    delete state.jobs[jobId]
    for (const [runId, run] of Object.entries(state.scheduleRuns)) {
      if (run.jobId === jobId) delete state.scheduleRuns[runId]
    }
  }
  delete state.autoApprove[employee.id]
  state.acl = state.acl.filter((rule) => rule.from !== employee.id && rule.to !== employee.id)

  for (const record of Object.values(state.invokes)) {
    if (record.fromEmployeeId !== employee.id && record.toEmployeeId !== employee.id) continue
    if (record.status === 'pending-approval' || record.status === 'queued' || record.status === 'running') {
      record.status = 'failed'
      record.error = '员工已注销'
      record.finishedAtMs = now
    }
  }
  for (const approval of Object.values(state.approvals)) {
    const related =
      approval.kind === 'employee.invoke'
        ? approval.fromEmployeeId === employee.id || approval.toEmployeeId === employee.id
        : approval.employeeId === employee.id
    if (related && approval.status === 'pending') {
      approval.status = 'cancelled'
      approval.resolvedAtMs = now
      approval.resolutionNote = '员工已注销'
    }
  }

  for (const [mailId, item] of Object.entries(state.mailbox)) {
    const itemParams = item.params as Record<string, unknown>
    if (itemParams['employeeId'] === employee.id || itemParams['toEmployeeId'] === employee.id || itemParams['fromEmployeeId'] === employee.id) {
      delete state.mailbox[mailId]
    }
  }
  for (const order of Object.values(state.officePrefs.employeeOrder)) {
    const index = order.indexOf(employee.id)
    if (index >= 0) order.splice(index, 1)
  }

  await Promise.all([
    hub.store.saveJobs(),
    hub.store.saveScheduleRuns(),
    hub.store.saveAutoApprove(),
    hub.store.saveAcl(),
    hub.store.saveInvokes(),
    hub.store.saveApprovals(),
    hub.store.saveMailbox(),
    hub.store.saveOfficePrefs(),
  ])
  hub.broadcastToScope('employee.read', 'employee.changed', { removed: employee.id })
  return result
}

/* ── 授权 ── */

const aclGet: Handler = async (hub) => ({ rules: hub.state().acl })

const aclSet: Handler = async (hub, conn, params) => {
  const input = parse(
    z.object({
      from: z.string().min(1).max(128),
      to: z.string().min(1).max(128),
      effect: aclEffectSchema,
      note: z.string().max(500).optional(),
    }),
    params,
    'acl.set',
  )
  const rule = upsertAclRule(hub.state().acl, {
    from: input.from,
    to: input.to,
    effect: input.effect as AclEffect,
    createdBy: conn.deviceId,
    ...(input.note === undefined ? {} : { note: input.note }),
  })
  await hub.store.saveAcl()
  return { rule }
}

/**
 * 删掉一条 ACL 规则。
 *
 * 为什么补这个：规则以前**只能加不能删**（只有 acl.get / acl.set）—— 写错一条
 * 就再也清不掉，只能再写一条同样具体的 deny 压住它，台账里永远留着那条错的。
 * 实测踩过：为验证互调写了一条 allow，验完只能改文件 + 重启 Hub 才恢复原状。
 */
const aclRemove: Handler = async (hub, _conn, params) => {
  const input = parse(z.object({ ruleId: z.string().min(1).max(128) }), params, 'acl.remove')
  const removed = removeAclRule(hub.state().acl, input.ruleId)
  if (removed !== true) throw protocolError('not-found', `unknown acl rule "${input.ruleId}"`)
  await hub.store.saveAcl()
  return { removed: true, ruleId: input.ruleId, remaining: hub.state().acl.length }
}

/* ────────────────────────────── 定时任务 ────────────────────────────── */

/** 控制台需要的形状：任务 + 它的最近执行记录。 */
function jobView(hub: Hub, job: ScheduleJob): Record<string, unknown> {
  const employee = hub.state().employees[job.employeeId]
  return {
    ...job,
    employeeName: employee?.name ?? '',
    nodeOnline: employee === undefined ? false : hub.state().nodes[employee.nodeId]?.online === true,
    runs: runsFor(hub.state(), job.jobId, 5),
  }
}

const jobList: Handler = async (hub) => {
  const jobs = Object.values(hub.state().jobs)
    .map((job) => jobView(hub, job))
    .sort((a, b) => Number(a['nextRunAtMs'] ?? 0) - Number(b['nextRunAtMs'] ?? 0))
  return {
    jobs,
    limits: {
      minIntervalMs: MIN_INTERVAL_MS,
      maxIntervalMs: MAX_INTERVAL_MS,
      maxRunsPerJob: MAX_RUNS_PER_JOB,
    },
  }
}

const jobUpsert: Handler = async (hub, conn, params) => {
  const input = parse(
    z.object({
      /** 不给 = 新建；给了且存在 = 修改 */
      jobId: z.string().min(1).max(128).optional(),
      name: z.string().min(1).max(120),
      employeeId: employeeIdSchema,
      prompt: z.string().min(1).max(20_000),
      intervalMs: z.number().int().positive().max(MAX_INTERVAL_MS).optional(),
      /** 用分钟表达也可以（控制台表单更自然） */
      intervalMinutes: z.number().positive().max(MAX_INTERVAL_MS / 60_000).optional(),
      sessionId: sessionIdSchema.optional(),
      enabled: z.boolean().optional(),
      /** 立刻重排下一次时间（改间隔后想从此刻重新计时） */
      restartSchedule: z.boolean().optional(),
    }),
    params,
    'job.upsert',
  )

  /* 员工必须存在：一条指向不存在员工的任务，只会在每次到点时失败，
     而失败原因离配置动作太远（用户配的时候看不出问题）。 */
  const employee = requireEmployee(hub, input.employeeId)

  const state = hub.state()
  const now = Date.now()
  const intervalMs = normalizeInterval(
    input.intervalMinutes !== undefined
      ? Math.round(input.intervalMinutes * 60_000)
      : (input.intervalMs ?? 30 * 60_000),
  )

  const existing = input.jobId === undefined ? undefined : state.jobs[input.jobId]
  if (input.jobId !== undefined && existing === undefined) {
    throw protocolError('not-found', `unknown job "${input.jobId}"`)
  }

  if (existing === undefined) {
    /* 新建：下一次时间 = 现在 + 间隔（而不是"立刻跑一次" —— 用户点的是"定时"，
       不是"现在就跑"，想现在跑有 job.runNow）。 */
    const job: ScheduleJob = {
      jobId: newId('job'),
      name: input.name,
      employeeId: employee.id,
      prompt: input.prompt,
      intervalMs,
      enabled: input.enabled !== false,
      nextRunAtMs: now + intervalMs,
      consecutiveFailures: 0,
      createdAtMs: now,
      updatedAtMs: now,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(conn.deviceId === undefined ? {} : { createdBy: conn.deviceId }),
    }
    state.jobs[job.jobId] = job
    await hub.store.saveJobs()
    hub.broadcastToScope('employee.read', 'job.changed', { jobId: job.jobId, created: true })
    hub.log(`job created ${job.jobId} (${job.name}) every ${Math.round(intervalMs / 60_000)}m → ${employee.name}`)
    return { job: jobView(hub, job) }
  }

  existing.name = input.name
  existing.employeeId = employee.id
  existing.prompt = input.prompt
  const intervalChanged = existing.intervalMs !== intervalMs
  existing.intervalMs = intervalMs
  if (input.sessionId !== undefined) existing.sessionId = input.sessionId
  /* "从此刻起重新计时"：把基准设成 now（advanceNextRun 会把第一个点排在 now+interval）。 */
  const restartFromNow = (): number => now + intervalMs

  if (input.enabled !== undefined) {
    existing.enabled = input.enabled
    /* 重新启用时把时间推回未来，并清掉"自动停用"的旧原因 —— 否则一开启就被
       几十个过期时间点砸中（那正是"跳过错过的时间点"要避免的）。 */
    if (input.enabled === true) {
      existing.nextRunAtMs = restartFromNow()
      delete existing.disabledReason
      existing.consecutiveFailures = 0
    } else {
      existing.disabledReason = '用户手动停用'
    }
  }
  if (input.restartSchedule === true) existing.nextRunAtMs = restartFromNow()
  else if (intervalChanged && existing.nextRunAtMs <= now) existing.nextRunAtMs = restartFromNow()
  existing.updatedAtMs = now
  rollForwardMissed(state, now)
  await hub.store.saveJobs()
  hub.broadcastToScope('employee.read', 'job.changed', { jobId: existing.jobId, updated: true })
  return { job: jobView(hub, existing) }
}

const jobRemove: Handler = async (hub, _conn, params) => {
  const input = parse(z.object({ jobId: z.string().min(1).max(128) }), params, 'job.remove')
  const state = hub.state()
  if (state.jobs[input.jobId] === undefined) {
    throw protocolError('not-found', `unknown job "${input.jobId}"`)
  }
  delete state.jobs[input.jobId]
  for (const run of Object.values(state.scheduleRuns)) {
    if (run.jobId === input.jobId) delete state.scheduleRuns[run.runId]
  }
  await hub.store.saveJobs()
  await hub.store.saveScheduleRuns()
  hub.broadcastToScope('employee.read', 'job.changed', { jobId: input.jobId, removed: true })
  return { removed: true, jobId: input.jobId, remaining: Object.keys(state.jobs).length }
}

const jobRunNow: Handler = async (hub, _conn, params) => {
  const input = parse(z.object({ jobId: z.string().min(1).max(128) }), params, 'job.runNow')
  const job = hub.state().jobs[input.jobId]
  if (job === undefined) throw protocolError('not-found', `unknown job "${input.jobId}"`)
  /* 手动跑一轮**不动时间表**：否则"点一下试试"会把节奏整体推后，用户以为改了间隔。 */
  const run = await runJob(hub, job, { advanceSchedule: false })
  return { run, job: jobView(hub, job) }
}

/**
 * 员工活动汇总：给"秘书"这类角色一份**元数据**视图（谁/何时/干了什么/成或败）。
 *
 * 不含对话正文 —— 要看正文得另外调 session.history，那是另一个决定。
 * 谁有权限：`employee.read`（能看目录的人本来就能看这些记录）。
 */
const employeeActivity: Handler = async (hub, _conn, params) => {
  const input = parse(
    z.object({
      windowHours: z.number().positive().max(ACTIVITY_MAX_WINDOW_MS / 3_600_000).optional(),
      employeeIds: z.array(employeeIdSchema).max(200).optional(),
      maxItems: z.number().int().positive().max(50).optional(),
    }),
    params,
    'employee.activity',
  )
  const report = await collectActivity(hub, {
    ...(input.windowHours === undefined ? {} : { windowMs: Math.round(input.windowHours * 3_600_000) }),
    ...(input.employeeIds === undefined ? {} : { employeeIds: input.employeeIds }),
    ...(input.maxItems === undefined ? {} : { maxItems: input.maxItems }),
  })
  return { ...report, defaultWindowMs: ACTIVITY_DEFAULT_WINDOW_MS }
}

const employeeInvokeSettle: Handler = async (hub, conn, params) => {
  if (conn.nodeId === undefined) throw protocolError('forbidden', 'employee.invoke.settle is node-only')
  const input = parse(
    z.object({
      invokeId: z.string().min(1).max(128),
      status: z.enum(['running', 'completed', 'failed']),
      sessionId: z.string().min(1).max(256).optional(),
      resultText: z.string().max(200_000).optional(),
      error: z.string().max(4_000).optional(),
    }),
    params,
    'employee.invoke.settle',
  )
  const state = hub.state()
  const record = state.invokes[input.invokeId]
  if (record === undefined) return { settled: false, reason: 'unknown-invoke' }
  const target = state.employees[record.toEmployeeId]
  if (target === undefined || target.nodeId !== conn.nodeId) {
    throw protocolError('forbidden', 'node may only settle invokes for its own employees')
  }
  if (record.status === 'completed' || record.status === 'failed' || record.status === 'denied') {
    return { settled: false, status: record.status }
  }
  record.status = input.status
  if (input.sessionId !== undefined) record.resultSessionId = input.sessionId
  if (input.resultText !== undefined) record.resultText = input.resultText
  if (input.error !== undefined) record.error = input.error
  if (input.status !== 'running') record.finishedAtMs = Date.now()
  await hub.store.saveInvokes()
  hub.broadcastToScope('employee.read', 'invoke.settled', {
    invokeId: record.invokeId,
    fromEmployeeId: record.fromEmployeeId,
    toEmployeeId: record.toEmployeeId,
    status: record.status,
    ...(record.resultText === undefined ? {} : { resultText: record.resultText }),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.resultSessionId === undefined ? {} : { sessionId: record.resultSessionId }),
  })
  return { settled: true, status: record.status }
}

/* ────────────────────────────── 配对窗口 ────────────────────────────── */

const pairingWindowGet: Handler = async (hub) => {
  const config = hub.state().config
  const until = config.pairingWindowUntilMs
  const open = hub.pairingWindowOpen()
  return {
    open,
    /** `untilMs` 缺省 + open = 一直开着（等有人手动关） */
    ...(open && typeof until === 'number'
      ? { untilMs: until, remainingSec: Math.round((until - Date.now()) / 1000) }
      : {}),
    /* 已配对设备数：0 台时窗口开着是**正常的第一步**（还没有任何设备能来关它），
       界面要能把这件事说清楚，而不是让人以为"我怎么没关过它却开着"。 */
    pairedCount: Object.keys(hub.state().paired).length,
    /** 本机（Hub 所在机器）之外的访问是否还能拿到页面 —— 控制台据此显示当前暴露面 */
    mode: config.pairingMode === 'closed' ? 'closed' : 'open',
    /** 进门方式：设备页据此决定给不给"批准"按钮（与 device.list 同一份判断） */
    approval: pairingApprovalMode(config),
  }
}

/**
 * 开/关「允许新设备注册」。
 *
 * 关着时，**没有本机设备凭据的** HTTP 访问会拿到 404（与 nginx 逐字节一致）——
 * 公网上就不存在一个常驻的、未认证可访问的注册入口（审计的结论是：唯一的屏障只是
 * 那个 6 位码 + 限流，这不够）。
 *
 * ⚠️ 两个不该踩的坑：
 *   1. 带上 `minutes` 才有倒计时（到点自动关）；不带 = 一直开着。**默认给倒计时**，
 *      因为"忘了关"是这类开关最常见的失败方式。
 *   2. 关掉之后，**已配对的浏览器靠 cookie 照常进**（配对时 `POST /session` 换来的）——
 *      没有它，"关闭注册"就等于把自己也关在门外（见 server.ts 的闸门）。
 *
 * ⚠️ 只影响未认证 HTTP 访问：Hub 本机的 `dse pair-code` / `dse pair approve`
 * 不依赖窗口；运行中的 `dse pairing open/close` 通过受限本机 IPC 更新同一份 Hub 内存状态。
 * Hub 停止时 CLI 不直接改配置文件，必须先启动 Hub 再操作。
 */
const pairingWindowSet: Handler = async (hub, conn, params) => {
  const input = parse(
    z.object({
      open: z.boolean(),
      /** 开多久（分钟，默认 15、上限 120） */
      minutes: z.number().int().positive().max(120).optional(),
    }),
    params,
    'pairing.window.set',
  )
  const result = await hub.setPairingWindow(
    input.open
      ? { ...(input.minutes === undefined ? {} : { openMinutes: input.minutes }) }
      : { close: true },
  )
  hub.log(
    input.open
      ? `pairing window opened${result.untilMs === undefined ? ' (no expiry)' : ` until ${new Date(result.untilMs).toISOString()}`} (by ${conn.deviceId.slice(0, 12)}…)`
      : `pairing window closed (by ${conn.deviceId.slice(0, 12)}…)`,
  )
  hub.broadcastToScope('device.pair', 'pair.requested', { windowOpen: result.open, untilMs: result.untilMs ?? null })
  return {
    open: result.open,
    ...(result.untilMs === undefined
      ? {}
      : { untilMs: result.untilMs, remainingSec: Math.round((result.untilMs - Date.now()) / 1000) }),
    pairedCount: Object.keys(hub.state().paired).length,
    mode: result.open ? 'open' : 'closed',
    approval: pairingApprovalMode(hub.state().config),
  }
}

/* ────────────────────────────── 新设备进门方式 ────────────────────────────── */

const pairingApprovalGet: Handler = async (hub) => {
  const config = hub.state().config
  const approval = pairingApprovalMode(config)
  return {
    approval,
    /** 与 `device.list` 同一份判断，界面据此决定要不要给"批准"按钮 */
    operatorApprovalAllowed: operatorApprovalAllowed(config),
    windowOpen: hub.pairingWindowOpen(),
    note:
      approval === 'code-only'
        ? '只认配对码：新设备要在「允许新设备注册」窗口开着时用配对码加入'
        : '也允许人工批准：待配对请求可以在设备页直接批准',
  }
}

/**
 * 改「新设备进门方式」。与注册窗口是两个独立开关（见 store.ts 的字段注释）：
 * 窗口管门开不开，这里管进门要给什么。
 *
 * ⚠️ 切到 `code-only` **不会**关闭已经打开的窗口，也不会清掉已有的待配对请求 ——
 * 它只是让那些请求不能再被人工批准（只能被配对码兑换，或在到期时自动清理）。
 * 想立刻清场就一并关窗。
 */
const pairingApprovalSet: Handler = async (hub, conn, params) => {
  const input = parse(
    z.object({ approval: z.enum(['code-only', 'operator']) }),
    params,
    'pairing.approval.set',
  )
  const applied = await hub.setPairingApproval(input.approval)
  hub.log(`device approval mode → ${applied} (by ${conn.deviceId.slice(0, 12)}…)`)
  hub.broadcastToScope('device.pair', 'pairing.approval.changed', { approval: applied })
  const config = hub.state().config
  return {
    approval: applied,
    operatorApprovalAllowed: operatorApprovalAllowed(config),
    windowOpen: hub.pairingWindowOpen(),
    note:
      applied === 'code-only'
        ? '只认配对码：新设备要在「允许新设备注册」窗口开着时用配对码加入'
        : '也允许人工批准：待配对请求可以在设备页直接批准',
  }
}

/* ────────────────────────────── 手机通知（Web Push）────────────────────────────── */

/** 给浏览器 VAPID 公钥 —— 它订阅时要用（私钥永不出 Hub）。 */
const pushKey: Handler = async (hub) => {
  const keys = await hub.vapidKeys()
  if (keys === undefined) throw protocolError('internal', 'Hub 还没准备好推送密钥')
  return { publicKey: keys.publicKey }
}

const pushSubscribe: Handler = async (hub, conn, params) => {
  const input = parse(
    z.object({
      endpoint: z.string().url().max(2048),
      keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) }),
    }),
    params,
    'push.subscribe',
  )
  const state = hub.state()
  upsertSubscription(state, {
    endpoint: input.endpoint,
    keys: input.keys,
    createdAtMs: Date.now(),
    ...(conn.deviceId === '' ? {} : { deviceId: conn.deviceId }),
  })
  await hub.store.savePushSubscriptions()
  hub.log(`push: subscription registered (${Object.keys(state.pushSubscriptions).length} total)`)
  return { subscribed: true, total: Object.keys(state.pushSubscriptions).length }
}

const pushUnsubscribe: Handler = async (hub, _conn, params) => {
  const input = parse(z.object({ endpoint: z.string().min(1).max(2048) }), params, 'push.unsubscribe')
  const state = hub.state()
  const existed = state.pushSubscriptions[input.endpoint] !== undefined
  delete state.pushSubscriptions[input.endpoint]
  await hub.store.savePushSubscriptions()
  return { removed: existed, total: Object.keys(state.pushSubscriptions).length }
}

/**
 * 发一条通知。**正文必须短** —— 它会经浏览器厂商的推送服务（Apple/Google）转发，
 * 而且手机上只显示一行；把汇报正文塞进来既没必要也不合适。
 */
const pushNotify: Handler = async (hub, _conn, params) => {
  const input = parse(
    z.object({
      title: z.string().min(1).max(120),
      body: z.string().max(PUSH_MAX_PAYLOAD_BYTES).optional(),
      /** 同一 tag 的通知会互相替换（避免"同一条消息刷出一屏") */
      tag: z.string().max(64).optional(),
    }),
    params,
    'push.notify',
  )
  if (Object.keys(hub.state().pushSubscriptions).length === 0) {
    /* 没有订阅不是错误，但要如实说 —— 否则调用方以为"发出去了"（用户手机其实什么都没收到） */
    return { sent: 0, dropped: 0, failed: 0, note: '这台机器还没有任何设备订阅手机通知' }
  }
  const result = await sendToAll(hub, {
    title: input.title,
    body: input.body ?? '',
    ...(input.tag === undefined ? {} : { tag: input.tag }),
  })
  return result
}

/* ────────────────────────────── 节点自升级 ────────────────────────────── */

/**
 * 让某个节点升级到指定提交。
 *
 * 三个设计要点：
 *   1. **空闲闸门**：目标节点上只要还有员工的回合在跑，就**拒绝**（不是排队）。
 *      实测过代价：回合进行中重启节点会损坏 dsh 的会话日志，那条会话再也发不进指令。
 *      判据是各员工会话的 `running` 标志（问节点要，节点自己最清楚）。
 *   2. **`to` 默认取"Hub 自己是从哪个提交部署的"**：Hub 知道自己这份代码的指纹，
 *      但指纹不是 git 引用 —— 所以部署时把提交写进 `<state>/deployed-commit.txt`，
 *      升级按钮据此把节点升到**与 Hub 同一个版本**（那才是"版本一致"的意思）。
 *   3. 节点只负责把版本准备好并以退出码 75 主动重启；**Hub 不碰节点的进程**。
 */
const nodeUpdate: Handler = async (hub, conn, params) => {
  const input = parse(
    z.object({
      nodeId: nodeIdSchema,
      /** 不给就用 Hub 的部署提交 */
      to: z.string().min(1).max(128).optional(),
      /** 明知有回合在跑也要升级（默认 false） */
      force: z.boolean().optional(),
    }),
    params,
    'node.update',
  )

  const state = hub.state()
  const node = state.nodes[input.nodeId]
  if (node === undefined) throw protocolError('not-found', `unknown node "${input.nodeId}"`)
  if (node.online !== true) throw protocolError('node-offline', `节点「${node.name}」当前离线，等它上线再升级`)

  let to = input.to ?? ''
  if (to === '') {
    to = await hub.readDeployedCommit()
    if (to === '') {
      throw protocolError(
        'bad-request',
        'Hub 不知道自己是哪个提交部署的（缺 deployed-commit.txt），请在请求里显式给 to',
      )
    }
  }

  /* 空闲闸门：问节点"你这边有回合在跑吗"。节点离线/不回答 ⇒ 拒绝（宁可让人再点一次）。 */
  if (input.force !== true) {
    const busy = await busyEmployeesOnNode(hub, node.nodeId).catch(() => null)
    if (busy === null) {
      throw protocolError('node-offline', `拿不到「${node.name}」的会话状态（节点可能刚掉线），稍后再试`)
    }
    if (busy.length > 0) {
      throw protocolError(
        'bad-request',
        `「${node.name}」上还有 ${busy.length} 个回合在跑（${busy.slice(0, 3).join('、')}` +
          `${busy.length > 3 ? ' 等' : ''}）—— 回合进行中重启会损坏会话日志，等它们结束再升级`,
      )
    }
  }

  node.update = {
    to,
    status: 'requested',
    requestedAtMs: Date.now(),
    ...(conn.deviceId === '' ? {} : { requestedBy: conn.deviceId }),
  }
  await hub.store.saveNodes()
  hub.log(`node.update requested: ${node.name} → ${to} (by ${conn.deviceId.slice(0, 12)}…)`)

  /* 给足时间：要 fetch + 导出 + 可能 npm ci（几分钟很正常）。 */
  const res = await hub.requestToNode(node.nodeId, 'node.update', { to }, 12 * 60_000)
  if (res.ok !== true) {
    const raw = res.error?.message ?? '节点没有回应'
    /* 节点太旧（它的代码里根本没有这个方法）是**引导问题**，不是故障：
       一台机器要先具备"能被升级"的能力，之后才谈得上按钮升级。把这句话翻译成
       一句可执行的指示 —— 原始的 "does not implement method" 对用户毫无用处。 */
    const tooOld = /does not implement method/i.test(raw)
    const error = tooOld
      ? `「${node.name}」的代码太旧，里面还没有升级能力：需要先在那台机器上手动更新一次` +
        `（git pull 后重启节点/计划任务），之后这颗按钮就能用了 —— 这是唯一一次手工，之后一直是按钮驱动`
      : `${res.error?.code ?? 'internal'}: ${raw}`
    node.update = {
      ...node.update,
      status: 'failed',
      finishedAtMs: Date.now(),
      error,
    }
    await hub.store.saveNodes()
    throw protocolError(tooOld ? 'bad-request' : (res.error?.code ?? 'internal'), error)
  }

  const payload = (res.payload ?? {}) as { ok?: boolean; fingerprint?: string; error?: string }
  if (payload.ok !== true) {
    node.update = {
      ...node.update,
      status: 'failed',
      finishedAtMs: Date.now(),
      ...(payload.error === undefined ? {} : { error: payload.error }),
    }
    await hub.store.saveNodes()
    throw protocolError('internal', payload.error ?? '节点侧升级失败')
  }

  node.update = {
    ...node.update,
    status: 'prepared',
    finishedAtMs: Date.now(),
    ...(payload.fingerprint === undefined ? {} : { fingerprint: payload.fingerprint }),
  }
  await hub.store.saveNodes()
  hub.broadcastToScope('employee.read', 'node.changed', { nodeId: node.nodeId, updating: true })
  return {
    nodeId: node.nodeId,
    to,
    status: 'prepared',
    fingerprint: payload.fingerprint,
    note: '节点已把新版本准备好，正在重启（会离线几十秒）；它回来后代码版本即与目标一致',
  }
}

/** 某节点上"正在跑回合"的员工名（问节点要会话状态；离线或报错由调用方决定怎么处理）。 */
async function busyEmployeesOnNode(hub: Hub, nodeId: string): Promise<string[]> {
  const state = hub.state()
  const employees = Object.values(state.employees).filter((employee) => employee.nodeId === nodeId)
  const busy: string[] = []
  for (const employee of employees) {
    const res = await hub.requestToNode(nodeId, 'session.list', { employeeId: employee.id }, 10_000)
    if (res.ok !== true) throw new Error(res.error?.message ?? 'session.list failed')
    const sessions = (res.payload as { sessions?: unknown } | undefined)?.sessions
    if (!Array.isArray(sessions)) continue
    const running = sessions.some(
      (item) => item !== null && typeof item === 'object' && (item as { running?: unknown }).running === true,
    )
    if (running) busy.push(employee.name)
  }
  return busy
}

/* ── 定时任务（员工给自己排的那几个）────────────────────────────────
 *
 * 与 job.* 的区别只有一条：**目标员工从绑定身份派生**，不接受请求里自报的 id。
 * 员工（秘书、总控）因此能自己挂"每天 9 点汇报"，而不需要管理员权限。
 */

/** 只列自己的任务。 */
const jobSelfList: Handler = async (hub, conn) => {
  const resolved = resolveSelfJobEmployee({
    deviceId: conn.deviceId,
    role: conn.role,
    ...(conn.boundEmployeeId === undefined ? {} : { boundEmployeeId: conn.boundEmployeeId }),
  })
  if (resolved.ok !== true) throw protocolError(resolved.code, resolved.message)
  const jobs = Object.values(hub.state().jobs)
    .filter((job) => job.employeeId === resolved.employeeId)
    .map((job) => jobView(hub, job))
    .sort((a, b) => Number(a['nextRunAtMs'] ?? 0) - Number(b['nextRunAtMs'] ?? 0))
  return { jobs, limit: SELF_JOB_LIMIT }
}

const jobSelfUpsert: Handler = async (hub, conn, params) => {
  const input = parse(
    z.object({
      jobId: z.string().min(1).max(128).optional(),
      name: z.string().min(1).max(120),
      prompt: z.string().min(1).max(20_000),
      intervalMinutes: z.number().positive().max(MAX_INTERVAL_MS / 60_000).optional(),
      intervalMs: z.number().int().positive().max(MAX_INTERVAL_MS).optional(),
      enabled: z.boolean().optional(),
      /** 若给出，必须与绑定身份一致（不一致会被拒绝，而不是被改写） */
      employeeId: employeeIdSchema.optional(),
    }),
    params,
    'job.self.upsert',
  )
  const resolved = resolveSelfJobEmployee(
    {
      deviceId: conn.deviceId,
      role: conn.role,
      ...(conn.boundEmployeeId === undefined ? {} : { boundEmployeeId: conn.boundEmployeeId }),
    },
    { ...(input.employeeId === undefined ? {} : { employeeId: input.employeeId }) },
  )
  if (resolved.ok !== true) throw protocolError(resolved.code, resolved.message)

  const state = hub.state()
  const now = Date.now()
  const intervalMs = normalizeInterval(
    input.intervalMinutes !== undefined
      ? Math.round(input.intervalMinutes * 60_000)
      : (input.intervalMs ?? 24 * 60 * 60_000),
  )
  const existing = input.jobId === undefined ? undefined : state.jobs[input.jobId]
  if (input.jobId !== undefined && existing === undefined) {
    throw protocolError('not-found', `unknown job "${input.jobId}"`)
  }
  /* 只能改自己的：别人的任务既看不到也不该动得了 */
  if (existing !== undefined && existing.employeeId !== resolved.employeeId) {
    throw protocolError('forbidden', '这条任务不属于你，改不了（job.self 只管家门口的事）')
  }
  if (existing === undefined) {
    const mine = Object.values(state.jobs).filter((job) => job.employeeId === resolved.employeeId)
    if (mine.length >= SELF_JOB_LIMIT) {
      throw protocolError(
        'bad-request',
        `自己最多能排 ${SELF_JOB_LIMIT} 条任务（现在有 ${mine.length} 条）—— 先删掉不用的，或请管理员帮忙`,
      )
    }
    const job: ScheduleJob = {
      jobId: newId('job'),
      name: input.name,
      employeeId: resolved.employeeId,
      prompt: input.prompt,
      intervalMs,
      enabled: input.enabled !== false,
      nextRunAtMs: now + intervalMs,
      consecutiveFailures: 0,
      createdAtMs: now,
      updatedAtMs: now,
      createdBy: `employee-device:${conn.deviceId.slice(0, 12)}`,
    }
    state.jobs[job.jobId] = job
    await hub.store.saveJobs()
    hub.broadcastToScope('employee.read', 'job.changed', { jobId: job.jobId, created: true })
    hub.log(`self-job created ${job.jobId} (${job.name}) by ${resolved.employeeId} every ${Math.round(intervalMs / 60_000)}m`)
    return { job: jobView(hub, job) }
  }

  existing.name = input.name
  existing.prompt = input.prompt
  const intervalChanged = existing.intervalMs !== intervalMs
  existing.intervalMs = intervalMs
  if (input.enabled !== undefined) {
    existing.enabled = input.enabled
    if (input.enabled === true) {
      existing.nextRunAtMs = now + intervalMs
      delete existing.disabledReason
      existing.consecutiveFailures = 0
    } else {
      existing.disabledReason = '自己停用'
    }
  } else if (intervalChanged && existing.nextRunAtMs <= now) {
    existing.nextRunAtMs = now + intervalMs
  }
  existing.updatedAtMs = now
  rollForwardMissed(state, now)
  await hub.store.saveJobs()
  hub.broadcastToScope('employee.read', 'job.changed', { jobId: existing.jobId, updated: true })
  return { job: jobView(hub, existing) }
}

const jobSelfRemove: Handler = async (hub, conn, params) => {
  const input = parse(z.object({ jobId: z.string().min(1).max(128) }), params, 'job.self.remove')
  const resolved = resolveSelfJobEmployee({
    deviceId: conn.deviceId,
    role: conn.role,
    ...(conn.boundEmployeeId === undefined ? {} : { boundEmployeeId: conn.boundEmployeeId }),
  })
  if (resolved.ok !== true) throw protocolError(resolved.code, resolved.message)
  const state = hub.state()
  const job = state.jobs[input.jobId]
  if (job === undefined) throw protocolError('not-found', `unknown job "${input.jobId}"`)
  if (job.employeeId !== resolved.employeeId) {
    throw protocolError('forbidden', '这条任务不属于你，删不了')
  }
  delete state.jobs[job.jobId]
  for (const run of Object.values(state.scheduleRuns)) {
    if (run.jobId === job.jobId) delete state.scheduleRuns[run.runId]
  }
  await hub.store.saveJobs()
  await hub.store.saveScheduleRuns()
  hub.broadcastToScope('employee.read', 'job.changed', { jobId: job.jobId, removed: true })
  return { removed: true, jobId: job.jobId }
}

/* ── 互调 ── */

const employeeInvokeList: Handler = async (hub, _conn, params) => {
  const input = parse(
    z.object({ limit: z.number().int().positive().max(200).optional() }).optional(),
    params,
    'employee.invoke.list',
  )
  const records = Object.values(hub.state().invokes).sort(
    (a, b) => b.createdAtMs - a.createdAtMs,
  )
  return { invocations: records.slice(0, input?.limit ?? 50) }
}

/* ── 审批 ── */

const approvalList: Handler = async (hub) => ({
  approvals: Object.values(hub.state().approvals).sort((a, b) => b.requestedAtMs - a.requestedAtMs),
})

/**
 * 裁决一个审批请求 —— 按 `kind` 分派到各自的执行路径。
 *
 * 两条路径的"裁决即执行"是同一个原则：
 *   - `employee.invoke`：批准时**在这里**才真正发起跨机调用，不存在"批准了但没人去执行"；
 *   - `dsh.approval`：批准时把 `allowed-once` 回填给 dsh，卡住的那一轮当场继续。
 */
const approvalResolve: Handler = async (hub, conn, params) => {
  const input = parse(
    z.object({
      approvalId: z.string().min(1),
      approve: z.boolean(),
      note: z.string().max(500).optional(),
    }),
    params,
    'approval.resolve',
  )
  const state = hub.state()
  const approval = state.approvals[input.approvalId]
  if (approval === undefined) throw protocolError('not-found', `unknown approval "${input.approvalId}"`)
  if (approval.status !== 'pending') {
    throw protocolError('bad-request', `approval ${input.approvalId} is already ${approval.status}`)
  }

  // 提问不是二值裁决：走 dsh.question.answer，别让人用"批准/拒绝"去答一个问题
  if (approval.kind === 'dsh.question') {
    throw protocolError(
      'bad-request',
      `approval "${input.approvalId}" is a question; use dsh.question.answer with the chosen answer`,
    )
  }

  approval.status = input.approve ? 'approved' : 'denied'
  approval.resolvedAtMs = Date.now()
  approval.resolvedBy = conn.deviceId
  if (input.note !== undefined) approval.resolutionNote = input.note
  await hub.store.saveApprovals()

  hub.broadcastToScope('employee.read', 'approval.resolved', {
    approvalId: approval.approvalId,
    status: approval.status,
    resolvedBy: conn.deviceId,
  })

  /* ── dsh 自身的审批：把裁决回填给 dsh（这才是真正解除阻塞的那一步）── */
  if (approval.kind === 'dsh.approval') {
    const outcome = input.approve ? 'allowed-once' : 'rejected'
    const delivered = await deliverDshInteraction(hub, approval, {
      sessionId: approval.sessionId,
      approvalId: approval.dshApprovalId,
      outcome,
    })
    return {
      approvalId: approval.approvalId,
      status: approval.status,
      delivered: delivered.ok,
      // 交付失败要如实说：卡片已翻篇、但员工那一轮**仍在挂着**，
      // 报成成功会让人以为卡点已经解除
      ...(delivered.ok ? {} : { deliveryError: delivered.error }),
      note: delivered.ok
        ? '裁决已回填给 dsh，被阻塞的那一轮继续执行'
        : '裁决已记录，但回填失败——员工那一轮可能仍在等待',
    }
  }

  /* ── 员工互调 ── */
  if (!input.approve) {
    const record = state.invokes[approval.correlationId]
    if (record !== undefined) {
      record.status = 'denied'
      record.finishedAtMs = Date.now()
      record.error = `审批被拒绝${input.note === undefined ? '' : `：${input.note}`}`
      await hub.store.saveInvokes()
      hub.broadcastToScope('employee.read', 'invoke.settled', {
        invokeId: record.invokeId,
        status: record.status,
        error: record.error,
      })
    }
    return { approvalId: approval.approvalId, status: 'denied' }
  }

  // 批准后**立刻返回**，在后台真正执行。
  // 同步等待会让这个调用阻塞到目标员工跑完（可能几分钟），而客户端的调用超时只有 30 秒 ——
  // 结果是发起方看到超时报错、活却还在干。发起即返回，结果走 `invoke.settled` 事件。
  void dispatchInvoke(hub, approval.correlationId).catch((error: unknown) => {
    hub.log(
      `background invoke failed: ${describeError(error)}`,
    )
  })
  return {
    approvalId: approval.approvalId,
    status: 'approved',
    dispatch: 'started',
    note: '执行已在后台开始；用 employee.invoke.list 查看结果，或监听 invoke.settled 事件',
  }
}

/* ── dsh 交互（审批 / 提问）── */

/** 按 `kind` 收窄：审批中心里"需要回填给 dsh"的两类（区别于 `employee.invoke`）。 */
function isDshInteraction(item: ApprovalRecord): item is DshInteraction {
  return item.kind === 'dsh.approval' || item.kind === 'dsh.question'
}

/** 按 dsh 的 rpcId 找那条交互记录（rpcId 是 dsh 侧 pending 表的键，天然唯一）。 */
function findByRpcId(state: HubState, rpcId: string): DshInteraction | undefined {
  return Object.values(state.approvals).find(
    (item: ApprovalRecord): item is DshInteraction => isDshInteraction(item) && item.rpcId === rpcId,
  )
}

/**
 * 把一份裁决/答案投递给持有该交互的节点，由节点 `POST /api/respond` 回填给 dsh。
 *
 * 不排队、不重试：那条请求正在**阻塞一次真实的工具调用**，等几分钟后补投只会把
 * 一个早已中止的 rpcId 送过去。投递失败就地记账（卡片标 cancelled），不留假待办。
 */
async function deliverDshInteraction(
  hub: Hub,
  record: DshInteraction,
  value: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await forwardToNode(hub, record.nodeId, 'dsh.interaction.respond', {
      rpcId: record.rpcId,
      kind: record.kind,
      value,
    })
    return { ok: true }
  } catch (error) {
    const message = describeError(error)
    record.status = 'cancelled'
    record.resolvedAtMs = Date.now()
    record.resolutionNote = `回填 dsh 失败：${message}`
    await hub.store.saveApprovals()
    hub.broadcastToScope('employee.read', 'approval.resolved', {
      approvalId: record.approvalId,
      status: record.status,
    })
    hub.log(`dsh interaction ${record.approvalId} could not be delivered: ${message}`)
    return { ok: false, error: message }
  }
}

/**
 * 节点上报一个 dsh 发起的交互（审批 / 提问）。
 *
 * 幂等键是 dsh 的 `rpcId`：断线重连时 dsh 会把**未应答的**请求重放给新消费者
 * （apiproxy 的 pending 表在每次新 mux 接入时重发），所以同一 rpcId 会来多次 ——
 * 已存在就更新，绝不新建第二条，否则控制台上会堆出一串假待办。
 */
const dshInteractionRequest: Handler = async (hub, conn, params) => {
  if (conn.nodeId === undefined) {
    throw protocolError('forbidden', 'dsh.interaction.request is only for node-role connections')
  }
  const input = parse(
    z.object({
      kind: z.enum(['dsh.approval', 'dsh.question']),
      employeeId: employeeIdSchema.optional(),
      sessionId: sessionIdSchema,
      rpcId: z.string().min(1).max(256),
      toolName: z.string().max(200).optional(),
      callId: z.string().max(128).optional(),
      reason: z.string().max(2000).optional(),
      dshApprovalId: z.string().max(256).optional(),
      questions: z.array(z.unknown()).max(32).optional(),
    }),
    params,
    'dsh.interaction.request',
  )

  // 归属校验：节点只能上报自己名下员工的交互（与 session.push 同一道闸）
  if (input.employeeId !== undefined) {
    const employee = hub.state().employees[input.employeeId]
    if (employee !== undefined && employee.nodeId !== conn.nodeId) {
      throw protocolError(
        'forbidden',
        `node may not report interactions for employee "${input.employeeId}" owned by another node`,
      )
    }
  }

  const state = hub.state()
  // 同 rpcId 的记录就地更新（重放场景），不新建
  const existing = findByRpcId(state, input.rpcId)

  if (existing !== undefined) {
    // 已经被人裁决过、或 dsh 自己解决了：不复活，只回报现状
    if (existing.status !== 'pending') {
      return { approvalId: existing.approvalId, status: existing.status, created: false }
    }
    if (input.employeeId !== undefined) existing.employeeId = input.employeeId
    await hub.store.saveApprovals()
    return { approvalId: existing.approvalId, status: existing.status, created: false }
  }

  const now = Date.now()
  const approvalId = newId('apr')
  const base = {
    approvalId,
    status: 'pending' as const,
    requestedAtMs: now,
    employeeId: input.employeeId ?? '',
    nodeId: conn.nodeId,
    sessionId: input.sessionId,
    rpcId: input.rpcId,
  }
  const record: DshInteraction =
    input.kind === 'dsh.approval'
      ? {
          ...base,
          kind: 'dsh.approval',
          toolName: input.toolName ?? '(unknown)',
          dshApprovalId: input.dshApprovalId ?? '',
          ...(input.callId === undefined ? {} : { callId: input.callId }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        }
      : { ...base, kind: 'dsh.question', questions: input.questions ?? [] }

  state.approvals[approvalId] = record
  await hub.store.saveApprovals()
  const employeeName0 = state.employees[record.employeeId]?.name ?? record.employeeId.slice(0, 8)

  /* 这个员工开了"审批自动放行" ⇒ 立刻裁决，不等人。
     留痕：resolvedBy 写成 auto:<员工>，审批页照样看得到这条与它的结局 ——
     "自动"不等于"无记录"。dsh.question **不走这条路**（那是在问人问题，
     自动编个答案等于替人做决定）。 */
  if (record.kind === 'dsh.approval' && state.autoApprove[record.employeeId] !== undefined) {
    record.status = 'approved'
    record.resolvedAtMs = Date.now()
    record.resolvedBy = `auto:${record.employeeId}`
    record.resolutionNote = '该员工开了审批自动放行（Hub 侧策略，可随时关）'
    await hub.store.saveApprovals()
    const delivered = await deliverDshInteraction(hub, record, {
      sessionId: record.sessionId,
      approvalId: record.dshApprovalId,
      outcome: 'allowed-once',
    })
    hub.broadcastToScope('employee.read', 'approval.resolved', {
      approvalId,
      status: record.status,
      resolvedBy: record.resolvedBy,
    })
    void sendToAll(hub, {
      title: `${employeeName0} 的审批已自动放行`,
      body: `要执行 ${record.toolName}${delivered.ok ? '' : '（回填失败，可能仍卡着）'}`,
      tag: `approval-${approvalId}`,
    }).catch(() => undefined)
    hub.log(
      `dsh approval auto-approved: employee=${record.employeeId || '(unknown)'} tool=${record.toolName} delivered=${String(delivered.ok)}`,
    )
    return { approvalId, status: record.status, created: true, autoApproved: true, delivered: delivered.ok }
  }
  /* 也推一条手机通知：员工卡在审批上是"必须有人动手"的事，
     而用户不一定正开着控制台（真实事故：员工卡在 bash 上，谁都没发现）。 */
  const employeeName = state.employees[record.employeeId]?.name ?? record.employeeId.slice(0, 8)
  void sendToAll(hub, {
    title: record.kind === 'dsh.approval' ? `${employeeName} 在等你批准` : `${employeeName} 问了你一个问题`,
    body:
      record.kind === 'dsh.approval'
        ? `要执行 ${record.toolName}${record.reason === undefined ? '' : '：' + record.reason.slice(0, 50)}`
        : '打开控制台「审批」页回答',
    tag: `approval-${approvalId}`,
  }).catch(() => undefined)

  hub.broadcastToScope('employee.read', 'approval.requested', {
    approvalId,
    kind: record.kind,
    employeeId: record.employeeId,
    sessionId: record.sessionId,
    requestedAtMs: now,
    ...(record.kind === 'dsh.approval' ? { toolName: record.toolName } : {}),
  })
  hub.log(
    `dsh interaction pending: ${record.kind} employee=${record.employeeId || '(unknown)'} tool=${
      record.kind === 'dsh.approval' ? record.toolName : `${record.questions.length} question(s)`
    } rpcId=${input.rpcId}`,
  )
  return { approvalId, status: 'pending', created: true }
}

/**
 * 节点上报 dsh 侧已解决（用户直接在 dsh Web 里答了、或工具信号中止 → cancelled）。
 *
 * 以**节点上报的结局为准**：它拿得到 dsh 的权威 outcome，而 Hub 只知道自己的裁决。
 * 只在状态真的变化时才广播，避免与 `approval.resolve` 的广播重复刷屏。
 */
const dshInteractionSettle: Handler = async (hub, conn, params) => {
  if (conn.nodeId === undefined) {
    throw protocolError('forbidden', 'dsh.interaction.settle is only for node-role connections')
  }
  const input = parse(
    z.object({
      /**
       * 两个坐标二选一 —— 因为 dsh 的两类 resolved 帧带的键不同：
       *   `approval/resolved` 带的是 dsh 的 approvalId，
       *   `question/resolved` 带的是 questionRpcId（就是原请求帧的 rpcId）。
       */
      rpcId: z.string().min(1).max(256).optional(),
      dshApprovalId: z.string().min(1).max(256).optional(),
      outcome: z.enum(['allowed-once', 'rejected', 'cancelled', 'answered', 'unavailable']),
    }),
    params,
    'dsh.interaction.settle',
  )
  if (input.rpcId === undefined && input.dshApprovalId === undefined) {
    throw protocolError('bad-request', 'settle needs either rpcId or dshApprovalId')
  }

  const state = hub.state()
  const record =
    input.rpcId !== undefined
      ? findByRpcId(state, input.rpcId)
      : Object.values(state.approvals).find(
          (item): item is DshInteraction =>
            item.kind === 'dsh.approval' && item.dshApprovalId === input.dshApprovalId,
        )
  if (record === undefined) return { settled: false }
  if (record.nodeId !== conn.nodeId) {
    throw protocolError('forbidden', 'node may not settle another node\u2019s interaction')
  }
  if (record.status !== 'pending') return { approvalId: record.approvalId, status: record.status, settled: false }

  const status: ApprovalStatus =
    input.outcome === 'allowed-once'
      ? 'approved'
      : input.outcome === 'rejected'
        ? 'denied'
        : input.outcome === 'answered'
          ? 'answered'
          : 'cancelled'
  record.status = status
  record.resolvedAtMs = Date.now()
  if (record.resolutionNote === undefined) {
    record.resolutionNote =
      input.outcome === 'cancelled'
        ? 'dsh 侧已取消（无人应答或工具调用被中止）'
        : `dsh 侧已解决：${input.outcome}`
  }
  await hub.store.saveApprovals()
  hub.broadcastToScope('employee.read', 'approval.resolved', {
    approvalId: record.approvalId,
    status,
  })
  return { approvalId: record.approvalId, status, settled: true }
}

/** 回答一个提问：Hub 不解释 `answer` 的形状，原样回填给 dsh。 */
const dshQuestionAnswer: Handler = async (hub, conn, params) => {
  const input = parse(
    z.object({
      approvalId: z.string().min(1),
      answer: z.unknown(),
      note: z.string().max(500).optional(),
    }),
    params,
    'dsh.question.answer',
  )
  const state = hub.state()
  const record = state.approvals[input.approvalId]
  if (record === undefined) throw protocolError('not-found', `unknown approval "${input.approvalId}"`)
  if (record.kind !== 'dsh.question') {
    throw protocolError('bad-request', `approval "${input.approvalId}" is not a question`)
  }
  if (record.status !== 'pending') {
    throw protocolError('bad-request', `question ${input.approvalId} is already ${record.status}`)
  }

  const delivered = await deliverDshInteraction(hub, record, {
    sessionId: record.sessionId,
    answer: input.answer,
  })
  if (!delivered.ok) {
    return {
      approvalId: record.approvalId,
      status: record.status,
      delivered: false,
      deliveryError: delivered.error,
    }
  }
  /* 交付是异步的，而我们上面刚检查过 pending：这中间 dsh 自己的 `question/resolved`
     可能已经到了（人直接在 dsh Web 里答了、或那一轮被中止），节点会把它 settle 掉。
     那种情况下答案其实已经不再需要，但**不能**把它当成失败（回填确实送达了），
     也不要再广播一次 —— 重复的"已解决"通知会让控制台闪两下。 */
  if (record.status === 'pending') {
    record.status = 'answered'
    record.answer = input.answer
    record.resolvedAtMs = Date.now()
    record.resolvedBy = conn.deviceId
    if (input.note !== undefined) record.resolutionNote = input.note
    await hub.store.saveApprovals()
    hub.broadcastToScope('employee.read', 'approval.resolved', {
      approvalId: record.approvalId,
      status: 'answered',
      resolvedBy: conn.deviceId,
    })
  }
  return {
    approvalId: record.approvalId,
    status: record.status,
    delivered: true,
    ...(record.status === 'answered' ? {} : { note: `该提问已被 dsh 侧收尾为 ${record.status}，答案未再记录` }),
  }
}

/* ── 办公区显示偏好 ── */

/** 排序偏好的形状与上限：组数 ≤64、每组组员 ≤512、组名/员工 id 长度对齐目录校验。 */
const officeOrderSchema = z.object({
  groupOrder: z.array(z.string().max(64)).max(64),
  employeeOrder: z.record(z.string().max(64), z.array(z.string().max(128)).max(512)),
})


/* ────────────────────────── 岗位目录 ────────────────────────── */

/**
 * 岗位是**用户可增删的共享数据**，不是代码分支：
 *   · 员工身份里只存 id（见 EmployeeManifest.position），显示名只在这份目录里；
 *   · 目录存 Hub 侧，于是手机与电脑看到同一份下拉（与 office.order 同性质）；
 *   · 新增岗位 = 加一条数据（将来是"勾哪几个通用面板"），不是写一套新前端。
 */
const positionIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'position id must be lowercase letters/digits/dash/underscore')

const positionList: Handler = async (hub) => {
  const state = hub.state()
  return {
    positions: Object.values(state.positions).sort((a, b) => {
      // 内置「通用」永远排第一（它是缺省项），其余按创建时间
      if (a.builtin === true && b.builtin !== true) return -1
      if (b.builtin === true && a.builtin !== true) return 1
      return a.createdAtMs - b.createdAtMs
    }),
  }
}

const positionUpsert: Handler = async (hub, _conn, params) => {
  const input = parse(
    z.object({
      id: positionIdSchema.optional(),
      name: z.string().trim().min(1).max(32),
      panels: z.array(z.string().max(32)).max(16).optional(),
      /* 页面外壳 id（如 'secretary'）。空串 = 默认对话页 —— 显式给空串**能清掉**外壳，
         所以这里不写成 `|| existing.layout`，而是 `?? existing.layout`（区分"没给"与"给空"）。 */
      layout: z.string().trim().max(32).optional(),
      /* 四宫格（layout: 'quad'）的格位各放哪些面板 id。
         键名固定为 tl/bl/tr/top —— 多余键直接拒绝（写成 {left:…} 这种拼错的配置会静默为空）。 */
      cells: z
        .object({
          tl: z.array(z.string().max(32)).max(8).optional(),
          bl: z.array(z.string().max(32)).max(8).optional(),
          tr: z.array(z.string().max(32)).max(8).optional(),
          top: z.array(z.string().max(32)).max(8).optional(),
        })
        .strict()
        .optional(),
    }),
    params,
    'position.upsert',
  )
  const state = hub.state()
  const now = Date.now()

  // 没给 id = 新建（id 由服务端生成，避免中文名 slug 出一堆怪东西）；
  // 给了 id = 按 id 幂等新增或改名 —— 改名**不会**影响已绑定该岗位的员工。
  let id = input.id
  if (id === undefined) {
    id = `pos_${newId('x').slice(-6)}`
    while (state.positions[id] !== undefined) id = `pos_${newId('x').slice(-6)}`
  }

  const existing = state.positions[id]
  const entry: PositionEntry = {
    id,
    name: input.name,
    panels: input.panels ?? existing?.panels ?? [],
    ...(input.layout === undefined ? (existing?.layout === undefined ? {} : { layout: existing.layout }) : { layout: input.layout }),
    /* 与 layout 同规矩：没给 = 保持原样，给了就整块替换（`{tl: []}` 能清空格位）。 */
    ...(input.cells === undefined ? (existing?.cells === undefined ? {} : { cells: existing.cells }) : { cells: input.cells }),
    ...(existing?.builtin === true ? { builtin: true } : {}),
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
  }
  state.positions[id] = entry
  await hub.store.savePositions()
  hub.log(`position "${entry.name}" (${id}) ${existing === undefined ? 'created' : 'updated'}`)
  // 岗位变化会影响所有控制台的工位徽章与下拉：广播出去（按 employee.read 门控）
  hub.broadcastToScope('employee.read', 'employee.changed', { positions: true })
  return { position: entry }
}

/**
 * 删除岗位。**必须把还绑着它的员工改回「通用」**：员工身份里存的是 id，删掉条目后
 * 那个 id 就成了悬空引用 —— 读的一方（控制台）虽然容忍这种引用（会原样显示 id），
 * 但那是兜底而不是常态，常态应该是"删了就干净"。
 *
 * 员工 manifest 在**各节点**上，所以只能逐节点转发 employee.update；节点离线时如实
 * 报告哪几个人没解绑（不假装成功），由用户稍后手动改或等节点上线后重试。
 */
const positionRemove: Handler = async (hub, _conn, params) => {
  const input = parse(z.object({ id: positionIdSchema }), params, 'position.remove')
  const state = hub.state()
  const entry = state.positions[input.id]
  if (entry === undefined) throw protocolError('not-found', `unknown position "${input.id}"`)
  if (entry.builtin === true) {
    throw protocolError('bad-request', 'builtin position cannot be removed (it is the default)')
  }

  delete state.positions[input.id]
  await hub.store.savePositions()

  const bound = Object.values(state.employees).filter((e) => e.position === input.id)
  const unbound: string[] = []
  const failed: string[] = []
  for (const employee of bound) {
    const response = await hub.requestToNode(
      employee.nodeId,
      'employee.update',
      { employeeId: employee.id, position: null },
      // 解绑是"顺手做"的动作，不该让删岗位的请求卡 30 秒：给短一点的超时
      8_000,
    )
    if (response.ok === true) unbound.push(employee.id)
    else failed.push(employee.id)
  }

  hub.log(
    `position "${entry.name}" (${input.id}) removed; unbound ${unbound.length} employee(s)` +
      (failed.length === 0 ? '' : `, ${failed.length} 个员工所在节点离线/拒绝，未解绑`),
  )
  hub.broadcastToScope('employee.read', 'employee.changed', { positions: true })
  return {
    removed: entry,
    unbound,
    failed,
    ...(failed.length === 0
      ? {}
      : {
          note:
            '这些员工的岗位没能改回通用（节点离线或拒绝）：它们会继续指向已删除的条目，' +
            '界面会显示该 id 本身；把该节点上的员工岗位手动改成「通用」即可。',
        }),
  }
}

const officeOrderGet: Handler = async (hub) => ({
  groupOrder: [...hub.state().officePrefs.groupOrder],
  employeeOrder: { ...hub.state().officePrefs.employeeOrder },
})

const officeOrderSet: Handler = async (hub, _conn, params) => {
  const input = parse(officeOrderSchema, params, 'office.order.set')
  /* 全量替换语义。未知组名/员工 id **不报错**：目录会变（删人/删组是常态），
     偏好里留着的旧引用由读取方跳过，写入方不该为"引用了已删员工"报错。 */
  hub.state().officePrefs = { groupOrder: input.groupOrder, employeeOrder: input.employeeOrder }
  await hub.store.saveOfficePrefs()
  /* 广播给所有在线控制台：办公室是共享事实，一台设备调完序其它设备立即跟上 */
  hub.broadcastToScope('employee.read', 'office.order.changed', {})
  return { saved: true }
}

/* ────────────────────── 机器级权限档位 ──────────────────────
 *
 * **整机**生效（dsh 只有这一个写入口），所以界面必须把影响范围写清楚：
 * 它改的是这台机器上**所有员工新建会话**的默认档位，已有会话不受影响。
 * 按员工的"别老是问人"需求走 `employee.autoApprove.set`（Hub 侧策略，见下）。
 */
const nodePermissionGet: Handler = async (hub, _conn, params) => {
  const input = parse(z.object({ nodeId: z.string().min(1).max(200) }), params, 'node.permission.get')
  const response = await hub.requestToNode(input.nodeId, 'node.permission.get', {}, 15_000)
  if (response.ok !== true) {
    throw protocolError('bad-request', `读不到那台节点的档位：${describeError(response.error)}`)
  }
  return response.payload
}

const nodePermissionSet: Handler = async (hub, _conn, params) => {
  const input = parse(
    z.object({
      nodeId: z.string().min(1).max(200),
      preset: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
    }),
    params,
    'node.permission.set',
  )
  const response = await hub.requestToNode(
    input.nodeId,
    'node.permission.set',
    { preset: input.preset },
    15_000,
  )
  if (response.ok !== true) {
    throw protocolError('bad-request', `改不动那台节点的档位：${describeError(response.error)}`)
  }
  hub.log(`node ${input.nodeId.slice(0, 12)}… default preset → ${input.preset}（整机；只影响新建会话）`)
  return response.payload
}

/* ────────────────────── 员工级"审批自动放行" ──────────────────────
 *
 * 目的：让**某些**员工不必逐条等人批（用户要的"给某些员工开 full access"，
 * 而 dsh 这版没有暴露"按会话/按员工设权限档位"的接口，见 employeeLlmSave 附近的说明）。
 *
 * 这件事只能在我们这层做对：审批的**裁决**本来就在 Hub。
 * 边界写死在代码里，不靠自觉：**只放行 dsh.approval，不放行 dsh.question，也不动沙箱。**
 */
const employeeAutoApproveSet: Handler = async (hub, _conn, params) => {
  const input = parse(
    z.object({ employeeId: employeeIdSchema, enabled: z.boolean() }),
    params,
    'employee.autoApprove.set',
  )
  requireEmployee(hub, input.employeeId)
  const state = hub.state()
  if (input.enabled) state.autoApprove[input.employeeId] = Date.now()
  else delete state.autoApprove[input.employeeId]
  await hub.store.saveAutoApprove()
  hub.log(
    `employee ${input.employeeId.slice(0, 12)}… 审批自动放行 ${input.enabled ? '开启' : '关闭'}`,
  )
  hub.broadcastToScope('employee.read', 'employee.changed', { autoApprove: input.employeeId })
  return { employeeId: input.employeeId, autoApprove: input.enabled }
}

/* ────────────────────────────── LLM 端点库 ──────────────────────────────
 *
 * BaseURL + Key 输一次，多个员工复用；员工那边只记"别名 + 指向哪条 + 哪个模型"。
 *
 * 为什么库在 Hub：这是用户明确要的"真全局"（输一次、全员共用、改一处全场生效）。
 * 代价写在 LlmEndpointRecord 的注释里：**密钥在服务器上多一份静态副本**（0600），
 * 所以这里有一条硬规矩：**任何返回值都只带掩码**，key 只往下游（节点）传。
 */

/** 出 Hub 的端点视图：**永不回 key**。 */
function llmEndpointView(
  hub: Hub,
  entry: LlmEndpointRecord,
): {
  id: string
  name: string
  apiUrl: string
  hasKey: boolean
  keyMask?: string
  models: string[]
  usedBy: Array<{ employeeId: string; name: string }>
  createdAtMs: number
  updatedAtMs: number
} {
  return {
    id: entry.id,
    name: entry.name,
    apiUrl: entry.apiUrl,
    hasKey: entry.apiKey !== undefined && entry.apiKey !== '',
    ...(entry.apiKey === undefined || entry.apiKey === ''
      ? {}
      : { keyMask: maskApiKey(entry.apiKey) }),
    models: [...(entry.models ?? [])],
    ...(entry.proxy === undefined ? {} : { proxy: entry.proxy }),
    /* 谁在用：取自员工目录里那份"随注册上报的摘要"（见 EmployeeRecord.llmEndpointIds）。
       不维护 Hub 自己的索引 —— 那种索引迟早与节点上的事实漂移。 */
    usedBy: Object.values(hub.state().employees)
      .filter((employee) => (employee.llmEndpointIds ?? []).includes(entry.id))
      .map((employee) => ({ employeeId: employee.id, name: employee.name })),
    createdAtMs: entry.createdAtMs,
    updatedAtMs: entry.updatedAtMs,
  }
}

const LLM_ENDPOINT_NAME_MAX = 64

function normalizeEndpointName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name === '') throw protocolError('bad-request', '端点名不能为空（它是你在界面上认出这条的名字）')
  if (name.length > LLM_ENDPOINT_NAME_MAX) {
    throw protocolError('bad-request', `端点名最多 ${LLM_ENDPOINT_NAME_MAX} 字`)
  }
  return name
}

const llmEndpointList: Handler = async (hub) => ({
  endpoints: Object.values(hub.state().llmEndpoints)
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .map((entry) => llmEndpointView(hub, entry)),
})

/**
 * 新增/修改一条端点。**改了 apiUrl 或 Key 就顺手同步到所有用到它的员工**——
 * "改一处全场生效"如果只在库里生效、员工那边还是旧 key，那这个库就是骗人的。
 * 同步失败的员工逐个点名（节点离线是常态，不能假装成功）。
 */
const llmEndpointUpsert: Handler = async (hub, _conn, params) => {
  const input = parse(
    z.object({
      id: z.string().min(1).max(64).optional(),
      name: z.string().max(LLM_ENDPOINT_NAME_MAX),
      apiUrl: z.string().min(1).max(2048),
      /* 留空 = 不改动已保存的 key（界面上密码框留空的语义），与员工级保存一致 */
      apiKey: z.string().max(512).optional(),
      models: z.array(z.string().max(200)).max(500).optional(),
      /* 出口代理：有些域名只有走代理才通（默认 127.0.0.1:7892 是 Clash 的常见口）。
         null = 显式取消代理；缺省 = 不改动。 */
      proxy: z
        .object({ host: z.string().min(1).max(255), port: z.number().int().positive().max(65535) })
        .nullable()
        .optional(),
    }),
    params,
    'llm.endpoint.upsert',
  )
  assertLlmApiUrl(input.apiUrl)

  const state = hub.state()
  const now = Date.now()
  const existing = input.id === undefined ? undefined : state.llmEndpoints[input.id]
  if (input.id !== undefined && existing === undefined) {
    throw protocolError('not-found', `unknown endpoint "${input.id}"`)
  }
  const name = normalizeEndpointName(input.name)
  const clash = Object.values(state.llmEndpoints).find(
    (entry) => entry.name === name && entry.id !== input.id,
  )
  if (clash !== undefined) {
    throw protocolError('bad-request', `端点名「${name}」已被另一条用了（库里名字要唯一）`)
  }

  const apiKey =
    input.apiKey !== undefined && input.apiKey !== '' ? input.apiKey : existing?.apiKey
  const proxy =
    input.proxy === null
      ? undefined
      : input.proxy !== undefined
        ? { host: input.proxy.host.trim(), port: input.proxy.port }
        : existing?.proxy
  const entry: LlmEndpointRecord = {
    id: existing?.id ?? `ep_${newId('x').slice(-8)}`,
    name,
    apiUrl: input.apiUrl,
    ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }),
    ...(proxy === undefined ? {} : { proxy }),
    models: input.models ?? existing?.models ?? [],
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
  }
  state.llmEndpoints[entry.id] = entry
  await hub.store.saveLlmEndpoints()
  hub.log(`llm endpoint "${entry.name}" (${entry.id}) ${existing === undefined ? 'created' : 'updated'}`)

  /* 端点变了才同步：只改名字不必打扰每个节点 */
  const changed =
    existing !== undefined &&
    (existing.apiUrl !== entry.apiUrl ||
      existing.apiKey !== entry.apiKey ||
      JSON.stringify(existing.proxy ?? null) !== JSON.stringify(entry.proxy ?? null))
  const synced: Array<{ employeeId: string; name: string; ok: boolean; error?: string }> = []
  if (changed || existing === undefined) {
    const users = Object.values(state.employees).filter((employee) =>
      (employee.llmEndpointIds ?? []).includes(entry.id),
    )
    for (const employee of users) {
      const response = await hub.requestToNode(
        employee.nodeId,
        'employee.llm.endpoint.sync',
        {
          employeeId: employee.id,
          endpointId: entry.id,
          apiUrl: entry.apiUrl,
          ...(entry.apiKey === undefined ? {} : { apiKey: entry.apiKey }),
          proxy: entry.proxy ?? null,
        },
        15_000,
      )
      synced.push(
        response.ok === true
          ? { employeeId: employee.id, name: employee.name, ok: true }
          : {
              employeeId: employee.id,
              name: employee.name,
              ok: false,
              error: describeError(response.error),
            },
      )
    }
  }
  hub.broadcastToScope('employee.read', 'employee.changed', { llmEndpoints: true })
  return { endpoint: llmEndpointView(hub, entry), synced }
}

/**
 * 删一条端点。**还有员工在用就拒绝并点名** —— 删掉之后那些员工手上的
 * BaseURL/Key 就成了悬空引用，症状是"某个员工某天开始全部 502/401"，
 * 而看界面什么线索都没有。先改掉那些员工再删，是这里唯一诚实的做法。
 */
const llmEndpointRemove: Handler = async (hub, _conn, params) => {
  const input = parse(z.object({ id: z.string().min(1).max(64) }), params, 'llm.endpoint.remove')
  const state = hub.state()
  const entry = state.llmEndpoints[input.id]
  if (entry === undefined) throw protocolError('not-found', `unknown endpoint "${input.id}"`)
  const usedBy = llmEndpointView(hub, entry).usedBy
  if (usedBy.length > 0) {
    throw protocolError(
      'bad-request',
      `还有 ${usedBy.length} 个员工在用「${entry.name}」：${usedBy.map((item) => item.name).join('、')} —— 先把他们的模型改成别的端点或删掉，再删这条`,
      { usedBy },
    )
  }
  delete state.llmEndpoints[input.id]
  await hub.store.saveLlmEndpoints()
  hub.log(`llm endpoint "${entry.name}" (${entry.id}) removed`)
  hub.broadcastToScope('employee.read', 'employee.changed', { llmEndpoints: true })
  return { removed: entry.id }
}

/**
 * 试拉某个端点的模型列表。**从节点发**（Hub 自己未必有出网权限，
 * 而且"这个端点在节点上能不能连通"才是真正要验的事）。
 * 不带 key 时用库里存的那把 —— 于是"改完 key 想验一下"不必重新粘一遍密钥。
 */
const llmEndpointProbe: Handler = async (hub, _conn, params) => {
  const input = parse(
    z.object({
      id: z.string().min(1).max(64).optional(),
      apiUrl: z.string().min(1).max(2048).optional(),
      apiKey: z.string().max(512).optional(),
      proxy: z
        .object({ host: z.string().min(1).max(255), port: z.number().int().positive().max(65535) })
        .nullable()
        .optional(),
    }),
    params,
    'llm.endpoint.probe',
  )
  const saved = input.id === undefined ? undefined : hub.state().llmEndpoints[input.id]
  if (input.id !== undefined && saved === undefined) {
    throw protocolError('not-found', `unknown endpoint "${input.id}"`)
  }
  const apiUrl = input.apiUrl ?? saved?.apiUrl
  if (apiUrl === undefined) throw protocolError('bad-request', '要么给 id（用库里那条），要么给 apiUrl')
  const apiKey = input.apiKey !== undefined && input.apiKey !== '' ? input.apiKey : saved?.apiKey
  const proxy =
    input.proxy !== undefined
      ? input.proxy === null
        ? undefined
        : { host: input.proxy.host.trim(), port: input.proxy.port }
      : saved?.proxy

  /* 挑一台在线的节点来发这个请求：优先员工的分布最广的那台不必要，
     任何一台能连上外网的节点都行 —— 端点连通性与具体机器无关。 */
  const node = Object.values(hub.state().nodes).find((record) => record.online === true)
  if (node === undefined) throw protocolError('node-offline', '没有在线节点能替 Hub 发这个探测请求')
  const response = await hub.requestToNode(
    node.nodeId,
    'llm.probe',
    {
      apiUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
      proxy: proxy ?? null,
    },
    20_000,
  )
  if (response.ok !== true) {
    throw protocolError('bad-request', `探测失败（经节点「${node.name}」）：${describeError(response.error)}`)
  }
  const models = (response.payload as { models?: unknown }).models
  return {
    models: Array.isArray(models) ? models.filter((item): item is string => typeof item === 'string') : [],
    via: node.name,
  }
}

/**
 * 把员工手上那条"本地端点"（历史配置）收进端点库。
 *
 * 一次动作里做三件事：向节点取回该条的 apiUrl + key → 在库里建一条 →
 * 让节点把这条指向库里那条（**条目 id 与路由名都不变**，所以旧会话照旧能用）。
 * 失败要清楚：库里已有同名端点时，是"用人家的那条"还是"另起个名"由人决定 ——
 * 这里不做猜测，直接报错。
 */
const employeeLlmPromote: Handler = async (hub, _conn, params) => {
  const input = parse(
    z.object({
      employeeId: employeeIdSchema,
      id: z.string().min(1).max(64),
      endpointName: z.string().min(1).max(LLM_ENDPOINT_NAME_MAX),
      models: z.array(z.string().max(200)).max(500).optional(),
    }),
    params,
    'employee.llm.promote',
  )
  requireEmployee(hub, input.employeeId)
  const name = normalizeEndpointName(input.endpointName)
  const clash = Object.values(hub.state().llmEndpoints).find((entry) => entry.name === name)
  if (clash !== undefined) {
    throw protocolError('bad-request', `端点库里已经有叫「${name}」的一条了 —— 换个名字，或直接用那条`)
  }

  const pulled = await hub.requestToNode(
    requireEmployee(hub, input.employeeId).nodeId,
    'employee.llm.promote',
    { employeeId: input.employeeId, id: input.id, endpointName: name },
    15_000,
  )
  if (pulled.ok !== true) {
    throw protocolError('bad-request', `读取本地端点失败：${describeError(pulled.error)}`)
  }
  const payload = pulled.payload as { apiUrl?: unknown; apiKey?: unknown }
  if (typeof payload.apiUrl !== 'string') {
    throw protocolError('internal', '节点没有回 apiUrl，收进端点库中止（没有改动任何东西）')
  }

  const now = Date.now()
  const entry: LlmEndpointRecord = {
    id: `ep_${newId('x').slice(-8)}`,
    name,
    apiUrl: payload.apiUrl,
    ...(typeof payload.apiKey === 'string' && payload.apiKey !== '' ? { apiKey: payload.apiKey } : {}),
    models: input.models ?? [],
    createdAtMs: now,
    updatedAtMs: now,
  }
  hub.state().llmEndpoints[entry.id] = entry
  await hub.store.saveLlmEndpoints()

  const linked = await hub.requestToNode(
    requireEmployee(hub, input.employeeId).nodeId,
    'employee.llm.linkEndpoint',
    { employeeId: input.employeeId, id: input.id, endpointId: entry.id },
    15_000,
  )
  if (linked.ok !== true) {
    /* 库里那条已经建好了，只是这个员工还没指过去 —— 如实说，并给下一步 */
    hub.log(`warning: endpoint ${entry.id} created but employee ${input.employeeId} link failed`)
    return {
      endpoint: llmEndpointView(hub, entry),
      linked: false,
      note: `端点已收进库（「${name}」），但这个员工还没指过去：${describeError(linked.error)} —— 再点一次「收进端点库」即可`,
    }
  }
  hub.log(`llm endpoint "${name}" (${entry.id}) promoted from employee ${input.employeeId}`)
  hub.broadcastToScope('employee.read', 'employee.changed', { llmEndpoints: true })
  return { endpoint: llmEndpointView(hub, entry), linked: true, employee: linked.payload }
}

/**
 * 保存某个员工的一条模型：**Hub 先按 endpointId 把端点解析出来（含 key），
 * 再把 apiUrl+apiKey 一起下发给节点**。
 *
 * 为什么 key 由 Hub 下发而不是让控制台每次带着：控制台只该填一次库，
 * 之后无论多少员工、切多少次，密钥都不再经过浏览器。顺带一个好处 ——
 * 控制台里的请求体里不会出现 key，抓包与日志都干净。
 */
const employeeLlmSave: Handler = async (hub, _conn, params) => {
  const input = parse(
    z.object({
      employeeId: employeeIdSchema,
      id: z.string().min(1).max(64).optional(),
      name: z.string().max(128),
      endpointId: z.string().min(1).max(64),
      model: z.string().min(1).max(200),
      activate: z.boolean().optional(),
    }),
    params,
    'employee.llm.save',
  )
  const employee = requireEmployee(hub, input.employeeId)
  const endpoint = hub.state().llmEndpoints[input.endpointId]
  if (endpoint === undefined) throw protocolError('not-found', `unknown endpoint "${input.endpointId}"`)
  return await forwardToEmployeeNode(hub, input.employeeId, 'employee.llm.save', {
    employeeId: input.employeeId,
    ...(input.id === undefined ? {} : { id: input.id }),
    name: input.name,
    endpointId: endpoint.id,
    apiUrl: endpoint.apiUrl,
    ...(endpoint.apiKey === undefined ? {} : { apiKey: endpoint.apiKey }),
    proxy: endpoint.proxy ?? null,
    model: input.model,
    ...(input.activate === undefined ? {} : { activate: input.activate }),
    /* employee.nodeId 只为可读性留着：真正路由用输入里的 employeeId */
    nodeId: employee.nodeId,
  })
}

/* ────────────────────────────── 互调实现 ────────────────────────────── */

const invokeSchema = z.object({
  /* 绑定到员工的设备可以省略（用绑定的那个）；operator 必须给 —— 见 resolveInvokePrincipal */
  fromEmployeeId: employeeIdSchema.optional(),
  toEmployeeId: employeeIdSchema,
  task: z.string().min(1).max(20_000),
  correlationId: z.string().min(1).max(128).optional(),
  /** operator 代员工发起时的显式声明（绑定设备不需要，也不该带） */
  onBehalfOf: z.boolean().optional(),
})

const employeeInvoke: Handler = async (hub, conn, params) => {
  const input = parse(invokeSchema, params, 'employee.invoke')
  const state = hub.state()

  /* 发起人由**认证连接**派生，不信请求里的自报值。
     这条以前是直接读 input.fromEmployeeId 的：任何持 employee.invoke 的设备都能
     以任意员工名义发起（实测冒充成功过），员工拿到凭据后会变成"互相冒名派活"。 */
  const principal = resolveInvokePrincipal(
    {
      deviceId: conn.deviceId,
      role: conn.role,
      ...(conn.boundEmployeeId === undefined ? {} : { boundEmployeeId: conn.boundEmployeeId }),
      ...(conn.nodeId === undefined ? {} : { nodeId: conn.nodeId }),
    },
    {
      ...(input.fromEmployeeId === undefined ? {} : { fromEmployeeId: input.fromEmployeeId }),
      ...(input.onBehalfOf === undefined ? {} : { onBehalfOf: input.onBehalfOf }),
    },
  )
  if (principal.ok !== true) {
    throw protocolError(principal.code, principal.message)
  }

  const from = requireEmployee(hub, principal.fromEmployeeId)
  const to = requireEmployee(hub, input.toEmployeeId)

  /* 节点只能代表**自己机器上**的员工：节点身份是"某台机器"，不是"某个人"。
     （节点目前拿不到 employee.invoke scope，这里是纵深防御，不是主判据。） */
  if (conn.role === 'node' && from.nodeId !== conn.nodeId) {
    throw protocolError('forbidden', '节点只能代表自己本机上的员工发起调用')
  }

  if (from.id === to.id) {
    throw protocolError('bad-request', 'an employee cannot invoke itself')
  }

  const decision = evaluateAcl(state.acl, from.id, to.id)
  const invokeId = newId('inv')
  const correlationId = input.correlationId ?? invokeId
  const audit = {
    principal: principal.principal,
    ...(principal.delegatedByDeviceId === undefined
      ? {}
      : { delegatedByDeviceId: principal.delegatedByDeviceId }),
  }

  if (decision.effect === 'deny') {
    state.invokes[invokeId] = {
      invokeId,
      fromEmployeeId: from.id,
      toEmployeeId: to.id,
      ...audit,
      task: input.task,
      status: 'denied',
      createdAtMs: Date.now(),
      finishedAtMs: Date.now(),
      error: decision.reason,
    }
    await hub.store.saveInvokes()
    throw protocolError('forbidden', `授权拒绝：${decision.reason}`, { invokeId })
  }

  if (decision.effect === 'approve') {
    const approvalId = newId('appr')
    state.approvals[approvalId] = {
      approvalId,
      kind: 'employee.invoke',
      fromEmployeeId: from.id,
      toEmployeeId: to.id,
      task: input.task,
      status: 'pending',
      requestedAtMs: Date.now(),
      correlationId,
      ...(decision.matchedRuleId === undefined ? {} : { matchedRuleId: decision.matchedRuleId }),
    }
    state.invokes[invokeId] = {
      invokeId,
      fromEmployeeId: from.id,
      toEmployeeId: to.id,
      ...audit,
      task: input.task,
      status: 'pending-approval',
      approvalId,
      createdAtMs: Date.now(),
    }
    await hub.store.saveApprovals()
    await hub.store.saveInvokes()

    /* 顺手推手机：有人在等你批准 —— 这是最值得"推一下"的一类事件
       （用户不必一直刷控制台；推送失败不影响审批本身）。 */
    void sendToAll(hub, {
      title: '有人等你批准',
      body: `${from.name} 想调用 ${to.name}：${input.task.slice(0, 60)}`,
      tag: `approval-${approvalId}`,
    }).catch(() => undefined)

    hub.broadcastToScope('approval.resolve', 'approval.requested', {
      approvalId,
      kind: 'employee.invoke',
      fromEmployeeId: from.id,
      fromEmployeeName: from.name,
      toEmployeeId: to.id,
      toEmployeeName: to.name,
      task: input.task,
      reason: decision.reason,
      principal: principal.principal,
      requestedAtMs: Date.now(),
    })

    return {
      invokeId,
      status: 'pending-approval',
      approvalId,
      reason: decision.reason,
      note: '等待授权终端审批',
    }
  }

  // allow：同样**发起即返回**，后台执行（理由见 approvalResolve 处的说明）
  state.invokes[invokeId] = {
    invokeId,
    fromEmployeeId: from.id,
    toEmployeeId: to.id,
    ...audit,
    task: input.task,
    status: 'queued',
    createdAtMs: Date.now(),
  }
  await hub.store.saveInvokes()

  void dispatchInvoke(hub, correlationId, { invokeId, task: input.task, to, from }).catch(
    (error: unknown) => {
      hub.log(
        `background invoke failed: ${describeError(error)}`,
      )
    },
  )

  return {
    invokeId,
    status: 'queued',
    dispatch: 'started',
    note: '执行已在后台开始；用 employee.invoke.list 查看结果，或监听 invoke.settled 事件',
  }
}

/**
 * 真正把任务交给目标员工执行。
 *
 * 调用点一律**不等待**它（`void dispatchInvoke(...)`）：一次互调可能跑几分钟，
 * 而 RPC 超时只有 30 秒，同步等必然变成"调用方看到超时、活还在干"。
 * 结算结果通过 `invoke.settled` 事件广播，并持久化在 invoke 记录里可查。
 *
 * 目标节点离线时记 `queued` 而不是失败 —— 这正是"5 个员工分布在 2 台机器、
 * 其中一台偶尔关机"时必须的行为。
 */
async function dispatchInvoke(
  hub: Hub,
  correlationId: string,
  explicit?: {
    invokeId: string
    task: string
    to: EmployeeRecord
    from: EmployeeRecord
  },
): Promise<Record<string, unknown>> {
  const state = hub.state()
  const record =
    explicit === undefined
      ? Object.values(state.invokes).find((item) => item.invokeId === correlationId)
      : state.invokes[explicit.invokeId]

  if (record === undefined) {
    return { status: 'failed', error: `no invoke record for correlation "${correlationId}"` }
  }

  /** 统一的收尾：落盘 + 广播结算事件。所有终止分支都必须走它。 */
  const settle = async (
    status: InvokeRecord['status'],
    patch: { error?: string; resultSessionId?: string; resultText?: string } = {},
  ): Promise<Record<string, unknown>> => {
    record.status = status
    if (patch.error !== undefined) record.error = patch.error
    if (patch.resultSessionId !== undefined) record.resultSessionId = patch.resultSessionId
    if (patch.resultText !== undefined) record.resultText = patch.resultText
    if (status !== 'queued') record.finishedAtMs = Date.now()
    await hub.store.saveInvokes()

    hub.broadcastToScope('employee.read', 'invoke.settled', {
      invokeId: record.invokeId,
      fromEmployeeId: record.fromEmployeeId,
      toEmployeeId: record.toEmployeeId,
      status,
      ...(record.resultText === undefined ? {} : { resultText: record.resultText }),
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.resultSessionId === undefined
        ? {}
        : { sessionId: record.resultSessionId }),
    })

    return {
      status,
      invokeId: record.invokeId,
      ...(record.resultSessionId === undefined ? {} : { sessionId: record.resultSessionId }),
      ...(record.resultText === undefined ? {} : { resultText: record.resultText }),
      ...(record.error === undefined ? {} : { error: record.error }),
    }
  }

  const to = explicit?.to ?? state.employees[record.toEmployeeId]
  if (to === undefined) {
    return await settle('failed', { error: 'target employee no longer exists' })
  }

  /* 互调需要结果，但离线期间也不能把记录伪装成“已启动”。
     这里把完整调用参数落进持久邮箱；节点上线后由 mailbox flush 以 async 形态
     投递，节点立即确认接收，再通过 employee.invoke.settle 回传最终结果。 */
  if (hub.nodeConnection(to.nodeId) === undefined) {
    const alreadyQueued = mailboxItemsFor(state, to.nodeId).some(
      (item) => item.method === 'employee.invoke' && (item.params as Record<string, unknown>)['invokeId'] === record.invokeId,
    )
    if (!alreadyQueued) {
      await enqueueForNode(hub, to.nodeId, 'employee.invoke', {
        invokeId: record.invokeId,
        fromEmployeeId: record.fromEmployeeId,
        toEmployeeId: record.toEmployeeId,
        task: record.task,
      })
    }
    return await settle('queued', {})
  }

  record.status = 'running'
  await hub.store.saveInvokes()

  // 超时必须按**这个操作本身的耗时特征**给：被调员工要跑完一整轮任务，
  // 实测单轮 1.6~4 秒，但带工具调用的任务可以到几分钟。
  // 用默认的 30 秒必然把正常的长任务误判成失败。
  // 这里的 15 分钟与节点侧 `#waitForTurnOutcome` 的上限对齐。
  const res = await hub.requestToNode(
    to.nodeId,
    'employee.invoke',
    {
      invokeId: record.invokeId,
      fromEmployeeId: record.fromEmployeeId,
      toEmployeeId: record.toEmployeeId,
      task: record.task,
    },
    15 * 60_000,
  )

  if (!res.ok) {
    const offline = res.error?.code === 'node-offline'
    const timedOut = res.error?.code === 'timeout'
    // 发送瞬间掉线时补进持久邮箱；超时不能当离线 —— 节点在线，只是慢；如实报失败并说明"可能还在跑"，
    // 否则任务会永远停在 queued，而人以为它在等重连。
    if (offline) {
      const alreadyQueued = mailboxItemsFor(state, to.nodeId).some(
        (item) => item.method === 'employee.invoke' && (item.params as Record<string, unknown>)['invokeId'] === record.invokeId,
      )
      if (!alreadyQueued) {
        await enqueueForNode(hub, to.nodeId, 'employee.invoke', {
          invokeId: record.invokeId,
          fromEmployeeId: record.fromEmployeeId,
          toEmployeeId: record.toEmployeeId,
          task: record.task,
        })
      }
    }
    return await settle(offline ? 'queued' : 'failed', {
      error: timedOut
        ? `${res.error?.message ?? '超时'}；该任务**可能仍在目标员工那里执行**，` +
          `请用 employee.invoke.list 或目标员工的会话历史确认最终结果`
        : (res.error?.message ?? 'node call failed'),
    })
  }

  const payload = (res.payload ?? {}) as {
    sessionId?: string
    resultText?: string
    error?: string
  }

  // 被调员工的这一轮可能以错误结束（例如缺模型凭据）。必须如实上报成失败，
  // 否则调用方看到的是"跑完了但没结果"，无从排查。
  if (payload.error !== undefined) {
    return await settle('failed', {
      error: payload.error,
      ...(payload.sessionId === undefined ? {} : { resultSessionId: payload.sessionId }),
    })
  }

  return await settle('completed', {
    ...(payload.sessionId === undefined ? {} : { resultSessionId: payload.sessionId }),
    ...(payload.resultText === undefined ? {} : { resultText: payload.resultText }),
  })
}

/* ────────────────────────────── 导出 ────────────────────────────── */

export const hubHandlers: Partial<Record<string, Handler>> = {
  /* 系统 */
  health,
  whoami,

  /* 设备 */
  'device.list': deviceList,
  'device.pair.approve': devicePairApprove,
  'device.pair.reject': devicePairReject,
  'device.pair.remove': devicePairRemove,
  'device.rename': deviceRename,
  'device.pair.redeem': devicePairRedeem,
  'device.token.rotate': deviceTokenRotate,
  'device.token.revoke': deviceTokenRevoke,

  /* 节点 */
  'node.list': nodeList,
  'node.update': nodeUpdate,
  'node.describe': nodeDescribe,
  'node.register': nodeRegister,
  'node.paircode.offer': nodePaircodeOffer,

  /* 员工 */
  'employee.list': employeeList,
  'employee.get': employeeGet,
  'employee.create': employeeCreate,
  'employee.update': forwarder('employee.update', ['employeeId']),
  'employee.remove': employeeRemove,
  'employee.files.list': forwarder('employee.files.list', ['employeeId']),
  'employee.files.get': forwarder('employee.files.get', ['employeeId', 'path']),
  'employee.files.download': forwarder('employee.files.download', ['employeeId', 'path'], { path: 512 }),
  'employee.files.set': forwarder('employee.files.set', ['employeeId', 'path']),
  'employee.files.upload': forwarder('employee.files.upload', ['employeeId', 'path', 'dataBase64'], {
    path: 512,
    dataBase64: UPLOAD_BASE64_MAX_CHARS,
  }),
  'employee.skills.list': forwarder('employee.skills.list', ['employeeId']),
  'employee.llm.get': forwarder('employee.llm.get', ['employeeId']),
  'employee.llm.save': employeeLlmSave,
  'employee.llm.activate': forwarder('employee.llm.activate', ['employeeId']),
  'employee.llm.remove': forwarder('employee.llm.remove', ['employeeId']),
  'employee.llm.promote': employeeLlmPromote,
  'employee.llm.unset': forwarder('employee.llm.unset', ['employeeId']),
  'employee.llm.probe': forwarder('employee.llm.probe', ['employeeId']),
  /* 端点库（Hub 级）：BaseURL + Key 输一次、多员工复用 */
  'llm.endpoint.list': llmEndpointList,
  'llm.endpoint.upsert': llmEndpointUpsert,
  'llm.endpoint.remove': llmEndpointRemove,
  'llm.endpoint.probe': llmEndpointProbe,
  'employee.avatar.get': forwarder('employee.avatar.get', ['employeeId']),
  'employee.avatar.set': forwarder('employee.avatar.set', ['employeeId']),
  'employee.avatar.remove': forwarder('employee.avatar.remove', ['employeeId']),

  /* 会话 */
  'session.list': forwarder('session.list', ['employeeId']),
  'session.create': forwarder('session.create', ['employeeId']),
  'session.prompt': forwarder('session.prompt', ['employeeId', 'sessionId']),
  'session.cancel': forwarder('session.cancel', ['employeeId', 'sessionId']),
  'session.compact': forwarder('session.compact', ['employeeId', 'sessionId']),
  'session.rename': forwarder('session.rename', ['employeeId', 'sessionId', 'title']),
  'session.archive': forwarder('session.archive', ['employeeId', 'sessionId']),
  'session.history': forwarder('session.history', ['employeeId', 'sessionId']),
  'session.subscribe': sessionSubscribe,
  'session.unsubscribe': sessionUnsubscribe,
  'session.push': sessionPush,

  /* 互调 */
  'employee.activity': employeeActivity,
  'employee.invoke': employeeInvoke,
  'employee.invoke.list': employeeInvokeList,
  'employee.invoke.settle': employeeInvokeSettle,

  /* 授权 */
  'job.self.list': jobSelfList,
  'job.self.upsert': jobSelfUpsert,
  'job.self.remove': jobSelfRemove,
  'pairing.window': pairingWindowGet,
  'pairing.window.set': pairingWindowSet,
  'pairing.approval': pairingApprovalGet,
  'pairing.approval.set': pairingApprovalSet,
  'push.key': pushKey,
  'push.subscribe': pushSubscribe,
  'push.unsubscribe': pushUnsubscribe,
  'push.notify': pushNotify,
  'job.list': jobList,
  'job.upsert': jobUpsert,
  'job.remove': jobRemove,
  'job.runNow': jobRunNow,
  'acl.get': aclGet,
  'acl.set': aclSet,
  'acl.remove': aclRemove,

  /* 审批 */
  'approval.list': approvalList,
  'approval.resolve': approvalResolve,
  /* dsh 交互（节点上报的审批/提问 + 控制台的回答） */
  'node.permission.get': nodePermissionGet,
  'node.permission.set': nodePermissionSet,
  'employee.autoApprove.set': employeeAutoApproveSet,
  'dsh.interaction.request': dshInteractionRequest,
  'dsh.interaction.settle': dshInteractionSettle,
  'dsh.question.answer': dshQuestionAnswer,

  /* 办公区显示偏好 */
  'position.list': positionList,
  'position.upsert': positionUpsert,
  'position.remove': positionRemove,
  'office.order.get': officeOrderGet,
  'office.order.set': officeOrderSet,
}

/**
 * 供测试与文档使用的内部出口。
 * 只暴露纯函数与错误构造器，不暴露任何状态。
 */
export const __internals = {
  dispatchInvoke,
  evaluateAcl,
  removeAclRule,
  protocolError,
  isProtocolError,
}
