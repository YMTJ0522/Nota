/**
 * 1.4.0 验证：侧栏导航 / AI 聊天页 / 设置行式重排 / 媒体渲染 / 代码块与行号。
 *
 * 跑在 headless Edge 上，注入假 IPC + 真实测试笔记：
 *  1. 侧边栏分两组：笔记视图 4 项带计数，库与 AI 单独一组
 *  2. 导航选中态真的跟着点走
 *  3. 点「AI 编写」进的是主区的聊天页，不是侧边小面板
 *  4. 发一条消息，助手回答被渲染成 Markdown（代码块走同一套外壳）
 *  5. 设置五个分区齐全，AI 页四项字段+测试连接都在行上
 *  6. nota:settings 事件能把设置直接停在 AI 页
 *  7. 外观：纸张/纯色、密度真的写到了 <html> 上
 *  8. 编辑：字号、行高、栏宽、换行、行号开关都对得上
 *  9. 「恢复默认」能把当前页改回去
 * 10. 预览：带空格的图片路径（裸写 + 尖括号）都能加载，video 有源有尺寸
 * 11. 代码块：标题、语言、行号、起始行号、高亮行
 * 12. 行号 gutter 不透明（不然后面的文字会透上去）
 * 14. 附件库与回收站各自独立成组
 * 15. AI 会话管理：新建 / 自动起名 / 左右分明 / 落盘
 * 16. 编辑区右键菜单：分组齐、不越界、Esc 可关
 * 13. 全程零 JS 异常
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { purgeStale, removeProfile } from './tmp-profiles.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')

/* ── 测试笔记 ──
   图片和视频刻意用中文名 + 空格，复现 marked 把路径 encodeURI 之后裂图的情况。 */
const PIC = 'attachments/【哲风壁纸】励志标语-彩色字体 2.jpg'
const VID = 'attachments/【哲风壁纸】人物剪影-开阔-旷野 1.mp4'
// 同一张图改用尖括号写法，两条路都得通
const PIC2 = 'attachments/【哲风壁纸】人物剪影-开阔-旷野 1.jpg'
// 用户笔记里的原样写法：alt 里套了一对方括号，路径带空格
const PIC3 = 'attachments/【哲风壁纸】佩剑-侠客-剪影 3.jpg'
// 文件名里带 `#`：encodeURI 不管它，会被浏览器当片段切掉
const PIC4 = 'attachments/拍摄#1.jpg'

const NOTE = [
  '# 媒体与代码块',
  '',
  `![励志标语](${PIC})`,
  '',
  `![尖括号写法](<${PIC2}>)`,
  '',
  `![[【哲风壁纸】佩剑-侠客-剪影-剪影]](${PIC3})`,
  '',
  `![井号文件名](${PIC4})`,
  '',
  '文内锚点 [去结尾](#结尾) 不该被当成文件路径。',
  '',
  `<video src="${VID}" controls></video>`,
  '',
  '## 代码块',
  '',
  '```ts title="demo.ts" line-numbers start=1 {2}',
  'const answer = 42',
  'export function hello(name: string) {',
  '  return `${name}: ${answer}`',
  '}',
  '```',
  '',
  '```python title="不带行号"',
  'for i in range(3):',
  '    print(i)',
  '```',
  '',
  '```text line-numbers start=10 {11}',
  '第一行（文件第 10 行）',
  '第二行（文件第 11 行，要高亮）',
  '```',
  '',
  '普通段落收尾。',
  '',
].join('\n')

/* 一张能真加载出来的图：128x128 的 SVG 转 data URI */
const PIC_DATA =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">' +
      '<rect width="160" height="160" fill="%234f7d5b"/>' +
      '<circle cx="80" cy="80" r="42" fill="%23f3efe6"/></svg>',
  )

const PORT = 4311
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROFILE = path.join(root, `.tmp-cdp-round5-${Date.now()}`)
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
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(2500)

const out = {}
const ok = (name, cond, detail) => {
  out[name] = { pass: !!cond, detail }
  console.log((cond ? '  PASS  ' : '  FAIL  '), name, detail !== undefined ? JSON.stringify(detail) : '')
}

/* ── 注入假 IPC ──
   resolveMedia 故意做得挑剔：只认 decode 之后能对上真实文件名的请求。
   这样如果前端把 encodeURI 过的路径原样传过来而没人解码，图片就拿不到。 */
