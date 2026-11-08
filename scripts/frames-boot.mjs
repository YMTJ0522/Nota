/**
 * 抓拍主应用启动头几秒的帧，找「点打开 Nota 后闪一下的竖杠滚动条」。
 * 用 CDP 轮询 captureScreenshot 逐帧收图。
 *   node scripts/frames-boot.mjs <Nota.exe> <输出目录> [--vault]
 * --vault：先造假工作区（几篇笔记 + vault.json 指针），
 *          模拟「已装好、打开就是编辑器」的真实启动，而不是空库欢迎页。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const exe = process.argv[2]
const outDir = process.argv[3]
const WITH_VAULT = process.argv.includes('--vault')
if (!exe || !outDir) {
  console.error('用法: node frames-boot.mjs <Nota.exe> <outdir> [--vault]')
  process.exit(2)
}
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

delete process.env.ELECTRON_RUN_AS_NODE
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-frames-'))
const PORT = 9233

if (WITH_VAULT) {
  /* 库：放几篇真实内容的笔记，让编辑器、大纲、预览都有东西渲染 */
  const vault = path.join(home, 'documents', 'Nota')
  fs.mkdirSync(vault, { recursive: true })
  const demoDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w):/, '$1:')), '..', 'demo')
  try {
    for (const f of fs.readdirSync(demoDir)) fs.copyFileSync(path.join(demoDir, f), path.join(vault, f))
  } catch {
    fs.writeFileSync(path.join(vault, '第一篇笔记.md'), '# 笔记\n\n一些**内容**，让界面有东西可画。\n')
  }
  /* 指针：NOTA_HOME 下 LOCAL_APP_DATA = <home>\local */
  const pointerDir = path.join(home, 'local', 'Nota')
  fs.mkdirSync(pointerDir, { recursive: true })
  fs.writeFileSync(
    path.join(pointerDir, 'vault.json'),
    JSON.stringify({ root: vault, at: Date.now() }, null, 2) + '\n',
  )
  console.log('假工作区就绪:', vault)
}

const child = spawn(exe, [`--remote-debugging-port=${PORT}`], {
  cwd: path.dirname(exe),
  env: { ...process.env, NOTA_HOME: home },
  stdio: 'ignore',
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function mainPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url))
      if (page) return page
    } catch {}
    await sleep(300)
  }
  return null
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res) => {
        const id = ++seq
        pending.set(id, res)
        ws.send(JSON.stringify({ id, method, params }))
      }),
      close: () => ws.close(),
    }),
    ws.onerror = reject
  })
}

const target = await mainPage()
if (!target) { console.error('没等到主窗口'); process.exit(1) }
console.log('主窗口已起，开始逐帧抓 6 秒…')

const c = await cdp(target.webSocketDebuggerUrl)
let n = 0
const t0 = Date.now()
c.send('Page.enable').catch(() => {})
c.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }).catch(() => {})

/* screencast 回调里存帧 */
const wsRaw = undefined // 占位：cdp() 没暴露原始 ws，改用轮询 captureScreenshot

/* 更可靠：以 90ms 间隔轮询 captureScreenshot（避免丢帧逻辑干扰） */
while (Date.now() - t0 < 6000) {
  try {
    const shot = await c.send('Page.captureScreenshot', { format: 'png' })
    const t = Date.now() - t0
    fs.writeFileSync(path.join(outDir, `f${String(n).padStart(3, '0')}-${t}ms.png`), Buffer.from(shot.result.data, 'base64'))
    n++
  } catch { break }
  await sleep(60)
}
console.log(`共抓 ${n} 帧 → ${outDir}`)
await c.close()
child.kill()
await sleep(400)
fs.rmSync(home, { recursive: true, force: true })
process.exit(0)
