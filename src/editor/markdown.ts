/**
 * Markdown → HTML 的渲染管线。
 *
 * 抽出来是因为现在有两个地方要渲染 Markdown：编辑区右侧的预览，
 * 和 AI 编写页里模型的回答。两边必须长得一样——同一段代码在预览里
 * 是卡片、在对话里是裸文本，会让人怀疑是不是同一个应用。
 *
 * 管线顺序（有讲究，不能随意调换）：
 *   marked 解析 → 代码高亮（按行切开，产出 .pv-line）→ 富块增强（外壳、表格、公式、mermaid）
 * 高亮必须在富块之前：富块要重新包裹 HTML 结构，先高亮才能保证
 * 代码块（含 mermaid）都已经被标成 language-*。
 */
import { highlightCode, langFromClass } from './highlight-code'
import { parseFenceInfo } from './fence-info'
import { enhancePreview, stripFrontMatter } from './preview-rich'
import type { HeadingItem } from './preview-rich'

let markedMod: typeof import('marked') | null = null

export function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
export function escapeAttr(s: string) {
  return escapeHtml(s).replace(/"/g, '&quot;')
}
/** 代码正文的转义：和 marked 自己的一致，引号也转，取值时再解回来 */
export function escapeCode(s: string) {
  return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
/** 把 escapeCode 的结果解回原文（顺序有讲究：&amp; 必须最后解） */
export function decodeCode(s: string) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 目的地里带空格的图片 / 链接。
 *
 * CommonMark 规定：地址含空格时必须写成 `![图](<一张 图.jpg>)`，
 * 否则 marked 会放弃整行、把原文原样吐出来——表现就是「图片不显示」，
 * 预览里躺着一行 `![](attachments/剪影 3.jpg)` 的源码。
 * Windows 上 `IMG 1234.jpg`、`剪影 3.jpg` 这类带空格的文件名太常见了，
 * 指望用户自觉加尖括号并不现实，所以在这里兜住。
 *
 * 边界很关键：只有默认解析器**确实吃不下**的目标才接管
 * （含空白，或含会被当成锚点 / 查询串的 `#` `?`），
 * 其余一律返回 undefined 交回内置实现——不去动正常链接的行为。
 */
type SpacedDestToken = {
  type: 'spacedDest'
  raw: string
  isImage: boolean
  alt: string
  href: string
  title: string
}

/** src[open] 是 `[`，返回与它配对的 `]` 下标；跨行或找不到就返回 -1 */
function matchBracket(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    const c = src[i]
    if (c === '\\') {
      i += 1
      continue
    }
    if (c === '\n') return -1
    if (c === '[') depth += 1
    else if (c === ']') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** src[open] 是 `(`，返回 `{ href, title, end }`（end 指向 `)` 之后） */
function matchDestination(
  src: string,
  open: number,
): { href: string; title: string; end: number } | null {
  let depth = 0
  let close = -1
  let firstClose = -1
  for (let i = open + 1; i < src.length; i += 1) {
    const c = src[i]
    if (c === '\\') {
      i += 1
      continue
    }
    if (c === '\n') return null
    if (c === '(') depth += 1
    else if (c === ')') {
      if (firstClose < 0) firstClose = i
      if (depth === 0) {
        close = i
        break
      }
      depth -= 1
    }
  }
  // 括号没配平（`a(1.jpg` 这种）就退回第一个 `)`。
  // 文件名截断总好过整行退化成纯文本。
  if (close < 0) close = firstClose
  if (close < 0) return null

  let inner = src.slice(open + 1, close)
  let title = ''
  const t = /\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*$/.exec(inner)
  if (t) {
    title = t[1]
    inner = inner.slice(0, t.index)
  }
  let href = inner.trim()
  // 本来就写成尖括号形式的，尖括号是分隔符不是路径的一部分，
  // 不剥掉的话会被 encodeURI 成 %3C…%3E 混进文件名里
  if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1).trim()
  if (!href) return null
  return { href, title, end: close + 1 }
}

/** 带协议头的绝对地址（http:、nota-media:…），但要放过 Windows 盘符 `C:\` */
function isAbsolute(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)
}

const SPACED_DEST = {
  name: 'spacedDest',
  level: 'inline' as const,
  start(src: string) {
    const bang = src.indexOf('![')
    const plain = src.indexOf('[')
    if (bang < 0) return plain
    if (plain < 0) return bang
    return Math.min(bang, plain)
  },
  tokenizer(src: string) {
    const isImage = src[0] === '!'
    const lb = isImage ? 1 : 0
    if (src[lb] !== '[') return undefined
    const close = matchBracket(src, lb)
    if (close < 0 || src[close + 1] !== '(') return undefined
    const dest = matchDestination(src, close + 1)
    if (!dest) return undefined
    // 内置解析器能处理的，一个字都不碰。
    // `#` 开头的是文内锚点，不是文件，别抢过来。
    const needsHelp =
      /\s/.test(dest.href) ||
      (!isAbsolute(dest.href) && !dest.href.startsWith('#') && /[#?]/.test(dest.href))
    if (!needsHelp) return undefined
    const token: SpacedDestToken = {
      type: 'spacedDest',
      raw: src.slice(0, dest.end),
      isImage,
      alt: src.slice(lb + 1, close),
      href: dest.href,
      title: dest.title,
    }
    return token
  },
  renderer(token: SpacedDestToken) {
    let href = token.href
    // encodeURI 不碰 `#` 和 `?`，它们会被浏览器当成片段和查询串切掉，
    // 于是 `拍摄#1.jpg` 只能找到 `拍摄`。本地路径里就是文件名的一部分，先编码掉。
    if (!isAbsolute(href)) href = href.replace(/#/g, '%23').replace(/\?/g, '%3F')
    // 和 marked 的 cleanUrl 保持一致：encodeURI 之后把 %25 还原，
    // 免得已经编码过的地址被二次编码。中文仍然原样保留，地址可读。
    href = encodeURI(href).replace(/%25/g, '%')
    const title = token.title ? ` title="${escapeAttr(token.title.slice(1, -1))}"` : ''
    if (token.isImage) {
      return `<img src="${escapeAttr(href)}" alt="${escapeAttr(token.alt)}"${title}>`
    }
    return `<a href="${escapeAttr(href)}"${title}>${escapeAttr(token.alt)}</a>`
  },
}

/** 懒加载 marked，并只安装一次自定义渲染器和扩展 */
export async function getMarked() {
  if (markedMod) return markedMod
  markedMod = await import('marked')
  markedMod.marked.setOptions({ gfm: true, breaks: true })
  // 围栏后面那串信息（```js title="x" line-numbers {2-4}）默认渲染器会丢掉，
  // 只留下 language-js。这里把它原样带到 <pre data-info> 上，
  // 后面的增强步骤才知道该不该画标题、行号和高亮行。
  markedMod.marked.use({
    renderer: {
      code({ text, lang, escaped }) {
        const info = (lang ?? '').trim()
        const first = info.split(/\s+/)[0] ?? ''
        const cls = first ? ` class="language-${escapeAttr(first)}"` : ''
        const attrs = info ? ` data-info="${escapeAttr(info)}"` : ''
        const body = escaped ? text : escapeCode(text)
        return `<pre class="pv-code-pre"${attrs}><code${cls}>${body}</code></pre>\n`
      },
    },
  })
  markedMod.marked.use({ extensions: [SPACED_DEST] })
  return markedMod
}

/**
 * 给代码块补高亮与外壳所需的元信息。
 *
 * marked 只输出 `<pre><code class="language-js">原文</code></pre>`，
 * 没有 token 信息；这里把它换成带 class 的 span，颜色和编辑区同源。
 * 语言没写、或写了不认识的语言，就按纯文本处理——不猜、不报错。
 */
export async function highlightFences(source: string): Promise<string> {
  const blocks = [...source.matchAll(/<pre([^>]*)><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g)]
  if (blocks.length === 0) return source

  const rendered = await Promise.all(
    blocks.map(async (m) => {
      const info = parseFenceInfo(
        (/\sdata-info="([^"]*)"/.exec(m[1])?.[1] ?? '')
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&'),
      )
      const lang = langFromClass(m[2]) || info.lang
      // mermaid 不是代码：一旦按行包成 <span class="pv-line">，
      // 后面取图表源码时拿到的就是带标签的 HTML，画出来一片空白。
      // 原样放过去，交给 transformMermaid 处理。
      if (lang.toLowerCase() === 'mermaid') return m[0]
      // marked 会在代码块末尾留一个换行。留着的话行容器会多出一个空行，
      // 底部凭空多一道空白，行数也对不上源码。
      const code = decodeCode(m[3]).replace(/\n$/, '')
      const inner = await highlightCode(code, lang, {
        start: info.start,
        highlights: info.highlights,
      })
      const cls = lang ? ` class="language-${lang}"` : ''
      return `<pre${m[1]}><code${cls}>${inner}</code></pre>`
    }),
  )

  let i = 0
  return source.replace(
    /<pre([^>]*)><code([^>]*)>[\s\S]*?<\/code><\/pre>/g,
    () => rendered[i++],
  )
}

/** 完整管线：给预览区用（不处理媒体路径，那一步要问主进程） */
export async function markdownToHtml(
  md: string,
): Promise<{ html: string; headings: HeadingItem[] }> {
  const { marked } = await getMarked()
  const raw = marked.parse(stripFrontMatter(md), { async: false }) as string
  const lit = await highlightFences(raw)
  return enhancePreview(lit)
}
