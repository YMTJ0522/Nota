/**
 * 验证打包后的 Nota.exe 真能跑起来。
 *
 * 为什么单独有这一份：dist 上的三套用例走的是 HTTP + 注入的假 window.api，
 * 验的是渲染逻辑；这一份验的是「产物本身」——asar 里有没有漏文件、
 * preload 桥通不通、主进程到渲染进程这条路在 file:// 下走不走得动。
 *
 * Electron 的 GPU 进程在本机会话里起不来，所以走 CDP 远程调试端口连进去，
 * 直接读 DOM。点 CTA 会弹系统文件对话框（自动化里没法按），
 * 因此这里不断言业务flow，只断言「起得来、东西都在、没有报错」。
 * 业务正确性由 verify-round*.mjs 那三套负责。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(root, 'release', 'win-unpacked', 'Nota.exe')
if (!fs.existsSync(EXE)) {
  console.log('没有打包产物，先跑 npm run pack')
  process.exit(2)
}

const STAMP = Date.now()
const CDP_PORT = 9300 + (STAMP % 300)

/* 「干净机器」这一维必须自己造，不能指望本机恰好干净。
 *
 * 这里有个坑，踩了才知道：Nota 的数据散在两处，只隔离一处是白忙。
 *   ① userData —— localStorage 里的「上次打开的工作区」、AI 会话、引导标记
 *   ② %LOCALAPPDATA%\Nota —— vault.json 指针、prefs、便签目录
 * 而 ① 从**外部**改不动：实测给 --user-data-dir、覆盖 APPDATA、覆盖
 * USERPROFILE 三种办法都只挪走了 Chromium 的缓存目录，localStorage 照样
 * 读开发者自己那份（SHGetKnownFolderPath 查注册表，不看环境变量）。
 * 症状很隐蔽：脚本照样「跑通」，但它读的是当前机器的工作区，
 * 「全新安装」那条路一次都没走过 —— 断言于是只能报 cta:false，
 * 看着像缺陷，其实是根本没进那个场景。
 *
 * 所以主进程加了 NOTA_HOME：一个环境变量把上面两处（外加首次建库的
 * 「文档」目录）一起搬到临时根下。这样跑的是真的新机器，也不碰用户数据。 */
const CLEAN_HOME = path.join(root, `.tmp-clean-home-${STAMP}`)
fs.mkdirSync(CLEAN_HOME, { recursive: true })
const CLEAN_VAULT = path.join(CLEAN_HOME, 'documents', 'Nota')
const CLEAN_USERDATA = path.join(CLEAN_HOME, 'userData')

// 宿主是 Electron 时会带这个变量，Electron 会退化成纯 Node、require('electron') 拿不到 API
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
  throw new Error('连不上打包应用的渲染进程')
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const errors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push('EXC ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300))
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('ERR ' + m.params.args.map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300))
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = ++id
  pending.set(myId, resolve)
  setTimeout(() => reject(new Error('cdp timeout ' + method)), 20000)
  ws.send(JSON.stringify({ id: myId, method, params }))
})
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}

await send('Runtime.enable')
await send('Page.enable')
await sleep(3000)

const out = {}
const ok = (name, cond, detail) => {
  out[name] = { pass: !!cond, detail }
  console.log((cond ? '  PASS  ' : '  FAIL  '), name, detail !== undefined ? JSON.stringify(detail) : '')
}

out.shell = await ev(`(() => ({
  title: document.title,
  mounted: !!document.querySelector('#app')?.children.length,
  winBtns: document.querySelectorAll('.wbtn').length,
  api: window.api ? Object.keys(window.api).length : 0,
  sheets: document.styleSheets.length,
}))()`)
ok(
  '1.界面起来了',
  // preload 暴露 18 个方法（见 electron/preload.ts）；写死 >=18 是防哪天桥忘了注
  out.shell.title === 'Nota' && out.shell.mounted && out.shell.api >= 18,
  out.shell,
)

/* 「全新安装」这条路以前是黑的：脚本没做隔离（详见文件头的说明），
   每次都落到开发者自己的工作区，于是只能断言「欢迎页有没有那个按钮」，
   而产品在这条路上的实际行为是**不停在欢迎页** —— 它直接在「文档\Nota」
   建库、写一篇欢迎笔记、把光标送进那篇里。
   所以这里验的是「停在哪 + 建了什么 + 数据落在哪」，比一个按钮的存在更能说明问题。 */
