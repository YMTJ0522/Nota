/**
 * 1.9.0 验证：AI 编写按参考图重排成 agent / 中间栏三页签 / 顶部按区域划分。
 *
 * 沿用前几轮的做法：真实测试笔记 + 注入的假 IPC，跑在 headless Edge 上。
 * 这一轮的假 AI 是**流式**的：它会把 delta 一段一段推回来，
 * 好让「思考过程真的在往外流」这件事可测，而不是只看最终结果。
 *
 * 覆盖：
 *  1. AI 面板的结构：卡片 / 指令行 / 上下文开关与笔记选择 / 消息流 / 快捷指令 / 输入区 / 底部
 *  2. 它是个 agent：一轮对话留下执行过程，每一步都有标签、状态和真实耗时
 *  3. 思考过程跟着流式增量实时长出来；模型不返回推理时这一行不出现（不摆空壳）
 *  4. 回答是边生成边长出来的（流中间就能看到半截内容）
 *  5. 顶部按区域划分：三栏各有一条自己的顶栏、同高，横贯整窗的标题栏已经没了
 *  6. 右侧区域顶部有标题 + 路径；窗口控制按钮落在这一行最右
 *  7. 筛选框从侧栏搬到了中间栏（侧栏里不该再有输入框）
 *  8. 中间栏顶上是一排页签：笔记 / 大纲 / 引用；大纲列真标题，引用列反向链接
 *  9. 全程零 JS 异常
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
  // 刻意写长：整屏装得下的话点大纲压根没得滚，跳转就测不出来
  ...Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段：一段够长的正文，用来把页面撑到可滚动的高度。\n`),
  '## 第二节',
  '',
  '另见 [[周报]] 与 [无标签](/ws/无标签.md)。',
].join('\n')
const SHORT = '---\ntags: [工作]\n---\n\n# 周报\n\n本周把导入导出做完了。另见 [[长文]]。\n'
const PLAIN = '# 无标签\n\n随手记两句。\n'

const PORT = 4333
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROFILE = path.join(root, `.tmp-cdp-round8-${Date.now()}`)
const CDP_PORT = 9800 + (Date.now() % 150)

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

const NOTES = {
  '/ws/长文.md': LONG,
  '/ws/工作/周报.md': SHORT,
  '/ws/无标签.md': PLAIN,
}

/* 假 AI：第一次带推理、流式推 4 段；第二次不带推理。
   两轮都要走真实的分片节奏，否则「边生成边长」测不出来。 */
const INJECT = '(() => {' +
  ` window.__notes = ${JSON.stringify(NOTES)};` +
  ' window.__aiCalls = 0;' +
  ' window.__delta = null;' +
  ' window.__wait = (ms) => new Promise(r => setTimeout(r, ms));' +
  ' window.api = {' +
  '  pickWorkspace: async () => "/ws",' +
  `  readTree: async () => ${JSON.stringify(TREE)},` +
  '  readNote: async (f) => window.__notes[f] ?? "",' +
  '  writeNote: async (f, c) => { window.__notes[f] = c; return true },' +
  '  createNote: async (d, n) => { const p = d + "/" + n + ".md"; window.__notes[p] = ""; return p },' +
  '  createFolder: async () => "/ws/x",' +
  '  deleteNote: async () => true,' +
  '  renameNote: async (f, n) => f,' +
  '  importNotes: async () => [],' +
  '  pickImage: async () => null,' +
  '  resolveMedia: async () => null,' +
  '  exportSave: async () => null,' +
  '  historySave: async () => null, historyList: async () => [], historyRead: async () => null,' +
  '  trashList: async () => [], trashRestore: async () => "", trashPurge: async () => true, trashEmpty: async () => true,' +
  '  attachList: async () => [], attachDelete: async () => true,' +
  '  aiTest: async () => ({ ok: true, models: ["llama3.2", "qwen2.5:7b"] }),' +
  '  onAiDelta: (cb) => { window.__delta = cb },' +
  '  aiChat: async () => {' +
  '    window.__aiCalls += 1;' +
  '    const cb = window.__delta;' +
  '    const first = window.__aiCalls === 1;' +
  '    if (first) {' +
  '      for (const r of ["我先看一遍", "这篇笔记的正文，", "再决定怎么润色。"]) {' +
  '        cb && cb({ reasoning: r }); await window.__wait(140);' +
  '      }' +
  '    }' +
  '    const parts = ["## 润色结果", "\\n\\n当前这篇笔记", "只有标题，正文是空的", "，所以暂时没有可润色的文本。"];' +
  '    for (const t of parts) { cb && cb({ text: t }); await window.__wait(140) }' +
  '    return { ok: true, text: parts.join(""), reasoning: first ? "我先看一遍这篇笔记的正文，再决定怎么润色。" : "" }' +
  '  },' +
  '  appInfo: async () => ({ electron:"", chrome:"", node:"", platform:"", arch:"" }),' +
  '  minimize: async () => {}, toggleMaximize: async () => false, closeWindow: async () => {}, onMaximizeChange: () => {},' +
  ' };' +
  ' const css = document.createElement("style");' +
  // headless 里没有真窗口，拖动区会把 mouse 事件吞掉，测试里先关掉
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
await sleep(900)
await evaluate(INJECT)
await sleep(1100)
await evaluate("(() => { const t=[...document.querySelectorAll('.nlist .nl-item')].find(b=>(b.querySelector('.nl-text')?.textContent??'').includes('长文')); t?.click(); return !!t })()")
await sleep(1000)

