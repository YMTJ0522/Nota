/**
 * 2.1.0 验证：工具栏补足（图表 / 提示块两组下拉）、侧栏瘦身与右键菜单、
 * 附件库与回收站的多选、历史版本改成「自动保存也留快照」、
 * 关于页重做、服务商预设下拉不再拉成一条、代码块选中整行、
 * 以及大纲 / 引用两个页签能正常用。
 *
 * 跑法：node scripts/verify-round10.mjs
 *
 * 覆盖：
 *  1. 工具栏「图表」下拉：11 种，点「折线图」真的写出 mermaid 围栏
 *  2. 工具栏「提示块」下拉：11 种，点「警告」写出 > [!WARNING]
 *  3. 工具栏十组下拉每一组都能展开且有菜单项（不是空壳）
 *  4. 侧栏顶部只留「收起」；新建入口挪进分区头，加号放大到 26px / 图标 15px
 *  5. 文件夹右键菜单 6 项、标签右键菜单 4 项
 *  6. 附件库：导入按钮真的收进文件；多选后出底栏；卡片右键出菜单
 *  7. 回收站：多选后出底栏（恢复所选 / 彻底删除所选）
 *  8. 笔记列表：头部有「导入笔记」；卡片上有独立收藏按钮
 *  9. 历史版本：自动保存也写快照，手动保存立刻再写一个，换笔记列表跟着换
 * 10. 关于页新结构（hero / 四张特性卡 / 环境四格 / 快捷键 / 页脚）
 * 11. 服务商预设下拉不再撑满（宽度 ≤ 240）
 * 12. 代码块选中是完整整行（选区底色与行的 padding box 重合）
 * 13. 大纲 / 引用两个页签都出内容
 * 16. AI 面板顶部那两块下拉不再被面板的 overflow 裁掉
 * 17. 侧栏底部的工作区选择器：切文件夹 / 添加文件夹
 * 18. 写作模式的行号跟顶栏搜索按钮落在同一条竖线上
 * 19. 全程零 JS 异常
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr, navExpr } from './fake-workspace.mjs'

const FENCE = String.fromCharCode(96).repeat(3)

const { send, evaluate, sleep, errors, close } = await launch({ port: 4355, size: [1500, 1000] })

const out = {}
const ok = (name, cond, detail) => {
  out[name] = { pass: !!cond, detail }
  console.log(cond ? '  PASS  ' : '  FAIL  ', name, detail !== undefined ? JSON.stringify(detail) : '')
}

const INJECT = makeInject()
const PORT = 4355

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1600)
await evaluate(
  `localStorage.clear(); localStorage.setItem('nota-ai', ${JSON.stringify(
    JSON.stringify({ enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'llama3.2', temperature: 0.7, systemPrompt: '' }),
  )}); localStorage.setItem('nota-roots', ${JSON.stringify(JSON.stringify(['/ws', '/tmp/另一个库']))})`,
)
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(2000)
await evaluate(INJECT)
await evaluate("document.querySelector('.cta')?.click()")
await sleep(1200)
await evaluate(INJECT)
await sleep(800)

/* ══ 1 + 2. 工具栏新加的两组下拉 ══ */
await evaluate(navExpr('所有笔记'))
await sleep(600)
await evaluate(openNoteExpr('甲笔记'))
await sleep(1100)

