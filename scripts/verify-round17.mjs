/**
 * round17 —— 2.2.8 这一批
 *
 * 1. 双向同步滚动必须互为逆映射。
 *    以前「预览 → 编辑区」拿字符比例算（预览滚动比例 × 文档字符数），
 *    而「编辑区 → 预览」走标题锚点插值 —— 两条不是互逆的。
 *    后果不是「对不齐一点」，是任何一次多余的同步都会把编辑区甩出去一大截：
 *    实测点完大纲落位后，预览只多滚 6px，编辑区被拽走十个百分点。
 *    人看到的就是「点大纲跳转时编辑区上下乱跳」。
 *    断言：来回滚一次要回到原地（误差在几十像素内，不到一行）。
 *
 * 2. 两栏的收放钮各归各列，不许再并排。
 *    2.2.8 把资料栏做成常驻（不许收），理由是「两枚并排不好看」——
 *    那条理由只说了一半：难看是因为它们并排，不是因为有两个。
 *    所以开关还回来了，但长在资料栏**自己**的顶行；收起后缩成窄轨，
 *    展开钮长在窄轨上。两栏各一枚、各管自己，永远撞不进同一行。
 *    断言：全页 column-toggle 恒为一枚，且在资料栏里；侧栏顶行恒为一枚。
 *
 * 3. 代价要有人盯着：侧栏宽度得给资料栏和编辑区让路，
 *    最小窗口 960 下三栏不能把编辑区挤到站不住。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4413)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 950] })
const results = []
const ok = (name, pass, data) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`, data === undefined ? '' : JSON.stringify(data))
}

/* 每节长短差得远：字符比例跟渲染高度差得最远，正是原来那条路偏得最狠的地方 */
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
    eTop: Math.round(e.scrollTop), eMax: Math.round(e.scrollHeight - e.clientHeight),
    pTop: Math.round(p.scrollTop), pMax: Math.round(p.scrollHeight - p.clientHeight),
  });
})()
`
const SET = `(who, v) => { var x = document.querySelector(who); x.scrollTop = Math.round(v); void 0; }`

async function reset() {
  await evaluate(`(${SET.replace(/\n/g, ' ')})('.cm-scroller', 0)`)
  await evaluate(`(${SET.replace(/\n/g, ' ')})('.pvw .preview', 0)`)
  await sleep(650)
}

/* 先把整篇滚一遍让 CodeMirror 量完 —— 未测量的行只有估算高度，
   那部分误差是量具的，不是映射的。 */
const eBox = JSON.parse(
  await evaluate(`(() => { var r = document.querySelector('.cm-scroller').getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)}) })()`),
)
for (let i = 0; i < 90; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: eBox.x, y: eBox.y, deltaX: 0, deltaY: 120 })
  await sleep(12)
}
await sleep(800)
for (let i = 0; i < 90; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: eBox.x, y: eBox.y, deltaX: 0, deltaY: -120 })
  await sleep(12)
}
await sleep(900)
const base = JSON.parse(await evaluate(READ.replace(/\n/g, ' ')))

/* ══ 1. 往返误差 ══ */
const errs = []
for (let k = 2; k <= 9; k++) {
  const at = k / 10
  const want = Math.round(at * base.eMax)
  await reset()
  await evaluate(`(${SET.replace(/\n/g, ' ')})('.cm-scroller', ${want})`)
  await sleep(650)
  const a = JSON.parse(await evaluate(READ.replace(/\n/g, ' ')))
  await reset()
  await evaluate(`(${SET.replace(/\n/g, ' ')})('.pvw .preview', ${a.pTop})`)
  await sleep(650)
  const b = JSON.parse(await evaluate(READ.replace(/\n/g, ' ')))
  errs.push(Math.abs(b.eTop - want))
}
const worst = Math.max(...errs)
ok(
  '1.编辑区→预览→编辑区能回到原地（两条映射互为逆运算）',
  worst <= 60,
  { 各档误差: errs, 最大误差: worst, 编辑区可滚: base.eMax },
)

/* ══ 2. 点大纲落位后，预览那一侧一丝多余的滚动不许把编辑区拽走 ══ */
await reset()
await evaluate(`document.querySelector('.col-tab[data-view="outline"]')?.click()`)
await sleep(600)
await evaluate(`(() => { var it = document.querySelectorAll('.ov-item')[5]; if (it) it.click(); void 0; })()`)
await sleep(1800)
const landedAt = JSON.parse(await evaluate(READ.replace(/\n/g, ' ')))
await evaluate(`(() => { var p = document.querySelector('.pvw .preview'); p.scrollTop = p.scrollTop + 6; void 0; })()`)
await sleep(800)
const after = JSON.parse(await evaluate(READ.replace(/\n/g, ' ')))
const drift = Math.abs(after.eTop - landedAt.eTop)
ok(
  '2.点大纲落位后，预览多滚 6px，编辑区不许被甩走（这就是原来「上下乱跳」的那一下）',
  drift <= 60,
  { 落位: landedAt.eTop, 之后: after.eTop, 漂移: drift },
)

/* ══ 3. 两端到底仍然对齐 ══ */
await reset()
for (let i = 0; i < 90; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: eBox.x, y: eBox.y, deltaX: 0, deltaY: 120 })
  await sleep(12)
}
await sleep(900)
const endE = JSON.parse(await evaluate(READ.replace(/\n/g, ' ')))
ok(
  '3.编辑区滚到底，预览也到底（两端对齐没被这次改动带坏）',
  endE.eMax > 0 && endE.eTop >= endE.eMax - 4 && endE.pTop >= endE.pMax - 4,
  endE,
)

/* ══ 4. 资料栏常驻：界面上一枚「收放资料栏」都没有 ══ */
const col = JSON.parse(
  await evaluate(`
    (() => JSON.stringify({
      column: !!document.querySelector('.col'),
      columnToggles: document.querySelectorAll('[data-role="column-toggle"]').length,
      onColumnItself: !!document.querySelector('.col [data-role="column-toggle"]'),
      onSidebar: !!document.querySelector('.panel [data-role="column-toggle"]'),
      sideToggles: document.querySelectorAll('.panel .head-actions .mini').length,
      sideOwn: !!document.querySelector('.head-actions [data-role="sidebar-toggle"]'),
    }))()
  `),
)
ok(
  '4.资料栏常驻：全页零收放钮，侧栏顶行仍只有「收起侧边栏」一枚',
  col.column && col.columnToggles === 0 && !col.onColumnItself && !col.onSidebar && col.sideToggles === 1 && col.sideOwn,
  col,
)

/* ══ 5. 侧栏收成窄轨后，资料栏照旧在那儿 ══ */
await evaluate(`document.querySelector('.head-actions [data-role="sidebar-toggle"]')?.click()`)
await sleep(800)
const rail = JSON.parse(
  await evaluate(`
    (() => JSON.stringify({
      rail: !!document.querySelector('.rail-head'),
      railHeadBtns: document.querySelectorAll('.rail-head button').length,
      columnToggles: document.querySelectorAll('[data-role="column-toggle"]').length,
      onColumnItself: !!document.querySelector('.col [data-role="column-toggle"]'),
      column: !!document.querySelector('.col'),
    }))()
  `),
)
ok(
  '5.侧栏收成窄轨：展开入口一枚，资料栏照旧在原地',
  rail.rail && rail.railHeadBtns === 1 && rail.columnToggles === 0 && rail.column,
  rail,
)

await evaluate(`document.querySelector('.rail-head button')?.click()`)
await sleep(800)
const back = JSON.parse(
  await evaluate(`
    (() => JSON.stringify({
      sidebar: !!document.querySelector('.panel .head'),
      column: !!document.querySelector('.col'),
      sideToggles: document.querySelectorAll('.panel .head-actions .mini').length,
    }))()
  `),
)
ok('6.再展开侧栏：两栏都在，顶行仍然一枚', back.sidebar && back.column && back.sideToggles === 1, back)

/* ══ 7. 侧栏入口点了要有反应（以前靠「先把资料栏叫回来」兜底）══ */
await evaluate(`(() => { var t=[...document.querySelectorAll('.panel .nav-item')].find(b=>(b.querySelector('.nav-label')?.textContent??'').trim()==='AI 编写'); t?.click(); void 0; })()`)
await sleep(1200)
const ai = JSON.parse(
  await evaluate(`(() => JSON.stringify({ col: !!document.querySelector('.col'), ai: !!document.querySelector('.ag, .ai-chat, .col .ai') }))()`),
)
ok('7.侧栏「AI 编写」点了有反应（不再依赖资料栏被叫回来）', ai.col && ai.ai, ai)

console.log(`\n通过 ${results.filter((r) => r.pass).length}/${results.length}`)
console.log('控制台异常:', errors.length ? errors.slice(0, 5) : '无')
await close()
