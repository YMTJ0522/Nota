/**
 * 2.2.3 验证：用户点名的那几处 + 顺手查出来的图标事故。
 *
 * 跑法：node scripts/verify-round12.mjs
 *
 * 覆盖：
 *  1. 深色模式的选中色不再是「强调色跟底色混出来的浊色」——色相保住了、
 *     彩度没被砍半、跟文字色的对比度还够
 *  2. 设置 → AI 编写：点服务商预设真的换配置（点得动 ≠ 生效，专治那个
 *     捕获阶段 pointerdown 把菜单提前拆掉的 bug）
 *  3. 预设的选中态认得出手打的地址（尾部斜杠 / 大小写不影响）
 *  4. 大纲跳转：编辑区与预览区都是滑过去而不是瞬移
 *  5. 大纲跳转：每一项都落在它自己那一节 —— 包括源码侧认不到的
 *     setext 标题和引用块标题，不再整体错位
 *  6. 「新建笔记 / 导入已有笔记」住在资料栏右上角，编辑区顶行不再重复
 *  7. 视图切换有淡入；系统开了减弱动效时有统一的兜底
 *  8. 资料栏收起 / 展开走的是宽度过渡，不是硬跳
 *  9. build/icon.ico 七个尺寸的**真实**分辨率与声明一致、且带 alpha
 *     （2.2.2 之前全是 770×770 的无 alpha 整窗截图，任务栏上就是一块白方块）
 * 10. 全程零 JS 异常
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, NOTE_STRUCT, openNoteExpr, navExpr } from './fake-workspace.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const { send, evaluate, sleep, errors, close } = await launch({ port: 4357, size: [1500, 1000] })

const out = {}
const ok = (name, cond, detail) => {
  out[name] = { pass: !!cond, detail }
  console.log(cond ? '  PASS  ' : '  FAIL  ', name, detail !== undefined ? JSON.stringify(detail) : '')
}

const NOTES = { ...makeNotes(), '/ws/大纲样本.md': NOTE_STRUCT }
const TREE = [
  ...makeTree(),
  { type: 'file', name: '大纲样本.md', path: '/ws/大纲样本.md', tags: [], starred: false, mtime: Date.now() - 5_000, excerpt: '' },
]
const INJECT = makeInject({ notes: NOTES, tree: TREE })
const PORT = 4357

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1600)
await evaluate(
  `localStorage.clear(); localStorage.setItem('nota-ai', ${JSON.stringify(
    JSON.stringify({ enabled: true, baseUrl: '', apiKey: '', model: '', temperature: 0.7, systemPrompt: '' }),
  )})`,
)
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(2000)
await evaluate(INJECT)
await evaluate("document.querySelector('.cta')?.click()")
await sleep(1200)
await evaluate(INJECT)
await sleep(800)

/* ══ 1. 深色模式的选中色 ══
   老写法是 `color-mix(in oklab, var(--n-accent) 52%, var(--n-bg))`：
   混色把两个颜色的 oklab a/b 直接平均，深底自带的蓝紫把绿强调色拽偏，
   彩度还按配比砍掉一半，出来是一片发灰的浊绿（用户截图点名说丑）。
   现在改成 `oklch(from …)`，直接继承强调色的色相。
   这里不比对某个写死的色值（换个强调色就该跟着变），而是检查
   「它确实有彩度、确实看得清」这两件本质的事。 */
