import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  protocol,
  net,
  session,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
} from 'electron'
import type { NativeImage } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { testConnection, syncWorkspace, onSyncProgress } from './sync'
import { maybeRunInstaller } from './installer'
import { ensureVault, ensureVaultAt, readVaultPointer, takeFreshFlag } from './vault'
import { checkUpdate } from './update'
import { readPrefs, writePrefs } from './prefs'
import {
  closeAllStickies,
  flushAll as flushStickies,
  initStickyWindows,
  openNewSticky,
  openSticky,
  openStickyCount,
  requestCloseSticky,
  saveStickyText,
  setStickyColor,
  setStickyPinned,
} from './sticky-window'
import {
  batchPatch as batchPatchStickies,
  listStickies,
  patchSticky,
  readSticky,
  reconcileOnBoot,
  removeStickies,
  removeSticky,
  renameSticky,
  saveToVault as saveStickyToVault,
} from './stickies'

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
let tray: Tray | null = null
/** 真退出时为 true。关窗口默认只是收进托盘，只有走「退出」那条路才放行 */
let isQuitting = false

/**
 * 图标。打包后在 resources/，开发时在仓库的 build/ 里，两条都试。
 * 抽成函数是因为现在有三处要用：主窗口、便签窗口、托盘。
 */
function resolveIcon(): string | undefined {
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
}

/** 托盘图标要小尺寸，直接拿 1024 的 png 塞进去，Windows 上会糊成一团 */
function resolveTrayIcon(): NativeImage | null {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'icon.ico'),
    path.join(__dirname, '..', 'build', 'icon.ico'),
  ]
  for (const p of candidates) {
    try {
      if (p && existsSync(p)) {
        const img = nativeImage.createFromPath(p)
        if (!img.isEmpty()) return img
      }
    } catch {
      /* 下一个 */
    }
  }
  const png = resolveIcon()
  if (!png) return null
  const img = nativeImage.createFromPath(png)
  return img.isEmpty() ? null : img.resize({ width: 16, height: 16 })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    // 三栏 + 编辑区顶行那一排，低于这个宽度就装不下了：再窄下去，
    // 顶行的东西会被挤出窗口（连窗口按钮一起出去了）。
    // 想要更窄＝把侧栏收成窄轨，而不是让整排东西互相压。
    minWidth: 960,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#fbfaf6',
    title: 'Nota',
    /* 标题栏与任务栏图标 */
    icon: resolveIcon(),
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

  /* 点右上角那颗叉不再退出程序，只把它收进托盘 —— 这是便签功能能成立的
     前提。便签的使用场景是「用电脑的时候突然想到一件事」，那个时刻
     Nota 多半是关着的；如果关窗口就把进程杀了，全局快捷键同一时刻失效，
     按下去什么都不会发生，这个功能就等于没有。

     要真正退出走托盘右键里的「退出 Nota」，那条路会把 isQuitting 立起来。 */
  win.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    win?.hide()
    tipTrayOnce()
  })

  win.on('closed', () => {
    win = null
  })

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

/* ═══════════ 桌面整合：托盘 · 全局快捷键 · 开机自启 ═══════════
 *
 * 这三件事是一个整体，缺一不可：
 *   托盘    —— 让「关窗口不退进程」有个去处，否则主窗一关用户就找不到它了
 *   快捷键  —— 便签真正的入口。桌面图标点两次才记下一句话，这个功能就白做
 *   自启动  —— 上面两样都要在 Nota 没被打开的时候也成立
 *
 * 全放主进程，是因为它们都得在**没有窗口**的时候工作。
 */

/**
 * 安装时选的笔记目录、界面状态、便签，全都拼在 %LOCALAPPDATA%\Nota\ 下面。
 * 不用 app.getPath('userData')：那个在免安装版里可能被重定向到临时解压目录，
 * 同一个用户装两次会算成两个位置。
 */
const LOCAL_APP_DATA =
  process.env.LOCALAPPDATA ||
  (process.platform === 'win32'
    ? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
    : app.getPath('appData'))

/** 快捷键。用户可以整组关掉（设置里），但键位不给改：能改的话
    设置页要做键位录制控件，还得处理各种非法组合，收益不抵成本 */
const HOTKEY_NEW = 'CommandOrControl+Alt+N'
const HOTKEY_CLOSE_ALL = 'CommandOrControl+Alt+Shift+N'

/** 快捷键没注册上的原因。界面问的时候要能说清楚，而不是静默失效 */
let hotkeyError = ''
/** 最近一次打开的工作区。便签「存为笔记」要知道往哪存 */
let activeRoot: string | null = null

/** 免安装版：每次启动会解压到 %TEMP% 下的随机目录，写进注册表的自启路径
    第二天就不存在了。所以自启只对安装版开放 */
function isPortable(): boolean {
  const p = process.env.PORTABLE_EXECUTABLE_FILE ?? ''
  return (
    /portable/i.test(path.basename(p)) || /portable/i.test(path.basename(process.execPath))
  )
}

function canAutoStart(): boolean {
  // 开发模式下 execPath 是 node_modules 里的 electron.exe，写进注册表纯属污染
  return app.isPackaged && !isPortable()
}

function loginAtStartup(): boolean {
  if (!canAutoStart()) return false
  try {
    return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin
  } catch {
    return false
  }
}

/**
 * 开/关自启。--hidden 这个参数很关键：开机时只把托盘和快捷键带起来，
 * 不建主窗口 —— 早上开机第一件事不是看笔记，白占 100MB 内存没有意义。
 */
async function setAutoStart(on: boolean): Promise<boolean> {
  if (!canAutoStart()) return false
  try {
    app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] })
  } catch (e) {
    console.error('[autostart] 写注册表失败：', e)
    return false
  }
  await writePrefs(LOCAL_APP_DATA, { openAtLogin: on })
  await refreshTrayMenu()
  return loginAtStartup() === on
}

