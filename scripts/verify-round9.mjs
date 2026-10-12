/**
 * 2.0.0 验证：代码块语言改成「写完再选」、右侧不再重复出大纲、
 * 笔记卡片右键菜单与两步删除、AI 面板会话行落到顶部、
 * 以及两个真 bug（导入串位 / 预览回来笔记空了）的回归。
 *
 * 沿用前几轮的做法：真实测试笔记 + 注入的假 IPC，跑在 headless Edge 上。
 *
 * 覆盖：
 *  1. 打字时不再弹语言补全列表；围栏右上角有一枚安静的「语言」标签
 *  2. 点标签才出下拉，选完语言真的写回围栏，且下拉收掉
 *  3. 标签浮在代码块右上角，不在行号里、不和围栏文字挤在一起
 *  4. 预览区右侧不再有大纲，顶栏也不再有大纲开关；大纲住在中间栏页签里
 *  5. 切笔记 / 导入：编辑器里装的一定是当前这一篇（导入串位回归）
 *  6. 预览 → 编辑来回切（含快速连点）：内容一次都不丢
 *  7. 笔记卡片右键菜单：11 项，顺序与文案照参考图
 *  8. 卡片上的删除键两步走：先变「确认删除」，再点才真删
 *  9. AI 面板：会话行在顶部（新建 / 删除都在这一行），开关打开＝选中笔记
 * 10. 全程零 JS 异常
 * 11. 回收站：彻底删除 / 清空回收站都要先过确认弹窗
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { purgeStale, removeProfile } from './tmp-profiles.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')

const CODE = [
  '# 带代码的一篇',
  '',
  '```',
  'const a = 1',
  'console.log(a)',
  '```',
  '',
  '后面还有一段正文，用来把代码块推到不是唯一内容的位置。',
].join('\n')
const PLAIN = '# 甲笔记\n\n这是甲的内容。\n'
const OTHER = '# 乙笔记\n\n这是乙的内容。\n'
const IMPORTED = '# 导入进来的\n\n外面收进来的一篇。\n'

const PORT = 4345
/** 三个反引号：断言里拼围栏字符串用，避免直接写字面字符被编辑器的高亮带偏 */
const FENCE = String.fromCharCode(96).repeat(3)
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROFILE = path.join(root, `.tmp-cdp-round9-${Date.now()}`)
const CDP_PORT = 9800 + (Date.now() % 150)

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2' }
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0])
  let file = path.join(distDir, rel === '/' ? 'index.html' : rel)
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(distDir, 'index.html')
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
const purged = purgeStale()
if (purged.removed || purged.skipped) console.log('[tmp] 清掉过期 profile:', JSON.stringify(purged))

const edge = spawn(EDGE, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=1500,1000', 'about:blank'], { stdio:'ignore' })

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
  setTimeout(() => reject(new Error('cdp timeout ' + method)), 25000)
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
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('ERR ' + m.params.args.map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300))
  }
})
await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false })

const out = {}
const ok = (name, cond, detail) => {
  out[name] = { pass: !!cond, detail }
  console.log((cond ? '  PASS  ' : '  FAIL  '), name, detail !== undefined ? JSON.stringify(detail) : '')
}

const now = Date.now()
const TREE = [
  { type: 'file', name: '甲.md', path: '/ws/甲.md', tags: [], starred: false, mtime: now - 600_000, excerpt: '' },
  { type: 'file', name: '乙.md', path: '/ws/乙.md', tags: [], starred: false, mtime: now - 900_000, excerpt: '' },
  { type: 'file', name: '代码.md', path: '/ws/代码.md', tags: [], starred: false, mtime: now - 300_000, excerpt: '' },
  { type: 'dir', name: '新建文件夹', path: '/ws/新建文件夹', children: [
    { type: 'file', name: '空的.md', path: '/ws/新建文件夹/空的.md', tags: [], starred: false, mtime: now, excerpt: '' },
  ]},
]
const NOTES = {
  '/ws/甲.md': PLAIN,
  '/ws/乙.md': OTHER,
  '/ws/代码.md': CODE,
  '/ws/新建文件夹/空的.md': '',
}