const sel = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  document.querySelector('[data-role="theme-toggle"]')?.click()
  await wait(700)
  const theme = document.documentElement.getAttribute('data-theme')
  const root = document.documentElement
  const raw = getComputedStyle(root).getPropertyValue('--n-selection').trim()

  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;left:-9999px;width:10px;height:10px;background:var(--n-selection)'
  document.body.appendChild(probe)
  // 对照：老写法「强调色与底色混」，看看它到底把彩度砍掉多少
  const old = document.createElement('div')
  old.style.cssText = 'position:fixed;left:-9999px;width:10px;height:10px;background:color-mix(in oklab, var(--n-accent) 62%, var(--n-bg))'
  document.body.appendChild(old)
  await wait(60)
  const now = getComputedStyle(probe).backgroundColor
  const was = getComputedStyle(old).backgroundColor
  probe.remove(); old.remove()

  // 浏览器把 oklch 原样返回（不做 rgb 化），所以直接读 L / C 两个分量。
  // 亮度换算用 Oklab 的近似 L ≈ Y^(1/3) → Y ≈ L³，
  // 对「判断白字压不压得住」这个量级足够了。
  const parts = (s) => (s.match(/-?[\\d.]+/g) || []).map(Number)
  const L = parts(now)[0]
  const C = parts(now)[1]
  const Lold = parts(was)[0]
  const Cold = parts(was)[1]
  const Y = (l) => Math.pow(l, 3)
  const contrast = (0.9 + 0.05) / (Y(L) + 0.05)
  return { theme, raw, now, was, L, C, Lold, Cold, contrast, okRelative: /^oklch\\(from /.test(raw) }
})()`)
ok(
  '1.深色选中色：走相对颜色语法继承强调色的色相（不再和底色混），彩度没被砍半、白字对比度 ≥ 4.5',
  sel.theme === 'dark' &&
    sel.okRelative &&
    sel.L >= 0.42 && sel.L <= 0.56 &&
    sel.C >= 0.05 && sel.C > sel.Cold * 1.25 &&
    sel.contrast >= 4.5,
  sel,
)

/* ══ 2 + 3. 服务商预设 ══
   这一条是「点得动但没生效」的正面回归：以前捕获阶段的 pointerdown
   会把菜单先拆掉，mouseup 时按钮已经不在 DOM 里，click 根本不产生。
   所以除了「配置换没换」，还专门盯了一下「按下那一刻菜单还在不在」。 */
const preset = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  window.dispatchEvent(new CustomEvent('nota:settings', { detail: 'ai' }))
  await wait(600)

  const trigger = document.querySelector('[data-role="preset-select"]')
  const label = () => trigger?.querySelector('.n-select-name')?.textContent?.trim() ?? ''
  const fieldByLabel = (t) => {
    const row = [...document.querySelectorAll('.st-row')].find(r => (r.querySelector('.st-name')?.textContent ?? '').trim() === t)
    return row?.querySelector('input, textarea')
  }
  const urlInput = () => fieldByLabel('接口地址')
  const modelInput = () => fieldByLabel('模型名称')
  const before = { label: label(), url: urlInput()?.value ?? '' }

  trigger.click()
  await wait(300)
  const items = [...document.querySelectorAll('.n-menu .n-menu-item')].map(b => b.getAttribute('data-preset')).filter(Boolean)
  const target = document.querySelector('.n-menu [data-preset="DeepSeek"]')
  // 菜单项得真的露在外面（不是被谁裁了 / 盖了）
  const r = target?.getBoundingClientRect()
  const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null
  const reachable = !!(target && hit && (hit === target || target.contains(hit)))

  // 按下那一刻菜单还应该在（这正是老 bug 断掉的地方）
  const down = new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 })
  target.dispatchEvent(down)
  const menuAliveAfterDown = !!document.querySelector('.n-menu [data-preset="DeepSeek"]')
  target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  target.click()
  await wait(400)

  const picked = {
    label: label(),
    url: urlInput()?.value ?? '',
    model: modelInput()?.value ?? '',
    menuGone: !document.querySelector('.n-menu [data-preset="DeepSeek"]'),
    stored: JSON.parse(localStorage.getItem('nota-ai') || '{}').baseUrl ?? '',
  }

  // 手打的地址（尾部多一个斜杠、大小写不同）也该认出是哪一套预设
  const inp = urlInput()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(inp, '  https://api.siliconflow.cn/v1/  ')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(400)
  const typed = { label: label(), url: inp.value }

  // 「自定义…」是一件动作：关掉菜单，把光标送进接口地址那一格
  trigger.click()
  await wait(250)
  document.querySelector('.n-menu [data-preset="自定义"]')?.click()
  await wait(300)
  const custom = {
    labelKeepsTruth: label(),
    menuGone: !document.querySelector('.n-menu [data-preset="自定义"]'),
    focused: document.activeElement === urlInput(),
  }
  document.querySelector('.st-x')?.click()
  await wait(400)

  return { before, items, reachable, menuAliveAfterDown, picked, typed, custom, closed: !document.querySelector('.st') }
})()`)
ok(
  '2.服务商预设：按下时菜单不被提前拆掉，点了 DeepSeek 就真的换成 DeepSeek（地址 / 模型 / 落盘全都跟上）',
  preset.items.length >= 7 &&
    preset.reachable &&
    preset.menuAliveAfterDown &&
    preset.picked.label === 'DeepSeek' &&
    preset.picked.url === 'https://api.deepseek.com/v1' &&
    preset.picked.model === 'deepseek-chat' &&
    preset.picked.stored === 'https://api.deepseek.com/v1' &&
    preset.picked.menuGone,
  { before: preset.before, items: preset.items.length, reachable: preset.reachable, alive: preset.menuAliveAfterDown, picked: preset.picked },
)
ok(
  '3.预设选中态认得出手打的地址（首尾空格 / 尾部斜杠不影响）；「自定义…」是「把光标送进地址栏」这个动作，不是把地址清空',
  preset.typed.label === '硅基流动' &&
    preset.typed.url.trim() === 'https://api.siliconflow.cn/v1/' &&
    preset.custom.labelKeepsTruth === '硅基流动' &&
    preset.custom.menuGone &&
    preset.custom.focused &&
    preset.closed,
  { typed: preset.typed, custom: preset.custom, closed: preset.closed },
)

