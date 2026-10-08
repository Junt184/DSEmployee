#!/usr/bin/env node
/**
 * `dse` 的可执行入口。
 *
 * 之所以是一个 `.mjs` 垫片而不是直接编译产物：它让 `bin/dse.mjs` 在**未编译**时也能跑
 * （Node 24 原生剥离 TS 类型），开发期不用先 build 就能用；编译后则优先加载 `dist/`。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const compiled = path.join(here, '..', 'dist', 'src', 'cli.js')
const source = path.join(here, '..', 'src', 'cli.ts')

if (existsSync(compiled)) {
  /* 从编译产物加载时必须**说出来**。这个"优先 dist"的规则踩过两次：
   *   ① 部署时误把本地 dist/ 推上服务器，公网 Hub 从此跑编译产物、源码改动一行都不生效；
   *   ② 共享工作区里别人 `npm run build` 一次，本机 Hub 悄悄改跑旧编译产物，
   *      新写的代码在页面上完全不出现 —— 看起来像"改了没生效"，实际是加载了别的东西。
   * 一句话成本，换掉一整类"沉默地跑着另一份代码"的排查。 */
  process.stderr.write(
    `dse: 从编译产物加载（${path.relative(process.cwd(), compiled)}）。` +
      '源码改动不会生效；要跑最新源码请删掉 dist/，或重新 npm run build。\n',
  )
  await import(new URL(`file://${compiled.replace(/\\/g, '/')}`))
} else if (existsSync(source)) {
  await import(new URL(`file://${source.replace(/\\/g, '/')}`))
} else {
  process.stderr.write(
    'dse: neither dist/src/cli.js nor src/cli.ts was found. Run "npm run build" first.\n',
  )
  process.exit(1)
}
