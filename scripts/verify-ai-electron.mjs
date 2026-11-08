/**
 * 真机 AI 连通性验证。
 *
 * 浏览器 harness 里 window.api.aiTest / aiChat 都是 mock 的，测不了真实链路；
 * AI 的网络请求全在 Electron 主进程里发。所以这里起一个假的 OpenAI 兼容
 * 服务器，连打包产物（release/win-unpacked/Nota.exe）的 CDP，把两条路径都过一遍：
 *
 *   1. 设置 › AI › 测试连接 —— 假服务器故意把 /models 回 404、只在 /v1/models
 *      回列表，验证主进程的候选路径回退逻辑真的会兜住。
 *   2. 编辑器右键 › AI › 润色这段 —— 走 ai:chat 的 SSE 流，验证模型回复真的能插进文档。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(root, 'release', 'win-unpacked-new', 'Nota.exe')
if (!fs.existsSync(EXE)) {
  console.log('没有打包产物（release/win-unpacked/Nota.exe），先 npm run pack')
  process.exit(2)
}

/* ── 假 OpenAI 兼容服务器 ──
   /models 故意 404：主进程的 ai:test 会先试 base/models，404 后应继续试
   base/v1/models —— 这是「测不出来」最典型的一种场景。 */
const hits = { models404: 0, v1models: 0, chat: 0 }
const PORT = 18000 + (Date.now() % 2000)
const MODEL_TXT = '润色完成OK'

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/models') {
    hits.models404++
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found (intentional)' }))
    return
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    hits.v1models++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'nota-test-model' }, { id: 'nota-test-small' }] }))
    return
  }
  if (req.method === 'POST' && req.url === '/chat/completions') {
    hits.chat++
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const frames = [
        { choices: [{ delta: { content: MODEL_TXT.slice(0, 2) } }] },
        { choices: [{ delta: { content: MODEL_TXT.slice(2) } }] },
      ]
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
console.log(`假服务器: http://127.0.0.1:${PORT}`)

/* ── 起真机 ── */
const STAMP = Date.now()
const CDP_PORT = 9900 + (STAMP % 200)
const CLEAN_HOME = path.join(root, `.tmp-ai-home-${STAMP}`)
fs.mkdirSync(CLEAN_HOME, { recursive: true })
delete process.env.ELECTRON_RUN_AS_NODE

const app = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`, '--no-sandbox'], {
  stdio: 'ignore',
  env: { ...process.env, NOTA_HOME: CLEAN_HOME },
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target = null
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
    if (target) break
  } catch {}
  await sleep(500)
}
if (!target) {
  app.kill()
  server.close()
  throw new Error('连不上渲染进程')
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
})
const send = (method, params = {}) =>
  new Promise((resolve) => { id += 1; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r?.exceptionDetails) return 'EXC: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)
  return r?.result?.value
}
const clickAt = async (x, y, button = 'left') => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1 })
    await sleep(60)
  }
}

await sleep(2000)
await send('Runtime.enable')
await send('Log.enable')
const logLines = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Log.entryAdded') logLines.push(`[${m.params.entry.level}] ${m.params.entry.text}`)
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    logLines.push('[console.error] ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
})

/* ── 0. 隔离探针：绕过 UI 直接调 aiChat，走 silent（不推流，一次拿全量） ── */
const probe = await evaluate(`(async () => {
  const cfg = { baseUrl: 'http://127.0.0.1:${PORT}', model: 'nota-test-model', apiKey: '', system: '', temperature: 0.7, silent: true }
  const t = setTimeout(() => {}, 1)
  const r = await Promise.race([
    window.api.aiChat(cfg, [{ role: 'user', content: 'hi' }]),
    new Promise((res) => setTimeout(() => res('PROBE_TIMEOUT'), 15000)),
  ])
  return JSON.stringify(r)
})()`)
console.log('隔离探针 aiChat:', probe)
console.log('  假服务器命中:', JSON.stringify(hits))

/* 过欢迎页 */
await evaluate(`localStorage.setItem('nota-tour-seen', '1')`)
await evaluate(`location.reload()`)
await sleep(2500)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)

/* ── 1. 设置 › AI › 测试连接 ── */
let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
  cond ? pass++ : fail++
}

// 打开设置（侧栏底部那颗齿轮）
const openR = await evaluate(`(() => {
  const btns = [...document.querySelectorAll('[data-tip="设置"]')]
  const b = btns.find(x => x.offsetParent !== null)
  if (!b) return 'no-btn'
  b.click(); return 'ok'
})()`)
await sleep(700)

// 切到 AI 一节
await evaluate(`(() => {
  const nav = [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent.includes('AI'))
  nav?.click()
})()`)
await sleep(500)

// 确保 AI 总开关开着（右键菜单的 AI 项要它）
await evaluate(`(() => {
  const sw = document.querySelector('.st-switch[role="switch"]')
  if (sw && sw.getAttribute('aria-checked') === 'false') sw.click()
})()`)
await sleep(300)

// 填接口地址（假地址故意不带 /v1，逼候选回退）
await evaluate(`(() => {
  const inp = document.querySelector('input[placeholder="http://localhost:11434/v1"]')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(inp, 'http://127.0.0.1:${PORT}')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(400)

// 点「测试连接」
const clicked = await evaluate(`(() => {
  const b = [...document.querySelectorAll('.st-btn')].find(x => x.textContent.includes('测试连接'))
  if (!b) return 'no-btn'
  b.click(); return 'ok'
})()`)
await sleep(300)

// 等结果（最多 15 秒）
let testText = ''
for (let i = 0; i < 30; i++) {
  testText = String(await evaluate(`(() => {
    const b = [...document.querySelectorAll('.st-btn')].find(x => x.textContent.includes('测试连接'))
    const row = b?.closest('.st-row')
    return row?.querySelector('.st-desc')?.textContent ?? ''
  })()`))
  if (testText.includes('连接成功') || testText.includes('失败') || testText.includes('超时')) break
  await sleep(500)
}
check('测试连接成功', testText.includes('连接成功'), testText.trim().slice(0, 80))
check('候选路径回退生效（/models 404 → /v1/models 命中）', hits.v1models > 0, JSON.stringify(hits))

const chips = String(await evaluate(`[...document.querySelectorAll('.st-chip')].map(c => c.textContent.trim()).join(',')`))
check('可用模型列表出来了', chips.includes('nota-test-model'), chips)

// 点假模型 chip，把模型名填上
await evaluate(`(() => {
  const c = [...document.querySelectorAll('.st-chip')].find(x => x.textContent.trim() === 'nota-test-model')
  c?.click()
})()`)
await sleep(200)

// 关设置
await evaluate(`document.querySelector('.st-x')?.click()`)
await sleep(600)

/* ── 2. 编辑器右键 AI 润色 ── */
/* 直接用启动时就打开的欢迎笔记：先点一下编辑器聚焦，再打字 + 全选 */
await evaluate(`document.querySelector('.cm-content')?.focus()`)
await sleep(400)
await send('Input.insertText', { text: '这是一段需要润色的测试文字。' })
await sleep(400)
const selKeys = { modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }
for (const t of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type: t, ...selKeys })
await sleep(400)
const preDoc = String(await evaluate(`document.querySelector('.cm-content')?.textContent ?? ''`))
const preSel = String(await evaluate(`document.getSelection().toString()`))
console.log('  [调试] 全选前文档含插入文字:', preDoc.includes('需要润色的测试文字'), '长度:', preDoc.length, '| 选区长度:', preSel.length)

// 编辑器中央右键
const rect = JSON.parse(await evaluate(`(() => {
  const el = document.querySelector('.cm-content')
  if (!el) return 'null'
  const b = el.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(b.height / 2, 200)) })
})()`))
if (!rect || rect === 'null') {
  check('编辑器存在', false)
} else {
  await clickAt(rect.x, rect.y, 'right')
  await sleep(600)

  // 点「润色这段」
  const item = await evaluate(`(() => {
    const els = [...document.querySelectorAll('button, [role="menuitem"]')]
    const it = els.find(x => x.textContent.includes('润色这段') && x.offsetParent !== null)
    if (!it) return 'no-item'
    const st = { disabled: it.disabled, off: it.classList.contains('off'), cls: it.className.slice(0, 60) }
    it.click()
    return JSON.stringify(st)
  })()`)
  console.log('  [调试] 菜单项状态:', item)
  check('右键菜单 AI 润色项可点', item !== 'no-item' && !item.includes('"disabled":true'), String(item))

  await sleep(1200)
  const toast = String(await evaluate(`(() => {
    const t = [...document.querySelectorAll('[class*="toast"]')]
    return t.map(x => x.textContent.trim()).filter(Boolean).join(' | ') || '(无 toast)'
  })()`))
  console.log('  [调试] 点击后 toast:', toast)

  // 等 AI 结果插进文档（最多 20 秒）
  let doc = ''
  for (let i = 0; i < 40; i++) {
    doc = String(await evaluate(`document.querySelector('.cm-content')?.textContent ?? ''`))
    if (doc.includes(MODEL_TXT)) break
    await sleep(500)
  }
  check('AI 回答插入文档', doc.includes(MODEL_TXT), doc.replace(/\s+/g, ' ').slice(0, 120))
  check('假服务器收到 chat 请求', hits.chat > 0, JSON.stringify(hits))
  const toast2 = String(await evaluate(`(() => {
    const t = [...document.querySelectorAll('[class*="toast"]')]
    return t.map(x => x.textContent.trim()).filter(Boolean).join(' | ') || '(无 toast)'
  })()`))
  console.log('  [调试] 结束后 toast:', toast2)
}

if (logLines.length) console.log('\n页面日志:\n' + logLines.slice(-12).join('\n'))

console.log(`\n${pass} 过 / ${fail} 挂`)
app.kill()
await sleep(300)
server.close()
fs.rmSync(CLEAN_HOME, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
