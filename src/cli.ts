/**
 * `dse` 命令行。
 *
 * 关于**引导问题**（这是配对方案里最容易设计错的地方）：
 *   设备配对要求"由已授权的设备批准"，但**第一台**设备没有别人能批准它。
 *   解法不是开一个后门接口，而是承认一个更基本的信任来源：
 *   **能读写 Hub 状态文件的人，本来就已经控制了这台机器**。
 *   因此 `dse pair approve` 直接在 Hub 本机改台账，不走网络、不需要任何令牌。
 *   这不是降级 —— 它把根信任明确锚定在"物理/操作系统层面的访问"上，
 *   比任何"首次连接自动放行"的魔法都更可审计。
 */

import { parseArgs } from 'node:util'

import { Hub } from './hub/server.ts'
import { HubStore } from './hub/store.ts'
import { NodeAgent } from './node/agent.ts'
import {
  SOURCE_RELEASE,
  markConnected,
  noteCrash,
  readPointer,
  releaseCodeDir,
  releasePaths,
  startPlan,
  switchRelease,
  writePointer,
} from './node/release.ts'
import { currentCodeFingerprint, packageRoot } from './protocol/build.ts'
import { prepareRelease, releaseLooksRunnable } from './node/update.ts'
import {
  CAPABILITY_SCOPES,
  provisionDailyDigest,
  provisionEmployeeCapability,
  provisionOrchestrateSkill,
} from './node/capability.ts'
import { HubClient } from './client/hub-client.ts'
import { callHubLocalControl } from './hub/local-control.ts'
import {
  approvePairing,
  pairingWindowOpen,
  rejectPairing,
  removePairing,
  revokeToken,
  rotateToken,
} from './hub/devices.ts'
import { hashPairCode, issuePairCode, newPairCode } from './hub/paircode.ts'
import { safeName } from './node/agent.ts'
import { showPairCodeNotification } from './util/notify.ts'
import { normalizeScopes } from './protocol/index.ts'
import { dseHome, expandHome, pathExists, readJsonFile, readTextFile, writeJsonFile } from './util/fsx.ts'
import { loadOrCreateIdentity } from './util/identity.ts'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'

/** 命令行里给的 scope 列表：逗号分隔，非法项由 `normalizeScopes` 丢弃。 */
function parseScopes(input: string | undefined, fallback: string): ReturnType<typeof normalizeScopes> {
  return normalizeScopes((input ?? fallback).split(',').map((s) => s.trim()))
}

