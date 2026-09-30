/**
 * 头像的本地缓存（跑交付脚本里的真源码）。
 *
 * 起因是一个体感问题："点进去先是线稿，等一下才刷出照片"。查下来是结构性开销：
 * 头像是几百 KB 的图，而 Hub 侧只有 RPC 一条路（没有 HTTP 缓存可借），
 * 于是**每次刷新、每个视图**都把所有人的头像重新拉一遍 —— 实测 9 个员工约 4.2 MB
 * base64，走一遍公网往返才轮到画到屏幕上。
 *
 * 这一组守的是让"版本没变就别下载"成立的那几个纯函数：
 *   · avatarVersionOf：把员工身上的版本读出来（没上报时必须是空串，不能编一个假的）；
 *   · readAvatarCache：坏数据/半截数据一律当"没有缓存"（隐私模式、配额满、别的版本写坏过）；
 *   · avatarCacheFresh：**只有版本非空且相等才算命中** —— 空版本绝不能当命中，
 *     否则节点不报版本时会永远显示旧头像（比慢一点严重得多）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderControlUiScript } from '../src/web/ui.ts'

const SCRIPT = renderControlUiScript()

function extractFunction(name: string): string {
  const start = SCRIPT.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `交付脚本里找不到 function ${name}(`)
  let depth = 0
  for (let index = SCRIPT.indexOf('{', start); index < SCRIPT.length; index += 1) {
    const char = SCRIPT[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return SCRIPT.slice(start, index + 1)
    }
  }
  throw new Error(`function ${name} 的花括号没有配对`)
}

/** 取交付脚本里某一行 `var NAME = …` 的原样声明：测试要用**真值**，不能自己再写一份。 */
function extractVarDeclaration(name: string): string {
  const match = new RegExp(`var ${name} = [^\n]+`).exec(SCRIPT)
  assert.ok(match !== null, `交付脚本里找不到 var ${name} = …`)
  return match[0]
}

interface Harness {
  avatarVersionOf: (employee: unknown) => string
  avatarCacheKey: (id: unknown) => string
  readAvatarCache: (id: string) => { version: string; dataUrl: string } | null
  avatarCacheFresh: (cached: unknown, current: string) => boolean
  storage: Map<string, string>
}

function makeHarness(seed: Record<string, string> = {}): Harness {
  const storage = new Map<string, string>(Object.entries(seed))
  const scope = {
    /* 与 00-core.ts 的 readLocal 同签名的最小替身 */
    readLocal: (key: string): string | null => (storage.has(key) ? (storage.get(key) as string) : null),
    state: {},
  }
  const factory = new Function(
    'scope',
    `with (scope) {
      ${extractVarDeclaration('AVATAR_CACHE_PREFIX')}
      ${extractFunction('avatarCacheKey')}
      ${extractFunction('avatarVersionOf')}
      ${extractFunction('readAvatarCache')}
      ${extractFunction('avatarCacheFresh')}
      return { avatarCacheKey, avatarVersionOf, readAvatarCache, avatarCacheFresh }
    }`,
  ) as (scope: unknown) => Omit<Harness, 'storage'>
  return { ...factory(scope), storage }
}

describe('头像版本号', () => {
  it('节点报了 mtime+字节数 ⇒ 版本是两者的组合（任一变都算变）', () => {
    const h = makeHarness()
    assert.equal(h.avatarVersionOf({ avatarUpdatedAtMs: 1790239081643, avatarBytes: 367001 }), '1790239081643-367001')
  })

  it('没上报 / 不是数字 ⇒ 空串（不许编假版本：那样会永远显示旧头像）', () => {
    const h = makeHarness()
    assert.equal(h.avatarVersionOf({}), '')
    assert.equal(h.avatarVersionOf({ avatarUpdatedAtMs: 0 }), '')
    assert.equal(h.avatarVersionOf({ avatarUpdatedAtMs: 'x' }), '')
    assert.equal(h.avatarVersionOf(null), '')
    assert.equal(h.avatarVersionOf(undefined), '')
  })

  it('缺 avatarBytes 时仍按 mtime 出个可用版本（老节点只报一半也不能瘫）', () => {
    const h = makeHarness()
    assert.equal(h.avatarVersionOf({ avatarUpdatedAtMs: 111 }), '111-0')
  })
})

describe('缓存读取：坏数据一律当没有', () => {
  it('正常的条目读得出来', () => {
    const h = makeHarness({
      'dse.avatar.emp_x': JSON.stringify({ v: '1-2', d: 'data:image/webp;base64,AAAA' }),
    })
    assert.deepEqual(h.readAvatarCache('emp_x'), { version: '1-2', dataUrl: 'data:image/webp;base64,AAAA' })
  })

  it('没有 / 空串 / 半截 JSON / 不是图片 / 结构不对 ⇒ null', () => {
    const h = makeHarness({
      'dse.avatar.a': 'not json at all',
      'dse.avatar.b': JSON.stringify({ v: '1', d: 'https://example.com/x.png' }),
      'dse.avatar.c': JSON.stringify({ v: '1' }),
      'dse.avatar.d': JSON.stringify('just a string'),
      'dse.avatar.e': '',
    })
    for (const id of ['a', 'b', 'c', 'd', 'e', 'missing']) {
      assert.equal(h.readAvatarCache(id), null, `${id} 应当当作没有缓存`)
    }
  })

  it('缓存键按员工分开（串了就会张冠李戴）', () => {
    const h = makeHarness()
    assert.notEqual(h.avatarCacheKey('emp_1'), h.avatarCacheKey('emp_2'))
    assert.equal(h.avatarCacheKey('emp_1'), h.avatarCacheKey('emp_1'))
  })
})

describe('要不要重新下载', () => {
  it('版本一致 ⇒ 命中，一个字节都不用传', () => {
    const h = makeHarness()
    assert.equal(h.avatarCacheFresh('9-100', '9-100'), true)
  })

  it('版本不同 ⇒ 不命中（换过头像必须能刷新出来）', () => {
    const h = makeHarness()
    assert.equal(h.avatarCacheFresh('9-100', '10-100'), false)
    assert.equal(h.avatarCacheFresh('9-100', '9-200'), false)
  })

  it('**当前版本为空 ⇒ 永不命中**（节点还没上报版本时只能老实下载）', () => {
    const h = makeHarness()
    assert.equal(h.avatarCacheFresh('9-100', ''), false)
    assert.equal(h.avatarCacheFresh('', ''), false)
    assert.equal(h.avatarCacheFresh(undefined, ''), false)
    assert.equal(h.avatarCacheFresh(undefined, '9-100'), false, '本地没有缓存版本时必须去下载')
  })
})