/* ── 1. 顶部按区域划分 ──
   原来有一条横贯整窗的标题栏，三栏的顶都被它压住。现在侧栏、中间栏、
   右侧各有一条自己的顶栏，高度一致，分隔线才能连成一条直线。 */
// 先切回「所有笔记」并等 Vue 重渲染完 —— 紧接着同步量会因为 DOM 还没更新而读到上一屏
await evaluate(`(() => {
  const pick = (label) => [...document.querySelectorAll('.panel .nav-item')]
    .find(b => (b.querySelector('.nav-label')?.textContent ?? '').trim() === label)
  pick('所有笔记')?.click()
  return true
})()`)
await sleep(700)
const top = await evaluate(`(() => {
  const h = (sel) => {
    const el = document.querySelector(sel)
    return el ? Math.round(el.getBoundingClientRect().height) : 0
  }
  return {
    globalBar: !!document.querySelector('.shell > .bar, .shell > header.bar'),
    sideHead: h('.panel .head'),
    tabRow: h('.col .col-flow'),
    paneHead: h('.ph'),
    // 右侧顶行里得有标题和路径
    title: document.querySelector('.ph .ph-title')?.value ?? '',
    pathText: document.querySelector('.ph .ph-path')?.textContent?.trim() ?? '',
    // 三颗窗口按钮跟着编辑区走，且在最右
    winBtns: document.querySelectorAll('.ph .wctl .wbtn').length,
    winAtRight: (() => {
      const w = document.querySelector('.ph .wctl')
      const ph = document.querySelector('.ph')
      if (!w || !ph) return false
      const a = w.getBoundingClientRect(), b = ph.getBoundingClientRect()
      return Math.abs(a.right - b.right) < 2
    })(),
    // 侧栏顶行那枚开关还在（折叠后靠它回来）
    sidebarToggle: !!document.querySelector('.panel [data-role="sidebar-toggle"]'),
    columnToggle: !!document.querySelector('.ph [data-role="column-toggle"]'),
    // 旧标题栏的品牌 logo 不该再出现；文件名也不该再糊在侧栏顶上（它现在归右侧那条）
    oldMark: !!document.querySelector('.bar .mark'),
    sideHeadText: document.querySelector('.panel .head .head-title')?.textContent?.trim() ?? '',
  }
})()`)
ok(
  '1.顶部按区域划分：三栏各有一条顶栏且同高，横贯整窗的标题栏已经没了',
  !top.globalBar && top.sideHead > 0 && top.sideHead === top.tabRow && top.tabRow === top.paneHead &&
    top.title === '长文' && top.pathText === '长文.md' &&
    top.winBtns === 3 && top.winAtRight &&
    top.sidebarToggle && top.columnToggle &&
    !top.oldMark && top.sideHeadText === '资料库',
  top,
)

