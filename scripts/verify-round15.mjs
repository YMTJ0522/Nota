/**
 * round15 —— 2.2.6：导出四种 + 图表/公式真渲染、AI 会话与联网、自定义图标、
 *             查找替换、粘贴图片、表格圆角
 *
 * 这一轮的共同点是「界面上看着没问题，但导出去 / 点下去才暴露」：
 *
 *  1. 顶栏导出以前只有 MD / HTML 两项，PDF 与 Word 只在右键菜单里 ——
 *     这里断言四项都在，并且点了真的走到对应的 IPC。
 *  2. 导出里**图表和公式必须已经渲染过**。不渲染的话导出来就是一段
 *     ```mermaid 代码和一堆 `$...$`：预览里看得见、导出里看不见。
 *     断言方式是直接读导出的 HTML 内容（假的 exportSave 把 data 存下来了）。
 *     Word 那一路走的是另一套（图片 + MathML），也一并断言。
 *  3. AI 会话下拉里每行要有一枚就地删除；模型下拉**不许出现没配置的预设** ——
 *     那些点了也连不上，摆着只会让人以为软件坏了。
 *  4. 自定义图标要真的落到 `.nota/icons.json`（断言 iconsWrite 收到的内容），
 *     并且侧栏与卡片区都要画出来。
 *  5. 查找条的三开关 + 替换；粘贴图片要真的走 mediaSave 并写进 Markdown。
 *  6. 表格圆角：量 `border-radius` 的计算值。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4397)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 950] })
const results = []
const ok = (name, pass, data) => {
  results.push({ name, pass, data })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`, data === undefined ? '' : JSON.stringify(data))
}

/* 一篇同时含图表、公式、表格的笔记 —— 导出那条链路的靶子 */
const NOTE = [
  '---',
  'tags: [测试]',
  '---',
  '',
  '# 导出靶子',
  '',
  '## 表格',
  '',
  '| 语言 | 用途 |',
  '| --- | --- |',
  '| Python | 数据 |',
  '| Rust | 系统 |',
  '',
  '## 公式',
  '',
  '行内公式 $E = mc^2$ 要解析出来。',
  '',
  '$$',
  '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
  '$$',
  '',
  '## 图表',
  '',
  '```mermaid',
  'graph TD',
  '  A[开始] --> B[结束]',
  '```',
  '',
  '正文里出现一个词：kubectl，用来验补全与查找。',
  '',
].join('\n')

const OTHER = '# 乙笔记\n\n这里有一行 kubectl 供查找。\n'

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1400)
await evaluate('localStorage.clear()')
/* 会话存在 localStorage 里（`nota-chat-sessions`），干净的页面一条都没有 ——
   不预先塞两条的话，第 13/14 条量到的永远是 0，而且看着像「功能没做」。
   落盘格式跟 store 的 saveSessions 一致：{ active, sessions:[{id,title,updatedAt,messages}] } */
await evaluate(`localStorage.setItem('nota-chat-sessions', JSON.stringify({
  active: 11,
  sessions: [
    { id: 11, title: '帮我改一段开场白', updatedAt: ${Date.now()}, messages: [
      { id: 1, role: 'user', content: '帮我改一段开场白' },
      { id: 2, role: 'assistant', content: '可以这样写：……' },
    ] },
    { id: 12, title: '把这段翻译成英文', updatedAt: ${Date.now() - 60000}, messages: [
      { id: 3, role: 'user', content: '把这段翻译成英文' },
    ] },
  ],
}))`)
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1700)

const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/导出靶子.md': NOTE, '/ws/乙笔记.md': OTHER },
  tree: [
    ...makeTree(),
    { type: 'file', name: '导出靶子.md', path: '/ws/导出靶子.md', tags: ['测试'], starred: false, mtime: Date.now(), excerpt: '' },
  ],
})
await evaluate(INJECT)
await evaluate("document.querySelector('.cta')?.click()")
await sleep(1200)
await evaluate(INJECT)
await sleep(700)
/* 先关掉「助手写的那一栏」以外的干扰：把中间列切回笔记 */
await evaluate(`document.querySelector('.col-tab[data-view="notes"]')?.click()`)
await sleep(500)
await evaluate(openNoteExpr('导出靶子'))
await sleep(1500)

