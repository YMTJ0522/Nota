/**
 * 检索流水线里那些「算数」的部分：改写结果的解析、关键词兜底、去重、
 * 相关性打分。
 *
 * 单独拎出来是为了能验。主流程那边每一步都要真发网络请求，一旦出问题
 * 根本分不清是规则写错了、模型不听话、还是搜索引擎给了垃圾——把纯函数
 * 抽出来，脚本可以一条条喂输入看输出，不必连模型。
 *
 * 为什么要这一套：原来的做法是让模型自己写检索词、自己判断结果相关不
 * 相关。模型不听话（免费档尤其明显）时，整条链每一步都可能走歪，而
 * 每一步歪了都只表现为「查不出来」。把改写、多路召回、排序都做成固定
 * 流水线，模型只负责最后一次「读资料写回答」，走歪的余地就小了。
 */

export interface WebHitLike {
  title: string
  url: string
  snippet: string
}

/** 改写请求要求输出的检索词上限。多一路就多一次搜索，3 路是召回与耗时
    的平衡点：实测第 4 路往后几乎不带来新链接，只是白花时间 */
export const MAX_QUERIES = 3

/** 单个检索词的长度上限。超过这个长度的「关键词」多半是模型又抄了整句 */
const MAX_TERM_LEN = 40

/**
 * 模型明确说「这轮不用查」。
 *
 * 单独认一下是因为「SKIP」和「模型乱回」必须区别对待：前者是有效判断，
 * 后者要退到本地兜底去搜。只看开头，模型偶尔会先写一句理由。
 */
export function isSkip(raw: string): boolean {
  return /^\s*(?:skip|跳过|不查|无需搜索)/i.test((raw ?? '').trim())
}

/**
 * 从改写的输出里取出检索词。
 *
 * 各家模型吐的格式不统一：一行一个、带 1./-/* 编号、套引号、写成
 * `QUERY: xxx`、甚至前后各说一句废话。这里只做一件事——把像检索词的
 * 行挑出来。挑不出来就返回空数组，由调用方决定要不要兜底。
 */
export function parseQueries(raw: string): string[] {
  const text = (raw ?? '').replace(/\r/g, '')
  if (!text.trim()) return []
  const out: string[] = []
  const seen = new Set<string>()

  for (const line of text.split('\n')) {
    // 去掉编号、箭头、项目符号、`QUERY:` 前缀、各种引号
    const s = line
      .replace(/^\s*(?:[-*•·]|\d+[.、)]|第\s*\d+\s*[个条]?)\s*/, '')
      .replace(/^\s*(?:QUERY|SEARCH|检索词)\s*[:：]\s*/i, '')
      // 行尾括注先去掉（「乌鲁木齐 天气（今天的）」），必须在剥引号之前做：
      // 全角括号和引号共用「尾部成对符号」的形态，顺序反了就会把半个括号剥掉
      .replace(/[（(][^）)]*[）)]\s*$/, '')
      .replace(/^[「"'“”『【]+|[」"'“”』】]+$/g, '')
      .trim()
    if (!s) continue
    if (isSkip(s)) continue
    // 一行里塞了好几句的，只留第一句
    const first = s.split(/[。；;!！?？]/)[0].trim()
    if (!first) continue
    const term = first.slice(0, MAX_TERM_LEN)
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(term)
    if (out.length >= MAX_QUERIES) break
  }
  return out
}

/**
 * 口语里的填充词。
 *
 * 这些词留在检索词里会直接毁掉召回：Bing 会把它当成待解释的字词，
 * 于是「帮我介绍下啊hca海康运维工程师的日常」被当成「帮」字的词条查询，
 * 回来一屏汉字释义。这不是模型的问题，是搜索引擎对整句的默认处理。
 */
const FILLER =
  /(帮我|帮忙|给我|请问|我想|我要|想看|想了解|能不能|可不可以|可以|麻烦|介绍下|介绍一下|说说|讲一讲|讲讲|一下|请问|那个|这个|那种|然后|就是|其实|怎么样|怎么|如何|什么|为什么|是不是|有没有|谢谢|啊|呢|吧|吗|呀|哦|的话|的日常|之类的)/g

/**
 * 模型改写失败时的兜底检索词。
 *
 * 只做最朴素的加工：抹掉口语填充词、抹掉标点、压掉多余空格。质量肯定
 * 不如模型改的，但比把原句直接丢进搜索框强得多——这是这条流水线的
 * 「最后一道防线」，它不该因为模型挂了而退化成零。
 */
