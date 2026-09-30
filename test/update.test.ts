/**
 * 升级执行器（`prepareRelease`）—— 把某个提交落地成一个可运行的版本目录。
 *
 * 这一组用**注入的执行器**跑：不真的 git/npm，但每一步的顺序、失败时"保持现状"
 * 的语义、以及"失败品不留下来"这些**决策**都被钉住。真机上的 git/npm 行为由
 * Mac 上的实跑验收（见 docs/05 §16）。
 *
 * 最要紧的三条不变量：
 *   ① 任何一步失败 ⇒ 指针**不动**（继续跑旧版本），并带回原因；
 *   ② 指纹不稳 / 算不出 ⇒ 拒绝切换（版本目录名就是指纹，名不对等于版本不明）；
 *   ③ 依赖装不上 ⇒ 拒绝切换（"指纹对了但 import 不到 ws"最难查）。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { prepareRelease } from '../src/node/update.ts'
import { readPointer, releasePaths, writePointer } from '../src/node/release.ts'

let root = ''
let repo = ''
let releases = ''

before(async () => {
  root = await mkdtemp(path.join(process.cwd(), '.tmp-update-'))
  repo = path.join(root, 'digital-employees')
  releases = path.join(root, 'dse-releases')
  await mkdir(repo, { recursive: true })
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

const env = () => ({ DSE_RELEASES: releases })

/** 造一个"版本目录"：prepareRelease 只认这些文件在不在。 */
async function fakeReleaseTree(dir: string, lock = '{"lockfileVersion":3}'): Promise<void> {
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await mkdir(path.join(dir, 'bin'), { recursive: true })
  await writeFile(path.join(dir, 'bin', 'dse.mjs'), '// entry\n', 'utf8')
  await writeFile(path.join(dir, 'src', 'cli.ts'), '// cli\n', 'utf8')
  await writeFile(path.join(dir, 'package-lock.json'), lock, 'utf8')
  await writeFile(path.join(dir, 'package.json'), '{"name":"dse-employee"}\n', 'utf8')
}

interface FakeExec {
  calls: string[]
  handler: (command: string, args: string[], cwd: string) => Promise<void>
}

/** 默认执行器替身：git fetch/rev-parse/archive/tar 都"成功"，并真的把树建出来。 */
function makeExec(options: { sha?: string; failOn?: string; buildTree?: boolean } = {}): FakeExec {
  const sha = options.sha ?? 'sha-abcdef123456'
  const calls: string[] = []
  return {
    calls,
    handler: async (command, args, cwd) => {
      const key = `${command} ${args[0] ?? ''}`
      calls.push(key)
      if (options.failOn !== undefined && key.startsWith(options.failOn)) {
        throw new Error(`injected failure: ${key}`)
      }
      if (command === 'git' && args[0] === 'rev-parse') return
      if (command === 'git' && args[0] === 'archive') {
        /* 形状：git archive --format=tar -o <tar> <sha> */
        const tarPath = args[3] ?? ''
        if (!path.isAbsolute(tarPath)) throw new Error(`archive 调用形状不对：${args.join(' ')}`)
        if (options.buildTree !== false) await writeFile(tarPath, 'fake tar', 'utf8')
        return
      }
      if (command === 'tar') {
        /* 形状：tar -xf <tar> -C <staging>。真实解包内容由 tar 决定；这里让假 tar
           把一份完整的树写进 staging，模拟"导出成功"。 */
        const staging = args[args.length - 1] ?? ''
        if (!path.isAbsolute(staging)) throw new Error(`tar 调用形状不对：${args.join(' ')}`)
        if (options.buildTree !== false) await fakeReleaseTree(staging)
        return
      }
      void cwd
    },
  }
}

function execOf(fake: FakeExec) {
  return async (command: string, args: string[], options: { cwd: string }) => {
    await fake.handler(command, args, options.cwd)
    return { stdout: command === 'git' && args[0] === 'rev-parse' ? 'sha-abcdef123456\n' : '' }
  }
}

describe('升级目标白名单（审计 FINDING-013：git 参数注入）', () => {
  it('拒绝以 - 开头的目标 —— 那会被 git 当成选项（`--upload-pack=<命令>` 可执行命令）', async () => {
    for (const evil of ['--upload-pack=touch /tmp/pwned', '-c protocol.ext.allow=always', '--exec=sh']) {
      const outcome = await prepareRelease({ repo, to: evil, env: env(), exec: execOf(makeExec()) })
      assert.equal(outcome.ok, false, `必须拒绝 ${evil}`)
      assert.match(String(outcome.error), /只接受分支\/标签名或提交 sha/)
    }
  })

  it('正常的 sha / 分支 / 标签仍然通过（别把白名单做得连自己都用不了）', async () => {
    for (const okRef of ['6f69a2f', '0123456789abcdef0123456789abcdef01234567', 'develop', 'release/v1.2', 'v1.0-rc.6']) {
      /* 每个引用一个**独立**的 releases 目录：否则这条用例会把共享指针改掉，
         后面那条"成功路径"就会因为 previous 已被写而失败（测试之间不许互相污染）。 */
      const dir = path.join(root, 'wl', okRef.replace(/[^a-z0-9]/gi, ''))
      const outcome = await prepareRelease({
        repo,
        to: okRef,
        env: { DSE_RELEASES: dir },
        exec: execOf(makeExec()),
        fingerprint: () => `fp-${okRef.replace(/[^a-z0-9]/gi, '')}`,
      })
      assert.equal(outcome.ok, true, `${okRef} 应该通过：${outcome.error ?? ''}`)
    }
  })
})

