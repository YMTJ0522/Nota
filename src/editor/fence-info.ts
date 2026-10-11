/**
 * 代码围栏的附加信息解析。
 *
 * Markdown 围栏后面那一串（```js title="示例" line-numbers {2,4-6}）
 * 是各家笔记软件约定俗成的扩展写法，CommonMark 本身不解释它，
 * 所以只有实现了解析，工具栏插出来的「增强代码块」才不是一句空话。
 *
 * 支持的写法（与参考项目的约定保持一致）：
 *   ```js                       → 语言
 *   ```js title="服务端入口"      → 标题栏左侧文字
 *   ```js [服务端入口]            → 同上，省掉引号的写法
 *   ```js line-numbers           → 显示行号（别名 linenos / numberLines）
 *   ```js start=10               → 行号从 10 起（别名 startFrom）
 *   ```js hl_lines="2,5-7"       → 指定行加底纹（别名 highlight）
 *   ```js {2,5-7}                → 只写行号的花括号写法
 *   ```{.js line-numbers}        → 花括号里带点的写法
 *
 * 解析失败的兜底是「当成纯语言名」——最坏情况就是没有标题、没有行号，
 * 绝不会因为一行围栏写得怪就把整块代码丢掉。
 */

export interface FenceInfo {
  /** 语言，已小写；没有就是空串 */
  lang: string
  /** 标题栏左侧文字；没有就是空串 */
  title: string
  /** 是否显示行号 */
  lineNumbers: boolean
  /** 行号起始值 */
  start: number
  /** 需要加底纹的行号（相对文件，从 start 起算） */
  highlights: number[]
}

/** 花括号里这几个词是「开关」而不是语言名 */
const RESERVED = new Set(['numberlines', 'line-numbers', 'linenos'])

function clamp(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** `1,3-5` / `1 3-5` → [1,3,4,5]。段数上限 200，避免恶意长串把页面拖死 */
function parseLineSpec(spec: string): number[] {
  const out = new Set<number>()
  for (const part of spec.split(/[,\s]+/).filter(Boolean).slice(0, 200)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part)
    if (range) {
      const from = clamp(Number(range[1]), 1, 100000)
      const to = clamp(Number(range[2]), from, Math.min(100000, from + 2000))
      for (let i = from; i <= to; i += 1) out.add(i)
    } else if (/^\d+$/.test(part)) {
      out.add(clamp(Number(part), 1, 100000))
    }
  }
  return [...out].sort((a, b) => a - b)
}

/** 从一段文本里取 `key=值`，值可以有引号也可以没有 */
function attr(source: string, ...names: string[]): string | null {
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  const re = /(?:^|\s)([A-Za-z][\w-]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g
  for (const m of source.matchAll(re)) {
    if (wanted.has((m[1] ?? '').toLowerCase())) return m[2] ?? m[3] ?? m[4] ?? ''
  }
  return null
}

export function parseFenceInfo(info: string): FenceInfo {
  let rest = (info ?? '').trim()
  let lang = ''
  let title = ''
  let lineNumbers = false
  let start = 1
  const highlights = new Set<number>()

  // ① 花括号开头：```{.js line-numbers title="x"} ——
  //    只有当括号里不是纯行号时才按「选项」解释，否则留给第 ⑤ 步。
  const brace = /^\{([^{}]+)\}/.exec(rest)
  if (brace && !/^\d[\d,\s-]*$/.test(brace[1].trim())) {
    const body = brace[1]
    const dotClasses = [...body.matchAll(/(?:^|\s)\.([A-Za-z][\w-]{0,63})/g)].map((m) => m[1])
    lang = (dotClasses.find((c) => !RESERVED.has(c.toLowerCase())) ?? '').toLowerCase()
    lineNumbers = dotClasses.some((c) => RESERVED.has(c.toLowerCase()))
    title = attr(body, 'title') ?? ''
    const s = attr(body, 'start', 'startfrom')
    if (s && /^\d+$/.test(s)) start = clamp(Number(s), 1, 100000)
    const hl = attr(body, 'hl_lines', 'highlight')
    if (hl) parseLineSpec(hl).forEach((n) => highlights.add(n))
    rest = rest.slice(brace[0].length).trim()
  }

  // ② 语言：第一个词
  if (!lang) {
    const m = /^([^\s{]+)/.exec(rest)
    if (m) {
      lang = m[1].toLowerCase()
      rest = rest.slice(m[0].length).trim()
    }
  }

  // ③ 标题：title="x" 或 [x]
  title = attr(rest, 'title') ?? title
  if (!title) {
    const bracket = /(?:^|\s)\[([^\]\n]+)\]/.exec(rest)
    if (bracket) title = bracket[1].trim()
  }

  // ④ 行号开关与起始值
  if (/(?:^|\s)(?:line-numbers|linenos|numberLines)(?=\s|$)/.test(rest)) lineNumbers = true
  const startAttr = attr(rest, 'start', 'startfrom')
  if (startAttr && /^\d+$/.test(startAttr)) start = clamp(Number(startAttr), 1, 100000)

  // ⑤ 高亮行：hl_lines="1,3-5" 或 {1,3-5}
  const named = attr(rest, 'hl_lines', 'highlight')
  if (named) parseLineSpec(named).forEach((n) => highlights.add(n))
  const bare = /(?:^|\s)\{(\d[\d,\s-]*)\}/.exec(rest)
  if (bare) parseLineSpec(bare[1]).forEach((n) => highlights.add(n))

  return { lang, title, lineNumbers, start, highlights: [...highlights].sort((a, b) => a - b) }
}

/** 语言名 → 标题栏上显示的大写标签（没语言时用 TEXT，和参考项目一致） */
export function langLabel(lang: string) {
  return (lang || 'text').toUpperCase()
}