const USAGE = `dse —— 基于 DeepSeek Harness 的数字员工平台

用法：
  dse hub [--port <n>] [--host <ip>] [--allow-non-loopback] [--trust-proxy] [--home <dir>] [--name <名>]
      启动 Hub：控制台 + 控制面（单端口 HTTP + WebSocket）。
      默认只绑回环。--host 给非回环地址时**必须**同时给 --allow-non-loopback，
      因为本 Hub 认证调用方但不加密传输：绑到局域网会把设备令牌与会话内容明发送出去。
      正确做法是前置带 TLS 的反向代理，或走 SSH/WireGuard/Tailscale 隧道。
      同一状态目录**只允许一个 Hub 实例**（有独占锁保护）。
      --trust-proxy：Hub 前面有**自己控制的**反代（如 nginx 终止 TLS）时开启，
      客户端 IP 改从 X-Real-IP / X-Forwarded-For 取 —— 不开的话反代后面所有
      连接都会被当成回环，节点配对的自动批准闸会被互联网流量骗开。
      直连部署**不要开**：那时这些头是客户端可伪造的。

  dse node --hub <ws-url> --name <节点名> --employee-root <目录> [选项]
      在终端上启动节点代理：托管本机 dsh、上报员工目录、执行 Hub 下发的指令。
      选项：--dsh-home <dir>   指定 dsh 的 DSH_HOME（一台机器跑多个隔离实例时必填）
            --attach-port <n>  附着到一个已在运行的 dsh，而不是自己拉起（此时不加 --dsh-home）
            --dsh-port <n>     托管模式下期望的端口（0 = 自动）
            --dsh <命令>        dsh 可执行文件名
            --dsh-env K=V      传给托管 dsh 子进程的环境变量（可重复）
                               常用：--dsh-env DEEPSEEK_API_KEY=sk-xxx
                               不给凭据时员工能连上，但一执行任务就会以
                               MISSING_CREDENTIAL 失败（该错误会回传到调用方）
            --default-preset <id>
                               新建会话缺省使用的 agent preset（默认 standard；
                               dsh 自己的部署默认是 minimal，没有 /compact 压缩等能力）
      技能（两层，由 dsh 的默认发现提供，本工具不再插手）：
        私有：<工作区>/.dsh/skills（rank 100，同名优先）
        公共：<DSH_HOME>/skills（400）与 ~/.agents/skills（500）
        前提：**员工工作区必须是 dsh 认定的项目根** —— 即工作区自身（或某个祖先）
        含 .git。工作区嵌在别的 git 仓库里会让私有技能静默失效。
        体检：node scripts/probe-skill-roots.ts

  dse pair list
      列出待审批与已配对的设备（**仅在 Hub 本机可用**）。

  dse pair-code [--hub <ws-url>] [--name <节点名>] [--label <说明>]
      生成新的 6 位配对码并打印（一次性）。
      不带 --hub：Hub 本机流程，24h 有效，旧码作废。
      带 --hub：终端本机流程 —— 用本机节点身份上报给 Hub，10 分钟内有效，
      并尽力弹桌面通知。新设备在控制台输入任一码即可完成授权。

  dse pair approve <requestId> [--scopes a,b] [--name 显示名] [--employee 员工id或名字]
      批准一台待配对的设备并打印它的设备令牌（只打印这一次）。
      兜底路径：配对码不可用时，在本机直接批准。
      --employee：把这台设备**绑定到一个员工** —— 绑定后它的令牌只能以该员工名义
      发起跨员工调用（from 由连接派生，不能冒名）。给员工发凭据时用这个。

  dse pair reject <requestId>
  dse pair remove <deviceId>
  dse token rotate <deviceId>     轮换设备令牌（受该设备已批准 scope 上限约束）
  dse token revoke <deviceId>     吊销设备令牌

  dse pairing [status] [--home <dir>]  查看注册窗口（默认子命令）
  dse pairing open [--minutes N]  通过运行中 Hub 的本机 IPC 打开注册窗口
  dse pairing close               通过运行中 Hub 的本机 IPC 关闭注册窗口
      本机 IPC 不依赖浏览器 cookie；Hub 停止时只可查看状态，变更前需先启动 Hub。
      因此"cookie 被清掉 + 窗口关着"仍可从 Hub 服务器本机救回。

  dse employee-capability --workspace <员工工作区> --hub <ws-url> [--dse-bin <路径>]
      给这个员工开通"调用其他员工"的能力：往它的工作区装入口
      （tools/employee-call）与技能说明，并打印接下来要在 Hub 机器上执行的批准命令。
      凭据是**绑定身份**的：批准时用 dse pair approve <id> --employee <名字> 把它
      绑到这个员工，之后它只能以自己名义发起调用（冒名会被 Hub 拒绝）。

  dse release start-plan [--repo <目录>]
      打印"这次该跑哪个版本"（JSON：action / release / codeDir / reason）。
      **启动器调它**：判定逻辑只有一份实现（src/node/release.ts），
      Windows 的 start-node.ps1 与 Mac 的 run-node.sh 都只负责执行。
      注意判定用的是**仓库里那份代码**，不是被判定那个版本 —— 后者可能根本起不来。

  dse release note-connected | note-crash
      节点连上 Hub / 启动器发现进程异常退出时调用，维护 current.json 里的证据。

  dse release switch --to <版本 id | __source__> [--by <谁>]
      切换当前版本指针（原子写）；同时把当前版本记为 previous（回滚目标）。

  dse release update --to <分支|标签|sha> [--repo <目录>]
      把一个提交落地成可运行的新版本：git fetch → git worktree 检出到
      releases/<sha> → 校验指纹 → 依赖变了才 npm ci → 冒烟 → 原子切指针。
      任何一步失败都**不动指针**（继续跑旧版本）。**不负责重启** —— 重启由
      Hub 的「升级」按钮或平台脚本触发。

  dse release status
      人看的当前状态：指针、目录、是否存在、上次连上时间、崩溃计数。

  dse employee-orchestrate --workspace <员工工作区>
      给已经装好互调入口的员工补上"总控"技能：怎么拆活、怎么派给同事、
      怎么收结果、以及"发起即返回、不许死等、不许编造"的纪律。

  dse employee-digest --workspace <员工工作区> [--at HH:MM]
      给已经装好互调入口的员工补上"每日汇总"技能（把其他同事的动向汇总成四段汇报，
      并可用钉钉推送）。取数走 employee.activity（只读元数据），不另发凭据；
      打印出创建每日定时任务的命令（任务要 employee.manage，由人来建）。

  dse rpc <method> [params-json] [--params-file <文件>] [--hub <ws-url>] [--identity <file>]
      以 operator 身份连上 Hub 调一个方法。用于脚本与排障。
      建议用 --params-file 而不是行内 JSON：Windows 的 PowerShell 会把参数里的引号吃掉。

  dse identity [--identity <file>]
      打印本机设备身份的指纹与公钥。

通用选项：
  --home <dir>   本产品家目录（默认 $DSE_HOME 或 ~/.dsemployee）
  --verbose      详细日志
  -h, --help     显示帮助
`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv

  if (command === undefined || command === '-h' || command === '--help') {
    process.stdout.write(USAGE)
    return 0
  }

  switch (command) {
    case 'hub':
      return await runHub(rest)
    case 'node':
      return await runNode(rest)
    case 'pair':
      return await runPair(rest)
    case 'pair-code':
      return await runPairCode(rest)
    case 'token':
      return await runToken(rest)
    case 'pairing':
      return await runPairing(rest)
    case 'employee-capability':
      return await runEmployeeCapability(rest)
    case 'employee-digest':
      return await runEmployeeDigest(rest)
    case 'employee-orchestrate':
      return await runEmployeeOrchestrate(rest)
    case 'release':
      return await runRelease(rest)
    case 'rpc':
      return await runRpc(rest)
    case 'identity':
      return await runIdentity(rest)
    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`)
      return 2
  }
}

/* ────────────────────────────── hub ────────────────────────────── */

async function runHub(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      home: { type: 'string' },
      name: { type: 'string' },
      'allow-non-loopback': { type: 'boolean', default: false },
      'trust-proxy': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })

  const hub = new Hub({
    ...(values.home === undefined ? {} : { home: values.home }),
    ...(values.port === undefined ? {} : { port: Number.parseInt(values.port, 10) }),
    ...(values.host === undefined ? {} : { host: values.host }),
    ...(values.name === undefined ? {} : { name: values.name }),
    allowNonLoopbackBind: values['allow-non-loopback'] === true,
    /* 仅本次运行生效、不落盘：反代拓扑是部署细节，不该固化进状态文件 */
    trustProxy: values['trust-proxy'] === true,
    verbose: values.verbose === true,
  })
  const address = await hub.start()

  // 每次启动换一个新配对码（旧码作废）。明文只出现在这里 —— 状态目录里只有 sha256。
  const pairCode = await issuePairCode(hub.store)

  process.stdout.write(
    [
      '',
      `Hub 已启动`,
      `  控制台   ${address.url}`,
      `  控制面   ${address.wsUrl}`,
      `  状态目录 ${hub.store.root}`,
      '',
      `  ╔══════════════════════════════╗`,
      `  ║   配对码（24h 有效）：${pairCode}   ║`,
      `  ╚══════════════════════════════╝`,
      `  在控制台页面输入它即可授权新设备。`,
      `  过期/丢失后在 Hub 本机执行「dse pair-code」重新生成（旧码作废）。`,
      '',
      `  ${pairingWindowOpen(hub.state().config)
        ? '注册窗口：开着 —— 未认证的访客也能看到授权码入口（要藏起来：控制台「设备」页点「关闭注册」）'
        : '注册窗口：已关闭 —— 没有 cookie 的访问只会看到 404（要加设备：dse pairing open）'}`,
      '',
      `把 ${address.wsUrl} 交给终端节点作为 --hub 参数。`,
      `兜底路径：也可以在本机用「dse pair list / pair approve <requestId>」批准设备。`,
      '',
    ].join('\n'),
  )

  await waitForShutdown(async () => {
    process.stdout.write('\n正在关闭 Hub…\n')
    await hub.stop()
  })
  return 0
}

/* ────────────────────────────── node ────────────────────────────── */

async function runNode(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      hub: { type: 'string' },
      name: { type: 'string' },
      'employee-root': { type: 'string' },
      'dsh-home': { type: 'string' },
      'dsh-port': { type: 'string' },
      'attach-port': { type: 'string' },
      dsh: { type: 'string' },
      'dsh-env': { type: 'string', multiple: true },
      'default-preset': { type: 'string', default: 'standard' },
      home: { type: 'string' },
      verbose: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })

  if (values.hub === undefined || values.name === undefined || values['employee-root'] === undefined) {
    process.stderr.write('node 需要 --hub、--name、--employee-root\n')
    return 2
  }

  const attachPort =
    values['attach-port'] === undefined ? undefined : Number.parseInt(values['attach-port'], 10)

  // `--dsh-env KEY=VALUE`（可重复）：把环境变量传给托管的 dsh 进程。
  // 最常用的就是 DEEPSEEK_API_KEY —— dsh 在找不到凭据时会整轮失败并报
  // MISSING_CREDENTIAL，而这条错误只有传到调用方那里才有意义。
  const dshEnv: Record<string, string> = {}
  for (const pair of values['dsh-env'] ?? []) {
    const index = pair.indexOf('=')
    if (index <= 0) {
      process.stderr.write(`--dsh-env 需要 KEY=VALUE 形式，收到 "${pair}"\n`)
      return 2
    }
    dshEnv[pair.slice(0, index)] = pair.slice(index + 1)
  }

  const agent = new NodeAgent({
    hubUrl: values.hub,
    name: values.name,
    employeeRoot: path.resolve(expandHome(values['employee-root'])),
    verbose: values.verbose === true,
    ...(values.home === undefined ? {} : { home: values.home }),
    ...(values['dsh-home'] === undefined
      ? {}
      : { dshHome: path.resolve(expandHome(values['dsh-home'])) }),
    ...(values.dsh === undefined ? {} : { dshCommand: values.dsh }),
    ...(values['dsh-port'] === undefined
      ? {}
      : { dshPort: Number.parseInt(values['dsh-port'], 10) }),
    ...(Object.keys(dshEnv).length === 0 ? {} : { dshEnv }),
    // 节点级缺省 preset（默认 standard）：调用参数与员工配置都没指定时，
    // 新会话用它而不是落到 dsh 自己的 minimal。显式给空串 = 不强制。
    ...(values['default-preset'] === undefined || values['default-preset'] === ''
      ? {}
      : { defaultPreset: values['default-preset'] }),
    // 给了 attach-port 就表示"连一个已经跑着的 dsh"，不由我们托管
    manageDsh: attachPort === undefined,
    ...(attachPort === undefined ? {} : { attachPort }),
  })

  await agent.start()
  process.stdout.write(`\n节点「${values.name}」已就绪，员工根目录：${agent.options.employeeRoot}\n\n`)

  await waitForShutdown(async () => {
    process.stdout.write('\n正在停止节点…\n')
    await agent.stop()
  })
  return 0
}

/* ────────────────────────────── pair-code（本地引导）────────────────────────────── */

async function runPairCode(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      home: { type: 'string' },
      hub: { type: 'string' },
      name: { type: 'string' },
      label: { type: 'string' },
    },
    allowPositionals: false,
  })

  // 带 --hub：终端本机出码并上报（节点码流程）；不带：Hub 本机流程（不变）
  if (values.hub !== undefined) {
    return await runNodePairCode({
      hubUrl: values.hub,
      ...(values.home === undefined ? {} : { home: values.home }),
      ...(values.name === undefined ? {} : { name: values.name }),
      ...(values.label === undefined ? {} : { label: values.label }),
    })
  }

  const store = new HubStore(values.home)
  await store.load()
  // 与 pair approve 同机制：直接在 Hub 本机改状态文件，不走网络、不需要令牌。
  // 运行中的 Hub 会在下一次 redeem 时重读这个文件，因此新码立即生效。
  const code = await issuePairCode(store)
  process.stdout.write(
    [
      '',
      `新配对码（24h 有效，一次性，旧码已作废）：`,
      '',
      `  ${code}`,
      '',
      '在控制台页面输入它即可授权一台新设备。',
      '',
    ].join('\n'),
  )
  return 0
}

/**
 * 节点码流程：在终端本机生成码，用**本机的节点身份**上报给 Hub。
 *
 * 身份从哪来：节点代理启动时把设备身份与令牌存在
 * `<home>/nodes/<节点名>/{identity,token}.json`（见 NodeAgent.start）。
 * 这里必须复用那份身份而不是新建一个 —— 否则 Hub 的批准日志里
 * "这是哪台终端出的码"会对不上号（审计意义全在 nodeId 上）。
 */
async function runNodePairCode(options: {
  hubUrl: string
  home?: string
  name?: string
  label?: string
}): Promise<number> {
  const nodesRoot = path.join(dseHome(options.home), 'nodes')
  const name = options.name ?? (await singleNodeName(nodesRoot))
  if (name === undefined) {
    process.stderr.write(
      '找不到本机的节点身份：请先用 dse node 启动一次节点代理；' +
        '若这台机器跑过多个节点，用 --name 指定其一。\n',
    )
    return 1
  }
  const dir = path.join(nodesRoot, safeName(name))
  const identityFile = path.join(dir, 'identity.json')
  const tokenFile = path.join(dir, 'token.json')
  const savedToken = await readJsonFile<{ token?: string }>(tokenFile, {})

  /* 出码的实现方式是"以本机节点身份再连一次 Hub"，而 Hub 对同一个 nodeId
     **只保留最新的那条连接**（`server.ts` 的 `#completeHandshake`：淘汰被取代的节点连接）。
     于是：如果这台机器上的节点此刻正在运行，它会被挤下线一次、随后自行重连，
     期间在途的转发请求可能一直等到超时（默认 30s）。
     这不是缺陷，而是"出码必须证明持有节点私钥"的代价 —— 但调用方必须提前知道，
     否则会把它当成随机故障（docs/05 §14.2 记录的就是这个取舍）。 */
  process.stderr.write(
    `注意：本命令会以节点「${name}」的身份再连一次 Hub（出码必须证明持有节点私钥）。\n` +
      '      如果这台机器上的节点正在运行，它会被 Hub 挤下线一次并自动重连；\n' +
      '      此刻正在转发的请求可能一直等到超时（最多 30s）。稳妥做法：挑空闲时出码。\n',
  )

  const client = await HubClient.create({
    identityFile,
    url: options.hubUrl,
    role: 'node',
    scopes: [],
    clientId: 'dse-node',
    displayName: name,
    autoReconnect: false,
    ...(savedToken.token === undefined ? {} : { token: savedToken.token }),
  })
  try {
    await client.connect()
  } catch (error) {
    // 连不上就直说：码没上报成功就是不存在，绝不能打印一个无效的码让人白试
    process.stderr.write(
      `节点未连接 Hub，码无法生效：${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 1
  }

  try {
    const code = newPairCode()
    const expiresAtMs = Date.now() + 10 * 60_000
    await client.call('node.paircode.offer', {
      codeHash: hashPairCode(code),
      expiresAtMs,
      ...(options.label === undefined ? {} : { label: options.label }),
    })
    process.stdout.write(
      [
        '',
        `新配对码（10 分钟内有效，一次性）：`,
        '',
        `  ${code}`,
        '',
        '在控制台页面输入它即可授权一台新设备。',
        '',
      ].join('\n'),
    )
    // 桌面弹窗只是加分项：失败静默回落到上面的终端输出
    void showPairCodeNotification(code)
    return 0
  } finally {
    client.close()
  }
}

/** 节点身份目录里只有一个节点时自动选用它；否则返回 undefined 让调用方报错。 */
async function singleNodeName(nodesRoot: string): Promise<string | undefined> {
  try {
    const entries = await readdir(nodesRoot, { withFileTypes: true })
    const candidates: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (await pathExists(path.join(nodesRoot, entry.name, 'identity.json'))) {
        candidates.push(entry.name)
      }
    }
    return candidates.length === 1 ? candidates[0] : undefined
  } catch {
    return undefined
  }
}

/* ────────────────────────────── pair / token（本地引导）────────────────────────────── */

async function runPair(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === undefined) {
    process.stderr.write('用法：dse pair list|approve|reject|remove\n')
    return 2
  }

  if (sub === 'list') {
    const { values } = parseArgs({
      args: rest,
      options: { home: { type: 'string' } },
      allowPositionals: false,
    })
    const store = new HubStore(values.home)
    await store.load()
    const state = store.state()
    const pending = Object.values(state.pending)
    const paired = Object.values(state.paired)

    process.stdout.write(`\n本机设备身份：${state.identity.deviceId}\n`)
    process.stdout.write(`待审批（${pending.length}）：\n`)
    for (const request of pending) {
      process.stdout.write(
        `  ${request.requestId}\n` +
          `    role=${request.role} scopes=[${request.scopes.join(',') || '—'}] platform=${request.platform}\n` +
          `    from=${request.remoteIp}${request.fromLoopback ? ' (回环)' : ''} name=${request.displayName ?? '—'}\n` +
          `    device=${request.deviceId}\n`,
      )
    }
    if (pending.length === 0) process.stdout.write('  （无）\n')

    process.stdout.write(`已配对（${paired.length}）：\n`)
    for (const device of paired) {
      process.stdout.write(
        `  ${device.displayName ?? device.clientId}  device=${device.deviceId}\n` +
          `    role=${device.role} scopes=[${device.approvedScopes.join(',') || '—'}]` +
          `${device.revoked ? ' 【令牌已吊销】' : ''}\n`,
      )
    }
    if (paired.length === 0) process.stdout.write('  （无）\n')
    process.stdout.write('\n')
    return 0
  }

  if (sub === 'approve') {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        scopes: { type: 'string' },
        name: { type: 'string' },
        home: { type: 'string' },
        employee: { type: 'string' },
      },
      allowPositionals: true,
    })
    const requestId = positionals[0]
    if (requestId === undefined) {
      process.stderr.write(
        '用法：dse pair approve <requestId> [--scopes a,b] [--name 名] [--employee 员工id或名字]\n',
      )
      return 2
    }
    const store = new HubStore(values.home)
    await store.load()

    /* --employee：把这台设备绑定到一个员工。绑定之后它的令牌**只能以这个员工的名义**
       发起跨员工调用（from 由认证连接派生），员工自己的凭据就是这么发的。
       名字也接受：员工 id 是 64 位哈希，让人手敲不现实。 */
    let boundEmployeeId: string | undefined
    if (values.employee !== undefined) {
      const wanted = values.employee
      const employees = Object.values(store.state().employees)
      const hit =
        employees.find((e) => e.id === wanted) ?? employees.find((e) => e.name === wanted)
      if (hit === undefined) {
        process.stderr.write(
          `找不到员工 "${wanted}"。现有员工：` +
            (employees.map((e) => `${e.name}(${e.id.slice(0, 12)}…)`).join('、') || '（无）') +
            '\n',
        )
        return 1
      }
      boundEmployeeId = hit.id
    }

    const approved = await approvePairing(store, requestId, `local:${process.env['USERNAME'] ?? 'operator'}`, {
      ...(values.scopes === undefined ? {} : { approvedScopes: parseScopes(values.scopes, '') }),
      ...(values.name === undefined ? {} : { displayName: values.name }),
      ...(boundEmployeeId === undefined ? {} : { boundEmployeeId }),
    })

    process.stdout.write(
      [
        '',
        `已批准设备 ${approved.device.deviceId}`,
        `  role      ${approved.device.role}`,
        `  scopes    ${approved.device.approvedScopes.join(', ') || '（无）'}`,
        ...(approved.device.boundEmployeeId === undefined
          ? []
          : [
              `  绑定员工  ${store.state().employees[approved.device.boundEmployeeId]?.name ?? ''} ` +
                `(${approved.device.boundEmployeeId})`,
              '           这台设备只能以它的名义发起跨员工调用。',
            ]),
        '',
        '  该设备会在它下一次连接时自动领取令牌，无需手动搬运。',
        '  如果它已经在线并且在重试，几秒内就会自己连上。',
        '',
      ].join('\n'),
    )
    return 0
  }

  if (sub === 'reject') {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { home: { type: 'string' } },
      allowPositionals: true,
    })
    const requestId = positionals[0]
    if (requestId === undefined) {
      process.stderr.write('用法：dse pair reject <requestId>\n')
      return 2
    }
    const store = new HubStore(values.home)
    await store.load()
    const request = await rejectPairing(store, requestId)
    process.stdout.write(`已拒绝 ${request.deviceId} 的配对请求\n`)
    return 0
  }

  if (sub === 'remove') {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { home: { type: 'string' } },
      allowPositionals: true,
    })
    const deviceId = positionals[0]
    if (deviceId === undefined) {
      process.stderr.write('用法：dse pair remove <deviceId>\n')
      return 2
    }
    const store = new HubStore(values.home)
    await store.load()
    const removed = await removePairing(store, deviceId)
    process.stdout.write(removed ? `已移除 ${deviceId}\n` : `未找到已配对设备 ${deviceId}\n`)
    return removed ? 0 : 1
  }

  process.stderr.write(`未知子命令 "pair ${sub}"\n`)
  return 2
}

function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function describePairingWindow(status: {
  open: boolean
  untilMs?: number
  pairedCount: number
  mode: string
}): string {
  const pairedLine = `已配对设备：${status.pairedCount} 台`
  if (!status.open) return `注册窗口：已关闭（没有 cookie 的访问只会看到 404）\n${pairedLine}`
  if (typeof status.untilMs === 'number') {
    const minutes = Math.max(0, Math.round((status.untilMs - Date.now()) / 60_000))
    return `注册窗口：开着，还剩约 ${minutes} 分钟（到点自动关）\n${pairedLine}`
  }
  return `注册窗口：开着（无到期时间，等有人手动关）\n${pairedLine}`
}

/**
 * `dse pairing open|close|status` —— 注册窗口的命令行入口。
 *
 * 开/关必须走受限的本机 IPC，让唯一的 Hub 进程更新自己的内存与磁盘状态。
 * Hub 停止时只允许 status 读盘；要开关窗口，先启动 Hub（窗口关闭不影响本机 IPC）。
 */
async function runPairing(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { home: { type: 'string' }, minutes: { type: 'string' } },
    allowPositionals: true,
  })
  const sub = positionals[0] ?? 'status'
  const store = new HubStore(values.home)
  await store.load()
  const lock = await readJsonFile<{ pid?: number } | undefined>(store.files.lock, undefined)
  const hubRunning = isProcessAlive(lock?.pid)

  if (sub !== 'status' && sub !== 'open' && sub !== 'close') {
    process.stderr.write('用法：dse pairing [status|open [--minutes N]|close]\n')
    return 2
  }

  let openMinutes: number | undefined
  if (sub === 'open' && values.minutes !== undefined) {
    const parsed = Number(values.minutes)
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 120) {
      process.stderr.write(`--minutes 需要 1 到 120 的整数，收到 "${values.minutes}"\n`)
      return 2
    }
    openMinutes = parsed
  }

  if (hubRunning) {
    try {
      const result = await callHubLocalControl(
        store.root,
        sub === 'status' ? 'pairing.window' : 'pairing.window.set',
        sub === 'status' ? {} : { open: sub === 'open', ...(openMinutes === undefined ? {} : { minutes: openMinutes }) },
      ) as { open: boolean; untilMs?: number; pairedCount: number; mode: string }
      process.stdout.write(`\n${describePairingWindow(result)}\n\n`)
      if (sub === 'open') {
        process.stdout.write('新设备现在可以打开控制台输入配对码了。用完记得 `dse pairing close`。\n')
      }
      return 0
    } catch (error) {
      process.stderr.write(
        `Hub 进程仍在运行，但本机控制通道调用失败；为避免改出“磁盘已变、Hub 内存未变”的状态，CLI 不会直接写配置。\n` +
          `请确认 CLI 与 Hub 使用相同的 --home 和 OS 账户；运行中的 Hub 不会回退为直接写 JSON。\n` +
          `详情：${error instanceof Error ? error.message : String(error)}\n`,
      )
      return 1
    }
  }

  // Hub 已停止：status 读盘仅供查看；开关不能离线写 JSON，否则 Hub 启动竞态会再次造成内存分叉。
  if (sub !== 'status') {
    process.stderr.write('Hub 当前未运行。请先启动 Hub，再执行此命令；运行中的 Hub 通过本机 IPC 即时更新状态。\n')
    return 1
  }
  const config = store.state().config
  const snapshot = {
    open: pairingWindowOpen(config),
    ...(typeof config.pairingWindowUntilMs === 'number' ? { untilMs: config.pairingWindowUntilMs } : {}),
    pairedCount: Object.keys(store.state().paired).length,
    mode: config.pairingMode === 'closed' ? 'closed' : 'open',
  }
  process.stdout.write(`\n${describePairingWindow(snapshot)}\n（Hub 当前已停止；这是磁盘上的最后状态）\n\n`)
  return 0
}

async function runToken(argv: string[]): Promise<number> {
  const [sub, deviceId, ...rest] = argv
  if ((sub !== 'rotate' && sub !== 'revoke') || deviceId === undefined) {
    process.stderr.write('用法：dse token rotate|revoke <deviceId>\n')
    return 2
  }
  const { values } = parseArgs({
    args: rest,
    options: { scopes: { type: 'string' }, home: { type: 'string' } },
    allowPositionals: false,
  })
  const store = new HubStore(values.home)
  await store.load()

  if (sub === 'revoke') {
    await revokeToken(store, deviceId)
    process.stdout.write(`已吊销 ${deviceId} 的令牌（配对记录保留）\n`)
    return 0
  }

  const rotated = await rotateToken(
    store,
    deviceId,
    values.scopes === undefined ? undefined : parseScopes(values.scopes, ''),
  )

  // 如果被轮换的就是本机 CLI 自己的身份，直接把新令牌写回本地令牌文件。
  // 理由：令牌是一次性领取的，设备自己丢了令牌时唯一的恢复路径就是这里；
  // 让用户再去手工搬运一次哈希式密钥，纯属自找麻烦。
  const localIdentityFile = path.join(dseHome(values.home), 'cli', 'identity.json')
  let wroteLocally = false
  try {
    const localIdentity = await loadOrCreateIdentity(localIdentityFile, 'device', 'CLI')
    if (localIdentity.deviceId === deviceId) {
      await writeJsonFile(path.join(path.dirname(localIdentityFile), 'token.json'), {
        token: rotated.token,
        savedAtMs: Date.now(),
      })
      wroteLocally = true
    }
  } catch {
    /* 本机没有 CLI 身份文件时正常，不做处理 */
  }

  process.stdout.write(
    [
      `已轮换 ${deviceId} 的令牌`,
      `  scopes ${rotated.device.approvedScopes.join(', ') || '（无）'}`,
      '',
      '  新令牌（只显示这一次）：',
      `  ${rotated.token}`,
      '',
      wroteLocally
        ? '  已自动写入本机 CLI 的令牌文件，无需手动操作。'
        : '  请把它保存到该设备上（Hub 只存哈希，无法再次显示）。',
      '',
    ].join('\n'),
  )
  return 0
}

/* ────────────────────────────── 员工互调能力 ────────────────────────────── */

async function runEmployeeCapability(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      workspace: { type: 'string' },
      hub: { type: 'string' },
      'dse-bin': { type: 'string' },
      home: { type: 'string' },
    },
    allowPositionals: false,
  })

  if (values.workspace === undefined || values.hub === undefined) {
    process.stderr.write(
      '用法：dse employee-capability --workspace <员工工作区> --hub <ws-url> [--dse-bin <路径>]\n',
    )
    return 2
  }

  /* 默认用**当前这份代码**的入口（bin/dse.mjs）：员工机器上装的往往就是同一个仓库。 */
  const dseBin = values['dse-bin'] ?? path.resolve(import.meta.dirname, '..', 'bin', 'dse.mjs')

  try {
    const result = await provisionEmployeeCapability({
      workspace: values.workspace,
      hubUrl: values.hub,
      dseBin,
    })
    process.stdout.write(
      [
        '',
        `已为「${result.employeeName}」(${result.employeeId}) 装好互调入口：`,
        ...result.files.map((f) => `  · ${f}`),
        `  申请 scope：${CAPABILITY_SCOPES.join(', ')}`,
        '',
        '接下来（信任锚点必须由人做）：',
        ...result.nextSteps.map((line) => `  ${line}`),
        '',
      ].join('\n'),
    )
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function runEmployeeDigest(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { workspace: { type: 'string' }, at: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.workspace === undefined) {
    process.stderr.write('用法：dse employee-digest --workspace <员工工作区> [--at HH:MM]\n')
    return 2
  }
  if (values.at !== undefined && !/^\d{1,2}:\d{2}$/.test(values.at)) {
    process.stderr.write(`--at 需要 HH:MM 形式，收到 "${values.at}"\n`)
    return 2
  }
  try {
    const result = await provisionDailyDigest({
      workspace: values.workspace,
      ...(values.at === undefined ? {} : { atTime: values.at }),
    })
    process.stdout.write(
      [
        '',
        `已为「${result.employeeName}」(${result.employeeId}) 装上每日汇总技能：`,
        ...result.files.map((f) => `  · ${f}`),
        '',
        '接下来（任务要 employee.manage，所以由人来建）：',
        `  ${result.scheduleCommand}`,
        '',
      ].join('\n'),
    )
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function runEmployeeOrchestrate(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { workspace: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.workspace === undefined) {
    process.stderr.write('用法：dse employee-orchestrate --workspace <员工工作区>\n')
    return 2
  }
  try {
    const result = await provisionOrchestrateSkill({ workspace: values.workspace })
    process.stdout.write(
      [
        '',
        `已为「${result.employeeName}」(${result.employeeId}) 装上总控技能：`,
        ...result.files.map((f) => `  · ${f}`),
        '',
        '提醒：它派活得先有 ACL 允许（默认策略是"需人工审批"，会在你的审批队列里出现）。',
        '  全自动：dse rpc acl.set \'{"from":"<它的 id>","to":"*","effect":"allow"}\'',
        '',
      ].join('\n'),
    )
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/* ────────────────────────────── 版本与回滚 ────────────────────────────── */

/**
 * 版本指针的读写入口 —— 给两个平台的启动器与升级器用。
 *
 * 为什么由 CLI 提供、而不是让 PowerShell/bash 各自实现一遍：判定规则（尤其是
 * "什么时候回滚"）一旦有两份实现就必然分叉，而分叉的后果是"一台机器回滚生效、
 * 另一台不生效"——这种问题在半夜最难查。所以两侧脚本只做两件事：
 * 调 `start-plan` 拿目录、按结果起进程。
 */
async function runRelease(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === undefined) {
    process.stderr.write('用法：dse release start-plan|note-connected|note-crash|switch|status\n')
    return 2
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      repo: { type: 'string' },
      to: { type: 'string' },
      by: { type: 'string' },
    },
    allowPositionals: true,
  })
  void positionals

  /* --repo 默认取**当前这份代码的包根**：启动器总是从仓库里调这个命令，
     所以默认值天然正确；显式给出只是为了测试与非常规部署。 */
  const repo = path.resolve(expandHome(values.repo ?? packageRoot()))
  const paths = releasePaths({ repo, env: process.env })

  if (sub === 'start-plan') {
    const pointer = await readPointer(paths.pointerFile)
    const plan = startPlan(pointer, { repo, paths })
    /* 只输出 JSON：调用方是脚本，人看的解释在 reason 里 */
    process.stdout.write(JSON.stringify(plan) + '\n')
    return plan.action === 'rollback' ? 0 : 0
  }

  if (sub === 'note-connected' || sub === 'note-crash') {
    const pointer = await readPointer(paths.pointerFile)
    if (pointer === undefined) {
      /* 没有指针（开发机形态）不是错误：这是"没在用版本目录"的正常情况 */
      process.stdout.write(JSON.stringify({ skipped: true, reason: '没有版本指针（开发机形态）' }) + '\n')
      return 0
    }
    if (sub === 'note-connected') {
      /* 与节点进程走同一份实现（src/node/release.ts 的 markConnected）：
         只有**正在运行的那个版本**能给自己盖章。 */
      const result = await markConnected({
        repo,
        env: process.env,
        mine: currentCodeFingerprint(),
      })
      process.stdout.write(
        JSON.stringify(result.noted ? { ...result, kind: 'connected' } : { ...result, kind: 'skipped' }) + '\n',
      )
      return 0
    }
    await writePointer(paths.pointerFile, noteCrash(pointer))
    process.stdout.write(
      JSON.stringify({ noted: 'crash', release: pointer.release, failedStarts: (pointer.failedStarts ?? 0) + 1 }) + '\n',
    )
    return 0
  }

  if (sub === 'switch') {
    const to = values.to
    if (to === undefined || to === '') {
      process.stderr.write('用法：dse release switch --to <版本 id | __source__> [--by <谁>]\n')
      return 2
    }
    const previous = await readPointer(paths.pointerFile)
    const next = switchRelease(previous, to, { updatedBy: values.by ?? 'manual' })
    if (to !== SOURCE_RELEASE) {
      const dir = releaseCodeDir(paths, to, repo)
      if (!(await pathExists(dir))) {
        /* 指向一个不存在的目录 = 下次启动直接失败。宁可现在拒绝。 */
        process.stderr.write(`版本目录不存在：${dir}\n`)
        return 1
      }
    }
    await writePointer(paths.pointerFile, next)
    process.stdout.write(JSON.stringify(next, null, 2) + '\n')
    return 0
  }

  if (sub === 'update') {
    const to = values.to
    if (to === undefined || to === '') {
      process.stderr.write('用法：dse release update --to <分支|标签|sha> [--repo <目录>]\n')
      return 2
    }
    const outcome = await prepareRelease({ repo, to, env: process.env })
    for (const step of outcome.steps) process.stdout.write(`  · ${step}\n`)
    process.stdout.write(JSON.stringify(outcome, null, 2) + '\n')
    return outcome.ok ? 0 : 1
  }

  if (sub === 'status') {
    const pointer = await readPointer(paths.pointerFile)
    const mine = currentCodeFingerprint()
    const lines = [
      `仓库：      ${repo}`,
      `releases：  ${paths.root}`,
      `指针文件：  ${paths.pointerFile}`,
      `本进程指纹：${mine ?? '(算不出来)'}`,
    ]
    if (pointer === undefined) {
      lines.push('指针：      （没有 —— 开发机形态，直接跑仓库工作区）')
    } else {
      const dir = releaseCodeDir(paths, pointer.release, repo)
      const exists = await releaseLooksRunnable(dir)
      const everConnected = (pointer.lastConnectedAtMs ?? 0) >= pointer.updatedAtMs
      lines.push(
        `指针：      ${pointer.release}${pointer.release === mine ? '（就是本进程）' : ''}`,
        `代码目录：  ${dir}${exists ? '' : '  ← 不存在！下次启动会失败'}`,
        `上一版：    ${pointer.previous ?? '(无)'}`,
        `曾连上 Hub：${everConnected ? '是' : '否'}`,
        `崩溃计数：  ${pointer.failedStarts ?? 0}`,
        `最后改动：  ${pointer.updatedBy ?? '?'} @ ${new Date(pointer.updatedAtMs).toISOString()}`,
      )
    }
    process.stdout.write(lines.join('\n') + '\n')
    return 0
  }

  process.stderr.write(`未知子命令：release ${sub}\n`)
  return 2
}

/* ────────────────────────────── rpc / identity ────────────────────────────── */

async function runRpc(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      hub: { type: 'string' },
      identity: { type: 'string' },
      token: { type: 'string' },
      scopes: { type: 'string' },
      'client-id': { type: 'string' },
      'params-file': { type: 'string' },
      'idempotency-key': { type: 'string' },
      home: { type: 'string' },
      verbose: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  })

  const method = positionals[0]
  if (method === undefined || values.hub === undefined) {
    process.stderr.write('用法：dse rpc <method> [params-json | --params-file <file>] --hub <ws-url>\n')
    return 2
  }

  // 参数既可以直接给 JSON，也可以从文件读。
  // 文件路径不是多余的：PowerShell 在把参数交给原生程序时会吞掉内嵌的引号，
  // 所以 Windows 上用行内 JSON 几乎必然出问题，而写文件再读则永远可靠，
  // 同时这也是脚本化的正常做法。
  const params =
    values['params-file'] === undefined
      ? positionals[1] === undefined
        ? {}
        : (JSON.parse(positionals[1]) as unknown)
      : (JSON.parse(await readTextFile(expandHome(values['params-file']))) as unknown)
  const identityFile =
    values.identity ?? path.join(dseHome(values.home), 'cli', 'identity.json')
  const tokenFile = path.join(path.dirname(identityFile), 'token.json')

  // 令牌是**一次性领取**的（见 devices.ts 的 claimToken），因此必须持久化：
  // 不存的话每次 `dse rpc` 都是"已配对但没令牌"，而令牌已经领过了、拿不回来。
  const saved = await readJsonFile<{ token?: string }>(tokenFile, {})
  const token = values.token ?? saved.token

  const client = await HubClient.create({
    identityFile,
    url: values.hub,
    role: 'operator',
    scopes: parseScopes(
      values.scopes,
      'employee.read,employee.prompt,employee.invoke,device.pair,approval.resolve,employee.manage,node.admin',
    ),
    clientId: values['client-id'] ?? 'dse-cli',
    displayName: 'CLI',
    verbose: values.verbose === true,
    autoReconnect: false,
    ...(token === undefined ? {} : { token }),
  })

  client.on('deviceToken', ({ token: issued }) => {
    void writeJsonFile(tokenFile, { token: issued, savedAtMs: Date.now() })
  })

  client.on('handshakeFailed', (error) => {
    if (error.code === 'pairing-required') {
      const requestId = (error.details as { requestId?: string } | undefined)?.requestId
      process.stderr.write(
        `\n本设备尚未配对。请在 Hub 本机执行：\n  dse pair approve ${requestId ?? '<requestId>'}\n然后重跑本条命令。\n\n`,
      )
    }
  })

  try {
    await client.connect()
    // 一次性命令的语义是"这是一次新的意图"，因此默认生成一个新键。
    // 需要重放同一次意图（例如超时后重试）时用 --idempotency-key 显式指定。
    const idempotencyKey = values['idempotency-key'] ?? randomUUID()
    const result = await client.call(method, params, { idempotencyKey })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  } finally {
    client.close()
  }
}

async function runIdentity(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { identity: { type: 'string' }, home: { type: 'string' } },
    allowPositionals: false,
  })
  const file = values.identity ?? path.join(dseHome(values.home), 'cli', 'identity.json')
  const identity = await loadOrCreateIdentity(file, 'device', 'CLI')
  process.stdout.write(
    [
      '',
      `身份文件  ${file}`,
      `指纹      ${identity.deviceId}`,
      `公钥      ${identity.publicKey}`,
      `创建时间  ${new Date(identity.createdAtMs).toISOString()}`,
      '',
    ].join('\n'),
  )
  return 0
}

/* ────────────────────────────── 辅助 ────────────────────────────── */

function waitForShutdown(onShutdown: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    let shuttingDown = false
    const shutdown = (signal: string): void => {
      if (shuttingDown) return
      shuttingDown = true
      process.stdout.write(`\n收到 ${signal}\n`)
      void onShutdown().finally(() => resolve())
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
  })
}

const exitCode = await main(process.argv.slice(2))
if (exitCode !== 0) process.exit(exitCode)
