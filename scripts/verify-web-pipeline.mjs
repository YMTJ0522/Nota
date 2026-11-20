/**
 * 检索流水线的纯规则回归。
 *
 * 只测「算数」那部分（改写解析、兜底关键词、去重、相关性打分），不连模型
 * 也不连搜索引擎。这么分是有原因的：这条链上每一步都要发网络请求，跑真机
 * 时一旦结果不对，根本分不清是规则写错了、模型不听话、还是 Bing 给了垃圾。
 * 规则先钉死，真机测试只需要看「有没有按规则跑」。
 *
 * 直接跑：node scripts/verify-web-pipeline.mjs
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'nota-wp-'))
const out = join(dir, 'wp.mjs')
await build({
  entryPoints: ['src/store/webPipeline.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
})
const wp = await import(pathToFileURL(out).href)
rmSync(dir, { recursive: true, force: true })

let fail = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${name} — ${detail}`)
  if (!ok) fail++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/* ── A. 改写输出的解析 ── */
{
  const r = wp.parseQueries('1. 海康威视 运维工程师\n2. 海康威视 运维 工作内容')
  check('A1 编号列表', eq(r, ['海康威视 运维工程师', '海康威视 运维 工作内容']), JSON.stringify(r))
}
{
  const r = wp.parseQueries('QUERY: OpenAI Codex 使用方法\nQUERY: codex 配置教程')
  check('A2 QUERY: 前缀', eq(r, ['OpenAI Codex 使用方法', 'codex 配置教程']), JSON.stringify(r))
}
{
  const r = wp.parseQueries('- 「海康威视 招聘」\n* 海康威视 运维 岗位职责')
  check('A3 项目符号与引号', eq(r, ['海康威视 招聘', '海康威视 运维 岗位职责']), JSON.stringify(r))
}
{
  const r = wp.parseQueries('SKIP')
  check('A4 SKIP 不当检索词', r.length === 0, JSON.stringify(r))
}
{
  const r = wp.parseQueries(
    '1. 甲 乙\n2. 丙 丁\n3. 戊 己\n4. 庚 辛\n5. 壬 癸',
  )
  check('A5 最多 3 路', r.length === 3, `${r.length} 路：${JSON.stringify(r)}`)
}
{
  const r = wp.parseQueries('海康威视 运维工程师\n海康威视 运维工程师\n海康威视 招聘')
  check('A6 重复去重', eq(r, ['海康威视 运维工程师', '海康威视 招聘']), JSON.stringify(r))
}
{
  const r = wp.parseQueries('乌鲁木齐 天气（今天的）')
  check('A7 去掉行尾括注', eq(r, ['乌鲁木齐 天气']), JSON.stringify(r))
}
{
  const r = wp.parseQueries('')
  check('A8 空输入', r.length === 0, '空数组')
}

/* ── B. 「这轮不用查」的识别 ── */
{
  const cases = [
    ['SKIP', true],
    ['  skip', true],
    ['Skip.\n（闲聊不用查）', true],
    ['跳过', true],
    ['这不是 skip 的场景', false],
    ['海康威视 运维工程师', false],
  ]
  const bad = cases.filter(([s, want]) => wp.isSkip(s) !== want)
  check('B1 SKIP 判定', bad.length === 0, bad.length ? JSON.stringify(bad) : '6/6 对')
}

/* ── C. 模型挂了时的兜底关键词 ── */
{
  const r = wp.localKeywords('帮我介绍下啊hca海康运维工程师的日常')
  const hit = r.some((t) => t.includes('海康运维工程师'))
  check('C1 抹掉口语填充词', hit, JSON.stringify(r))
}
{
  const r = wp.localKeywords('请问一下今天乌鲁木齐的天气怎么样呢？')
  const clean = r[0] ?? ''
  const noFiller = !/帮我|请问|一下|怎么样|呢/.test(clean)
  check('C2 兜底词里不含口语词', noFiller && clean.length > 0, JSON.stringify(r))
}
{
  const r = wp.localKeywords('？？？')
  check('C3 全是标点', r.length === 0, JSON.stringify(r))
}

