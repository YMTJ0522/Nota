/*
 * 验证 ai:chat 对「正文不在 content 字符串里」的各种网关形状都能接住。
 * 背景：deepseek-flash 这类网关把正文发成片段数组或塞进 delta.text，
 *   还有的思考型网关只回 reasoning、content 一路空——旧解析全丢，
 *   用户只看到「（模型只返回了思考过程）」。
 * 三种形状 × 真主进程：
 *   A. content 是片段数组 [{type:'text',text:'…'},…] → 拼出全文
 *   B. 没有 content 字段，正文在 delta.text → 照常收到
 *   C. 只有 reasoning_content，content 全空 → 思考内容顶上当回答
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = [
  path.join(root, 'release', 'win-unpacked-fresh2', 'Nota.exe'),
  path.join(root, 'release', 'win-unpacked-fresh', 'Nota.exe'),
  path.join(root, 'release', 'win-unpacked', 'Nota.exe'),
].find((p) => fs.existsSync(p))
if (!EXE) {
  console.log('没有打包产物（release/win-unpacked-fresh/Nota.exe），先重打包')
  process.exit(2)
}

const PORT = 18923
const sse = (res, frames) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    let model = ''
    try {
      model = JSON.parse(Buffer.concat(chunks).toString()).model
    } catch {}
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'array-model' }, { id: 'text-model' }, { id: 'think-only' }] }))
      return
    }
    if (model === 'array-model') {
      sse(res, [
        { choices: [{ delta: { reasoning_content: '想一下…' } }] },
        { choices: [{ delta: { content: [{ type: 'text', text: '你好' }] } }] },
        { choices: [{ delta: { content: [{ type: 'text', text: '，世界' }] } }] },
      ])
      return
    }
    if (model === 'text-model') {
      sse(res, [
        { choices: [{ delta: { text: '直连' } }] },
        { choices: [{ delta: { text: '正文' } }] },
      ])
      return
    }
    if (model === 'think-only') {
      sse(res, [
        { choices: [{ delta: { reasoning_content: '这段思考其实就是回答' } }] },
      ])
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'no such model' } }))
  })
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
console.log(`假服务器: http://127.0.0.1:${PORT}`)

const STAMP = Date.now()
const CDP_PORT = 9500 + (STAMP % 200)
const CLEAN_HOME = path.join(root, `.tmp-ai-shape-home-${STAMP}`)
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

const chatModel = (model) =>
  evaluate(`window.api.aiChat({
    baseUrl: 'http://127.0.0.1:${PORT}/v1',
    model: '${model}',
    apiKey: '',
    system: '',
    temperature: 0,
  }, [{ role: 'user', content: 'hi' }]).then(JSON.stringify)`)

{
  const r = JSON.parse(await chatModel('array-model'))
  check('A1 片段数组正文：拼出全文', r.ok && r.text === '你好，世界', JSON.stringify(r).slice(0, 140))
  check('A2 片段数组正文：思考过程照常保留', r.reasoning === '想一下…', r.reasoning)
}
{
  const r = JSON.parse(await chatModel('text-model'))
  check('B delta.text 正文：照常收到', r.ok && r.text === '直连正文', JSON.stringify(r).slice(0, 140))
}
{
  const r = JSON.parse(await chatModel('think-only'))
  check('C1 只回思考：思考内容顶上当回答', r.ok && r.text === '这段思考其实就是回答', JSON.stringify(r).slice(0, 140))
  check('C2 只回思考：不再报占位文案', !/只返回了思考过程/.test(r.text ?? ''), r.text)
  check('C3 只回思考：reasoning 置空避免双份显示', r.reasoning === '', r.reasoning)
}

app.kill()
server.close()
try {
  fs.rmSync(CLEAN_HOME, { recursive: true, force: true })
} catch {
  /* 临时目录删不掉就留着，验证结果不受影响 */
}
console.log(`\n${pass} 过 / ${fail} 挂`)
process.exit(fail ? 1 : 0)
