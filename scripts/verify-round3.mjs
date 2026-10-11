/**
 * 本轮验证：视图模式语义 + 侧边栏重构 + 设置横排 + 大纲 + 查找面板。
 *
 * 输入用的是仓库里那份真实测试笔记（docs/编辑器功能测试.md），
 * 所以「测试文件」和「验证用例」是同一份东西，不会两边跑偏。
 *
 * 覆盖：
 *  1. 编辑模式是纯编辑：只有源码，不出现任何渲染产物 / 图片缩略
 *  2. 分栏：左编辑 + 右预览同时在，预览有内容
 *  3. 阅读：只剩预览，编辑器被销毁
 *  4. 预览把富块都渲染出来了（Callout / 折叠 / 分栏 / 图表 / 表格 / 代码高亮）
 *  5. 右侧大纲有内容
 *  6. 点大纲能带动预览滚动
 *  7. 侧边栏结构：搜索 / 四个导航项 / 文件夹区 / 标签区 / 底部设置
 *  8. 收起后变成纯图标窄轨，且带悬停提示
 *  9. 设置面板是横向的（左导航 + 右内容）
 * 10. 编辑区顶栏不再有侧边栏切换按钮
 * 11. Ctrl+F 查找替换面板排版正常
 * 12. 全流程零 JS 异常
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { purgeStale, removeProfile } from './tmp-profiles.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')
const NOTE_FILE = path.join(root, 'docs', '编辑器功能测试.md')
const NOTE = fs.readFileSync(NOTE_FILE, 'utf-8')

const PORT = 4293
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROFILE = path.join(root, `.tmp-cdp-round3-${Date.now()}`)

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

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2' }

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

const edge = spawn(EDGE, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  "--remote-debugging-port=" + CDP_PORT, `--user-data-dir=${PROFILE}`, '--window-size=1500,1000', 'about:blank'], { stdio:'ignore' })

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const errors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') errors.push('EXC ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300))
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('ERR ' + m.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300))
})
await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(2500)

const out = {}
const ok = (name, cond, detail) => {
  out[name] = { pass: !!cond, detail }
  console.log((cond ? '  PASS  ' : '  FAIL  '), name, detail !== undefined ? JSON.stringify(detail) : '')
}

/* ── 注入假工作区 ── */
const TREE = [
  {
    type: 'dir',
    name: 'notes',
    path: '/ws/notes',
    children: [
      { type: 'file', name: '编辑器功能测试.md', path: '/ws/编辑器功能测试.md', tags: ['测试', '日记'], starred: true, mtime: Date.now() - 3600_000 },
      { type: 'file', name: '随笔.md', path: '/ws/随笔.md', tags: ['随笔'], starred: false, mtime: Date.now() - 86400_000 * 20 },
    ],
  },
]

await evaluate('(() => {' +
  ` window.__notes = { "/ws/编辑器功能测试.md": ${JSON.stringify(NOTE)}, "/ws/随笔.md": "# 随笔\\n\\n随手记两句。\\n" };` +
  ' window.api = {' +
  '  pickWorkspace: async () => "/ws",' +
  `  readTree: async () => (${JSON.stringify(TREE)}),` +
  '  readNote: async (p) => window.__notes[p] ?? "",' +
  '  writeNote: async (p, t) => { window.__notes[p] = t; return true },' +
  '  createNote: async (d, n) => d + "/" + n + ".md",' +
  '  createFolder: async (d, n) => d + "/" + n,' +
  '  deleteNote: async () => true, renameNote: async (p) => p,' +
  '  pickImage: async () => ({ rel: "attachments/demo.png", alt: "图", copied: true, isVideo: false }),' +
  '  resolveMedia: async (b, r) => "nota-media://local/" + encodeURIComponent(b + "/" + r),' +
  '  exportSave: async () => "/tmp/x",' +
  '  historySave: async () => "/h/1.md", historyList: async () => [], historyRead: async () => "# h",' +
  '  minimize: () => {}, toggleMaximize: () => {}, closeWindow: () => {}, onMaximizeChange: () => {}' +
  ' }; return true; })()')

