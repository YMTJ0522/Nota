/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface NoteApi {
  pickWorkspace(): Promise<string | null>
  ensureVault(): Promise<{
    root: string | null
    file: string | null
    created: boolean
    error?: string
  }>
  readTree(root: string): Promise<TreeNode[]>
  readNote(file: string): Promise<string>
  writeNote(file: string, content: string): Promise<boolean>
  createNote(dir: string, name: string): Promise<string>
  createFolder(parent: string, name: string): Promise<string>
  deleteNote(file: string): Promise<boolean>
  renameNote(file: string, newName: string): Promise<string>
  moveNote(file: string, dir: string): Promise<string>
  revealNote(file: string): Promise<boolean>
  importNotes(root: string, dir: string): Promise<{ name: string; path: string }[]>
  pickImage(
    workspace: string,
    kind?: 'image' | 'video' | 'any',
  ): Promise<{ rel: string; alt: string; copied: boolean; isVideo: boolean } | null>
  resolveMedia(base: string, rel: string): Promise<string | null>
  exportSave(opts: { defaultName: string; kind: string; data: string }): Promise<string | null>
  exportPdf(opts: { defaultName: string; html: string }): Promise<string | null>
  historySave(workspace: string, file: string, content: string): Promise<string | null>
  historyList(
    workspace: string,
    file: string,
  ): Promise<{ name: string; path: string; size: number; mtime: number }[]>
  historyRead(snapshot: string): Promise<string | null>
  trashList(
    root: string,
  ): Promise<
    { key: string; rel: string; name: string; deletedAt: number; size: number; isDir?: boolean }[]
  >
  trashRestore(root: string, key: string): Promise<string>
  trashPurge(root: string, key: string): Promise<boolean>
  trashEmpty(root: string): Promise<boolean>
  attachList(
    root: string,
  ): Promise<{ rel: string; name: string; size: number; mtime: number; isVideo: boolean }[]>
  attachDelete(root: string, rel: string): Promise<boolean>
  /** 批量导入任意文件（图片/视频/压缩包/文档…）到 attachments/ */
  attachImport(
    root: string,
  ): Promise<{ rel: string; name: string; size: number; mtime: number; isVideo: boolean }[]>
  aiChat(
    cfg: { baseUrl: string; model: string; apiKey: string; system: string; temperature: number },
    messages: { role: string; content: string }[],
  ): Promise<{ ok: boolean; text?: string; reasoning?: string; error?: string }>
  /** 流式增量：回答和推理过程都是边生成边到 */
  onAiDelta(cb: (d: { text?: string; reasoning?: string; done?: boolean }) => void): void
  aiTest(cfg: {
    baseUrl: string
    model: string
    apiKey: string
    system: string
    temperature: number
  }): Promise<{ ok: boolean; models?: string[]; error?: string }>
  /** 节点图标：相对路径 → 图标 id */
  iconsRead(root: string): Promise<Record<string, string>>
  iconsWrite(root: string, map: Record<string, string>): Promise<boolean>
  /** 标签的归属图标：标签名 → 图标 id */
  tagIconsRead(root: string): Promise<Record<string, string>>
  tagIconsWrite(root: string, map: Record<string, string>): Promise<boolean>
  /** 把粘贴 / 拖进来的图片存进工作区 attachments/，返回相对路径 */
  mediaSave(
    root: string,
    item: { srcPath?: string; bytes?: string; ext?: string },
  ): Promise<{ rel: string; name: string; isVideo: boolean } | null>
  /** 联网检索：返回若干条「标题 / 链接 / 摘要」，给 agent 当参考资料 */
  aiWebSearch(
    query: string,
    limit?: number,
  ): Promise<{
    ok: boolean
    hits?: { title: string; url: string; snippet: string }[]
    engine?: string
    error?: string
  }>
  /** 云同步（WebDAV）：测试连接 / 执行同步 */
  syncTest(cfg: {
    url: string
    username: string
    password: string
    dir: string
  }): Promise<{ ok: boolean; error?: string }>
  syncRun(
    root: string,
    cfg: { url: string; username: string; password: string; dir: string },
  ): Promise<{
    ok: boolean
    uploaded: number
    downloaded: number
    conflicts: number
    skipped: number
    error?: string
  }>
  onSyncProgress(cb: (text: string) => void): void
  appInfo(): Promise<{
    electron: string
    chrome: string
    node: string
    platform: string
    arch: string
  }>
  checkUpdate(current: string): Promise<{
    current: string
    latest: string
    newer: boolean
    size: number
    url: string
    error?: string
    detail?: string
  }>
  /* 便签：主窗口这边只管列表与开关，正文读写全在便签窗口自己的 preload 里 */
  stickyList(): Promise<StickyItem[]>
  stickyNew(): Promise<{ id: string } | { error: string }>
  stickyOpen(id: string): Promise<boolean>
  stickyCloseAll(): Promise<number>
  stickyCount(): Promise<number>
  stickyDelete(id: string): Promise<boolean>
  stickyMarkSaved(id: string, rel: string): Promise<boolean>
  stickyRename(id: string, title: string): Promise<{ ok: boolean; error?: string }>
  stickyPatch(id: string, patch: StickyPatch): Promise<boolean>
  /** 一批一起改，只写一次盘（多选之后的收起 / 加标签） */
  stickyBatchPatch(ids: string[], patch: StickyPatch): Promise<number>
  /** 关掉一张便签窗口（收起）。没开着的话什么也不做 */
  stickyCloseOne(id: string): Promise<boolean>
  stickyDeleteMany(ids: string[]): Promise<number>
  stickyText(id: string): Promise<string>
  stickyReveal(id: string): Promise<boolean>
  stickySaveToVault(
    id: string,
    archive?: boolean,
  ): Promise<{ ok: boolean; rel?: string; error?: string; archived?: boolean }>
  onStickyCount(cb: (n: number) => void): void
  onStickyError(cb: (msg: string) => void): void

  /* 桌面整合：开机自启、全局快捷键 */
  desktopPrefs(): Promise<DesktopPrefsInfo>
  setHotkey(on: boolean): Promise<{ ok: boolean; error: string }>
  setAutoStart(on: boolean): Promise<boolean>
  setActiveRoot(root: string | null): Promise<boolean>
  revealStickies(): Promise<string>

  minimize(): Promise<void>
  toggleMaximize(): Promise<boolean>
  closeWindow(): Promise<void>
  onMaximizeChange(cb: (maximized: boolean) => void): void
}

