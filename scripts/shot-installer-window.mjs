/**
 * 真机验证安装窗：伪造 PORTABLE_EXECUTABLE_FILE 让 maybeRunInstaller 走安装分支，
 * 用 CDP 给安装窗截图。
 *   node scripts/shot-installer-window.mjs <exe路径> <输出png> [uninstall]
 * 免编译依赖：用 node 22 自带的 fetch + WebSocket 直接说 CDP 协议。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const [exe, outPng, mode] = process.argv.slice(2)
if (!exe || !outPng) {
  console.error('用法: node shot-installer-window.mjs <exe> <out.png> [uninstall]')
  process.exit(2)
}

/* ELECTRON_RUN_AS_NODE 是沙箱环境自带的 —— 不删掉，spawn 出来的
   Electron 会变成纯 Node，一个窗口都不开。 */
delete process.env.ELECTRON_RUN_AS_NODE
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-inst-shot-'))
const PORT = 9224

const args = [`--remote-debugging-port=${PORT}`]
if (mode === 'uninstall') args.push('--uninstall')

const child = spawn(exe, args, {
  cwd: path.dirname(exe),
  env: {
    ...process.env,
    PORTABLE_EXECUTABLE_FILE: exe,
    NOTA_HOME: home,
  },
  stdio: 'ignore',
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findInstallerTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = list.find(
        (t) => t.type === 'page' && /install/i.test(t.url + t.title),
      )
      if (page) return page
    } catch { /* 还没起 */ }
    await sleep(500)
  }
  return null
}

/* CDP WebSocket 客户端：send{id,method,params} → 等 id 匹配的回包 */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({
      send: (method, params = {}) =>
        new Promise((res) => {
          const id = ++seq
          pending.set(id, res)
          ws.send(JSON.stringify({ id, method, params }))
        }),
      close: () => ws.close(),
    }),
    ws.onerror = reject
  })
}

try {
  const target = await findInstallerTarget()
  if (!target) throw new Error('40 秒内没等到安装窗')
  const c = await cdp(target.webSocketDebuggerUrl)
  await c.send('Page.enable')
  await sleep(1200) // 等首屏字体/图标渲染完
  const shot = await c.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'))
  console.log('截图完成:', outPng, `(${(fs.statSync(outPng).size / 1024).toFixed(0)} KB)`)
  await c.close()
} finally {
  child.kill()
  await sleep(500)
  fs.rmSync(home, { recursive: true, force: true })
}