await evaluate("document.querySelector('.cta')?.click()")
await sleep(900)
// 展开目录 → 打开测试笔记
await evaluate("document.querySelector('.tree .row.dir')?.click()")
await sleep(300)
await evaluate("(() => { const rows=[...document.querySelectorAll('.tree .row.file')]; const t=rows.find(r=>r.textContent.includes('编辑器功能测试')); t?.click(); return !!t })()")
await sleep(1600)

const BTN = (title) => `[...document.querySelectorAll('.ph-seg-btn')].find(b => (b.getAttribute('title')||'').includes(${JSON.stringify(title)}))`
const clickMode = async (title) => {
  await evaluate(`(() => { const b = ${BTN(title)}; if (b) b.click(); return !!b })()`)
  await sleep(700)
}

/* ── 1. 编辑模式是纯编辑 ── */
await clickMode('编辑模式')
const write = await evaluate(`(() => ({
  editor: document.querySelectorAll('.cm-editor').length,
  preview: document.querySelectorAll('.preview').length,
  toolbar: document.querySelectorAll('.tb').length > 0,
  richInEditor: document.querySelectorAll('.cm-rich, .pv-callout, .pv-tabs, .pv-mermaid').length,
  mediaThumb: document.querySelectorAll('.cm-md-media').length,
  lineCount: window.__notaView ? window.__notaView.state.doc.lines : 0,
}))()`)
ok(
  '1.编辑模式是纯编辑',
  write.editor === 1 && write.preview === 0 && write.richInEditor === 0 && write.mediaThumb === 0 && write.lineCount > 40,
  write,
)

/* ── 2. 分栏：左编辑右预览 ── */
await clickMode('分栏')
const split = await evaluate(`(() => {
  const host = document.querySelector('.host')
  const pv = document.querySelector('.preview')
  const hostBox = host?.getBoundingClientRect()
  const pvBox = pv?.getBoundingClientRect()
  return {
    editor: document.querySelectorAll('.cm-editor').length,
    hasHost: !!host,
    hasPreview: !!pv,
    hostLeft: Math.round(hostBox?.left ?? -1),
    pvLeft: Math.round(pvBox?.left ?? -1),
    hostW: Math.round(hostBox?.width ?? 0),
    pvW: Math.round(pvBox?.width ?? 0),
    h1: pv?.querySelectorAll('h1').length ?? 0,
  }
})()`)
ok(
  '2.分栏左写右看',
  split.editor === 1 && split.hasPreview && split.hostLeft < split.pvLeft && split.hostW > 200 && split.pvW > 200 && split.h1 === 1,
  split,
)

/* ── 4. 预览富块全渲染（在分栏下测，预览同样要全渲染）── */
const pv = await evaluate(`(() => {
  const p = document.querySelector('.preview')
  if (!p) return { err: 'no preview' }
  return {
    callout: p.querySelectorAll('.pv-callout').length,
    calloutTypes: [...p.querySelectorAll('.pv-callout')].map(e => e.dataset.type),
    details: p.querySelectorAll('.pv-details').length,
    detailsTitle: p.querySelector('.pv-details > summary')?.textContent?.trim() ?? '',
    tabs: p.querySelectorAll('.pv-tabs').length,
    tabCount: p.querySelectorAll('.pv-tab').length,
    tabLabels: [...p.querySelectorAll('.pv-tab')].map(e => e.textContent.trim()),
    mermaid: p.querySelectorAll('.pv-mermaid').length,
    mermaidSvg: !!p.querySelector('.pv-mermaid-graph svg'),
    table: p.querySelectorAll('.pv-table').length,
    tableCells: p.querySelectorAll('.pv-table td').length,
    codeSpans: p.querySelectorAll('pre code span').length,
    h: [1,2,3,4,5,6].map(n => p.querySelectorAll('h' + n).length),
    taskItems: p.querySelectorAll('input[type=checkbox]').length,
    listItems: p.querySelectorAll('li').length,
    commentsVisible: p.innerText.includes('预览里不该出现'),
    hr: p.querySelectorAll('hr').length,
  }
})()`)
ok(
  '4.预览富块全渲染',
  pv.callout === 4 && pv.details === 1 && pv.tabs === 1 && pv.tabCount === 2 &&
    pv.mermaid === 1 && pv.mermaidSvg && pv.table === 1 && pv.tableCells === 12 &&
    pv.codeSpans > 3 && JSON.stringify(pv.h) === JSON.stringify([1, 12, 1, 1, 1, 1]) &&
    pv.listItems >= 10 && pv.taskItems === 2 && !pv.commentsVisible && pv.hr === 1,
  pv,
)

