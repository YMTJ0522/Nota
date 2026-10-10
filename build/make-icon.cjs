/**
 * 从 build/icon.svg 生成 build/icon.ico（多尺寸）。
 *
 * 思路：用 Electron 的 Chromium 把 SVG 渲染成各尺寸 PNG，
 * 再按 ICO 格式手工打包（ICO 支持内嵌 PNG，无需额外依赖）。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
const SVG = path.join(ROOT, 'build', 'icon.svg')
const OUT = path.join(ROOT, 'build', 'icon.ico')

const SIZES = [16, 24, 32, 48, 64, 128, 256]

app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('no-sandbox')

/** 把多个 PNG buffer 按 ICO 格式打包 */
function buildIco(entries) {
  const count = entries.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(count, 4)

  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  const blobs = []

  entries.forEach((e, i) => {
    const b = i * 16
    // 宽高：256 记为 0
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 0)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 1)
    dir.writeUInt8(0, b + 2) // 调色板数
    dir.writeUInt8(0, b + 3) // reserved
    dir.writeUInt16LE(1, b + 4) // color planes
    dir.writeUInt16LE(32, b + 6) // bits per pixel
    dir.writeUInt32LE(e.data.length, b + 8) // 数据大小
    dir.writeUInt32LE(offset, b + 12) // 数据偏移
    offset += e.data.length
    blobs.push(e.data)
  })

  return Buffer.concat([header, dir, ...blobs])
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SVG, 'utf-8')

  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    webPreferences: { offscreen: true },
  })

  const entries = []

  // 统一的无滚动条包装：隐藏溢出、清掉默认边距
  const wrap = (inner, size) => `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;overflow:hidden;background:transparent;width:${size}px;height:${size}px}
    svg{display:block}
  </style></head><body>${inner}</body></html>`

  for (const size of SIZES) {
    const svgSized = svg.replace('<svg', `<svg width="${size}" height="${size}"`)
    const html = wrap(svgSized, size)

    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    await new Promise((r) => setTimeout(r, 120))

    const img = await win.webContents.capturePage()
    const png = img.toPNG()
    entries.push({ size, data: png })
    console.log(`  渲染 ${size}x${size} → ${png.length} bytes`)
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, buildIco(entries))
  console.log(`\n✅ 已生成 ${OUT} (${fs.statSync(OUT).size} bytes, ${SIZES.length} 个尺寸)`)

  // 同时导出一张 512 PNG 备用（如 README 展示）
  const bigSvg = svg.replace('<svg', '<svg width="512" height="512"')
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(wrap(bigSvg, 512)))
  await new Promise((r) => setTimeout(r, 150))
  const big = await win.webContents.capturePage()
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), big.toPNG())
  console.log('✅ 已生成 build/icon.png (512x512)')

  app.quit()
})
