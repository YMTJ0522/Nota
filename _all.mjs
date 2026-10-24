import WebSocket from 'ws'
import fs from 'fs'

const port = process.argv[2]
const dir = process.argv[3]

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
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.value
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true }, 30000)
  const p = `${dir}/${name}`
  fs.writeFileSync(p, Buffer.from(data, 'base64'))
  console.log('  ✓', name, Math.round(fs.statSync(p).size / 1024) + 'KB')
}

// 固定视口：1500x940 @2x = 3000x1880，与官网现有图同尺寸
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 940, deviceScaleFactor: 2, mobile: false })
await sleep(800)

const openNote = async (title) => {
  const ok = await js(`(() => {
    const s = [...document.querySelectorAll('span.name')].find(e => e.textContent.trim() === ${JSON.stringify(title)})
    if (s) s.parentElement.click()
    return !!s
  })()`)
  await sleep(900)
  return ok
}
const setTheme = async (want) => {
  const cur = await js(`document.documentElement.dataset.theme || localStorage.getItem('nota-theme')`)
  if (cur !== want) {
    await js(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/切到(浅色|深色)/.test(x.title||'')); if(b) b.click(); return 1 })()`)
    await sleep(700)
  }
}
const setView = async (label) => {
  await js(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').startsWith(${JSON.stringify(label)})); if(b) b.click(); return b?'ok':'none' })()`)
  await sleep(800)
}
const scrollTop = async () => {
  await js(`(() => {
    let el = document.querySelector('.md-body')
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 8) el.scrollTop = 0
      el = el.parentElement
    }
    window.scrollTo(0,0); return 1
  })()`)
  await sleep(500)
}
const scrollToH2 = async (t) => {
  const r = await js(`(() => {
    const h = [...document.querySelectorAll('.md-body h2')].find(e => e.textContent.trim() === ${JSON.stringify(t)})
    if (h) h.scrollIntoView({ block: 'start' })
    return h ? 'found' : 'miss'
  })()`)
  await sleep(600)
  return r
}

console.log('打开欢迎文档:', await openNote('欢迎使用 Nota'))

// 1) 首屏：浅色 + 分栏 + 顶部
await setTheme('light')
await setView('分栏视图')
await scrollTop()
await shot('hero.png')

// 2) 阅读模式：表格 / 任务列表 / 流程图 / 公式 / 提示块
await setView('阅读模式')
console.log('  定位段落:', await scrollToH2('写'))
await shot('article.png')

// 3) 深色：流程图会重新配色
await setTheme('dark')
await scrollToH2('写')
await shot('dark.png')

// 4) 搜索：浅色 + 全文搜索命中
await setTheme('light')
if (!(await js(`!!document.querySelector('.sp-input')`))) {
  await js(`(() => { const el=[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('全文搜索')); if(el) el.click(); return 1 })()`)
  await sleep(1200)
}
await js(`(() => {
  const side = document.querySelector('.nl-search-input')
  if (side && side.value) { side.value=''; side.dispatchEvent(new Event('input',{bubbles:true})) }
  const inp = document.querySelector('.sp-input')
  if (!inp) return 'noinput'
  inp.focus(); inp.value='导出'; inp.dispatchEvent(new Event('input',{bubbles:true}))
  return inp.value
})()`)
await sleep(2200)
await shot('search.png')

// 5) 关系图：关掉搜索浮层，打开图，把节点组拖到画面中间
await js(`document.querySelector('.sp-x')?.click()`)
await sleep(800)
await js(`(() => { const el=[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('关系图')); if(el) el.click(); return 1 })()`)
await sleep(3000)

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
// 节点组偏右下，往左上拖一点，再把鼠标移到空白处消掉 tooltip
await drag(1320, 860, 1010, 830)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 900 })
await sleep(700)
await shot('graph.png')

await send('Emulation.clearDeviceMetricsOverride').catch(() => {})
ws.close()
console.log('done')
process.exit(0)