const INJECT = '(() => {' +
  ` window.__notes = ${JSON.stringify(NOTES)};` +
  ` window.__tree = ${JSON.stringify(TREE)};` +
  ` window.__IMPORTED = ${JSON.stringify(IMPORTED)};` +
  ' window.__wait = (ms) => new Promise(r => setTimeout(r, ms));' +
  ' window.api = {' +
  '  pickWorkspace: async () => "/ws",' +
  '  readTree: async () => window.__tree ?? [],' +
  // 真实 IPC 是异步的，这里刻意慢一点：慢才会暴露「内容还没到就把界面换掉」的竞态
  '  readNote: async (f) => { await window.__wait(30); return window.__notes[f] ?? "" },' +
  '  writeNote: async (f, c) => { window.__notes[f] = c; return true },' +
  '  createNote: async (d, n) => { const p = d + "/" + n + ".md"; window.__notes[p] = ""; return p },' +
  '  createFolder: async (p, n) => p + "/" + n,' +
  '  deleteNote: async (f) => { window.__deleted = f; window.__tree = JSON.parse(JSON.stringify(window.__tree)); const rm = (ns) => { for (let i = ns.length - 1; i >= 0; i -= 1) { const n = ns[i]; if (n.path === f) ns.splice(i, 1); else if (n.children) rm(n.children) } }; rm(window.__tree); return true },' +
  '  renameNote: async (f, n) => f,' +
  '  moveNote: async (f, d) => f,' +
  '  revealNote: async () => { window.__revealed = true },' +
  '  importNotes: async (root, dir) => {' +
  '    const p = (dir || root) + "/导入的.md";' +
  '    window.__notes[p] = window.__IMPORTED;' +
  '    window.__tree = JSON.parse(JSON.stringify(window.__tree));' +
  '    window.__tree[3].children.push({ type: "file", name: "导入的.md", path: p, tags: [], starred: false, mtime: Date.now(), excerpt: "" });' +
  '    return [{ name: "导入的.md", path: p }];' +
  '  },' +
  '  pickImage: async () => null, resolveMedia: async () => null,' +
  '  exportSave: async () => { window.__exported = true; return "/out/x.md" },' +
  '  exportPdf: async () => { window.__exported = true; return "/out/x.pdf" },' +
  '  historySave: async () => null, historyList: async () => [], historyRead: async () => null,' +
  '  trashList: async () => [{ key: "tr-1", rel: "一周手记.md", name: "一周手记.md", deletedAt: Date.now() - 86400000, size: 2048 }],' +
  '  trashRestore: async () => "",' +
  '  trashPurge: async (r, k) => { window.__purged = (window.__purged || []).concat(k); return true },' +
  '  trashEmpty: async () => { window.__emptied = true; return true },' +
  '  attachList: async () => [], attachDelete: async () => true,' +
  '  aiTest: async () => ({ ok: true, models: ["llama3.2"] }),' +
  '  onAiDelta: (cb) => { window.__delta = cb },' +
  '  aiChat: async () => {' +
  '    const cb = window.__delta;' +
  '    for (const t of ["## 结果", "\\n\\n写好了。"]) { cb && cb({ text: t }); await window.__wait(80) }' +
  '    return { ok: true, text: "## 结果\\n\\n写好了。" }' +
  '  },' +
  '  appInfo: async () => ({}), minimize: async () => {}, toggleMaximize: async () => false, closeWindow: async () => {}, onMaximizeChange: () => {},' +
  ' };' +
  ' const css = document.createElement("style");' +
  ' css.textContent = "*{-webkit-app-region:no-drag !important}";' +
  ' document.head.appendChild(css);' +
  '})()'

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1800)
await evaluate(`localStorage.clear(); localStorage.setItem('nota-ai', ${JSON.stringify(JSON.stringify({
  enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'llama3.2', temperature: 0.7, systemPrompt: '',
}))})`)
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(2200)
await evaluate(INJECT)
await evaluate("document.querySelector('.cta')?.click()")
await sleep(1200)
await evaluate(INJECT)
await sleep(800)

