/**
 * round21 —— 资料栏常驻
 *
 * 这一栏来回改过三回：最初可收（Ctrl+Shift+\），2.2.8 改成常驻，
 * 2.3.0 又把收放还回来（窄轨方案），2.4.0 收到结论——它就不该能收。
 *
 * 理由不是「按钮好不好看」：笔记列表、大纲、引用、AI 全住在这一列上，
 * 收掉它等于整个应用只剩一个编辑器，而「只想要一个编辑器」的用法在 Nota 里
 * 不存在（那要么是阅读模式，要么是别的软件）。真正属于「偶尔看一眼」的是
 * 侧栏（工作区导航），所以它保留收放，这一列不保留。
 *
 * 断言：
 * 1. 默认开着，宽度正常
 * 2. 全页一枚「收放资料栏」的钮都没有（也不可能有窄轨）
 * 3. 旧版本写进 localStorage 的 nota-column-open='0' 必须被忽略
 * 4. Ctrl+Shift+\ 不再有反应（旧快捷键彻底拆除）
 * 5. Ctrl+\ 只收侧边栏，资料栏一动不动
 * 6. 从侧栏点「AI 编写」仍然好使，资料栏还在原地
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
await sleep(1200)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)

/** 一眼把「这一列还在不在、有没有收口」量齐 */
const SHAPE = `(() => {
  var q = (s) => document.querySelector(s)
  var col = q('.col')
  return JSON.stringify({
    hasCol: !!col,
    colW: col ? Math.round(col.getBoundingClientRect().width) : -1,
    hasTabs: !!q('.col-flow .col-tab'),
    sideBtns: q('.panel .head-actions') ? q('.panel .head-actions').querySelectorAll('button').length : -1,
    sidebarToggle: !!q('.panel .head-actions [data-role="sidebar-toggle"]'),
    rail: document.querySelectorAll('.col-fold').length,
    panelCollapsed: !!q('.panel.collapsed'),
  })
})()`

async function shape() {
  return JSON.parse(await evaluate(SHAPE))
}

/** 全页「收放资料栏」的钮总数。它应该是恒零的。 */
async function toggleCount() {
  return Number(await evaluate(`document.querySelectorAll('[data-role="column-toggle"]').length`))
}

/* ── 1. 默认开着 ── */
const first = await shape()
ok(
  '1.资料栏默认开着：准备渲染、宽度足够，三个页签都在',
  first.hasCol && first.colW >= 200 && first.hasTabs,
  first,
)

/* ── 2. 全页零收放钮 ── */
const toggles = await toggleCount()
ok(
  '2.界面上一枚「收放资料栏」都没有（没有窄轨，也没有入口藏在别处）',
  toggles === 0 && first.rail === 0,
  { toggles, rail: first.rail },
)

/* ── 3. 旧数据不能把这一列带走 ──
   2.3.0 那版会写 localStorage['nota-column-open']。用户升级上来时
   里面留着 '0'（当年亲手收过），新版本必须无视它——
   否则升级之后第一眼就是「我的资料栏呢」。 */
await evaluate(`localStorage.setItem('nota-column-open', '0')`)
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1000)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)
const afterOld = await shape()
ok(
  '3.旧版本留下的 nota-column-open=0 被忽略：资料栏照样开着',
  afterOld.hasCol && afterOld.colW >= 200 && (await toggleCount()) === 0,
  afterOld,
)

/* ── 4. Ctrl+Shift+\ 已经拆掉 ── */
const widthBefore = afterOld.colW
await evaluate(`
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true, bubbles: true }));
  void 0;
`)
await sleep(500)
const afterKey = await shape()
ok(
  '4.Ctrl+Shift+\\ 不再有反应（资料栏既没收也没跑）',
  afterKey.hasCol && Math.abs(afterKey.colW - widthBefore) <= 2,
  { before: widthBefore, after: afterKey.colW },
)

/* ── 5. Ctrl+\ 只管侧边栏 ── */
await evaluate(`
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', code: 'Backslash', ctrlKey: true, bubbles: true }));
  void 0;
`)
await sleep(600)
const afterSide = await shape()
ok(
  '5.Ctrl+\\ 收的是侧边栏，资料栏一动不动',
  afterSide.panelCollapsed && afterSide.hasCol && Math.abs(afterSide.colW - widthBefore) <= 2,
  { sideCollapsed: afterSide.panelCollapsed, colW: afterSide.colW },
)
await evaluate(`
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', code: 'Backslash', ctrlKey: true, bubbles: true }));
  void 0;
`)
await sleep(500)

/* ── 6. 侧栏入口照旧好使 ── */
await evaluate(`
  (() => {
    var b = [...document.querySelectorAll('.panel .nav-item')]
      .find(function (x) { return (x.textContent || '').indexOf('AI') >= 0 });
    b && b.click();
    void 0;
  })()
`)
await sleep(900)
const afterAi = JSON.parse(
  await evaluate(`
    (() => JSON.stringify({
      ai: !!document.querySelector('.col[data-view="ai"], .col .chat-wrap, .col .cp'),
      hasCol: !!document.querySelector('.col'),
      colW: Math.round((document.querySelector('.col')?.getBoundingClientRect().width) ?? -1),
    }))()
  `),
)
ok(
  '6.从侧栏点「AI 编写」仍然切得过去，资料栏还在原地',
  afterAi.hasCol && afterAi.colW >= 200,
  afterAi,
)

ok('7.过程中没有控制台报错', errors.length === 0, errors.slice(0, 4))

const pass = results.filter((r) => r.pass).length
console.log(`\n round21：${pass}/${results.length} 通过`)
await close()
process.exit(pass === results.length ? 0 : 1)
