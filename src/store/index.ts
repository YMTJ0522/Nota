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
  /** 仅文件：正文开头的一段纯文本，笔记列表栏拿它当摘要 */
  excerpt?: string
}

/** 编辑区三种视图模式：纯编辑 / 左右分栏 / 纯预览 */
export type ViewMode = 'write' | 'split' | 'read'
/** 侧栏导航筛选 */
export type NavFilter = 'all' | 'recent' | 'starred' | 'unfiled'
/** 主区当前内容：正在写的笔记，还是 AI 编写对话页 */
export type MainView = 'note' | 'ai'
/** 强调色板。id 直接写进 <html data-accent>，与 tokens.css 里的选择器一一对应 */
export type AccentName =
  | 'celadon' | 'cinnabar' | 'indigo' | 'amber' | 'lagoon' | 'wisteria' | 'graphite'

/* ── 外观偏好 ──
   全部落到 <html> 的 data 属性或 CSS 变量上，改一次全局生效，
   组件里不需要再关心这些值。 */
/** 纸张：暖白底；纯色：中性白/黑，去掉纸感 */
export type BgStyle = 'paper' | 'plain'
/** 界面密度：影响侧栏与列表这类行高 */
export type Density = 'comfortable' | 'compact'
/** 正文栏宽档位 */
export type MeasureName = 'narrow' | 'standard' | 'wide' | 'full'

/**
 * 设置面板的分区。
 *
 * 放在 store 里是为了只有一个来源：侧栏收到 `nota:settings` 事件时要判断
 * 「这个 id 认不认」，设置面板自己也要按 id 找当前页——两处各写一份白名单，
 * 加了新分区就一定会漏一处（外观页当初就是这么跳不过去的）。
 */
