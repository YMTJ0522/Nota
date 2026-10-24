/**
 * 便签窗口的生死。
 *
 * 每张便签一个独立的 BrowserWindow，加载的是 sticky.html 这个**独立入口**，
 * 不是主界面。这一条不能省：主界面一启动就要读工作区、建文件树、
 * 加载 AI 配置、试连云同步，一套下来几百毫秒；按快捷键要的是「手指还没
 * 离开键盘，框就已经能打字了」。便签入口只有一个小 textarea 和一条标题栏。
 *
 * 窗口不是「自己关自己」的：关闭动作统一走 finish()，由主进程决定
 * 这张纸该归档还是该扔掉（空白的便签不留痕迹）。这样 Alt+F4、Esc、
 * 「收起全部」三条路的行为才能是一致的。
 */
import { BrowserWindow, Menu, screen } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import {
  createSticky,
  listStickies,
  patchSticky,
  readSticky,
  removeSticky,
  writeSticky,
  type StickyMeta,
} from './stickies'

/** 同时存在的上限。再多就是几十个渲染进程，内存会被吃穿 */
const MAX_OPEN = 12

/** 纸色。渲染层有一份同样的表（src/sticky/colors.ts），key 必须对得上 */
const PAPER: Record<string, string> = {
  amber: '#fdf2d0',
  rose: '#fbe3e4',
  mint: '#e2f2e4',
  sky: '#e3edf9',
  lilac: '#eee7f7',
  slate: '#ebebeb',
}

interface Deps {
  localAppData: string
  preload: string
  rendererDist: string
  devUrl?: string
}

interface Live {
  win: BrowserWindow
  /** 最后一次上报的正文。主进程手里有它，关闭时不必等渲染层回话 */
  text: string
  /** 位置尺寸写盘的防抖定时器 */
  saveTimer: NodeJS.Timeout | null
  /** finish 只能跑一次：close 事件与 IPC 可能同时到 */
  done: boolean
}

const live = new Map<string, Live>()
/** 「等这个窗口彻底关干净」的回调，收起全部要等它们都结算完 */
const closedWaiters = new Map<string, () => void>()
let deps: Deps
/** 新建便签的层叠序号：每开一张往右下挪一点，不至于完全叠死 */
let cascade = 0

export function initStickyWindows(d: Deps): void {
  deps = d
}

const dir = () => path.join(deps.localAppData, 'Nota', 'stickies')

/** 主进程手里有正文的那几张，界面显示「开着 N 张」用 */
export function openStickyCount(): number {
  return live.size
}

export function stickyIds(): string[] {
  return [...live.keys()]
}

/**
 * 算一个「用户能看见」的位置。
 *
 * 不能直接信上次存的坐标：便签是在 A 屏拖到右下角的，第二天接着笔记本
 * 单独用，那块屏不在了 —— 恢复出来的窗口落在不存在的坐标上，
 * 屏幕上什么都没有，但按快捷键时明明「开了」。所以每次都要拿现存屏幕
 * 的 workArea 夹一下。
 */
function placeFor(meta: Partial<StickyMeta>): { x: number; y: number } {
  const pt = { x: meta.x ?? 0, y: meta.y ?? 0 }
  const display =
    typeof meta.x === 'number' && typeof meta.y === 'number'
      ? screen.getDisplayNearestPoint(pt)
      : screen.getPrimaryDisplay()
  const area = display.workArea
  const w = meta.w ?? 340
  const h = meta.h ?? 300

  if (typeof meta.x === 'number' && typeof meta.y === 'number') {
    const x = Math.min(Math.max(meta.x, area.x), area.x + area.width - w)
    const y = Math.min(Math.max(meta.y, area.y), area.y + area.height - h)
    return { x: Math.round(x), y: Math.round(y) }
  }

  // 没存过位置：从右上角往左下铺，一张压一张地错开
  const step = (cascade++ % 8) * 26
  return {
    x: Math.round(area.x + area.width - w - 40 - step),
    y: Math.round(area.y + 60 + step),
  }
}

function paperOf(meta: Partial<StickyMeta>): string {
  return PAPER[meta.color ?? 'amber'] ?? PAPER.amber
}

