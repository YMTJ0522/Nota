/**
 * diff 的异步入口：Worker 优先，Worker 不可用就同步兜底 ——
 * 调用方只管 await，拿到的永远是算好的结果，不是空数组。
 *
 * 为什么不能只靠 Worker：headless 浏览器、部分安全策略下 blob Worker
 * 会被禁（new Worker 成功但脚本永远跑不起来）。diff 是「看得见的正确性」，
 * 宁可慢，不能给用户摆一个错误的空对比。
 *
 * 单例 Worker + 自增 id 配对请求。两道保险：
 *   1. onerror：Worker 报错 → 挂着的请求改由主线程同步算；
 *   2. 看门狗：2.5s 没回音（worker 被静默禁用的典型症状）→ 同样转同步，
 *      并停用 Worker，之后的请求不再浪费时间等它。
 */
import type { DiffLine } from './diff'
import { diffLines } from './diff'
import DiffWorker from './diff.worker?worker&inline'

let worker: Worker | null = null
let seq = 0

interface PendingReq {
  a: string
  b: string
  resolve: (rows: DiffLine[]) => void
  timer: ReturnType<typeof setTimeout>
}
const pending = new Map<number, PendingReq>()

/** 把挂着的请求全部改走主线程同步算，然后停用 Worker */
function drainToSync(): void {
  for (const req of pending.values()) {
    clearTimeout(req.timer)
    req.resolve(diffLines(req.a, req.b))
  }
  pending.clear()
  worker = null
}

function ensureWorker(): Worker | null {
  if (worker) return worker
  try {
    worker = new DiffWorker()
  } catch {
    /* 起不来就退回同步：慢一点，但功能在 */
    return null
  }
  worker.onmessage = (e: MessageEvent) => {
    const { id, rows } = e.data as { id: number; rows: DiffLine[] }
    const req = pending.get(id)
    if (!req) return
    clearTimeout(req.timer)
    pending.delete(id)
    req.resolve(rows)
  }
  worker.onerror = () => {
    /* 脚本没跑起来（禁用策略/内部异常）：改同步，之后不再尝试 Worker */
    drainToSync()
  }
  return worker
}

export function diffLinesAsync(oldText: string, newText: string): Promise<DiffLine[]> {
  const w = ensureWorker()
  if (!w) return Promise.resolve(diffLines(oldText, newText))
  const id = ++seq
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      /* 2.5s 没回音：worker 八成被静默禁用了。这一个请求转同步，
         drainToSync 会把 worker 也停掉，之后直接走同步。 */
      if (pending.has(id)) drainToSync()
    }, 2500)
    pending.set(id, { a: oldText, b: newText, resolve, timer })
    w.postMessage({ id, a: oldText, b: newText })
  })
}