describe('升级执行器：顺序与安全边界', () => {
  it('成功路径：fetch → 导出 → 指纹 → 依赖 → 冒烟 → 切指针', async () => {
    const fake = makeExec()
    const outcome = await prepareRelease({
      repo,
      to: 'develop',
      env: env(),
      exec: execOf(fake),
      fingerprint: () => 'fp-1234',
    })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.ref, 'sha-abcdef123456')
    assert.equal(outcome.switched, true)
    assert.equal(outcome.fingerprint, 'fp-1234')
    assert.equal(outcome.codeDir, path.join(releases, 'fp-1234'), '版本目录名必须是代码指纹（不是 sha）')
    /* 指针已切到这个版本，且没有 previous（首次） */
    const pointer = await readPointer(releasePaths({ repo, env: env() }).pointerFile)
    assert.equal(pointer?.release, 'fp-1234')
    assert.equal(pointer?.previous, undefined)
    assert.ok(fake.calls[0]?.startsWith('git fetch'), '第一步必须是 fetch')
    assert.ok(
      !fake.calls.some((call) => call.startsWith('git worktree')),
      '不该用 worktree：版本目录是冻结产物，里面不该有 .git',
    )
    assert.ok(outcome.steps.some((step) => /冒烟/.test(step)), '必须有冒烟这一步')
  })

  it('fetch 两次都失败 ⇒ 指针不动（继续跑旧版本），并把原因带回来', async () => {
    const dir = path.join(root, 'r-fetch')
    const paths = releasePaths({ repo, env: { DSE_RELEASES: dir } })
    await writePointer(paths.pointerFile, { release: 'fp-old', updatedAtMs: 1 })
    const outcome = await prepareRelease({
      repo,
      to: 'develop',
      env: { DSE_RELEASES: dir },
      /* 让**所有** git 调用都失败：fetch 现在会试两次（先按本机配置、再直连），
         只挡 `git fetch` 的话直连那次会假成功，这条用例就失去意义了。 */
      exec: execOf(makeExec({ failOn: 'git' })),
      fingerprint: () => 'fp-new',
    })
    assert.equal(outcome.ok, false)
    assert.match(String(outcome.error), /git fetch 失败/)
    assert.equal((await readPointer(paths.pointerFile))?.release, 'fp-old', '失败不该动指针')
  })

  it('git fetch 先按本机配置、不通再直连（正好两次，第二次带 -c http.proxy=）', async () => {
    /* 真机就是这么失败的：git 全局配了给 GitHub 用的 http.proxy=127.0.0.1:7892，
       而它没开 → gitee 连不上（日志：Failed to connect to gitee.com port 443 via 127.0.0.1）。
       这条钉住"退一步直连"这条补救路径，以及它的**顺序**。 */
    const dir = path.join(root, 'r-proxy')
    const tree = makeExec()
    const calls: string[][] = []
    const outcome = await prepareRelease({
      repo,
      to: 'develop',
      env: { DSE_RELEASES: dir },
      fingerprint: () => 'fp-proxy',
      exec: async (command, args, options) => {
        calls.push([command, ...args])
        if (command === 'git' && args[0] === 'fetch') {
          throw new Error('Failed to connect to gitee.com port 443 via 127.0.0.1 after 2116 ms')
        }
        await tree.handler(command, args, options.cwd)
        return { stdout: command === 'git' && args[0] === 'rev-parse' ? 'sha-abcdef123456\n' : '' }
      },
    })
    assert.equal(outcome.ok, true, outcome.error ?? '')
    const fetches = calls.filter((call) => call[0] === 'git' && (call[1] === 'fetch' || call[1] === '-c'))
    assert.equal(fetches.length, 2, '应该正好尝试两次：一次按本机配置、一次直连')
    assert.deepEqual(fetches[0], ['git', 'fetch', '--tags', 'origin', 'develop'], '第一次必须按本机配置原样跑')
    assert.deepEqual(
      fetches[1],
      ['git', '-c', 'http.proxy=', '-c', 'https.proxy=', 'fetch', '--tags', 'origin', 'develop'],
      '第二次必须置空两个 proxy 再跑',
    )
    assert.ok(outcome.steps.some((step) => /改用直连重试/.test(step)), '步骤里要留下"第一次失败"的痕迹')
  })

  it('指纹算不出来 ⇒ 拒绝切换', async () => {
    const dir = path.join(root, 'r-fp')
    const paths = releasePaths({ repo, env: { DSE_RELEASES: dir } })
    await writePointer(paths.pointerFile, { release: 'fp-old', updatedAtMs: 1 })
    const outcome = await prepareRelease({
      repo,
      to: 'develop',
      env: { DSE_RELEASES: dir },
      exec: execOf(makeExec()),
      fingerprint: () => {
        throw new Error('no source files')
      },
    })
    assert.equal(outcome.ok, false)
    assert.match(String(outcome.error), /算指纹失败/)
    assert.equal((await readPointer(paths.pointerFile))?.release, 'fp-old')
  })

  it('依赖装不上 ⇒ 拒绝切换（宁可继续跑旧的可用版本）', async () => {
    const dir = path.join(root, 'r-npm')
    const paths = releasePaths({ repo, env: { DSE_RELEASES: dir } })
    await writePointer(paths.pointerFile, { release: 'fp-old', updatedAtMs: 1 })
    const outcome = await prepareRelease({
      repo,
      to: 'develop',
      env: { DSE_RELEASES: dir },
      exec: execOf(makeExec({ failOn: 'npm ci' })),
      fingerprint: () => 'fp-new',
    })
    assert.equal(outcome.ok, false)
    assert.match(String(outcome.error), /依赖安装失败/)
    assert.equal((await readPointer(paths.pointerFile))?.release, 'fp-old')
  })

  it('冒烟失败 ⇒ 拒绝切换（语法错/缺依赖在这一步暴露）', async () => {
    const dir = path.join(root, 'r-smoke')
    const paths = releasePaths({ repo, env: { DSE_RELEASES: dir } })
    await writePointer(paths.pointerFile, { release: 'fp-old', updatedAtMs: 1 })
    const outcome = await prepareRelease({
      repo,
      to: 'develop',
      env: { DSE_RELEASES: dir },
      exec: async (command, args, options) => {
        if (command === 'npm') return { stdout: '' }
        if (command === 'cp' || command === 'xcopy') return { stdout: '' }
        if (command === process.execPath) throw new Error('SyntaxError: boom')
        if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'sha-abcdef123456\n' }
        if (command === 'git' && args[0] === 'archive') {
          await writeFile(args[3] ?? '', 'fake tar', 'utf8')
          return { stdout: '' }
        }
        if (command === 'tar') {
          await fakeReleaseTree(args[args.length - 1] ?? '')
          return { stdout: '' }
        }
        void options
        return { stdout: '' }
      },
      fingerprint: () => 'fp-new',
    })
    assert.equal(outcome.ok, false)
    assert.match(String(outcome.error), /冒烟失败/)
    assert.equal((await readPointer(paths.pointerFile))?.release, 'fp-old')
  })

  it('已经是该版本 ⇒ 不重复切换（幂等：重复点"升级"不该改 previous）', async () => {
    const dir = path.join(root, 'r-idem')
    const paths = releasePaths({ repo, env: { DSE_RELEASES: dir } })
    await writePointer(paths.pointerFile, { release: 'fp-1234', previous: 'fp-old', updatedAtMs: 1 })
    const fake = makeExec()
    const outcome = await prepareRelease({
      repo,
      to: 'develop',
      env: { DSE_RELEASES: dir },
      exec: execOf(fake),
      fingerprint: () => 'fp-1234',
    })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.switched, false)
    const pointer = await readPointer(paths.pointerFile)
    assert.equal(pointer?.previous, 'fp-old', 'previous 必须保持不变，否则回滚目标会丢')
  })

  it('依赖没变（lock 哈希相同）⇒ 跳过安装；变了才装', async () => {
    const dir = path.join(root, 'r-lock')
    const codeDir = path.join(dir, 'fp-lock')
    await fakeReleaseTree(codeDir)
    /* 先把 stamp 与 lock 对齐，模拟"上次装过" */
    await writeFile(path.join(codeDir, '.deps-lock-hash'), await readFile(path.join(codeDir, 'package-lock.json'), 'utf8').then((text) => String(hashOf(text))), 'utf8')
    await mkdir(path.join(codeDir, 'node_modules'), { recursive: true })

    const calls: string[] = []
    const outcome = await prepareRelease({
      repo,
      to: 'develop',
      env: { DSE_RELEASES: dir },
      exec: async (command, args) => {
        calls.push(`${command} ${args[0] ?? ''}`)
        if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'sha-abcdef123456\n' }
        return { stdout: '' }
      },
      fingerprint: () => 'fp-lock',
    })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.installedDependencies, false)
    assert.ok(!calls.includes('npm ci'), '依赖没变就不该跑 npm ci')
    assert.ok(outcome.steps.some((step) => /依赖没变/.test(step)))
  })
})

/** 与实现同款的非密码学哈希，只在测试里用来对齐 stamp。 */
function hashOf(text: string): number {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return hash
}