/* ══ 1. 顶栏导出菜单：四种齐全 ══ */
await evaluate(`document.querySelector('.ea-anchor')?.click()`)
await sleep(500)
const menuItems = JSON.parse(
  await evaluate(`JSON.stringify([...document.querySelectorAll('.ea-menu .n-menu-item .n-menu-name')].map(e => e.textContent.trim()))`),
)
ok(
  '1.顶栏导出菜单四种齐全（MD / HTML / Word / PDF）',
  ['Markdown', 'HTML', 'Word', 'PDF'].every((k) => menuItems.some((t) => t.includes(k))) && menuItems.length === 4,
  menuItems,
)

/** 点导出菜单里的某一项。
    坑：`.ea-anchor` 是**开关**不是「打开」。第 1 条断言量完菜单时它还开着，
    这里再点一次就把它关上了 —— 第一次调用（HTML）什么都点不到，
    第二次（Word）反而正常，表现成「只有 HTML 导出坏了」。
    所以先判断，没开才开。 */
async function pickExport(kind) {
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
  if (!p || p.err) return null
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(80)
  }
  await sleep(1500)
  return true
}

/* ══ 2. HTML 导出：图表与公式都渲染过，没有原始语法漏出来 ══
   判据要「解析成 DOM 再数」，不能用全文搜：
     · KaTeX 的 HTML 输出本来就带一份 `<annotation encoding="application/x-tex">`
       源码，那是它自己的无障碍后备，搜 `\int_0^1` 必然命中，但公式是排好的；
     · `.pv-mermaid-graph` 上的 `data-graph` 属性也一直带着源码。
   真正该数是「有没有占位没被渲染」以及「源码块有没有被摘掉」。 */
const EXPORT_PROBE = `(kind) => {
  const d = (window.__exportedData || {})[kind] || ''
  const doc = new DOMParser().parseFromString(d, 'text/html')
  const graphs = [...doc.querySelectorAll('.pv-mermaid-graph')]
  const maths = [...doc.querySelectorAll('.pv-math, .pv-math-block')]
  return JSON.stringify({
    len: d.length,
    graphs: graphs.length,
    graphRendered: graphs.filter((g) => g.classList.contains('is-rendered')).length,
    graphSvg: graphs.filter((g) => g.querySelector('svg')).length,
    graphImg: graphs.filter((g) => g.querySelector('img[src^="data:image/png"]')).length,
    maths: maths.length,
    mathRendered: maths.filter((m) => m.classList.contains('is-rendered')).length,
    mathKatex: maths.filter((m) => m.querySelector('.katex')).length,
    /* 图注那块源码：画出来了就不该还在 */
    srcLeft: doc.querySelectorAll('.pv-mermaid-src').length,
  })
}`
await evaluate(`window.__probe = ${EXPORT_PROBE}`)

await pickExport('HTML')
const h = JSON.parse(await evaluate(`window.__probe('html')`))
ok(
  '2.HTML 导出里 mermaid 渲染成 SVG、源码块不再挂在图上面',
  h.graphs >= 1 && h.graphRendered === h.graphs && h.graphSvg === h.graphs && h.srcLeft === 0,
  h,
)
ok(
  '3.HTML 导出里公式渲染成 KaTeX、没有一个占位是空的',
  h.maths >= 2 && h.mathRendered === h.maths && h.mathKatex === h.maths,
  h,
)

const cssInline = await evaluate(`(() => { const d = window.__exportedData?.html || ''; return JSON.stringify({ katexCss: d.includes('.katex'), font: /data:font\\/woff2;base64,/.test(d) }) })()`)
const ci = JSON.parse(cssInline)
ok('4.HTML 导出把公式样式与字体一起内联（单文件拷走也不掉公式）', ci.katexCss && ci.font, ci)

