/**
 * 产品演示片：驱动**真实运行的 Nota**（dist + 打桩 IPC），逐帧截图，带运镜。
 *
 * 跟 promo/ 里那几块「排版舞台」不是一回事：那里是画出来的字和卡片；
 * 这里是真应用 —— 鼠标真点、字真敲进去、导出菜单真弹出来。
 * 片子里看到什么，装完就是这个样子。
 *
 * 运镜（就是录屏软件那种自动放大）：
 *   · 每次点击前推到被点的那一枚控件上（1.7–2.1 倍），点完拉回来露上下文；
 *   · 滚动时镜头盯着正在滚的那一栏；
 *   · 缩放只用 transform，不用 CSS zoom —— zoom 会改布局宽度，应用的
 *     响应式档位跟着跳（侧栏收起、工具栏挤掉按钮），拍出来就不是用户看到的界面了。
 *
 *   node scripts/record-demo.mjs --still   # 只出关键帧检查（不录整片、不占内存）
 *   node scripts/record-demo.mjs           # 录整片
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { purgeStale, removeProfile } from './tmp-profiles.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')
const docsDir = path.join(root, 'docs')

const W = Number(process.env.W || 1600)
const H = Number(process.env.H || 900)
const DPR = Number(process.env.DPR || 2.4)
const FPS = Number(process.env.FPS || 30)
const OUT = process.env.OUT || 'release/demo.mp4'
const STILL = process.argv.includes('--still')
const STILL_DIR = path.join(root, 'promo', 'demo-stills')

const PORT = Number(process.env.PORT || 4331)
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROFILE = path.join(root, `.tmp-cdp-demo-${Date.now()}`)
const CDP_PORT = 9600 + (Date.now() % 200)

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.jpg': 'image/jpeg' }

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/__icon.png')) {
    res.writeHead(200, { 'Content-Type': 'image/png' })
    return fs.createReadStream(path.join(docsDir, 'icon-big.png')).pipe(res)
  }
  const rel = decodeURIComponent(req.url.split('?')[0])
  let file = path.join(distDir, rel === '/' ? 'index.html' : rel)
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(distDir, 'index.html')
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

purgeStale()
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' })

async function pageTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p) return p
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('Edge 没起来')
}
const page = await pageTarget()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let mid = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++mid
  pending.set(id, resolve)
  setTimeout(() => reject(new Error('cdp 超时 ' + method)), 60000)
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  const res = r.result
  if (res?.exceptionDetails) throw new Error(res.exceptionDetails.text + ' :: ' + (res.exceptionDetails.exception?.description ?? ''))
  return res?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: false })
/* 应用默认「跟随系统」，headless 里会拿到深色。片子里要浅色（跟官网一致），
   直接把媒体查询钉死，而不是去 store 里改（改 store 会多一次重渲染）。 */
if (!process.env.DARK) {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
}

/* ────────────────────────── 演示用的笔记 ──────────────────────────
   全是真的能渲染的东西：公式、图表、表格、代码、提示块。
   片子里要推近给人看清的就是这些。 */
const PIC_DATA = 'data:image/png;base64,' + fs.readFileSync(path.join(docsDir, 'icon-big.png')).toString('base64')
const PIC = 'attachments/封面.png'

const NOTE = [
  '# 一周手记',
  '',
  '*「把想法写下来，它们才会长成东西。」*',
  '',
  '## 这周做了什么',
  '',
  '- [x] 把资料库迁到本地目录',
  '- [x] 给编辑器补上代码块行号',
  '- [ ] 整理读书笔记的双链',
  '',
  '> [!tip] 小技巧',
  '> 围栏后面写 `line-numbers` 就显示行号，写 `{3}` 还能高亮某一行。',
  '',
  '## 一段代码',
  '',
  '```ts title="notes.ts" line-numbers {3}',
  'export interface Note {',
  '  path: string',
  '  tags: string[]',
  '  updatedAt: number',
  '}',
  '',
  'export function isFresh(n: Note, days = 7) {',
  '  return Date.now() - n.updatedAt < days * 86400_000',
  '}',
  '```',
  '',
  '## 图表与表格',
  '',
  '```mermaid',
  'graph LR',
  '  A[想法] --> B[笔记]',
  '  B --> C[整理]',
  '  C --> D[输出]',
  '```',
  '',
  '| 项目 | 状态 | 耗时 |',
  '| --- | --- | --- |',
  '| 资料库 | 完成 | 2 天 |',
  '| 编辑器 | 完成 | 3 天 |',
  '| 双链 | 进行中 | — |',
  '',
  '## 一个公式',
  '',
  '$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$',
  '',
  '普通段落收尾，试一下 `行内代码` 和 [链接](https://example.com)。',
  '',
].join('\n')