function showMain(): void {
  /* 刚建出来的窗口不能立刻 show：它是 show:false 建的，loadURL 还没回来，
     这时候亮出来是一块白屏。那种情况交给 ready-to-show（见 createWindow）。 */
  const created = !win || win.isDestroyed()
  if (created) createWindow()
  const w = win
  if (!w) return
  if (created) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

/**
 * 第一次收进托盘时解释一句。
 * 「点了叉，程序还在跑」如果不说明，用户会以为是关不掉 —— 或者更糟，
 * 以为关掉了，然后在任务管理器里发现它一直在。
 */
let trayTipShown = false
function tipTrayOnce(): void {
  if (trayTipShown || !tray || process.platform !== 'win32') return
  trayTipShown = true
  try {
    tray.displayBalloon({
      title: 'Nota 还在后台运行',
      content: `关窗口只是收进托盘。按 ${HOTKEY_NEW.replace('CommandOrControl', 'Ctrl')} 随时记一张便签；要退出请右键托盘图标。`,
      iconType: 'info',
    })
  } catch {
    /* 气泡弹不出来不影响使用 */
  }
}

/** 快捷键按下：开一张新便签。连按就连开，这是刻意的 */
async function onHotkeyNew(): Promise<void> {
  const r = await openNewSticky()
  if ('error' in r) {
    // 开不出来至少要让用户看见原因（多半是「已经开了 12 张」）
    if (win && !win.isDestroyed()) win.webContents.send('sticky:error', r.error)
    else showMain()
  }
  await refreshTrayMenu()
}

function buildTray(): void {
  const img = resolveTrayIcon()
  if (!img) {
    /* 拿不到图标就不建托盘。这时「关窗不退」会让程序彻底失联，
       所以下面 boot() 里会强制把主窗建出来 */
    return
  }
  tray = new Tray(img)
  tray.setToolTip('Nota · 按 Ctrl+Alt+N 记一张便签')
  tray.on('click', () => showMain())
  void refreshTrayMenu()
}

async function refreshTrayMenu(): Promise<void> {
  if (!tray || tray.isDestroyed()) return
  const prefs = await readPrefs(LOCAL_APP_DATA)
  const n = openStickyCount()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 Nota', click: () => showMain() },
      {
        label: n > 0 ? `新便签（已开 ${n} 张）` : '新便签',
        // 只用来显示键位，真正的注册在 applyHotkeys 里做
        accelerator: HOTKEY_NEW,
        registerAccelerator: false,
        click: () => void onHotkeyNew(),
      },
      {
        label: '收起全部便签',
        accelerator: HOTKEY_CLOSE_ALL,
        registerAccelerator: false,
        enabled: n > 0,
        click: () => void closeAllStickies().then(() => refreshTrayMenu()),
      },
      { type: 'separator' },
      {
        label: '开机时自动启动',
        type: 'checkbox',
        checked: loginAtStartup(),
        enabled: canAutoStart(),
        click: (item) => void setAutoStart(item.checked),
      },
      {
        label: prefs.hotkey
          ? hotkeyError
            ? `快捷键没注册：${hotkeyError}`
            : '全局快捷键已开启'
          : '全局快捷键已关闭',
        enabled: false,
      },
      { type: 'separator' },
      { label: '退出 Nota', click: () => app.quit() },
    ]),
  )
}

/**
 * 注册 / 注销快捷键。
 * globalShortcut.register 返回 false 表示这个组合已经被别的程序占了 ——
 * 必须把这个结果说出来，否则用户按下去毫无反应，只会以为软件坏了。
 */
async function applyHotkeys(): Promise<void> {
  globalShortcut.unregisterAll()
  hotkeyError = ''
  const prefs = await readPrefs(LOCAL_APP_DATA)
  if (prefs.hotkey) {
    const okNew = globalShortcut.register(HOTKEY_NEW, () => void onHotkeyNew())
    const okAll = globalShortcut.register(HOTKEY_CLOSE_ALL, () =>
      void closeAllStickies().then(() => refreshTrayMenu()),
    )
    if (!okNew) hotkeyError = `${HOTKEY_NEW.replace('CommandOrControl', 'Ctrl')} 被别的程序占用`
    else if (!okAll)
      hotkeyError = `${HOTKEY_CLOSE_ALL.replace('CommandOrControl', 'Ctrl')} 被别的程序占用`
    if (hotkeyError) console.warn('[hotkey]', hotkeyError)
  }
  await refreshTrayMenu()
}

/* ── 便签的 IPC ──
   全部由主进程直接读写磁盘，不经过主窗口：便签窗口和主窗口之间没有依赖，
   主窗收在托盘里甚至从没建过的时候，便签照样能存。 */

const stickyDirOf = () => path.join(LOCAL_APP_DATA, 'Nota', 'stickies')

/**
 * 便签「存为笔记」的落点。
 * 优先用当前打开的工作区（渲染层会报上来），没有就用安装时选的目录，
 * 再没有就退回 文档\Nota —— 三档都会在写的时候 mkdir，不存在也能建起来。
 */
async function vaultForSticky(): Promise<string | null> {
  if (activeRoot) return activeRoot
  const p = await readVaultPointer(LOCAL_APP_DATA)
  if (p) return p
  try {
    return path.join(app.getPath('documents'), 'Nota')
  } catch {
    return null
  }
}

ipcMain.handle('sticky:load', async (_e, id: string) => {
  const metas = await listStickies(stickyDirOf())
  const m = metas.find((x) => x.id === id)
  if (!m) return null
  return {
    text: await readSticky(stickyDirOf(), id),
    pinned: m.pinned !== false,
    color: m.color ?? 'amber',
    savedTo: m.savedTo,
    tags: m.tags ?? [],
  }
})

ipcMain.handle('sticky:write', async (_e, id: string, text: string) => {
  await saveStickyText(id, text)
})

ipcMain.handle('sticky:close', async (_e, id: string) => {
  await requestCloseSticky(id)
  await refreshTrayMenu()
})

