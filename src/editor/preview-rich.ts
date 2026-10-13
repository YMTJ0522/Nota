/**
 * 预览区的富块增强。
 *
 * marked 只认标准 Markdown，三类语法它会原样输出成纯文本：
 *   - Callout   `> [!NOTE] 标题` → 只是一段引用
 *   - 折叠详情  `<details>` → marked 会保留 HTML，但没有样式、也不能交互
 *   - 分栏标签  `:::: tabs` → 完全看不懂，原样吐出来
 *   - Mermaid   ```mermaid 代码块 → 一段普通代码
 *
 * 这一层在 marked 产出 HTML **之后**做一次改写，把它们变成真正的结构。
 * 用字符串处理而不是自定义 marked 扩展：改动面小、不与 marked 版本耦合，
 * 出错时最坏也就是退化成原文，不会整页渲染失败。
 */

const CALLOUT_RE =
  /<blockquote>\s*<p>\[!([A-Za-z]+)\]([+-]?)\s*([\s\S]*?)<\/p>([\s\S]*?)<\/blockquote>/g

const CALLOUT_META: Record<string, { label: string; icon: string }> = {
  note: { label: '提示', icon: 'ℹ' },
  tip: { label: '技巧', icon: '✦' },
  info: { label: '说明', icon: 'ℹ' },
  warning: { label: '警告', icon: '⚠' },
  caution: { label: '注意', icon: '⚠' },
  danger: { label: '危险', icon: '⛔' },
  success: { label: '成功', icon: '✓' },
  important: { label: '重要', icon: '❕' },
  question: { label: '疑问', icon: '?' },
  example: { label: '示例', icon: '❯' },
  quote: { label: '引用', icon: '❝' },
}

/** Callout：把 `> [!TYPE] 标题` 的引用块换成带类型的卡片 */
function transformCallouts(src: string): string {
  return src.replace(CALLOUT_RE, (_whole, type: string, fold: string, title: string, rest: string) => {
    const key = type.toLowerCase()
    const meta = CALLOUT_META[key] ?? { label: type, icon: 'ℹ' }
    const heading = title.trim() || meta.label
    // rest 是引用块里标题之后的剩余段落（already <p>…</p>）
    const body = rest.replace(/^\s*<p>\s*<\/p>\s*$/, '')
    return (
      `<div class="pv-callout" data-type="${key}">` +
      `<div class="pv-callout-head"><span class="pv-callout-icon">${meta.icon}</span>` +
      `<span class="pv-callout-title">${heading}</span>` +
      (fold ? `<span class="pv-badge">可折叠</span>` : '') +
      `</div><div class="pv-callout-body">${body}</div></div>`
    )
  })
}

/**
 * Mermaid：把 ```mermaid 代码块换成待渲染的容器。
 *
 * 真正画图是异步的（mermaid 主包很大，只在真出现图表时才动态加载），
 * 所以这里只输出一个带 `data-graph` 的占位，由 `renderMermaidInHtml`
 * 在 DOM 挂上之后填充。
 */
function transformMermaid(src: string): string {
  return src.replace(
    // 注意 `<pre` 后面要容属性：自定义 renderer 会往上面挂 class 和 data-info，
    // 写成 `<pre>` 就一条都匹配不上，图表会退化成一个空的代码框。
    /<pre[^>]*><code[^>]*class="[^"]*language-mermaid[^"]*"[^>]*>([\s\S]*?)<\/code><\/pre>/g,
    (_w, code: string) => {
      const text = code
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
      return `<div class="pv-mermaid"><div class="pv-mermaid-src">${escapeHtml(text)}</div><div class="pv-mermaid-graph" data-graph="${escapeAttr(text)}"></div></div>`
    },
  )
}

