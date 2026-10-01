/**
 * 离线邮箱 —— 节点不在线时，把**不需要调用方等结果**的请求存下来，等节点回来按序送出。
 *
 * 为什么只排队这一种请求：判据是"调用方需不需要立刻拿到结果"。
 *   · `session.prompt`（员工的对话指令）：把消息交给员工就行，结果通过**实时流**回来
 *     （`session.event`）。节点离线时调用方也拿不到流，所以"先存起来、上线再送"语义完整 ✓
 *   · `employee.invoke`：离线时以异步委派形态入队；节点上线后先确认接收，再通过
 *     `employee.invoke.settle` 回报开始与最终结果。它不把最终结果伪装成 RPC 同步返回。
 *   · `session.create` / `session.cancel`：调用方**必须**拿到返回的 id 或结果才能继续，
 *     所以仍然走"立即失败"。
 *
 * 投递语义（诚实说明，不是 exactly-once）：
 *   · 投递成功 → 从队列删除（at-most-once 对已成功的这一条而言）；
 *   · 投递时节点又离线 → 保留，下次节点上线再试（这是主要路径）；
 *   · 投递出现**结果未知**（超时等）→ 记 attempts 且**不再无限重试**（到 3 次后跳过），
 *     因为"重试可能导致员工收到两条"。宁可留在队列里让体检显示出来，也不制造重复指令。
 *
 * 队列有界：每节点最多 50 条、最长留 24 小时。满了丢**最旧**的一条并如实告知调用方 ——
 * 用户刚发的那条通常才是要紧的，但"悄悄丢"不行。
 */

import { newId } from '../util/fsx.ts'
import type { Hub } from './server.ts'
import type { HubState } from './store.ts'
import type { MailboxItem } from './types.ts'

/** 只排队"结果不靠返回值"的方法。加新方法前先回答：调用方需要拿到它的返回值吗？ */
export const QUEUEABLE_METHODS: Readonly<Record<string, true>> = {
  'session.prompt': true,
  'employee.invoke': true,
}

/** 每个节点最多存多少条（超出丢最旧的，并如实上报）。 */
export const MAILBOX_MAX_PER_NODE = 50
/** 超过这个年龄的条目在入队/投递时被清掉（避免陈旧指令在几天后突然被送出去）。 */
export const MAILBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** 非"节点离线"类失败重试几次后放弃重试（继续重试可能让员工收到重复指令）。 */
export const MAILBOX_MAX_ATTEMPTS = 3
/** 单条投递的超时：超过就当"结果未知"，按上面的规则处理。 */
export const MAILBOX_DELIVER_TIMEOUT_MS = 15_000

/** 某节点的待办，按入队时间排序（FIFO —— 同一会话的先后顺序必须是用户的发送顺序）。 */
export function mailboxItemsFor(state: HubState, nodeId: string): MailboxItem[] {
  return Object.values(state.mailbox)
    .filter((item) => item.nodeId === nodeId)
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
}

/** 清掉超龄条目，返回被清掉的那些（调用方负责记日志）。 */
export function pruneMailbox(state: HubState, now = Date.now()): MailboxItem[] {
  const dropped: MailboxItem[] = []
  for (const item of Object.values(state.mailbox)) {
    if (now - item.createdAtMs <= MAILBOX_MAX_AGE_MS) continue
    dropped.push(item)
    delete state.mailbox[item.mailId]
  }
  return dropped
}

export interface EnqueueResult {
  item: MailboxItem
  /** 因队列已满而被丢掉的最旧条目（如实上报，不静默丢） */
  dropped: MailboxItem[]
}

/** 入队一条。参数原样存下来，节点上线后**按原样**投递。 */
export async function enqueueForNode(
  hub: Hub,
  nodeId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<EnqueueResult> {
  const state = hub.state()
  const now = Date.now()
  pruneMailbox(state, now)

  const item: MailboxItem = {
    mailId: newId('mail'),
    nodeId,
    kind: method as MailboxItem['kind'],
    method,
    params,
    correlationId: '',
    createdAtMs: now,
    attempts: 0,
  }
  state.mailbox[item.mailId] = item

  /* 有界：满了丢最旧的一条。用户刚发的那条通常才是要紧的，但"悄悄丢"不行 ——
     调用方会拿到 droppedOldest，控制台照实提示。 */
  const dropped: MailboxItem[] = []
  const mine = mailboxItemsFor(state, nodeId)
  while (mine.length > MAILBOX_MAX_PER_NODE) {
    const oldest = mine.shift()
    if (oldest === undefined) break
    dropped.push(oldest)
    delete state.mailbox[oldest.mailId]
  }

  await hub.store.saveMailbox()
  return { item, dropped }
}

export interface FlushResult {
  delivered: number
  /** 投递时节点又离线了 → 保留待下次（这是主要路径，不算失败） */
  skippedOffline: number
  /** 结果未知（超时/节点侧报错）→ 记一次 attempts，达到上限后不再重试 */
  uncertain: number
  /** 重试次数用尽、不再重试的条目数（仍留在队列里，由体检显示） */
  giveUp: number
  remaining: number
}

/**
 * 把某节点的待办按序投递出去。节点握手成功时调用（也适合将来做定时重投）。
 *
 * 顺序即语义：投递失败的**当前这条之后**不再继续（同一会话里后面的指令必须等前面那条），
 * 但节点整条离线时直接停 —— 那是"整批等下次"，不是"这一条坏了"。
 */
export async function flushMailbox(hub: Hub, nodeId: string): Promise<FlushResult> {
  const state = hub.state()
  const result: FlushResult = {
    delivered: 0,
    skippedOffline: 0,
    uncertain: 0,
    giveUp: 0,
    remaining: 0,
  }

  for (const expired of pruneMailbox(state)) {
    hub.log(`mailbox: dropped expired item ${expired.mailId} (${expired.method}, queued ${expired.createdAtMs})`)
  }

  for (const item of mailboxItemsFor(state, nodeId)) {
    if (item.attempts >= MAILBOX_MAX_ATTEMPTS) {
      result.giveUp += 1
      continue
    }
    const requestParams =
      item.method === 'employee.invoke'
        ? { ...(item.params as Record<string, unknown>), async: true }
        : item.params
    const response = await hub.requestToNode(
      nodeId,
      item.method,
      requestParams,
      MAILBOX_DELIVER_TIMEOUT_MS,
    )
    if (response.ok === true) {
      delete state.mailbox[item.mailId]
      result.delivered += 1
      hub.log(`mailbox: delivered queued ${item.method} (${item.mailId}) to node ${nodeId.slice(0, 12)}…`)
      continue
    }
    const code = response.error?.code ?? 'internal'
    if (code === 'node-offline') {
      /* 节点又离线了：整批留到下次，不做任何标记（不是这条的问题） */
      result.skippedOffline += 1
      break
    }
    item.attempts += 1
    item.lastError = response.error?.message ?? code
    result.uncertain += 1
    hub.log(
      `mailbox: queued ${item.method} (${item.mailId}) failed with ${code} ` +
        `(attempt ${item.attempts}/${MAILBOX_MAX_ATTEMPTS}); 不自动无限重试，避免员工收到重复指令`,
    )
    /* 结果未知：后面的指令仍可投（不是节点整条不可用），所以 continue 而不是 break */
  }

  result.remaining = mailboxItemsFor(state, nodeId).length
  await hub.store.saveMailbox()
  return result
}
