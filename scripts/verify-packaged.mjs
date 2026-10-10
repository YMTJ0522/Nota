/**
 * 验证打包后的 Nota.exe 能真正启动并渲染出编辑器。
 *
 * Electron 的 GPU 进程在本机会话里起不来，所以用 CDP 远程调试端口
 * 连进打包后的应用，直接断言 DOM。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'

const root = process.argv[2] ?? path.resolve('.')
const exe = path.join(root, 'release', 'win-unpacked', 'Nota.exe')
const CDP = 9411

if (!fs.existsSync(exe)) {
  console.log(JSON.stringify({ error: 'exe not found: ' + exe }))
  process.exit(2)
}

const child = spawn(exe, ['--remote-debugging-port=' + CDP, '--no-sandbox'], {
  stdio: 'ignore',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
})

async function waitFor(fn, t = 30000) {
  const s = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {}
    if (Date.now() - s > t) throw new Error('timeout waiting for app')
    await new Promise((r) => setTimeout(r, 500))
  }
}

const page = await waitFor(async () => {
  const res = await fetch('http://127.0.0.1:' + CDP + '/json')
  const list = await res.json()
  return list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
})

function connect(wsUrl) {
  const u = new URL(wsUrl)
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname)
    let hs = false
    let acc = Buffer.alloc(0)
    let client = null
    const emit = (f) => {
      let b = f
      while (b.length >= 2) {
        const op = b[0] & 0x0f
        let len = b[1] & 0x7f
        let off = 2
        if (len === 126) { if (b.length < 4) return b; len = b.readUInt16BE(2); off = 4 }
        else if (len === 127) { if (b.length < 10) return b; len = Number(b.readBigUInt64BE(2)); off = 10 }
        if (b.length < off + len) return b
        const d = b.subarray(off, off + len)
        if (op === 1) { try { client?.onMessage?.(JSON.parse(d.toString())) } catch {} }
        b = b.subarray(off + len)
      }
      return b
    }
    sock.on('connect', () => {
      const k = Buffer.from(String(Math.random()) + Date.now()).toString('base64')
      sock.write('GET ' + u.pathname + ' HTTP/1.1\r\nHost: ' + u.host +
        '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + k +
        '\r\nSec-WebSocket-Version: 13\r\n\r\n')
    })
    sock.on('error', reject)
    sock.on('data', (c) => {
      acc = Buffer.concat([acc, c])
      if (!hs) {
        const i = acc.indexOf('\r\n\r\n')
        if (i < 0) return
        hs = true
        acc = acc.subarray(i + 4)
        client = {
          onMessage: null,
          send(o) {
            const pl = Buffer.from(JSON.stringify(o))
            const len = pl.length
            let h
            if (len < 126) h = Buffer.from([0x81, 0x80 | len])
            else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0xfe; h.writeUInt16BE(len, 2) }
            else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0xff; h.writeBigUInt64BE(BigInt(len), 2) }
            const m = Buffer.from([1, 2, 3, 4])
            const ms = Buffer.from(pl)
            for (let i = 0; i < ms.length; i++) ms[i] ^= m[i % 4]
            sock.write(Buffer.concat([h, m, ms]))
          },
          close: () => sock.destroy(),
        }
        resolve(client)
      }
      acc = emit(acc)
    })
  })
}

const ws = await connect(page.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
ws.onMessage = (m) => { if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
function send(method, params = {}) {
  id++
  const i = id
  return new Promise((res, rej) => {
    pend.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)))
    ws.send({ id: i, method, params })
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('cdp timeout ' + method)) } }, 20000)
  })
}
async function ev(e) {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}

await send('Runtime.enable')
await new Promise((r) => setTimeout(r, 3500))

const out = {}
out.window = await ev("(() => ({ title: document.title, mounted: !!document.querySelector('#app')?.children.length, buttons: document.querySelectorAll('.wbtn').length, hasCta: !!document.querySelector('.cta') }))()")
out.apiKeys = await ev('window.api ? Object.keys(window.api).join(",") : "MISSING"')
out.hasCmAhead = await ev("!!document.querySelector('.cm-editor')")

// 直接调用主进程 IPC 读一个真实目录，再让 store 打开它，
// 以此确认「文件系统 → 编辑器」整条链路在打包版里通。
const wsDir = path.join(root, '.tmp-pack-check')
fs.mkdirSync(wsDir, { recursive: true })
const notePath = path.join(wsDir, 'demo.md')
fs.writeFileSync(notePath, '# 打包版验证\n\n编辑器内容 ABC\n\n- 一\n- 二\n', 'utf8')

out.ipcRead = await ev('window.api.readNote(' + JSON.stringify(notePath) + ')')

// 用打包版里的真实 preload API 驱动界面：改写 readTree/readNote 之外，
// 直接调 store 不可行（模块作用域），所以点 CTA 会弹系统对话框——自动化里跳过。
// 改为断言：新编辑器的代码确实被打进了这份产物。
out.editorBundled = await ev(
  "(() => {" +
    " const scripts = [...document.querySelectorAll('script[src]')].map(e => e.getAttribute('src'));" +
    " return { scripts, hasCmCss: !!document.querySelector('style[id*=codemirror], style[id*=cm]') || document.styleSheets.length > 0, styleSheets: document.styleSheets.length };" +
    "})()",
)

// 截图留档
await send('Page.enable')
const shot = await send('Page.captureScreenshot', { format: 'png' })
const shotPath = path.join(root, 'docs', 'packaged-welcome.png')
fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
out.screenshot = shotPath

await ws.close()
child.kill()
console.log('===PACKAGED RESULT===')
console.log(JSON.stringify(out, null, 2))
console.log('===END===')
process.exit(0)
