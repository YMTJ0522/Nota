/**
 * Nota 官网 + 下载 + 后台，一个 Worker 全包。
 *
 * 为什么不分家（Pages 一套、Worker 一套）：/admin 和下载计数都要跟官网同源，
 * 拆开就得处理跨域、两套域名、两处部署。一个 Worker + 静态资源，
 * 域名一个、部署一条命令，出错也只有一个地方要看。
 *
 * 路由：
 *   /              官网（静态资源，边缘直出，不占 Worker 调用）
 *   /d/setup       安装版下载（过 Worker 才记得到数）
 *   /d/portable    免安装版下载
 *   /admin         没登录给登录页，登录了给后台
 *   /api/info      公开：当前版本 + 两个包的体积（官网按钮要用）
 *   /api/login  /api/logout  /api/password  /api/stats
 */

import {
  hashPassword,
  randomHex,
  readSession,
  signSession,
  verifyPassword,
  type SessionPayload,
} from './auth'
import { adminPage, loginPage } from './views'

/* ── 只有这里用到的那几个 Workers 类型，手写一份，不引 @cloudflare/workers-types ── */
interface Stmt {
  bind(...args: unknown[]): Stmt
  first<T = unknown>(): Promise<T | null>
  run(): Promise<unknown>
  all<T = unknown>(): Promise<{ results: T[] }>
}
interface D1 {
  prepare(q: string): Stmt
}
interface R2Obj {
  body: ReadableStream
  size: number
  httpEtag?: string
}
interface R2 {
  get(key: string, opts?: { range?: { offset: number; length?: number } }): Promise<R2Obj | null>
  head(key: string): Promise<{ size: number } | null>
}
interface Env {
  DB: D1
  FILES: R2
  ASSETS: { fetch(r: Request): Promise<Response> }
  SESSION_SECRET: string
  /** 当前版本号，用来拼下载文件名；换版本只改这一个值 */
  VERSION?: string
}
/** Workers 里 `caches.default` 是全局单一缓存，DOM 的 CacheStorage 类型里没这个属性 */
interface EdgeCache {
  match(req: Request): Promise<Response | undefined>
  put(req: Request, res: Response): Promise<void>
}

const COOKIE = 'nota_sess'
const SESSION_DAYS = 7
/** 连错几次锁、锁多久 */
const MAX_FAILS = 5
const LOCK_MS = 15 * 60 * 1000
/** 下载文件名随版本走，R2 里固定存这两个 key */
const ASSETS: Record<string, string> = {
  setup: 'Nota-Setup',
  portable: 'Nota-Portable',
}

