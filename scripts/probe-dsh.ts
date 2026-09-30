/**
 * 探针：对一个正在运行的 dsh web 实例做只读体检。
 *
 * 用途是**验证我们的 `/api` 客户端契约理解正确**，以及查看真实返回形状，
 * 不发起任何模型调用（因此不消耗额度）。
 *
 * 用法：node scripts/probe-dsh.ts <port>
 */

import { DshApiError, DshCarrierError, DshClient } from '../src/node/dsh-client.ts'

const port = Number.parseInt(process.argv[2] ?? '', 10)
if (!Number.isInteger(port)) {
  process.stderr.write('usage: node scripts/probe-dsh.ts <port>\n')
  process.exit(2)
}

const client = new DshClient({ port, verbose: true })

async function tryCall(label: string, fn: () => Promise<unknown>): Promise<void> {
  process.stdout.write(`\n=== ${label} ===\n`)
  try {
    const value = await fn()
    process.stdout.write(`${JSON.stringify(value, null, 2).slice(0, 3000)}\n`)
  } catch (error) {
    if (error instanceof DshApiError) {
      process.stdout.write(`DshApiError code=${error.code} message=${error.message}\n`)
      process.stdout.write(`details=${JSON.stringify(error.details)?.slice(0, 800)}\n`)
    } else if (error instanceof DshCarrierError) {
      process.stdout.write(`DshCarrierError status=${error.status} message=${error.message}\n`)
    } else {
      process.stdout.write(`unexpected: ${String(error)}\n`)
    }
  }
}

await tryCall('host.describe', () => client.hostDescribe())
await tryCall('workspace.list', () => client.workspaceList())
await tryCall('session.list', () => client.sessionList())
/* 这里原本探 `agentPreset.list` —— 但 DshClient 的 agentPreset 方法已随"取消每员工
   物化 preset"一起删除（docs/05 §13.1），探针没跟着改：跑起来会报
   `client.agentPresetList is not a function`，**看起来像 dsh 的问题，其实是探针自己坏了**。
   现在改探真正在用的 skill.list（它按会话解析，所以先用会话列表取一个 sessionId）。 */
const sessions = await client.sessionList()
const firstSessionId = (sessions.items as Array<Record<string, unknown>>).find(
  (item) => typeof item['sessionId'] === 'string',
)?.['sessionId']
if (typeof firstSessionId === 'string') {
  await tryCall(`skill.list (session ${firstSessionId.slice(0, 8)}…)`, () =>
    client.skillList(firstSessionId),
  )
} else {
  process.stdout.write('\n=== skill.list ===\n（没有会话可查：dsh 的技能可见性是按会话解析的）\n')
}

// 下行流：只确认能连上，不等待业务事件
process.stdout.write('\n=== downlink ===\n')
const downlink = client.openDownlink()
let opened = 0
downlink.on('open', () => {
  opened += 1
  process.stdout.write(`downlink channel opened (${opened}/2)\n`)
})
downlink.on('request', (frame) => process.stdout.write(`server-request: ${frame.method}\n`))
downlink.on('error', (error) => process.stdout.write(`downlink error: ${error.message}\n`))
downlink.on('close', (info) => process.stdout.write(`downlink closed: ${info.channel}\n`))
downlink.open()
await new Promise((resolve) => setTimeout(resolve, 2500))
process.stdout.write(`channels opened: ${opened}/2\n`)
downlink.close()
process.stdout.write('done\n')
process.exit(0)
