/**
 * 验证预览区的图片 / 视频在真实环境里能加载。
 *
 * 为什么不在 dist 那套 HTTP 用例里验：那里的 window.api 是注入的假实现，
 * resolveMedia 返回的字符串看着对，但 nota-media:// 协议根本没注册——
 * 验了个寂寞。这一份用真的 Electron 跑真的主进程，协议、CSP、路径换算
 * 全都是生产链路。
 *
 * 覆盖：
 *  1. resolveMedia 返回 nota-media:// URL
 *  2. 图片经该协议真能解码（naturalWidth > 0）
 *  3. <video> 不被 CSP 拦（media-src 白名单在不在）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!fs.existsSync(ELECTRON)) {
  console.log('没有 electron 二进制，先 npm i')
  process.exit(2)
}

/* ── 造一个临时工作区，里面放真图片 ── */
const ws = path.join(root, '.tmp-media-check')
fs.rmSync(ws, { recursive: true, force: true })
fs.mkdirSync(path.join(ws, 'attachments'), { recursive: true })

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 手写一张纯色 PNG：不想为一张测试图引入图像库 */
function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  let p = 0
  for (let y = 0; y < h; y++) {
    raw[p++] = 0 // filter type: none
    for (let x = 0; x < w; x++) {
      raw[p++] = 0x3f
      raw[p++] = 0x6f
      raw[p++] = 0x5a
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

fs.writeFileSync(path.join(ws, 'attachments', 'pic.png'), makePng(64, 32))
// 视频只验「有没有被 CSP 拦」，内容是不是真视频不影响结论
fs.writeFileSync(path.join(ws, 'attachments', 'clip.mp4'), Buffer.alloc(64, 7))

const CDP_PORT = 9300 + (Date.now() % 300)
const PROFILE = path.join(root, `.tmp-cdp-media-${Date.now()}`)

// 宿主是 Electron 时会带这个变量，Electron 会退化成纯 Node
delete process.env.ELECTRON_RUN_AS_NODE

const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, '--no-sandbox'], {
  cwd: root,
  stdio: 'ignore',
  env: process.env,
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
  fs.rmSync(ws, { recursive: true, force: true })
  throw new Error('连不上 Electron 渲染进程')
}

const wsock = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const errors = []
const consoleAll = []
wsock.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push('EXC ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300))
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const text = m.params.args.map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300)
    errors.push('ERR ' + text)
    consoleAll.push(text)
  }
})
await new Promise((r) => wsock.addEventListener('open', r))
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = ++id
  pending.set(myId, resolve)
  setTimeout(() => reject(new Error('cdp timeout ' + method)), 25000)
  wsock.send(JSON.stringify({ id: myId, method, params }))
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

const WS_PATH = JSON.stringify(ws)

/* ── 1. 相对路径 → nota-media URL ── */
const url = await ev(`window.api.resolveMedia(${WS_PATH}, 'attachments/pic.png')`)
ok(
  '1.相对路径换算成 nota-media',
  typeof url === 'string' && url.startsWith('nota-media://'),
  String(url).slice(0, 80),
)

/* ── 2. 图片真能解码 ── */
const img = await ev(`(async () => {
  const url = await window.api.resolveMedia(${WS_PATH}, 'attachments/pic.png')
  const im = new Image()
  const loaded = await new Promise((r) => {
    im.onload = () => r(true)
    im.onerror = () => r(false)
    im.src = url
    setTimeout(() => r(false), 8000)
  })
  return { url: url.slice(0, 60), loaded, w: im.naturalWidth, h: im.naturalHeight }
})()`)
ok(
  '2.图片经协议解码成功',
  img.loaded === true && img.w === 64 && img.h === 32,
  img,
)

/* ── 3. video 不被 CSP 拦 ── */
const vid = await ev(`(async () => {
  const url = await window.api.resolveMedia(${WS_PATH}, 'attachments/clip.mp4')
  const v = document.createElement('video')
  v.muted = true
  v.src = url
  document.body.appendChild(v)
  // 内容不是真视频，必然解码失败；这里只关心有没有被策略拦掉
  await new Promise((r) => { v.onerror = r; setTimeout(r, 3000) })
  return { url: url.slice(0, 60), err: v.error ? v.error.code : null }
})()`)
const cspBlocked = consoleAll.filter((t) => /Content Security Policy/i.test(t))
ok(
  '3.video 未被 CSP 拦截',
  cspBlocked.length === 0,
  { videoError: vid.err, csp: cspBlocked.slice(0, 3) },
)

console.log('\n--- JS ERRORS ---')
console.log(errors.length ? errors.join('\n') : '(none)')
console.log('\n=== SUMMARY ===')
const failed = Object.entries(out).filter(([, v]) => v && v.pass === false).map(([k]) => k)
console.log(failed.length ? 'FAILED: ' + failed.join(', ') : `ALL PASS (${Object.keys(out).length})`)

await send('Browser.close').catch(() => {})
wsock.close()
app.kill()
fs.rmSync(ws, { recursive: true, force: true })
for (let i = 0; i < 5; i++) {
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); break } catch { await sleep(400) }
}
process.exit(failed.length ? 1 : 0)
