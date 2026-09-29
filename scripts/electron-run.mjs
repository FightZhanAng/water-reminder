/**
 * 开发 / 预览启动器（electron-vite dev | preview）。
 *
 * 存在的唯一理由：环境里只要有 ELECTRON_RUN_AS_NODE，electron.exe 就会退化成
 * 普通 Node —— 主进程里 `require('electron')` 拿到的是 npm 包那个「路径转发壳」
 * 字符串，于是启动即崩：
 *
 *   TypeError: Cannot read properties of undefined (reading 'isPackaged')
 *   at out/main/index.js:790  ← 模块顶部算 APP_ID 的那一行
 *
 * 这个报错完全看不出真正的原因，而且 `electron-vite build` 一切正常，
 * 只有真跑起来才炸。变量在某些环境里是上层工具全局注入的，用户自己也不知道。
 * 所以不靠「记得先 unset」，直接在这儿摘掉。
 *
 * 用法与 electron-vite 一致：
 *   node scripts/electron-run.mjs dev
 *   node scripts/electron-run.mjs preview
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 项目根要用脚本自身位置推算。
// 在 pnpm 下 require.resolve 会返回 .pnpm 里的真实路径，
// 从那个路径往上两层拿到的是 node_modules 而不是项目根。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const require = createRequire(import.meta.url)
const packageFile = require.resolve('electron-vite/package.json')
const pkg = JSON.parse(readFileSync(packageFile, 'utf-8'))
const binField = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['electron-vite']
const cli = join(dirname(packageFile), binField)

const env = { ...process.env }
if (env.ELECTRON_RUN_AS_NODE !== undefined) {
  delete env.ELECTRON_RUN_AS_NODE
  console.log('[run] 环境里有 ELECTRON_RUN_AS_NODE，已为 electron 摘掉（不摘它会退化成普通 Node，启动即崩）')
}

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: ROOT,
  env,
  stdio: 'inherit'
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[run] 被信号 ${signal} 终止`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
