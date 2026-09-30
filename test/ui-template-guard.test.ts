/**
 * 脚本片段的模板结构守卫：**每个 `String.raw` 区间里不能出现反引号或 `${`**。
 *
 * 为什么值得一条独立测试（而不是靠 tsc）：这个坑在本仓库已经踩过**六次**
 * （今天我自己又踩了一次 —— 在 ui.ts 的文档注释里写 `src/web/**` 之后的 `*` 斜杠
 * 提前闭合了块注释，另有几次是片段注释里的反引号截断模板）。
 * 每次的症状都是同一种难查的样子：tsc 报的是
 * `Module declaration names may only use ' or " quoted strings` 或 `',' expected`，
 * 后面跟十几 KB 的源码转储，完全看不出是"某行注释里写了个反引号"。
 *
 * 关键设计：本测试**只把源码当文本读**，不 import 控制台模块 —— 于是即使某个片段的
 * 模板已经被反引号截断、模块根本解析不了，这条测试依然能跑，并直接报出**文件名 + 行号**。
 * （import 式的测试在那种情况下自己也跑不起来，等于没有护栏。）
 *
 * 拆文件之后这条守卫覆盖**每一个片段**：判定单元从"ui.ts 那一个模板"变成
 * "`src/web/` 下每个 .ts 里的每个 String.raw 区间"。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'
import path from 'node:path'

const WEB_DIR = path.join(import.meta.dirname, '..', 'src', 'web')
const SCRIPT_DIR = path.join(WEB_DIR, 'script')

/** 参与守卫的源码文件：组装处 + 全部片段。 */
const FILES: Array<{ name: string; text: string }> = [
  { name: 'ui.ts', text: readFileSync(path.join(WEB_DIR, 'ui.ts'), 'utf8') },
  ...readdirSync(SCRIPT_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => ({ name: `script/${name}`, text: readFileSync(path.join(SCRIPT_DIR, name), 'utf8') })),
]

interface Region {
  file: string
  /** 模板内容 */
  text: string
  /** 模板内容第一行在文件里的行号（1-based） */
  firstLine: number
}

/**
 * 取每个片段文件里 `String.raw` 的模板区间：从起始反引号到**文件里最后一个反引号**。
 *
 * 为什么用"最后一个反引号"而不是"独占一行的反引号"：片段是机械切出来的，切点落在
 * 行边界上，于是有的片段正好以换行结尾（收尾反引号独占一行），有的不是
 * （收尾反引号紧跟在前一行末尾）。用"最后一个"两种情况都稳。
 *
 * 这样取出来的区间**包含**任何夹在中间的多余反引号 —— 那正是下面断言要抓的东西。
 */
function templateRegions(file: string, source: string): Region[] {
  const regions: Region[] = []
  let cursor = 0
  for (;;) {
    const at = source.indexOf('= String.raw`', cursor)
    if (at < 0) break
    const openTick = at + '= String.raw'.length
    const closeTick = source.lastIndexOf('`')
    assert.ok(closeTick > openTick, `${file}: String.raw 模板没有收尾反引号（多半被截断了）`)
    regions.push({
      file,
      text: source.slice(openTick + 1, closeTick),
      firstLine: source.slice(0, openTick + 1).split('\n').length,
    })
    cursor = closeTick + 1
  }
  return regions
}

/* 只守卫片段文件：ui.ts 里剩下的模板是真 TS 模板字面量，语法错误由 tsc 直接报。 */
const CHUNK_FILES = FILES.filter((file) => file.name.startsWith('script/'))
const REGIONS: Region[] = CHUNK_FILES.flatMap((file) => templateRegions(file.name, file.text))

/** 在模板区间里找出所有匹配，返回 `文件:行号: 内容` 便于直接定位。 */
function violations(region: Region, pattern: RegExp): string[] {
  const found: string[] = []
  region.text.split('\n').forEach((line, index) => {
    if (pattern.test(line)) found.push(`${region.file}:${region.firstLine + index}: ${line.trim().slice(0, 100)}`)
  })
  return found
}