/* ── 容器块：`:::: tabs` 与 `::: details` ──

   marked 会把「连续几行」合并成一个 `<p>`，行间用 `<br>` 连接，
   于是工具栏插出来的结构在 HTML 里长这样：

     <p>:::: tabs<br>::: tab-item 标签一</p>
     <p>第一个标签页的内容。</p>
     <p>:::<br>::::</p>

   所以不能按「整行等于 `<p>:::: tabs</p>`」去匹配，那样一条都命中不了。

   做法：定位起始段 → 找到「最后一行是结束标记」的那一段 → 把两段之间的
   **原始 HTML** 整块取出来 → 再按段落拆行、重建结构。

   关键点是取原始 HTML 而不是只收集 `<p>`：标签页里可能放列表、表格、
   代码块，它们都不是 `<p>`，只认段落会把内容整段吞掉。 */

/** 把一段 HTML 拆成「行」和「整块 HTML」两类；`<br>` 视为换行 */
function splitRegionBlocks(html: string): { line: boolean; text: string }[] {
  const out: { line: boolean; text: string }[] = []
  const pRe = /<p>([\s\S]*?)<\/p>/g
  let pos = 0
  let m: RegExpExecArray | null
  while ((m = pRe.exec(html))) {
    if (m.index > pos) pushChunk(out, html.slice(pos, m.index))
    for (const part of m[1].split(/<br\s*\/?>/g)) {
      out.push({ line: true, text: stripPara(part) })
    }
    pos = pRe.lastIndex
  }
  if (pos < html.length) pushChunk(out, html.slice(pos))
  return out
}

/** 段落之外的内容：有 `<br>` 的当行（它是上一个段落的零头），否则当整块 */
function pushChunk(out: { line: boolean; text: string }[], raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) return
  if (/<br\s*\/?>/i.test(trimmed) && !/^</.test(trimmed)) {
    for (const part of trimmed.split(/<br\s*\/?>/g)) {
      out.push({ line: true, text: stripPara(part) })
    }
    return
  }
  out.push({ line: false, text: cleanBlock(trimmed) })
}

/**
 * 清掉块里残留的结束标记行。
 *
 * Markdown 里收尾的 `:::` 若紧跟在前一行后面（中间没空行），marked 会把它
 * 当成上一段的「懒继续」，塞进同一个块里，例如：
 *   <li>也可以放 <code>x</code><br>:::</li>
 * 这时它已经不是一个独立段落，走不到行解析，只能在这里按「紧贴闭合标签的
 * 冒号尾巴」清掉。
 */
function cleanBlock(html: string): string {
  return html.replace(/<br\s*\/?>\s*:{3,4}\s*(?=<\/(?:li|p|ul|ol|div|blockquote)>)/gi, '')
}

/** 该位置是否落在代码块内部（代码块里的冒号不算结构标记） */
function insideCode(src: string, index: number): boolean {
  const before = src.slice(0, index)
  const opens = (before.match(/<pre\b/gi) || []).length
  const closes = (before.match(/<\/pre>/gi) || []).length
  return opens > closes
}

/**
 * 找容器的结束位置。
 *
 * 结束行未必独占一个 `<p>`：它可能是某个 `<li>` 的最后一行，
 * 也可能是 `<p>:::<br>::::</p>` 这种「分隔行 + 结束行」挤在一段里的形态。
 * 所以不按段落找，而是直接扫「紧贴块级闭合标签的冒号行」，
 * 再把偏移推到那个闭合标签之后。
 */
function findContainerEnd(src: string, from: number, colons: number): number {
  const re = new RegExp(
    `(?<!:):{${colons}}(?!:)[ \\t]*(?=\\s*<br\\s*\\/?>|\\s*<\\/(?:p|li|ul|ol|div|blockquote|h[1-6]|td|th|section|article)>)`,
    'g',
  )
  re.lastIndex = from
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (insideCode(src, m.index)) continue
    const gt = src.indexOf('>', m.index)
    if (gt < 0) return -1
    // 结束行可能落在列表/引用的内部（懒继续），把外层容器的闭合标签一并吃进来，
    // 否则切出来的片段会带着一个没闭合的 <ul>，拼出去就是坏结构。
    let end = gt + 1
    const tailRe = /^\s*(?:<\/(?:ul|ol|div|blockquote|section|article|table)>)+/i
    for (;;) {
      const t = tailRe.exec(src.slice(end))
      if (!t) break
      end += t[0].length
    }
    return end
  }
  return -1
}