const TREE = [{
  type: 'dir', name: '笔记归档 2026', path: '/ws/笔记归档 2026',
  children: [
    { type: 'file', name: '一周手记.md', path: '/ws/一周手记.md', tags: ['手记'], starred: true, mtime: Date.now() - 3600_000 },
    { type: 'file', name: '读书笔记.md', path: '/ws/读书笔记.md', tags: ['阅读'], starred: false, mtime: Date.now() - 86400_000 * 3 },
    { type: 'file', name: '待办.md', path: '/ws/待办.md', tags: [], starred: true, mtime: Date.now() - 7200_000 },
    { type: 'file', name: '接口设计.md', path: '/ws/接口设计.md', tags: [], starred: false, mtime: Date.now() - 86400_000 * 8 },
  ],
}]

/* ────────────────────────── 启动到有内容的状态 ────────────────────────── */
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(2600)

await evaluate('(() => {' +
  ' try { localStorage.setItem("nota-tour-seen", "1") } catch {}' +
  ` window.__notes = { "/ws/一周手记.md": ${JSON.stringify(NOTE)},` +
  '   "/ws/读书笔记.md": "# 读书笔记\\n\\n在读《设计中的设计》。\\n",' +
  '   "/ws/待办.md": "# 待办\\n\\n- 整理旧稿\\n",' +
  '   "/ws/接口设计.md": "# 接口设计\\n\\n## GET /notes\\n\\n返回笔记列表。\\n" };' +
  ` window.__pic = ${JSON.stringify(PIC)};` +
  ` window.__picData = ${JSON.stringify(PIC_DATA)};` +
  ' window.api = {' +
  '  pickWorkspace: async () => "/ws",' +
  `  readTree: async () => (${JSON.stringify(TREE)}),` +
  '  readNote: async (p) => window.__notes[p] ?? "",' +
  '  writeNote: async (p, t) => { window.__notes[p] = t; return true },' +
  '  createNote: async (d, n) => d + "/" + n + ".md", createFolder: async (d, n) => d + "/" + n,' +
  '  deleteNote: async () => true, renameNote: async (p) => p,' +
  '  pickImage: async () => ({ rel: window.__pic, alt: "封面", copied: true, isVideo: false }),' +
  '  resolveMedia: async () => window.__picData,' +
  '  attachList: async () => ([{ rel: window.__pic, name: "封面.png", size: 20480, mtime: Date.now(), isVideo: false }]),' +
  '  attachDelete: async () => true,' +
  '  trashList: async () => ([]), trashRestore: async () => "", trashPurge: async () => true,' +
  '  trashEmpty: async () => true,' +
  '  aiChat: async () => ({ ok: true, text: "先在本地跑通再说。" }),' +
  '  aiTest: async () => ({ ok: true, models: ["llama3.2"] }),' +
  '  appInfo: async () => ({ electron: "33.0.0", chrome: "130.0.0.0", node: "20.18.0", platform: "win32", arch: "x64" }),' +
  // 导出：返回一个像样的真实路径，片子里那条 toast 才是「真写出去了」。
  // 注意签名是对象（{defaultName, kind, data}），PDF 走的是另一支 exportPdf。
  '  exportSave: async (o) => "D:\\\\笔记归档 2026\\\\" + o.defaultName,' +
  '  exportPdf: async (o) => "D:\\\\笔记归档 2026\\\\" + o.defaultName,' +
  '  historySave: async () => "/h/1.md", historyList: async () => [], historyRead: async () => "# h",' +
  '  minimize: () => {}, toggleMaximize: () => {}, closeWindow: () => {}, onMaximizeChange: () => {}' +
  ' }; return true })()')

await sleep(300)
await evaluate("document.querySelector('.cta')?.click()")
await sleep(1200)

/* ────────────────────────── 注入：鼠标 / 涟漪 / 字幕 / 片尾 ──────────────────────────
   这三个挂在 <html> 上（不受镜头缩放影响，永远屏幕大小）；
   镜头缩放只作用在 <body>（Teleport 出来的菜单会跟着一起走）。 */
