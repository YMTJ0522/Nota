/**
 * 设置的内存副本 + 落盘队列。
 *
 * 一个库一份，存在 `<库>/.nota/settings.json`。这样「整个搬走」只需要
 * 拷一个文件夹：笔记、附件、历史、图标、便签、AI 配置、同步账号都在里面。
 *
 * 为什么不在 localStorage 里就地放着：
 *
 *  1. 用户看不见。Electron 的 localStorage 落在 %APPDATA% 的 leveldb 里，
 *     备份笔记时根本想不到还有这一块，换台电脑更是全丢。
 *  2. AI 密钥、同步密码写在那里是黑盒，想手改或想确认「我的 key 到底存了没」
 *     都没有入口。写成 json 至少是能打开、能看懂、能搬的。
 *  3. 没有库的时候也没有地方放（首次启动、欢迎页）—— 那时读写的还是
 *     机器级那份，一旦建库整份搬进去，用户不必重设一遍。
 *
 * 写盘是「改一项记一笔、攒 200ms 一起写」，因为拖一下分隔线会连续触发几十次。
 */
type Bag = Record<string, unknown>

/** 值类型。迁移时按它把 localStorage 里的字符串转成真类型，读的时候也按它取默认值 */
type Spec = 'string' | 'bool' | 'num' | 'json'

/**
 * 认识的键。**这个表是唯一真相**：迁移、读取、写盘都走它，
 * 免得「迁移时存成字符串、读的时候当对象用」这类错。
 */
const SPECS: Record<string, Spec> = {
  // 外观
  'nota-theme': 'string',
  'nota-accent': 'string',
  // 布局
  'nota-sidebar': 'bool',
  'nota-outline': 'bool',
  'nota-autosave': 'bool',
  'nota-view': 'string',
  'nota-column': 'string',
  'nota-column-auto': 'bool',
  'nota-w-sidebar': 'num',
  'nota-w-column': 'num',
  'nota-w-outline': 'num',
  // AI
  'nota-ai': 'json',
  'nota-ai-note': 'string',
  'nota-ai-withnote': 'bool',
  // 云同步
  'nota-sync': 'json',
  // 编辑器偏好
  'nota-prefs': 'json',
  // 杂项
  'nota-tour-seen': 'string',
  'nota.cmdk.recent': 'json',
  /* 上次停在哪个笔记。它是库内的相对路径，所以跟库走 —— 放在这里而不是
     localStorage，换台电脑打开同一个库还能回到同一篇。 */
  'nota-last-note': 'string',
}

let bag: Bag = {}
/** 当前这份设置属于哪个库。null = 还没有库，读写机器级那份 */
let root: string | null = null
/** 攒着还没写的改动 */
let pending: Bag = {}
let timer: ReturnType<typeof setTimeout> | null = null
/** 迁移只做一次。做完在文件里留个戳，以后启动直接读 */
const MIGRATED = 'migratedFrom'

function coerce(key: string, raw: unknown): unknown {
  const spec = SPECS[key]
  if (spec === 'bool') return raw === '0' || raw === false ? false : true
  if (spec === 'num') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  if (spec === 'json') {
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw)
      } catch {
        return undefined
      }
    }
    return raw
  }
  return typeof raw === 'string' ? raw : undefined
}

/**
 * 把老版本留在 localStorage 里的设置搬进文件。
 *
 * 搬完**不删** localStorage 里那些键：万一用户又装回旧版本，那边还是一份
 * 完整可用的旧设置，而不是一片空白。代价是两处会慢慢分叉 —— 新版只认文件，
 * 不再回头读 localStorage，所以旧那份从此是只读快照。
 */
function migrateFromLocalStorage(): Bag {
  const out: Bag = {}
  for (const key of Object.keys(SPECS)) {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(key)
    } catch {
      raw = null // 隐私模式/配额爆了，当作没有
    }
    if (raw === null || raw === '') continue
    const v = coerce(key, raw)
    if (v !== undefined) out[key] = v
  }
  return out
}

/** 读一份设置进内存。root 为 null 表示还没有库（读机器级那份） */
export async function loadSettings(next: string | null): Promise<void> {
  await flushSettings()
  root = next
  let data: Bag = {}
  try {
    const r = await window.api.settingsRead(next)
    data = r?.data ?? {}
  } catch {
    data = {}
  }

  if (!data[MIGRATED]) {
    /* 第一次跑这一版：把 localStorage 里那批搬进来。
       库里已经有文件时也要搬 —— 老用户升级上来，文件是刚建的空的 */
    const old = migrateFromLocalStorage()
    const merged = { ...old, ...data, [MIGRATED]: Date.now() }
    bag = merged
    pending = { ...pending, ...merged }
    schedule()
    return
  }

  /* 逐键挑，字段类型不对就当没有 —— 手改过的 json 不该让界面起不来。
     注意是遍历**文件里的键**而不是 SPECS：表里漏登记一个键（写的时候
     remember 进去了、读的时候被这张表过滤掉）就等于「这项设置每次重启都
     回到默认」，而且不报错、极难发现。不认识的键原样留着，反正它也是
     我们自己 JSON 序列化进去的。 */
  const clean: Bag = {}
  for (const key of Object.keys(data)) {
    const spec = SPECS[key]
    if (!spec) {
      clean[key] = data[key]
      continue
    }
    const v = coerce(key, data[key])
    if (v !== undefined) clean[key] = v
  }
  bag = clean
}

/** 取一项。没设过就用调用方给的默认值 */
export function setting<T>(key: string, fallback: T): T {
  const v = bag[key]
  return (v === undefined ? fallback : (v as T)) ?? fallback
}

/** 记一项：内存立刻生效，200ms 后落盘（连着的几十次改动只会写一次） */
export function remember(key: string, value: unknown): void {
  bag[key] = value
  pending[key] = value
  schedule()
}

function schedule(): void {
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void flushSettings()
  }, 200)
}

/** 立刻写盘。切库、关窗前都要叫一次，否则最后那点改动跟着进程一起没了 */
export async function flushSettings(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  const patch = pending
  pending = {}
  if (!Object.keys(patch).length) return
  try {
    await window.api.settingsPatch(root, patch)
  } catch {
    /* 写不进去（盘满/只读）就让它在内存里活着，本次会话仍然正常 */
  }
}

/** 当前设置存在哪个文件。设置页里要显示给人看 */
export async function settingsLocation(): Promise<string> {
  try {
    return (await window.api.settingsRead(root)).path
  } catch {
    return ''
  }
}