export const SETTINGS_SECTIONS = ['general', 'appearance', 'editor', 'ai', 'about'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export function isSettingsSection(id: unknown): id is SettingsSection {
  return typeof id === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(id)
}

export const BG_STYLES: { id: BgStyle; label: string }[] = [
  { id: 'paper', label: '纸张' },
  { id: 'plain', label: '纯色' },
]

export const DENSITY: { id: Density; label: string }[] = [
  { id: 'comfortable', label: '舒适' },
  { id: 'compact', label: '紧凑' },
]

export const MEASURES: { id: MeasureName; label: string; px: number }[] = [
  { id: 'narrow', label: '窄', px: 600 },
  { id: 'standard', label: '标准', px: 720 },
  { id: 'wide', label: '宽', px: 880 },
  { id: 'full', label: '满', px: 100000 },
]

export const FONT_SIZE_RANGE = { min: 13, max: 19, step: 1 }
export const LINE_HEIGHT_RANGE = { min: 1.5, max: 2.2, step: 0.05 }

/** 外观偏好的出厂值，「恢复默认」用的就是它 */
export const PREF_DEFAULTS = {
  bg: 'paper' as BgStyle,
  density: 'comfortable' as Density,
  fontSize: 15,
  lineHeight: 1.75,
  measure: 'standard' as MeasureName,
  lineWrap: true,
  lineNumbers: true,
}

/* ── AI 配置 ──
   走 OpenAI 兼容的 /chat/completions：Ollama、LM Studio、vLLM、各类网关
   都是这个接口，所以一套设置就能覆盖「本地跑模型」和「接云端」。 */
export interface AiConfig {
  /** 关掉之后侧栏不再出现「AI 编写」入口 */
  enabled: boolean
  /** 形如 http://localhost:11434/v1，末尾不要带 /chat/completions */
  baseUrl: string
  model: string
  /** 本地模型一般不需要，留空就不发 Authorization 头 */
  apiKey: string
  /** 每次请求都会带上的全局指令，用来约束语气和语言 */
  system: string
  temperature: number
}

export const AI_DEFAULTS: AiConfig = {
  enabled: true,
  baseUrl: 'http://localhost:11434/v1',
  model: 'llama3.2',
  apiKey: '',
  system: '你是写作助手。回答要简洁，直接给出结果，不要复述问题。',
  temperature: 0.7,
}

/** 常见本地/云端服务的预设，省得手打地址 */
export const AI_PRESETS: { label: string; baseUrl: string; model: string }[] = [
  { label: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
  { label: 'LM Studio（本地）', baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
]

/** 设置里的色板列表：swatch 只用于画圆点，不参与真正的取色 */
export const ACCENTS: { id: AccentName; label: string }[] = [
  { id: 'celadon', label: '青瓷' },
  { id: 'cinnabar', label: '朱砂' },
  { id: 'indigo', label: '靛蓝' },
  { id: 'amber', label: '琥珀' },
  { id: 'lagoon', label: '湖蓝' },
  { id: 'wisteria', label: '紫藤' },
  { id: 'graphite', label: '石墨' },
]

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
  /** 资料库与正文之间的笔记列表栏是否可见 */
  list: boolean
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
  /** 强调色（对应 tokens.css 里的 data-accent 色板） */
  accent: AccentName
  /** AI 接入配置：地址、模型、密钥、系统提示词 */
  ai: AiConfig

  /* ── 外观偏好（见 PREF_DEFAULTS） ── */
  /** 底色风格：纸张 / 纯色 */
  bg: BgStyle
  /** 界面密度 */
  density: Density
  /** 正文字号 px */
  fontSize: number
  /** 正文行高 */
  lineHeight: number
  /** 正文栏宽档位 */
  measure: MeasureName
  /** 编辑区自动换行 */
  lineWrap: boolean
  /** 编辑区显示行号 */
  lineNumbers: boolean

  /** 主区显示什么：笔记 / AI 编写 */
  mainView: MainView
  /** 全部对话会话。每个会话自带一堆消息 */
  sessions: ChatSession[]
  /** 当前正在看的会话 id */
  activeSessionId: number
  /** 当前会话的消息列表。始终与 sessions 里那一条**共用同一个数组**，
      所以 push / splice 都直接生效，不要整体赋值（会把引用换掉） */
  chat: ChatMessage[]
  /** 对话是否在进行中 */
  aiBusy: boolean
}

/** AI 对话消息。role 只有 user / assistant 两种——system 单独放在配置里 */
export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  /** 出错时的提示文案，与 content 分开存，样式不同 */
  error?: string
}

/** 一次对话。会话之间互不干扰，切来切去不会串台 */
export interface ChatSession {
  id: number
  /** 由第一条提问自动生成，也可以手动改 */
  title: string
  messages: ChatMessage[]
  /** 最后一次发言的时间，用来倒序排列 */
  updatedAt: number
}

/** 色板的预览色。给设置页画圆点用——真正生效的颜色仍在 CSS 里，
    这里只是把两套主题的主色各写一份，免得选择器读不到。 */
export const ACCENT_SWATCH: Record<AccentName, { light: string; dark: string }> = {
  celadon: { light: 'oklch(49% 0.13 150)', dark: 'oklch(74% 0.12 150)' },
  cinnabar: { light: 'oklch(54% 0.15 30)', dark: 'oklch(66.5% 0.15 32)' },
  indigo: { light: 'oklch(52% 0.14 252)', dark: 'oklch(72% 0.13 252)' },
  amber: { light: 'oklch(56% 0.105 95)', dark: 'oklch(80% 0.14 95)' },
  lagoon: { light: 'oklch(49% 0.075 205)', dark: 'oklch(76% 0.105 205)' },
  wisteria: { light: 'oklch(52% 0.14 300)', dark: 'oklch(72% 0.13 300)' },
  // 石墨是「去色」选项：低饱和的中性灰，浅色下压深、深色下提亮
  graphite: { light: 'oklch(48% 0.006 260)', dark: 'oklch(76% 0.006 260)' },
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
  list: true,
  activeTag: null,
  newFolderIn: null,
  viewMode: 'write',
  navFilter: 'all',
  searchQuery: '',
  outline: true,
  accent: 'celadon',
  ai: { ...AI_DEFAULTS },
  bg: PREF_DEFAULTS.bg,
  density: PREF_DEFAULTS.density,
  fontSize: PREF_DEFAULTS.fontSize,
  lineHeight: PREF_DEFAULTS.lineHeight,
  measure: PREF_DEFAULTS.measure,
  lineWrap: PREF_DEFAULTS.lineWrap,
  lineNumbers: PREF_DEFAULTS.lineNumbers,
  mainView: 'note',
  sessions: [],
  activeSessionId: 0,
  chat: [],
  aiBusy: false,
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
 * 侧栏与列表栏真正要渲染的笔记。
 *
 * 「所有笔记」保持树状（要看得到目录层级）；其余都是跨目录的横切视图
 * ——最近编辑、收藏、未归类、某个标签、搜索结果——拍平成文件列表更好读，
 * 硬套树反而要把每一层都展开才找得到。
 */
const visibleTree = computed<TreeNode[]>(() => {
  const q = state.searchQuery.trim().toLowerCase()
  const tag = state.activeTag
  if (state.navFilter !== 'all' || tag) {
    let files = allFiles.value
    if (tag) files = files.filter((f) => f.tags?.includes(tag))
    if (state.navFilter === 'starred') files = files.filter((f) => f.starred)
    else if (state.navFilter === 'unfiled') files = files.filter((f) => !f.tags || f.tags.length === 0)
    else if (state.navFilter === 'recent') {
      files = [...files].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0)).slice(0, 30)
    }
    if (q) files = files.filter((f) => f.name.toLowerCase().includes(q))
    return files
  }
  return q ? filterTreeByName(state.tree, q) : state.tree
})