/* ── 小工具 ── */

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (req.headers.get('Cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

function setCookie(value: string, maxAge: number): string {
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
}

/** 客户端 IP 只以哈希形式落库：这台机器不需要知道你从哪来，只需要知道别再来试 */
async function hashIp(req: Request, secret: string): Promise<string> {
  const ip = req.headers.get('CF-Connecting-IP') ?? '0.0.0.0'
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip))
  return [...new Uint8Array(sig)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 按东八区算「今天」。服务器是 UTC，直接用 UTC 切日会差八小时 */
function dayKey(ts = Date.now()): string {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 同源校验：POST 只认自己域名发来的。SameSite=Lax 之外再加一道 */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('Origin')
  if (!origin) return true // 某些客户端不带，交给 SameSite 兜
  try {
    return new URL(origin).host === new URL(req.url).host
  } catch {
    return false
  }
}

async function currentSession(req: Request, env: Env): Promise<SessionPayload | null> {
  const s = await readSession(cookies(req)[COOKIE] ?? null, env.SESSION_SECRET)
  if (!s) return null
  // token 里的版本号必须跟库里一致：改过密码，旧 token 立刻作废
  const row = await env.DB.prepare('SELECT pwd_ver FROM admin WHERE id = 1').first<{
    pwd_ver: number
  }>()
  if (!row || row.pwd_ver !== s.v) return null
  return s
}

/* ── 登录 ── */

async function handleLogin(req: Request, env: Env): Promise<Response> {
  if (!sameOrigin(req)) return json({ error: '来源不对' }, 403)
  let body: { username?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: '请求格式不对' }, 400)
  }
  const username = String(body.username ?? '').trim()
  const password = String(body.password ?? '')
  if (!username || !password) return json({ error: '账号和密码都要填' }, 400)

  const ip = await hashIp(req, env.SESSION_SECRET)
  const now = Date.now()
  const att = await env.DB.prepare(
    'SELECT fails, lock_until FROM login_attempts WHERE ip_hash = ?',
  )
    .bind(ip)
    .first<{ fails: number; lock_until: number }>()

  if (att && att.lock_until > now) {
    const min = Math.ceil((att.lock_until - now) / 60000)
    return json({ error: `连错太多次，${min} 分钟后再试` }, 429)
  }

  const row = await env.DB.prepare(
    'SELECT username, pwd_salt, pwd_hash, pwd_ver FROM admin WHERE id = 1',
  ).first<{ username: string; pwd_salt: string; pwd_hash: string; pwd_ver: number }>()

  const passOk = row ? await verifyPassword(password, row.pwd_salt, row.pwd_hash) : false
  if (!row || row.username !== username || !passOk) {
    const fails = (att?.fails ?? 0) + 1
    const lock = fails >= MAX_FAILS ? now + LOCK_MS : 0
    await env.DB.prepare(
      `INSERT INTO login_attempts (ip_hash, fails, lock_until, last_ts) VALUES (?, ?, ?, ?)
       ON CONFLICT(ip_hash) DO UPDATE SET fails = ?, lock_until = ?, last_ts = ?`,
    )
      .bind(ip, fails, lock, now, fails, lock, now)
      .run()
    return json({ error: '账号或密码不对' }, 401)
  }

  await env.DB.prepare('DELETE FROM login_attempts WHERE ip_hash = ?').bind(ip).run()
  const token = await signSession(
    { u: row.username, v: row.pwd_ver, exp: now + SESSION_DAYS * 86400000 },
    env.SESSION_SECRET,
  )
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': setCookie(token, SESSION_DAYS * 86400),
    },
  })
}

async function handlePassword(req: Request, env: Env, sess: SessionPayload): Promise<Response> {
  if (!sameOrigin(req)) return json({ error: '来源不对' }, 403)
  let body: { oldPassword?: string; newPassword?: string; username?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: '请求格式不对' }, 400)
  }
  const oldPwd = String(body.oldPassword ?? '')
  const newPwd = String(body.newPassword ?? '')
  const newUser = String(body.username ?? '').trim()

  if (!/^[A-Za-z0-9_-]{3,32}$/.test(newUser)) {
    return json({ error: '账号只能 3–32 位的字母、数字、下划线或连字符' }, 400)
  }
  if (newPwd.length < 10) return json({ error: '新密码至少 10 位' }, 400)

  const row = await env.DB.prepare(
    'SELECT pwd_salt, pwd_hash, pwd_ver FROM admin WHERE id = 1',
  ).first<{ pwd_salt: string; pwd_hash: string; pwd_ver: number }>()
  if (!row) return json({ error: '管理员记录不见了' }, 500)
  if (!(await verifyPassword(oldPwd, row.pwd_salt, row.pwd_hash))) {
    return json({ error: '当前密码不对' }, 401)
  }

  const salt = randomHex(16)
  const hash = await hashPassword(newPwd, salt)
  const ver = row.pwd_ver + 1
  await env.DB.prepare(
    'UPDATE admin SET username = ?, pwd_salt = ?, pwd_hash = ?, pwd_ver = ?, updated_at = ? WHERE id = 1',
  )
    .bind(newUser, salt, hash, ver, Date.now())
    .run()

  // 换一枚新 token：版本号变了，别处还登着的会话会立刻失效
  const token = await signSession(
    { u: newUser, v: ver, exp: Date.now() + SESSION_DAYS * 86400000 },
    env.SESSION_SECRET,
  )
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': setCookie(token, SESSION_DAYS * 86400) },
  })
}

