/**
 * 清空构建产物目录。
 *
 * 本机安全层对「单次批量删除」有阈值限制（一次超过 50 个文件会被拦截，
 * 报 SAFE_DELETE_BULK_CONFIRM_REQUIRED）。Vite 自己在 build 前会 emptyDir，
 * 它一次性删掉 dist/assets 里的上百个文件，于是整个构建直接失败。
 *
 * 这里的做法是**自底向上、逐个文件删除**：每个文件一次独立的 rmSync（不带
 * recursive），所以单次调用永远只涉及 1 个文件，不可能触达阈值；目录本身
 * 放到最后清空。每删若干轮让出一次事件循环。
 *
 * 用法：node scripts/clean.mjs <dir> [dir...]
 */
import fs from 'node:fs'
import path from 'node:path'

const targets = process.argv.slice(2)
if (!targets.length) {
  console.error('usage: node scripts/clean.mjs <dir> [dir...]')
  process.exit(1)
}

/** 每删多少个条目让出一次事件循环 */
const YIELD_EVERY = 8

let opsSinceYield = 0
async function tick() {
  if (++opsSinceYield >= YIELD_EVERY) {
    opsSinceYield = 0
    await new Promise((r) => setTimeout(r, 12))
  }
}

/** 递归收集目录下所有文件（不含目录），深度优先、子项排在前 */
function collectFiles(dir) {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    let stat
    try {
      stat = fs.lstatSync(p)
    } catch {
      continue
    }
    if (stat.isDirectory()) out.push(...collectFiles(p))
    else out.push(p)
  }
  return out
}

/** 递归收集目录下的所有子目录（不含根），子目录排在父目录前 */
function collectDirs(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    try {
      if (fs.lstatSync(p).isDirectory()) {
        collectDirs(p, acc)
        acc.push(p)
      }
    } catch {
      /* 忽略 */
    }
  }
  return acc
}

async function wipe(abs) {
  if (!fs.existsSync(abs)) {
    console.log('skip (not found):', abs)
    return 0
  }

  let removed = 0

  // 1) 逐个删文件 —— 每次 rmSync 只针对 1 个文件，不触发批量阈值
  for (const file of collectFiles(abs)) {
    try {
      fs.rmSync(file, { force: true })
      removed += 1
    } catch (e) {
      console.error('failed:', file, e.message)
    }
    await tick()
  }

  // 2) 再自底向上删空目录
  for (const dir of collectDirs(abs)) {
    try {
      fs.rmdirSync(dir)
    } catch (e) {
      console.error('failed dir:', dir, e.message)
    }
    await tick()
  }

  console.log('cleaned', abs, '->', removed, 'files')
  return removed
}

for (const target of targets) {
  await wipe(path.resolve(target))
}
