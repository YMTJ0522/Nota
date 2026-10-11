/**
 * 验证脚本用的临时浏览器 profile 目录管理。
 *
 * Edge 每轮需要一份独立的 `--user-data-dir`，跑完就留下一个目录；没人收的话
 * 几十轮下来项目根目录会堆上百个几 MB 的空壳（`ls -ld` 看是 0，其实有内容）。
 *
 * 两个入口：
 *   - `purgeStale()`  开跑前扫一遍，把上一轮（默认 15 分钟前）的残留带走
 *   - `removeProfile()`  本次跑完删自己的目录；失败就算了，留给下次开跑时收
 *
 * 为什么要在开跑前收：Edge 被 kill 之后它的子进程不一定立刻松手，
 * Windows 上在脚本末尾 `rmSync` 常常 EBUSY。等过了几十分钟再删反而稳。
 * 亲测「末尾删」几乎每次都失败，所以末尾只做一次尽力而为的尝试，
 * 真正保证干净的是下一次开跑时的 `purgeStale`。
 *
 * 删不动是常态不是意外，所以一律「失败就跳过」，不抛、不改变退出码——
 * 一个临时目录不该让验证脚本报红。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 默认只收 15 分钟之外的，避免删掉别的脚本正在用的 profile */
const DEFAULT_MAX_AGE = 15 * 60 * 1000

/** 删单个 profile 目录；成功返回 true */
export function removeProfile(dir) {
  if (!dir) return false
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 清掉项目根下所有过期的 `.tmp-*` 目录。
 *
 * 逐个独立删：把一整个列表交给一次删除会撞上批量删除的文件数阈值。
 */
export function purgeStale(maxAgeMs = DEFAULT_MAX_AGE) {
  const now = Date.now()
  let removed = 0
  let skipped = 0
  let kept = 0

  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith('.tmp-')) continue
    const full = path.join(root, name)
    let st
    try {
      st = fs.statSync(full)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    if (now - st.mtimeMs < maxAgeMs) {
      kept++
      continue
    }
    if (removeProfile(full)) removed++
    else skipped++
  }

  return { removed, skipped, kept }
}
