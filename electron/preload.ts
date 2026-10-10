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

  /* 窗口控制（自绘标题栏用） */
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
  onMaximizeChange: (cb: (maximized: boolean) => void): void => {
    ipcRenderer.on('window:maximized', (_e, v: boolean) => cb(v))
  },
})
