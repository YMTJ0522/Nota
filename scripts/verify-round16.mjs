/**
 * round16 —— 2.2.7 这一批「用起来不对劲」的修
 *
 * 共同点是：它们都不是「功能没做」，而是「做了但用起来不对劲」——
 * 不看数据根本发现不了，看一眼数据又无处可逃。
 *
 *  1. 双向滚动：编辑区滚时预览「半天不动然后猛跳一截」。
 *     根因是编辑区那一路拿 CodeMirror 的视口起点算比例，那玩意儿要滚过
 *     一整个 viewportMargin 才更新一次，于是跟随是阶跃的。
 *     断言：逐帧采样，预览侧的静止帧要远少于变化帧，且没有超大跳。
 *  2. 两端到底要对齐。以前按字符比例算，编辑区到底时预览只走 65%。
 *  3. 资料栏的收/放开关重新安置：开着时在自己那栏顶行，收着时退回侧栏顶行。
 *     于是侧栏顶行**任何时候都不会并排两枚**收起钮。
 *  4. 大纲不许冒出代码块里的注释：关栏行按 CommonMark 必须是纯围栏，
 *     带语言标记的那一行是开栏不是关栏。断言与 marked 的解析结果对齐。
 *  5. 版本历史 diff 的基准选择不许再用原生 select（那抹蓝不属于这个软件）。
 *  6. AI 里删会话一律过确认，空会话也不例外。
 *  7. 首屏与关于页的标用应用图标本身（位图），不是界面那套描边记号。
 *  8. 新建文件夹要立刻出现在树上，不等整棵树重扫。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4398)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 950] })
const results = []
const ok = (name, pass, data) => {
  results.push({ name, pass, data })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`, data === undefined ? '' : JSON.stringify(data))
}

/* 靶子一：够长，两个容器高度都远超视口 */
const paras = []
for (let i = 1; i <= 30; i++) paras.push(`## 第 ${i} 节`, '', `这是第 ${i} 节的正文，` + '文字内容。'.repeat(12), '')
const LONG = ['# 滚动靶子', '', ...paras].join('\n')

/* 靶子二：大纲。```` ```text ```` 是开栏不是关栏（带语言标记），
   所以它后面那行注释仍在块内，不该进大纲。 */
const OUTLINE = [
  '# 头部',
  '',
  '正文一段。',
  '',
  '```python',
  'def f():',
  '    return 1',
  '```text',
  '# 这条注释不该进大纲',
  '```',
  '',
  '# 尾部',
  '',
].join('\n')

const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/甲笔记.md': LONG, '/ws/大纲靶子.md': OUTLINE },
  tree: [
    ...makeTree(),
    {
      type: 'file',
      name: '大纲靶子.md',
      path: '/ws/大纲靶子.md',
      tags: [],
      starred: false,
      mtime: Date.now(),
      excerpt: '',
    },
  ],
})

/* ══ 7a. 首屏（还没进工作区）那枚标 ══ */
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1500)
const welcome = JSON.parse(
  await evaluate(`(() => {
    const img = document.querySelector('.welcome .logo')
    return JSON.stringify({
      isImg: img?.tagName === 'IMG',
      src: (img?.getAttribute('src') || '').slice(0, 24),
      w: img?.getBoundingClientRect().width ?? 0,
      svg: !!document.querySelector('.welcome .logo svg'),
    })
  })()`),
)
ok(
  '7a.首屏「打开一个目录」那页的标是应用图标本身（位图，不是描边记号）',
  welcome.isImg && !welcome.svg && welcome.w >= 40 && welcome.src.length > 0,
  welcome,
)

/* 进工作区。进去之后假 IPC 要**再注入一次**，否则量到的是空白页 */
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)
await evaluate(`document.querySelector('.col-tab[data-view="notes"]')?.click()`)
await sleep(500)

/* ══ 3. 资料栏开着时，侧栏顶行不许并排两枚收起钮 ══ */
const openState = JSON.parse(
  await evaluate(`(() => {
    const q = (s) => document.querySelector(s)
    return JSON.stringify({
      column: !!q('.col'),
      sideToggles: document.querySelectorAll('.side-head .head-actions .mini, .head-actions .mini').length,
      sideColToggle: !!q('.head-actions [data-role="column-toggle"]'),
      sideOwnToggle: !!q('.head-actions [data-role="sidebar-toggle"]'),
      colToggle: !!q('.col-flow [data-role="column-toggle"]'),
    })
  })()`),
)
ok(
  '3.资料栏开着时：收起钮在它自己顶行，侧栏顶行只剩「收起侧边栏」一枚',
  openState.column && openState.colToggle && openState.sideOwnToggle && !openState.sideColToggle,
  openState,
)

