// 探针：首次启动落在欢迎文档上，正文要真渲染出来。
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from './cdp-harness.mjs'
import { makeInject } from './fake-workspace.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, '.tmp-welcome.mjs')
await build({
  entryPoints: [path.join(ROOT, 'electron', 'welcome-doc.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: OUT,
  logLevel: 'silent',
})
const { WELCOME_DOC, WELCOME_NAME } = await import(`file://${OUT.replace(/\\/g, '/')}`)

const FILE = '/ws/' + WELCOME_NAME
const notes = { [FILE]: WELCOME_DOC }
const tree = [
  {
    type: 'file',
    name: WELCOME_NAME,
    path: FILE,
    tags: [],
    starred: false,
    mtime: Date.now(),
    excerpt: 'Nota 是一个只做笔记的软件',
  },
]

const INJECT = makeInject({
  notes,
  tree,
  vault: { root: '/ws', file: FILE, created: true },
})

const { send, evaluate, sleep, shot, close } = await launch({ port: 4488, size: [1400, 1900], scale: 1 })

// 必须在文档创建前注入：bootFirstRun 在 onMounted 就调用 ensureVault，
// 等页面加载完再塞 api 已经晚了。
await send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT })
await send('Page.navigate', { url: 'http://127.0.0.1:4488/' })
await sleep(2600)

// 切到左写右看：默认是纯编辑，正文只在 CodeMirror 里，看不到 callout 和图表
const seg = await evaluate(`(() => {
  const btns = [...document.querySelectorAll('.ph-seg-btn')]
  const off = btns.find(b => !b.classList.contains('on'))
  if (!off) return { ok: false, n: btns.length }
  off.click()
  return { ok: true, n: btns.length, label: (off.getAttribute('title') || off.textContent || '').trim() }
})()`)
console.log('切分栏：', JSON.stringify(seg))
await sleep(2200)

const probe = await evaluate(`(() => {
  const body = document.querySelector('.md-body')
  if (!body) return {
    ok: false,
    why: '没有 .md-body',
    hasCta: !!document.querySelector('.cta'),
    hasCm: !!document.querySelector('.cm-editor'),
    cmText: (document.querySelector('.cm-content')?.textContent || '').slice(0, 120),
    cmLen: (document.querySelector('.cm-content')?.textContent || '').length,
    mainCls: [...document.querySelectorAll('.main *')].slice(0, 25).map(e => e.className).join(' | '),
  }
  const txt = body.textContent || ''
  return {
    ok: true,
    h1: (body.querySelector('h1')?.textContent || '').trim(),
    h2: [...body.querySelectorAll('h2')].map(h => h.textContent.trim()),
    callouts: body.querySelectorAll('.pv-callout').length,
    tables: body.querySelectorAll('table').length,
    katex: body.querySelectorAll('.katex').length,
    mermaidSvg: body.querySelectorAll('svg').length,
    checks: body.querySelectorAll('input[type=checkbox]').length,
    codes: body.querySelectorAll('pre code').length,
    wikilinks: body.querySelectorAll('a').length,
    chars: txt.length,
    title: (document.querySelector('.title-input')?.value || document.querySelector('.np-title')?.textContent || '').trim(),
    listRows: document.querySelectorAll('.nlist .nl-item').length,
  }
})()`)

const detail = await evaluate(`(() => {
  const g = document.querySelector('.pv-mermaid-graph')
  const svg = g ? g.querySelector('svg') : null
  const r = svg ? svg.getBoundingClientRect() : null
  const box = (document.querySelector('.pv-mermaid') || g)?.getBoundingClientRect() || null
  return {
    mermaid: svg
      ? { w: Math.round(r.width), h: Math.round(r.height),
          nodes: svg.querySelectorAll('g.node').length,
          edges: svg.querySelectorAll('path.flowchart-link, path[class*=flowchart]').length,
          allPaths: svg.querySelectorAll('path').length }
      : null,
    mermaidError: !!g && g.classList.contains('is-error'),
    srcVisible: !!(document.querySelector('.pv-mermaid-src') || {}).offsetParent,
    tasks: [...document.querySelectorAll('.pv-task')].map(function (t) {
      return (t.classList.contains('on') ? '[x] ' : '[ ] ') + (t.parentElement?.textContent || '').trim().slice(0, 14)
    }),
    clip: box ? { x: Math.max(0, box.left - 8), y: Math.max(0, box.top - 8), width: Math.round(box.width + 16), height: Math.round(box.height + 16) } : null,
  }
})()`)
console.log(JSON.stringify(detail, null, 2))

if (detail.clip && detail.clip.width > 40 && detail.clip.height > 40) {
  await shot(path.join(ROOT, 'docs', 'probe-welcome-mermaid.png'), detail.clip)
}

await shot(path.join(ROOT, 'docs', 'probe-welcome.png'))
await close()
