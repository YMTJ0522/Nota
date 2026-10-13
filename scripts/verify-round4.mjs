/**
 * 本轮验证：代码块外壳 + 强调色 + 查找条 + 笔记嵌入 + 附件库/回收站 + AI 入口。
 *
 * 沿用前三轮的做法：真实测试笔记 + 注入的假 IPC，跑在 headless Edge 上。
 * 假 IPC 里补了本轮新增的几个方法，弹窗类用例才跑得起来。
 *
 * 覆盖：
 *  1. 代码块只剩一层圆角薄框（没有标题栏 / 语言标签 / 复制 / 折叠）
 *  2. 行容器的行数和源码行数一致
 *  3. 代码仍有语法高亮
 *  4. 代码块不再渲染行号
 *  4. 超长代码块有折叠，点一下能展开
 *  5. 强调色 6 套都能切，且真的改掉了主色
 *  6. 设置里多了 AI 分区，字段齐全
 *  7. Ctrl+F 出的是自绘查找条，不是原生那一堆控件
 *  8. 查找条能数出匹配个数
 *  9. 笔记嵌入弹选择笔记，插入的是 ![[名字]]
 * 10. 附件库 / 回收站对话框能开、有内容
 * 11. 工具栏有 AI 按钮
 * 12. 侧边栏底部有库入口
 * 13. 关于页显示运行环境
 * 14. 全程零 JS 异常
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

const PORT = 4297
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROFILE = path.join(root, `.tmp-cdp-round4-${Date.now()}`)
const CDP_PORT = 9300 + (Date.now() % 300)

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
const consoleErrors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') errors.push('EXC ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300))
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const text = m.params.args.map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300)
    errors.push('ERR ' + text)
    consoleErrors.push(text)
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

/* ── 注入假工作区 ── */
const TREE = [
  {
    type: 'dir',
    name: 'notes',
    path: '/ws/notes',
    children: [
      { type: 'file', name: '编辑器功能测试.md', path: '/ws/编辑器功能测试.md', tags: ['测试'], starred: true, mtime: Date.now() - 3600_000 },
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
  '  attachList: async () => ([{ rel: "attachments/pic.png", name: "pic.png", size: 2048, mtime: Date.now(), isVideo: false }]),' +
  '  attachDelete: async () => true,' +
  '  trashList: async () => ([{ key: "aGV5", rel: "notes/旧稿.md", name: "旧稿.md", deletedAt: Date.now() - 3600_000, size: 120 }]),' +
  '  trashRestore: async () => "/ws/notes/旧稿.md", trashPurge: async () => true, trashEmpty: async () => true,' +
  '  aiChat: async () => ({ ok: true, text: "这是 AI 返回的结果" }),' +
  '  aiTest: async () => ({ ok: false, error: "ECONNREFUSED" }),' +
  '  appInfo: async () => ({ electron: "33.0.0", chrome: "130.0.0.0", node: "20.18.0", platform: "win32", arch: "x64" }),' +
  '  exportSave: async () => "/tmp/x",' +
  '  historySave: async () => "/h/1.md", historyList: async () => [], historyRead: async () => "# h",' +
  '  minimize: () => {}, toggleMaximize: () => {}, closeWindow: () => {}, onMaximizeChange: () => {}' +
  ' }; return true; })()')

await evaluate("document.querySelector('.cta')?.click()")
await sleep(900)
await evaluate("document.querySelector('.tree .row.dir')?.click()")
await sleep(300)
await evaluate("(() => { const rows=[...document.querySelectorAll('.tree .row.file')]; const t=rows.find(r=>r.textContent.includes('编辑器功能测试')); t?.click(); return !!t })()")
await sleep(1600)

const clickMode = async (title) => {
  await evaluate(`(() => { const b = [...document.querySelectorAll('.ph-seg-btn')].find(x => (x.getAttribute('title')||'').includes(${JSON.stringify(title)})); if (b) b.click(); return !!b })()`)
  await sleep(800)
}

/* ── 1~4. 代码块：只要一层圆角薄框 ──
   曾经有一整套外壳（标题栏 / 语言标签 / 复制 / 折叠），现在按参考项目
   的做法砍掉了——代码块该把注意力让给代码本身。所以这里反过来断言
   「外壳不存在」，免得哪天又长回来。 */
await clickMode('分栏')
const code = await evaluate(`(() => {
  const p = document.querySelector('.preview')
  if (!p) return { err: 'no preview' }
  const pres = [...p.querySelectorAll('pre.pv-code-pre')]
  // 图表（mermaid）不属于代码块，统计时排除掉
  const diag = p.querySelectorAll('.pv-code.is-diagram, .pv-code').length
  const first = pres.find(el => !el.querySelector('code.language-mermaid')) ?? pres[0]
  const cs = first ? getComputedStyle(first) : null
  return {
    count: pres.length,
    diagrams: p.querySelectorAll('.pv-mermaid').length,
    shells: p.querySelectorAll('.pv-code').length,
    heads: p.querySelectorAll('.pv-code-head').length,
    copies: p.querySelectorAll('[data-copy]').length,
    folds: p.querySelectorAll('[data-fold]').length,
    hasDiagShell: diag,
    radius: cs?.borderRadius ?? '',
    borderW: cs?.borderTopWidth ?? '',
    lineNumbers: p.querySelectorAll('.pv-line[data-line]').length,
    lines: [...p.querySelectorAll('pre.pv-code-pre > code')].map(c => c.querySelectorAll('.pv-line').length),
    tokenColors: new Set([...p.querySelectorAll('code span[class]')].map(s => getComputedStyle(s).color)).size,
    firstText: (first?.querySelector('code')?.textContent ?? '').slice(0, 60),
  }
})()`)
ok(
  '1.代码块只剩一层圆角薄框',
  code.count >= 2 && code.radius === '10px' && parseFloat(code.borderW) >= 1 &&
    code.shells === 0 && code.heads === 0 && code.copies === 0 &&
    code.hasDiagShell === 0 && code.diagrams === 1,
  code,
)

/* ── 2. 行容器数量与源码一致 ── */
// mermaid 块不进代码块，统计时要排除掉
const src = (NOTE.match(/```[\s\S]*?```/g) ?? []).filter((b) => !b.startsWith('```mermaid'))
const expectLines = src.map((b) => b.split('\n').length - 2)
const srcTotal = expectLines.reduce((a, b) => a + b, 0)
const gotTotal = (code.lines ?? []).reduce((a, b) => a + b, 0)
ok(
  '2.行容器数量对得上',
  gotTotal === srcTotal && (code.lines ?? []).every((n) => n > 0),
  { srcTotal, gotTotal, perBlock: code.lines, expect: expectLines },
)

/* ── 3. 高亮还在（外壳砍了，配色不该跟着没） ── */
ok(
  '3.代码仍有语法高亮',
  (code.tokenColors ?? 0) >= 2 && (code.firstText ?? '').length > 0,
  { tokenColors: code.tokenColors, firstText: code.firstText },
)

/* ── 4. 行号不再输出 ── */
ok(
  '4.代码块不再渲染行号',
  (code.lineNumbers ?? 0) === 0,
  { lineNumbers: code.lineNumbers },
)

/* ── 5. 强调色 ── */
const accent = await evaluate(`(async () => {
  const s = document.querySelector('.panel .foot .foot-btn[data-tip="设置"]')
  if (s) s.click()
  await new Promise(r => setTimeout(r, 400))
  // 色板在「外观」分区，设置默认停在「通用」
  const ap = [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent.includes('外观'))
  ap?.click()
  await new Promise(r => setTimeout(r, 300))
  const dots = [...document.querySelectorAll('.st-swatches .st-swatch')]
  if (!dots.length) return { err: 'no swatches', dots: dots.length }
  const seen = []
  for (const d of dots) {
    d.click()
    await new Promise(r => setTimeout(r, 160))
    seen.push({
      attr: document.documentElement.getAttribute('data-accent'),
      color: getComputedStyle(document.documentElement).getPropertyValue('--n-accent').trim(),
    })
  }
  const x = document.querySelector('.st-x'); if (x) x.click()
  await new Promise(r => setTimeout(r, 250))
  return { count: dots.length, seen, distinct: new Set(seen.map(s => s.color)).size }
})()`)
ok(
  '5.七套强调色可切（含石墨灰）',
  accent.count === 7 && accent.distinct === 7 &&
    accent.seen.every((s) => s.color.length > 0) &&
    accent.seen.some((s) => s.attr === 'graphite'),
  accent,
)

/* ── 6. AI 分区 ── */
const ai = await evaluate(`(async () => {
  const s = document.querySelector('.foot .foot-btn[data-tip="设置"]')
  if (s) s.click()
  await new Promise(r => setTimeout(r, 400))
  const tab = [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent.includes('AI'))
  if (!tab) return { err: 'no ai tab' }
  tab.click()
  await new Promise(r => setTimeout(r, 350))
  const dlg = document.querySelector('.st')
  const x = document.querySelector('.st-x'); if (x) x.click()
  return {
    hasTab: true,
    inputs: dlg ? dlg.querySelectorAll('.st-input').length : 0,
    hasTextarea: !!dlg?.querySelector('.st-textarea'),
    hasRange: !!dlg?.querySelector('.st-range'),
    hasSelect: !!dlg?.querySelector('.st-select'),
    hasTestBtn: !![...document.querySelectorAll('.st-btn')].find(b => b.textContent.includes('测试')),
  }
})()`)
ok(
  '6.设置里有 AI 分区',
  ai.hasTab && ai.inputs >= 3 && ai.hasTextarea && ai.hasRange && ai.hasSelect && ai.hasTestBtn,
  ai,
)

/* ── 7~8. 查找条 ── */
await clickMode('编辑模式')
// 走真实按键：合成 KeyboardEvent 派发到外层 .cm-editor 上，
// CodeMirror 挂在 contentDOM 的监听收不到（冒泡只能从里往外）。
await evaluate("window.__notaView && window.__notaView.focus()")
await sleep(250)
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 70, code: 'KeyF', key: 'f', modifiers: 2 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 70, code: 'KeyF', key: 'f', modifiers: 2 })
await sleep(600)
const find = await evaluate(`(async () => {
  const bar = document.querySelector('.findbar')
  const input = document.querySelector('.fb-input')
  if (!bar || !input) return { err: 'no findbar', bar: !!bar, input: !!input }
  const btns = [...bar.querySelectorAll('button')]
  const buttons = btns.length
  const titles = btns.map((b) => b.getAttribute('title') || '')
  const native = document.querySelectorAll('.cm-panel.cm-search').length
  input.value = '标题'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 400))
  const count1 = document.querySelector('.fb-count')?.textContent?.trim() ?? ''
  input.value = 'zzz-不存在'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 400))
  const count2 = document.querySelector('.fb-count')?.textContent?.trim() ?? ''
  return { buttons, titles, native, count1, count2 }
})()`)
ok(
  '7.Ctrl+F 是自绘查找条',
  // 按钮数不写死（2.2.6 补了匹配开关与替换，3 → 7），
  // 只保证自绘、没有原生面板、该有的键位都在
  find.native === 0 &&
    find.buttons >= 3 &&
    ['区分大小写', '全字匹配', '正则表达式', '上一个', '下一个'].every((t) =>
      (find.titles ?? []).some((x) => x.includes(t)),
    ),
  find,
)
ok(
  '8.查找条能数匹配',
  /\d+ \/ \d+|\d+ 处/.test(find.count1 ?? '') && (find.count2 ?? '').includes('无匹配'),
  { hit: find.count1, miss: find.count2 },
)

