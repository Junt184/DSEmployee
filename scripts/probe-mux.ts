/**
 * 探针：直接听 dsh 的 events.mux / events.host 原始下行帧。
 *
 * 目的：回答"长任务运行期间，dsh 到底往下行流里推什么帧"——
 * agent.ts 只转发 type === 'server-request' 的帧，若文本 delta 是别的帧类型，
 * 那就是流式输出到不了控制台的根本原因。
 *
 * 用法：node scripts/probe-mux.ts <dshPort> <employeeWorkspacePath>
 */

import { WebSocket } from 'ws'
import { DshClient } from '../src/node/dsh-client.ts'

const port = Number.parseInt(process.argv[2] ?? '', 10)
const cwd = process.argv[3]
if (!Number.isInteger(port) || cwd === undefined) {
  process.stderr.write('usage: node scripts/probe-mux.ts <dshPort> <cwd>\n')
  process.exit(2)
}

const client = new DshClient({ port })
const created = await client.sessionCreate({ cwd })
process.stdout.write(`[probe] session ${created.sessionId}\n`)

const counts = new Map<string, number>()
let samples = 0
for (const channel of ['events.mux', 'events.host'] as const) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/${channel}`)
  socket.on('message', (data) => {
    let parsed: { type?: string; method?: string; payload?: unknown }
    try {
      parsed = JSON.parse(data.toString())
    } catch {
      return
    }
    const key = `${channel} type=${String(parsed.type)} method=${String(parsed.method ?? '-')}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (samples < 5 && parsed.type !== 'server-request') {
      samples += 1
      process.stdout.write(`[probe] 样例 ${key}: ${JSON.stringify(parsed).slice(0, 400)}\n`)
    }
  })
  socket.on('error', (error) => process.stdout.write(`[probe] ${channel} error ${error.message}\n`))
}

await client.sessionPrompt(
  created.sessionId,
  '从 1 数到 200，每个数字单独一行输出，中间不要停，不要调用任何工具。',
  'queue',
)
process.stdout.write('[probe] 已下达任务，听 15 秒…\n')
await new Promise((resolve) => setTimeout(resolve, 15_000))

process.stdout.write('\n[probe] 帧类型分布：\n')
for (const [key, count] of [...counts.entries()].sort()) {
  process.stdout.write(`  ${count.toString().padStart(6)}  ${key}\n`)
}
await client.sessionCancel(created.sessionId).catch(() => undefined)
process.exit(0)
