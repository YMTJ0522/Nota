/**
 * 本轮（视觉打磨 + 富块 + 文件夹/标签 + 图标）的端到端验证。
 *
 * 覆盖：
 *  1. 富块在编辑区渲染成卡片（Callout / 折叠 / 分栏 / Mermaid / 表格）
 *  2. 富块在预览区也渲染
 *  3. 表格九宫格能选尺寸并插入对应行列
 *  4. 设置入口在侧边栏左下角（不再在顶栏菜单里）
 *  5. 侧边栏折叠按钮在「资料库」行
 *  6. 删除按钮图标变大
 *  7. 文件夹能新建
 *  8. 标签能从 frontmatter 里读出来并列在侧栏
 *  9. 编辑区选中色不是原来的淡色
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')
const PORT = 4291
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROFILE = path.join(root, `.tmp-cdp-round2-${Date.now()}`)
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2' }

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0])
  let file = path.join(distDir, rel === '/' ? 'index.html' : rel)
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(distDir, 'index.html')
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const edge = spawn(EDGE, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  '--remote-debugging-port=9361', `--user-data-dir=${PROFILE}`, '--window-size=1400,900', 'about:blank'], { stdio:'ignore' })

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9361/json/list')
      const list = await r.json()
      const p = list.find((t) => t.type === 'page'); if (p) return p
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('edge 没起来')
}
const page = await pageTarget()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pending = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } })
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = ++id; pending.set(myId, resolve)
  setTimeout(() => reject(new Error('cdp timeout ' + method)), 20000)
  ws.send(JSON.stringify({ id: myId, method, params }))
})
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description ?? ''))
  return r.result.value
}
const errors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') errors.push('EXC ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300))
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('ERR ' + m.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300))
})
await send('Runtime.enable'); await send('Page.enable')
/* 视口刻意开高：CodeMirror 只渲染视口内的装饰，视口太矮时
   文档末尾的表格/图表卡片不会进 DOM，会误判成「没渲染」。 */
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 2600, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await new Promise((r) => setTimeout(r, 2500))

const out = {}
const ok = (name, cond, detail) => {
  out[name] = { pass: !!cond, detail }
  console.log((cond ? '  PASS  ' : '  FAIL  '), name, detail !== undefined ? JSON.stringify(detail) : '')
}

/**
 * 等到探测结果连续两次一致再返回。
 *
 * 编辑器挂载后还会经历「建装饰 → 异步解析 → 重绘」，固定 sleep 很容易
 * 正好停在中间态（块被算成两份）。所以这里轮询到稳定为止，不靠拍脑袋的等待。
 */
const stable = async (probe, budgetMs = 6000) => {
  const t0 = Date.now()
  let prev = null
  while (Date.now() - t0 < budgetMs) {
    const cur = await evaluate(probe)
    if (prev !== null && JSON.stringify(cur) === JSON.stringify(prev)) return cur
    prev = cur
    await new Promise((r) => setTimeout(r, 400))
  }
  console.log('  (warn) 未达到稳定态，用最后一次结果')
  return prev
}

const RICH = [
  '# 标题一',
  '',
  '正文一段。',
  '',
  '![图](attachments/pic.png)',
  '',
  '> [!WARNING] 注意安全',
  '> 这是一个警告块。',
  '',
  '<details>',
  '<summary>折叠详情</summary>',
  '',
  '里面的内容。',
  '',
  '</details>',
  '',
  ':::: tabs',
  '::: tab-item 标签一',
  '',
  '第一个标签的内容',
  '',
  ':::',
  '::: tab-item 标签二',
  '',
  '第二个标签的内容',
  '',
  ':::',
  '::::',
  '',
  '```mermaid',
  'graph TD',
  '  A[开始]-->B[结束]',
  '```',
  '',
  '| 列 1 | 列 2 |',
  '| --- | --- |',
  '| a | b |',
].join('\n')

