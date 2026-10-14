/**
 * 逐键延迟探针 —— 「编辑部分有点卡」
 *
 * 汇总数据只能说「总体不算慢」，说不出用户为什么觉得卡。
 * 用户感觉到的是单次投入的不良反应，所以这里把每一个字单独记录：
 *   按下键 → 到下一次绘制，用了多久（包含 CodeMirror 更新 + Vue 重渲染 + 布局）
 * 看的是 p50 / p95 / max 和**突刺出现在第几个字**，
 * 而不是平均值 —— 平均值会被大量 ui-free 帧拉平，
 * 感知 smoothness 取决于那几下最慢的。
 *
 * 三种模式对照：编辑（无预览）/ 分栏（有预览）/ 阅读（无编辑器）。
 * 再用一篇短笔记跑一遍，验证「行数多」是不是真的相关。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4418)
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
    if (i % 5 === 0) {
      out.push('| 列一 | 列二 | 列三 |', '| --- | --- | --- |')
      for (let k = 0; k < 6; k++) out.push(`| r${k} | ${k * 3} | 说明文字 |`)
      out.push('')
    }
  }
  return out.join('\n')
}

const BIG = docOf(2400)
const SMALL = docOf(120)

const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/大篇.md': BIG, '/ws/小篇.md': SMALL },
  tree: [
    ...makeTree(),
    { type: 'file', name: '大篇.md', path: '/ws/大篇.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' },
    { type: 'file', name: '小篇.md', path: '/ws/小篇.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' },
  ],
})

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1500)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)

/* 注入延迟采样：keydown 的那刻记时，下一帧绘制后算差 */
const ARM = `(() => {
  window.__lat = [];
  if (window.__armed) document.removeEventListener('keydown', window.__armed, true);
  window.__armed = function (e) {
    if (!e.key || e.key.length !== 1) return;
    var t = performance.now();
    requestAnimationFrame(function () { window.__lat.push(Math.round(performance.now() - t)); });
  };
  document.addEventListener('keydown', window.__armed, true);
  void 0;
})()`

async function typeChars(n, ch = '字') {
  for (let i = 0; i < n; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, code: 'KeyA' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'KeyA' })
    await sleep(40)
  }
}

function stats(list) {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))]
  const worst = list
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
  return { p50: at(0.5), p95: at(0.95), max: s[s.length - 1], spikes: worst.map((w) => `#${w.i}=${w.v}ms`) }
}

async function run(label, note, modeAria) {
  await evaluate(openNoteExpr(note))
  await sleep(1800)
  if (modeAria) {
    await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="${modeAria}"]')?.click()`)
    await sleep(1300)
  }
  /* 光标落到最后一行：那里离文档开头最远，最能体现整篇规模的影响 */
  await evaluate(`(() => {
    var lines = document.querySelectorAll('.cm-line');
    var last = lines[lines.length - 1];
    if (!last) return;
    var r = last.getBoundingClientRect();
    last.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 6, clientY: r.top + 8 }));
    last.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 6, clientY: r.top + 8 }));
    void 0;
  })()`)
  await sleep(600)
  await evaluate(ARM)
  await typeChars(40)
  await sleep(500)
  const list = JSON.parse(await evaluate(`JSON.stringify(window.__lat)`))
  const st = stats(list)
  console.log(`\n── ${label} ──`)
  console.log(`  ${JSON.stringify(st)}`)
  console.log(`  逐键：${list.join(',')}`)
  return st
}

await run('大篇 · 编辑模式（无预览）', '大篇', '编辑视图')
await run('大篇 · 分栏模式（有预览）', '大篇', '分栏视图')
await run('小篇 · 分栏模式（有预览）', '小篇', '分栏视图')

console.log('\n════ 结论看 p95 / max：60ms 以上就会被明显感觉到「卡一下」════')

await close()