/* ── 9. 笔记嵌入 ── */
// 先把查找条收掉，免得它挡住工具栏菜单的定位
await evaluate("document.querySelector('.findbar .fb-btn:last-child')?.click()")
await sleep(300)
const embed = await evaluate(`(async () => {
  window.__notaView?.focus()
  // 走工具栏下拉里的「笔记嵌入」
  const btns = [...document.querySelectorAll('.tb-btn')].map(b => b.getAttribute('title'))
  // 「笔记嵌入」在「链接与引用」下拉里（跟 wikiLink / 块引用 / 脚注一组）
  const noteBtn = [...document.querySelectorAll('.tb-btn')].find(b => (b.getAttribute('title')||'').includes('链接与引用'))
  const foundBtn = !!noteBtn
  noteBtn?.click()
  await new Promise(r => setTimeout(r, 500))
  const allItems = [...document.querySelectorAll('.tb-item')].map(b => b.textContent.trim())
  const item = [...document.querySelectorAll('.tb-item')].find(b => b.textContent.includes('笔记嵌入'))
  const hasItem = !!item
  item?.click()
  await new Promise(r => setTimeout(r, 500))
  const dlg = document.querySelector('.np')
  const rows = dlg ? dlg.querySelectorAll('.np-item').length : 0
  const pick = dlg?.querySelector('.np-item')
  const pickName = pick?.querySelector('.np-item-name')?.textContent?.trim() ?? ''
  pick?.click()
  const okBtn = [...(dlg?.querySelectorAll('.np-item') ?? [])].length
  // 双击确认
  pick?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await new Promise(r => setTimeout(r, 400))
  const doc = window.__notaView ? window.__notaView.state.doc.toString() : ''
  return {
    btns, foundBtn, allItems, hasItem, rows, pickName, okBtn,
    closed: !document.querySelector('.np'),
    inserted: /!\\[\\[[^\\]]+\\]\\]/.test(doc),
    sample: (doc.match(/!\\[\\[[^\\]]+\\]\\]/) ?? [''])[0],
  }
})()`)
ok(
  '9.笔记嵌入弹窗选笔记',
  embed.hasItem && embed.rows > 0 && embed.closed && embed.inserted,
  embed,
)

