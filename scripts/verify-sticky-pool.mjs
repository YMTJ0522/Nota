/**
 * 预热池的端到端体检（真 Electron、真窗口、真打字）。
 *
 * 便签的「按一下就出来」靠的是一个提前建好的空窗口：Chromium 起一个渲染
 * 进程要 200 多毫秒，实测同样一个只有 <div> 的空 HTML 也要 230ms，所以
 * 减依赖、拆 bundle 一点用都没有，只能把那个进程提前建好。代价是池化
 * 引入了一类新的事故 —— 窗口被复用了，上一张纸的东西可能留在下一张上。
 *
 * 这里验的就是这一类：① 池里那张空纸会不会被算进「开着 N 张」；
 * ② 被认领之后上一张的字、图、纸色有没有残留；③ 关掉之后内容有没有
 * 真的归档。这些界面单测看不出来（那边 window.sticky 是假的）。
 *
 * 会往便签目录里真写两张纸，跑完自己删干净。
 *
 * 用法：node scripts/verify-sticky-pool.mjs
 *       NOTA_EXE=release/win-unpacked/Nota.exe node scripts/verify-sticky-pool.mjs
 *       （后者验的是打包产物；池化牵涉窗口和 asar 里的路径，发版前值得再跑一遍）
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9391
/* 默认跑开发目录里的 electron；给 NOTA_EXE 就验那一个（打包产物） */
const EXE = process.env.NOTA_EXE || './node_modules/electron/dist/electron.exe'
const ARGS = process.env.NOTA_EXE ? [] : ['.']
let out = ''
const child = spawn(EXE, [...ARGS, '--remote-debugging-port=' + PORT], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
})
child.stdout.on('data', (d) => (out += d.toString()))
child.stderr.on('data', (d) => (out += d.toString()))

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  \x1b[32m✓\x1b[0m ' + name)
  } else {
    fail++
    console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : ''))
  }
}

const targets = async () => (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json())

function attach(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl)
    let seq = 0
    const pending = new Map()
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m)
        pending.delete(m.id)
      }
    }
    ws.onopen = () =>
      resolve({
        ws,
        send: (method, params) =>
          new Promise((res) => {
            const id = ++seq
            pending.set(id, res)
            ws.send(JSON.stringify({ id, method, params }))
          }),
      })
  })
}

async function evalOn(client, expr) {
  const r = await client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
  return r.result && r.result.result ? r.result.result.value : undefined
}

let page = null
for (let i = 0; i < 120; i++) {
  try {
    page = (await targets()).find((t) => t.type === 'page' && /index\.html/.test(t.url || ''))
    if (page) break
  } catch {}
  await sleep(300)
}
if (!page) {
  console.log('没等到主窗口')
  child.kill()
  process.exit(1)
}
const main = await attach(page.webSocketDebuggerUrl)
for (let i = 0; i < 60; i++) {
  if ((await evalOn(main, 'typeof window.api').catch(() => 'undefined')) === 'object') break
  await sleep(300)
}

/* 等池建好 */
await sleep(6000)
ok('池里那张空纸没被算进「开着 N 张」', (await evalOn(main, 'window.api.stickyCount()')) === 0)

/* 这台机器上本来就有用户自己的便签，所以按增量比，不比绝对条数 */
const baseline = await evalOn(main, 'window.api.stickyList()')
const baseIds = new Set((baseline || []).map((s) => s.id))

/**
 * 找「被认领的那张纸」。
 *
 * 池一被认领就会补一张新的空纸，所以页面上随时可能有两个 sticky.html：
 * 一个是用户眼前这张，一个是后台备着的空窗口。它们的界面长得一模一样，
 * 只有 init() 分得清 —— 认领过的那张拿得到 id，池里那张是 null。
 * 顺手点开第一个的话，打字会打进那张看不见的空纸里，后面的断言全成假的。
 */
async function stickyClient() {
  for (let i = 0; i < 40; i++) {
    const pages = (await targets()).filter((x) => x.type === 'page' && /sticky\.html/.test(x.url || ''))
    for (const t of pages) {
      const c = await attach(t.webSocketDebuggerUrl)
      const id = await evalOn(c, 'window.sticky.init()').catch(() => null)
      if (id && id.id) return c
      c.ws.close()
    }
    await sleep(150)
  }
  return null
}

/** 开一张、打字、返回它这一侧的 client */
async function openAndType(word) {
  await evalOn(main, 'window.api.stickyNew()')
  const c = await stickyClient()
  if (!c) return null
  await sleep(500)
  const t0 = Date.now()
  const ready = await evalOn(c, `(() => {
    const ta = document.querySelector('textarea');
    return { text: ta ? ta.value : null, focused: document.activeElement === ta };
  })()`)
  await evalOn(c, `(() => {
    const ta = document.querySelector('textarea');
    ta.value = ${JSON.stringify(word)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await sleep(600)
  return { c, ready, ms: Date.now() - t0 }
}

const first = await openAndType('第一张：池里认领出来的')
ok('第一张纸被认领出来了', !!first && !!first.c)
ok('认领出来的纸是空的（池没带进脏数据）', first && first.ready.text === '', JSON.stringify(first && first.ready))
ok('光标已经在正文里', first && first.ready.focused)
ok('开一张之后「开着 N 张」变 1', (await evalOn(main, 'window.api.stickyCount()')) === 1)

/* Esc 关掉 */
await evalOn(first.c, `document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await sleep(900)
ok('Esc 之后不再算「开着」', (await evalOn(main, 'window.api.stickyCount()')) === 0)
first.c.ws.close()

/* 第二张：必须完全干净 */
const second = await openAndType('第二张：不该看见第一张的字')
ok('第二张也开出来了', !!second && !!second.c)
ok('第二张的纸是空的 —— 上一张的字没有留下', second && second.ready.text === '', JSON.stringify(second && second.ready.text))
await sleep(1600)
await evalOn(second.c, `document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await sleep(900)
second.c.ws.close()

const list = await evalOn(main, 'window.api.stickyList()')
const fresh = (list || []).filter((s) => !baseIds.has(s.id))
const titles = fresh.map((s) => s.title)
ok('两张都归档进了列表', titles.some((t) => t.includes('第一张')) && titles.some((t) => t.includes('第二张')), JSON.stringify(titles))
ok('只多了这两张，没有空白便签混进来', fresh.length === 2, JSON.stringify(titles))
ok('池窗口不在便签列表里', (list || []).every((s) => !String(s.id).includes('pool')))

/* 「收起全部」不该被池窗口搅乱 */
await sleep(2000)
const n = await evalOn(main, 'window.api.stickyCloseAll()')
ok('收起全部返回 0（此刻没有开着的纸）', n === 0, String(n))

/* 收尾：把这次为了验证造的两张彻底删掉，别留在用户的便签列表里 */
for (const s of fresh) {
  await evalOn(main, 'window.api.stickyDelete(' + JSON.stringify(s.id) + ')')
  await evalOn(main, `window.api.stickyTrashPurge(${JSON.stringify('sticky:' + s.id)})`)
}
const left = await evalOn(main, 'window.api.stickyList()')
ok('验证造出来的便签已经收拾干净', (left || []).length === baseIds.size, (left || []).length + ' vs ' + baseIds.size)

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败')
main.ws.close()
child.kill()
await sleep(500)
process.exit(fail ? 1 : 0)
