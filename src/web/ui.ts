/**
 * 控制台 —— 零构建、零依赖、无 CDN 的 Web 控制台（组装处）。
 *
 * 这里只做四件事：
 *   1. 把 `src/web/script/*.ts` 的**脚本片段**按原物理顺序拼成 `CONTROL_UI_SCRIPT`；
 *   2. `renderControlUi()` 返回**一份完整的 HTML 文档**（内联 <style> + <script>）；
 *   3. `renderControlUiScript()` 把**同一份**浏览器端 JS 源码原样交出去，
 *      供服务端把 CSP 改成 nonce / 哈希（或把脚本挪到独立路由）时复用；
 *   4. 算界面指纹（覆盖 `src/web/` 下的全部 .ts，含子目录，见 `controlUiVersionSubject`）。
 *
 * 为什么拆成多个文件：这里原本是一个 10,263 行的单文件，其中客户端 JS 是**一个 8,302 行的
 * String.raw 字符串**。单文件没有边界，代价是真付过的：
 *   · 两个会话并行改同一个文件 —— edit 被"file changed"打断，提交时只能按 hunk 挑自己的改动；
 *   · 8,302 行 JS 在字符串里，tsc 一个字都看不见（引用未声明标识符那次，tsc 全绿、
 *     浏览器里却是 ReferenceError）—— 这条现在由 test/ui-script-globals.test.ts 兜着。
 * 拆开后：办公区、对话页、审批、设备、岗位、面板各占一个文件，边界就是文件名。
 *
 * **拼接顺序不可调换**：函数声明会提升，但顶层 `var` 的赋值不会 ——
 * `state`、常量、面板注册表必须先于使用它们的片段。
 * 每一段都必须在交付脚本里出现（漏接一段 = 一批函数静默消失），有测试逐个钉着。
 *
 * 为什么片段仍用 `String.raw`：内容就是**逐字符**要交给浏览器的 JS 源码，
 * 里面的 `\n`、`\d` 这类转义必须原样保留，不能被 TypeScript 先解一遍。
 * 代价是每个片段内不能出现反引号与 `${`（片段内的 JS 一律用字符串拼接）——
 * 拆分脚本对此有断言，踩过 6 次这个陷阱。
 */

import path from 'node:path'

import { contentHash, packageRoot, treeText } from '../protocol/build.ts'
import { readFileSync, readdirSync } from 'node:fs'
import { assetVersion } from './pwa.ts'
import { CONTROL_UI_CSS } from './css.ts'
import { renderControlBody } from './markup.ts'

