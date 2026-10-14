/**
 * 无头 Edge + CDP 的公共脚手架。
 *
 * 前面 round 脚本各自抄了一份「起静态服务器 → 拉起 headless Edge → 连 CDP」的样板，
 * 每加一处探针就要再抄一遍，改一处（比如换端口、加 deviceScaleFactor）要改十几份。
 * 这里把它抽成一份：`launch()` 出来直接拿 `evaluate / send / sleep / shot / close`。
 *
 * 刻意不做的事：
 *  - 不注入任何假数据（各脚本的业务假 IPC 差异太大，留在调用方）
 *  - 不跑断言（`ok()` 那种输出格式各脚本自己定）
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { purgeStale, removeProfile } from './tmp-profiles.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/* WEB_ROOT 允许换一个静态根目录：剖析时需要一份**未压缩**的构建
   （minify 会把函数名抹掉，CPU profile 里只剩一堆无意义的 fn），
   那份临时产物放 dist-prof，正常产物仍是 dist。 */
const distDir = path.join(root, process.env.WEB_ROOT || 'dist')

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/**
 * 起服务器 + 浏览器，返回一组操作句柄。
 *
 * @param {object} [opts]
 * @param {number} [opts.port]      静态服务器端口
 * @param {number} [opts.cdpPort]   CDP 端口
 * @param {number} [opts.scale]     deviceScaleFactor，截图要看清细节就设 2
 * @param {[number,number]} [opts.size] 视口尺寸
 */
export async function launch(opts = {}) {
  const PORT = opts.port ?? 4390
  const CDP_PORT = opts.cdpPort ?? 9900 + (Date.now() % 90)
  const scale = opts.scale ?? 1
  const [W, H] = opts.size ?? [1500, 1000]

  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0])
    let file = path.join(distDir, rel === '/' ? 'index.html' : rel)
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(distDir, 'index.html')
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  const purged = purgeStale()
  if (purged.removed || purged.skipped) console.log('[tmp] 清掉过期 profile:', JSON.stringify(purged))

  const PROFILE = path.join(root, `.tmp-cdp-${Date.now()}-${Math.floor(Math.random() * 1000)}`)
  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
      `--window-size=${W},${H}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  async function pageTarget() {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
        const list = await r.json()
        const p = list.find((t) => t.type === 'page')
        if (p) return p
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('edge 没起来')
  }

  const page = await pageTarget()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const errors = []
  const listeners = []
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result)
      pending.delete(m.id)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(
        'EXC ' +
          (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300),
      )
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('ERR ' + m.params.args.map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300))
    }
    for (const fn of listeners) fn(m)
  })
  await new Promise((r) => ws.addEventListener('open', r))

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      pending.set(myId, resolve)
      setTimeout(() => reject(new Error('cdp timeout ' + method)), 30000)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description ?? ''))
    return r.result.value
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** 整页截图，返回 PNG 的 base64 */
  async function shotBase64(clip) {
    const r = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    })
    return r.data
  }

  /** 截图存盘，返回文件路径 */
  async function shot(file, clip) {
    const data = await shotBase64(clip)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }

  /** 量某个选择器的盒子（视口坐标，已乘 scale 之前的值） */
  const boxOf = async (selector) =>
    evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null; const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: W,
    height: H,
    deviceScaleFactor: scale,
    mobile: false,
  })

  async function close() {
    try {
      ws.close()
    } catch {
      /* 忽略 */
    }
    try {
      edge.kill()
    } catch {
      /* 忽略 */
    }
    try {
      server.close()
    } catch {
      /* 忽略 */
    }
    removeProfile(PROFILE)
  }

  return { send, evaluate, sleep, shot, shotBase64, boxOf, errors, close, port: PORT, on: (fn) => listeners.push(fn) }
}