await evaluate('(() => {' +
  ` window.__notes = { "/ws/测试笔记.md": ${JSON.stringify(RICH)} };` +
  ' window.__folders = [];' +
  ' window.api = {' +
  '  pickWorkspace: async () => "/ws",' +
  '  readTree: async () => ([{ type: "file", name: "测试笔记.md", path: "/ws/测试笔记.md", tags: ["日记","随笔"] }]),' +
  '  readNote: async (p) => window.__notes[p] ?? "",' +
  '  writeNote: async (p, t) => { window.__notes[p] = t; return true },' +
  '  createNote: async (d, n) => d + "/" + n + ".md",' +
  '  createFolder: async (d, n) => { const p = d + "/" + n; window.__folders.push(p); return p },' +
  '  deleteNote: async () => true, renameNote: async (p) => p,' +
  '  pickImage: async () => ({ rel: "attachments/pic.png", alt: "图", copied: true, isVideo: false }),' +
  '  resolveMedia: async (b, r) => "nota-media://local/" + encodeURIComponent(b + "/" + r),' +
  '  exportSave: async () => "/tmp/x",' +
  '  historySave: async () => "/h/1.md", historyList: async () => ([{name:"1.md",path:"/h/1.md",size:20,mtime:Date.now()}]), historyRead: async () => "# h",' +
  '  minimize: () => {}, toggleMaximize: () => {}, closeWindow: () => {}, onMaximizeChange: () => {}' +
  ' }; return true; })()')

await evaluate("document.querySelector('.cta') && document.querySelector('.cta').click()")
await new Promise((r) => setTimeout(r, 900))
await evaluate("(() => { const el = document.querySelector('.tree .row'); if (el) el.click(); return !!el })()")
await new Promise((r) => setTimeout(r, 1800))

/* ── 1. 编辑区富块 ── */
const rich = await stable(`(() => ({
  callout: document.querySelectorAll('.cm-rich-callout').length,
  calloutType: document.querySelector('.cm-rich-callout')?.dataset.type ?? null,
  details: document.querySelectorAll('.cm-rich-details').length,
  tabs: document.querySelectorAll('.cm-rich-tabs').length,
  tabCount: document.querySelectorAll('.cm-rich-tab').length,
  mermaid: document.querySelectorAll('.cm-rich-mermaid').length,
  mermaidSvg: !!document.querySelector('.cm-rich-mermaid svg'),
  table: document.querySelectorAll('.cm-rich-table').length,
  tableCols: document.querySelectorAll('.cm-rich-table thead th').length,
  editorCount: document.querySelectorAll('.cm-editor').length,
  allBlocks: [...document.querySelectorAll('.cm-rich')].map((e) => e.className),
}))()`)
ok(
  '1.编辑区富块卡片',
  rich.callout === 1 && rich.details === 1 && rich.tabs === 1 && rich.tabCount === 2 &&
    rich.mermaid === 1 && rich.table === 1 && rich.tableCols === 2,
  rich,
)

/* ── 2. 预览区富块 ── */
const pv = await evaluate(`(async () => {
  // 切到预览模式
  const btns = [...document.querySelectorAll('.ph-seg-btn')]
  const read = btns.find(b => (b.getAttribute('title') || '').includes('阅读'))
  if (read) read.click()
  await new Promise(r => setTimeout(r, 1200))
  const p = document.querySelector('.preview')
  return {
    callout: p ? p.querySelectorAll('.pv-callout').length : 0,
    details: p ? p.querySelectorAll('.pv-details').length : 0,
    tabs: p ? p.querySelectorAll('.pv-tabs').length : 0,
    mermaid: p ? p.querySelectorAll('.pv-mermaid').length : 0,
    mermaidRendered: p ? !!p.querySelector('.pv-mermaid-graph svg') : false,
    table: p ? p.querySelectorAll('.pv-table').length : 0,
  }
})()`)
ok('2.预览区富块', pv.callout === 1 && pv.details === 1 && pv.tabs === 1 && pv.mermaid === 1 && pv.table === 1, pv)

// 切回编辑
await evaluate(`(() => {
  const btns = [...document.querySelectorAll('.ph-seg-btn')]
  const w = btns.find(b => (b.getAttribute('title') || '').includes('编辑'))
  if (w) w.click()
})()`)
await new Promise((r) => setTimeout(r, 900))

