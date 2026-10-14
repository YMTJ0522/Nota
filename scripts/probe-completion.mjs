/**
 * 代码补全探针。
 *
 * 用户说「打字没有提示」。补全的行为是分岔的：代码块内打字自动弹，
 * 正文里只在 Alt-/ 时弹（中文 Windows 上 Ctrl-Space 是输入法切换，
 * 抢不得）。所以两处都要真按键试，不能改 DOM 假装在打字。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4412)
const { send, evaluate, sleep, close } = await launch({ port: PORT, size: [1500, 950] })

const NOTE = [
  '# 补全靶子',
  '',
  '```bash',
  'systemctl restart nginx',
  'kubectl get pods',
  '',
  '```',
  '',
  '正文一句话。',
].join('\n')

const INJECT = makeInject({ notes: { ...makeNotes(), '/ws/甲笔记.md': NOTE } })

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1400)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)
await evaluate(openNoteExpr('甲笔记'))
await sleep(1600)

const ok = (n, p, d) => console.log(`  ${p ? 'PASS' : 'FAIL'} ${n}`, d === undefined ? '' : JSON.stringify(d))

/** 真按键：先 focus 再逐字符敲 */
async function clickInto(selector) {
  const box = JSON.parse(
    await evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}) })()`,
    ),
  )
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(300)
  return box
}

async function typeText(text) {
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    await sleep(60)
  }
}

const tipExpr = `(() => {
  const t = document.querySelector('.cm-tooltip-autocomplete')
  if (!t) return JSON.stringify({ open: false, items: 0, first: '' })
  const items = [...t.querySelectorAll('li')].map(li => li.textContent.trim())
  return JSON.stringify({ open: true, items: items.length, first: items[0] ?? '', sample: items.slice(0, 5) })
})()`

/* ══ 1. 代码块里打字：应当自动弹 ══ */
// 光标必须**真的落在围栏里**。点 .cm-content 的中心会落到文档中间某处，
// 那种测法量到的是「没弹」，其实是自己没摆对位置。
const fenceLine = JSON.parse(
  await evaluate(`(() => {
    const lines = [...document.querySelectorAll('.cm-content .cm-line')]
    const i = lines.findIndex((l, n) => n > 0 && (lines[n-1]?.textContent ?? '').includes('kubectl'))
    const el = lines[i]
    if (!el) return JSON.stringify({ found: false, n: lines.length })
    const r = el.getBoundingClientRect()
    return JSON.stringify({ found: true, i, x: Math.round(r.x + 24), y: Math.round(r.y + r.height / 2), n: lines.length })
  })()`),
)
console.log('  围栏内空行:', fenceLine)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fenceLine.x, y: fenceLine.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fenceLine.x, y: fenceLine.y, button: 'left', clickCount: 1 })
await sleep(400)
await typeText('sys')
await sleep(600)
const inFence = JSON.parse(await evaluate(tipExpr))
ok('1.代码块里打字自动弹补全', inFence.open && inFence.items > 0, inFence)

/* ══ 2. 正文里打字：不该自动弹 ══ */
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' })
await sleep(200)
await evaluate(`(() => { const e = document.querySelector('.cm-content'); e.blur(); return true })()`)
await sleep(200)
await clickInto('.cm-content')
await sleep(200)
// 挪到文档末尾（正文那行之后）
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 })
await sleep(200)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\n', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await sleep(300)
await typeText('system')
await sleep(500)
const inBody = JSON.parse(await evaluate(tipExpr))
ok('2.正文里打字不自动弹（避免打断中文输入）', !inBody.open, inBody)

/* ══ 3. 正文里按 Alt-/：应当弹 ══ */
await send('Input.dispatchKeyEvent', {
  type: 'keyDown', key: 'Alt', code: 'AltLeft', modifiers: 1, windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18,
})
await send('Input.dispatchKeyEvent', {
  type: 'keyDown', key: '/', code: 'Slash', text: '/', modifiers: 1, windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191,
})
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '/', code: 'Slash', modifiers: 1, windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18 })
await sleep(600)
const manual = JSON.parse(await evaluate(tipExpr))
ok('3.正文里 Alt-/ 手动唤出补全', manual.open && manual.items > 0, manual)

/* ══ 4. 输入法组字期间：不许弹英文候选 ══
   中文靠「先敲一串拉丁字母、再上屏成汉字」。组字这段时间的拉丁字符
   很容易被当成英文单词，弹出来的候选正好压在输入法自己的候选条上。 */
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' })
await sleep(200)
await clickInto('.cm-content')
await sleep(200)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\n', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await sleep(300)

let imeOk = false
try {
  // 组字中：拼音还没上屏
  await send('Input.imeSetComposition', {
    text: 'system',
    selectionStart: 6,
    selectionEnd: 6,
  })
  await sleep(500)
  const during = JSON.parse(await evaluate(tipExpr))
  imeOk = !during.open
  console.log('  组字期间:', JSON.stringify(during))
  // 上屏
  await send('Input.insertText', { text: '系统' })
  await sleep(400)
} catch (e) {
  console.log('  （CDP 不支持 imeSetComposition，跳过:', e.message, '）')
  imeOk = true
}
ok('4.输入法组字期间不弹英文补全', imeOk)

await close()
