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
  ): Promise<
    {
      text: string
      pinned: boolean
      color: string
      savedTo?: string
      tags?: string[]
      shots?: string[]
    } | null
  > => ipcRenderer.invoke('sticky:load', id),

  /** 自动保存：每敲一会儿上报一次，主进程同步写盘 */
  write: (id: string, text: string): Promise<void> => ipcRenderer.invoke('sticky:write', id, text),

  /** Esc / 自绘关闭按钮。主进程决定这张纸留下还是扔掉 */
  close: (id: string): Promise<void> => ipcRenderer.invoke('sticky:close', id),

  pin: (id: string, pinned: boolean): Promise<boolean> =>
    ipcRenderer.invoke('sticky:pin', id, pinned),

  color: (id: string, color: string): Promise<boolean> =>
    ipcRenderer.invoke('sticky:color', id, color),

  /**
   * 正文里打出来的 `#标签` 直接落到这张纸的记录上 —— 让「归类」变成写字的
   * 副产品，而不是另外去弹窗点一遍。
   *
   * 只加不减，并且由主进程读最新值再合并：这个窗口可能开着很久，期间用户
   * 从列表里给它补过标签，拿着窗口手里那份旧值覆盖回去就会把它们抹掉。
   * 返回合并之后的全量，窗口拿它更新自己那份。
   */
  addTags: (id: string, names: string[]): Promise<string[]> =>
    ipcRenderer.invoke('sticky:addTags', id, names),

  /** 搬进笔记库的 便签/ 目录，返回相对路径 */
  saveToVault: (id: string): Promise<{ ok: boolean; rel?: string; error?: string }> =>
    ipcRenderer.invoke('sticky:saveToVault', id),

  /** 彻底删掉这张纸（列表里那次删除） */
  remove: (id: string): Promise<boolean> => ipcRenderer.invoke('sticky:remove', id),

  /**
   * 贴一张图上来。图不写进正文（那层镜像靠逐行对齐，插图就全歪了），
   * 而是挂在纸底部的托盘上，正文里一个字不提；存为笔记时才转成链接。
   */
  addShot: (
    id: string,
    data: Uint8Array,
    ext: string,
  ): Promise<{ ok: boolean; name?: string; shots?: string[]; error?: string }> =>
    ipcRenderer.invoke('sticky:addShot', id, data, ext),

  removeShot: (id: string, name: string): Promise<string[]> =>
    ipcRenderer.invoke('sticky:removeShot', id, name),

  /** 文件名 → nota-media:// 地址，直接给 <img src> 用 */
  shotUrl: (name: string): Promise<string> => ipcRenderer.invoke('sticky:shotUrl', name),

  /** 新窗口建好后主进程叫一声，把光标送进正文 */
  onFocus: (cb: () => void): void => {
    ipcRenderer.removeAllListeners('sticky:focus')
    ipcRenderer.on('sticky:focus', () => cb())
  },

  /**
   * 开场要的那一份数据。
   *
   * 以前是窗口自己从地址栏的 `?id=` 里读，再拿去 invoke('load')。改成由主进程
   * 直接给，是为了让「预热池」那条路走得通：池里的窗口是没有 id 的（谁知道
   * 用户下次要点哪张纸），被认领时改地址栏就得重新加载整个页面，那 200 多
   * 毫秒又还回去了。改成一次性把数据推过来，窗口不用重载。
   */
  init: (): Promise<{
    id: string
    text: string
    pinned: boolean
    color: string
    savedTo?: string
    tags?: string[]
    shots?: string[]
  } | null> => ipcRenderer.invoke('sticky:init'),

  /** 正在跑着的池窗口被认领：整份新数据推过来，界面照它全量覆盖 */
  onBind: (cb: (d: unknown) => void): void => {
    ipcRenderer.removeAllListeners('sticky:bind')
    ipcRenderer.on('sticky:bind', (_e, d: unknown) => cb(d))
  },

  /** 从列表里右键换了纸色：这边跟着换，不然纸上还是旧的 */
  onColor: (cb: (color: string) => void): void => {
    ipcRenderer.removeAllListeners('sticky:color')
    ipcRenderer.on('sticky:color', (_e, color: string) => cb(color))
  },
})
