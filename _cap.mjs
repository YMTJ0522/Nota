import WebSocket from 'ws'
import fs from 'fs'

const port = process.argv[2]
const out = process.argv[3]
const w = Number(process.argv[4] || 1500)
const h = Number(process.argv[5] || 940)

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const waits = new Map()
ws.on('message', (raw) => {
  const d = JSON.parse(raw)
  if (d.id && waits.has(d.id)) {
    const x = waits.get(d.id)
    waits.delete(d.id)
    d.error ? x.rej(new Error(JSON.stringify(d.error))) : x.res(d.result)
  }
})
await new Promise((r, j) => {
  ws.on('open', r)
  ws.on('error', j)
})
const send = (m, p = {}, t = 30000) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method: m, params: p }))
  return new Promise((res, rej) => {
    waits.set(id, { res, rej })
    setTimeout(() => waits.has(id) && (waits.delete(id), rej(new Error(m + ' 超时'))), t)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false })
await sleep(1200)
const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true }, 30000)
fs.writeFileSync(out, Buffer.from(data, 'base64'))
console.log('saved', out, fs.statSync(out).size)
await send('Emulation.clearDeviceMetricsOverride').catch(() => {})
ws.close()
process.exit(0)
