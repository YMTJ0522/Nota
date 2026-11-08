/**
 * 资料栏顶栏「新建笔记 / 导入已有笔记」的可见性回归：
 * 这两枚只该长在跟笔记有关的屏（笔记 / 大纲 / 链接页签、AI 编写），
 * 附件库和回收站必须隐藏 —— 用户点侧栏「附件库」时手一偏就按到顶上的
 * 「新建笔记」，凭空多出一篇空笔记。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject } from './fake-workspace.mjs'

const PORT = 4531
const { send, evaluate, sleep, close } = await launch({ port: PORT, size: [1500, 950] })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1400)
await evaluate(`localStorage.setItem('nota-tour-seen', '1')`)
await evaluate('location.reload()')
await sleep(1200)
const inj = makeInject({})
await evaluate(inj)
await sleep(600)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(900)
await evaluate(inj)
await sleep(600)

const nav = (label) =>
  evaluate(
    `(() => { const b=[...document.querySelectorAll('.panel .nav-item')].find(x=>(x.querySelector('.nav-label')?.textContent??'').trim()===${JSON.stringify(label)}); b?.click(); return !!b })()`,
  )
const acts = () =>
  evaluate(
    `JSON.stringify({ new: !!document.querySelector('.col [data-role=new-note]'), imp: !!document.querySelector('.col [data-role=import-note]'), name: document.querySelector('.col-name')?.textContent?.trim() ?? document.querySelector('.col-tab.on')?.textContent?.trim() })`,
  ).then(JSON.parse)

let fail = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${name} — ${detail}`)
  if (!ok) fail++
}

await nav('所有笔记')
await sleep(500)
let r = await acts()
check('笔记屏保留新建/导入', r.new && r.imp, JSON.stringify(r))

await nav('附件库')
await sleep(500)
r = await acts()
check('附件库隐藏新建/导入', !r.new && !r.imp, JSON.stringify(r))

await nav('回收站')
await sleep(500)
r = await acts()
check('回收站隐藏新建/导入', !r.new && !r.imp, JSON.stringify(r))

await nav('AI 编写')
await sleep(500)
r = await acts()
check('AI 编写屏保留新建/导入', r.new && r.imp, JSON.stringify(r))

await nav('所有笔记')
await sleep(500)
r = await acts()
check('回到笔记屏按钮恢复', r.new && r.imp, JSON.stringify(r))

console.log(fail === 0 ? '\n✅ 全部通过' : `\n❌ ${fail} 项失败`)
await close()
process.exit(fail ? 1 : 0)
