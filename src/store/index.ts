import { reactive, computed } from 'vue'

/* ─────────────────────────────────────────────
   数据模型：字段名自己定，与任何外部项目无关
   ───────────────────────────────────────────── */

export interface TreeNode {
  type: 'dir' | 'file'
  name: string
  path: string
  children?: TreeNode[]
}

interface State {
  root: string | null
  tree: TreeNode[]
  activePath: string | null
  draft: string
  savedDraft: string
  loading: boolean
  theme: 'light' | 'dark'
  expanded: Record<string, boolean>
  renaming: string | null
}

const state = reactive<State>({
  root: null,
  tree: [],
  activePath: null,
  draft: '',
  savedDraft: '',
  loading: false,
  theme: 'light',
  expanded: {},
  renaming: null,
})

/* ── 派生 ── */
const dirty = computed(() => state.draft !== state.savedDraft)

const activeName = computed(() => {
  if (!state.activePath) return ''
  const parts = state.activePath.split(/[\\/]/)
  return parts[parts.length - 1].replace(/\.md$/i, '')
})

/* ── 动作 ── */

async function openWorkspace() {
  const dir = await window.api.pickWorkspace()
  if (!dir) return
  state.root = dir
  state.loading = true
  state.tree = await window.api.readTree(dir)
  state.loading = false
}

async function refreshTree() {
  if (!state.root) return
  state.tree = await window.api.readTree(state.root)
}

async function openNote(path: string) {
  if (dirty.value) await saveNote()
  state.activePath = path
  const raw = await window.api.readNote(path)
  state.draft = raw
  state.savedDraft = raw
}

async function saveNote() {
  if (!state.activePath || !dirty.value) return
  await window.api.writeNote(state.activePath, state.draft)
  state.savedDraft = state.draft
}

async function newNote(dir?: string) {
  const target = dir ?? (state.tree.find((n) => n.type === 'dir')?.path ?? state.root)
  if (!target) return
  const path = await window.api.createNote(target, '未命名笔记')
  await refreshTree()
  await openNote(path)
  state.renaming = path
}

async function removeNote(path: string) {
  await window.api.deleteNote(path)
  if (state.activePath === path) {
    state.activePath = null
    state.draft = ''
    state.savedDraft = ''
  }
  await refreshTree()
}

async function renameNote(path: string, newName: string) {
  const next = await window.api.renameNote(path, newName)
  if (state.activePath === path) state.activePath = next
  state.renaming = null
  await refreshTree()
}

function toggleDir(path: string) {
  state.expanded[path] = !state.expanded[path]
}

function setTheme(t: 'light' | 'dark') {
  state.theme = t
  document.documentElement.setAttribute('data-theme', t)
  localStorage.setItem('nota-theme', t)
}

function initTheme() {
  const saved = localStorage.getItem('nota-theme') as 'light' | 'dark' | null
  const t = saved ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  setTheme(t)
}

/** 首次展开所有顶层目录 */
function autoExpand() {
  for (const n of state.tree) {
    if (n.type === 'dir' && n.children?.length && !(n.path in state.expanded)) {
      state.expanded[n.path] = true
    }
  }
}

export const store = {
  state,
  dirty,
  activeName,
  openWorkspace,
  refreshTree,
  openNote,
  saveNote,
  newNote,
  removeNote,
  renameNote,
  toggleDir,
  setTheme,
  initTheme,
  autoExpand,
}
