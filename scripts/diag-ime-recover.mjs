/**
 * 诊断 8：组字结束之后，补全还能不能弹。
 *
 * 只在一个地方做完全部动作 —— 早先那份要在「正文」和「代码块」之间来回跳，
 * 而跳转靠的是模拟按键/点坐标，光标跑飞之后量到的全是假象
 * （文档被改成了别的形状，补全当然不弹）。
 *
 * 这次全程不挪窝：就在围栏里那一行上，先弹一次 → 组一次字 → 再弹一次。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4412)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 950] })

/* 围栏放在最前面：光标一落就在第 3 行，不用导航 */
const CODE = ['```python', 'x = 1', '', '```', ''].join('\n')
const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/IME.md': CODE },
  tree: [...makeTree(), { type: 'file', name: 'IME.md', path: '/ws/IME.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' }],
})

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1500)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)
await evaluate(`document.querySelector('.col-tab[data-view="notes"]')?.click()`)
await sleep(400)
await evaluate(openNoteExpr('IME'))
await sleep(1500)
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="编辑模式"]')?.click()`)
await sleep(900)

const TIP = `
(() => {
  var t = document.querySelector('.cm-tooltip-autocomplete');
  if (!t) return JSON.stringify({ open: false, n: 0, items: [] });
  return JSON.stringify({ open: true, n: t.querySelectorAll('.cm-completionLabel').length,
    items: [...t.querySelectorAll('.cm-completionLabel')].map((e) => (e.textContent || '').slice(0, 22)) });
})()
`
const DOC = `(() => JSON.stringify([...document.querySelectorAll('.cm-line')].map((e) => e.textContent)))()`

/* 落在第 3 行（围栏里那行空的）：点第 2 行下沿往下一点 */
async function land() {
  const raw = await evaluate(`
    (() => {
      var ls = [...document.querySelectorAll('.cm-line')];
      var t = ls[2];
      if (!t) return null;
      var b = t.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.x + 4), y: Math.round(b.y + Math.min(10, b.height / 2)) });
    })()
  `)
  if (!raw || raw === 'null') return false
  const box = JSON.parse(raw)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(400)
  return true
}

async function type(text) {
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, code: 'Key' + ch.toUpperCase() })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + ch.toUpperCase() })
    await sleep(50)
  }
  await sleep(600)
}
async function backspace(n) {
  for (let i = 0; i < n; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await sleep(60)
  }
  await sleep(350)
}
async function esc() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await sleep(350)
}

console.log('起始文档:', await evaluate(DOC.replace(/\n/g, ' ')))
console.log('落点:', await land())

const a = JSON.parse(await evaluate(TIP.replace(/\n/g, ' ')))
await type('if')
const b = JSON.parse(await evaluate(TIP.replace(/\n/g, ' ')))
console.log(`1. 组字之前敲「if」→ ${JSON.stringify(b)}  ${b.open ? 'PASS' : 'FAIL'}`)
console.log('   文档:', await evaluate(DOC.replace(/\n/g, ' ')))

await esc()
await backspace(2)

/* 组一次字：拼音没上屏 */
await send('Input.imeSetComposition', { text: 'xsys', selectionStart: 4, selectionEnd: 4 })
await sleep(800)
const c = JSON.parse(await evaluate(TIP.replace(/\n/g, ' ')))
console.log(`2. 组字期间（拼音 xsys 未上屏）→ ${JSON.stringify(c)}  ${!c.open ? 'PASS' : 'FAIL'}`)

await send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
await sleep(300)
await send('Input.insertText', { text: '写点中文' })
await sleep(800)
const d = JSON.parse(await evaluate(TIP.replace(/\n/g, ' ')))
console.log(`3. 上屏之后 → ${JSON.stringify(d)}  ${!d.open ? 'PASS' : 'FAIL'}`)
console.log('   文档:', await evaluate(DOC.replace(/\n/g, ' ')))

/* 清掉那几个字，再敲一次 */
await backspace(4)
await type('if')
const e = JSON.parse(await evaluate(TIP.replace(/\n/g, ' ')))
console.log(`4. 组字结束之后再敲「if」→ ${JSON.stringify(e)}  ${e.open ? 'PASS' : 'FAIL'}`)
console.log('   文档:', await evaluate(DOC.replace(/\n/g, ' ')))

console.log('\n控制台异常:', errors.length ? errors.slice(0, 5) : '无')
await close()