/* 点它 → 资料栏消失，侧栏顶行出现「展开」 */
await evaluate(`document.querySelector('.col-flow [data-role="column-toggle"]')?.click()`)
await sleep(600)
const closedState = JSON.parse(
  await evaluate(`(() => {
    const q = (s) => document.querySelector(s)
    return JSON.stringify({
      column: !!q('.col'),
      sideColToggle: !!q('.head-actions [data-role="column-toggle"]'),
      tip: q('.head-actions [data-role="column-toggle"]')?.getAttribute('data-tip') || '',
    })
  })()`),
)
ok(
  '4.收起后：资料栏没了，展开入口退回侧栏顶行（不会消失）',
  !closedState.column && closedState.sideColToggle && closedState.tip.includes('展开'),
  closedState,
)

/* 再点回来 */
await evaluate(`document.querySelector('.head-actions [data-role="column-toggle"]')?.click()`)
await sleep(700)
const backState = JSON.parse(
  await evaluate(`JSON.stringify({ column: !!document.querySelector('.col'), sideColToggle: !!document.querySelector('.head-actions [data-role="column-toggle"]') })`),
)
ok('5.再点展开：资料栏回来，侧栏顶行那枚又收起来了', backState.column && !backState.sideColToggle, backState)

/* ══ 8. 新建文件夹要立刻出现在树上（不等整棵树重扫）══ */
await evaluate(`document.querySelector('.col-tab[data-view="notes"]')?.click()`)
await sleep(400)
const before = JSON.parse(await evaluate(`JSON.stringify(document.querySelectorAll('.row.dir').length)`))
/* 走侧栏「文件夹」区右上角那枚 + */
await evaluate(`document.querySelector('.sec-add')?.click()`)
await sleep(400)
await evaluate(`(() => {
  const i = document.querySelector('.folder-input')
  if (i) { i.value = 'Wu'; i.dispatchEvent(new Event('input', { bubbles: true })) }
})()`)
await sleep(150)
await evaluate(`(() => {
  const i = document.querySelector('.folder-input')
  if (i) i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})()`)
/* 只给很短的窗口：要是必须等整棵树重扫完才出现，这里就量不到 */
await sleep(100)
const immediately = JSON.parse(
  await evaluate(`JSON.stringify({
    dirs: document.querySelectorAll('.row.dir').length,
    hasWu: [...document.querySelectorAll('.name.dir')].some((e) => e.textContent.trim() === 'Wu'),
  })`),
)
await sleep(1600)
const settled = JSON.parse(
  await evaluate(`JSON.stringify({
    dirs: document.querySelectorAll('.row.dir').length,
    hasWu: [...document.querySelectorAll('.name.dir')].some((e) => e.textContent.trim() === 'Wu'),
  })`),
)
ok(
  '8.新建文件夹立刻出现在树上（乐观插入，不等整棵树重扫）',
  immediately.hasWu && settled.hasWu && immediately.dirs === before + 1,
  { before, immediately, settled },
)

/* ══ 4. 大纲不许冒出代码块里的注释 ══ */
await evaluate(openNoteExpr('大纲靶子'))
await sleep(1200)
await evaluate(`document.querySelector('.col-tab[data-view="outline"]')?.click()`)
await sleep(700)
const outline = JSON.parse(
  await evaluate(`(() => {
    const items = [...document.querySelectorAll('.ov-item')].map((e) => e.textContent.trim())
    return JSON.stringify({ items, leaked: items.some((t) => t.includes('不该进大纲')) })
  })()`),
)
ok(
  '9.大纲不冒出代码块里的注释（带语言标记的那行是开栏不是关栏）',
  outline.items.length >= 2 && !outline.leaked && outline.items.some((t) => t.includes('尾部')),
  outline,
)

