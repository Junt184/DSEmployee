/**
 * 会话事件形状勘察器。
 *
 * 用途：把 dsh 会话历史的**真实事件形状**打印出来。
 *
 * 这个脚本存在的原因很实在：`src/node/agent.ts` 里从会话事件抽取"员工最终回复文本"
 * 的逻辑是**尽力而为的启发式**（因为事件形状在最初实现时未经实测）。
 * 一旦 dsh 改了事件结构，抽取会静默失效 —— 那时就用这个脚本看真实形状，
 * 再据此修正提取逻辑。它也是验证"抽取是否还准"的最快手段。
 *
 * 用法：node scripts/inspect-session.ts <dsh端口> <sessionId>
 */

import { DshClient } from '../src/node/dsh-client.ts'
import { extractAssistantText } from '../src/node/agent.ts'

const port = Number.parseInt(process.argv[2] ?? '', 10)
const sessionId = process.argv[3]

if (!Number.isInteger(port) || sessionId === undefined) {
  process.stderr.write('usage: node scripts/inspect-session.ts <port> <sessionId>\n')
  process.exit(2)
}

const client = new DshClient({ port })
const history = await client.sessionHistory(sessionId, { maxMessages: 200 })

process.stdout.write(`事件总数: ${history.events.length}\n`)

/** 统计事件类型分布 —— 一眼看出这一轮里都发生了什么。 */
const typeCounts = new Map<string, number>()
for (const entry of history.events) {
  const type = (entry as { event?: { type?: string } }).event?.type ?? '(no type)'
  typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1)
}
process.stdout.write('事件类型分布:\n')
for (const [type, count] of [...typeCounts].sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`  ${count.toString().padStart(4)}  ${type}\n`)
}

process.stdout.write('\n--- 含文本内容的事件（按 seq 顺序）---\n')
for (const entry of history.events) {
  const event = (entry as { event?: { type?: string; seq?: number; data?: unknown } }).event
  if (event === undefined) continue
  const serialized = JSON.stringify(event.data ?? null)
  if (serialized === undefined) continue
  // 只挑"看起来带模型可见文本"的事件，避免刷屏
  if (!serialized.includes('"text"') && !serialized.includes('"content"')) continue
  process.stdout.write(`\n[seq ${event.seq}] ${event.type}\n`)
  process.stdout.write(`${serialized.slice(0, 800)}\n`)
}

/* 抽取结果用**与生产同一份实现**，不再自带一份"看起来一样"的副本。
 *
 * 曾经这里复制了 agent.ts 的深度遍历启发式，还在输出里宣称"agent.ts 用的就是这套规则" ——
 * 两处都不成立：那份启发式在 docs/04 §3 就被实测否掉（对同一份历史返回空数组），
 * 而 agent.ts 早已改成"优先读 assistant/message 的 content 文本块"。
 * 结果是这个探针会对着完好的会话报"抽不到文本"，把人引向不存在的故障。
 * 现在直接 import 生产实现：它变，探针跟着变，不可能再对不上。 */
process.stdout.write('\n--- 文本抽取（与生产同一份实现：src/node/agent.ts 的 extractAssistantText）---\n')
const assistantMessages = history.events
  .map((entry) => (entry as { event?: { type?: string; data?: unknown } }).event)
  .filter((event) => event?.type === 'assistant/message')
  .map((event) => extractAssistantText(event?.data))
  .filter((text) => text !== undefined)
process.stdout.write(
  assistantMessages.length === 0
    ? '（这条历史里没有 assistant/message）\n'
    : JSON.stringify(assistantMessages, null, 2).slice(0, 2000) + '\n',
)
