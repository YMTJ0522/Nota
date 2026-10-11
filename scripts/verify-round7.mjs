/**
 * 1.8.0 验证：资料栏四视图 / 三条分隔线可拖 / 标签区常显 / 保存灯 / 选中色 / 菜单统一 / 色点同心。
 *
 * 沿用前几轮的做法：真实测试笔记 + 注入的假 IPC，跑在 headless Edge 上。
 *
 * 覆盖：
 *  1. 资料栏四个视图共用一个栏，一次只显示一个
 *  2. 三条分隔线都能拖：宽度真的变、落在上下限内、宽度落盘、双击复位
 *  3. 侧栏标签区常显（没标签时给提示而不是整块消失），新建标签写进 frontmatter
 *  4. 自动保存灯：没保存是红（--n-danger），已保存是绿（--n-ok）
 *  5. 选中色在浅色 / 深色下都是不透明实色，且与画布底色的反差够看清
 *  6. 所有下拉菜单走同一套 .n-menu，原生 <select> 与系统蓝方块都没了
 *  7. 强调色圆点同心居中（外圈描边不再把内点挤歪）
 *  8. 全程零 JS 异常
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { purgeStale, removeProfile } from './tmp-profiles.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')

const LONG = [
  '---',
  'tags: [随笔]',
  'star: true',
  '---',
  '',
  '# 长文',
  '',
  '## 第一节',
  '',
  ...Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 段：一段够长的正文，用来把页面撑到可滚动的高度。\n`),
  '## 第二节',
  '',
  ...Array.from({ length: 30 }, (_, i) => `第二段第 ${i + 1} 行：继续把页面往下撑，好让大纲有东西可跳。\n`),
].join('\n')

const SHORT = '---\ntags: [工作]\n---\n\n# 周报\n\n本周把导入导出做完了。\n'
const PLAIN = '# 无标签\n\n随手记两句。\n'

const PORT = 4327
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROFILE = path.join(root, `.tmp-cdp-round7-${Date.now()}`)
const CDP_PORT = 9900 + (Date.now() % 300)

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
  {
    type: 'dir', name: '工作', path: '/ws/工作',
    children: [
      { type: 'file', name: '周报.md', path: '/ws/工作/周报.md', tags: ['工作'], starred: false, mtime: now - 3_600_000, excerpt: '本周把导入导出做完了。' },
    ],
  },
  { type: 'file', name: '长文.md', path: '/ws/长文.md', tags: ['随笔'], starred: true, mtime: now - 600_000, excerpt: '用来验证分栏时的同步滚动。' },
  { type: 'file', name: '无标签.md', path: '/ws/无标签.md', tags: [], starred: false, mtime: now - 3 * 86400_000, excerpt: '随手记两句。' },
]
/** 三篇都没标签 —— 用来验证标签区在这种情况下是给提示，而不是整块消失 */
const TREE_NO_TAGS = TREE.map((n) => (
  n.type === 'dir'
    ? { ...n, children: n.children.map((c) => ({ ...c, tags: [] })) }
    : { ...n, tags: [] }
))

const INJECT = '(() => {' +
  ` window.__notes = { "/ws/长文.md": ${JSON.stringify(LONG)}, "/ws/工作/周报.md": ${JSON.stringify(SHORT)}, "/ws/无标签.md": ${JSON.stringify(PLAIN)} };` +
  ' window.api = {' +
  '  pickWorkspace: async () => "/ws",' +
  // 标签是从正文 frontmatter 里读出来的（真机就是这么干的），所以假 IPC
  // 也得跟着正文走 —— 否则「新建标签」永远测不出侧栏有没有更新
  '  readTree: async () => {' +
  `    const base = localStorage.getItem('noTags') ? ${JSON.stringify(TREE_NO_TAGS)} : ${JSON.stringify(TREE)};` +
  '    if (localStorage.getItem("noTags")) return base;' +
  '    const tagOf = (p) => {' +
  '      const doc = window.__notes[p] ?? "";' +
  '      const fm = doc.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---/);' +
  '      if (!fm) return [];' +
  '      const line = fm[1].match(/^tags:\\s*\\[(.*)\\]$/m);' +
  '      if (!line) return [];' +
  '      return line[1].split(",").map(s => s.trim()).filter(Boolean);' +
  '    };' +
  '    const walk = (n) => n.type === "dir"' +
  '      ? { ...n, children: n.children.map(walk) }' +
  '      : { ...n, tags: tagOf(n.path) };' +
  '    return base.map(walk);' +
  '  },' +
  '  readNote: async (p) => window.__notes[p] ?? "",' +
  '  writeNote: async (p, t) => { window.__notes[p] = t; return true },' +
  '  createNote: async (d, n) => d + "/" + n + ".md",' +
  '  createFolder: async (d, n) => d + "/" + n,' +
  '  deleteNote: async () => true, renameNote: async (p) => p,' +
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
  '  historySave: async () => "/h/1.md", historyList: async () => [], historyRead: async () => "# 旧版本\\n",' +
  '  minimize: () => {}, toggleMaximize: () => {}, closeWindow: () => {}, onMaximizeChange: () => {}' +
  ' }; return true; })()'