/** 剥掉一行首尾残留的段落标签 */
function stripPara(line: string): string {
  return line
    .trim()
    .replace(/^<\/p>/, '')
    .replace(/^<p[^>]*>/, '')
    .replace(/<\/p>$/, '')
    .trim()
}

/* ── 分栏标签 ── */

const TABS_OPEN_AT = /<p>\s*:{4,}\s*tabs\b[ \t]*[^<\n]*/i

function transformTabs(src: string): string {
  let out = ''
  let rest = src

  for (;;) {
    const openAt = TABS_OPEN_AT.exec(rest)
    if (!openAt) break

    const openEnd = rest.indexOf('</p>', openAt.index)
    if (openEnd < 0) {
      const cut = openAt.index + openAt[0].length
      out += rest.slice(0, cut)
      rest = rest.slice(cut)
      continue
    }

    // 单段写法：起始行和结束行挤在同一个 <p> 里
    const openPara = rest.slice(openAt.index, openEnd + 4)
    const end = /<br\s*\/?>\s*:{4,}\s*<\/p>$/i.test(openPara)
      ? openEnd + 4
      : findContainerEnd(rest, openEnd + 4, 4)

    // 没闭合就当普通文本放过，避免吃掉后面整篇文章
    if (end < 0) {
      out += rest.slice(0, openEnd + 4)
      rest = rest.slice(openEnd + 4)
      continue
    }

    out += rest.slice(0, openAt.index)
    out += buildTabsHtml(rest.slice(openAt.index, end))
    rest = rest.slice(end)
  }

  return out + rest
}

/** 把容器区域拼成 tabs 结构；识别不出标签时原样退回 */
function buildTabsHtml(region: string): string {
  const tabs: { label: string; body: string[] }[] = []
  let cur: { label: string; body: string[] } | null = null

  for (const tok of splitRegionBlocks(region)) {
    if (!tok.line) {
      if (cur) cur.body.push(tok.text)
      continue
    }
    const bare = tok.text.trim()
    if (/^:{4,}\s*tabs\b/i.test(bare)) continue // 起始行
    if (/^:{4,}$/.test(bare)) continue // 结束行
    if (/^:{3}$/.test(bare)) continue // 标签之间的分隔
    const item = /^:{3}\s*tab-item\s*(.*)$/i.exec(bare)
    if (item) {
      cur = { label: item[1].trim() || `标签 ${tabs.length + 1}`, body: [] }
      tabs.push(cur)
      continue
    }
    if (!bare) continue
    if (cur) cur.body.push(`<p>${bare}</p>`)
  }

  if (tabs.length === 0) return region

  const head = tabs
    .map((t, k) => `<span class="pv-tab${k === 0 ? ' on' : ''}">${t.label}</span>`)
    .join('')
  const panes = tabs
    .map(
      (t, k) =>
        `<div class="pv-tab-pane${k === 0 ? ' on' : ''}">${t.body.join('\n') || '<p></p>'}</div>`,
    )
    .join('')
  return `<div class="pv-tabs"><div class="pv-tabbar">${head}</div>${panes}</div>`
}

/* ── 折叠详情（`::: details 标题` 围栏写法） ── */

const DETAILS_OPEN_AT = /<p>\s*:{3}\s*details\b[ \t]*([^<\n]*)/i

