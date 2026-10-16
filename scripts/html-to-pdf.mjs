/**
 * 临时探针（用完即删）：把导出的 HTML（PDF 那一路的产物）用与主进程
 * printToPDF **完全相同的参数**打一份真 PDF，好在外部逐页目检。
 *
 * 用法：node scripts/_html2pdf.mjs <input.html> <output.pdf>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { launch } from './cdp-harness.mjs'

const SRC = process.argv[2]
const OUT = process.argv[3]

const { send, sleep, close } = await launch({ port: 4472, size: [794, 1123] })
const url = 'file:///' + SRC.replace(/\\/g, '/').replace(/^\//, '')
await send('Page.navigate', { url })
await sleep(3000)

const res = await send('Page.printToPDF', {
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

const b64 = res.data ?? res.result?.data
writeFileSync(OUT, Buffer.from(b64, 'base64'))
const head = readFileSync(OUT).subarray(0, 8).toString('latin1')
console.log('wrote', OUT, 'head=', JSON.stringify(head))
await close()
