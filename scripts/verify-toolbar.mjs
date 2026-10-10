/**
 * 工具栏下拉菜单的行为验证。
 *
 * 为什么单独写这个脚本：下拉菜单的问题都是「点了没反应 / 反应不一致」，
 * 靠肉眼看截图看不出来（上一轮已经吃过亏——headless 截图会返回过期帧）。
 * 这里全部用 DOM 断言 + 真实派发事件来判定。
 *
 * 重点验证四件事：
 *   1. 每个下拉按钮是「整颗按钮都能开菜单」，还是只有小箭头能开
 *   2. 菜单打开时按钮有没有高亮态
 *   3. 菜单项点击是否真的执行（而不是被 pointerdown 关菜单吃掉）
 *   4. 菜单是否会被窗口右边缘裁掉
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'

const root = 'C:/Users/ymtj1/Desktop/Nota'
const PORT = 5281
const CDP_PORT = 9341

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
    res.writeHead(404); res.end('not found'); return
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const candidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]
const bin = candidates.find((p) => fs.existsSync(p))
if (!bin) { console.log(JSON.stringify({ error: 'no browser' })); server.close(); process.exit(2) }

const profile = path.join(root, '.tmp-cdp-' + Date.now() + '-' + Math.floor(Math.random() * 1e6))
const child = spawn(bin, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--hide-scrollbars', '--window-size=1180,780',
  '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + profile,
  'http://127.0.0.1:' + PORT + '/',
], { stdio: 'ignore' })

/* ── CDP 连接 ── */
async function getWsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('CDP 未就绪')
}

const wsUrl = await getWsUrl()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })

let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  })
  if (r.result?.exceptionDetails) {
    return { __error: r.result.exceptionDetails.text }
  }
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

