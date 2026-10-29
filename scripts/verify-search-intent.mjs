/**
 * 「这一轮要不要联网」的判断规则。
 *
 * 只验规则本身，不发任何网络请求 —— 真实链路要问一次模型，而模型没配好
 * （密钥错、本地服务没开）时那条路径什么都验不出来，很容易把「环境坏了」
 * 误读成「功能坏了」。这里验的是：哪些话根本不该去问模型、模型回什么算
 * 检索词、回什么算放弃。
 *
 * 用法：node --experimental-strip-types scripts/verify-search-intent.mjs
 */
import { skipModelJudge, parseJudge, looksUnsure } from '../src/store/searchIntent.ts'

let pass = 0
const fail = []

function ok(name, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail.push(name)
    console.log(`  FAIL  ${name}  ${detail ?? ''}`)
  }
}

console.log('\n── 本地筛：哪些不该去问模型 ──')
const SKIP_CASES = [
  '把这句话改得通顺一点：我今天去学校的时候看到了一只猫',
  '帮我把这段润色一下',
  '翻译成英文：今天天气不错',
  '总结这篇笔记',
  '把我刚才写的那段整理成分点',
  '这句话有没有错别字',
  '帮我写一段自我介绍',
]
for (const c of SKIP_CASES) ok(`不该问模型：${c}`, skipModelJudge(c) === true)

console.log('\n── 本地筛：哪些要交出去判断 ──')
const ASK_CASES = [
  'Nota 这个软件最新的版本号是多少',
  '总结一下今年的新能源政策',
  'iPhone 17 现在多少钱',
  'React 19 什么时候发布的',
  '帮我写一份简历，但我需要知道现在运维岗的行情',
  '今天阿克苏天气怎么样',
]
for (const c of ASK_CASES) ok(`要问模型：${c}`, skipModelJudge(c) === false)

console.log('\n── 解析模型的判断 ──')
ok('标准格式', parseJudge('SEARCH: Nota 最新版本') === 'Nota 最新版本')
ok('全角冒号', parseJudge('SEARCH：Nota 最新版本') === 'Nota 最新版本')
ok('带双引号', parseJudge('SEARCH: "iPhone 17 价格"') === 'iPhone 17 价格')
ok('带中文引号', parseJudge('SEARCH: 「Nota 官网」') === 'Nota 官网')
ok('后面多嘴一句', parseJudge('SEARCH: Nota 版本（这是检索词）') === 'Nota 版本')
ok('前面带解释', parseJudge('这个问题需要查。\nSEARCH: Nota 版本') === 'Nota 版本')
ok('SKIP 不算检索词', parseJudge('SKIP') === null)
ok('含糊的回答当放弃', parseJudge('我觉得不用查') === null)
ok('空串当放弃', parseJudge('') === null)
ok('只有 SEARCH 没有词', parseJudge('SEARCH:') === null)
ok(
  '超长检索词被截断',
  (parseJudge('SEARCH: ' + 'a'.repeat(200)) ?? '').length === 80,
)

console.log('\n── 回答里「查不到」的识别 ──')
const UNSURE = [
  '我无法确定 Nota 现在的最新版本号。',
  '我的知识只到 2024 年，之后的变化我不清楚。',
  '这个价格我一直没有查到相关的最新信息。',
  '抱歉，我无法获取实时数据。',
  '这属于时效性很强的问题，建议你去搜索最新公告。',
]
for (const a of UNSURE) ok(`要补查：${a.slice(0, 16)}…`, looksUnsure(a) === true)

const SURE = [
  '这是我给你写的自我介绍：我叫于米提江，学云计算技术应用。',
  '把这段话改得通顺一点：我今天去学校的时候看到了一只猫。',
  '具体时间我不确定，但流程一般是先报名再审核，最后等通知。',
  '总结如下：三点，分别是成本、进度、质量。',
  '',
]
for (const a of SURE) ok(`不补查：${(a || '（空串）').slice(0, 16)}…`, looksUnsure(a) === false)

console.log(`\n${pass} 通过，${fail.length} 失败`)
if (fail.length) {
  console.log('失败项：\n' + fail.map((f) => '  · ' + f).join('\n'))
  process.exit(1)
}
console.log('ALL PASS')
