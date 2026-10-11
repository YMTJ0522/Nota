import { reactive, computed } from 'vue'

/* ─────────────────────────────────────────────
   数据模型：字段名自己定，与任何外部项目无关
   ───────────────────────────────────────────── */

export interface TreeNode {
  type: 'dir' | 'file'
  name: string
  path: string
  children?: TreeNode[]
  /** 仅文件：从 frontmatter 里摘出来的标签 */
  tags?: string[]
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
  /** 保存状态：给顶栏做「保存中…／已保存」的反馈 */
  saving: boolean
  /** 最近一次成功保存的时间戳 */
  lastSavedAt: number | null
  /** 自动保存开关 */
  autoSave: boolean
  /** 侧栏是否可见 */
  sidebar: boolean
  /** 当前选中的标签（null = 不筛选，显示全部笔记） */
  activeTag: string | null
  /** 新建文件夹的父目录；非 null 时侧栏弹出一个输入框 */
  newFolderIn: string | null
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
  saving: false,
  lastSavedAt: null,
  autoSave: true,
  sidebar: true,
  activeTag: null,
  newFolderIn: null,
})

/* ── 派生 ── */
const dirty = computed(() => state.draft !== state.savedDraft)

const activeName = computed(() => {
  if (!state.activePath) return ''
  const parts = state.activePath.split(/[\\/]/)
  return parts[parts.length - 1].replace(/\.md$/i, '')
})

/**
 * 全工作区的标签清单：把树里每个文件节点上的 tags 收拢、去重。
 * 标签来源是 frontmatter（主进程读树时已经摘好），不额外读盘。
 */
const allTags = computed(() => {
  const set = new Map<string, number>()
  const visit = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.type === 'dir') {
        if (n.children) visit(n.children)
      } else if (n.tags) {
        for (const t of n.tags) set.set(t, (set.get(t) ?? 0) + 1)
      }
    }
  }
  visit(state.tree)
  return [...set.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
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
async function saveNote(opts: { silent?: boolean } = {}) {
  if (!state.activePath || !dirty.value) return
  const path = state.activePath
  const content = state.draft
  state.saving = true
  try {
    await window.api.writeNote(path, content)
    state.savedDraft = content
    state.lastSavedAt = Date.now()
    // 非静默保存（Ctrl+S、切笔记、关窗）时留一份版本快照。
    // 自动保存太频繁，不每次都记，否则历史会被几秒钟的中间态淹没。
    if (!opts.silent && state.root) {
      await window.api.historySave?.(state.root, path, content)
    }
  } finally {
    state.saving = false
  }
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

/** 打开「新建文件夹」输入框；parent 为空时建在工作区根目录 */
function startNewFolder(parent?: string) {
  state.newFolderIn = parent ?? state.root ?? ''
}

/** 提交新建文件夹 */
async function commitNewFolder(name: string) {
  const parent = state.newFolderIn
  state.newFolderIn = null
  if (!parent || !name.trim()) return
  await window.api.createFolder(parent, name.trim())
  state.expanded[parent] = true
  await refreshTree()
}

function cancelNewFolder() {
  state.newFolderIn = null
}

/** 点标签筛选；再点一次同一个标签就取消筛选 */
function setActiveTag(tag: string | null) {
  state.activeTag = state.activeTag === tag ? null : tag
}

/* ── 导出 ──
   三种格式的产物都从 draft（当前编辑内容）派生，不是从磁盘读——
   这样「刚写完还没保存就导出」也能拿到最新内容。 */
async function exportNote(kind: 'md' | 'html') {
  if (!state.activePath) return null
  const name = activeName.value || '未命名笔记'
  const data =
    kind === 'md' ? state.draft : buildStandaloneHtml(name, state.draft)
  return window.api.exportSave({
    defaultName: `${name}.${kind}`,
    kind,
    data,
  })
}

/**
 * 把 Markdown 包成一份自带样式的独立 HTML。
 *
 * 已解析好的预览 HTML（含代码高亮 class）由调用方传入会更准，
 * 但这里刻意只依赖 draft：导出是脱离应用的动作，不该要求预览先渲染过。
 * 所以用一个极简的转换——足够让 md 在浏览器里可读，不追求和预览 1:1。
 */
function buildStandaloneHtml(title: string, md: string) {
  const body = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/</g, '&lt;')}</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 720px; margin: 48px auto; padding: 0 20px;
    font: 15px/1.75 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    color: #24231f; background: #fff; }
  pre { background: #f5f4f1; padding: 12px 16px; border-radius: 8px; overflow-x: auto; }
  code { font-family: ui-monospace, Consolas, monospace; }
  blockquote { border-left: 3px solid #3f7d5f; margin: 1em 0; padding: .4em 0 .4em 14px;
    background: #eef4f0; color: #55534e; }
  img { max-width: 100%; border-radius: 8px; }
  @media (prefers-color-scheme: dark) {
    body { color: #e8e5df; background: #1a1a18; }
    pre { background: #24241f; }
    blockquote { background: #20241f; color: #b3b0a8; }
  }
</style>
</head>
<body>
<pre style="white-space:pre-wrap;background:none;padding:0">${body}</pre>
</body>
</html>`
}

/** 侧栏显隐 */
function toggleSidebar() {
  state.sidebar = !state.sidebar
  localStorage.setItem('nota-sidebar', state.sidebar ? '1' : '0')
}

/** 自动保存开关 */
function setAutoSave(v: boolean) {
  state.autoSave = v
  localStorage.setItem('nota-autosave', v ? '1' : '0')
}

function initPrefs() {
  state.autoSave = localStorage.getItem('nota-autosave') !== '0'
  state.sidebar = localStorage.getItem('nota-sidebar') !== '0'
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
  allTags,
  openWorkspace,
  refreshTree,
  openNote,
  saveNote,
  newNote,
  removeNote,
  renameNote,
  toggleDir,
  startNewFolder,
  commitNewFolder,
  cancelNewFolder,
  setActiveTag,
  setTheme,
  initTheme,
  autoExpand,
  exportNote,
  toggleSidebar,
  setAutoSave,
  initPrefs,
}
