/**
 * 安装窗的桥。只暴露几个动词，不做通用的 invoke 转发 ——
 * 这个窗口是从 resources 里加载的静态页，权限给得越窄越好。
 */
import { contextBridge, ipcRenderer } from 'electron'

interface Phase {
  label: string
  percent: number
}

contextBridge.exposeInMainWorld('notaInstall', {
  info: () => ipcRenderer.invoke('installer:info'),
  chooseDir: () => ipcRenderer.invoke('installer:chooseDir'),
  chooseNotes: () => ipcRenderer.invoke('installer:chooseNotes'),
  start: () => ipcRenderer.invoke('installer:start'),
  launch: (exe?: string) => ipcRenderer.invoke('installer:launch', exe),
  usePortable: () => ipcRenderer.invoke('installer:usePortable'),
  minimize: () => ipcRenderer.invoke('installer:minimize'),
  quit: () => ipcRenderer.invoke('installer:quit'),
  onPhase: (cb: (p: Phase) => void) => {
    ipcRenderer.on('installer:phase', (_e, p: Phase) => cb(p))
  },
})
