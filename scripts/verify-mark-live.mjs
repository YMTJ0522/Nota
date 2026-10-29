/**
 * 真·主进程 + 真界面验证：标记完图标，便签墙和左边那一列有没有立刻变。
 *
 * 为什么不能像别的 round 那样用假 IPC：这条 bug 的性质就是「界面拿到的主进程
 * 数据对不对」，而且它只在**真实点击顺序**下复现。假 IPC 里 `stickyPatch`
 * 是我自己写的，它当然会立刻生效 —— 那就等于自己证明自己。
 *
 * 所以这里跑真 Electron：真便签目录（造两张纸）、真 IPC、真右键菜单。
 *
 * 判据四条：
 *  ① 点图标后 index.json 里立刻有这一枚（写盘那步没被跳过）
 *  ② 便签墙上那张卡立刻从「纸色圆点」变成图标（右侧实时更新）
 *  ③ 点「完成」关掉弹窗后仍然在（不是关窗时才补画）
 *  ④ 左边列表那条也跟着变（两边读的是同一份数据）
 *
 * 用法：node scripts/verify-mark-live.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, '.tmp-mark-live')
const LOCAL = path.join(TMP, 'local')
const VAULT = path.join(TMP, 'vault')
const UD = path.join(TMP, 'ud')
/* 便签从 2.8.0 起跟着库走（`<库>/.nota/stickies`）。这里原来种在
   `LOCALAPPDATA\Nota\stickies` —— 那是 2.8.0 之前的位置，种进去只会在启动时
   被搬一次，之后读的、写的都是库里那份，于是「写盘了」这条永远是红的。 */
const STICKIES = path.join(VAULT, '.nota', 'stickies')
const PORT = 9455

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 一张干净的靶子 ── */
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(STICKIES, { recursive: true })
fs.mkdirSync(VAULT, { recursive: true })
fs.mkdirSync(UD, { recursive: true })
/* vault.json 这个指针还在机器目录里（它记的是「上次开哪个库」，跟库无关） */
fs.mkdirSync(path.join(LOCAL, 'Nota'), { recursive: true })
/* vault.json 这个指针还在机器目录里（它记的是「上次开哪个库」，跟库无关） */
fs.mkdirSync(path.join(LOCAL, 'Nota'), { recursive: true })
fs.writeFileSync(
  path.join(LOCAL, 'Nota', 'vault.json'),
  `${JSON.stringify({ root: VAULT.replace(/\\/g, '/'), at: Date.now() }, null, 2)}\n`,
  'utf8',
)
const now = Date.now()
const seed = [
  { id: 'mk1', color: 'amber', tags: ['前端'], text: '重构编辑器的滚动同步\n两层要对齐。' },
  { id: 'mk2', color: 'sky', tags: [], text: '第二张，用来确认只改了被点的那一张' },
]
fs.writeFileSync(
  path.join(STICKIES, 'index.json'),
  `${JSON.stringify(seed.map((s) => ({ id: s.id, color: s.color, tags: s.tags, createdAt: now, updatedAt: now })), null, 2)}\n`,
  'utf8',
)
for (const s of seed) fs.writeFileSync(path.join(STICKIES, `${s.id}.md`), s.text, 'utf8')

const readIcons = () => {
  const arr = JSON.parse(fs.readFileSync(path.join(STICKIES, 'index.json'), 'utf8'))
  return Object.fromEntries(arr.map((m) => [m.id, m.icon ? `${m.icon.kind}:${m.icon.id}` : '']))
}