/* ══ 4 + 5. 大纲跳转：平滑 + 每一项都落在自己那一节 ══ */
await evaluate(navExpr('所有笔记'))
await sleep(600)
await evaluate(openNoteExpr('大纲样本'))
await sleep(1200)
await evaluate("document.querySelector('.ph-seg-btn[aria-label^=\"分栏\"]')?.click()")
await sleep(900)
await evaluate("document.querySelector('.col-tab[data-view=\"outline\"]')?.click()")
await sleep(700)

const jump = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const items = [...document.querySelectorAll('.ov-item')]
  const textOf = (b) => b.querySelector('.ov-text')?.textContent?.trim() ?? ''
  const p = document.querySelector('.preview')
  const sc = window.__notaView?.scrollDOM
  if (!items.length || !p || !sc) {
    return { err: 'missing', items: items.length, hasP: !!p, hasSc: !!sc, cls: [...document.querySelectorAll('.col-body button')].map(b => b.className).slice(0, 8) }
  }

  const rel = (el, box) => el.getBoundingClientRect().top - box.getBoundingClientRect().top
  const previewTopText = () => {
    const heads = [...p.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    let best = null
    for (const h of heads) { const d = rel(h, p); if (d <= 64 && (best === null || d > rel(best, p))) best = h }
    return best?.textContent?.trim() ?? ''
  }
  // 编辑区：直接找「那一行本身」，量它离视口顶多远。
  // 不能写成「可视区里最靠下的那一行」—— 那取到的是标题**下面**的正文。
  const lineOffsetOf = (label) => {
    const hit = [...sc.querySelectorAll('.cm-line')]
      .find(l => l.textContent.trim().replace(/^#+\\s*/, '') === label)
    return hit ? Math.round(rel(hit, sc)) : null
  }

  const report = []
  let smooth = null
  for (let i = 0; i < items.length; i += 1) {
    const label = textOf(items[i])
    // 每一步都先回到文档最顶上，跳转才一定是往下走的一段长距离
    sc.scrollTop = 0
    p.scrollTop = 0
    await wait(260)
    const p0 = p.scrollTop, e0 = sc.scrollTop
    items[i].click()
    await wait(50)
    const pMid = p.scrollTop, eMid = sc.scrollTop
    await wait(760)
    const p1 = p.scrollTop, e1 = sc.scrollTop
    if (i === items.length - 1) {
      smooth = {
        preview: { from: p0, mid: pMid, to: p1 },
        editor: { from: e0, mid: eMid, to: e1 },
      }
    }
    // 落点：预览里「顶部那一节」的文字 + 目标标题本身的位置；
    // 编辑区同理，直接量目标那一行离视口顶多远
    const headText = previewTopText()
    const lineOffset = lineOffsetOf(label)
    const el = [...p.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(h => h.textContent.trim() === label)
    const headOffset = el ? Math.round(rel(el, p)) : null
    report.push({
      label,
      headText,
      lineOffset,
      headOffset,
      previewOk: headText === label,
      // 编辑区：那一行要落在视口顶部（标题带上下留白，给到 120 的宽容度）
      editorOk: lineOffset !== null && lineOffset >= -8 && lineOffset <= 120,
      // 失败时留点现场：滚到哪了、可视区最上面几行长什么样
      dbg: {
        scTop: Math.round(sc.scrollTop),
        pTop: Math.round(p.scrollTop),
        lineCount: sc.querySelectorAll('.cm-line').length,
        lines: [...sc.querySelectorAll('.cm-line')].slice(0, 8)
          .map(l => [Math.round(rel(l, sc)), l.textContent.trim().slice(0, 12)]),
      },
    })
  }
  return { count: items.length, report, smooth, mode: document.querySelector('.stage')?.getAttribute('data-layout') }
})()`)

const bad = (jump.report ?? []).filter((r) => !r.previewOk || !r.editorOk || r.headOffset === null || r.headOffset < -4 || r.headOffset > 80)
ok(
  '4.大纲跳转是滑过去的：采样到的中间位置严格落在起点与终点之间，不是瞬移',
  jump.mode === 'split' &&
    jump.smooth &&
    jump.smooth.preview.mid > jump.smooth.preview.from + 4 &&
    jump.smooth.preview.mid < jump.smooth.preview.to - 4 &&
    jump.smooth.editor.mid > jump.smooth.editor.from + 4 &&
    jump.smooth.editor.mid < jump.smooth.editor.to - 4,
  { mode: jump.mode, smooth: jump.smooth },
)
ok(
  '5.大纲每一项都落在它自己那一节（编辑区与预览区同时对上，含 setext / 引用块标题的错位场景）',
  jump.count >= 5 && bad.length === 0,
  { count: jump.count, bad, report: (jump.report ?? []).map((r) => [r.label, r.headOffset, r.lineOffset, r.previewOk, r.editorOk]) },
)

/* ══ 6. 新建 / 导入在资料栏右上角 ══ */
const actions = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  // 2.2.7 起这一组里多了「收起资料栏」那一枚（它管的就是这一栏自己），
  // 所以不能写死两枚 —— 只认新建 / 导入这两枚在不在、贴不贴右边缘
  const inColumn = [...document.querySelectorAll('.col-flow .col-act')].map(b => ({
    role: b.getAttribute('data-role'), title: b.getAttribute('title'), w: Math.round(b.getBoundingClientRect().width),
  }))
  const inEditor = [...document.querySelectorAll('.ph-right .ea-btn')].map(b => b.getAttribute('title'))
  // 右上角：这一组的右边缘要贴近这一列的右边缘。
  // 取最后那一枚 —— 2.2.7 之后「收起资料栏」排在了导入后面，写死导入就不准了
  const colR = document.querySelector('.col')?.getBoundingClientRect()
  const acts = [...document.querySelectorAll('.col-flow .col-act')]
  const lastR = acts.length ? acts[acts.length - 1].getBoundingClientRect() : null
  const rightGap = colR && lastR ? Math.round(colR.right - lastR.right) : null
  // 先到「笔记」页签记下篇数，再去「大纲」页签点新建 ——
  // 顺便验「在小众页签上点新建，会切回笔记页签」，不然新笔记等于白建
  document.querySelector('.col-tab[data-view="notes"]')?.click()
  await wait(450)
  const listBefore = document.querySelectorAll('.nlist .nl-item').length
  document.querySelector('.col-tab[data-view="outline"]')?.click()
  await wait(450)
  const tabBefore = document.querySelector('.col-tab.on')?.getAttribute('data-view') ?? null
  document.querySelector('.col-act[data-role="new-note"]')?.click()
  await wait(900)
  return {
    inColumn, inEditor, rightGap, tabBefore,
    tabAfter: document.querySelector('.col-tab.on')?.getAttribute('data-view') ?? null,
    listBefore,
    listAfter: document.querySelectorAll('.nlist .nl-item').length,
    opened: document.querySelector('.ph-title')?.value ?? '',
  }
})()`)
ok(
  '6.新建 / 导入住在资料栏右上角（贴着这一列右边缘）；在大纲页签下点新建会切回笔记页签，编辑区顶行不再有这两个重复入口',
  actions.inColumn.some((b) => b.role === 'new-note') &&
    actions.inColumn.some((b) => b.role === 'import-note') &&
    actions.inColumn.every((b) => b.w === 26) &&
    actions.rightGap !== null && actions.rightGap >= 6 && actions.rightGap <= 14 &&
    actions.tabBefore === 'outline' && actions.tabAfter === 'notes' &&
    actions.listAfter === actions.listBefore + 1 &&
    (actions.opened ?? '').length > 0 &&
    !actions.inEditor.some((t) => (t ?? '').includes('新建')) &&
    !actions.inEditor.some((t) => (t ?? '').includes('导入')),
  actions,
)

/* ══ 7. 动效：视图淡入 + 减弱动效兜底 ══ */
const anim = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const view = document.querySelector('.col-body > *')
  const an = view ? getComputedStyle(view).animationName : 'none'
  const dur = view ? getComputedStyle(view).animationDuration : ''
  let reduced = null
  for (const sh of document.styleSheets) {
    let rules = []
    try { rules = [...sh.cssRules] } catch { continue }
    for (const r of rules) {
      if (r.conditionText && r.conditionText.includes('prefers-reduced-motion')) reduced = r.conditionText
    }
  }
  // 切一次页签，看新内容是不是带着动画挂上来的
  const before = document.querySelector('.col-tab.on')?.getAttribute('data-view')
  document.querySelector('.col-tab[data-view="notes"]')?.click()
  await wait(500)
  const el = document.querySelector('.col-body > *')
  return { an, dur, reduced, before, now: document.querySelector('.col-tab.on')?.getAttribute('data-view'), an2: el ? getComputedStyle(el).animationName : 'none' }
})()`)
ok(
  '7.资料栏切页签时新内容带淡入动画；样式表里有统一的「减弱动效」兜底',
  anim.an !== 'none' &&
    anim.dur !== '' && parseFloat(anim.dur) >= 0.1 && parseFloat(anim.dur) <= 0.4 &&
    anim.an2 !== 'none' &&
    anim.now === 'notes' &&
    (anim.reduced ?? '').includes('prefers-reduced-motion'),
  anim,
)

/* ══ 8. 资料栏收起 / 展开是滑的 ══ */
const collapse = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const seen = () => new Promise((res) => {
    const t0 = performance.now()
    const tick = () => {
      const el = document.querySelector('.col')
      if (el && /colx-(enter|leave)-active/.test(el.className)) return res({ cls: el.className, w: Math.round(el.getBoundingClientRect().width) })
      if (performance.now() - t0 > 600) return res(null)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  // 2.2.7：收起那一半在资料栏自己顶行，展开那一半退回侧栏顶行
  const leaveP = seen()
  document.querySelector('.col-flow [data-role="column-toggle"]')?.click()
  const leaveCls = await leaveP
  await wait(420)
  const gone = !document.querySelector('.col')
  const enterP = seen()
  document.querySelector('.panel .head [data-role="column-toggle"]')?.click()
  const enterCls = await enterP
  await wait(420)
  return { leaveCls, gone, enterCls, back: !!document.querySelector('.col') }
})()`)
ok(
  '8.资料栏收起 / 展开走的是宽度过渡（colx-* 过渡类真的挂上了），不是硬跳',
  !!collapse.leaveCls && collapse.leaveCls.cls.includes('colx-leave') &&
    collapse.gone &&
    !!collapse.enterCls && collapse.enterCls.cls.includes('colx-enter') &&
    collapse.back,
  collapse,
)

