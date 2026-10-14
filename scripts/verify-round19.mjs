/**
 * round19 —— 表格内容居中
 *
 * 用户要求「表格内容居中」。直接把 `text-align:left` 改成 center 也行，
 * 但那会顺手盖掉一个已经存在的行为：GFM 是支持作者自己写对齐的
 * （`| :--- | :---: | ---: |`），marked 会把它翻成 `<td align="...">`。
 * 一味居中等于让作者的显式标注失效 —— 写了 `---:` 还是居中，那是个 bug。
 *
 * 所以规则是：**默认居中，作者标注了就听作者的**。
 * 判据用 `getComputedStyle` 读实际生效的 text-align，而不是去看 CSS 文件写了什么。
 *
 * 导出（HTML / Word / PDF）另有一份内联样式表 EXPORT_CSS，
 * 以前它写死了 `text-align:left` —— 导出跟屏幕两样。这条本课一并盯住：
 * 直接把导出产物 parse 回来数，看 кол 是不是跟着变了。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4415)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 950] })
const results = []
const ok = (name, pass, data) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`, data === undefined ? '' : JSON.stringify(data))
}

/* 三列：一列没标、一列标右、一列标中。没标的那一列才体现「默认」 */
const TABLE = [
  '| 名称 | 数量 | 备注 |',
  '| --- | ---: | :---: |',
  '| 甲 | 12 | 长一点的文字内容 |',
  '| 乙丙丁 | 3 | x |',
  '',
].join('\n')
const MD = ['# 表格对齐', '', TABLE].join('\n')

const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/表格.md': MD },
  tree: [
    ...makeTree(),
    {
      type: 'file', name: '表格.md', path: '/ws/表格.md',
      tags: [], starred: false, mtime: Date.now(), excerpt: '',
    },
  ],
})

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1500)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)
await evaluate(openNoteExpr('表格'))
await sleep(1500)
/* 默认不一定是分栏视图，没有预览就量不到 —— 显式切过去 */
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="分栏视图"]')?.click()`)
await sleep(1200)

/* ── 1. 预览里读实际生效的对齐 ── */
const ALIGN = `(() => {
  var p = document.querySelector('.pvw .preview');
  if (!p) return JSON.stringify({ err: 'no preview' });
  var t = p.querySelector('table');
  if (!t) return JSON.stringify({ err: 'no table' });
  var rows = [...t.querySelectorAll('tbody tr')];
  var heads = [...t.querySelectorAll('thead th')];
  var cs = function (el) { return getComputedStyle(el).textAlign; };
  return JSON.stringify({
    head: heads.map(cs),
    body: rows.map(function (r) { return [...r.querySelectorAll('td')].map(cs); }),
    rawAlign: heads.map(function (h) { return h.getAttribute('align'); }),
  });
})()`

const a = JSON.parse(await evaluate(ALIGN))
ok('1.预览：没标对齐的列居中', a.body?.[0]?.[0] === 'center' && a.head?.[0] === 'center', {
  headFirst: a.head?.[0], bodyFirst: a.body?.[0]?.[0],
})
ok(
  '2.预览：作者标了 `---:` 的那列仍然靠右（没被默认值盖掉）',
  a.body?.[0]?.[1] === 'right' && a.head?.[1] === 'right',
  { headQty: a.head?.[1], bodyQty: a.body?.[0]?.[1], raw: a.rawAlign },
)
ok(
  '3.预览：作者标了 `:---:` 的那列居中',
  a.body?.[0]?.[2] === 'center',
  { headNote: a.head?.[2], bodyNote: a.body?.[0]?.[2] },
)

/* ── 2. 导出：不能跟屏幕两样 ──
   EXPORT_CSS 是写死在 store 里的**另一份**样式表，改 markdown.css 它不会跟着变。
   所以这里真的走一次顶栏导出，把产物 parse 回来查 —— 只读 CSS 源码会漏掉它。
   假桩子把 pdf 的完整 HTML 存在 window.__exportedData.pdf（见 fake-workspace）。 */
async function pickExport(kind) {
  await evaluate(`(() => { if (!document.querySelector('.ea-menu')) document.querySelector('.ea-anchor')?.click() })()`)
  await sleep(400)
  const p = JSON.parse(
    await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.ea-menu .n-menu-item')]
      const r = rows.find(e => (e.querySelector('.n-menu-name')?.textContent || '').includes(${JSON.stringify(kind)}))
      if (!r) return 'null'
      const b = r.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) })
    })()`),
  )
  if (!p) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: p.x, y: p.y, button: 'left', clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    })
    await sleep(80)
  }
  await sleep(1600)
  return true
}

const got = await pickExport('PDF')
const exportDoc = await evaluate(`String(window.__exportedData?.pdf ?? '')`)
const parsed = JSON.parse(
  await evaluate(`(() => {
    var h = String(window.__exportedData?.pdf ?? '');
    if (!h) return JSON.stringify({ err: 'no export' });
    var d = new DOMParser().parseFromString(h, 'text/html');
    var t = d.querySelector('table');
    if (!t) return JSON.stringify({ err: 'no table in export' });
    return JSON.stringify({
      alignAttrs: [...t.querySelectorAll('thead th')].map(function (c) { return c.getAttribute('align'); }),
      cells: t.querySelectorAll('tbody td').length,
    });
  })()`),
)
/* 关键判据：导出样式表里 td 的规则必须是居中 + 带 [align] 覆盖，
   而不是先前那句写死的 `text-align: left`（那时屏幕和 PDF 会是两个样子）。 */
const cssOk = /th,\s*td\s*\{[\s\S]*?text-align:\s*center/.test(exportDoc)
const cssHasOverride = /\[align='right'\][\s\S]*?text-align:\s*right/.test(exportDoc)
ok('4.导出：取到了 PDF 产物且里面有表格', got && !parsed.err && parsed.cells > 0, parsed)
ok(
  '5.导出：EXPORT_CSS 跟着改成居中（屏幕与导出一致）',
  cssOk,
  { found: cssOk },
)
ok('6.导出：作者标了 `---:` 的那列，导出里也靠右', cssHasOverride, { found: cssHasOverride })

ok('5.过程中没有控制台报错', errors.length === 0, errors.slice(0, 4))

const pass = results.filter((r) => r.pass).length
console.log(`\n round19：${pass}/${results.length} 通过`)
await close()
process.exit(pass === results.length ? 0 : 1)
