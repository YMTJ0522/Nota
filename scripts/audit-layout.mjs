/**
 * 布局巡检：跨视图、跨主题、跨窗宽找「不合适」的地方。
 *
 * 跟 round 系列的分工：round 验的是「这个版本改的东西对不对」，
 * 这一份不针对具体改动，是把整屏摊开量一遍，专治那些单点验证看不见的问题：
 *   - 文字被裁：内容比盒子宽，而盒子既不滚动也不省略
 *   - 越界：元素的边缘已经在窗口外面了（还在参与布局，不是 display:none）
 *   - 触摸目标过小：能点但不到 14px 的东西
 *
 * 跑法：node scripts/audit-layout.mjs
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, NOTE_STRUCT, openNoteExpr, navExpr } from './fake-workspace.mjs'

const PORT = 4361
const W = Number(process.argv[2] || 1500)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [W, 1000] })

const NOTES = { ...makeNotes(), '/ws/大纲样本.md': NOTE_STRUCT }
const TREE = [
  ...makeTree(),
  { type: 'file', name: '大纲样本.md', path: '/ws/大纲样本.md', tags: [], starred: false, mtime: Date.now() - 5_000, excerpt: '' },
]
const INJECT = makeInject({ notes: NOTES, tree: TREE })

// 假 IPC 是挂在 window 上的，一次 navigate 就没了：换了 document 就得重新注入一遍
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1600)
await evaluate('localStorage.clear()')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(2000)
await evaluate(INJECT)
await evaluate("document.querySelector('.cta')?.click()")
await sleep(1200)
await evaluate(INJECT)
await sleep(800)
await evaluate(openNoteExpr('大纲样本'))
await sleep(1200)

const auditExpr = () => `(async () => {
  const path = (el) => {
    const parts = []
    let p = el
    for (let i = 0; i < 3 && p && p !== document.body; i++) {
      const cls = (typeof p.className === 'string' ? p.className.trim().split(/\\s+/).slice(0, 2) : [])
      parts.unshift(p.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : ''))
      p = p.parentElement
    }
    return parts.join(' > ')
  }
  // 故意能横向滚 / 故意省略号的都不算毛病
  const scrollable = (el) => {
    let p = el
    while (p && p !== document.documentElement) {
      const s = getComputedStyle(p)
      if (s.overflowX === 'auto' || s.overflowX === 'scroll') return true
      p = p.parentElement
    }
    return false
  }
  const box = (el) => el.getBoundingClientRect()
  const alive = [...document.querySelectorAll('body *')].filter((el) => {
    const s = getComputedStyle(el)
    const r = box(el)
    // CodeMirror 内部自己管滚动和量高，文档再长也只是它的裁剪范围内的事，
    // 拿窗口尺寸去套只会报一堆 cm-gutter 的假警报。
    if (el.closest('.cm-editor')) return false
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && Number(s.opacity) > 0.05
  })
  const clipped = alive
    .filter((el) => {
      const s = getComputedStyle(el)
      return el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 &&
        s.textOverflow !== 'ellipsis' && s.overflowX !== 'auto' && s.overflowX !== 'scroll' && !scrollable(el)
    })
    .map((el) => ({ p: path(el), sw: el.scrollWidth, cw: el.clientWidth, t: (el.textContent || '').trim().slice(0, 20) }))
  const outside = alive
    .filter((el) => { const r = box(el); return r.right > innerWidth + 2 || r.left < -2 || r.bottom > innerHeight + 2 })
    .filter((el) => !scrollable(el))
    .map((el) => { const r = box(el); return { p: path(el), l: Math.round(r.left), r: Math.round(r.right), b: Math.round(r.bottom) } })
  const tiny = alive
    .filter((el) => (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && (box(el).width < 14 || box(el).height < 14))
    .map((el) => ({ p: path(el), w: Math.round(box(el).width), h: Math.round(box(el).height), t: el.getAttribute('data-tip') || el.getAttribute('title') || '' }))
  return { clipped: clipped.slice(0, 10), outside: outside.slice(0, 10), tiny: tiny.slice(0, 10) }
})()`

const setWidth = (w) => `(() => { document.querySelector('.app')?.__vue_app__; return true })()`

const report = {}
for (const theme of ['light', 'dark']) {
  // 主题必须走真正的切换按钮：直接写 <html data-theme> 会被 store 覆盖回去，
  // 那样深浅两趟其实量的是同一套配色。
  const real = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const trace = []
    for (let i = 0; i < 4; i++) {
      const now = document.documentElement.dataset.theme || 'light'
      trace.push('see:' + now)
      if (now === '${theme}') break
      const btn = document.querySelector('[data-role="theme-toggle"]')
      trace.push('btn:' + (btn ? 'yes' : 'no'))
      btn?.click()
      await wait(700)
    }
    return { got: document.documentElement.dataset.theme || 'light', trace: trace.join(' ') }
  })()`)
  console.log('  [主题]', JSON.stringify(real))
  const realTheme = real.got
  await sleep(320)
  for (const view of ['notes', 'attach', 'trash', 'ai']) {
    const key = `${realTheme}/${view}${realTheme === theme ? '' : ` (想要 ${theme})`}`
    if (view !== 'notes') {
      await evaluate(navExpr(view === 'attach' ? '附件库' : view === 'trash' ? '回收站' : 'AI 编写'))
      await sleep(800)
    }
    report[key] = await evaluate(auditExpr())
    if (view !== 'notes') {
      await evaluate(navExpr('所有笔记'))
      await sleep(600)
      await evaluate(openNoteExpr('大纲样本'))
      await sleep(600)
    }
  }
}

let bad = 0
for (const [k, v] of Object.entries(report)) {
  const lines = []
  if (v.clipped.length) lines.push(`    裁字 ${v.clipped.length}: ${JSON.stringify(v.clipped.slice(0, 4))}`)
  if (v.outside.length) lines.push(`    越界 ${v.outside.length}: ${JSON.stringify(v.outside.slice(0, 4))}`)
  if (v.tiny.length) lines.push(`    过小 ${v.tiny.length}: ${JSON.stringify(v.tiny.slice(0, 4))}`)
  if (lines.length) bad++
  console.log(`  ${k}:`, lines.length ? '\n' + lines.join('\n') : '干净')
}

console.log('\n--- JS ERRORS ---')
console.log(errors.length ? errors.join('\n') : '(none)')
console.log(
  `\n=== ${W}px ===\n` + (bad === 0 && errors.length === 0 ? '布局干净' : `${bad} 个视图有问题`),
)
await close()
process.exit(bad === 0 && errors.length === 0 ? 0 : 1)