const menus = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const btn = (t) => [...document.querySelectorAll('.tb-btn')].find(b => (b.getAttribute('title') ?? '').includes(t))
  const doc = () => (window.__notaView?.state.doc.toString() ?? '')

  const hasChart = !!btn('插入图表')
  const hasCallout = !!btn('提示块')
  btn('插入图表')?.click()
  await wait(300)
  const chartMenu = document.querySelector('.tb-scroll-menu')
  const chartRows = [...document.querySelectorAll('.tb-scroll-menu .tb-item')].map(b => ({
    label: b.querySelector('span')?.textContent?.trim(),
    hint: b.querySelector('.tag')?.textContent?.trim(),
  }))
  // 点「折线图」
  const line = [...document.querySelectorAll('.tb-scroll-menu .tb-item')].find(b => (b.textContent ?? '').includes('折线图'))
  line?.click()
  await wait(400)
  const afterChart = doc()

  btn('提示块')?.click()
  await wait(300)
  const calloutRows = [...document.querySelectorAll('.tb-scroll-menu .tb-item')].map(b => ({
    label: b.querySelector('.tb-dot-row')?.textContent?.trim(),
    kbd: b.querySelector('.kbd')?.textContent?.trim(),
  }))
  const dots = document.querySelectorAll('.tb-scroll-menu .tb-dot').length
  const warn = [...document.querySelectorAll('.tb-scroll-menu .tb-item')].find(b => (b.textContent ?? '').includes('警告'))
  warn?.click()
  await wait(400)
  const afterCallout = doc()

  return { hasChart, hasCallout, chartMenu: !!chartMenu, chartRows, afterChart, calloutRows, dots, afterCallout }
})()`)

const CHART_LABELS = ['折线图', '柱状图', '饼图', '流程图', '时序图', '类图', '状态图', '甘特图', '思维导图', '实体关系图', 'Git 提交图']
const gotCharts = menus.chartRows.map((r) => r.label)
ok(
  '1.工具栏「图表」下拉 11 种，点折线图真的写出 mermaid 围栏',
  menus.hasChart && menus.chartMenu && gotCharts.length === 11 &&
    CHART_LABELS.every((l) => gotCharts.includes(l)) &&
    menus.afterChart.includes(FENCE + 'mermaid') && menus.afterChart.includes('xychart'),
  { labels: gotCharts, hints: menus.chartRows.map((r) => r.hint).slice(0, 3), doc: menus.afterChart.slice(-60) },
)

const CALLOUT_KEYS = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION', 'DANGER', 'SUCCESS', 'QUESTION', 'EXAMPLE', 'QUOTE', 'INFO']
const gotKeys = menus.calloutRows.map((r) => (r.kbd ?? '').replace(/\[!|\]/g, ''))
ok(
  '2.工具栏「提示块」下拉 11 种（带色点），点警告写出 > [!WARNING]',
  menus.hasCallout && gotKeys.length === 11 && CALLOUT_KEYS.every((k) => gotKeys.includes(k)) &&
    menus.dots === 11 && menus.afterCallout.includes('> [!WARNING]'),
  { keys: gotKeys, dots: menus.dots, doc: menus.afterCallout.slice(-60) },
)

/* ══ 3. 十组下拉都不是空壳 ══
   早期版本有几组只有按钮没有菜单项，点下去什么也不做；这里逐个展开数一遍。 */
const groups = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const wraps = [...document.querySelectorAll('.tb-menu-wrap')]
  const res = []
  for (const w of wraps) {
    const b = w.querySelector('.tb-btn')
    b?.click()
    await wait(220)
    // 表格那一组是 8×8 网格，不是一排菜单项，两种都要认
    const items = document.querySelectorAll('body > .tb-menu .tb-item').length +
      document.querySelectorAll('body > .tb-menu .tb-grid-cell').length
    const title = b?.getAttribute('title') ?? ''
    res.push({ title, items })
    // 收掉：点文档空白处（工具栏菜单是 pointerdown 收的）
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await wait(160)
  }
  return { count: wraps.length, res, plain: document.querySelectorAll('.tb-group > .tb-btn').length }
})()`)
ok(
  '3.工具栏十组下拉全部有内容，直接按钮也都在（不是空壳）',
  groups.count === 10 && groups.res.every((g) => g.items >= 2) && groups.plain >= 10,
  { groups: groups.res.map((g) => `${g.title}:${g.items}`), plain: groups.plain },
)

/* ══ 4. 侧栏：两枚收起按钮并排；分区加号放大 ══
   2.2 把「收起资料栏」从编辑区顶栏搬到了这儿 —— 它跟窗口按钮挤在一起
   既不像视图也不像窗口，而「哪一块要腾地方」本来是一道连续的判断题。 */
const side = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const head = [...document.querySelectorAll('.panel .head-actions .mini')].map(b => b.getAttribute('data-tip') ?? b.getAttribute('title'))
  const roles = [...document.querySelectorAll('.panel .head-actions .mini')].map(b => b.getAttribute('data-role'))
  const add = document.querySelector('.panel .sec-add')
  const r = add?.getBoundingClientRect()
  const svg = add?.querySelector('svg')?.getBoundingClientRect()
  const btn = document.querySelector('.panel .mini')?.getBoundingClientRect()
  const boxes = [...document.querySelectorAll('.panel .head-actions .mini')].map(b => {
    const q = b.getBoundingClientRect(); return [Math.round(q.left), Math.round(q.width)]
  })
  return {
    head, roles,
    // 两枚按钮得是并排的：间距就是它们自己的宽度（±几像素的 gap），不是叠在一起
    sideBySide: boxes.length === 2 && boxes[0][1] === 26 &&
      boxes[1][0] - boxes[0][0] >= 26 && boxes[1][0] - boxes[0][0] <= 30,
    addW: r ? Math.round(r.width) : 0,
    addH: r ? Math.round(r.height) : 0,
    svgW: svg ? Math.round(svg.width) : 0,
    headBtnW: btn ? Math.round(btn.width) : 0,
    opacity: add ? getComputedStyle(add).opacity : '0',
  }
})()`)
ok(
  '4.侧栏顶部并排两枚收起按钮（资料栏 / 侧边栏）；分区加号 26px / 图标 15px 且常显',
  side.roles.includes('column-toggle') && side.roles.includes('sidebar-toggle') &&
    side.head.some((t) => (t ?? '').includes('资料栏')) &&
    side.head.some((t) => (t ?? '').includes('侧边栏')) &&
    side.sideBySide &&
    side.addW === 26 && side.addH === 26 && side.svgW === 15 && Number(side.opacity) === 1,
  side,
)

/* ══ 5. 文件夹 / 标签右键菜单 ══ */
const ctx2 = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const fire = (el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 8 })) }
  const texts = () => [...document.querySelectorAll('.ctx-menu .ctx-item')].map(b => (b.querySelector('.ctx-label')?.textContent ?? b.textContent).trim())

  const dir = [...document.querySelectorAll('.panel .tree .row.dir')].find(b => (b.textContent ?? '').includes('读书'))
  fire(dir)
  await wait(320)
  const folder = texts()
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await wait(260)

  const tag = [...document.querySelectorAll('.panel .tag')].find(b => (b.textContent ?? '').trim().startsWith('示例'))
  fire(tag)
  await wait(320)
  const tags = texts()
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await wait(200)
  return { folder, tags, dirFound: !!dir, tagFound: !!tag }
})()`)
// 2.2.6 加了「更换图标…」（紧跟「重命名」）
const FOLDER_EXPECT = ['在此新建笔记', '在此新建子文件夹', '重命名', '更换图标', '复制路径', '在系统打开', '删除文件夹']
ok(
  '5.文件夹右键 7 项（含删除文件夹）',
  ctx2.dirFound && ctx2.folder.length === 7 &&
    FOLDER_EXPECT.every((t) => ctx2.folder.some((g) => g.includes(t))) &&
    ctx2.folder.some((t) => t.includes('删除')),
  ctx2.folder,
)
ok(
  '5b.标签右键 4 项（筛选 / 复制 / 重命名 / 删除）',
  ctx2.tagFound && ctx2.tags.length === 4 &&
    ctx2.tags.some((t) => t.includes('复制')) && ctx2.tags.some((t) => t.includes('重命名')) &&
    ctx2.tags.some((t) => t.includes('删除')),
  ctx2.tags,
)

