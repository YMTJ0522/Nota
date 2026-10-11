/**
 * 界面截图：给对外展示/自查用的四个画面。
 *
 * 刻意不用灰块占位图——预览里的那张「照片」是真的 PNG，
 * 视频给的是真实文件：截图要能直接看，就不用假装。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { purgeStale, removeProfile } from './tmp-profiles.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')
const docsDir = path.join(root, 'docs')

// 名字里故意留个空格：这是之前图片不显示的那个坑（CommonMark 要求
// 含空格的地址必须写成 `<>`，否则 marked 整行不解析）
const PIC = 'attachments/【哲风壁纸】励志标语-彩色字体 2.jpg'
const VID = 'attachments/【哲风壁纸】人物剪影-开阔-旷野 1.mp4'

/* 真实的一张 PNG 当配图。用应用图标：它是一张规规矩矩的方图，
   比拿界面截图当配图更干净，也不会和当前界面视觉打架。 */
const PIC_DATA = 'data:image/png;base64,' + fs.readFileSync(path.join(docsDir, 'icon-big.png')).toString('base64')

const NOTE = [
  '# 一周手记',
  '',
  '*「把想法写下来，它们才会长成东西。」*',
  '',
  `![Nota 的图标](${PIC})`,
  '',
  `<video src="${VID}" controls></video>`,
  '',
  '## 这周做了什么',
  '',
  '- [x] 把资料库迁到本地目录',
  '- [x] 给编辑器补上代码块行号',
  '- [ ] 整理读书笔记的双链',
  '',
  '> [!tip] 小技巧',
  '> 围栏后面写 `line-numbers` 就会显示行号，写 `{2}` 还能高亮某一行。',
  '',
  '## 一段代码',
  '',
  '```ts title="notes.ts" line-numbers {3}',
  'export interface Note {',
  '  path: string',
  '  tags: string[]',
  '  updatedAt: number',
  '}',
  '',
  'export function isFresh(n: Note, days = 7) {',
  '  return Date.now() - n.updatedAt < days * 86400_000',
  '}',
  '```',
  '',
  '## 图表与表格',
  '',
  '```mermaid',
  'graph LR',
  '  A[想法] --> B[笔记]',
  '  B --> C[整理]',
  '  C --> D[输出]',
  '```',
  '',
  '| 项目 | 状态 | 耗时 |',
  '| --- | --- | --- |',
  '| 资料库 | 完成 | 2 天 |',
  '| 编辑器 | 完成 | 3 天 |',
  '| 双链 | 进行中 | — |',
  '',
  '普通段落收尾，顺便试一下 `行内代码` 和 [链接](https://example.com)。',
  '',
].join('\n')

const PORT = 4321
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROFILE = path.join(root, `.tmp-cdp-shots-${Date.now()}`)
const CDP_PORT = 9400 + (Date.now() % 200)

async function waitPortFree(port) {
  for (let i = 0; i < 60; i++) {
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

purgeStale()
await waitPortFree(CDP_PORT)

const edge = spawn(EDGE, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=1440,960', 'about:blank'], { stdio:'ignore' })

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
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
  setTimeout(() => reject(new Error('cdp timeout ' + method)), 40000)
  ws.send(JSON.stringify({ id: myId, method, params }))
})
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description ?? ''))
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(docsDir, name)
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('  截图 →', file)
}

await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(2500)

const TREE = [
  {
    type: 'dir', name: '2026 手记', path: '/ws/2026 手记',
    children: [
      { type: 'file', name: '一周手记.md', path: '/ws/一周手记.md', tags: ['手记'], starred: true, mtime: Date.now() - 3600_000 },
      { type: 'file', name: '读书笔记.md', path: '/ws/读书笔记.md', tags: ['阅读'], starred: false, mtime: Date.now() - 86400_000 * 3 },
      { type: 'file', name: '待办.md', path: '/ws/待办.md', tags: [], starred: true, mtime: Date.now() - 7200_000 },
    ],
  },
]

