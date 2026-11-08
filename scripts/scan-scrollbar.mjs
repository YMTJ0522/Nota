/* 逐帧扫描安装窗右缘 17px 竖条，找滚动条闪现的帧。
   滚动条 = 右缘一列连续数百行的亮灰像素；窗口正常时该列是暗色边框。 */
import { spawn } from 'node:child_process'

const VIDEO = process.argv[2]
const X = 1846, W = 17, H = 940 // 窗口右缘竖条区域（2560x1440 全分辨率）

const ff = spawn('ffmpeg', [
  '-i', VIDEO,
  '-vf', `crop=${W}:${H}:${X}:0`,
  '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
], { stdio: ['ignore', 'pipe', 'ignore'] })

const frames = []
let buf = Buffer.alloc(0)
const FRAME = W * H
ff.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  while (buf.length >= FRAME) {
    const f = buf.subarray(0, FRAME)
    buf = buf.subarray(FRAME)
    // 统计亮度 > 90 的行（该行 17 像素中至少 10 个亮）
    let rows = 0
    for (let y = 0; y < H; y++) {
      let lit = 0
      for (let x = 0; x < W; x++) if (f[y * W + x] > 90) lit++
      if (lit >= 10) rows++
    }
    frames.push(rows)
  }
})
ff.on('close', () => {
  console.log(`共 ${frames.length} 帧`)
  // 找连续亮行 > 100 的帧（真滚动条会占几百行）
  let start = -1
  for (let i = 0; i < frames.length; i++) {
    if (frames[i] > 100 && start < 0) start = i
    if (frames[i] <= 100 && start >= 0) {
      console.log(`亮条段: 帧 ${start}-${i - 1} (${(start / 30).toFixed(2)}s-${((i - 1) / 30).toFixed(2)}s), 峰值 ${Math.max(...frames.slice(start, i))} 行`)
      start = -1
    }
  }
  if (start >= 0) console.log(`亮条段: 帧 ${start}-${frames.length - 1} (到结尾), 峰值 ${Math.max(...frames.slice(start))} 行`)
  // 打印直方图概览：每 10 帧一个点
  let line = ''
  for (let i = 0; i < frames.length; i++) {
    line += frames[i] > 300 ? '#' : frames[i] > 100 ? '+' : frames[i] > 30 ? '.' : ' '
    if (line.length === 120) { console.log(`${String(Math.floor(i / 30)).padStart(3)}s ${line}`); line = '' }
  }
  if (line) console.log(`end ${line}`)
})
