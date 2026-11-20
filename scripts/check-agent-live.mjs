/**
 * 打包版里真跑一遍 agent 引擎。
 *
 * verify-agent-sdk 走的是 node 直接加载模块，verify-agent-ui 走的是浏览器 +
 * 假 IPC。这一份补最后一环：**装出来的那个 Nota.exe 里**，ai:agent 这条通道
 * 通不通、net.fetch 在打包环境里发不发得出去、事件有没有真的跨进程送到界面、
 * 工具能不能读到磁盘上的笔记。
 *
 * 模型用本地假服务替掉——真模型每次答得不一样，测不出「哪一步是我们写错的」。
 *
 * 用法: NOTA_UNPACKED=.tmp-unpacked-311 node scripts/check-agent-live.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(
  root,
  process.env.NOTA_UNPACKED || '.tmp-unpacked-311',
  'Nota.exe',
)
if (!fs.existsSync(EXE)) {
  console.log('没有打包产物：', EXE)
  console.log('先解包：7za x release/Nota-Portable-*.exe -o.tmp-unpacked-311')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 假模型服务 ── */
const chunk = (delta, finish = null) => ({
  id: 'c1',
  object: 'chat.completion.chunk',
  model: 'm',
  choices: [{ index: 0, delta, finish_reason: finish }],
})
let rounds = 0
const server = http.createServer(async (req, res) => {
  let raw = ''
  for await (const c of req) raw += c
  let payload = {}
  try {
    payload = JSON.parse(raw)
  } catch {
    /* 忽略 */
  }
  rounds += 1
  const hasTool = (payload.messages ?? []).some((m) => m.role === 'tool')
  const sse = (frames) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  }
  if (!hasTool) {
    sse([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_live1',
            type: 'function',
            function: { name: 'list_notes', arguments: '{}' },
          },
        ],
      }),
      chunk({}, 'tool_calls'),
    ])
  } else {
    sse([chunk({ content: '这是打包版引擎给出的回答。' }), chunk({}, 'stop')])
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port

/* ── 临时工作区：两篇笔记，让 list_notes 真读盘 ── */
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-live-ws-'))
fs.writeFileSync(path.join(WS, '周报-01.md'), '# 周报一\n\n本周做了三件事。', 'utf8')
fs.writeFileSync(path.join(WS, '周报-02.md'), '# 周报二\n\n下周计划两件事。', 'utf8')

const STAMP = Date.now()
const CDP_PORT = 9640 + (STAMP % 150)
const HOME = path.join(root, `.tmp-agent-live-${STAMP}`)
fs.mkdirSync(HOME, { recursive: true })

delete process.env.ELECTRON_RUN_AS_NODE
const app = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`, '--no-sandbox'], {
  stdio: 'ignore',
  env: { ...process.env, NOTA_HOME: HOME },
})

let target = null
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
    if (target) break
  } catch {
    /* 还没起来 */
  }
  await sleep(500)
}
if (!target) {
  app.kill()
  server.close()
  console.log('连不上打包应用')
  process.exit(2)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result)
    pending.delete(m.id)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const myId = ++id
    pending.set(myId, resolve)
    setTimeout(() => reject(new Error(`cdp timeout ${method}`)), 90000)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
  return r.result.value
}

await send('Runtime.enable')
await sleep(2500)

let fail = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${name} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  if (!ok) fail++
}

/* 1. 桥有没有暴露 */
const bridge = await ev(
  `[typeof window.api?.aiAgent, typeof window.api?.onAiAgentEvent].join(',')`,
)
check('L1 preload 暴露了 aiAgent', bridge === 'function,function', String(bridge))

/* 2. 整轮：真 IPC → 主进程 SDK → 本地假服务 → 工具读盘 → 事件回流 */
const wsPath = WS.replace(/\\/g, '/')
const out = await ev(`(async () => {
  const events = []
  window.api.onAiAgentEvent((e) => events.push(e))
  const r = await window.api.aiAgent(
    {
      baseUrl: 'http://127.0.0.1:${PORT}/v1',
      model: 'live-model',
      apiKey: 'sk-live-test',
      system: '你是笔记助手。',
      temperature: 0,
    },
    {
      messages: [{ role: 'user', content: '列出我的笔记' }],
      root: ${JSON.stringify(wsPath)},
      activePath: null,
      draft: '',
    },
  )
  return { r, events }
})()`)

if (out?.__exc) {
  check('L2 一轮对话跑通', false, out.__exc.slice(0, 200))
} else {
  const r = out?.r ?? {}
  const events = out?.events ?? []
  check('L2 一轮对话跑通', r.ok === true, r.error ?? 'ok')
  check('L3 正文回来了', /打包版引擎给出的回答/.test(r.text ?? ''), JSON.stringify(r.text))
  check(
    'L4 工具真的执行了（读了磁盘上的笔记）',
    events.some((e) => e.t === 'tool-start' && e.name === 'list_notes') &&
      events.some((e) => e.t === 'tool-end' && /共 2 篇/.test(e.detail ?? '')),
    JSON.stringify(events.filter((e) => e.t === 'tool-end').map((e) => e.detail)),
  )
  check(
    'L5 事件确实跨进程送到了渲染进程',
    events.some((e) => e.t === 'text') && events.some((e) => e.t === 'stage'),
    `${events.length} 条事件`,
  )
  check('L6 工具次数记了 1', r.toolUses === 1, String(r.toolUses))
  check('L7 服务端收到两轮', rounds === 2, `${rounds} 轮`)
}

/* 3. 密钥形状自查：填成模型名时不发请求，直接给中文提示 */
const before = rounds
const bad = await ev(`(async () => {
  return window.api.aiAgent(
    { baseUrl: 'http://127.0.0.1:${PORT}/v1', model: 'glm-4-flash', apiKey: 'glm-4-flash', system: '', temperature: 0 },
    { messages: [{ role: 'user', content: '在吗' }], root: null, activePath: null, draft: '' },
  )
})()`)
check('L8 密钥填成模型名被当场拦下', bad?.ok === false && /模型名/.test(bad?.error ?? ''), (bad?.error ?? '').slice(0, 60))
check('L9 拦下时连请求都没发', rounds === before, `${before} → ${rounds}`)

/* 4. 连不上：错误得是人话 */
/* 端口不能用 1：Chromium 有一张 unsafe port 黑名单，会先抛
   ERR_UNSAFE_PORT，测不到「连不上」那条文案。挑一个高位空闲端口 */
const dead = await ev(`(async () => {
  return window.api.aiAgent(
    { baseUrl: 'http://127.0.0.1:59987/v1', model: 'm', apiKey: '', system: '', temperature: 0 },
    { messages: [{ role: 'user', content: '在吗' }], root: null, activePath: null, draft: '' },
  )
})()`)
check('L10 连不上时给的是人话', dead?.ok === false && /连不上/.test(dead?.error ?? ''), (dead?.error ?? '').slice(0, 60))

app.kill()
ws.close()
server.close()
try {
  fs.rmSync(HOME, { recursive: true, force: true })
  fs.rmSync(WS, { recursive: true, force: true })
} catch {
  /* 锁了就留给系统临时目录清 */
}
console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
