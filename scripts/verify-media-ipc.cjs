/**
 * 真·主进程验证：marked 会把图片地址 encodeURI 一遍（中文名 → %E3%80%90…），
 * 磁盘上却没有带百分号的文件，所以 media:resolve 必须把地址解回来再找。
 *
 * 这一层在浏览器里验不了（那边注入的是假 IPC），所以只能真跑 Electron：
 * 抢在 main.cjs 注册之前包一层 ipcMain.handle 把回调存下来，
 * app ready 之后直接调用它，看返回的地址指向的文件是不是真的存在。
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, ipcMain } = require('electron')

const WS = 'C:/Users/ymtj1/AppData/Local/Temp/nota-media-ws'
const REL = 'attachments/【哲风壁纸】励志标语-彩色字体.jpg'
const REAL_TMP = path.join('D:/tmp', 'nota-media-ws')

/* 造一个带中文名的真实文件当靶子 */
const target = path.join(WS, REL)
fs.mkdirSync(path.dirname(target), { recursive: true })
if (!fs.existsSync(target)) {
  const src = path.join(__dirname, '..', 'docs', 'icon-big.png')
  fs.copyFileSync(fs.existsSync(src) ? src : path.join(__dirname, '..', 'package.json'), target)
}

/* ── 捕获 media:resolve 的实现 ── */
const captured = new Map()
const original = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => {
  captured.set(channel, listener)
  return original(channel, listener)
}

require('../dist-electron/main.cjs')

/** nota-media://local/<encoded> → 磁盘绝对路径 */
function toDisk(url) {
  if (!url) return null
  const m = /^nota-media:\/\/local\/(.+)$/.exec(url)
  if (!m) return null
  return decodeURIComponent(m[1]).replace(/^\/+/, (s) => s)
}

const results = []
function record(name, url, expectExists) {
  const disk = toDisk(url)
  const exists = disk ? fs.existsSync(disk) : false
  results.push({ name, ok: exists === expectExists && (expectExists || !!url), disk, exists })
}

app.whenReady().then(async () => {
  const resolve = captured.get('media:resolve')
  if (!resolve) {
    console.log('FAIL  没抓到 media:resolve 的处理器')
    app.exit(1)
    return
  }

  // ① 原样相对路径
  record('① 原始中文路径', await resolve({}, WS, REL), true)
  // ② marked 编过码的路径（用户踩到的就是这个）
  record('② encodeURI 后的路径', await resolve({}, WS, encodeURI(REL)), true)
  // ③ 带空格也一起编码
  record('③ 中文+空格', await resolve({}, WS, encodeURI('attachments/人物剪影-旷野 1.mp4')), false)
  // ④ 绝对路径
  record('④ 绝对路径', await resolve({}, '', target), true)
  // ⑤ 远程地址不该被改写
  const remote = await resolve({}, WS, 'https://example.com/a.png')
  results.push({ name: '⑤ 远程地址原样返回', ok: remote === 'https://example.com/a.png', disk: remote, exists: true })

  console.log('')
  for (const r of results) {
    console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name, JSON.stringify({ disk: r.disk, exists: r.exists }))
  }
  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log(failed.length ? `FAILED: ${failed.map((f) => f.name).join(', ')}` : `ALL PASS (${results.length})`)

  try { fs.rmSync(REAL_TMP, { recursive: true, force: true }) } catch {}
  app.exit(failed.length ? 1 : 0)
})