/* ── 10. 附件库 / 回收站（资料栏里的两个视图，不再是弹窗） ──
   原来是两个各自独立的窗口，开一个就得先想「我现在在第几层」。
   现在挪进中间那一列：左边挑素材，右边光标还等着，这才是插图该有的样子。
   所以这里反过来断言「弹窗已经不存在」，免得哪天又长回来。 */
const lib = await evaluate(`(async () => {
  const pick = (label) => [...document.querySelectorAll('.panel .nav-item')]
    .find(b => (b.querySelector('.nav-label')?.textContent ?? '').includes(label))
  const wait = (ms) => new Promise(r => setTimeout(r, ms))

  // 附件库：点侧栏入口，内容长在资料栏里
  pick('附件库')?.click()
  await wait(700)
  const colAttach = document.querySelector('.col[data-view="attach"]')
  const cards = colAttach?.querySelectorAll('.av-card').length ?? 0
  const attachTitle = colAttach?.querySelector('.pn-title')?.textContent ?? ''
  const trashGoneMeanwhile = !document.querySelector('.tv')
  const dialogs = document.querySelectorAll('.dlg, .dlg-mask').length

  // 回收站：同一块栏换一页，不是再叠一个窗口
  pick('回收站')?.click()
  await wait(700)
  const colTrash = document.querySelector('.col[data-view="trash"]')
  const rows = colTrash?.querySelectorAll('.pn-row').length ?? 0
  const hasRestore = !!colTrash?.querySelector('.tv-restore')
  const attachGoneMeanwhile = !document.querySelector('.av')

  // 切回笔记：从侧栏那一项走（「笔记/大纲/引用」这排页签只在自己这一类里
  // 出现，从附件库回来得从侧栏走）
  pick('所有笔记')?.click()
  await wait(600)
  const backToNotes = !!document.querySelector('.col[data-view="notes"] .nlist')
  const tabsBack = document.querySelectorAll('.col-tab').length
  const editorAlive = !!document.querySelector('.stage')
  return {
    cards, attachTitle, rows, hasRestore,
    trashGoneMeanwhile, attachGoneMeanwhile,
    dialogs, backToNotes, editorAlive,
    inColumn: !!colAttach && !!colTrash,
    tabsBack,
    tabs: document.querySelectorAll('.lib-tab').length,
  }
})()`)
ok(
  '10.附件库与回收站是资料栏里的两个视图（不再是弹窗）',
  lib.cards === 1 && lib.rows === 1 && lib.hasRestore && lib.inColumn &&
    lib.attachTitle.includes('附件库') &&
    // 换页是真的换页：切到回收站时附件视图已经不在了，反之亦然
    lib.trashGoneMeanwhile && lib.attachGoneMeanwhile &&
    // 反向断言：弹窗和旧页签组一个都不许有
    lib.dialogs === 0 && lib.tabs === 0 &&
    lib.backToNotes && lib.tabsBack === 3 && lib.editorAlive,
  lib,
)

