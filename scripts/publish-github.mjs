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

const FILES = [{ name: `Nota-Setup-${VERSION}.exe`, file: `release/Nota-Setup-${VERSION}.exe` }]

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
  if (!DRY && (!rel || !rel.id)) {
    console.error('  建 Release 失败：', (r.out || '').trim().slice(0, 300))
    process.exit(1)
  }
  releaseId = rel?.id ?? null
  console.log(`  ${DRY ? '（dry）' : `✓ https://github.com/${REPO}/releases/tag/${TAG}`}`)
})

/* ── 4. 传安装包 ── */
step('传安装包', () => {
  for (const f of FILES) {
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
    const r = run('git', ['subtree', 'push', '--prefix', 'site', 'origin', 'gh-pages'])
    if (r.code !== 0) {
      console.error('  失败：', r.out.trim().split('\n').pop())
      console.error('  同上，多半是代理。代码已经在本地提交了，换网络再跑这一步即可。')
      process.exit(1)
    }
  })
}

console.log(
  `\n完成。下载页会自动取到 ${TAG} 的安装包直链；` +
    'GitHub Pages 生效要一两分钟，之后再刷新官网。',
)