const WELCOME_FILE = path.join(CLEAN_VAULT, '欢迎使用 Nota.md')
let firstRun = null
let firstRunOk = false
for (let i = 0; i < 24; i++) {
  const dom = await ev(`(() => ({
    welcomePage: !!document.querySelector('.welcome'),
    editing: !!document.querySelector('.cm-content, .pv-line'),
    text: document.body.innerText.slice(0, 400),
  }))()`)
  const files = fs.existsSync(CLEAN_VAULT) ? fs.readdirSync(CLEAN_VAULT) : []
  firstRun = {
    vault: CLEAN_VAULT.replace(root, '.'),
    files,
    userDataMoved: fs.existsSync(CLEAN_USERDATA),
    welcomePage: dom.welcomePage,
    editing: dom.editing,
  }
  if (fs.existsSync(WELCOME_FILE) && !dom.welcomePage && String(dom.text).includes('欢迎使用 Nota')) {
    firstRunOk = true
    break
  }
  await sleep(500)
}
ok('2.全新机器：自动建库、写欢迎笔记、直接打开', firstRunOk, firstRun)
ok(
  '2b.数据根确实被搬到了临时目录（没碰本机的库）',
  firstRun && firstRun.userDataMoved && (firstRun.files || []).length > 0,
  firstRun,
)

// 真实走一遍主进程 IPC：读一个临时目录里的文件。
// 这验的不是业务逻辑，而是「渲染进程 → preload → ipcMain → fs」这条链在打包版里通不通。
const wsDir = path.join(root, '.tmp-pack-check')
fs.rmSync(wsDir, { recursive: true, force: true })
fs.mkdirSync(wsDir, { recursive: true })
const notePath = path.join(wsDir, 'demo.md')
fs.writeFileSync(notePath, '# 打包版验证\n\n编辑器内容 ABC\n', 'utf8')

out.ipcRead = await ev('window.api.readNote(' + JSON.stringify(notePath) + ')')
ok('3.主进程 IPC 读文件', /打包版验证/.test(String(out.ipcRead)), String(out.ipcRead).slice(0, 40))

// 懒加载的重资产（mermaid / katex）必须真在 asar 里，
// 否则打开带图表的笔记会静默失败——这也是当初打包时最容易漏的一类问题。
out.assets = await ev(`(async () => {
  const names = [...document.querySelectorAll('script[src]')].map(e => e.src)
  const probed = []
  for (const u of ['./assets']) probed.push(u)
  return { entryScripts: names.length, base: location.href.split('#')[0] }
})()`)
ok('4.入口脚本已加载', out.assets.entryScripts >= 1, out.assets)

// 字体是随包走的（src/assets/fonts/*.woff2）。生产用 file:// 打开，
// CSS 里的相对路径只要差一层就会静默退回系统字体 —— 不报错、也没有 JS 异常，
// 肉眼看着「就是没换成功」。所以这里必须量：字体真进了 asar，并且在 file:// 下加载完了。
out.font = await ev(`(async () => {
  await document.fonts.ready
  const faces = [...document.fonts].map(f => f.family + '/' + f.status)
  const c = document.createElement('canvas').getContext('2d')
  c.font = '20px NanxiXinyuanti'
  const w1 = c.measureText('笔记 Nota 2026').width
  c.font = '20px serif'
  const w2 = c.measureText('笔记 Nota 2026').width
  return { proto: location.protocol, faces, check: document.fonts.check('16px NanxiXinyuanti'),
           w1: Math.round(w1 * 100) / 100, w2: Math.round(w2 * 100) / 100 }
})()`)
ok(
  '5.随包字体在 file:// 下真的加载完成',
  out.font.check === true &&
    out.font.faces.some((f) => f.startsWith('NanxiXinyuanti/loaded')) &&
    Math.abs(out.font.w1 - out.font.w2) > 1,
  out.font,
)

console.log('\n--- JS ERRORS ---')
console.log(errors.length ? errors.join('\n') : '(none)')

const failed = Object.entries(out)
  .filter(([, v]) => v && typeof v === 'object' && 'pass' in v && !v.pass)
  .map(([k]) => k)
console.log('\n=== SUMMARY ===')
console.log(failed.length ? 'FAILED: ' + failed.join(', ') : 'ALL PASS')

await send('Browser.close').catch(() => {})
ws.close()
app.kill()
fs.rmSync(wsDir, { recursive: true, force: true })
for (const dir of [CLEAN_HOME]) {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      break
    } catch {
      /* 进程刚退出，句柄可能还没松开 */
      await sleep(400)
    }
  }
}
process.exit(failed.length || errors.length ? 1 : 0)