/** 重新载入并注入 —— 标签区「没标签」那一条要一个干净的工作区 */
async function boot(noTags = false) {
  await evaluate(`(() => { if (${noTags}) localStorage.setItem('noTags','1'); else localStorage.removeItem('noTags'); return true })()`)
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await sleep(2200)
  await evaluate(INJECT)
  await evaluate("document.querySelector('.cta')?.click()")
  await sleep(900)
  await evaluate("document.querySelector('.tree .row.dir')?.click()")
  await sleep(300)
  await evaluate("(() => { const rows=[...document.querySelectorAll('.tree .row.file')]; const t=rows.find(r=>r.textContent.includes('长文')); t?.click(); return !!t })()")
  await sleep(1300)
}

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(2000)
// AI 默认是关的，先开起来 —— 不然资料栏里第四个页签不会出现
await evaluate(`localStorage.setItem('nota-ai', ${JSON.stringify(JSON.stringify({
  enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'llama3.2', temperature: 0.7, systemPrompt: '',
}))})`)
await boot()

/* ── 1. 资料栏四个视图共用一个栏 ──
   四样东西（笔记 / 附件 / 回收站 / AI）在使用上是同一件事——「这一类有
   哪些，我要挑一个」，所以共用一个栏换着看，而不是各占一个弹窗。 */
const views = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const col = document.querySelector('.col')
  if (!col) return { err: 'no column' }
  const tabs = [...col.querySelectorAll('.col-tab')].map(b => b.getAttribute('data-view'))
  const seen = []
  for (const v of tabs) {
    col.querySelector('.col-tab[data-view="' + v + '"]')?.click()
    await wait(520)
    const cur = document.querySelector('.col')?.getAttribute('data-view')
    const body = document.querySelector('.col-body')
    seen.push({
      v,
      cur,
      // 每个视图的招牌元素，只应有一个在场
      nlist: !!body?.querySelector('.nlist'),
      av: !!body?.querySelector('.av'),
      tv: !!body?.querySelector('.tv'),
      chat: !!body?.querySelector('.chat.compact'),
    })
  }
  document.querySelector('.col-tab[data-view="notes"]')?.click()
  await wait(400)
  return {
    tabs, seen,
    cols: document.querySelectorAll('.col').length,
    editorAlive: !!document.querySelector('.stage'),
  }
})()`)
const viewMap = { notes: 'nlist', attach: 'av', trash: 'tv', ai: 'chat' }
ok(
  '1.资料栏四个视图共用一个栏，一次只显示一个',
  !views.err && views.cols === 1 &&
    ['notes', 'attach', 'trash', 'ai'].every((v) => views.tabs.includes(v)) &&
    views.seen.every((s) => s.cur === s.v && s[viewMap[s.v]] &&
      Object.keys(viewMap).filter((k) => k !== s.v).every((k) => !s[viewMap[k]])) &&
    views.editorAlive,
  views,
)

/* ── 2. 三条分隔线都能拖 ──
   拖完要满足四件事：宽度真的变了、不会拖出上下限、宽度落盘、双击能复位。
   顺带反向断言：拖完侧栏/资料栏不该把正文挤没。 */
const VAR = { sidebar: '--side-w', column: '--col-w', outline: '--outline-w' }
const HOST = { sidebar: '.panel', column: '.col', outline: '.outline' }
const DEFAULT_W = { sidebar: 232, column: 296, outline: 176 }
const readW = (key) => `(() => {
  const css = (n) => getComputedStyle(document.querySelector('.body')).getPropertyValue(n).trim()
  return {
    cssVar: css('${VAR[key]}'),
    stored: localStorage.getItem('nota-w-${key}'),
    real: Math.round(document.querySelector('${HOST[key]}')?.getBoundingClientRect().width ?? 0),
  }
})()`
const drag = (key, dx) => evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const sh = document.querySelector('.sh[data-target="${key}"]')
  if (!sh) return { err: 'no handle ${key}' }
  const r = sh.getBoundingClientRect()
  const x = Math.round(r.left), y = Math.round(r.top + Math.min(r.height / 2, 400))
  const ev = (t, cx) => new PointerEvent(t, { clientX: cx, clientY: y, bubbles: true, cancelable: true, pointerId: 1, isPrimary: true })
  sh.dispatchEvent(ev('pointerdown', x))
  await wait(50)
  window.dispatchEvent(ev('pointermove', x + ${dx}))
  await wait(80)
  window.dispatchEvent(ev('pointerup', x + ${dx}))
  await wait(200)
  return { x, dragging: document.body.classList.contains('n-dragging') }
})()`)