await evaluate(`(() => {
  document.documentElement.style.overflow = 'hidden'
  const c = document.createElement('div')
  c.id = '__cursor'
  c.style.cssText = 'position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483647;' +
    'pointer-events:none;will-change:transform;transform:translate3d(-300px,-300px,0);' +
    'filter:drop-shadow(0 1.5px 3px rgb(0 0 0/.5))'
  c.innerHTML = '<svg width="30" height="30" viewBox="0 0 26 26" fill="none">' +
    '<path d="M4 2.2 L4 20.4 L8.9 15.6 L12.2 22.6 L15.3 21.2 L12 14.2 L18.6 13.7 Z" ' +
    'fill="#fff" stroke="#16150f" stroke-width="1.5" stroke-linejoin="round"/></svg>'
  document.documentElement.appendChild(c)

  const r = document.createElement('div')
  r.id = '__ripple'
  r.style.cssText = 'position:fixed;left:-200px;top:-200px;width:12px;height:12px;border-radius:50%;' +
    'z-index:2147483646;pointer-events:none;opacity:0;' +
    'border:3px solid rgb(47 111 82/.85);background:rgb(47 111 82/.14)'
  document.documentElement.appendChild(r)

  const cap = document.createElement('div')
  cap.id = '__cap'
  cap.style.cssText = 'position:fixed;left:56px;bottom:54px;z-index:2147483645;opacity:0;' +
    'pointer-events:none;display:flex;align-items:center;gap:14px;' +
    'background:rgb(22 22 18/.88);color:#f7f5ee;padding:15px 26px;border-radius:12px;' +
    'font:600 24px/1.35 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;' +
    'box-shadow:0 18px 40px -18px rgb(0 0 0/.6);letter-spacing:.01em;transform:translateY(8px)'
  cap.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#4fbf8f;flex:none"></span>' +
    '<span id="__captext"></span>'
  document.documentElement.appendChild(cap)

  const end = document.createElement('div')
  end.id = '__end'
  end.style.cssText = 'position:fixed;inset:0;z-index:2147483644;opacity:0;pointer-events:none;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'background:radial-gradient(1200px 800px at 50% 42%,#fdfcf7,#f4f2e8 70%,#eeece0);' +
    'font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#1f1e1a'
  end.innerHTML =
    '<img src="/__icon.png" style="width:150px;height:150px;border-radius:34px;' +
      'box-shadow:0 34px 60px -26px rgb(20 60 44/.5)">' +
    '<div style="margin-top:34px;font-size:64px;font-weight:800;letter-spacing:-.03em">Nota</div>' +
    '<div style="margin-top:14px;font-size:25px;color:#8d897e;letter-spacing:.14em">一个只做笔记的笔记应用</div>' +
    '<div style="margin-top:40px;font-size:31px;font-weight:700;color:#2f6f52">ymtj.hyper99.top</div>' +
    '<div style="margin-top:16px;font-size:21px;color:#8d897e">Windows 10/11 · 免费开源 · 不联网、不上传、不要账号</div>'
  document.documentElement.appendChild(end)
  return true
})()`)

/* ────────────────────────── 运镜引擎 ────────────────────────── */
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const easeInOut = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const easeOut = (t) => 1 - Math.pow(1 - t, 3)
const easeIn = (t) => t * t * t
const EASES = { inout: easeInOut, out: easeOut, in: easeIn }
const lerp = (a, b, p) => a + (b - a) * p

/** 镜头：k = 放大倍数，(x,y) = 页面坐标里对准屏幕中心的那个点 */
let cam = { k: 1, x: W / 2, y: H / 2 }
let cursor = { x: 1180, y: 620 }        // 页面坐标
let ripple = { x: 0, y: 0, at: -99 }
let T = 0                                // 虚拟时钟（秒），跟真实耗时无关
let frameCount = 0

const setCam = (k, cx, cy) => evaluate(
  `(() => { const b=document.body;
    b.style.transformOrigin='0 0';
    b.style.transform='translate(${W / 2 - cx * k}px,${H / 2 - cy * k}px) scale(${k})';
    return true })()`)

