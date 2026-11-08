/**
 * 导出配色跟随强调色（2026-11-08 主题收尾的回归）：
 *   1. 切到朱砂 → 导出 HTML：--accent 是朱砂换算值 #b54436，不再出现旧的 #2f6f52
 *   2. 切到石墨 → 导出 Word：内联样式与 WORD_CSS 都用 #595b5e
 *   3. 导出文档固定白底（#fbfaf7 / #ffffff），不随应用深色主题走
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4421)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 960] })

const NOTE = [
  '# 导出配色',
  '',
  '链接 [示例](https://example.com) 和 `行内代码`。',
  '',
  '> 引用一句话。',
  '',
  '```ts',
  'const a = 1',
  '```',
].join('\n')

const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/导出配色.md': NOTE },
  tree: [
    ...makeTree(),
    { type: 'file', name: '导出配色.md', path: '/ws/导出配色.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' },
  ],
})

let bad = 0
function ok(name, cond, extra = '') {
  if (cond) console.log(`PASS ${name}${extra ? ' — ' + extra : ''}`)
  else {
    bad += 1
    console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1400)
await evaluate(`localStorage.setItem('nota-tour-seen', '1')`)
await evaluate(`location.reload()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(600)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(900)
await evaluate(INJECT)
await sleep(600)
await evaluate(`(() => { ${openNoteExpr('导出配色')} })()`)
await sleep(900)

/* 切强调色：设置 → 外观 → 色板第 idx 个 */
async function pickAccent(idx) {
  return evaluate(`(async () => {
    const btns = [...document.querySelectorAll('[data-tip="设置"]')]
    const s = btns.find(b => b.offsetParent !== null)
    if (s) s.click()
    await new Promise(r => setTimeout(r, 500))
    const ap = [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent.includes('外观'))
    if (!ap) return 'no nav: ' + [...document.querySelectorAll('.st-nav-item')].map(b => b.textContent.trim()).join(',')
    ap.click()
    await new Promise(r => setTimeout(r, 300))
    const dots = [...document.querySelectorAll('.st-swatches .st-swatch')]
    if (!dots.length) return 'no swatches'
    dots[${idx}]?.click()
    await new Promise(r => setTimeout(r, 200))
    const x = document.querySelector('.st-x'); if (x) x.click()
    await new Promise(r => setTimeout(r, 250))
    return document.documentElement.getAttribute('data-accent')
  })()`)
}

/* 通过导出菜单触发一次导出（与 verify-round19 同一套走法） */
async function doExport(kind) {
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
  if (p === 'null') return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(80)
  }
  await sleep(1600)
  return true
}

/* ── 1. 朱砂 → HTML 导出 ── */
const a1 = await pickAccent(1)
ok('切到朱砂', a1 === 'cinnabar', a1)
const gotHtml = await doExport('HTML')
const html = String(JSON.parse(await evaluate(`JSON.stringify(String(window.__exportedData?.html ?? ''))`)))
ok('取到 HTML 导出产物', gotHtml && html.length > 500, `len=${html.length}`)
ok('HTML 强调色 = 朱砂 #b54436', html.includes('--accent: #b54436'))
ok('HTML soft = 朱砂掺水 #f1e1dd', html.includes('--accent-soft: #f1e1dd'))
ok('HTML 里旧硬编码 #2f6f52 已绝迹', !html.includes('2f6f52'))
ok('HTML 白底 #fbfaf7', html.includes('background: #fbfaf7'))

/* ── 2. 石墨 → Word 导出 ── */
const a2 = await pickAccent(6)
ok('切到石墨', a2 === 'graphite', a2)
const gotWord = await doExport('Word')
const word = String(JSON.parse(await evaluate(`JSON.stringify(String(window.__exportedData?.word ?? ''))`)))
ok('取到 Word 导出产物', gotWord && word.length > 500, `len=${word.length}`)
ok('Word 链接色 = 石墨 #595b5e', word.includes('color:#595b5e') || word.includes('color: #595b5e'))
ok('Word 里旧硬编码 #2f6f52 已绝迹', !word.includes('2f6f52'))
ok('Word 白底 #ffffff', word.toLowerCase().includes('background: #ffffff') || word.toLowerCase().includes('background:#ffffff'))

ok('过程没有控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '))

await close()
process.exit(bad === 0 ? 0 : 1)