await evaluate("(() => { try { localStorage.setItem('nota-theme','light') } catch {} ; return true })()")
await evaluate(
  '(() => {' +
    ' window.__notes = { "/ws/测试.md": "# 标题\\n\\n正文段落" };' +
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
await evaluate("(() => { const el = document.querySelector('.tree .row'); if (el) el.click(); return !!el; })()")
await new Promise((r) => setTimeout(r, 1200))

/* ── 收集所有下拉：按钮 + 是否有 caret ── */
out.dropdowns = await evaluate(
  "(() => [...document.querySelectorAll('.tb-menu-wrap')].map((w, i) => {" +
    " const btn = w.querySelector('.tb-btn');" +
    " const caret = w.querySelector('.caret');" +
    " return { i, title: btn ? (btn.getAttribute('title') || btn.innerText.trim()) : '?'," +
    "   hasCaret: !!caret, btnTag: btn ? btn.tagName : '-' };" +
    "}))()",
)

/** 点按钮主体（不点 caret），看菜单是否打开 */
async function probeMainClick(idx) {
  await evaluate(
    '(() => {' +
      ' const w = document.querySelectorAll(".tb-menu-wrap")[' + idx + '];' +
      ' const btn = w.querySelector(".tb-btn");' +
      ' btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));' +
      ' btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));' +
      ' return true;' +
      '})()',
  )
  await new Promise((r) => setTimeout(r, 300))
  const state = await evaluate(
    '(() => {' +
      ' const w = document.querySelectorAll(".tb-menu-wrap")[' + idx + '];' +
      ' const menu = w.querySelector(".tb-menu");' +
      ' const btn = w.querySelector(".tb-btn");' +
      ' return { menuOpen: !!menu, btnHighlighted: btn ? btn.classList.contains("on") : null };' +
      '})()',
  )
  /* 关掉，避免影响下一个 */
  await evaluate('(() => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); return true })()')
  await new Promise((r) => setTimeout(r, 250))
  return state
}

/** 点 caret，看菜单是否打开 */
async function probeCaretClick(idx) {
  await evaluate(
    '(() => {' +
      ' const w = document.querySelectorAll(".tb-menu-wrap")[' + idx + '];' +
      ' const caret = w.querySelector(".caret");' +
      ' if (!caret) return "no-caret";' +
      ' caret.dispatchEvent(new MouseEvent("click", { bubbles: true }));' +
      ' return true;' +
      '})()',
  )
  await new Promise((r) => setTimeout(r, 300))
  const state = await evaluate(
    '(() => {' +
      ' const w = document.querySelectorAll(".tb-menu-wrap")[' + idx + '];' +
      ' return { menuOpen: !!w.querySelector(".tb-menu") };' +
      '})()',
  )
  await evaluate('(() => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); return true })()')
  await new Promise((r) => setTimeout(r, 250))
  return state
}

out.mainClick = []
out.caretClick = []
for (let i = 0; i < out.dropdowns.length; i += 1) {
  out.mainClick.push(await probeMainClick(i))
  out.caretClick.push(await probeCaretClick(i))
}

/* ── 菜单溢出窗口右边缘检查 ── */
out.overflow = []
for (let i = 0; i < out.dropdowns.length; i += 1) {
  /* 用 caret 打开（所有下拉都支持），再量菜单盒子 */
  await probeCaretClick(i)
  await evaluate(
    '(() => {' +
      ' const w = document.querySelectorAll(".tb-menu-wrap")[' + i + '];' +
      ' const btn = w.querySelector(".tb-btn");' +
      ' btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));' +
      ' return true;' +
      '})()',
  )
  await new Promise((r) => setTimeout(r, 320))
  const box = await evaluate(
    "(() => {" +
      " const w = document.querySelectorAll('.tb-menu-wrap')[" + i + '];' +
      " const menu = w.querySelector('.tb-menu');" +
      " if (!menu) return { present: false };" +
      " const r = menu.getBoundingClientRect();" +
      " return { present: true, left: Math.round(r.left), right: Math.round(r.right)," +
      "   w: Math.round(r.width), vw: window.innerWidth," +
      "   overflowRight: Math.round(r.right - window.innerWidth)," +
      "   overflowLeft: Math.round(-r.left) };" +
      "})()",
  )
  out.overflow.push({ i, ...box })
  await evaluate('(() => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); return true })()')
  await new Promise((r) => setTimeout(r, 220))
}

/* ── 菜单项点击是否真的执行（以「正文」去掉 # 为例） ── */
await evaluate(
  '(() => { const v = window.__notaView;' +
  ' v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# 行首标题\\n\\n段" } }); return true })()',
)
await new Promise((r) => setTimeout(r, 400))
out.itemClick = await evaluate(
  '(() => {' +
    ' const w = document.querySelectorAll(".tb-menu-wrap")[0];' +
    ' const btn = w.querySelector(".tb-btn");' +
    ' btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));' +
    ' return "opened";' +
    '})()',
)
await new Promise((r) => setTimeout(r, 350))
out.beforeItemClick = await evaluate('(() => window.__notaView.state.doc.toString())()')
/* 真实模拟：pointerdown 关菜单 + click 执行，两者顺序按浏览器实际行为 */
await evaluate(
  '(() => {' +
    ' const w = document.querySelectorAll(".tb-menu-wrap")[0];' +
    ' const items = [...w.querySelectorAll(".tb-item")];' +
    ' const target = items.find((b) => b.textContent.includes("正文"));' +
    ' if (!target) return "no-item";' +
    ' target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));' +
    ' target.dispatchEvent(new MouseEvent("click", { bubbles: true }));' +
    ' return "clicked";' +
    '})()',
)
await new Promise((r) => setTimeout(r, 500))
out.afterItemClick = await evaluate('(() => window.__notaView.state.doc.toString())()')

console.log('===RESULT===')
console.log(JSON.stringify(out, null, 2))
console.log('===END===')

ws.close()
server.close()
try {
  const { execFileSync } = await import('node:child_process')
  execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 3000 })
} catch { /* ignore */ }
process.exit(0)
