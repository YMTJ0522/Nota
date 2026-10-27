/**
 * 命令面板（Ctrl+K）验证。
 *
 * 这个面板不加功能，它只是把已有的动作排成一列。所以验的不是「新功能对不对」，
 * 而是三件事：
 *   · 该有的命令一条不少，而且**搜得到**（中文、英文、拼音三条路都得通）；
 *   · 不该能点的（没打开笔记时的导出 / 保存）**置灰并说明原因**，而不是消失；
 *   · 执行之后**面板关掉、该开的东西真的开了**，并记住「最近用过」。
 *
 * 跑法：node scripts/verify-cmdk.mjs
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = 4371
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1400, 950] })

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const eq = (name, a, b) => ok(name, a === b, `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`)

const INJECT = makeInject({ notes: makeNotes(), tree: makeTree() })

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1500)
await evaluate('localStorage.clear()')
// 假 IPC 要在文档执行之前挂上，否则第一轮界面只挂一半
await send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT })
await send('Page.reload')
await sleep(2200)
errors.length = 0
await evaluate("document.querySelector('.cta')?.click()")
await sleep(1300)
await evaluate(INJECT)
await sleep(600)

async function hotkey() {
  await evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`,
  )
  await sleep(240)
}

async function typeQ(v) {
  const r = await evaluate(`(() => {
    const el = document.querySelector('.cp-input')
    if (!el) return false
    el.value = ${JSON.stringify(v)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(200)
  return r
}

async function key(name) {
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true }))`,
  )
  await sleep(160)
}

const open = () => evaluate(`!!document.querySelector('.cp')`)
const rows = () =>
  evaluate(`[...document.querySelectorAll('.cp-row')].map(r => ({
    t: (r.querySelector('.cp-title')?.textContent ?? '').trim(),
    hint: (r.querySelector('.cp-hint')?.textContent ?? '').trim(),
    kbd: (r.querySelector('.cp-kbd')?.textContent ?? '').trim(),
    off: r.classList.contains('off'),
    on: r.classList.contains('on'),
  }))`)
const secs = () => evaluate(`[...document.querySelectorAll('.cp-sec')].map(s => s.textContent.trim())`)
const curTitle = () => evaluate(`document.querySelector('.cp-row.on .cp-title')?.textContent ?? ''`)
const clickFirst = async () => {
  await evaluate(`document.querySelector('.cp-row')?.click()`)
  await sleep(600)
}

/* ── 开关 ── */
console.log('\n── 开关 ──')
await hotkey()
ok('Ctrl+K 打开命令面板', await open())

const all = await rows()
ok('空输入时把命令全列出来', all.length >= 30, `列了 ${all.length} 条`)
eq('命令没有重复', new Set(all.map((r) => r.t)).size, all.length)
eq('空输入时只有一个分段「全部命令」', JSON.stringify(await secs()), JSON.stringify(['全部命令']))
ok('有快捷键的命令把键位标出来了', all.some((r) => r.kbd === 'Ctrl+N'), JSON.stringify(all.filter((r) => r.kbd).map((r) => r.kbd)))

const offRows = all.filter((r) => r.off)
ok('还没打开笔记时，依赖笔记的命令置灰', offRows.length > 0, `置灰 ${offRows.length} 条`)
ok(
  '置灰的不藏起来，而是说明「先打开一篇笔记」',
  offRows.every((r) => r.hint === '先打开一篇笔记'),
  JSON.stringify(offRows.slice(0, 3)),
)

await hotkey()
ok('再按一次 Ctrl+K 收起来', !(await open()))

await hotkey()
await key('Escape')
ok('Esc 关闭', !(await open()))

/* ── 搜索：中文 / 英文 / 拼音三条路 ── */
console.log('\n── 搜索 ──')
await hotkey()

await typeQ('导出')
let rs = await rows()
eq('打「导出」正好四条导出命令', rs.length, 4)
ok('四条都跟导出有关', rs.every((r) => r.t.includes('导出')), JSON.stringify(rs.map((r) => r.t)))

await typeQ('word')
rs = await rows()
eq('英文别名 word 排第一的是「导出为 Word」', rs[0]?.t, '导出为 Word')

