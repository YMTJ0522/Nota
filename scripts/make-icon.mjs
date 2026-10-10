/**
 * 生成应用图标：build/icon.svg → build/icon.ico（多尺寸）+ build/icon.png
 *
 * 为什么要这个包装脚本，而不是直接 `electron build/make-icon.cjs`：
 *
 * 本机（以及任何从某些工具链继承环境的地方）会带上 ELECTRON_RUN_AS_NODE=1。
 * 一旦带上它，electron.exe 会**退化成纯 Node**，`require('electron').app`
 * 直接是 undefined，报错是 `Cannot read properties of undefined (reading 'commandLine')`
 * —— 看起来像代码 bug，其实是环境问题，很难猜。
 *
 * 所以这里显式把该变量从子进程环境里删掉再启动。
 * 注意不能用 `ELECTRON_RUN_AS_NODE: ''`：Windows 上空字符串仍视为「已设置」。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '..')

/* electron 包导出的是可执行文件路径 */
const electronBin = require('electron')
if (typeof electronBin !== 'string' || !fs.existsSync(electronBin)) {
  console.error('找不到 electron 可执行文件，先跑 npm install')
  process.exit(1)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electronBin, [path.join(ROOT, 'build', 'make-icon.cjs')], {
  cwd: ROOT,
  stdio: 'inherit',
  env,
})

child.on('exit', (code) => process.exit(code ?? 1))
