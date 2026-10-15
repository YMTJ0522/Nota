/**
 * round25 —— 本轮六处修复的回归。
 *
 * 每一条都对着用户点名的那句话写：
 *   1. 收藏页资料栏顶部（笔记/大纲/引用）会动一下     → 量页签坐标
 *   2. 待办勾选时预览「动一下」                        → 量 scrollTop
 *   3. frontmatter（\--- 开头）漏进预览               → 数正文里有没有 title:
 *   4. 版本历史打开大笔记卡死                          → 大文件对比要能在窗口里活着算完
 *   5. 导出下拉要出现在按钮右侧                        → 量菜单与按钮的左右缘
 *   6. AI 页滚动条与右下角白色小方块                   → 滚动条不再占位（隐藏后 clientWidth==offsetWidth）
 * 附带：设置里新开的「云同步」分区能打开。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4425)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 980] })
const results = []
const ok = (name, pass, data) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`, data === undefined ? '' : JSON.stringify(data))
}

/* 一篇坏的 frontmatter（分隔线带反斜杠，就是用户截图里那种）
   + 一篇带任务清单的笔记 + 一篇 3000 行的大笔记 */
const BAD_FM = [
  '\\---',
  'title: 编辑器功能测试',
  'tags:',
  '- 测试',
  '- 体检',
  'star: true',
  '\\---',
  '',
  '# 编辑器功能测试',
  '',
  '正文第一段。',
].join('\n')

const TASKS = [
  '# 任务',
  '',
  '- [ ] 还没做的事',
  '- [x] 已经做完的事',
  '',
  '再来一行普通文字。',
].join('\n')

const BIG = ['# 大笔记'].concat(
  Array.from({ length: 3000 }, (_, i) => `第 ${i + 1} 行：这是一行用来撑行数的普通文本，后面跟一点内容 ${i % 7}`),
  [''],
).join('\n')
const BIG_OLD = BIG.replace('第 1500 行', '第 1500 行（改过）').replace('第 2999 行', '第 2999 行（也改过）')

const tree = makeTree()
const notes = {
  ...makeNotes(),
  '/ws/编辑器功能测试.md': BAD_FM,
  '/ws/任务.md': TASKS,
  '/ws/大笔记.md': BIG,
}
for (const [i, n] of ['编辑器功能测试', '任务', '大笔记'].entries()) {
  tree.unshift({
    type: 'file',
    name: `${n}.md`,
    path: `/ws/${n}.md`,
    tags: i === 0 ? ['测试'] : [],
    starred: i === 0,
    mtime: Date.now(),
    excerpt: '',
  })
}
const INJECT = makeInject({ notes, tree })

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1200)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1000)
await evaluate(INJECT)
await sleep(800)

/* ── 1. 收藏页页签不挪位 ── */
async function tabRects() {
  return evaluate(`(() => {
    const out = {}
    document.querySelectorAll('.col-tab').forEach(t => {
      const r = t.getBoundingClientRect()
      out[t.dataset.view] = [Math.round(r.left), Math.round(r.top)]
    })
    return out
  })()`)
}
const rAll = await tabRects()
await evaluate(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('收藏'))?.click()`)
await sleep(600)
const rStar = await tabRects()
await evaluate(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('最近编辑'))?.click()`)
await sleep(600)
const rRecent = await tabRects()
ok(
  '1.切到收藏/最近编辑，页签坐标不动（差≤1px）',
  Object.keys(rAll).every((k) => rStar[k] && rRecent[k] &&
    Math.abs(rAll[k][0] - rStar[k][0]) <= 1 && Math.abs(rAll[k][0] - rRecent[k][0]) <= 1 &&
    rAll[k][1] === rStar[k][1]),
  { all: rAll, star: rStar, recent: rRecent },
)

/* ── 2. 待办勾选不跳 ── */
await evaluate(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('所有笔记'))?.click()`)
await sleep(400)
await evaluate(`
  [...document.querySelectorAll('.nlist .nl-item')]
    .find(e => e.textContent.includes('任务'))?.click()
`)
await sleep(700)
await evaluate(
  `document.querySelector('.ph-seg-btn[aria-label^="分栏视图"]')?.click()`,
)
await sleep(700)
const before = await evaluate(`(() => {
  const t = [...document.querySelectorAll('.pv-task')].find(e => !e.classList.contains('on'))
  const p = document.querySelector('.preview')
  t?.scrollIntoView({ block: 'center' })
  return { top: p?.scrollTop ?? -1, n: document.querySelectorAll('.pv-task').length }
})()`)
await sleep(300)
const t0 = await evaluate(`document.querySelector('.preview')?.scrollTop ?? -1`)
await evaluate(`
  (() => {
    const t = [...document.querySelectorAll('.pv-task')].find(e => !e.classList.contains('on'))
    t?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })()
`)
await sleep(1200) // 等 180ms 防抖 + 重渲染 + mermaid/katex 一轮
const after = await evaluate(`(() => ({
  top: document.querySelector('.preview')?.scrollTop ?? -1,
  draft: undefined,
}))()`)
ok(
  '2.勾待办后预览滚动位置不变（差≤2px）',
  before.n >= 2 && Math.abs(t0 - after.top) <= 2,
  { before: t0, after: after.top, tasks: before.n },
)

/* ── 3. 坏 frontmatter 不漏进预览 ── */
await evaluate(`
  [...document.querySelectorAll('.nlist .nl-item')]
    .find(e => e.textContent.includes('编辑器功能测试'))?.click()