const open = (name) => `(() => { const t=[...document.querySelectorAll('.nlist .nl-item')].find(b=>(b.querySelector('.nl-text')?.textContent??'').includes(${JSON.stringify(name)})); t?.click(); return !!t })()`
const cmDoc = () => "(window.__notaView?.state.doc.toString() ?? '')"
const pick = (label) => `(() => { const t=[...document.querySelectorAll('.panel .nav-item')].find(b=>(b.querySelector('.nav-label')?.textContent??'').trim()===${JSON.stringify(label)}); t?.click(); return !!t })()`

/* ══ 1 + 2 + 3. 代码块的语言：不弹补全、写完点标签才选 ══ */
await evaluate(pick('所有笔记'))
await sleep(600)
console.log('  [debug] 卡片：', await evaluate("[...document.querySelectorAll('.nlist .nl-text')].map(e=>e.textContent.trim())"))
await evaluate(open('代码'))
await sleep(1100)
console.log('  [debug] 打开后：', await evaluate("({ ph: !!document.querySelector('.ph'), title: document.querySelector('.ph-title')?.value, view: !!window.__notaView, host: !!document.querySelector('.host') })"))
console.log('  [debug] 异常：', errors.slice(0, 3))

const chip = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const v = window.__notaView
  if (!v) return { noView: true }

  // 在末尾再打一个围栏：这一步最容易被补全弹层打断
  const at = v.state.doc.length
  // 围栏的三个反引号在这里只能转义着写：这段是模板字符串，裸反引号会提前收口
  const fence = '\\u0060\\u0060\\u0060'
  v.dispatch({ changes: { from: at, to: at, insert: '\\n\\n' + fence + '\\nlet b = 2\\n' + fence + '\\n' }, selection: { anchor: at + 6 } })
  await wait(500)

  // 光标停在围栏行里（这正是原来会弹列表的位置）
  const fenceLine = v.state.doc.line(v.state.doc.lineAt(v.state.selection.main.head).number)
  return {
    popup: document.querySelectorAll('.wiki-complete').length,
    chips: document.querySelectorAll('.cm-code-lang-btn').length,
    labels: [...document.querySelectorAll('.cm-code-lang-btn')].map(b => b.textContent.trim()),
    firstLine: fenceLine.text,
  }
})()`)
ok(
  '1.打 ``` 时不再弹语言补全列表，围栏上也没有内联的语言选择器',
  chip.popup === 0 && chip.chips === 2,
  chip,
)

