import WebSocket from 'ws'
import fs from 'fs'

const port = process.argv[2]
const out = process.argv[3]
const mode = process.argv[4] // search | graph

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
const send = (m, p = {}, t = 30000) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method: m, params: p }))
  return new Promise((res, rej) => {
    waits.set(id, { res, rej })
    setTimeout(() => waits.has(id) && (waits.delete(id), rej(new Error(m + ' 超时'))), t)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.value
}

// 先回到浅色，官网整体是浅色调
const theme = await evalJs(`document.documentElement.dataset.theme || localStorage.getItem('nota-theme')`)
if (theme !== 'light') {
  await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/切到浅色/.test(x.title||'')); if(b) b.click(); return 1 })()`)
  await sleep(600)
}

// 侧栏入口：按可见文字找
const openEntry = async (label) => {
  const ok = await evalJs(`(() => {
    const el = [...document.querySelectorAll('*')].filter(e => e.children.length <= 2 && e.textContent.trim().startsWith(${JSON.stringify(label)}))
      .sort((a,b) => b.textContent.length - a.textContent.length)
      .reverse()
      .find(e => e.offsetParent && e.textContent.trim().length < 24)
    if (!el) return 'miss'
    const clickable = el.closest('button, a, [class*=nav-item], [class*=item]') || el
    clickable.click()
    return clickable.className || 'clicked'
  })()`)
  await sleep(1200)
  return ok
}

if (mode === 'search') {
  // 面板已经开着就别再点一次 —— 那个入口是 toggle，点第二下会关掉
  const already = await evalJs(`!!document.querySelector('.sp-input')`)
  if (already) console.log('搜索面板已开着，跳过点击')
  else console.log('打开全文搜索 →', await openEntry('全文搜索'))
  await sleep(600)
  // 往搜索框里打字：Vue 受控，必须派发 input 事件。
  // 注意页面里有三个 input，浮层那个是 .sp-input；侧栏筛选框是 .nl-search-input，
  // 填错了会变成「左边列表被筛、浮层还是空的」，看着像搜索没生效。
  const typed = await evalJs(`(() => {
    const side = document.querySelector('.nl-search-input')
    if (side && side.value) { side.value = ''; side.dispatchEvent(new Event('input', { bubbles: true })) }
    const inp = document.querySelector('.sp-input')
    if (!inp) return 'noinput'
    inp.focus()
    inp.value = '导出'
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    inp.dispatchEvent(new Event('change', { bubbles: true }))
    return inp.className + '=' + inp.value
  })()`)
  console.log('输入 →', typed)
  await sleep(1800)
  console.log('结果条数 →', await evalJs(`document.querySelectorAll('[class*=hit],[class*=result]').length`))
} else {
  // 搜索浮层的遮罩会吃掉侧栏点击，先发一个 Escape 关掉
  await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape' })
  await sleep(700)
  console.log('打开关系图 →', await openEntry('关系图'))
  await sleep(2200)
}

await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 940, deviceScaleFactor: 2, mobile: false })
await sleep(1000)
const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true }, 30000)
fs.writeFileSync(out, Buffer.from(data, 'base64'))
console.log('saved', out, fs.statSync(out).size)
await send('Emulation.clearDeviceMetricsOverride').catch(() => {})
ws.close()
process.exit(0)
