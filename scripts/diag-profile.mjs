/**
 * CPU 剖析 —— 找出打字卡顿到底花在哪个函数上。
 *
 * 帧าด数只能告诉我们「卡了一下」，说不出「卡在哪」。
 * 这里用 CDP 的 Profiler 抓一段真正的 CPU profile，按 functionName 汇总自身耗时，
 * 排出最吃 CPU 的那几个 —— 根因要落在具体函数名上，不能停在「预览重建很重」这种程度。
 *
 * 必须配 WEB_ROOT=dist-prof（未压缩构建）跑：minify 之后函数名全被抹掉，
 * profile 里只剩下匿名帧，什么都看不出来。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4417)
const { send, evaluate, sleep, close } = await launch({ port: PORT, size: [1500, 950] })

function bigDoc(lines) {
  const out = ['# 性能靶子', '']
  let i = 0
  while (out.join('\n').split('\n').length < lines) {
    i++
    out.push(`## 第 ${i} 节 标题`, '')
    out.push('这是正文段落，' + '用来撑长度的中文内容。'.repeat(12))
    out.push('')
    if (i % 3 === 0) {
      out.push('```python')
      out.push('def f(x):')
      for (let k = 0; k < 14; k++) out.push(`    v${k} = x * ${k} + ${i}`)
      out.push('    return v13')
      out.push('```', '')
    }
    if (i % 5 === 0) {
      out.push('| 列一 | 列二 | 列三 |', '| --- | --- | --- |')
      for (let k = 0; k < 6; k++) out.push(`| r${k} | ${k * 3} | 说明文字 |`)
      out.push('')
    }
  }
  return out.join('\n')
}
const LONG = bigDoc(2400)

const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/性能靶子.md': LONG },
  tree: [
    ...makeTree(),
    { type: 'file', name: '性能靶子.md', path: '/ws/性能靶子.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' },
  ],
})

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1500)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)
await evaluate(openNoteExpr('性能靶子'))
await sleep(2200)

async function typeChars(n, ch = '字') {
  for (let i = 0; i < n; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, code: 'KeyA' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'KeyA' })
    await sleep(35)
  }
}

async function profile(label, modeAria, nchars) {
  await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="${modeAria}"]')?.click()`)
  await sleep(1400)
  await evaluate(`(() => {
    var lines = document.querySelectorAll('.cm-line');
    var last = lines[lines.length - 1];
    if (!last) return;
    var r = last.getBoundingClientRect();
    last.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 6, clientY: r.top + 8 }));
    last.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 6, clientY: r.top + 8 }));
    void 0;
  })()`)
  await sleep(500)

  await send('Profiler.enable')
  await send('Profiler.setSamplingInterval', { interval: 100 })
  await send('Profiler.start')
  await typeChars(nchars)
  await sleep(1200)
  const { profile } = await send('Profiler.stop')

  /* 自身耗时聚合：总 samples 减去子节点 samples 才是「花在自己身上」的部分 */
  const byId = new Map()
  for (const n of profile.nodes) byId.set(n.id, n)
  const childSamples = new Map()
  for (const n of profile.nodes) {
    for (const c of n.children ?? []) {
      childSamples.set(c, (childSamples.get(c) ?? 0) + (n.hitCount ?? 0))
    }
  }
  const total = profile.samples?.length || 1
  const rows = profile.nodes
    .map((n) => {
      const self = Math.max(0, (n.hitCount ?? 0) - (childSamples.get(n.id) ?? 0))
      const f = n.callFrame || {}
      return {
        self,
        pct: (self / total) * 100,
        name: f.functionName || '(anonymous)',
        url: (f.url || '').replace(/^https?:\/\/[^/]+\//, '').split('?')[0],
        line: f.lineNumber,
      }
    })
    .filter((r) => r.self > 0)
    .sort((a, b) => b.self - a.self)
    .slice(0, 22)

  console.log(`\n════ ${label} ════（${total} samples，采样间隔 100µs）`)
  for (const r of rows) {
    console.log(`  ${r.pct.toFixed(1).padStart(5)}%  ${r.name}  ${r.url}:${r.line}`)
  }
  return rows
}

await profile('写作模式 · 连打 30 字', '编辑视图', 30)
await profile('分栏模式 · 连打 30 字', '分栏视图', 30)

await close()
