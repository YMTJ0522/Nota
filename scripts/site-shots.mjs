/**
 * 官网用的功能特写截图。
 *
 * 跟 shots.mjs 的区别：那边是「自查用的界面记录」，这边是「对外宣传」，
 * 所以每张图只拍**一个功能**，并且刻意把界面填到最好看的状态 ——
 * 提示块那张要十一种都排上、关系图那张要有明显的枢纽和孤岛、搜索那张
 * 要能看到正文命中。空荡荡的界面当宣传图是没有说服力的。
 *
 * 一律 2 倍图：网页上要放大看细节（代码高亮、提示块配色、图表的线）。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes } from './fake-workspace.mjs'

const OUT = 'site/shots'
const PORT = Number(process.env.PORT || 4431)

/** 十一种提示块 + 图表 + 代码块：预览里最「满」的一屏 */
const SHOWCASE = [
  '---',
  'title: 一周手记',
  'tags: [手记, 示例]',
  '---',
  '',
  '# 一周手记',
  '',
  '*「把想法写下来，它们才会长成东西。」*',
  '',
  '> [!NOTE] 提示',
  '> 蓝。用来补一句不写也行、写了更清楚的话。',
  '',
  '> [!TIP] 技巧',
  '> 绿。围栏后面写 `line-numbers` 就有行号，`{2}` 高亮某一行。',
  '',
  '> [!WARNING] 警告',
  '> 琥珀。这一步做错了会丢东西。',
  '',
  '> [!DANGER] 危险',
  '> 红。删掉就找不回来了。',
  '',
  '> [!QUESTION] 疑问',
  '> 玫红。这里还没想清楚。',
  '',
  '> [!SUCCESS] 成功',
  '> 青绿。做完了。',
  '',
  '> [!IMPORTANT] 重要',
  '> 紫。这条别跳过。',
  '',
  '> [!EXAMPLE] 示例',
  '> 靛。给一个具体的样子。',
  '',
  '> [!CAUTION] 注意',
  '> 橙。小心一点。',
  '',
  '> [!INFO] 说明',
  '> 青蓝。交代背景。',
  '',
  '> [!QUOTE] 引用',
  '> 灰。别人的话。',
  '',
  '## 这周做了什么',
  '',
  '- [x] 把资料库迁到本地目录',
  '- [x] 给编辑器补上代码块行号',
  '- [ ] 整理读书笔记的双链 → [[读书笔记]]',
  '',
  '## 一段代码',
  '',
  '```ts title="notes.ts" line-numbers {3}',
  'export interface Note {',
  '  path: string',
  '  tags: string[]',
  '  updatedAt: number',
  '}',
  '```',
  '',
  '## 图表',
  '',
  '```mermaid',
  'graph LR',
  '  A[想法] --> B[笔记]',
  '  B --> C[整理]',
  '  C --> D[输出]',
  '  B --> D',
  '```',
  '',
  '## 表格',
  '',
  '| 项目 | 状态 | 耗时 |',
  '| --- | --- | --- |',
  '| 资料库 | 完成 | 2 天 |',
  '| 编辑器 | 完成 | 3 天 |',
  '| 双链 | 进行中 | — |',
  '',
].join('\n')

/** 关系图用的几篇：写一串互相引用的笔记，图上才有枢纽和孤岛 */
const LINKED = {
  '/ws/一周手记.md': SHOWCASE,
  '/ws/读书笔记.md': '# 读书笔记\n\n在读《设计中的设计》。[[一周手记]] 里也提到了这本。\n',
  '/ws/项目计划.md': '# 项目计划\n\n跟着 [[一周手记]] 推进，细节见 [[技术备忘]]。\n',
  '/ws/技术备忘.md': '# 技术备忘\n\n给 [[项目计划]] 做技术底稿。\n',
  '/ws/灵感.md': '# 灵感\n\n想到什么先扔这儿，之后再并进 [[项目计划]]。\n',
  '/ws/旧稿.md': '# 旧稿\n\n这一篇谁的都没提。\n',
}

