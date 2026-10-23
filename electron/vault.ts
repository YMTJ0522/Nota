/**
 * 首次启动准备笔记库。
 *
 * 单独一个文件是为了能脱离 Electron 测：这里只碰 path 和 fs，
 * 不碰 app / ipcMain，测试可以直接给一个临时目录跑。
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
 * 在 documentsDir 下准备一个 Nota 目录。
 *
 * 三种情况：
 *  - 目录不存在 → 建，写欢迎文档
 *  - 目录存在但是空的 → 写欢迎文档
 *  - 目录里已经有东西 → 原样交回去，一个文件都不写
 *
 * 第三条是重点：装过又卸过、或者用户早就自己建好了这个目录，
 * 这时候往里塞一篇欢迎文档就是在往别人的库里丢垃圾。
 */
export async function ensureVault(documentsDir: string): Promise<VaultResult> {
  const target = path.join(documentsDir, 'Nota')
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
