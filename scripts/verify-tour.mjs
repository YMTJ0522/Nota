/**
 * 新手引导回归探针：
 * 打开一篇笔记 → 派发 nota:tour 重放引导 → 逐步点「下一步」，
 * 断言每一步的目标元素都被命中（挖洞 rect 存在）+ 标题符合新文案。
 * 任何一步 rect 为 null 都说明 selector 失配或布局没渲染，引导会显示成
 * 「全屏遮罩没有洞」——那就是要修的。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = 4471
const { send, evaluate, sleep, close } = await launch({ port: PORT, size: [1500, 960] })

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`) }
}

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1400)
await evaluate(`localStorage.setItem('nota-tour-seen', '1')`)
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1400)

const inj = makeInject({
  notes: { ...makeNotes(), '/ws/一周手记.md': makeNotes()['/ws/一周手记.md'] },
  tree: makeTree(),
})
await evaluate(inj); await sleep(600)
await evaluate(`document.querySelector('.cta')?.click()`); await sleep(900)
await evaluate(inj); await sleep(600)
await evaluate(`(() => { ${openNoteExpr('一周手记')} })()`); await sleep(1200)

/* 重放引导 */
await evaluate(`window.dispatchEvent(new CustomEvent('nota:tour'))`)
await sleep(700)

const EXPECT = [
  ['这里是资料库', '.panel'],
  ['中间这栏换个角度看', '.col'],
  ['右边是写东西的地方', '.main'],
  ['这排是趁手工具', '.ea'],
  ['这几枚是「去别处」', '.nav.nav-group'],
  ['底部是总开关', '.foot'],
]

for (let i = 0; i < EXPECT.length; i++) {
  const [title, target] = EXPECT[i]
  const r = JSON.parse(await evaluate(`JSON.stringify((() => {
    const hole = document.querySelector('.tour-hole')
    const card = document.querySelector('.tour-card')
    return {
      title: card?.querySelector('.tour-title')?.textContent?.trim() ?? null,
      step: card?.querySelector('.tour-step')?.textContent?.trim() ?? null,
      hole: hole ? { w: Math.round(hole.getBoundingClientRect().width), h: Math.round(hole.getBoundingClientRect().height) } : null,
      targetExists: !!document.querySelector(${JSON.stringify(target)}),
    }
  })())`))
  check(`第 ${i + 1} 步「${title}」标题正确`, r.title === title, `实际：${r.title}`)
  check(`第 ${i + 1} 步目标 ${target} 被挖洞高亮`, !!r.hole && r.hole.w > 4 && r.hole.h > 4, JSON.stringify(r.hole))
  if (i < EXPECT.length - 1) {
    await evaluate(`document.querySelector('.tour-btn.solid')?.click()`)
    await sleep(500)
  }
}

console.log(`\n引导探针：${pass} 过 / ${fail} 挂`)
await close()
process.exit(fail ? 1 : 0)