/* ── 统计 ── */

async function githubStats(): Promise<{ stars: number; forks: number; tag: string; downloads: number } | null> {
  try {
    const cache = (caches as unknown as { default: EdgeCache }).default
    const key = new Request('https://cache.local/gh/nota')
    const hit = await cache.match(key)
    if (hit) return hit.json()
    const h = { 'User-Agent': 'nota-site', Accept: 'application/vnd.github+json' }
    const repo = 'https://api.github.com/repos/YMTJ0522/Nota'
    const [r1, r2] = await Promise.all([fetch(repo, { headers: h }), fetch(repo + '/releases/latest', { headers: h })])
    if (!r1.ok) return null
    const info = (await r1.json()) as { stargazers_count: number; forks_count: number }
    let tag = ''
    let downloads = 0
    if (r2.ok) {
      const rel = (await r2.json()) as { tag_name: string; assets?: { download_count: number }[] }
      tag = rel.tag_name ?? ''
      downloads = (rel.assets ?? []).reduce((n, a) => n + (a.download_count ?? 0), 0)
    }
    const out = { stars: info.stargazers_count, forks: info.forks_count, tag: tag.replace(/^v/, ''), downloads }
    // 五分钟缓存：GitHub 匿名接口一小时只给 60 次，不缓存会被自己打满
    const res = new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } })
    await cache.put(key, new Response(JSON.stringify(out), { headers: { 'Cache-Control': 'max-age=300' } }))
    return out
  } catch {
    return null
  }
}

async function handleStats(env: Env): Promise<Response> {
  const today = dayKey()
  const yesterday = dayKey(Date.now() - 86400000)
  const weekAgo = dayKey(Date.now() - 6 * 86400000)

  const [byAsset, todayRow, yRow, weekRow] = await Promise.all([
    env.DB.prepare('SELECT asset, COUNT(*) AS n FROM downloads GROUP BY asset').all<{
      asset: string
      n: number
    }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM downloads WHERE day = ?').bind(today).first<{ n: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM downloads WHERE day = ?')
      .bind(yesterday)
      .first<{ n: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM downloads WHERE day >= ?')
      .bind(weekAgo)
      .first<{ n: number }>(),
  ])

  const assetMap: Record<string, number> = { setup: 0, portable: 0 }
  for (const r of byAsset.results) assetMap[r.asset] = r.n

  // 近 30 天：缺的日子要补 0，否则柱状图会把空档压掉，看着像连着的
  const start = Date.now() - 29 * 86400000
  const rows = await env.DB.prepare(
    'SELECT day, COUNT(*) AS n FROM downloads WHERE day >= ? GROUP BY day',
  )
    .bind(dayKey(start))
    .all<{ day: string; n: number }>()
  const byDay = new Map(rows.results.map((r) => [r.day, r.n]))
  const series: [string, number][] = []
  for (let i = 29; i >= 0; i--) {
    const d = dayKey(Date.now() - i * 86400000)
    series.push([d, byDay.get(d) ?? 0])
  }

  return json({
    total: assetMap.setup + assetMap.portable,
    byAsset: assetMap,
    today: todayRow?.n ?? 0,
    yesterday: yRow?.n ?? 0,
    last7: weekRow?.n ?? 0,
    series,
    github: await githubStats(),
  })
}

/* ── 下载 ── */

