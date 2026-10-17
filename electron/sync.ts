/**
 * WebDAV 云同步（主进程）。
 *
 * 为什么选 WebDAV：坚果云（国内最顺的）原生支持，InfiniCloud、群晖、
 * Nextcloud 也都认；不用给每家网盘单独写 API，一个协议覆盖一片。
 *
 * 同步策略（v1，刻意保守）：
 *   · 只镜像 .md 与普通文件，跳过所有点开头目录（.nota / .trash / .git）；
 *   · 以「上次同步之后双方谁改过」判定方向 —— 本地改了就推上去，
 *     云端改了就拉下来，两边都没动就跳过；
 *   · **两边都改过**（相对上次同步）算冲突：本地那一份先改名成
 *     `xxx.conflict-时间.md` 留底，再落下云端版本。宁可多出一个文件，
 *     也不悄悄覆盖掉谁的字 —— 笔记丢字是没法原谅的；
 *   · 删除不做同步（没有墓碑记录，贸然删云端太危险），这版先明说。
 *
 * 速度上的三条底线（2.7.2 重做）：
 *   · 目录**按需建**，不再只建根目录 —— 子目录缺父集合会让 PUT 直接 404；
 *   · 传输并发 5 路、列目录并发 4 路，不再一个文件一个来回地串；
 *   · 传完不再额外发 HEAD 问 Last-Modified（PUT 响应里就有），
 *     真要问也只问那些没带的。
 *
 * 状态记在 `<工作区>/.nota-sync/state.json`：每个文件上次同步时
 * 本地的 mtime 与云端的 Last-Modified。它自己不参与同步。
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { net } from 'electron'

export interface SyncConfig {
  url: string
  username: string
  password: string
  dir: string
}

export interface SyncResult {
  ok: boolean
  uploaded: number
  downloaded: number
  conflicts: number
  skipped: number
  error?: string
}

interface RemoteEntry {
  href: string
  name: string
  isDir: boolean
  mtime: number
  size: number
}

/* ── 基础请求 ── */

function authHeader(cfg: SyncConfig) {
  return 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')
}

/** 规整 base URL：去尾部斜杠；坚果云这类给到 /dav/ 就够 */
function baseUrl(cfg: SyncConfig) {
  return cfg.url.replace(/\/+$/, '')
}

/** 远端目录 URL：base/dir，dir 里的每一段都过 encodeURIComponent */
function dirUrl(cfg: SyncConfig) {
  const dir = cfg.dir.replace(/^\/+|\/+$/g, '')
  const seg = dir ? '/' + dir.split('/').map(encodeURIComponent).join('/') : ''
  return baseUrl(cfg) + seg
}

async function davFetch(
  url: string,
  method: string,
  cfg: SyncConfig,
  init: { depth?: string; body?: string; contentType?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: authHeader(cfg),
  }
  if (init.depth !== undefined) headers.Depth = init.depth
  if (init.body !== undefined) headers['Content-Type'] = init.contentType ?? 'application/xml'
  return net.fetch(url, {
    method,
    headers,
    body: init.body,
  })
}

/* ── PROPFIND 解析 ──
   WebDAV 的 XML 命名空间前缀各家不一样（d: / D: / 不带前缀），
   正则一律写成 `(?:[\w-]+:)?`，哪家的都认。 */

function parsePropsResponse(block: string): {
  href: string
  raw: string
  isDir: boolean
  mtime: number
  size: number
} {
  const raw = (/<(?:[\w-]+:)?href>([^<]*)<\/(?:[\w-]+:)?href>/.exec(block)?.[1] ?? '').trim()
  const href = decodeURIComponent(raw)
  const isDir = /<(?:[\w-]+:)?collection\s*\/?>/.test(block)
  const mtime = Date.parse(
    (/<(?:[\w-]+:)?getlastmodified>([^<]*)<\/(?:[\w-]+:)?getlastmodified>/.exec(block)?.[1] ??
      '') || '',
  )
  const size = Number(/<(?:[\w-]+:)?getcontentlength>(\d+)</.exec(block)?.[1] ?? 0)
  return { href, raw, isDir, mtime: Number.isNaN(mtime) ? 0 : mtime, size }
}

/**
 * href 各家给法不一样：有的给完整 URL，有的只给路径（`/dav/Nota/子目录`）。
 *
 * 只给路径的那种必须补成绝对 URL —— 子目录是拿 href 接着往下 PROPFIND 的，
 * 把 `/dav/…` 直接丢给 net.fetch 会得到
 * `Failed to parse URL from /dav/…`：第一次同步（远端还是空的、没有子目录）
 * 一路顺风，第二次一撞上子目录就整轮失败。
 */
