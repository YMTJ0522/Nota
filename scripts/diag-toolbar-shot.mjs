/**
 * 拍工具栏：光标不在代码块里 vs 在代码块里，那颗「标行」按钮的两种样子。
 * 顺手拍一张悬停提示——「怕别人不会用」这件事靠的就是这行字。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4413)
const { send, evaluate, sleep, shot, close } = await launch({ port: PORT, size: [1500, 950] })

const NOTE = ['# 工具栏靶子', '', '正文一段。', '', '```ts', 'export const a = 1', 'export const b = 2', '```', ''].join('\n')
const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/工具栏靶子.md': NOTE },
  tree: [...makeTree(), { type: 'file', name: '工具栏靶子.md', path: '/ws/工具栏靶子.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' }],
})

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1200)
await evaluate(`localStorage.setItem('nota-tour-seen', '1')`)
await send('Page.reload', {})
await sleep(1400)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)
await evaluate(`document.querySelector('.col-tab[data-view="notes"]')?.click()`)
await sleep(400)
await evaluate(openNoteExpr('工具栏靶子'))
await sleep(1500)
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="编辑模式"]')?.click()`)
await sleep(900)

async function clickLine(text) {
  const raw = await evaluate(`
    (() => { var el = [...document.querySelectorAll('.cm-line')].find((e) => (e.textContent || '').trim() === ${JSON.stringify(text)});
      if (!el) return null; var b = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.x + 10), y: Math.round(b.y + b.height / 2) }); })()
  `)
  const p = JSON.parse(raw)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await sleep(320)
}

/** 工具栏那一整条 */
async function shootBar(file) {
  const box = JSON.parse(await evaluate(`
    (() => { var t = document.querySelector('.tb');
      if (!t) { t = document.querySelector('[data-role="line-marks"]').closest('div'); }
      var r = t.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }); })()
  `))
  const scrollY = await evaluate(`window.scrollY`)
  await shot(file, { ...box, y: box.y + scrollY })
  return box
}

/* 光标在正文里（不在代码块）——按钮应该是灰的 */
await clickLine('正文一段。')
await sleep(300)
await shootBar('.keep/marks/bar-idle.png')
console.log('idle:', await evaluate(`(() => { var b = document.querySelector('[data-role="line-marks"]');
  return JSON.stringify({ cls: b.className, title: b.title, opacity: getComputedStyle(b).opacity }); })()`))

/* 位置：标行应当紧跟在「行内代码」后面、是这一栏的最后一颗 */
console.log('gaps:', await evaluate(`
  (() => {
    var marks = document.querySelector('[data-role="line-marks"]');
    var prev = marks.previousElementSibling;
    var a = prev.getBoundingClientRect(), b = marks.getBoundingClientRect();
    return JSON.stringify({
      prevTitle: prev.title,
      prevToMarks: Math.round(b.left - a.right),
      sameGroup: prev.parentElement === marks.parentElement,
      isGroupLast: marks.nextElementSibling === null,
    });
  })()
`))

/* 光标进代码块——亮起来 */
await clickLine('export const a = 1')
await sleep(300)
await shootBar('.keep/marks/bar-on.png')
console.log('in-code:', await evaluate(`(() => { var b = document.querySelector('[data-role="line-marks"]');
  return JSON.stringify({ cls: b.className, title: b.title, opacity: getComputedStyle(b).opacity }); })()`))

/* 悬停：提示语是不是「标出第 2 行」 */
await evaluate(`(() => { var b = document.querySelector('[data-role="line-marks"]');
  var r = b.getBoundingClientRect(); window.__hov = { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)
const hov = JSON.parse(await evaluate(`JSON.stringify(window.__hov)`))
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hov.x, y: hov.y })
await sleep(1400)
await shootBar('.keep/marks/bar-hover.png')

/* 浅色主题下再看一眼标出来的行——默认主题是浅色，多数人看到的都是这一版 */
await clickLine('export const b = 2')
await sleep(200)
await evaluate(`document.querySelector('[data-role="line-marks"]')?.click()`)
await sleep(400)
await evaluate(`document.documentElement.setAttribute('data-theme', 'light')`)
await evaluate(`(() => { var v = window.__notaView; v.dispatch({ selection: { anchor: v.state.doc.length } }); })()`)
await sleep(500)
const codeBox = JSON.parse(await evaluate(`
  (() => { var el = document.querySelector('.cm-content').getBoundingClientRect();
    return JSON.stringify({ x: Math.round(el.x), y: Math.round(el.y), width: Math.round(el.width), height: Math.round(el.height) }); })()
`))
await shot('.keep/marks/marked-light.png', { ...codeBox, y: codeBox.y + (await evaluate(`window.scrollY`)) })

await close()
