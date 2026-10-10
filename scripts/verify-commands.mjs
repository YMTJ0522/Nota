/**
 * 一次性验证：标题下拉的「正文」与隐藏注释 %% 是否真的作用于文本。
 * 跑法：node scripts/verify-commands.mjs
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'dist')
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json',
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/') p = '/index.html'
  const abs = path.join(DIST, p)
  if (!abs.startsWith(DIST) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404); res.end('nope'); return
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(abs)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(abs).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p))

const CDP_PORT = 9444 + Math.floor(Math.random() * 200)
const profile = path.join(os.tmpdir(), `.tmp-cmd-${Date.now()}-${Math.floor(Math.random() * 1e4)}`)

const edge = spawn(EDGE, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--no-first-run',
  '--disable-application-cache',
  '--disable-features=Translate',
  'about:blank',
], { stdio: 'ignore' })

function waitPort(port, tries = 80) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      const s = net.connect(port, '127.0.0.1')
      s.on('connect', () => { s.destroy(); resolve() })
      s.on('error', () => { s.destroy(); n <= 0 ? reject(new Error('cdp timeout')) : setTimeout(() => tick(n - 1), 250) })
    }
    tick(tries)
  })
}
await waitPort(CDP_PORT)

const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())
const page = targets.find((t) => t.type === 'page')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
await new Promise((r) => ws.addEventListener('open', r))

function send(method, params = {}) {
  const id = ++msgId
  return new Promise((resolve) => {
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1180, height: 760, deviceScaleFactor: 1, mobile: false,
})
const out = {}
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` })
await new Promise((r) => setTimeout(r, 2500))

/* 固定浅色主题，并注入假 api 打开一个工作区（headless 下没法用原生目录选择框） */
await evaluate("(() => { try { localStorage.setItem('nota-theme','light') } catch {} ; return true })()")

await evaluate(
  '(() => {' +
    ' window.__notes = { "/ws/测试.md": "占位内容" };' +
    ' window.api = {' +
    '  pickWorkspace: async () => "/ws",' +
    '  readTree: async () => ([{ type: "file", name: "测试.md", path: "/ws/测试.md" }]),' +
    '  readNote: async (p) => window.__notes[p] ?? "",' +
    '  writeNote: async (p, t) => { window.__notes[p] = t; },' +
    '  createNote: async (d, n) => d + "/" + n + ".md",' +
    '  deleteNote: async () => {},' +
    '  renameNote: async (p) => p,' +
    '  pickImage: async () => null,' +
    '  minimize: () => {}, toggleMaximize: () => {}, closeWindow: () => {}, onMaximizeChange: () => {}' +
    ' };' +
    ' return true;' +
    '})()',
)

await evaluate("document.querySelector('.cta') && document.querySelector('.cta').click()")
await new Promise((r) => setTimeout(r, 900))
out.boot = await evaluate(
  "(() => ({ cta: !!document.querySelector('.cta'), rows: document.querySelectorAll('.tree .row').length, cm: !!document.querySelector('.cm-editor'), view: !!window.__notaView }))()",
)
await evaluate("(() => { const el = document.querySelector('.tree .row'); if (el) el.click(); return !!el; })()")
await new Promise((r) => setTimeout(r, 1000))

/** 在编辑器里整段替换内容，方便断言 */
async function setDoc(text) {
  return evaluate(
    '(() => {' +
      ' const v = window.__notaView; if (!v) return "no-view";' +
      ' v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ' + JSON.stringify(text) + ' },' +
      '   selection: { anchor: 0 }, userEvent: "input.type" });' +
      ' return v.state.doc.toString();' +
      '})()',
  )
}

/** 选中第 1 行，返回选中的文本 */
async function selectLine(n = 1) {
  return evaluate(
    '(() => {' +
      ' const v = window.__notaView;' +
      ' const line = v.state.doc.line(' + n + ');' +
      ' v.dispatch({ selection: { anchor: line.from, head: line.to } });' +
      ' return v.state.sliceDoc(line.from, line.to);' +
      '})()',
  )
}

await new Promise((r) => setTimeout(r, 800))

/* —— 用例 1：标题下拉里的「正文」应去掉 # —— */
await setDoc('# 一级标题文本\n\n正文段落')
await selectLine(1)
out.paragraphBefore = await evaluate("window.__notaView.state.doc.line(1).text")
await evaluate("(() => { const b = [...document.querySelectorAll('.tb-btn')].find((e) => (e.getAttribute('title')||'') === '标题级别'); b.click(); return true; })()")
await new Promise((r) => setTimeout(r, 200))
out.headingMenuItems = await evaluate("[...document.querySelectorAll('.tb-menu .tb-item .txt, .tb-menu .tb-item span:first-child')].map((e) => e.textContent.trim())")
await evaluate("(() => { const it = [...document.querySelectorAll('.tb-menu .tb-item')].find((e) => e.textContent.includes('正文')); it.click(); return true; })()")
await new Promise((r) => setTimeout(r, 250))
out.paragraphAfter = await evaluate("window.__notaView.state.doc.line(1).text")

/* —— 用例 2：隐藏注释 %% 包裹选中文本 —— */
await setDoc('这句话要被注释掉')
await selectLine(1)
out.commentBefore = await evaluate("window.__notaView.state.doc.line(1).text")
await evaluate("(() => { const b = [...document.querySelectorAll('.tb-btn')].find((e) => (e.getAttribute('title')||'') === '笔记工具'); b.click(); return true; })()")
await new Promise((r) => setTimeout(r, 200))
await evaluate("(() => { const it = [...document.querySelectorAll('.tb-menu .tb-item')].find((e) => e.textContent.includes('隐藏注释')); it.click(); return true; })()")
await new Promise((r) => setTimeout(r, 250))
out.commentAfter = await evaluate("window.__notaView.state.doc.line(1).text")

/* —— 用例 3：笔记工具下拉的条目清单 —— */
await evaluate("(() => { const b = [...document.querySelectorAll('.tb-btn')].find((e) => (e.getAttribute('title')||'') === '笔记工具'); b.click(); return true; })()")
await new Promise((r) => setTimeout(r, 200))
out.noteMenuItems = await evaluate("[...document.querySelectorAll('.tb-menu .tb-item')].map((e) => e.textContent.replace(/\\s+/g,' ').trim())")
await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))")

/* —— 用例 4：内容块下拉的条目清单（保持展开，用作截图） —— */
await evaluate("(() => { const b = [...document.querySelectorAll('.tb-btn')].find((e) => (e.getAttribute('title')||'') === '内容块'); b.click(); return true; })()")
await new Promise((r) => setTimeout(r, 200))
out.blockMenuItems = await evaluate("[...document.querySelectorAll('.tb-menu .tb-item')].map((e) => e.textContent.replace(/\\s+/g,' ').trim())")

/* 截图：内容块下拉展开状态（此时已是展开的，不要再点一次，否则会收起） */
out.menuShot = await evaluate(
  "(() => { const m = document.querySelector('.tb-menu');" +
  " if (!m) return { open: false };" +
  " const r = m.getBoundingClientRect();" +
  " return { open: true, items: m.querySelectorAll('.tb-item').length," +
  "   x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)," +
  "   inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 60 };" +
  "})()",
)
await new Promise((r) => setTimeout(r, 300))
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(path.join(ROOT, 'docs', 'probe-toolbar-menu.png'), Buffer.from(shot.result.data, 'base64'))

console.log(JSON.stringify(out, null, 2))

ws.close()
edge.kill()
server.close()
process.exit(0)