function absoluteHref(href: string, cfg: SyncConfig): string {
  try {
    return new URL(href, baseUrl(cfg) + '/').toString()
  } catch {
    return href
  }
}

/** 把 URL 规整成可比的路径键：解码、去尾斜杠。 */
function hrefKey(u: string): string {
  try {
    return decodeURIComponent(new URL(u, 'http://x/').pathname.replace(/\/+$/, ''))
  } catch {
    return decodeURIComponent(u.replace(/\/+$/, ''))
  }
}

/** 列一个远端目录（Depth 1）。返回目录自身的信息 + 直接子项 */
async function listDir(url: string, cfg: SyncConfig): Promise<RemoteEntry[]> {
  const res = await davFetch(url.endsWith('/') ? url : url + '/', 'PROPFIND', cfg, {
    depth: '1',
    body:
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>' +
      '<d:resourcetype/><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>',
  })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`服务器返回 ${res.status}（列目录失败）`)
  const xml = await res.text()
  // 多行响应里 <d:response> 可能带属性，宽松切开
  const blocks = xml.split(/<(?:[\w-]+:)?response[\s>]/).slice(1)
  const out: RemoteEntry[] = []
  for (const b of blocks) {
    const p = parsePropsResponse(b)
    if (!p.href) continue
    // href 可能是绝对 URL，也可能只有路径 —— 统一取末段当名字
    const name = decodeURIComponent(p.href.replace(/\/+$/, '').split('/').pop() ?? '')
    if (!name) continue
    out.push({
      href: absoluteHref(p.raw, cfg),
      name,
      isDir: p.isDir,
      mtime: p.mtime,
      size: p.size,
    })
  }
  return out
}

/**
 * 递归建远端目录（逐段 MKCOL；405 / 409 = 已存在，不算错）。
 *
 * `made` 是这一轮的缓存：同一轮里几十个文件落在同一个目录下时，
 * 不该每个文件都重走一遍 MKCOL 链。键用规整过的绝对路径。
 */
async function ensureRemoteDir(url: string, cfg: SyncConfig, made: Set<string>) {
  const target = new URL(url)
  if (made.has(hrefKey(target.toString()))) return
  const base = new URL(baseUrl(cfg))
  const segs = target.pathname.split('/').filter(Boolean)
  const baseSegs = base.pathname.split('/').filter(Boolean)
  let cur = `${base.protocol}//${base.host}`
  for (let i = 0; i < segs.length; i += 1) {
    cur += '/' + segs[i]
    if (i < baseSegs.length) continue // base 自带的段不用建
    const ck = hrefKey(cur)
    if (made.has(ck)) continue
    let res = await davFetch(cur + '/', 'MKCOL', cfg)
    if (res.status === 409) {
      // 409 = 父集合还不存在。先补上上一段，再试一次 ——
      // 只在这一段上重试，不能因为「没建成」就写进 made，
      // 否则后面的 PUT 撞 404 想自愈时会被这个缓存直接挡住。
      const parent = cur.slice(0, cur.lastIndexOf('/'))
      await ensureRemoteDir(parent, cfg, made)
      res = await davFetch(cur + '/', 'MKCOL', cfg)
    }
    // 405：服务器把它当成「资源已存在」。其余（401 / 403 / 507）都是真错，得让人看见。
    if (!res.ok && res.status !== 405) {
      throw new Error(`建目录 ${ck} 失败（${res.status}）`)
    }
    made.add(ck)
  }
  made.add(hrefKey(target.toString()))
}

/** 并发跑一批异步任务：上限 n 路，任意一个抛错就整体失败（错误信息更好定位）。 */
async function pool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>) {
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    for (;;) {
      const i = cursor
      cursor += 1
      if (i >= items.length) return
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}

/* ── 本地遍历 ── */

async function walkLocal(root: string, dir = '', out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir ? path.join(root, dir) : root, { withFileTypes: true })
  for (const e of entries) {
    if (e.name.startsWith('.')) continue // .nota / .trash / .git / .nota-sync 全跳过
    const rel = dir ? `${dir}/${e.name}` : e.name
    if (e.isDirectory()) await walkLocal(root, rel, out)
    else out.push(rel)
  }
  return out
}

/* ── 同步状态 ── */

interface SyncState {
  [rel: string]: { localMtime: number; remoteMtime: number }
}

const stateDir = (root: string) => path.join(root, '.nota-sync')
const stateFile = (root: string) => path.join(stateDir(root), 'state.json')

async function readState(root: string): Promise<SyncState> {
  try {
    return JSON.parse(await fs.readFile(stateFile(root), 'utf8'))
  } catch {
    return {}
  }
}