/* ── 4b. `==高亮==` 渲染成荧光笔底色 ── */
const mk = await evaluate(`(() => {
  const p = document.querySelector('.preview')
  const m = [...p.querySelectorAll('mark.pv-mark')]
  return {
    count: m.length,
    text: m.map(e => e.textContent.trim()),
    bg: m[0] ? getComputedStyle(m[0]).backgroundColor : '',
    leftover: p.innerText.includes('=='),
  }
})()`)
ok(
  '4b.高亮渲染成 mark',
  mk.count === 1 && mk.text[0] === '高亮' && mk.bg !== 'rgba(0, 0, 0, 0)' && !mk.leftover,
  mk,
)

/* ── 4c. 行内 / 块级公式由 KaTeX 排出 ── */
const math = await evaluate(`(async () => {
  const p = document.querySelector('.preview')
  for (let i = 0; i < 50; i++) {
    if ([...p.querySelectorAll('.pv-math,.pv-math-block')].every(e => e.querySelector('.katex'))) break
    await new Promise(r => setTimeout(r, 150))
  }
  const inline = [...p.querySelectorAll('.pv-math')]
  const block = [...p.querySelectorAll('.pv-math-block')]
  return {
    inline: inline.length,
    inlineRendered: inline.filter(e => e.querySelector('.katex')).length,
    block: block.length,
    blockRendered: block.filter(e => e.querySelector('.katex-display')).length,
    blockWidth: Math.round(block[0]?.getBoundingClientRect().width ?? 0),
    // 渲染出来还得看得见：零高度说明 KaTeX 的 CSS 没跟上，公式会塌成一条线
    inlineBox: inline.map((e) => {
      const b = e.getBoundingClientRect()
      return [Math.round(b.width), Math.round(b.height)]
    }),
    blockH: Math.round(block[0]?.getBoundingClientRect().height ?? 0),
    // 代码块里的美元符（模板字符串）是合法源码，要排除后再查有没有公式漏出来
    leftover: (() => {
      const clone = p.cloneNode(true)
      clone.querySelectorAll('pre, code, .katex').forEach((e) => e.remove())
      return clone.innerText.includes('$')
    })(),
  }
})()`)
ok(
  '4c.公式由 KaTeX 渲染',
  math.inline === 2 && math.inlineRendered === 2 &&
    math.block === 1 && math.blockRendered === 1 && math.blockWidth > 100 &&
    math.blockH > 20 && math.inlineBox.every(([w, h]) => w > 10 && h > 8) && !math.leftover,
  math,
)

/* ── 5. 大纲 ── */
const outline = await evaluate(`(() => {
  const n = document.querySelector('.outline')
  if (!n) return { exists: false }
  return {
    exists: true,
    items: n.querySelectorAll('.outline-item').length,
    first: n.querySelector('.outline-item')?.textContent?.trim() ?? '',
    hasActive: !!n.querySelector('.outline-item.on'),
  }
})()`)
ok('5.右侧大纲', outline.exists && outline.items >= 15, outline)