const menu = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const btns = [...document.querySelectorAll('.cm-code-lang-btn')]
  const b = btns[0]
  const r = b.getBoundingClientRect()
  // 标签得浮在代码块右上角：明显偏右，且落在首行的竖直范围里
  const line = document.querySelector('.cm-md-codeblock-open')
  const lr = line?.getBoundingClientRect()
  b.click()
  await wait(320)
  const m = document.querySelector('.n-menu .cm-lang-list')
  const rows = [...(m?.querySelectorAll('.n-menu-item') ?? [])].map(x => ({
    name: x.querySelector('.n-menu-name')?.textContent?.trim(),
    tail: x.querySelector('.n-menu-tail')?.textContent?.trim(),
  }))
  const py = rows.findIndex(r2 => r2.name === 'Python')
  const target = m?.querySelectorAll('.n-menu-item')[py]
  target?.click()
  await wait(320)
  return {
    opened: !!m,
    rows: rows.length,
    first: rows[0],
    hasPython: py >= 0,
    pythonTail: rows[py]?.tail,
    closed: !document.querySelector('.n-menu .cm-lang-list'),
    doc: window.__notaView.state.doc.toString().slice(0, 30),
    // 摆位：贴着首行、明显靠右
    chipRight: Math.round(r.right),
    lineRight: lr ? Math.round(lr.right) : 0,
    chipTop: Math.round(r.top),
    lineTop: lr ? Math.round(lr.top) : 0,
    lineBottom: lr ? Math.round(lr.bottom) : 0,
  }
})()`)
ok(
  '2.点标签才出下拉：选 Python 之后语言真的写回围栏，下拉随即收掉',
  menu.opened && menu.rows >= 15 && menu.first?.name === '纯文本' &&
    menu.hasPython && menu.pythonTail === 'python' && menu.closed &&
    // 注意是 includes 不是 startsWith：文档开头是标题，围栏还在第三行
    menu.doc.includes(FENCE + 'python'),
  { opened: menu.opened, rows: menu.rows, first: menu.first, hasPython: menu.hasPython,
    pythonTail: menu.pythonTail, closed: menu.closed, doc: menu.doc },
)
ok(
  '3.标签浮在代码块右上角（不在行号里，也不压住围栏文字）',
  menu.chipRight > menu.lineRight - 40 && menu.chipRight <= menu.lineRight &&
    menu.chipTop >= menu.lineTop && menu.chipTop <= menu.lineBottom,
  { chipRight: menu.chipRight, lineRight: menu.lineRight, chipTop: menu.chipTop, lineTop: menu.lineTop, lineBottom: menu.lineBottom },
)

/* ══ 4. 右侧不再有大纲 ══ */
const outline = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  document.querySelector('.ph-seg-btn[aria-label^="分栏视图"]')?.click()
  await wait(700)
  const split = {
    pvwChildren: document.querySelectorAll('.pvw > *').length,
    oldOutline: document.querySelectorAll('.pvw .eo, .pvw [class*="outline"]').length,
    toggle: document.querySelectorAll('.ph-icon').length,
    toggleTitles: [...document.querySelectorAll('.ph-icon')].map(b => b.getAttribute('title')),
  }
  // 大纲住在中间栏的页签里
  const tabs = [...document.querySelectorAll('.col .col-tab-label')].map(e => e.textContent.trim())
  const tabEl = document.querySelector('.col-tab[data-view="outline"]')
  tabEl?.click()
  await wait(600)
  const items = [...document.querySelectorAll('.ov .ov-item')].map(b => b.querySelector('.ov-text')?.textContent?.trim())
  document.querySelector('.col-tab[data-view="notes"]')?.click()
  await wait(400)
  document.querySelector('.ph-seg-btn[aria-label^="编辑模式"]')?.click()
  await wait(500)
  return { ...split, tabs, items }
})()`)
ok(
  '4.预览区右侧不再出大纲，顶栏的大纲开关也没了；大纲只在中间栏页签里',
  outline.pvwChildren === 1 && outline.oldOutline === 0 &&
    !outline.toggleTitles.some((t) => (t ?? '').includes('大纲')) &&
    outline.tabs.includes('大纲') && outline.items.length >= 1 &&
    outline.items.includes('带代码的一篇'),
  outline,
)

