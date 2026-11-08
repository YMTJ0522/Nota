/* 全帧扫描：找「连续 >400 行的亮像素竖条」——只有滚动条这种东西。 */
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
  // 每列统计最长的连续亮游程（>110 且 <245，滚动条浅灰；纯白云更亮）
  for (let x = 0; x < W; x++) {
    let best = 0, cur = 0
    for (let y = 0; y < H; y++) {
      const v = f[y * W + x]
      if (v > 110 && v < 245) cur++
      else { if (cur > best) best = cur; cur = 0 }
    }
    if (cur > best) best = cur
    if (best > 400) console.log(`x=${x}: 亮游程 ${best} 行`)
  }
})