/** 建窗口。id 对应 index.json 里一条记录 */
async function mount(meta: StickyMeta, text: string): Promise<BrowserWindow | null> {
  const existing = live.get(meta.id)
  if (existing) {
    existing.win.show()
    existing.win.focus()
    return existing.win
  }

  const pos = placeFor(meta)
  const win = new BrowserWindow({
    width: meta.w ?? 340,
    height: meta.h ?? 300,
    minWidth: 220,
    minHeight: 160,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    /* 便签不设成透明：透明窗口在 Windows 上要走 DWM 合成，
       拖动时会明显发涩，而且文字抗锯齿会变糊。纸色是实心的 */
    backgroundColor: paperOf(meta),
    alwaysOnTop: meta.pinned !== false,
    /* 在任务栏里留一条：便签被别的窗口盖住时，还能从任务栏点回来。
       全隐到托盘那种「找不到自己在哪」的体验更糟 */
    skipTaskbar: false,
    title: '便签',
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    icon: resolveIcon(),
    webPreferences: {
      preload: deps.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      /* 便签窗口不需要任何背景节流：切走再切回来必须立刻能打字 */
      backgroundThrottling: false,
    },
  })

  if (meta.pinned !== false) win.setAlwaysOnTop(true, 'floating')

  const id = meta.id
  const entry: Live = { win, text, saveTimer: null, done: false }
  live.set(id, entry)

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
    // 光标要直接落在正文里：按完快捷键就开始打字，不该再点一下
    win.webContents.send('sticky:focus')
  })

  /* 位置尺寸：拖动和缩放是连续事件，一次拖动能发上百个。
     每次都写 index.json 会把磁盘写穿，所以等停下了再记一笔 */
  const remember = () => {
    if (entry.done) return
    if (entry.saveTimer) clearTimeout(entry.saveTimer)
    entry.saveTimer = setTimeout(() => {
      entry.saveTimer = null
      const b = win.getBounds()
      void patchSticky(dir(), id, { x: b.x, y: b.y, w: b.width, h: b.height })
    }, 400)
  }
  win.on('move', remember)
  win.on('resize', remember)

  /* 真被关掉时的兜底，也是唯一的收尾入口（Esc、自绘按钮、Alt+F4、
     系统关机、渲染进程崩了，最后都会走到这里）。
     必须先结算再清账：finishSticky 要用内存里那份正文，
     而 wipe 之后内存里就什么都没有了。 */
  win.on('closed', () => {
    if (entry.saveTimer) clearTimeout(entry.saveTimer)
    void finishSticky(id).finally(() => {
      live.delete(id)
      notify()
      const waiter = closedWaiters.get(id)
      closedWaiters.delete(id)
      waiter?.()
    })
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void url
    return { action: 'deny' }
  })

  /* 右键菜单。
     Electron 默认什么都不弹，而这个窗口里唯一要紧的动作就是「粘贴」——
     用户从别处复制了一段话，按快捷键弹出便签，习惯性右键却发现没菜单，
     只能想起来去按 Ctrl+V。便签是这个软件里最不该让人思考的地方。 */
  win.webContents.on('context-menu', (_e, params) => {
    if (!params.isEditable) return
    Menu.buildFromTemplate([
      { label: '剪切', role: 'cut', enabled: params.editFlags.canCut },
      { label: '复制', role: 'copy', enabled: params.editFlags.canCopy },
      { label: '粘贴', role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: '全选', role: 'selectAll' },
    ]).popup({ window: win })
  })

  if (deps.devUrl) {
    await win.loadURL(`${deps.devUrl}/sticky.html?id=${encodeURIComponent(id)}`)
  } else {
    await win.loadFile(path.join(deps.rendererDist, 'sticky.html'), {
      search: `id=${encodeURIComponent(id)}`,
    })
  }

  notify()
  return win
}

function resolveIcon(): string | undefined {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'icon.png'),
    path.join(__dirname, '..', 'build', 'icon.png'),
  ]
  for (const p of candidates) {
    try {
      if (p && existsSync(p)) return p
    } catch {
      /* 下一个 */
    }
  }
  return undefined
}

/** 窗口数量变化时通知主窗口改侧栏角标。便签窗口自己不收这个 */
function notify(): void {
  const stickyWins = new Set([...live.values()].map((e) => e.win))
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || stickyWins.has(w)) continue
    w.webContents.send('sticky:count', live.size)
  }
}

/**
 * 收尾：决定这张纸留下还是扔掉。
 *
 * 空白便签直接删记录 —— 按了快捷键、看一眼又 Esc 掉，不该在列表里
 * 积一条「空白便签」。有内容就归档，之后能从侧栏「便签」里捞回来。
 */
