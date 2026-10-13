/**
 * 从 build/icon-source.png 生成 build/icon.ico（多尺寸）+ build/icon.png。
 *
 * 母版是一张 1024×1024 的 RGBA PNG：奶油底 + 薄荷绿手写「Nota」的圆角方块，
 * 四角已经是透明的（超椭圆轮廓，指数 6.3，4×4 超采样出的抗锯齿边）。
 * 它由一版 AI 生成稿裁出来 —— 裁框取方块自身的边界、水印在框外，一并去掉。
 * 换成矢量稿之前的旧版是 build/icon.svg，已经删掉：两个母版并存只会让人
 * 分不清该改哪个。
 *
 * 光栅化交给页面里的 canvas：drawImage 会按目标尺寸重新采样，
 * 每一档都从 1024 的母版直接缩，而不是「大图缩成小图再缩」。
 *
 * ⚠️ 这里**不能**用 `webContents.capturePage()` 截图。
 * 2.2.2 之前就是这么写的，结果生出来的 ico 一直是坏的：
 * capturePage 截的是**整页**，不是那块 16px 的图标 —— 窗口内容区
 * 在 150% 缩放的显示器上是 770×770 设备像素，于是七个「尺寸」拿到的
 * 全是同一张 770×770、无 alpha、白底的整窗图，图标缩在左上角一点点。
 * ICO 目录里却按 16/24/32… 声明，Windows 按声明的尺寸去缩那张大图，
 * 最后任务栏上就是一块白方块边上挤着一个绿豆子。
 *
 * 正解是把光栅化交给页面里的 canvas：canvas 本来就带 alpha，
 * toDataURL 出来的 PNG 尺寸严丝合缝，跟窗口缩放、DPR 全都无关。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'build', 'icon-source.png')
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
  if (!fs.existsSync(SRC)) {
    console.error(`找不到图标母版 ${SRC}`)
    app.exit(1)
    return
  }
  /** 走 data URL 让浏览器当图片加载；base64 是为了躲开引号与 # 的转义坑 */
  const src = 'data:image/png;base64,' + fs.readFileSync(SRC).toString('base64')

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
      // 母版带 alpha，直接drawImage 就保住透明四角
      ctx.drawImage(img, 0, 0, s, s);
      out[s] = c.toDataURL('image/png');
    }
    resolve(out);
  };
  img.onerror = () => reject(new Error('图标母版载入失败'));
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
