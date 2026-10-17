/**
 * 云同步的回归验证：本地起一个**假 WebDAV 服务器**，把真的 syncWorkspace 跑一遍。
 *
 * 为什么值得单独做一个：云同步的坑几乎全在「协议细节 + 请求顺序」上，
 * 而这些只有真发一遍请求才看得见 —— 静态读代码读不出「PUT 到不存在的父集合会 404」，
 * 也读不出「每传一个文件多问一次 HEAD」。
 *
 * 假服务器刻意按坚果云那种较真的行为来：
 *   · 往不存在的目录里 PUT → 404（这就是用户截图里那个错的来源）；
 *   · MKCOL 父目录不存在 → 409；
 *   · 已存在再 MKCOL → 405；
 *   · PUT 成功时**返回** Last-Modified（真服务器大多也返）。
 *
 *   node scripts/verify-sync-webdav.mjs
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ── 一次跨进程的 esbuild：把 sync.ts 的 `electron` 依赖换成 globalThis.fetch ── */

const SHIM = `
export const net = {
  fetch: (url, init) => globalThis.fetch(url, init),
}
`

async function bundleSync() {
  const esbuild = await import('esbuild')
  const out = path.join(os.tmpdir(), `nota-sync-${Date.now()}.mjs`)
  await esbuild.build({
    entryPoints: [path.join(root, 'electron/sync.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'silent',
    plugins: [
      {
        name: 'electron-shim',
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({ path: 'shim', namespace: 'shim' }))
          build.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: SHIM, loader: 'js' }))
        },
      },
    ],
  })
  return out
}

/* ── 假 WebDAV ── */

const ROOT = '/dav'
/** path → { dir: boolean, mtime: number, data?: Buffer } */
const tree = new Map()
/* 真服务器的 /dav 根一定存在（那是账号根），这里也得先摆上，
   否则第一次 MKCOL 拿到的 409 只是在测我的假服务器，不是测同步逻辑。 */
tree.set(ROOT, { dir: true, mtime: Date.now() })
const hits = { PROPFIND: 0, MKCOL: 0, PUT: 0, GET: 0, HEAD: 0 }

function norm(p) {
  const dec = decodeURIComponent(p)
  return dec.length > 1 ? dec.replace(/\/+$/, '') : dec
}
function parentOf(p) {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}
function childrenOf(p) {
  const prefix = p === '/' ? '/' : p + '/'
  const out = []
  for (const [k, v] of tree) {
    if (k === p || !k.startsWith(prefix)) continue
    if (k.slice(prefix.length).includes('/')) continue
    out.push([k, v])
  }
  return out
}
const iso = (t) => new Date(t).toUTCString()
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const encHref = (p) => encodeURI(p) + (tree.get(p)?.dir ? '/' : '')

function responseXml(p) {
  const v = tree.get(p)
  const rt = v?.dir ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>'
  const len = v?.dir ? '' : `<d:getcontentlength>${v?.data?.length ?? 0}</d:getcontentlength>`
  return (
    `<d:response><d:href>${esc(encHref(p))}</d:href><d:propstat><d:prop>${rt}` +
    `<d:getlastmodified>${iso(v?.mtime ?? 0)}</d:getlastmodified>${len}` +
    `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
  )
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  const p = norm(u.pathname)
  const m = req.method
  if (m in hits) hits[m] += 1

  const body = []
  for await (const c of req) body.push(c)
  const buf = Buffer.concat(body)

  if (!p.startsWith(ROOT)) {
    res.writeHead(404).end()
    return
  }

  if (m === 'PROPFIND') {
    const v = tree.get(p)
    if (!v) {
      res.writeHead(404).end()
      return
    }
    const depth = req.headers.depth === '0' ? 0 : 1
    const items = [p]
    if (depth === 1 && v.dir) for (const [k] of childrenOf(p)) items.push(k)
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">' +
      items.map(responseXml).join('') +
      '</d:multistatus>'
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' }).end(xml)
    return
  }

  if (m === 'MKCOL') {
    if (tree.has(p)) {
      res.writeHead(405).end()
      return
    }
    if (!tree.get(parentOf(p))?.dir) {
      res.writeHead(409).end()
      return
    }
    tree.set(p, { dir: true, mtime: Date.now() })
    res.writeHead(201).end()
    return
  }

  if (m === 'PUT') {
    if (!tree.get(parentOf(p))?.dir) {
      // 坚果云那一路的行为：父集合不存在直接 404，不会替你建
      res.writeHead(404).end()
      return
    }
    const existed = tree.has(p)
    const now = Date.now()
    tree.set(p, { dir: false, mtime: now, data: buf })
    res.writeHead(existed ? 204 : 201, { 'Last-Modified': iso(now) }).end()
    return
  }

  if (m === 'HEAD') {
    const v = tree.get(p)
    if (!v) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'Last-Modified': iso(v.mtime), 'Content-Length': v.data?.length ?? 0 }).end()
    return
  }

  if (m === 'GET') {
    const v = tree.get(p)
    if (!v || v.dir) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'Last-Modified': iso(v.mtime) }).end(v.data)
    return
  }

  res.writeHead(405).end()
})

/* ── 跑起来 ── */

const results = []
const ok = (name, pass, data) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${data === undefined ? '' : '  ' + JSON.stringify(data)}`)
}

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-sync-ws-'))
fs.writeFileSync(path.join(ws, 'a.md'), '# 甲\n')
fs.mkdirSync(path.join(ws, 'Docker'), { recursive: true })
fs.writeFileSync(path.join(ws, 'Docker', 'b.md'), '# 乙\n')
fs.mkdirSync(path.join(ws, 'Docker', 'sub'), { recursive: true })
fs.writeFileSync(path.join(ws, 'Docker', 'sub', 'c.md'), '# 丙\n')
fs.mkdirSync(path.join(ws, '中文目录'), { recursive: true })
// 用户截图里那个文件：顶层中文名 + 含点的扩展名
fs.writeFileSync(path.join(ws, '中文目录', '2.hive搭建.md'), '# hive\n')
fs.mkdirSync(path.join(ws, '.trash'), { recursive: true })
fs.writeFileSync(path.join(ws, '.trash', '别管我.md'), '# 不该同步\n')

