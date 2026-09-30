/**
 * dsh 进程托管 —— 终端节点负责把本机的 dsh 实例拉起来并看着它。
 *
 * 为什么由我们托管而不是让用户手动开：
 *   1. 员工宿主必须知道 dsh 的确切端口才能驱动 `/api`；
 *   2. dsh 崩溃后如果没人重启，员工就"死了"，而用户在手机上完全看不到原因；
 *   3. `DSH_HOME` 必须由我们掌控 —— 一台机器上跑多个隔离实例时那是唯一的隔离手段。
 *
 * 崩溃策略：指数退避重启，但**不掩盖失败** —— 每次重启都记录，
 * 连续快速失败超过阈值就停止重启并把状态标为 `failed`，让上层如实上报"这个节点不健康"。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'

import { ensureDir } from '../util/fsx.ts'
import { DshClient } from './dsh-client.ts'

export interface DshProcessOptions {
  /** dsh 可执行文件。默认用 PATH 里的 `dsh`。 */
  command?: string
  /** 额外参数（例如 `['--trusted-host', 'app.internal']`） */
  extraArgs?: string[]
  /** 传给子进程的环境变量（至少要有 DSH_HOME） */
  env?: Record<string, string>
  /** 期望端口；0 表示让 dsh 自己选，然后从输出里解析 */
  port?: number
  /** 工作目录（dsh 会把它当作默认 workspace 根） */
  cwd: string
  /** 调试日志 */
  verbose?: boolean
  /** 连续失败多少次后放弃重启 */
  maxConsecutiveFailures?: number
  /**
   * 是否捕获子进程的 stdout/stderr（默认：**仅在需要从输出里解析端口时才捕获**）。
   *
   * 为什么要有这个开关：捕获输出意味着用**管道 stdio**，而管道在受限环境里
   * 可能被禁止（本机沙箱下 `spawn` 直接 EPERM）。更根本的是，
   * 靠抓取 dsh 打印的 `dsh web: http://127.0.0.1:PORT` 这一行来得知端口是**脆弱**的 ——
   * 它把我们的启动逻辑绑死在别人的日志格式上。
   *
   * 因此：**给了显式端口就不捕获**（用 `inherit`，日志照样打在控制台），
   * 只有端口为 0（让 OS 选）时才不得不解析输出。
   */
  captureOutput?: boolean
}

export interface DshProcessEvents {
  ready: [{ port: number; url: string }]
  exit: [{ code: number | null; signal: string | null; willRestart: boolean }]
  stdout: [string]
  stderr: [string]
  failed: [{ reason: string }]
}

export class DshProcess extends EventEmitter<DshProcessEvents> {
  readonly #options: Required<Pick<DshProcessOptions, 'command' | 'cwd' | 'maxConsecutiveFailures'>> &
    DshProcessOptions
  #child: ChildProcessWithoutNullStreams | undefined
  #port: number | undefined
  #stopping = false
  #failures = 0
  #restartTimer: NodeJS.Timeout | undefined

