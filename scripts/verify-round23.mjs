/**
 * round23 —— 预览里的「能点却点不动」与「配色」
 *
 * 用户一口气点了四类毛病，它们有个共同点：**渲染得出来，但不好用/不好看**。
 *   · 待办清单画着勾选框，却是 disabled 的 —— 点了没反应；
 *   · 分栏标签长得像页签，却从没接过点击；
 *   · 代码块在预览里没有语言标识（编辑区有，两边不一致）；
 *   · 提示块十一种挤在五个色里，看着单调；图表偏蓝紫，被点名说丑。
 *
 * 这一轮因此分两段：
 *   A. 交互 —— 勾待办、切标签，都要真的改到源码里、真的换页，
 *      而不是只改预览里的一个 class；
 *   B. 观感 —— 语言标识在不在、十一种提示块的颜色是不是各不相同、
 *      图表主色是不是已经不是那片蓝紫。
 */
import { readFileSync } from 'node:fs'
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4423)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 980] })
const results = []
const ok = (name, pass, data) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`, data === undefined ? '' : JSON.stringify(data))
}

const NOTE = [
  '---',
  'title: 交互与配色体检',
  'tags: [体检]',
  '---',
  '',
  '# 交互与配色体检',
  '',
  '## 待办',
  '',
  '- [ ] 第一项：点它应该变成已勾选',
  '- [ ] 第二项：这一项不该被误改',
  '- [x] 第三项：本来就是勾上的',
  '',
  '## 标签页',
  '',
  ':::: tabs',
  '::: tab-item 甲',
  '甲的内容',
  ':::',
  '::: tab-item 乙',
  '乙的内容',
  ':::',
  '::: tab-item 丙',
  '丙的内容',
  ':::',
  '::::',
  '',
  '## 代码块',
  '',
  '```python',
  'print("hello")',
  '```',
  '',
  '```sh',
  'echo hi',
  '```',
  '',
  '```ts title="带标题的" line-numbers {1}',
  'const a = 1',
  '```',
  '',
  '## 提示块',
  '',
  '> [!NOTE] 提示',
  '> 蓝。',
  '',
  '> [!TIP] 技巧',
  '> 绿。',
  '',
  '> [!WARNING] 警告',
  '> 琥珀。',
  '',
  '> [!DANGER] 危险',
  '> 红。',
  '',
  '> [!QUESTION] 疑问',
  '> 玫红。',
  '',
  '> [!SUCCESS] 成功',
  '> 青绿。',
  '',
  '## 图表',
  '',
  '```mermaid',
  'graph LR',
  '  A[开始] --> B[写完] --> C[导出来]',
  '```',
  '',
].join('\n')

const tree = makeTree()
const notes = { ...makeNotes(), '/ws/体检23.md': NOTE }
tree.unshift({
  type: 'file',
  name: '体检23.md',
  path: '/ws/体检23.md',
  tags: ['体检'],
  starred: false,
  mtime: Date.now(),
  excerpt: '',
})
const INJECT = makeInject({ notes, tree })

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1200)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)
await evaluate(`
  (() => {
    const t = [...document.querySelectorAll('.nlist .nl-item')]
      .find((b) => (b.querySelector('.nl-text')?.textContent ?? '').includes('体检23'));
    t?.click();
    return !!t;
  })()
`)
await sleep(1200)
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="分栏视图"]')?.click()`)
await sleep(3000)

const P = `(() => {
  var q = (s) => document.querySelectorAll(s).length
  var pv = document.querySelector('.preview')
  var text = pv ? pv.textContent : ''
  var callouts = [...document.querySelectorAll('.pv-callout')].map((c) => ({
    t: c.getAttribute('data-type'),
    line: getComputedStyle(c).borderLeftColor,
    title: getComputedStyle(c.querySelector('.pv-callout-title')).color,
  }))
  var langs = [...document.querySelectorAll('.pv-code-lang')].map((n) => n.textContent.trim())
  var node = null
  var svg = document.querySelector('.pv-mermaid-graph svg')
  if (svg) {
    var r = svg.querySelector('rect, path.node, .node rect')
    if (r) node = r.getAttribute('fill') || getComputedStyle(r).fill
  }
  return JSON.stringify({
    frontmatterLeaked: /^---\\s*$/m.test(text) || text.indexOf('tags: [体检]') >= 0,
    nativeCheckbox: q('.preview input[type=checkbox]'),
    task: q('.preview .pv-task'),
    taskOn: q('.preview .pv-task.on'),
    tabs: q('.pv-tabs .pv-tab'),
    tabOn: (document.querySelector('.pv-tabs .pv-tab.on') || {}).textContent,
    paneOn: (document.querySelector('.pv-tabs .pv-tab-pane.on') || {}).textContent,
    langs: langs,
    callouts: callouts,
    calloutSvg: q('.pv-callout-icon svg'),
    mermaidNode: node,
  })
})()`

