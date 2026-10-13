/**
 * round13 —— 2.2.4：勾选框、编辑区选中色、随包字体、按钮内边距
 *
 * 这一轮没有新功能，全是「看得见的毛病」，所以断言也都落在能量的东西上：
 *
 *  1. 勾选框里的勾「显示不全」—— 浏览器给 button 的默认内边距是 1px 6px，
 *     17px 的方框左右各被吃掉 6px，11px 的勾只剩 3px 宽。这里直接量几何：
 *     框 17×17、勾 11×11、四边留白相等；再全局扫一遍，确认没有别的按钮
 *     还在吃 UA 的内边距。
 *  2. 编辑区选中的是浅紫 —— CodeMirror 的 baseTheme 用一条六层深的选择器把
 *     .cm-selectionBackground 写死成 #d7d4f0，比常规写法重，压不过它。
 *     现在量真实计算值，要求它恰好等于 --n-selection 解析出来的颜色，
 *     并且深浅两套主题都对得上（浅紫那两个值都要排除）。
 *  3. 随包字体 —— 不能只看 font-family 字符串，那只是「想要用什么」；
 *     要 document.fonts.check 为真、body 字体栈第一项就是它、并且用 canvas
 *     量出来跟 sans-serif 的宽度确实不同，才算真的换上了。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, NOTE_STRUCT, openNoteExpr, navExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4394)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1400, 950] })
const results = []
const ok = (name, pass, data) => {
  results.push({ name, pass, data })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`, data === undefined ? '' : JSON.stringify(data))
}

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1400)
await evaluate('localStorage.clear()')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1700)

const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/大纲样本.md': NOTE_STRUCT },
  tree: [
    ...makeTree(),
    { type: 'file', name: '大纲样本.md', path: '/ws/大纲样本.md', tags: [], starred: false, mtime: Date.now() - 5_000, excerpt: '' },
  ],
})
await evaluate(INJECT)
await evaluate("document.querySelector('.cta')?.click()")
await sleep(1200)
await evaluate(INJECT)
await sleep(700)

/* ══ 1. 勾选框：勾要完整、要居中 ══ */
await evaluate(navExpr('回收站'))
await sleep(800)
const trash = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  document.querySelector('.pn-x[data-tip="多选"]')?.click()
  await wait(420)
  const boxes = [...document.querySelectorAll('.tv-check')]
  if (!boxes.length) return { err: 'no boxes' }
  boxes[0].click()
  await wait(200)
  const geo = (b) => {
    const br = b.getBoundingClientRect()
    const cs = getComputedStyle(b)
    const svg = b.querySelector('svg')
    const sr = svg ? svg.getBoundingClientRect() : null
    return {
      box: [Math.round(br.width), Math.round(br.height)],
      pad: cs.padding,
      svg: sr ? [Math.round(sr.width), Math.round(sr.height)] : null,
      // 居中就是四边留白相等
      centered: sr
        ? [sr.left - br.left, br.right - sr.right, sr.top - br.top, br.bottom - sr.bottom]
            .every((d, _, a) => Math.abs(d - a[0]) < 1.5)
        : null,
    }
  }
  const picked = boxes.filter(b => b.querySelector('svg'))
  return { count: boxes.length, checked: picked.length, picked: picked.map(geo) }
})()`)
ok(
  '1.回收站勾选框：勾是完整的一枚、且在框里居中',
  !trash.err && trash.count >= 2 && trash.checked >= 1 &&
    trash.picked.every((g) => g.box[0] === 17 && g.box[1] === 17 &&
      g.pad === '0px' && g.svg && g.svg[0] === 11 && g.svg[1] === 11 && g.centered),
  trash,
)

/* 附件库同款（它在图片上，勾选框是自己写死 padding:0 的，一起守住） */
await evaluate(navExpr('附件库'))
await sleep(800)
const attach = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  document.querySelector('.pn-x[data-tip="多选"]')?.click()
  await wait(420)
  const boxes = [...document.querySelectorAll('.av-check')]
  if (!boxes.length) return { err: 'no boxes' }
  boxes[0].click()
  await wait(200)
  const b = boxes[0]
  const br = b.getBoundingClientRect()
  const svg = b.querySelector('svg')
  const sr = svg ? svg.getBoundingClientRect() : null
  return { count: boxes.length, pad: getComputedStyle(b).padding,
    box: [Math.round(br.width), Math.round(br.height)],
    svg: sr ? [Math.round(sr.width), Math.round(sr.height)] : null }
})()`)
ok(
  '2.附件库勾选框同样完整',
  !attach.err && attach.pad === '0px' && attach.svg && attach.svg[0] >= 9 && attach.svg[1] >= 9,
  attach,
)

