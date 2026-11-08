/**
 * 把一篇 Markdown 解析成一棵「结构树」，供大纲与导图共用。
 *
 * 为什么要有这一层、而不是让两个视图各自去扫正文：这两处对「什么算一节」
 * 的认定必须完全一致。只要有一处多认一个节点，大纲里点第 5 条、导图里就
 * 会亮第 6 个，用户没法解释，我们也没法维护。所以扫一遍，出一棵树。
 *
 * 收进树里的东西是**结构**，不是全文：
 *   · 标题 `#`~`######`        —— 骨架
 *   · 列表项 `-` / `1.` / `- [ ]` —— 骨架下的肉，按缩进定层级
 *   · 行内 `#标签`              —— 挂在节点上的一枚 chip
 * 段落、代码块、表格、公式**不进树**。Nota 的正文是文档而不是纯大纲，
 * 把一段两百字的正文压成一个节点，只会得到一个既读不懂又占地方的图。
 *
 * 树根是一个虚拟节点，代表「这篇笔记」本身 —— 导图以它为圆心。
 */

import { createFenceTracker, plainInline, firstHashtag, headingSlug } from './markdown-lines'

export type OutlineKind = 'heading' | 'item'

export interface OutlineNode {
  /** 标题沿用 slug（与预览里的锚点同源）；列表项用行号，保证唯一 */
  id: string
  kind: OutlineKind
  /** 标题是 1~6；列表项是「所属标题级别 + 缩进层数 + 1」，只用于建栈比较 */
  level: number
  /** 在树里的实际层数，0 是根。导图靠它定横坐标 */
  depth: number
  /** 已经抹掉 Markdown 记号的正文 */
  text: string
  /** 源码行号，0 起。点节点跳转要用它 */
  line: number
  /** 行内第一个 `#标签`，没有就是 null */
  tag: string | null
  /** 任务列表的勾选态；不是任务项就是 null */
  checked: boolean | null
  children: OutlineNode[]
}

export interface OutlineTree {
  /** 虚拟根，`text` 是笔记标题 */
  root: OutlineNode
  /** 先序遍历的扁平表，渲染与查找都走它 */
  flat: OutlineNode[]
  /** 节点总数（不含根），给界面显示「几个节点」 */
  count: number
}

/** 一行里最多取这么多字，超了截断 —— 导图节点只有一行的高度 */
const MAX_TEXT = 80

/**
 * 列表缩进按「见过的最小台阶」归一。
 *
 * 有人用两个空格，有人用四个，还有人混着写；如果直接拿空格数除以 2，
 * 四空格缩进的文档会凭空多出一层。这里维护一个缩进栈：新缩进比栈顶大
 * 就压栈（层级 +1），比栈顶小就弹到不大于它的位置。缩进宽度具体是多少
 * 就无关紧要了，只看「比上一层深」这件事。
 */
function indentDepth(stack: number[], width: number): number {
  if (stack.length === 0) {
    stack.push(width)
    return 0
  }
  const top = stack[stack.length - 1]
  if (width > top) {
    stack.push(width)
    return stack.length - 1
  }
  if (width === top) return stack.length - 1
  while (stack.length > 1 && stack[stack.length - 1] > width) stack.pop()
  const back = stack[stack.length - 1]
  if (back < width) {
    stack.push(width)
    return stack.length - 1
  }
  return stack.length - 1
}

/**
 * 从源码建树。
 *
 * `title` 只用作根节点的显示名（导图中心那一颗）；正文里没有标题时
 * 它就是唯一的字，所以调用方应当传文件名（去掉 .md）。
 */
export function buildOutlineTree(raw: string, title: string): OutlineTree {
  const root: OutlineNode = {
    id: '__root__',
    kind: 'heading',
    level: 0,
    depth: 0,
    text: title.trim() || '未命名',
    line: -1,
    tag: null,
    checked: null,
    children: [],
  }
  const lines = raw.split('\n')
  const inFence = createFenceTracker()
  const seen = new Map<string, number>()

  /** 栈顶永远是「下一个节点可能的父级」 */
  const stack: OutlineNode[] = [root]
  /** 当前所属标题的级别（1~6；文档开头没有标题时是 0） */
  let headingLevel = 0
  /** 列表缩进栈，遇到标题要清空 —— 新一节从头算缩进 */
  const indents: number[] = []

  /* front matter 逐行跳过而不是整段剥掉：剥掉之后所有行号都会上移，
     而节点要靠行号跳回正文，一错就是十几行。 */
  let front = (lines[0] ?? '').trim() === '---'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    /* front matter 先处理：它里面出现的 ``` 不该喂给围栏状态机，
       否则那一段会被当成开栏，把后面整篇正文都算作代码。 */
    if (front) {
      if (i > 0 && /^---\s*$/.test(line)) front = false
      continue
    }

    // 围栏里的内容一律不看：代码里的 `# 注释` 不是标题
    if (inFence(line)) continue

    const head = /^(#{1,6})[ \t]+(.*)$/.exec(line)
    if (head) {
      const level = head[1].length
      const tag = firstHashtag(head[2])
      /* slug 要用**没摘标签**的整行来算。
         `outlineFromSource` 那边（store.headings）就是这么算的，预览锚点也
         沿用同一份。这里如果拿 stripTag 之后的文字去生成 id，任何带 `#标签`
         的标题都会和预览锚点对不上 —— 点一下跳过去倒是靠行号，还能动，但
         「当前读到哪一节」的高亮会永远对不上号，而且没有任何报错。 */
      const full = plainInline(head[2])
      const text = stripTag(full, tag).slice(0, MAX_TEXT)
      if (!text) continue

      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop()
      const parent = stack[stack.length - 1]
      const node: OutlineNode = {
        id: headingSlug(full, seen),
        kind: 'heading',
        level,
        depth: parent.depth + 1,
        text,
        line: i,
        tag,
        checked: null,
        children: [],
      }
      parent.children.push(node)
      stack.push(node)
      headingLevel = level
      indents.length = 0
      continue
    }

    const item = /^([ \t]*)([-*+]|\d{1,3}[.)])[ \t]+(.*)$/.exec(line)
    if (item) {
      const indent = item[1].replace(/\t/g, '    ').length
      const depthInList = indentDepth(indents, indent)
      let body = item[3]

      // 任务列表：`- [ ] 待办` / `- [x] 已完成`
      let checked: boolean | null = null
      const task = /^\[([ xX])\][ \t]+(.*)$/.exec(body)
      if (task) {
        checked = task[1].toLowerCase() === 'x'
        body = task[2]
      }

      const tag = firstHashtag(body)
      const text = stripTag(plainInline(body), tag).slice(0, MAX_TEXT)
      if (!text) continue

      const level = headingLevel + 1 + depthInList
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop()
      const parent = stack[stack.length - 1]
      const node: OutlineNode = {
        id: `i-${i}`,
        kind: 'item',
        level,
        depth: parent.depth + 1,
        text,
        line: i,
        tag,
        checked,
        children: [],
      }
      parent.children.push(node)
      stack.push(node)
      continue
    }

    /* 其余行（段落、表格、公式、空行）既不入树也不清栈：
       段落夹在两条列表项之间是常事，看到段落就把列表「断开」是错的。 */
  }

  liftTitleHeading(root)
  const finalFlat = flatten(root)
  return { root, flat: finalFlat, count: finalFlat.length }
}

