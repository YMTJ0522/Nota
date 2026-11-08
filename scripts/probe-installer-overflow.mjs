/**
 * 安装窗溢出探针：查「点打开 Nota 时安装界面闪一下的竖杠滚动条」。
 *
 * 两轮：
 *   第 1 轮 mock launch（窗口不退）——渲染层完整走 welcome → busy → done →
 *          点「打开 Nota」，16ms 采样溢出 + 60ms 截帧，事后读溢出日志。
 *   第 2 轮 真 launch —— 恢复真实 api，再点一次，抓进程退出瞬间的帧。
 *
 *   node scripts/probe-installer-overflow.mjs <Setup.exe> <帧输出目录>
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const exe = process.argv[2]
const outDir = process.argv[3]
if (!exe || !outDir) {
  console.error('用法: node probe-installer-overflow.mjs <Setup.exe> <outdir>')
  process.exit(2)
}
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

delete process.env.ELECTRON_RUN_AS_NODE
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-iprobe-'))
const PORT = 9235

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
        /* 5 秒兜底：CDP 偶尔丢回包，别让整个脚本吊死 */
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); res({ timeout: true }) }
        }, 5000)
      }),
      close: () => ws.close(),
    }),
    ws.onerror = reject
  })
}

const target = await installerTarget()
if (!target) { console.error('没等到安装窗'); process.exit(1) }
console.log('安装窗已起')
const c = await cdp(target.webSocketDebuggerUrl)
await c.send('Page.enable')

const SAMPLER = `
window.__olog = window.__olog || [];
(function tick() {
  try {
    const de = document.documentElement, b = document.body;
    const screen = [...document.querySelectorAll('.screen')].find(s => !s.hidden);
    const e = { t: Date.now() };
    if (de) { e.deV = de.scrollHeight > de.clientHeight + 1; e.deH = de.scrollWidth > de.clientWidth + 1 }
    if (b) { e.bV = b.scrollHeight > b.clientHeight + 1; e.bH = b.scrollWidth > b.clientWidth + 1 }
    if (screen) {
      e.sV = screen.scrollHeight > screen.clientHeight + 1;
      e.sH = screen.scrollWidth > screen.clientWidth + 1;
      e.sh = screen.scrollHeight; e.ch = screen.clientHeight;
      e.id = screen.id;
    }
    if (e.deV || e.deH || e.bV || e.bH || e.sV || e.sH) window.__olog.push(e);
  } catch {}
  setTimeout(tick, 16);
})();
`
await c.send('Page.addScriptToEvaluateOnNewDocument', { source: SAMPLER }).catch(() => {})
await c.send('Runtime.evaluate', { expression: SAMPLER }).catch(() => {})

/* 后台截帧循环：跑到进程退出为止 */
let n = 0
const t0 = Date.now()
const stopFrames = { v: false }
;(async () => {
  while (!stopFrames.v) {
    try {
      const shot = await c.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(
        path.join(outDir, `f${String(n).padStart(3, '0')}-${Date.now() - t0}ms.png`),
        Buffer.from(shot.result.data, 'base64'),
      )
      n++
    } catch { break }
    await sleep(60)
  }
})()

/* ── 第 1 轮：假 start + 假 launch，完整走 UI ── */
const MOCK = `
(() => {
  const real = window.notaInstall;
  window.__realLaunch = real.launch;
  real.start = async () => ({
    ok: true,
    exe: '',
    dir: 'C:\\\\Users\\\\ymtj1\\\\AppData\\\\Local\\\\Programs\\\\Nota',
    notes: 'C:\\\\Users\\\\ymtj1\\\\Documents\\\\Nota',
    bytes: 71378855,
  });
  real.launch = async () => 'mocked-launch';
  document.querySelector('#w-go').click();
  return 'mocked-start';
})()
`
await c.send('Runtime.evaluate', { expression: MOCK })
console.log('假安装已走完，等 done 屏稳定…')
await sleep(2500)

/* 点「打开 Nota」（launch 是 mock 的，窗口不会退） */
await c.send('Runtime.evaluate', { expression: `document.querySelector('#d-open').click()` })
console.log('第 1 轮：已点「打开 Nota」（mock launch），观察 2 秒')
await sleep(2000)

/* 读溢出日志 */
const r = await c.send('Runtime.evaluate', {
  expression: 'JSON.stringify({ log: window.__olog, frames: window.__olog.length })',
  returnByValue: true,
}).catch(() => null)
if (!r || r.timeout) console.log('⚠ 读日志的 evaluate 没回包')
const log = JSON.parse(r?.result?.result?.value || '{"log":[]}').log
if (log.length) {
  console.log(`⚠ 采样到 ${log.length} 次溢出帧：`)
  for (const e of log.slice(0, 15)) {
    console.log(`  ${e.id} 纵向=${!!(e.deV || e.bV || e.sV)} 横向=${!!(e.deH || e.bH || e.sH)} screen[sh=${e.sh} ch=${e.ch}]`)
  }
} else {
  console.log('✓ 第 1 轮：welcome→busy→done→点打开 全程无溢出（渲染层没有滚动条闪现）')
}

/* ── 第 2 轮：真 launch，抓退出瞬间 ── */
console.log('第 2 轮：恢复真 launch 再点一次…')
await c.send('Runtime.evaluate', {
  expression: `window.notaInstall.launch = window.__realLaunch; document.querySelector('#d-open').click()`,
}).catch((e) => console.log('点击失败:', String(e).slice(0, 120)))
const exited = await Promise.race([
  new Promise((r2) => child.once('exit', () => r2(true))),
  sleep(6000).then(() => false),
])
console.log(exited ? '✓ 进程已退出' : '⚠ 6 秒未退出')
stopFrames.v = true
await sleep(300)

console.log(`共 ${n} 帧 → ${outDir}`)
try { await c.close() } catch {}
try { child.kill() } catch {}
await sleep(300)
try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
try { fs.rmSync(path.join(process.env.LOCALAPPDATA ?? '', 'Nota', 'install-handoff'), { force: true }) } catch {}
process.exit(0)
