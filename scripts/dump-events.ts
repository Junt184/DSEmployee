/**
 * 打印某条会话事件（按类型过滤）的**原始 JSON**。
 *
 * 与 `inspect-session.ts` 的分工：那个给"事件类型分布 + 文本抽取自检"，
 * 这个给"我要看某一种事件的完整形状"。当抽取逻辑失效时，先跑这个。
 *
 * 用法：node scripts/dump-events.ts <port> <sessionId> [类型子串]
 */

import { DshClient } from '../src/node/dsh-client.ts'

const port = Number.parseInt(process.argv[2] ?? '', 10)
const sessionId = process.argv[3]
const filter = process.argv[4] ?? ''

if (!Number.isInteger(port) || sessionId === undefined) {
  process.stderr.write('usage: node scripts/dump-events.ts <port> <sessionId> [typeSubstring]\n')
  process.exit(2)
}

const client = new DshClient({ port })
const history = await client.sessionHistory(sessionId, { maxMessages: 200 })

for (const entry of history.events) {
  const event = (entry as { event?: { type?: string; seq?: number; data?: unknown } }).event
  if (event?.type === undefined) continue
  if (filter !== '' && !event.type.includes(filter)) continue
  process.stdout.write(`\n[seq ${event.seq}] ${event.type}\n`)
  process.stdout.write(`${JSON.stringify(event.data, null, 2)}\n`)
}
