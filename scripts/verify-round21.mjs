/**
 * round21 —— 资料栏收 via 窄轨
 *
 * 上一版（2.2.8）把资料栏做成常驻，理由是「两枚并排的收起钮不好看」。
 * 这条理由只说明了一半：不好看是因为它们并排，不是因为有两个。
 * 所以这一版把开关还回来，但让它长在资料栏**自己**的顶行；
 * 收起后资料栏缩成一条窄轨，展开钮就长在窄轨上。
 * 于是两栏各有一枚、各管自己，永远不会撞进同一行。
 *
 * 断言：
 * 1. 资料栏开着时，它自己顶行有一枚收起钮，侧栏顶行只有它自己那一枚
 * 2. 点收起 → 资料栏变成窄轨，编辑区变宽（宽度真的还给了正文）
 * 3. 窄轨上有且只有一枚展开钮，侧栏顶行仍然只有一枚
 * 4. 点展开 → 回来，宽度还原
 * 5. 状态写进 localStorage：重启不会丢
 * 6. 收着的时候点侧栏「AI 编写」这类入口，要顺手把它拉开
 * 7. 没有 console 报错
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4421)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1400, 950] })
const results = []
const ok = (name, pass, data) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`, data === undefined ? '' : JSON.stringify(data))
}

const INJECT = makeInject({ notes: makeNotes(), tree: makeTree() })

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1500)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)
await evaluate(`document.querySelector('.col-tab[data-view="notes"]')?.click()`)
await sleep(600)

/** 三栏宽度 + 各处按钮数量，一次量齐 */
const SHAPE = `(() => {
  var q = (s) => document.querySelector(s)
  var col = q('.col')
  var sideHead = q('.panel .head-actions')
  var main = q('.main')
  return JSON.stringify({
    folded: !!col?.classList.contains('folded'),
    colW: col ? Math.round(col.getBoundingClientRect().width) : -1,
    mainW: main ? Math.round(main.getBoundingClientRect().width) : -1,
    sideBtns: sideHead ? sideHead.querySelectorAll('button').length : -1,
    colToggleInRail: !!q('.col-fold [data-role="column-toggle"]'),
    colToggleInHead: !!q('.col-flow [data-role="column-toggle"]'),
    railBtns: document.querySelectorAll('.col-fold button').length,
    sidebarToggleLeft: !!q('.panel .head-actions [data-role="sidebar-toggle"]'),
    stored: localStorage.getItem('nota-column-open'),
  })
})()`

async function shape() {
  return JSON.parse(await evaluate(SHAPE))
}

/* ── 1. 展开态：资料栏自己带一枚，侧栏只有它自己那一枚 ── */
const open = await shape()
ok(
  '1.资料栏开着：收起钮在它自己顶行，侧栏顶行只有「收起侧边栏」一枚',
  !open.folded && open.colToggleInHead && !open.colToggleInRail && open.sideBtns === 1,
  open,
)

/* ── 2. 收起 → 变窄轨，宽度真的给了正文 ── */
await evaluate(`document.querySelector('.col-flow [data-role="column-toggle"]')?.click()`)
await sleep(500)
const folded = await shape()
ok(
  '2.点收起：资料栏缩成窄轨，正文变宽（省下的宽度真的还给它了）',
  folded.folded && folded.colW < 60 && folded.mainW > open.mainW + 150,
  { colBefore: open.colW, colNow: folded.colW, mainBefore: open.mainW, mainNow: folded.mainW },
)

/* ── 3. 窄轨上只有一枚展开钮，侧栏没被塞第二枚 ── */
ok(
  '3.窄轨上有且只有一枚展开钮，侧栏顶行仍然只有一枚（不再并排）',
  folded.colToggleInRail && folded.railBtns === 1 && folded.sideBtns === 1 && folded.sidebarToggleLeft,
  folded,
)

/* ── 4. 状态要能带过重启 ── */
ok('4.收起状态写进了 localStorage', folded.stored === '0', { stored: folded.stored })

/* ── 5. 点回展开 ── */
await evaluate(`document.querySelector('.col-fold [data-role="column-toggle"]')?.click()`)
await sleep(500)
const back = await shape()
ok(
  '5.点展开：资料栏回来，正文宽度让回去',
  !back.folded && Math.abs(back.colW - open.colW) <= 2 && Math.abs(back.mainW - open.mainW) <= 2,
  { colW: back.colW, want: open.colW, mainW: back.mainW, wantMain: open.mainW },
)

/* ── 6. 收着的时候，从侧栏点入口要能把正文区那一列拉开 ── */
await evaluate(`document.querySelector('.col-flow [data-role="column-toggle"]')?.click()`)
await sleep(450)
const beforeAi = await shape()
/* AI 入口在侧栏底部 */
await evaluate(`(() => {
  var b = [...document.querySelectorAll('.panel .nav-item')]
    .find(function (x) { return (x.textContent || '').indexOf('AI') >= 0; });
  b && b.click();
  void 0;
})()`)
await sleep(700)
const afterAi = await shape()
ok(
  '6.收着的时候点侧栏入口（AI 编写）会顺手把资料栏拉开',
  beforeAi.folded && !afterAi.folded,
  { before: beforeAi.folded, after: afterAi.folded },
)

ok('7.过程中没有控制台报错', errors.length === 0, errors.slice(0, 4))

const pass = results.filter((r) => r.pass).length
console.log(`\n round21：${pass}/${results.length} 通过`)
await close()
process.exit(pass === results.length ? 0 : 1)
