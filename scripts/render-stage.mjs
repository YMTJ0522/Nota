/**
 * 把 `.tmp-video/index.html` 这种「逐帧可控的舞台」录成 mp4。
 *
 * 为什么不直接用录屏软件：录屏会掉帧、会带上鼠标、分辨率还随窗口漂。
 * 这里的页面里所有动画都由 `window.seek(ms)` 算出来（一帧一个时间点），
 * 所以只要一帧一帧调 seek 再截屏，成片就是确定性的、可重录的。
 *
 * 帧不落盘：CDP 给的 PNG 直接写进 ffmpeg 的 stdin（image2pipe），
 * 900 帧全存盘要几百 MB，没必要。
 *
 *   node scripts/render-stage.mjs                     # .tmp-video → release/promo.mp4
 *   STAGE=.tmp-video OUT=x.mp4 FPS=30 SECONDS=30 node scripts/render-stage.mjs
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { launch } from './cdp-harness.mjs'

const STAGE = process.env.STAGE || 'promo'
const PAGE = process.env.PAGE || 'index.html'
const OUT = process.env.OUT || 'release/promo.mp4'
const FPS = Number(process.env.FPS || 30)
const SECONDS = Number(process.env.SECONDS || 30)
const W = Number(process.env.W || 1920)
const H = Number(process.env.H || 1080)

const frames = Math.round(FPS * SECONDS)

/* 只想看几帧对不对：STILLS="8,13,28"（秒）出一组 PNG 就退出，
   省得为了看一眼排版白渲整片 5 分钟。 */
const STILLS = (process.env.STILLS || '').split(',').filter(Boolean).map(Number)

/* WEB_ROOT 必须由**调用方**在命令行里给（cdp-harness 在模块加载时就把
   静态根算成常量了，这里再 process.env.WEB_ROOT = ... 已经晚了）：
     WEB_ROOT=.tmp-video node scripts/render-stage.mjs
*/

const b = await launch({ port: Number(process.env.PORT || 4455), size: [W, H], scale: 1 })
await b.send('Page.navigate', { url: 'http://127.0.0.1:' + b.port + '/' + PAGE })
await b.sleep(600)
await b.evaluate('window.__ready')
// 字体没落位就开录的话，前几帧是回退字体，成片里看得出来
await b.evaluate('document.fonts.ready.then(() => true)')

fs.mkdirSync(path.dirname(OUT), { recursive: true })

if (STILLS.length) {
  const dir = path.join(path.dirname(OUT), 'stills')
  fs.mkdirSync(dir, { recursive: true })
  for (const s of STILLS) {
    await b.evaluate(`window.seek(${(s * 1000).toFixed(1)})`)
    await b.shot(path.join(dir, `t${s}.png`))
    console.log(`  stills/t${s}.png`)
  }
  await b.close()
  process.exit(0)
}

const ff = spawn('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  OUT,
], { stdio: ['pipe', 'inherit', 'inherit'] })
const ffDone = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c)))))

const write = (buf) =>
  new Promise((res) => {
    if (ff.stdin.write(buf)) res()
    else ff.stdin.once('drain', res)
  })

const t0 = Date.now()
for (let i = 0; i < frames; i++) {
  const ms = (i / FPS) * 1000
  await b.evaluate(`window.seek(${ms.toFixed(1)})`)
  const b64 = await b.shotBase64()
  await write(Buffer.from(b64, 'base64'))
  if (i % 60 === 0 || i === frames - 1) {
    const pct = ((i + 1) / frames * 100).toFixed(0)
    process.stdout.write(`\r  帧 ${i + 1}/${frames}  ${pct}%  ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  }
}
ff.stdin.end()
await ffDone
await b.close()

const size = (fs.statSync(OUT).size / 1048576).toFixed(1)
console.log(`\n  ${OUT}  ${size} MB  ${W}×${H}  ${FPS}fps  ${SECONDS}s`)
if (b.errors.length) console.log('  页面报错：', b.errors.slice(0, 5))
