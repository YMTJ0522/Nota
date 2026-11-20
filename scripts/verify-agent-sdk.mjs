/**
 * AI SDK 引擎的回归。
 *
 * 起一个假的 OpenAI 兼容服务，按剧本回 SSE，然后看引擎这边：工具定义有没有
 * 编进请求、tool_call 有没有被执行并喂回去、只思考不回答有没有补一次、出错
 * 有没有翻成人话。整条链不碰真模型——真模型每次答得不一样，测不出「哪一步
 * 是我们写错了」。
 *
 * 直接跑：node scripts/verify-agent-sdk.mjs
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import http from 'node:http'

/* ── 打包被测模块 ──
   ai 这包会拉进 @vercel/oidc，里面有动态 require("path")——打成 ESM 会在
   加载时就崩。所以打 CJS，和主进程真实产物（dist-electron/main.cjs）同一
   种形态，测的东西更贴近线上。 */
const dir = mkdtempSync(join(tmpdir(), 'nota-agent-'))
const out = join(dir, 'agent.cjs')
await build({
  entryPoints: ['electron/agentSdk.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out,
  logLevel: 'silent',
})
const agent = createRequire(import.meta.url)(out)
rmSync(dir, { recursive: true, force: true })

let fail = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${name} — ${detail}`)
  if (!ok) fail++
}

/* ── 假服务：按场景回 SSE ── */
let scenario = 'plain'
let lastBody = null
let calls = 0

const sse = (res, frames) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}
const chunk = (delta, finish = null) => ({
  id: 'c1',
  object: 'chat.completion.chunk',
  model: 'm',
  choices: [{ index: 0, delta, finish_reason: finish }],
})

const server = http.createServer(async (req, res) => {
  let raw = ''
  for await (const c of req) raw += c
  let payload = {}
  try {
    payload = JSON.parse(raw)
  } catch {
    /* 忽略 */
  }
  lastBody = payload
  calls += 1
  const hasToolResult = (payload.messages ?? []).some((m) => m.role === 'tool')
  const lastMessage = (payload.messages ?? []).at(-1)?.content ?? ''

  if (scenario === 'unauthorized') {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid API key provided' } }))
    return
  }

  if (scenario === 'tool') {
    // 第一轮：申请 list_notes；带 tool 结果的那一轮：给正文
    if (!hasToolResult) {
      sse(res, [
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_abc',
              type: 'function',
              function: { name: 'list_notes', arguments: '{"filter":"周报"}' },
            },
          ],
        }),
        chunk({}, 'tool_calls'),
      ])
    } else {
      sse(res, [chunk({ content: '库里有 2 篇周报。' }), chunk({}, 'stop')])
    }
    return
  }

  if (scenario === 'notools') {
    // 老模型：看到 tools 就 400，不带 tools 就正常答
    if (Array.isArray(payload.tools) && payload.tools.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'this model does not support tools' } }))
      return
    }
    sse(res, [chunk({ content: '不带工具的普通回答。' }), chunk({}, 'stop')])
    return
  }

  if (scenario === 'websearch' || scenario === 'editnote') {
    // 第一轮申请工具；带 tool 结果的那一轮给正文
    if (!hasToolResult) {
      const call =
        scenario === 'websearch'
          ? { id: 'call_web', name: 'web_search', args: '{"query":"海康 运维"}' }
          : { id: 'call_edit', name: 'edit_note', args: '{"find":"正文","replace":"新正文"}' }
      sse(res, [
        chunk({
          tool_calls: [
            { index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: call.args } },
          ],
        }),
        chunk({}, 'tool_calls'),
      ])
    } else {
      sse(res, [chunk({ content: scenario === 'websearch' ? '按资料，海康运维负责巡检。' : '改好了。' }), chunk({}, 'stop')])
    }
    return
  }

  if (scenario === 'thinkonly') {
    /* 只吐思考、不给正文。引擎该自己补一次不带工具的请求；
       带「请直接回答」那句的那一轮才给正文 */
    if (String(lastMessage).includes('请直接回答')) {
      sse(res, [chunk({ content: '补出来的正文。' }), chunk({}, 'stop')])
    } else {
      sse(res, [chunk({ reasoning_content: '我需要联网查一下。' }), chunk({}, 'stop')])
    }
    return
  }

  // plain：边思考边答
  sse(res, [
    chunk({ reasoning_content: '先想一下。' }),
    chunk({ content: '你好，' }),
    chunk({ content: '这是回答。' }),
    chunk({}, 'stop'),
  ])
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/v1`

/* ── 假宿主 ── */
const touch = { drafted: null, listed: 0 }
/** 检索走过哪些词。web_search 会并发多路，靠它确认原词真发出去了 */
const searchLog = []
/* 两路都回同两条（一条链接带尾斜杠），用来验「合并后去重」 */
const WEB_HITS = [
  { title: '海康威视 运维工程师 岗位职责', url: 'https://jobs.example/a', snippet: '负责机房巡检与故障处理。' },
  { title: '海康威视 运维运行 - 知乎', url: 'https://zhihu.example/b', snippet: '海康威视 运维 的一天。' },
]
const host = {
  root: '/ws',
  activePath: '/ws/a.md',
  listNotes: async () => {
    touch.listed += 1
    return ['/ws/a.md', '/ws/周报-01.md', '/ws/周报-02.md']
  },
  readFile: async () => '# A\n\n正文',
  writeFile: async () => {},
  createNote: async () => '/ws/new.md',
  searchNotes: async () => [],
  webSearch: async (q) => {
    searchLog.push(q)
    return { ok: true, hits: WEB_HITS.map((h) => ({ ...h })) }
  },
  getDraft: () => '# A\n\n正文',
  setDraft: (t) => {
    touch.drafted = t
  },
}

const cfg = {
  baseUrl,
  model: 'test-model',
  apiKey: 'sk-test',
  system: '你是助手',
  temperature: 0,
}

const runOnce = async (extra = {}) => {
  const events = []
  const r = await agent.runAgent(cfg, {
    messages: [{ role: 'user', content: '问题' }],
    host,
    emit: (e) => events.push(e),
    fetchImpl: (url, init) => fetch(url, init),
    ...extra,
  })
  return { r, events }
}

/* ── A. 普通回答 ── */
{
  scenario = 'plain'
  calls = 0
  const { r, events } = await runOnce()
  check('A1 正文拼完整', r.ok && r.text === '你好，这是回答。', JSON.stringify(r.text))
  check('A2 思考单独留存', r.reasoning === '先想一下。', JSON.stringify(r.reasoning))
  check(
    'A3 正文按增量推给界面',
    events.filter((e) => e.t === 'text').length === 2,
    `${events.filter((e) => e.t === 'text').length} 段`,
  )
  check('A4 只发一次请求', calls === 1, `${calls} 次`)
  check(
    'A5 工具定义编进了请求',
    Array.isArray(lastBody.tools) && lastBody.tools.some((t) => t.function?.name === 'web_search'),
    `${lastBody.tools?.length ?? 0} 个工具`,
  )
  check(
    'A6 六个工具都在',
    (lastBody.tools ?? []).length === 6,
    (lastBody.tools ?? []).map((t) => t.function?.name).join(','),
  )
  check('A7 没有工具调用', r.toolUses === 0, String(r.toolUses))
}

/* ── B. 工具循环 ── */
{
  scenario = 'tool'
  calls = 0
  touch.listed = 0
  const { r, events } = await runOnce()
  check('B1 请求了两轮', calls === 2, `${calls} 次`)
  check('B2 工具真的执行了', touch.listed === 1, `listNotes ${touch.listed} 次`)
  check('B3 步骤开始/结束配对', events.filter((e) => e.t === 'tool-start').length === 1 && events.filter((e) => e.t === 'tool-end').length === 1, `${events.filter((e) => e.t === 'tool-start').length}/${events.filter((e) => e.t === 'tool-end').length}`)
  const start = events.find((e) => e.t === 'tool-start')
  check('B4 步骤标签是中文', start?.name === 'list_notes', start?.name ?? '无')
  check('B5 参数摆进了 detail', start?.detail === '周报', JSON.stringify(start?.detail))
  check('B6 第二轮带上了工具结果', (lastBody.messages ?? []).some((m) => m.role === 'tool'), (lastBody.messages ?? []).map((m) => m.role).join(','))
  check('B7 最终拿到正文', r.ok && r.text === '库里有 2 篇周报。', JSON.stringify(r.text))
  check('B8 工具次数记了 1', r.toolUses === 1, String(r.toolUses))
  const toolMsg = (lastBody.messages ?? []).find((m) => m.role === 'tool')
  check(
    'B9 工具结果里有筛选后的篇数',
    /共 2 篇/.test(String(toolMsg?.content ?? '')),
    String(toolMsg?.content ?? '').slice(0, 40),
  )
}

/* ── C. 只思考不回答 → 补一次 ── */
{
  scenario = 'thinkonly'
  calls = 0
  const { r, events } = await runOnce()
  check('C1 补发了一次请求', calls === 2, `${calls} 次`)
  check('C2 补出了正文', r.ok && r.text === '补出来的正文。', JSON.stringify(r.text))
  check('C3 思考保留着', r.reasoning.includes('需要联网'), JSON.stringify(r.reasoning))
  check('C4 补的时候还在流式推正文', events.some((e) => e.t === 'text'), '有 text 事件')
}

/* ── D. 401 翻成人话 ── */
{
  scenario = 'unauthorized'
  calls = 0
  const { r } = await runOnce({
    describeError: (e) => {
      const o = e
      if (o?.statusCode === 401) return `密钥被拒（401）${o.responseBody ? '' : ''}`
      return String(o?.message ?? o)
    },
  })
  check('D1 判为失败', r.ok === false, String(r.ok))
  check('D2 错误翻成了中文', /密钥被拒/.test(r.error ?? ''), r.error ?? '')
}

/* ── E. 连不上时给的是人话 ── */
{
  const r = await agent.runAgent(
    { ...cfg, baseUrl: 'http://127.0.0.1:1/v1' },
    {
      messages: [{ role: 'user', content: '问题' }],
      host,
      emit: () => {},
      fetchImpl: (url, init) => fetch(url, init),
    },
  )
  check('E1 判为失败', r.ok === false, String(r.ok))
  check('E2 说的是连不上', /连不上|fetch|ECONN/i.test(r.error ?? ''), (r.error ?? '').slice(0, 60))
}

/* ── G. 模型不认 tools → 自动降级普通对话 ── */
{
  scenario = 'notools'
  calls = 0
  const { r, events } = await runOnce()
  check('G1 失败了会重试一次', calls === 2, `${calls} 次`)
  check('G2 降级后拿到了正文', r.ok && r.text === '不带工具的普通回答。', JSON.stringify(r.text))
  check(
    'G3 面板上说清了为什么降级',
    events.some((e) => e.t === 'stage' && /不支持工具调用/.test(e.text)),
    JSON.stringify(events.filter((e) => e.t === 'stage').map((e) => e.text)),
  )
  check('G4 第二次没再带 tools', !Array.isArray(lastBody.tools), String(lastBody.tools?.length ?? 'none'))
}

/* ── H. web_search：多路并发、合并去重、结果喂回去 ── */
{
  scenario = 'websearch'
  calls = 0
  searchLog.length = 0
  const { r, events } = await runOnce()
  check('H1 模型给的词原样搜了', searchLog.includes('海康 运维'), JSON.stringify(searchLog))
  check(
    'H2 同一个词不会搜两遍',
    new Set(searchLog).size === searchLog.length,
    JSON.stringify(searchLog),
  )
  const body = String((lastBody.messages ?? []).find((m) => m.role === 'tool')?.content ?? '')
  check('H3 结果带编号与链接', /\[1\]/.test(body) && body.includes('https://jobs.example/a'), body.slice(0, 60))
  check(
    'H4 同一链接只出现一次',
    (body.match(/jobs\.example\/a/g) ?? []).length === 1,
    `出现 ${(body.match(/jobs\.example\/a/g) ?? []).length} 次`,
  )
  const src = events.find((e) => e.t === 'sources')
  check(
    'H5 来源事件推给界面且不重复',
    !!src && new Set(src.hits.map((h) => h.url)).size === src.hits.length && src.hits.length > 0,
    JSON.stringify(src?.hits?.map((h) => h.url) ?? []),
  )
  check('H6 最后拿到正文', r.ok && r.text.includes('巡检'), JSON.stringify(r.text))
}

/* ── I. edit_note：改当前这篇 → 草稿真的变了 ── */
{
  scenario = 'editnote'
  calls = 0
  touch.drafted = null
  const { r, events } = await runOnce()
  check('I1 草稿被替换', touch.drafted === '# A\n\n新正文', JSON.stringify(touch.drafted))
  check('I2 推了 draft 事件让编辑器刷新', events.some((e) => e.t === 'draft' && e.text === touch.drafted), '有')
  const body = String((lastBody.messages ?? []).find((m) => m.role === 'tool')?.content ?? '')
  check('I3 工具回了替换处数', /已替换 1 处/.test(body), body.slice(0, 40))
  check('I4 最后拿到正文', r.ok && r.text === '改好了。', JSON.stringify(r.text))
}

/* ── F. 纯规则：工具详情、地址归一化 ── */
{
  check('F1 地址去掉末尾斜杠', agent.normalizeBase('http://x/v1///') === 'http://x/v1', agent.normalizeBase('http://x/v1///'))
  check(
    'F2 地址去掉误粘的 /chat/completions',
    agent.normalizeBase('https://api.deepseek.com/v1/chat/completions') === 'https://api.deepseek.com/v1',
    agent.normalizeBase('https://api.deepseek.com/v1/chat/completions'),
  )
  check('F3 长参数截断', agent.toolDetail('web_search', { query: 'x'.repeat(40) }).endsWith('…'), agent.toolDetail('web_search', { query: 'x'.repeat(40) }))
  check('F4 两段参数用点分隔', agent.toolDetail('edit_note', { path: 'a.md', find: '旧' }) === 'a.md · 旧', agent.toolDetail('edit_note', { path: 'a.md', find: '旧' }))
}

server.close()
console.log(fail ? `\n${fail} 项没通过` : '\n全部通过')
process.exit(fail ? 1 : 0)
