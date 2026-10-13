/**
 * round14 —— 2.2.5：代码块语言标签、大纲不漏代码注释、代码补全
 *
 * 三条都来自同一张截图，各自有明确的「不是玄学」的判定方式：
 *
 *  1. 语言标签点不动 —— 量 `elementFromPoint` 命中的是不是按钮本身。
 *     先前命中的是 `.cm-line`：`.cm-md-codeblock` 为了底色对齐加了
 *     `position:relative`，让那一行变成定位元素，把绝对定位的标签按 DOM 顺序盖住了。
 *     只看「菜单有没有出现」是不够的 —— 那样分不清是没点到还是没接住。
 *  2. 大纲把代码块里的 `# 注释` 当成 H1 —— 断言大纲里**没有**那些字符串。
 *     特意造了四反引号里含三反引号、波浪号里含反引号这两种：旧实现是
 *     「行首见到 ``` 就取反」，这两类的配对会错乱，块内的注释就漏出来了。
 *  3. 代码补全 —— 用真实按键打字，断言弹层开着、候选里有文档里那个词、
 *     以及**正文里打字不弹**（中文写作时每敲一下弹一层英文词是灾难）。
 *     这里还钉住一条容易悄悄破掉的：词的正则不能收 `-` 和 `.`，
 *     否则在 `uname -a` 后面接着打字取到的 token 是 `-asys`，前缀全落空。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4396)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 950] })
const results = []
const ok = (name, pass, data) => {
  results.push({ name, pass, data })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`, data === undefined ? '' : JSON.stringify(data))
}

/* 样本里故意埋了三种会让「见到 ``` 就取反」错乱的围栏 */
const LEAKS = ['服务在 systemctl 里管', '注释不该进大纲', '这个也不该进大纲', '块里的注释']
const NOTE = [
  '# 命令笔记',
  '',
  '## 2.1 命令格式',
  '',
  '```Bash',
  '# 服务在 systemctl 里管',
  'systemctl restart nginx',
  'df -h',
  '```',
  '',
  '## 2.2 系统信息',
  '',
  '```bash',
  'uname -a',
  '```',
  '',
  '### 2.3 文档里含围栏',
  '',
  '````md',
  '```bash',
  '# 注释不该进大纲',
  '```',
  '````',
  '',
  '~~~md',
  '```shell',
  '# 这个也不该进大纲',
  '```',
  '~~~',
  '',
  '## 真的标题',
  '',
  '正文里写着 systemctl 是很常见的说法。',
  '',
].join('\n')

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1400)
await evaluate('localStorage.clear()')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1700)

const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/命令笔记.md': NOTE },
  tree: [
    ...makeTree(),
    { type: 'file', name: '命令笔记.md', path: '/ws/命令笔记.md', tags: [], starred: false, mtime: Date.now() - 5_000, excerpt: '' },
  ],
})
await evaluate(INJECT)
await evaluate("document.querySelector('.cta')?.click()")
await sleep(1200)
await evaluate(INJECT)
await sleep(700)
await evaluate(openNoteExpr('命令笔记'))
await sleep(1400)

/* ══ 1. 大纲：代码块里的 # 注释一条都不许出现 ══ */
await evaluate(`document.querySelector('.col-tab[data-view="outline"]')?.click()`)
await sleep(800)
const outline = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.ov-item')].map(e => e.textContent.trim()))`))
const leaked = outline.filter((t) => LEAKS.some((s) => t.includes(s)))
ok(
  '1.大纲里没有代码块内的 # 注释（含四反引号 / 波浪号那两类）',
  outline.length >= 4 && leaked.length === 0 && outline.some((t) => t.includes('真的标题')),
  { count: outline.length, leaked, outline: outline.slice(0, 8) },
)

/* 回到编辑视图，后面的断言都要编辑器 */
await evaluate(`document.querySelector('.col-tab[data-view="notes"]')?.click()`)
await sleep(700)

