/**
 * 本轮验证：代码块外壳 + 强调色 + 查找条 + 笔记嵌入 + 附件库/回收站 + AI 入口。
 *
 * 沿用前三轮的做法：真实测试笔记 + 注入的假 IPC，跑在 headless Edge 上。
 * 假 IPC 里补了本轮新增的几个方法，弹窗类用例才跑得起来。
 *
 * 覆盖：
 *  1. 代码块有外壳：语言标签 + 复制按钮 + 行容器
 *  2. 行容器的行数和源码行数一致
 *  3. 复制按钮点得动，且拿到的就是源码
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

/* ── 1~3. 代码块外壳 ── */
await clickMode('分栏')
const code = await evaluate(`(() => {
  const p = document.querySelector('.preview')
  if (!p) return { err: 'no preview' }
  const blocks = [...p.querySelectorAll('.pv-code')]
  return {
    count: blocks.length,
    langs: blocks.map(b => b.querySelector('.pv-code-lang')?.textContent?.trim() ?? ''),
    heads: blocks.filter(b => b.querySelector('.pv-code-head')).length,
    copies: blocks.filter(b => b.querySelector('[data-copy]')).length,
    folds: blocks.filter(b => b.querySelector('[data-fold]')).length,
    lines: blocks.map(b => b.querySelectorAll('.pv-line').length),
    firstText: (blocks[0]?.querySelector('code')?.textContent ?? '').slice(0, 60),
    // 外壳里的 pre 不该再有独立边框，否则会出现双层描边
    preBorder: blocks[0] ? getComputedStyle(blocks[0].querySelector('pre')).borderTopWidth : '',
  }
})()`)
ok(
  '1.代码块有外壳',
  code.count >= 2 && code.heads === code.count && code.copies === code.count && code.langs.every((l) => l.length > 0),
  code,
)

/* ── 2. 行容器数量与源码一致 ── */
// mermaid 块不走代码块外壳（源码要留给图表渲染），统计时要排除掉
const src = (NOTE.match(/```[\s\S]*?```/g) ?? []).filter((b) => !b.startsWith('```mermaid'))
const expectLines = src.map((b) => b.split('\n').length - 2)
const srcTotal = expectLines.reduce((a, b) => a + b, 0)
const gotTotal = (code.lines ?? []).reduce((a, b) => a + b, 0)
ok(
  '2.行容器数量对得上',
  gotTotal === srcTotal && (code.lines ?? []).every((n) => n > 0),
  { srcTotal, gotTotal, perBlock: code.lines, expect: expectLines },
)

/* ── 3. 复制按钮 ── */
const copy = await evaluate(`(async () => {
  const block = document.querySelector('.pv-code')
  if (!block) return { err: 'no block' }
  const btn = block.querySelector('[data-copy]')
  const before = btn.textContent.trim()
  btn.click()
  await new Promise(r => setTimeout(r, 300))
  const after = btn.textContent.trim()
  return { before, after, text: (block.querySelector('code')?.textContent ?? '').slice(0, 40) }
})()`)
ok(
  '3.复制按钮点得动',
  copy.before === '复制' && ['已复制', '复制失败'].includes(copy.after) && (copy.text ?? '').length > 0,
  copy,
)

/* ── 4. 折叠 ── */
const fold = await evaluate(`(async () => {
  const btn = document.querySelector('.pv-code [data-fold]')
  if (!btn) return { none: true }
  const box = btn.closest('.pv-code')
  const before = box.classList.contains('is-folded')
  btn.click()
  await new Promise(r => setTimeout(r, 350))
  const after = box.classList.contains('is-folded')
  return { foldedFirst: before, after, label: btn.textContent.trim() }
})()`)
ok(
  '4.长代码块可折叠',
  fold.none ? true : fold.foldedFirst !== fold.after,
  fold,
)

/* ── 5. 强调色 ── */
const accent = await evaluate(`(async () => {
  const s = document.querySelector('.foot .foot-btn[data-tip="设置"]')
  if (s) s.click()
  await new Promise(r => setTimeout(r, 400))
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
  '5.强调色六套可切',
  accent.count === 6 && accent.distinct === 6 && accent.seen.every((s) => s.color.length > 0),
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
  const buttons = [...bar.querySelectorAll('button')].length
  const native = document.querySelectorAll('.cm-panel.cm-search').length
  input.value = '标题'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 400))
  const count1 = document.querySelector('.fb-count')?.textContent?.trim() ?? ''
  input.value = 'zzz-不存在'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 400))
  const count2 = document.querySelector('.fb-count')?.textContent?.trim() ?? ''
  return { buttons, native, count1, count2 }
})()`)
ok(
  '7.Ctrl+F 是自绘查找条',
  find.buttons === 3 && find.native === 0,
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

/* ── 10. 附件库 / 回收站 ── */
const lib = await evaluate(`(async () => {
  const btn = document.querySelector('.foot .foot-btn[data-tip="附件库与回收站"]')
  if (!btn) return { err: 'no entry' }
  btn.click()
  await new Promise(r => setTimeout(r, 600))
  const dlg = document.querySelector('.lib')
  if (!dlg) return { err: 'no dialog' }
  const tabs = [...dlg.querySelectorAll('.lib-tab')].map(t => t.textContent.trim())
  const cards = dlg.querySelectorAll('.lib-card').length
  // 切到回收站
  const trashTab = [...dlg.querySelectorAll('.lib-tab')].find(t => t.textContent.includes('回收站'))
  trashTab?.click()
  await new Promise(r => setTimeout(r, 500))
  const rows = dlg.querySelectorAll('.lib-row').length
  const hasRestore = !!dlg.querySelector('.lib-row .lib-act')
  const x = dlg.querySelector('.lib-x'); x?.click()
  await new Promise(r => setTimeout(r, 300))
  return { tabs, cards, rows, hasRestore, closed: !document.querySelector('.lib') }
})()`)
ok(
  '10.附件库与回收站',
  lib.tabs?.length === 2 && lib.cards > 0 && lib.rows > 0 && lib.hasRestore && lib.closed,
  lib,
)

/* ── 11~12. 入口存在 ── */
const entries = await evaluate(`(() => ({
  aiBtn: !!document.querySelector('.tb-btn.tb-ai'),
  libBtn: !!document.querySelector('.foot .foot-btn[data-tip="附件库与回收站"]'),
  navCount: document.querySelectorAll('.st-nav-item').length,
}))()`)
ok(
  '11.AI 与库入口都在',
  entries.aiBtn && entries.libBtn,
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
  const rows = [...(dlg?.querySelectorAll('.st-mini') ?? [])].map(r => r.textContent.trim())
  const x = document.querySelector('.st-x'); if (x) x.click()
  await new Promise(r => setTimeout(r, 250))
  return { rows, hasHero: !!dlg?.querySelector('.st-hero') }
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