function transformDetailsFence(src: string): string {
  let out = ''
  let rest = src

  for (;;) {
    const openAt = DETAILS_OPEN_AT.exec(rest)
    if (!openAt) break

    const openEnd = rest.indexOf('</p>', openAt.index)
    if (openEnd < 0) {
      const cut = openAt.index + openAt[0].length
      out += rest.slice(0, cut)
      rest = rest.slice(cut)
      continue
    }

    const title = (openAt[1] ?? '').trim().replace(/^\[\s*\]$/, '')
    const openPara = rest.slice(openAt.index, openEnd + 4)
    const end = /<br\s*\/?>\s*:{3}\s*<\/p>$/i.test(openPara)
      ? openEnd + 4
      : findContainerEnd(rest, openEnd + 4, 3)

    if (end < 0) {
      out += rest.slice(0, openEnd + 4)
      rest = rest.slice(openEnd + 4)
      continue
    }

    out += rest.slice(0, openAt.index)
    out += buildDetailsFenceHtml(rest.slice(openAt.index, end), title)
    rest = rest.slice(end)
  }

  return out + rest
}

function buildDetailsFenceHtml(region: string, title: string): string {
  const body: string[] = []
  let first = true

  for (const tok of splitRegionBlocks(region)) {
    if (!tok.line) {
      body.push(tok.text)
      continue
    }
    const bare = tok.text.trim()
    if (first) {
      first = false
      continue // 首行就是 `::: details 标题`
    }
    if (/^:{3}$/.test(bare)) continue // 结束行
    if (!bare) continue
    body.push(`<p>${bare}</p>`)
  }

  const label = title || '折叠详情'
  return (
    `<details class="pv-details"><summary>${label}</summary>` +
    `<div class="pv-details-body">${body.join('\n')}</div></details>`
  )
}

/** 折叠详情的 HTML 写法：补上样式类（原生 details 已支持点击展开） */
function transformDetails(src: string): string {
  return src.replace(/<details\b/gi, '<details class="pv-details"')
}

/**
 * 在「非代码」片段上做替换。
 *
 * 行内替换（==高亮==、$公式$）不能碰代码块——代码里的 `$` 和 `==`
 * 是字面量，改了就把用户的代码改了。按 `<pre>` / `<code>` 切成奇偶段，
 * 只对偶数段（非代码）执行 fn。
 */
function protectCode(html: string, fn: (s: string) => string): string {
  const parts = html.split(/(<pre\b[\s\S]*?<\/pre>|<code\b[\s\S]*?<\/code>)/gi)
  return parts.map((p, i) => (i % 2 === 1 ? p : fn(p))).join('')
}

/** 高亮：`==文字==`（marked 不认这个写法，会原样输出） */
function transformMark(src: string): string {
  return protectCode(src, (s) =>
    s.replace(/==([^=\n]+)==/g, (_w, text: string) => `<mark class="pv-mark">${text}</mark>`),
  )
}

/**
 * 数学公式：先落成带 `data-tex` 的占位，再交给 KaTeX 异步填充。
 *
 * 不在这里直接渲染，是因为 katex 连字体有 1MB 量级——
 * 只在文档里真的出现公式时才动态加载，普通笔记完全不受影响。
 *
 * 块级:行内的判定靠 `$` 的个数，而 marked 已经把连续行合并成一段并用
 * `<br>` 连接，所以块级公式在 HTML 里是 `<p>$$<br>源码<br>$$</p>`，
 * 不能按「整行以 $$ 开头」去找。
 */
const BLOCK_MATH_RE = /<p>\s*\$\$([\s\S]*?)\$\$\s*<\/p>/g

/**
 * 行内公式。
 *
 * 两个守卫是必须的：
 *   - `$` 后紧跟空白 → 是货币符号（「花了 $100」），不是公式
 *   - 闭合 `$` 前是空白 → 同上（「$ 100」），否则跨句误吞一大段
 * `[^$\n]` 限定不能跨行：跨了就把两个互不相干的 `$` 当成一对。
 */
const INLINE_MATH_RE = /\$(?![\s$])((?:[^$\n])+?)(?<![\s\\])\$/g

