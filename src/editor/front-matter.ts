/**
 * Front Matter 在预览区里的样子。
 *
 * 以前预览是**把它整段剥掉**的：`---` 在 marked 眼里是 setext 标题的下划线，
 * 保住它就会把 `title:` / `tags:` 排成一个巨大的二级标题，所以最省事的做法
 * 是删掉。可工具栏上明明摆着「Front Matter」这一项，点一下插进去，
 * 预览里什么都不出现 —— 用户的结论只能是「这个功能坏了」。
 *
 * 现在改成：源码里仍然是英文 YAML（谁都能拷走、跟别的工具互通），
 * 预览里换成一张中文的属性卡。**只换展示，不动文件**。
 */

/** 一条属性。list 非空时按标签/列表渲染 */
export interface FmRow {
  key: string
  label: string
  value: string
  list?: string[]
  /** 标题类字段排得大一点，它是这张纸的名字 */
  title?: boolean
}

/** 字段名的中文。没收录的保留原样 —— 乱猜一个中文名比显示英文更让人困惑 */
const LABELS: Record<string, string> = {
  title: '标题',
  name: '标题',
  subtitle: '副标题',
  description: '描述',
  desc: '描述',
  summary: '摘要',
  excerpt: '摘要',
  tags: '标签',
  tag: '标签',
  labels: '标签',
  keywords: '关键词',
  category: '分类',
  categories: '分类',
  series: '系列',
  collection: '合集',
  author: '作者',
  authors: '作者',
  created: '创建',
  created_at: '创建',
  date: '日期',
  updated: '更新',
  updated_at: '更新',
  modified: '更新',
  status: '状态',
  state: '状态',
  draft: '草稿',
  star: '收藏',
  starred: '收藏',
  pinned: '置顶',
  pin: '置顶',
  cover: '封面',
  image: '封面',
  icon: '图标',
  alias: '别名',
  aliases: '别名',
  slug: '短名',
  type: '类型',
  kind: '类型',
  source: '来源',
  url: '链接',
  link: '链接',
  repo: '仓库',
  weight: '权重',
  order: '排序',
  priority: '优先级',
  rating: '评分',
  progress: '进度',
  due: '截止',
  deadline: '截止',
  project: '项目',
  area: '领域',
  topic: '主题',
  license: '许可',
  version: '版本',
  lang: '语言',
  language: '语言',
  private: '私密',
  public: '公开',
}

/** 这几个字段的值天然是一串名字，按标签渲染 */
const LIST_KEYS = new Set(['tags', 'tag', 'labels', 'keywords', 'aliases', 'alias', 'categories'])

/** 这几个字段是这篇纸的名字，排大一号 */
const TITLE_KEYS = new Set(['title', 'name'])

const OPEN_LINE = /^\uFEFF?[ \t]*\\?---[ \t]*\r?\n/

/**
 * 找出文首 frontmatter 的正文（两个 `---` 中间那段）。
 *
 * 判据必须和 `stripFrontMatter` 完全一致：那边认 BOM、认被转义成 `\---` 的
 * 分隔线、认收尾行前后的空格。两边不一致就会出现「预览里既没有属性卡、
 * 元数据又漏进正文」这种两头不讨好的状态。
 */
export function readFrontMatter(md: string): string | null {
  const m = OPEN_LINE.exec(md)
  if (!m) return null
  const rest = md.slice(m[0].length)
  const close = /^[ \t]*\\?---[ \t]*(?:\r?\n|$)/m
  const hit = close.exec(rest)
  if (!hit) return null
  return rest.slice(0, hit.index)
}

