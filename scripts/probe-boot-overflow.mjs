/**
 * 主应用启动溢出探针：查「点打开 Nota 后闪一下的竖杠」是不是
 * 主窗口 boot 时 body 短暂溢出冒出的滚动条。
 * Page.addScriptToEvaluateOnNewDocument 注入 16ms 采样器，
 * 启动稳定后读回 __overflowLog，看有没有任何一帧出现纵向/横向溢出。
 *   node scripts/probe-boot-overflow.mjs <Nota.exe> [--vault]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const exe = process.argv[2]
const WITH_VAULT = process.argv.includes('--vault')
if (!exe) { console.error('用法: node probe-boot-overflow.mjs <Nota.exe> [--vault]'); process.exit(2) }

delete process.env.ELECTRON_RUN_AS_NODE
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-probe-'))
const PORT = 9234

if (WITH_VAULT) {
  const vault = path.join(home, 'documents', 'Nota')
  fs.mkdirSync(vault, { recursive: true })
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w):/, '$1:')), '..')
  let copied = false
  try {
    const demoDir = path.join(root, 'demo')
    for (const f of fs.readdirSync(demoDir)) fs.copyFileSync(path.join(demoDir, f), path.join(vault, f))
    copied = true
  } catch {}
  if (!copied) fs.writeFileSync(path.join(vault, '第一篇笔记.md'), '# 笔记\n\n一些**内容**。\n')
  const pointerDir = path.join(home, 'local', 'Nota')
  fs.mkdirSync(pointerDir, { recursive: true })
  fs.writeFileSync(
    path.join(pointerDir, 'vault.json'),
    JSON.stringify({ root: vault, at: Date.now() }, null, 2) + '\n',
  )
  /* fresh 标记：模拟「装完第一次启动」——清界面状态 + 弹引导 */
  fs.writeFileSync(
    path.join(pointerDir, 'fresh-install.json'),
    JSON.stringify({ at: Date.now(), version: '3.9.4' }, null, 2) + '\n',
  )
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
    await sleep(200)
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
const c = await cdp(target.webSocketDebuggerUrl)
await c.send('Page.enable')

/* 采样器要在文档最早期就位 —— 但 target 出现时首帧文档可能已经在跑了。
   双保险：addScriptToEvaluateOnNewDocument（对之后的导航生效）+
   立刻手动注入一遍（对当前文档生效）。 */
const SAMPLER = `
window.__overflowLog = window.__overflowLog || [];
(function tick() {
  try {
    const de = document.documentElement, b = document.body;
    if (de && b) {
      const v = de.scrollHeight > de.clientHeight + 1 || b.scrollHeight > b.clientHeight + 1;
      const h = de.scrollWidth > de.clientWidth + 1 || b.scrollWidth > b.clientWidth + 1;
      if (v || h) window.__overflowLog.push({
        t: Date.now(), v, h,
        de: [de.scrollWidth, de.clientWidth, de.scrollHeight, de.clientHeight],
        b: b ? [b.scrollWidth, b.clientWidth, b.scrollHeight, b.clientHeight] : null,
      });
    }
  } catch {}
  setTimeout(tick, 16);
})();
`
await c.send('Page.addScriptToEvaluateOnNewDocument', { source: SAMPLER }).catch(() => {})
await c.send('Runtime.evaluate', { expression: SAMPLER }).catch(() => {})

/* 采样器就位后 reload 重放整个启动 —— 直接附着时首帧可能已经渲染完 */
await sleep(500)
await c.send('Page.reload').catch(() => {})
console.log('已 reload 重放启动，采样 8 秒…')

/* 等 8 秒让启动彻底稳定，再读日志 */
await sleep(8000)
const r = await c.send('Runtime.evaluate', {
  expression: 'JSON.stringify(window.__overflowLog || [])',
  returnByValue: true,
})
const log = JSON.parse(r.result?.result?.value || '[]')
console.log(`采样到 ${log.length} 次溢出帧`)
if (log.length) {
  for (const e of log.slice(0, 10)) {
    console.log(`  v=${e.v} h=${e.h} de=[sw${e.de[0]} cw${e.de[1]} sh${e.de[2]} ch${e.de[3]}] b=[${(e.b || []).join(' ')}]`)
  }
} else {
  console.log('✓ 整个启动过程 body/documentElement 没有出现过溢出（没有 viewport 滚动条）')
}

await c.close()
child.kill()
await sleep(400)
fs.rmSync(home, { recursive: true, force: true })
process.exit(0)
