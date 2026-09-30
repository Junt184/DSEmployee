/**
 * 测试辅助构造器。
 *
 * 把这些放进独立文件而不是塞在测试里：它们描述的是**数据形状**，
 * 形状一旦变化（例如给 `PairingRequest` 加字段），只需改这里一处。
 */

import type { PairingRequest } from '../src/hub/types.ts'

let counter = 0

/** 造一条已经过期的待配对请求。 */
export function makeExpiredPending(requestId: string, ttlMs: number): PairingRequest {
  counter += 1
  const now = Date.now()
  return {
    requestId,
    deviceId: counter.toString(16).padStart(64, '0'),
    publicKey: 'AAAA',
    role: 'operator',
    scopes: ['employee.read'],
    platform: 'test',
    clientId: 'test',
    requestedAtMs: now - ttlMs * 2,
    expiresAtMs: now - 1000,
    fromLoopback: true,
    remoteIp: '127.0.0.1',
  }
}