export function localKeywords(q: string): string[] {
  const cleaned = (q ?? '')
    .replace(FILLER, ' ')
    .replace(/[，。！？、；：""''（）《》【】…—~!?,.;:()"'[\]<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return []

  const out: string[] = [cleaned.slice(0, MAX_TERM_LEN)]
  // 句子还长的话，再拆一组「最长的两个词块」——短查询召回更准
  const blocks = cleaned.split(' ').filter((w) => w.length >= 2)
  if (blocks.length >= 2 && cleaned.length > 8) {
    const two = [blocks[0], blocks[1]].join(' ')
    if (two !== out[0]) out.push(two)
  }
  return out
}

/**
 * 链接归一化，仅用于去重。
 *
 * 同一个页面在三路检索里常常以不同面貌出现：带不带 hash、带不带 utm 尾巴、
 * 末尾有没有斜杠、http 还是 https。按「主机 + 路径」认同一篇文章。
 */
export function urlKey(u: string): string {
  try {
    const url = new URL(u)
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.hostname.replace(/^www\./i, '').toLowerCase()}${path}`.toLowerCase()
  } catch {
    return (u ?? '').toLowerCase()
  }
}

/** 多路结果合并去重，保留先出现的那条（先出现的是主检索词的结果） */
export function mergeHits(lists: WebHitLike[][]): WebHitLike[] {
  const seen = new Set<string>()
  const out: WebHitLike[] = []
  for (const list of lists) {
    for (const h of list ?? []) {
      if (!h || !h.url) continue
      const key = urlKey(h.url)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ title: h.title ?? '', url: h.url, snippet: h.snippet ?? '' })
    }
  }
  return out
}

/**
 * 词典 / 字词释义类站点。
 *
 * 中文搜索最脏的一类结果：搜任何一句带口语的话，Bing 都可能把它当成
 * 「查这个字」而返回汉典、百度百科的汉字词条。这类结果对提问毫无用处，
 * 但标题里恰好含了问题里的字，纯按词命中打分反而会排到前面——必须单独降权。
 */
const DICT_JUNK =
  /(汉典|汉语字典|在线字典|新华字典|康熙字典|说文解字|部首|笔顺|拼音|成语大全|古诗文网|诗词名句|词典|的字义|的读音|怎么读|英文翻译|Cambridge Dictionary|Merriam-Webster)/i

/** 把检索词切成用于打分的词元。中文长块按两字一组切开，避免整块对不上 */
function termsOf(queries: string[]): string[] {
  const out = new Set<string>()
  for (const q of queries) {
    for (const raw of (q ?? '').split(/[\s,，、;；|/]+/)) {
      const s = raw.trim().toLowerCase()
      if (s.length < 2) continue
      if (/[\u4e00-\u9fa5]/.test(s) && s.length > 6) {
        for (let i = 0; i + 2 <= s.length; i += 2) out.add(s.slice(i, i + 2))
      } else {
        out.add(s)
      }
    }
  }
  return [...out]
}

/**
 * 按相关性排序。
 *
 * 标题命中比摘要命中重（3:1）：摘要里出现一个词经常是巧合，标题里出现
 * 才说明这条结果确实在讲这件事。词典类结果再扣一笔，把「帮（汉语汉字）」
 * 这种压到底下去。
 *
 * 一条都没命中的直接丢掉——这正是「搜了但白搜」要防的情况：把 5 条无关
 * 结果原样喂给模型，它只能照着编。
 *
 * 全是词典垃圾、或者一条都对不上时返回空数组，绝不拿零相关的结果凑数。
 * 真实翻车：问「帮我介绍下…海康运维工程师的日常」，Bing 回的是
 * 「帮_百度百科」「帮 bāng - 汉典」——标题里只有问题的一个字，纯按词
 * 命中反而会被当成「相关」。空手至少能让模型老实说没查到。
 */
export function rankHits(hits: WebHitLike[], queries: string[]): WebHitLike[] {
  const terms = termsOf(queries)
  const allDictLike = queries.some((q) => /词典|字典|释义|怎么读|的字义/.test(q))
  const scored = hits.map((h, i) => {
    const title = (h.title ?? '').toLowerCase()
    const snip = (h.snippet ?? '').toLowerCase()
    let score = 0
    for (const t of terms) {
      if (title.includes(t)) score += 3
      if (snip.includes(t)) score += 1
    }
    const dict = !allDictLike && DICT_JUNK.test(h.title ?? '')
    if (dict) score -= 6
    return { h, score, dict, i }
  })

  /* 用户没在问字义时，词典条目一律不进候选——哪怕命中了问题里的字 */
  return scored
    .filter((x) => !x.dict && x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.h)
}

/**
 * 天气意图 → 地名。
 *
 * 为什么要单独识别：搜索页根本给不出预报。实测「乌鲁木齐 今天 天气」
 * 「乌鲁木齐 天气预报 今天」在 Bing 上都只回城市百科和旅游攻略，模型
 * 拿着这些只能说不知道。天气改成走专门的天气源，别再靠搜索刮。
 *
 * 返回 null 表示「不是天气问题，或者没说地点」——没说地点时宁可让
 * 模型追问一句，也不要按 IP 定位猜（实测会猜错城市）。
 */
export function weatherPlace(q: string): string | null {
  const s = (q ?? '').trim()
  if (!s) return null

  const CUE = /(天气|气温|温度|几度|多少度|下雨|降雨|下雪|降雪|冷不冷|热不热|穿什么|带伞)/
  if (!CUE.test(s)) return null

  /* 这里防的是「温度对服务器的影响」这种技术问题：带「对/的影响/
     是什么/原理」，说明问的是机制不是天气 */
  if (/(对|的影响|原理|区别|是什么|为什么|如何影响)/.test(s)) return null

  const place = s
    .replace(CUE, ' ')
    .replace(/(今天|明天|后天|现在|当前|实时|最新|今天早上|今晚|上午|下午|晚上|出门|需要|要不要|会|有|吗|呢|啊|呀|的|了)/g, ' ')
    .replace(
      /(怎么样|如何|多少|预报|查询|查一下|查下|看一下|看看|帮我|问一下|请问|告诉我|这几天|这两天|这周|最近|未来|接下来|几天|周末)/g,
      ' ',
    )
    .replace(/[，。！？、,.!?~～\s]+/g, '')
    .trim()

  /* 地名太短（「了」「明」）或太长（把整句都留下了）都不认 */
  if (place.length < 2 || place.length > 12) return null
  if (/[a-zA-Z0-9]{8,}/.test(place)) return null
  return place
}