/* ══ 6. 附件库：导入 + 多选（显式模式） ══
   2.2 之前每张卡片角上都挂着一个空方块，不挑东西的时候整片素材看着像待办清单；
   批量按钮还钉在窗口最底边。现在两样都收进「多选」模式里。 */
await evaluate(navExpr('附件库'))
await sleep(900)
const attach = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const idle = {
    checks: document.querySelectorAll('.av-check').length,
    bar: !!document.querySelector('.av-bar'),
    foot: !!document.querySelector('.av-foot'),
  }
  const before = document.querySelectorAll('.av-card').length
  document.querySelector('.pn-x[data-tip="导入附件"]')?.click()
  await wait(700)
  const names = [...document.querySelectorAll('.av-name')].map(e => e.textContent.trim())
  const afterImport = document.querySelectorAll('.av-card').length

  // 进多选模式
  document.querySelector('.pn-x[data-tip="多选"]')?.click()
  await wait(400)
  const barEl = document.querySelector('.av-bar')
  const pick = (el) => {
    const kids = [...el.children].filter(e => e.getBoundingClientRect().width > 0)
    const btns = [...el.querySelectorAll('.pn-btn')]
    const bar = el.getBoundingClientRect()
    return {
      acts: [...el.querySelectorAll('button')].map(b => b.dataset.act ?? ''),
      // 「是不是同一行」要看中线，不能看 top：工具条里本来就混着高矮不同的东西
      // （全选是链接样式、中间还有一个弹性撑条），比 top 会把正常情况误判成折行。
      lines: new Set(kids.map((e) => {
        const r = e.getBoundingClientRect()
        return Math.round((r.top + r.bottom) / 8)
      })).size,
      clipped: kids.some((e) => {
        const r = e.getBoundingClientRect()
        return r.right > bar.right + 1 || r.left < bar.left - 1
      }),
      heights: btns.map(b => Math.round(b.getBoundingClientRect().height)),
      overflow: btns.map(b => b.scrollWidth - b.clientWidth),
    }
  }
  const picking = {
    bar: !!barEl,
    checks: document.querySelectorAll('.av-check').length,
    ...pick(barEl),
  }
  // 压到资料栏自适应的下限附近再看一次：宁可整齐折行，也不许把按钮捏扁
  const prevW = barEl.style.width
  barEl.style.width = '232px'
  await wait(80)
  const narrow = pick(barEl)
  barEl.style.width = prevW
  await wait(60)
  // 点卡片本体就勾上
  document.querySelectorAll('.av-card')[0]?.click()
  await wait(200)
  document.querySelectorAll('.av-card')[1]?.click()
  await wait(280)
  const picked = {
    on: document.querySelectorAll('.av-card.on').length,
    n: document.querySelector('.av .pn-sub')?.textContent?.trim() ?? '',
  }
  // 退出：勾选框和工具条都该消失
  document.querySelector('.av-bar button[data-act="done"]')?.click()
  await wait(360)
  const exited = {
    bar: !!document.querySelector('.av-bar'),
    checks: document.querySelectorAll('.av-check').length,
    on: document.querySelectorAll('.av-card.on').length,
  }
  return { idle, before, afterImport, names, picking, narrow, picked, exited }
})()`)
ok(
  '6.附件库：默认没有勾选框也没有底部按钮条；进多选才出勾选框，工具条在顶部；窄到 232px 也不变形，退出后收干净',
  attach.idle.checks === 0 && !attach.idle.bar && !attach.idle.foot &&
    attach.afterImport === attach.before + 1 && attach.names.includes('新导入的资料.zip') &&
    attach.picking.bar && attach.picking.checks === attach.afterImport &&
    attach.picking.acts.join(',') === 'all,insert,delete,done' &&
    attach.picking.lines === 1 && !attach.picking.clipped &&
    attach.picking.heights.every((h) => h >= 22 && h <= 26) &&
    attach.narrow.heights.every((h) => h >= 22 && h <= 26) &&
    !attach.narrow.clipped && attach.narrow.lines <= 2 &&
    attach.picking.overflow.every((d) => d <= 1) &&
    attach.narrow.overflow.every((d) => d <= 1) &&
    attach.picked.on === 2 && attach.picked.n.startsWith('已选 2') &&
    !attach.exited.bar && attach.exited.checks === 0 && attach.exited.on === 0,
  attach,
)

/* ══ 7. 回收站多选（同样是显式模式） ══ */
await evaluate(navExpr('回收站'))
await sleep(900)
const trash = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const idle = { checks: document.querySelectorAll('.tv-check').length, bar: !!document.querySelector('.tv-bar') }
  const rows = document.querySelectorAll('.tv .pn-row').length
  document.querySelector('.pn-x[data-tip="多选"]')?.click()
  await wait(380)
  const barEl = document.querySelector('.tv-bar')
  const pick = (el) => {
    const kids = [...el.children].filter(e => e.getBoundingClientRect().width > 0)
    const btns = [...el.querySelectorAll('.pn-btn')]
    const bar = el.getBoundingClientRect()
    return {
      acts: [...el.querySelectorAll('button')].map(b => b.dataset.act ?? ''),
      // 「是不是同一行」要看中线，不能看 top：工具条里本来就混着高矮不同的东西
      // （全选是链接样式、中间还有一个弹性撑条），比 top 会把正常情况误判成折行。
      lines: new Set(kids.map((e) => {
        const r = e.getBoundingClientRect()
        return Math.round((r.top + r.bottom) / 8)
      })).size,
      clipped: kids.some((e) => {
        const r = e.getBoundingClientRect()
        return r.right > bar.right + 1 || r.left < bar.left - 1
      }),
      heights: btns.map(b => Math.round(b.getBoundingClientRect().height)),
      overflow: btns.map(b => b.scrollWidth - b.clientWidth),
    }
  }
  const picking = {
    bar: !!barEl,
    checks: document.querySelectorAll('.tv-check').length,
    ...pick(barEl),
  }
  const prevW = barEl.style.width
  barEl.style.width = '232px'
  await wait(80)
  const narrow = pick(barEl)
  barEl.style.width = prevW
  await wait(60)
  document.querySelectorAll('.tv .pn-row')[0]?.click()
  await wait(240)
  const one = { on: document.querySelectorAll('.pn-row.on').length, n: document.querySelector('.tv .pn-sub')?.textContent?.trim() ?? '' }
  // 全选
  document.querySelector('.tv-bar button[data-act="all"]')?.click()
  await wait(300)
  const all = { on: document.querySelectorAll('.pn-row.on').length, n: document.querySelector('.tv .pn-sub')?.textContent?.trim() ?? '' }
  document.querySelector('.tv-bar button[data-act="done"]')?.click()
  await wait(320)
  return { idle, rows, picking, narrow, one, all, exited: { bar: !!document.querySelector('.tv-bar'), checks: document.querySelectorAll('.tv-check').length } }
})()`)
ok(
  '7.回收站：默认干净；进多选后可点行勾选、可全选；批量按钮在顶部且窄到 232px 不变形，退出收干净',
  trash.idle.checks === 0 && !trash.idle.bar && trash.rows === 2 &&
    trash.picking.bar && trash.picking.checks === trash.rows &&
    trash.picking.acts.join(',') === 'all,restore,purge,done' &&
    trash.picking.lines === 1 && !trash.picking.clipped &&
    trash.picking.heights.every((h) => h >= 22 && h <= 26) &&
    trash.narrow.heights.every((h) => h >= 22 && h <= 26) &&
    !trash.narrow.clipped && trash.narrow.lines <= 2 &&
    trash.picking.overflow.every((d) => d <= 1) &&
    trash.narrow.overflow.every((d) => d <= 1) &&
    trash.one.on === 1 && trash.one.n.startsWith('已选 1') &&
    trash.all.on === trash.rows && trash.all.n.startsWith(`已选 ${trash.rows}`) &&
    !trash.exited.bar && trash.exited.checks === 0,
  trash,
)

