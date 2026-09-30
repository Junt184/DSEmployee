/**
 * 界面脚本版本号（内容指纹）的接线 —— HTML 与 service worker 必须用同一个地址。
 *
 * 背景是这次真正的事故：手机与电脑界面不一致，根因是 `/ui.js` 被 service worker
 * 的 cache-first 永久冻住（页面 HTML 是 network-first，所以样式是新的、脚本是旧的）。
 * 结构性解法是让"脚本内容"决定"缓存版本"：
 *
 *   脚本改一个字 ⇒ 指纹变 ⇒ HTML 里的 <script src> 变、SW 的缓存名与 precache 变
 *   ⇒ SW 脚本字节变 ⇒ 浏览器判定需更新 SW ⇒ 旧缓存被清、新 SW 接管 ⇒ 客户端自愈
 *
 * 这条链上任何一环算错都**不会报错**（页面照常打开、只是又回到旧脚本），
 * 所以每一环都值得一条断言：
 *   1. 指纹真的跟着内容变；
 *   2. 交付出去的脚本里没有残留占位符（残留 = 页面上印着 `__DSE_UI_VERSION__`）；
 *   3. HTML 引用的地址带指纹（调用方忘了带也会被自动补上）；
 *   4. SW 的 precache 地址与 HTML 引用的地址**逐字符相同**（不同 → 离线兜底落空）；
 *   5. 页面能自检：HTML 里的服务端指纹 = 脚本里的指纹（不一致时页面自己变红报警）。
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'

import { SCRIPT_CHUNKS } from './console-source.ts'
import { assetVersion, renderPwaServiceWorker } from '../src/web/pwa.ts'
import { packageRoot } from '../src/protocol/build.ts'
import {
  CONTROL_UI_SCRIPT,
  controlUiScriptUrl,
  controlUiVersion,
  controlUiVersionSubject,
  renderControlUi,
  renderControlUiScript,
} from '../src/web/ui.ts'

const VERSION = controlUiVersion()
const PLACEHOLDER = '__DSE_UI_VERSION__'

function html(scriptUrl?: string): string {
  return renderControlUi({
    hubId: 'hub-test',
    hubName: '测试 Hub',
    ...(scriptUrl === undefined ? {} : { scriptUrl }),
  })
}

function scriptSrcOf(document: string): string {
  const match = document.match(/<script type="module" src="([^"]+)">/)
  assert.ok(match !== null, 'HTML 里没有外链脚本标签')
  return String(match[1])
}

describe('界面脚本指纹', () => {
  it('指纹覆盖 JS + 页面模板（含 CSS）—— 改样式也要换代', () => {
    const subject = controlUiVersionSubject()
    assert.equal(VERSION, assetVersion(subject))
    /* 控制台拆成多个文件之后，断言从"主体里含整份交付脚本"改成更强的说法：
       **每个片段文件的原文都在主体里**（拆之前是 CONTROL_UI_SCRIPT.includes，
       拆之后交付脚本是片段拼出来的，主体里带 `文件名:内容` 前缀，所以逐段查）。 */
    for (const chunk of SCRIPT_CHUNKS) {
      assert.ok(
        subject.includes(`${chunk.name}:`) && subject.includes(chunk.text.slice(0, 400)),
        `指纹没覆盖片段 ${chunk.name}`,
      )
    }
    assert.ok(subject.includes('ui.ts:'), '指纹没覆盖组装处 ui.ts 本身')
    // 只哈希脚本的话，改 CSS 不会换代，离线兜底那份壳会一直停在旧样式
    assert.ok(subject.includes('.desk-top'), '指纹没覆盖页面模板/CSS')
    assert.notEqual(VERSION, assetVersion(CONTROL_UI_SCRIPT), '指纹仍然只覆盖脚本')
  })

  it('内容改一个字指纹就变（否则 SW 不会换代）', () => {
    assert.notEqual(assetVersion(`${controlUiVersionSubject()}\n`), VERSION)
  })

  it('指纹来自磁盘上的源码，不随"代码是怎么被加载的"变化', () => {
    // 曾经用 renderControlUi.toString()：Node 类型擦除与 tsc 编译产物给出的文本不同，
    // 于是同一个提交在两种运行形态下算出不同指纹（真实踩到：公网 Hub 因部署误带 dist
    // 而跑编译产物，指纹与本地不一致，看着像"代码不同"）。现在主体是 src/web/*.ts 原文。
    /* 断言用的这句话只存在于**片段文件头的注释**里（不在交付脚本里）——
       所以"主体来自磁盘源码"这件事依然被钉着。 */
    assert.ok(
      controlUiVersionSubject().includes('为什么拆成文件'),
      '主体应当是源码文件原文（含只在源文件里、不在交付脚本里的注释）',
    )
  })

  it('若本机有编译产物，它与源码必须算出同一个指纹', async () => {
    const compiled = path.join(packageRoot(), 'dist', 'src', 'web', 'ui.js')
    if (!existsSync(compiled)) return
    const fromDist = (await import(pathToFileURL(compiled).href)) as {
      controlUiVersion: () => string
    }
    assert.equal(fromDist.controlUiVersion(), VERSION, '编译产物与源码的界面指纹必须一致')
  })

  it('交付的脚本已把占位符替换成指纹（且没有第二处需要替换的地方）', () => {
    const served = renderControlUiScript()
    assert.ok(served.indexOf(PLACEHOLDER) < 0, '交付的脚本里还留着版本占位符')
    assert.ok(served.includes(`var UI_VERSION = '${VERSION}'`), '脚本里的 UI_VERSION 不是当前指纹')
    // 反向还原：把指纹换回占位符应逐字符等于源码常量 ⇒ 替换只发生了一次、没夹带别的内容
    assert.equal(served.split(VERSION).join(PLACEHOLDER), CONTROL_UI_SCRIPT)
  })

  it('HTML 里的脚本地址带指纹 —— 调用方只给 /ui.js 也会自动补上', () => {
    assert.equal(scriptSrcOf(html('/ui.js')), `/ui.js?v=${VERSION}`)
  })

  it('内联模式（无 scriptUrl）不引用外部地址，但同样拿到替换后的指纹', () => {
    const document = html()
    assert.ok(!document.includes('<script type="module" src='), '内联模式不该有外链脚本')
    assert.ok(document.includes(`var UI_VERSION = '${VERSION}'`), '内联脚本里的版本没被替换')
  })

  it('已经带查询串的地址不会被重复拼接', () => {
    assert.equal(scriptSrcOf(html('/ui.js?v=custom')), '/ui.js?v=custom')
    // 地址是缓存键、指纹是"服务端当前发的是哪一版"，两者是不同的事实，不能互相污染
    assert.ok(html('/ui.js?v=custom').includes(`data-server-version="${VERSION}"`))
  })

  it('页面能自检：HTML 印的服务端指纹 = 脚本里的指纹（不一致就自曝旧脚本）', () => {
    const document = html('/ui.js')
    assert.ok(document.includes(`data-server-version="${VERSION}"`), 'HTML 没有印服务端指纹，页面无法自检')
    assert.ok(document.includes('data-ui-version'), 'HTML 里没有版本展示位')
  })

  it('SW 的 precache 地址与 HTML 引用的地址逐字符相同（否则离线兜底落空）', () => {
    const sw = renderPwaServiceWorker({ version: VERSION, scriptUrl: controlUiScriptUrl() })
    assert.ok(sw.includes(`var SCRIPT = '${scriptSrcOf(html('/ui.js'))}'`))
    assert.ok(sw.includes(`var CACHE = 'dse-pwa-${VERSION}'`))
  })
})

