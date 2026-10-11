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
  /** 仅文件：最后修改时间（毫秒），侧栏「最近编辑」用 */
  mtime?: number
  /** 仅文件：frontmatter 里 star: true，进侧栏「收藏」 */
  starred?: boolean
}

/** 编辑区三种视图模式：纯编辑 / 左右分栏 / 纯预览 */
export type ViewMode = 'write' | 'split' | 'read'
/** 侧栏导航筛选 */
export type NavFilter = 'all' | 'recent' | 'starred' | 'unfiled'

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
  /** 编辑区视图模式 */
  viewMode: ViewMode
  /** 侧栏导航当前项 */
  navFilter: NavFilter
  /** 侧栏搜索关键词 */
  searchQuery: string
  /** 右侧大纲是否展开 */
  outline: boolean
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
  viewMode: 'write',
  navFilter: 'all',
  searchQuery: '',
  outline: true,
})

/** 「最近编辑」的时间窗：7 天内有改动的算最近 */
const RECENT_WINDOW = 7 * 24 * 60 * 60 * 1000

/* ── 派生 ── */
const dirty = computed(() => state.draft !== state.savedDraft)

const activeName = computed(() => {
  if (!state.activePath) return ''
  const parts = state.activePath.split(/[\\/]/)
  return parts[parts.length - 1].replace(/\.md$/i, '')
})

/** 把树里所有文件拍平成一维 */
function flattenFiles(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    if (n.type === 'dir') {
      if (n.children) flattenFiles(n.children, out)
    } else {
      out.push(n)
    }
  }
  return out
}

const allFiles = computed(() => flattenFiles(state.tree))

/** 导航项的计数徽标 */
const navCounts = computed(() => {
  const now = Date.now()
  return {
    all: allFiles.value.length,
    recent: allFiles.value.filter((f) => now - (f.mtime ?? 0) < RECENT_WINDOW).length,
    starred: allFiles.value.filter((f) => f.starred).length,
    unfiled: allFiles.value.filter((f) => !f.tags || f.tags.length === 0).length,
  }
})

/** 按名称过滤树；目录只要底下还有命中的文件就保留 */
function filterTreeByName(nodes: TreeNode[], q: string): TreeNode[] {
  const walk = (list: TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = []
    for (const n of list) {
      if (n.type === 'dir') {
        const kids = n.children ? walk(n.children) : []
        if (kids.length) out.push({ ...n, children: kids })
        else if (n.name.toLowerCase().includes(q)) out.push({ ...n, children: n.children })
      } else if (n.name.toLowerCase().includes(q)) {
        out.push(n)
      }
    }
    return out
  }
  return walk(nodes)
}

/**
 * 侧栏真正要渲染的列表。
 * 「所有笔记」保持树状；其余导航项拍平成文件列表——
 * 最近/收藏/未归类本来就是跨目录的横切视图，硬套树反而更难读。
 */
const visibleTree = computed<TreeNode[]>(() => {
  const q = state.searchQuery.trim().toLowerCase()
  if (state.navFilter === 'all') {
    return q ? filterTreeByName(state.tree, q) : state.tree
  }
  let files = allFiles.value
  if (state.navFilter === 'starred') files = files.filter((f) => f.starred)
  else if (state.navFilter === 'unfiled') files = files.filter((f) => !f.tags || f.tags.length === 0)
  else if (state.navFilter === 'recent') {
    files = [...files].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0)).slice(0, 30)
  }
  if (q) files = files.filter((f) => f.name.toLowerCase().includes(q))
  return files
})

/** 侧栏标签筛选标签本身（标签计数仍按全量统计） */
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

/** 编辑区视图模式 */
function setViewMode(m: ViewMode) {
  state.viewMode = m
  localStorage.setItem('nota-view', m)
}

/** 侧栏导航项：切到「所有笔记」以外的视图时清掉标签筛选，两个筛选不该叠加 */
function setNavFilter(f: NavFilter) {
  state.navFilter = f
  if (f !== 'all') state.activeTag = null
}

function setSearchQuery(q: string) {
  state.searchQuery = q
}

function toggleOutline() {
  state.outline = !state.outline
  localStorage.setItem('nota-outline', state.outline ? '1' : '0')
}

/** 自动保存开关 */
function setAutoSave(v: boolean) {
  state.autoSave = v
  localStorage.setItem('nota-autosave', v ? '1' : '0')
}

function initPrefs() {
  state.autoSave = localStorage.getItem('nota-autosave') !== '0'
  state.sidebar = localStorage.getItem('nota-sidebar') !== '0'
  state.outline = localStorage.getItem('nota-outline') !== '0'
  const v = localStorage.getItem('nota-view')
  if (v === 'write' || v === 'split' || v === 'read') state.viewMode = v
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
  allFiles,
  navCounts,
  visibleTree,
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
  setViewMode,
  setNavFilter,
  setSearchQuery,
  toggleOutline,
  setAutoSave,
  initPrefs,
}
