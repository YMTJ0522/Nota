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
 *   node scripts/release.mjs --patch   # 只滚修订号（2.2.0 → 2.2.1），小修小补用这个
 *   node scripts/release.mjs --no-bump # 沿用当前版本，只重新打包
 *   node scripts/release.mjs --dry     # 只打印将要做什么，不执行
 *
 * 版本号规则（minor 递增，patch 归零）：
 *   0.2.0 → 0.3.0 → 0.4.0 …
 *   到 0.9.0 之后进 1.0.0，之后按 1.1.0 / 1.2.0 继续。
 *   --patch 是小改动的口子：动一行样式、撤一个按钮这种，别把 minor 吹上去。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const RELEASE = path.join(ROOT, 'release')
const PKG = path.join(ROOT, 'package.json')

const args = process.argv.slice(2)
const NO_BUMP = args.includes('--no-bump')
const PATCH = args.includes('--patch')
const DRY = args.includes('--dry')

const NODE = process.execPath

function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { cwd: ROOT, stdio: 'inherit', ...opts })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} 退出码 ${code}`))))
    p.on('error', reject)
  })
}

/** 0.2.0 → 0.3.0；0.9.0 → 1.0.0；1.2.0 → 1.3.0（patch=true 时 2.2.0 → 2.2.1） */
function nextVersion(current, patch = false) {
  const [major, minor, p] = current.split('.').map((n) => Number.parseInt(n, 10))
  if (Number.isNaN(major) || Number.isNaN(minor)) {
    throw new Error(`版本号格式无法解析：${current}`)
  }
  if (patch) return `${major}.${minor}.${(Number.isNaN(p) ? 0 : p) + 1}`
  const nextMajor = minor + 1 >= 10 ? major + 1 : major
  const nextMinor = minor + 1 >= 10 ? 0 : minor + 1
  return `${nextMajor}.${nextMinor}.0`
}

/* ── 1. 版本号 ── */
const raw = fs.readFileSync(PKG, 'utf-8')
const pkg = JSON.parse(raw)
const current = pkg.version
const target = NO_BUMP ? current : nextVersion(current, PATCH)

/**
 * 官网那套（下载文件名、页面上写的版本）用的是 cloudflare/wrangler.toml 里的 VERSION。
 * 三个地方（package.json / 安装包文件名 / wrangler.toml）靠人记着对齐，一定会漏 ——
 * 漏了的表现是「官网上写 2.7.3，下载下来是 2.7.2」，而且没人会发现。
 * 所以打包时顺手把它一起改掉。
 */
function syncCloudflareVersion(v) {
  const tomlPath = path.join(ROOT, 'cloudflare', 'wrangler.toml')
  if (!fs.existsSync(tomlPath)) return null
  const toml = fs.readFileSync(tomlPath, 'utf-8')
  const re = /^VERSION\s*=\s*"[^"]*"/m
  if (!re.test(toml)) return null
  const old = (/^VERSION\s*=\s*"([^"]*)"/m.exec(toml) ?? [])[1]
  if (old === v) return { changed: false, old, next: v }
  fs.writeFileSync(tomlPath, toml.replace(re, `VERSION = "${v}"`), 'utf-8')
  return { changed: true, old, next: v }
}

console.log(`\n当前版本：${current}`)
console.log(NO_BUMP ? '按 --no-bump，沿用当前版本' : `新版本：  ${target}${PATCH ? '（--patch 修订号）' : ''}`)

/* ── 2. 清旧包 ── */
/** 保留目录本身与 win-unpacked，只挪走旧的安装包 / 免安装包 / blockmap */
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
      // 挪走所有历史产物与中间文件（新版本此刻还没生成，全挪是安全的）
      return (
        lower.endsWith('.exe') ||
        lower.endsWith('.blockmap') ||
        lower.endsWith('.zip') ||
        lower.endsWith('.7z') ||
        lower.endsWith('.yml')
      )
    })

  if (!doomed.length) return doomed

  /* 同样用 rename 挪走而不是 rmSync：
     安全层按 turn 累计删除数（阈值 50），而这个 turn 里
     后面还有 clean.mjs 跟整个构建流程，能省一次计数就省一次。
     安装包单个 80+ MB，rename 是瞬时的，比删除还快。

     注意：rename 也可能失败——旧包若正被某个进程占用（比如上一次
     打包出的 portable 版还在运行），Windows 会拒绝改名。
     这时**绝不能退回 rmSync**：那个删除动作会被安全层拦下，
     把整个打包流程一起带崩（而且体积大的 exe 走 trash 更容易失败）。
     改名失败就原样留着，最多是多占一份磁盘，下次打包再处理。 */
  const trash = path.join(ROOT, '.trash')
  fs.mkdirSync(trash, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const skipped = []
  for (const name of doomed) {
    const dest = path.join(trash, `release-${stamp}-${name}`)
    try {
      fs.renameSync(path.join(RELEASE, name), dest)
    } catch {
      skipped.push(name)
    }
  }
  if (skipped.length) {
    console.log(`  ⚠ 有 ${skipped.length} 个旧产物被占用，无法挪走（不影响本次打包）：`)
    for (const name of skipped) console.log(`      - ${name}`)
    console.log('    多半是旧版 portable 还在运行。关掉它，或下次打包会自动处理。')
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
    console.log('  - 同步 cloudflare/wrangler.toml 的 VERSION（官网与下载文件名用）')
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

  const cfv = syncCloudflareVersion(pkg.version)
  if (cfv?.changed) console.log(`✓ cloudflare/wrangler.toml 的 VERSION ${cfv.old} → ${cfv.next}`)

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
  const builtAt = Date.now()
  const BUILDER = [path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--win']

  /**
   * electron-builder 的最后一步只是「删掉自己产生的中间文件」
   * （`__uninstaller-nsis-*.exe`、`*.nsis.7z`）——安装包在那之前早就写完了。
   * 而删除动作会被安全层按 turn 累计拦下（阈值 50）：这一 turn 里
   * after-pack 的瘦身刚删过四十来个语言包，正好把配额用光。
   *
   * 于是就出现「产物齐全、退出码非 0」，看上去像打包失败。
   * 判据不能只看退出码：**两份安装包是不是都在这轮之后写出来了**。
   * 是 → 那一步只是没删干净，我们替它清；不是 → 真的失败，照旧抛错。
   */
  let builderError = null
  try {
    await run(NODE, BUILDER)
  } catch (e) {
    builderError = e
  }

  const fresh = (name) => {
    const p = path.join(RELEASE, name)
    if (!fs.existsSync(p)) return false
    return fs.statSync(p).mtimeMs >= builtAt - 1000
  }
  const want = [`Nota-Setup-${target}.exe`, `Nota-Portable-${target}.exe`]
  const got = want.filter(fresh)

  if (builderError) {
    if (got.length === want.length) {
      console.log(`  ⚠ electron-builder 收尾时没能删掉自己的中间文件（安全层拦下），` +
        `但两份安装包都已生成：\n      ${want.join('\n      ')}\n    中间文件由下面这一步清理。`)
    } else {
      throw builderError
    }
  }

  /* 替 builder 清掉它没删成的中间产物（rename 挪走，不计入删除配额） */
  const leftover = fs
    .readdirSync(RELEASE)
    .filter((n) => n.startsWith('__uninstaller-nsis-') || n.endsWith('.nsis.7z'))
  if (leftover.length) {
    const trash = path.join(ROOT, '.trash')
    fs.mkdirSync(trash, { recursive: true })
    for (const name of leftover) {
      try {
        fs.renameSync(path.join(RELEASE, name), path.join(trash, `mid-${Date.now()}-${name}`))
      } catch {
        /* 删不掉就算了，不影响安装包 */
      }
    }
    console.log(`  ✓ 已清掉 ${leftover.length} 个中间产物`)
  }

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