const r = JSON.parse(await evaluate(P))

ok('1.frontmatter 没有漏进正文（title/tags 都不该出现在预览里）', r.frontmatterLeaked === false, {
  leaked: r.frontmatterLeaked,
})

ok(
  '2.待办：原生 disabled 复选框已经换掉，画成自己的勾',
  r.nativeCheckbox === 0 && r.task === 3 && r.taskOn === 1,
  { native: r.nativeCheckbox, task: r.task, on: r.taskOn },
)

/* ── 点第一个待办 → 源码里那一行要真的变成 [x] ── */
await evaluate(`document.querySelector('.preview .pv-task')?.click()`)
await sleep(900)
const afterTask = JSON.parse(
  await evaluate(`
    (() => {
      var lines = [...document.querySelectorAll('.cm-line')].map((n) => n.textContent)
      return JSON.stringify({
        checked: lines.filter((l) => l.indexOf('[x]') >= 0).length,
        unchecked: lines.filter((l) => l.indexOf('[ ]') >= 0).length,
      })
    })()
  `),
)
ok(
  '3.点一下勾 → 改的是源码（[x] 多一个，[ ] 少一个），不是只改预览',
  afterTask.checked === 2 && afterTask.unchecked === 1,
  afterTask,
)

/* ── 点第二个标签 → 第二个内容页亮起来 ── */
await evaluate(`
  (() => {
    var tabs = [...document.querySelectorAll('.pv-tabs .pv-tab')]
    tabs[1]?.click()
    return !!tabs[1]
  })()
`)
await sleep(400)
const afterTab = JSON.parse(
  await evaluate(`
    (() => JSON.stringify({
      tabOn: (document.querySelector('.pv-tabs .pv-tab.on') || {}).textContent || '',
      paneOn: (document.querySelector('.pv-tabs .pv-tab-pane.on') || {}).textContent || '',
    }))()
  `),
)
ok(
  '4.分栏标签点得动：点「乙」之后亮的是乙，内容也换成了乙的',
  afterTab.tabOn.includes('乙') && afterTab.paneOn.includes('乙的内容'),
  afterTab,
)

ok(
  '5.代码块右上角有语言标识，且与编辑区同一套名字（sh 显示 Shell）',
  r.langs.length >= 2 && r.langs.includes('Python') && r.langs.includes('Shell'),
  { langs: r.langs },
)

const colors = r.callouts.map((c) => c.line)
const distinct = new Set(colors).size
ok(
  '6.提示块：六种类型六种颜色（不再挤成同一个蓝）',
  r.callouts.length >= 6 && distinct === r.callouts.length,
  { types: r.callouts.map((c) => c.t), distinct, colors },
)

ok('7.提示块图标是描边 SVG（不再是会变成彩色 emoji 的字符）', r.calloutSvg >= 6, {
  svg: r.calloutSvg,
})

/* 图表主色：取节点填充色，绿通道应当高于蓝通道 —— 蓝紫是 B 明显压过 G */
const fill = r.mermaidNode || ''
const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(fill)
const hex = /^#([0-9a-f]{6})$/i.exec(fill.trim())
let rgb = m ? [+m[1], +m[2], +m[3]] : null
if (!rgb && hex) {
  const n = parseInt(hex[1], 16)
  rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
ok(
  '8.图表主色已经不是蓝紫（绿通道压过蓝通道 = 偏青绿）',
  !!rgb && rgb[1] > rgb[2],
  { fill, rgb },
)

/* ── 静态检查：导出的那份样式有没有跟着改 ──
   屏幕这份改了、导出那份没改，是最容易漏的一类问题（它们是两份写死的 CSS）。 */
const storeSrc = readFileSync(new URL('../src/store/index.ts', import.meta.url), 'utf8')
ok(
  '9.导出样式跟着改了：代码块不再跟着 figure 居中，Word 有自己那份字面量 CSS',
  storeSrc.includes('figure.pv-code-fig { text-align: left; }') &&
    storeSrc.includes('const WORD_CSS'),
)

ok('10.控制台零报错', errors.length === 0, errors.slice(0, 3))

const pass = results.filter((x) => x.pass).length
console.log(`\n  round23: ${pass}/${results.length}`)
await close()
process.exit(pass === results.length ? 0 : 1)
