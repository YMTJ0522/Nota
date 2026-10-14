/**
 * 诊断 5：来回滚一次，看能不能回到原地。
 *
 * 编辑区 → 预览 走标题锚点，预览 → 编辑区 走字符比例。若两条不是互逆的，
 * 那么「编辑区到 50% → 预览被写到 P → 预览在 P 又反过来写编辑区」就会跑到别处。
 * 到底/到顶会被 clamp 兜住看不出来，所以专挑中间段量。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4409)
const { evaluate, sleep, errors, send, close } = await launch({ port: PORT, size: [1500, 950] })

/* 每节长度差得远：源码里标题只占几个字符，渲染出来是一整块 */
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

const SET_E = `(v) => { var e = document.querySelector('.cm-scroller'); e.scrollTop = Math.round(v * (e.scrollHeight - e.clientHeight)); void 0; }`
const SET_P = `(v) => { var p = document.querySelector('.pvw .preview'); p.scrollTop = Math.round(v * (p.scrollHeight - p.clientHeight)); void 0; }`
const READ = `
(() => {
  var e = document.querySelector('.cm-scroller');
  var p = document.querySelector('.pvw .preview');
  var f = (x) => Math.round((x.scrollTop / Math.max(1, x.scrollHeight - x.clientHeight)) * 1000) / 10;
  return JSON.stringify({ e: f(e), p: f(p) });
})()
`

async function reset() {
  await evaluate(`(() => { document.querySelector('.cm-scroller').scrollTop = 0; document.querySelector('.pvw .preview').scrollTop = 0; void 0; })()`)
  await sleep(600)
}

console.log('起始:', await evaluate(READ.replace(/\n/g, ' ')))

for (const at of [0.25, 0.5, 0.75]) {
  await reset()
  await evaluate(`(${SET_E.replace(/\n/g, ' ')})(0)`)
  await sleep(100)
  await evaluate(`(${SET_E.replace(/\n/g, ' ')})(${at})`)
  await sleep(700)
  const a = JSON.parse(await evaluate(READ.replace(/\n/g, ' ')))

  await reset()
  await evaluate(`(${SET_P.replace(/\n/g, ' ')})(${a.p / 100})`)
  await sleep(700)
  const b = JSON.parse(await evaluate(READ.replace(/\n/g, ' ')))

  console.log(
    `编辑区置于 ${at * 100}% → 预览 ${a.p}%  |  再把预览置于 ${a.p}% → 编辑区回到 ${b.e}%` +
      `  ${Math.abs(b.e - at * 100) > 6 ? '  ✗ 回不去，两条映射不是互逆的' : '  ✓ 能回去'}`,
  )
}

/* 再来一次：点大纲落位之后，给预览一丝多余的滚动，看编辑区被拽多远 */
await reset()
await evaluate(`document.querySelector('.col-tab[data-view="outline"]')?.click()`)
await sleep(600)
await evaluate(`(() => { var it = document.querySelectorAll('.ov-item')[5]; if (it) it.click(); void 0; })()`)
await sleep(1800)
console.log('\n点第 5 项落位后:', await evaluate(READ.replace(/\n/g, ' ')))
await evaluate(`(() => { var p = document.querySelector('.pvw .preview'); p.scrollTop = p.scrollTop + 6; void 0; })()`)
await sleep(800)
console.log('预览只多滚 6px 后:', await evaluate(READ.replace(/\n/g, ' ')))
console.log('   → 编辑区若被拽走一大截，就是「预览→编辑区」这条映射在乱写')

console.log('\n控制台异常:', errors.length ? errors.slice(0, 5) : '无')
await close()
