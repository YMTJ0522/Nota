/**
 * 拿真实 Bing 结果跑一遍生产环境的合并/排序代码。
 *
 * 前面的 verify-web-flow 用的是假结果桩，只能验流程通不通，验不了
 * 「搜回来的东西到底能不能用」。这一份补上：关键词是用户真踩过的坑，
 * 结果来自真实 Bing RSS，排序/去重直接用 src/store/webPipeline.ts 的
 * 生产代码（esbuild 现场打包，不复制一份逻辑，避免脚本和线上脱节）。
 *
 * 用法: node scripts/check-live-search.mjs [额外检索词…]
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* 把 TS 模块打成临时 ESM，再 import —— 验的就是线上那份代码 */
const tmp = path.join(os.tmpdir(), `nota-wp-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(root, 'src/store/webPipeline.ts')],
  bundle: true,
  format: 'esm',
  outfile: tmp,
  logLevel: 'silent',
})
const wp = await import(`file://${tmp}`)
fs.unlinkSync(tmp)

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

/** 与 electron/main.ts 的 RSS 解析同一套（标题 + 链接 + 摘要） */
function parseRss(xml, limit) {
  const items = []
  const re = /<item>([\s\S]*?)<\/item>/g
  let m
  while ((m = re.exec(xml)) && items.length < limit) {
    const body = m[1]
    const t = /<title>([\s\S]*?)<\/title>/i.exec(body)
    const l = /<link>([\s\S]*?)<\/link>/i.exec(body)
    const d = /<description>([\s\S]*?)<\/description>/i.exec(body)
    const url = decode(l?.[1] ?? '')
    const title = decode(t?.[1] ?? '')
    if (!/^https?:\/\//.test(url) || !title) continue
    /* Bing 会在标题后面挂站点名：「标题 - 海康威视官网」 */
    items.push({ url, title, snippet: decode(d?.[1] ?? '') })
  }
  return items
}

async function search(q, limit = 6) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&count=${limit}`
  const t0 = Date.now()
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } })
    const xml = await r.text()
    return { ok: r.ok, status: r.status, ms: Date.now() - t0, hits: parseRss(xml, limit) }
  } catch (e) {
    return { ok: false, status: 'ERR', ms: Date.now() - t0, hits: [], error: String(e).slice(0, 60) }
  }
}

/* 词典/字词类站点：排名里如果还占多数，说明筛得不够 */
const JUNK =
  /(汉典|汉语字典|在线字典|新华字典|康熙字典|说文解字|部首|笔顺|成语大全|古诗文网|诗词名句|词典|Cambridge Dictionary|Merriam-Webster|zdic|hanyu\.baidu)/i

const cases = [
  {
    label: '用户原话（未改写，模拟改写超时兜底）',
    queries: ['帮我介绍下啊hca海康运维工程师的日常'],
    expect: ['海康', '运维'],
    /* 这条路径正常会被改写救回来；真走到兜底时，只要不把词典垃圾
       喂给模型就算合格——空手比胡说强。 */
    allowEmpty: true,
  },
  {
    label: '改写后：海康运维',
    queries: ['海康威视 运维工程师 工作日常', '海康威视 运维 工作内容'],
    expect: ['海康'],
  },
  {
    label: '改写后：Codex',
    queries: ['OpenAI Codex 使用方法', 'Codex CLI 怎么用'],
    expect: ['Codex', 'codex'],
  },
  {
    label: '时效性：天气',
    queries: ['乌鲁木齐 今天 天气'],
    expect: ['天气', '乌鲁木齐'],
  },
  {
    label: '时效性：版本发布',
    queries: ['DeepSeek 最新模型 发布时间'],
    expect: ['DeepSeek', 'deepseek'],
  },
]

let bad = 0
for (const c of cases) {
  console.log(`\n── ${c.label}`)
  console.log(`   检索词: ${c.queries.map((q) => `「${q}」`).join(' ')}`)

  const results = await Promise.all(c.queries.map((q) => search(q)))
  const first = results[0]
  console.log(
    `   抓取: ${results.map((r) => `${r.status} ${r.hits.length}条 ${r.ms}ms`).join(' / ')}`,
  )

  const merged = wp.mergeHits(results.map((r) => r.hits))
  const ranked = wp.rankHits(merged, c.queries)
  const top = ranked.slice(0, 4)

  const junkCount = top.filter((h) => JUNK.test(h.title + ' ' + (h.snippet ?? ''))).length
  const hitExpect = top.filter((h) =>
    c.expect.some((kw) => (h.title + ' ' + (h.snippet ?? '')).includes(kw)),
  ).length

  for (const h of top) {
    const junk = JUNK.test(h.title + ' ' + (h.snippet ?? '')) ? ' [词典]' : ''
    console.log(`   · ${h.title.slice(0, 46)}${junk}`)
    console.log(`     ${h.url.slice(0, 72)}`)
  }

  const ok =
    junkCount === 0 && (top.length === 0 ? !!c.allowEmpty : hitExpect >= 2)
  if (!ok) bad++
  const verdict =
    top.length === 0
      ? ok
        ? '✓ 没有可用结果，如实空手（不喂垃圾）'
        : '✗ 该有结果却空手'
      : `${ok ? '✓' : '✗'} 相关命中 ${hitExpect}/${top.length}，词典垃圾 ${junkCount} 条`
  console.log(`   ${verdict}`)
}

console.log(`\n${bad === 0 ? '全部通过' : `${bad} 个场景不合格`}`)
process.exit(bad === 0 ? 0 : 1)
