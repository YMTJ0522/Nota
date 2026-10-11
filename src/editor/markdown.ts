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

/** 懒加载 marked，并只安装一次自定义渲染器 */
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
