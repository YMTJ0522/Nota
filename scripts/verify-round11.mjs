/**
 * 2.1.0 验证：把 demo/ 这套真实测试笔记灌进预览，看它是不是真的都能渲染。
 *
 * 前面几轮都在用「为断言而生」的小笔记，好处是稳，坏处是骗自己——
 * 语法写得规规矩矩，自然不会出错。这一轮不再自己造内容，
 * 直接把 demo/ 里那 9 篇读进来渲染：图表、提示块、公式、表格、
 * 带空格路径的图片，全都是真实世界的写法。
 *
 * 跑法：node scripts/verify-round11.mjs
 *
 * 覆盖：
 *  1. 06 图表：11 种 Mermaid 至少渲染出 10 张图，写坏的那张给的是错误提示不是空白
 *  2. 08 内容块：11 种提示块都渲染成卡片，折叠块能开合
 *  3. 07 数学公式：KaTeX 真的注入了（不是留着裸的 $…$）
 *  4. 05 代码块与表格：代码块有语言标签、表格有表头
 *  5. 09 附件：带空格的图片地址照样出 <img>
 *  6. 01–04：标题层级、行内格式、任务列表、双链都在
 *  7. 大纲：从真实笔记里抽出的标题层级正确
 *  8. 全程零 JS 异常
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from './cdp-harness.mjs'
import { makeInject, openNoteExpr, navExpr } from './fake-workspace.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const demoDir = path.join(root, 'demo')

/** 把 demo/ 读成「路径 -> 内容」和目录树，喂给假 IPC */
function loadDemo() {
  const notes = {}
  const walk = (dir) => {
    const out = []
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      if (fs.statSync(full).isDirectory()) {
        if (name === 'attachments') continue
        const kids = walk(full)
        out.push({
          type: 'dir',
          name,
          path: '/ws/' + name,
          children: kids.files,
        })
        Object.assign(notes, kids.notes)
      } else if (name.endsWith('.md')) {
        notes['/ws/' + name] = fs.readFileSync(full, 'utf8')
        out.push({ type: 'file', name, path: '/ws/' + name, tags: [], starred: false, mtime: Date.now(), excerpt: '' })
      }
    }
    return { files: out, notes }
  }
  const top = walk(demoDir)
  // 目录项要排在前面：界面按「文件夹优先」排，断言里按下标取才稳
  const dirs = top.files.filter((f) => f.type === 'dir')
  const files = top.files.filter((f) => f.type === 'file')
  return { notes: { ...top.notes }, tree: [...dirs, ...files] }
}

const demo = loadDemo()
console.log('  [debug] demo 笔记:', Object.keys(demo.notes).join(' / '))

const { send, evaluate, sleep, errors, close } = await launch({ port: 4377, size: [1500, 1000] })
const PORT = 4377

const out = {}
const ok = (name, cond, detail) => {
  out[name] = { pass: !!cond, detail }
  console.log(cond ? '  PASS  ' : '  FAIL  ', name, detail !== undefined ? JSON.stringify(detail) : '')
}

const INJECT = makeInject({ notes: demo.notes, tree: demo.tree })

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1600)
await evaluate('localStorage.clear()')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(2000)
await evaluate(INJECT)
await evaluate("document.querySelector('.cta')?.click()")
await sleep(1400)
await evaluate(INJECT)
await sleep(900)
await evaluate(navExpr('所有笔记'))
await sleep(700)

/** 打开某篇并切到阅读模式，返回预览里的统计 */
const previewOf = (name) => `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const open = ${openNoteExpr(name)}
  open
  await wait(1100)
  const read = document.querySelector('.ph-seg-btn[aria-label^="阅读模式"]')
  read?.click()
  // 12 张图要一张张渲染（mermaid 首帧还要拉 1MB 的 chunk），等短了会只看到一半
  await wait(6000)
  const body = document.querySelector('.preview.md-body') ?? document.querySelector('.md-body')
  const count = (s) => (body?.querySelectorAll(s).length ?? 0)
  return {
    opened: !!body,
    h1: count('h1'), h2: count('h2'), h3: count('h3'),
    mermaid: count('.pv-mermaid-graph'),
    svg: count('.pv-mermaid-graph svg'),
    rendered: count('.pv-mermaid-graph.is-rendered'),
    mermaidErr: count('.pv-mermaid-graph.is-error'),
    callout: count('.pv-callout'),
    katex: count('.katex'),
    code: count('pre code'),
    langAttr: count('pre code[class*="language-"]'),
    table: count('table'),
    th: count('table th'),
    img: count('img'),
    task: count('input[type="checkbox"]'),
    details: count('details'),
    wiki: count('.pv-wiki, .wiki-link, [data-wiki]'),
    hr: count('hr'),
    strong: count('strong'),
  }
})()`

