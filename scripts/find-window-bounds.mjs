/* 在全分辨率帧里找安装窗的精确边界：窗口底色 #141418(灰度≈22)，
   扫每行的最长暗像素游程，窗口行会有 1400+ 的长游程。 */
import { spawn } from 'node:child_process'

const ff = spawn('ffmpeg', [
  '-ss', '6.1', '-i', 'C:/Users/ymtj1/Desktop/export-1794143798270.mp4',
  '-frames:v', '1',
  '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
], { stdio: ['ignore', 'pipe', 'ignore'] })

const W = 2560, H = 1440
const buf = []
ff.stdout.on('data', (d) => buf.push(d))
ff.on('close', () => {
  const f = Buffer.concat(buf)
  // 每行找最长暗游程（灰度<45，暗窗体；桌面草地可能也暗，所以要求游程>1200）
  const runs = []
  for (let y = 0; y < H; y++) {
    let best = 0, cur = 0, end = -1, start = -1, bestStart = -1
    for (let x = 0; x < W; x++) {
      if (f[y * W + x] < 45) { if (cur === 0) start = x; cur++; if (cur > best) { best = cur; bestStart = start } }
      else cur = 0
    }
    runs.push(best > 1200 ? [bestStart, best] : null)
  }
  // 找连续的窗口行段
  let top = -1, bot = -1, l = 1e9, r = -1
  for (let y = 0; y < H; y++) {
    if (runs[y]) {
      if (top < 0) top = y
      bot = y
      l = Math.min(l, runs[y][0])
      r = Math.max(r, runs[y][0] + runs[y][1])
    }
  }
  console.log(`窗口边界: x ${l}..${r} (宽 ${r - l}), y ${top}..${bot} (高 ${bot - top})`)
  console.log(`150% DPI 下 DIP: 宽 ${((r - l) / 1.5).toFixed(0)}, 高 ${((bot - top) / 1.5).toFixed(0)}`)
  // 窗口内右缘的滚动条位置：在窗口中部行 y=700 找暗区右侧的亮条
  const y = 700
  let s = ''
  for (let x = r - 80; x < r + 10; x++) s += f[y * W + x] > 90 ? '#' : f[y * W + x] > 45 ? '+' : '.'
  console.log(`y=700 右缘亮度图 (x ${r - 80}..${r + 10}):\n${s}`)
})