/* ══ 9. 图标 ICO ══
   这条不经过浏览器 —— 直接读盘拆 ICO 目录。2.2.2 之前七个「尺寸」里
   嵌的全是同一张 770×770、无 alpha 的整窗截图，Windows 缩下来就是
   一块白方块。所以除了「声明尺寸」，这里还核对了 PNG 头里的**真实**宽高
   与颜色类型（必须是带 alpha 的 6 号真彩色）。 */
const ico = (() => {
  const p = path.join(ROOT, 'build', 'icon.ico')
  if (!fs.existsSync(p)) return { err: 'missing' }
  const buf = fs.readFileSync(p)
  const count = buf.readUInt16LE(4)
  const want = [16, 24, 32, 48, 64, 128, 256]
  const rows = []
  for (let i = 0; i < count; i += 1) {
    const b = 6 + i * 16
    const declared = buf.readUInt8(b) || 256
    const size = buf.readUInt32LE(b + 8)
    const offset = buf.readUInt32LE(b + 12)
    const png = buf.subarray(offset, offset + size)
    const isPng = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const w = isPng ? png.readUInt32BE(16) : 0
    const h = isPng ? png.readUInt32BE(20) : 0
    const colorType = isPng ? png.readUInt8(25) : -1
    rows.push({ declared, w, h, colorType, bytes: size })
  }
  return { count, rows, want }
})()
ok(
  '9.build/icon.ico：七个尺寸的真实分辨率与声明一致，且每一档都是带 alpha 的 PNG',
  ico.count === 7 &&
    ico.rows.every((r, i) => r.declared === ico.want[i] && r.w === r.declared && r.h === r.declared) &&
    ico.rows.every((r) => r.colorType === 6),
  ico,
)

ok('10.全程零 JS 异常', errors.length === 0, errors.slice(0, 4))

console.log('\n' + (Object.values(out).every((v) => v.pass) ? '✅ 全部通过' : '❌ 有失败项'))
await close()
process.exit(Object.values(out).every((v) => v.pass) ? 0 : 1)
