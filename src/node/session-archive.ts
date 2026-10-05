import path from 'node:path'
import { readJsonFile, writeJsonFile } from '../util/fsx.ts'

type ArchiveFile = { version: 1; sessions: Array<{ sessionId: string; archivedAtMs: number }> }

/** 归档只维护列表元数据，不删除 dsh 会话、消息或模型选择。 */
export class SessionArchiveStore {
  readonly #writes = new Map<string, Promise<unknown>>()

  async list(workspacePath: string): Promise<Map<string, number>> {
    const file = await this.#read(workspacePath)
    return new Map(file.sessions.map(row => [row.sessionId, row.archivedAtMs]))
  }

  async set(workspacePath: string, sessionId: string, archived: boolean): Promise<number | undefined> {
    const key = path.resolve(workspacePath)
    const previous = this.#writes.get(key) ?? Promise.resolve()
    const writing = previous.catch(() => undefined).then(async () => {
      const file = await this.#read(key)
      const existing = file.sessions.find(row => row.sessionId === sessionId)
      if (archived && existing !== undefined) return existing.archivedAtMs
      if (!archived && existing === undefined) return undefined
      file.sessions = file.sessions.filter(row => row.sessionId !== sessionId)
      const atMs = archived ? Date.now() : undefined
      if (atMs !== undefined) file.sessions.push({ sessionId, archivedAtMs: atMs })
      await writeJsonFile(this.#file(key), file)
      return atMs
    })
    this.#writes.set(key, writing)
    try { return await writing }
    finally { if (this.#writes.get(key) === writing) this.#writes.delete(key) }
  }

  #file(workspacePath: string): string {
    return path.join(workspacePath, '.dsemployee', 'session-archives.json')
  }

  async #read(workspacePath: string): Promise<ArchiveFile> {
    const file = await readJsonFile<ArchiveFile>(this.#file(workspacePath), { version: 1, sessions: [] })
    if (file === null || typeof file !== 'object' || file.version !== 1 || !Array.isArray(file.sessions) ||
        file.sessions.some(row => row === null || typeof row !== 'object' ||
          typeof row.sessionId !== 'string' || row.sessionId === '' ||
          typeof row.archivedAtMs !== 'number' || !Number.isFinite(row.archivedAtMs) || row.archivedAtMs < 0)) {
      throw new Error('会话归档记录格式不正确，未修改已有记录')
    }
    return file
  }
}