/* ══ 5. 切笔记 / 导入：编辑器里装的一定是当前这一篇 ══ */
await evaluate(open('甲'))
await sleep(1000)
const a1 = await evaluate(cmDoc())
await evaluate(open('乙'))
await sleep(1000)
const a2 = await evaluate(cmDoc())
await evaluate(open('空的'))
await sleep(1000)
const emptyBefore = await evaluate(cmDoc())
// 2.2：导入从中间栏的头部 / 空态撤走，跟「新建」并排住进编辑区顶行；按 title 认，别按下标
await evaluate("document.querySelector('.ea-btn[title=\"导入已有笔记\"]')?.click()")
await sleep(1400)
const afterImport = await evaluate(`(() => ({
  doc: ${cmDoc()},
  title: document.querySelector('.ph-title')?.value ?? '',
  onDiskEmpty: window.__notes['/ws/新建文件夹/空的.md'] ?? '<<没了>>',
  onDiskImported: (window.__notes['/ws/新建文件夹/导入的.md'] ?? '').slice(0, 12),
}))()`)
await evaluate(open('空的'))
await sleep(1000)
const backToEmpty = await evaluate(cmDoc())
ok(
  '5.导入不再串位：新收进来的那篇是它自己的内容，原来那篇空笔记还是空的',
  a1.includes('这是甲的内容') && a2.includes('这是乙的内容') && emptyBefore === '' &&
    afterImport.title === '导入的' && afterImport.doc.includes('导入进来的') &&
    afterImport.onDiskEmpty === '' && afterImport.onDiskImported.includes('导入进来的') &&
    backToEmpty === '',
  { a1: a1.slice(0, 12), a2: a2.slice(0, 12), emptyBefore, afterImport, backToEmpty },
)

/* ══ 6. 预览 → 编辑来回切，内容一次都不丢 ══ */
// 必须先打开一篇有内容的笔记再切视图：顺序反了的话，
// 编辑器里装的是上一步留下的空笔记，怎么切都是空的，测不出东西。
await evaluate(open('甲'))
await sleep(1000)
const toggle = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const read = document.querySelector('.ph-seg-btn[aria-label^="阅读模式"]')
  const edit = document.querySelector('.ph-seg-btn[aria-label^="编辑模式"]')
  const split = document.querySelector('.ph-seg-btn[aria-label^="分栏视图"]')
  const doc = () => (window.__notaView?.state.doc.toString() ?? '<<no view>>')
  const steps = []
  // 慢切：每一步都等界面稳下来
  for (const [btn, name] of [[read, 'read'], [edit, 'write'], [split, 'split'], [read, 'read'], [edit, 'write']]) {
    btn?.click(); await wait(700)
    steps.push({ to: name, doc: doc().slice(0, 10), visible: !!document.querySelector('.host')?.offsetHeight })
  }
  // 快速连点：不等动画、不等渲染，最容易撞上「内容还没到」
  for (let i = 0; i < 6; i += 1) {
    read?.click(); await wait(40)
    edit?.click(); await wait(40)
  }
  await wait(900)
  const afterRapid = doc()
  return { steps, afterRapid: afterRapid.slice(0, 10), rapidOk: afterRapid.includes('甲') }
})()`)
await sleep(300)
ok(
  // 阅读模式本来就会把编辑器销毁（省内存），那两步没有 view 是正常的；
  // 只要每次回到能写字的模式，内容与 edits 都完整就行。
  '6.预览 → 编辑来回切（含快速连点），笔记内容一次都不丢',
  toggle.steps.every((s) => (s.to === 'read' ? !s.visible : s.doc.includes('甲') && s.visible)) &&
    toggle.rapidOk,
  { steps: toggle.steps, afterRapid: toggle.afterRapid },
)

/* ══ 7. 笔记卡片右键菜单 ══ */
const ctx = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const card = [...document.querySelectorAll('.nlist .nl-item')][0]
  const r = card.getBoundingClientRect()
  card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 30, clientY: r.top + 10 }))
  await wait(320)
  const m = document.querySelector('.ctx-menu')
  const items = [...(m?.querySelectorAll('.ctx-item') ?? [])].map(b => ({
    text: (b.querySelector('.ctx-label')?.textContent?.trim() ?? b.textContent.trim()).replace(/…$/, ''),
    danger: b.classList.contains('danger'),
  }))
  return { opened: !!m, items, seps: m?.querySelectorAll('.ctx-sep').length ?? 0 }
})()`)
const EXPECT = ['打开','收藏','重命名','归类','复制路径','在系统打开','导出 PDF','导出 HTML','导出 Markdown','导出 Word','删除']
const got = ctx.items.map((i) => i.text)
ok(
  '7.笔记卡片右键菜单：11 项，顺序与文案照参考图，删除是危险项',
  ctx.opened && got.join('|') === EXPECT.join('|') &&
    ctx.items[ctx.items.length - 1].danger === true,
  { got, seps: ctx.seps },
)