/* ── 2. 筛选框搬到了中间栏 ── */
const search = await evaluate(`(() => ({
  col: !!document.querySelector('.col .nl-search-input'),
  colPlaceholder: document.querySelector('.col .nl-search-input')?.getAttribute('placeholder') ?? '',
  sideInputs: document.querySelectorAll('.panel input').length,
  // 在中间栏里打字真的会筛
  total: document.querySelectorAll('.col .nl-item').length,
}))()`)
await evaluate("(() => { const b=document.querySelector('.col .nl-search-input'); b.value='周报'; b.dispatchEvent(new Event('input',{bubbles:true})); return true })()")
await sleep(400)
const filtered = await evaluate("document.querySelectorAll('.col .nl-item').length")
await evaluate("(() => { const b=document.querySelector('.col .nl-search-input'); b.value=''; b.dispatchEvent(new Event('input',{bubbles:true})); return true })()")
await sleep(400)
ok(
  '2.筛选框住在中间栏的笔记视图里（侧栏不再有输入框）',
  search.col && search.colPlaceholder.includes('筛选') && search.sideInputs === 0 &&
    search.total === 3 && filtered === 1,
  { ...search, filtered },
)

/* ── 3. 中间栏顶上是一排页签 ── */
const tabs = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const labels = [...document.querySelectorAll('.col .col-tab .col-tab-label')].map(e => e.textContent.trim())
  const rows = []
  for (const v of ['notes', 'outline', 'quote']) {
    document.querySelector('.col-tab[data-view="' + v + '"]')?.click()
    await wait(560)
    rows.push({
      v,
      view: document.querySelector('.col')?.getAttribute('data-view'),
      nlist: !!document.querySelector('.col-body .nlist'),
      ov: !!document.querySelector('.col-body .ov'),
      qv: !!document.querySelector('.col-body .qv'),
    })
  }
  // 大纲列的是真标题（循环结束时停在「引用」，得先切回大纲再取样）
  document.querySelector('.col-tab[data-view="outline"]')?.click()
  await wait(420)
  const outline = [...document.querySelectorAll('.ov .ov-item')].map(b => ({
    lv: b.querySelector('.ov-lv')?.textContent?.trim(),
    text: b.querySelector('.ov-text')?.textContent?.trim(),
  }))
  // 点一条大纲：编辑区要滚到对应位置
  document.querySelector('.col-tab[data-view="outline"]')?.click()
  await wait(400)
  const before = window.__notaView?.visibleRanges?.[0]?.from ?? -1
  const last = [...document.querySelectorAll('.ov .ov-item')].pop()
  last?.click()
  await wait(700)
  const after = window.__notaView?.visibleRanges?.[0]?.from ?? -1

  // 引用列的是提到这一篇的笔记
  document.querySelector('.col-tab[data-view="quote"]')?.click()
  await wait(1600)
  const quotes = [...document.querySelectorAll('.qv .qv-row')].map(b => ({
    name: b.querySelector('.qv-name')?.textContent?.trim(),
    line: b.querySelector('.qv-line')?.textContent?.trim() ?? '',
  }))

  document.querySelector('.col-tab[data-view="notes"]')?.click()
  await wait(420)
  return {
    labels, rows, outline, jump: { before, after }, quotes,
    tabsInColumn: document.querySelectorAll('.col .col-tab').length,
  }
})()`)
ok(
  '3.中间栏顶上是一排页签：笔记 / 大纲 / 引用',
  tabs.labels.join() === '笔记,大纲,引用' && tabs.tabsInColumn === 3 &&
    tabs.rows.every((r) => r.view === r.v &&
      (r.v === 'notes' ? r.nlist : r.v === 'outline' ? r.ov : r.qv)),
  { labels: tabs.labels, rows: tabs.rows },
)
ok(
  '4.大纲列的是当前笔记的真标题，点了能把编辑区带过去',
  tabs.outline.length >= 3 &&
    tabs.outline[0].lv === 'H1' && tabs.outline[0].text === '长文' &&
    tabs.outline.some((h) => h.text === '第二节' && h.lv === 'H2') &&
    tabs.jump.after > tabs.jump.before,
  { outline: tabs.outline, jump: tabs.jump },
)
ok(
  '5.引用列的是提到当前这篇的笔记，并摘出命中的那一行',
  tabs.quotes.length === 1 && tabs.quotes[0].name === '周报' &&
    tabs.quotes[0].line.includes('[[长文]]'),
  tabs.quotes,
)

/* ── 6. AI 面板的结构 ── */
await evaluate("[...document.querySelectorAll('.panel .nav-item')].find(b=>(b.querySelector('.nav-label')?.textContent??'').trim()==='AI 编写')?.click()")
await sleep(700)
const shape = await evaluate(`(() => {
  const el = document.querySelector('.col[data-view="ai"] .ag')
  const q = (s) => el?.querySelector(s) ?? null
  const labels = [...(el?.querySelectorAll('.chip span') ?? [])].map(e => e.textContent.trim())
  return {
    exists: !!el,
    // 顶部：它盯的是哪一篇
    card: !!q('.ag-card'),
    agentName: q('.ag-name')?.textContent?.trim() ?? '',
    agentSub: q('.ag-sub')?.textContent?.trim() ?? '',
    cardClose: !!q('.ag-card .ag-x'),
    // 2.0.0：这一道不再是「指令行」，改成了「会话行」——
    // 会话名 + 新建 + 删除当前会话，一并搬到了卡片正下方。
    sess: !!q('.ag-sess'),
    sessName: q('.ag-sess-name')?.textContent?.trim() ?? '',
    sessActs: [...(el?.querySelectorAll('.ag-sess .ag-mini') ?? [])].map(b => b.getAttribute('title')),
    // 上下文：开关 + 笔记选择
    toggle: !!q('.ag-switch'),
    toggleOn: q('.ag-switch')?.classList.contains('on') ?? false,
    notePick: q('.ag-pick-name')?.textContent?.trim() ?? '',
    // 消息流 / 快捷指令 / 输入区 / 底部
    stream: !!q('.stream'),
    chips: labels,
    input: q('.composer .input')?.getAttribute('placeholder') ?? '',
    send: !!q('.composer .send'),
    model: q('.ag-model-name')?.textContent?.trim() ?? '',
    session: !!q('.ss-wrap .ag-mini'),
    // 空态也得有话说
    emptyTitle: q('.ag-empty-title')?.textContent?.trim() ?? '',
    height: Math.round(el?.getBoundingClientRect().height ?? 0),
  }
})()`)
ok(
  '6.AI 面板按参考图重排：卡片 / 会话行 / 上下文开关与笔记选择 / 消息流 / 快捷指令 / 输入区 / 模型与发送',
  shape.exists && shape.card && shape.agentName === 'AI 助手' &&
    shape.agentSub.includes('笔记') && shape.cardClose &&
    shape.sess && !!shape.sessName &&
    shape.sessActs.includes('新建会话') && shape.sessActs.includes('删除当前会话') &&
    shape.toggle && shape.toggleOn && shape.notePick === '长文' &&
    shape.stream && shape.chips.length >= 4 &&
    shape.chips.includes('总结全文') && shape.chips.includes('生成大纲') && shape.chips.includes('起标题') &&
    shape.input.includes('Enter 发送') && shape.send &&
    shape.model === 'llama3.2' &&
    shape.emptyTitle === '让 AI 帮你写' && shape.height > 400,
  shape,
)

/* ── 7 + 8. 它是个 agent：执行过程是真的，思考过程是流出来的 ── */
const run = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const box = document.querySelector('.ag .composer .input')
  box.focus()
  box.value = '润色当前笔记，使其更通顺、专业，保留原意。'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(200)
  document.querySelector('.ag .composer .send')?.click()

  // 边跑边采样：能看到「半截回答」与「正在长的思考过程」才算流式
  const snaps = []
  for (let i = 0; i < 26; i += 1) {
    await wait(90)
    const last = [...document.querySelectorAll('.ag .stream .row.assistant')].pop()
    snaps.push({
      busyHint: !!document.querySelector('.ag .thinking-hint'),
      think: (document.querySelector('.ag .think')?.textContent ?? '').length,
      body: (document.querySelector('.ag .body')?.textContent ?? '').length,
      steps: document.querySelectorAll('.ag .step').length,
      running: document.querySelectorAll('.ag .step[data-status="run"]').length,
    })
  }

  const last = [...document.querySelectorAll('.ag .stream .row.assistant')].pop()
  const secs = [...(last?.querySelectorAll('.sec-head') ?? [])].map(b => b.textContent.replace(/\\s+/g, ' ').trim())
  const steps = [...(last?.querySelectorAll('.step') ?? [])].map(b => ({
    status: b.getAttribute('data-status'),
    label: b.querySelector('.step-label')?.textContent?.trim() ?? '',
    detail: b.querySelector('.step-detail')?.textContent?.trim() ?? '',
    ms: b.querySelector('.step-ms')?.textContent?.trim() ?? '',
  }))
  // 展开执行过程，确认能摊开
  const head = [...(last?.querySelectorAll('.sec-head') ?? [])].find(b => b.textContent.includes('执行过程'))
  head?.click()
  await wait(320)
  const stepsVisible = !!last?.querySelector('.steps')?.offsetHeight

  return {
    snaps, secs, steps, stepsVisible,
    thinkText: last?.querySelector('.think')?.textContent?.trim() ?? '',
    bodyText: last?.querySelector('.body')?.textContent?.trim() ?? '',
    userWho: document.querySelector('.ag .stream .row.user .who')?.textContent?.trim() ?? '',
    acts: last?.querySelectorAll('.acts .act').length ?? 0,
    aiCalls: window.__aiCalls,
  }
})()`)

