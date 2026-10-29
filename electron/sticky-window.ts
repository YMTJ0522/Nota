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
import { lockZoom } from './lock-zoom'
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

/* 建一张纸到底卡在哪：set 上 NOTA_STICKY_TIMING=1 就会在 stdout 打三段
   （写完 index / 窗口能加载 / 首帧画出来）。平时完全不计时 —— 不想为了一个
   排查用的东西在每次按键时多读两次时钟。 */
const timing = () => process.env.NOTA_STICKY_TIMING === '1'

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
  /**
   * 便签存在哪 —— 由外面给，不在这里算。
   *
   * 便签本来在 %LOCALAPPDATA%\Nota 里，后来改成跟着库走（换台电脑只拷库，
   * 便签不该全丢）。目录该跟着「当前打开的是哪个库」变，而库要等主进程
   * 读完 vault.json 才知道。这里如果再自己拼一遍路径，两边就会各说各话：
   * 窗口把字写进机器级目录，列表去库目录里找 —— 用户看到的是「便签存不住」。
   * 所以只留一个出处，就是主进程那个 stickyDirOf。
   */
  dir: () => string
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

/**
 * 一份开场数据。窗口刚建好、或者池里的空窗口被认领时，都往这里塞一份。
 * 渲染层的 init() 和 onBind 收的都是它 —— 界面只认这一份形状。
 */
interface Bind {
  id: string
  text: string
  pinned: boolean
  color: string
  savedTo?: string
  tags?: string[]
  shots?: string[]
}

const live = new Map<string, Live>()
/** 「等这个窗口彻底关干净」的回调，收起全部要等它们都结算完 */
const closedWaiters = new Map<string, () => void>()
/**
 * webContents.id → 这个窗口现在装的是哪张纸。
 *
 * 为什么不放在 Live 里：池里那个窗口还没有 id（用户下次要点哪张纸还不知道），
 * 它进不了 live（live 是「开着 N 张」，池不该算进去），但渲染层开场仍然
 * 需要一份数据来回答 init()。所以按 webContents 记，和「开没开着」解耦。
 */
const bindings = new Map<number, Bind>()

/**
 * 预热池：一个已经跑起来的空便签窗口。
 *
 * 为什么要有它 —— 实测一张纸从按键到画出来是 330ms 上下，而这 330ms 里
 * 我们的代码只占 20ms：HTML 7ms 就读完了，剩下的 230ms 全是 Chromium
 * 新建渲染进程的固定开销（拿一个只有 `<div>` 的空 HTML 做对照，照样
 * 230ms）。所以把 JS 拆小、减依赖，一点用都没有；唯一有效的办法是
 * 在用户按下快捷键之前就把那个进程建好。
 */
let pooled: { win: BrowserWindow; ready: boolean } | null = null
let poolTimer: NodeJS.Timeout | null = null
/** 池里那张空纸闲多久就扔掉。白占几十兆内存不划算 */
const POOL_IDLE = 5 * 60 * 1000
let deps: Deps
/** 新建便签的层叠序号：每开一张往右下挪一点，不至于完全叠死 */
let cascade = 0

export function initStickyWindows(d: Deps): void {
  deps = d
  /* 起界面那一下别抢：主窗口自己还在读工作区、建文件树。等三秒再安静地
     备一张空纸 —— 用户三秒内就按了 Alt+N 的话，那就走冷启动，慢一次也没关系 */
  const t = setTimeout(() => prewarm(), 3000)
  t.unref?.()
}

/** 渲染层开场时来取，按 webContents 找 */
export function bindOf(wcId: number): Bind | null {
  return bindings.get(wcId) ?? null
}

function payload(meta: Partial<StickyMeta>, text: string): Bind {
  return {
    id: meta.id ?? '',
    text,
    pinned: meta.pinned !== false,
    color: meta.color ?? 'amber',
    savedTo: meta.savedTo,
    tags: meta.tags,
    shots: meta.shots,
  }
}

const dir = () => deps.dir()

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

/**
 * 建一个便签窗口：只有壳子和通用行为，不含「这是哪张纸」。
 *
 * 拆出来的原因是预热池 —— 池里那张空纸也得是一个完整的窗口，但它还没有
 * 对应的便签，所以位置记忆、关闭收尾、显示时机这些都不能挂。
 */
function makeWindow(meta: Partial<StickyMeta>): BrowserWindow {
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

  /* 便签窗口同样不许被 Ctrl ± / 捏合缩放：一张纸突然变大又变小，
     比主窗口更吓人（它还是置顶的） */
  lockZoom(win)

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

  return win
}

