/**
 * 诊断 2：编辑区自己滚的时候，两栏各自怎么动。
 *
 * 上一份（diag-outline-jump.mjs）证明「点大纲 → 落点是对的」，
 * 所以问题不在跳转的目标算错，而在滚动过程本身。这里逐帧同时采
 * 编辑区和预览区，看编辑区有没有自己往回走（那就是肉眼看到的乱跳）。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4406)
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 950] })

/* 两种内容都试：一种是行高均匀的纯文字，一种夹着长代码块和表格
   —— 后者的「未测量行」高度跟真实高度差得多，是抖动最容易暴露的地方。 */
const plain = []
for (let i = 1; i <= 24; i++) plain.push(`## 平 ${i}`, '', '段落' + '文字内容。'.repeat(18), '')

const heavy = []
for (let i = 1; i <= 16; i++) {
  heavy.push(`## 重 ${i}`, '')
  heavy.push('| 列一 | 列二 | 列三 |', '| --- | --- | --- |')
  for (let r = 0; r < 6; r++) heavy.push(`| 值${r} | 数据${r} | 说明${r} |`)
  heavy.push('')
  heavy.push('```python', `def f${i}(a, b):`, `    for k in range(${i}):`, `        yield a * k + b`, '```', '')
  heavy.push(('这一行很长'.repeat(12)) , '')
}

const NOTES = {
  '/ws/纯文字.md': ['# 纯文字', '', ...plain].join('\n'),
  '/ws/重内容.md': ['# 重内容', '', ...heavy].join('\n'),
}
const TREE = [
  ...makeTree(),
  { type: 'file', name: '纯文字.md', path: '/ws/纯文字.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' },
  { type: 'file', name: '重内容.md', path: '/ws/重内容.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' },
]
const INJECT = makeInject({ notes: { ...makeNotes(), ...NOTES }, tree: TREE })

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1500)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)

const SAMPLER = `
window.__s = [];
window.__go = true;
(function loop(){
  if (!window.__go) return;
  var e = document.querySelector('.cm-scroller');
  var p = document.querySelector('.pvw .preview');
  window.__s.push([e ? Math.round(e.scrollTop) : -1, p ? Math.round(p.scrollTop) : -1, e ? Math.round(e.scrollHeight) : -1]);
  requestAnimationFrame(loop);
})();
void 0;
`

function analyze(arr, idx) {
  const rows = []
  let last = null
  for (const row of arr) {
    const v = row[idx]
    if (last === null || last !== v) rows.push(v)
    last = v
  }
  const steps = []
  for (let i = 1; i < rows.length; i++) steps.push(rows[i] - rows[i - 1])
  let reversals = 0
  let prevDir = 0
  let travel = 0
  let back = 0
  for (const st of steps) {
    if (st === 0) continue
    travel += Math.abs(st)
    const d = st > 0 ? 1 : -1
    if (prevDir !== 0 && d !== prevDir) { reversals += 1; back += Math.abs(st) }
    prevDir = d
  }
  const direct = rows.length ? Math.abs(rows[rows.length - 1] - rows[0]) : 0
  const sorted = steps.map(Math.abs).sort((a, b) => a - b)
  return {
    变值帧: rows.length,
    净位移: direct,
    总路程: travel,
    回退量: back,
    反向次数: reversals,
    最大单帧: sorted.length ? sorted[sorted.length - 1] : 0,
    中位步长: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
  }
}

async function wheelRun(label, note, mode, times, dy) {
  await evaluate(openNoteExpr(note))
  await sleep(1300)
  await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="${mode}"]')?.click()`)
  await sleep(900)
  const box = JSON.parse(
    await evaluate(`(() => { var r = document.querySelector('.cm-scroller').getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}) })()`),
  )
  await evaluate(SAMPLER.replace(/\n/g, ' '))
  await sleep(80)
  for (let i = 0; i < times; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: dy })
    await sleep(30)
  }
  await sleep(600)
  await evaluate(`window.__go = false; void 0;`)
  const s = JSON.parse(await evaluate(`JSON.stringify(window.__s)`))
  const h0 = s.length ? s[0][2] : 0
  const h1 = s.length ? s[s.length - 1][2] : 0
  console.log(`\n── ${label}`)
  console.log('   编辑区:', JSON.stringify(analyze(s, 0)))
  console.log('   预览区:', JSON.stringify(analyze(s, 1)))
  console.log(`   文档总高: ${h0} → ${h1}（${h1 - h0 >= 0 ? '+' : ''}${h1 - h0}）`)
}

await wheelRun('纯文字 / 分栏 / 向下 30 格', '纯文字', '分栏视图', 30, 100)
await wheelRun('纯文字 / 分栏 / 继续向下 30 格', '纯文字', '分栏视图', 30, 100)
await wheelRun('重内容 / 分栏 / 向下 30 格', '重内容', '分栏视图', 30, 100)
await wheelRun('重内容 / 分栏 / 继续向下 30 格', '重内容', '分栏视图', 30, 100)
await wheelRun('重内容 / 纯编辑 / 向下 30 格', '重内容', '编辑模式', 30, 100)
await wheelRun('重内容 / 分栏 / 向上 30 格', '重内容', '分栏视图', 30, -100)

console.log('\n控制台异常:', errors.length ? errors.slice(0, 5) : '无')
await close()
