/**
 * 本轮修复的端到端验证。
 *
 * 覆盖：
 *  1. 行号贴左（不再是居中）
 *  2. 点下拉菜单 / 执行命令时编辑区不位移
 *  3. 图片能真的加载（nota-media 协议）
 *  4. 下拉菜单宽度按内容自适应（每个菜单宽度不同、且不过宽）
 *  5. 图片菜单里有视频上传项
 *  6. 删除有确认弹窗
 *  7. 顶栏有保存状态 / 导出菜单 / 版本历史 / 设置
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { purgeStale, removeProfile } from './tmp-profiles.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')
const PORT = 4197
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROFILE = path.join(root, `.tmp-cdp-verify-${Date.now()}`)

const CDP_PORT = 9300 + (Date.now() % 300)

/**
 * 等上一个实例把调试端口彻底放开。
 *
 * 同一份脚本背靠背跑两次时，上一个 Edge 还没死干净，新实例会连到旧浏览器上，
 * 读到的还是那个已经被关掉的页面 —— 表现出来就是一堆莫名其妙的 FAIL。
 */
async function waitPortFree(port) {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch('http://127.0.0.1:' + port + '/json/version')
      await new Promise((r) => setTimeout(r, 500))
    } catch {
      return
    }
  }
}


const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
}

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0])
  let file = path.join(distDir, rel === '/' ? 'index.html' : rel)
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(distDir, 'index.html')
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

// 开跑前先把上一轮的残留清掉（依赖退出时序去删，几乎一定会撞 EBUSY）
const purged = purgeStale()
if (purged.removed || purged.skipped) console.log('[tmp] 清掉过期 profile:', JSON.stringify(purged))

await waitPortFree(CDP_PORT)

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  "--remote-debugging-port=" + CDP_PORT, `--user-data-dir=${PROFILE}`,
  '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' })

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await r.json()
      const p = list.find((t) => t.type === 'page')
      if (p) return p
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('edge 没起来')
}

const page = await pageTarget()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
})
await new Promise((r) => ws.addEventListener('open', r))

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = ++id
  pending.set(myId, resolve)
  setTimeout(() => reject(new Error('cdp timeout ' + method)), 20000)
  ws.send(JSON.stringify({ id: myId, method, params }))
})

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description ?? ''))
  }
  return r.result.value
}

const errors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push('EXC ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 200))
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('ERR ' + m.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 200))
  }
})
await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1400, height: 900, deviceScaleFactor: 1, mobile: false,
})
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await new Promise((r) => setTimeout(r, 2500))

const out = {}
const ok = (name, cond, detail) => {
  out[name] = { pass: !!cond, detail }
  console.log((cond ? '  PASS  ' : '  FAIL  '), name, detail !== undefined ? JSON.stringify(detail) : '')
}

/** 每步之后检查编辑器还在不在——它一旦被销毁，后面所有用例都会假失败 */
const viewAlive = async (tag) => {
  const v = await evaluate('!!window.__notaView')
  if (!v) console.log('  !! view 没了 @ ' + tag)
  return v
}

// ── 注入 api 桩（含新增的 resolveMedia / 导出 / 历史）──
const NOTE = '# 标题\n\n正文内容，用于验证。\n\n![示例图](attachments/pic.png)\n'
await evaluate(
  '(() => {' +
    ` window.__notes = { "/ws/测试笔记.md": ${JSON.stringify(NOTE)} };` +
    ' window.__history = [];' +
    ' window.api = {' +
    '  pickWorkspace: async () => "/ws",' +
    '  readTree: async () => ([{ type: "file", name: "测试笔记.md", path: "/ws/测试笔记.md" }]),' +
    '  readNote: async (p) => window.__notes[p] ?? "",' +
    '  writeNote: async (p, t) => { window.__notes[p] = t; return true },' +
    '  createNote: async (d, n) => d + "/" + n + ".md",' +
    '  deleteNote: async () => { window.__deleted = true; return true },' +
    '  renameNote: async (p) => p,' +
    '  pickImage: async (ws, kind) => ({ rel: "attachments/v.mp4", alt: "视频", copied: true, isVideo: kind === "video" }),' +
    '  resolveMedia: async (base, rel) => "nota-media://local/" + encodeURIComponent(base + "/" + rel),' +
    '  exportSave: async (o) => { window.__exported = o; return "/tmp/" + o.defaultName },' +
    '  historySave: async (ws, f, c) => { window.__history.push({ f, c }); return "/h/1.md" },' +
    '  historyList: async () => ([{ name: "1.md", path: "/h/1.md", size: 20, mtime: Date.now() }]),' +
    '  historyRead: async () => "# 历史版本内容",' +
    '  minimize: () => {}, toggleMaximize: () => {}, closeWindow: () => {}, onMaximizeChange: () => {}' +
    ' };' +
    ' return true;' +
    '})()',
)

