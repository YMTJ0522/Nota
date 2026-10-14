/**
 * 诊断 6：把往返误差按绝对像素扫一遍，看它在哪儿偏、偏多少。
 *
 * 上一份只报百分比，25% 那档回不去但看不出形状。这里把两端的
 * scrollTop / scrollHeight 原样打出来，逐档量。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4410)
const { evaluate, sleep, errors, send, close } = await launch({ port: PORT, size: [1500, 950] })

const sec = []
for (let i = 1; i <= 12; i++) {
  sec.push(`## 第 ${i} 节`, '')
  sec.push('段落' + '文字。'.repeat(4 + i * 12), '')
}
const LONG = ['# 往返靶子', '', ...sec].join('\n')
const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/往返.md': LONG },
  tree: [...makeTree(), { type: 'file', name: '往返.md', path: '/ws/往返.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' }],
})

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1500)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)
await evaluate(`document.querySelector('.col-tab[data-view="notes"]')?.click()`)
await sleep(500)
await evaluate(openNoteExpr('往返'))
await sleep(1400)
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="分栏视图"]')?.click()`)
await sleep(1000)

const READ = `
(() => {
  var e = document.querySelector('.cm-scroller');
  var p = document.querySelector('.pvw .preview');
  return JSON.stringify({
    eTop: Math.round(e.scrollTop), eMax: Math.round(e.scrollHeight - e.clientHeight), eH: Math.round(e.scrollHeight),
    pTop: Math.round(p.scrollTop), pMax: Math.round(p.scrollHeight - p.clientHeight), pH: Math.round(p.scrollHeight),
  });
})()
`
const SET = `(who, v) => { var x = document.querySelector(who); x.scrollTop = Math.round(v); void 0; }`

async function reset() {
  await evaluate(`(${SET.replace(/\n/g, ' ')})('.cm-scroller', 0)`)
  await evaluate(`(${SET.replace(/\n/g, ' ')})('.pvw .preview', 0)`)
  await sleep(700)
}

/* 先把两端都滚一遍，让 CodeMirror 把整篇量完 —— 否则「未测量的行」只有估算高度，
   量出来的误差是量具本身的，不是映射的。 */
const eBox = JSON.parse(await evaluate(`(() => { var r = document.querySelector('.cm-scroller').getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)}) })()`))
for (let i = 0; i < 90; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: eBox.x, y: eBox.y, deltaX: 0, deltaY: 120 }); await sleep(12) }
await sleep(800)
for (let i = 0; i < 90; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: eBox.x, y: eBox.y, deltaX: 0, deltaY: -120 }); await sleep(12) }
await sleep(900)
const base = JSON.parse(await evaluate(READ.replace(/\n/g, ' ')))
console.log('量完之后的两端几何:', JSON.stringify(base))

console.log('\n编辑区 → 预览 → 编辑区')
for (let k = 1; k <= 9; k++) {
  const at = k / 10
  await reset()
  await evaluate(`(${SET.replace(/\n/g, ' ')})('.cm-scroller', ${Math.round(at * base.eMax)})`)
  await sleep(650)
  const a = JSON.parse(await evaluate(READ.replace(/\n/g, ' ')))
  await reset()
  await evaluate(`(${SET.replace(/\n/g, ' ')})('.pvw .preview', ${a.pTop})`)
  await sleep(650)
  const b = JSON.parse(await evaluate(READ.replace(/\n/g, ' ')))
  const err = b.eTop - Math.round(at * base.eMax)
  console.log(
    `  ${String(Math.round(at * 100)).padStart(3)}%  编辑 ${String(Math.round(at * base.eMax)).padStart(5)} → 预览 ${String(a.pTop).padStart(5)} → 编辑 ${String(b.eTop).padStart(5)}   误差 ${String(err).padStart(5)}px`,
  )
}

console.log('\n预览 → 编辑区 → 预览')
for (let k = 1; k <= 9; k++) {
  const at = k / 10
  await reset()
  await evaluate(`(${SET.replace(/\n/g, ' ')})('.pvw .preview', ${Math.round(at * base.pMax)})`)
  await sleep(650)
  const a = JSON.parse(await evaluate(READ.replace(/\n/g, ' ')))
  await reset()
  await evaluate(`(${SET.replace(/\n/g, ' ')})('.cm-scroller', ${a.eTop})`)
  await sleep(650)
  const b = JSON.parse(await evaluate(READ.replace(/\n/g, ' ')))
  const err = b.pTop - Math.round(at * base.pMax)
  console.log(
    `  ${String(Math.round(at * 100)).padStart(3)}%  预览 ${String(Math.round(at * base.pMax)).padStart(5)} → 编辑 ${String(a.eTop).padStart(5)} → 预览 ${String(b.pTop).padStart(5)}   误差 ${String(err).padStart(5)}px`,
  )
}

console.log('\n控制台异常:', errors.length ? errors.slice(0, 5) : '无')
await close()
