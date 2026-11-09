/**
 * 「测试成功、聊天报错」修复的真机验证。
 *
 * 根因：Ollama 云端（ollama.com）的 /models 列表拉得到 ≠ 选的模型能用 ——
 * 免费额度只含 gemma 系列（选别的就 402），手写的模型名拼错就 404。
 * 修复：① 设置里的测试连接补一发最小对话请求验证当前模型（checkModel）；
 *       ② ai:chat 的 HTTP 错误按症状翻成人话（402/404 给出下一步）。
 *
 * 这里起一个假 OpenAI 兼容服务器，按模型名演三种角色：
 *   nota-ok    → 正常 SSE 回流
 *   ghost-model → 404 not_found_error（Ollama 的 JSON 形状）
 *   paid-model  → 402 free usage（Ollama 云端的 JSON 形状）
 * 连真 Electron 主进程，绕过 UI 直接调 window.api，把两条路径都过一遍：
 *   A. aiTest + checkModel —— 模型验证挂在测试结果上（三种模型三种结果）
 *   B. aiTest 不带 checkModel —— 面板拉列表的路径不受影响、不慢
 *   C. aiChat —— 错误信息是人话（402 说额度、404 说模型名），正常的照常流
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 有时旧 resources/app.asar 被 watcher 锁住清不掉，外层 win-unpacked 会变成
    「新 exe + 旧 asar」的缝合怪 —— 从 Portable exe 解出来的全新副本最可靠 */
const EXE_CANDIDATES = [
  path.join(root, 'release', 'win-unpacked-fresh', 'Nota.exe'),
  path.join(root, 'release', 'win-unpacked', 'Nota.exe'),
]
const EXE = EXE_CANDIDATES.find((p) => fs.existsSync(p))
if (!EXE) {
  console.log('没有打包产物（release/win-unpacked/Nota.exe），先 npm run pack')
  process.exit(2)
}
console.log(`产物: ${path.relative(root, EXE)}`)

const hits = { models: 0, chat: 0 }
const PORT = 18100 + (Date.now() % 2000)

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/models' || req.url === '/v1/models')) {
    hits.models++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'nota-ok' }, { id: 'gemma3:12b' }] }))
    return
  }
  if (req.method === 'POST' && (req.url === '/chat/completions' || req.url === '/v1/chat/completions')) {
    hits.chat++
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const model = JSON.parse(body || '{}').model ?? ''
      if (model === 'ghost-model') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: { message: "model 'ghost-model' not found", type: 'not_found_error', param: null, code: 'not_found' },
          }),
        )
        return
      }
      if (model === 'paid-model') {
        res.writeHead(402, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: {
              message:
                'this model is not included in your free usage, add usage credits to pay as you go: https://ollama.com/settings or upgrade for included usage: https://ollama.com/upgrade. Try gemma3',
            },
          }),
        )
        return
      }
      // 按请求里的 stream 参数如实回包：真 Ollama 对 stream:false 回 JSON
      const wantStream = (() => {
        try {
          return JSON.parse(body).stream !== false
        } catch {
          return true
        }
      })()
      if (!wantStream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const f of [{ choices: [{ delta: { content: 'OK' } }] }])
        res.write(`data: ${JSON.stringify(f)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
console.log(`假服务器: http://127.0.0.1:${PORT}`)

/* ── 起真机 ── */
const STAMP = Date.now()
const CDP_PORT = 9900 + (STAMP % 200)
const CLEAN_HOME = path.join(root, `.tmp-ai-fix-home-${STAMP}`)
fs.mkdirSync(CLEAN_HOME, { recursive: true })
delete process.env.ELECTRON_RUN_AS_NODE

const app = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`, '--no-sandbox'], {
  stdio: 'ignore',
  env: { ...process.env, NOTA_HOME: CLEAN_HOME },
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target = null
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
    if (target) break
  } catch {}
  await sleep(500)
}
if (!target) {
  app.kill()
  server.close()
  throw new Error('连不上渲染进程')
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
})
const send = (method, params = {}) =>
  new Promise((resolve) => { id += 1; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r?.exceptionDetails) return 'EXC: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)
  return r?.result?.value
}

await sleep(2500)
await send('Runtime.enable')

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 110) : ''}`)
  cond ? pass++ : fail++
}

/* ── A. aiTest + checkModel：模型验证挂进测试结果 ── */
const testModel = (model) =>
  evaluate(`window.api.aiTest({
    baseUrl: 'http://127.0.0.1:${PORT}/v1',
    model: '${model}',
    apiKey: '',
    system: '',
    temperature: 0,
    checkModel: true,
  }).then(JSON.stringify)`)

{
  const r = JSON.parse(await testModel('ghost-model'))
  check('A1 ghost 模型：连接仍算成功（列表是真的）', r.ok === true && Array.isArray(r.models) && r.models.includes('nota-ok'), JSON.stringify(r).slice(0, 120))
  check('A2 ghost 模型：modelError 点名不存在并给出 ollama pull', /不存在/.test(r.modelError ?? '') && /pull/.test(r.modelError ?? ''), r.modelError)
}
{
  const r = JSON.parse(await testModel('paid-model'))
  check('A3 paid 模型：modelError 讲清免费额度问题', /免费额度/.test(r.modelError ?? '') && /gemma/.test(r.modelError ?? ''), r.modelError)
}
{
  const r = JSON.parse(await testModel('nota-ok'))
  check('A4 正常模型：验证通过、无 modelError', r.ok === true && !r.modelError, JSON.stringify(r).slice(0, 120))
}

/* ── B. 不带 checkModel：面板拉列表的路径不受影响 ── */
{
  const r = JSON.parse(
    await evaluate(`window.api.aiTest({
      baseUrl: 'http://127.0.0.1:${PORT}/v1',
      model: 'ghost-model',
      apiKey: '',
      system: '',
      temperature: 0,
    }).then(JSON.stringify)`),
  )
  check('B1 不带 checkModel 时不做模型验证', r.ok === true && r.modelError === undefined, JSON.stringify(r).slice(0, 120))
}

/* ── C. aiChat：错误翻成人话，正常照常流 ── */
const chatModel = (model) =>
  evaluate(`window.api.aiChat({
    baseUrl: 'http://127.0.0.1:${PORT}/v1',
    model: '${model}',
    apiKey: '',
    system: '',
    temperature: 0,
    silent: true,
  }, [{ role: 'user', content: 'hi' }]).then(JSON.stringify)`)

{
  const r = JSON.parse(await chatModel('ghost-model'))
  check('C1 ghost：404 说是模型不存在', r.ok === false && /不存在/.test(r.error ?? '') && /qwen|pull/.test(r.error ?? ''), r.error)
}
{
  const r = JSON.parse(await chatModel('paid-model'))
  check('C2 paid：402 说是免费额度问题', r.ok === false && /免费额度/.test(r.error ?? ''), r.error)
}
{
  const r = JSON.parse(await chatModel('nota-ok'))
  check('C3 正常模型照常返回', r.ok === true && r.text === 'OK', JSON.stringify(r).slice(0, 100))
}

console.log(`\n${pass} 过 / ${fail} 挂`)
app.kill()
await sleep(300)
server.close()
fs.rmSync(CLEAN_HOME, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