await evaluate("document.querySelector('.cta') && document.querySelector('.cta').click()")
await new Promise((r) => setTimeout(r, 900))
await evaluate("(() => { const el = document.querySelector('.tree .row'); if (el) el.click(); return !!el })()")
await new Promise((r) => setTimeout(r, 1400))

/* ── 1. 行号贴左 ── */
const gutter = await evaluate(`(() => {
  const g = document.querySelector('.cm-gutters')
  const host = document.querySelector('.host')
  if (!g || !host) return null
  const gr = g.getBoundingClientRect()
  const hr = host.getBoundingClientRect()
  return { leftFromHost: Math.round(gr.left - hr.left), hostW: Math.round(hr.width) }
})()`)
ok('1.行号贴左', gutter && gutter.leftFromHost < 40, gutter)
await viewAlive('after-1')

/* ── 2. 命令执行时编辑区不位移 ── */
const snapExpr = `(() => {
  const s = document.querySelector('.cm-scroller')
  const c = document.querySelector('.cm-content')
  if (!s || !c) return { top: null, scroll: null }
  return { top: Math.round(c.getBoundingClientRect().top), scroll: Math.round(s.scrollTop) }
})()`
// 先把光标放到末尾，制造「容易被 scrollIntoView 拽走」的状态
await evaluate(`(() => {
  const v = window.__notaView
  if (!v) return
  const lines = []
  for (let i = 1; i <= 60; i++) lines.push('第 ' + i + ' 行')
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: lines.join('\\n') },
               selection: { anchor: v.state.doc.length } })
  v.focus()
})()`)
await new Promise((r) => setTimeout(r, 400))
const before = await evaluate(snapExpr)

const jitter = []
const ids = ['heading', 'reference', 'image', 'note', 'code', 'math', 'block']
for (let i = 0; i < ids.length; i++) {
  await evaluate(`document.querySelectorAll('.tb-menu-wrap')[${i}].querySelector('.tb-btn').click()`)
  await new Promise((r) => setTimeout(r, 280))
  await evaluate(`(() => {
    const m = document.querySelector('.tb-menu--float')
    const it = m && m.querySelector('.tb-item')
    if (it) it.click()
    return !!it
  })()`)
  await new Promise((r) => setTimeout(r, 420))
  const a = await evaluate(snapExpr)
  if (a.top !== before.top || a.scroll !== before.scroll) {
    jitter.push({ id: ids[i], before, after: a })
  }
}
ok('2.编辑区不位移', jitter.length === 0, jitter.length ? jitter : 'all 7 stable')
await viewAlive('after-2')

/* ── 3. 菜单宽度按内容自适应 ── */
const widths = await evaluate(`(async () => {
  const res = []
  const wraps = [...document.querySelectorAll('.tb-menu-wrap')]
  for (const w of wraps) {
    const btn = w.querySelector('.tb-btn')
    btn.click()
    await new Promise(r => setTimeout(r, 160))
    const m = document.querySelector('.tb-menu--float')
    const item = m && m.querySelector('.tb-item')
    res.push({
      label: btn.getAttribute('title'),
      w: m ? Math.round(m.getBoundingClientRect().width) : null,
      itemW: item ? Math.round(item.getBoundingClientRect().width) : null,
    })
    btn.click()
    await new Promise(r => setTimeout(r, 120))
  }
  return res
})()`)
const maxW = Math.max(...widths.map((x) => x.w ?? 0))
const distinct = new Set(widths.map((x) => x.w)).size
ok('3.菜单宽度自适应', distinct > 1 && maxW <= 280, { widths, distinct, maxW })
await viewAlive('after-3')

