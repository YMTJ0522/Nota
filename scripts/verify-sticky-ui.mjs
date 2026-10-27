/**
 * 便签窗口的界面体检（sticky.html）。
 *
 * 便签窗口是独立入口，和主界面共用不到任何东西，所以它得单独验一遍：
 * 自动保存有没有真的发出去、Esc 会不会在中文输入法组词时误关窗口、
 * 存为笔记之后按钮状态对不对。
 *
 * 这里 window.sticky 是假的（真东西来自 electron/preload-sticky.ts，
 * 在浏览器里没有）—— 断言的是「界面有没有在该调的时候调对方法」。
 * 主进程那一侧（快捷键、托盘、单例锁）只能在真实 Electron 里手工验。
 *
 * 用法：node scripts/verify-sticky-ui.mjs
 */
import { launch } from './cdp-harness.mjs'

const PORT = 4488
const SIZE = [340, 300]

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  \x1b[32m✓\x1b[0m ' + name)
  } else {
    fail++
    console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : ''))
  }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`)
}

const FAKE = `
window.__calls = [];
window.sticky = {
  load: async (id) => {
    window.__calls.push(['load', id]);
    return { text: '第一行标题\\n第二行正文', pinned: true, color: 'amber' };
  },
  write: async (id, t) => { window.__calls.push(['write', id, t]); },
  close: async (id) => { window.__calls.push(['close', id]); },
  pin: async (id, p) => { window.__calls.push(['pin', id, p]); return true; },
  color: async (id, c) => { window.__calls.push(['color', id, c]); return true; },
  saveToVault: async (id) => { window.__calls.push(['save', id]); return { ok: true, rel: '便签/第一行标题.md' }; },
  remove: async (id) => { window.__calls.push(['remove', id]); return true; },
  onFocus: (cb) => { window.__onFocus = cb; },
};
`

const { send, evaluate, sleep, shot, close } = await launch({ port: PORT, size: SIZE, scale: 2 })

await send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/sticky.html?id=s-test` })
await sleep(900)

/* ── 起来就该能打字 ── */
const boot = await evaluate(`(() => {
  const ta = document.querySelector('textarea');
  return {
    hasTa: !!ta,
    text: ta ? ta.value : '',
    focused: document.activeElement === ta,
    caret: ta ? ta.selectionStart : -1,
    len: ta ? ta.value.length : 0,
    loadCalled: (window.__calls || []).some(c => c[0] === 'load' && c[1] === 's-test'),
  };
})()`)
ok('便签窗口有输入框', boot.hasTa)
eq('把上次的内容读进来了', boot.text, '第一行标题\n第二行正文')
ok('光标已经在输入框里（不用再点一下）', boot.focused, JSON.stringify(boot))
ok('光标停在末尾，接着上次写', boot.caret === boot.len, String(boot.caret))
ok('按窗口参数里的 id 去取了内容', boot.loadCalled)

/* ── 打字 → 自动保存 ── */
await evaluate(`(() => {
  const ta = document.querySelector('textarea');
  ta.value = '第一行标题\\n第二行正文\\n刚加的一句';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
})()`)
// 防抖 280ms，等它跨过去
await sleep(80)
const early = await evaluate(`(window.__calls || []).filter(c => c[0] === 'write').length`)
ok('刚敲完不会立刻写盘（有防抖）', early === 0, `已经写了 ${early} 次`)
await sleep(420)
const after = await evaluate(`(window.__calls || []).filter(c => c[0] === 'write')`)
ok('停手之后自动写盘', after.length >= 1, String(after.length))
ok(
  '写下去的是最新正文',
  after.length > 0 && String(after.at(-1)[2]).includes('刚加的一句'),
  after.length ? String(after.at(-1)[2]).slice(-20) : '',
)
ok(
  '写的时候带的是本窗口的 id',
  after.length > 0 && after.at(-1)[1] === 's-test',
  after.length ? after.at(-1)[1] : '',
)

/* ── 钉住 / 换色 ──
   头部按钮按 title 找，不按位置找。
   位置是会变的：2.7.13 把「当前纸色」那颗圆点换成了调色板图标，
   顺序从 [图钉, 圆点, 笔, 叉] 变成 [调色板, 图钉, 笔, 叉]，
   按下标点的断言会在没人动过功能的情况下集体报错。 */
async function clickIco(kw) {
  return evaluate(`(() => {
    const bs = [...document.querySelectorAll('header .ico')];
    const b = bs.find((x) => (x.title || '').includes(${JSON.stringify(kw)}));
    if (!b) throw new Error('头部没有「' + ${JSON.stringify(kw)} + '」按钮，现有：' + bs.map((x) => x.title).join(' / '));
    b.click();
    return b.title;
  })()`)
}

