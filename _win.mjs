import WebSocket from 'ws'

const port = process.argv[2]
const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page')

const ws = new WebSocket(ver.webSocketDebuggerUrl)
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
const send = (m, p = {}, t = 15000) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method: m, params: p }))
  return new Promise((res, rej) => {
    waits.set(id, { res, rej })
    setTimeout(() => waits.has(id) && (waits.delete(id), rej(new Error(m + ' timeout'))), t)
  })
}

const { windowId, bounds } = await send('Browser.getWindowForTarget', { targetId: page.id })
console.log('windowId', windowId, 'bounds', JSON.stringify(bounds))

// 先最小化再恢复：窗口被别的应用盖住时，仅 setWindowBounds 不会把它提到最前
await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }).catch((e) => console.log('min fail', e.message))
await new Promise((r) => setTimeout(r, 400))
await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch((e) => console.log('normal fail', e.message))
const after = await send('Browser.getWindowBounds', { windowId })
console.log('after', JSON.stringify(after.bounds))
ws.close()
process.exit(0)
