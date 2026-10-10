import { contextBridge, ipcRenderer } from 'electron'

/**
 * 安全桥接：只暴露白名单方法，渲染进程拿不到 Node 的 fs / child_process 等能力。
 * 每个方法对应主进程里一个 ipcMain.handle。
 */
contextBridge.exposeInMainWorld('api', {
  pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke('workspace:pick'),
  readTree: (root: string): Promise<any[]> => ipcRenderer.invoke('workspace:tree', root),
  readNote: (file: string): Promise<string> => ipcRenderer.invoke('note:read', file),
  writeNote: (file: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke('note:write', file, content),
  createNote: (dir: string, name: string): Promise<string> =>
    ipcRenderer.invoke('note:create', dir, name),
  deleteNote: (file: string): Promise<boolean> => ipcRenderer.invoke('note:delete', file),
  renameNote: (file: string, newName: string): Promise<string> =>
    ipcRenderer.invoke('note:rename', file, newName),
  pickImage: (
    workspace: string,
    kind?: 'image' | 'video' | 'any',
  ): Promise<{ rel: string; alt: string; copied: boolean; isVideo: boolean } | null> =>
    ipcRenderer.invoke('image:pick', workspace, kind ?? 'image'),
  /* 把笔记里的相对路径换算成可加载的媒体 URL（工作区图片靠它显示） */
  resolveMedia: (base: string, rel: string): Promise<string | null> =>
    ipcRenderer.invoke('media:resolve', base, rel),

  /* 导出：弹保存框并写文件，返回最终路径 */
  exportSave: (opts: { defaultName: string; kind: string; data: string }): Promise<string | null> =>
    ipcRenderer.invoke('export:save', opts),

  /* 版本历史 */
  historySave: (workspace: string, file: string, content: string): Promise<string | null> =>
    ipcRenderer.invoke('history:save', workspace, file, content),
  historyList: (
    workspace: string,
    file: string,
  ): Promise<{ name: string; path: string; size: number; mtime: number }[]> =>
    ipcRenderer.invoke('history:list', workspace, file),
  historyRead: (snapshot: string): Promise<string | null> =>
    ipcRenderer.invoke('history:read', snapshot),

  /* 窗口控制（自绘标题栏用） */
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
  onMaximizeChange: (cb: (maximized: boolean) => void): void => {
    ipcRenderer.on('window:maximized', (_e, v: boolean) => cb(v))
  },
})