const bundle = await bundleSync()
const { syncWorkspace } = await import(pathToFileURL(bundle).href)

const cfg = { url: `http://127.0.0.1:${port}/dav`, username: 'u', password: 'p', dir: '笔记' }

/* ── 1. 首次同步：子目录里的文件必须能传上去（404 回归） ── */
const r1 = await syncWorkspace(ws, cfg)
ok('首次同步成功（子目录含中文名文件）', r1.ok === true && !r1.error, {
  ok: r1.ok,
  uploaded: r1.uploaded,
  error: r1.error,
})
ok('四个文件都传上去了，点开头的目录被跳过', r1.uploaded === 4 && !tree.has('/dav/笔记/.trash'), {
  uploaded: r1.uploaded,
})
ok('云端确实有了嵌套结构', tree.has('/dav/笔记/Docker/sub/c.md') && tree.has('/dav/笔记/中文目录/2.hive搭建.md'))

/* ── 2. 再跑一次：应该零传输（状态记对了才做得到） ── */
const putBefore = hits.PUT
const t0 = Date.now()
const r2 = await syncWorkspace(ws, cfg)
const ms = Date.now() - t0
ok('第二遍不重复上传', r2.ok === true && r2.uploaded === 0 && hits.PUT === putBefore, {
  uploaded: r2.uploaded,
  puts: hits.PUT - putBefore,
  ms,
})

/* ── 3. 传完不该再逐个问 HEAD ── */
ok('每个文件不再额外发 HEAD（PUT 响应自带 Last-Modified）', hits.HEAD === 0, { head: hits.HEAD })

/* ── 4. 云端新增的文件能拉下来 ── */
const remoteMtime = Date.now() + 5000
tree.set('/dav/笔记/云端新增.md', { dir: false, mtime: remoteMtime, data: Buffer.from('# 来自云\n') })
const r3 = await syncWorkspace(ws, cfg)
ok('云端新文件拉回本地', r3.ok === true && r3.downloaded === 1 && fs.existsSync(path.join(ws, '云端新增.md')), {
  downloaded: r3.downloaded,
})

/* ── 5. 本地改了要推上去 ── */
await new Promise((r) => setTimeout(r, 20))
fs.writeFileSync(path.join(ws, 'a.md'), '# 甲（改过）\n')
const r4 = await syncWorkspace(ws, cfg)
ok('本地改动推上云端', r4.ok === true && r4.uploaded === 1, { uploaded: r4.uploaded })

/* ── 6. 不该有的东西：点开头目录一个都没上去 ── */
ok('点开头的目录没被同步', ![...tree.keys()].some((k) => k.includes('/.trash')), {
  keys: [...tree.keys()].filter((k) => k.includes('.')),
})

/* ── 收尾 ── */
server.close()
try {
  fs.rmSync(ws, { recursive: true, force: true })
  fs.rmSync(bundle, { force: true })
} catch {
  /* 无所谓 */
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} PASS`)
process.exit(failed.length ? 1 : 0)