  constructor(options: DshProcessOptions) {
    super()
    // 注意顺序：先展开调用方给的选项，再用默认值兜底。
    // 反过来写会把未提供的字段覆盖成 undefined（这是个很容易犯的错）。
    this.#options = {
      ...options,
      command: options.command ?? 'dsh',
      maxConsecutiveFailures: options.maxConsecutiveFailures ?? 5,
    }
  }

  get port(): number | undefined {
    return this.#port
  }

  get running(): boolean {
    return this.#child !== undefined && this.#child.exitCode === null
  }

  /** 拉起 dsh 并等待它就绪。就绪后返回实际端口。 */
  async start(): Promise<number> {
    if (this.running) throw new Error('dsh process is already running')
    await ensureDir(this.#options.cwd)

    const requestedPort = this.#options.port ?? 0
    // 只有"让 OS 选端口"时才必须读 stdout 去解析端口；给了显式端口就不捕获。
    const capture = this.#options.captureOutput ?? requestedPort === 0

    const args = [
      '--profile',
      'web',
      '--port',
      String(requestedPort),
      ...(this.#options.extraArgs ?? []),
    ]

    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.#options.env ?? {}) }
    // 让 dsh 输出纯文本，便于解析 URL 行
    env['NO_COLOR'] = '1'

    this.#log(
      `starting: ${this.#options.command} ${args.join(' ')}` +
        (capture ? '' : '（端口已显式指定，不捕获输出）'),
    )
    const child = spawn(this.#options.command, args, {
      cwd: this.#options.cwd,
      env,
      // Windows 上 dsh 的入口是 .cmd 垫片，需要 shell 才能解析。
      // 参数全部来自我们自己的配置（可执行文件名、端口、额外 flag），不含用户输入。
      shell: process.platform === 'win32',
      windowsHide: true,
      // 不捕获时用 inherit：日志照样打到控制台，且不占用管道
      //（受限环境下管道可能被禁，管道的 spawn 会直接 EPERM）。
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    }) as ChildProcessWithoutNullStreams

    this.#child = child

    const ready = new Promise<number>((resolve, reject) => {
      let settled = false

      if (capture) {
        const onLine = (line: string, isErr: boolean): void => {
          this.#emitLine(line, isErr)
          // dsh 就绪时会打印一行形如：dsh web: http://127.0.0.1:52850
          const match = /https?:\/\/[^\s]*?:(\d+)/.exec(line)
          if (!settled && match?.[1] !== undefined) {
            settled = true
            resolve(Number.parseInt(match[1], 10))
          }
        }
        bufferLines(child.stdout, (line) => onLine(line, false))
        bufferLines(child.stderr, (line) => onLine(line, true))
      } else {
        // 端口已知，不必猜；真正的就绪判定交给下面的 #waitForApi
        settled = true
        resolve(requestedPort)
      }

      child.once('error', (error) => {
        if (!settled) {
          settled = true
          reject(error)
        }
      })
      child.once('exit', (code, signal) => {
        if (!settled) {
          settled = true
          reject(
            new Error(
              `dsh exited before becoming ready (code=${code ?? 'null'} signal=${signal ?? 'null'})`,
            ),
          )
        }
      })
    })

    child.once('exit', (code, signal) => {
      this.#child = undefined
      this.#onExit(code, signal)
    })

    try {
      this.#port = await ready
    } catch (error) {
      this.#failures += 1
      throw error
    }

    // 打印出 URL 只说明它开始监听了；再用一次真实调用确认 `/api` 能应答
    await this.#waitForApi(this.#port)
    this.#failures = 0
    this.emit('ready', { port: this.#port, url: `http://127.0.0.1:${this.#port}` })
    this.#log(`dsh ready on port ${this.#port}`)
    return this.#port
  }

  /**
   * 停止托管的 dsh。
   *
   * ⚠️ 这里有一个**极易踩的坑**，本项目实测踩过：
   * Windows 上必须用 `shell: true` 才能启动 `dsh.cmd`，于是我们手上的 `child` 其实是
   * **cmd.exe**，真正的 dsh 是它的子进程。`child.kill()` 只杀掉 cmd.exe，
   * dsh 便成为**孤儿继续存活、继续占用端口** —— 更糟的是 `exit` 事件照样会触发，
   * 日志会写下"dsh exited"，给出一个**假成功信号**。
   *
   * 后果不只是漏一个进程：同一个 DSH_HOME 上留下两个活的 dsh 实例时，
   * 它们会同时读写 `storages/*.json` 等状态文件而互相覆盖。
   *
   * 因此：① Windows 上用 `taskkill /T` 杀**整棵进程树**；
   * ② 不信任 `exit` 事件，改为**确认端口真的不再监听** —— 端口才是我们真正在意的事实。
   */
  async stop(): Promise<void> {
    this.#stopping = true
    if (this.#restartTimer !== undefined) clearTimeout(this.#restartTimer)

    const child = this.#child
    const port = this.#port

    if (child?.pid !== undefined) {
      if (process.platform === 'win32') {
        // /T 连子进程一起杀，/F 强制。Windows 上唯一可靠的进程树终止方式。
        await runQuiet('taskkill', ['/PID', String(child.pid), '/T', '/F'])
      } else {
        child.kill('SIGTERM')
        await sleep(1_500)
        if (child.exitCode === null) child.kill('SIGKILL')
      }
    }

    this.#child = undefined

    // 以"端口是否还给系统了"作为真正的成功判据
    if (port !== undefined) {
      const released = await waitForPortRelease(port, 10_000)
      this.#port = undefined
      if (released) {
        this.#log(`已停止，端口 ${port} 已释放`)
      } else {
        this.#log(
          `警告：端口 ${port} 在停止后仍被占用 —— 可能有残留的 dsh 进程。` +
            `请手动检查并结束它（Windows: taskkill /PID <pid> /T /F）。` +
            `留着它的风险是：同一 DSH_HOME 上两个 dsh 实例会互相覆盖状态文件。`,
        )
      }
    }
  }

  async #onExit(code: number | null, signal: string | null): Promise<void> {
    if (this.#stopping) {
      this.emit('exit', { code, signal, willRestart: false })
      return
    }
    this.#failures += 1
    const willRestart = this.#failures <= this.#options.maxConsecutiveFailures
    this.emit('exit', { code, signal, willRestart })
    this.#log(
      `dsh exited (code=${code ?? 'null'} signal=${signal ?? 'null'}); restart=${willRestart} failure#${this.#failures}`,
    )

    if (!willRestart) {
      this.emit('failed', {
        reason: `dsh exited ${this.#failures} times in a row; giving up so the node can report an honest unhealthy state`,
      })
      return
    }

    // 指数退避，上限 30 秒 —— 崩溃循环时不要打满 CPU
    const delayMs = Math.min(1_000 * 2 ** (this.#failures - 1), 30_000)
    this.#restartTimer = setTimeout(() => {
      void this.start().catch((error: unknown) => {
        this.#log(`restart attempt failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, delayMs)
    this.#restartTimer.unref?.()
  }

  /** 轮询直到 `/api` 真的能应答，或超时。 */
  async #waitForApi(port: number, timeoutMs = 30_000): Promise<void> {
    const client = new DshClient({ port, timeoutMs: 5_000 })
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        await client.hostDescribe()
        return
      } catch (error) {
        lastError = error
        await sleep(250)
      }
    }
    throw new Error(
      `dsh did not answer host.describe within ${timeoutMs}ms: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    )
  }

  #emitLine(line: string, isErr: boolean): void {
    this.emit(isErr ? 'stderr' : 'stdout', line)
    if (this.#options.verbose === true) {
      process.stdout.write(`[dsh${isErr ? ':err' : ''}] ${line}\n`)
    }
  }

  #log(message: string): void {
    process.stdout.write(`[dsh-process] ${message}\n`)
  }
}

/** 按行切分一个流并逐行回调（不依赖 readline，避免引入额外生命周期）。 */
function bufferLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = ''
  stream.setEncoding?.('utf8')
  stream.on('data', (chunk: string | Buffer) => {
    buffer += chunk.toString()
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line.trim() !== '') onLine(line)
      index = buffer.indexOf('\n')
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 安静地执行一个命令：不捕获输出、忽略失败。
 *
 * 专为"清理"这类动作设计 —— 我们要的是副作用（比如杀掉进程树），
 * 而不是它的输出或退出码；失败也不该抛，因为清理失败会在后续的端口检查里被发现。
 */
async function runQuiet(command: string, args: string[]): Promise<void> {
  const { spawn } = await import('node:child_process')
  await new Promise<void>((resolve) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
      child.once('exit', () => resolve())
      child.once('error', () => resolve())
    } catch {
      resolve()
    }
  })
}

/** 端口当前是否有进程在监听。 */
async function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  const { createConnection } = await import('node:net')
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host })
    const finish = (listening: boolean): void => {
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(1_000)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

/**
 * 轮询直到端口不再被监听。返回是否已释放。
 *
 * 用"端口"而不是"进程退出"作为判据，是因为**端口才是我们真正在意的事实**：
 * 它决定了下一个 dsh 实例能不能正常工作、以及是否还有另一个实例在并发写同一个 DSH_HOME。
 * 而 Windows 上 `shell: true` 会让"子进程退出"这件事变得不可靠（见 `stop()` 的注释）。
 */
async function waitForPortRelease(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isPortListening(port))) return true
    await sleep(250)
  }
  return !(await isPortListening(port))
}