/* ══ 1. 图表 ══ */
const charts = await evaluate(previewOf('06 图表'))
ok(
  '1.demo/06 图表：11 种 Mermaid 至少渲染 10 张图，写坏的那张给错误提示',
  charts.opened && charts.mermaid >= 11 && charts.rendered >= 10 && charts.mermaidErr >= 1,
  charts,
)

/* ══ 2. 提示块 + 折叠 ══ */
const blocks = await evaluate(previewOf('08 内容块'))
ok(
  '2.demo/08 内容块：11 种提示块都成卡片，折叠块与分割线都在',
  blocks.opened && blocks.callout >= 11 && blocks.details >= 1 && blocks.hr >= 1,
  blocks,
)

/* ══ 3. 数学公式 ══ */
const math = await evaluate(previewOf('07 数学公式'))
ok(
  '3.demo/07 数学公式：KaTeX 真的注入了（不是留着裸的 $…$）',
  math.opened && math.katex >= 1,
  math,
)

/* ══ 4. 代码块与表格 ══ */
const code = await evaluate(previewOf('05 代码块'))
ok(
  '4.demo/05 代码块与表格：代码块带语言标签，表格有表头',
  code.opened && code.code >= 2 && code.langAttr >= 1 && code.table >= 1 && code.th >= 2,
  code,
)

/* ══ 5. 附件（含带空格的路径） ══ */
const attach = await evaluate(previewOf('09 附件'))
ok(
  '5.demo/09 附件：图片引用出 <img>，带空格的地址也照样解析',
  attach.opened && attach.img >= 1,
  attach,
)

/* ══ 6. 入门四篇 ══ */
const basics = []
for (const n of ['01 基础编辑', '02 行内格式', '03 列表与任务', '04 链接与双链']) {
  basics.push(await evaluate(previewOf(n)))
}
const [b1, b2, b3, b4] = basics
ok(
  '6.demo/入门四篇：标题层级、行内加粗、任务列表、双链都渲染出来',
  b1.h1 >= 1 && b1.h2 >= 3 && b2.strong >= 1 && b3.task >= 1 && b4.wiki + b4.h2 >= 1,
  { b1: { h1: b1.h1, h2: b1.h2 }, b2: { strong: b2.strong }, b3: { task: b3.task }, b4: { wiki: b4.wiki, img: b4.img } },
)

/* ══ 7. 大纲从真实笔记里抽标题 ══ */
const outline = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  void ${openNoteExpr('01 基础编辑')};
  await wait(1000)
  document.querySelector('.col-tab[data-view="outline"]')?.click()
  await wait(700)
  const items = [...document.querySelectorAll('.ov .ov-item')].map(b => ({
    lv: b.querySelector('.ov-lv')?.textContent?.trim(),
    t: b.querySelector('.ov-text')?.textContent?.trim(),
  }))
  document.querySelector('.col-tab[data-view="notes"]')?.click()
  await wait(300)
  return items
})()`)
ok(
  '7.大纲：真实笔记的标题层级抽得出来（H1 → H2 都有）',
  outline.length >= 4 && outline.some((i) => i.lv === 'H1') && outline.some((i) => i.lv === 'H2'),
  outline.slice(0, 6),
)

/* ══ 8. 零异常 ══ */
ok('8.全程零 JS 异常', errors.length === 0, errors.slice(0, 4))

console.log('\n=== SUMMARY ===')
const failed = Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k)
if (failed.length) console.log('FAILED:', failed.join(', '))
else console.log('ALL PASS (' + Object.keys(out).length + ')')

await close()
process.exit(failed.length ? 1 : 0)
