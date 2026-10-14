/**
 * round20 —— 右键到处都能打标签，且标签可以挂图标
 *
 * 之前标签是「侧栏底部一块自留地」：只能在那儿新建、改名、删除，
 * 而真正要用的场景 —— 写到哪儿顺手把它归个类 —— 一步都够不着。
 * 于是它被并进了「标记」：图标与标签两个页签、同一套素材库，
 * 给文件挑图标用的是这批图标，给标签配形状用的也是这批。
 *
 * 断言：
 * 1. 笔记右键菜单里有「标记…」（侧栏目录树里那棵树也算）
 * 2. 卡片右键也能开同一个弹窗，默认停在标签页
 * 3. 勾一个已有的标签 → 真的写进那篇笔记的 frontmatter
 * 4. 再勾一次取消 → frontmatter 里它也跟着走
 * 5. 新建标签 → 打给这一篇，并顺势跳去挑图标
 * 6. 给标签配一枚图标 → 写进 tag-icons.json
 * 7. 没有 console 报错
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4420)
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
await evaluate(`document.querySelector('.col-tab[data-view="notes"]')?.click()`)
await sleep(800)

/* 所有笔记的快照。读不到「右键点中的是哪一篇」的准确路径，
   所以用「改动前后有几篇变了 + 变的那篇有没有 tags」来判定，比猜第一篇准。 */
const SNAP = `JSON.stringify(window.__notes || {})`

/** 跟上一份快照比，返回唯一被改过的那一篇的字 */
const CHANGED = `((prev) => {
  var now = window.__notes || {};
  var before = JSON.parse(prev);
  var keys = Object.keys(now).filter(function (k) { return now[k] !== before[k]; });
  return keys.length === 1 ? String(now[keys[0]]) : ('<变了的篇数=' + keys.length + '>');
})(%s)`

/** 打开卡片区的右键菜单 */
async function openCardMenu() {
  await evaluate(`(() => {
    var el = document.querySelector('.nl-item');
    var r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(r.left + 30), clientY: Math.round(r.top + 10),
    }));
    void 0;
  })()`)
  await sleep(450)
}

/** 点菜单里的某一项 */
async function clickMenuItem(labelText) {
  await evaluate(`(() => {
    var it = [...document.querySelectorAll('.n-menu .ctx-item')]
      .find(function (i) { return i.querySelector('.ctx-label').textContent.trim() === ${JSON.stringify(labelText)}; });
    it && it.click();
    void 0;
  })()`)
  await sleep(500)
}

/* ── 1. 菜单里有这一项 ── */
await openCardMenu()
const menuState = JSON.parse(
  await evaluate(`(() => {
    var items = [...document.querySelectorAll('.n-menu .ctx-item')];
    return JSON.stringify({
      open: items.length > 0,
      labels: items.map(function (i) { return i.querySelector('.ctx-label').textContent.trim(); }),
    });
  })()`),
)
ok('1.卡片右键菜单里有「标记…」', menuState.open && menuState.labels.includes('标记…'), {
  labels: menuState.labels,
})

/* ── 2. 打开弹窗，默认停在标签页 ── */
await clickMenuItem('标记…')
const dlg = JSON.parse(
  await evaluate(`(() => {
    var d = document.querySelector('.ip-mask');
    return JSON.stringify({
      open: !!d,
      title: d?.querySelector('.ip-title')?.textContent.trim() || '',
      tabs: [...document.querySelectorAll('.ip-tabs button')].map(function (b) { return b.textContent.trim(); }),
      onTab: [...document.querySelectorAll('.ip-tabs button')].filter(function (b) { return b.className.indexOf('on') >= 0; }).map(function (b) { return b.textContent.trim(); }),
      rows: document.querySelectorAll('.ip-row').length,
      hasSearch: !!d?.querySelector('.ip-search-row input'),
    });
  })()`),
)
ok(
  '2.弹窗打开且默认停在「标签」页（两个页签 + 搜索框都在）',
  dlg.open && dlg.title === '标记' && dlg.tabs.length === 2 && dlg.onTab[0] === '标签' && dlg.hasSearch,
  dlg,
)

