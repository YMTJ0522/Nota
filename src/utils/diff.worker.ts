/**
 * diff 的 Worker 入口：把 LCS 表格填充挪出主线程。
 *
 * 长文 + 大改动时（4M 格的表）主线程要烧上一两百毫秒 —— 界面就是用户
 * 感受到的那一下「卡」。丢进 Worker 后主线程一行不占，表格填多久
 * 界面都照常响应。
 *
 * 生产环境是 file:// 加载（loadFile），file:// 下不能起模块 Worker，
 * 所以这个文件必须以 `?worker&inline` 方式引入：Vite 把它打成 IIFE
 * 塞进 Blob URL，经典 Worker，file:// 下照样能跑。
 */
import { diffLines } from './diff'

const ctx = self as unknown as Worker

ctx.onmessage = (e: MessageEvent) => {
  const { id, a, b } = e.data as { id: number; a: string; b: string }
  ctx.postMessage({ id, rows: diffLines(a, b) })
}