function unquote(s: string): string {
  const t = s.trim()
  if (t.length >= 2) {
    const a = t[0]
    const b = t[t.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return t.slice(1, -1)
  }
  return t
}

/** `[a, b, "c"]` 这种行内数组 */
function inlineList(s: string): string[] | null {
  const t = s.trim()
  if (!t.startsWith('[') || !t.endsWith(']')) return null
  const inner = t.slice(1, -1).trim()
  if (!inner) return []
  return inner
    .split(',')
    .map((x) => unquote(x))
    .filter(Boolean)
}

/**
 * 解析成若干行。
 *
 * 只做「一眼能看懂」的那部分 YAML：标量、行内数组、`- ` 列表、折行续写。
 * 嵌套映射不展开（展开要画一棵树，预览里没人想看一棵树），原样并成一段。
 * **这是展示，不是解析器** —— 宁可多显示一点原文，也不要为了「看起来聪明」
 * 把用户的内容吃掉。
 */
export function parseFrontMatter(raw: string): FmRow[] {
  const rows: FmRow[] = []
  let cur: FmRow | null = null
  let folded: string[] = []

  const flush = () => {
    if (!cur) return
    if (folded.length) {
      const extra = folded.join(' ').trim()
      if (extra) cur.value = cur.value ? `${cur.value} ${extra}` : extra
    }
    folded = []
    cur = null
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    // YAML 注释。`#标签` 这种想当标签的写法只可能出现在 `- ` 列表里，
    // 顶层以 # 开头的行按规范就是注释。
    if (/^[ \t]*#/.test(line)) continue

    const item = /^[ \t]*-[ \t]+(.*)$/.exec(line)
    if (item) {
      if (cur) {
        cur.list = cur.list ?? []
        cur.list.push(unquote(item[1]))
      }
      continue
    }

    const kv = /^([^\s:#][^:]*):[ \t]*(.*)$/.exec(line)
    if (kv) {
      flush()
      const key = kv[1].trim()
      const rawVal = kv[2]
      const list = inlineList(rawVal)
      cur = {
        key,
        label: LABELS[key.toLowerCase()] ?? key,
        value: list ? '' : unquote(rawVal),
        ...(list ? { list: list.length ? list : [] } : {}),
        ...(TITLE_KEYS.has(key.toLowerCase()) ? { title: true } : {}),
      }
      if (list && !list.length) cur.list = []
      rows.push(cur)
      continue
    }

    // 缩进的续行 / 嵌套内容：并进当前值
    if (cur) folded.push(line.trim())
  }
  flush()

  // 空值 + 没有列表项的行，如果它下面全是空，仍然留着 —— 用户刚点完
  // 「Front Matter」插进来的正是 `title:` 和 `tags: []` 两个空栏位，
  // 藏起来又会回到「点了什么也没发生」。
  return rows
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function cell(row: FmRow): string {
  const key = row.key.toLowerCase()

  if (row.list) {
    if (!row.list.length) return '<span class="pv-fm-none">未填写</span>'
    const cls = LIST_KEYS.has(key) ? 'pv-fm-tag' : 'pv-fm-item'
    return row.list.map((x) => `<span class="${cls}">${esc(x)}</span>`).join('')
  }

  const v = row.value.trim()
  if (!v) return '<span class="pv-fm-none">未填写</span>'
  // true / false 是 YAML 的布尔，直接摆英文会像没翻译干净
  if (v === 'true') return '是'
  if (v === 'false') return '否'
  // 日期 / 时间原样，其它也原样：这些东西翻译了就失真
  return esc(v)
}

/**
 * 生成属性卡的 HTML。没有 frontmatter 就返回空串。
 *
 * 返回的是一段块级 HTML，直接拼在 markdown 前面喂给 marked ——
 * marked 对块级 HTML 是原样透传的（提示块、`<details>`、`<video>` 都靠这条）。
 */
export function frontMatterHtml(md: string): string {
  const raw = readFrontMatter(md)
  if (raw === null) return ''
  const rows = parseFrontMatter(raw)
  if (!rows.length) return ''

  const body = rows
    .map(
      (r) =>
        `<div class="pv-fm-row${r.title ? ' is-title' : ''}">` +
        `<span class="pv-fm-k">${esc(r.label)}</span>` +
        `<span class="pv-fm-v">${cell(r)}</span>` +
        `</div>`,
    )
    .join('')
  return `<div class="pv-fm" data-fm="1">${body}</div>\n\n`
}