/* ── 11~12. 入口存在 ── */
const entries = await evaluate(`(() => ({
  // 工具栏里那个 AI 下拉已经删掉，不该再出现
  toolbarAi: !!document.querySelector('.tb-btn.tb-ai'),
  navLib: !![...document.querySelectorAll('.panel .nav-item')].find(b => (b.querySelector('.nav-label')?.textContent ?? '').includes('附件库')),
  navTrash: !![...document.querySelectorAll('.panel .nav-item')].find(b => (b.querySelector('.nav-label')?.textContent ?? '').includes('回收站')),
  navAi: !![...document.querySelectorAll('.panel .nav-item')].find(b => (b.querySelector('.nav-label')?.textContent ?? '').includes('AI 编写')),
}))()`)
ok(
  '11.AI 与库入口都在侧栏（工具栏不再有 AI 下拉）',
  !entries.toolbarAi && entries.navLib && entries.navTrash && entries.navAi,
  entries,
)

/* ── 13. 关于页 ── */
const about = await evaluate(`(async () => {
  const s = document.querySelector('.foot .foot-btn[data-tip="设置"]')
  if (s) s.click()
  await new Promise(r => setTimeout(r, 400))
  const tab = [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent.includes('关于'))
  tab?.click()
  await new Promise(r => setTimeout(r, 500))
  const dlg = document.querySelector('.st')
  // 关于页 2.x 重排过：hero 叫 .ab-hero，环境四格叫 .ab-env-cell（原来那批 .st-* 已经没了）
  const rows = [...(dlg?.querySelectorAll('.ab-env-cell') ?? [])].map(r => r.textContent.trim())
  const x = document.querySelector('.st-x'); if (x) x.click()
  await new Promise(r => setTimeout(r, 250))
  return { rows, hasHero: !!dlg?.querySelector('.ab-hero') }
})()`)
ok(
  '13.关于页有运行环境',
  about.hasHero && about.rows.length === 4 && about.rows.some((r) => r.includes('33')),
  about,
)

/* ── 14. 零异常 ── */
const csp = consoleErrors.filter((t) => /Content Security Policy/i.test(t))
ok(
  '14.零 JS 异常',
  errors.length === 0 && csp.length === 0,
  { errors: errors.slice(0, 4), csp: csp.slice(0, 3) },
)

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
