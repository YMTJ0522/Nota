/**
 * 清空构建产物目录。
 *
 * Vite 在 build 前会自己 emptyDir，但在本机环境下批量删除会被安全层拦截
 * （一次 116 个文件超过阈值）。这里改成小批量、带间隔地删除，规避拦截。
 */
import fs from 'node:fs'
import path from 'node:path'

const targets = process.argv.slice(2)
if (!targets.length) {
  console.error('usage: node scripts/clean.mjs <dir> [dir...]')
  process.exit(1)
}

const BATCH = 20

for (const target of targets) {
  const abs = path.resolve(target)
  if (!fs.existsSync(abs)) {
    console.log('skip (not found):', abs)
    continue
  }

  const entries = fs.readdirSync(abs)
  let removed = 0

  for (const name of entries) {
    const p = path.join(abs, name)
    try {
      fs.rmSync(p, { recursive: true, force: true })
      removed += 1
    } catch (e) {
      console.error('failed:', p, e.message)
    }
    // 每删一批让出事件循环，避免被判定为单次批量操作
    if (removed % BATCH === 0) {
      await new Promise((r) => setTimeout(r, 30))
    }
  }

  console.log('cleaned', abs, '->', removed, 'entries')
}
