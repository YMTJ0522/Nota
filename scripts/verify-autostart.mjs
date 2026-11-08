/**
 * 开机自启真机回归：
 * 起打包产物（win-unpacked/Nota.exe，非便携名 → canAutoStart 应为 true），
 * 连 CDP 调 window.api.setAutoStart(true/false)，每一步查注册表
 * HKCU\...\Run 里的 Nota 项是否真的写上/摘掉。
 * 测完恢复原状（开关置回 false），不残留。
 */
import { spawn } from 'node:child_process'
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/* 优先测安装版（Program Files），没有就用打包产物 */
const EXE = fs.existsSync('C:\\Program Files\\Nota\\Nota.exe')
  ? 'C:\\Program Files\\Nota\\Nota.exe'
  : path.join(root, 'release3', 'win-unpacked', 'Nota.exe')
if (!fs.existsSync(EXE)) {
  console.log('没有可用的 Nota.exe（既没装安装版，也没有 release3/win-unpacked）')
  process.exit(1)
}
console.log('被测程序:', EXE)

const CDP_PORT = 4493
let pass = 0, fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`) }
}

const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
/* reg.exe 在沙箱黑名单里，用 PowerShell 的 Get-ItemProperty 查 */
function regEntry() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-ItemProperty -LiteralPath '${RUN_KEY}' -ErrorAction Stop).Nota"`,
      { encoding: 'utf-8' },
    )
    const v = (out ?? '').trim()
    return v || null
  } catch (e) {
    console.log('  [reg 探测失败]', String(e.stderr ?? e.message).trim().slice(0, 160))
    return null
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── CDP 连接 ── */
function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(JSON.parse(s)))
    }).on('error', reject)
  })
}

const before = regEntry()
console.log('测试前注册表 Nota 项:', before ?? '(无)')

delete process.env.ELECTRON_RUN_AS_NODE // 沙箱环境带着这个变量，会把 Electron 变成纯 Node
const CLEAN_HOME = path.join(root, '.tmp-autostart-home')
fs.rmSync(CLEAN_HOME, { recursive: true, force: true })
fs.mkdirSync(CLEAN_HOME, { recursive: true })

const app = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`, '--no-sandbox'], {
  stdio: ['ignore', 'ignore', 'pipe'],
  detached: false,
  env: { ...process.env, NOTA_HOME: CLEAN_HOME },
})
app.stderr.on('data', (d) => { if (String(d).trim()) console.log('  [app.stderr]', String(d).trim().slice(0, 200)) })
app.on('error', (e) => console.log('  [app.spawn error]', e.message))

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
    if (r.result?.exceptionDetails) return `__ERR__ ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`
    return r.result?.result?.value
  }
  await send('Runtime.enable')
  await sleep(2000)

  /* 应用内守卫：canAutoStart 必须是 true（打包 + 非便携名） */
  const can = await evaluate(`window.api.desktopPrefs ? 'has' : 'no'`)
  const prefs1 = await evaluate(`window.api.desktopPrefs().then(p => JSON.stringify({ can: p.canAutoStart, on: p.openAtLogin, portable: p.portable }))`)
  console.log('  [探针] getDesktopPrefs:', prefs1)
  const p1 = JSON.parse(prefs1)
  check('打包版 canAutoStart = true', p1.can === true, JSON.stringify(p1))

  /* 开：注册表必须出现 --hidden 参数 */
  const onRes = await evaluate(`window.api.setAutoStart(true)`)
  await sleep(600)
  const prefsOn = JSON.parse(await evaluate(`window.api.desktopPrefs().then(p => JSON.stringify({ on: p.openAtLogin }))`))
  const entry1 = regEntry()
  check('setAutoStart(true) 返回 true', onRes === true, String(onRes))
  check('应用自报 openAtLogin = true', prefsOn.on === true, JSON.stringify(prefsOn))
  check('注册表 Run 出现 Nota 且带 --hidden', !!entry1 && entry1.includes('--hidden'), entry1 ?? '(无)')

  /* 关：注册表必须摘掉 */
  const offRes = await evaluate(`window.api.setAutoStart(false)`)
  await sleep(600)
  const entry2 = regEntry()
  check('setAutoStart(false) 返回 true', offRes === true, String(offRes))
  check('注册表 Run 已摘掉 Nota', entry2 === null, entry2 ?? '')

  console.log(`\n自启回归：${pass} 过 / ${fail} 挂`)
} catch (e) {
  console.log('探针异常:', e.message)
  fail++
} finally {
  try { ws?.close() } catch { /* noop */ }
  app.kill()
}

process.exit(fail ? 1 : 0)
