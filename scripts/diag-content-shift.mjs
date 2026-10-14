/**
 * 诊断 4：滚编辑区时，内容有没有在脚下位移。
 *
 * 判据：同一行文字，它的「文档坐标」= rect.top + scrollTop 必须恒定。
 * 它一变，说明 CodeMirror 在滚动途中重新量了行高、把内容整体挪了一截 ——
 * 人眼看到的就是「往下滚着滚着，字突然上下跳一下」。
 *
 * 虚拟滚动会回收 DOM，所以按**文字**认行，不认元素。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4408)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 950] })

/* 每行都带唯一编号，方便按文字认行 */
const sec = []
for (let i = 1; i <= 40; i++) {
  sec.push(`## 节 ${i}`, '')
  sec.push(`L${i}a ` + '内容文字'.repeat(20))
  sec.push(`L${i}b ` + '内容文字'.repeat(3))
  sec.push('')
}
const LONG = ['# 位移靶子', '', ...sec].join('\n')
const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/位移.md': LONG },
  tree: [...makeTree(), { type: 'file', name: '位移.md', path: '/ws/位移.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' }],
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
console.log('打开笔记:', await evaluate(openNoteExpr('位移')))
await sleep(1400)
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="分栏视图"]')?.click()`)
await sleep(1000)

const SAMPLER = `
window.__s = [];
window.__go = true;
(function loop(){
  if (!window.__go) return;
  var e = document.querySelector('.cm-scroller');
  if (e) {
    var st = e.scrollTop;
    var r = e.getBoundingClientRect();
    var best = null, bestTop = 1e9;
    var ls = document.querySelectorAll('.cm-line');
    for (var i = 0; i < ls.length; i++) {
      var t = ls[i].getBoundingClientRect().top;
      if (t >= r.top - 8 && t < bestTop) { bestTop = t; best = ls[i]; }
    }
    window.__s.push([
      Math.round(st),
      best ? (best.textContent || '').slice(0, 12) : '',
      best ? Math.round(bestTop - r.top + st) : -1,
      Math.round(e.scrollHeight)
    ]);
  }
  requestAnimationFrame(loop);
})();
void 0;
`

async function run(label, times, dy, reset) {
  if (reset) {
    await evaluate(`(() => { var e = document.querySelector('.cm-scroller'); if (e) e.scrollTop = 0; void 0; })()`)
    await sleep(500)
  }
  const box = JSON.parse(
    await evaluate(`(() => { var r = document.querySelector('.cm-scroller').getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}) })()`),
  )
  await evaluate(SAMPLER.replace(/\n/g, ' '))
  await sleep(80)
  for (let i = 0; i < times; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: dy })
    await sleep(30)
  }
  await sleep(500)
  await evaluate(`window.__go = false; void 0;`)
  const s = JSON.parse(await evaluate(`JSON.stringify(window.__s)`))

  /* 按文字分组：同一行的文档坐标应当恒定，抖动就是内容位移 */
  const byText = new Map()
  for (const [st, text, docY] of s) {
    if (!text || docY < 0) continue
    if (!byText.has(text)) byText.set(text, [])
    byText.get(text).push(docY)
  }
  let worst = 0
  let worstText = ''
  let shifted = 0
  for (const [text, arr] of byText) {
    const lo = Math.min(...arr)
    const hi = Math.max(...arr)
    if (hi - lo > 2) shifted += 1
    if (hi - lo > worst) { worst = hi - lo; worstText = text }
  }
  const h0 = s.length ? s[0][3] : 0
  const h1 = s.length ? s[s.length - 1][3] : 0
  console.log(`\n── ${label}`)
  console.log(`   采样帧 ${s.length}，出现过的行 ${byText.size}，其中发生位移的 ${shifted}`)
  console.log(`   最大位移 ${worst}px（行「${worstText}」）`)
  console.log(`   文档总高 ${h0} → ${h1}`)
  /* 顺带看 scrollTop 自己有没有反向 */
  let rev = 0
  let prev = 0
  for (const [st] of s) {
    const d = st - prev
    if (prev !== 0 && d !== 0) {
      const dir = d > 0 ? 1 : -1
      if (prev !== 0 && dir !== Math.sign(prev)) rev += 1
    }
    if (d !== 0) prev = d
  }
  console.log(`   scrollTop 反向次数 ${rev}`)
}

await run('第一次向下 30 格（CM 还没量过下面的行）', 30, 100, true)
await run('第二次继续向下 30 格（已经量过了）', 30, 100, false)
await run('第三次再向下 30 格', 30, 100, false)

console.log('\n控制台异常:', errors.length ? errors.slice(0, 5) : '无')
await close()