/* ══ 2. 语言标签：看得见，也要点得到 ══ */
const chip = JSON.parse(
  await evaluate(`(() => {
    const b = document.querySelector('.cm-code-lang-btn')
    if (!b) return 'null'
    const r = b.getBoundingClientRect()
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
    const hit = document.elementFromPoint(x, y)
    return JSON.stringify({ x, y, label: (b.textContent || '').trim(), onTop: hit === b || b.contains(hit), hit: hit ? String(hit.className || hit.tagName) : null })
  })()`),
)

async function clickAt(pos) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(90)
  }
  await sleep(340)
}

/* ```Bash 要认成规范名（不是原样把 token 显示出来） */
ok('2.围栏上写 ```Bash，标签显示规范名', !chip.err && /Shell|Bash/.test(chip.label || ''), chip)

if (!chip.err) await clickAt(chip)
const menu = JSON.parse(
  await evaluate(`(() => {
    const m = document.querySelector('.n-menu')
    if (!m) return JSON.stringify({ open: false })
    const rows = [...m.querySelectorAll('.n-menu-item')].map(e => e.textContent.trim())
    const on = m.querySelector('.n-menu-item.on')
    return JSON.stringify({ open: true, head: m.querySelector('.n-menu-head')?.textContent || '', total: rows.length, on: on ? on.textContent.trim() : null })
  })()`),
)
ok('3.点标签真的开菜单（不只是看得见）', menu.open && menu.total > 10, menu)

/* 选一个别的语言，要真的写进围栏。
   刻意挑 Python —— 候选有十六项而列表限高自滚，Python 在首屏之外，
   必须先把目标行滚进视野再点，否则量到的坐标落在列表外面，
   点下去只是「菜单自己关了」，看着像「点得动但没生效」。 */
const pyRow = JSON.parse(
  await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const rows = [...document.querySelectorAll('.n-menu-item')]
    const r = rows.find(e => e.querySelector('.n-menu-name')?.textContent === 'Python')
    if (!r) return JSON.stringify({ err: 'no python row' })
    r.scrollIntoView({ block: 'center' })
    await wait(260)
    const b = r.getBoundingClientRect()
    const list = document.querySelector('.cm-lang-list')?.getBoundingClientRect()
    return JSON.stringify({
      x: Math.round(b.left + 20),
      y: Math.round(b.top + b.height / 2),
      insideList: !!list && b.top >= list.top - 1 && b.bottom <= list.bottom + 1,
      stillOpen: !!document.querySelector('.n-menu'),
    })
  })()`),
)
let applied = { err: 'no row' }
if (pyRow && !pyRow.err) {
  await clickAt(pyRow)
  applied = JSON.parse(
    await evaluate(`(() => {
      const lines = [...document.querySelectorAll('.cm-content .cm-line')].map(l => l.textContent)
      const i = lines.findIndex(t => t.trim() === '# 服务在 systemctl 里管' || t.trim() === 'systemctl restart nginx')
      const fence = i > 0 ? lines[i - 1] : null
      return JSON.stringify({ fence, chip: document.querySelector('.cm-code-lang-btn')?.textContent?.trim() || null, menuGone: !document.querySelector('.n-menu') })
    })()`),
  )
}
ok(
  '4.选了 Python 就写进围栏、标签跟着换、菜单收起',
  !applied.err && applied.fence === '```python' && applied.chip === 'Python' && applied.menuGone === true,
  { ...applied, row: pyRow },
)

/* ══ 3. 补全 ══ */
async function key(k, extra = {}) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: extra.code ?? k, windowsVirtualKeyCode: extra.vk ?? 0, ...extra })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: extra.code ?? k, windowsVirtualKeyCode: extra.vk ?? 0 })
  await sleep(120)
}
/* 手动唤出键是 Alt-/ —— 特意不用 Ctrl+Space：中文 Windows 上那是输入法的
   中英切换，编辑器抢走它等于让人切不回中文。 */
