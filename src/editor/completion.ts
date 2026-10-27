import {
  autocompletion,
  completionKeymap,
  snippetCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { LanguageDescription, syntaxTree } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { fencedCodeLanguages } from './code-languages'
import { store } from '@/store'

/**
 * 代码块补全。
 *
 * 为什么是自己写一份而不是挂现成的：CodeMirror 各语言包**默认不带补全源**
 * （只有 html/css/sql 那几个有），在这个应用里等于“一个走 `codeLanguages`
 * 动态加载进来的围栏语言，永远给不出候选”。所以这份的定位很明确 ——
 * 不假装懂语法，只做一件在笔记里真正省事的事：
 *
 *  **只在围栏代码块内**：把这篇笔记里已经出现过的词接上，再补上该语言的常用骨架。
 *  写命令笔记时最烦的是「前面写过 `systemctl restart`，这里又想打一遍」；
 *  文档词补全解决的正是这个，而且不需要任何语言服务。
 *
 * 正文（围栏以外）平时**一个候选都不给**，自动弹和手动唤都没有。
 * 那半套本来是给「中文里想引一下前文术语」准备的，实测没人用得上，
 * 反而在中文输入法组字时不断冒出英文词 —— 删掉比留着更清净。
 *
 * **唯一的例外是 `[[`**（双链）：它不是「顺手打出来的一个词」，而是一个
 * 明确的语法意图——人已经说了「我要引用一篇笔记」。这时候给列表不是打扰，
 * 不给才怪；而且双链的名字不带目录，同一份工作区里重名很常见，凭记忆手打
 * 常常指向错的那篇（`resolveWikiNote` 遇到重名会直接判「找不着」）。
 * 详见下面 wikiCompletion 的注释。
 *
 * 语言骨架刻意只写「语法本身就有的东西」（`if __name__ == "__main__":`、
 * `for f in *; do` 这种），不编具体 API —— 编出来的 API 是假的，
 * 补全一旦给出错误答案，人就不信它了。
 */

/* ── 光标在不在围栏代码块里 ── */

const FENCE_OPEN = /^(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})([^\s`]*)/

/** 围栏上写的 token → 规范语言名（```` ```Bash ```` 也是 Shell） */
function canonicalLangName(token: string): string {
  if (!token) return ''
  return LanguageDescription.matchLanguageName(fencedCodeLanguages, token, true)?.name ?? token
}


/**
 * 围栏行的记号（用于配对）。和 preview-rich.ts 里那份同源：
 * 允许引用前缀与最多 3 空格缩进，四空格起是缩进式代码块。
 */
function fenceMarkOf(text: string): { char: string; len: number } | null {
  const m = /^(?:[ \t]*>[ \t]?)*([ \t]*)(`{3,}|~{3,})/.exec(text)
  if (!m) return null
  if (m[1].replace(/\t/g, '    ').length > 3) return null
  return { char: m[2][0], len: m[2].length }
}

/**
 * 光标所在围栏的上下文；不在围栏里返回 null。
 *
 * 先问语法树（快、且只在真正解析过的地方下结论）；语法树里没有围栏时再自己
 * 逐行扫一遍 —— 围栏**还没写关栏**的那一小段时间里，语法树里可能还没有
 * FencedCode 节点，而人恰恰是在「刚敲完 ```bash、正要开始写」的时候最需要补全。
 * 两种走法都要把开栏那一行的语言名一起带出来。
 */
function fenceContextAt(state: EditorState, pos: number): { lang: string } | null {
  const tree = syntaxTree(state)
  // 类型取自 tree.topNode 而不是从 @lezer/common 另引一个 SyntaxNode：
  // 那是 @codemirror/language 的传递依赖，直接 import 会让依赖关系变得含糊
  let node: typeof tree.topNode | null = tree.resolveInner(pos, -1)
  while (node) {
    if (node.name === 'FencedCode') {
      const line = state.doc.lineAt(node.from)
      // 光标就在围栏那一行上（正在写语言名）→ 不补全
      if (pos <= line.to) return null
      return { lang: canonicalLangName(FENCE_OPEN.exec(line.text)?.[2] ?? '') }
    }
    node = node.parent
  }

  const cur = state.doc.lineAt(pos)
  let open: { char: string; len: number; lang: string } | null = null
  for (let n = 1; n < cur.number; n += 1) {
    const text = state.doc.line(n).text
    const mark = fenceMarkOf(text)
    if (open) {
      if (mark && mark.char === open.char && mark.len >= open.len) open = null
      continue
    }
    if (mark) open = { char: mark.char, len: mark.len, lang: FENCE_OPEN.exec(text)?.[2] ?? '' }
  }
  if (!open || fenceMarkOf(cur.text)) return null
  return { lang: canonicalLangName(open.lang) }
}

/* ── 语言骨架 ── */

interface Snip {
  label: string
  template: string
  detail: string
}

/** 每一条都是语法层面的骨架，没有具体 API —— 见文件头那段说明 */
const SNIPPETS: Record<string, Snip[]> = {
  Shell: [
    { label: '#!/bin/bash', template: '#!/bin/bash\n\nset -euo pipefail\n', detail: '脚本头' },
    { label: 'if [ -f ... ]', template: 'if [ -f "${1}" ]; then\n  ${}\nfi', detail: '条件判断' },
    { label: 'for ... do', template: 'for ${f} in "${@}"; do\n  ${}\ndone', detail: '遍历' },
    { label: 'while read', template: 'while read -r ${line}; do\n  ${}\ndone < ${file}', detail: '逐行读文件' },
    { label: 'case ... esac', template: 'case "${1}" in\n  ${start})\n    ;;\n  *)\n    ;;\nesac', detail: '分支' },
    { label: '$( ... )', template: '$( ${} )', detail: '命令替换' },
  ],
  Python: [
    { label: 'if __name__ == "__main__":', template: 'if __name__ == "__main__":\n    ${}', detail: '入口' },
    { label: 'def ...', template: 'def ${name}(${args}):\n    ${}', detail: '函数' },
    { label: 'class ...', template: 'class ${Name}:\n    def __init__(self):\n        ${}', detail: '类' },
    { label: 'for ... enumerate', template: 'for ${i}, ${item} in enumerate(${items}):\n    ${}', detail: '带序号遍历' },
    { label: 'with open(...)', template: 'with open(${path}, "r", encoding="utf-8") as f:\n    ${}', detail: '读文件' },
    { label: 'try / except', template: 'try:\n    ${}\nexcept ${Exception} as e:\n    print(e)', detail: '异常' },
  ],
  JavaScript: [
    { label: 'const ... = () => {}', template: 'const ${fn} = (${args}) => {\n  ${}\n}', detail: '箭头函数' },
    { label: 'async function', template: 'async function ${name}(${args}) {\n  ${}\n}', detail: '异步函数' },
    { label: 'try / catch', template: 'try {\n  ${}\n} catch (${e}) {\n  console.error(${e})\n}', detail: '异常' },
    { label: 'import ... from', template: 'import { ${x} } from "${mod}"', detail: '导入' },
    { label: 'export default', template: 'export default ${}', detail: '导出' },
    { label: 'for (const ... of ...)', template: 'for (const ${x} of ${list}) {\n  ${}\n}', detail: '遍历' },
  ],
  CSS: [
    { label: '@media', template: '@media (max-width: ${600px}) {\n  ${}\n}', detail: '媒体查询' },
    { label: 'display: flex', template: 'display: flex;\nalign-items: center;\ngap: ${8px};', detail: '弹性布局' },
    { label: ':root 变量', template: ':root {\n  --${name}: ${value};\n}', detail: '自定义属性' },
  ],
  HTML: [
    { label: '<!DOCTYPE html>', template: '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8" />\n  <title>${}</title>\n</head>\n<body>\n  ${}\n</body>\n</html>', detail: '文档骨架' },
    { label: '<div class="">', template: '<div class="${}">\n  ${}\n</div>', detail: '容器' },
    { label: '<a href="">', template: '<a href="${}">${}</a>', detail: '链接' },
    { label: '<img src="" alt="">', template: '<img src="${}" alt="${}" />', detail: '图片' },
  ],
  XML: [{ label: '<?xml ... ?>', template: '<?xml version="1.0" encoding="UTF-8"?>\n${}', detail: '声明' }],
  SQL: [
    { label: 'SELECT ... FROM', template: 'SELECT ${*}\nFROM ${table}\nWHERE ${cond}\nORDER BY ${col}\nLIMIT ${10};', detail: '查询' },
    { label: 'INSERT INTO', template: 'INSERT INTO ${table} (${a}, ${b})\nVALUES (${1}, ${2});', detail: '插入' },
    { label: 'UPDATE ... SET', template: 'UPDATE ${table}\nSET ${a} = ${1}\nWHERE ${cond};', detail: '更新' },
    { label: 'CREATE TABLE', template: 'CREATE TABLE ${name} (\n  id INTEGER PRIMARY KEY,\n  ${col} TEXT NOT NULL\n);', detail: '建表' },
  ],
}

/**
 * 规范语言名 → SNIPPETS 的键。
 *
 * 只做**确实通用**的归并：JSX / TSX / TypeScript 里那几条 JS 骨架照样成立。
 * 刻意不把 Go / Rust / Java / C++ 也塞到别人的骨架里 —— 给 Go 用户弹一条
 * `async function` 是在撒谎，宁可不给。这些语言就只有文档词可用。
 */
const SNIPPET_ALIAS: Record<string, string> = {
  TypeScript: 'JavaScript',
  JSX: 'JavaScript',
  TSX: 'JavaScript',
}

function snippetsFor(lang: string): Snip[] {
  if (!lang) return []
  const key = SNIPPET_ALIAS[lang] ?? lang
  return SNIPPETS[key] ?? []
}

/* ── 文档词索引 ── */

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}_.-]+/gu
const MAX_WORD_LEN = 40

interface WordIndex {
  doc: EditorState['doc'] | null
  words: { word: string; n: number; lower: string }[]
}

const index: WordIndex = { doc: null, words: [] }

/**
 * 这篇文档里出现过的词，按出现次数排。
 *
 * 按 doc 对象缓存：CodeMirror 的文档是不可变结构，改一下就是新对象，
 * 所以缓存天然每次都失效 —— 但这仍然值得，因为一次补全里
 * 源函数可能被连着问好几次（每敲一个字一次），而同一个 doc 上只扫一遍。
 */
function docWords(state: EditorState) {
  if (index.doc === state.doc) return index.words
  const text = state.doc.toString()
  const count = new Map<string, number>()
  for (const m of text.matchAll(WORD_RE)) {
    const word = m[0]
    if (word.length > MAX_WORD_LEN) continue
    count.set(word, (count.get(word) ?? 0) + 1)
  }
  index.doc = state.doc
  index.words = [...count]
    .map(([word, n]) => ({ word, n, lower: word.toLowerCase() }))
    .sort((a, b) => b.n - a.n || b.word.length - a.word.length)
  return index.words
}

/* ── 输入法（IME）──
   中文、日文、韩文都靠「先敲一串拉丁字母、再上屏成汉字」输入。
   拼音还没上屏的那段时间里，编辑器里已经有了真实的拉丁字符 ——
   补全源分不清「这是拼音」还是「这是人在打英文单词」，于是每敲一个字母
   就弹一层英文候选，正好压在输入法的候选条上：不但挡视线，还会把
   输入法的窗挤走。

   所以组字期间一律不补全。用 DOM 的 compositionstart / compositionend
   直接记账（而不是去猜字符范围）：这两个事件是浏览器自己发的，
   只要输入法开着就一定准。 */
let composing = false

const imeGuard = EditorView.domEventHandlers({
  compositionstart: () => {
    composing = true
    return false
  },
  compositionend: () => {
    composing = false
    return false
  },
})

/* ── 补全源 ── */

/**
 * 光标左边那一串「词」。
 *
 * 只允许**字母 / 数字 / 下划线**打头，中间也不放 `-` 和 `.` —— 早先那版
 * 把两个分隔符也算进词里，结果在 `uname -a` 后面接着打字时取到的 token 是
 * `-asys`（连字符被当成词首），前缀匹配一个都命中不了，补全就「静默失效」。
 * 写命令笔记恰恰满地都是 `-` 和 `.`，这条必须收紧。
 *
 * 刻意不带 `$` 也**不带 g 标志**：CodeMirror 自己会给它补上两端的锚
 * （`matchBefore` 补尾、`validFor` 补头），而带 g 的正则在 `validFor`
 * 那条路上是有状态的 —— `test()` 会推进 lastIndex，同一份正则被连着问两次
 * 结论就不一样了。
 */
const TOKEN_RE = /[\p{L}\p{N}_][\p{L}\p{N}_]*/u


/** 文档词候选：前缀匹配，按「出现得多 + 长得完整」排，最多 30 条 */
function wordOptions(state: EditorState, token: string, limit = 30): Completion[] {
  const needle = token.toLowerCase()
  const out: Completion[] = []
  for (const w of docWords(state)) {
    if (w.word === token) continue
    if (!w.lower.startsWith(needle)) continue
    out.push({ label: w.word, type: 'text', sortText: '2' + String(out.length).padStart(3, '0') })
    if (out.length >= limit) break
  }
  return out
}

/**
 * 语言骨架候选。
 *
 * 已经敲了字的话就只留对得上的那几条 —— 打 `sys` 的时候头顶悬着六条
 * `for ... do` / `case ... esac` 是纯粹的遮挡；骨架是「刚起一行」时要的东西，
 * 那时 token 为空，全部照给。
 */
function snippetOptions(lang: string, token = ''): Completion[] {
  const needle = token.toLowerCase()
  return snippetsFor(lang)
    .filter((s) => !needle || s.label.toLowerCase().includes(needle) || s.template.toLowerCase().includes(needle))
    .map((s) =>
      snippetCompletion(s.template, {
        label: s.label,
        detail: s.detail,
        type: 'keyword',
        // 片段排在文档词前面：它是「结构」，人找的是它
        sortText: '0' + s.label,
      }),
    )
}

/* ── 双链补全（正文） ── */

/**
 * `[[` 之后、光标之前那一段还没闭合的名字。
 *
 * 刻意不含 `]`：光标在 `[[会议记录]]` 的 `]]` 之后时，这段就匹配不上，
 * 也就不会在一条已经写完的链接后面接着弹候选。
 *
 * 也不含 `[`：`[[a[[b` 这种明显是打错了，不去猜它想指哪一段。
 */
const WIKI_TAIL = /\[\[[^\[\]\n]*/

/** 名字里出现这些字符会把 `[[…]]` 撕开 —— 这种文件宁可不给候选，也别补出一句坏语法 */
const BAD_NOTE_NAME = /[\[\]|^\\]/

interface NoteName {
  /** 显示用，也是「名字唯一」时插进正文的内容 */
  name: string
  /** 工作区内的相对路径（posix，不带 .md）。重名时插这个 */
  rel: string
  /** 所在目录，重名时用来分辨「你说的哪个会议记录」 */
  dir: string
}

/**
 * 工作区里所有笔记。不缓存：`[[` 是低频动作（一天几十次，不像普通打字
 * 每键都来），而按 `allFiles` 的引用做缓存又得处理重命名、新建、删除三种
 * 失效，省下来的那点时间还不值这段代码的风险。
 */
function noteNames(): NoteName[] {
  const root = (store.state.root ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const out: NoteName[] = []
  for (const f of store.allFiles.value) {
    if (!/\.md$/i.test(f.name)) continue
    const name = f.name.replace(/\.md$/i, '')
    if (BAD_NOTE_NAME.test(name)) continue
    let rel = f.path.replace(/\\/g, '/')
    if (root && rel.toLowerCase().startsWith(root + '/')) rel = rel.slice(root.length + 1)
    rel = rel.replace(/\.md$/i, '')
    const cut = rel.lastIndexOf('/')
    out.push({ name, rel, dir: cut >= 0 ? rel.slice(0, cut) : '' })
  }
  return out
}

/** 同名了几篇：只在重名时才需要插路径，也只在重名时才需要显示目录 */
function baseCounts(list: NoteName[]): Map<string, number> {
  const n = new Map<string, number>()
  for (const it of list) {
    const k = it.name.toLowerCase()
    n.set(k, (n.get(k) ?? 0) + 1)
  }
  return n
}

function wikiCompletion(ctx: CompletionContext): CompletionResult | null {
  const m = ctx.matchBefore(WIKI_TAIL)
  if (!m) return null

  const typed = m.text.slice(2)
  const needle = typed.toLowerCase()
  const all = noteNames()
  if (!all.length) return null

  /* 三段排序：名字以它开头的 → 名字里包含它的 → 只有路径包含它的。
     打「周报」时最想要的是《周报模板》，不是《2026 年第 3 周报表》。 */
  const hits: { it: NoteName; rank: number }[] = []
  for (const it of all) {
    const low = it.name.toLowerCase()
    let rank = -1
    if (!needle) rank = 0
    else if (low.startsWith(needle)) rank = 0
    else if (low.includes(needle)) rank = 1
    else if (it.rel.toLowerCase().includes(needle)) rank = 2
    if (rank >= 0) hits.push({ it, rank })
  }
  if (!hits.length) return null

  hits.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.it.name.length - b.it.name.length ||
      a.it.rel.localeCompare(b.it.rel, 'zh-Hans-CN'),
  )

  const dup = baseCounts(all)
  const options: Completion[] = hits.slice(0, 40).map(({ it, rank }) => {
    /* 重名的笔记**必须插路径**：resolveWikiNote 对重名不猜（猜错了跳到
       另一篇上，比报错更糟）。而路径形式它能直接命中。 */
    const ambiguous = (dup.get(it.name.toLowerCase()) ?? 1) > 1
    const insert = ambiguous ? it.rel : it.name
    return {
      label: it.name,
      // 重名时把目录亮出来，两条一模一样的名字靠它分辨
      detail: ambiguous ? it.dir || '根目录' : undefined,
      type: 'text',
      sortText: `${rank}${String(hits.length).padStart(3, '0')}`,
      apply: (view, _c, from, to) => {
        /* `]]` 通常已经在（closeBrackets 敲第二个 `[` 时就补上了）。
           在就别再补一对，否则变成 `[[名字]]]]`。 */
        const doc = view.state.doc
        const closed = doc.sliceString(to, Math.min(to + 2, doc.length)) === ']]'
        const text = insert + (closed ? '' : ']]')
        const end = from + text.length
        view.dispatch({
          changes: { from, to, insert: text },
          // 已经闭合的话光标跳过那对括号：链接写完了，下一句在链接外面
          selection: { anchor: closed ? Math.min(end + 2, doc.length) : end },
          userEvent: 'input.complete',
          scrollIntoView: true,
        })
      },
    }
  })

  return { from: m.from + 2, options, validFor: /^[^\[\]\n]*$/ }
}

/* ── 代码块补全 ── */

/** 只有一种情况给代码候选：光标在围栏里。正文的事交给 wikiCompletion */
function codeCompletion(ctx: CompletionContext, lang: string): CompletionResult | null {
  const { state } = ctx

  // 先看字，再决定要不要扫全篇：单字符输入是最高频的按键
  const match = ctx.matchBefore(TOKEN_RE)
  const token = match?.text ?? ''
  if (!ctx.explicit && token.length < 2) return null

  const options = [...snippetOptions(lang, token), ...wordOptions(state, token)]
  if (!options.length) return null
  return { from: match?.from ?? ctx.pos, options, validFor: TOKEN_RE }
}

/**
 * 唯一的补全源。
 *
 * 分岔只有一条：光标在围栏代码块里 → 代码候选；否则 → 只认 `[[`。
 * 围栏里**绝不能**走双链那条路：Shell 的 `[[ -f "$f" ]]` 满地都是，
 * 在那里弹笔记名是把一个正经语法当成引用意图。
 */
function notaCompletion(ctx: CompletionContext): CompletionResult | null {
  // 组字期间直接退出。放在最前面：这时候连围栏都不该去判断。
  if (composing) return null

  const fence = fenceContextAt(ctx.state, ctx.pos)
  return fence ? codeCompletion(ctx, fence.lang) : wikiCompletion(ctx)
}

/**
 * 手动唤出的键位。
 *
 * CodeMirror 默认是 Ctrl-Space，这里**特意把它换掉**：在中文 Windows 上
 * Ctrl-Space 是输入法的中英切换，写中文的人一天要按几十次 —— 编辑器把它抢走
 * 等于让人没法切回中文。
 *
 * 主键位用 Ctrl+Shift+Space：跟系统与常见输入法都不撞，按键形制又和
 * 「默认那个 Ctrl-Space」同一家族，好记。Alt-/ 留着当别名 —— 老用户已经顺手了。
 *
 * 正文不再有候选，所以这个键只在代码块里真正用得上（那里打字也会自动弹，
 * 手动唤是给「刚打完一个词、想把上一段出现过的名字捞回来」用的）。
 */
const MANUAL_KEY = 'Mod-Shift-Space'
const MANUAL_KEY_ALT = 'Alt-/'

export function markdownCompletion(): Extension[] {
  return [
    imeGuard,
    autocompletion({
      override: [notaCompletion],
      // 候选自带 type 小标（keyword / text），不用再画图标
      icons: false,
      // 一屏放得下就行；超出的靠上下键滚
      maxRenderedOptions: 24,
      // 光标离开编辑器就收起来：这一份是写作时的辅助，不该悬在那里
      closeOnBlur: true,
      // 自己接管键位：默认那份里绑的是 Ctrl-Space（见上面 MANUAL_KEY 的说明）
      defaultKeymap: false,
    }),
    keymap.of([
      ...completionKeymap.filter((b) => b.key !== 'Ctrl-Space'),
      { key: MANUAL_KEY, run: startCompletion },
      { key: MANUAL_KEY_ALT, run: startCompletion },
    ]),
  ]
}
