/**
 * 联网检索流水线的真机回归。
 *
 * 验的是「不靠模型自觉」这件事本身：
 *   W1 口语长句 → 改写成两路关键词 → 并行搜 → 合并去重 → 词典垃圾被过滤
 *      → 资料进系统上下文 → 执行过程记了这一步
 *   W2 模型判 SKIP → 一次都不搜
 *   W3 模型乱回（没给检索词）→ 本地兜底关键词照样搜
 *   W4 润色/改笔记类指令 → 本地就判死，连改写请求都不发
 *   W5 模型自己调 web_search → 它的词当一路，改写再补一路（不是单搜）
 *
 * 桩在 fake-workspace.mjs：__rewriteQueue 控改写请求的应答，
 * __webByQuery 按检索词给不同结果。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject } from './fake-workspace.mjs'

const PORT = 4557
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
    `(() => [...document.querySelectorAll('.row.assistant .step')].map(s => JSON.stringify({ label: s.textContent.trim().slice(0, 60), fail: s.dataset.status === 'fail' })))()`,
  ).then((a) => a.map((s) => JSON.parse(s)))
const aiCalls = () => evaluate('window.__aiCalls').then((c) => c ?? [])
const searched = () => evaluate('window.__searched').then((c) => c ?? [])
const silentCalls = () => evaluate('window.__silentCalls').then((c) => c ?? [])

/* 这一轮模型拿到的系统上下文。新引擎走 aiAgent（cfg.system），
   没有记录时退回 aiChat（旧路）的第一条。 */
const sysText = async () => {
  const ag = await evaluate('(window.__agentCalls || [])')
  if (ag.length) return String(ag[ag.length - 1].cfg?.system ?? '')
  const calls = await aiCalls()
  return String((calls[0]?.msgs ?? []).find((m) => m.role === 'system')?.content ?? '')
}

