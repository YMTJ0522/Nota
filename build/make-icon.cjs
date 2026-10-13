/**
 * 从 build/icon.svg 生成 build/icon.ico（多尺寸）+ build/icon.png。
 *
 * 思路：借 Electron 里的 Chromium 把 SVG 光栅化成每一档尺寸的 PNG，
 * 再按 ICO 格式手工打包（ICO 支持内嵌 PNG，无需任何额外依赖）。
 *
 * ⚠️ 这里**不能**用 `webContents.capturePage()` 截图。
 * 2.2.2 之前就是这么写的，结果生出来的 ico 一直是坏的：
 * capturePage 截的是**整页**，不是那个 16px 的 SVG —— 窗口内容区
 * 在 150% 缩放的显示器上是 770×770 设备像素，于是七个「尺寸」拿到的
 * 全是同一张 770×770、无 alpha、白底的整窗图，图标缩在左上角一点点。
 * ICO 目录里却按 16/24/32… 声明，Windows 按声明的尺寸去缩那张大图，
 * 最后任务栏上就是一块白方块边上挤着一个绿豆子。
 *
 * 正解是把光栅化交给页面里的 canvas：drawImage 会按目标尺寸重新
 * 光栅化矢量图（每一档都是清晰的，不是把大图缩下来），canvas 本来就带
 * alpha，toDataURL 出来的 PNG 尺寸严丝合缝，跟窗口缩放、DPR 全都无关。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
const SVG = path.join(ROOT, 'build', 'icon.svg')
const ICO = path.join(ROOT, 'build', 'icon.ico')
const PNG = path.join(ROOT, 'build', 'icon.png')

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const BIG = 512

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
  /** 走 data URL 让浏览器当图片加载；base64 是为了躲开引号与 # 的转义坑 */
  const src = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf-8').toString('base64')

  const win = new BrowserWindow({
    width: 640,
    height: 640,
    show: false,
    // 页面只是拿来当渲染器的，截不截图都行；给个透明底更保险
    backgroundColor: '#00000000',
  })

  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<script>
const SRC = ${JSON.stringify(src)};
window.renderAt = (sizes) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => {
    const out = {};
    for (const s of sizes) {
      const c = document.createElement('canvas');
      c.width = s; c.height = s;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, s, s);
      // drawImage 会按目标尺寸重新光栅化矢量图，每一档都是清晰的原生渲染
      ctx.drawImage(img, 0, 0, s, s);
      out[s] = c.toDataURL('image/png');
    }
    resolve(out);
  };
  img.onerror = () => reject(new Error('SVG 载入失败'));
  img.src = SRC;
});
</script></body></html>`

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page))

  const dataUrls = await win.webContents.executeJavaScript(
    `window.renderAt(${JSON.stringify([...SIZES, BIG])})`,
  )

  const entries = SIZES.map((size) => {
    const data = Buffer.from(dataUrls[String(size)].split(',')[1], 'base64')
    console.log(`  渲染 ${size}x${size} → ${data.length} bytes`)
    return { size, data }
  })

  fs.writeFileSync(ICO, buildIco(entries))
  console.log(`\n✅ 已生成 ${ICO} (${fs.statSync(ICO).size} bytes, ${SIZES.length} 个尺寸)`)

  // 512 那张留着给 README / 商店信息用
  fs.writeFileSync(PNG, Buffer.from(dataUrls[String(BIG)].split(',')[1], 'base64'))
  console.log(`✅ 已生成 ${PNG} (${BIG}x${BIG})`)

  app.quit()
})