/* ── 6. 点大纲带动预览滚动 ── */
const jump = await evaluate(`(async () => {
  const p = document.querySelector('.preview')
  const items = [...document.querySelectorAll('.outline-item')]
  const target = items[items.length - 2]
  const before = p.scrollTop
  target?.click()
  await new Promise(r => setTimeout(r, 1000))
  const onItem = document.querySelector('.outline-item.on')
  return {
    before,
    after: Math.round(p.scrollTop),
    label: target?.textContent?.trim() ?? '',
    activeLabel: onItem?.textContent?.trim() ?? '',
  }
})()`)
ok('6.点大纲能跳转', jump.after > jump.before && !!jump.activeLabel, jump)

/* ── 3. 阅读：纯预览 ── */
await clickMode('阅读模式')
const read = await evaluate(`(() => ({
  editor: document.querySelectorAll('.cm-editor').length,
  preview: document.querySelectorAll('.preview').length,
  h1: document.querySelector('.preview')?.querySelectorAll('h1').length ?? 0,
}))()`)
ok('3.阅读模式是纯预览', read.editor === 0 && read.preview === 1 && read.h1 === 1, read)

/* ── 10. 编辑区顶栏没有侧栏切换按钮 ── */
const headBtns = await evaluate(`(() => {
  const btns = [...document.querySelectorAll('.ph .ph-icon')]
  return { titles: btns.map(b => b.getAttribute('title') || ''), sidebarSwitch: btns.some(b => (b.getAttribute('title')||'').includes('侧边栏')) }
})()`)
ok('10.顶栏无侧栏切换按钮', headBtns.sidebarSwitch === false, headBtns)

/* ── 11. Ctrl+F 查找替换面板 ── */
await clickMode('分栏')
await evaluate("window.__notaView && window.__notaView.focus()")
await sleep(200)
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 70, code: 'KeyF', key: 'f', modifiers: 2 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 70, code: 'KeyF', key: 'f', modifiers: 2 })
await sleep(600)
const search = await evaluate(`(() => {
  const panel = document.querySelector('.cm-panel.cm-search')
  if (!panel) return { exists: false }
  const input = panel.querySelector('input.cm-textfield')
  const btns = [...panel.querySelectorAll('button.cm-button')]
  const ib = input?.getBoundingClientRect()
  const bb = btns[0]?.getBoundingClientRect()
  return {
    exists: true,
    inputW: Math.round(ib?.width ?? 0),
    btnH: Math.round(bb?.height ?? 0),
    buttons: btns.map(b => b.textContent.trim()),
    labels: [...panel.querySelectorAll('label')].length,
    display: getComputedStyle(panel).display,
    wrap: getComputedStyle(panel).flexWrap,
  }
})()`)
ok(
  '11.查找替换面板',
  search.exists && search.inputW > 120 && search.btnH >= 22 && search.buttons.length >= 5 &&
    search.labels === 3 && search.display === 'flex',
  search,
)
await evaluate("document.querySelector('.cm-panel.cm-search button[name=close]')?.click()")

/* ── 7. 侧边栏结构 ── */
const side = await evaluate(`(() => {
  const p = document.querySelector('.panel')
  if (!p) return { exists: false }
  return {
    exists: true,
    width: Math.round(p.getBoundingClientRect().width),
    nav: [...p.querySelectorAll('.nav-item .nav-label')].map(e => e.textContent.trim()),
    navIcons: p.querySelectorAll('.nav-item svg').length,
    search: !!p.querySelector('.search-input'),
    secTitles: [...p.querySelectorAll('.sec-title')].map(e => e.textContent.trim()),
    folderRows: p.querySelectorAll('.tree .row.dir').length,
    fileRows: p.querySelectorAll('.tree .row.file').length,
    tags: p.querySelectorAll('.tag').length,
    footSettings: !!p.querySelector('.foot-btn svg'),
    collapsed: p.classList.contains('collapsed'),
  }
})()`)
ok(
  '7.侧边栏结构',
  side.exists && side.nav.length === 4 && side.navIcons >= 4 && side.search &&
    side.secTitles.includes('文件夹') && side.secTitles.includes('标签') &&
    side.folderRows === 1 && side.fileRows === 2 && side.tags === 3 && side.footSettings && !side.collapsed,
  side,
)