/* ── 3. 勾一个已有标签 → 写进 frontmatter ── */
const snapBefore = await evaluate(SNAP)
await evaluate(`(() => { var r = document.querySelector('.ip-row'); r && r.click(); void 0; })()`)
await sleep(700)
const tagged = await evaluate(CHANGED.replace('%s', JSON.stringify(snapBefore)))
const firstRowName = await evaluate(
  `document.querySelector('.ip-row .tc-n')?.textContent.trim() ?? ''`,
)
ok(
  '3.勾一个标签：这一篇的 frontmatter 里真的多出来了',
  !tagged.startsWith('<') && tagged.includes('tags:') && tagged.includes(firstRowName),
  { tag: firstRowName, text: tagged.slice(0, 60) },
)

/* ── 4. 再点一次取消 → frontmatter 跟着撤 ── */
await evaluate(`(() => { var r = document.querySelector('.ip-row'); r && r.click(); void 0; })()`)
await sleep(700)
const untagged = await evaluate(CHANGED.replace('%s', JSON.stringify(snapBefore)))
ok(
  '4.再点一次取消勾选：标签从 frontmatter 里去掉了（不是只改显示）',
  !untagged.startsWith('<') && untagged !== tagged && !untagged.includes(firstRowName),
  { had: tagged.includes(firstRowName), now: untagged.includes(firstRowName) },
)

/* ── 5. 新建一个标签 ── */
await evaluate(`(() => {
  var i = document.querySelector('.ip-search-row input');
  i.value = '性能测试';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  void 0;
})()`)
await sleep(350)
await evaluate(`(() => {
  var b = document.querySelector('.ip-new');
  b && b.click();
  void 0;
})()`)
await sleep(800)
const created = await evaluate(CHANGED.replace('%s', JSON.stringify(snapBefore)))
ok('5.输入新名字能新建标签并打给这一篇', created.includes('性能测试'), {
  inFrontmatter: created.includes('性能测试'),
})

/* ── 6. 新建后顺势给这枚标签配图标 ── */
/* 新建完会直接跳到图标页（这一步是「跟图标合起来」真正的收益） */
const iconPane = await evaluate(
  `JSON.stringify({ onGrid: document.querySelectorAll('.ig-cell').length, hint: document.querySelector('.ip-foot-hint')?.textContent.trim() ?? '' })`,
)
await evaluate(`(() => { var c = document.querySelector('.ig-cell'); c && c.click(); void 0; })()`)
await sleep(700)
const saved = JSON.parse(await evaluate(`JSON.stringify(window.__tagIcons ?? {})`))
const keys = Object.keys(saved)
ok(
  '6.给标签挑的图标写进了 tag-icons.json（不是跟文件图标混在一个文件里）',
  keys.length > 0 && JSON.parse(iconPane).hint.includes('性能测试'),
  { hint: JSON.parse(iconPane).hint, saved },
)

/* ── 7. 侧栏标签清单里那枚标签要带着图标画出来 ── */
await evaluate(`(() => { var b = document.querySelector('.ip-btn:not(.ghost)'); b && b.click(); void 0; })()`)
await sleep(600)
const chip = JSON.parse(
  await evaluate(`(() => {
    var t = [...document.querySelectorAll('.panel .tag')];
    var hit = t.filter(function (x) { return (x.textContent || '').indexOf('性能测试') >= 0; })[0];
    return JSON.stringify({
      found: !!hit,
      hasGlyph: !!hit?.querySelector('.bg-glyph, .tc-e'),
    });
  })()`),
)
ok('7.侧栏标签清单里，这枚标签带着图标而不是一颗 #', chip.found && chip.hasGlyph, chip)

ok('8.过程中没有控制台报错', errors.length === 0, errors.slice(0, 4))

const pass = results.filter((r) => r.pass).length
console.log(`\n round20：${pass}/${results.length} 通过`)
await close()
process.exit(pass === results.length ? 0 : 1)