/* ══ 8. 笔记列表：导入笔记 + 收藏按钮 ══ */
await evaluate(navExpr('所有笔记'))
await sleep(700)
const list = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  // 2.2.3：新建 / 导入住资料栏右上角（.col-flow 里），编辑区顶行只留导出与版本历史
  const tips = [...document.querySelectorAll('.col-flow .col-act')].map(b => b.getAttribute('title'))
  const editorTips = [...document.querySelectorAll('.ph-right .ea-btn')].map(b => b.getAttribute('title'))
  // 收藏：找一张没被收藏的卡片
  const card = [...document.querySelectorAll('.nlist .nl-item')].find(c => !c.querySelector('.nl-star-btn.on'))
  const name = card?.querySelector('.nl-text')?.textContent?.trim() ?? ''
  card?.querySelector('.nl-star-btn')?.click()
  await wait(600)
  // 收藏记在 frontmatter 里，所以直接看落盘内容：
  // 假 IPC 的 readTree 是静态的，界面上的星标不会因为收藏就亮起来，
  // 拿界面断言只会测到假数据的形状。
  const disk = window.__notes['/ws/' + name + '.md'] ?? ''
  return {
    tips,
    editorTips,
    name,
    hasBtn: !!card?.querySelector('.nl-star-btn'),
    onDisk: disk.slice(0, 60),
    // 注意：\\s —— 这段是模板字符串里的正则，写 \s 会被当成转义的 s
    starred: /star:\\s*true/i.test(disk),
  }
})()`)
ok(
  '8.新建/导入住资料栏右上角（编辑区顶行不再重复这两件事），卡片上有独立收藏按钮且点了真的写进 frontmatter',
  list.tips.some((t) => (t ?? '').includes('导入')) && list.tips.some((t) => (t ?? '').includes('新建')) &&
    !list.editorTips.some((t) => (t ?? '').includes('导入')) &&
    !list.editorTips.some((t) => (t ?? '').includes('新建')) &&
    list.hasBtn && list.starred,
  list,
)

/* ══ 9. 历史版本：自动保存也留快照 ══ */
const hist = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const v = window.__notaView
  // 改一笔，等自动保存
  const at = v.state.doc.length
  v.dispatch({ changes: { from: at, to: at, insert: '\\n\\n自动保存留痕。' }, selection: { anchor: at + 2 } })
  await wait(1800)
  const afterAuto = (window.__histSaved ?? []).length

  // 再改一笔，立刻手动保存（Ctrl+S）：内容变了，该多一个快照
  const at2 = v.state.doc.length
  v.dispatch({ changes: { from: at2, to: at2, insert: '\\n手动保存留痕。' }, selection: { anchor: at2 + 2 } })
  await wait(120)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
  await wait(1000)
  const afterManual = (window.__histSaved ?? []).length
  // 同一个内容再存一次不该刷出新快照（否则历史里全是重复）
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
  await wait(800)
  const afterAgain = (window.__histSaved ?? []).length
  return { afterAuto, afterManual, afterAgain, files: Object.keys(window.__hist ?? {}) }
})()`)
ok(
  '9.历史版本：自动保存也写快照，内容再变时手动保存立刻补一个，重复保存不刷屏',
  hist.afterAuto >= 1 && hist.afterManual > hist.afterAuto &&
    hist.afterAgain === hist.afterManual && hist.files.length >= 1,
  hist,
)

