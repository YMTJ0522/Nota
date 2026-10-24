/**
 * 用 esbuild 单独构建主进程与 preload，输出确定性的 CJS。
 *
 * 为什么不用 vite-plugin-electron：
 *   该插件在 dev 模式下会覆盖 rollupOptions.output.format，强制输出 ESM，
 *   导致 .cjs 文件里出现 import 语句而崩溃。在这里完全绕开它。
 */
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  // electron 与 node 内置模块不打进产物
  external: ['electron'],
  logLevel: 'info',
}

const targets = [
  { entryPoints: [path.join(root, 'electron/main.ts')], outfile: path.join(root, 'dist-electron/main.cjs') },
  { entryPoints: [path.join(root, 'electron/preload.ts')], outfile: path.join(root, 'dist-electron/preload.cjs') },
  // 安装窗单独一个 preload：那个窗口是从 resources 里加载的静态页，
  // 不该拿到主界面的全套 IPC
  {
    entryPoints: [path.join(root, 'electron/installer-preload.ts')],
    outfile: path.join(root, 'dist-electron/installer-preload.cjs'),
  },
  // 便签窗口同理，而且更彻底：它拿不到笔记、工作区、AI、云同步的任何方法，
  // 只有「读自己 / 写自己 / 关自己」这一小把
  {
    entryPoints: [path.join(root, 'electron/preload-sticky.ts')],
    outfile: path.join(root, 'dist-electron/preload-sticky.cjs'),
  },
]

if (watch) {
  const ctxs = await Promise.all(targets.map((t) => esbuild.context({ ...common, ...t })))
  await Promise.all(ctxs.map((c) => c.watch()))
  console.log('[electron] watching main + preload ...')
} else {
  await Promise.all(targets.map((t) => esbuild.build({ ...common, ...t })))
  console.log('[electron] build done')
}