function transformMath(src: string): string {
  // 整段包进 protectCode：代码里的 $ 是字面量，不该参与公式改写
  return protectCode(src, (s) => {
    let out = s.replace(BLOCK_MATH_RE, (_w, body: string) => {
      const tex = decodeEntities(body).replace(/<br\s*\/?>/g, '\n').trim()
      return `<div class="pv-math-block" data-tex="${escapeAttr(tex)}">${escapeHtml(tex)}</div>`
    })
    out = out.replace(
      INLINE_MATH_RE,
      (_w, tex: string) =>
        `<span class="pv-math" data-tex="${escapeAttr(tex.trim())}">${escapeHtml(tex.trim())}</span>`,
    )
    return out
  })
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 给表格加一层容器，方便统一控制样式与横向滚动 */
function transformTables(src: string): string {
  return src.replace(/<table>/g, '<div class="pv-table-wrap"><table class="pv-table">').replace(/<\/table>/g, '</table></div>')
}

/* ── 标题锚点与目录 ── */

export interface HeadingItem {
  /** 预览区里对应元素的 id */
  id: string
  level: number
  text: string
  /** 源码里的行号（0 起）。只有从 Markdown 源码提取的标题才带 */
  line?: number
}

/**
 * 从 Markdown 源码里直接提标题。
 *
 * 为什么还要这一份：`decorateHeadings` 的目录要等预览渲染过才有，
 * 纯写作模式（不分栏）下大纲就是空的 —— 而恰恰是专心写的时候最想看结构。
 * 这份随着打字实时更新，行号也是准的，点了必定能跳到那一行。
 *
 * 会跳过 front matter 和围栏代码块里的 `#`，免得把注释当成章节。
 */
/**
 * 标题锚点：从文字生成 slug，重名的在后面加序号。
 *
 * 为什么不用「第几个标题」当 id（2.2.2 之前就是 `h-0` / `h-1` …）：
 * 大纲那份从源码提，预览这份从渲染后的 HTML 提，两边认到的标题集合并不
 * 总是完全一样 —— setext 标题（`标题` 下面一行 `===`）在源码里看不出来，
 * 引用块里的 `> # 标题` 源码那行又不以 `#` 开头。只要某一侧多认或少认一个，
 * 之后所有编号就整体错位一格，点第三项会跳到第四项去。
 *
 * 改成按文字取名之后，即使某一侧多一个标题，错位的也只有那一个，
 * 其余各项仍然各就各位。
 */
export function headingSlug(text: string, seen: Map<string, number>): string {
  const base =
    text
      .trim()
      .toLowerCase()
      .replace(/[\s　]+/g, '-')
      .replace(/[^\p{L}\p{N}-]+/gu, '')
      .replace(/^-+|-+$/g, '') || 'h'
  const n = (seen.get(base) ?? 0) + 1
  seen.set(base, n)
  return n === 1 ? base : `${base}-${n}`
}

/**
 * 行首的围栏记号。
 *
 * 允许引用前缀（`> ```bash`）与最多 3 个空格的缩进——4 个空格起是缩进式
 * 代码块，不构成围栏（CommonMark 的规矩，顺手也避开列表续行的误判）。
 * 返回开栏用的字符与长度，关栏要靠它们配对。
 */
function fenceMarkOf(line: string): { char: string; len: number } | null {
  const m = /^(?:[ \t]*>[ \t]?)*([ \t]*)(`{3,}|~{3,})/.exec(line)
  if (!m) return null
  if (m[1].replace(/\t/g, '    ').length > 3) return null
  return { char: m[2][0], len: m[2].length }
}

export function outlineFromSource(raw: string): HeadingItem[] {
  const out: HeadingItem[] = []
  const lines = raw.split('\n')
  const seen = new Map<string, number>()
  /* 记的是「开栏记号」而不是一个布尔值。
     原来写成 `fence = !fence` 的取反，只能应付最规矩的一对 ```
     碰到这两类就整体错位，代码块里的 `# 注释` 会整段漏进大纲、被当成 H1：
       · ````（四反引号）包着的块里出现 ``` 行——那是内容，不是关栏；
       · 用 ~ 开的块里出现 ``` 行，反之亦然。
     现在要求「同种字符 + 不短于开栏长度」才算关栏，对不上就一律当内容。
     只认长度不小于、不认「恰好等于」，是为了永远不会卡在「开着的状态」里出不来：
     万一用户手写的关栏多打了一个反引号，也应当正常收尾，而不是把后面半篇吞掉。 */
  let open: { char: string; len: number } | null = null
  /** front matter 必须以首行的 --- 开头 */
  let front = lines[0]?.trim() === '---'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const mark = fenceMarkOf(line)
    if (open) {
      // 块内一律不看标题——这就是「代码块里的 # 注释不该出现在大纲里」的落点
      if (mark && mark.char === open.char && mark.len >= open.len) open = null
      continue
    }
    if (mark) {
      open = mark
      continue
    }
    if (front) {
      // 结束分隔符顶多出现在第二行往后
      if (i > 0 && /^---\s*$/.test(line)) front = false
      continue
    }
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (!m) continue
    const level = m[1].length
    const text = plainInline(m[2])
    out.push({ id: headingSlug(text, seen), level, text, line: i })
  }
  return out
}

/** 抹掉行内的 Markdown 记号，只留看得见的字 */
function plainInline(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\s+#+\s*$/, '')
    .trim()
}

/**
 * 给预览里的 h1~h6 依次挂 id，并回传目录数据。
 *
 * 刻意从 HTML 反推而不是另解析一遍 Markdown：setext 标题（下划线式）
 * 在源码里看不出来，只有渲染后才知道它是不是标题。同一遍扫描保证
 * 目录项和页面元素严格一一对应，不会出现「点了没反应」。
 */
function decorateHeadings(html: string): { html: string; headings: HeadingItem[] } {
  const headings: HeadingItem[] = []
  const seen = new Map<string, number>()
  const next = html.replace(
    /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g,
    (whole, lvl: string, attrs: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, '').trim()
      if (/\sid=/.test(attrs)) {
        const existing = /\sid="([^"]+)"/.exec(attrs)?.[1]
        if (existing) headings.push({ id: existing, level: Number(lvl), text })
        return whole
      }
      const id = headingSlug(text, seen)
      headings.push({ id, level: Number(lvl), text })
      return `<h${lvl}${attrs} id="${id}">${inner}</h${lvl}>`
    },
  )
  return { html: next, headings }
}

