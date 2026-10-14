/**
 * 时间构成探针 —— 每次按键那 20 多毫秒，到底是「算」还是「排」。
 *
 * 逐键延迟只能测到端到端的结果，没法判断该往哪个方向改：
 * 优化脚本没用（如果是布局慢），反过来也一样。
 * 这里用 CDP 的 Performance.getMetrics 取同一段时间的累计值相减，
 * 把 ScriptDuration / RecalcStyleDuration / LayoutDuration 分开看。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4419)
const { send, evaluate, sleep, close } = await launch({ port: PORT, size: [1500, 950] })

function docOf(lines) {
  const out = ['# 性能靶子', '']
  let i = 0
  while (out.join('\n').split('\n').length < lines) {
    i++
    out.push(`## 第 ${i} 节 标题`, '')
    out.push('这是正文段落，' + '用来撑长度的中文内容。'.repeat(12))
    out.push('')
    if (i % 3 === 0) {
      out.push('```python', 'def f(x):')
      for (let k = 0; k < 14; k++) out.push(`    v${k} = x * ${k} + ${i}`)
      out.push('    return v13', '```', '')
    }
  }
  return out.join('\n')
}
const BIG = docOf(2400)

const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/大篇.md': BIG },
  tree: [
    ...makeTree(),
    { type: 'file', name: '大篇.md', path: '/ws/大篇.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' },
  ],
})

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1500)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)

async function metrics() {
  const { metrics } = await send('Performance.getMetrics')
  const m = {}
  for (const { name, value } of metrics) m[name] = value
  return m
}
const KEYS = ['ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration', 'TaskDuration', 'LayoutCount', 'Nodes']

async function sample(label, n = 40) {
  const a = await metrics()
  for (let i = 0; i < n; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: '字', key: '字', code: 'KeyA' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '字', code: 'KeyA' })
    await sleep(40)
  }
  await sleep(600)
  const b = await metrics()
  const per = (k) => ((b[k] - a[k]) / n) * 1000
  console.log(`\n── ${label} · 每敲一个字的耗时 ──`)
  for (const k of KEYS) {
    if (k === 'Nodes') continue
    console.log(`  ${k.padEnd(22)} ${per(k).toFixed(2)} ms`)
  }
  console.log(`  页面节点数 ${b.Nodes}`)
}

await send('Performance.enable')
await evaluate(openNoteExpr('大篇'))
await sleep(1800)
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="编辑视图"]')?.click()`)
await sleep(1200)
await evaluate(`(() => {
  var lines = document.querySelectorAll('.cm-line');
  var last = lines[lines.length - 1];
  var r = last.getBoundingClientRect();
  last.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 6, clientY: r.top + 8 }));
  last.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 6, clientY: r.top + 8 }));
  void 0;
})()`)
await sleep(600)
await sample('大篇 · 编辑模式')

await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="分栏视图"]')?.click()`)
await sleep(1400)
await evaluate(`(() => {
  var lines = document.querySelectorAll('.cm-line');
  var last = lines[lines.length - 1];
  var r = last.getBoundingClientRect();
  last.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 6, clientY: r.top + 8 }));
  last.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 6, clientY: r.top + 8 }));
  void 0;
})()`)
await sleep(600)
await sample('大篇 · 分栏模式')

await close()
