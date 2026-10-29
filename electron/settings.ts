/**
 * 一个库的全部设置，落成 `<库>/.nota/settings.json`。
 *
 * 以前这些东西散在 localStorage（界面状态、AI 配置、同步密码、聊天记录），
 * 而 localStorage 在 Electron 里落在 %APPDATA%\<app> 的 leveldb 里 —— 用户
 * 既看不见也备份不了，换台电脑更是一无所有。再加上便签在 %LOCALAPPDATA%、
 * 笔记在库目录，一台机器上三处各存一部分，想「整个搬走」根本无从下手。
 *
 * 现在的划分只有一条线：**跟这个库有关的一切都在库里面**。
 * 拷走库目录 = 拷走笔记、附件、历史、图标、便签、AI 配置、同步配置。
 * 留在系统目录的只有两个「这台电脑的登记信息」：
 *
 *   - vault.json：上次打开的是哪个库。它必须在知道库在哪之前就能读到，
 *     所以只能放在外面（放在库里就成了先有鸡还是先有蛋）。
 *   - prefs.json：开机自启、便签全局快捷键。这两个开关描述的是这台机器，
 *     跟着库搬到另一台电脑上反而会做错事（比如在新机器上偷偷开机自启）。
 *
 * 没有库的时候（首次启动、欢迎页）设置落在 `%LOCALAPPDATA%\Nota\settings.json`，
 * 一旦建好库就整份搬进去 —— 用户不必为「我还没建库时改的主题」再调一遍。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export type SettingsMap = Record<string, unknown>

/**
 * `<库>/.nota`。库根为空时退回机器级目录。
 *
 * 两样都拿不到（环境里连本地目录都读不出来）时返回空串 —— 调用方据此
 * 当「没有这处存储」，而不是让 path.join 抛错把整条读取链路带崩。
 */
export function notaDirOf(root: string | null, machineRoot: string | null): string {
  if (root) return path.join(root, '.nota')
  return machineRoot ? path.join(machineRoot, 'Nota') : ''
}

/**
 * 库内某个数据文件的路径。
 *
 * 默认是 settings.json。聊天记录单独一份（chat.json）：它长得很快，
 * 而且每聊一句就要落盘一次，混在设置里等于每次拖一下分隔线就把几十万字的
 * 对话重写一遍 —— 那是纯浪费。
 */
export type StoreName = 'settings' | 'chat'

export function settingsPathOf(
  root: string | null,
  machineRoot: string | null,
  name: StoreName = 'settings',
): string {
  const dir = notaDirOf(root, machineRoot)
  return dir ? path.join(dir, `${name}.json`) : ''
}

/**
 * 写盘串行化。
 *
 * 设置是「改一项写一次」的碎片操作：拖动分隔线、切换主题、关掉侧栏都会触发。
 * 几个请求同时在飞的时候，各自「读-合并-写」会互相覆盖 —— 后写的那次
 * 手里握着旧快照，能把前一次的改动抹掉。排队之后就不会了。
 */
const queues = new Map<string, Promise<unknown>>()

function enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const next = prev.then(job, job)
  queues.set(
    key,
    next.catch(() => undefined),
  )
  return next
}

/** 原子写：先写 .tmp 再 rename，写到一半断电不会留下半个 json */
async function writeAtomic(file: string, data: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, data, 'utf8')
  await fsp.rename(tmp, file)
}

export async function readSettingsFile(file: string): Promise<SettingsMap | null> {
  try {
    const raw = await fs.promises.readFile(file, 'utf8')
    const o = JSON.parse(raw) as unknown
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null
    return o as SettingsMap
  } catch {
    /* 没有、坏了、不是对象 —— 一律当作「还没写过」 */
    return null
  }
}

/**
 * 开窗之前把主题读出来（同步）。
 *
 * 渲染层拿到设置要等一轮 IPC，第一帧多半已经画出来了：深色用户每次启动都会
 * 先闪一下浅色。以前靠 localStorage 存一份副本兜住这一帧，可那样主题就成了
 * 两处数据 —— 两个库来回切的时候缓存和真值还会打架。
 *
 * 现在由主进程在开窗前读一次，通过启动参数交给 preload。同步读一个小 json
 * 的代价远小于一次白闪；读不到就返回 null，让渲染层退回系统偏好。
 */
export function bootThemeOf(root: string | null, machineRoot: string | null): 'light' | 'dark' | null {
  const file = settingsPathOf(root, machineRoot)
  if (!file) return null
  for (const f of [file, settingsPathOf(null, machineRoot)]) {
    if (!f) continue
    try {
      const o = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>
      const t = o?.['nota-theme']
      if (t === 'light' || t === 'dark') return t
    } catch {
      /* 没有或坏了：看下一处 */
    }
  }
  return null
}