await clickIco('钉')
await sleep(120)
const pinCall = await evaluate(`(window.__calls || []).filter(c => c[0] === 'pin')`)
ok('点图钉会调 pin，并且取反', pinCall.length === 1 && pinCall[0][2] === false, JSON.stringify(pinCall))

await clickIco('换纸色')
await sleep(200)
const swatches = await evaluate(`document.querySelectorAll('.sw').length`)
eq('点调色板弹出六种纸色', swatches, 6)

await evaluate(`document.querySelectorAll('.sw')[3].click()`)
await sleep(160)
const colorCall = await evaluate(`(window.__calls || []).filter(c => c[0] === 'color')`)
ok('选色会调到 color', colorCall.length === 1, JSON.stringify(colorCall))
eq('选的是第四个（天蓝）', colorCall[0]?.[2], 'sky')
const bg = await evaluate(`getComputedStyle(document.querySelector('.note')).backgroundColor`)
ok('纸色真的变了（不是只记了个 key）', /rgb\(227, 237, 249\)/.test(bg), bg)

/* ── 存为笔记 ── */
await clickIco('存为笔记')
await sleep(300)
const saveCall = await evaluate(`(window.__calls || []).filter(c => c[0] === 'save')`)
ok('点笔按钮会存进笔记库', saveCall.length === 1, JSON.stringify(saveCall))
const hint = await evaluate(`document.querySelector('.hint')?.textContent || ''`)
ok('存完给了一句回执', hint.includes('便签/第一行标题.md'), hint)

/* ── 存完自己收起 ──
   存进库之后 700ms 会自己 close（「搬进库就是终点」）。
   这一段必须先等它发生并把这次 close 记成基准数：后面测 Esc 时
   如果从 0 开始数，会自动收起那一次算进去，报出「Esc 关了两回」的假警报。 */
await sleep(1100)
const autoClose = await evaluate(`(window.__calls || []).filter(c => c[0] === 'close').length`)
eq('存完一会儿自己收起来', autoClose, 1)

/* ── Esc 关闭，但组词中不能误关 ── */
await evaluate(`(() => {
  const ta = document.querySelector('textarea');
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }));
})()`)
await sleep(150)
eq(
  '中文输入法组词时按 Esc 不关窗口',
  await evaluate(`(window.__calls || []).filter(c => c[0] === 'close').length`),
  autoClose,
)

await evaluate(`(() => {
  const ta = document.querySelector('textarea');
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
})()`)
await sleep(200)
const closeCall = await evaluate(`(window.__calls || []).filter(c => c[0] === 'close')`)
eq('正常按 Esc 关掉这张便签', closeCall.length, autoClose + 1)

/* ── 关之前有没有把最后那一笔写下去 ──
   close 之前必须先 write 一次：直接发 close 的话，主进程手里那份
   是上一次上报的内容，正在打的这半句会丢。 */
const order = await evaluate(`(() => {
  const c = window.__calls || [];
  const lastWrite = c.map(x => x[0]).lastIndexOf('write');
  const closeAt = c.map(x => x[0]).lastIndexOf('close');
  return { lastWrite, closeAt };
})()`)
ok('关闭之前先写了一次盘', order.lastWrite >= 0 && order.lastWrite < order.closeAt, JSON.stringify(order))

/* ── 纸不许被 body 里多出来的东西推下去 ──
   真机上报过「内容同时出现在顶部和正文里」：body 里多了一个行盒（一段裸文字），
   纸按 height:100% 顺着流排，就被顶下去 20 多像素，那行字还明晃晃露在标题栏上方。
   钉成 position:fixed 之后，多什么都不该动位置、也不该露出来。 */
await evaluate(`(() => {
  const n = document.createTextNode('55555');
  document.body.insertBefore(n, document.body.firstChild);
})()`)
await sleep(150)
const guard = await evaluate(`(() => {
  const bar = document.querySelector('.bar').getBoundingClientRect();
  const note = document.querySelector('.note').getBoundingClientRect();
  const hit = document.elementFromPoint(4, 6);
  return {
    barTop: bar.top,
    noteTop: note.top,
    hitInsideNote: !!(hit && hit.closest && hit.closest('.note')),
  };
})()`)
ok('body 里多出一行裸文字，纸的位置不动', guard.noteTop === 0 && guard.barTop === 0, JSON.stringify(guard))
ok('那行裸文字被纸盖住（点上去命中的是纸）', guard.hitInsideNote, JSON.stringify(guard))

/* ── 控制台不能有报错 ── */
const errs = await evaluate(`(window.__errs || []).length`)
ok('没有脚本报错', !errs, String(errs))

await shot('.tmp-sticky-ui.png').catch(() => {})
await close()

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
