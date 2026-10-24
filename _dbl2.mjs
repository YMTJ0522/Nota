import WebSocket from 'ws'

const port = process.argv[2]
const want = '欢迎使用 Nota'
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
const send = (m, p = {}, t = 20000) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method: m, params: p }))
  return new Promise((res, rej) => {
    waits.set(id, { res, rej })
    setTimeout(() => waits.has(id) && (waits.delete(id), rej(new Error(m + ' 超时'))), t)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value

if (!(await js(`!!document.querySelector('.gv-canvas')`))) {
  await js(`(() => { const el=[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('关系图')); if(el) el.click(); return 1 })()`)
  await sleep(3000)
}

const rectRaw = await js(`(() => { const r=document.querySelector('.gv-canvas').getBoundingClientRect(); return JSON.stringify({l:r.left,t:r.top,w:r.width,h:r.height}) })()`)
const rect = JSON.parse(rectRaw)
console.log('画布:', rect)

const tipAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await sleep(28)
  return await js(`(document.querySelector('.gv-tip')||{}).textContent?.trim() || ''`)
}

let hit = null
const step = 26
outer: for (let y = Math.round(rect.t + 40); y < rect.t + rect.h - 40; y += step) {
  for (let x = Math.round(rect.l + 40); x < rect.l + rect.w - 40; x += step) {
    const t = await tipAt(x, y)
    if (t.includes(want)) { hit = { x, y, t }; break outer }
  }
}
if (!hit) { console.log('没扫到目标节点（布局可能变了）'); process.exit(2) }
console.log('命中:', hit)

const clickAt = async (x, y, count) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count })
}

// 1) 单击：不该离开关系图
await clickAt(hit.x, hit.y, 1)
await sleep(1000)
const stillGraph = await js(`!!document.querySelector('.gv-canvas')`)
console.log('单击后仍在关系图:', stillGraph)

// 2) 双击：应该打开那一篇并回到正文
await clickAt(hit.x, hit.y, 1)
await clickAt(hit.x, hit.y, 2)
await sleep(1600)
let leftGraph = !(await js(`!!document.querySelector('.gv-canvas')`))
console.log('CDP 双击后离开关系图:', leftGraph)

// 合成没成功时，直接派发 dblclick —— 用来区分「事件没到」和「逻辑没生效」
if (!leftGraph) {
  await js(`(() => {
    const cv = document.querySelector('.gv-canvas')
    cv.dispatchEvent(new MouseEvent('dblclick', { clientX: ${hit.x}, clientY: ${hit.y}, bubbles: true, cancelable: true }))
    return 1
  })()`)
  await sleep(1600)
  leftGraph = !(await js(`!!document.querySelector('.gv-canvas')`))
  console.log('直接派发 dblclick 后离开关系图:', leftGraph)
}
const h1 = await js(`(document.querySelector('.md-body h1')||{}).textContent?.trim() || ''`)
const firstLine = await js(`(document.querySelector('.cm-line')||{}).textContent?.trim() || ''`)
const activeName = await js(`(document.querySelector('.row.file.is-active .name, .row.file.on .name, .row.file[class*=act] .name')||{}).textContent?.trim() || ''`)
console.log('双击后离开关系图:', leftGraph)
console.log('正文标题:', h1 || firstLine || '(空)')
console.log('列表选中项:', activeName || '(未读到)')

ws.close()
process.exit(0)