/* ── D. 跨路去重 ── */
{
  const same =
    wp.urlKey('https://www.example.com/a/') === wp.urlKey('http://example.com/a#top')
  check('D1 同一页面不同写法归一', same, 'www/http/hash/尾斜杠抹平')
}
{
  const merged = wp.mergeHits([
    [{ title: 'A', url: 'https://x.com/1', snippet: 's' }],
    [
      { title: 'A（另一路）', url: 'https://x.com/1/', snippet: 's2' },
      { title: 'B', url: 'https://x.com/2', snippet: 's' },
    ],
  ])
  check(
    'D2 合并去重且保留先出现的',
    merged.length === 2 && merged[0].title === 'A',
    JSON.stringify(merged.map((h) => h.title)),
  )
}

/* ── E. 相关性排序：这一层专门治「搜了但白搜」 ── */
{
  const junk = [
    { title: '帮（汉语汉字）_百度百科', url: 'https://baike.baidu.com/bang', snippet: '帮，汉语一级字。' },
    { title: '帮的解释|帮的意思|汉典"帮"字的基本解释', url: 'https://zdic.net/bang', snippet: '帮助。' },
    { title: '海康威视（中国安防企业）_汉典', url: 'https://zdic.net/hik', snippet: '海康威视。' },
  ]
  const good = [
    { title: '海康威视 运维工程师 岗位职责与工作内容', url: 'https://zhaopin.com/a', snippet: '海康威视运维工程师日常负责设备巡检…' },
    { title: '在海康威视做运维是什么体验 - 知乎', url: 'https://zhihu.com/b', snippet: '海康威视 运维 工作日常…' },
  ]
  const r = wp.rankHits([...junk, ...good], ['海康威视 运维工程师'])
  const top = r.slice(0, 2).map((h) => h.title)
  const junkGone = !r.some((h) => /汉典|汉语汉字/.test(h.title))
  check('E1 词典垃圾被压下去', junkGone, `榜首：${JSON.stringify(top)}`)
  check('E2 相关结果排前面', r[0]?.url === 'https://zhaopin.com/a', `第一：${r[0]?.title}`)
}
{
  /* 零相关的结果比空手更坏：模型拿到「讲别的事情」只会照着编。 */
  const all = [
    { title: '完全无关的一篇', url: 'https://a.com/1', snippet: '讲别的事情' },
    { title: '也无关', url: 'https://a.com/2', snippet: '还是在讲别的' },
  ]
  const r = wp.rankHits(all, ['海康威视 运维工程师'])
  check('E3 一条都不命中时返回空，不拿无关结果凑数', r.length === 0, `${r.length} 条`)
}
{
  // 词典查询本身该正常出结果，不能因为命中「词典」这个词就被扣死
  const dict = [
    { title: 'codex 的意思|剑桥词典', url: 'https://dict.example/codex', snippet: 'codex 名词：古代手抄本' },
  ]
  const r = wp.rankHits(dict, ['codex 词典 释义'])
  check('E4 用户真要查词时不误伤', r.length === 1, r.length ? '保留' : '被误删')
}
{
  /* 真实翻车现场：问「帮我介绍下…海康运维工程师的日常」，Bing 只回
     「帮_百度百科」「帮 bāng - 汉典」「《帮》的拼音…汉语查」三条。
     旧逻辑把它们当兜底喂给模型，模型就顺着「帮」的字义胡说。
     现在应该返回空——宁可空手，也不拿垃圾凑数。 */
  const junkOnly = [
    { title: '帮_百度百科', url: 'https://baike.baidu.com/item/帮', snippet: '帮助的意思' },
    { title: '《帮》的拼音,帮字的意思、组词、部首、笔画 - 汉语查', url: 'https://hgcha.com/zidian/1', snippet: '帮 bāng' },
    { title: '帮 bāng - 汉典', url: 'https://zdic.net/hans/帮', snippet: '帮助；群、伙' },
  ]
  const r = wp.rankHits(junkOnly, ['帮我介绍下啊hca海康运维工程师的日常'])
  check('E5 全是词典垃圾时返回空，不拿垃圾凑数', r.length === 0, `${r.length} 条`)
}

{
  /* 天气单独走数据源：地名要认得出，技术问题不能误判 */
  const cases = [
    ['乌鲁木齐今天天气怎么样', '乌鲁木齐'],
    ['明天阿克苏冷不冷', '阿克苏'],
    ['海康威视 运维工程师的日常', null],
    ['温度对服务器的影响', null],
    ['今天天气怎么样', null],
    ['北京这几天下雨吗', '北京'],
  ]
  for (const [q, want] of cases) {
    const got = wp.weatherPlace(q)
    check(`F ${q} → ${want ?? '不查天气'}`, got === want, String(got))
  }
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