const TREE = [
  {
    type: 'dir', name: '笔记', path: '/ws/笔记',
    children: [
      { type: 'file', name: '媒体与代码块.md', path: '/ws/媒体与代码块.md', tags: ['测试'], starred: true, mtime: Date.now() - 3600_000 },
      { type: 'file', name: '随笔.md', path: '/ws/随笔.md', tags: [], starred: false, mtime: Date.now() - 86400_000 * 20 },
    ],
  },
]

await evaluate('(() => {' +
  ` window.__notes = { "/ws/媒体与代码块.md": ${JSON.stringify(NOTE)}, "/ws/随笔.md": "# 随笔\\n\\n随手记两句。\\n" };` +
  ` window.__pic = ${JSON.stringify(PIC)};` +
  ` window.__pic2 = ${JSON.stringify(PIC2)};` +
  ` window.__pic3 = ${JSON.stringify(PIC3)};` +
  ` window.__pic4 = ${JSON.stringify(PIC4)};` +
  " window.__asks = [];" +
  ` window.__picData = ${JSON.stringify(PIC_DATA)};` +
  ' window.api = {' +
  '  pickWorkspace: async () => "/ws",' +
  `  readTree: async () => (${JSON.stringify(TREE)}),` +
  '  readNote: async (p) => window.__notes[p] ?? "",' +
  '  writeNote: async (p, t) => { window.__notes[p] = t; return true },' +
  '  createNote: async (d, n) => d + "/" + n + ".md",' +
  '  createFolder: async (d, n) => d + "/" + n,' +
  '  deleteNote: async () => true, renameNote: async (p) => p,' +
  '  pickImage: async () => ({ rel: window.__pic, alt: "图", copied: true, isVideo: false }),' +
  '  resolveMedia: async (b, r) => {' +
  '    const dec = /%[0-9a-fA-F]{2}/.test(r) ? decodeURIComponent(r) : r;' +
  '    window.__asks.push(dec);' +
  '    if ([window.__pic, window.__pic2, window.__pic3, window.__pic4].includes(dec)) return window.__picData;' +
  '    return "nota-media://local/" + encodeURIComponent(dec);' +
  '  },' +
  '  attachList: async () => ([{ rel: window.__pic, name: "励志标语.jpg", size: 2048, mtime: Date.now(), isVideo: false }]),' +
  '  attachDelete: async () => true,' +
  '  trashList: async () => ([{ key: "aGV5", rel: "笔记/旧稿.md", name: "旧稿.md", deletedAt: Date.now() - 3600_000, size: 120 }]),' +
  '  trashRestore: async () => "/ws/笔记/旧稿.md", trashPurge: async () => true, trashEmpty: async () => true,' +
  `  aiChat: async () => ({ ok: true, text: ${JSON.stringify(
    '好的，这是一段带代码的回答：\n\n```ts title="answer.ts" line-numbers\nconst x: number = 1\nconsole.log(x)\n```\n\n以及一句普通的话。',
  )} }),` +
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
await evaluate("(() => { const rows=[...document.querySelectorAll('.tree .row.file')]; const t=rows.find(r=>r.textContent.includes('媒体与代码块')); t?.click(); return !!t })()")
await sleep(1800)

const clickMode = async (title) => {
  await evaluate(`(() => { const b = [...document.querySelectorAll('.ph-seg-btn')].find(x => (x.getAttribute('title')||'').includes(${JSON.stringify(title)})); if (b) b.click(); return !!b })()`)
  await sleep(800)
}

/* ── 1. 侧边栏分组导航 ──
   笔记视图一组，之后每件不同性质的事（附件库 / 回收站 / AI 编写）
   各自独立成组，不再挤在一栏里。 */
const nav = await evaluate(`(() => {
  const groups = [...document.querySelectorAll('.panel .nav')]
  const first = groups[0]
  const rest = groups.slice(1)
  return {
    groups: groups.length,
    views: [...(first?.querySelectorAll('.nav-item') ?? [])].map(b => {
      const lab = b.querySelector('.nav-label')?.textContent?.trim() ?? ''
      const cnt = b.querySelector('.nav-count')?.textContent?.trim() ?? '0'
      return lab + '|' + cnt
    }),
    lib: rest.map(g => [...g.querySelectorAll('.nav-item .nav-label')].map(l => l.textContent.trim()).join(',')),
    allDivider: rest.every(g => getComputedStyle(g).borderTopWidth !== '0px'),
  }
})()`)
ok(
  '1.侧栏按功能各自成组',
  nav.groups === 4 &&
    nav.views.length === 4 &&
    nav.views[0].startsWith('所有笔记|') &&
    Number(nav.views[0].split('|')[1]) > 0 &&
    nav.lib.join(' / ') === '附件库 / 回收站 / AI 编写' &&
    nav.allDivider,
  nav,
)

/* ── 2. 选中态跟着点走 ── */
const navSel = await evaluate(`(async () => {
  const pick = (label) => [...document.querySelectorAll('.panel .nav-item')].find(b => (b.querySelector('.nav-label')?.textContent ?? '').trim() === label)
  const starred = pick('收藏')
  starred?.click()
  await new Promise(r => setTimeout(r, 400))
  const on1 = [...document.querySelectorAll('.panel .nav-item.on')].map(b => b.querySelector('.nav-label')?.textContent?.trim())
  const ai = pick('AI 编写')
  ai?.click()
  await new Promise(r => setTimeout(r, 400))
  const on2 = [...document.querySelectorAll('.panel .nav-item.on')].map(b => b.querySelector('.nav-label')?.textContent?.trim())
  return { on1, on2 }
})()`)
ok(
  '2.导航选中态正确',
  navSel.on1?.length === 1 && navSel.on1[0] === '收藏' &&
    navSel.on2?.length === 1 && navSel.on2[0] === 'AI 编写',
  navSel,
)

/* ── 3. AI 编写在资料栏里（紧凑布局，不再占满主区） ──
   铺满整屏时它把要改的正文挡住了 —— 而它的用法本来就是「边看边改」。
   所以挪进中间那一列：左边聊，右边正文还看得见。 */
const chat = await evaluate(`(async () => {
  await new Promise(r => setTimeout(r, 500))
  const el = document.querySelector('.chat')
  const col = el?.closest('.col')
  return {
    exists: !!el,
    compact: el?.classList.contains('compact') ?? false,
    inColumn: col?.getAttribute('data-view') === 'ai',
    // 紧凑下标题让位给会话下拉，模型收成一个图标
    sessPicker: !!el?.querySelector('.sess-wrap .hbtn'),
    modelIconOnly: !!el?.querySelector('.model-wrap.model-icon-only'),
    railHidden: !el?.querySelector('.rail'),
    hero: !!el?.querySelector('.hero-title'),
    quick: el?.querySelectorAll('.quick-card').length ?? 0,
    hasComposer: !!el?.querySelector('.composer .input'),
    width: Math.round(el?.getBoundingClientRect().width ?? 0),
    // 正文还得在 —— 这是搬进来的全部理由
    editorAlive: !!document.querySelector('.stage'),
  }
})()`)
ok(
  '3.AI 编写在资料栏里（紧凑）且正文仍可见',
  chat.exists && chat.compact && chat.inColumn && chat.sessPicker &&
    chat.modelIconOnly && chat.railHidden &&
    chat.hero && chat.quick === 4 && chat.hasComposer &&
    chat.width > 200 && chat.width < 600 && chat.editorAlive,
  chat,
)

/* ── 4. 发消息后助手回答被渲染成 Markdown ── */
const asked = await evaluate(`(async () => {
  const box = document.querySelector('.chat .composer .input')
  if (!box) return { err: 'no composer' }
  box.focus()
  box.value = '给我一段带代码的示例'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 200))
  document.querySelector('.chat .composer .send')?.click()
  await new Promise(r => setTimeout(r, 1200))
  const rows = [...document.querySelectorAll('.chat .stream .row')]
  const assistant = rows.filter(r => r.classList.contains('assistant'))
  const bubble = assistant[assistant.length - 1]?.querySelector('.bubble.md')
  const navCount = document.querySelector('.panel .nav-item .nav-label')
  return {
    rows: rows.length,
    assistant: assistant.length,
    hasMdBody: !!bubble?.classList.contains('md-body'),
    codeBlocks: bubble?.querySelectorAll('pre.pv-code-pre').length ?? 0,
    codeShell: bubble?.querySelectorAll('.pv-code').length ?? 0,
    codeLangCls: bubble?.querySelector('pre.pv-code-pre code')?.className ?? '',
    codeLines: bubble?.querySelectorAll('.pv-line').length ?? 0,
    paras: bubble?.querySelectorAll('p').length ?? 0,
    acts: assistant[assistant.length - 1]?.querySelectorAll('.act').length ?? 0,
    _nav: !!navCount,
  }
})()`)
ok(
  '4.AI 回答渲染成 Markdown',
  asked.rows === 2 && asked.assistant === 1 && asked.hasMdBody &&
    asked.codeBlocks === 1 && asked.codeShell === 0 &&
    asked.codeLangCls === 'language-ts' && asked.codeLines === 2 && asked.paras > 0,
  asked,
)

/* ── 5~6. 设置：五分区 + AI 页行式字段 ── */
const settings = await evaluate(`(async () => {
  const close = async () => { document.querySelector('.st-x')?.click(); await new Promise(r => setTimeout(r, 250)) }
  await close()
  window.dispatchEvent(new CustomEvent('nota:settings', { detail: 'ai' }))
  await new Promise(r => setTimeout(r, 600))
  const dlg = document.querySelector('.st')
  if (!dlg) return { err: 'settings not opened' }
  const tabs = [...dlg.querySelectorAll('.st-nav-item')].map(b => b.querySelector('.st-nav-label')?.textContent?.trim())
  const title = dlg.querySelector('.st-title')?.textContent?.trim()
  const rows = [...dlg.querySelectorAll('.st-body > .st-row')]
  const names = rows.map(r => r.querySelector('.st-name')?.textContent?.trim())
  const inputCount = dlg.querySelectorAll('.st-input').length
  const hasSwitch = !!dlg.querySelector('.st-switch')
  const hasSelect = !!dlg.querySelector('.st-select')
  const testBtn = [...dlg.querySelectorAll('.st-btn')].find(b => b.textContent.includes('测试连接'))
  testBtn?.click()
  await new Promise(r => setTimeout(r, 700))
  const result = dlg.querySelector('.st-desc.is-bad')?.textContent?.trim() ?? dlg.querySelector('.st-desc.is-ok')?.textContent?.trim() ?? ''
  const foot = !!dlg.querySelector('.st-reset')
  await close()
  return { tabs, title, names, inputCount, hasSwitch, hasSelect, hasTest: !!testBtn, result, foot }
})()`)
ok(
  '5.设置五个分区且能直达 AI 页',
  settings.tabs?.join(',') === '通用,外观,编辑,AI 编写,关于' && settings.title === 'AI 编写',
  { tabs: settings.tabs, title: settings.title },
)
ok(
  '6.AI 页四件套+测试连接都在行上',
  ['启用 AI 编写', '接口地址', 'API Key', '模型名称', '测试连接'].every((n) => settings.names?.includes(n)) &&
    settings.inputCount === 3 && settings.hasSwitch && settings.hasSelect &&
    (settings.result ?? '').includes('ECONNREFUSED') && settings.foot,
  settings,
)

/* ── 5b. 每个分区的 id 都能从外部直达（侧栏那份白名单当初漏了 appearance） ── */
const jump = await evaluate(`(async () => {
  const want = [['general','通用'],['appearance','外观'],['editor','编辑'],['ai','AI 编写'],['about','关于']]
  const seen = []
  for (const [id, label] of want) {
    document.querySelector('.st-x')?.click()
    await new Promise(r => setTimeout(r, 250))
    window.dispatchEvent(new CustomEvent('nota:settings', { detail: id }))
    await new Promise(r => setTimeout(r, 450))
    const t = document.querySelector('.st .st-title')?.textContent?.trim() ?? ''
    if (t !== label) seen.push(id + ' 期望 ' + label + ' 实际 ' + t)
    else seen.push(id + ' ok')
  }
  document.querySelector('.st-x')?.click()
  await new Promise(r => setTimeout(r, 250))
  return seen
})()`)
ok(
  '5b.五个分区的 id 都能从外部直达',
  (jump ?? []).length === 5 && jump.every((s) => s.endsWith('ok')),
  jump,
)

/* ── 7. 外观：纸张/纯色 + 密度真的落到 <html> ── */
const look = await evaluate(`(async () => {
  document.querySelector('.panel .foot .foot-btn[data-tip="设置"]')?.click()
  await new Promise(r => setTimeout(r, 400))
  const tab = [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent.includes('外观'))
  tab?.click()
  await new Promise(r => setTimeout(r, 350))
  const before = document.documentElement.getAttribute('data-bg')
  const seg = [...document.querySelectorAll('.st-seg-btn')].find(b => b.textContent.trim() === '纯色')
  seg?.click()
  await new Promise(r => setTimeout(r, 350))
  const plain = document.documentElement.getAttribute('data-bg')
  const compact = [...document.querySelectorAll('.st-seg-btn')].find(b => b.textContent.trim() === '紧凑')
  compact?.click()
  await new Promise(r => setTimeout(r, 350))
  const dens = document.documentElement.getAttribute('data-density')
  // 色点必须是正圆。浏览器默认给 button 留了 1px 6px 的内边距，
  // 不清掉的话 24px 的圆圈只剩 10px 放内容，色点会被压成 10x15 的椭圆
  const dots = [...document.querySelectorAll('.st-swatch-dot')].map(d => {
    const r = d.getBoundingClientRect()
    return Math.round(r.width) + 'x' + Math.round(r.height)
  })
  const ringR = document.querySelector('.st-swatch')?.getBoundingClientRect()
  const ring = ringR ? Math.round(ringR.width) + 'x' + Math.round(ringR.height) : ''
  // 选中圈的描边颜色应当就是这一格自己的颜色（而不是黑白）
  const swatches = [...document.querySelectorAll('.st-swatch')]
  const on = swatches.find(b => b.classList.contains('on'))
  const ringColor = on ? getComputedStyle(on).borderTopColor : ''
  const dotColor = on ? getComputedStyle(on.querySelector('.st-swatch-dot')).backgroundColor : ''
  const offRing = swatches.find(b => !b.classList.contains('on'))
  const offRingColor = offRing ? getComputedStyle(offRing).borderTopColor : ''
  return {
    before, plain, dens, dots, ring,
    labels: swatches.map(b => b.getAttribute('title')),
    ringColor, dotColor, offRingColor,
  }
})()`)
ok(
  '7.外观项写进了 <html>',
  look.before === 'paper' && look.plain === 'plain' && look.dens === 'compact',
  { before: look.before, plain: look.plain, dens: look.dens },
)
ok(
  '7b.七个强调色圆点都是正圆',
  look.dots.length === 7 && look.dots.every(d => d.split('x')[0] === d.split('x')[1]) &&
    look.ring === '24x24' && look.labels.includes('石墨'),
  { dots: look.dots, ring: look.ring, labels: look.labels },
)
ok(
  '7c.选中圈的描边跟着色点颜色走',
  look.ringColor === look.dotColor && look.ringColor !== look.offRingColor,
  { ringColor: look.ringColor, dotColor: look.dotColor, offRing: look.offRingColor },
)

/* ── 8. 编辑：字号/行高/栏宽/换行/行号 ── */
const edit = await evaluate(`(async () => {
  const tab = [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent.includes('编辑'))
  tab?.click()
  await new Promise(r => setTimeout(r, 350))
  const fs0 = getComputedStyle(document.documentElement).getPropertyValue('--n-fs-body').trim()
  const range = document.querySelector('.st-range')
  range.value = '19'
  range.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 300))
  const fs1 = getComputedStyle(document.documentElement).getPropertyValue('--n-fs-body').trim()
  const wide = [...document.querySelectorAll('.st-seg-btn')].find(b => b.textContent.trim() === '宽')
  wide?.click()
  await new Promise(r => setTimeout(r, 300))
  const measure = getComputedStyle(document.documentElement).getPropertyValue('--n-measure').trim()
  return { fs0, fs1, measure }
})()`)
ok(
  '8.编辑项即时生效',
  edit.fs0 !== edit.fs1 && edit.fs1 === '19px' && edit.measure === '880px',
  edit,
)

/* ── 9. 恢复默认 ── */
const reset = await evaluate(`(async () => {
  document.querySelector('.st-reset')?.click()
  await new Promise(r => setTimeout(r, 400))
  const fs = getComputedStyle(document.documentElement).getPropertyValue('--n-fs-body').trim()
  const measure = getComputedStyle(document.documentElement).getPropertyValue('--n-measure').trim()
  document.querySelector('.st-x')?.click()
  await new Promise(r => setTimeout(r, 250))
  return { fs, measure }
})()`)
ok(
  '9.恢复默认回滚当前页',
  reset.fs === '15px' && reset.measure === '720px',
  reset,
)

/* ── 10~11. 预览：媒体 + 代码块 ── */
await evaluate("(() => { const b=[...document.querySelectorAll('.panel .nav-item')].find(x=>(x.querySelector('.nav-label')?.textContent??'').trim()==='所有笔记'); b?.click(); return true })()")
await sleep(500)
await clickMode('分栏')
const media = await evaluate(`(async () => {
  const p = document.querySelector('.preview.md-body')
  if (!p) return { err: 'no preview or missing md-body' }
  const imgs = [...p.querySelectorAll('img')]
  if (!imgs.length) return { err: 'no img' }
  // 等图片解码：data URI 很快，但保险起见轮询一下
  for (let i = 0; i < 20 && imgs.some(im => !im.complete); i++) await new Promise(r => setTimeout(r, 100))
  const video = p.querySelector('video')
  // marked 解析失败时不会产出 <img>，而是把整行当普通文本吐回来，
  // 所以「源码还躺在正文里」是最直接的失败信号
  const raw = p.textContent ?? ''
  return {
    imgCount: imgs.length,
    imgSrc: (imgs[0].getAttribute('src') ?? '').slice(0, 40),
    img2Src: (imgs[1]?.getAttribute('src') ?? '').slice(0, 40),
    imgOk: imgs[0].complete && imgs[0].naturalWidth > 0,
    img2Ok: !!imgs[1] && imgs[1].complete && imgs[1].naturalWidth > 0,
    img3Src: (imgs[2]?.getAttribute('src') ?? '').slice(0, 40),
    img3Ok: !!imgs[2] && imgs[2].complete && imgs[2].naturalWidth > 0,
    img4Src: (imgs[3]?.getAttribute('src') ?? '').slice(0, 40),
    img4Ok: !!imgs[3] && imgs[3].complete && imgs[3].naturalWidth > 0,
    asks: (window.__asks ?? []).filter(a => a.includes('拍摄')),
    anchor: p.querySelector('a[href^="#"]')?.getAttribute('href') ?? '',
    imgW: imgs[0].naturalWidth,
    imgBox: Math.round(imgs[0].getBoundingClientRect().width),
    leftover: raw.includes('![') || raw.includes(']('),
    videoSrc: (video?.getAttribute('src') ?? '').slice(0, 46),
    videoControls: video?.hasAttribute('controls') ?? false,
    videoW: Math.round(video?.getBoundingClientRect().width ?? 0),
    paneW: Math.round(p.clientWidth),
  }
})()`)
ok(
  '10.空格 / 尖括号 / # 的图片路径都能渲染',
  media.imgCount === 4 && media.imgOk && media.img2Ok && media.img3Ok && media.img4Ok &&
    media.imgSrc.startsWith('data:image/svg') && media.img2Src.startsWith('data:image/svg') &&
    media.img3Src.startsWith('data:image/svg') && media.img4Src.startsWith('data:image/svg') &&
    media.asks.some(a => a.includes('#')) && media.anchor.startsWith('#') &&
    !media.leftover &&
    (media.videoSrc ?? '').includes('nota-media://local/') &&
    media.videoControls && media.imgBox > 0 &&
    // 视频要铺满一栏，不能被默认的 300×150 卡住
    media.videoW > media.paneW * 0.8,
  media,
)

const code = await evaluate(`(() => {
  const pres = [...document.querySelectorAll('.preview pre.pv-code-pre')]
  const cs = pres[0] ? getComputedStyle(pres[0]) : null
  return {
    count: pres.length,
    radius: cs?.borderRadius ?? '',
    border: cs?.borderTopWidth ?? '',
    bg: cs?.backgroundColor ?? '',
    // 外壳、标题、语言标签、行号、复制按钮统统不该再出现
    shells: document.querySelectorAll('.preview .pv-code').length,
    titles: document.querySelectorAll('.preview .pv-code-title').length,
    langs: document.querySelectorAll('.preview .pv-code-lang').length,
    numbered: document.querySelectorAll('.preview .pv-line[data-line]').length,
    copies: document.querySelectorAll('.preview [data-copy]').length,
    // 围栏后面那串元信息不再被解析成外壳，但仍要留在 code 的语言类上
    langClasses: pres.map(p => p.querySelector('code')?.className ?? ''),
    // 元信息本身不该漏进可见文字里
    leaked: pres.some(p => /title=|line-numbers|start=/.test(p.textContent ?? '')),
    lines: pres.map(p => p.querySelectorAll('.pv-line').length),
    tokenColors: new Set([...document.querySelectorAll('.preview pre span[class]')]
      .map(el => getComputedStyle(el).color)).size,
  }
})()`)
ok(
  '11.代码块只剩一层薄框，元信息不再画外壳',
  code.count === 3 && code.radius === '10px' && parseFloat(code.border) >= 1 &&
    code.shells === 0 && code.titles === 0 && code.langs === 0 &&
    code.numbered === 0 && code.copies === 0 &&
    code.langClasses.every(c => /language-(ts|python|text)/.test(c)) &&
    !code.leaked && code.tokenColors >= 2 &&
    JSON.stringify(code.lines) === JSON.stringify([4, 2, 2]),
  code,
)

/* ── 12. 行号 gutter 不透明 ── */
await clickMode('编辑模式')
const gutter = await evaluate(`(async () => {
  await new Promise(r => setTimeout(r, 500))
  const g = document.querySelector('.cm-gutters')
  const nums = document.querySelector('.cm-lineNumbers')
  const line = document.querySelector('.cm-content .cm-line')
  if (!g || !nums) return { err: 'no gutter', gutters: !!g, numbers: !!nums }
  const gs = getComputedStyle(g)
  const gr = g.getBoundingClientRect()
  const lr = line?.getBoundingClientRect()
  return {
    bg: gs.backgroundColor,
    alpha: gs.backgroundColor.startsWith('rgba') ? gs.backgroundColor.split(',')[3] : 'solid',
    gutterRight: Math.round(gr.right),
    lineLeft: Math.round(lr?.left ?? -1),
    numbers: nums.querySelectorAll('.cm-gutterElement').length,
    wrap: getComputedStyle(document.querySelector('.cm-content')).whiteSpace,
    overlap: lr ? lr.left + 1 < gr.right : true,
  }
})()`)
ok(
  '12.行号与文字不重叠',
  gutter.numbers > 0 && gutter.alpha === 'solid' &&
    gutter.lineLeft >= gutter.gutterRight && !gutter.overlap,
  gutter,
)

/* ── 14. 侧栏：附件库与回收站各自独立成组 ── */
const groups = await evaluate(`(() => {
  const navs = [...document.querySelectorAll('.panel .nav')]
  return {
    groups: navs.map(n => [...n.querySelectorAll('.nav-item .nav-label')].map(l => l.textContent.trim())),
    rail: [...document.querySelectorAll('.rail .rail-btn')].map(b => b.getAttribute('data-tip')),
  }
})()`)
ok(
  '14.附件库与回收站各自独立成组',
  (() => {
    const g = groups.groups ?? []
    const withAttach = g.filter((it) => it.includes('附件库'))
    const withTrash = g.filter((it) => it.includes('回收站'))
    // 两者各自独占一组，绝不共处一栏
    return withAttach.length === 1 && withAttach[0].length === 1 &&
      withTrash.length === 1 && withTrash[0].length === 1
  })(),
  groups.groups,
)

/* ── 15. AI 会话管理：新建 / 自动起名 / 切换 / 落盘 ──
   紧凑布局没有常驻侧轨了，会话收进头部那个下拉里：
   点标题出菜单，菜单顶栏的 + 就是新建。功能一样，只是换了个地方。 */
const sess = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const nav = [...document.querySelectorAll('.panel .nav-item')]
    .find(x => (x.querySelector('.nav-label')?.textContent ?? '').trim() === 'AI 编写')
  nav?.click()
  await wait(500)

  const openMenu = async () => {
    document.querySelector('.chat .sess-wrap .hbtn')?.click()
    await wait(320)
    return document.querySelector('.chat .sess-menu')
  }
  const names = () => [...document.querySelectorAll('.chat .sess-menu .n-menu-name')]
    .map(e => e.textContent.trim())

  const menu = await openMenu()
  const menuIsDropdown = menu?.classList.contains('n-menu') ?? false
  const before = menu?.querySelectorAll('.n-menu-item').length ?? 0

  // 新建：菜单顶栏那个 +
  menu?.querySelector('.sess-mini')?.click()
  await wait(450)
  const titleAfterNew = document.querySelector('.chat .sess-wrap .hbtn-name')?.textContent?.trim() ?? ''
  const emptyRows = document.querySelectorAll('.chat .stream .row').length

  await openMenu()
  const after = names().length
  const activeFirst = document.querySelector('.chat .sess-menu .n-menu-item')?.classList.contains('on') ?? false
  document.body.click()
  await wait(200)

  // 发一条，会话标题应自动变成那句提问
  const box = document.querySelector('.chat .composer .input')
  box.focus(); box.value = '这是一句用来当标题的提问'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  document.querySelector('.chat .composer .send')?.click()
  await wait(1300)
  const titleAfterAsk = document.querySelector('.chat .sess-wrap .hbtn-name')?.textContent?.trim() ?? ''

  // 我的消息靠右、AI 靠左
  const userRow = document.querySelector('.chat .stream .row.user')
  const aiRow = document.querySelector('.chat .stream .row.assistant')
  const dir = { user: userRow ? getComputedStyle(userRow).flexDirection : '', ai: aiRow ? getComputedStyle(aiRow).flexDirection : '' }

  // 切回最早那条，消息要跟着换
  const m2 = await openMenu()
  const list = [...(m2?.querySelectorAll('.n-menu-item') ?? [])]
  list[list.length - 1]?.click()
  await wait(700)
  const rowsAfterSwitch = document.querySelectorAll('.chat .stream .row').length

  let saved = {}
  try { saved = JSON.parse(localStorage.getItem('nota-chat-sessions') || '{}') } catch {}
  return {
    menuIsDropdown, before, after, activeFirst, titleAfterNew, emptyRows,
    titleAfterAsk, dir, rowsAfterSwitch,
    savedCount: (saved.sessions || []).length,
    savedActive: saved.active,
    savedMsgs: (saved.sessions || []).reduce((n, s) => n + (s.messages || []).length, 0),
  }
})()`)
ok(
  '15.会话管理：头部下拉里新建 / 自动起名 / 左右分明 / 落盘',
  sess.menuIsDropdown && sess.after === sess.before + 1 && sess.activeFirst &&
    sess.titleAfterNew === '新对话' && sess.emptyRows === 0 &&
    sess.titleAfterAsk.includes('这是一句用来当标题的提问') &&
    sess.dir.user === 'row-reverse' && sess.dir.ai === 'row' &&
    sess.rowsAfterSwitch > 0 &&
    sess.savedCount >= 2 && sess.savedActive > 0 && sess.savedMsgs >= 2,
  sess,
)

/* ── 16. 编辑区右键菜单 ── */
const menu = await evaluate(`(async () => {
  const nav = [...document.querySelectorAll('.panel .nav-item')]
    .find(x => (x.querySelector('.nav-label')?.textContent ?? '').trim() === '所有笔记')
  nav?.click()
  await new Promise(r => setTimeout(r, 500))
  const v = window.__notaView
  if (!v) return { err: 'no view' }
  v.dispatch({ selection: { anchor: 0, head: 24 } })
  await new Promise(r => setTimeout(r, 200))
  const el = document.querySelector('.cm-content')
  if (!el) return { err: 'no cm-content' }
  const r = el.getBoundingClientRect()
  el.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true,
    clientX: Math.round(r.left + 120), clientY: Math.round(r.top + 70),
  }))
  await new Promise(r2 => setTimeout(r2, 400))
  const box = document.querySelector('.ctx-menu')
  if (!box) return { err: 'no menu' }
  const items = [...box.querySelectorAll('.ctx-item')]
  const labels = items.map(b => (b.querySelector('.ctx-label')?.textContent ?? '').trim())
  const off = items.filter(b => b.classList.contains('off')).map(b => (b.querySelector('.ctx-label')?.textContent ?? '').trim())
  const rect = box.getBoundingClientRect()
  const inside = rect.left >= 0 && rect.top >= 0 &&
    rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1
  const seps = box.querySelectorAll('.ctx-sep').length
  // Esc 应当关掉菜单
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await new Promise(r2 => setTimeout(r2, 300))
  const closedByEsc = !document.querySelector('.ctx-menu')
  return { labels, off, inside, seps, closedByEsc }
})()`)
ok(
  '16.右键菜单：分组齐、越界回弹、Esc 可关',
  menu.labels && menu.labels.length === 10 && menu.seps === 3 &&
    ['撤销', '重做', '剪切', '复制', '粘贴', '扩写这段', '润色这段', '总结这段', '翻译这段', '全选']
      .every((l) => menu.labels.includes(l)) &&
    // 有选区时剪切 / 复制 / AI 组都该是可点的
    !menu.off.includes('剪切') && !menu.off.includes('复制') && !menu.off.includes('润色这段') &&
    menu.inside && menu.closedByEsc,
  menu,
)

/* ── 13. 零异常 ── */
ok(
  '13.零 JS 异常',
  errors.length === 0,
  { errors: errors.slice(0, 5) },
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