/* ══ 5. 版本历史 diff 的基准选择不许是原生 select ══ */
/* 版本历史入口是顶栏那枚独立的「版本历史」按钮（EditorActions 里） */
await evaluate(`document.querySelector('.ea-btn[title="版本历史"]')?.click()`)
await sleep(800)
const history = JSON.parse(
  await evaluate(`JSON.stringify({ panel: !!document.querySelector('.hp') })`),
)
if (history.panel) {
  /* 切到「对比」模式，基准选择器才会出现 */
  await evaluate(`[...document.querySelectorAll('.hp button')].find((b) => b.textContent.includes('对比'))?.click()`)
  await sleep(600)
  const base = JSON.parse(
    await evaluate(`(() => {
      const q = (s) => document.querySelector(s)
      return JSON.stringify({
        native: document.querySelectorAll('.hp select').length,
        ownBtn: !!q('.hp [data-role="base-pick"]'),
      })
    })()`),
  )
  ok(
    '10.版本历史 diff 的基准下拉是自绘菜单，不是原生 select（没有那抹系统蓝）',
    base.native === 0 && base.ownBtn,
    base,
  )
  if (base.ownBtn) {
    await evaluate(`document.querySelector('.hp [data-role="base-pick"]')?.click()`)
    await sleep(500)
    const menu = JSON.parse(
      await evaluate(`JSON.stringify({ open: !!document.querySelector('.hp .n-menu'), items: document.querySelectorAll('.hp .n-menu .n-menu-item').length })`),
    )
    ok('11.基准菜单点得开，里面有得选', menu.open && menu.items >= 1, menu)
    await evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
    await sleep(300)
  } else {
    ok('11.基准菜单点得开，里面有得选', false, { skipped: true })
  }
  await evaluate(`document.querySelector('.hp [data-role="hp-close"]')?.click()`)
  await sleep(400)
} else {
  ok('10.版本历史 diff 的基准下拉是自绘菜单，不是原生 select（没有那抹系统蓝）', false, history)
  ok('11.基准菜单点得开，里面有得选', false, { skipped: true })
}

/* ══ 6. AI：删会话一律过确认，空会话也不例外 ══ */
await evaluate(`localStorage.setItem('nota-chat-sessions', JSON.stringify({
  active: 21,
  sessions: [
    { id: 21, title: '有内容的会话', updatedAt: Date.now(), messages: [
      { id: 1, role: 'user', content: '问一句' },
      { id: 2, role: 'assistant', content: '答一句' },
    ] },
  ],
}))`)
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1600)
await evaluate(INJECT)
/* navigate 之后回到首屏，得重新进一次工作区，不然侧栏根本不存在 */
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)
/* AI 入口在侧栏底部那排导航里，不在中间列的页签上 */
await evaluate(`[...document.querySelectorAll('.nav-item')].find((e) => e.textContent.includes('AI'))?.click()`)
await sleep(1000)
const aiOpen = JSON.parse(await evaluate(`JSON.stringify({ panel: !!document.querySelector('.ag') })`))
if (aiOpen.panel) {
  /* 顶行那枚删除（就是新对话页右上角那个叉号） */
  await evaluate(`document.querySelector('.ag [data-role="del-session"]')?.click()`)
  await sleep(500)
  const confirm1 = JSON.parse(
    await evaluate(`JSON.stringify({ dialog: !!document.querySelector('.cf'), danger: !!document.querySelector('.cf-btn.cf-danger') })`),
  )
  ok('12.AI 顶行那个删除（叉号）也要过确认弹窗', confirm1.dialog && confirm1.danger, confirm1)
  await evaluate(`document.querySelector('.cf-btn.cf-danger')?.click()`)
  await sleep(600)
  /* 删完之后是空会话，再点一次：空会话也不能直接删 */
  await evaluate(`document.querySelector('.ag [data-role="del-session"]')?.click()`)
  await sleep(500)
  const confirm2 = JSON.parse(
    await evaluate(`JSON.stringify({ dialog: !!document.querySelector('.cf'), text: document.querySelector('.cf')?.textContent?.trim().slice(0, 40) || '' })`),
  )
  ok('13.空会话（新对话）删除同样过确认，不再直接抹掉', confirm2.dialog, confirm2)
  await evaluate(`document.querySelector('.cf-btn:not(.cf-danger)')?.click()`)
  await sleep(400)
} else {
  ok('12.AI 顶行那个删除（叉号）也要过确认弹窗', false, aiOpen)
  ok('13.空会话（新对话）删除同样过确认，不再直接抹掉', false, { skipped: true })
}