/* ── 4. 图片菜单含视频上传 ── */
const imgItems = await evaluate(`(async () => {
  const w = document.querySelectorAll('.tb-menu-wrap')[2]
  w.querySelector('.tb-btn').click()
  await new Promise(r => setTimeout(r, 200))
  const m = document.querySelector('.tb-menu--float')
  const labels = m ? [...m.querySelectorAll('.tb-item')].map(b => b.textContent.trim()) : []
  w.querySelector('.tb-btn').click()
  return labels
})()`)
ok(
  '4.图片菜单含视频',
  imgItems.some((t) => t.includes('视频')),
  imgItems,
)

/* ── 5. 删除有确认弹窗 ── */
const delFlow = await evaluate(`(async () => {
  const del = document.querySelector('.tree .del')
  if (!del) return { err: 'no del button' }
  del.click()
  await new Promise(r => setTimeout(r, 300))
  const dlg = document.querySelector('.cf-mask .cf')
  const text = dlg ? dlg.textContent : null
  const hasConfirm = !!document.querySelector('.cf-danger')
  const cancelBtn = document.querySelector('.cf-cancel')
  if (cancelBtn) cancelBtn.click()
  await new Promise(r => setTimeout(r, 250))
  const closed = !document.querySelector('.cf-mask')
  return { present: !!dlg, text: (text || '').slice(0, 40), hasConfirm, closedAfterCancel: closed,
           deleted: !!window.__deleted }
})()`)
ok(
  '5.删除确认弹窗',
  delFlow.present && delFlow.hasConfirm && delFlow.closedAfterCancel && !delFlow.deleted,
  delFlow,
)

/* ── 6. 顶栏保存状态 / 导出菜单 ── */
const header = await evaluate(`(async () => {
  const save = document.querySelector('.ph-save')
  const menuBtn = document.querySelector('.hm-anchor')
  if (menuBtn) { menuBtn.click(); }
  await new Promise(r => setTimeout(r, 250))
  const menu = document.querySelector('.hm-menu')
  const items = menu ? [...menu.querySelectorAll('.hm-item')].map(b => b.textContent.trim()) : []
  if (menuBtn) menuBtn.click()
  return {
    saveText: save ? save.textContent.trim() : null,
    saveClass: save ? save.className : null,
    hasMenuBtn: !!menuBtn,
    menuItems: items,
  }
})()`)
/* 「设置」已经按需求从顶栏菜单挪到侧边栏左下角，
   所以这里反过来断言：顶栏菜单里**不该**再有设置。 */
ok(
  '6.顶栏功能簇',
  header.saveText && header.hasMenuBtn &&
    header.menuItems.some((t) => t.includes('Markdown')) &&
    header.menuItems.some((t) => t.includes('版本历史')) &&
    !header.menuItems.some((t) => t.includes('设置')),
  header,
)

/* ── 7. 导出真的调用 exportSave ── */
const exp = await evaluate(`(async () => {
  const menuBtn = document.querySelector('.hm-anchor')
  menuBtn.click()
  await new Promise(r => setTimeout(r, 220))
  const items = [...document.querySelectorAll('.hm-menu .hm-item')]
  const md = items.find(b => b.textContent.includes('Markdown'))
  if (md) md.click()
  await new Promise(r => setTimeout(r, 350))
  return window.__exported ? { kind: window.__exported.kind, name: window.__exported.defaultName } : null
})()`)
ok('7.导出可用', exp && exp.kind === 'md' && exp.name.endsWith('.md'), exp)

/* ── 8. 版本历史面板 ── */
const hist = await evaluate(`(async () => {
  const menuBtn = document.querySelector('.hm-anchor')
  menuBtn.click()
  await new Promise(r => setTimeout(r, 220))
  const items = [...document.querySelectorAll('.hm-menu .hm-item')]
  const h = items.find(b => b.textContent.includes('版本历史'))
  if (h) h.click()
  await new Promise(r => setTimeout(r, 500))
  const panel = document.querySelector('.hp')
  const rows = panel ? panel.querySelectorAll('.hp-row').length : 0
  const hasRestore = !!document.querySelector('.hp-primary')
  const x = document.querySelector('.hp-x')
  if (x) x.click()
  await new Promise(r => setTimeout(r, 250))
  return { present: !!panel, rows, hasRestore, closed: !document.querySelector('.hp') }
})()`)
ok('8.版本历史', hist.present && hist.rows > 0 && hist.hasRestore && hist.closed, hist)
await viewAlive('after-8')