async function manualComplete() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 1 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '/', code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 1 })
  await sleep(520)
}
async function typeText(text) {
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, code: 'Key' + ch.toUpperCase() })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + ch.toUpperCase() })
    await sleep(85)
  }
}
async function clickLineEnd(text) {
  const p = JSON.parse(
    await evaluate(`(() => {
      const el = [...document.querySelectorAll('.cm-content .cm-line')].find(l => l.textContent.includes(${JSON.stringify(text)}))
      if (!el) return 'null'
      const r = el.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2) })
    })()`),
  )
  if (!p || p.err) throw new Error('找不到行 ' + text)
  await clickAt(p)
  await key('End', { code: 'End' })
  await sleep(200)
}
const popup = async () =>
  JSON.parse(
    await evaluate(`(() => {
      const t = document.querySelector('.cm-tooltip-autocomplete')
      if (!t) return JSON.stringify({ open: false })
      const r = t.getBoundingClientRect()
      const hit = document.elementFromPoint(Math.round(r.left + 30), Math.round(r.top + 10))
      return JSON.stringify({ open: true, items: [...t.querySelectorAll('li')].map(e => e.textContent.trim()).slice(0, 10), onTop: !!hit && !!t.contains(hit) })
    })()`),
  )
const lineTexts = async () => JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.cm-content .cm-line')].map(l => l.textContent))`))

/* 3a. 代码块里新起一行打字 → 自动弹，候选中含文档里那个词 */
await clickLineEnd('uname -a')
await key('Enter', { code: 'Enter', vk: 13 })
await sleep(280)
await typeText('sys')
await sleep(520)
const autoPop = await popup()
ok(
  '5.代码块内打字自动弹出，且第一个候选就是文档里出现过的 systemctl',
  autoPop.open && autoPop.onTop && (autoPop.items[0] || '').startsWith('systemctl'),
  autoPop,
)

/* 3b. Enter 采纳 */
await key('Enter', { code: 'Enter', vk: 13 })
await sleep(380)
const afterAccept = await lineTexts()
ok(
  '6.Enter 采纳补全，写进去的是 systemctl',
  afterAccept.some((t) => t.trim() === 'systemctl') && !(await popup()).open,
  { lines: afterAccept.filter((t) => t.trim()).slice(-6) },
)

/* 3c. 代码块里空行 Ctrl+Space → 语言骨架。
   这一条顺带验「骨架跟着语言走」：上面第 4 条把第一个块改成了 python，
   而第 5/6 步的光标停在第二个（仍是 bash）块里——两处各问一次，
   给出的骨架必须不一样，否则就是语言没被认出来。 */
await key('Enter', { code: 'Enter', vk: 13 })
await sleep(280)
await manualComplete()
const shellPop = await popup()
ok('7.Shell 块里 Alt+/ 给 Shell 骨架', shellPop.open && shellPop.items.some((t) => t.includes('#!/bin/bash')), shellPop)
await key('Escape', { code: 'Escape', vk: 27 })
await sleep(220)

await clickLineEnd('df -h')
await key('Enter', { code: 'Enter', vk: 13 })
await sleep(280)
await manualComplete()
const pyPop = await popup()
ok(
  '8.同一个文档里 Python 块给的是 Python 骨架（骨架跟语言走）',
  pyPop.open && pyPop.items.some((t) => t.includes('入口') || t.includes('def ')) && !pyPop.items.some((t) => t.includes('#!/bin/bash')),
  pyPop,
)
await key('Escape', { code: 'Escape', vk: 27 })
await sleep(220)

/* 3d. 正文里打字必须安静 */
await clickLineEnd('正文里写着')
await typeText('sys')
await sleep(520)
const quiet = await popup()
ok('9.正文里打字不弹补全（中文写作不该被打扰）', quiet.open === false, quiet)

/* 3e. 正文里 Ctrl+Space 手动唤出 */
await manualComplete()
const manual = await popup()
ok('10.正文里 Alt+/ 手动唤出，给的是文档词', manual.open && manual.items.some((t) => t.startsWith('systemctl')), manual)
await key('Escape', { code: 'Escape', vk: 27 })

ok('11.零 JS 异常', errors.length === 0, errors.slice(0, 3))

const bad = results.filter((r) => !r.pass)
console.log(`\n${bad.length ? `FAILED ${bad.length}/${results.length}` : `ALL PASS (${results.length})`}`)
await close()
process.exit(bad.length ? 1 : 0)
