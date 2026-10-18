/**
 * 把官网 + 下载 + 后台部署到 Cloudflare。
 *
 * 为什么要有这个脚本：这套东西一共有六步（建库、建表、种管理员、建桶、
 * 传两个安装包、发版），漏一步的表现都很隐蔽 ——
 * 忘了建表就是登录时 500，忘了传包就是「点了下载没反应」，
 * 忘了种管理员就是永远登不进去。一步一步手敲，第二次就敲漏。
 *
 *   node scripts/cf-deploy.mjs --dry      # 只打印要做什么，不动手
 *   node scripts/cf-deploy.mjs            # 真的做
 *   node scripts/cf-deploy.mjs --force-secret  # 重新生成会话密钥（会让所有人掉线）
 *
 * 前置：`npx wrangler login`（或者设好 CLOUDFLARE_API_TOKEN）。这个登录
 * 只能你自己做 —— 账号是你的，令牌不该经过别人的手。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CF = path.join(root, 'cloudflare')
const TOML = path.join(CF, 'wrangler.toml')

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const FORCE_SECRET = argv.includes('--force-secret')

let step = 0
const say = (s) => console.log(`\n\x1b[36m[${++step}]\x1b[0m ${s}`)
const note = (s) => console.log(`    \x1b[2m${s}\x1b[0m`)
const good = (s) => console.log(`    \x1b[32m✓\x1b[0m ${s}`)
const warn = (s) => console.log(`    \x1b[33m!\x1b[0m ${s}`)

/** `npx wrangler ...`：不依赖全局安装，版本跟着项目走 */
function wr(args, { quiet = false, input = null, allowFail = false } = {}) {
  const printable = `npx wrangler ${args.join(' ')}`
  if (DRY) {
    console.log(`    \x1b[2m$\x1b[0m ${printable}`)
    return { ok: true, out: '', dry: true }
  }
  const r = spawnSync('npx', ['wrangler', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    input: input ?? undefined,
    env: { ...process.env, CI: '1' },
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  if (!quiet && out) console.log(out.split('\n').map((l) => '    ' + l).join('\n'))
  if (r.status !== 0 && !allowFail) {
    throw new Error(`命令失败：${printable}\n${out}`)
  }
  return { ok: r.status === 0, out }
}

function fail(msg) {
  console.error(`\n\x1b[31m部署中止\x1b[0m ${msg}\n`)
  process.exit(1)
}

/* ── 读配置 ── */

const toml = fs.readFileSync(TOML, 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const grab = (re) => (re.exec(toml) ?? [])[1] ?? ''
const projectName = grab(/^name\s*=\s*"([^"]+)"/m) || 'nota'
const dbName = grab(/database_name\s*=\s*"([^"]+)"/m) || projectName
let dbId = grab(/database_id\s*=\s*"([^"]+)"/m)
const bucket = grab(/bucket_name\s*=\s*"([^"]+)"/m) || 'nota-downloads'
const routeDomain = grab(/pattern\s*=\s*"([^"]+)"/m)
const cfgVersion = grab(/^VERSION\s*=\s*"([^"]+)"/m)

/* ── 安装包 ── */

