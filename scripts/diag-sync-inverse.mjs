/**
 * 诊断 3：两个方向是不是互为逆映射。
 *
 * 编辑区 → 预览 走的是「标题锚点插值」（2.2.7 修好的那条），
 * 预览 → 编辑区 走的却是「字符比例 × 文档长度」。这两条不是互逆的：
 * 一个标题在源码里只占十来个字符，渲染出来却是一整块。
 * 于是「编辑区滚到第 N 节 → 预览滚到第 N 节 → 预览再反过来写编辑区」
 * 就跑不到原来的地方，任何一次多余的同步都会把编辑区拽走一段。
 *
 * 判据很直接：把预览滚到底，看编辑区到没到底；再把编辑区滚到底，看预览到没到底。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4407)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 950] })

/*  headings 多、每节长短不一 —— 字符比例跟渲染高度差得最远 */
const sec = []
for (let i = 1; i <= 10; i++) {
  sec.push(`## 第 ${i} 节`, '')
  sec.push('段落' + '内容文字。'.repeat(6 + i * 8), '')
}
const LONG = ['# 逆映射靶子', '', ...sec].join('\n')
const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/逆映射.md': LONG },
  tree: [...makeTree(), { type: 'file', name: '逆映射.md', path: '/ws/逆映射.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' }],
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

const opened = await evaluate(openNoteExpr('逆映射'))
console.log('打开笔记:', opened)
await sleep(1400)
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="分栏视图"]')?.click()`)
await sleep(1000)

const PCT = `
(() => {
  var e = document.querySelector('.cm-scroller');
  var p = document.querySelector('.pvw .preview');
  var ep = e ? Math.round((e.scrollTop / Math.max(1, e.scrollHeight - e.clientHeight)) * 100) : -1;
  var pp = p ? Math.round((p.scrollTop / Math.max(1, p.scrollHeight - p.clientHeight)) * 100) : -1;
  return JSON.stringify({ ep: ep, pp: pp, eTop: e ? Math.round(e.scrollTop) : -1, pTop: p ? Math.round(p.scrollTop) : -1 });
})()
`

async function wheelOn(sel, times, dy) {
  const box = JSON.parse(
    await evaluate(`(() => { var r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}) })()`),
  )
  for (let i = 0; i < times; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: dy })
    await sleep(26)
  }
  await sleep(600)
}

console.log('\n【起点】', await evaluate(PCT.replace(/\n/g, ' ')))

/* ① 只滚预览到底 */
await wheelOn('.pvw .preview', 60, 120)
await sleep(500)
console.log('① 预览滚到底后：', await evaluate(PCT.replace(/\n/g, ' ')))
console.log('   → 编辑区应该也在 100，差多少就是「预览→编辑区」这条映射偏多少')

/* ② 回到顶，只滚编辑区到底 */
await wheelOn('.cm-scroller', 80, -120)
await sleep(400)
await wheelOn('.pvw .preview', 80, -120)
await sleep(500)
console.log('\n② 两端回顶后：', await evaluate(PCT.replace(/\n/g, ' ')))
await wheelOn('.cm-scroller', 80, 120)
await sleep(600)
console.log('③ 编辑区滚到底后：', await evaluate(PCT.replace(/\n/g, ' ')))
console.log('   → 预览应该也在 100，这是 2.2.7 已经修好的那条')

/* ④ 点大纲跳一次，然后长时间观察编辑区会不会自己漂走 */
await evaluate(`document.querySelector('.col-tab[data-view="outline"]')?.click()`)
await sleep(600)
await evaluate(`(() => { var it = document.querySelectorAll('.ov-item')[6]; if (it) it.click(); void 0; })()`)
for (const t of [400, 900, 1600, 2600, 4000]) {
  await sleep(t === 400 ? 400 : 500)
  console.log(`④ 点第 6 项后 ${t}ms：`, await evaluate(PCT.replace(/\n/g, ' ')))
}

console.log('\n控制台异常:', errors.length ? errors.slice(0, 5) : '无')
await close()
