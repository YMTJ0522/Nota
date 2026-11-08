/**
 * 全功能测试.md 的渲染回归：
 * 把 demo/全功能测试.md 注入假工作区，数预览里的关键元素是否都渲染出来，
 * 同时收集控制台报错。选择器对不上就 FAIL。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from './cdp-harness.mjs'
import { makeInject, makeTree, openNoteExpr } from './fake-workspace.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = path.join(root, 'demo', '全功能测试.md')
const md = fs.readFileSync(FILE, 'utf-8')
const PORT = 4520

const { send, evaluate, sleep, close } = await launch({ port: PORT, size: [1600, 950] })
await send('Page.enable')
await send('Runtime.enable')
const errors = []
send('Runtime.consoleAPICalled').catch?.(() => {}) // noop, events come via waitEvent

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1400)
await evaluate(`localStorage.setItem('nota-tour-seen', '1')`)
await evaluate('location.reload()')
await sleep(1200)

const inj = makeInject({
  notes: { '/ws/全功能测试.md': md },
  tree: [
    ...makeTree(),
    { type: 'file', name: '全功能测试.md', path: '/ws/全功能测试.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' },
  ],
})
await evaluate(inj)
await sleep(600)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(900)
await evaluate(inj)
await sleep(600)
await evaluate(openNoteExpr('全功能测试'))
await sleep(1500)

/* Mermaid 是按视口懒渲染的（设计如此）：先滚到底再回顶，给所有图渲染机会 */
await evaluate(`(() => { const p = document.querySelector('.pv, [class*=preview]'); if (p) p.scrollTop = p.scrollHeight })()`)
await sleep(2500)
await evaluate(`(() => { const p = document.querySelector('.pv, [class*=preview]'); if (p) p.scrollTop = 0 })()`)
await sleep(1500)

/* 预览态再查一遍：切到「只看预览」需要点分栏按钮，这里直接读预览 pane */
/* 编辑器是 CodeMirror，视口虚拟化下 textContent 不代表全文，源码以预览侧的
   front-matter（pv-fm）来佐证「这篇笔记确实打开了」。 */
const stats = JSON.parse(
  await evaluate(`JSON.stringify({
    frontMatter: document.querySelectorAll('.pv-fm').length,
    preview: (() => { const p = document.querySelector('.pv, .preview, [class*=preview]'); return p ? p.innerHTML.length : 0 })(),
    callout: document.querySelectorAll('[class*=callout]').length,
    mermaidBlocks: document.querySelectorAll('.pv-mermaid').length,
    mermaidRendered: document.querySelectorAll('.pv-mermaid-graph.is-rendered').length,
    tables: document.querySelectorAll('.pv table, [class*=preview] table').length,
    details: document.querySelectorAll('details, [class*=details]').length,
    tabs: document.querySelectorAll('button.col-tab').length,
    fnote: document.querySelectorAll('[class*=footnote], [class*=fn-]').length,
    marks: document.querySelectorAll('mark').length,
    hl: document.querySelectorAll('[class*=highlight], mark').length,
    wiki: document.querySelectorAll('[class*=wlink], [class*=wiki]').length,
    embed: document.querySelectorAll('[class*=embed]').length,
    taskBox: document.querySelectorAll('.pv-task').length,
    taskDone: document.querySelectorAll('.pv-task.on').length,
    video: document.querySelectorAll('video').length,
  })`),
)

/* 收集这一窗口的 console error */
const collected = await evaluate(`JSON.stringify(window.__errors ?? [])`).catch(() => '[]')

let fail = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${name}${detail !== undefined ? '  — ' + detail : ''}`)
  if (!ok) fail++
}
check('这篇笔记已打开（front matter 渲染）', stats.frontMatter >= 1, `数量 ${stats.frontMatter}`)
check('预览面板有内容', stats.preview > 2000, `预览长度 ${stats.preview}`)
check('提示块 callout 渲染', stats.callout >= 2, `数量 ${stats.callout}`)
check('Mermaid 图 11 块全部渲染', stats.mermaidBlocks === 11 && stats.mermaidRendered === 11,
  `共 ${stats.mermaidBlocks} 块，渲染成功 ${stats.mermaidRendered}`)
check('表格渲染（3 张）', stats.tables >= 3, `数量 ${stats.tables}`)
check('折叠 details 渲染', stats.details >= 1, `数量 ${stats.details}`)
check('分栏标签渲染（3 个页签）', stats.tabs >= 3, `数量 ${stats.tabs}`)
check('脚注渲染', stats.fnote >= 1, `数量 ${stats.fnote}`)
check('高亮 mark 渲染（5 色）', stats.marks + stats.hl >= 5, `数量 ${stats.marks + stats.hl}`)
check('双链渲染', stats.wiki >= 2, `数量 ${stats.wiki}`)
check('嵌入块渲染', stats.embed >= 1, `数量 ${stats.embed}`)
check('任务复选框渲染（6 项）', stats.taskBox >= 6, `共 ${stats.taskBox}，已勾选 ${stats.taskDone}`)
console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`)
await close()
process.exit(fail ? 1 : 0)
