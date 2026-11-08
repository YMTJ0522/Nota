/**
 * 探针：生产 Electron 里 blob Worker 到底能不能跑。
 *
 * headless Edge（verify 系列用的宿主）会把 blob Worker 静默禁用
 * （new Worker 成功、脚本永远不执行、onerror 无消息），diff 因此带同步兜底。
 * 但兜底是兜底，Worker 这条快路在生产里必须真的通 —— 这里用打包产物
 * （release/win-unpacked/Nota.exe）连 CDP，在真实渲染进程里跑一遍
 * 「Blob → createObjectURL → new Worker → postMessage → 回信」全链路。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(root, 'release', 'win-unpacked-new', 'Nota.exe')
if (!fs.existsSync(EXE)) {
  console.log('没有打包产物（release/win-unpacked/Nota.exe），先 npm run pack')
  process.exit(2)
}

const STAMP = Date.now()
const CDP_PORT = 9700 + (STAMP % 200)
const CLEAN_HOME = path.join(root, `.tmp-worker-home-${STAMP}`)
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
  if (r?.exceptionDetails) return 'EXC: ' + JSON.stringify(r.exceptionDetails).slice(0, 200)
  return r?.result?.value
}

await sleep(1500)
await send('Runtime.enable')

const probe = await evaluate(`
  (async () => {
    const code = 'self.onmessage = function (e) { self.postMessage({ id: e.data.id, n: e.data.n * 2 }) }'
    const blob = new Blob([code], { type: 'text/javascript;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    return await new Promise((resolve) => {
      let w
      try { w = new Worker(url) } catch (e) { resolve('construct-fail: ' + e.message); return }
      const t = setTimeout(() => resolve('TIMEOUT: 无回音'), 3000)
      w.onerror = () => { clearTimeout(t); resolve('onerror: worker 被禁') }
      w.onmessage = (e) => { clearTimeout(t); resolve('OK n=' + e.data.n) }
      w.postMessage({ id: 1, n: 21 })
    })
  })()
`)
console.log('Electron blob worker:', probe)

app.kill()
await sleep(300)
fs.rmSync(CLEAN_HOME, { recursive: true, force: true })
process.exit(String(probe).startsWith('OK') ? 0 : 1)
