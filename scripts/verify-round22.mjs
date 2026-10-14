/**
 * round22 —— 工具栏逐项体检
 *
 * 起因是用户一句话：「工具栏哪些功能用不了，哪些没有正确实现」。
 * 这类问题的难点在于它**不会报错**：菜单项照样画着、点了照样关菜单，
 * 只是插出来的东西在预览里是一串没人管的中括号，或者压根没附加。
 * 所以这一轮不看「按钮能不能点」，只看「点上之后屏幕上多了什么」。
 *
 * 分两段：
 *   A. 渲染 —— 写一篇把所有写法都用过一遍的笔记，逐类数预览里的元素；
 *   B. 交互 —— 「双链笔记」要弹选择器而不是甩一对空括号给人；
 *      文件夹右键「更换图标」要停在图标页上，而不是停在空标签页上。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4422)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 980] })
const results = []
const ok = (name, pass, data) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`, data === undefined ? '' : JSON.stringify(data))
}

/** 把工具栏里每一项都用上的一篇笔记 */
const NOTE_ALL = [
  '---',
  'tags: [体检]',
  '---',
  '',
  '# 全功能体检',
  '',
  '这是一段普通正文，里面有 ==高亮==、~~删除线~~ 和 `行内代码`。',
  '',
  '行内公式 $E=mc^2$，块级公式：',
  '',
  '$$',
  '\\int_0^1 x^2 dx',
  '$$',
  '',
  '> [!NOTE]',
  '> 这是一条提示块，标题没写，就用默认名。',
  '',
  '> [!TIP] 自定义标题',
  '> 提示块的正文。',
  '',
  '行内标签：#体检、#随手记',
  '',
  '给这一段起个名字 ^kaishi',
  '',
  '这里引用一个脚注[^1]。',
  '',
  '[^1]: 脚注的内容藏在文末。',
  '',
  '| 列 1 | 列 2 |',
  '| --- | --- |',
  '| a | b |',
  '',
  ':::: tabs',
  '::: tab-item 第一个',
  '第一个标签页的内容。',
  ':::',
  '::: tab-item 第二个',
  '第二个标签页的内容。',
  ':::',
  '::::',
  '',
  '::: details [点开看]',
  '折叠起来的内容。',
  ':::',
  '',
  '```text title="示例脚本" line-numbers {2}',
  '第一行',
  '第二行',
  '第三行',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  A --> B',
  '```',
  '',
  '双链到另一篇：[[代码示例]]',
  '',
  '嵌入另一篇：![[书评]]',
  '',
  '%%这句是隐藏注释，不该出现在预览里%%',
  '',
].join('\n')

