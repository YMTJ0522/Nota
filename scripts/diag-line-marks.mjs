/**
 * 验「标行」和远程图片弹窗。
 *
 * 三件事必须真点一遍才算数：
 *   1. 光标放进代码块 → 点工具栏那颗按钮 → 围栏行真的多了 `{n}`；
 *      再点一次 → 撤干净，且顺手开的 `line-numbers` 也一起退回去；
 *   2. 围栏右上角那颗「行号」chip 能开关行号轨；
 *   3. 「远程图片链接」弹的是弹窗，填完能插进正文（而不是往光标处插一对空括号）。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4412)
const { send, evaluate, sleep, errors, close, shot } = await launch({ port: PORT, size: [1500, 950] })

const NOTE = [
  '# 标行靶子',
  '',
  '正文一段，用来试「选中一段字直接包成代码块」。',
  '',
  '```ts',
  'export interface Note {',
  '  path: string',
  '  tags: string[]',
  '}',
  '```',
  '',
  '结尾一段。',
  '',
].join('\n')

const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/标行靶子.md': NOTE },
  tree: [
    ...makeTree(),
    { type: 'file', name: '标行靶子.md', path: '/ws/标行靶子.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' },
  ],
})

let bad = 0
function ok(name, cond, extra = '') {
  if (cond) console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`)
  else {
    bad += 1
    console.log(`❌ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

/** 真按鼠标点（顺带检验有没有被别的层盖住） */
async function clickAt(selector) {
  const raw = await evaluate(`
    (() => {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      var b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) return null;
      return JSON.stringify({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
    })()
  `)
  if (!raw || raw === 'null') return false
  const p = JSON.parse(raw)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await sleep(320)
  return true
}

/** 点某一行落光标 */
async function clickLine(text) {
  const raw = await evaluate(`
    (() => {
      var ls = [...document.querySelectorAll('.cm-line')];
      var el = ls.find((e) => (e.textContent || '').trim() === ${JSON.stringify(text)});
      if (!el) return null;
      var b = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.x + 10), y: Math.round(b.y + b.height / 2) });
    })()
  `)
  if (!raw || raw === 'null') return false
  const p = JSON.parse(raw)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await sleep(350)
  return true
}

const FENCE = `(() => {
  var v = window.__notaView; if (!v) return '';
  var t = v.state.doc.toString().split('\\n').find((l) => l.trim().startsWith('\\u0060\\u0060\\u0060'));
  return t || '';
})()`

const TOAST = `(() => { var e = document.querySelector('.toast, .n-toast, [class*="toast"]'); return e ? e.textContent.trim() : ''; })()`

/* ── 启动 ── */
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1200)
/* 新手引导的遮罩会盖住编辑区（.tour-block），点哪都点不到编辑器。
   它只在 localStorage 没有 nota-tour-seen 时弹，标一下再重载。 */
await evaluate(`localStorage.setItem('nota-tour-seen', '1')`)
await send('Page.reload', {})
await sleep(1400)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)
await evaluate(`document.querySelector('.col-tab[data-view="notes"]')?.click()`)
await sleep(400)
await evaluate(openNoteExpr('标行靶子'))
await sleep(1500)
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="编辑模式"]')?.click()`)
await sleep(900)

/* ── 1. 标行按钮 ── */
const btnBox = await evaluate(`
  (() => { var b = document.querySelector('[data-role="line-marks"]');
    if (!b) return null; var r = b.getBoundingClientRect();
    return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) }); })()
`)
ok('工具栏上有「标行」按钮', btnBox && btnBox !== 'null', btnBox ?? '')

const before = await evaluate(FENCE)
ok('围栏原样（没有 line-numbers）', before === '```ts', before)

await clickLine('path: string')
const titleInFence = await evaluate(
  `(() => { var b = document.querySelector('[data-role="line-marks"]'); return b ? b.getAttribute('title') : ''; })()`,
)
ok('光标进代码块后按钮提示改成「标出第 N 行」', /标出第 2 行/.test(titleInFence), titleInFence)

await clickAt('[data-role="line-marks"]')
const after1 = await evaluate(FENCE)
ok('点一下 → 围栏补上 line-numbers 与 {2}', after1 === '```ts line-numbers {2}', after1)
const toast1 = await evaluate(TOAST)
ok('给了回执', /已标第 2 行/.test(toast1), toast1)

