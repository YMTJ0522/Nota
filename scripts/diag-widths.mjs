/**
 * 各档窗宽下三栏各占多少，编辑区有没有被挤到站不住。
 *
 * 资料栏改成常驻之后，这是唯一的代价点：以前放不下时可以整栏收掉顶账，
 * 现在只能让侧栏和资料栏各自退到自己的下限。这里逐档量一遍，
 * 确认编辑区始终不低于它的最低宽度（store 里的 EDITOR_MIN_WIDTH = 520）。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const INJECT = makeInject({})
const EDITOR_MIN = 520

const WIDTHS = [960, 1024, 1100, 1280, 1500, 1800]
for (let wi = 0; wi < WIDTHS.length; wi++) {
  const W = WIDTHS[wi]
  const PORT = 4420 + wi
  const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [W, 1000] })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await sleep(1500)
  await evaluate('localStorage.clear()')
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await sleep(1600)
  await evaluate(INJECT)
  await evaluate(`document.querySelector('.cta')?.click()`)
  await sleep(1100)
  await evaluate(INJECT)
  await sleep(600)
  await evaluate(openNoteExpr('甲笔记'))
  await sleep(1100)

  const m = JSON.parse(
    await evaluate(`
      (() => {
        var q = (s) => document.querySelector(s)
        var w = (s) => { var e = q(s); return e ? Math.round(e.getBoundingClientRect().width) : 0 }
        var win = window.innerWidth
        var side = w('.panel')
        var col = w('.col')
        var ed = w('.pane') || w('.editor-pane') || (q('.cm-editor') ? Math.round(q('.cm-editor').closest('section, div[class]').getBoundingClientRect().width) : 0)
        return JSON.stringify({ win: win, side: side, col: col, ed: ed, sum: side + col + ed,
          overflow: document.documentElement.scrollWidth > win })
      })()
    `),
  )
  const pass = m.ed >= EDITOR_MIN - 2 && !m.overflow
  console.log(
    `${pass ? 'PASS' : 'FAIL'} ${String(W).padStart(4)}px  侧栏 ${String(m.side).padStart(3)} + 资料栏 ${String(m.col).padStart(3)} + 编辑区 ${String(m.ed).padStart(4)} = ${String(m.sum).padStart(4)}${m.overflow ? '  ← 横向溢出！' : ''}`,
  )
  if (errors.length) console.log('   异常:', errors.slice(0, 3))
  await close()
}
