/** 验证 Bing RSS 引擎的抓取与解析（与 electron/main.ts 里同一套正则） */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const engine = {
  build: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&count=10`,
  link: /<item>[\s\S]*?<title>([\s\S]*?)<\/title>\s*<link>([\s\S]*?)<\/link>/gi,
  snip: /<description>([\s\S]*?)<\/description>/gi,
}
const prep = (html) => {
  const i = html.indexOf('<item>')
  return i >= 0 ? html.slice(i) : html
}
const htmlToText = (s) =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

async function search(q, limit = 5) {
  const res = await fetch(engine.build(q), { headers: { 'User-Agent': UA } })
  let html = await res.text()
  html = prep(html)
  const links = []
  for (const m of html.matchAll(engine.link)) {
    const url = m[2].trim()
    const title = htmlToText(m[1])
    if (!/^https?:\/\//.test(url) || !title) continue
    links.push({ url, title })
    if (links.length >= limit) break
  }
  const snips = []
  for (const m of html.matchAll(engine.snip)) {
    const t = htmlToText(m[1])
    if (t) snips.push(t)
    if (snips.length >= limit) break
  }
  const n = Math.min(links.length, snips.length)
  return snips.length ? links.slice(0, n).map((l, i) => ({ ...l, snippet: snips[i] })) : links
}

const queries = process.argv.slice(2)
for (const q of queries) {
  console.log(`\n===== ${q} =====`)
  try {
    const hits = await search(q)
    if (!hits.length) console.log('  （0 条结果）')
    for (const h of hits) {
      console.log(`  · ${h.title}`)
      console.log(`    ${h.url}`)
      console.log(`    ${h.snippet.slice(0, 80)}`)
    }
  } catch (e) {
    console.log('  失败：', String(e))
  }
}