/** 加载便签那个入口。带 id 只是给不认识池的老路径留的后路，界面已经不看它了 */
async function loadInto(win: BrowserWindow, id?: string): Promise<void> {
  if (deps.devUrl) {
    await win.loadURL(`${deps.devUrl}/sticky.html${id ? `?id=${encodeURIComponent(id)}` : ''}`)
  } else {
    await win.loadFile(
      path.join(deps.rendererDist, 'sticky.html'),
      id ? { search: `id=${encodeURIComponent(id)}` } : undefined,
    )
  }
}

/**
 * 把窗口和一张纸绑起来：登记进 live、挂位置记忆、挂关闭收尾。
 * 冷启动和「从池里认领」都走这里 —— 两条路的窗口行为必须完全一样。
 */
function attach(win: BrowserWindow, meta: StickyMeta, text: string): void {
  const id = meta.id
  const wcId = win.webContents.id
  const entry: Live = { win, text, saveTimer: null, done: false }
  live.set(id, entry)

  if (meta.pinned !== false) win.setAlwaysOnTop(true, 'floating')

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
    /* 按 webContents 记的那份开场数据也要清：id 会被下一个窗口复用，
       不清的话新窗口来问 init() 可能拿到上一张纸的内容 */
    bindings.delete(wcId)
    void finishSticky(id).finally(() => {
      live.delete(id)
      notify()
      const waiter = closedWaiters.get(id)
      closedWaiters.delete(id)
      waiter?.()
    })
  })
}

/** 建窗口。id 对应 index.json 里一条记录 */
async function mount(meta: StickyMeta, text: string): Promise<BrowserWindow | null> {
  const existing = live.get(meta.id)
  if (existing) {
    existing.win.show()
    existing.win.focus()
    return existing.win
  }

  /* 池里有已经跑起来的空窗口就直接认领：省掉的正是 Chromium 起渲染进程
     那两百多毫秒 */
  const warm = claim(meta, text)
  if (warm) return warm

  const m0 = timing() ? performance.now() : 0
  const win = makeWindow(meta)

  /* 窗口对象建好（还没内容）的时刻。它和 m0 之间只有 placeFor 与构造，
     正常应该是几十毫秒；这一段要是变长，说明是 Chromium 起渲染进程慢，
     再优化我们自己这层代码也没用 */
  const mWin = timing() ? performance.now() : 0
  /* 文档加载完（DOM 就绪）的时刻，由下面 loadInto 回填 */
  let docReady = 0
  /* 渲染进程开始跑 / DOM 就绪。这两个点在排查「到底慢在起进程还是跑 JS」时
     一眼就能看出来：start 与 win 的差是起进程，dom 与 start 的差是解析+执行 */
  let tStart = 0
  let tDom = 0
  if (m0) {
    win.webContents.once('did-start-loading', () => (tStart = performance.now()))
    win.webContents.once('dom-ready', () => (tDom = performance.now()))
  }

  /* 数据要在 loadInto 之前挂好：渲染层的 onMounted 会立刻来问 init()，
     晚一步它就只能拿到 null，纸上会显示「这张便签已经不在了」 */
  bindings.set(win.webContents.id, payload(meta, text))
  attach(win, meta, text)

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
    // 光标要直接落在正文里：按完快捷键就开始打字，不该再点一下
    win.webContents.send('sticky:focus')
    if (m0) {
      const now = performance.now()
      console.log(
        `[sticky-timing] win=${(mWin - m0).toFixed(1)}` +
          ` start=${(tStart - m0).toFixed(1)}` +
          ` dom=${(tDom - m0).toFixed(1)}` +
          ` doc=${(docReady - m0).toFixed(1)}` +
          ` paint=${(now - m0).toFixed(1)}`,
      )
    }
  })

  await loadInto(win, meta.id)
  if (m0) docReady = performance.now()

  notify()
  return win
}

function clearPoolTimer(): void {
  if (poolTimer) {
    clearTimeout(poolTimer)
    poolTimer = null
  }
}

function destroyPool(): void {
  clearPoolTimer()
  const p = pooled
  pooled = null
  if (p && !p.win.isDestroyed()) p.win.destroy()
}

/**
 * 备一张已经跑起来的空纸。
 *
 * 只在空闲时做（启动后 3 秒、认领后 1.2 秒），因为它本身要起一个渲染进程，
 * 跟主界面加载抢主线程的话，用户会觉得"软件卡"。池里最多一张：再多的意义
 * 只是多占几十兆内存 —— 用户一次只记一件事。
 */