await typeQ('zhu')
rs = await rows()
ok('拼音 zhu 能搜到「切换明暗主题」', rs.some((r) => r.t === '切换明暗主题'), JSON.stringify(rs.map((r) => r.t)))

await typeQ('主题')
rs = await rows()
eq('中文「主题」排第一', rs[0]?.t, '切换明暗主题')

await typeQ('回收')
rs = await rows()
eq('「回收」只命中一条', rs.length, 1)
eq('就是回收站', rs[0]?.t, '回收站')

await typeQ('一周')
const s2 = await secs()
ok('打笔记名会多出「笔记」分段', s2.includes('笔记'), JSON.stringify(s2))
ok('笔记那一条是《一周手记》', (await rows()).some((r) => r.t === '一周手记'), JSON.stringify((await rows()).map((r) => r.t)))

await typeQ('zzzz')
ok(
  '搜不到时给一句空态提示',
  await evaluate(`document.querySelector('.cp-empty')?.textContent.includes('没有匹配') ?? false`),
)

/* ── 键盘 ── */
console.log('\n── 键盘 ──')
await typeQ('')
await sleep(180)
const first0 = await curTitle()
await key('ArrowDown')
const secondAt = await curTitle()
ok('↓ 移到下一条', !!secondAt && secondAt !== first0, `${first0} → ${secondAt}`)
await key('ArrowUp')
eq('↑ 回到上一条', await curTitle(), first0)

await key('ArrowUp')
const lastTitle = await evaluate(
  `(() => { const a = [...document.querySelectorAll('.cp-row')]; return a.length ? a[a.length - 1].querySelector('.cp-title').textContent : '' })()`,
)
eq('在第一行按 ↑ 绕到最后一行', await curTitle(), lastTitle)

/* ── 执行 ── */
console.log('\n── 执行 ──')
await typeQ('切换明暗')
const before = await evaluate(`document.documentElement.dataset.theme`)
await clickFirst()
const after = await evaluate(`document.documentElement.dataset.theme`)
ok('点「切换明暗主题」真的换了主题', !!after && after !== before, `${before} → ${after}`)
ok('执行完面板自己关掉', !(await open()))

await hotkey()
const s3 = await secs()
eq('再打开时第一段变成「最近用过」', s3[0], '最近用过')
eq('刚执行过的那条排在最前', await curTitle(), '切换明暗主题')

// 还原主题，顺便验「同一条再执行一次仍然有效」
await clickFirst()
eq('再执行一次能换回来', await evaluate(`document.documentElement.dataset.theme`), before)

/* ── 依赖笔记的命令 ── */
console.log('\n── 依赖笔记的命令 ──')
await evaluate(openNoteExpr('一周手记'))
await sleep(1300)
await hotkey()
await typeQ('保存当前')
rs = await rows()
ok('打开笔记后「保存当前笔记」不再置灰', !!rs[0] && !rs[0].off, JSON.stringify(rs[0]))
await key('Escape')

await hotkey()
await typeQ('版本历史')
await clickFirst()
ok('「版本历史」命令把历史面板打开了', await evaluate(`!!document.querySelector('.hp')`))
await evaluate(`document.querySelector('[data-role="hp-close"]')?.click()`)
await sleep(400)

/* ── 跨组件命令 ── */
console.log('\n── 跨组件命令 ──')
await hotkey()
await typeQ('设置')
await clickFirst()
ok('「设置」命令打开设置面板', await evaluate(`!!document.querySelector('.st-mask')`))
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await sleep(500)
ok('设置能关掉，回到原来的界面', !(await evaluate(`!!document.querySelector('.st-mask')`)))

await hotkey()
await typeQ('全文搜索')
await clickFirst()
ok('「全文搜索」命令打开搜索面板', await evaluate(`!!document.querySelector('.sp')`))
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await sleep(400)

/* ── 报错 ── */
console.log('\n── 报错 ──')
ok('全程没有 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '))

console.log(`\n${pass} 过 / ${fail} 失`)
await close()
process.exit(fail ? 1 : 0)