const histPanel = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  // 版本历史抽屉：从编辑区顶栏的「历史」按钮打开
  const btn = [...document.querySelectorAll('.ph-icon, .ea-btn, button')].find(b => (b.getAttribute('title') ?? b.getAttribute('data-tip') ?? '').includes('历史'))
  btn?.click()
  await wait(800)
  const rows = document.querySelectorAll('.hp-row').length
  const title = document.querySelector('.hp-title')?.textContent?.trim() ?? ''
  const sub = document.querySelector('.hp-sub')?.textContent?.trim() ?? ''
  document.querySelector('.hp-x')?.click()
  await wait(300)
  return { opened: rows > 0 || !!document.querySelector('.hp'), rows, title, sub }
})()`)
ok(
  '9b.版本历史抽屉能打开并列出快照（标题带当前笔记名）',
  histPanel.rows >= 1 && histPanel.title === '版本历史' && histPanel.sub.length > 0,
  histPanel,
)

/* ══ 10. 关于页 ══ */
await evaluate(
  `window.dispatchEvent(new CustomEvent('nota:settings', { detail: 'about' }))`,
)
await sleep(900)
const about = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const cards = [...document.querySelectorAll('.ab-card')].map(c => ({
    t: c.querySelector('.ab-card-title')?.textContent?.trim(),
    d: (c.querySelector('.ab-card-desc')?.textContent?.trim() ?? '').slice(0, 12),
    ico: !!c.querySelector('.ab-card-ico svg'),
  }))
  const env = [...document.querySelectorAll('.ab-env-cell')].map(c => c.querySelector('.ab-env-k')?.textContent?.trim())
  const keys = [...document.querySelectorAll('.ab-keys .ab-key, .ab-keys li, .ab-keys > *')].length
  return {
    hero: !!q('.ab-hero'),
    glow: !!q('.ab-hero-glow'),
    mark: !!q('.ab-mark svg'),
    tag: q('.ab-hero-tag')?.textContent?.trim() ?? '',
    ver: q('.ab-hero-ver')?.textContent?.trim() ?? '',
    dot: !!q('.ab-dot'),
    note: q('.ab-hero-note')?.textContent?.trim() ?? '',
    lead: (q('.ab-lead')?.textContent?.trim() ?? '').slice(0, 14),
    cards,
    env,
    keys,
    foot: q('.ab-foot')?.textContent?.trim() ?? '',
  }
})()`)
ok(
  '10.关于页：hero + 四张特性卡 + 环境四格 + 快捷键 + 页脚',
  about.hero && about.glow && about.mark && about.tag === '本地优先' &&
    about.ver.includes('2.') && about.dot && about.lead.length > 0 &&
    about.cards.length === 4 && about.cards.every((c) => c.ico && c.t && c.d) &&
    about.env.length === 4 && about.keys >= 4 && about.foot.includes('YMTJ0522'),
  about,
)