/* ── 3. 表格九宫格 ── */
const grid = await evaluate(`(async () => {
  const wraps = [...document.querySelectorAll('.tb-menu-wrap')]
  const btn = [...wraps].map(w => w.querySelector('.tb-btn')).find(b => (b.getAttribute('title') || '') === '插入表格')
  if (!btn) return { err: 'no table btn' }
  btn.click()
  await new Promise(r => setTimeout(r, 300))
  const menu = document.querySelector('.tb-grid-menu')
  const cells = menu ? menu.querySelectorAll('.tb-grid-cell') : []
  // 悬停到第 4 行第 5 列
  const target = menu ? menu.querySelectorAll('.tb-grid-cell')[3 * 8 + 4] : null
  if (target) target.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
  await new Promise(r => setTimeout(r, 200))
  const sizeText = document.querySelector('.tb-grid-size')?.textContent?.trim() ?? null
  const onCount = menu ? menu.querySelectorAll('.tb-grid-cell.on').length : 0
  return { present: !!menu, cells: cells.length, sizeText, onCount }
})()`)
ok(
  '3.表格九宫格',
  grid.present && grid.cells === 64 && grid.sizeText === '4 × 5' && grid.onCount === 20,
  grid,
)

// 真的点一个尺寸，验证「插在光标处」且尺寸对
const tableInsert = await evaluate(`(async () => {
  const menu = document.querySelector('.tb-grid-menu')
  if (!menu) return { err: 'menu gone' }
  const v = window.__notaView
  // 光标放到文档开头：若命令有 bug 把内容追加到文末，这里就能抓出来
  v.dispatch({ selection: { anchor: 0 } })
  await new Promise(r => setTimeout(r, 120))
  const before = v.state.doc.toString()
  // 第 1 行（标题）行尾是插入点
  const at = before.indexOf('\\n')
  // 3 行 4 列
  const cell = menu.querySelectorAll('.tb-grid-cell')[2 * 8 + 3]
  cell.click()
  await new Promise(r => setTimeout(r, 400))
  const after = window.__notaView.state.doc.toString()
  const delta = after.length - before.length
  const added = delta > 0 ? after.slice(at, at + delta) : ''
  // 命令会在插入前补一个换行，所以真正的表头是第二个非空行
  const first = (added.split('\\n').find((l) => l.trim().length > 0) || '')
  return {
    atCursor: after.startsWith('# 标题一'),
    added: added.slice(0, 120),
    firstLine: first,
    cols: (first.match(/\\|/g) || []).length - 1,
  }
})()`)
ok(
  '3b.表格插入尺寸',
  tableInsert.cols === 4 &&
    tableInsert.firstLine.includes('列 4') &&
    tableInsert.atCursor,
  tableInsert,
)

/* ── 4. 设置入口在侧栏底部 ── */
const settingsLoc = await evaluate(`(() => {
  const foot = document.querySelector('.foot .foot-btn')
  const panel = document.querySelector('.panel')
  const fm = document.querySelector('.hm-menu')
  return {
    inSidebarFoot: !!foot,
    footTitle: foot ? foot.getAttribute('title') : null,
    inPanel: !!(panel && foot && panel.contains(foot)),
  }
})()`)
// 顶栏菜单里应该已经没有「设置」了
const headerNoSettings = await evaluate(`(async () => {
  const anchor = document.querySelector('.hm-anchor')
  if (!anchor) return { err: 'no anchor' }
  anchor.click()
  await new Promise(r => setTimeout(r, 250))
  const items = [...document.querySelectorAll('.hm-menu .hm-item')].map(b => b.textContent.trim())
  anchor.click()
  return { items, hasSettings: items.some(t => t === '设置') }
})()`)
ok(
  '4.设置入口移位',
  settingsLoc.inSidebarFoot && settingsLoc.inPanel && !headerNoSettings.hasSettings,
  { ...settingsLoc, headerItems: headerNoSettings.items },
)