async function handleDownload(req: Request, env: Env, which: string): Promise<Response> {
  const base = ASSETS[which]
  if (!base) return new Response('没有这个安装包', { status: 404 })
  const version = env.VERSION ?? ''
  const fileName = version ? `${base}-${version}.exe` : `${base}.exe`
  const key = `${base}.exe`

  const head = await env.FILES.head(key)
  if (!head) return new Response('安装包还没传上来', { status: 404 })

  const total = head.size
  const range = req.headers.get('Range')
  let start = 0
  let end = total - 1
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m) {
      start = m[1] ? Number(m[1]) : 0
      end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1
      if (Number.isNaN(start) || start > end) {
        return new Response('范围不合法', { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
      }
    }
  }

  // 只有从头开始取才算一次下载：断点续传的那几段不该重复计数
  if (start === 0) {
    const ip = await hashIp(req, env.SESSION_SECRET)
    await env.DB.prepare(
      'INSERT OR IGNORE INTO downloads (asset, day, ip_hash, ts, referer, country) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        which,
        dayKey(),
        ip,
        Date.now(),
        (req.headers.get('Referer') ?? '').slice(0, 200),
        (req as unknown as { cf?: { country?: string } }).cf?.country ?? '',
      )
      .run()
  }

  const obj = await env.FILES.get(key, {
    range: range ? { offset: start, length: end - start + 1 } : undefined,
  })
  if (!obj) return new Response('安装包读不出来', { status: 500 })

  const headers = new Headers({
    'Content-Type': 'application/vnd.microsoft.portable-executable',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=300',
  })
  if (range) {
    headers.set('Content-Range', `bytes ${start}-${end}/${total}`)
    headers.set('Content-Length', String(end - start + 1))
    return new Response(obj.body, { status: 206, headers })
  }
  headers.set('Content-Length', String(total))
  return new Response(obj.body, { status: 200, headers })
}

/* ── 公开信息：官网按钮上的版本号和体积 ── */

/**
 * 官网不再去问 GitHub 要下载地址（那样点下去就绕过计数了），
 * 所以版本号和文件大小得自己给。这个接口不带鉴权，只吐两件事：
 * 当前版本、两个包各多大。
 */
async function handleInfo(env: Env): Promise<Response> {
  const version = env.VERSION ?? ''
  const nameOf = (base: string) => (version ? `${base}-${version}.exe` : `${base}.exe`)
  const [a, b] = await Promise.all([
    env.FILES.head(`${ASSETS.setup}.exe`),
    env.FILES.head(`${ASSETS.portable}.exe`),
  ])
  return new Response(
    JSON.stringify({
      version,
      assets: {
        setup: { name: nameOf(ASSETS.setup), size: a?.size ?? 0 },
        portable: { name: nameOf(ASSETS.portable), size: b?.size ?? 0 },
      },
    }),
    {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        // 一分钟够了：传新包之后最多一分钟官网就跟着换
        'Cache-Control': 'public, max-age=60',
      },
    },
  )
}

/* ── 入口 ── */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const p = url.pathname
    const m = req.method

    if (p.startsWith('/api/')) {
      // 这一条是公开的，放在登录校验之前
      if (p === '/api/info' && m === 'GET') return handleInfo(env)
      if (p === '/api/login' && m === 'POST') return handleLogin(req, env)
      if (p === '/api/logout' && m === 'POST') {
        return new Response('{}', {
          headers: { 'Content-Type': 'application/json', 'Set-Cookie': setCookie('', 0) },
        })
      }
      const sess = await currentSession(req, env)
      if (!sess) return json({ error: '没登录' }, 401)
      if (p === '/api/stats' && m === 'GET') return handleStats(env)
      if (p === '/api/password' && m === 'POST') return handlePassword(req, env, sess)
      return json({ error: '没有这个接口' }, 404)
    }

    if (p === '/admin') {
      const sess = await currentSession(req, env)
      const html = sess ? adminPage(sess.u) : loginPage()
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }

    if (p.startsWith('/d/')) {
      return handleDownload(req, env, p.slice(3).replace(/\/$/, ''))
    }

    return env.ASSETS.fetch(req)
  },
}
