/**
 * 导出的附加样式 —— 现在只有公式（KaTeX）。
 *
 * 导出必须是**能独立打开**的一份文件：拷给别人、传到别的机器上，排版都得在。
 * 所以公式的样式表要整份内联，字体也要一起塞进去（base64）。
 *
 * 为什么不干脆引用 dist/assets 里那几份字体：导出的 HTML 是个单文件，
 * 它不知道自己在谁的磁盘上，相对路径一换就全丢。不内联的话，
 * 公式里的 ∑ ∫ √ 这些会掉回系统字体 —— 有的能显示、有的显示成一个框，
 * 这正是「导出有 bug」最典型的样子。
 *
 * 20 个 woff2 一共 254KB，base64 之后约 340KB。只有**这篇笔记里真有公式**
 * 的时候才会带上（见 store 里的 hasMath 判断），纯文字笔记的导出不受影响。
 *
 * 这些字体以 `?inline` 走 Vite 打包，整块是懒加载 chunk：不用公式的人
 * 在应用里也不会加载到它。
 */
import katexCss from 'katex/dist/katex.min.css?raw'

/** 字体文件名（去掉扩展名）→ base64 data URI */
const FONT_URLS = import.meta.glob('/node_modules/katex/dist/fonts/*.woff2', {
  query: '?inline',
  eager: true,
  import: 'default',
}) as Record<string, string>

const BY_NAME = new Map<string, string>()
for (const [p, url] of Object.entries(FONT_URLS)) {
  BY_NAME.set(p.split('/').pop() ?? '', url)
}

let cached: string | null = null

/** 一份可以直接塞进 <style> 的公式样式：CSS 内联 + 字体 base64 */
export function katexExportCss(): string {
  if (cached) return cached

  let out = katexCss
  // 原 CSS 每个字体给了 woff2 / woff / ttf 三档。只留 woff2：
  // 另外两档的 url 在单文件里无处可指，留着只会让浏览器白跑两次 404。
  out = out.replace(
    /,url\(fonts\/[^)]+\.woff\)\s*format\("woff"\),url\(fonts\/[^)]+\.ttf\)\s*format\("truetype"\)/g,
    '',
  )
  out = out.replace(/url\(fonts\/([^)\s]+?\.woff2)\)/g, (whole, file: string) => {
    const data = BY_NAME.get(file)
    return data ? `url(${data})` : whole
  })

  // KaTeX 的 .katex 用了 em 相对字号。导出页面的正文字号跟应用里不一样，
  // 1.21em 会算出一个偏大的公式，这里压到跟应用预览一致的观感
  out += `
.md-body .katex, .katex { font-size: 1.06em; }
.katex-display { margin: 1.1em 0; }
.katex-display > .katex { white-space: normal; }
`

  cached = out
  return out
}