function prewarm(): void {
  if (!deps || pooled) return
  if (live.size >= MAX_OPEN - 1) return
  /* 对照实验用的开关：关掉池再看一次冷启动到底多慢 */
  if (process.env.NOTA_STICKY_NO_POOL === '1') return

  let win: BrowserWindow
  try {
    win = makeWindow({})
  } catch {
    return
  }
  /* 池里这张不显示、不进任务栏。置顶也取消 —— 一张看不见的纸去抢其它窗口
     的层级，是纯捣乱 */
  win.setAlwaysOnTop(false)
  win.setSkipTaskbar(true)

  const p = { win, ready: false }
  pooled = p
  win.on('closed', () => {
    if (pooled === p) {
      pooled = null
      clearPoolTimer()
    }
  })
  win.webContents.once('did-finish-load', () => {
    if (pooled !== p) return
    p.ready = true
    clearPoolTimer()
    poolTimer = setTimeout(() => {
      if (pooled === p) destroyPool()
    }, POOL_IDLE)
    poolTimer.unref?.()
  })
  void loadInto(win).catch(() => {
    if (pooled === p) destroyPool()
  })
}

/**
 * 认领池里那张空纸。
 *
 * 不 ready 的不认领：数据推过去会落在一个还没跑起来的页面上，直接丢。
 * 那种情况下不如老老实实现建一个，反正用户已经等过一次了。
 */
function claim(meta: StickyMeta, text: string): BrowserWindow | null {
  const p = pooled
  if (!p || !p.ready || p.win.isDestroyed()) return null
  pooled = null
  clearPoolTimer()

  const win = p.win
  const pos = placeFor(meta)
  const data = payload(meta, text)
  const pin = meta.pinned !== false

  /* 先摆好外观再 attach：setBounds 会触发 resize，attach 之后再设就会
     让刚认领的纸立刻写一次盘（记下的还是它自己的位置，纯浪费） */
  win.setSkipTaskbar(false)
  win.setAlwaysOnTop(pin, pin ? 'floating' : 'normal')
  win.setBackgroundColor(paperOf(meta))
  win.setBounds({ x: pos.x, y: pos.y, width: meta.w ?? 340, height: meta.h ?? 300 })

  bindings.set(win.webContents.id, data)
  attach(win, meta, text)
  /* 这个窗口里已经有一个跑着的界面在等数据，推过去就行 —— 不重载页面，
     这就是池的全部价值 */
  win.webContents.send('sticky:bind', data)

  win.show()
  win.focus()
  win.webContents.send('sticky:focus')
  if (timing()) console.log('[sticky-timing] warm=1')

  /* 认领完再备一张。隔一秒多，别和"这张纸出现"抢那一帧 */
  const t = setTimeout(() => prewarm(), 1200)
  t.unref?.()
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
 * 开一张新的。这是快捷键 Alt+N 的落点，会连按连开。
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
  const t0 = timing() ? performance.now() : 0
  const meta = await createSticky(dir(), {
    ...(bound ? { w: bound.width, h: bound.height } : {}),
  })
  if (t0) console.log(`[sticky-timing] index=${(performance.now() - t0).toFixed(1)}`)
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
  // 重新打开时把归档标记撤掉，否则列表里会显得它还关着。
  // 传 null 而不是 undefined：patchSticky 把 null 当「删掉这个字段」，
  // undefined 则是「没给这个字段」直接跳过，归档标记就留下了。
  await patchSticky(dir(), id, { closedAt: null })
  return !!(await mount({ ...meta, closedAt: undefined }, text))
}

/** 收起全部（Alt+Shift+N）。逐张关，空白的那些会自己消失 */
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
/**
 * 从列表里改了纸色：窗口正开着就跟一下。
 *
 * 只写盘的话，那张纸要等下次打开才变色 —— 用户看到的是「右键点了颜色，
 * 屏幕上一点反应都没有」，很容易以为没生效，于是再点一次别的颜色。
 */
export function pushStickyColor(id: string, color: string): void {
  const entry = live.get(id)
  if (!entry || entry.win.isDestroyed()) return
  entry.win.setBackgroundColor(paperOf({ color }))
  entry.win.webContents.send('sticky:color', color)
}

export async function setStickyColor(id: string, color: string): Promise<boolean> {
  const entry = live.get(id)
  if (!entry || entry.win.isDestroyed()) return false
  entry.win.setBackgroundColor(paperOf({ color }))
  await patchSticky(dir(), id, { color })
  return true
}

/** 应用退出前把开着的便签都收好，别让正在打的字跟着进程一起消失 */
export async function flushAll(): Promise<void> {
  /* 池里那张空纸先扔掉：它是「一个窗口」，留在那儿会让 window-all-closed
     永远等不到，退出就变成"关不掉" */
  destroyPool()
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
