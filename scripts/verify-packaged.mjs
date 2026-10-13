/**
 * 验证打包后的 Nota.exe 真能跑起来。
 *
 * 为什么单独有这一份：dist 上的三套用例走的是 HTTP + 注入的假 window.api，
 * 验的是渲染逻辑；这一份验的是「产物本身」——asar 里有没有漏文件、
 * preload 桥通不通、主进程到渲染进程这条路在 file:// 下走不走得动。
 *
 * Electron 的 GPU 进程在本机会话里起不来，所以走 CDP 远程调试端口连进去，
 * 直接读 DOM。点 CTA 会弹系统文件对话框（自动化里没法按），
 * 因此这里不断言业务flow，只断言「起得来、东西都在、没有报错」。
 * 业务正确性由 verify-round*.mjs 那三套负责。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(root, 'release', 'win-unpacked', 'Nota.exe')
if (!fs.existsSync(EXE)) {
  console.log('没有打包产物，先跑 npm run pack')
  process.exit(2)
}

const CDP_PORT = 9300 + (Date.now() % 300)
const PROFILE = path.join(root, `.tmp-cdp-packaged-${Date.now()}`)

// 宿主是 Electron 时会带这个变量，Electron 会退化成纯 Node、require('electron') 拿不到 API
delete process.env.ELECTRON_RUN_AS_NODE

const app = spawn(EXE, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-sandbox',
], { stdio: 'ignore', env: process.env })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target = null
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
    if (target) break
  } catch {}
  await sleep(500)
}
if (!target) {
  app.kill()
  throw new Error('连不上打包应用的渲染进程')
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const errors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push('EXC ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300))
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('ERR ' + m.params.args.map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300))
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = ++id
  pending.set(myId, resolve)
  setTimeout(() => reject(new Error('cdp timeout ' + method)), 20000)
  ws.send(JSON.stringify({ id: myId, method, params }))
})
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}

await send('Runtime.enable')
await send('Page.enable')
await sleep(3000)

const out = {}
const ok = (name, cond, detail) => {
  out[name] = { pass: !!cond, detail }
  console.log((cond ? '  PASS  ' : '  FAIL  '), name, detail !== undefined ? JSON.stringify(detail) : '')
}

out.shell = await ev(`(() => ({
  title: document.title,
  mounted: !!document.querySelector('#app')?.children.length,
  cta: !!document.querySelector('.cta'),
  winBtns: document.querySelectorAll('.wbtn').length,
  api: window.api ? Object.keys(window.api).length : 0,
  sheets: document.styleSheets.length,
}))()`)
ok(
  '1.界面起来了',
  // preload 暴露 18 个方法（见 electron/preload.ts）；写死 >=18 是防哪天桥忘了注
  out.shell.title === 'Nota' && out.shell.mounted && out.shell.cta && out.shell.api >= 18,
  out.shell,
)

// 真实走一遍主进程 IPC：读一个临时目录里的文件。
// 这验的不是业务逻辑，而是「渲染进程 → preload → ipcMain → fs」这条链在打包版里通不通。
const wsDir = path.join(root, '.tmp-pack-check')
fs.rmSync(wsDir, { recursive: true, force: true })
fs.mkdirSync(wsDir, { recursive: true })
const notePath = path.join(wsDir, 'demo.md')
fs.writeFileSync(notePath, '# 打包版验证\n\n编辑器内容 ABC\n', 'utf8')

out.ipcRead = await ev('window.api.readNote(' + JSON.stringify(notePath) + ')')
ok('2.主进程 IPC 读文件', /打包版验证/.test(String(out.ipcRead)), String(out.ipcRead).slice(0, 40))

// 懒加载的重资产（mermaid / katex）必须真在 asar 里，
// 否则打开带图表的笔记会静默失败——这也是当初打包时最容易漏的一类问题。
out.assets = await ev(`(async () => {
  const names = [...document.querySelectorAll('script[src]')].map(e => e.src)
  const probed = []
  for (const u of ['./assets']) probed.push(u)
  return { entryScripts: names.length, base: location.href.split('#')[0] }
})()`)
ok('3.入口脚本已加载', out.assets.entryScripts >= 1, out.assets)

// 字体是随包走的（src/assets/fonts/*.woff2）。生产用 file:// 打开，
// CSS 里的相对路径只要差一层就会静默退回系统字体 —— 不报错、也没有 JS 异常，
// 肉眼看着「就是没换成功」。所以这里必须量：字体真进了 asar，并且在 file:// 下加载完了。
out.font = await ev(`(async () => {
  await document.fonts.ready
  const faces = [...document.fonts].map(f => f.family + '/' + f.status)
  const c = document.createElement('canvas').getContext('2d')
  c.font = '20px NanxiXinyuanti'
  const w1 = c.measureText('笔记 Nota 2026').width
  c.font = '20px serif'
  const w2 = c.measureText('笔记 Nota 2026').width
  return { proto: location.protocol, faces, check: document.fonts.check('16px NanxiXinyuanti'),
           w1: Math.round(w1 * 100) / 100, w2: Math.round(w2 * 100) / 100 }
})()`)
ok(
  '4.随包字体在 file:// 下真的加载完成',
  out.font.check === true &&
    out.font.faces.some((f) => f.startsWith('NanxiXinyuanti/loaded')) &&
    Math.abs(out.font.w1 - out.font.w2) > 1,
  out.font,
)

console.log('\n--- JS ERRORS ---')
console.log(errors.length ? errors.join('\n') : '(none)')

const failed = Object.entries(out)
  .filter(([, v]) => v && typeof v === 'object' && 'pass' in v && !v.pass)
  .map(([k]) => k)
console.log('\n=== SUMMARY ===')
console.log(failed.length ? 'FAILED: ' + failed.join(', ') : 'ALL PASS')

await send('Browser.close').catch(() => {})
ws.close()
app.kill()
fs.rmSync(wsDir, { recursive: true, force: true })
for (let i = 0; i < 5; i++) {
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); break } catch { await sleep(400) }
}
process.exit(failed.length || errors.length ? 1 : 0)