/* 再点一次：应该撤干净，连顺手开的行号一起退 */
await clickAt('[data-role="line-marks"]')
const after2 = await evaluate(FENCE)
ok('再点一次 → 退回原样', after2 === '```ts', after2)

/* ── 1b. 快捷键 Ctrl+Alt+L ── */
await clickLine('path: string')
for (const type of ['keyDown', 'keyUp']) {
  await send('Input.dispatchKeyEvent', {
    type,
    modifiers: 3,
    key: 'l',
    code: 'KeyL',
    windowsVirtualKeyCode: 76,
    nativeVirtualKeyCode: 76,
  })
}
await sleep(400)
const afterKey = await evaluate(FENCE)
ok('Ctrl+Alt+L 等效于点按钮', afterKey === '```ts line-numbers {2}', afterKey)
for (const type of ['keyDown', 'keyUp']) {
  await send('Input.dispatchKeyEvent', {
    type,
    modifiers: 3,
    key: 'l',
    code: 'KeyL',
    windowsVirtualKeyCode: 76,
    nativeVirtualKeyCode: 76,
  })
}
await sleep(400)
ok('再按一次退回', (await evaluate(FENCE)) === '```ts')

/* ── 2. 围栏右上角的 chip ── */
const chips = await evaluate(`
  (() => { var r = document.querySelector('.cm-code-lang-row');
    if (!r) return null;
    return JSON.stringify([...r.querySelectorAll('button')].map((b) => b.textContent.trim())); })()
`)
ok('围栏上有「语言」和「行号」两颗 chip', chips && /行号/.test(chips), chips ?? '')

await clickAt('.cm-code-lang-btn--gutter')
const after3 = await evaluate(FENCE)
ok('点 chip 打开行号', after3 === '```ts line-numbers', after3)

const gutterOn = await evaluate(
  `(() => { var b = document.querySelector('.cm-code-lang-btn--gutter'); return b ? b.classList.contains('on') : false; })()`,
)
ok('chip 自己有开着的状态', gutterOn === true)

await clickAt('.cm-code-lang-btn--gutter')
const after4 = await evaluate(FENCE)
ok('再点 chip 关掉', after4 === '```ts', after4)

/* ── 3. 选中几行一起标 ── */
await clickLine('  path: string')
await evaluate(`
  (() => {
    var v = window.__notaView; var d = v.state.doc;
    var a = d.toString().indexOf('  path: string');
    var b = d.toString().indexOf('  tags: string[]') + '  tags: string[]'.length;
    v.dispatch({ selection: { anchor: a, head: b } });
    v.focus();
  })()
`)
await sleep(300)
await clickAt('[data-role="line-marks"]')
const after5 = await evaluate(FENCE)
ok('选中两行一起标 → {2-3}', after5 === '```ts line-numbers {2-3}', after5)

/* ── 4. 远程图片弹窗 ── */
await clickAt('[data-role="line-marks"]')
await sleep(200)
/* 光标挪到文末：图片要插在正文里，留在代码块里的选区会被整段替换掉 */
await evaluate(`(() => { var v = window.__notaView; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); })()`)
await sleep(200)
await evaluate(`document.querySelector('.tb-btn[title="插入图片或视频"]')?.click()`)
await sleep(400)
const menuHit = await evaluate(`
  (() => { var b = [...document.querySelectorAll('.tb-item')].find((e) => /远程图片链接/.test(e.textContent || ''));
    return b ? b.textContent.trim() : ''; })()
`)
ok('下拉里有「远程图片链接」', /远程图片链接/.test(menuHit), menuHit)

await evaluate(`
  (() => { var b = [...document.querySelectorAll('.tb-item')].find((e) => /远程图片链接/.test(e.textContent || ''));
    if (b) b.click(); })()
`)
await sleep(500)
const dlg = await evaluate(`
  (() => { var d = document.querySelector('.ri'); if (!d) return null;
    return JSON.stringify({ title: d.querySelector('.ri-title')?.textContent || '',
      fields: [...d.querySelectorAll('.ri-label')].map((e) => e.textContent) }); })()
`)
ok('弹窗打开了', dlg && dlg !== 'null', dlg ?? '没开')

