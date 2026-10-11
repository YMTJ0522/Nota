import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Vite 注入：开发环境指向 dev server，生产环境加载打包后的 dist
process.env.APP_ROOT = path.join(__dirname, '..')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

/* ── 自定义媒体协议 ──
   笔记里的图片写的是相对路径（attachments/xxx.png），而渲染进程是从
   file:// 或 http://localhost 加载的，相对路径指向的是应用自己而不是
   工作区目录 —— 所以插图永远是个破图标。

   这里注册一个 nota-media:// 协议专门用来读工作区里的文件，
   渲染层只要把相对路径拼进来即可。必须在 app ready 之前声明为
   standard + secure，否则会被当成普通 URL 处理、拿不到本地文件。

   用 protocol.handle（Electron 25+ 的新 API）而不是废弃的
   registerFileProtocol：前者直接返回 Response，路径拼接更可控。 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'nota-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#fbfaf6',
    title: 'Nota',
    /* 标题栏与任务栏图标。
       打包后 icon.png 会被 electron-builder 放进 resources/，
       开发时则直接读仓库里的 build/icon.png——两条路径都试一下，
       拿不到就让系统用 exe 自带的图标兜底。 */
    icon: (() => {
      const candidates = [
        path.join(process.resourcesPath ?? '', 'icon.png'),
        path.join(__dirname, '..', 'build', 'icon.png'),
      ]
      for (const p of candidates) {
        try {
          if (p && existsSync(p)) return p
        } catch {
          /* 忽略：继续试下一个 */
        }
      }
      return undefined
    })(),
    // 完全自绘标题栏：用 frame:false 去掉系统边框与按钮，
    // 最小化/最大化/关闭由渲染层自己画，布局完全可控
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.once('ready-to-show', () => win?.show())

  // 最大化状态变化时通知渲染层，用于切换按钮图标
  const notifyMaximize = () => win?.webContents.send('window:maximized', win.isMaximized())
  win.on('maximize', notifyMaximize)
  win.on('unmaximize', notifyMaximize)

  // 外链一律用系统浏览器打开，禁止在应用内跳转
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

/** 窗口控制：渲染层自绘按钮调用 */
ipcMain.handle('window:minimize', () => win?.minimize())
ipcMain.handle('window:toggleMaximize', () => {
  if (!win) return false
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
  return win.isMaximized()
})
ipcMain.handle('window:close', () => win?.close())

/* ── AI ──
   请求走主进程而不是渲染进程：渲染进程的 fetch 会被目标服务的 CORS 拦
   （尤其是 Ollama 这类本地服务），主进程的 net.fetch 没有同源限制。
   接口统一用 OpenAI 兼容的 /chat/completions，本地与云端都能覆盖。 */

interface AiRequest {
  baseUrl: string
  model: string
  apiKey: string
  system: string
  temperature: number
}
type ChatMessage = { role: string; content: string }

function aiEndpoint(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, '') + '/chat/completions'
}

function aiHeaders(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey.trim()) h.Authorization = `Bearer ${apiKey.trim()}`
  return h
}

/** 本地模型可能几十秒才吐第一个字，超时给得宽一点 */
const AI_TIMEOUT_MS = 120_000

function aiError(e: unknown): string {
  const err = e as { name?: string; message?: string }
  if (err?.name === 'AbortError') return `请求超时（超过 ${AI_TIMEOUT_MS / 1000} 秒）`
  const msg = err?.message ?? String(e)
  // 连接不上是最常见的情况，把最可能的病因直接说出来
  if (/ECONNREFUSED|fetch failed|net::ERR_CONNECTION_REFUSED/i.test(msg)) {
    return '连不上目标地址。确认服务已启动、地址和端口没写错。'
  }
  return msg
}

/** 一段模型返回。text 是回答，reasoning 是推理过程（思考型模型才有） */
interface AiPiece {
  text?: string
  reasoning?: string
  /** 流结束 */
  done?: boolean
}

