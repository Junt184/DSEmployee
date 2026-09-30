/**
 * 凭据诊断：确认 dsh 到底有没有读到凭据文档，以及它是从哪一层读到的。
 *
 * 存在的原因：`MISSING_CREDENTIAL` 是个**归因困难**的错误 —— 它只说"没有 key"，
 * 不说"我找过哪些地方、哪些不存在、哪些不可写"。这个脚本把那层信息挖出来。
 *
 * 只调 `credentials.describe`（它是只读方法，且被钉在回环），**绝不读取或打印凭据值**。
 *
 * 用法：node scripts/probe-credentials.ts <dsh端口>
 */

import { DshClient, DshApiError } from '../src/node/dsh-client.ts'

const port = Number.parseInt(process.argv[2] ?? '', 10)
if (!Number.isInteger(port)) {
  process.stderr.write('usage: node scripts/probe-credentials.ts <port>\n')
  process.exit(2)
}

const client = new DshClient({ port })

process.stdout.write(`DSH_HOME 环境变量: ${process.env['DSH_HOME'] ?? '(未设置 → 用 ~/.dsh)'}\n\n`)

try {
  // `credentials.describe` 要求显式列出要查的引用（不是"列出全部"）。
  // 只查键名，返回值里不会有凭据内容。
  const described = await client.call<unknown>('credentials.describe', {
    refs: ['DEEPSEEK_API_KEY'],
  })
  process.stdout.write('credentials.describe:\n')
  process.stdout.write(`${JSON.stringify(described, null, 2)}\n`)
} catch (error) {
  if (error instanceof DshApiError) {
    process.stdout.write(`DshApiError code=${error.code} message=${error.message}\n`)
    process.stdout.write(`details=${JSON.stringify(error.details)}\n`)
  } else {
    process.stdout.write(`unexpected: ${String(error)}\n`)
  }
}

process.stdout.write('\n--- 模型路由（llm.providers，只看 id 与是否有凭据）---\n')
try {
  const providers = await client.call<unknown>('llm.providers', {})
  process.stdout.write(`${JSON.stringify(providers, null, 2).slice(0, 2500)}\n`)
} catch (error) {
  process.stdout.write(`llm.providers 失败: ${String(error)}\n`)
}