/* ══ 3. Word 导出：图表走图片、公式走 MathML ══ */
await evaluate(`window.__exportedData = {}`)
await pickExport('Word')
const word = JSON.parse(await evaluate(`window.__probe('word')`))
const wordRaw = await evaluate(`(() => { const d = window.__exportedData?.word || ''; return JSON.stringify({ section: d.includes('WordSection1') }) })()`)
const ws = JSON.parse(wordRaw)
ok(
  '5.Word 导出：图表转成 PNG 图片、公式转成 MathML（Word 认这两样）',
  word.graphs >= 1 && word.graphImg === word.graphs && word.maths >= 2 && word.mathRendered === word.maths && word.srcLeft === 0 && ws.section,
  { ...word, section: ws.section },
)

/* ══ 4. 表格圆角 ══
   圆角长在 `enhancePreview` 包出来的 `.pv-table-wrap` 上，只有预览真的在
   渲染时才存在。默认可能是纯编辑视图，先把视图切到分栏，
   否则量到的「no table wrap」会被误读成样式没写。 */
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="分栏视图"]')?.click()`)
await sleep(1500)

/* 图渲染出来之后，顶上那段灰色源码必须消失。
   它以前一直在：每张图表上方挂着 `graph TD / A-->B`，预览和导出都带。 */
const msrc = JSON.parse(
  await evaluate(`(() => {
    const g = document.querySelector('.md-body .pv-mermaid-graph')
    const src = document.querySelector('.md-body .pv-mermaid-src')
    const b = src?.getBoundingClientRect()
    return JSON.stringify({
      graph: !!g,
      rendered: !!g?.classList.contains('is-rendered'),
      svg: !!g?.querySelector('svg'),
      srcLeft: document.querySelectorAll('.md-body .pv-mermaid-src').length,
      srcVisible: !!src && !!(b && b.width > 0 && b.height > 0),
    })
  })()`),
)
ok('6a.图表画出来后，那段灰色源码不再挂在图上面', msrc.svg && msrc.srcLeft === 0 && !msrc.srcVisible, msrc)

const table = JSON.parse(
  await evaluate(`(() => {
    const w = document.querySelector('.md-body .pv-table-wrap') || document.querySelector('.pv-table-wrap')
    if (!w) return JSON.stringify({ err: 'no table wrap' })
    const cs = getComputedStyle(w)
    return JSON.stringify({ radius: cs.borderRadius, overflow: cs.overflowX, hasTable: !!w.querySelector('table') })
  })()`),
)
ok('6.预览里的表格有圆角（和代码块统一）', !table.err && table.hasTable && parseFloat(table.radius) > 0, table)

/* ══ 5. 查找与替换 ══ */
await evaluate(`document.querySelector('[title^="在本文中查找"]')?.click()`)
await sleep(500)
async function setInput(sel, text) {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return
    el.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(500)
}
await setInput('.fb-input', 'kubectl')
const found = JSON.parse(await evaluate(`JSON.stringify({ bar: !!document.querySelector('.findbar'), count: document.querySelector('.fb-count')?.textContent?.trim() || '', press: !!document.querySelector('.cm-searchMatch') })`))
ok('7.查找条能搜到、计数显示正确', found.bar && /1/.test(found.count), found)

/* 区分大小写：大写 K 不该再匹配到小写那个 */
await evaluate(`([...document.querySelectorAll('.fb-btn.opt')].find(b => b.title === '区分大小写'))?.click()`)
await sleep(400)
await setInput('.fb-input', 'KUBECTL')
const caseOn = JSON.parse(await evaluate(`JSON.stringify({ count: document.querySelector('.fb-count')?.textContent?.trim() || '', on: !!document.querySelector('.fb-btn.opt.on') })`))
ok('8.「区分大小写」开关生效（大写不再匹配到小写）', caseOn.on && /无匹配|0/.test(caseOn.count), caseOn)
await evaluate(`([...document.querySelectorAll('.fb-btn.opt')].find(b => b.title === '区分大小写'))?.click()`)
await sleep(300)