/* ── 8. 折叠成窄轨 + 悬停提示 ── */
const rail = await evaluate(`(async () => {
  document.querySelector('.head-actions .mini[data-tip*="收起"]')?.click()
  await new Promise(r => setTimeout(r, 500))
  const p = document.querySelector('.panel')
  const btns = [...p.querySelectorAll('.rail-btn')]
  return {
    width: Math.round(p.getBoundingClientRect().width),
    collapsed: p.classList.contains('collapsed'),
    railBtns: btns.length,
    tips: btns.map(b => b.dataset.tip).filter(Boolean),
    hasExpand: btns.some(b => (b.dataset.tip||'').includes('展开')),
    navLabelGone: p.querySelectorAll('.nav-label').length === 0,
  }
})()`)
ok(
  '8.折叠成图标窄轨',
  rail.collapsed && rail.width <= 60 && rail.railBtns >= 7 && rail.hasExpand &&
    rail.tips.length === rail.railBtns && rail.navLabelGone,
  rail,
)

/* ── 9. 设置面板横向 ── */
const settings = await evaluate(`(async () => {
  document.querySelector('.rail-btn[data-tip="设置"]')?.click()
  await new Promise(r => setTimeout(r, 400))
  const dlg = document.querySelector('.st')
  const nav = document.querySelector('.st-nav')
  const main = document.querySelector('.st-main')
  const nb = nav?.getBoundingClientRect()
  const mb = main?.getBoundingClientRect()
  const items = [...document.querySelectorAll('.st-nav-item .st-nav-label')].map(e => e.textContent.trim())
  const out = {
    exists: !!dlg,
    flex: dlg ? getComputedStyle(dlg).display : '',
    navW: Math.round(nb?.width ?? 0),
    navLeft: Math.round(nb?.left ?? 0),
    mainLeft: Math.round(mb?.left ?? 0),
    items,
    title: document.querySelector('.st-title')?.textContent?.trim() ?? '',
  }
  // 切到「关于」看版本号是否注入成功
  const about = [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent.includes('关于'))
  about?.click()
  await new Promise(r => setTimeout(r, 250))
  out.ver = document.querySelector('.st-about-ver')?.textContent?.trim() ?? ''
  document.querySelector('.st-x')?.click()
  return out
})()`)
ok(
  '9.设置横向布局',
  settings.exists && settings.flex === 'flex' && settings.navW > 150 &&
    settings.navLeft < settings.mainLeft && settings.items.length === 8 &&
    settings.title === '外观' && /^版本 \d/.test(settings.ver),
  settings,
)

/* ── 展开侧栏，回到初始状态 ── */
await evaluate(`(async () => {
  document.querySelector('.rail-btn[data-tip*="展开"]')?.click()
  await new Promise(r => setTimeout(r, 400))
})()`)

/* ── 12. JS 异常 ── */
console.log('\n--- JS ERRORS ---')
if (errors.length === 0) console.log('(none)')
else for (const e of errors.slice(0, 12)) console.log(e)

const failed = Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k)
console.log('\n=== SUMMARY ===')
console.log(failed.length ? 'FAILED: ' + failed.join(', ') : 'ALL PASS (' + Object.keys(out).length + ')')

await send('Page.close').catch(() => {})
ws.close()
edge.kill()
server.close()
removeProfile(PROFILE)
process.exit(failed.length || errors.length ? 1 : 0)
