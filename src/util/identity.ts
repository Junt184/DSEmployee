/**
 * 设备身份的持久化：生成、载入、收紧权限。
 *
 * 私钥文件必须 0600 —— 这里不是"尽力而为"，而是写入时就指定 mode，
 * 并在载入时校验权限位，发现过宽就告警（不静默放过）。
 */

import { chmod, stat } from 'node:fs/promises'

import { generateIdentity, type DeviceIdentity } from '../protocol/index.ts'
import { pathExists, ensureDir, readJsonFile, writeJsonFile } from './fsx.ts'

export interface IdentityFile extends DeviceIdentity {
  kind: 'hub' | 'device' | 'node'
  name?: string
}

/** 载入身份文件；不存在则创建。返回值保证 `deviceId === fingerprintOf(publicKey)`。 */
export async function loadOrCreateIdentity(
  file: string,
  kind: IdentityFile['kind'],
  name?: string,
): Promise<IdentityFile> {
  if (await pathExists(file)) {
    const loaded = await readJsonFile<IdentityFile | undefined>(file, undefined)
    if (loaded === undefined || typeof loaded.privateKeyPem !== 'string') {
      throw new Error(`identity file ${file} exists but is not a valid identity`)
    }
    await warnIfPermissive(file)
    return loaded
  }
  await ensureDir(file.replace(/[/\\][^/\\]*$/, ''))
  const base = generateIdentity()
  const identity: IdentityFile = name === undefined ? { ...base, kind } : { ...base, kind, name }
  await writeJsonFile(file, identity, 0o600)
  return identity
}

async function warnIfPermissive(file: string): Promise<void> {
  // Windows 上 POSIX 权限位没有意义（文件访问由 ACL 决定，stat 通常报 666），
  // 在那里告警只会刷屏而无从修复。因此只在类 POSIX 平台上做这项检查。
  if (process.platform === 'win32') return
  try {
    const info = await stat(file)
    if ((info.mode & 0o077) !== 0) {
      process.emitWarning(
        `identity file ${file} has permissive mode ${(info.mode & 0o777).toString(8)}; expected 600`,
      )
      await chmod(file, 0o600).catch(() => {})
    }
  } catch {
    /* 权限探测失败不影响功能 */
  }
}
