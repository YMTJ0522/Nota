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
 * 为什么末尾删不掉：Edge 被 kill 之后 crashpad / GPU 子进程还要一小会儿才
 * 松手，Windows 上这期间 `rmSync` 一律 EBUSY。所以末尾用 `removeProfileWhenFree`
 * 边等边重试（约 3 秒窗口），仍有漏网的交给下一次开跑时的 `purgeStale`。
 *
 * 删不动不是意外，一律「失败就跳过」，不抛、不改变退出码——一个临时目录
 * 不该让验证脚本报红。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 默认只收 15 分钟之外的，避免删掉别的脚本正在用的 profile */
const DEFAULT_MAX_AGE = 15 * 60 * 1000

/** `.tmp-cdp-*` 是一轮一换的一次性 profile，开跑前收 60 秒以上的就够安全 */
const CDP_MAX_AGE = 60 * 1000

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
 * 边等边删。进程刚收到 kill 时句柄还没放开，硬删必 EBUSY，等一会儿就成了。
 * 约 3 秒窗口（12 次 × 250ms）够 crashpad 退干净。
 */
export async function removeProfileWhenFree(dir, { tries = 12, waitMs = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (!fs.existsSync(dir)) return true
    if (removeProfile(dir)) return true
    await new Promise((r) => setTimeout(r, waitMs))
  }
  return false
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
    /* cdp profile 一轮一个、名字带时间戳，不存在跨轮复用，门槛放低 */
    const limit = name.startsWith('.tmp-cdp-') ? CDP_MAX_AGE : maxAgeMs
    if (now - st.mtimeMs < limit) {
      kept++
      continue
    }
    if (removeProfile(full)) removed++
    else skipped++
  }

  return { removed, skipped, kept }
}

/**
 * 收掉本机所有 `.tmp-cdp-*`。
 *
 * 收尾时只删自己那一个不够：实测偶有 Edge 的残留子进程在 close 之后又把
 * profile 目录 recreates 一份（甚至换个名字），自己那个删干净了根目录里还
 * 躺着一个。既然同一时刻只会有一个脚本在跑，收尾就按「整个前缀清空」处理。
 */
export async function purgeCdp({ tries = 4, waitMs = 400 } = {}) {
  let pending = []
  for (let i = 0; i < tries; i++) {
    pending = fs.readdirSync(root).filter((n) => n.startsWith('.tmp-cdp-'))
    if (!pending.length) return 0
    for (const n of pending) removeProfile(path.join(root, n))
    await new Promise((r) => setTimeout(r, waitMs))
  }
  return fs.readdirSync(root).filter((n) => n.startsWith('.tmp-cdp-')).length
}