/* ══ 1/2. 双向滚动 ══ */
/* AI 那一屏没有页签条，回不去 —— 走侧栏的「所有笔记」导航项 */
await evaluate(`[...document.querySelectorAll('.nav-item')].find((e) => e.textContent.includes('所有笔记'))?.click()`)
await sleep(600)
await evaluate(openNoteExpr('甲笔记'))
await sleep(1400)
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="分栏视图"]')?.click()`)
await sleep(1000)
const shape = JSON.parse(
  await evaluate(`JSON.stringify({
    editor: !!document.querySelector('.cm-scroller'),
    preview: !!document.querySelector('.pvw .preview'),
    eMax: (() => { const e = document.querySelector('.cm-scroller'); return e ? e.scrollHeight - e.clientHeight : -1 })(),
    pMax: (() => { const p = document.querySelector('.pvw .preview'); return p ? p.scrollHeight - p.clientHeight : -1 })(),
  })`),
)
if (shape.editor && shape.preview && shape.eMax > 100 && shape.pMax > 100) {
  await evaluate(`(() => {
    window.__samples = []
    const e = document.querySelector('.cm-scroller')
    const p = document.querySelector('.pvw .preview')
    window.__sampling = true
    const tick = () => {
      if (!window.__sampling) return
      window.__samples.push([Math.round(e.scrollTop), Math.round(p.scrollTop)])
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })()`)

  async function wheel(x, y, dy, times) {
    for (let i = 0; i < times; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy })
      await sleep(28)
    }
  }
  const boxE = JSON.parse(
    await evaluate(`(() => { const r = document.querySelector('.cm-scroller').getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}) })()`),
  )
  await wheel(boxE.x, boxE.y, 60, 25)
  await sleep(400)
  const samples = JSON.parse(await evaluate(`JSON.stringify(window.__samples)`))

  /* 只留发生变化的帧 */
  const rows = []
  let last = null
  for (const [e, p] of samples) {
    if (!last || last[0] !== e || last[1] !== p) rows.push([e, p])
    last = [e, p]
  }
  const steps = []
  for (let i = 1; i < rows.length; i++) steps.push(rows[i][1] - rows[i - 1][1])
  const moved = steps.filter((s) => s !== 0)
  const zero = steps.length - moved.length
  const sorted = [...moved].sort((a, b) => a - b)
  const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  const max = sorted.length ? sorted[sorted.length - 1] : 0
  ok(
    '1.滚编辑区时预览连续跟随（不是半天不动再猛跳一截）',
    moved.length > 0 && zero <= moved.length && max <= med * 6 + 40,
    { 变化帧: moved.length, 静止帧: zero, 步长中位数: med, 最大跳: max },
  )

  /* 一路滚到底：两端必须同时到底 */
  await wheel(boxE.x, boxE.y, 100, 60)
  await sleep(700)
  const endE = JSON.parse(
    await evaluate(`(() => {
      const e = document.querySelector('.cm-scroller')
      const p = document.querySelector('.pvw .preview')
      return JSON.stringify({
        ePct: Math.round((e.scrollTop / Math.max(1, e.scrollHeight - e.clientHeight)) * 100),
        pPct: Math.round((p.scrollTop / Math.max(1, p.scrollHeight - p.clientHeight)) * 100),
      })
    })()`),
  )
  ok('2.编辑区滚到底时预览也到底（两端对齐，不再停在中途）', endE.ePct >= 99 && endE.pPct >= 95, endE)
  await evaluate(`window.__sampling = false`)
} else {
  ok('1.滚编辑区时预览连续跟随（不是半天不动再猛跳一截）', false, shape)
  ok('2.编辑区滚到底时预览也到底（两端对齐，不再停在中途）', false, shape)
}

/* ══ 7b. 关于页那枚标 ══ */
await evaluate(`document.querySelector('.foot-btn[data-tip="设置"]')?.click()`)
await sleep(700)
const about = JSON.parse(
  await evaluate(`(() => {
    const t = [...document.querySelectorAll('.st-nav-item')].find((e) => e.textContent.includes('关于'))
    if (t) t.click()
    return JSON.stringify({ found: !!t })
  })()`),
)
await sleep(600)
const aboutIcon = JSON.parse(
  await evaluate(`(() => {
    const img = document.querySelector('.ab-mark img')
    return JSON.stringify({
      isImg: img?.tagName === 'IMG',
      w: img?.getBoundingClientRect().width ?? 0,
      svg: !!document.querySelector('.ab-mark svg'),
    })
  })()`),
)
ok(
  '7b.关于页的标是应用图标本身（位图，不是描边记号）',
  aboutIcon.isImg && !aboutIcon.svg && aboutIcon.w >= 40,
  { ...aboutIcon, ...about },
)

const realErrors = errors.filter((e) => !/favicon|ResizeObserver loop/i.test(e))
ok('14.全程零 JS 异常', realErrors.length === 0, realErrors.slice(0, 4))

const pass = results.filter((r) => r.pass).length
console.log(`\n通过 ${pass}/${results.length}`)
await close()
process.exit(pass === results.length ? 0 : 1)
