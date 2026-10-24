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

declare global {
  /** 由 vite.config.ts 的 define 注入，值取自 package.json */
  const __APP_VERSION__: string

  interface Window {
    api: NoteApi
  }
}

export {}