ipcMain.handle('sticky:pin', (_e, id: string, pinned: boolean) => setStickyPinned(id, pinned))

ipcMain.handle('sticky:color', (_e, id: string, color: string) => setStickyColor(id, color))

ipcMain.handle('sticky:saveToVault', async (_e, id: string, archive?: boolean) => {
  const root = await vaultForSticky()
  if (!root) return { ok: false, error: '还没选过笔记目录' }
  const r = await saveStickyToVault(stickyDirOf(), id, root, { archive })
  // 默认存完就收起来了，托盘菜单里那张要跟着消失
  if (r.ok && r.archived) await refreshTrayMenu()
  return r
})

ipcMain.handle('sticky:remove', async (_e, id: string) => {
  await removeSticky(stickyDirOf(), id)
  await refreshTrayMenu()
  return true
})

/* 主窗口这一侧：列表、开一张、开一张已有的、当前工作区、桌面偏好 */
ipcMain.handle('sticky:list', () => listStickies(stickyDirOf()))
ipcMain.handle('sticky:new', () => openNewSticky())
ipcMain.handle('sticky:open', (_e, id: string) => openSticky(id))
ipcMain.handle('sticky:closeAll', async () => {
  const n = await closeAllStickies()
  await refreshTrayMenu()
  return n
})
ipcMain.handle('sticky:count', () => openStickyCount())
ipcMain.handle('sticky:delete', async (_e, id: string) => {
  await removeSticky(stickyDirOf(), id)
  return true
})

/** 便签另存进库之后，列表那边要能立刻看到「已存入」 */
ipcMain.handle('sticky:markSaved', async (_e, id: string, rel: string) => {
  await patchSticky(stickyDirOf(), id, { savedTo: rel })
  return true
})

/* 列表这一屏的管理动作：改名、打标签/换图标、读正文、定位文件。
   全部走主进程落盘，渲染层不碰路径——便签目录不一定在用户想得到的地方。 */
ipcMain.handle('sticky:rename', (_e, id: string, title: string) =>
  renameSticky(stickyDirOf(), id, title),
)

/* 标记 / 归档状态。
   closedAt 传数字是「收起来」，传 null 是「撤回收起」——撤销存为笔记那一步
   走的就是它。传 undefined 的字段一律跳过，别把没提到的字段清掉。 */
type StickyPatchIn = {
  tags?: string[]
  icon?: { kind: 'brand' | 'emoji'; id: string } | null
  closedAt?: number | null
}

ipcMain.handle('sticky:patch', async (_e, id: string, patch: StickyPatchIn) =>
  !!(await patchSticky(stickyDirOf(), id, patch)),
)

/* 一批的同一个改动。多选之后「收起 / 打标签」用它，一次写盘 */
ipcMain.handle('sticky:batchPatch', async (_e, ids: string[], patch: StickyPatchIn) => {
  const n = await batchPatchStickies(stickyDirOf(), ids, patch)
  if ('closedAt' in patch && patch.closedAt != null) await refreshTrayMenu()
  return n
})

/* 关掉一张（列表里批量「收起」用）。没开着的话是空操作，
   它本来就该是收起状态。 */
ipcMain.handle('sticky:closeOne', async (_e, id: string) => {
  await requestCloseSticky(id)
  await refreshTrayMenu()
  return true
})

ipcMain.handle('sticky:deleteMany', async (_e, ids: string[]) => {
  const n = await removeStickies(stickyDirOf(), ids)
  await refreshTrayMenu()
  return n
})

/* 便签窗口把正文里扫出来的 `#标签` 挂到这张纸上。
   走「只加不减」：窗口可能停在那儿开着很久，期间用户从列表里给它补过标签，
   窗口手里那份是旧的 —— 拿旧值整套覆盖回去，列表上刚做的分类就没了。
   所以让主进程读一次最新的再合并。 */
ipcMain.handle('sticky:addTags', async (_e, id: string, names: string[]) => {
  const cur = (await listStickies(stickyDirOf())).find((m) => m.id === id)?.tags ?? []
  const next = [...new Set([...cur, ...names.filter(Boolean)])]
  if (next.length === cur.length) return next
  await patchSticky(stickyDirOf(), id, { tags: next })
  return next
})

ipcMain.handle('sticky:text', (_e, id: string) => readSticky(stickyDirOf(), id))

ipcMain.handle('sticky:reveal', async (_e, id: string) => {
  const p = path.join(stickyDirOf(), `${id}.md`)
  try {
    await fs.access(p)
  } catch {
    return false // 还没落盘的空便签，没有文件可定位
  }
  shell.showItemInFolder(p)
  return true
})

ipcMain.handle('desktop:prefs', async () => ({
  ...(await readPrefs(LOCAL_APP_DATA)),
  // 以注册表的实际状态为准：用户可能在任务管理器的「启动」页里关掉了
  openAtLogin: loginAtStartup(),
  canAutoStart: canAutoStart(),
  portable: isPortable(),
  packaged: app.isPackaged,
  hotkeyNew: HOTKEY_NEW.replace('CommandOrControl', 'Ctrl'),
  hotkeyCloseAll: HOTKEY_CLOSE_ALL.replace('CommandOrControl', 'Ctrl'),
  hotkeyError,
}))

ipcMain.handle('desktop:setHotkey', async (_e, on: boolean) => {
  await writePrefs(LOCAL_APP_DATA, { hotkey: on })
  await applyHotkeys()
  return { ok: !hotkeyError, error: hotkeyError }
})

ipcMain.handle('desktop:setAutoStart', async (_e, on: boolean) => setAutoStart(on))

/** 渲染层每打开一个工作区就报一次，便签存笔记时有地方可去 */
ipcMain.handle('desktop:activeRoot', (_e, root: string | null) => {
  activeRoot = root
  return true
})

/** 设置里「打开便签文件夹」 */
ipcMain.handle('desktop:revealStickies', async () => {
  const d = stickyDirOf()
  await fs.mkdir(d, { recursive: true }).catch(() => {})
  void shell.openPath(d)
  return d
})

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

