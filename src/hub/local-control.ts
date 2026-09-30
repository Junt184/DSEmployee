/**
 * Hub 本机控制通道。
 *
 * 只暴露少数救援/管理操作给同一台机器上的 CLI，不开放通用 RPC，也不绑定到外部网卡。
 * 使用随机本机 TCP 端口（仅绑定 127.0.0.1）+ 状态目录内 0600 的 256-bit token 描述文件。
 * 这条通道与 WS 设备身份无关，因此浏览器 cookie 丢失时，Hub 主机上的 CLI 仍能救援。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { stat } from 'node:fs/promises'
import path from 'node:path'

import { ensureDir, readJsonFile, removeFile, writeJsonFile } from '../util/fsx.ts'

const MAX_LINE_CHARS = 64 * 1024
const LOCAL_METHODS = new Set(['pairing.window', 'pairing.window.set'])
const DESCRIPTOR_FILE = 'local-control.json'

type LocalControlRequest = { token: string; method: string; params?: unknown }
type LocalControlResponse = { ok: true; result: unknown } | { ok: false; error: string }
type LocalControlDescriptor = { host: '127.0.0.1'; port: number; token: string }
export type LocalControlHandler = (method: string, params: unknown) => Promise<unknown>

export interface LocalControlServer {
  close(): Promise<void>
}

export function localControlDescriptorFile(stateDir: string): string {
  return path.join(stateDir, DESCRIPTOR_FILE)
}

function sameToken(expected: string, actual: string): boolean {
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.length === right.length && timingSafeEqual(left, right)
}

function writeResponse(socket: Socket, response: LocalControlResponse): void {
  if (socket.destroyed) return
  socket.end(JSON.stringify(response) + '\n')
}

export async function startHubLocalControl(stateDir: string, handler: LocalControlHandler): Promise<LocalControlServer> {
  await ensureDir(stateDir)
  const token = randomBytes(32).toString('hex')
  const descriptorFile = localControlDescriptorFile(stateDir)
  const server: Server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.setTimeout(3_000, () => socket.destroy())
    let buffer = ''
    let handled = false
    socket.on('data', (chunk: string) => {
      if (handled) return
      buffer += chunk
      if (buffer.length > MAX_LINE_CHARS) {
        handled = true
        writeResponse(socket, { ok: false, error: 'local control request too large' })
        return
      }
      const end = buffer.indexOf('\n')
      if (end < 0) return
      handled = true
      void (async () => {
        let request: LocalControlRequest
        try {
          request = JSON.parse(buffer.slice(0, end)) as LocalControlRequest
        } catch {
          writeResponse(socket, { ok: false, error: 'invalid local control request' })
          return
        }
        if (typeof request.token !== 'string' || !sameToken(token, request.token)) {
          writeResponse(socket, { ok: false, error: 'local control authentication failed' })
          return
        }
        if (!LOCAL_METHODS.has(request.method)) {
          writeResponse(socket, { ok: false, error: `local control method not allowed: ${String(request.method)}` })
          return
        }
        try {
          const result = await handler(request.method, request.params ?? {})
          writeResponse(socket, { ok: true, result })
        } catch (error) {
          writeResponse(socket, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })()
    })
  })

  let port: number
  try {
    port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        const address = server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('local control server did not receive a TCP address'))
          return
        }
        resolve(address.port)
      })
    })
    await writeJsonFile(descriptorFile, { host: '127.0.0.1', port, token } satisfies LocalControlDescriptor, 0o600)
    if (process.platform !== 'win32') {
      const mode = (await stat(descriptorFile)).mode & 0o777
      if ((mode & 0o077) !== 0) throw new Error('local control descriptor permissions are broader than 0600')
    }
  } catch (error) {
    await new Promise<void>((resolve) => {
      if (!server.listening) return resolve()
      server.close(() => resolve())
    })
    await removeFile(descriptorFile)
    throw error
  }

  let closed = false
  return {
    close: async () => {
      if (closed) return
      closed = true
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await removeFile(descriptorFile)
    },
  }
}

/**
 * 通过 Hub 本机 RPC 调用受限的管理方法。
 * 失败时抛错；调用方不得用直接写配置文件的方式绕过运行中的 Hub。
 */
export async function callHubLocalControl(stateDir: string, method: string, params: unknown = {}): Promise<unknown> {
  if (!LOCAL_METHODS.has(method)) throw new Error(`local control method not allowed: ${method}`)
  const descriptor = await readJsonFile<LocalControlDescriptor | undefined>(localControlDescriptorFile(stateDir), undefined)
  if (
    descriptor === undefined || descriptor.host !== '127.0.0.1' ||
    !Number.isInteger(descriptor.port) || descriptor.port <= 0 || descriptor.port > 65535 ||
    typeof descriptor.token !== 'string' || !/^[0-9a-f]{64}$/.test(descriptor.token)
  ) {
    throw new Error('Hub local control descriptor is missing or invalid')
  }

  return await new Promise<unknown>((resolve, reject) => {
    const socket = connect(descriptor.port, descriptor.host)
    let buffer = ''
    let settled = false
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error !== undefined) reject(error)
      else resolve(result)
    }
    const timer = setTimeout(() => finish(new Error('timed out connecting to the running Hub local control endpoint')), 3_000)
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      const request: LocalControlRequest = { token: descriptor.token, method, params }
      socket.write(JSON.stringify(request) + '\n')
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_LINE_CHARS) {
        finish(new Error('Hub local control response too large'))
        return
      }
      const end = buffer.indexOf('\n')
      if (end < 0) return
      try {
        const response = JSON.parse(buffer.slice(0, end)) as LocalControlResponse
        if (response.ok !== true) finish(new Error(response.error || 'Hub local control request failed'))
        else finish(undefined, response.result)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.once('error', (error) => finish(error))
    socket.once('end', () => {
      if (!settled) finish(new Error('Hub closed the local control connection without a response'))
    })
  })
}