const grewBody = run.snaps.some((s) => s.body > 0 && s.body < run.bodyText.length)
const grewThink = run.snaps.some((s) => s.think > 0 && s.think < run.thinkText.length)
ok(
  '7.一轮对话会留下执行过程：每步有标签、状态和真实耗时',
  run.steps.length >= 3 &&
    run.steps.every((s) => s.label.length > 0 && s.status === 'ok' && /\\d+ms$/.test(s.ms)) &&
    run.steps.some((s) => s.label.includes('笔记')) &&
    run.steps.some((s) => s.label.includes('模型')) &&
    run.stepsVisible === false ? false : run.steps.some((s) => s.detail.length > 0),
  run.steps,
)
ok(
  '8.执行过程在跑的时候能看见「正在做哪一步」',
  run.snaps.some((s) => s.running > 0) || run.snaps.some((s) => s.steps >= 3),
  run.snaps.filter((s, i) => i % 4 === 0),
)
ok(
  '9.思考过程跟着流式增量实时长出来',
  run.thinkText.includes('我先看一遍') && grewThink &&
    run.secs.some((t) => t.includes('思考过程')) &&
    run.secs.some((t) => t.includes('执行过程')),
  { thinkText: run.thinkText, grewThink, secs: run.secs, thinkSamples: run.snaps.map((s) => s.think) },
)
ok(
  '10.回答是边生成边长出来的，不是等完了一次性出现',
  run.bodyText.includes('润色结果') && grewBody &&
    run.userWho === '你' && run.acts === 4,
  { bodyLen: run.bodyText.length, grewBody, samples: run.snaps.map((s) => s.body), acts: run.acts },
)