/** 非流式返回体里可能出现的两种字段名：content 是回答，reasoning_content 是思考 */
function pickReasoning(msg: Record<string, unknown> | undefined): string {
  if (!msg) return ''
  const v = msg.reasoning_content ?? msg.reasoning
  return typeof v === 'string' ? v : ''
}

ipcMain.handle(
  'ai:chat',
  async (
    e,
    cfg: AiRequest,
    messages: ChatMessage[],
  ): Promise<{ ok: boolean; text?: string; reasoning?: string; error?: string }> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS)
    const push = (p: AiPiece) => {
      if (!e.sender.isDestroyed()) e.sender.send('ai:delta', p)
    }
    try {
      const body: ChatMessage[] = cfg.system.trim()
        ? [{ role: 'system', content: cfg.system.trim() }, ...messages]
        : messages
      const res = await net.fetch(aiEndpoint(cfg.baseUrl), {
        method: 'POST',
        headers: aiHeaders(cfg.apiKey),
        body: JSON.stringify({
          model: cfg.model,
          messages: body,
          temperature: cfg.temperature,
          stream: true,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        return { ok: false, error: `HTTP ${res.status} ${detail.slice(0, 200)}` }
      }

      // 有的服务不认 stream:true，原样回了完整 JSON —— 那就当非流式处理
      const ctype = res.headers.get('content-type') ?? ''
      if (!ctype.includes('event-stream')) {
        const data = (await res.json()) as {
          choices?: { message?: { content?: string; reasoning_content?: string } }[]
        }
        const msg = data?.choices?.[0]?.message
        const text = msg?.content
        if (typeof text !== 'string') return { ok: false, error: '返回里没有文本内容' }
        const reasoning = pickReasoning(msg as Record<string, unknown>)
        if (reasoning) push({ reasoning })
        push({ text })
        return { ok: true, text, reasoning }
      }

      /* SSE：一段一段读，攒出回答与推理。每读到一块就发给渲染进程，
         这样面板上的「思考过程」是真的在往外流，而不是转完圈才一次性冒出来。 */
      const reader = res.body?.getReader()
      if (!reader) return { ok: false, error: '响应没有内容' }
      const decoder = new TextDecoder()
      let buf = ''
      let text = ''
      let reasoning = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // SSE 以空行分帧；半截的留在 buf 里等下一块
        let cut = buf.indexOf('\n\n')
        while (cut >= 0) {
          const frame = buf.slice(0, cut)
          buf = buf.slice(cut + 2)
          cut = buf.indexOf('\n\n')
          for (const line of frame.split('\n')) {
            const raw = line.startsWith('data:') ? line.slice(5).trim() : ''
            if (!raw || raw === '[DONE]') continue
            let piece: { choices?: { delta?: Record<string, unknown> }[] }
            try {
              piece = JSON.parse(raw)
            } catch {
              continue
            }
            const d = piece?.choices?.[0]?.delta
            if (!d) continue
            const r = pickReasoning(d)
            if (r) {
              reasoning += r
              push({ reasoning: r })
            }
            const c = d.content
            if (typeof c === 'string' && c) {
              text += c
              push({ text: c })
            }
          }
        }
      }
      // 有些实现最后一帧不带空行收尾，把它也吃掉
      decoder.decode()
      if (!text && !reasoning) return { ok: false, error: '流里没有收到任何内容' }
      push({ done: true })
      return { ok: true, text: text || '（模型只返回了思考过程）', reasoning }
    } catch (err) {
      return { ok: false, error: aiError(err) }
    } finally {
      clearTimeout(timer)
    }
  },
)

/** 测试连接：拉一次 /models，顺带把可用模型列出来方便直接挑 */
ipcMain.handle(
  'ai:test',
  async (
    _e,
    cfg: AiRequest,
  ): Promise<{ ok: boolean; models?: string[]; error?: string }> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const base = cfg.baseUrl.trim().replace(/\/+$/, '')
      const res = await net.fetch(base + '/models', {
        method: 'GET',
        headers: aiHeaders(cfg.apiKey),
        signal: controller.signal,
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        return { ok: false, error: `HTTP ${res.status} ${detail.slice(0, 160)}` }
      }
      const data = (await res.json()) as { data?: { id?: string }[] }
      const models = (data?.data ?? []).map((m) => m.id ?? '').filter(Boolean)
      return { ok: true, models }
    } catch (e) {
      return { ok: false, error: aiError(e) }
    } finally {
      clearTimeout(timer)
    }
  },
)

