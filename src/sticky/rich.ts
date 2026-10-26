/**
 * 便签正文的「看得见的字」—— 只上色，不改字。
 *
 * 便签的输入框是一个普通 textarea：纯文本、粘贴不炸、中文输入法零干扰。
 * 但纯文本有个代价 —— 写 `#mysql` 和写「mysql」看起来一样，写 `- [ ] 修一下`
 * 也看不出这是件待办。要在这上面加一点「认得出你在写什么」的能力，又不能
 * 换成 contenteditable（那是输入法、粘贴、撤销栈的连环坑）。
 *
 * 做法是叠一层镜像：textarea 的字设成全透明（光标还在），下面一层用同一套
 * 字体行高把同样的文字画成彩色。**这一层里一个字符都不能改、不能加粗、不能
 * 加 padding** —— 任何宽度变化都会让两层的换行位置错开，用户看到的就是
 * 一列错位的鬼影。所以这里只输出 `<span>`，样式也只有颜色和背景。
 *
 * 复选框那一段是个例外：`[ ]` 三个字留着占位（宽度不变）但染成透明，
 * 用伪元素在它上面画一个方块。点一下把 `[ ]` 改成 `[x]`，文本框里的真是
 * 这份文本 —— 不是什么「富文本里的一个 task 节点」。
 */

/** HTML 转义。只在最前面做一次，之后的替换都往实体串里塞标签 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 行首的待办框：`- [ ]` / `* [x]` / `1. [ ]`。
 *
 * 只认行首（前面允许缩进）：正文中间随便一个 `[ ]` 不该变成能点的东西，
 * 那会把「写一个数组下标」变成「手滑打了个勾」。
 */
export const BOX_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/

/**
 * 正文里的 `#标签`。
 *
 * 前一个字符必须不是词字符 —— 不然 `a#b` 这种（颜色值、锚点）也会亮起来。
 * 首字符限定字母/下划线/中文，**不允许数字**：`见 #3`、`第 #2 条` 是引用编号，
 * 不是标签，一条便签里挂上十个数字标签比不挂还乱。
 */
const TAG_RE = /(^|[\s(（[【,，;；:：、。!！?？"'“”‘’])#([\p{L}_][\p{L}\p{N}_\-./]{1,23})/gu

/** 给一行上色。输入是原文，输出是可直接塞进 innerHTML 的串 */
function lineHtml(raw: string, li: number): string {
  let s = esc(raw)

  s = s.replace(BOX_RE, (_m, pre: string, mark: string) => {
    // 字符原样留着（含那个空格或 x），只是整段被染成透明的。
    // data-l 是行号：点一下要能定位回是哪一行的那一个框。
    //
    // 前面那个 `- ` 压淡一档（只改透明度，不改宽度）：它是 Markdown 的列表记号，
    // 在这一层里是给「存为笔记」留的，不该和方框一起抢眼睛。
    return `<span class="li">${pre}</span><span class="cb${mark === ' ' ? '' : ' on'}" data-l="${li}">[${mark}]</span>`
  })

  s = s.replace(
    TAG_RE,
    (_m, pre: string, name: string) => `${pre}<span class="tg">#${name}</span>`,
  )

  return s
}

/**
 * 整篇正文 → 镜像层的 HTML。
 *
 * 末尾补一个零宽空格：文本以换行结尾时，`pre-wrap` 下最后一个空行不会
 * 产生高度，textarea 里却有这一行 —— 补一个不可见的字符，两边才对得上。
 */
export function mirrorHtml(text: string): string {
  return `${text
    .split(/\r?\n/)
    .map((line, i) => lineHtml(line, i))
    .join('\n')}\u200b`
}

/**
 * 点中某个待办框之后，算出新的整篇正文。
 *
 * 返回 null 表示那一行已经不是待办行了（用户刚把它改掉），调用方什么都不做。
 */
export function toggleBox(text: string, lineIndex: number): string | null {
  const lines = text.split(/\r?\n/)
  const line = lines[lineIndex]
  if (line == null) return null
  const m = BOX_RE.exec(line)
  if (!m) return null
  const at = m[1].length
  const done = m[2] !== ' '
  lines[lineIndex] = `${line.slice(0, at)}${done ? '[ ]' : '[x]'}${line.slice(at + 3)}`
  return lines.join('\n')
}

/**
 * 正文里出现了哪些标签。给「打标签」这件事省掉一次弹窗：
 * 写着 `#docker` 就已经把它挂上了。
 */
export function tagsInText(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    // 每行单独跑：TAG_RE 的 `^` 在整串上只认开头
    for (const m of line.matchAll(new RegExp(TAG_RE.source, 'gu'))) {
      const name = m[2]
      if (seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}