async function finishSticky(id: string): Promise<void> {
  const entry = live.get(id)
  if (entry) {
    if (entry.done) return
    entry.done = true
    if (entry.saveTimer) clearTimeout(entry.saveTimer)
  }
  const text = entry ? entry.text : await readSticky(dir(), id)
  try {
    if (!text.trim()) {
      await removeSticky(dir(), id)
    } else {
      await writeSticky(dir(), id, text)
      await patchSticky(dir(), id, { closedAt: Date.now() })
    }
  } catch (e) {
    console.error('[sticky] 收尾失败：', e)
  }
}

/**
 * 开一张新的。这是快捷键 Ctrl+Alt+N 的落点，会连按连开。
 *
 * 位置从上一张的右下角接过来，这样连按几次看到的是阶梯，
 * 而不是一摞完全重合的纸。
 */
export async function openNewSticky(): Promise<{ id: string } | { error: string }> {
  if (!deps) return { error: '便签还没准备好' }
  if (live.size >= MAX_OPEN) {
    return { error: `最多同时开 ${MAX_OPEN} 张，先关掉几张` }
  }
  const last = [...live.values()].pop()
  const bound = last?.win.getBounds()
  const meta = await createSticky(dir(), {
    ...(bound ? { w: bound.width, h: bound.height } : {}),
  })
  const win = await mount(meta, '')
  if (!win) return { error: '窗口没建起来' }
  return { id: meta.id }
}

/** 打开一张已有的（列表里点回来的那条路） */
export async function openSticky(id: string): Promise<boolean> {
  if (!deps) return false
  if (live.has(id)) {
    const w = live.get(id)!.win
    w.show()
    w.focus()
    return true
  }
  if (live.size >= MAX_OPEN) {
    const w = live.values().next().value?.win
    w?.focus()
    return false
  }
  const metas = await listStickies(dir())
  const meta = metas.find((m) => m.id === id)
  if (!meta) return false
  const text = await readSticky(dir(), id)
  // 重新打开时把归档标记撤掉，否则列表里会显得它还关着
  await patchSticky(dir(), id, { closedAt: undefined })
  return !!(await mount({ ...meta, closedAt: undefined }, text))
}

/** 收起全部（Ctrl+Alt+Shift+N）。逐张关，空白的那些会自己消失 */
export async function closeAllStickies(): Promise<number> {
  const ids = [...live.keys()]
  await Promise.all(ids.map((id) => destroyAndWait(id)))
  return ids.length
}

/** 关掉一个窗口并等它结算完。收尾逻辑只在 closed 里那一处 */
function destroyAndWait(id: string): Promise<void> {
  const entry = live.get(id)
  if (!entry || entry.win.isDestroyed()) {
    live.delete(id)
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    closedWaiters.set(id, resolve)
    entry.win.destroy()
  })
}

/** 渲染层上报正文。text 同时留在内存里，关闭时不用等它再发一次 */
export async function saveStickyText(id: string, text: string): Promise<void> {
  const entry = live.get(id)
  if (entry) entry.text = text
  await writeSticky(dir(), id, text)
}

/** 渲染层要关自己（Esc / 自绘的关闭按钮） */
export async function requestCloseSticky(id: string): Promise<void> {
  await destroyAndWait(id)
}

/** 钉住 / 取消钉住 */
export async function setStickyPinned(id: string, pinned: boolean): Promise<boolean> {
  const entry = live.get(id)
  if (!entry || entry.win.isDestroyed()) return false
  entry.win.setAlwaysOnTop(pinned, pinned ? 'floating' : 'normal')
  await patchSticky(dir(), id, { pinned })
  return true
}

/**
 * 换纸色。窗口底色也要跟着换 —— 只改 CSS 的话，窗口缩放时露出的
 * 那一窄条仍然是旧色，看着像个错位。
 */
export async function setStickyColor(id: string, color: string): Promise<boolean> {
  const entry = live.get(id)
  if (!entry || entry.win.isDestroyed()) return false
  entry.win.setBackgroundColor(paperOf({ color }))
  await patchSticky(dir(), id, { color })
  return true
}

/** 应用退出前把开着的便签都收好，别让正在打的字跟着进程一起消失 */
export async function flushAll(): Promise<void> {
  for (const [id, entry] of live) {
    if (entry.saveTimer) clearTimeout(entry.saveTimer)
    try {
      await writeSticky(dir(), id, entry.text)
      if (entry.text.trim()) await patchSticky(dir(), id, { closedAt: Date.now() })
      else await removeSticky(dir(), id)
    } catch {
      /* 退出路上失败也没别的办法了 */
    }
  }
}
