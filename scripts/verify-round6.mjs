/**
 * 1.7.0 验证：独立弹窗 / 笔记列表栏 / 导入导出历史 / 简化搜索 / 同步滚动 / 模型选择。
 *
 * 沿用前几轮的做法：真实测试笔记 + 注入的假 IPC，跑在 headless Edge 上。
 *
 * 覆盖：
 *  1. 附件库与回收站是两个各自独立的窗口（没有页签、从不同时出现）
 *  2. 笔记列表栏：标题 / 计数 / 摘要 / 标签都在，条目数与视图一致
 *  3. 点列表里的一条真的把它打开
 *  4. 列表栏能收起展开，并且状态落盘
 *  5. 顶栏三枚动作：导入 / 导出 / 版本历史互不嵌套；导入走 note:import，
 *     目标目录取当前笔记所在目录，导入后重读目录树并给出轻提示
 *  6. 工具栏不再有 AI 下拉；搜索按钮开的是自绘查找条，不是原生面板
 *  7. 分栏时编辑区与预览区双向同步滚动
 *  8. AI 页的模型徽标能当选择器用（拉列表、点一下即切换、落盘）
 *  9. 标签筛选真的过滤（顺带修掉：以前点了没反应）
 * 10. 全程零 JS 异常
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { purgeStale, removeProfile } from './tmp-profiles.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')

/* 长文要能滚起来：同步滚动那一条得有足够的可滚高度 */
const LONG = [
  '---',
  'tags: [随笔]',
  'star: true',
  '---',
  '',
  '# 长文',
  '',
  '用来验证分栏时的同步滚动。',
  '',
  ...Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段：一段够长的正文，用来把页面撑到可滚动的高度。\n`),
].join('\n')

const SHORT = '---\ntags: [工作]\n---\n\n# 周报\n\n本周把导入导出做完了。\n'
const PLAIN = '# 无标签\n\n随手记两句。\n'

const PORT = 4313
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROFILE = path.join(root, `.tmp-cdp-round6-${Date.now()}`)
const CDP_PORT = 9600 + (Date.now() % 300)

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

const purged = purgeStale()
if (purged.removed || purged.skipped) console.log('[tmp] 清掉过期 profile:', JSON.stringify(purged))

await waitPortFree(CDP_PORT)

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
    errors.push('ERR ' + m.params.args.map((a) => String(a.value ?? a.description ?? '')).slice(0, 300))
  }
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

const now = Date.now()
const TREE = [
  {
    type: 'dir', name: '工作', path: '/ws/工作',
    children: [
      { type: 'file', name: '周报.md', path: '/ws/工作/周报.md', tags: ['工作'], starred: false, mtime: now - 3_600_000, excerpt: '本周把导入导出做完了。' },
    ],
  },
  { type: 'file', name: '长文.md', path: '/ws/长文.md', tags: ['随笔'], starred: true, mtime: now - 600_000, excerpt: '用来验证分栏时的同步滚动。' },
  { type: 'file', name: '无标签.md', path: '/ws/无标签.md', tags: [], starred: false, mtime: now - 3 * 86400_000, excerpt: '随手记两句。' },
]

await evaluate('(() => {' +
  ` window.__notes = { "/ws/长文.md": ${JSON.stringify(LONG)}, "/ws/工作/周报.md": ${JSON.stringify(SHORT)}, "/ws/无标签.md": ${JSON.stringify(PLAIN)} };` +
  ' window.__treeCalls = 0;' +
  ' window.__imp = null;' +
  ' window.api = {' +
  '  pickWorkspace: async () => "/ws",' +
  `  readTree: async () => { window.__treeCalls += 1; return (${JSON.stringify(TREE)}) },` +
  '  readNote: async (p) => window.__notes[p] ?? "",' +
  '  writeNote: async (p, t) => { window.__notes[p] = t; return true },' +
  '  createNote: async (d, n) => d + "/" + n + ".md",' +
  '  createFolder: async (d, n) => d + "/" + n,' +
  '  deleteNote: async () => true, renameNote: async (p) => p,' +
  '  importNotes: async (root, dir) => {' +
  '    window.__imp = { root, dir };' +
  '    const p = dir + "/导入的笔记.md";' +
  '    window.__notes[p] = "# 导入的笔记\\n\\n从外面收进来的。\\n";' +
  '    return [{ name: "导入的笔记.md", path: p }];' +
  '  },' +
  '  pickImage: async () => null,' +
  '  resolveMedia: async (b, r) => "nota-media://local/" + encodeURIComponent(r),' +
  '  attachList: async () => ([{ rel: "attachments/a.jpg", name: "a.jpg", size: 2048, mtime: Date.now(), isVideo: false }]),' +
  '  attachDelete: async () => true,' +
  '  trashList: async () => ([{ key: "aGV5", rel: "旧稿.md", name: "旧稿.md", deletedAt: Date.now() - 3600000, size: 120 }]),' +
  '  trashRestore: async () => "/ws/旧稿.md", trashPurge: async () => true, trashEmpty: async () => true,' +
  '  aiChat: async () => ({ ok: true, text: "好的。" }),' +
  '  aiTest: async () => ({ ok: true, models: ["qwen2.5:7b", "llama3.2"] }),' +
  '  appInfo: async () => ({ electron: "33.0.0", chrome: "130.0.0.0", node: "20.18.0", platform: "win32", arch: "x64" }),' +
  '  exportSave: async () => "/tmp/x.md",' +
  '  historySave: async () => "/h/1.md",' +
  '  historyList: async () => ([{ name: "1.md", path: "/h/1.md", size: 12, mtime: Date.now() }]),' +
  '  historyRead: async () => "# 旧版本\\n",' +
  '  minimize: () => {}, toggleMaximize: () => {}, closeWindow: () => {}, onMaximizeChange: () => {}' +
  ' }; return true; })()')

await evaluate("document.querySelector('.cta')?.click()")
await sleep(900)
await evaluate("document.querySelector('.tree .row.dir')?.click()")
await sleep(300)
await evaluate("(() => { const rows=[...document.querySelectorAll('.tree .row.file')]; const t=rows.find(r=>r.textContent.includes('长文')); t?.click(); return !!t })()")
await sleep(1200)

const clickMode = async (title) => {
  await evaluate(`(() => { const b = [...document.querySelectorAll('.ph-seg-btn')].find(x => (x.getAttribute('title')||'').includes(${JSON.stringify(title)})); if (b) b.click(); return !!b })()`)
  await sleep(700)
}

/* ── 1. 附件库与回收站：资料栏里的两个视图 ──
   开一个弹窗就得多想一层「我在第几层」，而且插图时正文被盖住。
   挪进中间那一列之后，这两件事变成同一栏的两个页签。 */
const libs = await evaluate(`(async () => {
  const pick = (label) => [...document.querySelectorAll('.panel .nav-item')]
    .find(b => (b.querySelector('.nav-label')?.textContent ?? '').includes(label))

  pick('附件库')?.click()
  await new Promise(r => setTimeout(r, 700))
  const cards = document.querySelectorAll('.col[data-view="attach"] .av-card').length
  const bothAtOnce1 = !!document.querySelector('.tv')

  pick('回收站')?.click()
  await new Promise(r => setTimeout(r, 700))
  const rows = document.querySelectorAll('.col[data-view="trash"] .pn-row').length
  const hasRestore = !!document.querySelector('.col[data-view="trash"] .tv-restore')
  const bothAtOnce2 = !!document.querySelector('.av')

  // 从侧栏切回笔记：附件/回收站顶上没有页签，它们是一次单独的「去某个地方」
  pick('所有笔记')?.click()
  await new Promise(r => setTimeout(r, 600))
  return {
    cards, rows, hasRestore, bothAtOnce1, bothAtOnce2,
    tabs: document.querySelectorAll('.lib-tab').length,
    dialogs: document.querySelectorAll('.dlg, .dlg-mask').length,
    backToNotes: !!document.querySelector('.col[data-view="notes"] .nlist'),
    tabsBack: document.querySelectorAll('.col-tab').length,
  }
})()`)
ok(
  '1.附件库与回收站是资料栏里的两个视图（不再是弹窗）',
  libs.cards === 1 && libs.rows === 1 && libs.hasRestore &&
    libs.tabs === 0 && libs.dialogs === 0 &&
    !libs.bothAtOnce1 && !libs.bothAtOnce2 && libs.backToNotes && libs.tabsBack === 3,
  libs,
)

/* ── 2. 笔记列表（资料栏「笔记」页） ── */
const list = await evaluate(`(() => {
  const panel = document.querySelector('.col[data-view="notes"] .nlist')
  if (!panel) return { err: 'no list panel' }
  const items = [...panel.querySelectorAll('.nl-item')]
  return {
    title: panel.querySelector('.nl-title')?.textContent?.trim(),
    count: panel.querySelector('.nl-count')?.textContent?.trim(),
    items: items.length,
    names: items.map(b => b.querySelector('.nl-text')?.textContent?.trim()),
    excerpt: items.map(b => b.querySelector('.nl-excerpt')?.textContent?.trim() ?? ''),
    folders: items.map(b => b.querySelector('.nl-folder')?.textContent?.trim()),
    tags: items.map(b => [...b.querySelectorAll('.nl-tag')].map(t => t.textContent.trim())),
    width: Math.round(panel.getBoundingClientRect().width),
  }
})()`)
ok(
  '2.笔记列表有标题/计数/摘要/标签',
  list.title === '所有笔记' && list.count === '3' && list.items === 3 &&
    ['周报', '长文', '无标签'].every((n) => (list.names ?? []).includes(n)) &&
    list.excerpt.every((e) => e.length > 0) &&
    list.folders.includes('工作') &&
    list.tags.some((t) => t.join() === '#工作') &&
    list.width > 200,
  list,
)

/* ── 3. 点列表里的一条能打开 ── */
const opened = await evaluate(`(async () => {
  const items = [...document.querySelectorAll('.col .nlist .nl-item')]
  const target = items.find(b => (b.querySelector('.nl-text')?.textContent ?? '').includes('无标签'))
  target?.click()
  await new Promise(r => setTimeout(r, 900))
  const on = document.querySelector('.col .nlist .nl-item.on .nl-text')?.textContent?.trim() ?? ''
  return { on, title: document.querySelector('.ph-title')?.value ?? '', body: (window.__notes['/ws/无标签.md'] ?? '').slice(0, 6) }
})()`)
ok(
  '3.列表里的一条能直接打开',
  opened.on === '无标签' && opened.title === '无标签',
  opened,
)

/* ── 4. 资料栏收起展开 + 落盘 ──
   1.9.0：横贯整窗的标题栏去掉了，这枚开关跟着右侧编辑区走 ——
   2.2.2 又把它从编辑区顶行并到侧栏顶行（和「收起侧边栏」排在一起），
   收起之后这一组按钮还在窄轨上，所以自己也管得了自己的复原。 */
const collapse = await evaluate(`(async () => {
  const pick = () => document.querySelector('.panel .head [data-role="column-toggle"]')
  const btn = pick()
  if (!btn) return { err: 'no toggle' }
  btn.click()
  await new Promise(r => setTimeout(r, 400))
  const hidden = !document.querySelector('.col')
  const saved = localStorage.getItem('nota-column-open')
  pick()?.click()
  await new Promise(r => setTimeout(r, 400))
  return { hidden, saved, back: !!document.querySelector('.col') }
})()`)
ok(
  '4.资料栏可收起展开且状态落盘',
  collapse.hidden && collapse.saved === '0' && collapse.back,
  collapse,
)

/* ── 5. 顶栏动作 + 导入（导入 2.2.3 起住资料栏右上角） ── */
const actions = await evaluate(`(async () => {
  const imp = document.querySelector('.col-act[title^="导入"]')
  const exp = document.querySelector('.ea-anchor')
  const hist = document.querySelector('.ea-btn[title="版本历史"]')
  if (!imp || !exp || !hist) return { err: 'missing buttons', imp: !!imp, exp: !!exp, hist: !!hist }

  // 导出下拉里只有导出，历史与导入都不在里面。
  // 项数从 2 涨到 4：2.2.6 把右键菜单里才有的 PDF / Word 补到了顶栏。
  exp.click()
  await new Promise(r => setTimeout(r, 300))
  const menuItems = [...document.querySelectorAll('.ea-menu .ea-item')].map(b => b.textContent.trim())
  exp.click()
  await new Promise(r => setTimeout(r, 250))

  // 先把当前笔记切到子目录里那篇，导入目标目录应当是它所在的目录
  const fileRows = [...document.querySelectorAll('.tree .row.file')]
  fileRows.find(r => r.textContent.includes('周报'))?.click()
  await new Promise(r => setTimeout(r, 900))
  const before = window.__treeCalls
  imp.click()
  await new Promise(r => setTimeout(r, 900))
  const toast = [...document.querySelectorAll('.toast')].pop()?.textContent?.trim() ?? ''
  return {
    menuItems, imp: window.__imp, before, after: window.__treeCalls, toast,
    openedAfterImport: document.querySelector('.ph-title')?.value ?? '',
  }
})()`)
ok(
  '5.导入 / 导出 / 版本历史各自独立，导入落到当前目录',
  actions.menuItems?.length === 4 &&
    ['Markdown', 'HTML', 'Word', 'PDF'].every((k) => actions.menuItems.join(',').includes(k)) &&
    // 导入与历史**不**混进导出菜单 —— 这才是这条断言真正要看的
    !actions.menuItems.join(',').match(/导入|历史/) &&
    actions.imp && actions.imp.root === '/ws' && actions.imp.dir === '/ws/工作' &&
    actions.after > actions.before &&
    actions.toast.includes('已导入 1 篇') &&
    actions.openedAfterImport === '导入的笔记',
  actions,
)

/* ── 6. 工具栏没有 AI 下拉；搜索走自绘查找条 ── */
const toolbar = await evaluate(`(async () => {
  const wraps = document.querySelectorAll('.tb-menu-wrap').length
  const ai = !!document.querySelector('.tb-btn.tb-ai')
  const searchBtn = [...document.querySelectorAll('.tb-btn')].find(b => (b.getAttribute('title') || '').includes('查找'))
  searchBtn?.click()
  await new Promise(r => setTimeout(r, 500))
  const bar = document.querySelector('.findbar')
  const native = document.querySelectorAll('.cm-panel.cm-search').length
  // 收掉，免得挡住后面的定位
  document.querySelector('.findbar .fb-btn:last-child')?.click()
  await new Promise(r => setTimeout(r, 300))
  return { wraps, ai, bar: !!bar, native, closed: !document.querySelector('.findbar') }
})()`)
ok(
  '6.工具栏无 AI 下拉，搜索是自绘查找条',
  // 下拉组数：2.1 加了「图表」「提示块」两组之后是 10 组（round10 第 3 条逐个数过）
  !toolbar.ai && toolbar.wraps >= 10 && toolbar.bar && toolbar.native === 0 && toolbar.closed,
  toolbar,
)

/* ── 7. 分栏同步滚动 ── */
await evaluate("(() => { const t=[...document.querySelectorAll('.nlist .nl-item')].find(b=>(b.querySelector('.nl-text')?.textContent??'').includes('长文')); t?.click(); return true })()")
await sleep(1000)
await clickMode('分栏')
const sync = await evaluate(`(async () => {
  const v = window.__notaView
  const pv = document.querySelector('.preview')
  if (!v || !pv) return { err: 'no view/preview', v: !!v, pv: !!pv }
  const ed = v.scrollDOM
  const edMax = ed.scrollHeight - ed.clientHeight
  const pvMax = pv.scrollHeight - pv.clientHeight
  if (edMax < 200 || pvMax < 200) return { err: 'not scrollable', edMax, pvMax }

  // 编辑区看向文档的哪个位置——对齐用的是它，不是像素比例：CodeMirror
  // 虚拟滚动，scrollHeight 一滚就重估一次，拿它算比例两边会互相追着跑
  const at = () => (v.visibleRanges[0]?.from ?? 0) / v.state.doc.length
  const pvFrac = () => pv.scrollTop / (pv.scrollHeight - pv.clientHeight)
  const r3 = (n) => Math.round(n * 1000) / 1000

  // ① 编辑 → 预览：预览应当停在编辑区正在看的位置上
  const fromEditor = []
  for (const f of [0.35, 0.7]) {
    ed.scrollTop = Math.round((ed.scrollHeight - ed.clientHeight) * f)
    ed.dispatchEvent(new Event('scroll'))
    await new Promise(r => setTimeout(r, 350))
    fromEditor.push({ f, ed: r3(at()), pv: r3(pvFrac()) })
  }

  // ② 预览 → 编辑：中段来回走一趟。预览底部留了 42vh 尾白（故意的，方便
  //    滚过头），最底下那一段预览能滚、编辑区已经到底滚不动了，所以取样
  //    避开底，免得拿「已经抵墙」去比。
  const toPreview = async (frac) => {
    pv.scrollTop = Math.round((pv.scrollHeight - pv.clientHeight) * frac)
    pv.dispatchEvent(new Event('scroll'))
    await new Promise(r => setTimeout(r, 350))
    return { want: frac, got: r3(pvFrac()), ed: r3(at()) }
  }
  const deep = await toPreview(0.55)
  const backUp = await toPreview(0.2)
  const deepAgain = await toPreview(0.55)

  return { edMax, pvMax, fromEditor, deep, backUp, deepAgain }
})()`)
/* 这一条以前是自证循环：预览的位置本来就是从编辑区回写过去的，两边当然
   相等。现在改成四条能各自站住的契约：
     · 编辑区动了，预览停在编辑区正在看的位置（不是随便挪一下）
     · 预览往下走，编辑区跟着往下走；预览退回，编辑区也退回
     · 预览回到同一个位置时，编辑区落回同一处 —— 不是单向累加的漂移
     · 预览自己停得住 —— 不会被回音在半路上拽回去 */
ok(
  '7.分栏时编辑区与预览区双向同步滚动',
  !sync.err &&
    sync.fromEditor.every((s) => Math.abs(s.pv - s.ed) < 0.02) &&
    sync.fromEditor[1].ed > sync.fromEditor[0].ed + 0.1 &&
    Math.abs(sync.deep.got - sync.deep.want) < 0.02 &&
    Math.abs(sync.backUp.got - sync.backUp.want) < 0.02 &&
    sync.deep.ed > sync.backUp.ed + 0.1 &&
    Math.abs(sync.deepAgain.ed - sync.deep.ed) < 0.05,
  sync,
)

/* ── 8. AI 模型选择（底部那一行，菜单仍是同一套 .n-menu） ── */
const model = await evaluate(`(async () => {
  const read = () => { try { return JSON.parse(localStorage.getItem('nota-ai') || '{}') } catch { return {} } }
  const nav = [...document.querySelectorAll('.panel .nav-item')]
    .find(x => (x.querySelector('.nav-label')?.textContent ?? '').trim() === 'AI 编写')
  nav?.click()
  await new Promise(r => setTimeout(r, 600))

  // 底部那一行左边的模型名就是当前模型
  const label = () => document.querySelector('.ag .ag-model-name')?.textContent?.trim() ?? ''
  const badge = document.querySelector('.ag .m-wrap .ag-model')
  if (!badge) return { err: 'no model badge' }
  const active = () => document.querySelector('.ag .m-menu .n-menu-item.on .n-menu-name')
    ?.textContent?.trim() ?? ''
  const initial = label()
  badge.click()
  await new Promise(r => setTimeout(r, 900))
  const menu = document.querySelector('.ag .m-menu')
  const menuIsN = menu?.classList.contains('n-menu') ?? false
  const items = [...(menu?.querySelectorAll('.n-menu-item') ?? [])]
  const opts = items.map(b => b.querySelector('.n-menu-name')?.textContent?.trim() ?? '')
  const hasSettings = opts.includes('模型设置…')
  const marked = active()
  const target = items.find(b => (b.querySelector('.n-menu-name')?.textContent ?? '').trim() === 'qwen2.5:7b')
  target?.click()
  await new Promise(r => setTimeout(r, 400))
  const saved = read()
  const closed = !document.querySelector('.ag .m-menu')
  return {
    initial, menuIsN, opts, hasSettings, marked,
    after: label(), savedModel: saved.model, closed,
  }
})()`)
ok(
  '8.AI 底部的模型选择可切换模型',
  model.initial === 'llama3.2' && model.menuIsN && model.marked === 'llama3.2' &&
    (model.opts ?? []).includes('qwen2.5:7b') && model.hasSettings &&
    model.after === 'qwen2.5:7b' && model.savedModel === 'qwen2.5:7b' && model.closed,
  model,
)

/* ── 9. 标签筛选真的过滤 ── */
const tagFilter = await evaluate(`(async () => {
  const nav = [...document.querySelectorAll('.panel .nav-item')]
    .find(x => (x.querySelector('.nav-label')?.textContent ?? '').trim() === '所有笔记')
  nav?.click()
  await new Promise(r => setTimeout(r, 500))
  const tag = [...document.querySelectorAll('.panel .tags-body .tag')]
    .find(b => b.textContent.includes('工作'))
  if (!tag) return { err: 'no tag button' }
  const before = document.querySelectorAll('.nlist .nl-item').length
  tag.click()
  await new Promise(r => setTimeout(r, 500))
  const after = document.querySelectorAll('.nlist .nl-item').length
  const names = [...document.querySelectorAll('.nlist .nl-text')].map(e => e.textContent.trim())
  const secTitle = document.querySelector('.panel .sec-title')?.textContent?.trim() ?? ''
  const listTitle = document.querySelector('.nlist .nl-title')?.textContent?.trim() ?? ''
  // 再点一次取消筛选
  const tag2 = [...document.querySelectorAll('.panel .tags-body .tag')].find(b => b.textContent.includes('工作'))
  tag2?.click()
  await new Promise(r => setTimeout(r, 500))
  return { before, after, names, secTitle, listTitle, restored: document.querySelectorAll('.nlist .nl-item').length }
})()`)
ok(
  '9.标签筛选真的过滤（以前点了没反应）',
  tagFilter.before === 3 && tagFilter.after === 1 &&
    tagFilter.names.join() === '周报' && tagFilter.listTitle === '# 工作' &&
    tagFilter.secTitle === '# 工作' && tagFilter.restored === 3,
  tagFilter,
)

/* ── 10. 零异常 ── */
ok('10.零 JS 异常', errors.length === 0, { errors: errors.slice(0, 5) })

console.log('\n--- JS ERRORS ---')
console.log(errors.length ? errors.join('\n') : '(none)')
console.log('\n=== SUMMARY ===')
const failed = Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k)
console.log(failed.length ? 'FAILED: ' + failed.join(', ') : `ALL PASS (${Object.keys(out).length})`)

await send('Page.close').catch(() => {})
ws.close()
edge.kill()
server.close()
removeProfile(PROFILE)
process.exit(failed.length || errors.length ? 1 : 0)
