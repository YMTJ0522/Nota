/**
 * 双向滚动同步探针。
 *
 * 用户报「编辑区滚 → 预览卡；预览滚 → 编辑丝滑」。两边代码看着对称，
 * 所以不猜，直接在页面里逐帧采样两边的 scrollTop，看预览那一路
 * 到底是「跟不上」还是「一跳一跳」。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4411)
const { send, evaluate, sleep, close } = await launch({ port: PORT, size: [1500, 950] })

/* 一篇够长的笔记：标题 + 正文混排，让两个容器高度都明显超过视口 */
const paras = []
for (let i = 1; i <= 30; i++) {
  paras.push(`## 第 ${i} 节`, '', `这是第 ${i} 节的正文，` + '文字内容。'.repeat(12), '')
}
const NOTE = ['# 滚动靶子', '', ...paras].join('\n')

const INJECT = makeInject({ notes: { ...makeNotes(), '/ws/甲笔记.md': NOTE } })

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1400)
await evaluate(INJECT)
// 先点「打开一个目录」进工作区；进去之后假 IPC 要**再注入一次**，
// 否则量到的是空白页，看着像功能没做。
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)
await evaluate(`document.querySelector('.col-tab[data-view="notes"]')?.click()`)
await sleep(500)
await evaluate(openNoteExpr('甲笔记'))
await sleep(1500)

/* 切分栏 */
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="分栏视图"]')?.click()`)
await sleep(1000)

const shape = JSON.parse(
  await evaluate(`JSON.stringify({
    editor: !!document.querySelector('.cm-scroller'),
    preview: !!document.querySelector('.pvw .preview'),
    eMax: (() => { const e = document.querySelector('.cm-scroller'); return e ? e.scrollHeight - e.clientHeight : -1 })(),
    pMax: (() => { const p = document.querySelector('.pvw .preview'); return p ? p.scrollHeight - p.clientHeight : -1 })(),
  })`),
)
console.log('容器:', shape)
if (!shape.editor || !shape.preview) {
  console.log('!! 分栏没起来')
  await close()
  process.exit(1)
}

/** 装一个逐帧采样器 */
await evaluate(`(() => {
  window.__samples = []
  const e = document.querySelector('.cm-scroller')
  const p = document.querySelector('.pvw .preview')
  window.__sampling = true
  const tick = () => {
    if (!window.__sampling) return
    window.__samples.push([Math.round(e.scrollTop), Math.round(p.scrollTop)])
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`)

/** 真滚轮：落在编辑区中心 */
async function wheel(x, y, dy, times) {
  for (let i = 0; i < times; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY: dy,
    })
    await sleep(28)
  }
}

function dump(label, samples) {
  console.log(`\n── ${label} ──`)
  // 只打印发生变化的帧，省得刷屏
  const rows = []
  let last = null
  for (const [e, p] of samples) {
    if (!last || last[0] !== e || last[1] !== p) rows.push([e, p])
    last = [e, p]
  }
  console.log('  编辑区 → 预览区（只列变化的帧）')
  for (const [e, p] of rows) console.log(`    ${String(e).padStart(5)}  →  ${String(p).padStart(5)}`)

  // 预览侧的步长分布：如果大量帧不动、偶尔大跳，就是阶跃而非平滑
  const steps = []
  for (let i = 1; i < rows.length; i++) steps.push(rows[i][1] - rows[i - 1][1])
  const moved = steps.filter((s) => s !== 0)
  const zero = steps.length - moved.length
  if (moved.length) {
    moved.sort((a, b) => a - b)
    const max = moved[moved.length - 1]
    const med = moved[Math.floor(moved.length / 2)]
    console.log(`  预览侧: 变化帧 ${moved.length} / 静止帧 ${zero}，步长中位数 ${med}，最大 ${max}`)
  }
}

/* ══ 1. 滚编辑区，看预览 ══ */
const boxE = JSON.parse(
  await evaluate(`(() => { const r = document.querySelector('.cm-scroller').getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}) })()`),
)
await wheel(boxE.x, boxE.y, 60, 25)
await sleep(400)
const s1 = JSON.parse(await evaluate(`JSON.stringify(window.__samples)`))
dump('滚编辑区 → 预览跟随', s1)

/* ══ 1b. 一路滚到底：两端必须同时到底 ══ */
await wheel(boxE.x, boxE.y, 100, 60)
await sleep(600)
const endE = JSON.parse(
  await evaluate(`(() => {
    const e = document.querySelector('.cm-scroller')
    const p = document.querySelector('.pvw .preview')
    return JSON.stringify({
      eTop: Math.round(e.scrollTop), eMax: Math.round(e.scrollHeight - e.clientHeight),
      pTop: Math.round(p.scrollTop), pMax: Math.round(p.scrollHeight - p.clientHeight),
    })
  })()`),
)
console.log('\n── 编辑区滚到底时 ──')
console.log(`  编辑区 ${endE.eTop}/${endE.eMax}   预览 ${endE.pTop}/${endE.pMax}`)
console.log(
  `  到底程度: 编辑区 ${(endE.eTop / Math.max(1, endE.eMax) * 100).toFixed(1)}%  预览 ${(endE.pTop / Math.max(1, endE.pMax) * 100).toFixed(1)}%`,
)

/* 回到顶部，好测反方向 */
await evaluate(`document.querySelector('.cm-scroller').scrollTop = 0`)
await sleep(500)

/* ══ 2. 滚预览区，看编辑区 ══ */
await evaluate(`window.__samples = []`)
const boxP = JSON.parse(
  await evaluate(`(() => { const r = document.querySelector('.pvw .preview').getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}) })()`),
)
await wheel(boxP.x, boxP.y, 60, 25)
await sleep(400)
const s2 = JSON.parse(await evaluate(`JSON.stringify(window.__samples)`))
dump('滚预览区 → 编辑区跟随', s2)

await evaluate(`window.__sampling = false`)
await close()