function findExe(kind) {
  const dir = path.join(root, 'release')
  if (!fs.existsSync(dir)) return null
  const hits = fs
    .readdirSync(dir)
    .filter((f) => new RegExp(`^Nota-${kind}-.*\\.exe$`, 'i').test(f))
    .map((f) => ({ name: f, file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return hits[0] ?? null
}

async function main() {
  console.log('\x1b[1mNota · Cloudflare 部署\x1b[0m')
  if (DRY) console.log('\x1b[33m（预演模式：只打印命令，不执行）\x1b[0m')

  /* ── 0. 体检 ── */
  say('检查配置和安装包')
  note(`项目 ${projectName} / 库 ${dbName} / 桶 ${bucket}${routeDomain ? ` / 域名 ${routeDomain}` : ''}`)

  if (cfgVersion !== pkg.version) {
    warn(`wrangler.toml 里的 VERSION=${cfgVersion}，package.json 是 ${pkg.version}`)
    note('下载文件名和官网版本号都取 VERSION，发版时两边对一下')
  } else {
    good(`版本号一致：${cfgVersion}`)
  }

  if (!routeDomain || /example\.com/.test(routeDomain)) {
    warn('routes 里还是 nota.example.com —— 换成你自己的域名再跑，否则会发到一个不存在的主机上')
    note('改 cloudflare/wrangler.toml 里 [[routes]] 的 pattern；没有域名就先把这一段删掉，')
    note('发完用默认的 <name>.<账号>.workers.dev 也能访问')
  }

  const setup = findExe('Setup')
  const portable = findExe('Portable')
  for (const [label, f] of [
    ['安装版', setup],
    ['免安装版', portable],
  ]) {
    if (!f) warn(`release/ 里没找到 ${label} 的 .exe —— 这一步会跳过，之后必须补传，否则官网点了没反应`)
    else {
      const mb = (fs.statSync(f.file).size / 1048576).toFixed(1)
      good(`${label}：${f.name}（${mb} MB）`)
      if (cfgVersion && !f.name.includes(cfgVersion)) warn(`这个包名里没有 ${cfgVersion}，可能不是当前版本`)
    }
  }

  /* ── 1. 登录 ── */
  say('确认 Cloudflare 登录状态')
  const who = wr(['whoami'], { quiet: true, allowFail: true })
  if (!DRY && !who.ok) {
    fail('还没登录。先在终端跑一次 `npx wrangler login`（会开浏览器），再回来跑这个脚本。')
  }
  if (!DRY && who.out) console.log(who.out.split('\n').map((l) => '    ' + l).join('\n'))

  /* ── 2. 建库 ── */
  say(`D1 数据库 ${dbName}`)
  if (dbId && dbId !== 'REPLACE_WITH_YOUR_DATABASE_ID') {
    good(`已经建过：${dbId}`)
  } else if (DRY) {
    note('database_id 还是占位符 → 会执行 d1 create，再把返回的 id 写回 wrangler.toml')
    wr(['d1', 'create', dbName])
  } else {
    note('database_id 还是占位符，现在创建')
    const r = wr(['d1', 'create', dbName], { allowFail: true })
    const m = /database_id"?\s*=\s*"([0-9a-f-]{36})"/i.exec(r.out) ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(r.out)
    if (!m) {
      fail(
        '没能从输出里拿到 database_id。\n' +
          '    如果提示「already exists」，去 Cloudflare 面板 D1 页面把这个库的 ID 复制到\n' +
          '    cloudflare/wrangler.toml 的 database_id，再重跑。',
      )
    }
    dbId = m[1]
    fs.writeFileSync(TOML, toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${dbId}"`))
    good(`已建好并写回 wrangler.toml：${dbId}`)
  }

  /* ── 3. 建表 + 种管理员 ── */
  say('建表（schema.sql）')
  wr(['d1', 'execute', dbName, '--remote', '--file=cloudflare/schema.sql'])
  if (!DRY) good('三张表就位')

  say('种管理员账号（seed.sql → admin / admin123）')
  note('这个口令是给你第一次登进去用的，登进去以后请立刻在后台改掉')
  wr(['d1', 'execute', dbName, '--remote', '--file=cloudflare/seed.sql'])
  if (!DRY) good('admin 已写入（版本号 1）')

  /* ── 4. R2 桶 ── */
  say(`R2 存储桶 ${bucket}`)
  const mk = wr(['r2', 'bucket', 'create', bucket], { quiet: true, allowFail: true })
  if (DRY) {
    // 已经打印过
  } else if (mk.ok) {
    good('已创建')
  } else if (/already exists|already owned|10004/i.test(mk.out)) {
    good('已经存在，跳过')
  } else {
    warn('建桶没成功，输出如下：')
    console.log(mk.out.split('\n').map((l) => '    ' + l).join('\n'))
    note('如果账号没开通 R2（要绑卡），后台能登录但没有下载；可以先把安装包留在 GitHub Release。')
  }

  /* ── 5. 会话密钥 ── */
  say('会话密钥 SESSION_SECRET')
  const list = wr(['secret', 'list'], { quiet: true, allowFail: true })
  const hasSecret = /SESSION_SECRET/.test(list.out)
  if (hasSecret && !FORCE_SECRET) {
    good('已经设过，保持不动（换掉会让所有已登录的会话掉线）')
    note('要强制换，加 --force-secret')
  } else {
    const secret = crypto.randomBytes(32).toString('hex')
    if (DRY) {
      console.log(`    \x1b[2m$\x1b[0m npx wrangler secret put SESSION_SECRET`)
      note('（把随机生成的 64 位十六进制通过 stdin 喂进去，不写进任何文件）')
    } else {
      wr(['secret', 'put', 'SESSION_SECRET'], { input: secret + '\n', quiet: true })
      good('已写入（只存在 Cloudflare，脚本里不落地）')
    }
  }

  /* ── 6. 传安装包 ── */
  say('上传安装包到 R2')
  const targets = [
    ['Nota-Setup.exe', setup],
    ['Nota-Portable.exe', portable],
  ]
  for (const [key, f] of targets) {
    if (!f) {
      warn(`跳过 ${key}（没有源文件）`)
      continue
    }
    note(`${f.name} → ${bucket}/${key}`)
    wr(['r2', 'object', 'put', `${bucket}/${key}`, `--file=${path.relative(root, f.file)}`, '--content-type=application/vnd.microsoft.portable-executable', '--remote'])
    if (!DRY) good('传完')
  }

  /* ── 7. 发版 ── */
  say('发布 Worker')
  wr(['deploy'])
  if (!DRY) good('已发布')

  /* ── 结束 ── */
  const host = routeDomain && !/example\.com/.test(routeDomain) ? routeDomain : `${projectName}.<你的账号>.workers.dev`
  console.log(`
\x1b[32m完成\x1b[0m  站点  https://${host}
        后台  https://${host}/admin
        下载  https://${host}/d/setup  ·  https://${host}/d/portable

第一次进去用 \x1b[1madmin / admin123\x1b[0m，然后在后台右上角「改账号密码」里换掉。
新密码要求至少 10 位 —— 默认那 8 位只是为了让你进得去。

自检一遍：\x1b[2mnode scripts/verify-cf-worker.mjs\x1b[0m（本地跑，不连线上）
`)
}

main().catch((e) => fail(e.message))
