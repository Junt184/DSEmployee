/**
 * 启动脚本的配置来源守卫：**公开仓库里不许出现某个运营者的 Hub 地址**。
 *
 * 为什么值得一条独立测试：`scripts/start-node.ps1` 与 `scripts/run-node.sh` 是随仓库
 * 发布的稳定启动器，而它们必须知道 Hub 地址。最省事的写法就是把它写成字面量 ——
 * 于是**一个运营者的部署域名会随仓库发给每个 clone 的人**（这真的发生过，见本文件的
 * 断言）。而写成占位符同样不行：已经部署的机器在启动器进程下次重启时会连不上，
 * 而启动器只在开机/崩溃时才重启 —— 故障会在几天后的一次重启里突然出现。
 *
 * 定下来的契约（写的人与读的人各占一半，所以必须一起测）：
 *   · 节点启动时把 `--hub` 的值写到 `$DSE_HOME/hub-url`（src/node/agent.ts 的
 *     `writeHubUrlFile`）—— 地址本来就只有节点自己知道；
 *   · 启动器按 `$env:DSE_HUB` → `<DSE_HOME>/hub-url` 的顺序读回来，读不到就
 *     **明确报错退出**，绝不猜一个默认值。
 *   · 两边的文件名必须是同一个常量，否则会静默地"各写各的、各读各的"。
 *
 * 还有一条兜底：全仓（发布面）扫描 `ws://` / `wss://` 后面的主机名，
 * 只允许环回与 RFC 2606/6761 的保留域名（example / test / invalid / localhost）
 * 以及模板占位。谁以后再把生产地址写进去，这条会指名道姓地拦下来。
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, it } from 'node:test'
import path from 'node:path'
import { promisify } from 'node:util'

import { HUB_URL_FILE, writeHubUrlFile } from '../src/node/agent.ts'

const run = promisify(execFile)

const ROOT = path.join(import.meta.dirname, '..')
const PS1 = path.join(ROOT, 'scripts', 'start-node.ps1')
const SH = path.join(ROOT, 'scripts', 'run-node.sh')

/* ────────────────────── 发布面扫描：真地址不许进仓库 ────────────────────── */

/** 参与扫描的目录（只扫随仓库发布的东西；docs/ 等未跟踪目录不在此列）。 */
const SCAN_DIRS = ['src', 'scripts', 'bin', 'test', 'design']
const SCAN_EXT = new Set(['.ts', '.mjs', '.js', '.sh', '.ps1', '.md', '.json', '.yml', '.yaml'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (SCAN_EXT.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

/** 环回，或 RFC 2606/6761 保留域名 —— 这些怎么用都不指向任何人的生产环境。 */
function isPlaceholderHost(host: string): boolean {
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)$/.test(host)) return true
  return /(\.example\.(com|net|org)|\.example|\.test|\.invalid|\.localhost)$/.test(host)
}

/** 文本里"看起来是真地址"的 WS 主机（行号 + 原文，便于直接改）。 */
function realHubHosts(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/wss?:\/\/([^\s/'"`)\]}]+)/g)) {
    const authority = match[1] ?? ''
    // 模板占位（${host}）、文档占位（<服务器IP>、…）都不是真地址
    if (/[<>${}*…]/.test(authority)) continue
    // 主机名字符集之外的东西（中文、全角符号等）同样是占位
    if (!/^[A-Za-z0-9.\-:[\]]+$/.test(authority)) continue
    const host = authority.replace(/:\d+$/, '').toLowerCase()
    if (isPlaceholderHost(host)) continue
    const line = text.slice(0, match.index).split('\n').length
    found.push(`${line}: ${authority}`)
  }
  return found
}

describe('启动脚本：Hub 地址只能来自本机，不许写进公开仓库', () => {
  it('start-node.ps1 里没有任何真实 Hub 地址', () => {
    const text = readFileSync(PS1, 'utf8')
    assert.deepEqual(realHubHosts(text), [], '启动脚本里出现了真实地址：')
  })

  it('run-node.sh 里没有任何真实 Hub 地址', () => {
    const text = readFileSync(SH, 'utf8')
    assert.deepEqual(realHubHosts(text), [], '启动脚本里出现了真实地址：')
  })

  it('两个启动器都按「$DSE_HUB → <DSE_HOME>/hub-url → 报错退出」解析地址', () => {
    const ps1 = readFileSync(PS1, 'utf8')
    assert.match(ps1, /\$env:DSE_HUB/, 'Windows 启动器要认环境变量')
    assert.match(ps1, /Join-Path \$DseHome 'hub-url'/, 'Windows 启动器要认本机那份 hub-url')
    assert.match(ps1, /hub URL not configured[\s\S]*throw|throw[\s\S]*hub URL not configured/, '读不到必须报错，不许猜')

    const sh = readFileSync(SH, 'utf8')
    assert.match(sh, /DSE_HUB/, 'POSIX 启动器要认环境变量')
    assert.match(sh, /hub-url/, 'POSIX 启动器要认本机那份 hub-url')
    assert.match(sh, /set -- --hub "\$HUB_URL" "\$@"/, 'POSIX 启动器要把读到的地址补成 --hub（显式传入的优先）')
  })

  it('文件名是同一个常量 —— 写的人与读的人不会各写各的', () => {
    assert.equal(HUB_URL_FILE, 'hub-url')
    for (const file of [PS1, SH]) {
      assert.ok(readFileSync(file, 'utf8').includes(HUB_URL_FILE), `${file} 读的名字与常量不一致`)
    }
  })

  it('全发布面扫描：除环回与保留域名外，没有任何 ws:// / wss:// 真实主机', () => {
    const offenders: string[] = []
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        for (const hit of realHubHosts(readFileSync(file, 'utf8'))) {
          offenders.push(`${path.relative(ROOT, file)}:${hit}`)
        }
      }
    }
    /* README 里的 `ws://<服务器IP>:19790/ws` 是占位（尖括号），会被上面的规则放过 ——
       这条断言拦的是"写成了真的"。 */
    assert.deepEqual(offenders, [], '这些文件里写着真实 Hub 地址：')
  })
})

