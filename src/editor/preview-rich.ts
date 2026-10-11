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
    /<pre><code[^>]*class="[^"]*language-mermaid[^"]*"[^>]*>([\s\S]*?)<\/code><\/pre>/g,
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

/**
 * 分栏标签：`:::: tabs` 整段交给 marked 会变成一堆冒号段落，这里整体改写。
 *
 * ⚠️ marked 会把**连续的若干行合并成一个 `<p>`，行间用 `<br>` 连接**，
 * 所以真实输出长这样（不是每行一个 `<p>`）：
 *   <p>:::: tabs<br>::: tab-item 标签一</p>
 *   <p>第一个标签的内容</p>
 *   <p>:::<br>::: tab-item 标签二</p>
 *   <p>第二个标签的内容</p>
 *   <p>:::<br>::::</p>
 * 因此这里不能按「整行等于 `<p>:::: tabs</p>`」匹配，会一条都命中不了。
 * 做法：先定位起始段，再逐段向后吃到含 `::::` 的结束段，
 * 只在这几段内部把 `<br>` 还原成换行、拆成结构行来解析。
 */
const TABS_OPEN_AT = /<p>\s*:{4,}\s*tabs\b/i
const PARA_RE = /<p>[\s\S]*?<\/p>/g

function transformTabs(src: string): string {
  let out = ''
  let rest = src

  for (;;) {
    const openAt = TABS_OPEN_AT.exec(rest)
    if (!openAt) break

    /* 从起始段开始，逐段向后吃，直到某段末尾出现 `::::` 为止 */
    const segs: string[] = []
    let consumed = openAt.index
    let closed = false
    PARA_RE.lastIndex = openAt.index
    let pm: RegExpExecArray | null
    while ((pm = PARA_RE.exec(rest))) {
      segs.push(pm[0])
      consumed = PARA_RE.lastIndex
      // 结束段特征：`::::` 紧跟在段尾 `</p>` 前（如 `<p>:::<br>::::</p>`）
      if (segs.length > 1 && /:{4,}\s*(?:<br\s*\/?>)?\s*<\/p>\s*$/.test(pm[0])) {
        closed = true
        break
      }
    }

    /* 没闭合就当普通文本放过，避免吃掉后面整篇文章 */
    if (!closed) {
      const cut = openAt.index + openAt[0].length
      out += rest.slice(0, cut)
      rest = rest.slice(cut)
      continue
    }

    out += rest.slice(0, openAt.index)
    out += buildTabsHtml(segs)
    rest = rest.slice(consumed)
  }

  return out + rest
}

/** 把若干 `<p>` 段拼成 tabs 结构；失败时返回原始拼接，退化成普通段落 */
function buildTabsHtml(segs: string[]): string {
  const tabs: { label: string; body: string[] }[] = []
  let cur: { label: string; body: string[] } | null = null

  for (const seg of segs) {
    // 段内 `<br>` 才是真正的行分隔，还原成换行后逐行判结构
    for (const raw of seg.split(/<br\s*\/?>/g)) {
      const bare = stripPara(raw)
      if (/^\s*:{4,}\s*tabs\b/i.test(bare)) continue // 起始行
      if (/^\s*:{4,}\s*$/.test(bare)) continue // 结束行
      if (/^\s*:{3}\s*$/.test(bare)) continue // tab 之间的分隔 `:::`
      const item = /^\s*:{3}\s*tab-item\s*(.*)$/i.exec(bare)
      if (item) {
        cur = { label: item[1].trim() || `标签 ${tabs.length + 1}`, body: [] }
        tabs.push(cur)
        continue
      }
      if (cur) cur.body.push(raw.trim())
    }
  }

  if (tabs.length === 0) return segs.join('\n')

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

/**
 * 剥掉一行首尾残留的段落标签。
 *
 * 段被 `<br>` 拆开后，首行会带前导 `<p>`、末行会带尾随 `</p>`，
 * 直接拿去匹配结构行会失败，所以先剥干净。
 */
function stripPara(line: string): string {
  return line
    .trim()
    .replace(/^<\/p>/, '')
    .replace(/^<p[^>]*>/, '')
    .replace(/<\/p>$/, '')
    .trim()
}

/** 折叠详情：补上样式类，并让 summary 可点（原生 details 已支持） */
function transformDetails(src: string): string {
  return src.replace(/<details\b/gi, '<details class="pv-details"')
}

/** 给表格加一层容器，方便统一控制样式与横向滚动 */
function transformTables(src: string): string {
  return src.replace(/<table>/g, '<div class="pv-table-wrap"><table class="pv-table">').replace(/<\/table>/g, '</table></div>')
}

/** 按顺序跑完所有预览增强 */
export function enhancePreview(html: string): string {
  let out = html
  out = transformCallouts(out)
  out = transformTabs(out)
  out = transformDetails(out)
  out = transformMermaid(out)
  out = transformTables(out)
  return out
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

/* ── 小工具 ── */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}
