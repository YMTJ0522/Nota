/**
 * 编辑器里两件「从外面搬东西进来」的事：
 *   1. 粘贴表格 → GFM 表格（src/editor/paste-table.ts）
 *   2. 正文敲 `[[` → 笔记名补全（src/editor/completion.ts）
 *
 * 都在真实构建产物上跑，用真实的 CompositionEvent / ClipboardEvent，
 * 不直接调函数 —— 要验的正是「事件有没有被接住」这一层。
 *
 * 跑法：node scripts/verify-editor.mjs
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = 4371
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 1000] })

let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) {
    pass += 1
    console.log('  ✓ ' + name)
  } else {
    fails.push(name)
    console.log('  ✗ ' + name + (extra ? '   → ' + extra : ''))
  }
}

/* 靶子笔记：结尾留三行空行，粘贴点好找；代码块里放一条 shell 的 `[[`，
   用来证明「围栏里不要把 [[ 当引用意图」（那是 bash 的语法）。 */
const TARGET = [
  '---',
  'tags: []',
  '---',
  '',
  '# 粘贴靶子',
  '',
  '证据在这里。',
  '',
  '```bash',
  'if [[ -f "$f" ]]; then',
  '  echo ok',
  'fi',
  '```',
  '',
  '',
  '',
].join('\n')

/* 树里本来就有一篇 `新建文件夹/空的.md`，这里再放一篇同名的 `读书/空的.md`：
   重名是双链最常见也最容易指错的情况（resolveWikiNote 遇到重名不猜）。 */
const NOTES = { ...makeNotes(), '/ws/粘贴靶子.md': TARGET, '/ws/读书/空的.md': '' }
const TREE = [
  ...makeTree(),
  { type: 'file', name: '粘贴靶子.md', path: '/ws/粘贴靶子.md', tags: [], starred: false, mtime: Date.now() - 1_000, excerpt: '' },
  { type: 'file', name: '空的.md', path: '/ws/读书/空的.md', tags: [], starred: false, mtime: Date.now() - 2_000, excerpt: '' },
]
const INJECT = makeInject({ notes: NOTES, tree: TREE })

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1600)
await evaluate('localStorage.clear()')
await send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT })
await send('Page.reload')
await sleep(2200)
errors.length = 0
await evaluate("document.querySelector('.cta')?.click()")
await sleep(1200)
await evaluate(INJECT)
await sleep(600)
await evaluate(openNoteExpr('粘贴靶子'))
await sleep(1200)

const ready = await evaluate("!!document.querySelector('.cm-content')")
if (!ready) {
  console.log('编辑器没起来，后面没法测')
  await close()
  process.exit(1)
}

/** 全文按行读回来（live preview 会把行包在一堆装饰里，textContent 才是原文） */
const lines = () => evaluate(`[...document.querySelectorAll('.cm-content .cm-line')].map(l => l.textContent)`)
const text = async () => (await lines()).join('\n')

