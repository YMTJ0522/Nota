/**
 * round27：2.7.1 的三处导出排版修复。
 *  · mermaid 导出**强制按浅色渲染** —— 深色主题下算出的浅色线条落在
 *    白底上会整张隐形（xychart 的坐标轴与折线实测消失）；
 *  · 段落里的 `<br>` 拆成独立 `<p>` —— Word 把 `<br>` 当软回车，
 *    软回车也参与两端对齐，于是每行都被拉满整行宽、字间距爆炸；
 *  · 长代码块不再一律 page-break-inside:avoid —— 四十行的块只能整块
 *    推到下页，上一页留下半页空白；
 *  · Word 里的**块级公式改为图片** —— OMML 写进 .doc 也白搭，Word 打开
 *    HTML 套壳时不解析它，公式塌成一行裸文本；
 *  · 提示块标题改成「无 class + 单份内联样式」—— 两份样式叠在一起时
 *    WPS 会把行高算错，标题被纵向裁掉一半。
 *
 * 断言都在页面内做（导出数据动辄几百 KB，拖回 node 没意义）。
 * 用法：node scripts/verify-round27.mjs
 */
import { launch } from './cdp-harness.mjs'
import { makeInject } from './fake-workspace.mjs'

const NOTE = [
  '# 导出排版体检',
  '',
  '**作者：豆包**',
  '**版本：v2.0**',
  '**更新时间：2026年4月**',
  '',
  '## 图表',
  '',
  '```mermaid',
  'xychart-beta',
  '  title "月度趋势"',
  '  x-axis ["1月", "2月", "3月"]',
  '  y-axis "数量" 0 --> 100',
  '  line [28, 46, 88]',
  '```',
  '',
  '## 长代码块（20 行）',
  '',
  '```bash',
  ...Array.from({ length: 20 }, (_, i) => `echo "line ${i + 1}"`),
  '```',
  '',
  '## 公式与提示块',
  '',
  '行内 $\\alpha+\\beta=\\gamma$ 一句。',
  '',
  '$$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$',
  '',
  '> [!NOTE] 说明',
  '> 提示块的正文。',
].join('\n')

const { send, evaluate, sleep, close } = await launch({ port: 4474, size: [1500, 940] })
const notes = { '/ws/排版体检.md': NOTE }
const TREE = [
  { type: 'file', name: '排版体检.md', path: '/ws/排版体检.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' },
]
const INJECT = makeInject({ notes, tree: TREE })

await send('Page.navigate', { url: 'http://127.0.0.1:4474/' })
await sleep(1300)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1300)
await evaluate(INJECT)
await sleep(1000)
await evaluate(`
  (() => {
    const r = [...document.querySelectorAll('.nlist .nl-item')].find(b => (b.textContent||'').includes('排版体检'))
    r?.click(); return !!r
  })()`)
await sleep(2000)

