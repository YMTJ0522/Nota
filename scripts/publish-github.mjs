/**
 * 发版一条龙：推代码 → 打 tag → 建 Release → 传两个 exe → 推官网到 gh-pages。
 *
 * 为什么要有它：本机的出网代理对 GitHub 的 CONNECT 一律返回 502，
 * 手工发版每次都要重练一遍那串 API 调用（还容易把令牌贴错地方），
 * 所以把它固化下来。每一步都可单独重跑 —— 失败的会自动跳过、成功的也能重来。
 *
 *   node scripts/publish-github.mjs              # 全跑
 *   node scripts/publish-github.mjs --no-push    # 网络已通但只想发包
 *   node scripts/publish-github.mjs --dry        # 只打印要做什么
 *
 * 令牌走 `git credential fill` 取，**不落任何文件**，也不出现在命令行参数里
 * （通过 curl 的 --config - 从 stdin 喂进去）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const NO_PUSH = argv.includes('--no-push')
const REPO = 'YMTJ0522/Nota'

/* ── 读版本与 Release 文案 ── */
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const VERSION = pkg.version
const TAG = `v${VERSION}`

const NOTES = fs
  .readFileSync(path.join(root, 'release-notes.md'), 'utf8')
  .replace(/^#.*$/m, '') // 去掉 H1，标题由 API 自己写
  .trim()

/* 2.7.5 起只有一个产物：同一个 exe 既能装到本机，也能直接运行。
   以前那两个（Setup / Portable）留给旧版本，新版本不再产。
   只传确实存在的文件 —— 列了却没有会在上传那步报 404。 */
const FILES = [
  { name: `Nota-Setup-${VERSION}.exe`, file: `release/Nota-Setup-${VERSION}.exe` },
  { name: `Nota-Portable-${VERSION}.exe`, file: `release/Nota-Portable-${VERSION}.exe` },
].filter((f) => fs.existsSync(path.join(root, f.file)))

const run = (cmd, args, opts = {}) => {
  console.log(`  $ ${cmd} ${args.join(' ')}`)
  if (DRY) return { code: 0, out: '' }
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** curl 的通用底噪：本机出网有 MITM 代理，不开 --ssl-no-revoke 会卡在证书吊销检查 */
const CURL = ['curl', '-sS', '--ssl-no-revoke', '--max-time', '900']

/** 令牌经 stdin 喂给 curl，避免出现在 ps / 命令行里 */
function curlWithToken(args, token) {
  if (DRY) {
    console.log(`  $ curl [token via stdin] ${args.join(' ')}`)
    return { code: 0, out: '{}' }
  }
  const cfg = [
    `-H "Authorization: Bearer ${token}"`,
    '-H "Accept: application/vnd.github+json"',
    '-H "X-GitHub-Api-Version: 2022-11-28"',
  ].join('\n')
  const r = spawnSync(CURL[0], [...CURL.slice(1), '--config', '-', ...args], {
    cwd: root,
    encoding: 'utf8',
    input: cfg + '\n',
  })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const step = (title, fn) => {
  console.log(`\n── ${title} ──`)
  return fn()
}

/* ── 0. 前置检查 ── */
console.log(`Nota ${VERSION} 发版 → ${REPO}`)
const missing = FILES.filter((f) => !fs.existsSync(path.join(root, f.file)))
if (missing.length) {
  console.error('安装包不在，先 `npm run pack`：')
  for (const m of missing) console.error(`  缺 ${m.file}`)
  process.exit(1)
}
for (const f of FILES) {
  const mb = (fs.statSync(path.join(root, f.file)).size / 1048576).toFixed(1)
  console.log(`  ✓ ${f.name}  ${mb} MB`)
}
if (!fs.existsSync(path.join(root, 'release-notes.md'))) {
  console.error('缺 release-notes.md（Release 正文）')
  process.exit(1)
}

/* ── 1. 令牌 ── */
let TOKEN = ''
if (!DRY) {
  const cred = spawnSync('git', ['credential', 'fill'], {
    cwd: root,
    encoding: 'utf8',
    input: 'protocol=https\nhost=github.com\n\n',
  })
  TOKEN = /password=(.*)/.exec(cred.stdout ?? '')?.[1]?.trim() ?? ''
  if (!TOKEN) {
    console.error('取不到令牌：`git credential fill` 里没有 github.com 的凭据')
    process.exit(1)
  }
  console.log('\n── 令牌 ──\n  ✓ 已从 git credential 读取')
}

/* ── 2. 推代码 ── */
if (!NO_PUSH) {
  step('推 main', () => {
    const r = run('git', ['push', 'origin', 'HEAD'])
    if (r.code !== 0) {
      console.error('  推送失败：', r.out.trim().split('\n')[0])
      console.error('  多半是出网代理挡了 GitHub（CONNECT tunnel failed, response 502）。')
      console.error('  换个网络再跑一遍，或先挂代理；本脚本可以重跑，已完成的部分会自己跳过。')
      process.exit(1)
    }
  })
}

/* ── 3. 建 Release ── */
let releaseId = null
step(`建 Release ${TAG}`, () => {
  const body = JSON.stringify({
    tag_name: TAG,
    name: `Nota ${VERSION}`,
    body: NOTES,
    draft: false,
    prerelease: false,
  })
  const payloadPath = path.join(root, '.tmp-release-body.json')
  fs.writeFileSync(payloadPath, body)
  const r = curlWithToken(
    [
      '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '--data-binary', `@${payloadPath}`,
      `https://api.github.com/repos/${REPO}/releases`,
    ],
    TOKEN,
  )
  try { fs.unlinkSync(payloadPath) } catch { /* 无所谓 */ }
  let rel = null
  try { rel = JSON.parse(r.out) } catch { /* 下面统一报错 */ }
  /* 422 already_exists：上一次其实建成功了，只是响应被代理吞掉（本机会这样），
     重跑时不该当成失败。改为按 tag 取回那条 Release 接着传包。 */
  if (!DRY && (!rel || !rel.id) && /already_exists/.test(r.out || '')) {
    const g = curlWithToken(
      [`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`],
      TOKEN,
    )
    try { rel = JSON.parse(g.out) } catch { /* 下面统一报错 */ }
    if (rel?.id) console.log(`  Release ${TAG} 已存在，改为续传安装包`)
  }
  if (!DRY && (!rel || !rel.id)) {
    console.error('  建 Release 失败：', (r.out || '').trim().slice(0, 300))
    process.exit(1)
  }
  releaseId = rel?.id ?? null
  console.log(`  ${DRY ? '（dry）' : `✓ https://github.com/${REPO}/releases/tag/${TAG}`}`)
})

/* ── 4. 传安装包 ── */
step('传安装包', () => {
  /* 传之前先看这条 Release 上已经有哪几个文件：重跑时同名再传一遍会 422，
     而脚本要能反复重跑。同名且大小一致的直接跳过。 */
  let existing = []
  if (!DRY && releaseId) {
    const g = curlWithToken(
      [`https://api.github.com/repos/${REPO}/releases/${releaseId}/assets`],
      TOKEN,
    )
    try {
      const arr = JSON.parse(g.out)
      if (Array.isArray(arr)) existing = arr
    } catch { /* 取不到就当空的，后面照传 */ }
  }

  for (const f of FILES) {
    const size = fs.statSync(path.join(root, f.file)).size
    const hit = existing.find((a) => a.name === f.name)
    if (hit) {
      /* state 必须是 uploaded 才算数。上传被中断（代理断在半路）时，
         GitHub 会把这条记录留下，state 停在 starter、size 却是最终大小 ——
         光比大小会误判成「已经传好了」。这种要先删掉再传。 */
      const done = hit.state === 'uploaded' && Number(hit.size) === size
      if (done) {
        console.log(`  已传过 ${f.name}（${(hit.size / 1048576).toFixed(1)} MB），跳过`)
        continue
      }
      console.log(`  ${f.name} 上次没传完（state=${hit.state}），删掉重传`)
      const d = curlWithToken(
        ['-X', 'DELETE', `https://api.github.com/repos/${REPO}/releases/assets/${hit.id}`],
        TOKEN,
      )
      if (d.code !== 0) {
        console.error(`  删旧资源失败：`, (d.out || '').trim().slice(0, 200))
        process.exit(1)
      }
    }
    const url = `https://uploads.github.com/repos/${REPO}/releases/${
      releaseId ?? 'LATEST'
    }/assets?name=${f.name}`
    const r = curlWithToken(
      [
        '-X', 'POST',
        '-H', 'Content-Type: application/octet-stream',
        '--data-binary', `@${f.file}`,
        url,
      ],
      TOKEN,
    )
    if (!DRY && r.code !== 0) {
      console.error(`  ${f.name} 上传失败：`, (r.out || '').trim().slice(0, 300))
      process.exit(1)
    }
    console.log(`  ${DRY ? '（dry）' : '✓'} ${f.name}`)
  }
})

/* ── 5. 官网 ── */
if (!NO_PUSH) {
  step('推官网到 gh-pages', () => {
    if (DRY) {
      console.log('  （dry）会重建 site 的内容树并直接推到 gh-pages')
      return
    }
    /* 不用 git subtree push：本机跑 split 必卡死（几分钟后 SIGTERM），
       换成「临时索引 → 写树 → 造提交 → 直接推」，秒过。
       索引必须给绝对路径，否则会被解析到 --work-tree 里面去。 */
    const idx = path.join(root, '.git', 'ghp-index')
    const env = { ...process.env, GIT_INDEX_FILE: idx }
    const git = (args) => {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env })
      if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim().split('\n').pop())
      return (r.stdout || '').trim()
    }

    fs.rmSync(idx, { force: true })
    try {
      git(['--work-tree=site', 'add', '-A', '.'])
      const tree = git(['write-tree'])
      git(['fetch', '-f', 'origin', 'gh-pages:refs/tmp/ghp'])
      const parent = git(['rev-parse', 'refs/tmp/ghp'])
      const commit = git(['commit-tree', tree, '-p', parent, '-m', `官网 ${TAG}`])
      const r = spawnSync('git', ['push', 'origin', `${commit}:refs/heads/gh-pages`], {
        cwd: root,
        encoding: 'utf8',
      })
      if (r.status !== 0) {
        console.error('  失败：', (r.stderr || '').trim().split('\n').pop())
        console.error('  代码与 Release 都已完成，只差官网；网络好一点再单独跑这一步即可。')
        process.exit(1)
      }
      console.log(`  ✓ ${commit.slice(0, 7)} → gh-pages`)
    } finally {
      spawnSync('git', ['update-ref', '-d', 'refs/tmp/ghp'], { cwd: root })
      fs.rmSync(idx, { force: true })
    }
  })
}

console.log(
  `\n完成。下载页会自动取到 ${TAG} 的安装包直链；` +
    'GitHub Pages 生效要一两分钟，之后再刷新官网。',
)
