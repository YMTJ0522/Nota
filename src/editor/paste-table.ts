/**
 * 从剪贴板粘一张表格进来。
 *
 * 以前从网页或 Excel 里复制一张表，粘进来是一坨用 tab 隔开的纯文本 ——
 * 在 Markdown 里那不是表格，预览出来每一行都挤成一段，还得手工补 `|`
 * 和那行 `---`。所以大多数人的做法是截图贴进来，图里的字搜不到、也改不了。
 *
 * 两条来源，顺序有讲究：
 *  1. `text/html`：从网页和 Excel 复制时都在，`<table>` 是结构化的，
 *     能拿到真正的表头、合并前的单元格边界；
 *  2. `text/plain` 里 tab 分隔的多行文本：某些时候 html 那份没有
 *     （终端里复制、只给了纯文本的应用），行列对齐的话照样能认出来。
 *
 * **只在「整个剪贴板就是一张表」时才接管**，这条边界比转换本身更重要：
 * 从网页上复制一整篇文章、里面夹着一张表，这里要是把表抽出来粘上，
 * 用户就丢了一大段正文 —— 那比粘成纯文本糟得多。所以下面每一处判断都是
 * 「不像一张单独的表 → 返回 null，让浏览器默认粘贴去干」。
 */

/** 单元格里出现这些就没法在 Markdown 表格里表达，宁可不转 */
const MERGED = '[colspan], [rowspan]'

/** 一张表至少这么多行 / 列，否则它就是一段文字而不是表 */
const MIN_ROWS = 2
const MIN_COLS = 2

function esc(s: string): string {
  // 管道符会把单元格切断；反斜杠留在最后处理，别把刚加的转义又转一遍
  return s.replace(/\|/g, '\\|')
}

/**
 * 单元格的文字。
 *
 * `<br>` 保留成 Markdown 的 `<br>`（表格里唯一还能换行的写法）；
 * 其余空白全部折成一个空格 —— HTML 里的缩进和换行是排版用的，
 * 原样搬进表格会把一格撑成三行。
 */
function cellText(el: Element): string {
  const c = el.cloneNode(true) as HTMLElement
  for (const br of Array.from(c.querySelectorAll('br'))) br.replaceWith('\u0000')
  // 嵌套的表、图片说明这类结构里也有字，textContent 会一并带出来，够用了
  const raw = (c.textContent ?? '').replace(/\u0000/g, '<br>')
  return esc(raw.replace(/[\t\n\r]+/g, ' ').replace(/\s{2,}/g, ' ').trim())
}

function isTableRow(el: Element): boolean {
  return el.tagName === 'TD' || el.tagName === 'TH'
}

/** html → Markdown 表格；不像一张单独的表就 null */
export function tableFromHtml(html: string): string | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return null
  }
  const tables = Array.from(doc.querySelectorAll('table'))
  // 一张以上：可能是整页复制的排版表格，猜哪个是"那张表"不如不猜
  if (tables.length !== 1) return null
  const table = tables[0]
  if (table.querySelector(MERGED)) return null

  /* 除了这张表之外还有没有别的正文？
     Excel / 网页里只选表格时，html 里通常只有一层空壳（<html><body><table>，
     至多带一句 "table { … }" 的样式）；复制整篇文章则满地都是 <p>、<h1>。 */
  const rest = doc.body.cloneNode(true) as HTMLElement
  rest.querySelector('table')?.remove()
  for (const junk of Array.from(rest.querySelectorAll('style, script'))) junk.remove()
  if ((rest.textContent ?? '').replace(/[\s\u00a0]+/g, '')) return null

  const rows: string[][] = []
  let headerIsReal = false
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const cells = Array.from(tr.children).filter(isTableRow)
    if (!cells.length) continue
    if (!rows.length) headerIsReal = cells.every((c) => c.tagName === 'TH')
    rows.push(cells.map(cellText))
  }
  if (rows.length < MIN_ROWS) return null

  const cols = Math.max(...rows.map((r) => r.length))
  if (cols < MIN_COLS) return null

  /* GFM 必须有表头那一行。原表没有表头时**造一行空的**，而不是
     把第一行数据顶上去冒充表头 —— 那等于把一条真实记录改成了列名。 */
  const head = headerIsReal ? rows.shift()! : new Array(cols).fill('')
  const pad = (r: string[]) => [...r, ...new Array(Math.max(0, cols - r.length)).fill('')]

  const out: string[] = []
  out.push(`| ${pad(head).join(' | ')} |`)
  out.push(`| ${new Array(cols).fill('---').join(' | ')} |`)
  for (const r of rows) out.push(`| ${pad(r).join(' | ')} |`)
  return out.join('\n')
}

/** tab 分隔的纯文本 → Markdown 表格；行列不齐就 null */
export function tableFromTsv(text: string): string | null {
  const clean = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  if (!clean.includes('\t')) return null
  const rows = clean.split('\n').map((l) => l.split('\t'))
  if (rows.length < MIN_ROWS) return null
  const cols = rows[0].length
  if (cols < MIN_COLS) return null
  // 列数不齐 → 这不是表，是一段带制表符的散文或代码
  if (!rows.every((r) => r.length === cols)) return null
  // 整张表一个非空字都没有（比如只复制了几行空白）就别动
  if (!rows.some((r) => r.some((c) => c.trim()))) return null

  const out: string[] = []
  out.push(`| ${rows[0].map((c) => esc(c.trim())).join(' | ')} |`)
  out.push(`| ${new Array(cols).fill('---').join(' | ')} |`)
  for (const r of rows.slice(1)) out.push(`| ${r.map((c) => esc(c.trim())).join(' | ')} |`)
  return out.join('\n')
}

/** 先试 html（有就最准），再退回 tab 文本 */
export function tableFromClipboard(dt: DataTransfer): string | null {
  const html = dt.getData('text/html')
  if (html) {
    const md = tableFromHtml(html)
    if (md) return md
  }
  return tableFromTsv(dt.getData('text/plain'))
}