/**
 * 归一化接口地址。
 *
 * 用户从服务商文档里粘过来的东西五花八门：末尾多个斜杠、把
 * `/chat/completions` 也一起复制进来。这里统一削掉，只留 base。
 * （设置页的说明写着「末尾不要带 /chat/completions」，但真粘了
 * 也该能用，不然「测试连接」会一直失败而看不出为什么。）
 */
function aiBase(baseUrl: string) {
  return baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/+$/, '')
}

/**
 * 本地模型的地址候选。
 *
 * Ollama 默认只监听 127.0.0.1，而 Windows 上 `localhost` 会先解析到
 * IPv6 的 ::1 —— 于是同一个地址「有时候连得上、有时候连不上」。
 * 预设里已经写死 127.0.0.1，但用户手改回 localhost 时也要能兜住：
 * 两个写法互为备选，逐个试。
 */
function hostCandidates(base: string): string[] {
  const out = [base]
  try {
    const u = new URL(base)
    const alt = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname === '127.0.0.1' ? 'localhost' : ''
    if (alt) {
      const v = new URL(base)
      v.hostname = alt
      out.push(v.toString().replace(/\/+$/, ''))
    }
  } catch {
    /* 地址还没写全，交给 fetch 去报错 */
  }
  return out
}

/** /models 的候选路径：有的服务（Ollama）只在 /v1 下提供 OpenAI 兼容接口 */
function modelsPaths(base: string): string[] {
  const paths = [base + '/models']
  if (!/\/v\d+$/i.test(base)) paths.push(base + '/v1/models')
  return paths
}

function aiHeaders(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey.trim()) h.Authorization = `Bearer ${apiKey.trim()}`
  return h
}

/** 本地模型可能几十秒才吐第一个字，超时给得宽一点 */
const AI_TIMEOUT_MS = 120_000

/** 测试连接只拉一次列表，不该等两分钟 */
const AI_TEST_TIMEOUT_MS = 15_000