/** 运行环境版本：设置里「关于」一页要展示，只能从主进程拿 */
ipcMain.handle('app:info', () => ({
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
}))

/* ── IPC：文件系统操作，全部在主进程执行，渲染进程只能通过白名单调用 ── */

/* ── 工作区内的隐藏目录 ──
   .nota 放应用自己产生的东西（回收站、索引等），和笔记混在一起会污染目录树，
   所以单独藏起来；名字带点前缀，文件管理器里也不显眼。 */
const NOTA_DIR = '.nota'
const TRASH_DIR = 'trash'
const ATTACH_DIR = 'attachments'

/** 当前工作区根。删除/回收站都要知道"相对工作区的路径"才能还原回去 */
let workspaceRoot: string | null = null

function trashDirOf(root: string) {
  return path.join(root, NOTA_DIR, TRASH_DIR)
}

/** 原路径 → 安全文件名。Windows 文件名吃不下 `\ / :` 这些，用 base64url 编码 */
function trashKey(rel: string) {
  return Buffer.from(rel, 'utf8').toString('base64url')
}

// 选择工作区目录
ipcMain.handle('workspace:pick', async () => {
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title: '选择笔记目录',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// 递归读取目录树（只读 .md，跳过隐藏目录）
// 顺带把每篇笔记 frontmatter 里的 tags 摘出来挂在节点上，
// 这样侧栏的标签筛选不用再为每个文件单独发一次 IPC。
// 正文开头也顺手截一句摘要——笔记列表栏要显示，读的是同一个文件头，
// 不额外开销一次 IO。
ipcMain.handle('workspace:tree', async (_e, root: string) => {
  workspaceRoot = root

  /** 从正文里摘一段能当摘要的纯文本：去掉标记符号，只留内容 */
  function excerptOf(body: string) {
    return body
      .replace(/```[\s\S]*?```/g, ' ')        // 代码块整段丢
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')  // 图片
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接只留文字
      .replace(/^\s{0,3}#{1,6}\s+/gm, ' ')    // 标题号
      .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, ' ') // 列表号
      .replace(/[`*_>~|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  async function readMeta(
    file: string,
  ): Promise<{ tags: string[]; starred: boolean; excerpt: string }> {
    const empty = { tags: [] as string[], starred: false, excerpt: '' }
    try {
      // 只读文件头部：frontmatter 一定在最前面，不必整篇读进来
      const fd = await fs.open(file, 'r')
      try {
        const buf = Buffer.alloc(2048)
        const { bytesRead } = await fd.read(buf, 0, 2048, 0)
        const head = buf.subarray(0, bytesRead).toString('utf-8')
        const m = head.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        const tags: string[] = []
        let starred = false
        if (m) {
          // inline 形式：tags: [a, b]
          const inline = m[1].match(/^tags:\s*\[([^\]]*)\]/m)
          if (inline) {
            for (const t of inline[1].split(',')) {
              const v = t.trim().replace(/^["']|["']$/g, '')
              if (v) tags.push(v)
            }
          }
          // 列表形式：
          // tags:
          //   - a
          //   - b
          const listBlock = m[1].match(/^tags:\s*\n((?:[ \t]*-[ \t]*.+\n?)*)/m)
          if (listBlock) {
            for (const line of listBlock[1].split('\n')) {
              const v = line.replace(/^[ \t]*-[ \t]*/, '').trim().replace(/^["']|["']$/g, '')
              if (v) tags.push(v)
            }
          }
          starred = /^(star|starred|favorite|favourite):\s*(true|yes|1)\s*$/im.test(m[1])
        }
        const body = m ? head.slice(m[0].length) : head
        return {
          tags: [...new Set(tags)],
          starred,
          excerpt: excerptOf(body).slice(0, 110),
        }
      } finally {
        await fd.close()
      }
    } catch {
      return empty
    }
  }

  async function walk(dir: string, depth: number): Promise<any[]> {
    if (depth > 6) return []
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const nodes: any[] = []
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.name === 'node_modules') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        nodes.push({
          type: 'dir',
          name: e.name,
          path: full,
          children: await walk(full, depth + 1),
        })
      } else if (e.name.toLowerCase().endsWith('.md')) {
        const meta = await readMeta(full)
        let mtime = 0
        try {
          mtime = (await fs.stat(full)).mtimeMs
        } catch {
          mtime = 0
        }
        nodes.push({
          type: 'file',
          name: e.name,
          path: full,
          tags: meta.tags,
          starred: meta.starred,
          excerpt: meta.excerpt,
          mtime,
        })
      }
    }
    // 目录在前，文件在后，各自按名称排序
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    return nodes
  }
  return walk(root, 0)
})

/* ── 导入 ──
   把工作区外面的 Markdown 收进来。和「插图」不同：插图只引用原文件、
   把副本放进 attachments/；导入是真的把笔记复制进工作区，之后它就是
   这里的一篇普通笔记，可以改名、可以进回收站。 */
ipcMain.handle(
  'note:import',
  async (_e, root: string, dir?: string): Promise<{ name: string; path: string }[]> => {
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      title: '导入笔记',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return []

    const target = dir || root
    if (!target) return []
    await fs.mkdir(target, { recursive: true })

    const out: { name: string; path: string }[] = []
    for (const src of result.filePaths) {
      try {
        const content = await fs.readFile(src, 'utf8')
        const base =
          path.basename(src, path.extname(src)).replace(/[\\/:*?"<>|]/g, '-').trim() ||
          '导入的笔记'
        let name = `${base}.md`
        let full = path.join(target, name)
        let i = 1
        // 重名就往后加序号，绝不覆盖已有的笔记
        while (existsSync(full)) {
          name = `${base} ${i}.md`
          full = path.join(target, name)
          i++
        }
        await fs.writeFile(full, content, 'utf8')
        out.push({ name, path: full })
      } catch {
        /* 单个文件读不出来不该拖垮整次导入 */
      }
    }
    return out
  },
)

// 新建文件夹（父目录下，重名自动加序号）
ipcMain.handle('folder:create', async (_e, parent: string, name: string) => {
  const safe = name.replace(/[\\/:*?"<>|]/g, '-').trim() || '新建文件夹'
  let target = path.join(parent, safe)
  let i = 1
  while (true) {
    try {
      await fs.access(target)
      target = path.join(parent, `${safe} ${i}`)
      i++
    } catch {
      break
    }
  }
  await fs.mkdir(target, { recursive: true })
  return target
})

// 读单个文件
ipcMain.handle('note:read', async (_e, file: string) => {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch {
    return ''
  }
})

// 写单个文件（自动建父目录）
ipcMain.handle('note:write', async (_e, file: string, content: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, 'utf-8')
  return true
})

// 新建笔记
ipcMain.handle('note:create', async (_e, dir: string, name: string) => {
  const safe = name.replace(/[\\/:*?"<>|]/g, '-').trim() || '未命名'
  let target = path.join(dir, `${safe}.md`)
  let i = 1
  // 避免重名
  while (true) {
    try {
      await fs.access(target)
      target = path.join(dir, `${safe} ${i}.md`)
      i++
    } catch {
      break
    }
  }
  await fs.writeFile(target, '', 'utf-8')
  return target
})

// 删除：移进工作区内的 .nota/trash，而不是系统回收站。
// 系统回收站只认"文件名"，笔记恢复时不知道该放回哪个子目录，
// 所以这里把「相对工作区的原路径」一并存进 sidecar json。
ipcMain.handle('note:delete', async (_e, file: string) => {
  const root = workspaceRoot
  if (!root || !file.startsWith(root)) {
    // 没有工作区上下文（比如单文件预览）时退回系统回收站，总比直接删除好
    await shell.trashItem(file)
    return true
  }
  const rel = path.relative(root, file).replace(/\\/g, '/')
  const key = trashKey(rel)
  const dir = trashDirOf(root)
  await fs.mkdir(dir, { recursive: true })
  await fs.rename(file, path.join(dir, `${key}.md`))
  await fs.writeFile(
    path.join(dir, `${key}.json`),
    JSON.stringify({ rel, name: path.basename(file), deletedAt: Date.now() }),
    'utf8',
  )
  return true
})

/* ── 回收站 ── */
interface TrashItem {
  key: string
  rel: string
  name: string
  deletedAt: number
  size: number
}

ipcMain.handle('trash:list', async (_e, root: string): Promise<TrashItem[]> => {
  const dir = trashDirOf(root)
  try {
    await fs.access(dir)
  } catch {
    return []
  }
  const files = await fs.readdir(dir)
  const out: TrashItem[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const key = f.slice(0, -5)
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))
      const size = await fs.stat(path.join(dir, `${key}.md`)).then(
        (s) => s.size,
        () => 0,
      )
      out.push({ key, rel: meta.rel, name: meta.name, deletedAt: meta.deletedAt, size })
    } catch {
      /* 元信息坏了就跳过这一条，别让整页挂掉 */
    }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt)
})

ipcMain.handle('trash:restore', async (_e, root: string, key: string) => {
  const dir = trashDirOf(root)
  const meta = JSON.parse(await fs.readFile(path.join(dir, `${key}.json`), 'utf8'))
  const target = path.join(root, meta.rel)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.rename(path.join(dir, `${key}.md`), target)
  await fs.rm(path.join(dir, `${key}.json`), { force: true })
  return target
})

ipcMain.handle('trash:purge', async (_e, root: string, key: string) => {
  const dir = trashDirOf(root)
  await fs.rm(path.join(dir, `${key}.md`), { force: true })
  await fs.rm(path.join(dir, `${key}.json`), { force: true })
  return true
})

ipcMain.handle('trash:empty', async (_e, root: string) => {
  await fs.rm(trashDirOf(root), { recursive: true, force: true })
  return true
})

/* ── 附件库 ──
   工作区 attachments/ 下的图片视频。笔记引用它们是相对路径，
   这里列出真实文件，方便直接插入到正在写的笔记里。 */
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|mp4|webm|mov|m4v|ogv|mkv|avi)$/i

ipcMain.handle(
  'attach:list',
  async (
    _e,
    root: string,
  ): Promise<{ rel: string; name: string; size: number; mtime: number; isVideo: boolean }[]> => {
    const dir = path.join(root, ATTACH_DIR)
    try {
      await fs.access(dir)
    } catch {
      return []
    }
    const files = await fs.readdir(dir)
    const out: { rel: string; name: string; size: number; mtime: number; isVideo: boolean }[] = []
    for (const name of files) {
      if (!MEDIA_EXT.test(name)) continue
      try {
        const s = await fs.stat(path.join(dir, name))
        if (!s.isFile()) continue
        out.push({
          rel: `${ATTACH_DIR}/${name}`,
          name,
          size: s.size,
          mtime: s.mtimeMs,
          isVideo: /\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/i.test(name),
        })
      } catch {
        /* 单个文件读不到不影响其余 */
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime)
  },
)

ipcMain.handle('attach:delete', async (_e, root: string, rel: string) => {
  await fs.rm(path.join(root, rel), { force: true })
  return true
})

// 重命名
ipcMain.handle('note:rename', async (_e, file: string, newName: string) => {
  const safe = newName.replace(/[\\/:*?"<>|]/g, '-').trim() || '未命名'
  const target = path.join(path.dirname(file), `${safe}.md`)
  if (target === file) return file
  await fs.rename(file, target)
  return target
})

// 选择本地图片/视频并复制进工作区的 attachments 目录，返回相对路径供 Markdown 引用。
// 复制而非引用原路径：笔记目录自带素材，换机器/备份时不丢图。
const MEDIA_FILTERS: Record<string, { name: string; extensions: string[] }[]> = {
  image: [
    { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] },
  ],
  video: [
    { name: '视频', extensions: ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi'] },
  ],
  any: [
    { name: '图片与视频', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi'] },
    { name: '所有文件', extensions: ['*'] },
  ],
}

ipcMain.handle('image:pick', async (_e, workspace: string, kind: string = 'image') => {
  if (!win) return null
  const filters = MEDIA_FILTERS[kind] ?? MEDIA_FILTERS.image
  const result = await dialog.showOpenDialog(win, {
    title: kind === 'video' ? '插入视频' : kind === 'any' ? '插入图片或视频' : '插入图片',
    properties: ['openFile'],
    filters,
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const source = result.filePaths[0]
  const ext = path.extname(source).toLowerCase()
  const base = path.basename(source, path.extname(source)).replace(/[\\/:*?"<>|]/g, '-')
  // 让渲染层知道插进来的是视频还是图片，好决定用 <video> 还是 <img>
  const isVideo = /\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/i.test(ext)

  // 没选工作区时退化为返回绝对路径（让预览也能显示）
  if (!workspace) {
    return { rel: path.resolve(source).replace(/\\/g, '/'), alt: base, copied: false, isVideo }
  }

  const dir = path.join(workspace, 'attachments')
  await fs.mkdir(dir, { recursive: true })

  let fileName = `${base}${ext || '.png'}`
  let target = path.join(dir, fileName)
  let i = 1
  while (true) {
    try {
      await fs.access(target)
      fileName = `${base} ${i}${ext || '.png'}`
      target = path.join(dir, fileName)
      i++
    } catch {
      break
    }
  }

  await fs.copyFile(source, target)
  return {
    rel: `attachments/${fileName}`.replace(/\\/g, '/'),
    alt: base,
    copied: true,
    isVideo,
  }
})

/* ── 导出 ──
   三种格式：
    - md   ：直接把源文件另存一份，最保真
    - html ：带上内联样式与内容，独立可打开的网页
    - pdf  ：让渲染进程把预览页打印成 PDF（这里只负责弹保存框 + 写文件）
   统一走「弹保存框 → 写文件」，返回最终路径（取消返回 null）。 */
ipcMain.handle('export:save', async (_e, opts: { defaultName: string; kind: string; data: string }) => {
  if (!win) return null
  const filters =
    opts.kind === 'html'
      ? [{ name: '网页', extensions: ['html'] }]
      : opts.kind === 'pdf'
        ? [{ name: 'PDF', extensions: ['pdf'] }]
        : [{ name: 'Markdown', extensions: ['md'] }]

  const result = await dialog.showSaveDialog(win, {
    title: '导出',
    defaultPath: opts.defaultName,
    filters,
  })
  if (result.canceled || !result.filePath) return null

  // pdf 的 data 是 base64（渲染进程已经在那边渲染好了）
  if (opts.kind === 'pdf') {
    await fs.writeFile(result.filePath, Buffer.from(opts.data, 'base64'))
  } else {
    await fs.writeFile(result.filePath, opts.data, 'utf8')
  }
  return result.filePath
})

/* ── 版本历史 ──
   每篇笔记在 .nota-history/<相对路径>/<时间戳>.md 下留快照。
   存成文件而不是塞进一个 json：出问题时用户能直接用记事本打开看，
   也不需要担心 json 被写坏导致整份历史全丢。 */
function historyDir(workspace: string, file: string) {
  const rel = path.relative(workspace, file).replace(/\\/g, '/')
  // 把路径里的斜杠换成安全的层级，避免子目录名跟文件名混淆
  const safe = rel.replace(/\.md$/i, '').replace(/\//g, '__')
  return path.join(workspace, '.nota-history', safe)
}

ipcMain.handle('history:save', async (_e, workspace: string, file: string, content: string) => {
  if (!workspace || !file) return null
  const dir = historyDir(workspace, file)
  await fs.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(dir, `${stamp}.md`)
  await fs.writeFile(target, content, 'utf8')
  // 只保留最近 40 份，避免历史无限堆积（用改名不动，直接删旧快照是安全的）
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md')).sort()
  if (files.length > 40) {
    for (const f of files.slice(0, files.length - 40)) {
      await fs.rm(path.join(dir, f), { force: true })
    }
  }
  return target
})

ipcMain.handle('history:list', async (_e, workspace: string, file: string) => {
  if (!workspace || !file) return []
  const dir = historyDir(workspace, file)
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'))
    const items = await Promise.all(
      files.map(async (f) => {
        const full = path.join(dir, f)
        const stat = await fs.stat(full)
        return { name: f, path: full, size: stat.size, mtime: stat.mtimeMs }
      }),
    )
    // 新的在前
    return items.sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
})

ipcMain.handle('history:read', async (_e, snapshot: string) => {
  try {
    return await fs.readFile(snapshot, 'utf8')
  } catch {
    return null
  }
})

/* ── 生命周期 ── */

/**
 * 把 nota-media:// 的请求映射到真实文件。
 *
 * URL 形态：nota-media://local/<工作区绝对路径>?  —— 不用，因为工作区路径
 * 里可能有中文、空格、盘符。改成用 pathname 承载「已编码的绝对路径」：
 *   nota-media://local/E%3A%5Cnotes%5Cattachments%5Ca.png
 * renderer 侧统一用 mediaUrl(absPath) 生成，这里解码后 net.fetch 一个
 * file:// URL —— net.fetch 支持 file 协议，且能正确处理 Range/流。
 */
function registerMediaProtocol() {
  protocol.handle('nota-media', (request) => {
    try {
      const u = new URL(request.url)
      // nota-media://local/<encoded abs path>
      const encoded = u.pathname.replace(/^\/+/, '')
      const abs = decodeURIComponent(encoded)
      if (!abs) return new Response('bad path', { status: 400 })
      return net.fetch(pathToFileURL(abs).toString())
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

/**
 * percent-encoded 路径的解码候选。
 *
 * Markdown 的图片地址会被 marked 走一遍 encodeURI，于是笔记里写的
 * `attachments/【哲风壁纸】… .jpg` 到了 HTML 里变成 `%E3%80%90…%20.jpg`。
 * 而 <video src> 是我们自己写的原始 HTML，marked 不碰，仍是原文。
 * 结果就是同一个目录下的图和视频，一个能显示一个裂开——因为前者
 * 拿去 resolve 的是一个带 %XX 的字面路径，磁盘上根本不存在这个文件。
 *
 * 所以：含 %XX 时把解码后的形式排在前面，原文留作兜底
 * （文件名里真的写了 %20 这种字面量时不至于找错）。
 */
function pathCandidates(rel: string): string[] {
  if (!/%[0-9a-fA-F]{2}/.test(rel)) return [rel]
  try {
    const decoded = decodeURIComponent(rel)
    return decoded === rel ? [rel] : [decoded, rel]
  } catch {
    return [rel]
  }
}

/** 渲染层把相对路径交给主进程换算成 nota-media:// 绝对 URL */
ipcMain.handle('media:resolve', (_e, base: string, rel: string) => {
  if (!rel) return null
  // 已经是绝对 URL 或 data URI 就原样返回，交给浏览器处理
  if (/^(https?:|data:|nota-media:)/i.test(rel)) return rel
  // 绝对文件路径（插入时未选工作区的情况）
  if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('file://')) {
    const p = rel.startsWith('file://') ? rel.replace(/^file:\/\/\/?/, '') : rel
    return mediaUrl(p)
  }
  if (!base) return null
  // 相对于工作区根目录解析，并归一化掉 ../ 之类；
  // 解码前后都试一下，磁盘上真实存在的那个优先
  const abs = pathCandidates(rel).map((r) => path.resolve(base, r))
  return mediaUrl(abs.find((p) => existsSync(p)) ?? abs[0])
})

/** 绝对路径 → nota-media URL（统一正斜杠 + 编码，避免中文/空格/盘符出错） */
function mediaUrl(abs: string) {
  const norm = abs.replace(/\\/g, '/')
  return 'nota-media://local/' + encodeURIComponent(norm)
}

app.whenReady().then(() => {
  registerMediaProtocol()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
