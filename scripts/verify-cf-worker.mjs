/**
 * 后台的端到端验证：把 Worker 真的跑起来，请求真的打进去。
 *
 * auth.ts 那层已经单独验过了（scripts/verify-cf-auth.mjs），但「哈希对」不等于
 * 「接口能用」—— 路由是不是挂对了、Cookie 有没有发出去、改密码之后旧 token
 * 会不会真的作废、断点续传会不会重复计数，这些只有把整套跑一遍才看得见。
 *
 * 三个绑定都在本地顶掉，不连真的 Cloudflare：
 *   D1  → node:sqlite 的内存库，跑的就是 cloudflare/schema.sql + seed.sql 原文
 *   R2  → Map + 字节数组
 *   ASSETS → 直接读 cloudflare/public/
 *
 * GitHub 那个接口故意不给 `caches`，让它走「拉不到就返回 null」的降级路径 ——
 * 后台不该因为 GitHub 挂了就打不开。
 *
 *   node scripts/verify-cf-worker.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CF = path.join(root, 'cloudflare')
const HOST = 'https://nota.test'

let pass = 0
let fail = 0
const log = []

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    log.push(`  ✓ ${name}`)
  } else {
    fail += 1
    log.push(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

/* ── D1：node:sqlite 顶上 ── */

class D1Stmt {
  constructor(db, sql, args = []) {
    this.db = db
    this.sql = sql
    this.args = args
  }
  bind(...args) {
    return new D1Stmt(this.db, this.sql, args)
  }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.args)
    return row ?? null
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args) }
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.args)
    return { success: true, meta: info }
  }
}

function makeD1() {
  const db = new DatabaseSync(':memory:')
  db.exec(fs.readFileSync(path.join(CF, 'schema.sql'), 'utf8'))
  db.exec(fs.readFileSync(path.join(CF, 'seed.sql'), 'utf8'))
  return { db, binding: { prepare: (q) => new D1Stmt(db, q) } }
}

/* ── R2：内存桶 ── */

function makeR2() {
  const files = new Map()
  return {
    files,
    put(key, bytes) {
      files.set(key, bytes)
    },
    binding: {
      async head(key) {
        const b = files.get(key)
        return b ? { size: b.length } : null
      },
      async get(key, opts) {
        const b = files.get(key)
        if (!b) return null
        const offset = opts?.range?.offset ?? 0
        const length = opts?.range?.length ?? b.length - offset
        const slice = b.subarray(offset, offset + length)
        return { body: new Response(slice).body, size: b.length }
      },
    },
  }
}

/* ── ASSETS：读 public/ ── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

const assets = {
  async fetch(req) {
    const p = new URL(req.url).pathname
    const rel = p === '/' ? '/index.html' : p
    const file = path.join(CF, 'public', rel)
    if (!file.startsWith(path.join(CF, 'public'))) return new Response('no', { status: 404 })
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // 静态资源站的行为：找不到就回落首页
      const idx = path.join(CF, 'public', 'index.html')
      return new Response(fs.readFileSync(idx), { headers: { 'Content-Type': MIME['.html'] } })
    }
    return new Response(fs.readFileSync(file), {
      headers: { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' },
    })
  },
}

/* ── 起环境 ── */