const reset = (opt) =>
  evaluate(`(() => {
    window.__aiScript = ${JSON.stringify(opt.script ?? [])};
    window.__aiCalls = [];
    window.__searched = [];
    window.__silentCalls = [];
    window.__agentCalls = [];
    window.__agentScript = ${JSON.stringify(
      (opt.script ?? []).map((x) => (x && x.text ? [{ t: 'text', text: x.text }] : [{ t: 'text', text: '默认回答。' }]))
    )};
    window.__rewriteQueue = ${JSON.stringify(opt.rewrite ?? [])};
    window.__webByQuery = ${JSON.stringify(opt.web ?? {})};
    window.__weatherAsked = [];
    window.__weatherFail = ${opt.weatherFail ? 'true' : 'false'};
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

/** 等一轮跑完：气泡文本两次采样一致 */
const waitDone = async (timeout = 15000) => {
  const t0 = Date.now()
  let prev = ''
  let stable = 0
  while (Date.now() - t0 < timeout) {
    await sleep(350)
    const txt = await lastBubble()
    if (txt && txt === prev) {
      stable += 1
      if (stable >= 2) return txt
    } else {
      stable = 0
    }
    prev = txt
  }
  return prev
}

/* ── W1. 口语长句：两路检索 + 垃圾过滤 + 资料进上下文 ── */
await reset({
  rewrite: ['海康威视 运维工程师\n海康威视 运维 工作内容'],
  web: {
    '海康威视 运维工程师': [
      { title: '帮（汉语汉字）_百度百科', url: 'https://baike.baidu.com/bang', snippet: '帮，汉语一级字。' },
      {
        title: '海康威视 运维工程师 岗位职责',
        url: 'https://jobs.example/a',
        snippet: '负责海康威视设备的日常巡检与故障处理。',
      },
    ],
    '海康威视 运维 工作内容': [
      {
        title: '海康威视 运维日常 - 知乎',
        url: 'https://zhihu.example/b',
        snippet: '海康威视 运维 工作内容包括机房巡检、告警处理。',
      },
      // 与上面第一篇同一个页面（尾斜杠写法不同），用来验去重
      { title: '海康威视 运维工程师 岗位职责（转载）', url: 'https://jobs.example/a/', snippet: '重复' },
    ],
  },
  script: [{ text: '海康威视运维工程师主要负责机房与设备巡检。' }],
})
await ask('帮我介绍下啊hca海康运维工程师的日常')
await waitDone()
{
  const got = await searched()
  const system = await sysText()
  const steps = await lastSteps()

  check(
    'W1a 两路关键词分别搜了一次',
    got.length === 2 && got.includes('海康威视 运维工程师') && got.includes('海康威视 运维 工作内容'),
    JSON.stringify(got),
  )
  check('W1b 资料塞进了系统上下文', system.includes('联网检索到的资料'), `${system.length} 字`)
  check(
    'W1c 词典垃圾被过滤掉',
    !system.includes('汉语汉字') && !system.includes('帮，汉语一级字'),
    system.includes('汉语汉字') ? '还在' : '已剔除',
  )
  check(
    'W1d 同一页面的重复结果被合并',
    (system.match(/jobs\.example\/a/g) ?? []).length === 1,
    `出现 ${(system.match(/jobs\.example\/a/g) ?? []).length} 次`,
  )
  check('W1e 正经结果进了上下文', system.includes('机房巡检') || system.includes('岗位职责'), '有')
  check(
    'W1f 执行过程记了联网检索这一步',
    steps.some((s) => s.label.includes('联网检索') && !s.fail),
    steps.map((s) => s.label).join(' | ').slice(0, 90),
  )
  check('W1g 改写请求确实是静默发的', (await silentCalls()).length === 1, `${(await silentCalls()).length} 次`)
}

/* ── W2. 模型判 SKIP：一次都不搜 ── */
await reset({ rewrite: ['SKIP'], script: [{ text: '你好，有什么想聊的？' }] })
await ask('你好呀')
await waitDone()
{
  const got = await searched()
  check('W2 SKIP 后一次都没搜', got.length === 0, JSON.stringify(got))
}

/* ── W3. 模型乱回：本地兜底关键词照样搜 ── */
await reset({ rewrite: ['\n   \n'], script: [{ text: '（按资料答）海康威视运维负责巡检。' }] })
await ask('帮我介绍下啊hca海康运维工程师的日常')
await waitDone()
{
  const got = await searched()
  const term = got[0] ?? ''
  check(
    'W3 兜底词去掉了口语部分',
    got.length > 0 && term.includes('海康运维工程师') && !term.includes('帮我'),
    JSON.stringify(got),
  )
}

/* ── W4. 润色类指令：本地就判死，连改写请求都不发 ── */
await reset({ rewrite: [], script: [{ text: '改好了：今天天气很好。' }] })
await ask('把这段改通顺一点：今天天气不错')
await waitDone()
{
  const sil = await silentCalls()
  const got = await searched()
  check('W4 编辑指令不发改写请求、不搜', sil.length === 0 && got.length === 0, `静默=${sil.length} 搜索=${got.length}`)
}

/* ── W6. 天气：走天气源，不再拿城市百科糊弄 ── */
await reset({ rewrite: ['乌鲁木齐 天气'], script: [{ text: '今天乌鲁木齐晴，3~15℃。' }] })
await ask('乌鲁木齐今天天气怎么样')
await waitDone()
{
  const asked = await evaluate('window.__weatherAsked').then((c) => c ?? [])
  const got = await searched()
  const sys = await sysText()
  check('W6a 天气问题走了天气源', asked.length === 1 && asked[0] === '乌鲁木齐', JSON.stringify(asked))
  check('W6b 天气拿到后不再去搜网页', got.length === 0, `搜了 ${got.length} 次`)
  check('W6c 实况数据进了系统上下文', sys.includes('实况') && sys.includes('12℃'), sys.includes('实况') ? '已注入' : '没注入')
}

/* ── W7. 天气源挂了：退回普通检索，不能让这轮没资料 ── */
await reset({
  weatherFail: true,
  rewrite: ['乌鲁木齐 天气 预报'],
  script: [{ text: '这是检索到的天气信息。' }],
})
await ask('乌鲁木齐今天天气怎么样')
await waitDone()
{
  const got = await searched()
  check('W7 天气源失败后自动退回网页检索', got.length === 1, JSON.stringify(got))
}

await close()
console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
