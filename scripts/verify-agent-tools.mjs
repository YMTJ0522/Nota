/**
 * Agent 工具循环回归：AI 编写从「一次 RAG 对话」升级成真正的 agent
 * （模型申请工具 → 执行 → 结果喂回 → 再问，直到给出最终回答）。
 *
 * A. read_note：模型申请读当前笔记 → 结果喂回 → 第二轮给出回答
 *    （两次调用的工具开关、消息表里的 assistant/tool 配对都要对）
 * B. edit_note：改另一篇笔记 → 内存里的正文真的变了
 * C. create_note：新建笔记并写入内容 → __notes 与目录树都有它
 * D. web_search：联网工具 → 来源挂到消息上
 * E. 服务不认 tools 参数 → 退回普通模式重试，回答照常给出
 * F. 工具参数不是 JSON → 错误喂回模型，它重新作答，步骤记为失败
 */
import { launch } from './cdp-harness.mjs'
import { makeInject } from './fake-workspace.mjs'

const PORT = 4554
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

// 打开一篇笔记当「当前笔记」，read_note 不带 path 读的就是它
await evaluate(
  `(() => { const t=[...document.querySelectorAll('.nlist .nl-item')].find(b=>(b.querySelector('.nl-text')?.textContent??'').includes('甲笔记')); t?.click(); return !!t })()`,
)
await sleep(700)

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
const resetAI = (script) =>
  evaluate(
    `window.__aiScript = ${JSON.stringify(script)}; window.__aiCalls = []; window.__searched = []; true`,
  )

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

/** 等一轮跑完：模型调用次数到位 + 气泡文本两次采样不再变化 */
const waitDone = async (minCalls, timeout = 9000) => {
  const t0 = Date.now()
  let prev = ''
  while (Date.now() - t0 < timeout) {
    await sleep(350)
    const calls = await aiCalls()
    const txt = await lastBubble()
    if (calls.length >= minCalls && txt && txt === prev) return txt
    prev = txt
  }
  return prev
}

const findToolMsg = (msgs, id) =>
  (msgs ?? []).find((m) => m.role === 'tool' && m.tool_call_id === id)

/* ── A. read_note：读当前笔记 → 回答 ── */
await resetAI([
  { deltas: [{ text: '我先看看这篇笔记。' }], toolCalls: [{ id: 'c1', name: 'read_note', args: '{}' }] },
  { deltas: [{ text: '这篇笔记写的是甲的内容。' }], text: '这篇笔记写的是甲的内容。' },
])
await ask('看看当前笔记写了什么')
await waitDone(2)
{
  const calls = await aiCalls()
  const txt = await lastBubble()
  check('A1 两轮模型调用都带工具定义', calls.length === 2 && calls.every((c) => c.hasTools), `calls=${calls.length}`)
  check(
    'A2 第二轮喂回了 assistant(tool_calls)+tool 结果',
    calls[1] &&
      calls[1].msgs.some((m) => m.role === 'assistant' && m.tool_calls) &&
      (findToolMsg(calls[1].msgs, 'c1')?.content ?? '').includes('这是甲的内容'),
    `tool 结果=${findToolMsg(calls[1].msgs, 'c1')?.content?.slice(0, 30) ?? '(无)'}`,
  )
  check('A3 中间叙述与最终回答都流进了同一条气泡', txt.includes('我先看看') && txt.includes('甲的内容'), txt.slice(0, 40))
  const steps = await lastSteps()
  check(
    'A4 执行过程记了「读取笔记」一步',
    steps.some((s) => s.label.includes('读取笔记') && !s.fail),
    steps.map((s) => s.label).join(' | ').slice(0, 80),
  )
}

/* ── B. edit_note：改另一篇 ── */
await resetAI([
  {
    toolCalls: [
      {
        id: 'e1',
        name: 'edit_note',
        args: JSON.stringify({ path: '/ws/乙笔记.md', find: '这是乙的内容。', replace: '这是乙改过的内容。' }),
      },
    ],
  },
  { text: '已经改好了。' },
])
await ask('把乙笔记里那句内容改成改过的版本')
await waitDone(2)
{
  const calls = await aiCalls()
  const note = await evaluate(`window.__notes['/ws/乙笔记.md'] ?? ''`)
  check('B1 笔记正文真的被改了', note.includes('乙改过的内容'), note.slice(0, 30))
  check(
    'B2 工具结果「已替换 1 处」喂回了模型',
    (findToolMsg(calls[1]?.msgs, 'e1')?.content ?? '').includes('已替换 1 处'),
    findToolMsg(calls[1]?.msgs, 'e1')?.content ?? '(无)',
  )
  const steps = await lastSteps()
  check('B3 执行过程记了「修改笔记」', steps.some((s) => s.label.includes('修改笔记') && !s.fail), '')
}