const tree = makeTree()
const notes = { ...makeNotes(), '/ws/全功能体检.md': NOTE_ALL }
tree.unshift({
  type: 'file',
  name: '全功能体检.md',
  path: '/ws/全功能体检.md',
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

/** 打开那篇体检笔记 */
await evaluate(`
  (() => {
    const t = [...document.querySelectorAll('.nlist .nl-item')]
      .find((b) => (b.querySelector('.nl-text')?.textContent ?? '').includes('全功能体检'));
    t?.click();
    return !!t;
  })()
`)
await sleep(1200)

/* 默认不是分栏视图，预览压根不存在 —— 先切过去 */
await evaluate(
  `document.querySelector('.ph-seg-btn[aria-label^="分栏视图"]')?.click()`,
)
await sleep(1500)
// 图表与公式是异步填的，给它们一点时间
await sleep(1800)

const PROBE = `(() => {
  var q = (s) => document.querySelectorAll(s).length
  var pv = document.querySelector('.preview')
  var text = pv ? pv.textContent : ''
  return JSON.stringify({
    hasPreview: !!pv,
    callout: q('.pv-callout'),
    calloutHead: q('.pv-callout-head'),
    table: q('.pv-table-wrap .pv-table'),
    mathInline: q('.pv-math'),
    mathBlock: q('.pv-math-block'),
    katex: q('.pv-math .katex') + q('.pv-math-block .katex'),
    fnRef: q('sup.pv-fnref'),
    fnList: q('section.footnotes .pv-fn'),
    tag: q('.pv-tag'),
    bid: q('.pv-bid'),
    tabs: q('.pv-tabs'),
    tabsItem: q('.pv-tabs .pv-tab'),
    tabsPane: q('.pv-tabs .pv-tab-pane'),
    details: q('details.pv-details'),
    fig: q('figure.pv-code-fig'),
    codeTitle: q('.pv-code-title'),
    numbered: q('pre[data-line-numbers]'),
    hlLine: q('.pv-line.is-hl'),
    mermaid: q('.pv-mermaid-graph svg'),
    wlink: q('.pv-wlink'),
    wlinkMissing: q('.pv-wlink.is-missing'),
    embed: q('.pv-embed'),
    mark: q('mark.pv-mark'),
    del: q('del'),
    leakedComment: text.indexOf('隐藏注释，不该出现') >= 0,
  })
})()`

const r = JSON.parse(await evaluate(PROBE))

ok('1.预览存在，且每个富块都排出来了', r.hasPreview, { hasPreview: r.hasPreview })

ok(
  '2.提示块：两种写法都成块（写了标题的和没写的）',
  r.callout === 2 && r.calloutHead === 2,
  { callout: r.callout, head: r.calloutHead },
)

ok(
  '3.表格：套上了圆角容器',
  r.table >= 1,
  { table: r.table },
)

ok(
  '4.公式：行内与块级各一块，KaTeX 真的排出来了',
  r.mathInline >= 1 && r.mathBlock >= 1 && r.katex >= 2,
  { inline: r.mathInline, block: r.mathBlock, katex: r.katex },
)

ok(
  '5.脚注：正文上一枚上标，文末一张列表',
  r.fnRef >= 1 && r.fnList >= 1,
  { ref: r.fnRef, list: r.fnList },
)

ok(
  '6.行内标签 #标签：渲染成chip',
  r.tag >= 2,
  { tag: r.tag },
)

ok('7.块 ID ^名字：渲染成记号', r.bid >= 1, { bid: r.bid })

ok(
  '8.分栏标签：容器、两个标签头、两个内容页都在',
  r.tabs >= 1 && r.tabsItem >= 2 && r.tabsPane >= 2,
  { tabs: r.tabs, heads: r.tabsItem, panes: r.tabsPane },
)

ok('9.折叠详情块：渲染成可展开的块', r.details >= 1, { details: r.details })

ok(
  '10.高级代码块：标题条 + 行号 + 高亮行三样都在',
  r.fig >= 1 && r.codeTitle >= 1 && r.numbered >= 1 && r.hlLine === 1,
  { fig: r.fig, title: r.codeTitle, numbered: r.numbered, hl: r.hlLine },
)

ok('11.Mermaid 图表真的画成了 SVG', r.mermaid >= 1, { svg: r.mermaid })

ok(
  '12.双链 [[名字]]：渲染成链接，且找得到那篇（不是虚线的「缺篇」）',
  r.wlink >= 1 && r.wlinkMissing === 0,
  { wlink: r.wlink, missing: r.wlinkMissing },
)

ok('13.笔记嵌入 ![[名字]]：渲染成卡片', r.embed >= 1, { embed: r.embed })

ok(
  '14.高亮与删除线：都不是原样躺着的符号',
  r.mark >= 1 && r.del >= 1,
  { mark: r.mark, del: r.del },
)

ok('15.隐藏注释 %%…%% 真的藏住了', r.leakedComment === false, { leaked: r.leakedComment })

/* ── 交互：双链要点得动 ──
   过去它是「插入一对空 [[]]」，名字得自己打；同源工作区里重名笔记很常见，
   打出来的常常不是想指的那篇。现在必须跟「笔记嵌入」一样弹选择器。 */
await evaluate(`
  (() => {
    const w = [...document.querySelectorAll('.tb-group.tb-menu-wrap')]
      .find((g) => (g.querySelector('.tb-btn')?.getAttribute('title') ?? '').indexOf('链接与引用') >= 0);
    w?.querySelector('.tb-btn')?.click();
    return !!w;
  })()
`)
await sleep(400)
const menuItems = JSON.parse(
  await evaluate(`
    (() => JSON.stringify([...document.querySelectorAll('.tb-menu .tb-item')].map((b) => b.textContent.trim())))()
  `),
)
const hasWikilink = menuItems.some((t) => t.includes('双链笔记'))

await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.tb-menu .tb-item')]
      .find((x) => (x.textContent || '').indexOf('双链笔记') >= 0);
    b?.click();
    return !!b;
  })()
