/**
 * 性能探针 —— 「软件一卡一卡的 / 编辑里打字卡」
 *
 * 不猜哪里慢，直接量。
 * 做法是：Jamestown 一篇长文，一边逐字输入，一边在页面里采样：
 *   · 每帧的时间戳（掉帧 = 有任务卡住了渲染）
 *   · PerformanceObserver 的 longtask（>50ms 的那feeling就是「卡」的直接来源）
 * 然后按「帧间隔的最大值 / 出现几次」来判断，而不是看平均 ——
 * 平均值会被大量空闲帧拉平，用户感觉到的是那几下停顿。
 *
 * 三分样本对照：
 *   write 模式（预览不渲染） / split 模式（预览跟着重建） / 纯滚动
 * 先分清是「编辑本身慢」还是「预览重建拖累编辑」。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4416)
const { send, evaluate, sleep, close } = await launch({ port: PORT, size: [1500, 950] })

/** 一篇够长的笔记：标题多（大纲重）、代码块多（高亮重）、表格也不少 */
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
console.log(`样本：${LONG.split('\n').length} 行 / ${LONG.length} 字符`)

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

const t0 = Date.now()
await evaluate(openNoteExpr('性能靶子'))
await sleep(2000)
console.log(`打开这篇笔记：${Date.now() - t0} ms（含 2s 等待）`)

/* 页面里挂采样器 */
const START = `(() => {
  window.__perf = { frames: [], long: [] };
  window.__stop = false;
  if (window.__po) { try { window.__po.disconnect() } catch (e) {} }
  try {
    window.__po = new PerformanceObserver(function (l) {
      for (var e of l.getEntries()) window.__perf.long.push(Math.round(e.duration));
    });
    window.__po.observe({ entryTypes: ['longtask'] });
  } catch (e) {}
  var last = performance.now();
  (function tick() {
    var n = performance.now();
    window.__perf.frames.push(n - last);
    last = n;
    if (!window.__stop) requestAnimationFrame(tick);
  })();
  void 0;
})()`
const STOP = `(() => { window.__stop = true; return JSON.stringify(window.__perf); })()`

/** 把光标放到最后一行后，连打 n 个字 */
async function typeChars(n, ch = '字') {
  for (let i = 0; i < n; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, code: 'KeyA' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'KeyA' })
    await sleep(35)
  }
}

function report(tag, raw) {
  const d = JSON.parse(raw)
  const f = d.frames.filter((x) => x > 0)
  f.sort((a, b) => b - a)
  const top = f.slice(0, 8).map((x) => Math.round(x))
  const over50 = d.long.length
  console.log(`\n── ${tag} ──`)
  console.log(`  采样帧数 ${f.length}，最长帧 ${top.join('/')} ms`)
  console.log(`  >50ms 长任务 ${over50} 次${over50 ? '：' + d.long.slice(0, 8).join('/') + ' ms' : ''}`)
  return { max: top[0] ?? 0, over50, long: d.long }
}

/* ── 1. 写作模式（预览不重建）── */
await evaluate(START)
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="编辑视图"]')?.click()`)
await sleep(900)
await evaluate(`(() => {
  var lines = document.querySelectorAll('.cm-line');
  var last = lines[lines.length - 1];
  var r = last.getBoundingClientRect();
  last.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 6, clientY: r.top + 8 }));
  last.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 6, clientY: r.top + 8 }));
  void 0;
})()`)
await sleep(500)
await evaluate(START)
await typeChars(30)
await sleep(600)
const write = report('写作模式 · 连打 30 字', await evaluate(STOP))

/* ── 2. 分栏模式（预览跟着重建）── */
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
await evaluate(START)
await typeChars(30)
await sleep(1500)
const split = report('分栏模式 · 连打 30 字', await evaluate(STOP))

/* ── 3. 纯滚动 ── */
await evaluate(START)
for (let i = 0; i < 20; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 400, y: 500, deltaX: 0, deltaY: 220, button: 'none', clickCount: 0,
  })
  await sleep(30)
}
await sleep(400)
const scroll = report('分栏模式 · 滚轮滚动 20 格', await evaluate(STOP))

/* ── 4. 大纲抽词（每敲一个字都跑一次）单独的代价 ── */
const outlineCost = await evaluate(`(() => {
  var v = document.querySelector('.cm-editor').cmView.view;
  var raw = v.state.doc.toString();
  /* 拿同源实现的等价量：源码行数与标题数，用来估算 outlineFromSource 的规模 */
  return JSON.stringify({
    lines: v.state.doc.lines,
    headings: (raw.match(/^#{1,6}\\s/gm) || []).length,
    chars: raw.length,
  });
})()`)
console.log(`\n文档规模：${outlineCost}`)

/* ── 5. 大纲视图切换代价 ── */
await evaluate(START)
await evaluate(`document.querySelector('.col-tab[data-view="outline"]')?.click()`)
await sleep(1200)
await evaluate(`document.querySelector('.col-tab[data-view="notes"]')?.click()`)
await sleep(1200)
report('切换中间栏页签（笔记 ↔ 大纲）', await evaluate(STOP))

console.log('\n════ 汇总 ════')
console.log(`写作模式最长帧 ${write.max}ms / 长任务 ${write.over50} 次`)
console.log(`分栏模式最长帧 ${split.max}ms / 长任务 ${split.over50} 次`)
console.log(`纯滚动最长帧 ${scroll.max}ms / 长任务 ${scroll.over50} 次`)

await close()