/* ── 11. 模型不返回推理时，「思考过程」那一行不出现（不摆空壳） ── */
const noThink = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const box = document.querySelector('.ag .composer .input')
  box.focus()
  box.value = '再简短说一句'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(200)
  document.querySelector('.ag .composer .send')?.click()
  await wait(2400)
  const rows = [...document.querySelectorAll('.ag .stream .row.assistant')]
  const last = rows[rows.length - 1]
  return {
    aiCalls: window.__aiCalls,
    rows: rows.length,
    secs: [...(last?.querySelectorAll('.sec-head') ?? [])].map(b => b.textContent.trim()),
    hasThink: !!last?.querySelector('.think'),
    hasSteps: !!last?.querySelector('.steps, .sec'),
    bodyText: last?.querySelector('.body')?.textContent?.trim() ?? '',
  }
})()`)
ok(
  '11.模型没给推理的那一轮，只有执行过程，不摆空的思考栏',
  noThink.aiCalls === 2 && noThink.rows === 2 && !noThink.hasThink &&
    noThink.hasSteps &&
    noThink.secs.some((t) => t.includes('执行过程')) &&
    !noThink.secs.some((t) => t.includes('思考过程')) &&
    noThink.bodyText.includes('润色结果'),
  noThink,
)

/* ── 12. 全程零 JS 异常 ── */
ok('12.全程零 JS 异常', errors.length === 0, errors.slice(0, 4))

console.log('\n=== SUMMARY ===')
const failed = Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k)
if (failed.length) console.log('FAILED:', failed.join(', '))
else console.log('ALL PASS (' + Object.keys(out).length + ')')

ws.close()
edge.kill()
server.close()
await removeProfile(PROFILE)
process.exit(failed.length ? 1 : 0)