`)
await sleep(700)
const picker = JSON.parse(
  await evaluate(`
    (() => {
      const d = document.querySelector('.np');
      return JSON.stringify({
        open: !!d,
        title: d?.querySelector('.np-title')?.textContent?.trim() ?? '',
        rows: d ? d.querySelectorAll('.np-item').length : 0,
      });
    })()
  `),
)
ok(
  '16.工具栏「双链笔记」：菜单里有这一项，点了弹笔记选择器而不是甩一对空括号',
  hasWikilink && picker.open && picker.rows > 0 && picker.title.includes('链接'),
  { hasWikilink, ...picker },
)

await evaluate(`
  (() => {
    const it = document.querySelector('.np .np-item');
    it?.click();
    return !!it;
  })()
`)
await sleep(1200)
const afterPick = JSON.parse(
  await evaluate(`
    (() => {
      const pv = document.querySelector('.preview');
      const doc = window.__notaView ? window.__notaView.state.doc.toString() : '';
      return JSON.stringify({
        wlink: pv ? pv.querySelectorAll('.pv-wlink').length : 0,
        missing: pv ? pv.querySelectorAll('.pv-wlink.is-missing').length : 0,
        inserted: /\\[\\[[^\\]]+\\]\\]/.test(doc),
      });
    })()
  `),
)
ok(
  '17.选完那一篇：正文插入 [[名字]]，预览立刻多出一枚指得通的链接',
  afterPick.inserted && afterPick.wlink >= 2 && afterPick.missing === 0,
  afterPick,
)

/* ── 交互：文件夹右键「更换图标」── */
const dirRow = await evaluate(`
  (() => {
    const row = [...document.querySelectorAll('.panel .row, .panel .tree-row, .panel .tw-row')]
      .find((r) => (r.textContent || '').includes('读书'));
    const target = row ?? [...document.querySelectorAll('.panel [class*=row]')]
      .find((r) => (r.textContent || '').trim().startsWith('读书'));
    if (!target) return 'no-row';
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    return 'ok';
  })()
`)
await sleep(600)
const folderMenu = JSON.parse(
  await evaluate(`
    (() => JSON.stringify({
      items: [...document.querySelectorAll('.ctx-item .ctx-label')].map((l) => l.textContent.trim()),
    }))()
  `),
)
const hasIconItem = folderMenu.items.some((t) => t.includes('更换图标'))

await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.ctx-item')]
      .find((x) => (x.textContent || '').indexOf('更换图标') >= 0);
    b?.click();
    return !!b;
  })()
`)
await sleep(800)
const iconDlg = JSON.parse(
  await evaluate(`
    (() => {
      const d = document.querySelector('.ip');
      return JSON.stringify({
        open: !!d,
        title: d?.querySelector('.ip-title')?.textContent?.trim() ?? '',
        tabs: d ? d.querySelectorAll('.ip-tabs button').length : -1,
        cells: d ? d.querySelectorAll('.ig-cell').length : -1,
      });
    })()
  `),
)
ok(
  '18.文件夹右键「更换图标」：标题写「更换图标」，直接停在图标页（网格真的有东西）',
  dirRow === 'ok' &&
    hasIconItem &&
    iconDlg.open &&
    iconDlg.title.includes('更换图标') &&
    iconDlg.tabs === 0 &&
    iconDlg.cells > 10,
  { dirRow, hasIconItem, ...iconDlg },
)

ok('19.过程中没有控制台报错', errors.length === 0, errors.slice(0, 4))

const pass = results.filter((x) => x.pass).length
console.log(`\n round22：${pass}/${results.length} 通过`)
await close()
process.exit(pass === results.length ? 0 : 1)
