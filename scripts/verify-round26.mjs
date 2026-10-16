/**
 * round26：导出（Word / HTML）的端到端断言（2.6.x）。
 * 两条主断言是 2.6.1 修的：
 *  · 代码块每一行从 `<span class="pv-line">`（靠 CSS display:block 撑行，
 *    Word/WPS 不认 → 整块糊成一行）换成真块级 `<p>`；
 *  · 图片（mermaid 光栅图为主）钉死像素 width/height —— Word 不认
 *    max-width，2 倍图按原始像素排版会铺满两页。
 * 顺带把「同样的修复会不会压坏别处」一起验掉：公式出 MathML、宽表格有边框、
 * 嵌套引用、脚注、以及 HTML 导出还是不是那一套。
 * 断言都页内做，免得把几百 KB 的 base64 拖回 node。
 * `SAVE_DOC=路径` 时顺带落一份真实 .doc 成品，可用 WPS 直接开。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject } from './fake-workspace.mjs'

const NOTE = [
  '# 导出体检',
  '',
  '> [!warning] 注意',
  '> 这一块要变成带色边的表格。',
  '',
  '```bash title="deploy.sh" line-numbers',
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  '',
  'RSYNC_OPTS="-avz --delete"',
  'rsync $RSYNC_OPTS ./dist/ user@server:/srv/app',
  'echo "部署完成"',
  '```',
  '',
  '```mermaid',
  'graph LR',
  '  A[提交] --> B{测试通过?}',
  '  B -- 是 --> C[部署]',
  '  B -- 否 --> D[修]',
  '```',
  '',
  '- [x] 写完脚本',
  '- [ ] 挂上 cron',
].join('\n')

/* 另一篇专压「代码之外」的排版：公式、宽表格、嵌套引用、脚注。
   代码块那次修复埋在的同一个函数里（inlineWordStyles），
   一次改动压坏公式或表格是完全可能的，所以这两篇要各导一次。 */
const RICH = [
  '# 排版体检',
  '',
  '## 公式',
  '',
  '行内 $E = mc^2$ 与块级都要出 MathML：',
  '',
  '$$',
  '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
  '$$',
  '',
  '## 宽表格',
  '',
  '| 环境 | 地址 | 负责人 | 状态 | 备注 |',
  '| :--- | :--- | :---: | :--- | ---: |',
  '| 开发 | dev.example.com | 张三 | 在用 | 每天重置一次，别放真数据 |',
  '| 预发 | stg.example.com | 李四 | 在用 | 数据取自生产的脱敏快照 |',
  '| 生产 | www.example.com | 王五 | 只读 | 变更走工单，不打招呼不发布 |',
  '',
  '## 嵌套引用',
  '',
  '> 第一层',
  '>',
  '> > 第二层，这一层要还看得出是引用',
  '',
  '## 脚注',
  '',
  '正文里提一句[^note]，脚注会在文末重建。',
  '',
  '[^note]: 这是脚注的内容，导出后应当排在文末。',
].join('\n')

const { send, evaluate, sleep, close } = await launch({ port: 4468, size: [1500, 940] })
const notes = { '/ws/导出体检.md': NOTE, '/ws/排版体检.md': RICH }
const TREE = [
  {
    type: 'file',
    name: '导出体检.md',
    path: '/ws/导出体检.md',
    tags: [],
    starred: false,
    mtime: Date.now(),
    excerpt: '',
  },
  {
    type: 'file',
    name: '排版体检.md',
    path: '/ws/排版体检.md',
    tags: [],
    starred: false,
    mtime: Date.now() - 1000,
    excerpt: '',
  },
]
const INJECT = makeInject({ notes, tree: TREE })

const openNote = async (name) => {
  await evaluate(`
    (() => {
      const r = [...document.querySelectorAll('.nlist .nl-item')].find(b => (b.textContent||'').includes(${JSON.stringify(name)}))
      r?.click()
      return !!r
    })()
  `)
  await sleep(1500)
}

const exportAs = async (label) => {
  await evaluate(`(async () => {
    const menuBtn = document.querySelector('.hm-anchor')
    if (!menuBtn) return false
    menuBtn.click()
    await new Promise(r => setTimeout(r, 260))
    const items = [...document.querySelectorAll('.hm-menu .hm-item')]
    const it = items.find(b => b.textContent.includes(${JSON.stringify(label)}))
    it?.click()
    await new Promise(r => setTimeout(r, 2500))
    return !!it
  })()`)
}

await send('Page.navigate', { url: 'http://127.0.0.1:4468/' })
await sleep(1200)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(900)