export interface ControlUiOptions {
  hubId: string
  hubName: string
  /**
   * 脚本地址。给定时 HTML 用 `<script type="module" src="...">` 引用外部脚本，
   * **不给时**把脚本内联进 HTML。
   *
   * 生产路径**必须**给这个值：服务端的 CSP 是 `script-src 'self'`，
   * 内联脚本会被浏览器直接拦掉（页面会白屏且报 CSP 违规）。
   * 内联分支只保留给离线/单文件交付场景，那时需要自行放宽 CSP。
   */
  scriptUrl?: string
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 浏览器端 JS 源码（唯一一份，由下面的片段拼成）
 *
 * 片段顺序 = 原 10k 行单文件里的物理顺序，**不可调换**（见文件头注释）。
 * ═══════════════════════════════════════════════════════════════════════════ */
import { CHUNK_00_CORE } from './script/00-core.ts'
import { CHUNK_10_IDENTITY } from './script/10-identity.ts'
import { CHUNK_20_TRANSPORT } from './script/20-transport.ts'
import { CHUNK_30_OFFICE } from './script/30-office.ts'
import { CHUNK_32_OFFICE_ROOM } from './script/32-office-room.ts'
import { CHUNK_40_PAGES } from './script/40-pages.ts'
import { CHUNK_45_JOBS } from './script/45-jobs.ts'
import { CHUNK_50_HEALTH } from './script/50-health.ts'
import { CHUNK_55_POSITIONS } from './script/55-positions.ts'
import { CHUNK_60_SESSIONS } from './script/60-sessions.ts'
import { CHUNK_65_CHAT } from './script/65-chat.ts'
import { CHUNK_67_SECRETARY } from './script/67-secretary.ts'
import { CHUNK_68_QUAD } from './script/68-quad.ts'
import { CHUNK_70_ATTACH } from './script/70-attach.ts'
import { CHUNK_75_ASIDE } from './script/75-aside.ts'
import { CHUNK_80_PANELS } from './script/80-panels.ts'
import { CHUNK_85_APPROVALS } from './script/85-approvals.ts'
import { CHUNK_90_DEVICES } from './script/90-devices.ts'
import { CHUNK_95_THEME_BOOT } from './script/95-theme-boot.ts'

export const CONTROL_UI_SCRIPT =
  CHUNK_00_CORE +
  CHUNK_10_IDENTITY +
  CHUNK_20_TRANSPORT +
  CHUNK_30_OFFICE +
  CHUNK_32_OFFICE_ROOM +
  CHUNK_40_PAGES +
  CHUNK_45_JOBS +
  CHUNK_50_HEALTH +
  CHUNK_55_POSITIONS +
  CHUNK_60_SESSIONS +
  CHUNK_65_CHAT +
  CHUNK_67_SECRETARY +
  CHUNK_68_QUAD +
  CHUNK_70_ATTACH +
  CHUNK_75_ASIDE +
  CHUNK_80_PANELS +
  CHUNK_85_APPROVALS +
  CHUNK_90_DEVICES +
  CHUNK_95_THEME_BOOT


/** 版本占位符：源码里写死它，交付时替换成 `controlUiVersion()`（内容指纹）。 */
const UI_VERSION_PLACEHOLDER = '__DSE_UI_VERSION__'

/* ═══════════════════════════════════════════════════════════════════════════
 * 导出
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 浏览器端 JS 源码（与 `renderControlUi()` 内联的那一份**完全是同一个字符串**）。
 *
 * 用途：当服务端把 CSP 从 `script-src 'self'` 改成 nonce / 哈希，或把脚本挪到
 * `/ui.js` 之类独立路由时，直接复用这份源码即可，无需改动本文件。
 * 脚本唯一依赖的页面内数据是 `#dse-boot` 的 `data-hub-id` / `data-hub-name`。
 */
export function renderControlUiScript(): string {
  return servedControlUiScript()
}

/**
 * 参与界面指纹计算的**全部内容**：控制台源码（`src/web/*.ts`，含全部 CSS 与 JS）。
 *
 * 为什么用**磁盘上的源码文本**而不是 `renderControlUi.toString()`：
 * `Function.prototype.toString()` 返回的文本取决于代码**是怎么被加载的** ——
 * 源码直跑（Node 类型擦除）与编译产物（tsc 输出）会给出不同文本，于是同一个提交
 * 在两种运行形态下算出不同指纹，看起来像"代码不同"，其实只是加载方式不同。
 * 真实踩到：公网 Hub 因部署时误带了 `dist/` 而跑编译产物，指纹与本地不一致。
 *
 * 为什么 CSS 也算进来：控制台是"零构建"交付，样式写在页面模板里。只哈希脚本的话，
 * 改样式不会让指纹变 ⇒ SW 不换代 ⇒ 离线兜底那份 `'/'` 缓存会一直停在旧样式
 * （在线时 HTML 走 no-store 看不出来，一断网就现形）。
 *
 * 没有源码（被裁剪的交付形态）时才退回运行时文本 —— 那时也只能这样了。
 */
/**
 * 页面素材（`src/web/assets/` 下的图）的内容摘要 —— **必须进指纹**。
 *
 * 为什么：素材是**长缓存**（`immutable`），靠 URL 上的 `?v=<指纹>` 换版本。
 * 而指纹原来只覆盖 `.ts` 源码 —— 于是"换了一张立绘、文件名没变"时指纹不动、
 * URL 不动、浏览器继续用缓存里的旧图：**图换了，页面上看不出换了**。
 * 这正是本仓库最防的那类"看起来生效了"的故障，所以把素材正文也算进来。
 */
function assetsSubject(): string {
  const root = path.join(packageRoot(), 'src', 'web', 'assets')
  const files: string[] = []
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      return /* 没有素材目录（裁剪过的交付形态）：摘要为空，不影响其它部分 */
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  walk(root)
  /* 只算**会被浏览器请求的图片**：README 之类的文档改了不该让客户端重下立绘
     （素材是 immutable 长缓存，版本一动就全量重取 —— 白烧流量）。 */
  const served = files.filter((relative) => /\.(webp|png|jpe?g|gif|svg|avif)$/i.test(relative))
  if (served.length === 0) return ''
  return served
    .sort()
    .map((relative) => `${relative}:${contentHash(readFileSync(path.join(root, relative), 'latin1'))}`)
    .join('\n')
}

export function controlUiVersionSubject(): string {
  const source = treeText(packageRoot(), path.join('src', 'web'), '.ts')
  const assets = assetsSubject()
  if (source !== undefined) return `${source}\n${assets}`
  return CONTROL_UI_SCRIPT + renderControlUi.toString() + renderScriptTag.toString() + assets
}

/**
 * 控制台脚本的**内容指纹** —— 上面那份 JS 源码 + 页面模板的哈希。
 *
 * 为什么必须有它：脚本要经浏览器缓存、service worker 缓存、PWA 三层缓存才能到达手机，
 * 而"缓存住旧脚本"这件事**不会报错**：页面照常打开、CSS 是新的（HTML 走 network-first）、
 * 只有 JS 停在旧版本，于是出现"电脑上对、手机上不对"这种最难查的错配。
 * 真实事故：SW 对 /ui.js 用 cache-first 且缓存名写死，手机上 JS 永远停在装上那天，
 * 办公区卡片与电脑完全不同（旧 JS 根本不建 `.desk-top` 网格，新样式整块空转）。
 *
 * 把内容哈希接进两处之后，"忘记升版本"从结构上不可能发生：
 *   · HTML：`<script src="/ui.js?v=<指纹>">`（见 renderScriptTag）
 *   · service worker：缓存名与 precache 列表（见 renderPwaServiceWorker）
 * 任何一行浏览器端代码改动 ⇒ 指纹变 ⇒ SW 脚本字节变 ⇒ SW 换代 + 旧缓存被清。
 */
export function controlUiVersion(): string {
  return assetVersion(controlUiVersionSubject())
}

/**
 * 控制台脚本的完整交付地址（含内容指纹）。
 *
 * HTML 与 service worker 必须用**同一个**地址：两边算错一个，离线兜底就会落空
 * （缓存里存的是 A 版本、请求的是 B 版本）。所以只暴露这一个入口。
 */
export function controlUiScriptUrl(): string {
  return `/ui.js?v=${controlUiVersion()}`
}

/** 交付给浏览器的源码：把版本占位符换成真实指纹（同一个字符串，只替换一处）。 */
function servedControlUiScript(): string {
  return CONTROL_UI_SCRIPT.replace(UI_VERSION_PLACEHOLDER, controlUiVersion())
}

export function renderControlUi(options: ControlUiOptions): string {
  const hubName = escapeHtml(options.hubName)
  /* data-* 属性里同样要转义（escapeHtml 已覆盖 & < > " '）；
     额外的 '<' → '\u003c' 只是纵深防御，避免任何实现上的意外。 */
  const bootHubId = escapeHtml(options.hubId).replace(/</g, '\\u003c')
  const bootHubName = escapeHtml(options.hubName).replace(/</g, '\\u003c')
  /* 服务端时间点的界面指纹。印进 HTML 是为了让**页面自己**能发现脚本是旧的：
     HTML 走 no-store/network-first，它上面的这一串永远是最新的；
     而脚本可能被三层缓存冻住。两者不一致 = "你跑的是旧脚本"（见 renderUiVersion）。 */
  const uiVersion = escapeHtml(controlUiVersion())

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#f5f5f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#161a22" media="(prefers-color-scheme: dark)">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="${hubName}">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<link rel="apple-touch-icon" href="/icon-180.png">
<title>DSEmployee 控制台 · ${hubName}</title>
<script>
/* 主题防闪烁：首屏渲染前读 localStorage 应用主题（默认日间）。
   生产 CSP（script-src 'self'）会拦下这段内联脚本——此时由 CONTROL_UI_SCRIPT
   启动时的 applyTheme() 兜底，深色用户最多闪一帧浅色。 */
try {
  document.documentElement.setAttribute(
    'data-theme',
    localStorage.getItem('dse.theme') === 'dark' ? 'dark' : 'light',
  )
} catch (error) {}
</script>
<style>${CONTROL_UI_CSS}</style>
</head>
${renderControlBody({ bootHubId: bootHubId, bootHubName: bootHubName, uiVersion: uiVersion, scriptTag: renderScriptTag(options) })}
</html>
`
}

/**
 * 决定脚本怎么进页面。
 *
 * 外部引用是默认的生产形态（满足 `script-src 'self'`）；内联是离线单文件形态。
 * 两条路径引用的是**同一份** `CONTROL_UI_SCRIPT`，不存在两份需要同步的代码。
 *
 * 版本查询串在这里**自动补上**（调用方只给 `/ui.js` 也不会漏）：忘带版本的后果是
 * 浏览器按裸 URL 缓存旧脚本，而"缓存住旧脚本"正是上面 `controlUiVersion()` 注释里
 * 那类"电脑对、手机不对"故障的成因 —— 这种事不该依赖调用方记得。
 */
function renderScriptTag(options: ControlUiOptions): string {
  const url = options.scriptUrl
  if (url !== undefined && url !== '') {
    const versioned = url.indexOf('?') < 0 ? `${url}?v=${controlUiVersion()}` : url
    return `<script type="module" src="${escapeHtml(versioned)}"></script>`
  }
  return `<!-- 内联模式：部署时须放宽 CSP 的 script-src，否则本脚本会被浏览器拦截 -->\n<script type="module">\n${servedControlUiScript()}\n</script>`
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 自检（内联 JS 是字符串，tsc 不检查它 —— 必须单独跑）：
 *
 *   cd dsemployee
 *   node --input-type=module -e "import('./src/web/ui.ts').then(function(m){require('node:fs').writeFileSync('ui-check.mjs', m.renderControlUiScript())})"
 *   node --check ui-check.mjs
 *   del ui-check.mjs
 * ═══════════════════════════════════════════════════════════════════════════ */