function aiError(e: unknown, timeoutMs = AI_TIMEOUT_MS): string {
  const err = e as { name?: string; message?: string }
  if (err?.name === 'AbortError') return `请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`
  const msg = err?.message ?? String(e)
  // 连接不上是最常见的情况，把最可能的病因直接说出来
  if (/ECONNREFUSED|fetch failed|net::ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED/i.test(msg)) {
    return '连不上目标地址。确认服务已启动、地址和端口没写错（本地模型用 127.0.0.1 更稳）。'
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
      const payload = JSON.stringify({
        model: cfg.model,
        messages: body,
        temperature: cfg.temperature,
        stream: true,
      })
      /* 同一份请求按候选地址依次发：localhost / 127.0.0.1 哪一个通就用哪个。
         只对「连不上」重试——服务器已经回话了（哪怕回的是 4xx）就不再换地址，
         否则同一次提问会被送两遍。 */
      const urls = hostCandidates(aiBase(cfg.baseUrl)).map((b) => b + '/chat/completions')
      let res: Response | null = null
      let lastErr: unknown = null
      for (const url of urls) {
        try {
          res = await net.fetch(url, {
            method: 'POST',
            headers: aiHeaders(cfg.apiKey),
            body: payload,
            signal: controller.signal,
          })
          break
        } catch (e) {
          lastErr = e
        }
      }
      if (!res) throw lastErr ?? new Error('fetch failed')
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

/* ── 联网检索 ──
   agent 那一轮要「先查再答」，就得有地方去查。

   这里刻意不接任何要注册、要密钥的搜索 API：为了偶尔查一次资料先去申请
   一个 Key，成本比功能本身还高。所以直接抓公开搜索页的 HTML，再从中取
   标题 / 链接 / 摘要三样。

   两个引擎依次试：DuckDuckGo（境外可达、无反爬门槛）→ Bing（国内更稳）。
   抓不到就如实报失败，聊天照常继续 —— 没查到资料也不该让这一轮废掉。 */
const WEB_TIMEOUT_MS = 12000

export interface WebHit {
  title: string
  url: string
  snippet: string
}

/** 把 HTML 里那些实体与标签清掉，只留能读的纯文本 */
function htmlToText(s: string) {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

function decodeEntities(s: string) {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    '#39': "'",
  }
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z#0-9]+);/gi, (m, n: string) => named[n.toLowerCase()] ?? m)
}

/** DuckDuckGo 的 lite 页把真实地址塞在跳转链接的 uddg 参数里，取出来才是原站 */
function unwrapUrl(u: string) {
  try {
    const abs = u.startsWith('//') ? `https:${u}` : u
    const url = new URL(abs)
    const real = url.searchParams.get('uddg')
    return real ? decodeURIComponent(real) : abs
  } catch {
    return u
  }
}

const SEARCH_ENGINES: {
  name: string
  build: (q: string) => string
  link: RegExp
  snip: RegExp
}[] = [
  {
    name: 'Bing',
    build: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=10`,
    link: /<h2>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    snip: /<p[^>]+class="b_(?:lineclamp\d|paractl|caption)"[^>]*>([\s\S]*?)<\/p>/gi,
  },
  {
    name: 'DuckDuckGo',
    build: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    link: /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    snip: /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi,
  },
]

/**
 * 抓一个引擎的结果。标题与摘要是两个互不相关的正则扫出来的，
 * 所以按下标配对；数量对不齐时以少的那一头为准，多出来的丢掉 ——
 * 宁可少给两条，也不能把 A 的标题配到 B 的摘要上。
 */
function parseEngine(html: string, engine: (typeof SEARCH_ENGINES)[number], limit: number) {
  const links: { url: string; title: string }[] = []
  for (const m of html.matchAll(engine.link)) {
    const url = unwrapUrl(m[1])
    const title = htmlToText(m[2])
    if (!url.startsWith('http') || !title) continue
    links.push({ url, title })
    if (links.length >= limit) break
  }
  const snips: string[] = []
  for (const m of html.matchAll(engine.snip)) {
    const t = htmlToText(m[1])
    if (t) snips.push(t)
    if (snips.length >= limit) break
  }
  const n = Math.min(links.length, snips.length)
  const out: WebHit[] = []
  // 一条摘要都没有时也要把结果给出去：有标题和链接已经够模型去读了
  for (let i = 0; i < (snips.length ? n : links.length); i += 1) {
    out.push({ title: links[i].title, url: links[i].url, snippet: snips[i] ?? '' })
  }
  return out
}

ipcMain.handle(
  'ai:websearch',
  async (
    _e,
    query: string,
    limit = 5,
  ): Promise<{ ok: boolean; hits?: WebHit[]; engine?: string; error?: string }> => {
    const q = String(query ?? '').trim()
    if (!q) return { ok: false, error: '检索词是空的' }
    const want = Math.max(1, Math.min(limit, 8))
    let lastError = ''
    for (const engine of SEARCH_ENGINES) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS)
      try {
        const res = await net.fetch(engine.build(q), {
          method: 'GET',
          headers: {
            // 不伪装成浏览器，搜索页通常直接拒绝；这里只声明自己是普通 UA
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
          signal: controller.signal,
        })
        if (!res.ok) {
          lastError = `${engine.name} HTTP ${res.status}`
          continue
        }
        const hits = parseEngine(await res.text(), engine, want)
        if (hits.length) return { ok: true, hits, engine: engine.name }
        lastError = `${engine.name} 没有解析到结果`
      } catch (e) {
        lastError = `${engine.name}：${aiError(e, WEB_TIMEOUT_MS)}`
      } finally {
        clearTimeout(timer)
      }
    }
    return { ok: false, error: lastError || '联网检索失败' }
  },
)

/**
 * 测试连接：拉一次 /models，顺带把可用模型列出来方便直接挑。
 *
 * 不能只试一个地址就下结论 —— 用户报的「有时候测不成功」就是这个：
 * 预设/手写地址、带不带 /v1、localhost 与 127.0.0.1，任何一种组合都可能
 * 只差一点点。这里把候选按「最可能对」的顺序逐个试，任何一个成功就算过，
 * 全失败才报最后一个错误（并把试过的地址一并说出来，好排查）。
 */
ipcMain.handle(
  'ai:test',
  async (
    _e,
    cfg: AiRequest,
  ): Promise<{ ok: boolean; models?: string[]; error?: string }> => {
    const base = aiBase(cfg.baseUrl)
    if (!base) return { ok: false, error: '请先填接口地址' }

    const targets: string[] = []
    for (const host of hostCandidates(base)) {
      for (const p of modelsPaths(host)) {
        if (!targets.includes(p)) targets.push(p)
      }
    }

    let lastError = ''
    for (const url of targets) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), AI_TEST_TIMEOUT_MS)
      try {
        const res = await net.fetch(url, {
          method: 'GET',
          headers: aiHeaders(cfg.apiKey),
          signal: controller.signal,
        })
        if (!res.ok) {
          const detail = await res.text().catch(() => '')
          // 404 通常只是这个路径不对，继续试下一个候选
          lastError = `HTTP ${res.status} ${detail.slice(0, 160)}`
          continue
        }
        const data = (await res.json()) as { data?: { id?: string }[]; models?: { name?: string }[] }
        const models = [
          ...(data?.data ?? []).map((m) => m.id ?? ''),
          // 有的服务回的是 models: [{name}]（Ollama 的原生 /api/tags 就是这样）
          ...(data?.models ?? []).map((m) => m.name ?? ''),
        ].filter(Boolean)
        return { ok: true, models: [...new Set(models)] }
      } catch (e) {
        lastError = aiError(e, AI_TEST_TIMEOUT_MS)
      } finally {
        clearTimeout(timer)
      }
    }
    return { ok: false, error: `${lastError || '连接失败'}（试过：${targets.join('、')}）` }
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

/* 检查更新：版本号由渲染端传进来，界面显示的是哪一版就比哪一版。
   不在这儿读 app.getVersion()，是为了避免「界面写 A、比较用 B」的错位 ——
   那是最难查的一类问题，界面上看不出任何异常。 */
ipcMain.handle('app:checkUpdate', (_e, current: unknown) =>
  checkUpdate(typeof current === 'string' && current ? current : '0.0.0'),
)

/* ── IPC：WebDAV 云同步。请求在主进程发（与联网检索同一个理由：不受 CORS 限制），
   进度通过 sync:progress 事件推给渲染进程，界面上能看见「正在传哪个文件」 ── */
ipcMain.handle('sync:test', (_e, cfg) => testConnection(cfg))
ipcMain.handle('sync:run', async (_e, root: string, cfg) => syncWorkspace(root, cfg))
onSyncProgress((text) => {
  win?.webContents.send('sync:progress', text)
})

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

/**
 * 首次启动时准备一个开箱即用的笔记库。
 *
 * 以前第一次打开落在欢迎页上，要求用户先挑一个文件夹 —— 这是整个流程里
 * 最容易流失的一步：他刚装完，还不知道这软件值不值得用，就先被要求做
 * 一个文件管理方面的决定。
 *
 * 现在第一次打开自己建一个目录，里面放一篇讲清楚怎么用的笔记，直接读到正文。
 * 目录默认放在「文档」下，不用 AppData —— 笔记藏进 AppData，用户既找不到也没法备份，
 * 重装系统还会跟着一起没。安装时如果专门选过位置，就用他选的那个（见下面 vault:ensure）。
 *
 * 宁可返回空也不抛：建目录失败（比如「文档」被重定向到一个不存在的网盘盘符）
 * 最多回到原来的欢迎页，不能让主窗口在这里挂掉。
 */
ipcMain.handle('vault:ensure', async () => {
  /* 安装时选的目录优先。指针文件在 %LOCALAPPDATA%\Nota\vault.json，
     安装程序写、这里读 —— 这样「装的时候挑了 D:\我的笔记」,
     第一次打开就落在 D:\我的笔记，而不是又跑回「文档\Nota」。
     读不到（没选过 / 文件坏了 / 盘拔了）就退回原来的默认行为。 */
  const localAppData =
    process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local')
  const chosen = await readVaultPointer(localAppData)
  if (chosen) return ensureVaultAt(chosen)
  return ensureVault(app.getPath('documents'))
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
  /* 目录也走同一条路：侧栏的文件夹现在能右键删除，删掉的是一整个目录，
     里面可能有几十篇笔记，所以同样进应用内回收站而不是直接抹掉。
     存的时候按类型换后缀（.md / .dir），恢复时才知道该按哪种还原。 */
  const isDir = await fs.stat(file).then((s) => s.isDirectory(), () => false)
  const rel = path.relative(root, file).replace(/\\/g, '/')
  const key = trashKey(rel)
  const dir = trashDirOf(root)
  await fs.mkdir(dir, { recursive: true })
  await fs.rename(file, path.join(dir, `${key}.${isDir ? 'dir' : 'md'}`))
  await fs.writeFile(
    path.join(dir, `${key}.json`),
    JSON.stringify({ rel, name: path.basename(file), deletedAt: Date.now(), isDir }),
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
  /** 这一条是文件夹（里面可能还有笔记） */
  isDir?: boolean
}

/** 回收站里这一条实际存在哪个文件名下 */
function trashStoreName(key: string, isDir?: boolean) {
  return `${key}.${isDir ? 'dir' : 'md'}`
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
      const size = await fs.stat(path.join(dir, trashStoreName(key, meta.isDir))).then(
        (s) => (s.isDirectory() ? 0 : s.size),
        () => 0,
      )
      out.push({
        key,
        rel: meta.rel,
        name: meta.name,
        deletedAt: meta.deletedAt,
        size,
        isDir: !!meta.isDir,
      })
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
  await fs.rename(path.join(dir, trashStoreName(key, meta.isDir)), target)
  await fs.rm(path.join(dir, `${key}.json`), { force: true })
  return target
})

ipcMain.handle('trash:purge', async (_e, root: string, key: string) => {
  const dir = trashDirOf(root)
  await fs.rm(path.join(dir, `${key}.md`), { force: true })
  await fs.rm(path.join(dir, `${key}.dir`), { recursive: true, force: true })
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

/**
 * 往附件库里导入任意文件。
 *
 * 和 image:pick 的区别：那个是「挑一张插进光标处」，这里是「往库里收一批」，
 * 所以允许多选、也不限图片视频 —— 压缩包、PDF、Word、音频、随便什么都能收，
 * 挑的时候再决定插不插。附件库本来就该是工作区的素材抽屉，不是图片夹。
 *
 * 一律复制进来而不是记原路径：笔记引用的是相对路径，素材跟着工作区走，
 * 换机器、打包备份都不会变成一堆裂链。
 */
const IMPORT_FILTERS = [
  {
    name: '图片与视频',
    extensions: [
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif',
      'mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi',
    ],
  },
  { name: '压缩包', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz'] },
  {
    name: '文档',
    extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'json'],
  },
  { name: '音频', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'] },
  { name: '所有文件', extensions: ['*'] },
]

ipcMain.handle(
  'attach:import',
  async (
    _e,
    root: string,
  ): Promise<{ rel: string; name: string; size: number; mtime: number; isVideo: boolean }[]> => {
    if (!win || !root) return []
    const result = await dialog.showOpenDialog(win, {
      title: '导入附件到工作区',
      properties: ['openFile', 'multiSelections'],
      filters: IMPORT_FILTERS,
    })
    if (result.canceled || result.filePaths.length === 0) return []

    const dir = path.join(root, ATTACH_DIR)
    await fs.mkdir(dir, { recursive: true })
    const out: { rel: string; name: string; size: number; mtime: number; isVideo: boolean }[] = []

    for (const source of result.filePaths) {
      try {
        const ext = path.extname(source).toLowerCase()
        const base = path.basename(source, path.extname(source)).replace(/[\\/:*?"<>|]/g, '-')
        // 同名就往后编号，绝不覆盖已有的那一份
        let fileName = `${base}${ext}`
        let target = path.join(dir, fileName)
        let i = 1
        while (existsSync(target)) {
          fileName = `${base} ${i}${ext}`
          target = path.join(dir, fileName)
          i++
        }
        await fs.copyFile(source, target)
        const st = await fs.stat(target)
        out.push({
          rel: `${ATTACH_DIR}/${fileName}`.replace(/\\/g, '/'),
          name: fileName,
          size: st.size,
          mtime: st.mtimeMs,
          isVideo: /\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/i.test(ext),
        })
      } catch {
        /* 单个文件复制失败不影响其余的 */
      }
    }
    return out
  },
)

/**
 * 把一张图直接存进工作区（粘贴或拖进来的那些）。
 *
 * 与 attach:import 的区别：那个是「人去挑文件」，这个是「编辑器自己接住」——
 * 来源可能是剪贴板里的一张截图（磁盘上根本没有这个文件），所以除了
 * 按路径复制，还要能吃一段字节。
 *
 * 落点统一是 attachments/，和手动导入的那批在一起 —— 分成两个目录的话，
 * 「这篇笔记用到的图」就散在两处了。
 */
ipcMain.handle(
  'media:save',
  async (
    _e,
    root: string,
    item: { srcPath?: string; bytes?: string; ext?: string },
  ): Promise<{ rel: string; name: string; isVideo: boolean } | null> => {
    if (!root) return null
    const dir = path.join(root, ATTACH_DIR)
    await fs.mkdir(dir, { recursive: true })

    // 剪贴板里的截图没有文件名，用时间戳起一个，免得全叫 image.png 互相顶掉
    const ext = (item.ext || path.extname(item.srcPath ?? '') || '.png').toLowerCase()
    let base: string
    if (item.srcPath) {
      base = path.basename(item.srcPath, path.extname(item.srcPath)).replace(/[\\/:*?"<>|]/g, '-')
    } else {
      const d = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      base = `paste-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    }

    let fileName = `${base}${ext}`
    let target = path.join(dir, fileName)
    let i = 1
    while (existsSync(target)) {
      fileName = `${base}-${i}${ext}`
      target = path.join(dir, fileName)
      i += 1
    }

    try {
      if (item.srcPath) {
        await fs.copyFile(item.srcPath, target)
      } else if (item.bytes) {
        await fs.writeFile(target, Buffer.from(item.bytes, 'base64'))
      } else {
        return null
      }
    } catch {
      return null
    }

    return {
      rel: `${ATTACH_DIR}/${fileName}`.replace(/\\/g, '/'),
      name: fileName,
      isVideo: /\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/i.test(ext),
    }
  },
)

// 重命名
ipcMain.handle('note:rename', async (_e, file: string, newName: string) => {
  const safe = newName.replace(/[\\/:*?"<>|]/g, '-').trim() || '未命名'
  /* 目录不能补 .md：侧栏文件夹也可以重命名了，给它加扩展名会变成
     「设计.md」这种看起来像笔记、实际是文件夹的东西。 */
  const isDir = await fs.stat(file).then((s) => s.isDirectory(), () => false)
  const target = path.join(path.dirname(file), isDir ? safe : `${safe}.md`)
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
   四种格式：
    - md   ：直接把源文件另存一份，最保真
    - html ：带上内联样式与内容，独立可打开的网页
    - word ：同一份 HTML 换一层 Word 认的壳，存成 .doc（Word/WPS 直接打开）
    - pdf  ：拿同一份 HTML 在隐藏窗口里打印成 PDF
   渲染层负责把 Markdown 渲染成 HTML（它那边有 marked 和高亮），
   主进程只负责「弹保存框 → 写文件」，PDF 多一步无头打印。 */
ipcMain.handle(
  'export:save',
  async (_e, opts: { defaultName: string; kind: string; data: string }) => {
    if (!win) return null
    const filters =
      opts.kind === 'html'
        ? [{ name: '网页', extensions: ['html'] }]
        : opts.kind === 'word'
          ? [{ name: 'Word 文档', extensions: ['doc'] }]
          : [{ name: 'Markdown', extensions: ['md'] }]

    const result = await dialog.showSaveDialog(win, {
      title: '导出',
      defaultPath: opts.defaultName,
      filters,
    })
    if (result.canceled || !result.filePath) return null
    await fs.writeFile(result.filePath, opts.data, 'utf8')
    return result.filePath
  },
)

/**
 * 导出 PDF：把渲染好的 HTML 放进一个不显示的窗口里，让 Chromium 自己排版打印。
 *
 * 为什么不干脆用渲染进程的 printToPDF：那会把整个应用界面（侧栏、工具栏）
 * 一起打进去。这里是一个只有正文的干净页面，出来的就是一份文档。
 *
 * HTML 落到临时文件再 loadFile，而不是塞进 data: URL —— 长笔记的数据
 * URL 会非常长，Chromium 对它有上限，而且图片的 file:// 相对解析也会乱。
 */
ipcMain.handle(
  'export:pdf',
  async (_e, opts: { defaultName: string; html: string }): Promise<string | null> => {
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      title: '导出 PDF',
      defaultPath: opts.defaultName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (result.canceled || !result.filePath) return null

    const tmp = path.join(app.getPath('temp'), `nota-print-${Date.now()}.html`)
    await fs.writeFile(tmp, opts.html, 'utf8')
    const printer = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    })
    try {
      await printer.loadFile(tmp)
      const buf = await printer.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0.75, bottom: 0.75, left: 0.7, right: 0.7 },
        headerTemplate: '<div></div>',
        footerTemplate: `
          <div style="width:100%;text-align:center;font-size:9px;color:#8a867c;
                      font-family:-apple-system,'Segoe UI','PingFang SC',sans-serif;
                      padding:0 20mm;">
            <span class="pageNumber"></span> / <span class="totalPages"></span>
          </div>`,
      })
      await fs.writeFile(result.filePath, buf)
    } finally {
      printer.destroy()
      await fs.rm(tmp, { force: true })
    }
    return result.filePath
  },
)