describe('writeHubUrlFile：节点把地址落在本机', () => {
  it('写一行、去掉首尾空白、权限 0600', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dse-huburl-'))
    try {
      await writeHubUrlFile(home, '  wss://hub.example.test/ws  ')
      const file = path.join(home, HUB_URL_FILE)
      assert.equal(readFileSync(file, 'utf8'), 'wss://hub.example.test/ws\n')
      const mode = (await stat(file)).mode & 0o777
      assert.equal(mode, 0o600, '本机配置也按 0600 落盘')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('重复写是覆盖，不会追加成多行（启动器只读第一行，但多行本身就是脏状态）', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dse-huburl-'))
    try {
      await writeHubUrlFile(home, 'ws://127.0.0.1:19791/ws')
      await writeHubUrlFile(home, 'wss://hub.example.test/ws')
      assert.equal(readFileSync(path.join(home, HUB_URL_FILE), 'utf8'), 'wss://hub.example.test/ws\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('空地址直接抛错，不能写出一份"看似有配置"的空文件', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dse-huburl-'))
    try {
      await assert.rejects(() => writeHubUrlFile(home, '   '), /empty/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('run-node.sh：地址解析真的跑得通（用 NODE_BIN 桩替换 node）', () => {
  /** 一个把 argv 打出来的 node 替身；退出码 0 让启动器"干净退出"，不进入重试循环。 */
  function makeStub(dir: string): string {
    const stub = path.join(dir, 'node-stub.sh')
    writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$@"\n', 'utf8')
    chmodSync(stub, 0o755)
    return stub
  }

  it('没传 --hub 时，从 <DSE_HOME>/hub-url 读出来并补成 --hub', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dse-runnode-'))
    try {
      const dseHome = path.join(dir, 'dse-home')
      await mkdir(dseHome, { recursive: true })
      await writeHubUrlFile(dseHome, 'wss://hub.example.test/ws')
      const { stdout } = await run('sh', [SH, '--name', 'probe', '--employee-root', dir], {
        env: { ...process.env, NODE_BIN: makeStub(dir), DSE_HOME: dseHome, DSE_RELEASES: path.join(dir, 'rel') },
      })
      const args = stdout.split('\n')
      const at = args.indexOf('--hub')
      assert.ok(at >= 0, '启动器没有把 hub-url 补成 --hub：' + stdout)
      assert.equal(args[at + 1], 'wss://hub.example.test/ws')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('显式 --hub 优先于本机那份文件（命令行仍然是最高优先级）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dse-runnode-'))
    try {
      const dseHome = path.join(dir, 'dse-home')
      await mkdir(dseHome, { recursive: true })
      await writeHubUrlFile(dseHome, 'wss://hub.example.test/ws')
      const { stdout } = await run(
        'sh',
        [SH, '--hub', 'ws://127.0.0.1:19791/ws', '--name', 'probe', '--employee-root', dir],
        { env: { ...process.env, NODE_BIN: makeStub(dir), DSE_HOME: dseHome, DSE_RELEASES: path.join(dir, 'rel') } },
      )
      const hubs = stdout.split('\n').filter((line) => line.startsWith('ws'))
      assert.deepEqual(hubs, ['ws://127.0.0.1:19791/ws'], '--hub 必须原样传下去，且不能重复注入')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('两处都没有地址时，明确退出 2 并说清去哪儿写 —— 不猜默认值', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dse-runnode-'))
    try {
      const dseHome = path.join(dir, 'empty-home')
      await mkdir(dseHome, { recursive: true })
      await assert.rejects(
        () =>
          run('sh', [SH, '--name', 'probe', '--employee-root', dir], {
            env: { ...process.env, NODE_BIN: makeStub(dir), DSE_HOME: dseHome, DSE_RELEASES: path.join(dir, 'rel') },
          }),
        (error: unknown) => {
          const e = error as { code?: number; stderr?: string }
          assert.equal(e.code, 2)
          assert.match(String(e.stderr), /no hub address on this machine/)
          assert.match(String(e.stderr), /hub-url/)
          return true
        },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/* 目录扫描的一次性自检：路径算错会让上面那条"全发布面扫描"变成永远通过的空断言。 */
it('扫描范围自检：确实扫到了多个文件（否则守卫是假的）', () => {
  const files = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)))
  assert.ok(files.length > 50, '扫描到的文件太少，路径可能算错了：' + files.length)
  assert.ok(files.includes(PS1) && files.includes(SH), '两个启动器都必须在扫描范围内')
  assert.ok(statSync(PS1).isFile())
})