await evaluate('(() => {' +
  ` window.__notes = { "/ws/一周手记.md": ${JSON.stringify(NOTE)}, "/ws/读书笔记.md": "# 读书笔记\\n\\n在读《设计中的设计》。\\n", "/ws/待办.md": "# 待办\\n\\n- 整理旧稿\\n" };` +
  ` window.__pic = ${JSON.stringify(PIC)};` +
  ` window.__picData = ${JSON.stringify(PIC_DATA)};` +
  ' window.api = {' +
  '  pickWorkspace: async () => "/ws",' +
  `  readTree: async () => (${JSON.stringify(TREE)}),` +
  '  readNote: async (p) => window.__notes[p] ?? "",' +
  '  writeNote: async (p, t) => { window.__notes[p] = t; return true },' +
  '  createNote: async (d, n) => d + "/" + n + ".md", createFolder: async (d, n) => d + "/" + n,' +
  '  deleteNote: async () => true, renameNote: async (p) => p,' +
  '  pickImage: async () => ({ rel: window.__pic, alt: "封面", copied: true, isVideo: false }),' +
  '  resolveMedia: async (b, r) => { const dec = /%[0-9a-fA-F]{2}/.test(r) ? decodeURIComponent(r) : r; return dec === window.__pic ? window.__picData : "nota-media://local/" + encodeURIComponent(dec) },' +
  '  attachList: async () => ([{ rel: window.__pic, name: "封面.jpg", size: 20480, mtime: Date.now(), isVideo: false }]),' +
  '  attachDelete: async () => true,' +
  '  trashList: async () => ([{ key: "aGV5", rel: "2026 手记/旧稿.md", name: "旧稿.md", deletedAt: Date.now() - 3600_000, size: 120 }]),' +
  '  trashRestore: async () => "/ws/2026 手记/旧稿.md", trashPurge: async () => true, trashEmpty: async () => true,' +
  `  aiChat: async () => ({ ok: true, text: ${JSON.stringify(
    '我看了一遍，结构挺清楚，三处可以再打磨：\n\n1. 「这段 touchend 的处理」缺主语，改成「touchend 里这一段」读起来更顺\n2. 第二段偏长，可以在「然后再看看后面还有触屏上 qb 的 apply8.getPendingUiOps 是否符合预期」前断开\n3. 结尾那句像是口语记录，正式文档里可以省掉\n\n改完大概是这样：\n\n```ts title="建议.md" line-numbers\n// 处理完成后统一刷新，避免重复绘制\nif (pendingOps > 0) refreshView()\n```\n\n要不要我直接替你把整段改一版？',
  )} }),` +
  '  aiTest: async () => ({ ok: true, models: ["llama3.2", "qwen2.5"] }),' +
  '  appInfo: async () => ({ electron: "33.0.0", chrome: "130.0.0.0", node: "20.18.0", platform: "win32", arch: "x64" }),' +
  '  exportSave: async () => "/tmp/x",' +
  '  historySave: async () => "/h/1.md", historyList: async () => [], historyRead: async () => "# h",' +
  '  minimize: () => {}, toggleMaximize: () => {}, closeWindow: () => {}, onMaximizeChange: () => {}' +
  ' }; return true; })()')

await evaluate("document.querySelector('.cta')?.click()")
await sleep(900)
await evaluate("document.querySelector('.tree .row.dir')?.click()")
await sleep(300)
await evaluate("(() => { const rows=[...document.querySelectorAll('.tree .row.file')]; const t=rows.find(r=>r.textContent.includes('一周手记')); t?.click(); return !!t })()")
await sleep(1600)

const clickMode = async (title) => {
  await evaluate(`(() => { const b = [...document.querySelectorAll('.ph-seg-btn')].find(x => (x.getAttribute('title')||'').includes(${JSON.stringify(title)})); if (b) b.click(); return !!b })()`)
  await sleep(900)
}

/* ① 浅色 · 分栏（编辑 + 预览） */
await clickMode('分栏')
await sleep(1200)
await shot('screenshot-light.png')

/* ② 深色 · 纯预览
   主题必须走设置面板改：直接写 <html data-theme> 会被 store 的下一次
   重渲染覆盖回去（按钮叫「阅读模式」，不叫「预览模式」）。 */
await evaluate(`(async () => {
  document.querySelector('.panel .foot .foot-btn[data-tip="设置"]')?.click()
  await new Promise(r => setTimeout(r, 400))
  const ap = [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent.includes('外观'))
  ap?.click()
  await new Promise(r => setTimeout(r, 300))
  const dark = [...document.querySelectorAll('.st-seg-btn')].find(b => b.textContent.trim() === '深色')
  dark?.click()
  await new Promise(r => setTimeout(r, 300))
  document.querySelector('.st-x')?.click()
  return true
})()`)
await sleep(700)
await clickMode('阅读模式')
await sleep(1400)
await shot('screenshot-dark.png')

/** 主题只能从设置面板改，直接改 <html> 会被 store 覆盖 */
const setTheme = async (label) => {
  await evaluate(`(async () => {
    document.querySelector('.panel .foot .foot-btn[data-tip="设置"]')?.click()
    await new Promise(r => setTimeout(r, 400))
    const ap = [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent.includes('外观'))
    ap?.click()
    await new Promise(r => setTimeout(r, 300))
    const b = [...document.querySelectorAll('.st-seg-btn')].find(x => x.textContent.trim() === ${JSON.stringify(label)})
    b?.click()
    await new Promise(r => setTimeout(r, 300))
    document.querySelector('.st-x')?.click()
    return true
  })()`)
  await sleep(600)
}
await setTheme('浅色')

/* ③ AI 聊天页 */
await evaluate("(() => { const b=[...document.querySelectorAll('.panel .nav-item')].find(x=>(x.querySelector('.nav-label')?.textContent??'').trim()==='AI 编写'); b?.click(); return true })()")
await sleep(700)
await evaluate(`(async () => {
  const box = document.querySelector('.chat .composer .input')
  box.focus(); box.value = '帮我看看这段文字有没有可以精简的地方'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 200))
  document.querySelector('.chat .composer .send')?.click()
  await new Promise(r => setTimeout(r, 1400))
  return true
})()`)
await sleep(900)
await shot('screenshot-ai.png')

/* ④ 设置 · AI 编写页 */
await evaluate("window.dispatchEvent(new CustomEvent('nota:settings', { detail: 'ai' }))")
await sleep(700)
await evaluate(`(async () => {
  const btn = [...document.querySelectorAll('.st-btn')].find(b => b.textContent.includes('测试连接'))
  btn?.click()
  await new Promise(r => setTimeout(r, 900))
  return true
})()`)
await sleep(600)
await shot('screenshot-settings.png')

/* ⑤ 设置 · 外观页（强调色板） */
await evaluate("document.querySelector('.st-x')?.click()")
await sleep(400)
await evaluate("window.dispatchEvent(new CustomEvent('nota:settings', { detail: 'appearance' }))")
await sleep(900)
await shot('screenshot-appearance.png')

await send('Page.close').catch(() => {})
ws.close()
edge.kill()
server.close()
removeProfile(PROFILE)
console.log('done')
process.exit(0)
