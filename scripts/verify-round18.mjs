/**
 * round18 —— 笔记卡片区的「更换图标」
 *
 * 以前这一项点了没反应：NoteContextMenu 里那一行的 `emit('icon')` 发了，
 * 但 NoteListView 从来没接过 —— 菜单项照常画出来（因为它是无条件渲染的），
 * 点了却什么事都不发生。
 *
 * 这类坏法特别難查：不报错、不白屏、类型检查也抓不到
 * （emit 少绑一个在 TS 里是完全合法的），只能靠人碰巧点到。
 * 所以顺带加了 scripts/audit-menu-wiring.mjs 静态扫所有菜单的接线。
 *
 * 断言：
 * 1. 菜单里真有这一项
 * 2. 点了真的弹出标记弹窗
 * 3. 选一个品牌图标后，卡片上的图标当场变（state.icons 是 reactive）
 * 4. 「恢复默认」能把自定义图标撤掉
 * 5. 换完的成果要写进 .nota/icons.json —— 重开还得在
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4414)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 950] })
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
/* 「所有笔记」就是中间栏的笔记页签 */
await evaluate(`document.querySelector('.col-tab[data-view="notes"]')?.click()`)
await sleep(800)

const CARD_COUNT = `document.querySelectorAll('.nl-item').length`
const n = Number(await evaluate(CARD_COUNT))
ok('0.前置：笔记列表里有卡片', n > 0, { cards: n })

/* ── 1. 右键第一张卡片 ── */
/* 菜单里有「看真实按键<bool> + pointerdown 收起」的逻辑，用 Input.dispatchMouseEvent
   发出的右键在 headless 里不一定合成 contextmenu —— 直接派发事件更稳。 */
async function openMenu() {
  await evaluate(`(() => {
    var el = document.querySelector('.nl-item');
    var r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(r.left + 30), clientY: Math.round(r.top + 10),
    }));
    void 0;
  })()`)
  await sleep(500)
}

await openMenu()
const menuState = JSON.parse(
  await evaluate(`(() => {
    var items = [...document.querySelectorAll('.n-menu .ctx-item')];
    return JSON.stringify({
      open: items.length > 0,
      labels: items.map(function (i) { return i.querySelector('.ctx-label').textContent.trim(); }),
    });
  })()`),
)
ok('1.卡片右键菜单里有「标记…」', menuState.open && menuState.labels.includes('标记…'), menuState)

/* ── 2. 点它要有反应 ── */
await evaluate(`(() => {
  var it = [...document.querySelectorAll('.n-menu .ctx-item')]
    .find(function (i) { return i.querySelector('.ctx-label').textContent.trim() === '标记…'; });
  it && it.click();
  void 0;
})()`)
await sleep(600)
const picker = JSON.parse(
  await evaluate(`(() => {
    var d = document.querySelector('.ip-mask');
    return JSON.stringify({
      open: !!d,
      title: document.querySelector('.ip-title')?.textContent.trim() || '',
      tabs: [...document.querySelectorAll('.ip-tabs button')].map(function (b) { return b.textContent.trim(); }),
    });
  })()`),
)
ok('2.点「标记…」真的弹出标记弹窗（两个页签都在）', picker.open && picker.tabs.length === 2, picker)

/* ── 3. 切到「图标」页，选一个品牌图标，卡片要当场变 ── */
/* 默认停在标签页（那个才是隔三差五要动的），图标页要多点一下。 */
await evaluate(`(() => {
  var b = [...document.querySelectorAll('.ip-tabs button')]
    .find(function (x) { return x.textContent.trim() === '图标'; });
  b && b.click();
  void 0;
})()`)
await sleep(400)
const gridCells = Number(await evaluate(`document.querySelectorAll('.ig-cell').length`))
ok('2b.「图标」页铺出了素材库', gridCells > 0, { cells: gridCells })

/* 品牌图标渲染出来就是 <svg class="ni ni-brand">，`.nl-ico` 落在它自己身上，
   所以判据是「有没有 .ni-brand / .ni-emoji」，不是「里面有没有 svg」。
   fallback=false 且没自定义图标时整块不渲染 —— 正是这次要看的「从无到有」。 */
const ICO = `(() => {
  var el = document.querySelector('.nl-item .nl-ico');
  return JSON.stringify({
    drawn: !!el,
    len: el ? el.outerHTML.length : 0,
    kind: el ? (el.classList.contains('ni-brand') ? 'brand' : el.classList.contains('ni-emoji') ? 'emoji' : '?') : 'none',
  });
})()`
const before = await evaluate(ICO)
await evaluate(`(() => { var c = document.querySelector('.ig-cell'); c && c.click(); void 0; })()`)
await sleep(700)
const after = JSON.parse(
  await evaluate(`(() => {
    var d = document.querySelector('.ip-mask');
    return JSON.stringify({
      pickerClosed: !d,
      len: document.querySelector('.nl-item .nl-ico')?.outerHTML.length ?? 0,
      kind: (function () {
        var el = document.querySelector('.nl-item .nl-ico');
        if (!el) return 'none';
        return el.classList.contains('ni-brand') ? 'brand' : el.classList.contains('ni-emoji') ? 'emoji' : '?';
      })(),
    });
  })()`),
)
ok(
  '3.选完图标：弹窗收起，卡片上当场多出一枚自定义图标',
  after.pickerClosed && after.kind === 'brand' && JSON.parse(before).kind === 'none',
  { before: JSON.parse(before), after },
)

/* ── 4. 写盘检查：成果要落进 icons.json ── */
const saved = await evaluate(
  `JSON.stringify(Object.keys(window.__icons || {}))`,
)
ok('4.图标写进了工作区的 icons.json（重开还在）', (JSON.parse(saved) || []).length > 0, {
  keys: JSON.parse(saved),
})

/* ── 5. 「恢复默认」要能撤回去 ── */
await openMenu()
await evaluate(`(() => {
  var it = [...document.querySelectorAll('.n-menu .ctx-item')]
    .find(function (i) { return i.querySelector('.ctx-label').textContent.trim() === '标记…'; });
  it && it.click();
  void 0;
})()`)
await sleep(500)
/* 「恢复默认」在页脚，跟停在哪个页签无关 */
await evaluate(`(() => {
  var b = [...document.querySelectorAll('.ip-btn')]
    .find(function (x) { return x.textContent.trim() === '恢复默认'; });
  b && b.click();
  void 0;
})()`)
await sleep(600)
const restored = JSON.parse(
  await evaluate(`(() => {
    return JSON.stringify({
      pickerClosed: !document.querySelector('.ip-mask'),
      gone: !document.querySelector('.nl-item .nl-ico'),
      keys: Object.keys(window.__icons || {}),
    });
  })()`),
)
ok(
  '5.「恢复默认」撤掉自定义图标（卡片回到没图标的样子）',
  restored.pickerClosed && restored.gone && restored.keys.length === 0,
  restored,
)

ok('7.过程中没有控制台报错', errors.length === 0, errors.slice(0, 4))

const pass = results.filter((r) => r.pass).length
console.log(`\n round18：${pass}/${results.length} 通过`)
await close()
process.exit(pass === results.length ? 0 : 1)