const screenOf = (p, c) => ({ x: (p.x - c.x) * c.k + W / 2, y: (p.y - c.y) * c.k + H / 2 })
const toPage = (sx, sy) => ({ x: (sx - W / 2) / cam.k + cam.x, y: (sy - H / 2) / cam.k + cam.y })

const paintCursor = (s, press) => evaluate(
  `(() => { const c=document.getElementById('__cursor'); if(!c) return false;
    c.style.transform='translate3d(${s.x - 4}px,${s.y - 3}px,0) scale(${press ? .9 : 1})';
    c.style.transformOrigin='4px 2px'; return true })()`)

const paintRipple = (s, p) => evaluate(
  `(() => { const r=document.getElementById('__ripple'); if(!r) return false;
    const d=14+${p}*64; r.style.width=d+'px'; r.style.height=d+'px';
    r.style.left=(${s.x}-d/2)+'px'; r.style.top=(${s.y}-d/2)+'px';
    r.style.opacity=String((1-${p})*0.9); return true })()`)

let capText = ''
const paintCap = (text, op) => evaluate(
  `(() => { const c=document.getElementById('__cap'); if(!c) return false;
    const t=document.getElementById('__captext');
    if (t.textContent !== ${JSON.stringify(text)}) t.textContent = ${JSON.stringify(text)};
    c.style.opacity=String(${op});
    c.style.transform='translateY(' + ((1-${op})*10).toFixed(1) + 'px)';
    return true })()`)

const paintEnd = (op) => evaluate(
  `(() => { const e=document.getElementById('__end'); if(!e) return false;
    e.style.opacity=String(${op}); return true })()`)

let ff = null
if (!STILL) {
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true })
  ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-vf', 'scale=1920:1080:flags=lanczos',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.resolve(OUT),
  ], { stdio: ['pipe', 'inherit', 'inherit'] })
}

/** 一帧：定镜头 → 画鼠标 → 画涟漪 → 截屏进 ffmpeg */
const emit = async (opt = {}) => {
  await setCam(cam.k, cam.x, cam.y)
  const s = screenOf(cursor, cam)
  await paintCursor(s, opt.press ?? false)
  const rp = clamp((T - ripple.at) / .42)
  if (T >= ripple.at && rp < 1) await paintRipple(screenOf(ripple, cam), rp)
  else if (rp >= 1) await evaluate("(() => { const r=document.getElementById('__ripple'); if(r) r.style.opacity='0'; return true })()")
  /* 字幕：只给 capOp 也要生效（片尾要把它淡掉），所以文本单独记一份 */
  if (opt.cap !== undefined) capText = opt.cap
  if (opt.cap !== undefined || opt.capOp !== undefined) await paintCap(capText, opt.capOp ?? 1)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(s.x), y: Math.round(s.y), button: 'none' })
  if (!STILL) {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const buf = Buffer.from(r.result.data, 'base64')
    if (!ff.stdin.write(buf)) await new Promise((res) => ff.stdin.once('drain', res))
  }
  T += 1 / FPS
  frameCount++
}

const stills = {}
const mark = async (name) => {
  if (!STILL) return
  fs.mkdirSync(STILL_DIR, { recursive: true })
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(STILL_DIR, name + '.png'), Buffer.from(r.result.data, 'base64'))
  console.log('  帧 →', name, ' t=' + T.toFixed(1) + 's')
}

/* ────────────────────────── 定位（统一换算到页面坐标） ────────────────────────── */
const rectOf = (sel) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)})
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom }
})()`)

const rectOfText = (sel, text) => evaluate(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .find(e => (e.textContent || '').includes(${JSON.stringify(text)}))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom }
})()`)

/** 屏幕坐标 → 页面坐标。镜头一动同一个元素的屏幕位置就变，
 *  所以「镜头去哪儿 / 鼠标去哪儿」都先落成页面坐标，再逐帧插值。 */
const resolveTarget = async (spec) => {
  if (!spec) return null
  if (spec.x !== undefined) return { x: spec.x, y: spec.y }
  const r = spec.text ? await rectOfText(spec.on, spec.text) : await rectOf(spec.on)
  if (!r) { console.warn('  ! 找不到', spec.on, spec.text ?? ''); return null }
  return toPage(r.x + (spec.dx ?? 0), r.y + (spec.dy ?? 0))
}

