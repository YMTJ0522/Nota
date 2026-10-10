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
  deleteNote(file: string): Promise<boolean>
  renameNote(file: string, newName: string): Promise<string>
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
}

declare global {
  interface Window {
    api: NoteApi
  }
}

export {}