/**
 * 读一个库的设置。
 *
 * 自己空着而机器级那份有内容时，把机器级的搬过来 —— 这是老用户的第一次
 * 升级路径：他们的设置全在机器级（更早是 localStorage），库里的 .nota
 * 什么都不认识。搬完**不删**机器级那份：万一用户又装回旧版本，那边
 * 至少还是一份完整的旧设置，而不是一片空白。
 */
export async function readSettings(
  root: string | null,
  machineRoot: string | null,
  name: StoreName = 'settings',
): Promise<{ data: SettingsMap; path: string; migratedFrom?: string }> {
  const target = settingsPathOf(root, machineRoot, name)
  if (!target) return { data: {}, path: '' }
  const own = await readSettingsFile(target)
  const machineFile = root ? settingsPathOf(null, machineRoot, name) : ''

  if (machineFile) {
    const machine = await readSettingsFile(machineFile)
    if (!own && machine) {
      await enqueue(target, () => writeAtomic(target, `${JSON.stringify(machine, null, 2)}\n`))
      return { data: machine, path: target, migratedFrom: machineFile }
    }
  }

  return { data: own ?? {}, path: target }
}

/** 合并写。传进来的每个键都会覆盖旧值；值为 null 表示删掉这个键 */
export async function patchSettings(
  root: string | null,
  machineRoot: string | null,
  patch: SettingsMap,
  name: StoreName = 'settings',
): Promise<void> {
  const file = settingsPathOf(root, machineRoot, name)
  if (!file) return
  await enqueue(file, async () => {
    const cur = (await readSettingsFile(file)) ?? {}
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete cur[k]
      else cur[k] = v
    }
    await writeAtomic(file, `${JSON.stringify(cur, null, 2)}\n`)
  })
}

/**
 * 把机器级的便签搬进库。
 *
 * 便签的设计是「和库解耦」：没建库也能按 Alt+N 记一句。所以老用户手里
 * 大概率有这么一批：在机器级目录里，而库里一个都没有。第一次带着库
 * 启动时不搬的话，它们就「消失」了 —— 用户看到的是便签全没了。
 *
 * 两条边界：
 *   - 搬过的库留一个 `.migrated` 记号，之后永远不再看机器级那份。否则
 *     用户在库里删掉一张纸，下次启动它又从旧目录里冒出来。
 *   - 按 id 去重：库里已经有的那张不搬。这样「库里已经有便签」的库也能
 *     补回它没见过的那些，而不是整批放弃。
 *
 * 复制而不是移动：旧位置留着，装回旧版本时那边仍然是一份完整快照。
 */
export async function migrateStickies(
  root: string | null,
  machineRoot: string | null,
): Promise<{ copied: number } | null> {
  if (!root || !machineRoot) return null
  const from = path.join(machineRoot, 'Nota', 'stickies')
  const to = path.join(root, '.nota', 'stickies')
  if (from === to) return null

  const isDir = (p: string) =>
    fs.promises
      .stat(p)
      .then((s) => s.isDirectory())
      .catch(() => false)

  const marker = path.join(to, '.migrated')
  if (fs.existsSync(marker)) return null
  if (!(await isDir(from))) return null

  /* 库里已经有谁：文件在、或者 index.json 里登记过（空白便签只有登记没有文件） */
  const have = new Set<string>()
  try {
    for (const n of await fsp.readdir(to)) {
      if (n.endsWith('.md')) have.add(n.slice(0, -3))
    }
  } catch {
    /* 还没有这个目录 */
  }
  try {
    const arr = JSON.parse(await fsp.readFile(path.join(to, 'index.json'), 'utf8')) as unknown
    if (Array.isArray(arr)) {
      for (const m of arr) {
        if (m && typeof (m as { id?: unknown }).id === 'string') have.add((m as { id: string }).id)
      }
    }
  } catch {
    /* 没有或者坏了：按文件去重就够 */
  }

  let copied = 0
  try {
    await fsp.mkdir(to, { recursive: true })
    for (const name of await fsp.readdir(from)) {
      if (!/\.(md|json|png|jpg|jpeg|webp|gif)$/i.test(name)) continue
      /* index.json 合并由调用方无从处理，这里只搬「库还没有的那几张纸」，
         index 里没有的记录会在 listStickies 时按磁盘文件补出来 */
      if (name === 'index.json') continue
      if (have.has(name.replace(/\.(md|png|jpg|jpeg|webp|gif)$/i, ''))) continue
      try {
        await fsp.copyFile(path.join(from, name), path.join(to, name))
        copied += 1
      } catch {
        /* 单个文件搬不动就跳过，别让整批失败 */
      }
    }
    await fsp.writeFile(marker, `${new Date().toISOString()}\n`, 'utf8')
  } catch {
    return null
  }
  return { copied }
}
