/**
 * 补全行为体检。
 *
 * 2.7.3 起正文（围栏以外）一个候选都不给：那半套是给「中文里引一下前文术语」
 * 准备的，实际没人用得上，反而在中文组字时冒英文词。代码块内的补全照旧。
 *
 * 两条断言：
 *  1. 正文输入 `syst` → 不出现候选层；
 *  2. 围栏代码块里输入 `syst` → 出现 `systemctl` 候选。
 *
 * 前置：先 `npm run build`（读 dist）。用法：node scripts/verify-completion.mjs
 */
import { launch } from './cdp-harness.mjs'
import { makeInject } from './fake-workspace.mjs'

const NOTE = [
  '# 补全体检',
  '',
  '正文里提到 systemctl restart 这个词。',
  '',
  '```bash',
  'systemctl restart nginx',
  '```',
].join('\n')

const { send, evaluate, sleep, close } = await launch({ port: 4479, size: [1400, 900] })
const INJECT = makeInject({
  notes: { '/ws/补全体检.md': NOTE },
  tree: [
    { type: 'file', name: '补全体检.md', path: '/ws/补全体检.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' },
  ],
})

await send('Page.navigate', { url: 'http://127.0.0.1:4479/' })
await sleep(1300)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1300)
await evaluate(INJECT)
await sleep(900)
await evaluate(`(() => {
  const r = [...document.querySelectorAll('.nlist .nl-item')].find(b => (b.textContent||'').includes('补全体检'))
  r?.click(); return !!r
})()`)
await sleep(1800)

/** 把光标放到「包含 needle 的那一行」的行尾，返回是否成功 */
async function caretTo(needle, atEnd = true) {
  return await evaluate(`(() => {
    const root = document.querySelector('.cm-content')
    if (!root) return 'no editor'
    root.focus()
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let n, hit = null
    while ((n = w.nextNode())) if (n.textContent.includes(${JSON.stringify(needle)})) hit = n
    if (!hit) return 'text not found'
    const sel = window.getSelection()
    sel.collapse(hit, ${atEnd ? 'hit.textContent.length' : '0'})
    document.dispatchEvent(new Event('selectionchange'))
    return 'ok'
  })()`)
}

async function typeText(t) {
  await send('Input.insertText', { text: t })
  await sleep(500)
}

const hasTip = () =>
  evaluate(`(() => {
    const t = document.querySelector('.cm-tooltip-autocomplete')
    if (!t) return { open: false }
    return { open: true, options: [...t.querySelectorAll('.cm-completionLabel')].map(e => e.textContent).slice(0, 6) }
  })()`)

const res = {}

/* ── 1. 正文：输入英文前缀，不该有任何候选 ── */
res.caret1 = await caretTo('这个词')
await typeText('syst')
res.prose = await hasTip()

/* ── 2. 代码块：同样输入，应当弹候选 ── */
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`)
await sleep(200)
// 先撤掉正文里刚打的字，免得污染
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
await sleep(150)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
await sleep(150)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
await sleep(150)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
await sleep(300)

res.caret2 = await caretTo('nginx')
// 在代码块里另起一行再输入，否则前缀会粘成 nginx+syst
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await sleep(400)
await typeText('syst')
res.code = await hasTip()

console.log('光标(正文):', res.caret1)
console.log('正文输入 syst →', JSON.stringify(res.prose))
console.log('光标(代码块):', res.caret2)
console.log('代码块输入 syst →', JSON.stringify(res.code))

const ok1 = res.prose.open === false
const ok2 = res.code.open === true
console.log('')
console.log(ok1 ? '✓ 正文不弹候选' : '✗ 正文仍在弹候选')
console.log(ok2 ? '✓ 代码块仍弹候选' : '✗ 代码块补全被误伤')

await close()
process.exit(ok1 && ok2 ? 0 : 1)