/* ── 起真应用 ── */
const env = { ...process.env, LOCALAPPDATA: LOCAL.replace(/\\/g, '/') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(
  electronPath,
  ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD.replace(/\\/g, '/')}`],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
)
let appLog = ''
child.stdout.on('data', (d) => (appLog += String(d)))
child.stderr.on('data', (d) => (appLog += String(d)))

async function waitTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const hit = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (hit) return hit
    } catch {
      /* 还没起来 */
    }
    await sleep(400)
  }
  throw new Error('应用没起来：\n' + appLog.slice(-800))
}

let ws
const pending = new Map()
let seq = 0
const errors = []

function connect(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', reject)
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m)
        pending.delete(m.id)
      }
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
      }
    })
  })
}
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++seq
    pending.set(n, resolve)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) {
    return { __err: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text }
  }
  return r.result?.result?.value
}

const quit = async () => {
  try {
    ws?.close()
  } catch {
    /* 已经断了 */
  }
  child.kill()
  await sleep(600)
  // 主进程不一定肯立刻走（有托盘），再补一刀；路径挪进 .trash 而不是直接删
  try {
    process.kill(child.pid, 'SIGKILL')
  } catch {
    /* 已经没了 */
  }
  await sleep(300)
  const trash = path.join(ROOT, '.trash')
  fs.mkdirSync(trash, { recursive: true })
  try {
    fs.rmSync(path.join(trash, 'mark-live'), { recursive: true, force: true })
    fs.renameSync(TMP, path.join(trash, 'mark-live'))
  } catch {
    /* 被占用就算了，下次跑会自己清 */
  }
}

let exitCode = 0
try {
  const target = await waitTarget()
  await connect(target.webSocketDebuggerUrl)
  await send('Runtime.enable')
  await sleep(1800)

  /* 走到便签那一屏 */
  const nav = async (label) =>
    evaluate(`(() => {
      const b = [...document.querySelectorAll('.nav-item')].find((x) => (x.textContent || '').includes(${JSON.stringify(label)}));
      if (b) b.click();
      return !!b;
    })()`)
  await nav('所有笔记')
  await sleep(400)
  await nav('便签')
  await sleep(1200)

  /* 启动对账（reconcileOnBoot）会把「index 里没有 closedAt、但也没有窗口」的
     记录一律归档 —— 这个行为本身是对的（强杀进程后不留幽灵便签），只是意味着
     种进去的纸天然都是「已收起」态。左边那一列默认只列开着的，所以要先把
     底下那个抽屉展开，才看得到条目。 */
  await evaluate(`(() => {
    const b = document.querySelector('.sv-more');
    if (b && !b.classList.contains('open')) b.click();
    return !!b;
  })()`)
  await sleep(500)
  const listed = await evaluate(`document.querySelectorAll('.sv-item').length`)
  ok('左边列展开抽屉后能看到这两张', listed === 2, String(listed))

  const cards = await evaluate(`document.querySelectorAll('.sb-card').length`)
  ok('便签墙上有两张', cards === 2, String(cards))

  /* 右键第一张 → 标记… */
  /* 按标题找靶子那张，不认「第一张」：两张纸的 createdAt 一样，
     排序是并列的，谁在前不算行为的一部分。 */
  const title = await evaluate(`document.querySelector('.sb-card .sb-ctitle')?.textContent`)
  ok(
    '墙上有靶子那张',
    (await evaluate(`[...document.querySelectorAll('.sb-card .sb-ctitle')].some((t) => t.textContent === '重构编辑器的滚动同步')`)) === true,
    String(title),
  )
  const CARD = `[...document.querySelectorAll('.sb-card')].find((c) => c.querySelector('.sb-ctitle')?.textContent === '重构编辑器的滚动同步')`
  await evaluate(`(() => {
    const c = ${CARD};
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 40, clientY: r.y + 24 }));
  })()`)
  await sleep(300)
  const menuItems = await evaluate(`[...document.querySelectorAll('.ctx-item')].map((b) => (b.textContent || '').trim())`)
  ok('右键菜单里有「标记…」', Array.isArray(menuItems) && menuItems.some((t) => t.includes('标记')), JSON.stringify(menuItems))
  await evaluate(`[...document.querySelectorAll('.ctx-item')].find((x) => (x.textContent || '').includes('标记')).click()`)
  await sleep(500)
  ok('标记弹窗开了', (await evaluate(`!!document.querySelector('.sm')`)) === true)
  ok('弹窗上是这张纸的名字', (await evaluate(`document.querySelector('.sm-name')?.textContent`)) === '重构编辑器的滚动同步')

  /* 点第一枚图标 —— 只选，先不关弹窗 */
  const before = readIcons()
  const cells = await evaluate(`document.querySelectorAll('.ig-cell').length`)
  ok('图标格铺出来了', cells > 10, String(cells))
  const picked = await evaluate(`(() => {
    const b = document.querySelector('.ig-cell');
    const name = b.getAttribute('title') || b.textContent || '';
    b.click();
    return name;
  })()`)
  await sleep(900)

  const after = readIcons()
  ok('写盘了：这张纸上多了图标', !!after.mk1, JSON.stringify(after))
  ok('只改了被点的那一张', after.mk2 === '', JSON.stringify(after))

  const wallIcon = await evaluate(`${CARD}.querySelector('.sb-cico svg') !== null`)
  ok('便签墙上的卡片立刻换成了图标（不等关弹窗）', wallIcon === true, await evaluate(`${CARD}.querySelector('.sb-cico')?.innerHTML.slice(0, 60)`))
  ok('弹窗里那枚图标是高亮的', (await evaluate(`document.querySelectorAll('.ig-cell.cur').length`)) === 1)

  const listIcon = await evaluate(`[...document.querySelectorAll('.sv-item')].some((it) => it.querySelector('.sv-ico svg'))`)
  ok(
    '左边列表那一条也跟着变了',
    listIcon === true,
    await evaluate(`JSON.stringify({
      items: document.querySelectorAll('.sv-item').length,
      search: !!document.querySelector('.sv-search'),
      list: !!document.querySelector('.sv-list'),
      empty: document.querySelector('.sv-empty')?.textContent?.trim() ?? '',
      body: document.querySelector('.col-body')?.firstElementChild?.className ?? '空',
      ico: document.querySelector('.sv-item .sv-ico')?.innerHTML.slice(0, 60) ?? '没有 sv-ico'
    })`),
  )

  /* 点「完成」关掉弹窗，图标不能没 */
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.sm-btn')].find((x) => (x.textContent || '').trim() === '完成');
    if (b) b.click();
  })()`)
  await sleep(500)
  ok('弹窗关掉了', (await evaluate(`!!document.querySelector('.sm')`)) === false)
  ok('关掉之后卡片上的图标还在', (await evaluate(`${CARD}.querySelector('.sb-cico svg') !== null`)) === true)

  /* 去掉图标也得立刻回到圆点 */
  await evaluate(`(() => {
    const c = ${CARD};
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 40, clientY: r.y + 24 }));
  })()`)
  await sleep(250)
  await evaluate(`[...document.querySelectorAll('.ctx-item')].find((x) => (x.textContent || '').includes('标记')).click()`)
  await sleep(450)
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.sm-btn')].find((x) => (x.textContent || '').trim() === '去掉图标');
    if (b) b.click();
  })()`)
  await sleep(800)
  ok('去掉图标也写盘了', readIcons().mk1 === '', JSON.stringify(readIcons()))
  ok('去掉之后卡片回到纸色圆点', (await evaluate(`${CARD}.querySelector('.sb-cico .sb-seal') !== null`)) === true)

  ok('没有脚本报错', errors.length === 0, JSON.stringify(errors).slice(0, 300))
  console.log(`\n${pass} 通过 / ${fail} 失败`)
  if (fail) exitCode = 1
} catch (e) {
  console.log('\x1b[31m跑挂了\x1b[0m ' + (e?.stack ?? e))
  exitCode = 1
} finally {
  await quit()
}
process.exit(exitCode)