/** 按顺序跑完所有预览增强，并顺带产出目录数据 */
export function enhancePreview(html: string): { html: string; headings: HeadingItem[] } {
  let out = html
  out = transformCallouts(out)
  // tabs 必须先于 details：tabs 收尾是 4 个冒号、details 是 3 个，
  // 先把 tabs 整块替换成 <div class="pv-tabs">，details 才不会把它里面的
  // `:::` 分隔行误当成自己的收尾。
  out = transformTabs(out)
  out = transformDetailsFence(out)
  out = transformDetails(out)
  // 行内改写要在 mermaid 还原成容器之前做：那时候图表源码还在 <pre><code> 里，
  // protectCode 能挡住它，不会把 mermaid 里的 $ 或 == 当成公式和高亮。
  out = transformMark(out)
  out = transformEmbeds(out)
  out = transformMath(out)
  // mermaid 必须先走：它要把 <pre><code> 还原成图表容器，
  // 晚一步的话会被下面的代码块包装当成普通代码框起来。
  out = transformMermaid(out)
  out = transformTables(out)
  return decorateHeadings(out)
}

/**
 * 笔记嵌入 `![[笔记名]]`。
 *
 * marked 不认这个写法，会原样输出成一串方括号文本。这里补成一个卡片：
 * 真正意义上的「把另一篇的正文拉进来渲染」要等双链那一版，
 * 现在先把它的样子和别的行内文本区分开，免得看着像没解析成功的乱码。
 */
