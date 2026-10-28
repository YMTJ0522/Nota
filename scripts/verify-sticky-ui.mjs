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
window.__shots = [];
window.__onColor = null;
window.__bind = null;
window.sticky = {
  load: async (id) => {
    window.__calls.push(['load', id]);
    return { text: '第一行标题\\n第二行正文', pinned: true, color: 'amber' };
  },
  init: async () => {
    window.__calls.push(['init']);
    return { id: 's-test', text: '第一行标题\\n第二行正文', pinned: true, color: 'amber' };
  },
  onBind: (cb) => {
    window.__calls.push(['onBind']);
    window.__bind = cb;
  },
  write: async (id, t) => { window.__calls.push(['write', id, t]); },
  close: async (id) => { window.__calls.push(['close', id]); },
  pin: async (id, p) => { window.__calls.push(['pin', id, p]); return true; },
  color: async (id, c) => { window.__calls.push(['color', id, c]); return true; },
  saveToVault: async (id) => { window.__calls.push(['save', id]); return { ok: true, rel: '便签/第一行标题.md' }; },
  remove: async (id) => { window.__calls.push(['remove', id]); return true; },
  onFocus: (cb) => { window.__onFocus = cb; },
  onColor: (cb) => { window.__onColor = cb; },
  shotUrl: async (n) => {
    window.__calls.push(['shotUrl', n]);
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  },
  addShot: async (id, buf, ext) => {
    window.__calls.push(['addShot', id, buf.length, ext, buf instanceof Uint8Array]);
    const name = 's-test-shot' + (window.__shots.length + 1) + '.' + ext;
    window.__shots.push(name);
    return { ok: true, name, shots: window.__shots.slice() };
  },
  removeShot: async (id, name) => {
    window.__calls.push(['removeShot', id, name]);
    window.__shots = window.__shots.filter((n) => n !== name);
    return window.__shots.slice();
  },
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
    initCalled: (window.__calls || []).some(c => c[0] === 'init'),
    bindHooked: typeof window.__bind === 'function',
  };
})()`)
ok('便签窗口有输入框', boot.hasTa)
eq('把上次的内容读进来了', boot.text, '第一行标题\n第二行正文')
ok('光标已经在输入框里（不用再点一下）', boot.focused, JSON.stringify(boot))
ok('光标停在末尾，接着上次写', boot.caret === boot.len, String(boot.caret))
ok('开场数据是问主进程要的（不是从地址栏读 id）', boot.initCalled)
ok('窗口监听了「被认领」这条推送', boot.bindHooked)

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

/* ── 主进程推过来的纸色 ──
   列表里右键换了颜色，这张纸要当场跟着换。只写盘不推的话，用户看到的是
   「点了颜色，屏幕上没反应」，很容易以为没生效，再点一次别的。
   （这一段以前是盲的：fake 的 window.sticky 缺 onColor，onMounted 里那行
   抛成 unhandled rejection，界面上什么都不报，于是「没有脚本报错」照样绿。） */
const colorPushed = await evaluate(`(() => {
  if (typeof window.__onColor !== 'function') return { hooked: false };
  window.__onColor('mint');
  return { hooked: true };
})()`)
ok('窗口监听了主进程推来的纸色（onColor 挂上了）', colorPushed.hooked === true, JSON.stringify(colorPushed))
await sleep(160)
const bgPushed = await evaluate(`getComputedStyle(document.querySelector('.note')).backgroundColor`)
ok('推过来之后纸色当场换了（薄荷绿，不是等下次打开）', /rgb\(226, 242, 228\)/.test(bgPushed), bgPushed)

/* ── 粘贴图片 ──
   正文是纯文本 + 逐行对齐的镜像层，图要是插进正文，那层对齐就废了。
   所以图走纸底的托盘。这里断的是「剪贴板里是图片」这一种被接住、
   而且落到了 addShot。 */
const pasted = await evaluate(`(() => {
  const ta = document.querySelector('textarea');
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'clip.png', { type: 'image/png' }));
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  ta.dispatchEvent(ev);
  return { files: dt.files.length, prevented: ev.defaultPrevented };
})()`)
eq('剪贴板里能取到那张图', pasted.files, 1)
ok('粘贴被接管，不会把图塞进正文', pasted.prevented === true, JSON.stringify(pasted))
await sleep(500)
const tray = await evaluate(`(() => {
  const t = document.querySelector('.tray');
  return {
    hasTray: !!t,
    shots: document.querySelectorAll('.shot').length,
    calls: (window.__calls || []).filter((c) => c[0] === 'addShot'),
  };
})()`)
ok('图挂到纸底的托盘里', tray.hasTray === true, JSON.stringify(tray))
eq('托盘里有一张', tray.shots, 1)
ok(
  '调 addShot 时带的是原始字节（不是 base64 字符串）和真扩展名',
  tray.calls.length === 1 && tray.calls[0][2] === 8 && tray.calls[0][3] === 'png' && tray.calls[0][4] === true,
  JSON.stringify(tray.calls),
)
eq('addShot 带的是这张纸的 id', tray.calls[0]?.[1], 's-test')

/* 拖进来一张也认。拖的是文字就不该接管（否则正文没法选中拖走） */
const dragged = await evaluate(`(() => {
  const note = document.querySelector('.note');
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'drag.png', { type: 'image/png' }));
  const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
  note.dispatchEvent(ev);
  const textOnly = new DragEvent('drop', { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true });
  note.dispatchEvent(textOnly);
  return { img: ev.defaultPrevented, text: textOnly.defaultPrevented };
})()`)
ok('拖图进窗口也会被接住', dragged.img === true, JSON.stringify(dragged))
ok('拖的不是文件就不接管', dragged.text === false, JSON.stringify(dragged))
await sleep(500)
eq('托盘里变成两张', await evaluate(`document.querySelectorAll('.shot').length`), 2)

/* 点缩略图看大图 —— 便签窗口太小，缩略图只够认出是哪张 */
await evaluate(`document.querySelectorAll('.shot img')[0].click()`)
await sleep(220)
const zoom = await evaluate(`(() => {
  const z = document.querySelector('.zoom');
  return { open: !!z, src: z ? (z.querySelector('img') || {}).getAttribute('src') : '' };
})()`)
ok('点缩略图能看大图', zoom.open === true, JSON.stringify(zoom))
ok('大图用的是同一个地址', String(zoom.src || '').startsWith('data:image/png'), String(zoom.src).slice(0, 24))
await evaluate(`document.querySelector('.zoom').click()`)
await sleep(200)
eq('点一下收起来', await evaluate(`!!document.querySelector('.zoom')`), false)

/* 单张删掉 */
await evaluate(`document.querySelectorAll('.shot .del')[0].click()`)
await sleep(400)
const afterDel = await evaluate(`(() => ({
  shots: document.querySelectorAll('.shot').length,
  calls: (window.__calls || []).filter((c) => c[0] === 'removeShot'),
}))()`)
eq('删掉一张后托盘剩一张', afterDel.shots, 1)
ok('删的时候只删那一张（带的是它的文件名）', afterDel.calls.length === 1 && /^s-test-shot1\./.test(afterDel.calls[0][2]), JSON.stringify(afterDel.calls))

/* 全部删掉 → 托盘自己消失，不留一条空托盘占着正文高度 */
await evaluate(`document.querySelectorAll('.shot .del')[0].click()`)
await sleep(400)
eq('最后一张删掉后托盘整个消失', await evaluate(`!!document.querySelector('.tray')`), false)
eq('删完正文还在（删图不该动字）', await evaluate(`document.querySelector('textarea').value.includes('刚加的一句')`), true)

/* ── 池窗口被认领：整份覆盖，一点残影都不许留 ──
   这是「预热池」那条路最容易出的事故：同一个窗口先装着「买牛奶」，
   转身被认领成一张新纸，如果正文/图/纸色/提示有一项没重置，用户会看到
   上一张纸的残渣混在新纸上 —— 比慢更让人不敢用。所以这里先把各项都弄脏
   （有正文、有图、有纸色、有提示），再推一份完全不同的数据进去。 */
await evaluate(`(() => {
  const note = document.querySelector('.note');
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([9, 9, 9])], 'left.png', { type: 'image/png' }));
  note.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
})()`)
await sleep(450)
eq('认领之前托盘里挂着上一张的图', await evaluate(`document.querySelectorAll('.shot').length`), 1)

const rebound = await evaluate(`(() => {
  if (typeof window.__bind !== 'function') return { ok: false };
  window.__bind({ id: 's-second', text: '换了一张纸', pinned: false, color: 'slate', tags: ['临时'], shots: [] });
  return { ok: true };
})()`)
ok('窗口上挂着 onBind，认领时有路可走', rebound.ok === true)
await sleep(500)
const afterBind = await evaluate(`(() => ({
  text: document.querySelector('textarea').value,
  bg: getComputedStyle(document.querySelector('.note')).backgroundColor,
  tray: !!document.querySelector('.tray'),
  hint: document.querySelector('.hint') ? document.querySelector('.hint').textContent : '',
  swatches: document.querySelectorAll('.sw').length,
  zoom: !!document.querySelector('.zoom'),
  focused: document.activeElement === document.querySelector('textarea'),
}))()`)
eq('认领后正文换成新那张纸的', afterBind.text, '换了一张纸')
ok('认领后纸色跟着换（石板灰，不是上一张的）', /rgb\(235, 235, 235\)/.test(afterBind.bg), afterBind.bg)
eq('认领后上一张的图不许留在托盘里', afterBind.tray, false)
eq('认领后提示清掉', afterBind.hint, '')
eq('认领后色板是收起的', afterBind.swatches, 0)
eq('认领后不会莫名其妙顶出大图', afterBind.zoom, false)
ok('认领后光标还在正文里（接着就能打字）', afterBind.focused, JSON.stringify(afterBind))

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