// 大纲的把手只在分栏 + 大纲可见时才存在，先把这两件事打开
await evaluate("(() => { const b=[...document.querySelectorAll('.ph-seg-btn')].find(x=>(x.getAttribute('title')||'').includes('分栏')); b?.click(); return !!b })()")
await sleep(800)
await evaluate("(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('title')||'')==='显示大纲'); b?.click(); return !!b })()")
await sleep(600)

const drags = {}
// 大纲默认 176、下限 140，拖 40 会直接撞到下限，所以用 20 量「真的跟着指针走」
for (const [key, dx, clampTo] of [['sidebar', 60, 420], ['column', 60, 560], ['outline', 20, 140]]) {
  const before = await evaluate(readW(key))
  const moved = await drag(key, dx)
  const after = await evaluate(readW(key))
  // 拖过头：应当停在界限上，而不是跟着指针跑出去
  await drag(key, 2000)
  const clamped = await evaluate(readW(key))
  await evaluate(`(() => { const sh = document.querySelector('.sh[data-target="${key}"]'); sh?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true })()`)
  await sleep(300)
  const reset = await evaluate(readW(key))
  drags[key] = { before, after, clamped, reset, dx, clampTo, moved }
}
const dragOk = (d) => {
  // 大纲在最右边，指针右移是把它变窄
  const want = d.key === 'outline' ? -d.dx : d.dx
  const grow = parseInt(d.after.cssVar) - parseInt(d.before.cssVar)
  return Math.abs(grow - want) <= 2 &&
    parseInt(d.after.cssVar) === parseInt(d.after.stored) &&
    parseInt(d.clamped.cssVar) === d.clampTo &&
    parseInt(d.reset.cssVar) === DEFAULT_W[d.key]
}
Object.entries(drags).forEach(([k, d]) => { d.key = k })
ok(
  '2.三条分隔线都能拖（宽度变 / 落盘 / 夹在上下限内 / 双击复位）',
  Object.values(drags).every((d) => !d.moved.err && dragOk(d)) &&
    Object.values(drags).every((d) => !d.moved.dragging) &&
    Object.values(drags).every((d) => d.before.real > 0 && d.after.real > 0),
  drags,
)

