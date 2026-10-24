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
