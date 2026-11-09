/**
 * 「测试成功、聊天报错」修复的 UI 层回归（浏览器 harness，window.api 为桩）：
 *
 * A. 设置 › AI › 测试连接：服务器把 modelError 带回来时，结果要亮红讲清
 *    「连接成功，但当前模型有问题」，不能只说连接成功让人聊天翻车
 * B. 聊天面板模型菜单：当前模型不在服务列表里时，底部说明点名警告
 * C. 模型在列表里时不误报
 */
import { launch } from './cdp-harness.mjs'
import { makeInject } from './fake-workspace.mjs'

const PORT = 4560
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

let fail = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${name} — ${detail}`)
  if (!ok) fail++
}

/* ── A. 设置里的测试连接：modelError 必须亮出来 ── */
await evaluate(
  `window.__aiTestResult = { ok: true, models: ['gemma3:12b', 'qwen3:8b'], modelError: '测试用的模型问题说明' }; true`,
)
await evaluate(`(() => {
  const btns = [...document.querySelectorAll('[data-tip="设置"]')]
  const b = btns.find((x) => x.offsetParent !== null)
  b?.click(); return !!b
})()`)
await sleep(700)
await evaluate(`(() => {
  const nav = [...document.querySelectorAll('.st-nav-item')].find((b) => b.textContent.includes('AI'))
  nav?.click(); return true
})()`)
await sleep(500)
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.st-btn')].find((x) => x.textContent.includes('测试连接'))
  b?.click(); return !!b
})()`)
// 等结果落定
let text = ''
for (let i = 0; i < 16; i++) {
  await sleep(400)
  text = String(
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('.st-btn')].find((x) => x.textContent.includes('测试连接'))
      return b?.closest('.st-row')?.querySelector('.st-desc')?.textContent ?? ''
    })()`),
  )
  if (text) break
}
check('A1 测试结果点名「当前模型有问题」', text.includes('但当前模型有问题'), text.slice(0, 60))
check('A2 模型列表仍然展示', String(await evaluate(`[...document.querySelectorAll('.st-chip')].map(c=>c.textContent.trim()).join(',')`)).includes('gemma3:12b'), '')
await evaluate(`document.querySelector('.st-x')?.click()`)
await sleep(500)

/* ── B/C. 聊天面板模型菜单的警告 ── */
const nav = (label) =>
  evaluate(
    `(() => { const b=[...document.querySelectorAll('.panel .nav-item')].find(x=>(x.querySelector('.nav-label')?.textContent??'').trim()===${JSON.stringify(label)}); b?.click(); return !!b })()`,
  )
await evaluate(
  `(() => {
    const s = JSON.parse(localStorage.getItem('nota-ai') || '{}')
    s.model = 'ghost-model'
    localStorage.setItem('nota-ai', JSON.stringify(s))
    return true
  })()`,
)
await evaluate('location.reload()')
await sleep(1400)
await evaluate(makeInject({}))
await sleep(600)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(900)
await evaluate(makeInject({}))
await sleep(600)
await nav('AI 编写')
await sleep(800)
await evaluate(`(() => {
  const b = document.querySelector('.composer .ag-model')
  b?.click(); return !!b
})()`)
await sleep(500)
const hint = String(await evaluate(`document.querySelector('.composer .m-menu .n-menu-hint')?.textContent ?? ''`))
check('B1 模型不在列表时菜单里点名警告', hint.includes('ghost-model') && hint.includes('不在列表里'), hint.slice(0, 70))

// 换成列表里有的模型，不应再警告
await evaluate(`(() => {
  const it = [...document.querySelectorAll('.composer .m-menu .n-menu-item')].find((x) => x.textContent.includes('gemma3:12b'))
  it?.click(); return !!it
})()`)
await sleep(300)
await evaluate(`document.querySelector('.composer .ag-model')?.click()`)
await sleep(400)
const hint2 = String(await evaluate(`document.querySelector('.composer .m-menu .n-menu-hint')?.textContent ?? ''`))
check('C1 模型在列表里时不误报', !hint2.includes('不在列表里'), hint2.slice(0, 70))

console.log(fail === 0 ? '\n✅ 全部通过' : `\n❌ ${fail} 项失败`)
await close()
process.exit(fail ? 1 : 0)
