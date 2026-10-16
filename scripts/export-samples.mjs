/**
 * 临时探针（用完即删）：把一篇真实笔记按当前代码导出成 Word / PDF / HTML 三份成品，
 * 落到指定目录，好在外部（Word COM / 浏览器）里逐页目检排版。
 *
 * 用法：node scripts/_export3.mjs <源md> <输出目录前缀> [笔记显示名]
 * 产出：<前缀>.doc / <前缀>.pdf / <前缀>.html
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { launch } from './cdp-harness.mjs'
import { makeInject } from './fake-workspace.mjs'

const SRC = process.argv[2]
const OUT = process.argv[3]
const NAME = process.argv[4] || SRC.split(/[\\/]/).pop()

const md = readFileSync(SRC, 'utf8')
const key = '/ws/' + NAME

const { send, evaluate, sleep, close } = await launch({ port: 4470, size: [1500, 940] })
const notes = { [key]: md }
const TREE = [
  { type: 'file', name: NAME, path: key, tags: [], starred: false, mtime: Date.now(), excerpt: '' },
]
const INJECT = makeInject({ notes, tree: TREE })

await send('Page.navigate', { url: 'http://127.0.0.1:4470/' })
await sleep(1300)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1300)
await evaluate(INJECT)
await sleep(1000)

// 打开这篇笔记
const opened = await evaluate(`
  (() => {
    const r = [...document.querySelectorAll('.nlist .nl-item')].find(b => (b.textContent||'').includes(${JSON.stringify(NAME.replace(/\.md$/, ''))}))
    r?.click(); return !!r
  })()`)
const openedName = await evaluate(`
  (() => {
    const r = [...document.querySelectorAll('.nlist .nl-item')].find(b => (b.textContent||'').includes('Linux') || (b.textContent||'').includes('编辑器'))
    if (r) r.click()
    return r ? r.textContent.trim() : null
  })()`)
await sleep(2000)

/* DARK=1 时切成深色再导出：导出强制按浅色渲染图，正好拿这个场景验收。 */
if (process.env.DARK) {
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`)
  await sleep(900)
}

/* 等预览渲染完（mermaid 光栅化是异步的） */
await evaluate(`document.querySelector('.tab-preview, [data-tab]')?.click?.()`)
await sleep(2500)

async function exportAs(label) {
  const r = await evaluate(`(async () => {
    const anchor = document.querySelector('.ea-anchor')
    if (!anchor) return { fail: 'no .ea-anchor' }
    anchor.click()
    await new Promise(r => setTimeout(r, 300))
    const items = [...document.querySelectorAll('.ea-menu .ea-item, .hm-menu .hm-item, .ea-menu button, .hm-menu button')]
    const hit = items.find(b => (b.textContent || '').includes(${JSON.stringify(label)}))
    if (!hit) return { fail: 'no item', items: items.map(i => i.textContent.trim()) }
    hit.click()
    await new Promise(r => setTimeout(r, 4000))
    return { ok: true }
  })()`)
  if (r.fail) return r
  const data = await evaluate(`(() => {
    const d = window.__exportedData || {}
    const k = ${JSON.stringify(label)}.toLowerCase()
    if (k.includes('word')) return d.word || ''
    if (k.includes('pdf')) return d.pdf || ''
    if (k.includes('html')) return d.html || ''
    return ''
  })()`)
  return { ok: true, len: (data || '').length, data }
}

const out = {}
for (const [label, ext] of [['Word', 'doc'], ['PDF', 'pdf'], ['HTML', 'html']]) {
  const r = await exportAs(label)
  if (!r.ok) { out[label] = r; continue }
  writeFileSync(`${OUT}.${ext}`, r.data, 'utf8')
  out[label] = { ok: true, bytes: r.data.length }
  await sleep(600)
}

console.log('opened:', opened, '|', openedName)
console.log(JSON.stringify(out, null, 2))
await close()