`)
await sleep(900)
const fm = await evaluate(`(() => {
  const p = document.querySelector('.preview')
  const txt = p?.textContent ?? ''
  return {
    leaked: /title:|star:|^-{2,}$/m.test(txt) || txt.includes('\\\\---'),
    firstH1: p?.querySelector('h1')?.textContent ?? '',
  }
})()`)
ok(
  '3.\\--- 转义的 frontmatter 被剥掉，正文从 h1 开始',
  !fm.leaked && fm.firstH1 === '编辑器功能测试',
  fm,
)

/* ── 4. 大笔记版本历史不卡死 ── */
await evaluate(`
  window.__hist['/ws/大笔记.md'] = [{ path: '/h/big-1', name: 'big-1.md', size: 10, mtime: Date.now() - 5000, content: ${JSON.stringify(BIG_OLD)} }]
`)
await evaluate(`
  [...document.querySelectorAll('.nlist .nl-item')]
    .find(e => e.textContent.includes('大笔记'))?.click()
`)
await sleep(700)
const t0ms = Date.now()
await evaluate(`document.querySelectorAll('.ea-btn')[1]?.click()`)
await sleep(600)
await evaluate(`[...document.querySelectorAll('.hp-seg button')].find(b => b.textContent.includes('对比'))?.click()`)
// 等异步 diff 落地（30ms 定时 + 计算）；给 4s 上限
let diffRows = 0
for (let i = 0; i < 20; i += 1) {
  await sleep(200)
  diffRows = await evaluate(`document.querySelectorAll('.hp-dl').length`)
  if (diffRows > 0 && !(await evaluate(`!!document.querySelector('.hp-hint')`))) break
}
const dt = Date.now() - t0ms
const alive = await evaluate(`1 + 1`)
ok(
  '4.3000 行笔记的对比算得完且窗口还活着',
  diffRows > 2900 && alive === 2 && dt < 6000,
  { rows: diffRows, ms: dt },
)
await evaluate(`document.querySelector('[data-role="hp-close"]')?.click()`)
await sleep(300)

/* ── 5. 导出菜单出现在按钮右侧 ── */
await evaluate(`document.querySelector('.ea-anchor')?.click()`)
await sleep(350)
const menuPos = await evaluate(`(() => {
  const m = document.querySelector('.ea-menu')
  const a = document.querySelector('.ea-anchor')
  if (!m || !a) return null
  const mr = m.getBoundingClientRect()
  const ar = a.getBoundingClientRect()
  return { menuLeft: Math.round(mr.left), anchorLeft: Math.round(ar.left), menuRight: Math.round(mr.right), anchorRight: Math.round(ar.right), vw: innerWidth }
})()`)
ok(
  '5.导出菜单从按钮左缘起排（在按钮右侧展开）',
  menuPos && Math.abs(menuPos.menuLeft - menuPos.anchorLeft) <= 2 && menuPos.menuRight > menuPos.anchorRight,
  menuPos,
)
await evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
await sleep(200)

/* ── 6. AI 页滚动条藏掉 ── */
await evaluate(`window.dispatchEvent(new CustomEvent('nota:settings', { detail: 'ai' }))`)
await sleep(400)
const aiEnabled = await evaluate(`document.querySelector('.st-switch')?.getAttribute('aria-checked')`)
if (aiEnabled !== 'true') {
  await evaluate(`document.querySelector('.st-switch')?.click()`)
  await sleep(300)
}
await evaluate(`document.querySelector('.st-x')?.click()`)
await sleep(300)
await evaluate(`
  [...document.querySelectorAll('.side-nav button, .nav-item, [data-role]')]
    .find(b => b.textContent.includes('AI'))?.click()
  || document.querySelector('[aria-label*="AI"]')?.click()
`)
await sleep(800)
const sb = await evaluate(`(() => {
  const s = document.querySelector('.stream')
  if (!s) return null
  return { stream: s.clientWidth === s.offsetWidth, sw: getComputedStyle(s).scrollbarWidth }
})()`)
ok('6.AI 消息流滚动条不占位（已隐藏）', sb && sb.stream && sb.sw === 'none', sb)

/* ── 7. 设置里云同步分区 ── */
await evaluate(`window.dispatchEvent(new CustomEvent('nota:settings', { detail: 'sync' }))`)
await sleep(400)
const syncUi = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.st-name')].map(e => e.textContent)
  return { has: rows.some(t => t === '服务器地址') && rows.some(t => t === '立即同步') }
})()`)
ok('7.设置里云同步分区在（地址/账号/立即同步）', syncUi.has, syncUi)
await evaluate(`document.querySelector('.st-x')?.click()`)

console.log(`\\n== round25: ${results.filter(r => r.pass).length}/${results.length} ==`)
if (errors.length) console.log('console errors:', errors.length)
await close()
process.exit(results.every(r => r.pass) && errors.length === 0 ? 0 : 1)