const focused = await evaluate(`(() => document.activeElement?.className || '')()`)
ok('焦点落在链接那一格', /ri-input/.test(focused), focused)

/* 填链接（顺手塞一段「从别处复制来的」带 markdown 包裹的地址，检验清洗）。
   图用本地服务上的 dist/icon.png：外网图片在测试机上时通时不通，
   拿它判「预览加载成功」会把网络问题算到代码头上。 */
const IMG = `http://127.0.0.1:${PORT}/icon.png`
await evaluate(`
  (() => {
    var inputs = document.querySelectorAll('.ri-input');
    inputs[0].value = '  ![封面](${IMG})  ';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    var alt = document.querySelectorAll('.ri-input')[1];
    if (!alt.value) { alt.value = '封面'; alt.dispatchEvent(new Event('input', { bubbles: true })); }
  })()
`)
await sleep(1200)

const preview = await evaluate(`
  (() => { var s = document.querySelector('.ri-shot'); if (!s) return null;
    return JSON.stringify({ state: s.getAttribute('data-state'),
      src: s.querySelector('img')?.getAttribute('src') || '' }); })()
`)
ok('预览框认出了链接并加载', preview && /"state":"ok"/.test(preview), preview ?? '')
ok('链接被清洗成纯地址', preview && /127\.0\.0\.1.*icon\.png/.test(preview) && !/!\[/.test(preview))

const dlgBox = JSON.parse(await evaluate(`(() => { var r = document.querySelector('.ri').getBoundingClientRect();
  return JSON.stringify({ x: r.x - 30, y: r.y - 30, width: r.width + 60, height: r.height + 60 }); })()`))
await shot('.keep/marks/image-dialog.png', dlgBox)

await evaluate(`document.querySelector('.ri-primary')?.click()`)
await sleep(600)
const doc = await evaluate(`(() => window.__notaView.state.doc.toString())()`)
ok('插进了正文', doc.includes(`![封面](<${IMG}>)`), (doc.split('\n').find((l) => l.startsWith('![')) || ''))

/* ── 收尾截图：代码块的样子 ── */
await evaluate(`
  (() => {
    var v = window.__notaView; var d = v.state.doc;
    var a = d.toString().indexOf('  path: string');
    var b = d.toString().indexOf('  tags: string[]') + '  tags: string[]'.length;
    v.dispatch({ selection: { anchor: a, head: b } });
    v.focus();
  })()
`)
await sleep(300)
await clickAt('[data-role="line-marks"]')
await sleep(400)
/* 把光标挪走再截图：留着选区会把标出来的那层淡底盖住，
   截图就看不出「编辑器里也有反应」这件事有没有做到 */
await evaluate(`(() => { var v = window.__notaView; v.dispatch({ selection: { anchor: v.state.doc.length } }); })()`)
await sleep(400)
ok(
  '编辑器里标出来的行铺了底色',
  (await evaluate(`document.querySelectorAll('.cm-md-marked').length`)) === 2,
)
const rawBox = await evaluate(`
  (() => { var row = document.querySelector('.cm-code-lang-row');
    var el = (row && row.closest('.cm-content')) || document.querySelector('.cm-content');
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }); })()
`)
const box = rawBox && rawBox !== 'null' ? JSON.parse(rawBox) : null
if (box) {
  const scrollY = await evaluate(`window.scrollY`)
  await shot('.keep/marks/code-marks.png', { ...box, y: box.y + scrollY })
}
ok('围栏上两颗 chip 都还在', await evaluate(`(document.querySelectorAll('.cm-code-lang-row button').length) === 2`))

/* ── 5. 预览里真的亮起来了 ── */
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="分栏视图"]')?.click()`)
await sleep(900)
const hl = await evaluate(`
  (() => {
    var lines = [...document.querySelectorAll('.preview .pv-line')];
    var marked = lines.filter((e) => e.classList.contains('is-hl'));
    return JSON.stringify({ total: lines.length, marked: marked.length,
      texts: marked.map((e) => (e.textContent || '').trim()) });
  })()
`)
ok('预览里标出来的行带 is-hl', /"marked":2/.test(hl), hl)

if (errors.length) console.log('控制台报错：', errors.slice(0, 5))
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项没过`)
await close()
process.exit(bad === 0 ? 0 : 1)