/* ── 9. 设置面板 ── */
const settings = await evaluate(`(async () => {
  // 设置入口在侧边栏左下角（.foot .foot-btn）。那里现在还有一个「附件库」
  // 按钮，所以必须按 data-tip 精确定位，不能取第一个。
  const s = document.querySelector('.panel .foot .foot-btn[data-tip="设置"]')
  if (s) s.click()
  await new Promise(r => setTimeout(r, 400))
  const dlg = document.querySelector('.st')
  const nav = document.querySelector('.st-nav')
  const themeBtns = dlg ? dlg.querySelectorAll('.st-seg-btn').length : 0
  const sect = [...document.querySelectorAll('.st-nav-item .st-nav-label')].map(e => e.textContent.trim())
  // 1.4.0 起分区叫「编辑」（不再是「编辑器」），开关都在这一页
  const editorTab = [...document.querySelectorAll('.st-nav-item')].find(b => b.querySelector('.st-nav-label')?.textContent?.trim() === '编辑')
  editorTab?.click()
  await new Promise(r => setTimeout(r, 300))
  const switches = dlg ? dlg.querySelectorAll('.st-switch').length : 0
  const x = document.querySelector('.st-x')
  if (x) x.click()
  await new Promise(r => setTimeout(r, 250))
  return { present: !!dlg, switches, themeBtns, horizontal: !!nav, sect, closed: !document.querySelector('.st') }
})()`)
ok(
  '9.设置面板',
  settings.present && settings.horizontal && settings.switches >= 3 &&
    settings.themeBtns >= 2 && settings.sect.length === 5 && settings.closed,
  settings,
)
await viewAlive('after-9')

/* ── 10. 图片能加载（media widget 出现 + src 正确）── */
// 前面的用例可能把编辑器状态搅乱了，先诊断当前 DOM 状况
const diag = await evaluate(`({
  view: !!window.__notaView,
  host: !!document.querySelector('.host'),
  pane: !!document.querySelector('.pane'),
  idle: !!document.querySelector('.idle'),
  welcome: !!document.querySelector('.welcome'),
  activePath: (() => { try { return document.querySelector('.ph-title')?.value ?? null } catch { return null } })(),
  segBtns: document.querySelectorAll('.ph-seg-btn').length,
  mode: (() => { const b = document.querySelector('.ph-seg-btn.on'); return b ? b.getAttribute('title') : null })(),
})`)
console.log('DIAG', JSON.stringify(diag))

const media = await evaluate(`(async () => {
  const v = window.__notaView
  if (!v) return { err: 'no view' }
  v.dispatch({ changes: { from: 0, to: v.state.doc.length,
    insert: '# 标题\\n\\n![示例](attachments/pic.png)\\n' } })
  await new Promise(r => setTimeout(r, 300))
  // 编辑模式不再渲染图片缩略图，图片只在预览区出现——
  // 所以这里切到分栏，去预览里查 <img> 有没有换成可加载的 URL
  const split = [...document.querySelectorAll('.ph-seg-btn')].find(b => (b.getAttribute('title')||'').includes('分栏'))
  split?.click()
  await new Promise(r => setTimeout(r, 1400))
  const img = document.querySelector('.preview img')
  const thumb = document.querySelectorAll('.cm-md-media').length
  return {
    src: img ? img.getAttribute('src') : null,
    previewHasImg: !!img,
    editorThumbCount: thumb,
  }
})()`)
ok(
  '10.图片在预览区可加载',
  media.previewHasImg && media.src && media.src.startsWith('nota-media://') && media.editorThumbCount === 0,
  media,
)

console.log('\n--- JS ERRORS ---')
console.log(errors.length ? errors.join('\n') : '(none)')
console.log('\n=== SUMMARY ===')
const failed = Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k)
console.log(failed.length === 0 ? 'ALL PASS' : 'FAILED: ' + failed.join(', '))

ws.close()
edge.kill()
server.close()
removeProfile(PROFILE)
process.exit(failed.length === 0 ? 0 : 1)
