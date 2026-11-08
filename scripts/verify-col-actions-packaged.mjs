/**
 * 资料栏顶栏按钮可见性 —— 打包版回归：
 * 起 win-unpacked 的 Nota.exe（默认 release/win-unpacked-new），连 CDP，
 * 逐屏点侧栏导航，断言「新建笔记 / 导入已有笔记」只出现在
 * 笔记类页签和 AI 编写屏，附件库 / 回收站必须没有。
 * 不依赖工作区（root 为空时按钮可能 disabled，但存在性判断不受影响）。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = fs.existsSync(path.join(root, 'release', 'win-unpacked-new', 'Nota.exe'))
  ? path.join(root, 'release', 'win-unpacked-new', 'Nota.exe')
  : path.join(root, 'release3', 'win-unpacked', 'Nota.exe')
if (!fs.existsSync(EXE)) {
  console.log('没有可用的打包版 Nota.exe')
  process.exit(1)
}
console.log('被测程序:', EXE)

const CDP_PORT = 4541
let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} —— ${extra}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(JSON.parse(s)))
    }).on('error', reject)
  })
}

delete process.env.ELECTRON_RUN_AS_NODE
const HOME = path.join(root, '.tmp-colact-home')
fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(HOME, { recursive: true })

const app = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`, '--no-sandbox'], {
  stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, NOTA_HOME: HOME },
})
app.on('error', (e) => console.log('  [spawn error]', e.message))

let ws = null
try {
  let targets
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try {
      targets = await getJson('/json/list')
      if (targets?.some((t) => t.type === 'page')) break
    } catch { /* 还没起来 */ }
  }
  const page = targets?.find((t) => t.type === 'page')
  if (!page) throw new Error('CDP 页面没等到')

  const WebSocket = (await import('ws')).default
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  let seq = 0
  const pending = new Map()
  ws.on('message', (d) => {
    const m = JSON.parse(d)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    return r.result?.result?.value
  }
  await send('Runtime.enable')
  await sleep(2000)
  await evaluate(`localStorage.setItem('nota-tour-seen', '1')`)
  await send('Page.reload')
  await sleep(2500)

  const nav = (label) => evaluate(
    `(() => { const b=[...document.querySelectorAll('.panel .nav-item')].find(x=>(x.querySelector('.nav-label')?.textContent??'').trim()==='${label}'); b?.click(); return !!b })()`,
  )
  const acts = () => evaluate(
    `JSON.stringify({ new: !!document.querySelector('.col [data-role=new-note]'), imp: !!document.querySelector('.col [data-role=import-note]'), name: document.querySelector('.col-name')?.textContent?.trim() ?? document.querySelector('.col-tab.on')?.textContent?.trim() })`,
  ).then((s) => JSON.parse(s))

  await nav('所有笔记')
  await sleep(500)
  let r = await acts()
  check('笔记屏保留新建/导入', r.new && r.imp, JSON.stringify(r))

  await nav('附件库')
  await sleep(500)
  r = await acts()
  check('附件库隐藏新建/导入', !r.new && !r.imp, JSON.stringify(r))

  await nav('回收站')
  await sleep(500)
  r = await acts()
  check('回收站隐藏新建/导入', !r.new && !r.imp, JSON.stringify(r))

  await nav('AI 编写')
  await sleep(500)
  r = await acts()
  check('AI 编写屏保留新建/导入', r.new && r.imp, JSON.stringify(r))

  await nav('所有笔记')
  await sleep(500)
  r = await acts()
  check('回到笔记屏按钮恢复', r.new && r.imp, JSON.stringify(r))

  console.log(`\n打包版按钮可见性回归：${pass} 过 / ${fail} 挂`)
} catch (e) {
  console.log('探针失败:', e.message)
  fail++
} finally {
  try { ws?.close() } catch { /* ignore */ }
  app.kill()
  fs.rmSync(HOME, { recursive: true, force: true })
}
process.exit(fail ? 1 : 0)
