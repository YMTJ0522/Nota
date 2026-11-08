/**
 * 大纲树 + 思维导图的回归检查。
 *
 * 看四件事，每件都对应一个容易坏的点：
 *   1. 大纲里标题和列表项都在，代码块里的 `#` 与表格**不在**
 *   2. 折叠一个分支，行数要真的减少，`+N` 的数字要对
 *   3. 导图节点数 = 大纲可见行数 + 1（根），连线数 = 有父的节点数
 *   4. 点节点后 activeHeading 变成它，编辑区滚到对应行
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4412)
const OUT = '.tmp-shots'
const { send, evaluate, sleep, shot, errors, close } = await launch({ port: PORT, size: [1500, 960], scale: 2 })

const SAMPLE = [
  '# 一周手记',
  '',
  '## 这周做了什么 #记录',
  '',
  '- 把周报模板定下来',
  '  - 去掉三段套话，只留「做了什么 / 卡在哪 / 下周」',
  '  - 试写了两期，字数从 800 降到 300',
  '- 整理读书笔记三篇',
  '  - 《设计中的设计》',
  '  - 《我们如何学习》',
  '- 写完 notes.ts 的搜索',
  '',
  '## 卡住的地方 #问题',
  '',
  '- 图表在窄屏会溢出',
  '- 深色下公式发虚',
  '  - katex 的颜色是硬编码的，没跟主题走',
  '',
  '## 下周',
  '',
  '- [ ] 把备份脚本挪到 cron',
  '- [x] 清一遍旧稿',
  '- [ ] 看完《设计中的设计》第三章',
  '',
  '## 想法池',
  '',
  '### 关于大纲',
  '',
  '- 现在只列标题，看不出小节里有什么',
  '- 想做成能折叠的树',
  '',
  '## 随手记',
  '',
  '一段不属于任何列表的正文。',
  '',
  '```bash',
  '# 这行注释在代码块里，不该变成标题',
  'rsync -a --delete /var/lib/nota/ /backup/nota/',
  '```',
  '',
  '| 事项 | 状态 |',
  '| --- | --- |',
  '| 备份 | 已挪 |',
].join('\n')

const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/一周手记.md': SAMPLE },
  tree: [
    ...makeTree(),
    { type: 'file', name: '一周手记.md', path: '/ws/一周手记.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' },
  ],
})

const PASS = []
const FAIL = []
function ok(name, cond, extra = '') {
  if (cond) PASS.push(name)
  else FAIL.push(name + (extra ? ` — ${extra}` : ''))
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra && !cond ? ' — ' + extra : ''}`)
}

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1400)
await evaluate(`localStorage.setItem('nota-tour-seen','1')`)
await evaluate(`location.reload()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(600)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(900)
await evaluate(INJECT)
await sleep(600)

const opened = await evaluate(openNoteExpr('一周手记'))
ok('打开样本笔记', opened === true)
await sleep(1200)
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="分栏视图"]')?.click()`)
await sleep(900)

/* ── 大纲 ── */
await evaluate(`document.querySelector('.col-tab[data-view="outline"]')?.click()`)
await sleep(700)

const outline = JSON.parse(
  await evaluate(`JSON.stringify({
    rows: document.querySelectorAll('.ov-row').length,
    heads: document.querySelectorAll('.ov-row[data-kind="heading"]').length,
    items: document.querySelectorAll('.ov-row[data-kind="item"]').length,
    tasks: document.querySelectorAll('.ov-box').length,
    tags: document.querySelectorAll('.ov-tag').length,
    text: [...document.querySelectorAll('.ov-row')].map(r => r.querySelector('.ov-text')?.textContent ?? ''),
  })`),
)
console.log('\n── 大纲:', JSON.stringify({ ...outline, text: undefined }))
ok('大纲有标题（H1 已提升为根）', outline.heads === 6, `实际 ${outline.heads}`)
ok('大纲有列表项', outline.items === 15, `实际 ${outline.items}`)
ok('任务项带勾选框', outline.tasks === 3, `实际 ${outline.tasks}`)
ok('标签 chip 挂上了', outline.tags === 2, `实际 ${outline.tags}`)
ok('代码块里的 # 没进大纲', !outline.text.some((t) => t.includes('注释')), outline.text.join(' | '))
ok('表格没进大纲', !outline.text.some((t) => t.includes('备份') && t.includes('已挪')))
ok('根标题被提升、没重复出现', outline.text.filter((t) => t === '一周手记').length === 0)
ok('带标签的标题文字里不带 #', !outline.text.some((t) => t.includes('#记录')))

await shot(`${OUT}/outline-light.png`)

/* 折叠：收起「这周做了什么」 */
const before = outline.rows
await evaluate(`
  (() => {
    var row = [...document.querySelectorAll('.ov-row')].find(r => (r.querySelector('.ov-text')?.textContent ?? '') === '这周做了什么');
    row?.querySelector('.ov-fold')?.click();
    return !!row;
  })()
`)
await sleep(400)
const folded = JSON.parse(
  await evaluate(`JSON.stringify({
    rows: document.querySelectorAll('.ov-row').length,
    more: document.querySelector('.ov-more')?.textContent ?? null,
    open: document.querySelector('.ov-fold.open') ? true : false,
  })`),
)
console.log('── 折叠后:', JSON.stringify(folded))
ok('折叠后行数减少', folded.rows === before - 7, `${before} → ${folded.rows}`)
ok('折叠标记显示 +N', (folded.more ?? '').trim() === '+7', String(folded.more))
await shot(`${OUT}/outline-folded.png`)

