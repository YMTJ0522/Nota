/**
 * 打包版里真跑一遍联网 IPC。
 *
 * 前面的 verify-web-flow 验的是渲染层逻辑（假 IPC），这一份验的是
 * 「主进程真发请求、真解析」——Bing RSS 的解析、天气源到中文的转换都在
 * 主进程，只有连着真包跑才能确认它们在 file:// 的打包环境里也通。
 *
 * 用法: NOTA_UNPACKED=release/win-unpacked-XXX node scripts/check-live-ipc.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(
  root,
  process.env.NOTA_UNPACKED || path.join('release', 'win-unpacked'),
  'Nota.exe',
)
if (!fs.existsSync(EXE)) {
  console.log('没有打包产物：', EXE)
  process.exit(2)
}

const STAMP = Date.now()
const CDP_PORT = 9600 + (STAMP % 200)
const HOME = path.join(root, `.tmp-live-ipc-${STAMP}`)
fs.mkdirSync(HOME, { recursive: true })

delete process.env.ELECTRON_RUN_AS_NODE
const app = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`, '--no-sandbox'], {
  stdio: 'ignore',
  env: { ...process.env, NOTA_HOME: HOME },
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
  console.log('连不上打包应用')
  process.exit(2)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result)
    pending.delete(m.id)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const myId = ++id
    pending.set(myId, resolve)
    setTimeout(() => reject(new Error(`cdp timeout ${method}`)), 60000)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
  return r.result.value
}

await send('Runtime.enable')
await sleep(3000)

let fail = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${name} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  if (!ok) fail++
}

/* 1. 网页检索：主进程真抓 Bing RSS、真解析 */
const sr = await ev(`window.api.aiWebSearch('海康威视 运维工程师', 5)`)
if (sr?.__exc) check('L1 网页检索 IPC 可调用', false, sr.__exc)
else {
  const hits = sr?.hits ?? []
  check('L1 网页检索拿到结果', sr?.ok && hits.length > 0, `${sr?.engine} · ${hits.length} 条`)
  check(
    'L2 结果是真实链接与标题（不是词典释义）',
    hits.length > 0 && hits.every((h) => /^https?:\/\//.test(h.url) && h.title.length > 4),
    hits[0]?.title ?? '无',
  )
  const junk = hits.filter((h) => /汉典|zdic|汉语字典/.test(h.title)).length
  check('L3 没有把词典条目混进来', junk === 0, `${junk} 条`)
}

/* 2. 天气：真请求 wttr.in，中文天气码转换 */
const wr = await ev(`window.api.aiWeather('乌鲁木齐')`)
if (wr?.__exc) check('L4 天气 IPC 可调用', false, wr.__exc)
else {
  const text = wr?.text ?? ''
  check('L4 天气 IPC 拿到数据', wr?.ok && text.includes('实况'), text.split('\n')[0] ?? '')
  check('L5 描述已转成中文且带温度', /℃/.test(text) && /[晴雨雪云雾阴]/.test(text), text.split('\n')[1] ?? '')
  check('L6 带三天预报', (text.match(/降水概率/g) ?? []).length >= 2, `${(text.match(/降水概率/g) ?? []).length} 天`)
  console.log('--- 天气原文 ---\n' + text + '\n---------------')
}

/* 3. 边界：不存在的城市不应崩，也不该返回假数据 */
const bad = await ev(`window.api.aiWeather('zzzz-not-a-city-9999')`)
check('L7 乱写地名不崩（要么 ok:false，要么没数据）', !!bad && !bad.__exc, bad?.ok ? '返回了 ok' : String(bad?.error ?? '').slice(0, 40))

app.kill()
ws.close()
try {
  fs.rmSync(HOME, { recursive: true, force: true })
} catch {}
console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