function treeOf(extra) {
  const file = (name, tags = []) => ({
    type: 'file',
    name,
    path: `/ws/${name}`,
    tags,
    starred: name === '一周手记.md',
    mtime: Date.now() - 3600_000,
    excerpt: '',
  })
  return [
    {
      type: 'dir',
      name: '2026',
      path: '/ws/2026',
      children: [
        file('一周手记.md', ['手记']),
        file('读书笔记.md', ['阅读']),
        ...extra.map((n) => file(n)),
      ],
    },
  ]
}

const { send, evaluate, sleep, close, shot } = await launch({
  port: PORT,
  size: [1440, 900],
  scale: 2,
})

const notes = { ...makeNotes(), ...LINKED }
const tree = treeOf(['项目计划.md', '技术备忘.md', '灵感.md', '旧稿.md'])
const INJECT = makeInject({ notes, tree })

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1200)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(900)
await evaluate(`
  (() => {
    const r = [...document.querySelectorAll('.nlist .nl-item, .tree .row.file')]
      .find((b) => (b.textContent || '').includes('一周手记'));
    r?.click();
    return !!r;
  })()
`)
await sleep(1500)

const clickMode = async (label) => {
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.ph-seg-btn')].find(x => (x.getAttribute('aria-label')||'').includes(${JSON.stringify(label)})); b?.click(); return !!b })()`,
  )
  await sleep(900)
}

const setTheme = async (label) => {
  await evaluate(`(async () => {
    document.querySelector('.panel .foot .foot-btn[data-tip="设置"]')?.click()
    await new Promise(r => setTimeout(r, 400))
    const ap = [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent.includes('外观'))
    ap?.click()
    await new Promise(r => setTimeout(r, 300))
    const b = [...document.querySelectorAll('.st-seg-btn')].find(x => x.textContent.trim() === ${JSON.stringify(label)})
    b?.click()
    await new Promise(r => setTimeout(r, 300))
    document.querySelector('.st-x')?.click()
    return true
  })()`)
  await sleep(700)
}

/* ① 主视觉：浅色 · 分栏（左边源码、右边渲染结果） */
await clickMode('分栏')
await sleep(2600)
console.log('  →', await shot(`${OUT}/hero.png`))

/* ② 深色 · 阅读模式。图表配色会跟着重画，所以要等它画完 */
await setTheme('深色')
await clickMode('阅读模式')
await sleep(2600)
console.log('  →', await shot(`${OUT}/dark.png`))

/* ③ 提示块与图表：回到浅色分栏，滚到提示块那一屏 */
await setTheme('浅色')
await clickMode('分栏')
await sleep(2400)
await evaluate(`document.querySelector('.preview')?.scrollTo(0, 0)`)
await sleep(600)
console.log('  →', await shot(`${OUT}/callouts.png`))

/* ④ 关系图 */
await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.nav-item')].find((x) => x.textContent.includes('关系图'))
    b?.click()
    return !!b
  })()
`)
await sleep(3400)
console.log('  →', await shot(`${OUT}/graph.png`))

/* ⑤ 搜索面板：正文里搜「设计中的设计」，标题里没有这个词 */
await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.nav-item')].find((x) => x.textContent.includes('关系图'))
    b?.click()
    return !!b
  })()
`)
await sleep(700)
await evaluate(`
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true, bubbles: true }))
`)
await sleep(400)
await evaluate(`
  (() => {
    const i = document.querySelector('.sp-input')
    i.value = '设计中的设计'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()
`)
await sleep(1800)
console.log('  →', await shot(`${OUT}/search.png`))

await evaluate(`document.querySelector('.sp-x')?.click()`)
await sleep(400)

/* ⑥ 大纲与引用：中间那一列的两个页签 */
await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.col-tab, .nlist-tab')].find((x) => x.textContent.includes('大纲'))
    b?.click()
    return !!b
  })()
`)
await sleep(900)
console.log('  →', await shot(`${OUT}/outline.png`))

await close()
console.log('done')
process.exit(0)
