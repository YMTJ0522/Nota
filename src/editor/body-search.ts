/**
 * 正文搜索。
 *
 * 侧栏那个搜索框只比文件名：输入「备份」能找到《备份策略》，
 * 却找不到正文里写过「记得先备份」的那十几篇 —— 而人想找的往往正是后者，
 * 因为文件名是他自己起的，正因为想不起来叫什么才要搜。
 *
 * 两个刻意的取舍：
 *  1. **缓存按「路径 + 修改时间」**：只有真改过的才重读。工作区有几百篇 .md，
 *     每敲一个字就把它们全读一遍是不现实的；
 *  2. **并发有限、总量有上限**：一次最多扫 MAX_FILES 篇、同时读 POOL 篇，
 *     超了就在结果里说清楚扫了多少篇 —— 宁可如实报范围，也不假装全查过了。
 */
import type { TreeNode } from '@/store'

export interface BodyHit {
  path: string
  name: string
  /** 命中的那一行，前后各留一点，用来判断要不要点进去 */
  line: string
  /** 命中行在正文里的行号（从 1 起） */
  at: number
}

const MAX_FILES = 400
const POOL = 8

interface CacheEntry {
  mtime: number
  text: string
}
const cache = new Map<string, CacheEntry>()

/** 上次扫的是哪一批文件：整个工作区换掉的时候要让缓存跟着换 */
let cacheRoot = ''

async function readOne(file: TreeNode): Promise<string> {
  const hit = cache.get(file.path)
  if (hit && hit.mtime === (file.mtime ?? 0)) return hit.text
  const text = (await window.api.readNote(file.path)) ?? ''
  cache.set(file.path, { mtime: file.mtime ?? 0, text })
  return text
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

/** 把命中那一行截成看得懂的一小段：太长的话从命中处往两边取 */
function snippet(line: string, at: number, width = 60): string {
  const plain = line.replace(/\s+/g, ' ').trim()
  if (plain.length <= width * 2) return plain
  const start = Math.max(0, at - width)
  return (start > 0 ? '…' : '') + plain.slice(start, start + width * 2) + '…'
}

/**
 * 在正文里找这个词。
 *
 * @returns 命中的行（按文件顺序），以及实际扫了多少篇。
 */
export async function searchBody(
  files: TreeNode[],
  root: string,
  query: string,
): Promise<{ hits: BodyHit[]; scanned: number; total: number }> {
  const q = query.trim().toLowerCase()
  if (!q) return { hits: [], scanned: 0, total: files.length }
  if (root !== cacheRoot) {
    cache.clear()
    cacheRoot = root
  }

  const pool = files.slice(0, MAX_FILES)
  const texts = await mapPool(pool, POOL, (f) => readOne(f))

  const hits: BodyHit[] = []
  for (let i = 0; i < pool.length; i += 1) {
    const text = texts[i]
    if (!text) continue
    const lower = text.toLowerCase()
    let from = lower.indexOf(q)
    if (from < 0) continue
    const lines = text.split('\n')
    let passed = 0
    let at = 0
    for (let k = 0; k < lines.length; k += 1) {
      if (passed + lines[k].length >= from) {
        at = k
        break
      }
      passed += lines[k].length + 1
    }
    hits.push({
      path: pool[i].path,
      name: pool[i].name.replace(/\.md$/i, ''),
      line: snippet(lines[at] ?? '', lower.indexOf(lines[at].toLowerCase()) >= 0 ? q.length : 0),
      at: at + 1,
    })
  }
  return { hits, scanned: pool.length, total: files.length }
}