/* ── 1. 导出体检：代码块 + 图表 + 提示块 ── */
await openNote('导出体检')
await exportAs('Word')
const word = await evaluate(`(() => {
  const data = window.__exportedData?.word
  if (!data) return { fail: 'no data' }
  return {
    noPvLine: !data.includes('class="pv-line"'),
    codePs: (data.match(/<p style="margin:0;/g) || []).length,
    hasWcCode: data.includes('wc-code'),
    hasWcCallout: data.includes('wc-callout'),
    imgWidth: (data.match(/<img [^>]*width="/g) || []).length,
    imgStyleW: (data.match(/width:\\d+px;height:\\d+px/g) || []).length,
    hasMermaidImg: data.includes('data:image/png'),
    taskChar: data.includes('☒') && data.includes('☐'),
    /* 留在 580 封顶内：不该有 1500+ 像素宽的图 */
    bigImgGone: !data.match(/width="(1[5-9]\\d\\d|2\\d{3})"/),
  }
})()`)

/* ── 2. 排版体检：公式 / 宽表格 / 嵌套引用 / 脚注 ── */
await openNote('排版体检')
await exportAs('Word')
/* 公式在 Word 那条路上的终点是 OMML（<m:oMath>，Word 原生公式对象，
   打开后能直接编辑）—— mathToOmmL() 会把 MathML 换掉，所以成品里
   本来就看不到 `<math`。断言只要求二者之一在，且不能是裸 `$$`。 */
const rich = await evaluate(`(() => {
  const data = window.__exportedData?.word || ''
  if (!data) return { fail: 'no data' }
  const cells = data.match(/<t[dh][^>]*style="[^"]*border:1pt solid/g) || []
  return {
    mathOk: data.includes('oMath') || data.includes('<math'),
    tableCells: cells.length,
    tableStyled: cells.length >= 15,          // 3 行 × 5 列，含表头
    nestedQuote: (data.match(/<blockquote/g) || []).length >= 2,
    footnote: data.includes('脚注的内容'),
    noRawDollar: !data.includes('$$'),
    /* 内联样式这条主线不能倒：正文要有 text-align:justify */
    bodyJustify: data.includes('text-align:justify'),
  }
})()`)

/* ── 3. 同一篇导 HTML：不能因为改了 wordify 就跟着变样 ──
   必须用「导出体检」这篇：它有代码块和图表，
   HTML 那一路就是要保留 span 行 + SVG 图表，换成没代码的笔记验不出东西。 */
await openNote('导出体检')
await exportAs('HTML')
const html = await evaluate(`(() => {
  const data = window.__exportedData?.html || ''
  if (!data) return { fail: 'no data' }
  return {
    hasExportCss: data.includes('<style>'),
    keepPvLine: data.includes('class="pv-line"'),   // HTML 那一路本来就该保留 span 行
    hasGraphSvg: data.includes('data:image/svg+xml') || data.includes('<svg'),
  }
})()`)

console.log('— word/导出体检 —', JSON.stringify(word))
console.log('— word/排版体检 —', JSON.stringify(rich))
console.log('— html/导出体检 —', JSON.stringify(html))

/* 落一份真实成品，直接拿 WPS 开 */
const docx = await evaluate(`window.__exportedData?.word || ''`)
if (process.env.SAVE_DOC && docx) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.env.SAVE_DOC, Buffer.from(docx, 'utf8'))
  console.log('saved →', process.env.SAVE_DOC)
}

const fails = []
if (word.fail) fails.push('1.' + word.fail)
else {
  if (!word.noPvLine) fails.push('1.代码行还是 span')
  if (!word.codePs) fails.push('1.代码块没换成 <p>')
  if (!word.hasWcCode) fails.push('1.代码块没成表格')
  if (!word.hasWcCallout) fails.push('1.提示块没成表格')
  if (!word.imgWidth || !word.imgStyleW) fails.push('1.图没钉宽度')
  if (!word.hasMermaidImg) fails.push('1.mermaid 没光栅化')
  if (!word.taskChar) fails.push('1.待办字符丢了')
  if (!word.bigImgGone) fails.push('1.还有超宽图')
}
if (rich.fail) fails.push('2.' + rich.fail)
else {
  if (!rich.mathOk) fails.push('2.公式没转成 OMML/MathML')
  if (!rich.tableStyled) fails.push('2.表格单元格没内联边框')
  if (!rich.nestedQuote) fails.push('2.嵌套引用丢了层')
  if (!rich.footnote) fails.push('2.脚注没重建')
  if (!rich.noRawDollar) fails.push('2.公式源码没渲染')
  if (!rich.bodyJustify) fails.push('2.正文没两端对齐')
}
if (html.fail) fails.push('3.' + html.fail)
else {
  if (!html.hasExportCss) fails.push('3.HTML 没带样式表')
  if (!html.keepPvLine) fails.push('3.HTML 那一路被误改')
  if (!html.hasGraphSvg) fails.push('3.HTML 图表丢了')
}

console.log(fails.length ? 'ROUND26 FAIL\n  ' + fails.join('\n  ') : 'ROUND26 PASS')
await close()
process.exit(0)
