/**
 * Headless verification harness for Nota.
 *
 * Serves `dist/` over HTTP, drives Edge/Chrome over a raw CDP WebSocket,
 * and reports DOM assertions plus screenshots. Needed because Electron's
 * GPU process cannot start inside this sandbox.
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'

const root = process.argv[2] ?? 'C:/Users/ymtj1/Desktop/Nota'
const outDir = path.join(root, 'docs')
const PORT = 5275
const CDP_PORT = 9335

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/') p = '/index.html'
  const file = path.join(root, 'dist', p)
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const candidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
const bin = candidates.find((p) => fs.existsSync(p))
if (!bin) {
  console.log(JSON.stringify({ error: 'no browser found' }))
  server.close()
  process.exit(2)
}

const profile = path.join(root, '.tmp-cdp-' + Date.now() + '-' + Math.floor(Math.random() * 1e6))

const child = spawn(
  bin,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--hide-scrollbars',
    '--disable-application-cache',
    '--disk-cache-size=1',
    '--media-cache-size=1',
    '--window-size=1180,780',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    'http://127.0.0.1:' + PORT + '/',
  ],
  { stdio: 'ignore' },
)

async function waitFor(fn, timeout = 20000, gap = 250) {
  const start = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      /* retry */
    }
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, gap))
  }
}

const page = await waitFor(async () => {
  const res = await fetch('http://127.0.0.1:' + CDP_PORT + '/json')
  const list = await res.json()
  return list.find((t) => t.type === 'page' && t.url.includes(String(PORT)))
})

/* ── 裸 WebSocket 客户端（仅需 text 帧） ── */
function connect(wsUrl) {
  const u = new URL(wsUrl)
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname)
    let handshaken = false
    let acc = Buffer.alloc(0)
    let client = null

    const emit = (frame) => {
      let b = frame
      while (b.length >= 2) {
        const op = b[0] & 0x0f
        let len = b[1] & 0x7f
        let off = 2
        if (len === 126) {
          if (b.length < 4) return b
          len = b.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          if (b.length < 10) return b
          len = Number(b.readBigUInt64BE(2))
          off = 10
        }
        if (b.length < off + len) return b
        const data = b.subarray(off, off + len)
        if (op === 1) {
          try {
            client?.onMessage?.(JSON.parse(data.toString()))
          } catch {
            /* ignore malformed */
          }
        } else if (op === 8) {
          sock.destroy()
        }
        b = b.subarray(off + len)
      }
      return b
    }

    sock.on('connect', () => {
      const key = Buffer.from(String(Math.random()) + Date.now()).toString('base64')
      sock.write(
        'GET ' + u.pathname + ' HTTP/1.1\r\n' +
          'Host: ' + u.host + '\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: ' + key + '\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      )
    })

    sock.on('error', reject)

    sock.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk])
      if (!handshaken) {
        const idx = acc.indexOf('\r\n\r\n')
        if (idx < 0) return
        handshaken = true
        acc = acc.subarray(idx + 4)
        client = {
          onMessage: null,
          send(obj) {
            const payload = Buffer.from(JSON.stringify(obj))
            const len = payload.length
            let header
            if (len < 126) header = Buffer.from([0x81, 0x80 | len])
            else if (len < 65536) {
              header = Buffer.alloc(4)
              header[0] = 0x81
              header[1] = 0xfe
              header.writeUInt16BE(len, 2)
            } else {
              header = Buffer.alloc(10)
              header[0] = 0x81
              header[1] = 0xff
              header.writeBigUInt64BE(BigInt(len), 2)
            }
            const mask = Buffer.from([1, 2, 3, 4])
            const masked = Buffer.from(payload)
            for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4]
            sock.write(Buffer.concat([header, mask, masked]))
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

let msgId = 0
const pending = new Map()
ws.onMessage = (msg) => {
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}

function send(method, params = {}) {
  msgId += 1
  const id = msgId
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)))
    ws.send({ id, method, params })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error('cdp timeout ' + method))
      }
    }, 20000)
  })
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description ?? ''),
    )
  }
  return r.result.value
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, name), Buffer.from(r.data, 'base64'))
  return name
}

