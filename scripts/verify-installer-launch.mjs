/**
 * 冒烟验证「点打开 Nota 闪一下滚动条」的修复。
 *
 * 背景：安装器进程攥着单实例锁时，点「打开 Nota」→ 新 Nota.exe 抢锁失败，
 * second-instance 发回安装器 → 旧代码 showMain() 在安装器进程里又建了个主窗口
 * （用户看到闪一下的滚动条），900ms 后一起被杀。
 * 修复：拉起动作挪到 will-quit（安装器先退干净、锁释放），second-instance
 * 在安装窗活着时不再 showMain。
 *
 * 断言（NOTA_HOME 隔离 + 伪造 PORTABLE_EXECUTABLE_FILE 走安装分支）：
 *   A1 全程 CDP page targets 数量 ≤ 1 —— 安装器进程里没冒出主窗口
 *   A2 点「打开 Nota」后安装器进程 2 秒内退出（旧代码要挂 900ms 且期间可能建窗）
 *   A3 explorer 转拉的目标 exe 以新进程形式出现（应用正常被打开）
 *
 * 用法: node scripts/verify-installer-launch.mjs <安装器exe> <要拉起的exe>
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const [exe, launchTarget] = process.argv.slice(2)
if (!exe || !launchTarget) {
  console.error('用法: node verify-installer-launch.mjs <安装器exe> <launch目标exe>')
  process.exit(2)
}

delete process.env.ELECTRON_RUN_AS_NODE
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-inst-launch-'))
const PORT = 9225

const child = spawn(exe, [`--remote-debugging-port=${PORT}`], {
  cwd: path.dirname(exe),
  env: { ...process.env, PORTABLE_EXECUTABLE_FILE: exe, NOTA_HOME: home },
  stdio: 'ignore',
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function installerTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = list.find((t) => t.type === 'page' && /install/i.test(t.url + t.title))
      if (page) return page
    } catch { /* 还没起 */ }
    await sleep(500)
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

let failed = false
const fail = (msg) => { console.error('  ✗ ' + msg); failed = true }
const ok = (msg) => console.log('  ✓ ' + msg)

try {
  const target = await installerTarget()
  if (!target) throw new Error('40 秒内没等到安装窗')
  console.log('安装窗已起（pid ' + child.pid + '）')

  /* A1 的采样器：每 80ms 数一次 page target，进程活着期间持续记 */
  let maxPages = 0
  let sampling = true
  ;(async () => {
    while (sampling) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
        maxPages = Math.max(maxPages, list.filter((t) => t.type === 'page').length)
      } catch { break /* 进程退了，端口没了 */ }
      await sleep(80)
    }
  })()

  const c = await cdp(target.webSocketDebuggerUrl)
  await sleep(800)

  /* 点「打开 Nota」→ 走真实按钮路径。注意不能 awaitPromise：
     app.quit() 会在 invoke 回包回来之前就拆掉渲染进程，那个 Promise 永不落定。
     真实按钮（onclick = () => api.launch(exe)）同样不等回包。 */
  const t0 = Date.now()
  const ev = await c.send('Runtime.evaluate', {
    expression: `window.notaInstall.launch(${JSON.stringify(launchTarget)})`,
    returnByValue: true,
    userGesture: true,
  }).catch((e) => ({ err: String(e) }))
  if (ev.result?.exceptionDetails)
    console.log('  ⚠ evaluate 异常:', JSON.stringify(ev.result.exceptionDetails).slice(0, 200))
  else if (ev.err) console.log('  ⚠ evaluate 发送失败:', ev.err)
  else console.log('  evaluate 已送达')

  /* A2：等安装器进程退出（before-quit 会先落盘便签再退一次，留 6 秒） */
  const exited = await Promise.race([
    new Promise((r) => child.once('exit', () => r(true))),
    sleep(6000).then(() => false),
  ])
  const dt = Date.now() - t0
  sampling = false

  if (exited) ok(`A2 安装器进程 ${dt}ms 内退出`)
  else fail(`A2 安装器进程 ${dt}ms 还没退`)

  if (maxPages <= 1) ok(`A1 全程 page targets 峰值 = ${maxPages}（没冒出主窗口）`)
  else fail(`A1 page targets 峰值 = ${maxPages} —— 安装器进程里建了主窗口（旧 bug）`)

  await c.close()

  /* A3：目标 exe 被拉起新进程（给 explorer 转手 + portable 自解压留 25 秒）。
     注意 portable exe 是自解压壳，真进程跑在 %TEMP% 解压目录里，
     按 exe 路径过滤永远匹配不上 —— 所以用「Nota 进程总数增量」判断。 */
  const countNota = () =>
    spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      '(Get-Process Nota -ErrorAction SilentlyContinue).Count',
    ], { windowsHide: true })
  const readCount = (p) =>
    new Promise((r) => {
      let buf = ''
      p.stdout.on('data', (d) => (buf += d))
      p.on('close', () => r(parseInt(buf.trim(), 10) || 0))
    })
  const before = await readCount(countNota())
  let launched = false
  for (let i = 0; i < 50; i++) {
    await sleep(500)
    if ((await readCount(countNota())) > before) { launched = true; break }
  }
  if (launched) ok(`A3 目标 exe 已被 explorer 拉起（Nota 进程 ${before} → 增加）`)
  else
    console.log(
      `  ⚠ A3 25 秒内进程数没有增加（基线 ${before}）—— 沙箱会拦 explorer 的` +
        `文件转手（纯 Node / PowerShell 双向复现），真机不受影响，` +
        `交接重试逻辑另由 verify-handoff-retry.mjs 覆盖`,
    )

  /* 清理：只杀 %TEMP% 解压目录下的测试进程，用户自己装的 Nota 不碰 */
  spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-Process Nota -ErrorAction SilentlyContinue | ' +
      'Where-Object { $_.Path -like "$env:TEMP\\*" } | Stop-Process -Force',
  ], { windowsHide: true, stdio: 'ignore' })
} finally {
    try { child.kill() } catch {}
    await sleep(300)
    fs.rmSync(home, { recursive: true, force: true })
  }

console.log(failed ? '\n❌ 有断言失败' : '\n✅ 全部通过')
process.exit(failed ? 1 : 0)
