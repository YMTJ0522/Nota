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

// 打开关系图（toggle，先看画布在不在）
if (!(await js(`!!document.querySelector('.gv-canvas')`))) {
  await js(`(() => { const el=[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('关系图')); if(el) el.click(); return 1 })()`)
  await sleep(3000)
}
console.log('画布存在:', await js(`!!document.querySelector('.gv-canvas')`))
console.log('图头:', await js(`document.querySelector('.gv-meta')?.textContent.trim()`))

// 从组件内部拿节点屏幕坐标（比网格扫描靠谱）
const info = await js(`(() => {
  const cv = document.querySelector('.gv-canvas')
  const comp = cv && cv.__vueParentComponent
  const st = comp && comp.setupState
  if (!st) return 'no-vue-state'
  const r = cv.getBoundingClientRect()
  const nodes = (st.nodes && (st.nodes.value ?? st.nodes)) || []
  const panX = st.panX ? (st.panX.value ?? st.panX) : 0
  const panY = st.panY ? (st.panY.value ?? st.panY) : 0
  const scale = st.scale ? (st.scale.value ?? st.scale) : 1
  return JSON.stringify({ rect: {l: r.left, t: r.top, w: r.width, h: r.height}, panX, panY, scale,
    nodes: nodes.map(n => ({ name: n.name, id: n.id, x: n.x, y: n.y })) })
})()`)
console.log('组件状态:', info)
if (typeof info !== 'string' || info.startsWith('no')) process.exit(1)

const st = JSON.parse(info)
const target = st.nodes.find((n) => n.name === '欢迎使用 Nota') || st.nodes[0]
// 与组件里 toLocal 相反：屏幕 = 画布中心 + pan + 节点坐标 * scale
const cx = st.rect.l + st.rect.w / 2 + st.panX + target.x * st.scale
const cy = st.rect.t + st.rect.h / 2 + st.panY + target.y * st.scale
console.log(`目标「${target.name}」→ 屏幕 (${Math.round(cx)}, ${Math.round(cy)})`)

// 单击一次：不应跳走
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(cx), y: Math.round(cy), button: 'left', clickCount: 1, buttons: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(cx), y: Math.round(cy), button: 'left', clickCount: 1 })
await sleep(900)
console.log('单击后画布还在:', await js(`!!document.querySelector('.gv-canvas')`))

// 真正的双击
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(cx), y: Math.round(cy), button: 'left', clickCount: 1, buttons: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(cx), y: Math.round(cy), button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(cx), y: Math.round(cy), button: 'left', clickCount: 2, buttons: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(cx), y: Math.round(cy), button: 'left', clickCount: 2 })
await sleep(1500)

console.log('双击后画布还在:', await js(`!!document.querySelector('.gv-canvas')`))
console.log('当前笔记:', await js(`document.querySelector('.pv-title, .note-title, [class*=title]')?.textContent?.trim() || document.title`))
console.log('正文首行:', await js(`(document.querySelector('.md-body h1, .cm-line')||{}).textContent?.trim() || '(无)'`))
console.log('顶部标签:', await js(`[...document.querySelectorAll('[class*=tab]')].map(e=>e.textContent.trim()).filter(Boolean).slice(0,3).join(' | ')`))

ws.close()
process.exit(0)