describe('每个 String.raw 片段的结构', () => {
  it('每个片段文件恰好一个 String.raw 区间，且总数不少于 16（漏接一段 = 一批函数静默消失）', () => {
    assert.equal(REGIONS.length, CHUNK_FILES.length, '有的片段里不是恰好一个 String.raw')
    assert.ok(REGIONS.length >= 16, `只找到 ${REGIONS.length} 个片段`)
  })

  it('模板区间里没有反引号（一个反引号就会把模板截断，症状极难查）', () => {
    const hits = REGIONS.flatMap((region) => violations(region, /`/))
    assert.deepEqual(
      hits,
      [],
      '模板区间里出现了反引号 —— 它会把 String.raw 模板提前闭合，tsc 只会报一句莫名其妙的语法错。\n' +
        '注释里请用「」代替：\n' +
        hits.join('\n'),
    )
  })

  it('模板区间里没有 ${（会被当成 TS 插值，同样截断）', () => {
    const hits = REGIONS.flatMap((region) => violations(region, /\$\{/))
    assert.deepEqual(hits, [], '模板区间里出现了 ${ —— 注释里请直接写"美元花括号"或改写句子：\n' + hits.join('\n'))
  })

  it('每个片段都足够大且确实是控制台脚本（防"定位逻辑失效导致断言空转"）', () => {
    for (const region of REGIONS) {
      assert.ok(region.text.length > 4_000, `${region.file} 只取到 ${region.text.length} 字符 —— 定位逻辑多半坏了`)
    }
    const joined = REGIONS.map((region) => region.text).join('\n')
    assert.ok(joined.includes('function init()'), '片段合起来里没有 init()，取到的不是控制台脚本')
    assert.ok(joined.includes('function placeChatTools('), '片段合起来里没有 placeChatTools()')
    assert.ok(joined.includes('function renderPositionPanels('), '片段合起来里没有岗位面板渲染函数')
  })

  it('片段合起来就是交付脚本，且**顺序**满足"先声明后使用"', () => {
    const joined = REGIONS.map((region) => region.text).join('')
    assert.ok(joined.includes('function init()'), '片段合起来里没有 init()，拼装漏了')

    /* 顺序为什么必须钉：函数声明会提升，但顶层 var 的赋值**不会** ——
       如果哪天有人重排了 ui.ts 里的 import 顺序，`state` 会不会在使用它的代码之前
       赋值就全看运气，而这种错误在浏览器里表现为"某个变量是 undefined"，极难查。 */
    /* 用"在拼接结果里的绝对偏移"比较顺序，而不是"第几个片段" ——
       同一个片段内部的先后也要算数（比如 PANEL_RENDERERS 与 renderPositionPanels 同段）。 */
    const positionOf = (snippet: string): number => {
      let offset = 0
      for (const region of REGIONS) {
        const at = region.text.indexOf(snippet)
        if (at >= 0) return offset + at
        offset += region.text.length
      }
      assert.fail(`片段里找不到「${snippet}」—— 它被删了或改名了`)
    }
    for (const [declaration, user] of [
      ['var state =', 'function init('],
      ['var PANEL_RENDERERS =', 'function renderPositionPanels('],
      ['var VIEW_IDS =', 'function setView('],
      ['function weekKeyOf(', 'function skillAnalysis('],
    ] as Array<[string, string]>) {
      assert.ok(
        positionOf(declaration) < positionOf(user),
        `${declaration} 必须排在用到它的 ${user} 之前（顶层 var 不提升）`,
      )
    }

    /* 首段是引导配置，末段是启动 —— 这两条保证"文件名顺序 = 物理顺序"没被破坏 */
    assert.ok(String(REGIONS[0]?.text).includes('var BOOT'), '首段应当是引导配置')
    assert.ok(String(REGIONS[REGIONS.length - 1]?.text).includes('function init()'), '末段应当是启动')
  })
})

describe('行号定位的健壮性（报错要能直接跳到那一行）', () => {
  it('每个文件的定位都能算出正确行号', () => {
    for (const file of FILES) {
      const lines = file.text.split('\n')
      const at = file.text.indexOf('export const')
      assert.ok(at > 0, `${file.name} 里找不到 export const`)
      const line = file.text.slice(0, at).split('\n').length
      assert.equal(lines[line - 1]?.startsWith('export const'), true, `${file.name} 的行号换算不对`)
    }
  })
})