/* 全局：还有没有按钮在吃浏览器默认内边距 */
const uaPad = await evaluate(`(() => {
  const hits = []
  for (const b of document.querySelectorAll('button')) {
    const cs = getComputedStyle(b)
    if (cs.paddingTop === '1px' && cs.paddingLeft === '6px') {
      hits.push((b.className || '').toString().slice(0, 40))
    }
  }
  return hits
})()`)
ok('3.没有按钮还留着浏览器默认的 1px 6px 内边距', uaPad.length === 0, uaPad)

/* ══ 2. 编辑区选中色：必须就是 --n-selection ══ */
await evaluate(navExpr('所有笔记'))
await sleep(500)
await evaluate(openNoteExpr('大纲样本'))
await sleep(1100)

/** 拖一段字出来，把选区的真实计算色跟 --n-selection 对照 */
const measureSelection = async () => {
  const lineBox = await evaluate(`(() => {
    const l = document.querySelector('.cm-content .cm-line')
    if (!l) return null
    const r = l.getBoundingClientRect()
    return { x: Math.round(r.left + 3), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) }
  })()`)
  if (!lineBox) return { err: 'no line' }
  const to = Math.min(lineBox.x + 70, lineBox.x + lineBox.w - 4)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: lineBox.x, y: lineBox.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to, y: lineBox.y, button: 'left' })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to, y: lineBox.y, button: 'left', clickCount: 1 })
  await sleep(380)
  return evaluate(`(() => {
    const bg = document.querySelector('.cm-selectionLayer .cm-selectionBackground')
    const t = document.createElement('div')
    t.style.background = 'var(--n-selection)'
    document.body.appendChild(t)
    const want = getComputedStyle(t).backgroundColor
    t.style.color = 'var(--n-selection-fg)'
    const wantFg = getComputedStyle(t).color
    t.remove()
    // canvas 采样出 RGB，好在页里算对比度（oklch 字符串本身没法直接比）
    let rgb = null
    if (bg) {
      const c = document.createElement('canvas')
      c.width = c.height = 1
      const ctx = c.getContext('2d')
      ctx.fillStyle = getComputedStyle(bg).backgroundColor
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      rgb = [d[0], d[1], d[2]]
    }
    const lum = (r, g, b) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    let contrast = null
    if (rgb) {
      const fg = getComputedStyle(bg).color.match(/\\d+/g).slice(0, 3).map(Number)
      const a = lum(...rgb), b = lum(...fg)
      contrast = Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100
    }
    return {
      theme: document.documentElement.dataset.theme,
      selected: window.getSelection()?.toString() ?? '',
      hasLayer: !!bg,
      bg: bg ? getComputedStyle(bg).backgroundColor : null,
      sameAsVar: bg ? getComputedStyle(bg).backgroundColor === want : false,
      isOldPurple: bg ? /215, 212, 240/.test(getComputedStyle(bg).backgroundColor) : false,
      rgb, contrast, wantFg, fgMatches: bg ? getComputedStyle(bg).color === wantFg : false,
    }
  })()`)
}