/* 替换行：展开 → 填 → 全部替换 */
await evaluate(`([...document.querySelectorAll('.fb-btn.opt')].find(b => b.title === '替换'))?.click()`)
await sleep(400)
await setInput('.fb-input', 'kubectl')
await setInput('.fb-row:nth-child(2) .fb-input', 'k8s')
const repBtns = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.fb-btn.wide')].map(b => b.textContent.trim()))`))
await evaluate(`([...document.querySelectorAll('.fb-btn.wide')].find(b => b.textContent.trim() === '全部'))?.click()`)
await sleep(700)
const after = await evaluate(`(() => { const t = [...document.querySelectorAll('.cm-content .cm-line')].map(l => l.textContent).join('\\n'); return JSON.stringify({ hasK8s: t.includes('k8s'), hasKubectl: t.includes('kubectl'), repBtns: ${JSON.stringify(repBtns)} }) })()`)
const af = JSON.parse(after)
ok('9.替换行能展开，全部替换真的改了文档', af.repBtns.length === 2 && af.hasK8s && !af.hasKubectl, af)
await evaluate(`document.querySelector('[title^="关闭 (Esc)"]')?.click()`)
await sleep(400)

/* ══ 6. 粘贴图片：走 mediaSave 并写进 Markdown ══ */
await evaluate(`(() => {
  const el = document.querySelector('.cm-content .cm-line')
  el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
})()`)
await sleep(300)
const pasted = JSON.parse(
  await evaluate(`(() => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([137,80,78,71,13,10,26,10])], 'shot.png', { type: 'image/png' }))
    const host = document.querySelector('.cm-content')
    if (!host) return JSON.stringify({ err: 'no editor' })
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    host.dispatchEvent(ev)
    return JSON.stringify({ dispatched: true })
  })()`),
)
await sleep(1200)
const pasteRes = JSON.parse(
  await evaluate(`(() => {
    const t = [...document.querySelectorAll('.cm-content .cm-line')].map(l => l.textContent).join('\\n')
    return JSON.stringify({ saved: (window.__mediaSaved || []).length, inserted: t.includes('attachments/粘贴进来的图.png') })
  })()`),
)
ok('10.粘贴图片自动存进工作区并写进 Markdown', pasted.dispatched === true && pasteRes.saved >= 1 && pasteRes.inserted, pasteRes)

/* ══ 7. 自定义图标 ══ */
await evaluate(`document.querySelector('.col-tab[data-view="notes"]')?.click()`)
await sleep(500)
/* 侧栏里右键那篇笔记 → 更换图标 */
const opened = JSON.parse(
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.tree-row, .node-row, .tree-node')]
    const el = [...document.querySelectorAll('.name')].find(e => e.textContent.trim() === '导出靶子')
    if (!el) return JSON.stringify({ err: 'no node', names: [...document.querySelectorAll('.name')].map(e => e.textContent.trim()).slice(0, 12) })
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + r.height / 2 }))
    return JSON.stringify({ ok: true, rows: rows.length })
  })()`),
)
await sleep(600)
const hasIconItem = JSON.parse(
  await evaluate(`(() => {
    const items = [...document.querySelectorAll('.n-menu-item, .ctx-item')].map(e => e.textContent.trim())
    const hit = items.find(t => t.includes('图标'))
    if (!hit) return JSON.stringify({ err: 'no icon item', items })
    return JSON.stringify({ ok: true, hit })
  })()`),
)
if (!hasIconItem.err) {
  await evaluate(`(() => {
    const it = [...document.querySelectorAll('.n-menu-item, .ctx-item')].find(e => e.textContent.includes('图标'))
    it?.click()
  })()`)
  await sleep(700)
}
const dialog = JSON.parse(
  await evaluate(`(() => {
    const d = document.querySelector('.ip')
    return JSON.stringify({ open: !!d, cells: document.querySelectorAll('.ip-cell').length, tabs: [...document.querySelectorAll('.ip-seg button')].map(b => b.textContent.trim()) })
  })()`),
)
ok('11.侧栏右键能打开图标选择器，技术栈图标是一组真实品牌图标', dialog.open && dialog.cells > 30, dialog)

/* 挑一个品牌图标（Python），断言：写到磁盘 + 侧栏画出来 + 卡片区也画出来 */
const picked = JSON.parse(
  await evaluate(`(() => {
    const cells = [...document.querySelectorAll('.ip-cell')]
    const py = cells.find(c => (c.textContent || '').includes('Python'))
    if (!py) return JSON.stringify({ err: 'no python', labels: cells.slice(0, 10).map(c => c.textContent.trim()) })
    py.click()
    return JSON.stringify({ ok: true })
  })()`),
)
await sleep(900)
const stored = JSON.parse(
  await evaluate(`(() => {
    const map = window.__icons || {}
    const vals = Object.values(map)
    return JSON.stringify({
      written: vals.length,
      val: vals[0] ?? null,
      dialogGone: !document.querySelector('.ip'),
      sidebarSvg: document.querySelectorAll('.ni-brand').length,
      cardIcon: !!document.querySelector('.nl-item .ni'),
    })
  })()`),
)
ok(
  '12.选完图标：写进 .nota/icons.json、侧栏与卡片区都画出来',
  !picked.err && stored.written >= 1 && /^brand:/.test(String(stored.val)) && stored.dialogGone && stored.sidebarSvg >= 1 && stored.cardIcon,
  { ...stored, picked },
)

/* ══ 8. AI：会话就地删除 + 模型下拉只列已配置的 ══
   AI 的入口**不在中间列的页签上** —— 页签只有 笔记/大纲/引用 三个，
   AI 是侧栏底部那枚「AI 编写」（`state.ai.enabled` 默认开着就有）。
   早先脚本点 `.col-tab[data-view="ai"]`，那个元素根本不存在，
   于是三条断言全在量空气。 */
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.nav-item')].find((b) => b.querySelector('.nav-label')?.textContent?.trim() === 'AI 编写')
  btn?.click()
})()`)
await sleep(1000)
const aiOn = JSON.parse(
  await evaluate(`JSON.stringify({ panel: !!document.querySelector('.ag-sess-pick'), view: document.querySelector('.ag-sess-pick') ? 1 : 0 })`),
)
ok('13a.侧栏「AI 编写」能进到 AI 面板', aiOn.panel, aiOn)

