/**
 * 附件库删除确认弹窗回归：
 * 卡片右下角那个单删按钮原来直接调 remove()，一声不吭就把文件从磁盘抹了
 * （批量删除有确认、单删没有，是个漏网）。现在单删也并进 ConfirmDialog。
 *
 * A. 点卡片垃圾桶 → 弹确认（文件还没删）
 * B. 点「删除」确认 → 文件真的没了，卡片和侧栏计数跟着走
 * C. 再点一张 → 点「取消」→ 文件还在
 */
import { launch } from './cdp-harness.mjs'
import { makeInject } from './fake-workspace.mjs'

const PORT = 4546
const { send, evaluate, sleep, close } = await launch({ port: PORT, size: [1500, 950] })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1400)
await evaluate(`localStorage.setItem('nota-tour-seen', '1')`)
await evaluate('location.reload()')
await sleep(1200)
await evaluate(makeInject({}))
await sleep(600)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(900)
await evaluate(makeInject({}))
await sleep(600)

const nav = (label) =>
  evaluate(
    `(() => { const b=[...document.querySelectorAll('.panel .nav-item')].find(x=>(x.querySelector('.nav-label')?.textContent??'').trim()===${JSON.stringify(label)}); b?.click(); return !!b })()`,
  )

let fail = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${name} — ${detail}`)
  if (!ok) fail++
}

const attachCount = () =>
  evaluate(`window.__attach.length`).then(Number)
const cardCount = () =>
  evaluate(`document.querySelectorAll('.av-card').length`).then(Number)
const dialog = () =>
  evaluate(
    `(() => { const m=document.querySelector('.cf-mask'); if(!m) return null; return JSON.stringify({ title: m.querySelector('.cf-title')?.textContent?.trim() ?? '', msg: m.querySelector('.cf-msg')?.textContent?.trim() ?? '' }) })()`,
  ).then((s) => (s ? JSON.parse(s) : null))
const clickDialog = (sel) =>
  evaluate(`(() => { const b=document.querySelector('${sel}'); b?.click(); return !!b })()`)

await nav('附件库')
await sleep(700)

// A. 单删按钮弹确认，且此刻文件还在
const before = await attachCount()
await evaluate(`(() => { const b=document.querySelector('.av-card .av-del'); b?.click(); return !!b })()`)
await sleep(500)
const d1 = await dialog()
check('A1 点单删弹出确认框', !!d1, JSON.stringify(d1))
check('A2 确认框文案带文件名', d1?.msg?.includes('封面.png') ?? false, d1?.msg ?? '(无)')
check('A3 弹窗期间文件未删', (await attachCount()) === before, `__attach=${await attachCount()}/${before}`)

// B. 确认删除 → 文件消失
await clickDialog('.cf-danger')
await sleep(600)
check('B1 确认后文件删除', (await attachCount()) === before - 1, `__attach=${await attachCount()}`)
check('B2 卡片同步少一张', (await cardCount()) === before - 1, `cards=${await cardCount()}`)
check('B3 弹窗已关', (await dialog()) === null, '')

// C. 取消 → 文件还在
await evaluate(`(() => { const b=document.querySelector('.av-card .av-del'); b?.click(); return !!b })()`)
await sleep(400)
await clickDialog('.cf-cancel')
await sleep(400)
check('C1 取消后文件还在', (await attachCount()) === before - 1, `__attach=${await attachCount()}`)
check('C2 弹窗已关', (await dialog()) === null, '')

console.log(fail === 0 ? '\n✅ 全部通过' : `\n❌ ${fail} 项失败`)
await close()
process.exit(fail ? 1 : 0)
