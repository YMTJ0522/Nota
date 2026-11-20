/**
 * 设置 › AI 里「密钥填错格子」的当场提示（浏览器 harness，window.api 为桩）。
 *
 * 真实事故：用户把 Ollama 的模型名 qwen2.5-coder:7b 粘进了 API Key 框，
 * 接口一直 401，界面上只有「身份验证失败」。这里验证：
 *
 * A. 密钥框里是模型名 → 当场出现红字，并点明该填到「模型名称」
 * B. 换成正常密钥形状 → 红字消失，不能一惊一乍
 * C. 选带控制台的服务商时，密钥行有「去哪拿」的链接
 * D. 选本地模型（Ollama）时不摆链接，只说留空
 */
import { launch } from './cdp-harness.mjs'
import { makeInject } from './fake-workspace.mjs'

const PORT = 4562
const { evaluate, send, sleep, close } = await launch({ port: PORT, size: [1500, 950] })
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
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${name} — ${detail}`)
  if (!ok) fail++
}

/* 打开 设置 › AI */
await evaluate(`(() => {
  const b = [...document.querySelectorAll('[data-tip="设置"]')].find((x) => x.offsetParent !== null)
  b?.click(); return !!b
})()`)
await sleep(700)
await evaluate(`(() => {
  const nav = [...document.querySelectorAll('.st-nav-item')].find((b) => b.textContent.includes('AI'))
  nav?.click(); return true
})()`)
await sleep(600)

/** 选服务商预设：点开下拉 → 点目标项 */
const pickPreset = async (label) => {
  await evaluate(`document.querySelector('[data-role="preset-select"]')?.click()`)
  await sleep(350)
  const ok = await evaluate(`(() => {
    const it = document.querySelector('[data-preset=${JSON.stringify(label)}]')
    it?.click(); return !!it
  })()`)
  await sleep(450)
  return ok
}

/** 往 API Key 那一格写值并触发 v-model */
const typeKey = (v) =>
  evaluate(`(() => {
    const row = [...document.querySelectorAll('.st-row')].find((r) => r.textContent.includes('API Key'))
    const inp = row?.querySelector('input')
    if (!inp) return 'NO_INPUT'
    inp.value = ${JSON.stringify(v)}
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    return 'OK'
  })()`)

const warnText = () =>
  evaluate(`(() => {
    const w = document.querySelector('.st-warn')
    return w ? w.textContent.trim() : ''
  })()`)

const keyRow = () =>
  evaluate(`(() => {
    const row = [...document.querySelectorAll('.st-row')].find((r) => r.textContent.includes('API Key'))
    const a = row?.querySelector('a.st-link')
    return {
      link: a ? a.getAttribute('href') : '',
      linkText: a ? a.textContent.trim() : '',
      desc: row?.querySelector('.st-desc')?.textContent.trim() ?? '',
    }
  })()`)

/* 换到智谱：这一档带控制台链接 */
const pickedZhipu = await pickPreset('智谱 GLM')
check('0 能选中服务商预设', pickedZhipu, pickedZhipu ? '已选 智谱 GLM' : '下拉里没找到')

/* ── A. 把模型名粘进密钥框 ── */
await typeKey('qwen2.5-coder:7b-instruct-q4_K_M')
await sleep(400)
let t = await warnText()
check('A1 模型名填进密钥框 → 当场提示', t.includes('模型名'), t.slice(0, 46))
check('A2 提示里指出该填到「模型名称」', t.includes('模型名称'), t.slice(0, 60))

/* ── B. 换成正常密钥形状 ── */
await typeKey('9f8e7d6c1a2b3c4d.5e6f7g8h9i0j')
await sleep(400)
t = await warnText()
check('B 正常密钥形状 → 提示消失', t === '', t || '（无提示）')

/* ── C. 带控制台的服务商要给出链接 ── */
const c = await keyRow()
check('C 密钥行有「去哪拿」的链接', /^https:/.test(c.link), c.link ? `${c.linkText} → ${c.link}` : '没有链接')

/* ── D. 切到本地 Ollama：不该再摆注册链接 ── */
const pickedLocal = await pickPreset('Ollama（本地）')
if (pickedLocal) {
  const d = await keyRow()
  check('D 本地模型不给注册链接，只说留空', !d.link && d.desc.includes('留空'), d.desc.slice(0, 50))
} else {
  check('D 能切回本地 Ollama', false, '下拉里没找到 Ollama')
}

console.log(fail === 0 ? '\n✅ 全部通过' : `\n❌ ${fail} 项失败`)
await close()
process.exit(fail === 0 ? 0 : 1)