/* ────────────────────────── 动作 ────────────────────────── */
const realClick = async (sel, text) => {
  const r = text ? await rectOfText(sel, text) : await rectOf(sel)
  if (!r) return
  const x = Math.round(r.x), y = Math.round(r.y)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(45)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

/** 一步镜头：镜头与鼠标从当前状态平滑推到目标状态 */
async function shot({ dur, cam: camTo, cursor: curTo, ease = 'inout', cap, capOp, action, at = .55 }) {
  const n = Math.max(1, Math.round(dur * FPS))
  const c2 = camTo ? await resolveTarget(camTo) : null
  const k2 = camTo ? (camTo.k ?? cam.k) : cam.k
  const p2 = curTo ? await resolveTarget(curTo) : null
  const c1 = { ...cam }
  const p1 = { ...cursor }
  const ez = EASES[ease]
  let acted = false
  for (let i = 1; i <= n; i++) {
    const e = ez(i / n)
    cam = { k: lerp(c1.k, k2, e), x: lerp(c1.x, c2 ? c2.x : c1.x, e), y: lerp(c1.y, c2 ? c2.y : c1.y, e) }
    if (p2) cursor = { x: lerp(p1.x, p2.x, e), y: lerp(p1.y, p2.y, e) }
    if (!acted && action && i / n >= at) { acted = true; await action() }
    await emit({ cap, capOp })
  }
}

async function hold(dur, opt = {}) {
  const n = Math.max(1, Math.round(dur * FPS))
  for (let i = 0; i < n; i++) await emit(opt)
}

/** 点击：推到控件上 → 涟漪 + 真事件 → 停一下 */
async function clickZoom(sel, { text, k = 1.9, dur = .8, cap } = {}) {
  await shot({ dur, cam: { on: sel, k, ...(text ? { text } : {}) }, cursor: { on: sel, ...(text ? { text } : {}) }, ease: 'out', cap })
  await hold(.18, { cap })
  ripple = { ...cursor, at: T }
  await paintRipple(screenOf(cursor, cam), 0)
  await realClick(sel, text)
  await emit({ press: true, cap })
  await emit({ cap })
  await hold(.26, { cap })
}

/** 逐字敲进去：每帧一个字，右侧预览实时跟着变 */
async function typeText(text) {
  for (const ch of [...text]) {
    await send('Input.insertText', { text: ch })
    await emit({})
    if ('，。、'.includes(ch)) await emit({})
  }
}

/** 滚轮（帧同步，总量摊到 frames 帧里，看着才顺） */
async function wheel(dy, n, at) {
  for (let i = 0; i < n; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Math.round(at.x), y: Math.round(at.y),
      deltaX: 0, deltaY: dy / n, button: 'none',
    })
    await emit({})
  }
}

const key = async (k, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text: k === 'Enter' ? '\r' : undefined })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
}

/* ────────────────────────── 分镜 ────────────────────────── */
const CAP = {
  intro: 'Nota · 只做笔记的笔记应用',
  files: '笔记就是硬盘上的 .md 文件',
  split: '左边写，右边实时渲染',
  type: '敲字的同时，右边跟着变',
  render: '图表、表格、公式都是真渲染',
  outline: '大纲 / 引用 / 全文搜索',
  exp: '导出 PDF、Word、HTML、Markdown',
}

await sleep(500)
await emit({ cap: CAP.intro, capOp: 1 })
await mark('01')

/* ① 开场：整窗，慢慢推一点 */
await shot({ dur: 1.5, cam: { k: 1.07, x: W / 2, y: H / 2 }, cap: CAP.intro })
await mark('02')

/* ② 点开笔记：推到文件名上再点 */
await shot({ dur: 1.0, cursor: { on: '.nl-item', text: '一周手记', dx: -50 }, cap: CAP.files })
await mark('03')
await clickZoom('.nl-item', { text: '一周手记', k: 1.8, cap: CAP.files })
await hold(.45, { cap: CAP.files })
await mark('04')

/* ③ 切分栏：推到三个视图页签 */
await shot({ dur: .9, cam: { on: '.ph-seg', k: 1.65 }, cursor: { on: '.ph-seg-btn[title^="分栏视图"]' }, cap: CAP.split, ease: 'out' })
await clickZoom('.ph-seg-btn[title^="分栏视图"]', { k: 2.0, dur: .7, cap: CAP.split })
await hold(.35, { cap: CAP.split })
await mark('05')