/* ══ 8. 删除两步确认 ══ */
const del = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  // 先把右键菜单收掉（它挂在 body 上，会挡住卡片上的按钮）
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await wait(260)
  const card = [...document.querySelectorAll('.nlist .nl-item')][0]
  const name = card.querySelector('.nl-text')?.textContent?.trim() ?? ''
  const before = document.querySelectorAll('.nlist .nl-item').length
  card.querySelector('.nl-del')?.click()
  await wait(300)
  const armed = {
    confirmText: card.querySelector('.nl-del-yes')?.textContent?.trim() ?? '',
    arming: card.classList.contains('arming'),
    count: document.querySelectorAll('.nlist .nl-item').length,
    deleted: window.__deleted ?? null,
  }
  // 再点一次「确认删除」才真删
  card.querySelector('.nl-del-yes')?.click()
  await wait(700)
  return {
    name, before, armed,
    after: document.querySelectorAll('.nlist .nl-item').length,
    deleted: window.__deleted ?? null,
    gone: ![...document.querySelectorAll('.nlist .nl-text')].some(e => e.textContent.trim() === name),
  }
})()`)
ok(
  '8.卡片上的删除键两步走：先变成「确认删除」，再点一次才真的删掉',
  del.armed.confirmText === '确认删除' && del.armed.arming &&
    del.armed.count === del.before && !del.armed.deleted &&
    del.after === del.before - 1 && del.gone && !!del.deleted,
  del,
)

/* ══ 9. AI 面板：会话行在顶部、开关语义 ══ */
await evaluate(pick('AI 编写'))
await sleep(800)
const ai = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const el = document.querySelector('.col[data-view="ai"] .ag')
  const q = (s) => el?.querySelector(s) ?? null
  // 2.2：设定区合成一块面板（.ag-head），三行分别还是卡 / 会话 / 上下文
  const head = q('.ag-head')
  const rows = [...(head?.children ?? [])].map(c => c.className)
  const sess = q('.ag-sess')
  const acts = [...(sess?.querySelectorAll('.ag-mini') ?? [])].map(b => b.getAttribute('title'))
  // 开关默认打开＝选中笔记：右边跟的是笔记选择
  const onState = {
    on: q('.ag-switch')?.classList.contains('on'),
    pick: !!q('.ag-pick-name'),
    pickName: q('.ag-pick-name')?.textContent?.trim() ?? '',
    free: !!q('.ag-note-label'),
  }
  q('.ag-switch')?.click()
  await wait(300)
  const offState = {
    on: q('.ag-switch')?.classList.contains('on'),
    pick: !!q('.ag-pick-name'),
    free: q('.ag-note-label')?.textContent?.trim() ?? '',
  }
  q('.ag-switch')?.click()
  await wait(250)
  // 新建会话：点「+」真的开出一份空的
  const plus = [...(sess?.querySelectorAll('.ag-mini') ?? [])].find(b => b.getAttribute('title') === '新建会话')
  const before = q('.ag-sess-name')?.textContent?.trim()
  plus?.click()
  await wait(400)
  return {
    headOk: !!head,
    rows,
    sessName: q('.ag-sess-name')?.textContent?.trim() ?? '',
    acts,
    onState, offState,
    before, afterNew: q('.ag-sess-name')?.textContent?.trim(),
    trashTitle: [...(sess?.querySelectorAll('.ag-mini') ?? [])].map(b => b.getAttribute('title')).includes('删除当前会话'),
    foot: !!q('.ag-foot'),
  }
})()`)
ok(
  '9.AI 面板：会话行在卡片下面（新建 / 删除都在这一行），开关打开＝选中笔记',
  ai.headOk && ai.rows[0]?.includes('ag-row-top') && ai.rows[1]?.includes('ag-sess') &&
    ai.rows[2]?.includes('ag-note') && ai.acts.includes('新建会话') && ai.trashTitle &&
    ai.onState.on === true && ai.onState.pick && !ai.onState.free &&
    ai.offState.on === false && !ai.offState.pick && ai.offState.free === '自由对话' &&
    !ai.foot,
  ai,
)

