/**
 * 本轮四个修复的回归：
 *   1. 标行按钮的「亮」= 当前行已标行（未标的行不亮）
 *   2. 语言 chip 下拉：再点一次能收回去
 *   3. 版本历史：对比视图单列行号；抽屉开着时自动保存后列表实时多出快照
 *   4. 标行高亮加强后仍在（diag-line-marks 管功能，这里只看按钮状态）
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4421)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 960] })

const NOTE = [
  '# 标行回归',
  '',
  '```ts',
  'const a = 1',
  'const b = 2',
  'const c = 3',
  '```',
  '',
  '结尾。',
].join('\n')

const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/标行回归.md': NOTE },
  tree: [
    ...makeTree(),
    { type: 'file', name: '标行回归.md', path: '/ws/标行回归.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' },
  ],
})

let bad = 0
function ok(name, cond, extra = '') {
  if (cond) console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`)
  else {
    bad += 1
    console.log(`❌ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

async function clickAt(selector) {
  const raw = await evaluate(`
    (() => {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      var b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) return null;
      return JSON.stringify({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
    })()
  `)
  if (!raw || raw === 'null') return false
  const p = JSON.parse(raw)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await sleep(320)
  return true
}

async function clickLine(text) {
  const raw = await evaluate(`
    (() => {
      var ls = [...document.querySelectorAll('.cm-line')];
      var el = ls.find((e) => (e.textContent || '').trim() === ${JSON.stringify(text)});
      if (!el) return null;
      var b = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.x + 10), y: Math.round(b.y + b.height / 2) });
    })()
  `)
  if (!raw || raw === 'null') return false
  const p = JSON.parse(raw)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await sleep(320)
  return true
}

const btnState = async () =>
  evaluate(
    `(() => { var b = document.querySelector('[data-role="line-marks"]'); return b ? b.classList.contains('on') : null })()`,
  )

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1400)
await evaluate(`localStorage.setItem('nota-tour-seen','1')`)
await evaluate(`location.reload()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(600)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(900)
await evaluate(INJECT)
await sleep(600)
ok('打开样本笔记', (await evaluate(openNoteExpr('标行回归'))) === true)
await sleep(1100)

/* ── 2. 版本历史（先做：此时文档还没被标行动过，快照从零开始） ── */
// 先开抽屉（此刻还没有任何快照），再打字 → 自动保存落盘 →
// lastSavedAt 跳动 → 列表不走「关掉重开」就得实时多出这一份。
ok('打开版本历史', (await clickAt('.ea-btn[title="版本历史"]')) === true)
await sleep(900)
const rows0 = await evaluate(`document.querySelectorAll('.hp-row').length`)
ok('初始还没有快照', rows0 === 0, `rows=${rows0}`)

await evaluate(`
  (() => {
    var cm = document.querySelector('.cm-content');
    cm.focus();
    document.execCommand('insertText', false, '\\n\\n自动保存测试新增段。');
  })()
`)
await sleep(2600)
const saved1 = await evaluate(`(window.__histSaved || []).length`)
ok('自动保存写出了快照', saved1 === 1, `__histSaved=${saved1}`)
const rows1 = await evaluate(`document.querySelectorAll('.hp-row').length`)
ok('抽屉开着，快照实时出现在列表里', rows1 === 1, `rows=${rows1}`)

ok('切到对比页', (await clickAt('.hp-seg button:nth-child(2)')) === true)
await sleep(1800)
console.log('   [诊断]', JSON.stringify(await evaluate(`JSON.stringify({
  hasDiff: !!document.querySelector('.hp-diff'),
  hint: document.querySelector('.hp-hint')?.textContent ?? null,
  dbg: window.__diffDbg ?? null,
})`)))
const gutters = await evaluate(`
  (() => {
    var rows = [...document.querySelectorAll('.hp-dl')];
    return rows.length ? rows[0].querySelectorAll('.hp-g').length : -1;
  })()
`)
ok('对比行只有一列行号', gutters === 1, `gutters=${gutters}`)
const noOldNo = await evaluate(
  `[...document.querySelectorAll('.hp-dl')].every(r => r.children.length === 3)`,
)
ok('行结构 = 行号 + 符号 + 正文', noOldNo === true)

// 关上抽屉再测按钮：遮罩还开着的话，编辑器那侧的点击全被它吃掉
ok('关上抽屉', (await clickAt('.hp-x')) === true)
await sleep(500)

/* ── 3. 标行按钮的亮 ── */
await clickLine('const a = 1')
ok('未标行：按钮不亮', (await btnState()) === false)
ok('点按钮 → 标行', (await clickAt('[data-role="line-marks"]')) === true)
await sleep(400)
ok('刚标的行：按钮亮', (await btnState()) === true)
const info = await evaluate(
  `(() => { var l = [...document.querySelectorAll('.cm-line')].find(e => (e.textContent||'').includes('const a')); return l ? l.textContent : '' })()`,
)
ok('围栏 info 里多了标记', /\{1\}|\b1\b/.test(info), JSON.stringify(info))
await clickLine('const b = 2')
ok('移到未标的行：按钮不亮', (await btnState()) === false)
await clickLine('const a = 1')
ok('回到已标的行：按钮亮', (await btnState()) === true)
ok('再点一次 → 取消标行', (await clickAt('[data-role="line-marks"]')) === true)
await sleep(400)
ok('取消后：按钮不亮', (await btnState()) === false)
/* 重新标上，给后面历史测试用 */
ok('重新标行', (await clickAt('[data-role="line-marks"]')) === true)

/* ── 4. 语言 chip 下拉 toggle ── */
const hasMenu = async () => evaluate(`!!document.querySelector('.n-menu')`)
ok('点语言 chip → 下拉展开', (await clickAt('[aria-label="选择代码语言"]')) === true && (await hasMenu()) === true)
ok('再点同一颗 → 收回去', (await clickAt('[aria-label="选择代码语言"]')) === true && (await hasMenu()) === false)
ok('第三下 → 再展开', (await clickAt('[aria-label="选择代码语言"]')) === true && (await hasMenu()) === true)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(250)
ok('Escape 也能收', (await hasMenu()) === false)

console.log('\n控制台异常:', errors.length ? errors.slice(0, 6) : '无')
console.log(bad === 0 ? '\n全部通过' : `\n失败 ${bad} 项`)
await close()
process.exit(bad ? 1 : 0)
