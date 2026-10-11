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
  createFolder: (parent: string, name: string): Promise<string> =>
    ipcRenderer.invoke('folder:create', parent, name),
  deleteNote: (file: string): Promise<boolean> => ipcRenderer.invoke('note:delete', file),
  renameNote: (file: string, newName: string): Promise<string> =>
    ipcRenderer.invoke('note:rename', file, newName),
  /* 导入：把工作区外面的 .md 复制进来，返回真正写成功的那些 */
  importNotes: (root: string, dir: string): Promise<{ name: string; path: string }[]> =>
    ipcRenderer.invoke('note:import', root, dir),
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

  /* 回收站：删除的笔记进 .nota/trash，可恢复可彻底删 */
  trashList: (
    root: string,
  ): Promise<{ key: string; rel: string; name: string; deletedAt: number; size: number }[]> =>
    ipcRenderer.invoke('trash:list', root),
  trashRestore: (root: string, key: string): Promise<string> =>
    ipcRenderer.invoke('trash:restore', root, key),
  trashPurge: (root: string, key: string): Promise<boolean> =>
    ipcRenderer.invoke('trash:purge', root, key),
  trashEmpty: (root: string): Promise<boolean> => ipcRenderer.invoke('trash:empty', root),

  /* 附件库：工作区 attachments/ 下的图片与视频 */
  attachList: (
    root: string,
  ): Promise<
    { rel: string; name: string; size: number; mtime: number; isVideo: boolean }[]
  > => ipcRenderer.invoke('attach:list', root),
  attachDelete: (root: string, rel: string): Promise<boolean> =>
    ipcRenderer.invoke('attach:delete', root, rel),

  /* AI：请求在主进程发出，绕开渲染进程的 CORS 限制。
     回答是流式的：onAiDelta 收增量，aiChat 的 Promise 在流结束时才 resolve。 */
  aiChat: (
    cfg: { baseUrl: string; model: string; apiKey: string; system: string; temperature: number },
    messages: { role: string; content: string }[],
  ): Promise<{ ok: boolean; text?: string; reasoning?: string; error?: string }> =>
    ipcRenderer.invoke('ai:chat', cfg, messages),
  onAiDelta: (cb: (d: { text?: string; reasoning?: string; done?: boolean }) => void): void => {
    ipcRenderer.removeAllListeners('ai:delta')
    ipcRenderer.on('ai:delta', (_e, d) => cb(d))
  },
  aiTest: (cfg: {
    baseUrl: string
    model: string
    apiKey: string
    system: string
    temperature: number
  }): Promise<{ ok: boolean; models?: string[]; error?: string }> =>
    ipcRenderer.invoke('ai:test', cfg),

  /* 运行环境版本（关于页展示） */
  appInfo: (): Promise<{
    electron: string
    chrome: string
    node: string
    platform: string
    arch: string
  }> => ipcRenderer.invoke('app:info'),

  /* 窗口控制（自绘标题栏用） */
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
  onMaximizeChange: (cb: (maximized: boolean) => void): void => {
    ipcRenderer.on('window:maximized', (_e, v: boolean) => cb(v))
  },
})