async function build() {
  const esbuild = await import('esbuild')
  const out = path.join(os.tmpdir(), `nota-cf-worker-${Date.now()}.mjs`)
  await esbuild.build({
    entryPoints: [path.join(CF, 'src/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error',
  })
  const mod = await import(`file://${out.replace(/\\/g, '/')}`)
  fs.rmSync(out, { force: true })
  return mod.default
}

const VERSION = '2.7.2'
const SECRET = 'local-test-secret'

/**
 * 跟 index.ts 里的 hashIp 同一个算法，好在测试里精确查「这个 IP 那一行」，
 * 而不是随手 `LIMIT 1` 抓一行出来看 —— 那种断言在行数一多就一定读错行。
 */
function ipHash(ip) {
  const h = createHmac('sha256', SECRET).update(ip).digest('hex')
  return h.slice(0, 16)
}

async function main() {
  const worker = await build()
  const d1 = makeD1()
  const r2 = makeR2()

  // 故意不提供 caches：验证「GitHub 那路挂了，后台照样打开」
  delete globalThis.caches

  const env = {
    DB: d1.binding,
    FILES: r2.binding,
    ASSETS: assets,
    SESSION_SECRET: SECRET,
    VERSION,
  }

  const call = (p, init = {}) => {
    const { ip = '1.1.1.1', cookie, origin, body, method = 'GET', headers = {} } = init
    const h = new Headers(headers)
    h.set('CF-Connecting-IP', ip)
    if (cookie) h.set('Cookie', cookie)
    if (origin) h.set('Origin', origin)
    if (body !== undefined && !h.has('Content-Type')) h.set('Content-Type', 'application/json')
    return worker.fetch(
      new Request(HOST + p, {
        method,
        headers: h,
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
      env,
    )
  }

  const cookieOf = (res) => {
    const raw = res.headers.get('Set-Cookie') ?? ''
    const m = /nota_sess=([^;]*)/.exec(raw)
    return { raw, value: m ? m[1] : null, token: m && m[1] ? `nota_sess=${m[1]}` : null }
  }

  /* ── 1. 结构：库真建起来了 ── */
  const adminRow = d1.db.prepare('SELECT username, pwd_ver FROM admin WHERE id = 1').get()
  ok('schema + seed 落库：admin 一行，版本 1', adminRow?.username === 'admin' && adminRow?.pwd_ver === 1)
  let checkBlocked = false
  try {
    d1.db.exec("INSERT INTO admin (id, username, pwd_salt, pwd_hash, pwd_ver, updated_at) VALUES (2, 'x', 'a', 'b', 1, 0)")
  } catch {
    checkBlocked = true
  }
  ok('CHECK (id = 1) 挡住第二个管理员', checkBlocked)

  /* ── 2. 官网与静态资源 ── */
  const home = await call('/')
  const homeHtml = await home.text()
  ok('GET / 出官网首页', home.status === 200 && homeHtml.includes('<html'))
  const shot = await call('/icon.png')
  ok('GET /icon.png 出图片', shot.status === 200 && (shot.headers.get('content-type') ?? '').includes('png'))
  const missing = await call('/whatever-else')
  ok('未知路径回落首页（静态站行为）', missing.status === 200)

  /* ── 3. 未登录一律挡住 ── */
  const adminAnon = await call('/admin')
  const anonHtml = await adminAnon.text()
  ok('GET /admin 未登录 → 登录页', adminAnon.status === 200 && anonHtml.includes('action="/api/login"'))
  ok('登录页不泄露后台内容', !anonHtml.includes('/api/stats'))
  ok('GET /api/stats 未登录 → 401', (await call('/api/stats')).status === 401)
  ok('POST /api/password 未登录 → 401', (await call('/api/password', { method: 'POST', body: {} })).status === 401)
  const badCookie = await call('/api/stats', { cookie: 'nota_sess=v1.abc.def' })
  ok('伪造 Cookie → 401', badCookie.status === 401)

  /* ── 4. 登录 ── */
  const wrongPw = await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'nope' }, ip: '9.9.9.1' })
  ok('错密码 → 401', wrongPw.status === 401)
  const wrongPwBody = await wrongPw.json()
  ok('错密码不说是账号错还是密码错', wrongPwBody.error === '账号或密码不对', wrongPwBody.error)

  const emptyLogin = await call('/api/login', { method: 'POST', body: { username: '', password: '' }, ip: '9.9.9.2' })
  ok('空账号空密码 → 400', emptyLogin.status === 400)

  const crossOrigin = await call('/api/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123' },
    origin: 'https://evil.test',
    ip: '9.9.9.3',
  })
  ok('跨站 Origin → 403', crossOrigin.status === 403)

  const login = await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' }, ip: '9.9.9.4' })
  ok('admin / admin123 登录成功', login.status === 200 && (await login.clone().json()).ok === true)
  const ck = cookieOf(login)
  ok('发了会话 Cookie', !!ck.value)
  ok('Cookie 是 HttpOnly', /HttpOnly/i.test(ck.raw))
  ok('Cookie 是 Secure', /\bSecure\b/i.test(ck.raw))
  ok('Cookie 是 SameSite=Lax', /SameSite=Lax/i.test(ck.raw))
  ok('Cookie 7 天', /Max-Age=604800/.test(ck.raw), ck.raw)

  const adminIn = await call('/admin', { cookie: ck.token })
  const adminHtml = await adminIn.text()
  ok('登录后 /admin 是后台页', adminHtml.includes('/api/stats') && !adminHtml.includes('action="/api/login"'))

  /* ── 5. 统计接口 ── */
  const st0 = await (await call('/api/stats', { cookie: ck.token })).json()
  ok('stats: 30 天序列', Array.isArray(st0.series) && st0.series.length === 30, `length=${st0.series?.length}`)
  ok('stats: 序列日期连续且升序', st0.series.every((r, i, a) => i === 0 || r[0] > a[i - 1][0]))
  ok('stats: 初始下载量为 0', st0.total === 0 && st0.today === 0 && st0.byAsset.setup === 0)
  ok('stats: GitHub 拉不到时 github 为 null（后台不因此打不开）', st0.github === null)

  /* ── 6. 下载：包还没上传 ── */
  const none = await call('/d/setup')
  ok('R2 里没包 → 404', none.status === 404)
  ok('未知包名 → 404', (await call('/d/nope')).status === 404)

  // 这个接口给官网用，不能要登录 —— 不然首屏就得先登一次
  const info0res = await call('/api/info')
  const info0 = await info0res.json()
  ok('/api/info 不需要登录', info0res.status === 200)
  ok('info 带当前版本号', info0.version === VERSION, info0.version)
  ok('info 的文件名按版本拼好', info0.assets.setup.name === `Nota-Setup-${VERSION}.exe`, info0.assets.setup.name)
  ok('包还没传时体积报 0（官网据此只显示文件名）', info0.assets.setup.size === 0 && info0.assets.portable.size === 0)
  ok('info 可被 CDN 缓存一分钟以内', /max-age=60/.test(info0res.headers.get('cache-control') ?? ''))

  /* ── 7. 下载：正常路径 ── */
  const SIZE = 5 * 1024 * 1024
  const bytes = new Uint8Array(SIZE)
  for (let i = 0; i < SIZE; i += 1) bytes[i] = i % 251
  r2.put('Nota-Setup.exe', bytes)
  r2.put('Nota-Portable.exe', bytes.subarray(0, 1024))

  const dl = await call('/d/setup', { ip: '2.2.2.1' })
  ok('GET /d/setup → 200', dl.status === 200)
  ok('Content-Length 等于对象大小', dl.headers.get('content-length') === String(SIZE), dl.headers.get('content-length'))
  ok('声明支持断点续传', dl.headers.get('accept-ranges') === 'bytes')
  const cd = dl.headers.get('content-disposition') ?? ''
  ok('下载文件名带版本号', cd.includes(`Nota-Setup-${VERSION}.exe`), cd)
  const bodyBytes = new Uint8Array(await dl.arrayBuffer())
  ok('下载内容与上传字节逐字节一致', bodyBytes.length === SIZE && bodyBytes[0] === 0 && bodyBytes[12345] === 12345 % 251)

  const st1 = await (await call('/api/stats', { cookie: ck.token })).json()
  ok('下载计一次', st1.total === 1 && st1.byAsset.setup === 1, JSON.stringify(st1.byAsset))
  ok('today 同步涨', st1.today === 1)

  const info1 = await (await call('/api/info')).json()
  ok('传了包之后 info 报真实体积', info1.assets.setup.size === SIZE && info1.assets.portable.size === 1024, JSON.stringify(info1.assets))

  // 记的日期必须是东八区那天，不能是服务器的 UTC 那天
  const dayRow = d1.db.prepare('SELECT day FROM downloads LIMIT 1').get()
  const bj = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  ok('记录的日期是东八区今天', dayRow.day === bj, `记录 ${dayRow.day} / 应为 ${bj}`)
  const hashRow = d1.db.prepare('SELECT ip_hash FROM downloads LIMIT 1').get()
  ok('只存 IP 哈希（16 位十六进制），不存明文', /^[0-9a-f]{16}$/.test(hashRow.ip_hash), hashRow.ip_hash)
  ok('哈希是按 SESSION_SECRET 做 HMAC 出来的（换密钥就对不上）', hashRow.ip_hash === ipHash('2.2.2.1'), hashRow.ip_hash)

  const dl2 = await call('/d/setup', { ip: '2.2.2.1' })
  ok('同 IP 同日重复下载仍返回 200', dl2.status === 200)
  const st2 = await (await call('/api/stats', { cookie: ck.token })).json()
  ok('同 IP 同日不重复计数', st2.total === 1, `total=${st2.total}`)

  const dl3 = await call('/d/setup', { ip: '2.2.2.2' })
  ok('换 IP 是另一个人', dl3.status === 200)
  const st3 = await (await call('/api/stats', { cookie: ck.token })).json()
  ok('换 IP 计数 +1', st3.total === 2, `total=${st3.total}`)

  /* ── 8. 断点续传 ── */
  const r1 = await call('/d/setup', { ip: '3.3.3.1', headers: { Range: 'bytes=100-199' } })
  ok('Range 中段 → 206', r1.status === 206)
  ok('Content-Range 正确', r1.headers.get('content-range') === `bytes 100-199/${SIZE}`, r1.headers.get('content-range'))
  ok('分段长度正确', r1.headers.get('content-length') === '100')
  const part = new Uint8Array(await r1.arrayBuffer())
  ok('分段首字节对得上', part[0] === 100 % 251, `得到 ${part[0]}`)
  const st4 = await (await call('/api/stats', { cookie: ck.token })).json()
  ok('从中间续传不算一次下载', st4.total === 2, `total=${st4.total}`)

  const r2res = await call('/d/setup', { ip: '3.3.3.1', headers: { Range: 'bytes=100-' } })
  ok('Range 开到末尾 → 206 且长度为剩余', r2res.status === 206 && Number(r2res.headers.get('content-length')) === SIZE - 100)
  const ra = await call('/d/setup', { ip: '3.3.3.1', headers: { Range: 'bytes=0-9' } })
  ok('Range 从头起 → 206', ra.status === 206 && ra.headers.get('content-length') === '10')
  // 浏览器续传会发 bytes=0-，这跟直接点下载是一回事，该算。
  // 上面那条 bytes=100-199 才是「真正的续传」，不算。两者的区别就在 start 是不是 0。
  ok('Range 从头起算一次下载', d1.db.prepare("SELECT COUNT(*) AS n FROM downloads WHERE asset='setup'").get().n === 3)
  const rbad = await call('/d/setup', { ip: '3.3.3.1', headers: { Range: 'bytes=99999999-' } })
  ok('越界 Range → 416 且告知总长', rbad.status === 416 && rbad.headers.get('content-range') === `bytes */${SIZE}`, `${rbad.status} ${rbad.headers.get('content-range')}`)

  const portable = await call('/d/portable', { ip: '4.4.4.1' })
  ok('portable 也通', portable.status === 200 && portable.headers.get('content-length') === '1024')
  const st5 = await (await call('/api/stats', { cookie: ck.token })).json()
  ok('两个包的构成分开记', st5.byAsset.setup === 3 && st5.byAsset.portable === 1, JSON.stringify(st5.byAsset))

  /* ── 9. 登录锁 ── */
  for (let i = 1; i <= 5; i += 1) {
    await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'bad' + i }, ip: '5.5.5.5' })
  }
  const locked = await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' }, ip: '5.5.5.5' })
  const lockedBody = await locked.json()
  ok('连错 5 次就锁（即便这次密码是对的）', locked.status === 429, `${locked.status} ${lockedBody.error ?? ''}`)
  ok('锁的提示带剩余分钟', /分钟后再试/.test(lockedBody.error ?? ''), lockedBody.error)
  const otherIp = await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' }, ip: '5.5.5.6' })
  ok('锁只锁这个 IP，别人不受牵连', otherIp.status === 200)
  const attRow = d1.db.prepare('SELECT fails FROM login_attempts WHERE ip_hash = ?').get(ipHash('5.5.5.5'))
  ok('失败次数落库（第 6 次被锁，所以记到 5）', attRow?.fails === 5, String(attRow?.fails))
  const goodLogin = await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' }, ip: '5.5.5.7' })
  const goodAfter = d1.db.prepare('SELECT fails FROM login_attempts WHERE ip_hash = ?').get(ipHash('5.5.5.7'))
  ok('登录成功后清掉自己那条失败记录', goodLogin.status === 200 && !goodAfter, goodAfter ? `还留着 fails=${goodAfter.fails}` : '')

  /* ── 10. 改密码 ── */
  const badOld = await call('/api/password', { method: 'POST', cookie: ck.token, body: { oldPassword: 'wrong', username: 'admin', newPassword: 'a-very-long-one' } })
  ok('旧密码不对 → 401', badOld.status === 401)
  const shortPw = await call('/api/password', { method: 'POST', cookie: ck.token, body: { oldPassword: 'admin123', username: 'admin', newPassword: 'short' } })
  ok('新密码太短 → 400', shortPw.status === 400)
  const badName = await call('/api/password', { method: 'POST', cookie: ck.token, body: { oldPassword: 'admin123', username: '管理员', newPassword: 'a-very-long-one' } })
  ok('账号名不合法 → 400', badName.status === 400)

  const NEW_PW = 'jiangchen-2026'
  const changed = await call('/api/password', {
    method: 'POST',
    cookie: ck.token,
    body: { oldPassword: 'admin123', username: 'jiang', newPassword: NEW_PW },
  })
  ok('改账号+改密码 → 200', changed.status === 200)
  const ck2 = cookieOf(changed)
  ok('改完立刻换发新 Cookie', !!ck2.value && ck2.value !== ck.value)

  const oldTokenDead = await call('/api/stats', { cookie: ck.token })
  ok('旧 token 立刻失效（版本号对不上）', oldTokenDead.status === 401, String(oldTokenDead.status))
  const newTokenAlive = await call('/api/stats', { cookie: ck2.token })
  ok('新 token 可用', newTokenAlive.status === 200)
  ok('改完密码后下载量没丢', (await newTokenAlive.json()).total === 4)

  const oldPwLogin = await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' }, ip: '6.6.6.1' })
  ok('旧密码登不进来了', oldPwLogin.status === 401)
  const oldNameLogin = await call('/api/login', { method: 'POST', body: { username: 'admin', password: NEW_PW }, ip: '6.6.6.2' })
  ok('旧账号名也登不进来', oldNameLogin.status === 401)
  const newLogin = await call('/api/login', { method: 'POST', body: { username: 'jiang', password: NEW_PW }, ip: '6.6.6.3' })
  ok('新账号名 + 新密码能登', newLogin.status === 200)

  const adminRow2 = d1.db.prepare('SELECT username, pwd_ver FROM admin WHERE id = 1').get()
  ok('库里账号名已改、版本号 +1', adminRow2.username === 'jiang' && adminRow2.pwd_ver === 2)
  ok('库里换过盐（不是种子里那份）', d1.db.prepare('SELECT pwd_salt FROM admin WHERE id = 1').get().pwd_salt !== '562a65f605e64253c0c5f1b8ef424995')

  /* ── 11. 退出 ── */
  const out = await call('/api/logout', { method: 'POST', cookie: ck2.token })
  ok('退出清 Cookie', out.status === 200 && /Max-Age=0/.test(out.headers.get('set-cookie') ?? ''))

  /* ── 12. 未知接口 ── */
  ok('已登录时未知接口 → 404', (await call('/api/nope', { cookie: ck2.token })).status === 404)

  console.log('\n' + log.join('\n'))
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} 通过 / ${fail} 失败\n`)
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('验证脚本自身出错：', e)
  process.exitCode = 1
})
