/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface NoteApi {
  pickWorkspace(): Promise<string | null>
  readTree(root: string): Promise<TreeNode[]>
  readNote(file: string): Promise<string>
  writeNote(file: string, content: string): Promise<boolean>
  createNote(dir: string, name: string): Promise<string>
  createFolder(parent: string, name: string): Promise<string>
  deleteNote(file: string): Promise<boolean>
  renameNote(file: string, newName: string): Promise<string>
  importNotes(root: string, dir: string): Promise<{ name: string; path: string }[]>
  pickImage(
    workspace: string,
    kind?: 'image' | 'video' | 'any',
  ): Promise<{ rel: string; alt: string; copied: boolean; isVideo: boolean } | null>
  resolveMedia(base: string, rel: string): Promise<string | null>
  exportSave(opts: { defaultName: string; kind: string; data: string }): Promise<string | null>
  historySave(workspace: string, file: string, content: string): Promise<string | null>
  historyList(
    workspace: string,
    file: string,
  ): Promise<{ name: string; path: string; size: number; mtime: number }[]>
  historyRead(snapshot: string): Promise<string | null>
  trashList(
    root: string,
  ): Promise<{ key: string; rel: string; name: string; deletedAt: number; size: number }[]>
  trashRestore(root: string, key: string): Promise<string>
  trashPurge(root: string, key: string): Promise<boolean>
  trashEmpty(root: string): Promise<boolean>
  attachList(
    root: string,
  ): Promise<{ rel: string; name: string; size: number; mtime: number; isVideo: boolean }[]>
  attachDelete(root: string, rel: string): Promise<boolean>
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
  appInfo(): Promise<{
    electron: string
    chrome: string
    node: string
    platform: string
    arch: string
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
