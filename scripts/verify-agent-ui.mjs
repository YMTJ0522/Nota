/**
 * AI SDK 引擎在界面上的表现。
 *
 * verify-agent-sdk.mjs 验的是主进程那一侧（工具真的执行了没有、循环走对
 * 没有）；这一份验的是渲染进程这一侧：事件过来之后，气泡正文是不是一段
 * 段长出来、工具步骤有没有标签和状态、来源有没有挂到脚注上、失败时这轮
 * 是不是红的。中间那层 IPC 用桩替掉，桩的形状和 preload 暴露的一致。
 *
 * 直接跑：node scripts/verify-agent-ui.mjs
 */
import { launch } from './cdp-harness.mjs'
import { makeInject } from './fake-workspace.mjs'

const PORT = 4561
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
await nav('AI 编写')
await sleep(800)

let fail = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${name} — ${detail}`)
  if (!ok) fail++
}

const lastBubble = () =>
  evaluate(
    `(() => { const b=[...document.querySelectorAll('.row.assistant .md-body')].pop(); return b ? b.textContent : '' })()`,
  )
const lastSteps = () =>
  evaluate(
    `(() => [...document.querySelectorAll('.row.assistant .step')].map(s => JSON.stringify({ text: s.textContent.trim().replace(/\\s+/g,' ').slice(0, 60), fail: s.dataset.status === 'fail' })))()`,
  ).then((a) => a.map((s) => JSON.parse(s)))
const srcCount = () =>
  evaluate(
    `(() => { const c=[...document.querySelectorAll('.row.assistant .srcs')].pop(); return c ? c.querySelectorAll('a').length : 0 })()`,
  )
const agentCalls = () => evaluate('window.__agentCalls').then((c) => c ?? [])

const reset = (opt) =>
  evaluate(`(() => {
    window.__agentScript = ${JSON.stringify(opt.script ?? [])};
    window.__agentCalls = [];
    window.__searched = [];
    window.__silentCalls = [];
    window.__rewriteQueue = ${JSON.stringify(opt.rewrite ?? [])};
    window.__webByQuery = ${JSON.stringify(opt.web ?? {})};
    return true
  })()`)

const ask = async (text) => {
  await evaluate(`(() => {
    const el = document.querySelector('.composer .input')
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(120)
  await evaluate(`document.querySelector('.composer .send')?.click()`)
}

const waitDone = async (timeout = 12000) => {
  const t0 = Date.now()
  let prev = ''
  let stable = 0
  while (Date.now() - t0 < timeout) {
    await sleep(300)
    const txt = await lastBubble()
    if (txt && txt === prev) {
      stable += 1
      if (stable >= 3) return txt
    } else {
      stable = 0
    }
    prev = txt
  }
  return prev
}

/* ── S0. 设置里不该再有引擎开关：引擎只剩一套，用户不用选 ── */
{
  const opened = await evaluate(`(() => {
    const b=[...document.querySelectorAll('.ae-fact')].find(x=>/设置/.test(x.textContent||''));
    b?.click(); return !!b
  })()`)
  await sleep(500)
  const hasEngine = await evaluate(`(() => {
    if (/对话引擎/.test(document.body.textContent || '')) return true
    return [...document.querySelectorAll('.st-chip')].some(x => /^(AI SDK|旧版)$/.test((x.textContent||'').trim()))
  })()`)
  /* 切到 AI 分区，确认这一区还在、温度这类真选项没被一起删掉 */
  await evaluate(`(() => {
    const sec=[...document.querySelectorAll('.st-nav-item, .nav-item')].find(x=>/AI 编写/.test(x.textContent||''));
    sec?.click(); return !!sec
  })()`)
  await sleep(400)
  const hasTemp = await evaluate(`(() => /温度/.test(document.body.textContent || ''))()`)
  await evaluate(`document.querySelector('.st-x')?.click()`)
  await sleep(400)
  check('S0a 从空状态能打开设置', opened, String(opened))
  check('S0b 设置里没有对话引擎这一项', !hasEngine, String(hasEngine))
  check('S0c AI 分区还在（温度仍在）', hasTemp, String(hasTemp))
}

/* ── S1. 工具步骤 + 分段正文 + 来源 ── */
await reset({
  script: [
    [
      { t: 'stage', text: '正在列出笔记…' },
      { t: 'tool-start', id: 'c1', name: 'list_notes', detail: '周报' },
      { t: 'tool-end', id: 'c1', ok: true, detail: '共 2 篇' },
      { t: 'text', text: '库里有' },
      { t: 'text', text: '两篇周报。' },
      { t: 'sources', hits: [{ title: '海康威视 运维 - 知乎', url: 'https://zhihu.example/b' }] },
    ],
  ],
})
await ask('库里有哪些周报')
await waitDone()
{
  const txt = await lastBubble()
  const steps = await lastSteps()
  const calls = await agentCalls()
  const srcs = await srcCount()

  check('S1a 分段正文拼成一段话', txt.includes('库里有') && txt.includes('两篇周报。'), JSON.stringify(txt))
  check(
    'S1b 工具步骤画出了中文标签',
    steps.some((s) => s.text.includes('列出笔记')),
    JSON.stringify(steps.map((s) => s.text)),
  )
  check('S1c 步骤细节换成执行结果', steps.some((s) => s.text.includes('共 2 篇')), JSON.stringify(steps.map((s) => s.text)))
  check('S1d 成功的步骤不是红的', steps.every((s) => !s.fail), JSON.stringify(steps.filter((s) => s.fail).map((s) => s.text)))
  check('S1e 来源挂到了脚注', srcs === 1, `${srcs} 条`)

  const call = calls[0] ?? {}
  const req = call.req ?? {}
  const last = req.messages?.[req.messages.length - 1]
  check('S1f 最后一条消息是用户问题', last?.role === 'user' && last?.content === '库里有哪些周报', JSON.stringify(last))
  check('S1g 请求里带了工作区与当前笔记', !!req.root, String(req.root))
  check('S1h 请求里带了草稿', typeof req.draft === 'string', typeof req.draft)
  check(
    'S1i 系统提示里写了 agent 规矩',
    /agent|工具/.test(call.cfg?.system ?? ''),
    (call.cfg?.system ?? '').slice(0, 40),
  )
}

/* ── S2. 工具失败 → 这一步是红的，但整轮还有回答 ── */
await reset({
  script: [
    [
      { t: 'tool-start', id: 'c2', name: 'read_note', detail: '周报-01.md' },
      { t: 'tool-end', id: 'c2', ok: false, detail: '路径不在工作区里' },
      { t: 'text', text: '那篇读不到，换了一篇。' },
    ],
  ],
})
await ask('读一下周报')
await waitDone()
{
  const steps = await lastSteps()
  const txt = await lastBubble()
  check('S2a 失败步骤标了红', steps.some((s) => s.fail), JSON.stringify(steps))
  check('S2b 失败原因写在步骤里', steps.some((s) => s.text.includes('路径不在工作区')), JSON.stringify(steps.map((s) => s.text)))
  check('S2c 整轮仍然有正文', txt.includes('换了一篇'), JSON.stringify(txt))
}

/* ── S3. 整轮失败 → 气泡显示错误，不装成回答 ── */
await reset({ script: [{ fail: '密钥被服务拒绝了（401）。到设置里核对 API Key。' }] })
await ask('测试一下失败')
await sleep(1500)
{
  const errText = await evaluate(
    `(() => { const e=[...document.querySelectorAll('.row.assistant .err')].pop(); return e ? e.textContent.trim() : '' })()`,
  )
  check('S3a 错误显示在气泡上', /401/.test(errText), JSON.stringify(errText.slice(0, 60)))
}

await close()
console.log(fail ? `\n${fail} 项没通过` : '\n全部通过')
process.exit(fail ? 1 : 0)
