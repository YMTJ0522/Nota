/**
 * 打包发布流程（一条命令搞定）：
 *   1. 计算下一个版本号（0.2.0 → 0.3.0 → 0.4.0 …）
 *   2. 写回 package.json
 *   3. 清空 release/ 里的旧安装包（只留最新一份产物）
 *   4. 构建前端 + 主进程
 *   5. 调 electron-builder 出 NSIS 安装版 + Portable 免安装版
 *
 * 用法：
 *   node scripts/release.mjs           # 自动滚版（0.2.0 → 0.3.0）
 *   node scripts/release.mjs --no-bump # 沿用当前版本，只重新打包
 *   node scripts/release.mjs --dry     # 只打印将要做什么，不执行
 *
 * 版本号规则（minor 递增，patch 归零）：
 *   0.2.0 → 0.3.0 → 0.4.0 …
 *   到 0.9.0 之后进 1.0.0，之后按 1.1.0 / 1.2.0 继续。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const RELEASE = path.join(ROOT, 'release')
const PKG = path.join(ROOT, 'package.json')

const args = process.argv.slice(2)
const NO_BUMP = args.includes('--no-bump')
const DRY = args.includes('--dry')

const NODE = process.execPath

function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { cwd: ROOT, stdio: 'inherit', ...opts })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} 退出码 ${code}`))))
    p.on('error', reject)
  })
}

/** 0.2.0 → 0.3.0；0.9.0 → 1.0.0；1.2.0 → 1.3.0 */
function nextVersion(current) {
  const [major, minor] = current.split('.').map((n) => Number.parseInt(n, 10))
  if (Number.isNaN(major) || Number.isNaN(minor)) {
    throw new Error(`版本号格式无法解析：${current}`)
  }
  const nextMajor = minor + 1 >= 10 ? major + 1 : major
  const nextMinor = minor + 1 >= 10 ? 0 : minor + 1
  return `${nextMajor}.${nextMinor}.0`
}

/* ── 1. 版本号 ── */
const raw = fs.readFileSync(PKG, 'utf-8')
const pkg = JSON.parse(raw)
const current = pkg.version
const target = NO_BUMP ? current : nextVersion(current)

console.log(`\n当前版本：${current}`)
console.log(NO_BUMP ? '按 --no-bump，沿用当前版本' : `新版本：  ${target}`)

/* ── 2. 清旧包 ── */
/** 保留目录本身与 win-unpacked，只删旧的安装包 / 免安装包 / blockmap */
function cleanRelease() {
  if (!fs.existsSync(RELEASE)) {
    fs.mkdirSync(RELEASE, { recursive: true })
    return []
  }
  const doomed = fs
    .readdirSync(RELEASE)
    .filter((name) => {
      const lower = name.toLowerCase()
      if (lower === 'win-unpacked') return false
      // 删掉所有历史产物与中间文件（新版本此刻还没生成，全删是安全的）
      return (
        lower.endsWith('.exe') ||
        lower.endsWith('.blockmap') ||
        lower.endsWith('.zip') ||
        lower.endsWith('.7z') ||
        lower.endsWith('.yml')
      )
    })

  for (const name of doomed) {
    fs.rmSync(path.join(RELEASE, name), { force: true })
  }
  return doomed
}

/* ── 3. 构建产物清理 ── */
async function cleanDist() {
  await run(NODE, [path.join('scripts', 'clean.mjs'), 'dist', 'dist-electron'])
}

async function main() {
  if (DRY) {
    console.log('\n[dry-run] 将要执行：')
    console.log(`  - 版本 ${current} → ${target}`)
    console.log('  - 清空 release/ 下所有 .exe / .blockmap / .yml（保留 win-unpacked）')
    console.log('  - 清空 dist/')
    console.log('  - npm run build')
    console.log('  - electron-builder')
    return
  }

  if (!NO_BUMP) {
    pkg.version = target
    // 保持原文件的末尾换行与 2 空格缩进
    fs.writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8')
    console.log(`✓ package.json 已更新为 ${target}`)
  }

  const removed = cleanRelease()
  if (removed.length) {
    console.log(`✓ 已删除 ${removed.length} 个旧产物：`)
    for (const name of removed) console.log(`    - ${name}`)
  } else {
    console.log('✓ release/ 无需清理')
  }

  console.log('\n→ 清理 dist/')
  await cleanDist()

  console.log('\n→ 构建前端与主进程')
  await run(NODE, [path.join('node_modules', 'vue-tsc', 'bin', 'vue-tsc.js'), '-b'])
  await run(NODE, [path.join('node_modules', 'vite', 'bin', 'vite.js'), 'build'])
  await run(NODE, ['build-electron.mjs'])

  console.log('\n→ electron-builder 打包')
  await run(NODE, [path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--win'])

  /* 汇总 */
  const produced = fs.existsSync(RELEASE)
    ? fs.readdirSync(RELEASE).filter((n) => n.endsWith('.exe'))
    : []
  console.log(`\n✅ 打包完成，版本 ${target}`)
  for (const name of produced) {
    const stat = fs.statSync(path.join(RELEASE, name))
    console.log(`    ${name}  (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
  }
}

await main()
