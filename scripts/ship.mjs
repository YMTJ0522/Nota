/**
 * 一条命令走完发版：打包 → 验产物 → 打部署包 → 提交 → 推 GitHub → 更新官网 → 清垃圾。
 *
 *   node scripts/ship.mjs
 *   node scripts/ship.mjs --skip-deploy    # 不动官网，只发代码和安装包
 *   node scripts/ship.mjs --skip-clean     # 不清垃圾
 *   node scripts/ship.mjs --from=5         # 从第 5 步接着跑（前面几步已经成功过）
 *
 * 为什么要有它：这几步的顺序是死的（先打包才有 exe，先提交 publish 才推得对，
 * 全量部署才会带上新 exe），但每一步各自都有坑。写死在脚本里，比每次靠记性拼命令可靠。
 *
 * 每一步都能单独重跑 —— 已经完成的会自己跳过（GitHub 那边按 state 判定，
 * 部署脚本自己会比对文件）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const SKIP_DEPLOY = argv.includes('--skip-deploy')
const SKIP_CLEAN = argv.includes('--skip-clean')
const fromArg = argv.find((a) => a.startsWith('--from='))
const FROM = fromArg ? Number.parseInt(fromArg.split('=')[1], 10) || 1 : 1

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const VERSION = pkg.version
const EXE_NAME = `Nota-Setup-${VERSION}.exe`
const PORTABLE_NAME = `Nota-Portable-${VERSION}.exe`
const EXE = path.join(root, 'release', EXE_NAME)
const PORTABLE = path.join(root, 'release', PORTABLE_NAME)
const SEVENZA = path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
const rel = (p) => path.relative(root, p).replace(/\\/g, '/')
const mb = (n) => (n / 1048576).toFixed(1) + ' MB'

const problems = []

function fail(msg) {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
  if (r.error) return 127
  return r.status ?? 1
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' })
  return { code: r.error ? 127 : (r.status ?? 1), out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/* ── 1. 打包 ──
   electron-builder 收尾那步只是删自己的中间文件，安全层会拦；
   于是常见「产物齐全、退出码非 0」。所以退出码只作参考，认产物。 */
function stepPack() {
  const code = run(process.execPath, [path.join('scripts', 'release.mjs'), '--no-bump'])
  if (!fs.existsSync(EXE)) {
    fail(`打包没有产出 ${EXE_NAME}（release.mjs 退出码 ${code}）`)
  }
  /* 便携版是 release.mjs 复制出来的，缺了说明那一步被跳过（比如产物刚生成就被占用）。
     它跟安装包同一个二进制，缺一份不影响功能，但下载页上会少一个入口。 */
  if (!fs.existsSync(PORTABLE)) {
    console.log(`  ⚠ 缺 ${PORTABLE_NAME}，拿安装包复制一份补上`)
    fs.copyFileSync(EXE, PORTABLE)
  }
  if (code !== 0) {
    console.log(`  ⚠ release.mjs 退出码 ${code}，但产物已生成 —— 多为收尾删中间文件被拦，下一步验完整性`)
  }
  console.log(`  ✓ ${EXE_NAME}  ${mb(fs.statSync(EXE).size)}`)
  console.log(`  ✓ ${PORTABLE_NAME}  ${mb(fs.statSync(PORTABLE).size)}`)
}

/* ── 2. 验产物 ──
   这个项目历史上出现过「打包说失败，产物其实完整」，也出现过相反的情况。
   只有 7za t 通过才算数 —— 它真去读了一遍压缩流。 */
function stepVerify() {
  if (!fs.existsSync(SEVENZA)) fail(`找不到 7za：${rel(SEVENZA)}`)
  /* 两份都验。便携版是复制出来的，原则上跟安装包一模一样的字节 ——
     但「原则上」这三个字在发版流程里等于没说，真读一遍压缩流才作数。 */
  for (const file of [EXE, PORTABLE]) {
    const name = path.basename(file)
    const { code, out } = capture(SEVENZA, ['t', file])
    if (code !== 0) {
      console.error(out.split('\n').slice(-12).join('\n'))
      fail(`${name} 自检没过，别发这个包`)
    }
    const size = fs.statSync(file).size
    if (size < 40 * 1048576) {
      fail(`${name} 只有 ${mb(size)}，比正常的 70 MB 小太多，多半不完整`)
    }
    console.log(`  ✓ ${name} 压缩流完整  ${mb(size)}`)
  }
}

/* ── 3. 官网部署包 ──
   site/ + 安装包 + info.json 打成一个 tgz，交给服务器解压 —— 服务器不碰外网。 */