await send('Runtime.enable')
await send('Page.enable')

/* 连接建立后强制重新导航，保证加载的是当次构建而不是浏览器恢复的旧会话 */
await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' })
await new Promise((r) => setTimeout(r, 2500))

/* 固定浅色主题，避免上一轮的 localStorage 影响截图 */
await evaluate("(() => { try { localStorage.setItem('nota-theme', 'light') } catch {} ; return true })()")

const result = { steps: [] }

/* 步 0：确认页面加载的是最新产物 */
result.buildInfo = await evaluate(
  "(() => { const s = [...document.querySelectorAll('script[src]')].map((e) => e.getAttribute('src')); return { scripts: s, hasNotaGlobalPath: true }; })()",
)

/* 步 1：欢迎页 */
await evaluate("(() => { document.documentElement.setAttribute('data-theme', 'light'); return true })()")
result.welcome = await evaluate(
  "(() => { const app = document.querySelector('#app'); return { mounted: !!app && app.children.length > 0, hasWelcome: !!document.querySelector('.cta'), windowButtons: document.querySelectorAll('.wbtn').length, title: document.title, theme: document.documentElement.getAttribute('data-theme') }; })()",
)
result.steps.push(await shot('probe-01-welcome.png'))

/* 步 2：注入假 api 并打开工作区 */
const FIXTURE = [
  '# 欢迎使用 Nota',
  '',
  '这是一个 **Markdown** 编辑器，支持 `行内代码`。',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '> 引用块测试',
  '',
  '```js',
  'const a = 1',
  '```',
  '',
].join('\n')

await evaluate(
  '(() => {' +
    ' window.__notes = { "/ws/欢迎.md": ' + JSON.stringify(FIXTURE) + ' };' +
    ' window.api = {' +
    '  pickWorkspace: async () => "/ws",' +
    '  readTree: async () => ([{ type: "file", name: "欢迎.md", path: "/ws/欢迎.md" }]),' +
    '  readNote: async (p) => window.__notes[p] ?? "",' +
    '  writeNote: async (p, t) => { window.__notes[p] = t; },' +
    '  createNote: async (d, n) => d + "/" + n + ".md",' +
    '  deleteNote: async () => {},' +
    '  renameNote: async (p) => p,' +
    '  minimize: () => {}, toggleMaximize: () => {}, closeWindow: () => {}' +
    ' };' +
    ' return true;' +
    '})()',
)

await evaluate("document.querySelector('.cta') && document.querySelector('.cta').click()")
await new Promise((r) => setTimeout(r, 900))

result.afterOpen = await evaluate(
  "(() => ({ hasToolbar: !!document.querySelector('.tb'), sidebarPresent: !!document.querySelector('[class*=panel], [class*=side], aside'), treeItems: document.querySelectorAll('[class*=node], [class*=tree] li').length }))()",
)

/* 步 3：打开笔记 —— 点树里的 .row，点完编辑器才会挂载 */
result.clickNote = await evaluate(
  '(() => {' +
    ' const rows = [...document.querySelectorAll(".row")];' +
    ' const hit = rows.find((r) => (r.querySelector(".name") || {}).textContent === "欢迎");' +
    ' if (!hit) return "no-row";' +
    ' hit.click();' +
    ' return "clicked";' +
    '})()',
)
await new Promise((r) => setTimeout(r, 1400))