describe('素材也必须进指纹（否则"换了图但页面没换"）', () => {
  it('指纹主体里逐个列出 src/web/assets 下的文件与内容摘要', () => {
    const subject = controlUiVersionSubject()
    const files = readdirSync(path.join(packageRoot(), 'src', 'web', 'assets'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(webp|png|jpe?g|gif|svg|avif)$/i.test(entry.name))
      .map((entry) => path.join(entry.parentPath ?? '', entry.name))
    assert.ok(files.length > 0, '素材目录里没有图片 —— 这条测试自己也失效了')
    for (const file of files) {
      const relative = path.relative(path.join(packageRoot(), 'src', 'web', 'assets'), file).split(path.sep).join('/')
      assert.ok(subject.includes(`${relative}:`), `指纹没覆盖素材 ${relative}`)
    }
  })

  it('只算图片：改 README 不该让客户端重下立绘（素材是 immutable 长缓存）', () => {
    const subject = controlUiVersionSubject()
    assert.ok(subject.includes('.webp:'), '图片没进指纹')
    assert.ok(!subject.includes('README.md:'), 'README 混进了指纹 —— 改文档会让所有素材重新下载')
  })

  it('换一张图（内容变）指纹就变 —— 长缓存靠它失效', () => {
    const before = controlUiVersionSubject()
    assert.notEqual(assetVersion(`${before}\nstage-idle.webp:changed`), VERSION)
  })
})