interface TreeNode {
  type: 'dir' | 'file'
  name: string
  path: string
  children?: TreeNode[]
  /** 仅文件：从 frontmatter 里摘出来的标签 */
  tags?: string[]
  /** 仅文件：最后修改时间（毫秒） */
  mtime?: number
  /** 仅文件：frontmatter 里 star: true */
  starred?: boolean
  /** 仅文件：正文开头的一段纯文本摘要 */
  excerpt?: string
}

/**
 * 便签窗口的桥（electron/preload-sticky.ts）。只有这一小把能力，
 * 和主界面的 window.api 是两个完全独立的暴露面 —— 便签窗口拿不到笔记、
 * 工作区、AI、云同步的任何方法。
 */
interface StickyApi {
  load(
    id: string,
  ): Promise<
    { text: string; pinned: boolean; color: string; savedTo?: string; tags?: string[] } | null
  >
  write(id: string, text: string): Promise<void>
  close(id: string): Promise<void>
  pin(id: string, pinned: boolean): Promise<boolean>
  color(id: string, color: string): Promise<boolean>
  /** 正文里打出来的 `#标签` 自动落到这张纸的记录上，只加不减，返回合并后的全量 */
  addTags(id: string, names: string[]): Promise<string[]>
  saveToVault(id: string): Promise<{ ok: boolean; rel?: string; error?: string }>
  remove(id: string): Promise<boolean>
  onFocus(cb: () => void): void
}

declare global {
  /** 由 vite.config.ts 的 define 注入，值取自 package.json */
  const __APP_VERSION__: string

  interface Window {
    api: NoteApi
    /** 只有便签窗口里才有 */
    sticky: StickyApi
  }

  /**
   * 一条便签。主进程从 %LOCALAPPDATA%\Nota\stickies\ 里扫出来的摘要，
   * 不含全文 —— 列表不需要，几百张便签全读进内存也没意义。
   */
  interface StickyItem {
    id: string
    /** 首行，列表里当标题 */
    title: string
    preview: string
    chars: number
    createdAt: number
    updatedAt: number
    /** 有值＝已经关掉归档了，还在列表里等着捞 */
    closedAt?: number
    /** 存为笔记后的相对路径 */
    savedTo?: string
    /** 自己打的标签，不进笔记库的标签表，存为笔记时才写进 frontmatter */
    tags?: string[]
    /** 标记图标：技术栈一眼认出来 */
    icon?: { kind: 'brand' | 'emoji'; id: string }
    /** 纸色 key（默认 amber）。列表里画那枚小圆点用 */
    color?: string
  }

  /** 便签的可改字段。值给 null 表示「去掉这个字段」 */
  interface StickyPatch {
    tags?: string[]
    icon?: { kind: 'brand' | 'emoji'; id: string } | null
    /** 数字＝收起来，null＝撤回收起（存为笔记之后后悔了） */
    closedAt?: number | null
  }

  /** 桌面级偏好。存在 %LOCALAPPDATA%\Nota\prefs.json，由主进程管 */
  interface DesktopPrefsInfo {
    hotkey: boolean
    openAtLogin: boolean
    /** 免安装版和开发环境下都是 false */
    canAutoStart: boolean
    portable: boolean
    packaged: boolean
    hotkeyNew: string
    hotkeyCloseAll: string
    /** 非空＝这两个组合被别的程序占了 */
    hotkeyError: string
  }
}

export {}