/* ④ 拉回来看整体布局 */
await shot({ dur: 1.0, cam: { x: 700, y: 420, k: 1.1 }, cursor: { x: 640, y: 430 }, ease: 'inout', cap: CAP.split })
await mark('06')

/* ⑤ 写笔记：点到最后一条待办行尾，回车续一条，逐字敲 */
await shot({ dur: 1.0, cam: { on: '.cm-line', text: '整理读书笔记', k: 1.9 }, cursor: { on: '.cm-line', text: '整理读书笔记', dx: 70 }, ease: 'out', cap: CAP.type })
await mark('07')
const eol = await evaluate(`(() => {
  const l = [...document.querySelectorAll('.cm-line')].find(e => e.textContent.includes('整理读书笔记'))
  if (!l) return null
  const rg = document.createRange(); rg.selectNodeContents(l)
  const r = rg.getBoundingClientRect()
  return { x: r.right - 2, y: r.top + r.height / 2 }
})()`)
if (eol) {
  const x = Math.round(eol.x), y = Math.round(eol.y)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
} else console.warn('  ! 没找到那一行')
await emit({})
await key('End', 'End', 35)
await emit({})
await key('Enter', 'Enter', 13)
await emit({})
await typeText('把每周回顾压到 15 分钟')
await mark('08')
await hold(.25)

/* ⑥ 推近右侧预览，看刚写进去的那一条 */
await shot({ dur: .9, cam: { on: '.preview li', text: '把每周回顾', k: 2.0 }, cursor: { on: '.preview li', text: '把每周回顾', dx: -40 }, ease: 'out', cap: CAP.type })
await mark('09')
await hold(.6, { cap: CAP.type })

/* ⑦ 滚预览看代码 / 图表 / 表格 / 公式，镜头跟着走
   每一段都对准「那一个块」而不是整栏：预览栏只有 500 宽，
   对准栏中心会有大片白，对准块才有细节可看。 */
const pv = await rectOf('.preview')
const pvP = toPage(pv.x, pv.y)
console.log('  预览块：', await evaluate(`(() => {
  const pick = (s) => { const e = document.querySelector(s); if (!e) return null
    const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }
  return { pre: pick('.preview pre'), svg: pick('.preview svg'), table: pick('.preview table'),
           katex: pick('.preview .katex-display'), katex2: pick('.preview .katex') }
})()`))

await wheel(250, 20, pv)
await shot({ dur: .7, cam: { on: '.preview pre', k: 1.75 }, cap: CAP.render })
await hold(.9, { cap: CAP.render })
await mark('10')

await wheel(300, 20, pv)
await hold(.6, { cap: CAP.render })
await mark('11')

await shot({ dur: .7, cam: { on: '.preview table', k: 1.6 }, cap: CAP.render })
await hold(.8, { cap: CAP.render })
await mark('12')

await shot({ dur: .8, cam: { on: '.preview .katex-display', k: 2.1 }, cap: CAP.render })
await hold(1.0, { cap: CAP.render })
await mark('13')

/* ⑧ 大纲 */
await shot({ dur: .9, cam: { x: W / 2 - 280, y: H / 2, k: 1.3 }, cursor: { x: 320, y: 22 }, ease: 'inout', cap: CAP.outline })
await clickZoom('.col-tab', { text: '大纲', k: 2.0, dur: .7, cap: CAP.outline })
await hold(.7, { cap: CAP.outline })
await mark('14')

/* 回笔记页签，顺手也是「切一页换一种看法」的收束 */
await shot({ dur: .7, cam: { on: '.col-tab', text: '笔记', k: 1.9 }, cursor: { on: '.col-tab', text: '笔记' }, ease: 'inout', cap: CAP.outline })
ripple = { ...cursor, at: T }
await realClick('.col-tab', '笔记')
await emit({ press: true, cap: CAP.outline })
await hold(.5, { cap: CAP.outline })

/* ⑨ 导出：导出按钮 → 四项菜单 → 点 PDF → toast */
await shot({ dur: .85, cam: { on: '.ph-seg', k: 1.3 }, cursor: { on: '.ea-anchor' }, ease: 'inout', cap: CAP.exp })
await clickZoom('.ea-anchor', { k: 2.1, dur: .7, cap: CAP.exp })
await mark('15')
await shot({ dur: .5, cam: { on: '.ea-menu', k: 2.0 }, cursor: { on: '.ea-menu .n-menu-item', text: '导出 Markdown' }, ease: 'out', cap: CAP.exp })
await mark('16')
ripple = { ...cursor, at: T }
/* 点 Markdown 而不是 PDF：PDF / Word 要先在页面里把整篇（含 mermaid、公式）
   重渲一遍再打印，截屏压力下要五六秒才出 toast；md 是直接把原文写出去，
   秒出。菜单里四种格式照样全露，卖点不受影响。 */