/* 关键：把应用切到**深色**再导出 —— 只有在深色下才验得出「导出强制浅色」是否生效。 */
await evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`)
await sleep(800)

async function exportAs(label) {
  const r = await evaluate(`(async () => {
    const anchor = document.querySelector('.ea-anchor')
    if (!anchor) return { fail: 'no anchor' }
    anchor.click()
    await new Promise(r => setTimeout(r, 320))
    const items = [...document.querySelectorAll('.ea-menu .ea-item, .hm-menu .hm-item')]
    const hit = items.find(b => (b.textContent || '').includes(${JSON.stringify(label)}))
    if (!hit) return { fail: 'no item', items: items.map(i => i.textContent.trim()) }
    hit.click()
    await new Promise(r => setTimeout(r, 4200))
    return { ok: true }
  })()`)
  if (r.fail) return r
  return { ok: true }
}

const fails = []

/* ── 1. HTML 导出：mermaid 必须是浅色 ── */
await exportAs('HTML')
const html = await evaluate(`(() => {
  const d = window.__exportedData?.html || ''
  if (!d) return { fail: 'no data' }
  // 深色主题的前景色/次色（#eeedea / #a3a19b / #16161a）不该出现在白底导出里
  const darkHits = ['#eeedea', '#a3a19b', '#1c1d21'].filter(c => d.includes(c))
  // 浅色主题的正文色应当出现（图的轴/文字用它）
  const lightHit = d.includes('#2a2b28') || d.includes('#8b8880')
  return { hasSvg: d.includes('<svg'), darkHits, lightHit, bytes: d.length }
})()`)
console.log('— 1. HTML/mermaid 浅色 —', JSON.stringify(html))
if (html.fail) fails.push('1.' + html.fail)
else {
  if (!html.hasSvg) fails.push('1.没有内联 SVG 图')
  if (html.darkHits.length) fails.push('1.图上仍是深色主题色 ' + html.darkHits.join(','))
  if (!html.lightHit) fails.push('1.没看到浅色主题色')
}

/* ── 2. Word 导出：<br> 段落拆开；长代码块放开跨页 ── */
await exportAs('Word')
const word = await evaluate(`(() => {
  const d = window.__exportedData?.word || ''
  if (!d) return { fail: 'no data' }
  // frontmatter 那三行原本是 <p>…<br>…<br>…</p>，拆开后应当各成一个 <p>
  const brInP = /<p[^>]*>(?:(?!<\\/p>)[\\s\\S])*?<br/i.test(d)
  // 拆出来的行带 margin:0 0 2pt;
  const splitRows = (d.match(/margin:0 0 2pt;/g) || []).length
  // 20 行代码块应被判定为长块 → page-break-inside:auto
  const autoBreak = (d.match(/page-break-inside:auto/g) || []).length
  const stillAvoid = (d.match(/page-break-inside:avoid/g) || []).length
  // 正文仍应两端对齐（修复不该把整体排法也丢掉）
  const justify = d.includes('text-align:justify')
  return { brInP, splitRows, autoBreak, stillAvoid, justify, bytes: d.length }
})()`)
console.log('— 2. Word/<br>拆分与跨页 —', JSON.stringify(word))
if (word.fail) fails.push('2.' + word.fail)
else {
  if (word.brInP) fails.push('2.还有 <p> 里挂 <br>（Word 会撑开字距）')
  if (word.splitRows < 3) fails.push('2.没看到拆开的元信息行（splitRows=' + word.splitRows + '）')
  if (word.autoBreak < 1) fails.push('2.长代码块仍被禁止跨页（会留大片空白）')
  if (!word.justify) fails.push('2.正文两端对齐被误删')
}

/* ── 3. PDF 那一路的 HTML 也要是浅色 ── */
await exportAs('PDF')
const pdf = await evaluate(`(() => {
  const d = window.__exportedData?.pdf || ''
  if (!d) return { fail: 'no data' }
  const darkHits = ['#eeedea', '#a3a19b'].filter(c => d.includes(c))
  return { darkHits, bytes: d.length }
})()`)
console.log('— 3. PDF 源浅色 —', JSON.stringify(pdf))
if (pdf.fail) fails.push('3.' + pdf.fail)
else if (pdf.darkHits.length) fails.push('3.PDF 图上仍是深色 ' + pdf.darkHits.join(','))

/* ── 4. Word：块级公式是图片；提示块标题只有一份干净样式 ── */
const word2 = await evaluate(`(() => {
  const d = window.__exportedData?.word || ''
  if (!d) return { fail: 'no data' }
  // 块级公式应当已经拍成图片：正文里不该再剩 <math>，也不该有 OMML 占位残留
  const mathLeft = (d.match(/<math/g) || []).length
  const omathLeft = (d.match(/m:oMath/g) || []).length
  // 公式图是窄图（图表那张被压到 580），拿宽度区分
  const narrowImg = (d.match(/<img[^>]*width="(\\d+)"/g) || [])
    .map(s => Number(/width="(\\d+)"/.exec(s)[1]))
    .some(n => n > 40 && n < 500)
  // 提示块标题：不能带 class（WPS 那个行高 bug 的触发条件），且行高给了绝对值
  const headHasClass = d.includes('class="pv-callout-head"')
  const headStyled = /data-wc-callout-head="1"[^>]*style="[^"]*line-height:15pt/.test(d)
  return { mathLeft, omathLeft, narrowImg, headHasClass, headStyled }
})()`)
console.log('— 4. Word/公式与提示块 —', JSON.stringify(word2))
if (word2.fail) fails.push('4.' + word2.fail)
else {
  if (word2.mathLeft > 0) fails.push('4.还有 <math> 没转（块级公式应当已拍成图）')
  // 行内公式仍走 OMML（Word 会把行内 OMML 摊平成能读的文本），所以 m:oMath 该有；
  // 真正不许留的是块级那条 —— 它一旦留在 OMML 里就会塌成一串裸文本。
  if (word2.omathLeft < 1) fails.push('4.行内公式的 OMML 没了（不该连它一起删）')
  if (!word2.narrowImg) fails.push('4.没看到公式图片')
  if (word2.headHasClass) fails.push('4.提示块标题仍带 class（WPS 会裁掉半截）')
  if (!word2.headStyled) fails.push('4.提示块标题没拿到写全的样式')
}

console.log(fails.length ? 'ROUND27 FAIL: ' + fails.join(' | ') : 'ROUND27 PASS')
await close()
process.exit(0)
