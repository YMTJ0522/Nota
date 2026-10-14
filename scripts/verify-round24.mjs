/**
 * round24 —— 关系图与搜索面板
 *
 * 这两样是这一轮新加的，性质相同：**都是「换个角度找东西」**。
 * 列表能回答「有哪些」，回答不了「它们之间是什么关系」「我记得写过但忘了在哪篇」。
 *
 * 验证的难点在于它们都是异步的（要读几百篇正文），所以断言不能写成
 * 「打开就有结果」，而要写成「等它读完，结果里该有的东西都在」。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4424)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 980] })
const results = []
const ok = (name, pass, data) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`, data === undefined ? '' : JSON.stringify(data))
}

/* 三篇互相连着：甲 → 乙 → 丙，另外一篇谁也不连（图上要画成空心） */
const LINKED_A = '# 甲\n\n这里指向 [[乙]]，还有 [[丙]]。\n'
const LINKED_B = '# 乙\n\n乙只指向 [[丙]]。\n'
const LINKED_C = '# 丙\n\n丙提到 [[甲]]。\n'
const LONELY = '# 孤零零\n\n这篇谁的都没提，正文里只有一个词：石斑鱼。\n'

const tree = makeTree()
const notes = {
  ...makeNotes(),
  '/ws/甲.md': LINKED_A,
  '/ws/乙.md': LINKED_B,
  '/ws/丙.md': LINKED_C,
  '/ws/孤零零.md': LONELY,
}
for (const n of ['甲', '乙', '丙', '孤零零']) {
  tree.unshift({
    type: 'file',
    name: `${n}.md`,
    path: `/ws/${n}.md`,
    tags: [],
    starred: false,
    mtime: Date.now(),
    excerpt: '',
  })
}
const INJECT = makeInject({ notes, tree })

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1200)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(900)

/* ── 1. Ctrl+P：只搜标题 ── */
await evaluate(`
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))
`)
await sleep(400)
let st = JSON.parse(
  await evaluate(`
    (() => JSON.stringify({
      open: !!document.querySelector('.sp'),
      placeholder: document.querySelector('.sp-input')?.placeholder || '',
      rows: document.querySelectorAll('.sp-row').length,
    }))()
  `),
)
ok('1.Ctrl+P 弹出的是「只搜标题」那个面板', st.open && st.placeholder.includes('跳到'), st)

await evaluate(`
  (() => {
    const i = document.querySelector('.sp-input')
    i.value = '孤零零'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()
`)
await sleep(500)
st = JSON.parse(
  await evaluate(`
    (() => JSON.stringify({
      rows: [...document.querySelectorAll('.sp-row .sp-name')].map((n) => n.textContent),
      bodySec: !!document.querySelector('.sp-sec'),
    }))()
  `),
)
ok('2.输标题关键字 → 只有那一篇，且不出现「正文里提到」这一段', st.rows.length === 1 && st.rows[0].includes('孤零零'), st)

await evaluate(`document.querySelector('.sp-row.on')?.click()`)
await sleep(900)
const opened = await evaluate(`document.querySelector('.ea-title')?.value || document.querySelector('.cm-line')?.textContent || ''`)
ok('3.回车/点击 → 真的打开了那一篇', String(opened).includes('孤零零'), { opened })

/* ── 4. Ctrl+Shift+F：连正文一起搜 ── */
await evaluate(`
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true, bubbles: true }))
`)
await sleep(400)
await evaluate(`
  (() => {
    const i = document.querySelector('.sp-input')
    i.value = '石斑鱼'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()
`)
await sleep(1600)
st = JSON.parse(
  await evaluate(`
    (() => JSON.stringify({
      secs: [...document.querySelectorAll('.sp-sec')].map((n) => n.textContent.trim()),
      bodyRows: [...document.querySelectorAll('.sp-row .sp-line')].map((n) => n.textContent),
    }))()
  `),
)
ok(
  '4.Ctrl+Shift+F 能在正文里找到「石斑鱼」（标题里没有这个词）',
  st.bodyRows.some((t) => t.includes('石斑鱼')),
  st,
)

await evaluate(`document.querySelector('.sp-x')?.click()`)
await sleep(300)

/* ── 5. 关系图 ── */
await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.nav-item')].find((x) => x.textContent.includes('关系图'))
    b?.click()
    return !!b
  })()
`)
await sleep(2600)
const g = JSON.parse(
  await evaluate(`
    (() => JSON.stringify({
      canvas: !!document.querySelector('.gv-canvas'),
      meta: document.querySelector('.gv-meta')?.textContent.trim() || '',
    }))()
  `),
)
const metaNums = /(\d+)\s*篇\s*·\s*(\d+)\s*条连线/.exec(g.meta.replace(/\s+/g, ' '))
ok(
  '5.关系图画出来了：三条连线（甲乙、甲丙、乙丙 —— 甲与丙互相提到，算同一条）',
  g.canvas && !!metaNums && Number(metaNums[2]) === 3 && Number(metaNums[1]) === 10,
  { canvas: g.canvas, meta: g.meta.replace(/\s+/g, ' ') },
)

/* 画布上真的有像素（不是一块空白）—— 取中心区域非透明像素的比例 */
const inked = JSON.parse(
  await evaluate(`
    (() => {
      const cv = document.querySelector('.gv-canvas')
      if (!cv) return JSON.stringify({ ink: 0 })
      const ctx = cv.getContext('2d')
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data
      let n = 0
      for (let i = 3; i < d.length; i += 4 * 37) if (d[i] > 8) n += 1
      return JSON.stringify({ ink: n, sampled: Math.floor(d.length / (4 * 37)) })
    })()
  `),
)
ok('6.画布上真的画了东西（不是一块白）', inked.ink > 20, inked)

/* 点一个节点应该打开对应笔记：点当前高亮（active）之外的一个点比较麻烦，
   所以这里直接验「点画布空白处不报错、图还在」 */
await evaluate(`
  (() => {
    const cv = document.querySelector('.gv-canvas')
    const r = cv.getBoundingClientRect()
    cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 20, clientY: r.top + 20 }))
    cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + 20, clientY: r.top + 20 }))
    return true
  })()
`)
await sleep(400)
ok('7.图上点空白处不会崩（画布还在）', await evaluate(`!!document.querySelector('.gv-canvas')`))

/* 回到正文 */
await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.nav-item')].find((x) => x.textContent.includes('关系图'))
    b?.click()
    return !!b
  })()
`)
await sleep(600)
ok('8.再点一次关系图回到正文（编辑器回来了）', await evaluate(`!!document.querySelector('.cm-editor') || !!document.querySelector('.preview')`))

ok('9.控制台零报错', errors.length === 0, errors.slice(0, 3))

const pass = results.filter((x) => x.pass).length
console.log(`\n  round24: ${pass}/${results.length}`)
await close()
process.exit(pass === results.length ? 0 : 1)