/* ══ 11. 服务商预设下拉不再撑满 ══ */
await evaluate(
  `window.dispatchEvent(new CustomEvent('nota:settings', { detail: 'ai' }))`,
)
await sleep(700)
const preset = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const btn = document.querySelector('.st-drop .n-select.st-select')
  btn?.click()
  await wait(320)
  const m = document.querySelector('.st-drop-menu')
  const r = m?.getBoundingClientRect()
  const rows = [...(m?.querySelectorAll('.n-menu-item') ?? [])].map(x => x.textContent.trim().slice(0, 8))
  const cs = m ? getComputedStyle(m) : null
  const btnBox = btn?.getBoundingClientRect()
  return {
    opened: !!m,
    w: r ? Math.round(r.width) : 0,
    // 右对齐到按钮：菜单右边与按钮右边齐平，不是飘到视口另一头
    dx: r && btnBox ? Math.round(r.right - btnBox.right) : null,
    rows,
    pos: cs?.position,
    overflow: cs?.overflowY,
    hasOllama: rows.some(x => x.includes('Ollama')),
  }
})()`)
ok(
  '11.服务商预设下拉：贴着按钮、宽度 ≤ 240、可滚动，不是撑满视口的一条',
  preset.opened && preset.w > 0 && preset.w <= 240 && preset.pos === 'absolute' &&
    Math.abs(preset.dx ?? 999) <= 2 && preset.overflow === 'auto' &&
    preset.rows.length >= 5 && preset.hasOllama,
  preset,
)

/* ══ 12. 代码块选中整行 ══ */
await evaluate(`document.querySelector('.st-x, .st-mask')?.click()`)
await sleep(400)
await evaluate(navExpr('所有笔记'))
await sleep(500)
await evaluate(openNoteExpr('代码示例'))
await sleep(1100)
const sel = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const v = window.__notaView
  const text = v.state.doc.toString()
  // 整行选中（含行尾换行），这才是「选中一行」时用户看到的情形
  const ln = v.state.doc.lineAt(text.indexOf('def hello'))
  v.dispatch({ selection: { anchor: ln.from, head: ln.to + 1 } })
  await wait(400)
  const bg = document.querySelector('.cm-selectionBackground')
  const line = [...document.querySelectorAll('.cm-line')].find(l => (l.textContent ?? '').includes('def hello'))
  if (!bg || !line) return { noEl: true, bg: !!bg, line: !!line }
  const b = bg.getBoundingClientRect()
  const l = line.getBoundingClientRect()
  // 底色画在 ::before 上，左右各让出 .cm-line 的 18px 内边距；
  // 选区矩形按文本列画 —— 两者应该严丝合缝
  const pb = getComputedStyle(line, '::before')
  return {
    leftGap: Math.round(b.left - l.left),
    rightGap: Math.round(l.right - b.right),
    selW: Math.round(b.width),
    beforeW: parseInt(pb.width, 10),
    padL: getComputedStyle(line).paddingLeft,
  }
})()`)
ok(
  // 左右各留 18px 内边距是对的：那是 .cm-line 的padding，
  // 也是 ::before 让出的量。判据是「选区宽度 == 底色宽度」。
  '12.代码块里整行选中：选区与代码块底色严丝合缝（不再露边）',
  !sel.noEl && sel.selW === sel.beforeW && sel.leftGap === 18 && sel.rightGap === 18,
  sel,
)

