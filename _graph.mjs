import WebSocket from 'ws'
import fs from 'fs'

const port = process.argv[2]
const out = process.argv[3]

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const waits = new Map()
ws.on('message', (raw) => {
  const d = JSON.parse(raw)
  if (d.id && waits.has(d.id)) {
    const w = waits.get(d.id)
    waits.delete(d.id)
    d.error ? w.rej(new Error(JSON.stringify(d.error))) : w.res(d.result)
  }
})
await new Promise((r, j) => {
  ws.on('open', r)
  ws.on('error', j)
})
const send = (m, p = {}, t = 25000) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method: m, params: p }))
  return new Promise((res, rej) => {
    waits.set(id, { res, rej })
    setTimeout(() => waits.has(id) && (waits.delete(id), rej(new Error(m + ' 超时'))), t)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value

await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 940, deviceScaleFactor: 2, mobile: false })
await sleep(900)

// 浅色，关系图在深色下节点配色看不出层次
const cur = await js(`document.documentElement.dataset.theme || localStorage.getItem('nota-theme')`)
if (cur !== 'light') {
  await js(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/切到浅色/.test(x.title||'')); if(b) b.click(); return 1 })()`)
  await sleep(600)
}

// 入口是 toggle：已经开着再点一下会关掉，所以先看画布在不在
if (!(await js(`!!document.querySelector('.gv-canvas')`))) {
  await js(`(() => { const el=[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('关系图')); if(el) el.click(); return 1 })()`)
  await sleep(3200)
}

// 先点「回到中心与原始大小」，让布局自己归位，比盲拖可靠
await js(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/回到中心/.test(x.title||'')); if(b) b.click(); return b?1:0 })()`)
await sleep(900)
const nodes = await js(`document.querySelector('.gv-meta')?.textContent.trim() || ''`)
console.log('图头:', nodes)
// 截图专用：右侧那条 1px 溢出滚动条不属于要展示的内容
await js(`document.documentElement.style.overflow='hidden'; document.body.style.overflow='hidden'; 1`)

const drag = async (x1, y1, x2, y2) => {
  const steps = 12
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1, buttons: 1 })
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x1 + ((x2 - x1) * i) / steps),
      y: Math.round(y1 + ((y2 - y1) * i) / steps),
      button: 'left',
      buttons: 1,
    })
    await sleep(16)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 })
  await sleep(300)
}
// 拖动只在空白处平移，幅度控制住 —— 拖太多会把度数低的节点推出画布
await drag(1330, 870, 1160, 850)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 900 })
await sleep(700)

const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true }, 30000)
fs.writeFileSync(out, Buffer.from(data, 'base64'))
console.log('saved', out, Math.round(fs.statSync(out).size / 1024) + 'KB')
console.log('提示文案:', await js(`document.querySelector('.gv-hint')?.textContent || 'none'`))
await send('Emulation.clearDeviceMetricsOverride').catch(() => {})
ws.close()
process.exit(0)