await evaluate(`document.querySelector('.ag-sess-pick')?.click()`)
await sleep(500)
const sess = JSON.parse(
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.ss-item')]
    return JSON.stringify({ rows: rows.length, dels: document.querySelectorAll('.ss-del').length, head: document.querySelector('.ss-menu .n-menu-head')?.textContent?.trim() || '' })
  })()`),
)
ok('13.AI 会话下拉里每一行都有就地删除按钮', sess.rows >= 2 && sess.dels === sess.rows, sess)

/* 点第一行的删除 → 出确认 → 确认后会话数 -1。
   删完再数一遍之前先确认菜单还开着：`.ss-del` 就在菜单里面，
   菜单要是被收起来，数到的 0 会被当成「删掉了两条」。 */
await evaluate(`document.querySelector('.ss-del')?.click()`)
await sleep(500)
const hadConfirm = JSON.parse(
  await evaluate(`JSON.stringify({ confirm: !!document.querySelector('.cf'), danger: !!document.querySelector('.cf-btn.cf-danger') })`),
)
await evaluate(`document.querySelector('.cf-btn.cf-danger')?.click()`)
await sleep(700)
await evaluate(`(() => { if (!document.querySelector('.ss-menu')) document.querySelector('.ag-sess-pick')?.click() })()`)
await sleep(400)
const afterDel = JSON.parse(
  await evaluate(`(() => {
    const raw = JSON.parse(localStorage.getItem('nota-chat-sessions') || '{}')
    return JSON.stringify({
      rows: document.querySelectorAll('.ss-item').length,
      stored: Array.isArray(raw.sessions) ? raw.sessions.length : -1,
      left: Array.isArray(raw.sessions) ? raw.sessions.map((s) => s.title) : [],
    })
  })()`),
)
ok(
  '14.删除会话要过确认，确认后该会话从列表里消失',
  hadConfirm.confirm && hadConfirm.danger && afterDel.rows === sess.rows - 1 && afterDel.stored === sess.rows - 1 && !afterDel.left.includes('帮我改一段开场白'),
  { before: sess.rows, ...afterDel, confirm: hadConfirm.confirm },
)

/* 模型下拉：只列 aiTest 探测到的，不摆没配置的预设。
   末尾那项「模型设置…」是固定入口不是模型，先剔掉再比。 */
await evaluate(`document.querySelector('.ag-model')?.click()`)
await sleep(900)
const models = JSON.parse(
  await evaluate(`(() => {
    const names = [...document.querySelectorAll('.m-menu .n-menu-item .n-menu-name')]
      .map((e) => e.textContent.trim())
      .filter((t) => t && !t.includes('模型设置'))
    return JSON.stringify({ names, hint: document.querySelector('.m-menu .n-menu-hint')?.textContent?.trim() || '' })
  })()`),
)
ok(
  '15.模型下拉只列探测到的模型，不出现没配置的预设',
  models.names.length === 1 && models.names[0] === 'llama3.2' && /共 1 个模型/.test(models.hint),
  models,
)

/* ══ 9. AI 联网搜索：它是个 agent，回答前先去查资料 ══
   两条一起看才算数：
     · 开关是**状态**，得看得见 —— 空态那枚「联网」胶囊跟着它走；
     · 开着发一条，得真的先检索再把来源摆在回答下面。
   只验「界面上有个开关」没意义，开关背后没检索就是个装饰。 */
await evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
await sleep(260)
/* 换个新会话把空态拿回来：上一轮删完会话后剩下的那条是有消息的 */
await evaluate(`document.querySelector('.ag-sess .ag-mini[title="新建会话"]')?.click()`)
await sleep(600)
const factsOff = JSON.parse(
  await evaluate(`JSON.stringify({
    n: document.querySelectorAll('.ag-empty .ae-fact').length,
    toggleOn: !!document.querySelector('.web-toggle.on'),
    empty: !!document.querySelector('.ag-empty'),
  })`),
)
await evaluate(`document.querySelector('.web-toggle')?.click()`)
await sleep(450)
const factsOn = JSON.parse(
  await evaluate(`JSON.stringify({
    n: document.querySelectorAll('.ag-empty .ae-fact').length,
    toggleOn: !!document.querySelector('.web-toggle.on'),
    net: [...document.querySelectorAll('.ag-empty .ae-fact-v')].some((e) => e.textContent.trim() === '联网'),
  })`),
)
ok(
  '17.联网开关是看得见的状态：开着才多一枚「联网」胶囊',
  factsOff.empty && factsOff.n === 3 && !factsOff.toggleOn && factsOn.n === 4 && factsOn.toggleOn && factsOn.net,
  { factsOff, factsOn },
)

/* 真发一条：走检索 → 出回答 → 回答下面挂着来源 */
await evaluate(`(() => {
  const box = document.querySelector('.ag .composer .input')
  if (!box) return
  box.focus()
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  set.call(box, '帮我查一下最新的资料')
  box.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(350)
await evaluate(`document.querySelector('.ag .composer .send')?.click()`)
await sleep(3500)
const web = JSON.parse(
  await evaluate(`JSON.stringify({
    searched: window.__searched || [],
    srcBlocks: document.querySelectorAll('.ag .srcs').length,
    srcHead: document.querySelector('.ag .srcs .srcs-h')?.textContent?.trim() || '',
    links: [...document.querySelectorAll('.ag .srcs a.src')].map((a) => a.getAttribute('href') || ''),
    assistantRows: document.querySelectorAll('.ag .row.assistant').length,
  })`),
)
ok(
  '18.联网开着时先检索再回答，来源摆在回答下面（能点开）',
  web.searched.length >= 1 &&
    web.searched.some((q) => String(q).includes('查一下最新的资料')) &&
    web.srcBlocks >= 1 &&
    /联网来源 2 条/.test(web.srcHead) &&
    web.links.length === 2 &&
    web.links.every((u) => /^https?:\/\//.test(u)),
  web,
)

// console 报错也要算失败
const realErrors = errors.filter((e) => !/favicon|ResizeObserver loop/i.test(e))
ok('16.全程零 JS 异常', realErrors.length === 0, realErrors.slice(0, 4))

const failed = results.filter((r) => !r.pass)
console.log(`\nround15: ${results.length - failed.length}/${results.length} 通过`)
if (failed.length) console.log('失败：', failed.map((f) => f.name).join(' / '))
await close()
process.exit(failed.length ? 1 : 0)
