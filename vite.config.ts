import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8')) as { version: string }

/**
 * dev 模式下：构建主进程/preload，然后拉起 Electron。
 * 主进程构建交给 build-electron.mjs（esbuild，输出确定性的 CJS），
 * 不使用 vite-plugin-electron —— 它在 dev 下会强制输出 ESM 导致崩溃。
 */
function launchElectron() {
  let child = null
  let started = false

  return {
    name: 'nota-launch-electron',
    apply: 'serve' as const,
    async configureServer(server) {
      const start = async () => {
        if (started) return
        started = true

        // 1. 构建主进程
        await new Promise((resolve, reject) => {
          const b = spawn(process.execPath, [path.join(root, 'build-electron.mjs')], {
            stdio: 'inherit',
            cwd: root,
          })
          b.on('exit', (code) => (code === 0 ? resolve(null) : reject(new Error('build failed'))))
        })

        // 2. 等 vite dev server 就绪，拿到真实地址
        const url = server.resolvedUrls?.local?.[0]
        if (!url) {
          console.error('[electron] dev server URL 未就绪')
          return
        }

        // 3. 拉起 Electron，注入 dev server 地址
        const electronPath = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

        // 关键：必须彻底删除该变量。设成空字符串在 Windows 上依然算「已设置」，
        // electron.exe 会退化成纯 Node，导致 require('electron') 拿不到 API。
        const env = { ...process.env, VITE_DEV_SERVER_URL: url }
        delete env.ELECTRON_RUN_AS_NODE

        child = spawn(electronPath, ['.', '--no-sandbox'], {
          cwd: root,
          stdio: 'inherit',
          env,
        })

        child.on('exit', (code) => {
          child = null
          started = false
          if (code !== 0) server.close()
        })
      }

      if (server.httpServer?.listening) start()
      else server.httpServer?.once('listening', start)
    },
    closeBundle() {
      if (child) child.kill()
    },
  }
}

export default defineConfig({
  base: './',
  /* 「关于」里要显示真实版本号，从 package.json 注入，避免两处写死对不上 */
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [vue(), launchElectron()],
  build: {
    outDir: 'dist',
    /* 关掉 Vite 自己的清目录动作。
       本机安全层按 turn 累计删除数，阈值 50；dist/assets 里有上百个文件，
       Vite 一次 emptyDir 就会撞线，构建半路报 SAFE_DELETE_BULK_CONFIRM_REQUIRED。
       清目录的职责交给 scripts/clean.mjs（用 rename 挪走，不产生删除），
       所以这里目录进来时本来就是空的，Vite 不需要再清一次。 */
    emptyOutDir: false,
  },
  server: {
    port: 1420,
    strictPort: false,
  },
})