/* ── 3. 侧栏标签区：常显 + 新建标签写进 frontmatter ── */
await boot()
const tagBefore = await evaluate(`(() => {
  const sec = [...document.querySelectorAll('.panel .sec')].find(s => s.querySelector('.sec-title')?.textContent?.trim() === '标签')
  return {
    hasSection: !!sec,
    hasAdd: !!sec?.querySelector('.sec-add[data-tip="新建标签"]'),
    tags: [...(sec?.querySelectorAll('.tag') ?? [])].map(b => b.textContent.replace(/\\s+/g, ' ').trim()),
  }
})()`)
const made = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const sec = [...document.querySelectorAll('.panel .sec')].find(s => s.querySelector('.sec-title')?.textContent?.trim() === '标签')
  sec?.querySelector('.sec-add[data-tip="新建标签"]')?.click()
  await wait(300)
  const input = sec?.querySelector('.folder-new .folder-input')
  if (!input) return { err: 'no input' }
  input.focus(); input.value = '想法'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(120)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await wait(900)
  const doc = window.__notes['/ws/长文.md'] ?? ''
  return {
    inputGone: !document.querySelector('.panel .folder-new .folder-input'),
    inFrontmatter: /tags:/.test(doc) && /想法/.test(doc),
    head: doc.slice(0, 120),
    tags: [...document.querySelectorAll('.panel .tags-body .tag')].map(b => b.textContent.replace(/\\s+/g, ' ').trim()),
  }
})()`)
// 没标签时：给一句提示，而不是整块消失
await boot(true)
const emptyTags = await evaluate(`(() => {
  const sec = [...document.querySelectorAll('.panel .sec')].find(s => s.querySelector('.sec-title')?.textContent?.trim() === '标签')
  return {
    hasSection: !!sec,
    hasAdd: !!sec?.querySelector('.sec-add[data-tip="新建标签"]'),
    hint: sec?.querySelector('.hint')?.textContent?.trim().slice(0, 24) ?? '',
    tags: sec?.querySelectorAll('.tag').length ?? -1,
  }
})()`)
await boot()
ok(
  '3.标签区常显，没标签时给提示；新建标签写进 frontmatter',
  tagBefore.hasSection && tagBefore.hasAdd && tagBefore.tags.some((t) => t.includes('随笔')) &&
    !made.err && made.inputGone && made.inFrontmatter &&
    made.tags.some((t) => t.includes('想法')) &&
    emptyTags.hasSection && emptyTags.hasAdd && emptyTags.tags === 0 && emptyTags.hint.length > 0,
  { tagBefore, made, emptyTags },
)

/* ── 4. 自动保存灯：没保存红 / 已保存绿 ──
   原来只有一种灰底字，看不出有没有落盘。现在直接读颜色，
   跟 --n-danger / --n-ok 对得上才算数（不是「看起来像」）。 */
const save = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const el = () => document.querySelector('.ph-save')
  const read = () => {
    const e = el()
    if (!e) return null
    const cs = getComputedStyle(e)
    // 「已保存」用的是对勾图标，没有圆点；只在有圆点时读它的颜色
    const dot = e.querySelector('.ph-dot')
    return {
      cls: e.className.replace('ph-save', '').trim(),
      color: cs.color,
      dot: dot ? getComputedStyle(dot).backgroundColor : null,
      text: e.textContent.trim(),
    }
  }
  const rootVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
  // 先把编辑器弄脏
  const v = window.__notaView
  v?.focus()
  v?.dispatch({ changes: { from: v.state.doc.length, insert: '\\n脏了一笔。' } })
  await wait(120)
  const dirty = read()
  await wait(1800)
  const saved = read()
  return {
    danger: rootVar('--n-danger'), ok: rootVar('--n-ok'),
    dirty, saved,
  }
})()`)
const hexToRgb = (h) => {
  const m = /^#([0-9a-f]{6})$/i.exec((h ?? '').trim())
  if (!m) return null
  return `rgb(${parseInt(m[1].slice(0,2),16)}, ${parseInt(m[1].slice(2,4),16)}, ${parseInt(m[1].slice(4,6),16)})`
}
ok(
  '4.自动保存灯：没保存红 / 已保存绿（颜色取自 --n-danger / --n-ok）',
  save.dirty && save.saved &&
    save.dirty.cls === 'dirty' && save.saved.cls === 'saved' &&
    save.dirty.color === hexToRgb(save.danger) &&
    save.saved.color === hexToRgb(save.ok) &&
    save.dirty.dot === hexToRgb(save.danger) &&
    save.dirty.color !== save.saved.color,
  save,
)

