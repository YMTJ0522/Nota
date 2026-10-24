/**
 * 首次启动准备笔记库。
 *
 * 单独一个文件是为了能脱离 Electron 测：这里只碰 path 和 fs，
 * 不碰 app / ipcMain，测试可以直接给一个临时目录跑。
 *
 * 另外这里还管一样东西：**安装时选的笔记目录记在哪**（vault.json）。
 * 安装程序（portable 身份）和装好后的程序都读它，所以路径不能靠
 * app.getPath('userData') 算 —— 那个在 portable 运行时可能被重定向到临时目录，
 * 两边算出来就不是同一个文件了。统一拼 %LOCALAPPDATA%\Nota\。
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { WELCOME_DOC, WELCOME_NAME } from './welcome-doc'

export interface VaultResult {
  root: string | null
  file: string | null
  created: boolean
  error?: string
}

/**
 * 直接在 target 这个目录上准备笔记库。
 *
 * 三种情况：
 *  - 目录不存在 → 建，写欢迎文档
 *  - 目录存在但是空的 → 写欢迎文档
 *  - 目录里已经有东西 → 原样交回去，一个文件都不写
 *
 * 第三条是重点：装过又卸过、或者用户早就自己建好了这个目录、
 * 或者安装时专门指着自己现有的笔记文件夹说「就用这个」——
 * 这时候往里塞一篇欢迎文档就是在往别人的库里丢垃圾。
 */
export async function ensureVaultAt(target: string): Promise<VaultResult> {
  try {
    await fs.mkdir(target, { recursive: true })
    const entries = (await fs.readdir(target)).filter((n) => !n.startsWith('.'))
    if (entries.length > 0) return { root: target, file: null, created: false }

    const file = path.join(target, WELCOME_NAME)
    // wx：同名文件已存在就失败，绝不覆盖
    await fs.writeFile(file, WELCOME_DOC, { encoding: 'utf8', flag: 'wx' })
    return { root: target, file, created: true }
  } catch (e) {
    return { root: null, file: null, created: false, error: String(e) }
  }
}

/**
 * 在 documentsDir 下准备一个 Nota 目录（没在安装时选过路径时走这条）。
 */
export async function ensureVault(documentsDir: string): Promise<VaultResult> {
  return ensureVaultAt(path.join(documentsDir, 'Nota'))
}

/* ── 安装时选的笔记目录 ── */

/** 指针文件的位置。安装程序与主程序都用 %LOCALAPPDATA%\Nota\vault.json */
export function vaultPointerPath(localAppData: string): string {
  return path.join(localAppData, 'Nota', 'vault.json')
}

export async function writeVaultPointer(localAppData: string, root: string): Promise<void> {
  const p = vaultPointerPath(localAppData)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, `${JSON.stringify({ root, at: Date.now() }, null, 2)}\n`, 'utf8')
}

/**
 * 读回安装时选的目录。没有、坏了、或者内容不是个字符串，一律返回 null ——
 * 这个文件只是「装的时候挑过哪里」的提示，读不出来就退回默认的「文档\Nota」，
 * 不能因为一个坏掉的 json 让程序首次启动就起不来。
 */
export async function readVaultPointer(localAppData: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(vaultPointerPath(localAppData), 'utf8')
    const root = (JSON.parse(raw) as { root?: unknown })?.root
    if (typeof root !== 'string' || !root.trim()) return null
    return path.resolve(root)
  } catch {
    return null
  }
}

/* ── 「这次是全新安装」的标记 ──
 *
 * 安装器装完写一个标记，主程序启动时看到它，就把上一个版本留下的界面状态
 * 整个清掉（见 main.ts 的 consumeFreshInstall）。
 *
 * 为什么需要这个：界面的东西（AI 的密钥、聊天记录、上次打开的目录、
 * 侧栏宽度、那个 5 步引导的「已看过」）全在 localStorage 里，它躺在
 * %APPDATA%\Nota 里，装新版本根本不动它。于是「重装了一个干净的新版」
 * 打开还是旧密钥、旧对话、旧目录 —— 用户会以为安装没生效。
 *
 * 也不能让安装器当场删：安装器进程自己就占着那份 LevelDB（LOCK 文件在），
 * 删到一半必然 EPERM。所以只留标记，让**下一个进程**在窗口打开之前清。
 */
export function freshFlagPath(localAppData: string): string {
  return path.join(localAppData, 'Nota', 'fresh-install.json')
}

export async function writeFreshFlag(localAppData: string, version: string): Promise<void> {
  const p = freshFlagPath(localAppData)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, `${JSON.stringify({ at: Date.now(), version }, null, 2)}\n`, 'utf8')
}

/**
 * 读一次并把标记删掉。**先删再返回**：清界面状态是一次性的，
 * 万一清理那一步炸了，也不该在下次启动时再抹一遍用户刚配好的东西。
 * 文件不存在、内容坏了，都返回 null，安装后的首次启动不会因此起不来。
 */
export async function takeFreshFlag(localAppData: string): Promise<{ version?: string } | null> {
  const p = freshFlagPath(localAppData)
  let raw: string
  try {
    raw = await fs.readFile(p, 'utf8')
  } catch {
    return null
  }
  try {
    await fs.unlink(p)
  } catch {
    /* 删不掉也照样继续：下次启动再清一次，代价是配置又空一遍，比卡住强 */
  }
  try {
    const v = JSON.parse(raw) as { version?: unknown }
    return { version: typeof v?.version === 'string' ? v.version : undefined }
  } catch {
    return {}
  }
}
