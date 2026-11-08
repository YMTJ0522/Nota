/**
 * 按行处理 Markdown 时反复要用的几个小判定。
 *
 * 原先它们散在 `preview-rich.ts` 里。后来「大纲 / 导图」也要按行扫一遍正文，
 * 而围栏代码块的判定是最容易写错、也最不该有两份的地方 ——
 * 一旦两处对围栏的认法不同，就会出现「预览里是代码、大纲里冒出个 H1 标题」
 * 这种没法解释的现象。所以抽到这里，谁要用谁引，只有一套规矩。
 *
 * 都是纯函数，不认识编辑器、不认识 DOM，放哪儿都能跑。
 */

/**
 * 行首的围栏记号。
 *
 * 允许引用前缀（`> ```bash`）与最多 3 个空格的缩进——4 个空格起是缩进式
 * 代码块，不构成围栏（CommonMark 的规矩，顺手也避开列表续行的误判）。
 * 返回开栏用的字符与长度，关栏要靠它们配对。
 */
export function fenceMarkOf(line: string): { char: string; len: number } | null {
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
export function fenceCloseOf(line: string): { char: string; len: number } | null {
  const m = /^(?:[ \t]*>[ \t]?)*([ \t]*)(`{3,}|~{3,})[ \t]*\r?$/.exec(line)
  if (!m) return null
  if (m[1].replace(/\t/g, '    ').length > 3) return null
  return { char: m[2][0], len: m[2].length }
}

/**
 * 一趟扫完所有行时用的「围栏状态机」。
 *
 * 调用方每行喂一次，返回这行是不是在围栏里（含开栏与关栏这两行本身）。
 * 把顺序记在闭包里，比每个调用方各自维护 `open` 变量干净 ——
 * 之前主大纲那一份和自己又写的一份，就因为一处忘了处理 `~` 开栏而分岔过。
 */
export function createFenceTracker(): (line: string) => boolean {
  let open: { char: string; len: number } | null = null
  return (line: string) => {
    if (open) {
      const close = fenceCloseOf(line)
      if (close && close.char === open.char && close.len >= open.len) open = null
      return true
    }
    const mark = fenceMarkOf(line)
    if (mark) {
      open = mark
      return true
    }
    return false
  }
}

/**
 * 抹掉行内的 Markdown 记号，只留看得见的字。
 *
 * 给大纲和导图用：那里显示的是「这一节叫什么」，不该出现 `**` 和 `](url)`。
 * 注意它会吃掉行尾的 `###`（ATX 标题的收尾井号），也会把 `#标签` 里的
 * 井号留着 —— 井号只在前方是空白或标点时才被当标签，这里不处理标签。
 */
export function plainInline(s: string): string {
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
 * 取出行内的第一个 `#标签`。
 *
 * 用的是 `preview-rich.ts` 里渲染 chip 的同一条规则的前缀部分：
 * 前面必须是行首或空白/标点，标签名首字不能是标点。
 * 这里只要第一个 —— 大纲与导图的节点一行只放得下一枚 chip。
 */
export function firstHashtag(s: string): string | null {
  const m = /(?:^|[\s(（【「，。：；！？、])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/u.exec(s)
  return m ? m[1] : null
}

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
 *
 * 现在三处共用这一份：预览锚点、源码大纲、结构树。`seen` 由调用方持有，
 * 同一篇文档里传同一个 Map，才能保证重名标题各自拿到不同的 id。
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
