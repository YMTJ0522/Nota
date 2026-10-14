/**
 * 诊断：点大纲跳转时，编辑区到底怎么动的。
 *
 * 不看代码猜，直接逐帧把 .cm-scroller 的 scrollTop 采下来，看三件事：
 *   1. 最后停在哪一行 —— 是不是停在了点的那个标题上
 *   2. 中途有没有「反向」—— 先冲过头再退回来，就是肉眼看到的「乱跳」
 *   3. 走过的总路程跟直线距离差多少 —— 差得多说明在来回追
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4405)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 950] })

/* 靶子：12 节，每节长度不同，中间夹代码块和长列表。
   编辑器里的行高是均匀的，但预览里代码块/列表占的高度完全不同 ——
   正是「估算高度对不上真实高度」最容易暴露的形态。 */
const sec = []
for (let i = 1; i <= 12; i++) {
  sec.push(`## 第 ${i} 节`, '')
  sec.push('段落' + '内容文字。'.repeat(20 + i * 3), '')
  sec.push('```js', `const v${i} = ${i}`, `console.log(v${i})`, '```', '')
  sec.push('- 列表项 ' + '甲乙丙丁戊己庚辛壬癸'.repeat(2 + i), '')
}
const LONG = ['# 跳转靶子', '', ...sec].join('\n')

const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/跳转靶子.md': LONG },
  tree: [...makeTree(), { type: 'file', name: '跳转靶子.md', path: '/ws/跳转靶子.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' }],
})

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1500)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)

await evaluate(openNoteExpr('跳转靶子'))
await sleep(1400)
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="分栏视图"]')?.click()`)
await sleep(900)
await evaluate(`document.querySelector('.col-tab[data-view="outline"]')?.click()`)
await sleep(700)

const count = JSON.parse(await evaluate(`JSON.stringify(document.querySelectorAll('.ov-item').length)`))
console.log('大纲条目数:', count)

const SAMPLER = `
window.__s = [];
window.__go = true;
(function loop(){
  if (!window.__go) return;
  var e = document.querySelector('.cm-scroller');
  if (e) window.__s.push(Math.round(e.scrollTop));
  requestAnimationFrame(loop);
})();
void 0;
`

/** 停稳之后，编辑区视口最上面那一行是什么 */
const TOP_LINE = `
(() => {
  var e = document.querySelector('.cm-scroller');
  var r = e.getBoundingClientRect();
  var lines = [...document.querySelectorAll('.cm-line')];
  var best = null, bestTop = -1e9;
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].getBoundingClientRect().top;
    if (t >= r.top - 2 && t < bestTop + 0.001) { }
    if (t >= r.top - 6) { if (best === null || t < bestTop) { best = lines[i]; bestTop = t; } }
  }
  return JSON.stringify({
    top: Math.round(e.scrollTop),
    max: Math.round(e.scrollHeight - e.clientHeight),
    line: best ? (best.textContent || '').slice(0, 24) : null,
    delta: best ? Math.round(bestTop - r.top) : null,
  });
})()
`

const MAXS = `
(() => {
  var e = document.querySelector('.cm-scroller');
  return JSON.stringify({ max: Math.round(e.scrollHeight - e.clientHeight) });
})()
`

async function jump(idx) {
  await evaluate(MAXS.replace(/\n/g, ' '))
  await evaluate(SAMPLER.replace(/\n/g, ' '))
  await sleep(60)
  await evaluate(`
    (function () {
      var it = document.querySelectorAll('.ov-item')[${idx}];
      if (it) it.click();
      void 0;
    })()
  `)
  await sleep(1600)
  await evaluate(`window.__go = false; void 0;`)
  await sleep(80)
  const s = JSON.parse(await evaluate(`JSON.stringify(window.__s)`))
  const land = JSON.parse(await evaluate(TOP_LINE.replace(/\n/g, ' ')))
  return { s, land }
}

function analyze(s) {
  const rows = []
  let last = null
  for (const v of s) {
    if (last === null || last !== v) rows.push(v)
    last = v
  }
  const steps = []
  for (let i = 1; i < rows.length; i++) steps.push(rows[i] - rows[i - 1])
  const direct = rows.length ? Math.abs(rows[rows.length - 1] - rows[0]) : 0
  let travel = 0
  let reversals = 0
  let prevDir = 0
  for (const st of steps) {
    if (st === 0) continue
    travel += Math.abs(st)
    const d = st > 0 ? 1 : -1
    if (prevDir !== 0 && d !== prevDir) reversals += 1
    prevDir = d
  }
  const sorted = [...steps].map(Math.abs).sort((a, b) => a - b)
  return {
    帧数: rows.length,
    直线: direct,
    路程: travel,
    绕路比: direct > 0 ? Math.round((travel / direct) * 100) / 100 : 0,
    反向次数: reversals,
    最大单帧: sorted.length ? sorted[sorted.length - 1] : 0,
    末值: rows.length ? rows[rows.length - 1] : 0,
  }
}

const targets = [2, 5, 9, 11, 7, 1, 11, 3]
for (const idx of targets) {
  const want = JSON.parse(
    await evaluate(`JSON.stringify(((document.querySelectorAll('.ov-item')[${idx}] || {}).textContent || '').trim().slice(0, 20))`),
  )
  const { s, land } = await jump(idx)
  console.log(`\n── 点第 ${idx} 项「${want}」`)
  console.log('   落点:', JSON.stringify(land))
  console.log('   轨迹:', JSON.stringify(analyze(s)))
}

console.log('\n控制台异常:', errors.length ? errors.slice(0, 5) : '无')
await close()
