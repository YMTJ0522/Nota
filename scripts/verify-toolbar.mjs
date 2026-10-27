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

/* ── 收集所有下拉：按钮 + 是否有 caret ──
   btnCount 是给「下拉被拆成几颗按钮」这类退化用的：一组里出现两颗 .tb-btn，
   视觉上就会变成两个断开的小块，和旁边一体的下拉对不上（高亮那一组踩过）。 */
out.dropdowns = await evaluate(
  "(() => [...document.querySelectorAll('.tb-menu-wrap')].map((w, i) => {" +
    " const btn = w.querySelector('.tb-btn');" +
    " const caret = w.querySelector('.caret');" +
    " return { i, title: btn ? (btn.getAttribute('title') || btn.innerText.trim()) : '?'," +
    "   hasCaret: !!caret, btnTag: btn ? btn.tagName : '-'," +
    "   btnCount: w.querySelectorAll('.tb-btn').length };" +
    "}))()",
)

/** 一组里多于一颗按钮的，直接点名，不用肉眼翻上面那一大坨 */
out.splitGroups = out.dropdowns.filter((d) => d.btnCount !== 1).map((d) => d.title)

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
      ' const btn = w.querySelector(".tb-btn");' +
      ' const menu = document.querySelector(".tb-menu");' +
      ' return { menuOpen: !!menu, btnHighlighted: btn ? btn.classList.contains("on") : null };' +
      '})()',
  )
  /* 关掉，避免影响下一个 */
  await evaluate('(() => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); return true })()')
  await new Promise((r) => setTimeout(r, 250))
  return state
}

/**
 * 「菜单真的看得见吗」——这是最关键的一条断言。
 *
 * 教训：之前只断言 `!!menu`（DOM 里在不在）和 getBoundingClientRect()，
 * 两者对「被 overflow 裁掉」的元素都照样成立，于是漏掉了真机上
 * 「按钮亮了但下拉不出来」的 bug（.tb 是 overflow:auto，把绝对定位的下拉裁没了）。
 * 正确做法是用 elementFromPoint 打菜单中心：如果返回的是菜单自己，
 * 才算真的可见；返回编辑器/工具栏说明被盖住或被裁。
 */
async function probeVisible(idx) {
  /* 用 caret 打开（不依赖某个按钮的点击语义） */
  await evaluate(
    '(() => {' +
      ' const w = document.querySelectorAll(".tb-menu-wrap")[' + idx + '];' +
      ' const btn = w.querySelector(".tb-btn");' +
      ' btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));' +
      ' return true;' +
      '})()',
  )
  await new Promise((r) => setTimeout(r, 350))
  const res = await evaluate(
    "(() => {" +
      " const menu = document.querySelector('.tb-menu');" +
      " if (!menu) return { visible: false, reason: 'no-menu' };" +
      " const r = menu.getBoundingClientRect();" +
      " if (r.width < 10 || r.height < 10) return { visible: false, reason: 'zero-size', w: r.width, h: r.height };" +
      " const cx = Math.round(r.left + r.width / 2);" +
      " const cy = Math.round(r.top + r.height / 2);" +
      " const el = document.elementFromPoint(cx, cy);" +
      " const inside = el ? menu.contains(el) : false;" +
      " const hit = el ? (typeof el.className === 'string' && el.className ? el.className : el.tagName) : null;" +
      " return { visible: inside, hit, cx, cy, w: Math.round(r.width), h: Math.round(r.height)," +
      "   top: Math.round(r.top), left: Math.round(r.left)," +
      "   overflowBottom: Math.round(r.bottom - window.innerHeight) };" +
      "})()",
  )
  await evaluate('(() => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); return true })()')
  await new Promise((r) => setTimeout(r, 220))
  return res
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
      ' return { menuOpen: !!document.querySelector(".tb-menu") };' +
      '})()',
  )
  await evaluate('(() => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); return true })()')
  await new Promise((r) => setTimeout(r, 250))
  return state
}

out.mainClick = []
out.caretClick = []
out.visibility = []
for (let i = 0; i < out.dropdowns.length; i += 1) {
  out.mainClick.push(await probeMainClick(i))
  out.caretClick.push(await probeCaretClick(i))
  out.visibility.push({ i, ...(await probeVisible(i)) })
}

/* ── 菜单溢出窗口检查（含底部溢出） ── */
out.overflow = []
for (let i = 0; i < out.dropdowns.length; i += 1) {
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
      " const menu = document.querySelector('.tb-menu');" +
      " if (!menu) return { present: false };" +
      " const r = menu.getBoundingClientRect();" +
      " return { present: true, left: Math.round(r.left), right: Math.round(r.right)," +
      "   bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height)," +
      "   vw: window.innerWidth, vh: window.innerHeight," +
      "   overflowRight: Math.round(r.right - window.innerWidth)," +
      "   overflowBottom: Math.round(r.bottom - window.innerHeight) };" +
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
    ' const menu = document.querySelector(".tb-menu");' +
    ' if (!menu) return "no-menu";' +
    ' const items = [...menu.querySelectorAll(".tb-item")];' +
    ' const target = items.find((b) => b.textContent.includes("正文"));' +
    ' if (!target) return "no-item";' +
    ' target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));' +
    ' target.dispatchEvent(new MouseEvent("click", { bubbles: true }));' +
    ' return "clicked";' +
    '})()',
)
await new Promise((r) => setTimeout(r, 500))
out.afterItemClick = await evaluate('(() => window.__notaView.state.doc.toString())()')

/* ── 图标渲染检查 ──
   换用 Lucide 后最怕两件事：
   1) 图标是描边画的，被 CSS 强加 fill:currentColor 后糊成实心黑块；
   2) 某个图标名没解析出来，渲染成空白。
   两者肉眼在小尺寸下都不容易发现，这里逐个量盒子。 */
out.icons = await evaluate(
  "(() => [...document.querySelectorAll('.tb-btn')].map((b) => {" +
    " const svgs = [...b.querySelectorAll('svg')];" +
    " return {" +
    "   title: b.getAttribute('title') || b.innerText.trim()," +
    "   svgCount: svgs.length," +
    "   shapes: svgs.map((s) => {" +
    "     const r = s.getBoundingClientRect();" +
    "     const cs = getComputedStyle(s);" +
    "     return {" +
    "       w: Math.round(r.width), h: Math.round(r.height)," +
    "       fill: cs.fill, stroke: cs.stroke," +
    "       isCaret: s.classList.contains('caret')," +
    "       paths: s.querySelectorAll('path,line,circle,rect,polyline,polygon').length," +
    "     };" +
    "   })," +
    " };" +
    "}))()",
)

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