await realClick('.ea-menu .n-menu-item', '导出 Markdown')
await emit({ press: true, cap: CAP.exp })
await mark('17')

/* 抓那条「已导出到 …」。
   坑：toast 只活 3 秒**真实**时间，而我们每帧要花 200 多毫秒去截图 ——
   0.9 秒的画面要采六七秒，先 hold 再去找，它早就弹完消失了。
   所以点完立刻一帧一帧盯，再让镜头推过去。 */
let toastText = ''
let toastPage = null
for (let i = 0; i < 10 && !toastText; i++) {
  await emit({ cap: CAP.exp })
  const list = await evaluate("(() => [...document.querySelectorAll('.toast')].map(e => (e.textContent||'').trim()))()")
  toastText = (list || []).find((s) => s.includes('已导出')) ?? ''
  if (toastText) {
    /* 坐标必须**趁它还在**的时候量。等抓完再量，toast 已经消失，只能拿到 null
       退到窗口中心，镜头就跑到别处去了（第一次就是这么拍空的）。 */
    const r = await rectOf('.toast')
    if (r) toastPage = toPage(r.x, r.y)
  }
}
console.log('  导出 toast：', toastText || '（没等到）', toastPage ? `@${Math.round(toastPage.x)},${Math.round(toastPage.y)}` : '')

if (toastText) {
  /* 同样因为「一段画面比 toast 的一辈子长」，推到它上面这几秒里它会自己消失。
     所以按原样重发同一条（就是导出真的返回的那句话）；已经有同文就不再发，
     免得叠成一摞。 */
  const keepToast = (text) => evaluate(`(() => {
    const has = [...document.querySelectorAll('.toast')].some(e => (e.textContent||'').includes(${JSON.stringify(text)}))
    if (!has) window.dispatchEvent(new CustomEvent('nota:toast', { detail: ${JSON.stringify(text)} }))
    return true })()`)

  /* toast 贴在窗口左下角。要是把镜头正对它，就只剩侧栏那点空白；
     往右带一点，让编辑区和预览一起入画，toast 落在左下角。 */
  const to = toastPage
    ? { x: Math.min(toastPage.x + 120, 620), y: toastPage.y - 150, k: 1.3 }
    : { x: 620, y: 660, k: 1.3 }
  const from = { ...cam }
  const n = 24
  for (let i = 1; i <= n; i++) {
    const e = easeOut(i / n)
    cam = { k: lerp(from.k, to.k, e), x: lerp(from.x, to.x, e), y: lerp(from.y, to.y, e) }
    if (i % 5 === 1) await keepToast(toastText)
    await emit({ cap: CAP.exp })
  }
  for (let i = 0; i < 20; i++) {
    if (i % 5 === 0) await keepToast(toastText)
    await emit({ cap: CAP.exp })
  }
  await keepToast(toastText)
  await mark('18')
}

/* ⑩ 片尾：鼠标先撤出画面，再淡入片尾卡 */
cursor = { x: -420, y: -420 }
await paintCursor({ x: -420, y: -420 }, false)
await shot({ dur: 1.1, cam: { x: W / 2, y: H / 2, k: 1.02 }, ease: 'inout', capOp: 0 })
await mark('19')
const n1 = Math.round(.7 * FPS)
for (let i = 1; i <= n1; i++) { await paintEnd(i / n1); if (!STILL) await emit({ capOp: 0 }) }
const n2 = Math.round(2.3 * FPS)
for (let i = 0; i < n2; i++) if (!STILL) await emit({ capOp: 0 })
await mark('20')

/* ────────────────────────── 出片 ────────────────────────── */
if (!STILL) {
  await new Promise((r) => { ff.on('close', r); ff.stdin.end() })
  console.log('  成片 →', OUT, '｜', frameCount, '帧 /', T.toFixed(1), '秒')
}

ws.close()
edge.kill()
server.close()
try { removeProfile(PROFILE) } catch {}
process.exit(0)