/** 把光标放到文档最后一行行首，后续粘贴 / 输入都落在那儿 */
async function caretToEnd() {
  const p = await evaluate(`(() => {
    const ls = document.querySelectorAll('.cm-content .cm-line')
    const l = ls[ls.length - 1]
    const r = l.getBoundingClientRect()
    return { x: Math.round(r.left + 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await sleep(150)
}

/**
 * 在编辑器上派发一次真实的 clipboard paste。
 * `html` 为空就只给纯文本（模拟终端 / 只给纯文本的应用）。
 * 返回 defaultPrevented —— 那就是「我们接管了这次粘贴」。
 */
const paste = (html, plain) =>
  evaluate(`(() => {
    const dt = new DataTransfer()
    ${html === null ? '' : `dt.setData('text/html', ${JSON.stringify(html)});`}
    dt.setData('text/plain', ${JSON.stringify(plain ?? '')})
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
    document.querySelector('.cm-content').dispatchEvent(ev)
    return ev.defaultPrevented
  })()`)

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function htmlTable(rows, { th = true, attrs = '' } = {}) {
  const body = rows
    .map(
      (r, i) =>
        '<tr>' +
        r.map((c) => `<${th && i === 0 ? 'th' : 'td'}>${esc(c)}</${th && i === 0 ? 'th' : 'td'}>`).join('') +
        '</tr>',
    )
    .join('')
  return `<html><head><meta charset="utf-8"><style>table{border-collapse:collapse}</style></head><body><table ${attrs}>${body}</table></body></html>`
}

/* 注意这几条断言的形状：**不接管 ≠ 文本没变**。
   handler 返回 false 之后浏览器照常做默认粘贴，纯文本会原样进来 ——
   要验的是「没生成表格」（没有那行 `| --- |`），而不是「什么都没发生」。 */
const hasTable = (s) => s.includes('| --- |')

/** 清掉上一轮粘进来的东西：全选删掉，再点回末尾。
    走页面里的 execCommand 而不是 CDP 发 Ctrl+A —— 后者在 headless 里不一定
    落到 CodeMirror 的 keymap 上（试过会静默失效，文本一路累积）。 */
async function wipe() {
  await evaluate(`(() => {
    const el = document.querySelector('.cm-content')
    el.focus()
    document.execCommand('selectAll')
    document.execCommand('delete')
    return el.textContent
  })()`)
  await sleep(200)
  await caretToEnd()
}

console.log('\n── 粘贴表格 ──')

/* 1. 一张带表头的三行表 */
await caretToEnd()
const emptyBefore = await text()
let took = await paste(htmlTable([['姓名', '部门', '工号'], ['张三', '技术部', '007'], ['李四', '市场部', '012']]), '姓名\t部门\t工号')
await sleep(300)
let body = await text()
ok('html 单表被接管', took === true, `defaultPrevented=${took}`)
ok('写出了表头行', body.includes('| 姓名 | 部门 | 工号 |'), body.split('\n').slice(-6).join('\n'))
ok('写了对齐分隔行', body.includes('| --- | --- | --- |'))
ok('三条数据都在', body.includes('| 张三 | 技术部 | 007 |') && body.includes('| 李四 | 市场部 | 012 |'))
ok('只插了一次（没有把纯文本也贴一遍）', body.length - emptyBefore.length < 260)

/* 2. 单元格里有竖线：必须转义，否则表格裂成两列 */
await wipe()
await paste(htmlTable([['名字', '说明'], ['a|b', '含竖线']]), '名字\t说明')
await sleep(250)
body = await text()
ok('单元格里的竖线被转义', body.includes('a\\|b'), body.split('\n').slice(-4).join('\n'))

/* 3. 原表没有表头：不许拿第一行数据冒充列名 */
await wipe()
await paste(htmlTable([['苹果', '12'], ['香蕉', '7']], { th: false }), '苹果\t12')
await sleep(250)
body = await text()
ok('无表头时造空表头，数据一条不少', body.includes('|  |  |') && body.includes('| 苹果 | 12 |'), body.split('\n').slice(-4).join('\n'))

/* 4. 表格夹在正文里：不接管。抽出来会让人丢掉那一大段文字 */
await wipe()
await paste(
  '<html><body><h1>周报</h1><p>本周做了三件事，下面是对应的人。</p>' +
    '<table><tr><th>姓名</th><th>部门</th></tr><tr><td>张三</td><td>技术部</td></tr></table></body></html>',
  '周报 本周做了三件事，下面是对应的人。 姓名 部门 张三 技术部',
)
await sleep(250)
body = await text()
ok('正文里夹着表格 → 不接管', !hasTable(body) && body.includes('周报'), body.slice(-120))

/* 5. 合并单元格：转出来会错列，宁可不转 */
await wipe()
await paste(
  '<html><body><table><tr><td colspan="2">合计</td></tr><tr><td>甲</td><td>1</td></tr></table></body></html>',
  '合计 甲 1',
)
await sleep(250)
body = await text()
ok('有 colspan 的表格不转', !hasTable(body), body.slice(-120))

/* 6. 只有一行的"表格"：更像是一段带边框的文字 */
await wipe()
await paste('<html><body><table><tr><td>只有一行</td><td>就一格</td></tr></table></body></html>', '只有一行')
await sleep(250)
body = await text()
ok('单行表格不转', !hasTable(body), body.slice(-120))

/* 7. 没有 html、tab 分隔的 3×3：照样认 */
await wipe()
await paste(null, '机器\tIP\t角色\nweb-01\t10.0.0.5\t前端\nweb-02\t10.0.0.6\t后端')
await sleep(250)
body = await text()
ok('tab 纯文本被认成表格', body.includes('| 机器 | IP | 角色 |') && body.includes('| web-01 | 10.0.0.5 | 前端 |'), body.split('\n').slice(-4).join('\n'))

/* 8. 列数不齐的 tab 文本：那不是表，是排过版的散文 */
await wipe()
await paste(null, '第一行\t两列\n第二行只有一列\n第三行\t两列')
await sleep(250)
body = await text()
ok('列数不齐不转', !hasTable(body), body.slice(-120))

/* 9. 普通多行文本：不转 */
await wipe()
await paste(null, '这是一段普通的话。\n第二行也是。')
await sleep(250)
body = await text()
ok('没有 tab 的普通文本不转', !hasTable(body), body.slice(-120))

console.log('\n── 双链补全 ──')

/** 从光标处敲一段字（走真实的 input 事件，不是直接改文档） */
const type = (s) =>
  evaluate(`(() => {
    const el = document.querySelector('.cm-content')
    el.focus()
    const ok = document.execCommand('insertText', false, ${JSON.stringify(s)})
    return ok
  })()`)

const pop = () =>
  evaluate(`(() => {
    const lis = [...document.querySelectorAll('.cm-tooltip-autocomplete li')]
    return lis.map(li => ({
      label: (li.querySelector('.cm-completionLabel')?.textContent ?? '').trim(),
      detail: (li.querySelector('.cm-completionDetail')?.textContent ?? '').trim(),
    }))
  })()`)

/* 10. 正文敲 [[ 要弹笔记名 */
await wipe()
await caretToEnd()
await type('[[')
await sleep(500)
let opts = await pop()
ok('敲 [[ 弹出候选', opts.length > 0, JSON.stringify(opts.slice(0, 4)))
ok('候选里是笔记名', opts.some((o) => o.label === '甲笔记' || o.label === '一周手记'), JSON.stringify(opts.slice(0, 6)))

/* 11. 前缀过滤：打「书」只剩书评 */
await type('书')
await sleep(400)
opts = await pop()
ok('按打进去的字过滤', opts.length > 0 && opts.every((o) => o.label.includes('书')), JSON.stringify(opts.slice(0, 6)))

/* 12. 列表里只有一篇叫这个名的，插入的是纯名字（不带目录） */
await wipe()
await caretToEnd()
await type('[[一周')
await sleep(450)
await evaluate(`(() => {
  const li = document.querySelector('.cm-tooltip-autocomplete li')
  li?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  return !!li
})()`)
await sleep(400)
body = await text()
ok('选中后只插入名字，不重复补 ]]', body.includes('[[一周手记]]') && !body.includes(']]]]'), body.split('\n').slice(-2).join('\n'))

/* 13. 重名的笔记：候选带目录，插入路径（否则谁也指不准是哪一篇） */
await wipe()
await caretToEnd()
await type('[[空的')
await sleep(450)
opts = await pop()
const dups = opts.filter((o) => o.label === '空的')
ok(
  '重名两条都在候选里，并带上目录',
  dups.length === 2 && dups.map((o) => o.detail).sort().join('|') === '新建文件夹|读书',
  JSON.stringify(dups),
)

/* 点第一条（按拼音排：读 < 新，所以是「读书/空的」） */
const picked = await evaluate(`(() => {
  const li = [...document.querySelectorAll('.cm-tooltip-autocomplete li')].find(x =>
    (x.querySelector('.cm-completionDetail')?.textContent ?? '').includes('读书'))
  li?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  return !!li
})()`)
await sleep(400)
body = await text()
ok('重名时插入相对路径', picked && body.includes('[[读书/空的]]'), body.split('\n').slice(-2).join('\n'))

/* 14. 预览里 [[目录/名字]] 要能解析到那一篇（以前路径那一档永远命中不了） */
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.ph-seg-btn')].find(b => (b.getAttribute('title') ?? '').includes('阅读模式'))
  btn?.click()
  return !!btn
})()`)
await sleep(1000)
const probe = await evaluate(`(() => {
  const links = [...document.querySelectorAll('.pv-wlink')]
  return {
    preview: !!document.querySelector('.pv-body'),
    links: links.length,
    notes: links.map(a => a.getAttribute('data-note')),
    sample: links[0]?.outerHTML.slice(0, 160) ?? '',
  }
})()`)
const missing = await evaluate(`(() => {
  const el = [...document.querySelectorAll('.pv-wlink')].find(a => (a.getAttribute('data-note') ?? '').includes('读书/空的'))
  return el ? el.classList.contains('is-missing') : null
})()`)
ok('路径形式的双链不是「找不到」', missing === false, JSON.stringify(probe))

console.log('')
ok('全程没有 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '))

await close()
console.log(`\n${pass} 过 / ${fails.length} 败`)
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log('  · ' + f)
  process.exit(1)
}
