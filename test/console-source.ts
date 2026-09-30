/**
 * 控制台源码的统一读取口（拆文件之后）。
 *
 * 背景：控制台原本是**一个** `src/web/ui.ts`（10,263 行，其中客户端 JS 是一个 8,302 行的
 * `String.raw` 字符串）。许多测试靠"在这个文件里搜字符串"来钉机制
 * （例如"提交时把意图同步成这一次要改成的名字"）—— 拆分之后那段代码可能落在
 * `src/web/script/` 的任何一个片段里，测试就读不到了。
 *
 * 所以给测试一个统一入口，而不是让每个测试自己拼路径：
 *   · `UI_SOURCE`      —— 只有 ui.ts（组装处 + 页面模板 + CSS）。**需要 CSS/标记的用这个。**
 *   · `SCRIPT_CHUNKS`  —— 按拼接顺序排列的脚本片段（`src/web/script/*.ts`）。
 *   · `CONSOLE_SOURCE` —— ui.ts + 全部片段的文本（顺序拼接）。**搜 JS 机制用这个**：
 *     它是一个超集，"某处**不该**出现 X"这类否定断言在超集上更强。
 *
 * 为什么不让测试直接 `import` 片段常量：那会 import 整个控制台模块，而有些护栏
 * （比如模板结构守卫）必须在"模板已经被反引号截断、模块根本 import 不了"的情况下
 * 仍然能跑并报出行号。
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const WEB_DIR = path.join(import.meta.dirname, '..', 'src', 'web')
const SCRIPT_DIR = path.join(WEB_DIR, 'script')

/** 组装处（页面模板 + CSS + 片段拼接） */
export const UI_SOURCE = readFileSync(path.join(WEB_DIR, 'ui.ts'), 'utf8')

/** 脚本片段：按文件名排序（= ui.ts 里的拼接顺序，`NN-name.ts` 前缀就是序号） */
export const SCRIPT_CHUNKS: Array<{ name: string; text: string }> = readdirSync(SCRIPT_DIR)
  .filter((name) => name.endsWith('.ts'))
  .sort()
  .map((name) => ({ name, text: readFileSync(path.join(SCRIPT_DIR, name), 'utf8') }))

/** 样式：`src/web/css.ts`（页面 CSS 拆出去之后，断言 CSS 的都该读它） */
export const CSS_SOURCE = readFileSync(path.join(WEB_DIR, 'css.ts'), 'utf8')

/** 页面标记：`src/web/markup.ts`（<body> 那一段） */
export const MARKUP_SOURCE = readFileSync(path.join(WEB_DIR, 'markup.ts'), 'utf8')

/** ui.ts + 样式 + 标记 + 全部片段：搜"某个机制/某条样式在不在"时用它（超集） */
export const CONSOLE_SOURCE = [UI_SOURCE, CSS_SOURCE, MARKUP_SOURCE, ...SCRIPT_CHUNKS.map((chunk) => chunk.text)].join('\n')