/* ── 5. 侧栏折叠按钮在「资料库」行 ── */
const headBtns = await evaluate(`(() => {
  const head = document.querySelector('.panel .head')
  if (!head) return { err: 'no head' }
  const btns = [...head.querySelectorAll('.mini')].map(b => b.getAttribute('title'))
  return { btns, hasCollapse: btns.some(t => (t || '').includes('收起侧边栏')),
           hasFolder: btns.some(t => (t || '').includes('新建文件夹')) }
})()`)
ok('5.侧栏头部按钮', headBtns.hasCollapse && headBtns.hasFolder, headBtns)

/* ── 6. 删除按钮图标变大 ── */
const delIcon = await evaluate(`(() => {
  const del = document.querySelector('.tree .del')
  if (!del) return { err: 'no del' }
  const svg = del.querySelector('svg')
  const r = del.getBoundingClientRect()
  return { size: svg ? svg.getAttribute('width') : null, btnW: Math.round(r.width), btnH: Math.round(r.height) }
})()`)
ok('6.删除图标', Number(delIcon.size) >= 15 && delIcon.btnW >= 24, delIcon)

/* ── 7. 标签从 frontmatter 读出 ── */
const tags = await evaluate(`(() => {
  const chips = [...document.querySelectorAll('.tags-body .tag')].map(b => b.textContent.replace(/\\s+/g,' ').trim())
  return { count: chips.length, chips }
})()`)
ok('7.标签区', tags.count === 2 && tags.chips.some(t => t.startsWith('日记')), tags)

/* ── 8. 新建文件夹 ── */
const folder = await evaluate(`(async () => {
  const btn = [...document.querySelectorAll('.panel .head .mini')].find(b => (b.getAttribute('title')||'').includes('新建文件夹'))
  if (!btn) return { err: 'no folder btn' }
  btn.click()
  await new Promise(r => setTimeout(r, 300))
  const input = document.querySelector('.folder-input')
  if (!input) return { err: 'no input' }
  input.value = '我的文件夹'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await new Promise(r => setTimeout(r, 500))
  return { created: window.__folders, inputGone: !document.querySelector('.folder-input') }
})()`)
ok('8.新建文件夹', folder.created && folder.created.length === 1 && folder.created[0].endsWith('我的文件夹'), folder)

/* ── 9. 选中色不再是淡色 ── */
const selColor = await evaluate(`(() => {
  const v = window.__notaView
  if (!v) return { err: 'no view' }
  // 全选正文，看 selectionBackground 的计算样式
  v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } })
  v.focus()
  const sel = document.querySelector('.cm-selectionBackground')
  const cs = sel ? getComputedStyle(sel) : null
  const rootStyle = getComputedStyle(document.documentElement)
  return {
    bg: cs ? cs.backgroundColor : null,
    token: rootStyle.getPropertyValue('--n-selection').trim(),
    fgToken: rootStyle.getPropertyValue('--n-selection-fg').trim(),
  }
})()`)
/* 断言不能写死具体数值：深浅两套主题的 alpha 不同（浅色 0.3 / 深色 0.34）。
   这里验的是「选区够深 + 有配套文字色」这两件事，不是某个固定字符串。 */
const selAlpha = parseFloat((String(selColor.token).match(/([\d.]+)\s*\)/) ?? [])[1] ?? '0')
ok(
  '9.选中色加深',
  selColor.token && selAlpha >= 0.25 && !!selColor.fgToken,
  { ...selColor, alpha: selAlpha },
)

/* ── 10. 编辑器仍存活 ── */
ok('10.编辑器存活', await evaluate('!!window.__notaView'), undefined)

console.log('\n--- JS ERRORS ---')
console.log(errors.length ? errors.join('\n') : '(none)')
console.log('\n=== SUMMARY ===')
const failed = Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k)
console.log(failed.length === 0 ? 'ALL PASS' : 'FAILED: ' + failed.join(', '))

ws.close(); edge.kill(); server.close()
process.exit(failed.length === 0 ? 0 : 1)
