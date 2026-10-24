import WebSocket from 'ws'
import fs from 'fs'

const port = process.argv[2]
const out = process.argv[3]
const mode = process.argv[4] || 'hero'

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

// 1. 打开目标笔记（欢迎使用 Nota）
await evalJs(`(() => {
  const s = [...document.querySelectorAll('span.name')].find(e => e.textContent.trim() === '欢迎使用 Nota')
  if (s) s.parentElement.click()
  return !!s
})()`)
await sleep(900)

// 2. 主题与视图
const steps = {
  hero: { theme: 'light', view: '分栏视图', scroll: 'top' },
  article: { theme: 'light', view: '阅读模式', scroll: '写' },
  // 深色那张要走「写」这一段：流程图在深色下会重新配色，正好对上官网那句
  dark: { theme: 'dark', view: '阅读模式', scroll: '写' },
}
const cfg = steps[mode]
if (cfg) {
  // 主题
  const cur = await evalJs(`document.documentElement.dataset.theme || localStorage.getItem('nota-theme')`)
  if (cur !== cfg.theme) {
    await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/切到(浅色|深色)/.test(x.title||'')); if(b) b.click(); return b?b.title:'none' })()`)
    await sleep(700)
  }
  // 视图
  await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').startsWith(${JSON.stringify(cfg.view)})); if(b) b.click(); return b?'ok':'none' })()`)
  await sleep(800)
  // 位置
  if (cfg.scroll === 'top') {
    await evalJs(`(() => {
      const body = document.querySelector('.md-body')
      let el = body && body.parentElement
      while (el && el !== document.body) {
        if (el.scrollHeight > el.clientHeight + 8) { el.scrollTop = 0; }
        el = el.parentElement
      }
      window.scrollTo(0, 0)
      return 'top'
    })()`)
  } else {
    await evalJs(`(() => {
      const hs = [...document.querySelectorAll('.md-body h2')]
      const t = hs.find(e => e.textContent.trim() === ${JSON.stringify(cfg.scroll)})
      if (t) t.scrollIntoView({ block: 'start' })
      return t ? 'found' : 'miss'
    })()`)
  }
  await sleep(700)
}

// 3. 固定视口截图（1500x940 @2x = 3000x1880，与官网现有图同尺寸）
await send('Emulation.setDeviceMetricsOverride', {
  width: 1500,
  height: 940,
  deviceScaleFactor: 2,
  mobile: false,
})
await sleep(900)
const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true }, 30000)
fs.writeFileSync(out, Buffer.from(data, 'base64'))
console.log('saved', out, fs.statSync(out).size)
await send('Emulation.clearDeviceMetricsOverride').catch(() => {})
ws.close()
process.exit(0)