/* ── 5. 选中色：深浅两套都是不透明实色，且跟底色反差够看清 ──
   以前是 transparent 打底 + 紫藤色，深色模式下混在黑底里发灰；
   现在改成向底色混入足够比例的强调色，实色，且反差可测。 */
const sel = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  // computed color 会把 oklab 原样吐回来，没法直接比亮度；借画布取真实像素
  const cv = document.createElement('canvas'); cv.width = cv.height = 1
  const cx = cv.getContext('2d', { willReadFrequently: true })
  const px = (v) => {
    cx.clearRect(0, 0, 1, 1)
    cx.fillStyle = '#000'
    cx.fillStyle = v
    cx.fillRect(0, 0, 1, 1)
    const d = cx.getImageData(0, 0, 1, 1).data
    return { rgba: [d[0], d[1], d[2], d[3]], luma: (0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]) / 255 }
  }
  const snap = () => {
    const cs = getComputedStyle(document.documentElement)
    const raw = cs.getPropertyValue('--n-selection').trim()
    return {
      raw,
      sel: px(raw),
      bg: px(cs.getPropertyValue('--n-bg').trim()),
      fg: px(cs.getPropertyValue('--n-selection-fg').trim()),
      transparent: /transparent/.test(raw),
    }
  }
  const html = document.documentElement
  const was = html.getAttribute('data-theme')
  const set = async (t) => { html.setAttribute('data-theme', t); await wait(240) }
  await set('light'); const light = snap()
  await set('dark'); const dark = snap()
  await set(was ?? 'light')
  return { light, dark }
})()`)
const selOk = (s) =>
  !s.transparent &&
  s.sel.rgba[3] === 255 &&                                  // 不透明实色
  Math.abs(s.sel.luma - s.bg.luma) > 0.05 &&                // 跟底色拉得开
  Math.abs(s.fg.luma - s.sel.luma) > 0.25                   // 字压在选中块上也读得清
ok(
  '5.选中色深浅都是不透明实色，且跟底色反差够看清',
  selOk(sel.light) && selOk(sel.dark) &&
    sel.light.sel.rgba.join() !== sel.dark.sel.rgba.join(),
  sel,
)

/* ── 6. 下拉菜单统一走 .n-menu ──
   系统原生控件那个蓝色方块是硬伤：跟顶栏主菜单完全两种语言。
   所以除了「菜单都挂 .n-menu」，还要反向断言原生 <select> 一个都不剩。 */
const menus = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const isN = (sel) => { const e = document.querySelector(sel); return e ? e.classList.contains('n-menu') : null }

  // ① 右键菜单
  const ed = document.querySelector('.cm-editor') ?? document.querySelector('.stage')
  ed?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 500, clientY: 400 }))
  await wait(400)
  const ctxIsN = isN('.ctx-menu')
  const ctxItem = document.querySelector('.ctx-item')?.classList.contains('n-menu-item') ?? false
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await wait(250)

  // ② 工具栏下拉（插入图片那一格）
  const tbBtn = document.querySelector('.tb-btn[title="插入图片或视频"]')
  tbBtn?.click()
  await wait(400)
  const tbIsN = isN('.tb-menu')
  const tbItem = document.querySelector('.tb-menu .tb-item')?.classList.contains('n-menu-item') ?? null
  document.body.click()
  await wait(250)

  // ③ 设置里的自绘下拉（原来是原生 <select>）
  document.querySelector('.foot .foot-btn[data-tip="设置"]')?.click()
  await wait(450)
  const nativeSelects = document.querySelectorAll('select').length
  const tab = [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent.includes('AI 编写'))
  tab?.click()
  await wait(450)
  const drop = document.querySelector('.st-drop .n-select')
  const dropIsSelect = !!drop
  drop?.click()
  await wait(350)
  const dropIsN = isN('.st-drop-menu')
  const dropItem = document.querySelector('.st-drop-menu .n-menu-item')?.classList.contains('n-menu-item') ?? false
  return { ctxIsN, ctxItem, tbIsN, tbItem, nativeSelects, dropIsSelect, dropIsN, dropItem }
})()`)
// 菜单项的 hover / 选中态必须挂在 --n-accent 上，不能是系统那一套
const menuCss = await evaluate(`(() => {
  const want = []
  for (const sheet of document.styleSheets) {
    let rules
    try { rules = sheet.cssRules } catch { continue }
    for (const r of rules) {
      if (!r.selectorText) continue
      const s = r.selectorText
      if (/\\.n-menu-item(:hover|\\.on)\\b/.test(s)) want.push({ sel: s, color: r.style.color, bg: r.style.backgroundColor || r.style.background })
      if (/\\.n-menu-item\\b/.test(s)) want.push({ sel: s, appearance: r.style.appearance })
    }
  }
  return want
})()`)
// 只认直接落在菜单项上的那条规则。带空格的是后代选择器
// （比如 .n-menu-item.on .n-menu-tail，颜色是 inherit），不算数
const direct = (sel) => sel.split(',').map((s) => s.trim()).some((s) => !s.includes(' '))
const hoverOn = menuCss.filter((r) => r.color && direct(r.sel))
const hasAppearance = menuCss.some((r) => r.appearance === 'none')
ok(
  '6.下拉菜单统一走 .n-menu（原生 select 归零，配色挂 --n-accent）',
  menus.ctxIsN === true && menus.ctxItem &&
    menus.tbIsN === true && menus.tbItem !== false &&
    menus.nativeSelects === 0 &&
    menus.dropIsSelect && menus.dropIsN === true && menus.dropItem &&
    hasAppearance &&
    hoverOn.length >= 1 &&
    // 悬停与选中必须是同一套配色，且都挂在 --n-accent 上（不是系统蓝方块）
    hoverOn.some((r) => r.sel.includes(':hover') && r.sel.includes('.on')) &&
    hoverOn.every((r) => (r.color ?? '').includes('--n-accent') && (r.bg ?? '').includes('--n-accent')),
  { menus, hoverOn, hasAppearance },
)