/** 列表栏要的那一列：把当前视图拍平 */
const visibleFiles = computed(() => flattenFiles(visibleTree.value))

/** 当前视图的名字，侧栏分区标题与列表栏头共用一份，避免两处各写一套 */
const navTitle = computed(() => {
  if (state.activeTag) return `# ${state.activeTag}`
  switch (state.navFilter) {
    case 'recent':
      return '最近编辑'
    case 'starred':
      return '收藏'
    case 'unfiled':
      return '未归类'
    default:
      return '所有笔记'
  }
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
 * 把工作区外面的 Markdown 收进来。
 *
 * 目标目录取「当前笔记所在的目录」——多数人是正在哪写就往哪收；
 * 没有打开的笔记时落到工作区根目录。真正的读文件、去重命名在主进程里做
 * （见 electron/main.ts 的 note:import），这里只负责挑目标和刷新目录树。
 *
 * @returns 真正导入进来的文件（用户取消时是空数组）
 */
async function importNotes(): Promise<{ name: string; path: string }[]> {
  if (!state.root) return []
  const dir = state.activePath
    ? state.activePath.replace(/[\\/][^\\/]*$/, '')
    : state.root
  const added = (await window.api.importNotes?.(state.root, dir)) ?? []
  if (added.length) {
    await refreshTree()
    // 刚收进来的那篇顺手打开，省得再找一次
    const last = added[added.length - 1]
    if (last?.path) await openNote(last.path)
  }
  return added
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

/** 笔记列表栏显隐 */
function toggleList() {
  state.list = !state.list
  localStorage.setItem('nota-list', state.list ? '1' : '0')
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
  state.list = localStorage.getItem('nota-list') !== '0'
  state.outline = localStorage.getItem('nota-outline') !== '0'
  const v = localStorage.getItem('nota-view')
  if (v === 'write' || v === 'split' || v === 'read') state.viewMode = v
  initAccent()
  initAi()
  initPrefs2()
  initSessions()
}

/**
 * 强调色。只切 <html data-accent>，颜色本身全在 tokens.css 里，
 * 配套色（soft / selection / 活动行）由 color-mix 从主色派生。
 */
function setAccent(a: AccentName) {
  state.accent = a
  document.documentElement.setAttribute('data-accent', a)
  localStorage.setItem('nota-accent', a)
}

function initAccent() {
  const saved = localStorage.getItem('nota-accent')
  setAccent(ACCENTS.some((a) => a.id === saved) ? (saved as AccentName) : 'celadon')
}

function setTheme(t: 'light' | 'dark') {
  state.theme = t
  document.documentElement.setAttribute('data-theme', t)
  localStorage.setItem('nota-theme', t)
}

/** 改一项 AI 配置并落盘。密钥也存 localStorage——这是本机应用，
    跟系统钥匙串集成的收益远小于它带来的复杂度。 */
function setAiConfig(patch: Partial<AiConfig>) {
  state.ai = { ...state.ai, ...patch }
  try {
    localStorage.setItem('nota-ai', JSON.stringify(state.ai))
  } catch {
    /* 存不下就算了，本次会话内仍然有效 */
  }
}

function initAi() {
  try {
    const raw = localStorage.getItem('nota-ai')
    if (!raw) return
    const saved = JSON.parse(raw) as Partial<AiConfig>
    state.ai = { ...AI_DEFAULTS, ...saved }
  } catch {
    state.ai = { ...AI_DEFAULTS }
  }
}

function initTheme() {
  const saved = localStorage.getItem('nota-theme') as 'light' | 'dark' | null
  const t = saved ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  setTheme(t)
}

/* ── 外观偏好 ──
   一次 setPrefs 就写完 <html> 上的属性与 CSS 变量并落盘。
   单独开一个 localStorage 键（nota-prefs）而不是七个键：
   它们是一组，一起读一起写，缺一个就会得到半套主题。 */
type PrefKey = 'bg' | 'density' | 'fontSize' | 'lineHeight' | 'measure' | 'lineWrap' | 'lineNumbers'

function applyPrefs() {
  const el = document.documentElement
  el.setAttribute('data-bg', state.bg)
  el.setAttribute('data-density', state.density)
  el.style.setProperty('--n-fs-body', `${state.fontSize}px`)
  el.style.setProperty('--n-lh', String(state.lineHeight))
  el.style.setProperty(
    '--n-measure',
    (MEASURES.find((m) => m.id === state.measure) ?? MEASURES[1]).px === 100000
      ? 'none'
      : `${(MEASURES.find((m) => m.id === state.measure) ?? MEASURES[1]).px}px`,
  )
}

function setPrefs(patch: Partial<Pick<State, PrefKey>>) {
  Object.assign(state, patch)
  applyPrefs()
  try {
    localStorage.setItem(
      'nota-prefs',
      JSON.stringify({
        bg: state.bg,
        density: state.density,
        fontSize: state.fontSize,
        lineHeight: state.lineHeight,
        measure: state.measure,
        lineWrap: state.lineWrap,
        lineNumbers: state.lineNumbers,
      }),
    )
  } catch {
    /* 存不下就只在本次会话生效 */
  }
}

function initPrefs2() {
  try {
    const raw = localStorage.getItem('nota-prefs')
    if (raw) Object.assign(state, JSON.parse(raw) as object)
  } catch {
    /* 坏数据就当没有 */
  }
  applyPrefs()
}

/** 恢复默认：只重置外观偏好，不动工作区、主题、强调色这些「个人化」选择 */
function resetPrefs() {
  Object.assign(state, PREF_DEFAULTS)
  applyPrefs()
  try {
    localStorage.removeItem('nota-prefs')
  } catch {
    /* 忽略 */
  }
}

/* ── AI 编写：对话页 ── */

let chatSeq = 0
let sessionSeq = 0

const CHAT_STORE_KEY = 'nota-chat-sessions'
/** 最多留这么多个会话，多的从最旧的开始丢 */
const SESSION_LIMIT = 30
/** 单个会话最多留这么多条消息 */
const MESSAGE_LIMIT = 200

function setMainView(v: MainView) {
  state.mainView = v
}

function currentSession(): ChatSession | undefined {
  return state.sessions.find((s) => s.id === state.activeSessionId)
}

/** 把 state.chat 接到某个会话的消息数组上——共用同一个引用，不拷贝 */
function activateSession(id: number) {
  const s = state.sessions.find((x) => x.id === id)
  if (!s) return
  state.activeSessionId = s.id
  state.chat = s.messages
}

/** 由第一条提问起个标题：够短、能认出来是哪次对话就行 */
function autoTitle(text: string) {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 22 ? `${one.slice(0, 22)}…` : one || '新对话'
}

/** 新建一个空会话并切过去 */
function newChat() {
  sessionSeq += 1
  const s: ChatSession = {
    id: sessionSeq,
    title: '新对话',
    messages: [],
    updatedAt: Date.now(),
  }
  state.sessions.unshift(s)
  if (state.sessions.length > SESSION_LIMIT) state.sessions.length = SESSION_LIMIT
  activateSession(s.id)
  saveSessions()
  return s.id
}

function switchSession(id: number) {
  if (id === state.activeSessionId) return
  activateSession(id)
  saveSessions()
}

function deleteSession(id: number) {
  const i = state.sessions.findIndex((s) => s.id === id)
  if (i < 0) return
  state.sessions.splice(i, 1)
  if (state.sessions.length === 0) {
    newChat()
    return
  }
  if (state.activeSessionId === id) {
    // 删掉当前会话后就近接上：优先它下面那条，没有就往上一条
    activateSession(state.sessions[Math.min(i, state.sessions.length - 1)].id)
  }
  saveSessions()
}

function renameSession(id: number, title: string) {
  const s = state.sessions.find((x) => x.id === id)
  if (!s) return
  const next = title.trim()
  if (next) s.title = next
  saveSessions()
}

/** 清空当前会话的消息，会话本身留着 */
function clearChat() {
  state.chat.splice(0, state.chat.length)
  const s = currentSession()
  if (s) {
    s.title = '新对话'
    s.updatedAt = Date.now()
  }
  saveSessions()
}

/** 往对话里追加一条消息，返回它的 id */
function pushChat(role: 'user' | 'assistant', content: string, error?: string) {
  chatSeq += 1
  state.chat.push({ id: chatSeq, role, content, error })
  const s = currentSession()
  if (s) {
    // 首条提问顺手当标题，之后不再改——标题跟着内容一路飘反而认不出来
    if (role === 'user' && s.title === '新对话') s.title = autoTitle(content)
    s.updatedAt = Date.now()
  }
  saveSessions()
  return chatSeq
}

/* ── 落盘 ──
   对话是用户自己敲出来的东西，重启就没了会很恼人。
   但 localStorage 只有几 MB，所以两头都设上限：会话数、单会话消息数。 */
function saveSessions() {
  try {
    localStorage.setItem(
      CHAT_STORE_KEY,
      JSON.stringify({
        active: state.activeSessionId,
        sessions: state.sessions.slice(0, SESSION_LIMIT).map((s) => ({
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
          messages: s.messages.slice(-MESSAGE_LIMIT),
        })),
      }),
    )
  } catch {
    /* 配额满了就算了，对话留在内存里照常用 */
  }
}

function initSessions() {
  try {
    const raw = localStorage.getItem(CHAT_STORE_KEY)
    if (raw) {
      const data = JSON.parse(raw) as { active?: number; sessions?: ChatSession[] }
      const list = Array.isArray(data.sessions) ? data.sessions : []
      const valid = list.filter((s) => s && typeof s.id === 'number' && Array.isArray(s.messages))
      if (valid.length) {
        state.sessions = valid.map((s) => ({
          id: s.id,
          title: s.title || '新对话',
          updatedAt: s.updatedAt || Date.now(),
          messages: s.messages.filter((m) => m && typeof m.id === 'number'),
        }))
        sessionSeq = Math.max(...valid.map((s) => s.id))
        chatSeq = Math.max(0, ...valid.flatMap((s) => s.messages.map((m) => m.id)))
        const active = valid.some((s) => s.id === data.active) ? (data.active as number) : valid[0].id
        activateSession(active)
        return
      }
    }
  } catch {
    /* 存档坏了就当没有，下面会建一个新的 */
  }
  newChat()
}

/**
 * 取当前笔记作为上下文。
 *
 * 整篇笔记可能有几万字，塞进本地小模型的上下文只会挤掉真正的问题，
 * 所以截一段头部（标题、导语通常都在前面），并如实告诉用户截了多少。
 */
function noteContext(limit = 1500) {
  const body = state.draft.trim()
  if (!body) return ''
  const head = body.slice(0, limit)
  const name = activeName.value || '当前笔记'
  return `【${name}】\n${head}${body.length > limit ? '\n…（已截断）' : ''}`
}

/**
 * 发一轮对话。
 *
 * 请求走主进程的 net.fetch（见 electron/main.ts），本地模型不会被
 * 渲染进程的 CORS 拦；这里只负责拼消息、管状态、把结果写回对话。
 */
async function sendChat(text: string, opts: { withNote?: boolean } = {}) {
  const q = text.trim()
  if (!q || state.aiBusy) return
  if (!state.ai.enabled) {
    pushChat('assistant', '', 'AI 编写已在设置里关闭。')
    return
  }

  pushChat('user', q)
  state.aiBusy = true

  const system = opts.withNote && state.draft.trim()
    ? `${state.ai.system}\n\n以下是用户正在写的笔记，回答时参考它：\n${noteContext()}`
    : state.ai.system

  const messages = [
    { role: 'system', content: system },
    ...state.chat
      .filter((m) => !m.error)
      .slice(-12) // 只带最近几轮，长对话不该把上下文无限撑大
      .map((m) => ({ role: m.role, content: m.content })),
  ]

  try {
    const r = await window.api.aiChat({ ...state.ai }, messages)
    if (r.ok) pushChat('assistant', r.text ?? '（模型没有返回内容）')
    else pushChat('assistant', '', r.error ?? '请求失败')
  } catch (e) {
    pushChat('assistant', '', String(e))
  } finally {
    state.aiBusy = false
  }
}

/** 重新生成最后一条回答 */
async function retryChat() {
  // 找到最后一条用户消息，把它之后的内容丢掉重发
  let last = -1
  for (let i = state.chat.length - 1; i >= 0; i -= 1) {
    if (state.chat[i].role === 'user') { last = i; break }
  }
  if (last < 0) return
  const q = state.chat[last].content
  // 必须原地截断：整体赋值会把 state.chat 换成新数组，
  // 那样它就和 sessions 里那条会话脱钩了，切走再切回来消息全没了
  state.chat.splice(last)
  await sendChat(q)
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
  visibleFiles,
  navTitle,
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
  setAccent,
  setAiConfig,
  initTheme,
  autoExpand,
  exportNote,
  importNotes,
  toggleSidebar,
  toggleList,
  setViewMode,
  setNavFilter,
  setSearchQuery,
  toggleOutline,
  setAutoSave,
  initPrefs,
  /* 外观偏好 */
  setPrefs,
  resetPrefs,
  /* AI 编写 */
  setMainView,
  sendChat,
  retryChat,
  clearChat,
  pushChat,
  newChat,
  switchSession,
  deleteSession,
  renameSession,
}
