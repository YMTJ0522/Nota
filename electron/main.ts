import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'

// Vite 注入：开发环境指向 dev server，生产环境加载打包后的 dist
process.env.APP_ROOT = path.join(__dirname, '..')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

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
ipcMain.handle('workspace:tree', async (_e, root: string) => {
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
        nodes.push({ type: 'file', name: e.name, path: full })
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

// 选择本地图片并复制进工作区的 attachments 目录，返回相对路径供 Markdown 引用。
// 复制而非引用原路径：笔记目录自带素材，换机器/备份时不丢图。
ipcMain.handle('image:pick', async (_e, workspace: string) => {
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title: '插入图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const source = result.filePaths[0]
  const ext = path.extname(source).toLowerCase()
  const base = path.basename(source, path.extname(source)).replace(/[\\/:*?"<>|]/g, '-')

  // 没选工作区时退化为返回绝对路径（file:// 形式让预览也能显示）
  if (!workspace) {
    return { rel: path.resolve(source).replace(/\\/g, '/'), alt: base, copied: false }
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
  }
})

/* ── 生命周期 ── */

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
