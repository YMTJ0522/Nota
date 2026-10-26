import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * 拖进来的 File 在 Electron 里是有真实磁盘路径的。
 * 单独暴露一个取路径的方法（而不是把整个 webUtils 递过去）——
 * 渲染进程只能问「这个文件的路径是什么」，拿不到别的。
 */
contextBridge.exposeInMainWorld('pathForFile', (file: File): string => {
  try {
    return webUtils.getPathForFile(file)
  } catch {
    return ''
  }
})

/**
 * 安全桥接：只暴露白名单方法，渲染进程拿不到 Node 的 fs / child_process 等能力。
 * 每个方法对应主进程里一个 ipcMain.handle。
 */
contextBridge.exposeInMainWorld('api', {
  pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke('workspace:pick'),
  /* 首次启动准备笔记库（建目录 + 写欢迎文档）。已有内容就原样打开，不写任何文件 */
  ensureVault: (): Promise<{
    root: string | null
    file: string | null
    created: boolean
    error?: string
  }> => ipcRenderer.invoke('vault:ensure'),
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
  /* 归到另一个文件夹 / 在文件管理器里定位 */
  moveNote: (file: string, dir: string): Promise<string> =>
    ipcRenderer.invoke('note:move', file, dir),
  revealNote: (file: string): Promise<boolean> => ipcRenderer.invoke('note:reveal', file),
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
  /* 导出 PDF：主进程拿渲染好的 HTML 在隐藏窗口里打印 */
  exportPdf: (opts: { defaultName: string; html: string }): Promise<string | null> =>
    ipcRenderer.invoke('export:pdf', opts),

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
  ): Promise<
    { key: string; rel: string; name: string; deletedAt: number; size: number; isDir?: boolean }[]
  > => ipcRenderer.invoke('trash:list', root),
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
  /* 批量导入任意文件（图片/视频/压缩包/文档…）到 attachments/ */
  attachImport: (
    root: string,
  ): Promise<{ rel: string; name: string; size: number; mtime: number; isVideo: boolean }[]> =>
    ipcRenderer.invoke('attach:import', root),

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
  /* 节点图标：相对路径 → 图标 id，存在工作区 .nota/icons.json */
  iconsRead: (root: string): Promise<Record<string, string>> =>
    ipcRenderer.invoke('icons:read', root),
  iconsWrite: (root: string, map: Record<string, string>): Promise<boolean> =>
    ipcRenderer.invoke('icons:write', root, map),

  /* 标签归属图标：标签名 → 图标 id，存在 .nota/tag-icons.json */
  tagIconsRead: (root: string): Promise<Record<string, string>> =>
    ipcRenderer.invoke('tagIcons:read', root),
  tagIconsWrite: (root: string, map: Record<string, string>): Promise<boolean> =>
    ipcRenderer.invoke('tagIcons:write', root, map),

  /* 把粘贴 / 拖进来的图片存进工作区 attachments/，返回相对路径 */
  mediaSave: (
    root: string,
    item: { srcPath?: string; bytes?: string; ext?: string },
  ): Promise<{ rel: string; name: string; isVideo: boolean } | null> =>
    ipcRenderer.invoke('media:save', root, item),

  /* 联网检索：agent 那一轮先去查资料。走主进程，不受 CORS 限制 */
  aiWebSearch: (
    query: string,
    limit?: number,
  ): Promise<{
    ok: boolean
    hits?: { title: string; url: string; snippet: string }[]
    engine?: string
    error?: string
  }> => ipcRenderer.invoke('ai:websearch', query, limit),

  /* 云同步（WebDAV）：测试连接 / 执行同步；进度事件一路推到界面 */
  syncTest: (cfg: {
    url: string
    username: string
    password: string
    dir: string
  }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('sync:test', cfg),
  syncRun: (
    root: string,
    cfg: { url: string; username: string; password: string; dir: string },
  ): Promise<{
    ok: boolean
    uploaded: number
    downloaded: number
    conflicts: number
    skipped: number
    error?: string
  }> => ipcRenderer.invoke('sync:run', root, cfg),
  onSyncProgress: (cb: (text: string) => void): void => {
    ipcRenderer.removeAllListeners('sync:progress')
    ipcRenderer.on('sync:progress', (_e, text: string) => cb(text))
  },

  /* 运行环境版本（关于页展示） */
  appInfo: (): Promise<{
    electron: string
    chrome: string
    node: string
    platform: string
    arch: string
  }> => ipcRenderer.invoke('app:info'),

  /* 检查更新：拿官网 info.json 和传进来的当前版本比一比，只报不装 */
  checkUpdate: (current: string): Promise<{
    current: string
    latest: string
    newer: boolean
    size: number
    url: string
    error?: string
    detail?: string
  }> => ipcRenderer.invoke('app:checkUpdate', current),

  /* ── 便签 ──
     主窗口这边只负责「列出来 / 开一张 / 关掉全部」，正文读写全在便签窗口
     自己的 preload 里。两边分开是为了让便签窗口拿不到笔记与工作区。 */
  stickyList: (): Promise<
    {
      id: string
      title: string
      preview: string
      chars: number
      createdAt: number
      updatedAt: number
      closedAt?: number
      savedTo?: string
      tags?: string[]
      icon?: { kind: 'brand' | 'emoji'; id: string }
      color?: string
    }[]
  > => ipcRenderer.invoke('sticky:list'),
  stickyNew: (): Promise<{ id: string } | { error: string }> => ipcRenderer.invoke('sticky:new'),
  stickyOpen: (id: string): Promise<boolean> => ipcRenderer.invoke('sticky:open', id),
  stickyCloseAll: (): Promise<number> => ipcRenderer.invoke('sticky:closeAll'),
  stickyCount: (): Promise<number> => ipcRenderer.invoke('sticky:count'),
  stickyDelete: (id: string): Promise<boolean> => ipcRenderer.invoke('sticky:delete', id),
  stickyMarkSaved: (id: string, rel: string): Promise<boolean> =>
    ipcRenderer.invoke('sticky:markSaved', id, rel),
  /** 改标题 = 改正文第一行，标题只有一份，不另存名字 */
  stickyRename: (id: string, title: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sticky:rename', id, title),
  /** 打标签 / 换图标。icon 传 null 是「去掉这枚图标」 */
  stickyPatch: (
    id: string,
    patch: { tags?: string[]; icon?: { kind: 'brand' | 'emoji'; id: string } | null },
  ): Promise<boolean> => ipcRenderer.invoke('sticky:patch', id, patch),
  stickyText: (id: string): Promise<string> => ipcRenderer.invoke('sticky:text', id),
  stickyReveal: (id: string): Promise<boolean> => ipcRenderer.invoke('sticky:reveal', id),
  /** 存为笔记。落点由主进程决定（当前工作区 → 安装时选的目录 → 文档\Nota） */
  stickySaveToVault: (id: string): Promise<{ ok: boolean; rel?: string; error?: string }> =>
    ipcRenderer.invoke('sticky:saveToVault', id),
  /** 便签窗口数量变化（开了一张、关了一张） */
  onStickyCount: (cb: (n: number) => void): void => {
    ipcRenderer.removeAllListeners('sticky:count')
    ipcRenderer.on('sticky:count', (_e, n: number) => cb(n))
  },
  /** 快捷键按下但便签开不出来（比如已经开了 12 张） */
  onStickyError: (cb: (msg: string) => void): void => {
    ipcRenderer.removeAllListeners('sticky:error')
    ipcRenderer.on('sticky:error', (_e, msg: string) => cb(msg))
  },

  /* ── 桌面整合：开机自启、全局快捷键 ── */
  desktopPrefs: (): Promise<{
    hotkey: boolean
    openAtLogin: boolean
    canAutoStart: boolean
    portable: boolean
    packaged: boolean
    hotkeyNew: string
    hotkeyCloseAll: string
    hotkeyError: string
  }> => ipcRenderer.invoke('desktop:prefs'),
  setHotkey: (on: boolean): Promise<{ ok: boolean; error: string }> =>
    ipcRenderer.invoke('desktop:setHotkey', on),
  setAutoStart: (on: boolean): Promise<boolean> => ipcRenderer.invoke('desktop:setAutoStart', on),
  /** 当前工作区报给主进程：便签「存为笔记」要知道往哪存 */
  setActiveRoot: (root: string | null): Promise<boolean> =>
    ipcRenderer.invoke('desktop:activeRoot', root),
  revealStickies: (): Promise<string> => ipcRenderer.invoke('desktop:revealStickies'),

  /* 窗口控制（自绘标题栏用） */
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
  onMaximizeChange: (cb: (maximized: boolean) => void): void => {
    ipcRenderer.on('window:maximized', (_e, v: boolean) => cb(v))
  },
})