function stepBundle() {
  const code = run(process.execPath, [path.join('scripts', 'make-deploy-bundle.mjs')])
  if (code !== 0) fail('打部署包失败')
}

/* ── 4. 提交 ──
   publish-github.mjs 只 push 不 commit。这一步漏了，GitHub 上就还是旧版本号，
   而 Release 是用本地 package.json 的版本号建的 —— 会出现「tag 是 2.7.6、
   仓库里写 2.7.5」这种对不上的状态。 */
function stepCommit() {
  run('git', ['add', '-A'])
  const staged = capture('git', ['diff', '--cached', '--quiet'])
  if (staged.code === 0) {
    console.log('  没有改动要提交，跳过')
    return
  }
  const code = run('git', ['commit', '-m', commitSubject()])
  if (code !== 0) fail('提交失败（上面有 git 的原话）')
}

/** 提交标题取 release-notes.md 里第一句正文 —— 写死一行「安装时可选笔记目录」
    的结果是每发一版都留着上一版的描述，git log 上看着像没改过任何东西。

    release notes 那句常常自带冒号（「这一版只补一件事：把免安装版单独拿出来」），
    直接拼就成了「2.7.7：这一版只补一件事：…」，一串冒号。这种时候只留后半句。 */
function commitSubject() {
  try {
    const md = fs.readFileSync(path.join(root, 'release-notes.md'), 'utf8')
    const line = md
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith('#') && !s.startsWith('|') && !s.startsWith('>') && !s.startsWith('-'))
    if (line) {
      let clean = line.replace(/[*`]/g, '').replace(/[：:。.]$/, '')
      const m = /^[^：:]{2,24}[：:]\s*(.+)$/.exec(clean)
      if (m) clean = m[1]
      return `${VERSION}：${clean.length > 60 ? clean.slice(0, 60) + '…' : clean}`
    }
  } catch {
    /* 没有 release-notes 就退回版本号 */
  }
  return `${VERSION}：发版`
}

/* ── 5. 推代码 + Release + 传包 + 推 gh-pages ── */
function stepPublish() {
  const code = run(process.execPath, [path.join('scripts', 'publish-github.mjs')])
  if (code !== 0) {
    problems.push(`GitHub 那步没走完。网络好了单独重跑：node scripts/ship.mjs --from=5`)
    return false
  }
  return true
}

/* ── 6. 官网 ──
   **必须全量**，不能用 --quick：--quick 只同步页面，/d/setup.exe 还是旧的，
   于是「官网写着 2.7.6、下下来是 2.7.5」，这种错最难发现。 */
function stepDeploy() {
  const pass = process.env.NOTA_PASS
  if (!pass) {
    problems.push('没设 NOTA_PASS，官网没更新。设好后单独跑：$env:NOTA_PASS="…"; node scripts/ship.mjs --from=6')
    return false
  }
  /* remote-deploy.py 依赖 paramiko。这台机器上有好几个 Python，
     PATH 里那个未必装了它 —— 直接跑会甩一段 traceback 出来，
     看不出该修什么。所以先挨个试 `import paramiko`，挑一个能用的。 */
  const py = pickPython()
  if (!py) {
    problems.push(
      '找不到装了 paramiko 的 Python。装一下再重跑：\n' +
        '      D:\\soft\\python\\python.exe -m pip install paramiko\n' +
        '      $env:NOTA_PYTHON="D:\\soft\\python\\python.exe"; $env:NOTA_PASS="…"; node scripts/ship.mjs --from=6',
    )
    return false
  }
  console.log(`  用 ${py} 跑部署脚本`)
  const code = run(py, [path.join('deploy', 'remote-deploy.py')])
  if (code !== 0) {
    problems.push('官网部署失败（上面有原话）。网络好了单独重跑：node scripts/ship.mjs --from=6')
    return false
  }
  return true
}

/** WorkBuddy 自带的解释器里预装了 paramiko，是这台机器上最可能直接能用的那个。
    路径带版本号，按版本倒序排，将来升级也不用改代码。 */
function bundledPythons() {
  const base = path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'versions')
  try {
    return fs
      .readdirSync(base)
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      .map((v) => path.join(base, v, 'python.exe'))
      .filter((p) => fs.existsSync(p))
  } catch {
    return []
  }
}

/** 候选顺序：NOTA_PYTHON > WorkBuddy 自带的 > PATH 里的 python > D:\soft\python > py 启动器
    判据只有一条：能 `import paramiko` 才算数，别的一概不看。 */
function pickPython() {
  const seen = new Set()
  const cands = [
    process.env.NOTA_PYTHON,
    ...bundledPythons(),
    'python',
    'D:\\soft\\python\\python.exe',
    'py',
  ].filter((p) => p && !seen.has(p) && seen.add(p))
  for (const p of cands) {
    const r = spawnSync(p, ['-c', 'import paramiko'], { cwd: root, encoding: 'utf8' })
    if (!r.error && r.status === 0) return p
  }
  return null
}

/* ── 7. 清垃圾 ──
   .trash 是 clean.mjs / release.mjs 用「改名代替删除」攒下来的历史构建目录，
   每 build 一次多一份，几百 MB 且永远不会自己消失。
   _nota-tmp 是早先做导出测试时挪到桌面上的临时工程，跟项目无关。
   这些都是本项目自己的中间产物，不动任何用户数据。 */
function stepClean() {
  const targets = [
    path.join(root, '.trash'),
    path.join(root, '.bundle-stage'),
    path.join(root, 'Desktop'),
    path.join(os.homedir(), 'Desktop', '_nota-tmp'),
  ]
  // 历史部署包：只留最新那份（等下也要删，官网已经拿到手了）
  const releaseDir = path.join(root, 'release')
  if (fs.existsSync(releaseDir)) {
    const tgz = fs
      .readdirSync(releaseDir)
      .filter((name) => /^nota-site-.*\.tgz$/.test(name))
      .map((name) => path.join(releaseDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    /* 官网没部署成功就先留着最新那份包 —— 重跑 --from=6 时 remote-deploy.py
       会自动挑最新的 tgz，删早了就得重打一遍。 */
    for (const p of problems.length ? tgz.slice(1) : tgz) targets.push(p)
  }
  // 验证脚本留下的临时浏览器 profile
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('.tmp-cdp-') || name.startsWith('.tmp-')) targets.push(path.join(root, name))
  }

  let freed = 0
  for (const p of targets) {
    if (!fs.existsSync(p)) continue
    let size = 0
    try {
      size = byteSize(p)
    } catch {
      /* 算不出来就按 0 记，照样删 */
    }
    try {
      fs.rmSync(p, { recursive: true, force: true })
      freed += size
      console.log(`  ✓ 删掉 ${rel(p)}  ${size ? mb(size) : ''}`)
    } catch (e) {
      console.log(`  ⚠ 删不掉 ${rel(p)}：${e.message}`)
    }
  }
  if (!freed) console.log('  没有要删的')
  else console.log(`  共释放 ${mb(freed)}`)
}

function byteSize(p) {
  const st = fs.lstatSync(p)
  if (!st.isDirectory()) return st.size
  let sum = 0
  for (const name of fs.readdirSync(p)) {
    try {
      sum += byteSize(path.join(p, name))
    } catch {
      /* 权限/长路径读不到就跳过 */
    }
  }
  return sum
}

/* ── 跑 ── */

const STEPS = [
  [1, '打包', stepPack],
  [2, '验产物', stepVerify],
  [3, '官网部署包', stepBundle],
  [4, '提交', stepCommit],
  [5, '推 GitHub', stepPublish],
  [6, '更新官网', stepDeploy],
  [7, '清垃圾', stepClean],
]

console.log(`\nNota ${VERSION} 发版${FROM > 1 ? `（从第 ${FROM} 步开始）` : ''}`)

for (const [n, title, fn] of STEPS) {
  if (n < FROM) continue
  if (n === 6 && SKIP_DEPLOY) {
    console.log(`\n── 6. 更新官网 ──\n  按 --skip-deploy 跳过`)
    continue
  }
  if (n === 7 && SKIP_CLEAN) {
    console.log(`\n── 7. 清垃圾 ──\n  按 --skip-clean 跳过`)
    continue
  }
  console.log(`\n── ${n}. ${title} ──`)
  fn()
}

console.log('\n════ 结果 ════')
console.log(`  版本       ${VERSION}`)
console.log(`  安装包     ${fs.existsSync(EXE) ? `${EXE_NAME}  ${mb(fs.statSync(EXE).size)}` : '不在'}`)
console.log(`  便携版     ${fs.existsSync(PORTABLE) ? `${PORTABLE_NAME}  ${mb(fs.statSync(PORTABLE).size)}` : '不在'}`)
if (problems.length) {
  console.log('')
  for (const p of problems) console.log(`  ! ${p}`)
  process.exit(1)
}
console.log('  全部完成')
