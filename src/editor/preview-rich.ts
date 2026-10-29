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

import { displayLangName } from './code-languages'

const CALLOUT_RE =
  /<blockquote>\s*<p>\[!([A-Za-z]+)\]([+-]?)\s*([\s\S]*?)<\/p>([\s\S]*?)<\/blockquote>/g

/**
 * 提示块的图标一律是描边 SVG，不用字符。
 *
 * 字符看着省事，实际三种毛病：⚠ 在有些字体里会被画成彩色 emoji（一块
 * 黄三角压在文里）、✦ ❝ 这类符号不同字体高矮不一、而且它们在深色下
 * 跟着正文色走，根本分不出类型。SVG 用 currentColor，颜色由 --c 给，
 * 深浅两套主题下都跟提示块自己的色走。
 */
function calloutIcon(paths: string): string {
  return (
    `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
  )
}

const I = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11.5V16"/><path d="M12 8h.01"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>',
  bulb: '<path d="M9.5 18h5"/><path d="M10.5 21h3"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.8 1 .8 1.6v.6h5.6v-.6c0-.6.3-1.2.8-1.6A6 6 0 0 0 12 3Z"/>',
  tri: '<path d="M10.3 4.3 2.7 17.4a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v3.5"/><path d="M12 16.5h.01"/>',
  bang: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/>',
  cross: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6"/><path d="m15 9-6 6"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8.2 12.4 2.6 2.6 5-5.4"/>',
  star: '<path d="M12 3.2l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.5l6-.8Z"/>',
  ask: '<circle cx="12" cy="12" r="9"/><path d="M9.7 9.4a2.4 2.4 0 1 1 3.3 2.2c-.6.3-1 1-1 1.7"/><path d="M12 16.5h.01"/>',
  code: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="m7.5 10 2.5 2.5-2.5 2.5"/><path d="M13 15h3.5"/>',
  chat: '<path d="M20 11.5a7 7 0 0 1-7 7H9.5L5 21v-4.6A7 7 0 0 1 9 5h4a7 7 0 0 1 7 6.5Z"/>',
}

const CALLOUT_META: Record<string, { label: string; icon: string }> = {
  note: { label: '提示', icon: calloutIcon(I.info) },
  tip: { label: '技巧', icon: calloutIcon(I.bulb) },
  info: { label: '说明', icon: calloutIcon(I.doc) },
  warning: { label: '警告', icon: calloutIcon(I.tri) },
  caution: { label: '注意', icon: calloutIcon(I.bang) },
  danger: { label: '危险', icon: calloutIcon(I.cross) },
  success: { label: '成功', icon: calloutIcon(I.check) },
  important: { label: '重要', icon: calloutIcon(I.star) },
  question: { label: '疑问', icon: calloutIcon(I.ask) },
  example: { label: '示例', icon: calloutIcon(I.code) },
  quote: { label: '引用', icon: calloutIcon(I.chat) },
}

/** Callout：把 `> [!TYPE] 标题` 的引用块换成带类型的卡片 */
function transformCallouts(src: string): string {
  return src.replace(CALLOUT_RE, (_whole, type: string, fold: string, title: string, rest: string) => {
    const key = type.toLowerCase()
    const meta = CALLOUT_META[key] ?? { label: type, icon: 'ℹ' }
    const titleText = title.trim()
    // marked(breaks) 会把引用块里的软换行并成 <br>，导致「标题<br>正文」全被
    // 当成标题吞进来（正文会跟标题挤在一起，字号颜色都变标题样式）。
    // 把第一个 <br> 之后的内容拆出来放回正文区。
    let heading = titleText || meta.label
    let extraBody = ''
    const brIdx = titleText.indexOf('<br>')
    if (brIdx !== -1) {
      heading = titleText.slice(0, brIdx).trim() || meta.label
      const after = titleText.slice(brIdx + 4).trim()
      if (after) extraBody = `<p>${after}</p>`
    }
    // rest 是引用块里标题之后的剩余段落（already <p>…</p>）
    let body = rest.replace(/^\s*<p>\s*<\/p>\s*$/, '')
    if (extraBody) body = extraBody + body
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
 *
 * 占位里那个 `.pv-mermaid-src` 是**加载中与出错时**才该露面的源码：
 * 图还没画出来时它顶着位置，语法写错时它告诉你错在哪一行。
 * 画成功之后必须摘掉 —— 见 `renderMermaidInHtml` 里的说明。
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
 * 还有更糟的：marked 把 `:::…` 「懒继续」进了上一段——比如表格单元格里
 * `<td>::::</td>`、列表项里 `<li>…:::</li>`、引用块里末尾的 `:::`——
 * 这些就**没法**纯按字符串匹配定位到闭合段，因为整块被吸进外层元素里了。
 *
 * 解决：扫「独立的 <p> 段」，以段为单位看内容是不是纯冒号（允许 `<br>` 拆行）。
 * 这是 marked **最稳定的输出形态**——任凭它怎么懒继续，`::::` 只要真的想当
 * 闭合标记，它就会独立成段；只要它被外层吃掉了，就当成内容漏出去，让 buildXxxHtml
 * 走 fallback 把那些残留的 `::::` `:::` 当成纯文本丢掉。
 *
 * 如果连一个独立闭合段都找不到（marked 把一切全打散），则按外层元素的边界回退。
 */
function findContainerEnd(src: string, from: number, colons: number): number {
  // 优先级 1：找下一个「内容里只有 colons 个冒号（允许 `<br>` 拆行）」的独立 <p>。
  const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi
  pRe.lastIndex = from
  let pm: RegExpExecArray | null
  while ((pm = pRe.exec(src))) {
    const inner = pm[1]
    // 把 <br> 当分隔、空格去掉、剩余的就是纯字符。
    const cleaned = inner
      .replace(/<br\s*\/?>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, '')
    if (cleaned.length >= colons && /^:+$/.test(cleaned)) {
      return pm.index + pm[0].length
    }
  }
  // 优先级 2：找「列内孤立的 :{colons,}」——marked 把闭合符塞进了 <td> / <li> 这种
  // 块级元素的最后位置，且后面跟着那个元素的闭合。把段落收尾时一并把外层
  // 已经开启的块级标签全收完，避免 region 截在标签里。
  const colonRe = new RegExp(`(?<!:):{${colons},}(?!:)`, 'g')
  colonRe.lastIndex = from
  let m: RegExpExecArray | null
  while ((m = colonRe.exec(src))) {
    if (insideCode(src, m.index)) continue
    // 把匹配到冒号段后面的所有「孤立闭合标签」一并吃掉，包括 </td></tr></table> 等。
    const tailRe = /^\s*(?:<\/(?:ul|ol|li|div|blockquote|section|article|table|tr|td|p|h[1-6]|th)>)+/i
    let end = m.index + m[0].length
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
  // region 来自 findContainerEnd:它已经尽力找闭合段的位置,但 marked 经常把
  // 闭合 `:::` `::::` 「懒继续」进表格单元格 / 列表项 / 引用块,
  // 让定位丢失精度。先把这类「漏出去」的纯冒号块清掉,再交给下面的 split。
  // 清理必须用 DOM 而不是字符串扫,免得误伤真正的内容。
  const cleaned = stripFencesFromBlocks(region)
  const tabs: { label: string; body: string[] }[] = []
  let cur: { label: string; body: string[] } | null = null

  for (const tok of splitRegionBlocks(cleaned)) {
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

  if (tabs.length === 0) return cleaned

  // data-i 是给点击接线用的:标签和它对应的内容页按同一个序号配对,
  // 切换时只改两边 `.on` 落在第几个上。没有它就得靠 DOM 顺序去数,
  // 一旦中间夹了别的节点数就错。
  const head = tabs
    .map(
      (t, k) =>
        `<span class="pv-tab${k === 0 ? ' on' : ''}" data-i="${k}" role="tab" tabindex="0">${t.label}</span>`,
    )
    .join('')
  const panes = tabs
    .map(
      (t, k) =>
        `<div class="pv-tab-pane${k === 0 ? ' on' : ''}" data-i="${k}">${t.body.join('\n') || '<p></p>'}</div>`,
    )
    .join('')
  return `<div class="pv-tabs"><div class="pv-tabbar">${head}</div>${panes}</div>`
}

/**
 * 把 marked 输出里「内容只含冒号 + 空白」的叶节点整块移除——
 * 主要是 `<td>::::</td>` `<li>…:::</li>` `<p>::::</p>` 这种。
 * 它们是闭合标记,但 marked 没办法识别,而被「懒继续」进了外层块。
 * 漏到 tabs region 里会把表格行搞乱、让标题节点被吞进来。
 *
 * 不能在源 HTML 字符串上改:DOM 解析才能识别「这是孤立的纯冒号 cell」。
 */
function stripFencesFromBlocks(html: string): string {
  if (!html.includes(':::')) return html
  // 用一个游离容器解析,不挂到文档,改完拿走序列化字符串。
  const host = document.createElement('div')
  host.innerHTML = html
  // 1) 全树扫:任何叶节点,文本只有 `:xxx` / `xxx:::` 之类纯冒号 + 空白,删它。
  const all = Array.from(host.querySelectorAll('p, td, th, li, span'))
  for (const el of all) {
    if (el.children.length > 0) continue
    const text = (el.textContent ?? '').trim()
    if (text && /^:{3,}$/.test(text)) {
      // 如果父容器里就剩这一个子,直接删会把父留个空壳;
      // 这里只删这一行文本节点,父自然空下来。
      el.remove()
    }
  }
  return host.innerHTML
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

/** 高亮：`==文字==`（marked 不认这个写法，会原样输出）。
    前面可以跟一个颜色标签：`=={green}文字==`，不写就是默认的黄笔。
    颜色名用 data-c 带出去而不是写成内联色——同一份文档在明暗两套主题里
    要各配一支笔（见 markdown.css 的 .pv-mark[data-c]）。 */
const HL_RE = /==(?:\{([a-z]+)\})?([^=\n]+)==/g

function transformMark(src: string): string {
  return protectCode(src, (s) =>
    s.replace(
      HL_RE,
      (_w, color: string | undefined, text: string) =>
        `<mark class="pv-mark"${color ? ` data-c="${color}"` : ''}>${text}</mark>`,
    ),
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

/**
 * 关栏行。按 CommonMark，关栏**只能是纯围栏**——除了空白不能再带东西，
 * 带语言标记的那一行是开栏，不是关栏。
 *
 * 以前开栏关栏共用一个判定（就是上面那个 `fenceMarkOf`），于是代码块里
 * 任何一行恰好以 ``` 开头都会被当成关栏：笔记在讲 Markdown 语法时很常见，
 * 代码里嵌的三引号字符串、示例里贴的一段 fence 也是。那一行提前关栏，
 * 后面整段代码就暴露在正文里，里面的 `# 注释` 顺理成章被收进了大纲——
 * 「大纲尾部冒出代码块里的注释」就是这么来的。
 *
 * `\r?` 是给 CRLF 留的：按行切完末尾会剩一个回车，不算「栏里还有东西」。
 */
function fenceCloseOf(line: string): { char: string; len: number } | null {
  const m = /^(?:[ \t]*>[ \t]?)*([ \t]*)(`{3,}|~{3,})[ \t]*\r?$/.exec(line)
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
      // 关栏要走更严的那条判定（纯围栏），见 fenceCloseOf
      const close = fenceCloseOf(line)
      if (close && close.char === open.char && close.len >= open.len) open = null
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
  // 脚注的第一步必须最早：它要把 `[^1]: …` 那几段从正文里摘出来挪到文末，
  // 晚一步的话那些段落已经被 tabs / details 当成自己的内容包走了。
  const { html: fnOut, notes } = collectFootnotes(out)
  out = fnOut
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
  out = transformWikiLinks(out)
  out = transformMath(out)
  // mermaid 必须先走：它要把 <pre><code> 还原成图表容器，
  // 晚一步的话会被下面的代码块包装当成普通代码框起来。
  out = transformMermaid(out)
  out = enhanceCodeBlocks(out)
  out = transformHashtags(out)
  out = transformBlockIds(out)
  out = markTaskCheckboxes(out)
  out = appendFootnotes(out, notes)
  out = transformTables(out)
  return decorateHeadings(out)
}

/* ── 脚注 ──
   marked 不带脚注（那是 GitHub 的 GFM 方言之一，得另装扩展）。
   以前这里什么都没做，于是工具栏插出来的 `[^1]` 在预览里就是一串中括号，
   文末那行 `[^1]: 说明` 也原样躺着——写了脚注看不见，等于没写。

   两步走：先把定义段从正文里摘出来（同时把正文里的 `[^1]` 换成一个上标），
   再统一append 到文末。分两步是因为②要落在所有富块包完之后——
   否则 `::: details` 这类块会把脚注列表当成自己的一段内容卷进去。 */
interface Footnote {
  id: string
  html: string
}

const FOOTNOTE_DEF_RE = /<p>\s*\[\^([^\]\n]+)\]:\s*([\s\S]*?)<\/p>/g

function collectFootnotes(src: string): { html: string; notes: Footnote[] } {
  const notes: Footnote[] = []
  let html = src.replace(FOOTNOTE_DEF_RE, (_w, id: string, body: string) => {
    notes.push({ id: id.trim(), html: body.trim() })
    // 定义段要整段挪走：留在原地的话正文里会凭空多出一段「脚注说明」，
    // 而它本该在文末那张列表里。
    return ''
  })
  if (notes.length === 0) return { html: src, notes }
  // 正文里那些 `[^1]`：只在标签之外的文字上改，`<a href>` 属性里的不改
  const ids = new Set(notes.map((n) => n.id))
  html = mapHtmlText(html, (s) =>
    s.replace(/\[\^([^\]\n]+)\]/g, (whole, id: string) => {
      if (!ids.has(id.trim())) return whole
      const slug = `fn-${encodeURIComponent(id.trim())}`
      return (
        `<sup class="pv-fnref" id="fnref-${slug}">` +
        `<a href="#${slug}">${escapeHtml(id.trim())}</a></sup>`
      )
    }),
  )
  return { html, notes }
}

function appendFootnotes(src: string, notes: Footnote[]): string {
  if (notes.length === 0) return src
  const rows = notes
    .map((n) => {
      const slug = `fn-${encodeURIComponent(n.id)}`
      const back =
        `<a href="#fnref-${slug}" class="pv-fnback" aria-label="回到正文">↩</a>`
      return (
        `<li id="${slug}" class="pv-fn"><span class="pv-fn-n">${escapeHtml(n.id)}</span>` +
        `<span class="pv-fn-body">${n.html}${back}</span></li>`
      )
    })
    .join('')
  return `${src}<section class="footnotes"><ol class="pv-fn-list">${rows}</ol></section>`
}

/* ── 高级代码块 ──
   工具栏那一项插出来的是 ```text title="示例" line-numbers {2}``，
   marked 只认第一个词当语言，其余全丢（这一步在 markdown.ts 里已经把整串
   信息挂到 `data-info` 上带过来了）。这里把它兑现成三样东西：
     · 标题 —— 块顶上一条细caption，说明这段是什么；
     · 行号 —— 用来指着某一行说话（「看第 12 行」），装在左边一道窄轨里；
     · 高亮行 —— `{2}` / `{2,4-6}`，把要人看的几行点出来。
   三者都可缺省：没写就不画，不写一个空标题条在那里占位。 */
function enhanceCodeBlocks(src: string): string {
  return src.replace(
    /<pre\b([^>]*)\bdata-info="([^"]*)"([^>]*)>([\s\S]*?)<\/pre>/g,
    (whole, preA: string, rawInfo: string, preB: string, inner: string) => {
      const info = decodeEntities(rawInfo).trim()
      const lang =
        (info.split(/\s+/)[0] ?? '') ||
        (/<code[^>]*class="[^"]*language-([^"\s]+)/.exec(inner)?.[1] ?? '')
      const title = /title\s*=\s*"([^"]*)"|title\s*=\s*'([^']*)'/.exec(info)
      const caption = (title?.[1] ?? title?.[2] ?? '').trim()
      const numbered = /\bline-?numbers\b/i.test(info)
      const hl = /\{([\d,\s-]+)\}/.exec(info)
      const lines = hl ? parseLineSpec(hl[1]) : null

      let body = inner
      if (lines && lines.size > 0) {
        let at = 0
        body = body.replace(/<span class="pv-line">/g, (tag) => {
          at += 1
          return lines.has(at) ? `<span class="pv-line is-hl">` : tag
        })
      }

      // 注意前面那个空格不能省：属性串是直接拼在 `<pre` 后面的，
      // trim 掉了 `<pre` 和 `class` 之间那道缝就变成 `<preclass=…`，
      // 浏览器会当成一个叫 preclass 的陌生标签，整个代码块就没了。
      const attrs =
        ` ${preA}${preB}`.replace(/\s+/g, ' ') + (numbered ? ' data-line-numbers="1"' : '')
      const head = caption
        ? `<figcaption class="pv-code-title">${escapeHtml(caption)}</figcaption>`
        : ''
      // 语言标签放在 pre **外面**：塞进 <pre> 里的话它就成了代码正文的一部分，
      // 选中整块复制时会把「Python」两个字一起带走。
      const chip = lang
        ? `<span class="pv-code-lang">${escapeHtml(displayLangName(lang))}</span>`
        : ''
      const box = `<div class="pv-code-box">${chip}<pre${attrs}>${body}</pre></div>`
      return caption
        ? `<figure class="pv-code-fig" data-lang="${escapeAttr(lang)}">${head}${box}</figure>`
        : box
    },
  )
}

/* ── 待办清单能勾选 ──
   marked 把 `- [ ] 去买牛奶` 渲染成一个 **带 disabled 的复选框**：
   它只是把源码里那对方括号画成一个勾，并不打算让人点。
   可预览里的待办如果不能勾，它就只是一张画得好看的清单 ——
   清单的全部价值恰恰在「做完一项划掉一项」这个动作上。

   所以把那些 input 换成我们自己的 span，并按**出现顺序**编号（data-task）。
   序号是两边对齐的唯一凭据：源码里第 n 个任务行 ↔ 预览里第 n 个勾。
   两边都只数围栏之外的任务行，代码块里写的 `- [ ]` 不会被算进去，不会串号。 */
function markTaskCheckboxes(src: string): string {
  let n = 0
  return src.replace(/<input\b[^>]*>/g, (tag) => {
    if (!/type\s*=\s*["']?checkbox/i.test(tag)) return tag
    const on = /\bchecked\b/i.test(tag)
    const i = n++
    return (
      `<span class="pv-task${on ? ' on' : ''}" data-task="${i}" role="checkbox" ` +
      `aria-checked="${on ? 'true' : 'false'}" tabindex="0"></span>`
    )
  })
}

const TASK_LINE_RE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\]/

/**
 * 源码里第 index 个待办行在哪（返回要切换的那个字符的位置）。
 *
 * **「第几个」必须和预览里数的是同一批。** 预览那侧数的是 marked 真正渲染出来的
 * 复选框（markTaskCheckboxes），所以这里也得先去掉那些 marked 看不到的东西，
 * 或者它吃掉了行首标记的东西。少排除一样，序号就会往后错一位 —— 点第二条，
 * 勾掉的是第三条。三条规则，各自对应 `prepareMarkdown` 里的一步：
 *
 *  · 围栏代码块里的 `- [ ]` 只是示例文本，不是待办；
 *  · `%%…%%` 注释在进 marked 之前就被 stripComments 删了；
 *  · 文首的 frontmatter 同样一行都进不去 marked。
 *
 * 反过来，引用块里的 `> - [ ]` marked 是**照常渲染**成待办的，所以行首的 `>`
 * 要先剥掉再认，否则那里会漏数一条。
 */
export function findTaskLine(md: string, index: number): { from: number; done: boolean } | null {
  const lines = md.split('\n')

  /* frontmatter：和 stripFrontMatter 一样，只在文件最开头、且真的能收尾时才剥 */
  let start = 0
  if (lines.length > 1 && /^\uFEFF?[ \t]*\\?---[ \t]*$/.test(lines[0])) {
    for (let n = 1; n < lines.length; n += 1) {
      if (/^[ \t]*\\?---[ \t]*$/.test(lines[n])) {
        start = n + 1
        break
      }
    }
  }

  let at = 0
  let pos = 0
  for (let n = 0; n < start; n += 1) pos += lines[n].length + 1

  let fenceChar = ''
  let inComment = false
  for (let n = start; n < lines.length; n += 1) {
    const line = lines[n]
    const fence = /^[ \t]*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (!fenceChar) fenceChar = fence[1][0]
      else if (fence[1][0] === fenceChar) fenceChar = ''
    } else if (!fenceChar) {
      /* 行**开头**就在注释里 → 整行都被 stripComments 吃掉。
         注释从行中间开始的不算：`- [ ] 买牛奶 %%备注%%` 那个待办还在。
         围栏里不翻这个状态，和 protectFences 的口径一致。 */
      const wasInComment = inComment
      if (((line.match(/%%/g)?.length ?? 0) & 1) === 1) inComment = !inComment

      if (!wasInComment) {
        const q = /^[ \t]*(?:>[ \t]?)+/.exec(line)
        const skip = q ? q[0].length : 0
        const t = TASK_LINE_RE.exec(line.slice(skip))
        if (t) {
          if (at === index) {
            return { from: pos + skip + t[1].length + 1, done: t[2].toLowerCase() === 'x' }
          }
          at += 1
        }
      }
    }
    pos += line.length + 1
  }
  return null
}

/** 把 `2,4-6` 这样的写法展开成行号集合 */
function parseLineSpec(spec: string): Set<number> {
  const set = new Set<number>()
  for (const part of spec.split(',')) {
    const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part)
    if (!m) continue
    const from = Number(m[1])
    const to = m[2] ? Number(m[2]) : from
    if (to < from) continue
    for (let i = from; i <= to && i <= 9999; i += 1) set.add(i)
  }
  return set
}

/* ── 行内标签 `#标签` ──
   工具栏「插入标签」写进正文的就是一个 `#` 加一串字。
   不渲染的话它跟普通正文没区别，人看不出自己刚才那一下生效了没有。
   这里给它一枚chip——注意它只是**长得像标签**，真正的标签在 frontmatter 里
   （侧栏「标签」区读的是那儿）；这颗chip是正文中联机成提到的记号，不参与筛选。

   两条边界：`# 后面要跟字`（单独的 `#` 是标点）；
   改写只在标签之外的文字上进行（`<a href="#x">` 里的那是地址，不是标签）。 */
function transformHashtags(src: string): string {
  return mapHtmlText(src, (s) =>
    s.replace(
      /(^|[\s(（【「，。：；！？、])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu,
      (_w, lead: string, tag: string) => `${lead}<span class="pv-tag">#${escapeHtml(tag)}</span>`,
    ),
  )
}

/* ── 块 ID `^名称` ──
   「块 ID」菜单项是给一块内容起个名字，好让别处的 `[[#^名称]]` 指过来。
   不渲染的话它只是正文末尾一枚插入符，看不出那里挂着一个名字。
   渲染成一枚淡淡的chip，同时给 `id`，将来跳转定位有地方可去。

   `^` 前面必须是白或是行首 —— `x^2` 是数学里的乘幂，不是块名。 */
function transformBlockIds(src: string): string {
  return mapHtmlText(src, (s) =>
    s.replace(
      /(^|\s)\^([A-Za-z0-9_\u4e00-\u9fa5][\w\u4e00-\u9fa5-]{0,31})/g,
      (_w, lead: string, id: string) =>
        `${lead}<span class="pv-bid" id="^${escapeAttr(id)}">^${escapeHtml(id)}</span>`,
    ),
  )
}

/** 只在「标签之外的文字」上做改写：`<a href="#x">` 属性里的 `#x` 是地址，
    代码块里写的东西是在讲语法。两者都不该被这些变换当成正文改写。 */
function mapHtmlText(src: string, fn: (s: string) => string): string {
  return protectCode(src, (s) =>
    s
      .split(/(<[^>]*>)/g)
      .map((part, i) => (i % 2 === 1 ? part : fn(part)))
      .join(''),
  )
}

/**
 * 指向另一篇笔记的三种写法，统一在这里变成 DOM。
 *
 *   `[[笔记名]]`        —— 双链：一枚链接，点了跳过去
 *   `[[笔记名#^块ID]]`  —— 块引用：指向那一篇里的某个块
 *   `![[笔记名]]`       —— 嵌入：把那一篇的正文拉进来显示
 *   `[[#^块ID]]`        —— 本篇里的块（省掉笔记名）
 *
 * marked 不认任何一种，会原样输出成一串方括号。以前只处理了嵌入那一种，
 * 于是「双链」在预览里是一串没人管的中括号，看着像没解析成功。
 *
 * 为什么都要经过 `protectCode`：代码块里写 `[[]]` 是在讲语法，不是要链接。
 *
 * 为什么解析出的名字先原样挂到 `data-note` 上、渲染成再看存不存在：
 * 这里是纯粹的字符串变换，拿不到工作区里有哪些笔记。存不存在由编辑区
 * 在 DOM 挂上去之后补一个 class（见 markWikiLinks）——那样本文还是纯函数，
 * 导出 / 阅读模式都不需要额外的入参。
 */
function transformWikiLinks(src: string): string {
  return protectCode(src, (s) =>
    s.replace(/(!?)\[\[([^\]\n]*)\]\]/g, (whole, bang: string, inner: string) => {
      const body = inner.trim()
      if (!body) return whole
      const at = body.indexOf('#')
      const note = (at >= 0 ? body.slice(0, at) : body).trim()
      const frag = at >= 0 ? body.slice(at + 1).trim() : ''
      const isBlock = frag.startsWith('^')
      const blockId = isBlock ? frag.slice(1) : ''
      const label = note || (isBlock ? `^${blockId}` : body)
      const data =
        (note ? ` data-note="${escapeAttr(note)}"` : '') +
        (blockId ? ` data-block="${escapeAttr(blockId)}"` : '')
      const tag = isBlock ? '块' : ''

      if (bang) {
        return (
          `<span class="pv-embed"${data}>` +
          `<span class="pv-embed-ico">${'\u{1F4C4}'}</span>` +
          `<span class="pv-embed-name">${escapeHtml(label)}</span>` +
          (isBlock ? `<span class="pv-embed-tag">${tag}</span>` : '') +
          `</span>`
        )
      }
      return (
        `<a class="pv-wlink"${data} role="link">` +
        (isBlock ? `<span class="pv-wlink-tag">${tag}</span>` : '') +
        `<span>${escapeHtml(label)}</span>` +
        `</a>`
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
 *
 * `asImage` 是给 Word 导出用的：Word 的 HTML 解析器不认识行内 `<svg>`，
 * 会整块丢掉 —— 导出的 .doc 里图表直接消失。所以那一路先光栅化成 PNG
 * 再以 `<img src="data:...">` 放回去，Word 认图片。
 */
/* ── 图表配色 ──
   mermaid 默认的 default 主题是自己的一套蓝紫灰，跟界面的陶土纸色系
   完全不是一家人：同一屏里正文写在暖底上、图表却是冷蓝细线，
   深色模式下更是白生生一片，像从别的软件里贴进来的。

   所以这里一律走 `theme: 'base'` + 自己给 themeVariables，颜色全部从
   CSS 变量里读：强调色换6套色板中的任何一套、或者切到深色，图表跟着变。
   这是别人也能够维修的颜色表 —— 不需要在这里重新维护一份十六进制常数。 */

/** 把 `rgb(255 255 255)` / `#fff` 都拆成三个 0–255 的数；读不出来就当黑 */
function parseColor(input: string): [number, number, number] {
  const s = input.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (hex) {
    const h = hex[1]
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ]
  }
  const nums = s.match(/-?\d+(\.\d+)?/g)
  if (nums && nums.length >= 3) return [Number(nums[0]), Number(nums[1]), Number(nums[2])]
  return [0, 0, 0]
}

/**
 * 往底色里兑一点：`ratio` 是 `color` 占的比例，兑出来的是「淡得几乎看不见但有」的那种底。
 *
 * 输出写成十六进制而不是 `rgb(r g b)`：mermaid 内部会对主题色做二次加工
 * （`darken()` / `lighten()` 那一类），它自己的颜色解析器只认 `#rrggbb` 和
 * 逗号分隔的 `rgb(r, g, b)`。喂它空格分隔的现代写法，它解析失败之后不会报错，
 * 而是默默退回一个深色，于是流程图里的节点全成了墨绿色的方块。
 * —— 饼图那几张没受影响，是因为那些色它只当字符串直接填，不做加工。
 */
function mix(color: string, base: string, ratio: number): string {
  const [r1, g1, b1] = parseColor(color)
  const [r2, g2, b2] = parseColor(base)
  const m = (a: number, b: number) => Math.round(a * ratio + b * (1 - ratio)).toString(16).padStart(2, '0')
  return `#${m(r1, r2)}${m(g1, g2)}${m(b1, b2)}`
}

function readVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/** 应用当前是不是深色主题。图表取色和导出强制浅色都看它。 */
const darkMode = () => document.documentElement.getAttribute('data-theme') === 'dark'

/* 图表色板：深浅两套，各自取过对比。
   提成模块级常量是因为它有两个用处 —— themeVariables 里逐项兑底色，
   以及 xychart 的 plotColorPalette（那个必须是一条完整的配置，不能只给一项）。 */
const MERMAID_PALETTE = {
  dark: { a: '#5fb3a1', b: '#e0b263', c: '#e08a6e', d: '#a3cb7e', e: '#cb8bb2', f: '#84a8cb' },
  light: { a: '#2e8c7e', b: '#c98a2e', c: '#bf5a3c', d: '#6e8c46', e: '#a44c74', f: '#4a7ca6' },
}

function mermaidThemeVariables(forceLight = false): Record<string, string> {
  /* forceLight 是给**导出**用的：导出的终点永远是白底 —— Word 的白纸、
     PDF 的白页、HTML 的白背景。而 svgToPng 光栅化时也是先铺一层白。
     深色主题下这套变量算出来的是「浅色线条 + 浅色文字」，落在白底上
     等于隐形（实测 xychart 的坐标轴与折线整张消失）。
     所以导出时无条件按浅色算色，跟用户当前用什么主题无关。 */
  const dark = !forceLight && darkMode()
  /* forceLight 时**不能**走 readVar：readVar 读的是当前主题挂在根上的真实值，
     深色主题下它照样会把 #16161a / #eeedea 捞回来，forceLight 就形同虚设
     （实测第一版就是这么翻车的 —— 导出出来的图还是深色）。
     所以强制浅色时直接用浅色字面量，一个变量都不问。 */
  const pick = (name: string, darkVal: string, lightVal: string) =>
    forceLight ? lightVal : readVar(name, dark ? darkVal : lightVal)
  const bg = pick('--n-bg', '#16161a', '#fbfaf6')
  const surface = pick('--n-surface', '#1c1d21', '#fffefb')
  const fg = pick('--n-fg', '#eeedea', '#2a2b28')
  const fgDim = pick('--n-fg-dim', '#a3a19b', '#8b8880')
  const line = pick('--n-line', '#33343a', '#e6e2da')

  /* 图表自己带一套色板，不再跟着界面强调色走。
   两条理由，都是挨过骂之后才定的：
   ① 强调色是给按钮和链接用的，把它整块铺到图上，整张图就变成一片强调色，
      而且用户换一次色板，所有图跟着换一种情绪 —— 图是内容，不该被主题绑架；
   ② 之前那套是从强调色 + 语义色推出来的，推出来的结果偏蓝紫，
      一整张图看过去发冷、发闷，被点名说丑。
   现在这组是手挑的：青为主（节点）、琥珀与陶土作辅，橄榄/玫/石板蓝
   留给饼图和多分支，冷暖搭着来，深浅两套各自取过对比。 */
  const P = MERMAID_PALETTE[dark ? 'dark' : 'light']

  /* 节点：主色兑进底色，浅浅一层 —— 形状还在，颜色是「我们家的」。
     描边取同色更深的一档，边上屋顶线用淡灰；文字永远是正文色，两套主题都读得清。 */
  /* 深色下兑得要比浅色多：底色本身就暗，只兑两成的话节点几乎和背景同色，
     整张图看上去像一堆描边空框。三成半才看得出「这是个有颜色的块」。 */
  const node = mix(P.a, bg, dark ? 0.36 : 0.15)
  const nodeHeavy = mix(P.a, bg, dark ? 0.6 : 0.46)
  /* 连线与箭头归「纸上也要认得出来」那一类，得比装饰线（--n-line）重。
     浅色这档原来拿 fgDim 兑 0.55，压在 #fbfaf6 上只有 #bdb9b0 ——
     屏幕上看着还行，打到纸上就是一缕灰雾，连线几乎和纸同色。
     改成按正文色兑 0.45，落到 #92928f：细，但一眼看得见往哪连。
     深色那档不动：底本来就暗，fgDim 兑出来已经够亮。 */
  const edge = dark ? mix(fgDim, bg, 0.55) : mix(fg, bg, 0.45)

  /* 字体不能写成 `var(--n-font-ui)`：mermaid 把它塞进 SVG 的 font-family
     属性里，那里没有 CSS 变量这个东西，写什么都认不出来 ——
     所以这里把算好的那一串字符取出来给它。 */
  const font = readVar('--n-font-ui', 'system-ui, sans-serif')

  return {
    /* 通用 */
    background: 'transparent',
    fontFamily: font,
    /* mainBkg 才是流程图节点的底：只给 primaryColor 的话，
       base 主题会自己从它推一份，推出什么全看它当时的心情 */
    mainBkg: node,
    primaryColor: node,
    primaryTextColor: fg,
    primaryBorderColor: nodeHeavy,
    secondaryColor: mix(P.b, bg, dark ? 0.24 : 0.16),
    secondaryTextColor: fg,
    secondaryBorderColor: mix(P.b, bg, 0.46),
    tertiaryColor: mix(P.c, bg, dark ? 0.24 : 0.16),
    tertiaryTextColor: fg,
    tertiaryBorderColor: mix(P.c, bg, 0.46),
    lineColor: edge,
    textColor: fg,
    titleColor: fg,
    /* 流程图：连线标签压在线上，给一层底色才读得出来 */
    edgeLabelBackground: surface,
    clusterBkg: mix(P.a, bg, 0.05),
    clusterBorder: mix(P.a, bg, 0.3),
    nodeBorder: nodeHeavy,
    /* 时序图 */
    actorBkg: node,
    actorBorder: nodeHeavy,
    actorTextColor: fg,
    actorLineColor: edge,
    signalColor: edge,
    signalTextColor: fg,
    labelBoxBkgColor: surface,
    labelBoxBorderColor: edge,
    labelTextColor: fg,
    loopTextColor: fg,
    /* 便签沿用「便利贴是黄的」这个直觉：琥珀兑开，浅色下更淡一点 */
    noteBkgColor: mix(P.b, bg, dark ? 0.22 : 0.32),
    noteTextColor: fg,
    noteBorderColor: edge,
    /* 类图 / 状态图 / 甘特图 */
    classText: fg,
    labelBackground: surface,
    taskTextLightColor: fg,
    taskTextColor: fg,
    taskBkgColor: node,
    taskBorderColor: nodeHeavy,
    activeTaskBkgColor: nodeHeavy,
    activeTaskBorderColor: P.a,
    gridColor: line,
    sectionBkgColor: mix(P.a, bg, 0.05),
    /* 饼图：同一组色按「实 → 淡」排两轮。八片里前六片各占一色
       （够分清就行，第 7、8 片开始变淡，一眼看得出是次要的），
       比 mermaid 默认那套看不出关系的彩虹好认得多。 */
    pie1: mix(P.a, bg, 0.92),
    pie2: mix(P.b, bg, 0.92),
    pie3: mix(P.c, bg, 0.92),
    pie4: mix(P.d, bg, 0.92),
    pie5: mix(P.e, bg, 0.92),
    pie6: mix(P.f, bg, 0.92),
    pie7: mix(P.a, bg, 0.55),
    pie8: mix(P.b, bg, 0.55),
    pieTitleTextSize: '15',
    pieStrokeColor: surface,
    pieOuterStrokeColor: line,
    /* 象限 / Git 图 */
    quadrant1Fill: mix(P.a, bg, 0.16),
    quadrant2Fill: mix(P.b, bg, 0.16),
    quadrant3Fill: mix(P.c, bg, 0.16),
    quadrant4Fill: mix(P.d, bg, 0.16),
    git0: mix(P.c, bg, 0.85),
    git1: mix(P.a, bg, 0.85),
    git2: mix(P.b, bg, 0.85),
    git3: mix(P.d, bg, 0.85),
    git4: mix(P.e, bg, 0.85),
    gitBranchLabel: mix(P.a, bg, 0.16),
    commitLabelColor: fg,
    commitLabelBackground: surface,
  }
}

/** 上次喂给 mermaid 的是什么主题。读数是对不上桥的： --n-accent 会随色板变，
    所以要把整份变量序列化之后比 —— 变了才重新 initialize，
    不然每次渲染（哪怕同一篇笔记反复重排）都要走一遍全局初始化。 */
let appliedThemeKey = ''

function ensureMermaidTheme(forceLight = false) {
  const vars = mermaidThemeVariables(forceLight)
  // 主题键要带上 forceLight：同一份色板在「深色渲染」和「浅色渲染」下
  // 是两次不同的 initialize，只用 vars 做键会让导出复用预览那份深色配置。
  const key = (forceLight ? 'light|' : 'auto|') + JSON.stringify(vars)
  if (key === appliedThemeKey) return
  mermaidMod?.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: vars,
    flowchart: { curve: 'basis' },
    /* xychart（折线/柱状）的线条色不走 themeVariables，得单独给：
       它的默认色板是 `#FFF4B5` 那一套 —— 那是配深底用的浅黄，
       落到白纸上淡得几乎看不出折线在哪。这里换成跟图里其它元素同族的颜色。 */
    xyChart: {
      plotColorPalette: Object.values(MERMAID_PALETTE[forceLight ? 'light' : darkMode() ? 'dark' : 'light']).join(','),
    },
    fontFamily: vars.fontFamily,
  })
  appliedThemeKey = key
}

/**
 * xychart 的线条色**不走 themeVariables**，initialize 里给的
 * `xyChart.plotColorPalette` 在 mermaid 11.17 上实测也吃不动 ——
 * 配了照样画成内置的 `#FFF4DD` 那一套浅黄，落在白纸上淡得几乎看不出折线。
 * 与其跟它的配置系统较劲，直接在**输出**上改：折线/柱子的分组类名是
 * `line-plot-N` / `bar-plot-N`，按序号取色板里对应的一色替换掉。
 * 折线改 stroke，柱子改 fill（rect 的边框色不动）。
 */
function recolorXyChart(svg: string, palette: string[]): string {
  if (!palette.length) return svg
  return svg.replace(
    /<g class="(line|bar)-plot-(\d+)">([\s\S]*?)<\/g>/g,
    (_m, kind: string, idx: string, body: string) => {
      const c = palette[Number(idx) % palette.length]
      const patched =
        kind === 'line'
          ? body.replace(/stroke="[^"]*"/g, `stroke="${c}"`)
          : body.replace(/fill="(?!none)[^"]*"/g, `fill="${c}"`)
      return `<g class="${kind}-plot-${idx}">${patched}</g>`
    },
  )
}

export async function renderMermaidInHtml(
  root: HTMLElement,
  opts: { asImage?: boolean; light?: boolean } = {},
): Promise<void> {
  const targets = root.querySelectorAll<HTMLElement>('.pv-mermaid-graph[data-graph]')
  if (targets.length === 0) return
  try {
    if (!mermaidMod) {
      const mod = (await import('mermaid')) as unknown as {
        default: { initialize: Function; render: Function }
      }
      mermaidMod = mod.default
      appliedThemeKey = ''
    }
    ensureMermaidTheme(opts.light ?? false)
  } catch {
    return
  }
  let n = 0
  const palette = Object.values(
    MERMAID_PALETTE[opts.light ? 'light' : darkMode() ? 'dark' : 'light'],
  )
  for (const el of Array.from(targets)) {
    const code = el.dataset.graph ?? ''
    if (!code) continue
    try {
      const { svg: rawSvg } = (await mermaidMod.render(
        `pv-mmd-${Date.now()}-${n++}`,
        code,
      )) as { svg: string }
      const svg = recolorXyChart(rawSvg, palette)
      if (opts.asImage) {
        const png = await svgToPng(svg)
        // 光栅化失败就退回 SVG：Word 可能认不出它，但总比把图弄丢好
        el.innerHTML = png
          ? `<img src="${png}" alt="图表" style="max-width:100%">`
          : svg
      } else {
        el.innerHTML = svg
      }
      el.classList.add('is-rendered')
      /* 画出来了就把那块源码摘掉。
         以前它一直留在 DOM 里，于是每张图上面都挂着一段灰色的
         `graph TD / A-->B` —— 预览里看得见，导出也照样带出去。
         它是「还没画出来」和「画错了」时的替身，不是图注。
         失败分支不动它：语法写错的人正需要看那几行。 */
      el.parentElement?.querySelector('.pv-mermaid-src')?.remove()
    } catch {
      el.classList.add('is-error')
    }
  }
}

/**
 * mermaid 的 SVG → PNG data URI。
 *
 * 尺寸从 viewBox 里读：mermaid 默认 `useMaxWidth`，给出的 svg 上写的是
 * `width="100%"`，`naturalWidth` 拿到的是 0，画出来会是一张空图。
 * 底色铺白 —— Word 里透明 PNG 常常会连内容一起看不见。
 */
export async function svgToPng(svg: string): Promise<string | null> {
  const vb = /viewBox="([\d.\-\s]+)"/.exec(svg)?.[1]?.trim().split(/[\s,]+/).map(Number)
  let w = vb && vb.length === 4 ? vb[2] : 0
  let h = vb && vb.length === 4 ? vb[3] : 0
  if (!w || !h) {
    w = Number(/width="(\d+(?:\.\d+)?)/.exec(svg)?.[1] ?? 0)
    h = Number(/height="(\d+(?:\.\d+)?)/.exec(svg)?.[1] ?? 0)
  }
  if (!w || !h) return null

  const scale = 2 // 2 倍图，打印和缩放都不糊
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('svg load failed'))
      img.src = url
    })
    const c = document.createElement('canvas')
    c.width = Math.round(w * scale)
    c.height = Math.round(h * scale)
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(img, 0, 0, c.width, c.height)
    return c.toDataURL('image/png')
  } catch {
    return null
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
 *
 * `output: 'mathml'` 是给 Word 导出用的：Word 不认 KaTeX 那套行内样式的
 * span 布局（它没有 flex / inline-block 的排版语义），但认得 `<math>` ——
 * 会当成一个真正的公式对象放进去。HTML / PDF 走默认的 html 输出，
 * 那是浏览器的强项。
 */
export async function renderMathInHtml(
  root: HTMLElement,
  opts: { output?: 'html' | 'mathml' } = {},
): Promise<void> {
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
        ...(opts.output ? { output: opts.output } : {}),
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
/**
 * 剥掉文首的 frontmatter。
 *
 * 宽容三件事，都是真踩过的：
 *  · BOM —— 有些编辑器存 UTF-8 会带，带了之后 `---` 就不在行首，整段漏进正文；
 *  · 收尾那行 `---` 后面可以没有换行（文件只有 frontmatter 时）；
 *  · 收尾行允许前后有空格。
 * 反过来不宽容：必须是文件的**最开头**，正文中间的 `---`（分隔线）不算。
 */
export function stripFrontMatter(md: string): string {
  // `\\?---`：分隔线前面多一个反斜杠也认。有些工具（包括我们自己的旧版本）
  // 写文件时会把行首的 `-` 转义成 `\-`，文件打开就是满屏的 `\---` 和
  // `title: …` —— 对这种「被写坏的 frontmatter」也照剥不误，别让用户背锅。
  return md.replace(
    /^\uFEFF?[ \t]*\\?---[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*\\?---[ \t]*(?:\r?\n|$)/,
    '',
  )
}

/**
 * 喂给 marked 之前的三步准备。
 *
 * 顺序是这样排的：先拆 frontmatter（它恒在文首，早拿早干净），
 * 再删隐藏注释，最后**把脚注定义的那个 `[` 转义掉**。
 *
 * 最后一步不做不行，而且它是最反直觉的一条：
 * `[^1]: 说明文字` 在 CommonMark 里**不是一个脚注，而是一条合法的链接引用定义**
 * —— 中括号里是引用名，冒号后面是地址。marked 会按后者吃掉它，
 * 于是定义段凭空消失，正文里的 `[^1]` 还顺手变成了一个指向「说明文字」的链接。
 * 转义之后它只是一段普通文字，脚注就能按我们自己的规则收拢到文末了。
 */
export function prepareMarkdown(md: string): string {
  return escapeFootnoteDefs(stripComments(stripFrontMatter(md)))
}

/** 脚注定义行：只在围栏外、且行首（允许缩进三格以内）才算 */
const FOOTNOTE_DEF_LINE = /^[ \t]{0,3}\[\^([^\]\n]+)\]:[ \t]?(.*)$/

function escapeFootnoteDefs(md: string): string {
  return protectFences(md, (s) =>
    s
      .split('\n')
      .map((line) => {
        const m = FOOTNOTE_DEF_LINE.exec(line)
        return m ? `\\[^${m[1]}]: ${m[2]}` : line
      })
      .join('\n'),
  )
}

/**
 * 隐藏注释 `%%写给自己看的%%`。
 *
 * marked 不认它，会把两个 `%%` 连同中间的字原样排进预览——
 * 「隐藏」两个字就成了笑话：藏起来的东西正大光明地印在页面上。
 *
 * 在 Markdown 这一层删，而不是等 HTML 出来再删：那时候注释已经参与过
 * 段落合并、标题判定（`%% # 假标题 %%` 会进大纲），再说什么也晚了。
 *
 * 代码块里不删：那里是在讲 `%%` 这个写法本身。
 */
export function stripComments(md: string): string {
  return protectFences(md, (s) => s.replace(/%%[\s\S]*?%%/g, ''))
}

/**
 * 让 `fn` 只在围栏之外的正文上生效。
 *
 * 和 `protectCode` 干的是同一件事，只是一个作用在 HTML 的 `<pre>` 上，
 * 这个作用在 Markdown 源码的 ``` 围栏上。
 */
function protectFences(md: string, fn: (s: string) => string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let inFence = false
  let fence = ''
  let buf: string[] = []
  const flush = () => {
    if (!buf.length) return
    out.push((inFence ? buf.join('\n') : fn(buf.join('\n'))))
    buf = []
  }
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (m) {
      const mark = m[1]
      if (!inFence) {
        // 开栏允许带 info string；关栏只能是纯围栏（CommonMark），
        // 这条判定跟大纲那边那一处必须一致，否则代码块里的注释会漏出去
        if (!/^ {0,3}(?:`{3,}|~{3,})[ \t]*$/.test(line)) {
          flush()
          inFence = true
          fence = mark
          buf.push(line)
          continue
        }
      } else if (mark[0] === fence[0] && mark.length >= fence.length) {
        buf.push(line)
        flush()
        inFence = false
        fence = ''
        continue
      }
    }
    buf.push(line)
  }
  flush()
  return out.join('\n')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}