/* 全部展开 */
await evaluate(`document.querySelector('.pn-head .pn-x')?.click()`)
await sleep(400)
ok('全部展开后行数复原', (await evaluate(`document.querySelectorAll('.ov-row').length`)) === before)

/* ── 导图 ── */
await evaluate(`document.querySelector('.ov .pn-x[aria-label="打开思维导图"]')?.click()`)
await sleep(1100)

const map = JSON.parse(
  await evaluate(`JSON.stringify({
    nodes: document.querySelectorAll('.mm-node').length,
    edges: document.querySelectorAll('.mm-links path').length,
    root: document.querySelectorAll('.mm-node[data-depth="0"]').length,
    folds: document.querySelectorAll('.mm-fold').length,
    sub: document.querySelector('.mm-meta')?.textContent?.trim() ?? '',
    worldW: document.querySelector('.mm-world')?.style.width,
  })`),
)
console.log('\n── 导图:', JSON.stringify(map))
ok('根只有一个', map.root === 1)
ok('节点数 = 大纲行数 + 1', map.nodes === before + 1, `${map.nodes} vs ${before + 1}`)
ok('连线数 = 节点数 - 1', map.edges === map.nodes - 1, `${map.edges} vs ${map.nodes - 1}`)
ok('可折叠的节点有折叠钮', map.folds > 0, String(map.folds))

/* 根节点的样子：整张图只该有一个实心块 */
const rootStyle = JSON.parse(
  await evaluate(`
    (() => {
      var el = document.querySelector('.mm-node[data-depth="0"]');
      var s = getComputedStyle(el);
      return JSON.stringify({ bg: s.backgroundColor, fg: getComputedStyle(el.querySelector('.mm-text')).color });
    })()
  `),
)
console.log('   根节点样式:', JSON.stringify(rootStyle))
console.log('   根节点样式:', JSON.stringify(rootStyle))
ok('根节点是实心强调色块', rootStyle.bg !== 'rgba(0, 0, 0, 0)' && rootStyle.bg !== 'rgb(255, 254, 252)', JSON.stringify(rootStyle))

await shot(`${OUT}/map-light.png`)

/* 折叠一级分支 */
await evaluate(`document.querySelector('.mm-fold')?.click()`)
await sleep(500)
const map2 = JSON.parse(
  await evaluate(`JSON.stringify({
    nodes: document.querySelectorAll('.mm-node').length,
    plus: [...document.querySelectorAll('.mm-fold')].map(b => b.textContent.trim()).filter(t => t.startsWith('+')),
  })`),
)
console.log('── 导图折叠后:', JSON.stringify(map2))
ok('导图折叠后节点变少', map2.nodes < map.nodes, `${map.nodes} → ${map2.nodes}`)
ok('折叠钮写出 +N', map2.plus.length > 0, JSON.stringify(map2.plus))

/* 点一个深层节点：要滚到正文那一行 */
await evaluate(`document.querySelector('.mm-bar .mm-act[title="全部展开"]')?.click()`)
await sleep(600)
const jumped = JSON.parse(
  await evaluate(`
    (() => {
      var hit = [...document.querySelectorAll('.mm-node')].find(n => (n.querySelector('.mm-text')?.textContent ?? '') === '深色下公式发虚');
      hit?.click();
      return JSON.stringify({ found: !!hit });
    })()
  `),
)
await sleep(1500)
const after = JSON.parse(
  await evaluate(`JSON.stringify({
    back: !!document.querySelector('.cm-scroller'),
    map: !!document.querySelector('.mm-stage'),
    active: document.querySelector('.ov-row.on .ov-text')?.textContent ?? null,
    scroll: Math.round(document.querySelector('.cm-scroller')?.scrollTop ?? -1),
    pv: Math.round(document.querySelector('.pvw .preview')?.scrollTop ?? -1),
  })`),
)
console.log('── 点节点:', JSON.stringify(jumped), JSON.stringify(after))
ok('点节点后回到正文', after.back === true && after.map === false)
ok('大纲仍有「当前节」高亮', !!after.active, String(after.active))
ok('编辑区滚到那一行', after.scroll > 0, String(after.scroll))
ok('预览也滚动了', after.pv > 0, String(after.pv))

/* 深色：先切主题再打开导图，否则截到的是正文 */
await evaluate(`document.documentElement.setAttribute('data-theme','dark')`)
await sleep(500)
console.log('   主题:', await evaluate(`document.documentElement.getAttribute('data-theme') + ' / bg=' + getComputedStyle(document.body).backgroundColor`))
await evaluate(`document.querySelector('.ov .pn-x[aria-label="打开思维导图"]')?.click()`)
await sleep(1400)
await shot(`${OUT}/map-dark.png`)
await evaluate(`document.querySelector('.mm-bar .mm-act[aria-label="关闭导图"]')?.click()`)
await sleep(700)
await shot(`${OUT}/outline-dark.png`)

console.log('\n控制台异常:', errors.length ? errors.slice(0, 6) : '无')
console.log(`\n通过 ${PASS.length} 项，失败 ${FAIL.length} 项`)
if (FAIL.length) console.log(FAIL.map((f) => '  ✗ ' + f).join('\n'))
await close()
process.exit(FAIL.length ? 1 : 0)