/* ── 节点图标 ──
   给文件夹/笔记挑的图标存在工作区的 .nota/icons.json 里。

   为什么跟笔记放一起而不是存进应用配置：图标是「这个工作区长什么样」的
   一部分，换台机器把工作区拷过去，图标应该跟着走；反过来换工作区时
   也不该继承上一个工作区的图标。
   存的是**相对路径 → 图标 id**，不是绝对路径 —— 工作区整个挪个盘符
   也不会全部失效。 */
function iconsFileOf(root: string) {
  return path.join(root, NOTA_DIR, 'icons.json')
}

ipcMain.handle('icons:read', async (_e, root: string): Promise<Record<string, string>> => {
  if (!root) return {}
  try {
    return JSON.parse(await fs.readFile(iconsFileOf(root), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
})

/* ── 标签图标 ──
   跟节点图标同一套素材库，但意义不同、所以分开存：
   节点图标是「这一个文件/文件夹长什么样」，标签图标是「这一类笔记是什么」。
   混在一个文件里，删一个节点的图标时很容易顺手把标签的归属图标也带走。 */
function tagIconsFileOf(root: string) {
  return path.join(root, NOTA_DIR, 'tag-icons.json')
}

ipcMain.handle('tagIcons:read', async (_e, root: string): Promise<Record<string, string>> => {
  if (!root) return {}
  try {
    return JSON.parse(await fs.readFile(tagIconsFileOf(root), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
})

ipcMain.handle(
  'tagIcons:write',
  async (_e, root: string, map: Record<string, string>): Promise<boolean> => {
    if (!root) return false
    try {
      await fs.mkdir(path.join(root, NOTA_DIR), { recursive: true })
      await fs.writeFile(tagIconsFileOf(root), JSON.stringify(map, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  },
)

ipcMain.handle(
  'icons:write',
  async (_e, root: string, map: Record<string, string>): Promise<boolean> => {
    if (!root) return false
    try {
      await fs.mkdir(path.join(root, NOTA_DIR), { recursive: true })
      await fs.writeFile(iconsFileOf(root), JSON.stringify(map, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  },
)

/* ── 归类与定位 ──
   右键菜单里的两项：把笔记挪到另一个文件夹、在文件管理器里定位它。
   不用 shell.openPath（那会用默认程序打开笔记），要的是「在文件夹里选中」。 */
ipcMain.handle('note:reveal', (_e, file: string) => {
  shell.showItemInFolder(file)
  return true
})

ipcMain.handle('note:move', async (_e, file: string, dir: string) => {
  const base = path.basename(file)
  let target = path.join(dir, base)
  if (target === file) return file
  // 目标里已有同名笔记就往后加序号，跟新建/导入一样，绝不覆盖
  const stem = base.replace(/\.md$/i, '')
  let i = 1
  while (existsSync(target)) {
    target = path.join(dir, `${stem} ${i}.md`)
    i++
  }
  await fs.mkdir(dir, { recursive: true })
  await fs.rename(file, target)
  return target
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

/**
 * 刚装完的第一次启动：上一个版本留下的界面状态一律不要。
 *
 * 需要清的东西全在 localStorage 里 —— AI 的密钥和地址、所有聊天会话、
 * 上次打开的目录和笔记、「引导已看过」那个键、侧栏宽度。它们躺在
 * %APPDATA%\Nota 下，装新版本碰都不会碰。不清，用户装完打开看到的
 * 还是旧密钥、上次的对话，会以为安装根本没生效。
 *
 * 清完 root 也没了，渲染进程那边自然走首次建库（store 里的 bootFirstRun）：
 * 按安装时记下的笔记目录建库、写《欢迎使用 Nota》并直接打开。
 *
 * 只认安装器留的那个标记，所以便携版（双击直接跑）不受影响 —— 那个用法
 * 本来就没有「安装」这一步，数据留着才对。
 */
async function consumeFreshInstall() {
  const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local')
  const flag = await takeFreshFlag(localAppData)
  if (!flag) return
  try {
    await session.defaultSession.clearStorageData({
      /* sessionStorage 是会话级的，进程一退就没了，不用管；
         Electron 这份类型里也没有这个取值。 */
      storages: ['localstorage', 'indexdb', 'cookies', 'cachestorage', 'shadercache', 'serviceworkers'],
    })
    console.log('[fresh] 全新安装：界面状态已清空')
  } catch (e) {
    /* 清不掉就带着旧状态开窗，总比让首次启动崩在门口强 */
    console.error('[fresh] 清界面状态失败：', e)
  }
}

/* ── 启动 ──
 *
 * 单例锁必须最先拿。这个应用有两条「再点一次图标」的路：桌面上双击、
 * 以及开机自启已经把它挂在托盘里了。没有锁的话第二个进程会起来，
 * 两个进程同时对着同一个笔记库写文件 —— 那是最难查的一类数据损坏。
 *
 * 拿到锁之后的第二次启动走 second-instance：把已有的主窗放出来，
 * 自己安静退出。 */
const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (app.isReady()) showMain()
  })

  app.whenReady().then(boot)
}

async function boot(): Promise<void> {
  registerMediaProtocol()
  // 从免安装包启动时会先问一句装不装；装/卸界面接管了就不要再开主窗口
  if (await maybeRunInstaller()) return
  // 必须在开窗之前清完：渲染进程一加载就会去读 localStorage
  await consumeFreshInstall()

  initStickyWindows({
    localAppData: LOCAL_APP_DATA,
    preload: path.join(__dirname, 'preload-sticky.cjs'),
    rendererDist: RENDERER_DIST,
    devUrl: VITE_DEV_SERVER_URL,
  })

  /* 上一次多半是被强杀 / 断电 / 任务管理器结束掉的：开着的便签没来得及
     走收尾，记录里还写着「开着」，可桌面上什么都没有。开窗前先对一遍账，
     否则列表会显示一堆其实不在的纸。 */
  try {
    const rec = await reconcileOnBoot(stickyDirOf())
    if (rec.archived || rec.dropped) {
      console.log(`[sticky] 启动对账：归档 ${rec.archived} 张，清掉 ${rec.dropped} 张空白`)
    }
  } catch (e) {
    console.error('[sticky] 启动对账失败：', e)
  }

  buildTray()
  await applyHotkeys()

  /* 开机自启那一轮带 --hidden：只把托盘和快捷键带起来，不建主窗。
     早上开机第一件事不是看笔记，没必要先占一屏内存。
     但托盘要是没建起来（拿不到图标），隐藏启动会让程序彻底失联，
     那种情况照常开窗。 */
  const hidden = process.argv.includes('--hidden')
  if (!hidden || !tray) createWindow()
}

/**
 * 窗口全关掉了，但程序不退。
 *
 * 以前这里直接 app.quit()。现在不行：主窗点叉只是 hide（不算关），
 * 便签窗口却会真的关掉 —— 用户收起最后一张便签时这个事件就会来。
 * 那一刻退出的话，托盘和快捷键就一起没了。
 *
 * 唯一的例外是没有托盘：那样「还在后台」就成了看不见的幽灵进程，
 * 只能退回老行为。
 */
app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return
  if (!tray) app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

/**
 * 退出前把开着的便签落盘。
 *
 * before-quit 不能 await，所以先拦下来、等收尾做完再 quit 一次。
 * 不这么做的话，用户正在打的那半句会跟着进程一起消失 ——
 * 便签的全部价值就是「随手记的东西不会丢」，这一步不能省。
 */
let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  isQuitting = true
  void flushStickies()
    .catch(() => {})
    .finally(() => app.quit())
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  tray?.destroy()
  tray = null
})