/* ══ 11. 回收站：彻底删除 / 清空都要先过确认弹窗 ══
   回收站里按下去就是不可撤销的，所以这两处不能「点了就删」。 */
await evaluate(pick('回收站'))
await sleep(900)
const trash = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const row = document.querySelector('.tv .pn-row')
  row?.querySelector('.pn-act.danger')?.click()
  await wait(320)
  const dlg = document.querySelector('.cf-mask .cf')
  const ask = {
    open: !!dlg,
    title: dlg?.querySelector('.cf-title')?.textContent?.trim() ?? '',
    msg: dlg?.querySelector('.cf-msg')?.textContent?.trim() ?? '',
    dangerBtn: dlg?.querySelector('.cf-danger')?.textContent?.trim() ?? '',
    purged: window.__purged ?? null,
    rows: document.querySelectorAll('.tv .pn-row').length,
  }
  // 先点「取消」：不该有任何东西被删掉
  dlg?.querySelector('.cf-cancel')?.click()
  await wait(300)
  const afterCancel = {
    open: !!document.querySelector('.cf-mask'),
    purged: window.__purged ?? null,
    rows: document.querySelectorAll('.tv .pn-row').length,
  }
  // 再走一遍，这次确认
  document.querySelector('.tv .pn-row .pn-act.danger')?.click()
  await wait(280)
  document.querySelector('.cf-mask .cf-danger')?.click()
  await wait(500)
  const afterConfirm = { purged: window.__purged ?? null, rows: document.querySelectorAll('.tv .pn-row').length }

  // 清空回收站同样要问一句
  document.querySelector('.tv .pn-foot .pn-btn.danger')?.click()
  await wait(300)
  const emptyAsk = {
    title: document.querySelector('.cf-mask .cf-title')?.textContent?.trim() ?? '',
    emptied: window.__emptied ?? false,
  }
  document.querySelector('.cf-mask .cf-cancel')?.click()
  await wait(200)
  return { ask, afterCancel, afterConfirm, emptyAsk, emptiedAfterCancel: window.__emptied ?? false }
})()`)
ok(
  '11.回收站：彻底删除先弹确认（取消不动手 / 确认才真删），清空同样要问一句',
  trash.ask.open && trash.ask.title.includes('彻底删除') &&
    trash.ask.msg.includes('无法恢复') && trash.ask.dangerBtn === '永久删除' &&
    trash.ask.purged === null && trash.ask.rows === 1 &&
    !trash.afterCancel.open && trash.afterCancel.purged === null && trash.afterCancel.rows === 1 &&
    trash.afterConfirm.purged?.includes('tr-1') &&
    trash.emptyAsk.title.includes('清空') && trash.emptyAsk.emptied === false &&
    trash.emptiedAfterCancel === false,
  trash,
)

/* ══ 10. 零异常 ══ */
ok('10.全程零 JS 异常', errors.length === 0, errors.slice(0, 4))

console.log('\n=== SUMMARY ===')
const failed = Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k)
if (failed.length) console.log('FAILED:', failed.join(', '))
else console.log('ALL PASS (' + Object.keys(out).length + ')')

ws.close()
edge.kill()
server.close()
await removeProfile(PROFILE)
process.exit(failed.length ? 1 : 0)
