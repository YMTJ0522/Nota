/**
 * 关掉页面缩放。
 *
 * Chromium 自带 Ctrl+加号 / Ctrl+减号 / 触控板捏合缩放，Electron 默认不拦。
 * 它改的是 webContents 的缩放比例：整个界面（连自绘的标题栏、图标、边框）
 * 一起变大又变小，而且**会记住**，下次开还是那个比例 —— 用户看到的就是
 * 「软件自己突然放大又缩小」，不像自己按了快捷键。
 *
 * 桌面应用不需要这个能力：正文想大一点有字号设置，不该把整个界面当网页缩放。
 *
 * 三处一起关，缺一处都能再打开：
 *   · setVisualZoomLevelLimits —— 触控板捏合（pinch）走的是 visual viewport；
 *   · did-finish-load 复位 —— 比例是会存进会话的，上一次留下的要清掉；
 *   · before-input-event —— Ctrl ± / 0 的快捷键，拦下来同时复位。
 *
 * 主窗口和便签窗口都要调。只在主窗口写，便签窗口照样能缩 —— 那种「有时候
 * 会，有时候不会」的毛病最难查。
 */
import type { BrowserWindow } from 'electron'

export function lockZoom(win: BrowserWindow): void {
  const wc = win.webContents

  // 触控板捏合
  wc.setVisualZoomLevelLimits(1, 1)

  // 已经是缩放状态时（比如这次更新之前留下的），一旦变化立刻拉回 100%
  wc.on('zoom-changed', () => {
    if (!wc.isDestroyed()) wc.setZoomFactor(1)
  })

  // 每次载入都从 100% 开始
  wc.on('did-finish-load', () => {
    if (!wc.isDestroyed()) wc.setZoomFactor(1)
  })

  // 快捷键：主键盘和小键盘的加减号都拦。
  // **不拦 Ctrl+0** —— 那个键我们自己在用（工具栏「正文」段落级别，见 Toolbar.vue）。
  // 页面缩放已经被限死在 1，Ctrl+0 就算漏下去也只是「复位到 100%」，无害。
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return
    const k = input.key
    if (k === '+' || k === '=' || k === '-' || k === '_') {
      e.preventDefault()
      if (!wc.isDestroyed()) wc.setZoomFactor(1)
    }
  })
}
