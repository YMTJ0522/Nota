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

/* ── IPC：文件系统操作，全部在主进程执行，渲染进程只能通过白名单调用 ── */

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
ipcMain.handle('workspace:tree', async (_e, root: string) => {
  async function readTags(file: string): Promise<string[]> {
    try {
      // 只读文件头部：frontmatter 一定在最前面，不必整篇读进来
      const fd = await fs.open(file, 'r')
      try {
        const buf = Buffer.alloc(2048)
        const { bytesRead } = await fd.read(buf, 0, 2048, 0)
        const head = buf.subarray(0, bytesRead).toString('utf-8')
        const m = head.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        if (!m) return []
        const tags: string[] = []
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
        return [...new Set(tags)]
      } finally {
        await fd.close()
      }
    } catch {
      return []
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
        nodes.push({ type: 'file', name: e.name, path: full, tags: await readTags(full) })
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

// 删除（移入回收站，不直接抹掉）
ipcMain.handle('note:delete', async (_e, file: string) => {
  await shell.trashItem(file)
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
  // 相对于工作区根目录解析，并归一化掉 ../ 之类
  const abs = path.resolve(base, rel)
  return mediaUrl(abs)
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
