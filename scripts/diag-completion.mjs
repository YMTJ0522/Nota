/**
 * 诊断 7：代码补全到底弹不弹。
 *
 * 补全要**真按键**才作数（直接改 DOM 不会触发 CodeMirror 的输入处理），
 * 组字要用真的 IME 合成事件，不能拿普通输入冒充。
 * 光标一律**点目标行**落位 —— 早先用 Ctrl+Home + 方向键，键位修饰符会串，
 * 光标跑飞之后量到的全是假象。
 *
 * 三问：
 *   1. 代码块里打字，候选会不会自己弹出来？
 *   2. 正文里打字，会不会自己弹？（不该 —— 写中文时每敲一下弹一层英文词是灾难）
 *   3. 组字期间（拼音还没上屏）会不会弹？组字结束之后还能不能弹？（不该弹 / 必须能）
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4411)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 950] })

const FENCE = '```python'
const PROSE = '正文 systemctl 出现过一次。'
const CODE = ['# 补全靶子', '', PROSE, '', FENCE, '', '```', ''].join('\n')
const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/补全靶子.md': CODE },
  tree: [...makeTree(), { type: 'file', name: '补全靶子.md', path: '/ws/补全靶子.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' }],
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
await evaluate(openNoteExpr('补全靶子'))
await sleep(1500)
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="编辑模式"]')?.click()`)
await sleep(900)

const TIP = `
(() => {
  var t = document.querySelector('.cm-tooltip-autocomplete');
  if (!t) return JSON.stringify({ open: false, n: 0, items: [] });
  var its = [...t.querySelectorAll('.cm-completionLabel')].map((e) => (e.textContent || '').slice(0, 22));
  return JSON.stringify({ open: true, n: its.length, items: its.slice(0, 6) });
})()
`
const DOC = `(() => JSON.stringify([...document.querySelectorAll('.cm-line')].map((e) => e.textContent)))()`

/**
 * 点某一行落光标。
 *
 * @param after 有内容就点这一行，没内容（空行）就点它**后面**那一行 ——
 *              围栏里那行是空的，靠文字认不出来，只能靠相对位置。
 */
async function clickLine(text, offset = 0) {
  const raw = await evaluate(`
    (() => {
      var ls = [...document.querySelectorAll('.cm-line')];
      var i = ls.findIndex((e) => (e.textContent || '') === ${JSON.stringify(text)});
      if (i < 0) return null;
      var t = ls[i + ${offset}];
      if (!t) return null;
      var b = t.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.x + 6), y: Math.round(b.y + b.height / 2) });
    })()
  `)
  if (raw === 'null' || !raw) return false
  const box = JSON.parse(raw)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(350)
  return true
}

async function type(text) {
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, code: 'Key' + ch.toUpperCase() })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + ch.toUpperCase() })
    await sleep(45)
  }
  await sleep(550)
}

async function backspace(n) {
  for (let i = 0; i < n; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await sleep(50)
  }
  await sleep(300)
}

async function esc() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await sleep(300)
}

const say = (n, text, want, got) => {
  const open = got.open
  const pass = want === open
  console.log(`${pass ? 'PASS' : 'FAIL'} ${n}. ${text}`, JSON.stringify(got), `（期望${want ? '弹' : '不弹'}）`)
  return pass
}

const results = []

/* ── 1. 代码块内 ── */
await clickLine(FENCE, 1)
results.push(say(1, '代码块内敲「if」', true, JSON.parse(await evaluate(TIP.replace(/\n/g, ' ')))))
await backspace(2)

results.push(say(2, '代码块内敲「sys」（文档词 systemctl）', true, JSON.parse(await evaluate(TIP.replace(/\n/g, ' ')))))
await esc()
await backspace(3)

/* ── 2. 正文里 ── */
await clickLine(PROSE)
results.push(say(3, '正文里敲「sys」', false, JSON.parse(await evaluate(TIP.replace(/\n/g, ' ')))))

await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Alt', code: 'AltLeft', modifiers: 1 })
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', code: 'Slash', text: '/', modifiers: 1 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '/', code: 'Slash', modifiers: 1 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft' })
await sleep(800)
results.push(say(4, '正文里按 Alt-/', true, JSON.parse(await evaluate(TIP.replace(/\n/g, ' ')))))
await esc()
await backspace(3)

/* ── 3. 组字 ── */
await clickLine(PROSE)
await send('Input.imeSetComposition', { text: 'sys', selectionStart: 3, selectionEnd: 3 })
await sleep(800)
results.push(say(5, '组字期间（拼音 sys 未上屏）', false, JSON.parse(await evaluate(TIP.replace(/\n/g, ' ')))))

await send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
await sleep(300)
await send('Input.insertText', { text: '系统' })
await sleep(800)
results.push(say(6, '上屏之后', false, JSON.parse(await evaluate(TIP.replace(/\n/g, ' ')))))

/* ── 4. 关键：组字结束后回到代码块，还能不能弹 ── */
await clickLine(FENCE, 1)
await type('if')
results.push(say(7, '组字结束后回到代码块敲「if」（必须恢复）', true, JSON.parse(await evaluate(TIP.replace(/\n/g, ' ')))))

console.log('\n文档最终内容:', await evaluate(DOC.replace(/\n/g, ' ')))
console.log(`\n通过 ${results.filter(Boolean).length}/${results.length}`)
console.log('控制台异常:', errors.length ? errors.slice(0, 5) : '无')
await close()