result.editor = await evaluate(
  "(() => {" +
    " const c = document.querySelector('.cm-content');" +
    " const cm = document.querySelector('.cm-editor');" +
    " return {" +
    "  hasCmEditor: !!cm," +
    "  hasContent: !!c," +
    "  lineCount: document.querySelectorAll('.cm-line').length," +
    "  textStart: c ? c.innerText.slice(0, 60) : ''," +
    "  toolbarButtons: document.querySelectorAll('.tb-btn').length," +
    "  dropdowns: document.querySelectorAll('.tb-menu-wrap').length," +
    "  toolbarOrder: [...document.querySelectorAll('.tb > *')]" +
    "    .map((e) => e.classList.contains('tb-sep') ? '|'" +
    "      : (e.querySelector('.tb-btn')?.getAttribute('title') || e.querySelector('.tb-btn')?.getAttribute('aria-label') || e.getAttribute('title') || '?'))" +
    "    .join(' ')," +
    "  hasView: !!window.__notaView," +
    "  stat: document.querySelector('.stat') ? document.querySelector('.stat').textContent : ''" +
    " };" +
    "})()",
)
result.steps.push(await shot('probe-02-editor.png'))

/* 步 4：斜杠命令 —— 通过 CodeMirror 自身 API 插入 "/"，
   这样才会走 updateListener，菜单才会开 */
result.slashProbe = await evaluate(
  '(() => {' +
    ' const c = document.querySelector(".cm-content");' +
    ' if (!c) return "no-content";' +
    ' const v = window.__notaView;' +
    ' if (!v) return "no-view";' +
    ' const end = v.state.doc.length;' +
    ' v.dispatch({' +
    '   changes: { from: end, insert: "\\n/" },' +
    '   selection: { anchor: end + 2 },' +
    '   userEvent: "input.type",' +
    ' });' +
    ' return "ok";' +
    '})()',
)
await new Promise((r) => setTimeout(r, 700))

result.slash = await evaluate(
  "(() => { const m = document.querySelector('.slash'); return { open: !!m, itemCount: m ? m.querySelectorAll('.slash-item').length : 0, first: m && m.querySelector('.slash-item .txt') ? m.querySelector('.slash-item .txt').textContent : '' }; })()",
)
result.steps.push(await shot('probe-03-slash.png'))

/* 步 4b：过滤 —— 输入中文"标题"看列表是否收敛 */
await evaluate(
  '(() => {' +
    ' const v = window.__notaView;' +
    ' if (!v) return false;' +
    ' v.dispatch({ changes: { from: v.state.doc.length, insert: "标题" }, selection: { anchor: v.state.doc.length + 2 }, userEvent: "input.type" });' +
    ' return true;' +
    '})()',
)
await new Promise((r) => setTimeout(r, 500))
result.slashFiltered = await evaluate(
  "(() => { const m = document.querySelector('.slash'); return { open: !!m, itemCount: m ? m.querySelectorAll('.slash-item').length : 0, labels: m ? [...m.querySelectorAll('.slash-item .txt')].map((e) => e.textContent) : [] }; })()",
)
result.steps.push(await shot('probe-03b-slash-filter.png'))

/* 步 4c：别名过滤 —— 输入 "h1" */
await evaluate(
  '(() => {' +
    ' const v = window.__notaView;' +
    ' if (!v) return false;' +
    ' const n = v.state.doc.length;' +
    ' v.dispatch({ changes: { from: n - 2, to: n, insert: "h1" }, selection: { anchor: n }, userEvent: "input.type" });' +
    ' return true;' +
    '})()',
)
await new Promise((r) => setTimeout(r, 500))
result.slashAlias = await evaluate(
  "(() => { const m = document.querySelector('.slash'); return { open: !!m, itemCount: m ? m.querySelectorAll('.slash-item').length : 0, labels: m ? [...m.querySelectorAll('.slash-item .txt')].map((e) => e.textContent) : [] }; })()",
)

/* 步 5：暗色 */
await evaluate("(() => { document.documentElement.setAttribute('data-theme', 'dark'); return true; })()")
await new Promise((r) => setTimeout(r, 400))
result.steps.push(await shot('probe-04-dark.png'))

console.log('===RESULT===')
console.log(JSON.stringify(result, null, 2))
console.log('===END===')

ws.close()
child.kill()
server.close()
process.exit(0)