/* ── 7. 强调色圆点同心居中 ──
   外圈那道 1px 描边会把内容盒挤歪半像素，用 flex 居中时肉眼就能看出来。
   改成 inset:0 + margin:auto 之后内外两个圆心必须重合。 */
await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  document.body.click(); await wait(200)
  document.querySelector('.foot .foot-btn[data-tip="设置"]')?.click(); await wait(450)
  const tab = [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent.includes('外观'))
  tab?.click(); await wait(450)
  return true
})()`)
const dots = await evaluate(`(() => {
  const rings = [...document.querySelectorAll('.st-swatch')]
  const rows = rings.map((ring) => {
    const dot = ring.querySelector('.st-swatch-dot')
    const a = ring.getBoundingClientRect(), b = dot.getBoundingClientRect()
    return {
      on: ring.classList.contains('on'),
      ring: [Math.round(a.width), Math.round(a.height)],
      dot: [Math.round(b.width), Math.round(b.height)],
      dx: Math.round((b.left + b.width / 2 - (a.left + a.width / 2)) * 100) / 100,
      dy: Math.round((b.top + b.height / 2 - (a.top + a.height / 2)) * 100) / 100,
    }
  })
  return { count: rows.length, rows }
})()`)
ok(
  '7.七个强调色圆点都是同心居中（内外圆心重合）',
  dots.count === 7 &&
    dots.rows.every((r) => Math.abs(r.dx) <= 0.6 && Math.abs(r.dy) <= 0.6) &&
    dots.rows.every((r) => r.dot[0] < r.ring[0] && r.dot[1] < r.ring[1]) &&
    dots.rows.filter((r) => r.on).length === 1,
  dots,
)

await evaluate("document.querySelector('.st-x, .st-mask')?.click()")
await sleep(300)

/* ── 8. 零异常 ── */
ok('8.零 JS 异常', errors.length === 0, { errors })

const failed = Object.entries(out).filter(([, v]) => !v.pass)
console.log('\n--- JS ERRORS ---')
console.log(errors.length ? errors.join('\n') : '(none)')
console.log('\n=== SUMMARY ===')
console.log(failed.length ? 'FAILED: ' + failed.map(([k]) => k).join(' | ') : `ALL PASS (${Object.keys(out).length})`)

ws.close(); edge.kill(); server.close()
await sleep(300)
removeProfile(PROFILE)
process.exit(failed.length ? 1 : 0)
