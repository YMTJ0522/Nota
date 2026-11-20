/**
 * 验证鉴权失败的提示是否真的说人话。
 *
 * 直接从 electron/main.ts 里抠出 keyLooksLikeModel / humanizeChatError 两个
 * 函数的源码来跑——不复制一份实现，否则改了真代码这里还是旧的，验证就成了摆设。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8')

const from = src.indexOf('function keyLooksLikeModel')
const to = src.indexOf('async function validateModel')
if (from < 0 || to < 0 || to < from) {
  console.error('没能从 main.ts 里定位到函数（源码结构变了？）')
  process.exit(1)
}

const code = src.slice(from, to)
const js = esbuild.transformSync(code, { loader: 'ts' }).code
const factory = new Function(`${js}; return { keyLooksLikeModel, humanizeChatError }`)
const { keyLooksLikeModel, humanizeChatError } = factory()

let fail = 0
const check = (label, ok, detail = '') => {
  if (!ok) fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  → ${detail}` : ''}`)
}

/* ① 判定器：模型名要认得出，真密钥不能误伤 */
{
  const cases = [
    ['qwen2.5-coder:7b-instruct-q4_K_M', true, '带 tag 的 Ollama 模型名'],
    ['glm-4-flash', true, '无 tag 但品牌前缀'],
    ['llama3', true, 'llama 家族'],
    ['sk-abc123def456', false, 'OpenAI/DeepSeek 风格'],
    ['1a2b3c4d.5e6f7g8h9i0j', false, '智谱风格（带一个点）'],
    ['', false, '空值不算填错'],
  ]
  for (const [k, want, label] of cases) {
    check(`判定 ${label}`, keyLooksLikeModel(k) === want, `「${k}」→ ${keyLooksLikeModel(k)}`)
  }
}

/* ② 真实事故：智谱 + 模型名当密钥 */
{
  const body = JSON.stringify({ error: { code: '1000', message: '身份验证失败。' } })
  const msg = humanizeChatError(401, body, 'glm-4-flash', 'qwen2.5-coder:7b-instruct-q4_K_M')
  check('401 且密钥像模型名 → 直接点破', msg.includes('模型名，不是密钥') && msg.includes('glm-4-flash'), msg.slice(0, 60))
}

/* ③ 空密钥 */
{
  const msg = humanizeChatError(401, '{"error":{"message":"身份验证失败。"}}', 'glm-4-flash', '')
  check('401 且没填密钥 → 教怎么填', msg.includes('没填') && msg.includes('11434'), msg.slice(0, 50))
}

/* ④ 密钥形状正常但仍然被拒 → 不要瞎猜是模型名 */
{
  const msg = humanizeChatError(401, '{"error":{"message":"Incorrect API key provided"}}', 'gpt-4o-mini', 'sk-wrongkey')
  check(
    '401 且密钥形状正常 → 只说被拒绝',
    msg.includes('被服务拒绝') && !msg.includes('模型名，不是密钥'),
    msg.slice(0, 50),
  )
}

/* ⑤ 不能把 402/404 的老修法冲掉 */
{
  const m402 = humanizeChatError(402, '{"error":{"message":"free usage exceeded"}}', 'glm-5.1', 'sk-x')
  check('402 仍走额度提示', m402.includes('免费额度'), m402.slice(0, 40))
  const m404 = humanizeChatError(404, '{"error":{"message":"model not found"}}', 'glm-9', 'sk-x')
  check('404 仍走模型不存在提示', m404.includes('不存在'), m404.slice(0, 40))
}

/* ⑥ 渲染层的即时提示与主进程各有一份判断，结果必须一致（否则一个放行、一个报错） */
{
  const ui = fs.readFileSync(path.join(root, 'src/store/keyShape.ts'), 'utf8')
  /* 整份文件带 export，扔进 new Function 里会语法报错，去掉导出关键字即可 */
  const js2 = esbuild.transformSync(ui.replace(/^export\s+/gm, ''), { loader: 'ts' }).code
  const uiFn = new Function(`${js2}; return keyLooksLikeModel`)()
  const probes = [
    'qwen2.5-coder:7b-instruct-q4_K_M',
    'glm-4-flash',
    'deepseek-chat',
    'llama3.2',
    'sk-abc123',
    '9f8e7d6c.1a2b3c4d',
    '',
  ]
  const diff = probes.filter((k) => uiFn(k) !== keyLooksLikeModel(k))
  check('渲染层与主进程判断一致', diff.length === 0, diff.length ? diff.join(' / ') : `${probes.length} 组一致`)
}

console.log(fail === 0 ? '\n✅ 全部通过' : `\n❌ ${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)