/**
 * 把 `#标签` 从节点文字里摘掉。
 *
 * 节点右侧已经有一枚 chip 显示它了，文字里再带一遍就是重复。
 * 只摘第一个 —— 一行挂两个标签时 chip 只放得下一个，另一个留在文字里
 * 当普通内容，总比悄悄吞掉强。
 */
function stripTag(text: string, tag: string | null): string {
  if (!tag) return text
  const i = text.indexOf('#' + tag)
  if (i < 0) return text
  return (text.slice(0, i) + text.slice(i + 1 + tag.length)).replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * 把「正文开头唯一的 H1」提升成根。
 *
 * 绝大多数笔记第一行就是 `# 标题`，和文件名是同一件事。不提升的话，
 * 导图中心写着「一周手记」、右边第一个分支又写着「一周手记」，一个名字
 * 出现两次；大纲里也多出一层毫无意义的缩进。更糟的是：折叠那个 H1 会把
 * 整篇收成一行，看起来像文档没了。
 *
 * 只在「顶层恰好只有一个 H1」时提升。有多个 H1 的文档结构本来就松散，
 * 那时用文件名当根、每个 H1 各当一个分支才是对的。
 */
function liftTitleHeading(root: OutlineNode) {
  if (root.children.length !== 1) return
  const only = root.children[0]
  if (only.kind !== 'heading' || only.level !== 1) return

  root.text = only.text || root.text
  root.id = only.id
  root.line = only.line
  root.tag = only.tag
  root.children = only.children
  const fix = (n: OutlineNode, d: number) => {
    n.depth = d
    for (const c of n.children) fix(c, d + 1)
  }
  for (const c of root.children) fix(c, 1)
}

/** 先序遍历（不含根），重建扁平表 */
function flatten(root: OutlineNode): OutlineNode[] {
  const out: OutlineNode[] = []
  const walk = (n: OutlineNode) => {
    for (const c of n.children) {
      out.push(c)
      walk(c)
    }
  }
  walk(root)
  return out
}
/**
 * 统计整棵树里有多少个节点（含折叠起来的）。
 *
 * 大纲的折叠标记要显示「收起时里面还有几项」，导图上用的是同一个数。
 */
export function countNodes(node: OutlineNode): number {
  let n = 0
  for (const c of node.children) n += 1 + countNodes(c)
  return n
}

/** 大纲里的一行：节点 + 它在树上「此刻」的位置 */
export interface OutlineRow {
  node: OutlineNode
  /** 从 1 起（根不显示），缩进按它算 */
  depth: number
  hasChildren: boolean
  /** 展开着 = true；叶子节点也是 true（只是没有可折的东西） */
  open: boolean
  /** 收起时里面压着几项，展开时为 0 */
  hidden: number
}

/**
 * 先序展开成「此刻看得见的行」，折叠的子树整段跳过。
 *
 * 大纲直接 v-for 这一份，不必在模板里递归 —— 递归组件配 `v-if` 在几百个
 * 节点时渲染代价高得多，而且行与行之间没法做统一的 hover 底色。
 *
 * `max` 是硬上限。超长笔记（几千行、每行一个列表项）全画出来会让这一栏
 * 卡住，宁可截断并在界面上说一句「后面还有」。
 */
export function visibleRows(
  root: OutlineNode,
  collapsed: Set<string>,
  max = 600,
): { rows: OutlineRow[]; truncated: boolean } {
  const rows: OutlineRow[] = []
  let truncated = false
  const walk = (n: OutlineNode, depth: number) => {
    for (const c of n.children) {
      if (rows.length >= max) {
        truncated = true
        return
      }
      const hasChildren = c.children.length > 0
      const open = hasChildren && !collapsed.has(c.id)
      rows.push({
        node: c,
        depth,
        hasChildren,
        open,
        hidden: open ? 0 : countNodes(c),
      })
      if (open) walk(c, depth + 1)
    }
  }
  walk(root, 1)
  return { rows, truncated }
}