async function writeState(root: string, st: SyncState) {
  await fs.mkdir(stateDir(root), { recursive: true })
  await fs.writeFile(stateFile(root), JSON.stringify(st), 'utf8')
}

/* ── 主流程 ── */

let progressCb: ((text: string) => void) | null = null

export function onSyncProgress(cb: (text: string) => void) {
  progressCb = cb
}

function say(text: string) {
  progressCb?.(text)
}

export async function testConnection(cfg: SyncConfig): Promise<{ ok: boolean; error?: string }> {
  if (!cfg.url || !/^https?:\/\//.test(cfg.url)) {
    return { ok: false, error: '服务器地址要以 http(s):// 开头' }
  }
  try {
    const res = await davFetch(dirUrl(cfg) + '/', 'PROPFIND', cfg, { depth: '0' })
    if (res.status === 401) return { ok: false, error: '账号或应用密码不对（401）' }
    if (!res.ok && res.status !== 404) {
      return { ok: false, error: `服务器返回 ${res.status}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `连不上：${String(e)}` }
  }
}

export async function syncWorkspace(root: string, cfg: SyncConfig): Promise<SyncResult> {
  const r: SyncResult = { ok: false, uploaded: 0, downloaded: 0, conflicts: 0, skipped: 0 }
  /* 这一轮里已经确认存在的远端目录。
     以前只有根目录会建，子目录从来没建过 —— 本地有 `Docker/xxx.md` 时
     PUT 到 `笔记/Docker/xxx.md`，服务器找不到父集合，回 404，
     整轮同步就停在那儿（用户看到的「上传 xx 失败（404）」就是它）。 */
  const made = new Set<string>()
  /* 状态要能「边做边记」：一个文件失败不代表前面成功的白干，
     否则下次重跑会把已经传上去的几十篇再传一遍 —— 也是慢的一大来源。 */
  let st: SyncState = {}
  let dirty = false
  try {
    await ensureRemoteDir(dirUrl(cfg), cfg, made)
    st = await readState(root)
    const localFiles = await walkLocal(root)
    const localSet = new Set(localFiles)

    // 远端递归列表：逐个目录 PROPFIND（depth-infinity 很多服务器不支持）。
    // 同一层并发 4 路 —— 串行时每多一层子目录就多等一个来回。
    const remoteFiles = new Map<string, RemoteEntry>()
    let level: { url: string; prefix: string }[] = [{ url: dirUrl(cfg), prefix: '' }]
    let guard = 0
    while (level.length && guard++ < 500) {
      const next: { url: string; prefix: string }[] = []
      await pool(level, 4, async (job) => {
        const entries = await listDir(job.url, cfg)
        // PROPFIND 会连目录自己一起带回来。不认出来的话它会被当成
        // 「一个同名子目录」再塞回队列 —— 于是无限往下钻，整轮同步卡死。
        // 比的是规整过的路径（解码 + 去尾斜杠），因为 URL 上那段是编码过的，
        // 而服务器给的 href 未必编码，两种写法要能认成同一个。
        const self = hrefKey(job.url)
        for (const e of entries) {
          if (hrefKey(e.href) === self) continue
          if (e.isDir) {
            next.push({
              url: `${e.href}/`,
              prefix: job.prefix ? `${job.prefix}/${e.name}` : e.name,
            })
          } else {
            const rel = job.prefix ? `${job.prefix}/${e.name}` : e.name
            remoteFiles.set(rel, e)
          }
        }
      })
      level = next
    }

    const stamp = () => {
      const d = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    }

    // 先把本地每个文件的 mtime 一次性量完，再决定谁要传 ——
    // 以前在循环里逐个 stat，跟网络请求混在一起串着等。
    const locals: { rel: string; lm: number }[] = []
    await pool(localFiles, 8, async (rel) => {
      const s = await fs.stat(path.join(root, rel))
      locals.push({ rel, lm: s.mtimeMs })
    })

    /* ① 本地 → 云端。决定方向的判断是纯内存的，先算完再并发传。 */
    const toUpload: { rel: string; lm: number }[] = []
    for (const { rel, lm } of locals) {
      const rec = st[rel]
      const remote = remoteFiles.get(rel)
      const localChanged = !rec || rec.localMtime !== lm
      const remoteChanged = remote ? remote.mtime > (rec?.remoteMtime ?? 0) : false

      if (!localChanged && !remoteChanged && remote) {
        r.skipped += 1
        continue
      }
      if (localChanged && remoteChanged && rec) {
        // 冲突：本地这份改名留底（本地 + 云端各留一份），再落云端版本
        const ext = path.extname(rel)
        const base = rel.slice(0, rel.length - ext.length)
        const conflictRel = `${base}.conflict-${stamp()}${ext}`
        await fs.copyFile(path.join(root, rel), path.join(root, conflictRel))
        say(`冲突：${rel} 两边都改过，本地版本留底为 ${path.basename(conflictRel)}`)
        r.conflicts += 1
      }
      if (localChanged || !remote || (rec && remote.mtime <= rec.remoteMtime)) {
        toUpload.push({ rel, lm })
      } else {
        // 只有远端改过 → 落到 ② 里处理
        r.skipped += 1
      }
    }

    await pool(toUpload, 5, async ({ rel, lm }) => {
      const url = `${dirUrl(cfg)}/${rel.split('/').map(encodeURIComponent).join('/')}`
      const remoteNow = await putFile(root, rel, url, cfg, made)
      st[rel] = { localMtime: lm, remoteMtime: remoteNow ?? Date.now() }
      dirty = true
      r.uploaded += 1
      say(`↑ ${rel}`)
    })

    /* ② 云端 → 本地（本地没有的，或云端更新且本地没动过的） */
    const toDownload: { rel: string; remote: RemoteEntry }[] = []
    await pool([...remoteFiles], 8, async ([rel, remote]) => {
      const abs = path.join(root, rel)
      const rec = st[rel]
      let lm = 0
      try {
        lm = (await fs.stat(abs)).mtimeMs
      } catch {
        /* 本地没有这个文件 */
      }
      const localChanged = rec ? rec.localMtime !== lm : lm > 0
      if (localSet.has(rel) && !localChanged && remote.mtime <= (rec?.remoteMtime ?? 0)) return
      if (localSet.has(rel) && localChanged) return // ① 里已按冲突/上传处理
      toDownload.push({ rel, remote })
    })

    await pool(toDownload, 5, async ({ rel, remote }) => {
      const abs = path.join(root, rel)
      const url = `${dirUrl(cfg)}/${rel.split('/').map(encodeURIComponent).join('/')}`
      const res = await davFetch(url, 'GET', cfg)
      if (!res.ok) throw new Error(`下载 ${rel} 失败（${res.status}）`)
      const buf = Buffer.from(await res.arrayBuffer())
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, buf)
      st[rel] = { localMtime: (await fs.stat(abs)).mtimeMs, remoteMtime: remote.mtime }
      dirty = true
      r.downloaded += 1
      say(`↓ ${rel}`)
    })

    r.ok = true
    return r
  } catch (e) {
    r.error = String(e)
    return r
  } finally {
    // 即使中途失败也把已完成的记下来，下一轮不用重传一遍
    if (dirty) {
      try {
        await writeState(root, st)
      } catch {
        /* 状态写不进去不该盖掉真正的错误 */
      }
    }
  }
}

/**
 * PUT 一个文件。
 *
 * 两件以前做得不对的事：
 *  · **没建父目录** —— 404 的真凶。撞上就补建一次再重试；
 *  · **传完还额外发一次 HEAD 只为问 Last-Modified** —— 每个文件多半个来回。
 *    PUT 的响应本身多半就带这个头，直接用；真没有才回退去 HEAD。
 */
async function putFile(
  root: string,
  rel: string,
  url: string,
  cfg: SyncConfig,
  made: Set<string>,
): Promise<number | null> {
  const send = async () => {
    const bytes = await fs.readFile(path.join(root, rel))
    return net.fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: authHeader(cfg),
        'Content-Type': 'application/octet-stream',
      },
      // body 必须是二进制视图：直接给 string 会按 utf8 再编一遍，二进制文件必坏
      body: new Uint8Array(bytes),
    })
  }

  let res = await send()
  if (res.status === 404) {
    // 父集合还不存在。按 URL 反推出父目录补建，再试一次。
    const slash = url.lastIndexOf('/')
    if (slash > 0) {
      await ensureRemoteDir(url.slice(0, slash), cfg, made)
      res = await send()
    }
  }
  if (!res.ok) throw new Error(`上传 ${rel} 失败（${res.status}）`)

  const lm = Date.parse(res.headers.get('last-modified') ?? '')
  if (!Number.isNaN(lm)) return lm
  return statRemote(url, cfg)
}

/** 兜底：PUT 响应里没带 Last-Modified 时才单独问一次（不再每个文件都问） */
async function statRemote(url: string, cfg: SyncConfig): Promise<number | null> {
  try {
    const res = await davFetch(url, 'HEAD', cfg)
    if (!res.ok) return null
    const t = Date.parse(res.headers.get('last-modified') ?? '')
    return Number.isNaN(t) ? null : t
  } catch {
    return null
  }
}