/* ══ 13. 大纲 / 引用 ══ */
const tabs = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const labels = [...document.querySelectorAll('.col-tab-label')].map(e => e.textContent.trim())
  document.querySelector('.col-tab[data-view="outline"]')?.click()
  await wait(600)
  const outline = [...document.querySelectorAll('.ov .ov-item')].map(b => b.querySelector('.ov-text')?.textContent?.trim())
  document.querySelector('.col-tab[data-view="quote"]')?.click()
  await wait(600)
  const quote = {
    root: !!document.querySelector('.qv'),
    rows: document.querySelectorAll('.qv .qv-row, .qv .qv-item').length,
    empty: document.querySelector('.qv')?.textContent?.trim().slice(0, 20) ?? '',
  }
  document.querySelector('.col-tab[data-view="notes"]')?.click()
  await wait(300)
  return { labels, outline, quote }
})()`)
ok(
  '13.中间栏三个页签齐全，大纲出标题、引用视图能打开',
  tabs.labels.includes('笔记') && tabs.labels.includes('大纲') && tabs.labels.includes('引用') &&
    tabs.outline.length >= 1 && tabs.quote.root,
  tabs,
)

/* ══ 14. 深浅色切换按钮：回到窗口按钮旁边，点一下真的换主题 ══
   1.9 之前它在旧的全局标题栏里，2.0 重划顶部时弄丢了；
   2.2 补回来，位置就贴着窗口按钮 —— 它管的是整个窗口，不是这篇文档。 */
const theme = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const btn = document.querySelector('[data-role="theme-toggle"]')
  const wctl = document.querySelector('.wctl')
  const b = btn?.getBoundingClientRect()
  const w = wctl?.getBoundingClientRect()
  const before = document.documentElement.dataset.theme
  btn?.click()
  await wait(700)
  const after = document.documentElement.dataset.theme
  btn?.click()
  await wait(700)
  return {
    found: !!btn,
    // 就在窗口按钮左边那一格：不越过它，间距不超过一个图标位，且同一条水平线
    adjacent: b && w
      ? b.right <= w.left && w.left - b.right <= 28 && Math.abs((b.top + b.bottom) / 2 - (w.top + w.bottom) / 2) <= 4
      : false,
    gap: b && w ? Math.round(w.left - b.right) : -1,
    before, after,
    back: document.documentElement.dataset.theme,
    tip: btn?.getAttribute('title') ?? '',
  }
})()`)
ok(
  '14.深浅色切换按钮回到窗口控制按钮旁边，点一下真的换主题（再点回来）',
  theme.found && theme.adjacent && theme.before !== theme.after && theme.back === theme.before,
  theme,
)

/* ══ 15. AI 面板：顶部合成一块面板；模型下拉能完整展开 ══ */
await evaluate(navExpr('AI 编写'))
await sleep(1000)
const aiPanel = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const head = q('.ag-head')
  const rows = [...(head?.children ?? [])].map(c => c.className)
  const col = q('.col')?.getBoundingClientRect()
  // 中间那一列的默认宽度应该是「自适应」算出来的，不是写死的 296
  const colAuto = col ? Math.round(col.width) : 0
  // 模型下拉：打开后得是个正常高度的菜单，且完全落在窗口里
  q('.ag-model')?.click()
  await wait(450)
  const m = q('.m-menu')
  const r = m?.getBoundingClientRect()
  const menu = r
    ? { h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), items: document.querySelectorAll('.m-menu .n-menu-item').length }
    : null
  const composer = q('.composer')?.getBoundingClientRect()
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await wait(200)
  return {
    headOk: !!head, rows, colAuto, menu,
    // 输入框居中限宽：在它所在的那一栏里，左右留白应该对称
    composer: composer && col
      ? {
          w: Math.round(composer.width),
          left: Math.round(composer.left - col.left),
          right: Math.round(col.right - composer.right),
        }
      : null,
  }
})()`)
ok(
  '15.AI 面板：顶部是一块三行的设定面板；模型下拉能完整展开且不出窗口',
  aiPanel.headOk && aiPanel.rows.length === 3 &&
    aiPanel.rows[0].includes('ag-row-top') && aiPanel.rows[1].includes('ag-sess') && aiPanel.rows[2].includes('ag-note') &&
    aiPanel.colAuto > 300 &&
    // items 从 >=3 降到 >=2：2.2.6 起模型下拉只列真正探测到的模型，
    // 不再摆一堆没配过密钥的预设 —— 假接口只回了一个 llama3.2，
    // 加上末尾固定的「模型设置…」就是 2 项，这是对的。
    aiPanel.menu && aiPanel.menu.h > 120 && aiPanel.menu.items >= 2 &&
    aiPanel.menu.top >= 0 && aiPanel.menu.bottom <= 1000 &&
    aiPanel.composer && Math.abs(aiPanel.composer.left - aiPanel.composer.right) <= 2,
  aiPanel,
)

/* ══ 16. 顶部那两块下拉不再被面板裁掉 ══
   2.2 把三行合成一块 .ag-head 时，顺手写了 overflow:hidden 去收那圈圆角，
   结果住在这块面板里的「会话」「处理哪一篇」两个下拉被整块剪掉 ——
   点开只剩一个表头（用户截图报的就是这个）。
   这里不能只看盒子的尺寸：被裁不影响 getBoundingClientRect，
   得用 elementFromPoint 打在菜单项中心，看真的能不能落到它自己身上。 */
const clip = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el))
  }
  const head = q('.ag-head')
  const overflow = head ? getComputedStyle(head).overflow : ''
  q('.ag-sess-pick')?.click()
  await wait(450)
  const items = [...(q('.ss-menu')?.querySelectorAll('.n-menu-item') ?? [])]
  const sess = { items: items.length, shown: items.length > 0 && items.every(visible) }
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await wait(300)
  q('.ag-pick')?.click()
  await wait(450)
  const nitems = [...(q('.np-menu')?.querySelectorAll('.n-menu-item') ?? [])]
  const note = { items: nitems.length, shown: nitems.length > 0 && nitems.every(visible) }
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await wait(300)
  return { overflow, sess, note }
})()`)
ok(
  '16.AI 面板顶部那两块下拉点开是真看得见的（不再被面板的 overflow 裁掉）',
  !/hidden/.test(clip.overflow ?? 'hidden') && clip.sess.items > 0 && clip.sess.shown && clip.note.shown,
  clip,
)

