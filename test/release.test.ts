/**
 * 版本指针与回滚判定（节点自升级的地基）。
 *
 * 这一组要钉住的都是**真机上最难查的那类问题**：
 *   · 指针写了一半被读到 ⇒ 机器再也起不来（所以必须原子写，且坏指针要能自愈）；
 *   · 升级后连不上 Hub 却没人回滚 ⇒ Windows 计划任务的 `RestartOnFailure Count=999`
 *     会把一个坏版本每分钟拉起一次、连拉 999 次（真实配置）；
 *   · 回滚目标不存在还硬回滚 ⇒ 从"版本不对"变成"根本起不来"。
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  MAX_FAILED_STARTS,
  SOURCE_RELEASE,
  listReleases,
  markConnected,
  noteConnected,
  noteCrash,
  parsePointer,
  pruneReleases,
  readPointer,
  releaseCodeDir,
  resolveUpdateRepo,
  releasePaths,
  startPlan,
  switchRelease,
  writePointer,
} from '../src/node/release.ts'

let root = ''
let repo = ''
let releases = ''

before(async () => {
  root = await mkdtemp(path.join(process.cwd(), '.tmp-release-'))
  repo = path.join(root, 'digital-employees')
  releases = path.join(root, 'dse-releases')
  await mkdir(repo, { recursive: true })
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

const paths = () => releasePaths({ repo, env: { DSE_RELEASES: releases } })

describe('版本目录约定', () => {
  it('默认放在仓库的兄弟目录；可用 DSE_RELEASES 覆盖（升级不该动到被升级的那个目录）', () => {
    const def = releasePaths({ repo, env: {} })
    assert.equal(def.root, path.join(root, 'dse-releases'))
    assert.equal(releasePaths({ repo, env: { DSE_RELEASES: releases } }).root, releases)
    assert.equal(paths().pointerFile, path.join(releases, 'current.json'))
  })

  it('__source__ 指回仓库自身（开发机形态）；普通 id 指到 releases/<id>', () => {
    assert.equal(releaseCodeDir(paths(), SOURCE_RELEASE, repo), repo)
    assert.equal(releaseCodeDir(paths(), 'abc-123', repo), path.join(releases, 'abc-123'))
  })
})

describe('指针：坏了一点也能自愈', () => {
  it('没有文件 / 空文件 / 坏 JSON / 缺 release 字段 ⇒ 一律当"没有指针"', () => {
    assert.equal(parsePointer(''), undefined)
    assert.equal(parsePointer('{不是 JSON'), undefined)
    assert.equal(parsePointer('[]'), undefined)
    assert.equal(parsePointer('{"updatedAtMs":1}'), undefined)
    assert.equal(parsePointer('{"release":"","updatedAtMs":1}'), undefined)
    assert.equal(parsePointer('{"release":"abc","updatedAtMs":5}')?.release, 'abc')
  })

  it('写进去能读回来（含可选字段）', async () => {
    const file = path.join(root, 'p1.json')
    await writePointer(file, {
      release: 'abc',
      previous: 'def',
      updatedAtMs: 7,
      failedStarts: 2,
      lastConnectedAtMs: 3,
      updatedBy: 'update',
    })
    const back = await readPointer(file)
    assert.deepEqual(back, {
      release: 'abc',
      previous: 'def',
      updatedAtMs: 7,
      failedStarts: 2,
      lastConnectedAtMs: 3,
      updatedBy: 'update',
    })
  })

  it('写入是原子的：目录里不留 .tmp 残留', async () => {
    const file = path.join(root, 'p2.json')
    await writePointer(file, { release: 'x', updatedAtMs: 1 })
    const dir = await listReleases(root)
    assert.ok(!dir.some((name) => name.includes('.tmp-')), '不该留下临时文件')
    assert.match(await readFile(file, 'utf8'), /"release": "x"/)
  })
})

describe('启动计划：什么时候回滚', () => {
  it('首次安装（没有指针）⇒ 跑仓库工作区，不打回滚', () => {
    const plan = startPlan(undefined, { repo, paths: paths() })
    assert.equal(plan.action, 'run')
    assert.equal(plan.release, SOURCE_RELEASE)
  })

  it('这个版本曾经连上过 Hub ⇒ 照跑（哪怕后来崩过几次）', () => {
    const plan = startPlan(
      { release: 'v2', previous: 'v1', updatedAtMs: 100, lastConnectedAtMs: 200, failedStarts: 9 },
      { repo, paths: paths() },
    )
    assert.equal(plan.action, 'run')
    assert.equal(plan.release, 'v2')
  })

  it('只是连不上、没崩过 ⇒ **不回滚**（网络抖动不该把好版本退掉）', () => {
    const plan = startPlan(
      { release: 'v2', previous: 'v1', updatedAtMs: 100, failedStarts: 0 },
      { repo, paths: paths() },
    )
    assert.equal(plan.action, 'run')
  })

  it('崩到上限且**从没连上过** ⇒ 回滚到上一版（这就是"坏版本每分钟被拉起 999 次"的解药）', () => {
    const plan = startPlan(
      { release: 'v2', previous: 'v1', updatedAtMs: 100, failedStarts: MAX_FAILED_STARTS },
      { repo, paths: paths() },
    )
    assert.equal(plan.action, 'rollback')
    assert.equal(plan.release, 'v1')
    assert.match(plan.action === 'rollback' ? plan.reason : '', /回滚到 v1/)
    assert.equal(plan.codeDir, path.join(releases, 'v1'))
  })

  it('失败没到上限 ⇒ 继续跑当前版本（偶发端口占用不该触发回滚）', () => {
    const plan = startPlan(
      { release: 'v2', previous: 'v1', updatedAtMs: 100, failedStarts: MAX_FAILED_STARTS - 1 },
      { repo, paths: paths() },
    )
    assert.equal(plan.action, 'run')
  })

  it('没有可回滚的上一版 ⇒ 照跑并说明原因（不假装成功、也不把机器搞成起不来）', () => {
    const plan = startPlan(
      { release: 'v2', updatedAtMs: 100, failedStarts: MAX_FAILED_STARTS },
      { repo, paths: paths() },
    )
    assert.equal(plan.action, 'run-anyway')
    assert.match(plan.action === 'run-anyway' ? plan.reason : '', /没有可回滚的上一版/)
  })

  it('上一版是 __source__ 时不回滚（那不是一份可回滚的发布）', () => {
    const plan = startPlan(
      { release: 'v2', previous: SOURCE_RELEASE, updatedAtMs: 100, failedStarts: MAX_FAILED_STARTS },
      { repo, paths: paths() },
    )
    assert.equal(plan.action, 'run-anyway')
  })
})

describe('计数与切换', () => {
  it('崩一次加一、连上一次清零；且**不改 updatedAtMs**（它是"曾连上"的比对基准）', () => {
    const base = { release: 'v2', updatedAtMs: 1 }
    const crashed = noteCrash(base, 5)
    assert.equal(crashed.failedStarts, 1)
    assert.equal(crashed.updatedAtMs, 1, '改写 updatedAtMs 会把"曾经连上过"的证据抹掉')
    const connected = noteConnected({ ...crashed, failedStarts: 3 }, 9)
    assert.equal(connected.failedStarts, undefined)
    assert.equal(connected.lastConnectedAtMs, 9)
  })

  it('切换版本把当前记为 previous；切到同一个版本不覆盖 previous', () => {
    const first = switchRelease(undefined, 'v1', { now: 1, updatedBy: 'update' })
    assert.equal(first.release, 'v1')
    assert.equal(first.previous, undefined, '首次安装没有上一版')
    const second = switchRelease(first, 'v2', { now: 2, updatedBy: 'update' })
    assert.equal(second.previous, 'v1')
    assert.equal(second.failedStarts, undefined, '切换后计数必须清零，否则新版本一启动就被回滚')
    const again = switchRelease(second, 'v2', { now: 3, updatedBy: 'update' })
    assert.equal(again.previous, 'v1', '切到同一版本时 previous 保持不变')
  })
})

describe('盖章：只有正在运行的那个版本能给自己盖章', () => {
  it('指针 == 本进程指纹 → 记下"已连上"，清掉崩溃计数', async () => {
    const dir = path.join(root, 'mark1')
    const p = releasePaths({ repo, env: { DSE_RELEASES: dir } })
    await writePointer(p.pointerFile, { release: 'fp-abc', updatedAtMs: 10, failedStarts: 2 })
    const result = await markConnected({ repo, env: { DSE_RELEASES: dir }, mine: 'fp-abc', now: 99 })
    assert.equal(result.noted, true)
    const after = await readPointer(p.pointerFile)
    assert.equal(after?.lastConnectedAtMs, 99)
    assert.equal(after?.failedStarts, undefined)
  })

  it('指针指向别的版本 → 拒绝盖章（否则"跑着旧版本"会把新版本标记成可用，回滚机制就废了）', async () => {
    const dir = path.join(root, 'mark2')
    const p = releasePaths({ repo, env: { DSE_RELEASES: dir } })
    await writePointer(p.pointerFile, { release: 'fp-new', updatedAtMs: 10 })
    const result = await markConnected({ repo, env: { DSE_RELEASES: dir }, mine: 'fp-old', now: 99 })
    assert.equal(result.noted, false)
    assert.match(String(result.reason), /指针指向 fp-new/)
    assert.equal((await readPointer(p.pointerFile))?.lastConnectedAtMs, undefined)
  })

  it('没有指针（开发机形态）→ 静默跳过，不是错误', async () => {
    const result = await markConnected({ repo, env: { DSE_RELEASES: path.join(root, 'mark3') }, mine: 'fp-x' })
    assert.equal(result.noted, false)
    assert.match(String(result.reason), /开发机形态/)
  })

  it('进程就跑在 releases/<指纹>/ 里时，也能找到指针（不靠环境变量）', () => {
    const inside = path.join(releases, 'fp-abc')
    const found = releasePaths({ repo: inside, env: {} })
    assert.equal(found.root, releases, '包根的父目录已经是 releases 根，不该再拼一层')
    assert.equal(found.pointerFile, path.join(releases, 'current.json'))
  })
})

describe('升级该在哪个 clone 里跑（真机踩过：release 目录里没有 .git）', () => {
  it('DSE_REPO 最优先（启动器给的，最明确）', async () => {
    const r = await resolveUpdateRepo({
      mine: path.join(releases, 'fp-x'),
      env: { DSE_REPO: repo },
      paths: paths(),
    })
    assert.equal(r?.repo, repo)
    assert.equal(r?.source, 'env')
  })

  it('没有环境变量时用指针里的 repo（自描述）', async () => {
    const dir = path.join(root, 'resolve1')
    const p = releasePaths({ repo, env: { DSE_RELEASES: dir } })
    await writePointer(p.pointerFile, { release: 'fp-x', updatedAtMs: 1, repo })
    const r = await resolveUpdateRepo({ mine: path.join(dir, 'fp-x'), env: {}, paths: p })
    assert.equal(r?.repo, repo)
    assert.equal(r?.source, 'pointer')
  })

  it('开发机形态：包根本身就是 clone（有 .git）', async () => {
    const clone = path.join(root, 'plain-clone')
    await mkdir(path.join(clone, '.git'), { recursive: true })
    const p = releasePaths({ repo: clone, env: { DSE_RELEASES: path.join(root, 'resolve2') } })
    const r = await resolveUpdateRepo({ mine: clone, env: {}, paths: p })
    assert.equal(r?.repo, clone)
    assert.equal(r?.source, 'self')
  })

  it('都拿不到 ⇒ 返回 undefined（调用方如实拒绝，绝不猜一个目录去 checkout）', async () => {
    const lonely = path.join(root, 'frozen-release')
    await mkdir(lonely, { recursive: true })
    const p = releasePaths({ repo: lonely, env: { DSE_RELEASES: path.join(root, 'resolve3') } })
    assert.equal(await resolveUpdateRepo({ mine: lonely, env: {}, paths: p }), undefined)
  })
})

describe('清理旧版本', () => {
  it('只删 keep 之外的同级目录，且不越出 releases 根', async () => {
    const cleanRoot = path.join(root, 'clean')
    await mkdir(path.join(cleanRoot, 'v1'), { recursive: true })
    await mkdir(path.join(cleanRoot, 'v2'), { recursive: true })
    await mkdir(path.join(cleanRoot, 'v3'), { recursive: true })
    await writeFile(path.join(cleanRoot, 'current.json'), '{}')
    const removed = await pruneReleases(cleanRoot, ['v3', 'v2'])
    assert.deepEqual(removed, ['v1'])
    assert.deepEqual(await listReleases(cleanRoot), ['v2', 'v3'])
  })
})