function transformEmbeds(src: string): string {
  return protectCode(src, (s) =>
    s.replace(/!\[\[([^\]\n]+)\]\]/g, (_w, name: string) => {
      const label = escapeHtml(name.trim())
      return (
        `<span class="pv-embed" data-note="${escapeAttr(name.trim())}">` +
        `<span class="pv-embed-ico">${'\u{1F4C4}'}</span>` +
        `<span class="pv-embed-name">${label}</span>` +
        `</span>`
      )
    }),
  )
}

/* ── Mermaid 异步渲染 ── */

let mermaidMod: { initialize: Function; render: Function } | null = null

/**
 * 找页面里所有待渲染的 mermaid 容器并把 SVG 填进去。
 *
 * 失败（语法错、库没加载出来）时保留源码文本，不抛异常——
 * 一个写坏的图表不该让整篇预览白屏。
 */
export async function renderMermaidInHtml(root: HTMLElement): Promise<void> {
  const targets = root.querySelectorAll<HTMLElement>('.pv-mermaid-graph[data-graph]')
  if (targets.length === 0) return
  try {
    if (!mermaidMod) {
      const mod = (await import('mermaid')) as unknown as {
        default: { initialize: Function; render: Function }
      }
      mermaidMod = mod.default
      mermaidMod.initialize({ startOnLoad: false, securityLevel: 'strict' })
    }
  } catch {
    return
  }
  let n = 0
  for (const el of Array.from(targets)) {
    const code = el.dataset.graph ?? ''
    if (!code) continue
    try {
      const { svg } = (await mermaidMod.render(`pv-mmd-${Date.now()}-${n++}`, code)) as { svg: string }
      el.innerHTML = svg
      el.classList.add('is-rendered')
    } catch {
      el.classList.add('is-error')
    }
  }
}

/* ── 公式异步渲染 ── */

interface KatexApi {
  renderToString: (tex: string, opts?: Record<string, unknown>) => string
}

let katexMod: KatexApi | null = null
/** 加载失败就别再试第二次，否则每敲一个字都会重新发起一次注定失败的请求 */
let katexFailed = false

/**
 * 把预留的公式占位换成 KaTeX 排出来的 HTML。
 *
 * 失败时保留源码文本——一个写错的公式不该把整篇预览拖白。
 * katex 本体连同它的 stylesheet 都是动态加载：文档里没有公式时，
 * 连一个字节都不会进主包。
 */
export async function renderMathInHtml(root: HTMLElement): Promise<void> {
  const targets = root.querySelectorAll<HTMLElement>('.pv-math[data-tex], .pv-math-block[data-tex]')
  if (targets.length === 0) return

  if (!katexMod && !katexFailed) {
    try {
      // 样式要跟着本体一起到位，否则公式会裸着排成一行纯文本
      await import('katex/dist/katex.min.css')
      const mod = (await import('katex')) as unknown as KatexApi & { default?: KatexApi }
      katexMod = typeof mod.renderToString === 'function' ? mod : (mod.default ?? null)
      if (!katexMod) throw new Error('katex: no renderToString')
    } catch {
      katexFailed = true
      katexMod = null
    }
  }
  if (!katexMod) return

  for (const el of Array.from(targets)) {
    const tex = el.dataset.tex ?? ''
    if (!tex) continue
    try {
      el.innerHTML = katexMod.renderToString(tex, {
        displayMode: el.classList.contains('pv-math-block'),
        throwOnError: false,
        strict: false,
      })
      el.classList.add('is-rendered')
    } catch {
      el.classList.add('is-error')
    }
  }
}

/* ── 小工具 ── */

/**
 * 预览前剥掉 YAML frontmatter。
 *
 * 不剥的话 marked 会把开头的 `---` 当成 setext 标题的下划线，
 * 把 `title:` / `tags:` 那一整段渲染成一个巨大的二级标题——
 * 预览顶部会出现一段莫名其妙的元数据，这是最基础的渲染错误。
 */
export function stripFrontMatter(md: string): string {
  return md.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}
