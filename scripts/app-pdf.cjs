/* 用**应用自己的 Electron 通道**把导出 HTML 打成 PDF，参数与 main.ts 的
   `export:pdf` 逐字一致。验收 PDF 那一路要看这份，不要拿 html-to-pdf.mjs 的
   结果当数：那条走的是裸 CDP，`pageSize: 'A4'` 被吃掉，出来是 Letter
   （实测 612×792pt），几何跟用户手里那份对不上。
   用法：electron scripts/app-pdf.cjs <in.html> <out.pdf>
   （跑之前确保没设 ELECTRON_RUN_AS_NODE，否则 electron 会以纯 node 模式启动，
     `require('electron').app` 是 undefined。）
*/
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')

const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('_app-pdf.cjs')) + 1)
const SRC = path.resolve(args[0])
const OUT = path.resolve(args[1])

app.whenReady().then(async () => {
  // main.ts 也是先落到临时文件再 loadFile（长 HTML 走 data: URL 会撞长度上限）。
  // 这里同样用纯 ASCII 临时路径，避开中文路径带来的加载玄学。
  const tmp = path.join(os.tmpdir(), `nota-probe-${Date.now()}.html`)
  fs.copyFileSync(SRC, tmp)
  const win = new BrowserWindow({ show: false, width: 794, height: 1123 })
  try {
    await win.loadFile(tmp)
    await new Promise((r) => setTimeout(r, 2000))
    const buf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.75, bottom: 0.75, left: 0.7, right: 0.7 },
      headerTemplate: '<div></div>',
      footerTemplate: `
        <div style="width:100%;text-align:center;font-size:9px;color:#8a867c;
                    font-family:-apple-system,'Segoe UI','PingFang SC',sans-serif;
                    padding:0 20mm;">
          <span class="pageNumber"></span> / <span class="totalPages"></span>
        </div>`,
    })
    fs.writeFileSync(OUT, buf)
    console.log('OK wrote', OUT, buf.length, 'bytes')
  } catch (e) {
    console.log('FAIL', String(e && e.message))
  } finally {
    fs.rmSync(tmp, { force: true })
    app.exit(0)
  }
})
