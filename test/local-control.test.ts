/** Hub 本机 RPC：回环绑定 + 单用途白名单 + 随机 token。 */
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { callHubLocalControl, localControlDescriptorFile, startHubLocalControl } from '../src/hub/local-control.ts'

let temp = ''
let stateDir = ''
let stopped: { close: () => Promise<void> } | undefined
let handled = 0

before(async () => {
  temp = await mkdtemp(path.join(process.cwd(), '.tmp-local-control-'))
  stateDir = path.join(temp, 'hub')
  stopped = await startHubLocalControl(stateDir, async (method, params) => {
    handled += 1
    return { method, params, handled }
  })
})

after(async () => {
  await stopped?.close()
  await rm(temp, { recursive: true, force: true })
})

interface Descriptor { host: string; port: number; token: string }

async function descriptor(): Promise<Descriptor> {
  return JSON.parse(await readFile(localControlDescriptorFile(stateDir), 'utf8')) as Descriptor
}

async function sendRaw(request: unknown): Promise<Record<string, unknown>> {
  const address = await descriptor()
  return await new Promise((resolve, reject) => {
    const socket = connect(address.port, address.host)
    socket.setEncoding('utf8')
    let output = ''
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', (chunk: string) => {
      output += chunk
      const end = output.indexOf('\n')
      if (end < 0) return
      socket.destroy()
      try {
        resolve(JSON.parse(output.slice(0, end)) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    socket.once('error', reject)
  })
}

describe('Hub local control', () => {
  it('通过本机通道调用允许的方法，并把处理结果返回', async () => {
    const result = await callHubLocalControl(stateDir, 'pairing.window', { source: 'test' }) as Record<string, unknown>
    assert.equal(result['method'], 'pairing.window')
    assert.deepEqual(result['params'], { source: 'test' })
    assert.equal(result['handled'], 1)
  })

  it('拒绝未授权 token，且拒绝通用 RPC 方法', async () => {
    const details = await descriptor()
    const denied = await sendRaw({ token: '0'.repeat(details.token.length), method: 'pairing.window.set', params: { open: true } })
    assert.equal(denied['ok'], false)
    assert.match(String(denied['error']), /authentication failed/)

    await assert.rejects(() => callHubLocalControl(stateDir, 'device.token.rotate', {}), /not allowed/)
    assert.equal(handled, 1, '认证失败或白名单外的方法不得进入业务 handler')
  })

  it('本机 RPC 描述文件仅当前账户可读，监听仅绑定回环地址', async () => {
    const details = await descriptor()
    assert.equal(details.host, '127.0.0.1')
    if (process.platform === 'win32') return
    const descriptorMode = (await stat(localControlDescriptorFile(stateDir))).mode & 0o777
    assert.equal(descriptorMode & 0o077, 0)
  })
})
