/**
 * 桌面级偏好：开机自启、全局快捷键开关。
 *
 * 为什么这一小撮设置不跟其他界面偏好一起放 localStorage：
 *
 * 这两项要在**主窗口不存在的时候**也生效 —— 用户关掉窗口收进托盘后，
 * 渲染进程已经销毁，localStorage 那份就读不到了；开机自启那一轮更是
 * 压根不建窗口（--hidden）。主进程必须自己能拿到这个值。
 *
 * 所以落在 %LOCALAPPDATA%\Nota\prefs.json，和 vault.json 放一起。
 * 不 import electron，能脱壳测。
 */
import path from 'node:path'
import fs from 'node:fs/promises'

export interface DesktopPrefs {
  /** 全局快捷键是否启用 */
  hotkey: boolean
  /** 开机自启（仅安装版有意义） */
  openAtLogin: boolean
}

export const DEFAULT_PREFS: DesktopPrefs = {
  hotkey: true,
  openAtLogin: false,
}

export function prefsPath(localAppData: string): string {
  return path.join(localAppData, 'Nota', 'prefs.json')
}

/** 读不到、坏了、字段类型不对，一律退回默认值，不让启动挂在门口 */
export async function readPrefs(localAppData: string): Promise<DesktopPrefs> {
  try {
    const raw = await fs.readFile(prefsPath(localAppData), 'utf8')
    const o = JSON.parse(raw) as Partial<DesktopPrefs>
    return {
      hotkey: typeof o?.hotkey === 'boolean' ? o.hotkey : DEFAULT_PREFS.hotkey,
      openAtLogin:
        typeof o?.openAtLogin === 'boolean' ? o.openAtLogin : DEFAULT_PREFS.openAtLogin,
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

/** 只改传进来的字段，其余保持原样。返回合并后的完整值 */
export async function writePrefs(
  localAppData: string,
  patch: Partial<DesktopPrefs>,
): Promise<DesktopPrefs> {
  const cur = await readPrefs(localAppData)
  const next = { ...cur, ...patch }
  const p = prefsPath(localAppData)
  await fs.mkdir(path.dirname(p), { recursive: true })
  // 原子写：写到一半掉电不该把这两项变成「未设置」（那会让快捷键悄悄失效）
  const tmp = `${p}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, p)
  return next
}
