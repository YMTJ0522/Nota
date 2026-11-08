/**
 * 安装窗关闭瞬间逐帧抓拍：查「点打开 Nota 后安装窗关闭时右缘闪竖杠」。
 *
 * 流程：探针版安装页（start 假、launch 真转发）→ 走完三屏 → 点「打开 Nota」
 * → 真实 quit 链路（handoff 写盘 + explorer 转手 + 500ms 后 app.quit()）
 * → Page.startScreencast 推流，每一帧都落盘，直到 WebSocket 随进程断掉。
 * 断掉前最后几帧 = 窗口销毁前的最后画面。
 *
 *   node scripts/probe-close-frames.mjs <Nota.exe> <帧输出目录>
 * （Nota.exe 需是打了探针补丁的 win-unpacked-new 里那份）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const exe = process.argv[2]
const outDir = process.argv[3]
if (!exe || !outDir) {
  console.error('用法: node probe-close-frames.mjs <Nota.exe> <outdir>')
  process.exit(2)
}
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

delete process.env.ELECTRON_RUN_AS_NODE
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-cprobe-'))
const PORT = 9236

const child = spawn(exe, [`--remote-debugging-port=${PORT}`], {
  cwd: path.dirname(exe),
  env: { ...process.env, PORTABLE_EXECUTABLE_FILE: exe, NOTA_HOME: home },
  stdio: 'ignore',
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function installerTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = list.find((t) => t.type === 'page' && /install/i.test(t.url + t.title))
      if (page) return page
    } catch {}
    await sleep(400)
  }
  return null
}

/* screencast 版 cdp：需要处理事件 */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  const handlers = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method) for (const h of handlers) h(m)
  }
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res) => {
        const id = ++seq
        pending.set(id, res)
        ws.send(JSON.stringify({ id, method, params }))
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ timeout: true }) } }, 5000)
      }),
      onEvent: (h) => handlers.push(h),
      close: () => ws.close(),
    }),
    ws.onerror = reject
  })
}

const target = await installerTarget()
if (!target) { console.error('没等到安装窗'); process.exit(1) }
console.log('安装窗已起，开推流')
const c = await cdp(target.webSocketDebuggerUrl)
await c.send('Page.enable')

let n = 0
let dead = false
c.onEvent(async (m) => {
  if (m.method !== 'Page.screencastFrame') return
  const { data, sessionId } = m.params
  try {
    fs.writeFileSync(path.join(outDir, `f${String(n).padStart(3, '0')}.png`), Buffer.from(data, 'base64'))
    n++
  } catch {}
  /* 必须 ack 下一帧才继续推 */
  c.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
})
await c.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }).catch(() => {})

await sleep(1200)
/* 假 start：不碰磁盘 */
await c.send('Runtime.evaluate', {
  expression: `document.querySelector('#w-go').click()`,
}).catch(() => {})
console.log('已点「继续」（start 是假的）')
await sleep(2500)

console.log('点「打开 Nota」→ 真实 quit 链路…')
child.once('exit', () => { dead = true; console.log('进程已退出') })
await c.send('Runtime.evaluate', {
  expression: `document.querySelector('#d-open').click()`,
}).catch(() => {})

/* 推流会随进程退出而断；等 exit 事件 */
await new Promise((r) => child.once('exit', r))
console.log(`共收到 ${n} 帧，进程退出`)
try { await c.close() } catch {}
await sleep(300)
try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
try { fs.rmSync(path.join(process.env.LOCALAPPDATA ?? '', 'Nota', 'install-handoff'), { force: true }) } catch {}
process.exit(0)
