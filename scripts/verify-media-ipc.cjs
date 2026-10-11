/**
 * 真·主进程验证：媒体路径解析。
 *
 * 这一层在浏览器里验不了（那边注入的是假 IPC），所以只能真跑 Electron：
 * 抢在 main.cjs 注册之前包一层 ipcMain.handle 把回调存下来，
 * app ready 之后直接调用它。
 *
 * 两道关都得过：
 *  ① 返回的 nota-media:// 地址反解回磁盘后文件真的存在
 *  ② 用 net.fetch 真把字节取回来 —— 光看地址存在不够，
 *     协议没注册好、CSP 拦掉，用户看到的依然是裂图
 *
 * 靶子用真实文件名：中文 + 空格（`佩剑-侠客-剪影 3.jpg`）。
 * 空格以前是致命的：CommonMark 要求地址含空格必须写成 `<>`，
 * 否则 marked 直接不解析，整行退成纯文本。
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, ipcMain, net } = require('electron')

const WS = 'C:/Users/ymtj1/AppData/Local/Temp/nota-media-ws'
const DIR = 'attachments'
const SPACED = '【哲风壁纸】佩剑-侠客-剪影 3.jpg'
const PLAIN = '【哲风壁纸】励志标语-彩色字体.jpg'
const HASHED = '拍摄#1.jpg'

/* 造真实文件当靶子。能从用户的真实工作区借到就用真图，借不到就用应用图标。 */
const REAL_WS = 'E:/图片/Camera Roll/attachments'
const FALLBACK = path.join(__dirname, '..', 'docs', 'icon-big.png')

function seed(name) {
  const target = path.join(WS, DIR, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (fs.existsSync(target)) return target
  const real = path.join(REAL_WS, name)
  const src = fs.existsSync(real) ? real : FALLBACK
  fs.copyFileSync(src, target)
  return target
}
;['【哲风壁纸】佩剑-侠客-剪影 3.jpg', PLAIN, HASHED].forEach(seed)

/* ── 捕获 media:resolve 的实现 ── */
const captured = new Map()
const original = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => {
  captured.set(channel, listener)
  return original(channel, listener)
}

require('../dist-electron/main.cjs')

/** nota-media://local/<encoded> 反解成磁盘绝对路径 */
function toDisk(url) {
  if (!url) return null
  const m = /^nota-media:\/\/local\/(.+)$/.exec(url)
  if (!m) return null
  // + 号在 path 里是字面量，不是空格，只处理 %XX
  return decodeURIComponent(m[1])
}

const results = []
function ok(name, pass, detail) {
  results.push({ name, pass, detail })
}

/** 真的把 URL 拉一遍，返回字节数；失败返回 -1 */
async function fetchBytes(url) {
  try {
    const res = await net.fetch(url)
    if (!res.ok) return -1
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length
  } catch {
    return -1
  }
}

app.whenReady().then(async () => {
  const resolve = captured.get('media:resolve')
  if (!resolve) {
    console.log('FAIL  没抓到 media:resolve 的处理器')
    app.exit(1)
    return
  }

  // ① 原始相对路径（中文，无空格）
  const plain = await resolve({}, WS, `${DIR}/${PLAIN}`)
  const plainDisk = toDisk(plain)
  ok('① 原始中文路径', !!plainDisk && plainDisk.endsWith(PLAIN) && fs.existsSync(plainDisk), { disk: plainDisk })

  // ② marked 编过码的路径（中文 → %E3%80%90…）
  const encoded = await resolve({}, WS, encodeURI(`${DIR}/${PLAIN}`))
  ok('② encodeURI 后的中文路径', !!toDisk(encoded) && fs.existsSync(toDisk(encoded)), { url: encoded })

  // ③ 用户踩到的那个：中文 + 空格，且已经被 marked 编码成 %20
  const spacedEnc = encodeURI(`${DIR}/${SPACED}`)
  const spaced = await resolve({}, WS, spacedEnc)
  const spacedDisk = toDisk(spaced)
  ok(
    '③ 中文 + 空格（encodeURI 后）',
    !!spacedDisk && fs.existsSync(spacedDisk),
    { rel: spacedEnc, disk: spacedDisk },
  )

  // ④ 原始未编码的中文 + 空格
  const spacedRaw = await resolve({}, WS, `${DIR}/${SPACED}`)
  ok('④ 中文 + 空格（未编码）', !!toDisk(spacedRaw) && fs.existsSync(toDisk(spacedRaw)), { url: spacedRaw })

  // ⑤ 文件名里的 # 被编码成 %23，不能当成锚点切掉
  const hashed = await resolve({}, WS, `${DIR}/${encodeURIComponent(HASHED)}`)
  const hashedDisk = toDisk(hashed)
  ok('⑤ 文件名含 # ', !!hashedDisk && fs.existsSync(hashedDisk), { url: hashed, disk: hashedDisk })

  // ⑥ 绝对路径
  const abs = path.join(WS, DIR, PLAIN)
  const absUrl = await resolve({}, '', abs)
  ok('⑥ 绝对路径', !!toDisk(absUrl) && fs.existsSync(toDisk(absUrl)), { url: absUrl })

  // ⑦ 远程地址不该被改写
  const remote = await resolve({}, WS, 'https://example.com/a.png')
  ok('⑦ 远程地址原样返回', remote === 'https://example.com/a.png', { url: remote })

  // ⑧ 最后一道：真把字节取回来
  const bytes = await fetchBytes(spaced)
  ok('⑧ nota-media 协议真的能在出图字节', bytes > 0, { bytes, url: spaced })

  console.log('')
  for (const r of results) {
    console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name, JSON.stringify(r.detail))
  }
  const failed = results.filter((r) => !r.pass)
  console.log('')
  console.log(failed.length ? `FAILED: ${failed.map((f) => f.name).join(', ')}` : `ALL PASS (${results.length})`)

  try { fs.rmSync(WS, { recursive: true, force: true }) } catch {}
  app.exit(failed.length ? 1 : 0)
})
