/**
 * 逐行对比（ Myers 之外的稳妥选择：LCS 动态规划 ）。
 *
 * 为什么自己写而不引一个 diff 库：这里要的只是「哪几行是新的、哪几行没了」，
 * 一个 diff 库连带它的分包与依赖能有好几百 KB，为版本历史这一个面板不值。
 *
 * 两篇 Markdown 通常都是几百行，O(n·m) 的表完全撑得住；
 * 只有真的很大（比如一篇被整段替换的长文）才退化成
 * 「掐掉公共头尾、中间按块替换」的粗算法 —— 那种情况下精确的逐行结果
 * 反正也没人一行行看。
 */
export type DiffOp = 'same' | 'add' | 'del'

export interface DiffLine {
  op: DiffOp
  /** 行内容（不含换行符） */
  text: string
  /** 在旧文本里的行号，从 1 起；新增行为 null */
  oldNo: number | null
  /** 在新文本里的行号，从 1 起；删除行为 null */
  newNo: number | null
}

const MAX_CELLS = 4_000_000

export function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n')
}

/** 掐掉公共前缀与后缀，只对中间那一段做精确对比 */
function trimCommon(a: string[], b: string[]) {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1
  }
  return { head, tail, am: a.slice(head, a.length - tail), bm: b.slice(head, b.length - tail) }
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const { head, am, bm } = trimCommon(a, b)

  const out: DiffLine[] = []
  for (let i = 0; i < head; i += 1) out.push({ op: 'same', text: a[i], oldNo: i + 1, newNo: i + 1 })

  const mid =
    am.length * bm.length > MAX_CELLS
      ? coarseDiff(am, bm)
      : lcsDiff(am, bm)

  let oldNo = head
  let newNo = head
  for (const m of mid) {
    if (m.op === 'same') {
      out.push({ op: 'same', text: m.text, oldNo: oldNo + 1, newNo: newNo + 1 })
      oldNo += 1
      newNo += 1
    } else if (m.op === 'del') {
      out.push({ op: 'del', text: m.text, oldNo: oldNo + 1, newNo: null })
      oldNo += 1
    } else {
      out.push({ op: 'add', text: m.text, oldNo: null, newNo: newNo + 1 })
      newNo += 1
    }
  }

  // 公共后缀：两侧的起点不同（中间那段增删会错开偏移量），所以各自算一遍
  const tailStart = head + am.length
  const bTail = head + bm.length
  for (let i = tailStart; i < a.length; i += 1) {
    out.push({ op: 'same', text: a[i], oldNo: i + 1, newNo: bTail + (i - tailStart) + 1 })
  }
  return out
}

/** 中间整段当「全删 + 全加」。大文件下只用它兜底 */
function coarseDiff(am: string[], bm: string[]): { op: DiffOp; text: string }[] {
  return [
    ...am.map((text) => ({ op: 'del' as DiffOp, text })),
    ...bm.map((text) => ({ op: 'add' as DiffOp, text })),
  ]
}

/**
 * 标准 LCS：先填一张 (n+1)×(m+1) 的表，再从右下角回溯出路径。
 * 表用 Uint32Array 摊平成一维 —— 二维数组的每一行都是一次分配，
 * 几百行乘几百列就是几百次分配。
 *
 * 内层比较走**整数**不走字符串：先给两边的行各发一个行号（同文同号），
 * DP 每格就只是一次数字比较。直接拿字符串比的话，一篇 2000 行、
 * 每行几十字的笔记就是上百万次字符串比较，几秒就烧进去了 ——
 * 这正是版本历史在长文上「打开就卡死」的出处。
 */
function lcsDiff(a: string[], b: string[]): { op: DiffOp; text: string }[] {
  const ids = new Map<string, number>()
  const intern = (s: string) => {
    let v = ids.get(s)
    if (v === undefined) {
      v = ids.size
      ids.set(s, v)
    }
    return v
  }
  const ai = a.map(intern)
  const bi = b.map(intern)

  const n = a.length
  const m = b.length
  const w = m + 1
  const table = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * w + j] =
        ai[i] === bi[j]
          ? table[(i + 1) * w + (j + 1)] + 1
          : Math.max(table[(i + 1) * w + j], table[i * w + (j + 1)])
    }
  }

  const out: { op: DiffOp; text: string }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (ai[i] === bi[j]) {
      out.push({ op: 'same', text: a[i] })
      i += 1
      j += 1
    } else if (table[(i + 1) * w + j] >= table[i * w + (j + 1)]) {
      out.push({ op: 'del', text: a[i] })
      i += 1
    } else {
      out.push({ op: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < n) {
    out.push({ op: 'del', text: a[i] })
    i += 1
  }
  while (j < m) {
    out.push({ op: 'add', text: b[j] })
    j += 1
  }
  return out
}

/** 面板顶上那句「+N −M」 */
export function diffSummary(rows: DiffLine[]) {
  let add = 0
  let del = 0
  for (const r of rows) {
    if (r.op === 'add') add += 1
    else if (r.op === 'del') del += 1
  }
  return { add, del }
}
