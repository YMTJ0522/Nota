import WebSocket from 'ws'

const port = process.argv[2]
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
const send = (m, p = {}) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method: m, params: p }))
  return new Promise((res, rej) => {
    waits.set(id, { res, rej })
    setTimeout(() => waits.has(id) && (waits.delete(id), rej(new Error(m + ' timeout'))), 15000)
  })
}
try {
  await send('Page.bringToFront')
  console.log('bringToFront ok')
} catch (e) {
  console.log('bringToFront failed:', e.message)
}
const r = await send('Runtime.evaluate', {
  expression: `document.visibilityState + '|' + (document.hasFocus?'f':'n')`,
  returnByValue: true,
})
console.log('visibility =', r.result?.value)
ws.close()
process.exit(0)