/* ══ 17. 侧栏底部的工作区选择器 ══ */
const roots = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const btn = q('.foot-pick .fp-btn')
  const before = q('.fp-name')?.textContent ?? ''
  btn?.click()
  await wait(450)
  const m = q('.fp-menu')
  const r = m?.getBoundingClientRect()
  const bt = btn?.getBoundingClientRect()
  const items = [...(m?.querySelectorAll('.n-menu-item') ?? [])].map(i => ({
    t: i.querySelector('.n-menu-name')?.textContent ?? '',
    on: i.classList.contains('on'),
  }))
  const inWin = r ? r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth : false
  // 底栏贴着窗口下沿，菜单必须往上开
  const opensUp = r && bt ? r.bottom <= bt.top + 1 : false
  ;[...document.querySelectorAll('.fp-menu .n-menu-item')]
    .find(i => (i.querySelector('.n-menu-name')?.textContent ?? '') === '另一个库')?.click()
  await wait(700)
  return {
    before, after: q('.fp-name')?.textContent ?? '', items, inWin, opensUp,
    menuClosed: !q('.fp-menu'),
    stored: localStorage.getItem('nota-roots') ?? '',
  }
})()`)
ok(
  '17.侧栏底部能切文件夹：最近打开过的都在下拉里，点一下真的换过去（还有「添加文件夹…」）',
  roots.before === 'ws' && roots.after === '另一个库' &&
    roots.items.some(i => i.t === '另一个库') &&
    roots.items.some(i => i.t === '添加文件夹…') &&
    roots.items.filter(i => i.on).length === 1 &&
    roots.inWin && roots.opensUp && roots.menuClosed &&
    roots.stored.includes('另一个库'),
  roots,
)

/* ══ 18. 写作模式的行号紧贴左边框 ══
   判据不写死像素：行号那一格是右对齐的，量盒子说明不了什么，
   得量「字形」落在离编辑区左边多远，再跟顶栏那枚搜索按钮里的图标比。
   以前是 12px + 28px，数字飘到 36px 开外，看着像多出来一栏。 */
await evaluate(navExpr('所有笔记'))
await sleep(500)
await evaluate(openNoteExpr('甲笔记'))
await sleep(1000)
const gutter = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  /* 先滚回顶部：代码视图只渲染视口里的那几行，量到的可能是第 99 行。
     而且 gutter 的 DOM 顺序不等于视觉顺序（复用节点会打乱），
     所以按「最靠上的那一格」挑，不按 DOM 第一个。 */
  window.__notaView?.dispatch({ selection: { anchor: 0 }, scrollIntoView: true })
  await wait(600)
  const pane = document.querySelector('.ph')?.parentElement
  const all = [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
    .map(e => ({ e, r: e.getBoundingClientRect() }))
    .filter(x => x.r.height > 0 && x.r.top > 0)
    .sort((a, b) => a.r.top - b.r.top)
  const num = all[0]?.e
  const icon = document.querySelector('.tb-btn svg, .md-toolbar button svg, .ed-toolbar button svg')
  const glyph = (el) => {
    const r = document.createRange()
    r.selectNodeContents(el)
    const b = r.getBoundingClientRect()
    return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }
  }
  const p = pane?.getBoundingClientRect()
  if (!p || !num || !icon) return { none: true, num: !!num, icon: !!icon }
  const g = glyph(num)
  const ic = icon.getBoundingClientRect()
  const panL = Math.round(p.left)
  return {
    numText: num.textContent,
    numGap: g.l - panL,
    numRightGap: g.r - panL,
    iconGap: Math.round(ic.left - panL),
    // 一列数字的右边界：两位数不许比一位数多探出去（格子定宽才对得齐）
    gutterW: Math.round(document.querySelector('.cm-gutters').getBoundingClientRect().width),
  }
})()`)
ok(
  '18.写作模式的行号紧贴左边框：字形跟顶栏搜索按钮落在同一条竖线上（差 ≤4px）',
  !gutter.none &&
    Math.abs(gutter.numGap - gutter.iconGap) <= 4 &&
    gutter.gutterW <= 42,
  gutter,
)

/* ══ 19. 零异常 ══ */
ok('19.全程零 JS 异常', errors.length === 0, errors.slice(0, 4))

console.log('\n=== SUMMARY ===')
const failed = Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k)
if (failed.length) console.log('FAILED:', failed.join(', '))
else console.log('ALL PASS (' + Object.keys(out).length + ')')

await close()
process.exit(failed.length ? 1 : 0)
