import { contextBridge, ipcRenderer } from 'electron'

/**
 * 便签窗口的桥。刻意做得很小 —— 这个窗口是「随时按快捷键弹出来」的东西，
 * 它不该有能力读笔记、改工作区、发 AI 请求。只有四件事：
 * 读自己、写自己、调外观、关掉自己。
 */
contextBridge.exposeInMainWorld('sticky', {
  /** 拉正文和外观。id 由窗口 URL 带进来，渲染层读 search 传给这里 */
  load: (
    id: string,
  ): Promise<{ text: string; pinned: boolean; color: string; savedTo?: string } | null> =>
    ipcRenderer.invoke('sticky:load', id),

  /** 自动保存：每敲一会儿上报一次，主进程同步写盘 */
  write: (id: string, text: string): Promise<void> => ipcRenderer.invoke('sticky:write', id, text),

  /** Esc / 自绘关闭按钮。主进程决定这张纸留下还是扔掉 */
  close: (id: string): Promise<void> => ipcRenderer.invoke('sticky:close', id),

  pin: (id: string, pinned: boolean): Promise<boolean> =>
    ipcRenderer.invoke('sticky:pin', id, pinned),

  color: (id: string, color: string): Promise<boolean> =>
    ipcRenderer.invoke('sticky:color', id, color),

  /** 搬进笔记库的 便签/ 目录，返回相对路径 */
  saveToVault: (id: string): Promise<{ ok: boolean; rel?: string; error?: string }> =>
    ipcRenderer.invoke('sticky:saveToVault', id),

  /** 彻底删掉这张纸（列表里那次删除） */
  remove: (id: string): Promise<boolean> => ipcRenderer.invoke('sticky:remove', id),

  /** 新窗口建好后主进程叫一声，把光标送进正文 */
  onFocus: (cb: () => void): void => {
    ipcRenderer.removeAllListeners('sticky:focus')
    ipcRenderer.on('sticky:focus', () => cb())
  },
})