/** 切主题必须走真按钮：直接写 <html data-theme> 会被 store 覆盖回来 */
const setTheme = (want) => evaluate(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms))
  for (let i = 0; i < 4; i++) {
    if ((document.documentElement.dataset.theme || 'light') === '${want}') break
    document.querySelector('[data-role="theme-toggle"]')?.click()
    await w(340)
  }
  return document.documentElement.dataset.theme || 'light'
})()`)

const lightTheme = await setTheme('light')
await sleep(280)
const lightSel = await measureSelection()
ok(
  '4.浅色：编辑区选区色就是 --n-selection（不再是 CM 内置的浅紫）',
  lightTheme === 'light' && !lightSel.err && lightSel.hasLayer && lightSel.selected.length > 0 &&
    lightSel.sameAsVar && !lightSel.isOldPurple && lightSel.fgMatches &&
    lightSel.contrast !== null && lightSel.contrast >= 4.5,
  lightSel,
)

/* 切深色再量一次 —— 用户抱怨的正是深色 */
const realTheme = await setTheme('dark')
await sleep(280)
const darkSel = await measureSelection()
ok(
  '5.深色：同一套颜色跟着主题走，仍然看得清（不再是一块浅紫压白字）',
  realTheme === 'dark' && !darkSel.err && darkSel.hasLayer &&
    darkSel.sameAsVar && !darkSel.isOldPurple && darkSel.fgMatches &&
    darkSel.contrast !== null && darkSel.contrast >= 4.5,
  darkSel,
)

/* ══ 3. 随包字体 ══ */
const font = await evaluate(`(async () => {
  await document.fonts.ready
  const faces = [...document.fonts].map(f => ({ fam: f.family, status: f.status, weight: f.weight }))
  const c = document.createElement('canvas').getContext('2d')
  const probe = '笔记应用 Nota 2026'
  c.font = '20px NanxiXinyuanti'
  const w1 = c.measureText(probe).width
  c.font = '20px sans-serif'
  const w2 = c.measureText(probe).width
  const of = (el) => (el ? getComputedStyle(el).fontFamily : null)
  return {
    faces,
    check: document.fonts.check('16px NanxiXinyuanti'),
    bodyFam: getComputedStyle(document.body).fontFamily,
    editorFam: of(document.querySelector('.cm-content')),
    previewFam: of(document.querySelector('.md-body')),
    sidebarFam: of(document.querySelector('.panel')),
    differs: Math.abs(w1 - w2) > 1,
    w1: Math.round(w1 * 100) / 100, w2: Math.round(w2 * 100) / 100,
  }
})()`)
ok(
  '6.字体：圆体随包加载，并且真的被用上了（不只是写在字体栈里）',
  font.check === true &&
    font.faces.some((f) => f.fam === 'NanxiXinyuanti' && f.status === 'loaded') &&
    /^NanxiXinyuanti/.test(font.bodyFam) &&
    /^NanxiXinyuanti/.test(font.editorFam || '') &&
    /^NanxiXinyuanti/.test(font.sidebarFam || '') &&
    // 预览区没开时元素不在 DOM 里，这时不判它
    (!font.previewFam || /^NanxiXinyuanti/.test(font.previewFam)) &&
    font.differs,
  { check: font.check, faces: font.faces, bodyFam: font.bodyFam, editorFam: font.editorFam, previewFam: font.previewFam, sidebarFam: font.sidebarFam, w1: font.w1, w2: font.w2, differs: font.differs },
)

/* 行号反而要留在等宽栈里 —— 圆体的数字是比例宽，11 和 111 长度不一样，右对齐也压不齐 */
const gutter = await evaluate(`(() => {
  const g = document.querySelector('.cm-gutters')
  return { fam: g ? getComputedStyle(g).fontFamily : null }
})()`)
ok('7.行号留在等宽栈里（比例字体的数字会压不齐）', /Cascadia Code|Consolas/.test(gutter.fam || ''), gutter)

ok('8.等宽栈末尾也挂了圆体（代码块里的中文不掉回系统字体）',
  /NanxiXinyuanti/.test(await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--n-font-mono')`)),
)

ok('9.零 JS 异常', errors.length === 0, errors.slice(0, 3))

await close()

const failed = results.filter((r) => !r.pass)
console.log('')
if (failed.length) {
  console.log(`FAILED ${failed.length}/${results.length}`)
  process.exit(1)
}
console.log(`ALL PASS (${results.length})`)