/* ── C. create_note：新建并写入 ── */
await resetAI([
  {
    toolCalls: [
      {
        id: 'n1',
        name: 'create_note',
        args: JSON.stringify({ name: 'Agent建的笔记', content: '# 新篇\n\nagent 写进去的。' }),
      },
    ],
  },
  { text: '建好了。' },
])
await ask('帮我新建一篇叫 Agent建的笔记 的笔记')
await waitDone(2)
{
  const note = await evaluate(`window.__notes['/ws/Agent建的笔记.md'] ?? ''`)
  const inTree = await evaluate(
    `(() => { let ok=false; const walk=(ns)=>{for(const n of ns){ if(n.path==='/ws/Agent建的笔记.md') ok=true; if(n.children) walk(n.children) }}; walk(window.__tree); return ok })()`,
  )
  check('C1 笔记已创建且内容写入', note.includes('agent 写进去的'), note.slice(0, 20))
  check('C2 目录树里出现了新笔记', !!inTree, '')
  const calls = await aiCalls()
  check(
    'C3 工具结果带上了创建路径',
    (findToolMsg(calls[1]?.msgs, 'n1')?.content ?? '').includes('Agent建的笔记.md'),
    findToolMsg(calls[1]?.msgs, 'n1')?.content ?? '(无)',
  )
}

/* ── D. web_search：联网工具 ── */
await resetAI([
  { toolCalls: [{ id: 'w1', name: 'web_search', args: JSON.stringify({ query: 'electron 最新版本' }) }] },
  { text: '根据检索到的资料回答。' },
])
await ask('现在 electron 最新版本是多少')
await waitDone(2)
{
  const calls = await aiCalls()
  const searched = await evaluate(`(window.__searched ?? []).join(',')`)
  check('D1 联网工具把检索词送进了搜索桩', searched.includes('electron'), searched)
  check(
    'D2 检索结果作为工具结果喂回了模型',
    (findToolMsg(calls[1]?.msgs, 'w1')?.content ?? '').includes('example.com'),
    (findToolMsg(calls[1]?.msgs, 'w1')?.content ?? '').slice(0, 40),
  )
}

/* ── E. 服务不认 tools → 退回普通模式 ── */
await resetAI([
  { ok: false, error: 'HTTP 400 "tools is not supported"' },
  { text: '普通模式的回答。' },
])
await ask('随便聊两句')
await waitDone(2)
{
  const calls = await aiCalls()
  const txt = await lastBubble()
  check(
    'E1 第一次带 tools、重试不带',
    calls.length === 2 && calls[0].hasTools === true && calls[1].hasTools === false,
    `calls=${calls.length}`,
  )
  check('E2 退回后回答照常给出', txt.includes('普通模式的回答。'), txt)
  const steps = await lastSteps()
  check('E3 执行过程记了退回这一步', steps.some((s) => s.label.includes('不支持工具')), '')
}

/* ── F. 工具参数不是 JSON → 错误喂回 ── */
await resetAI([
  { toolCalls: [{ id: 'b1', name: 'search_notes', args: 'oops-not-json' }] },
  { text: '刚才参数坏了，重新来过。' },
])
await ask('在工作区里搜一下甲')
await waitDone(2)
{
  const calls = await aiCalls()
  const steps = await lastSteps()
  check(
    'F1 坏参数的错误信息喂回了模型',
    (findToolMsg(calls[1]?.msgs, 'b1')?.content ?? '').includes('不是合法 JSON'),
    findToolMsg(calls[1]?.msgs, 'b1')?.content?.slice(0, 40) ?? '(无)',
  )
  check('F2 这一步在执行过程里标成失败', steps.some((s) => s.fail), '')
}

console.log(fail === 0 ? '\n✅ 全部通过' : `\n❌ ${fail} 项失败`)
await close()
process.exit(fail ? 1 : 0)
