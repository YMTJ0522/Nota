import { reactive, computed } from 'vue'
import type { HeadingItem } from '@/editor/preview-rich'
import {
  prepareMarkdown,
  renderMathInHtml,
  renderMermaidInHtml,
  enhancePreview,
} from '@/editor/preview-rich'
import { getMarked, highlightFences } from '@/editor/markdown'

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
export const SETTINGS_SECTIONS = [
  'general',
  'appearance',
  'editor',
  'ai',
  'sync',
  'about',
] as const
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
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'llama3.2',
  apiKey: '',
  system: '你是写作助手。回答要简洁，直接给出结果，不要复述问题。',
  temperature: 0.7,
}

/**
 * 常见本地/云端服务的预设，省得手打地址。
 *
 * 本地那两个写 127.0.0.1 而不是 localhost：Ollama / LM Studio 默认只监听
 * IPv4，而 Windows 上 localhost 会先解析到 IPv6 的 ::1，连不上时看起来就是
 * 「同一个地址有时候能测通、有时候不能」。主进程里另有一层兜底（见 main.ts
 * 的 hostCandidates），但预设本身先给对的那个更省事。
 */
export const AI_PRESETS: { label: string; baseUrl: string; model: string }[] = [
  { label: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' },
  { label: 'LM Studio（本地）', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
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
  /** 最近打开过的文件夹，最近的在最前。侧栏底部那个下拉读它 */
  recentRoots: string[]
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
  /** 关系图开着没。它是主区的一次「换一个看法」，不是中间列的一个页签 ——
      中间列只有 300px 宽，画不下几百个节点。 */
  graphOpen: boolean
  /** 中间那一列在显示什么（主区与这一列的分工见 setColumnView） */
  columnView: ColumnView
  /** 各栏宽度（拖动分隔线改的就是它们） */
  sidebarWidth: number
  columnWidth: number
  outlineWidth: number
  /** 中间那一列的宽度是不是「自适应窗口」。
      默认开着：这一列的读者视角是「正在跟 AI 聊 / 正在挑素材」，
      窄窄一条固定宽度会让每句话都折成三四行。人一旦自己拖过，
      就按他拖的来（自适应关掉），双击分隔线可以再回到自适应。 */
  columnAuto: boolean
  /** 全部对话会话。每个会话自带一堆消息 */
  sessions: ChatSession[]
  /** 当前正在看的会话 id */
  activeSessionId: number
  /** 当前会话的消息列表。始终与 sessions 里那一条**共用同一个数组**，
      所以 push / splice 都直接生效，不要整体赋值（会把引用换掉） */
  chat: ChatMessage[]
  /** 对话是否在进行中 */
  aiBusy: boolean
  /** 正在干哪一步。给面板上那句话用，不是装饰：每个阶段都是真在发生的事 */
  aiStage: string
  /** AI 这一轮在改哪一篇。null = 跟着当前打开的那篇走 */
  aiNote: string | null
  /** 联网检索：开着时每轮提问先去查资料，再把摘要一起交给模型 */
  aiWeb: boolean
  /** 节点图标：相对路径 → `brand:python` / `emoji:📌`。随工作区走 */
  icons: Record<string, string>
  /** 标签 → 归属图标，跟 icons 同一套素材库、同一个 `kind:id` 值格式 */
  tagIcons: Record<string, string>
  /** 要不要把那一篇的正文一起交给模型 */
  aiWithNote: boolean
  /** 当前笔记的标题结构。由编辑区在渲染预览时写进来，
      中间那一列的「大纲」视图直接读它，不重复解析一遍 Markdown */
  headings: HeadingItem[]
  /** 当前读到哪一节。滚动由编辑区量，大纲那一侧只负责高亮这一条 */
  activeHeading: string | null
  /** 云同步（WebDAV）。config 持久化在 localStorage，状态是这一屏的 */
  sync: SyncUi
}

/** 云同步在界面上的那一份状态 */
export interface SyncUi {
  config: { url: string; username: string; password: string; dir: string; auto: boolean }
  /** idle / busy / ok / error */
  status: 'idle' | 'busy' | 'ok' | 'error'
  /** 现在正在传哪个文件 / 上一次同步的结果一句话 */
  message: string
  /** 上次成功同步的时间戳 */
  lastAt: number
}

/** AI 对话消息。role 只有 user / assistant 两种——system 单独放在配置里 */
export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  /** 出错时的提示文案，与 content 分开存，样式不同 */
  error?: string
  /** 模型自己吐出来的推理过程。只有思考型模型（R1 / QwQ 这类）才有，
      没有就是空的——面板据此决定「思考过程」那一行显不显示。 */
  thinking?: string
  /** 这一轮实际做过的事，按发生顺序记。不是装饰：每一条都能对上一个真动作 */
  steps?: AgentStep[]
  /** 这一轮从按下回车到收完答案花了多久 */
  ms?: number
  /** 这一轮联网查到的来源。跟着消息存，切会话再切回来还在 */
  sources?: { title: string; url: string }[]
}

/** 执行过程里的一步。label 是一句话，detail 是这一步的具体结果 */
export interface AgentStep {
  label: string
  detail?: string
  status: 'run' | 'ok' | 'fail'
  ms?: number
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
  recentRoots: [],
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
  graphOpen: false,
  columnView: 'notes',
  sidebarWidth: 232,
  columnWidth: 296,
  outlineWidth: 176,
  columnAuto: true,
  sessions: [],
  activeSessionId: 0,
  chat: [],
  aiBusy: false,
  aiStage: '',
  aiNote: null,
  aiWeb: false,
  aiWithNote: true,
  icons: {},
  tagIcons: {},
  headings: [],
  activeHeading: null,
  sync: {
    config: { url: '', username: '', password: '', dir: '', auto: false },
    status: 'idle',
    message: '',
    lastAt: 0,
  },
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
  state.icons = {}
  state.loading = true
  state.tree = await window.api.readTree(dir)
  state.loading = false
  rememberRoot(dir)
  rememberLast(dir)
  await loadIcons()
}

/* ── 最近打开过的文件夹 ──
   侧栏底部那个下拉读的就是这一份。

   为什么要有它：以前换文件夹只有「打开文件夹…」一条路，每次都从系统
   选择框最外层的盘符开始点。常常在用的其实就那么两三个目录，
   现在它们排在列表里，点一下就过去了。 */

const ROOTS_KEY = 'nota-roots'
const ROOTS_MAX = 8

/** 记一个目录到列表头部（已经在里面就提到最前），并落盘 */
function rememberRoot(dir: string) {
  const next = [dir, ...state.recentRoots.filter((d) => d !== dir)].slice(0, ROOTS_MAX)
  state.recentRoots = next
  try {
    localStorage.setItem(ROOTS_KEY, JSON.stringify(next))
  } catch {
    /* 落盘失败不影响这次会话，列表还在内存里 */
  }
}

/** 从列表里摘掉一个（目录被删了 / 用户不要了） */
function forgetRoot(dir: string) {
  const next = state.recentRoots.filter((d) => d !== dir)
  state.recentRoots = next
  try {
    localStorage.setItem(ROOTS_KEY, JSON.stringify(next))
  } catch {
    /* 同上 */
  }
}

/**
 * 启动时回到上次那个工作区。
 *
 * 每次都从欢迎页点一次目录，是这个应用最没道理的一个动作：
 * 它是**笔记本**，不是一次性工具，打开就该落在上次写字的地方。
 * 于是把「最后一次进入的工作区」单独记一个键（recentRoots 是列表，
 * 它的第一项会被后来的排序翻动，不适合当「上次」）。
 *
 * 打不开（盘拔了、目录改名了）就安静地退回欢迎页，并把它从最近里去掉 ——
 * 一个点进去必错的入口留在列表里，比没有更烦人。
 */
const LAST_ROOT_KEY = 'nota-last-root'
const LAST_NOTE_KEY = 'nota-last-note'

function rememberLast(dir: string) {
  try {
    localStorage.setItem(LAST_ROOT_KEY, dir)
  } catch {
    /* 同上 */
  }
}

async function restoreLastWorkspace(): Promise<boolean> {
  const dir = localStorage.getItem(LAST_ROOT_KEY)
  if (!dir) return false
  try {
    const tree = await window.api.readTree(dir)
    state.root = dir
    state.tree = tree
    rememberRoot(dir)
    rememberLast(dir)
    await loadIcons()
    // 连上次在看的那篇一起回去：只回到目录、还得再找一遍笔记，等于只做了一半
    const note = localStorage.getItem(LAST_NOTE_KEY)
    if (note && note.startsWith(dir)) {
      const hit = flattenFiles(tree).find((f) => f.path === note)
      if (hit) await openNote(note)
    }
    return true
  } catch {
    localStorage.removeItem(LAST_ROOT_KEY)
    forgetRoot(dir)
    return false
  }
}

function loadRoots() {
  try {
    const raw = JSON.parse(localStorage.getItem(ROOTS_KEY) ?? '[]') as unknown
    if (Array.isArray(raw)) {
      state.recentRoots = raw
        .filter((d): d is string => typeof d === 'string' && d.length > 0)
        .slice(0, ROOTS_MAX)
    }
  } catch {
    /* 坏数据就当没有 */
  }
}

/**
 * 换到另一个工作区。返回 false 表示那个文件夹已经打不开了。
 *
 * 跟「第一次打开」的区别在于：这时候编辑区里可能正躺着一篇还没保存的笔记，
 * 而它属于**旧**工作区。所以顺序必须是先落盘、再换根，然后把「当前笔记」
 * 整个清空 —— 不清的话标题栏、大纲、自动保存都还指着旧根下的那个路径。
 */
async function switchWorkspace(dir: string): Promise<boolean> {
  if (dir === state.root) return true
  if (dirty.value) await saveNote()
  state.loading = true
  let tree: TreeNode[]
  try {
    tree = await window.api.readTree(dir)
  } catch {
    state.loading = false
    forgetRoot(dir)
    return false
  }
  state.activePath = null
  state.draft = ''
  state.savedDraft = ''
  state.activeTag = null
  state.expanded = {}
  setAiNote(null)
  state.root = dir
  state.tree = tree
  state.icons = {}
  state.tagIcons = {}
  state.loading = false
  rememberRoot(dir)
  rememberLast(dir)
  await loadIcons()
  return true
}

async function refreshTree() {
  if (!state.root) return
  state.tree = await window.api.readTree(state.root)
}

/* ── 节点图标 ──
   文件夹和笔记都可以自己挑一个图标：一组编程语言/技术栈的品牌图标，
   加一组工作向表情。默认是系统那两枚（文件夹 / 文档）。

   落在工作区的 .nota/icons.json（主进程那边读写），键是**相对路径**——
   工作区整个换个盘符或挪个目录，图标不会跟着一起失效。

   值写成 `brand:python` / `emoji:📌` 这种前缀形式：一个字符串就够，
   不用为了两种图标搞两套存储结构。 */
export interface NodeIcon {
  kind: 'brand' | 'emoji'
  id: string
}

function relOf(p: string): string {
  const root = state.root ? state.root.replace(/[\\/]+$/, '') : ''
  const abs = p.replace(/\\/g, '/')
  if (root && abs.toLowerCase().startsWith(root.replace(/\\/g, '/').toLowerCase() + '/')) {
    return abs.slice(root.replace(/\\/g, '/').length + 1)
  }
  return abs
}

function parseIcon(v: string | undefined): NodeIcon | null {
  if (!v) return null
  const cut = v.indexOf(':')
  if (cut < 0) return null
  const kind = v.slice(0, cut)
  const id = v.slice(cut + 1)
  if (!id) return null
  if (kind === 'brand' || kind === 'emoji') return { kind, id }
  return null
}

function encodeIcon(ic: NodeIcon): string {
  return `${ic.kind}:${ic.id}`
}

/** 某个节点的图标。没有自定义就返回 null，交给组件画默认的那一枚 */
function iconOf(p: string): NodeIcon | null {
  if (!p) return null
  return parseIcon(state.icons[relOf(p)])
}

/* ── 标签的归属图标 ──
   标签本来只是 frontmatter 里的一串名字，长得都一样，扫一眼分不清哪个是哪个。
   给它配一枚图标之后，侧栏的标签清单、笔记上的标签 chip 都带着这枚图标，
   认的是形状不是字 —— 这跟给文件挑图标是同一件事，所以共用同一份素材库、
   同一种 `kind:id` 值格式，甚至连输入框都复用同一个。

   但**数据分两个文件存**：icons.json 键是路径（删笔记时天然可以清掉），
   tag-icons.json 键是标签名。混在一起的话，删一个节点的图标很容易
   顺手把标签的归属图标也带走，而标签本身还活着。 */
function tagIconOf(tag: string): NodeIcon | null {
  if (!tag) return null
  return parseIcon(state.tagIcons[tag])
}

/** 设置 / 清除（传 null）某个标签的图标 */
async function setTagIcon(tag: string, ic: NodeIcon | null) {
  if (!state.root) return
  const name = tag.trim()
  if (!name) return
  const next = { ...state.tagIcons }
  if (ic) next[name] = encodeIcon(ic)
  else delete next[name]
  state.tagIcons = next
  await window.api.tagIconsWrite?.(state.root, next)
}

/* ── 给一篇笔记设标签 ──
   以前只能在侧栏的标签区点来点去，且改的是「全库所有带这个标签的笔记」。
   现在右键任意一篇笔记都能直接改这一篇自己的标签清单，所以这里要的是
   「整组替换」而不是「加一个 / 减一个」—— 勾选框的结果本来就是一整组。 */
async function setNoteTags(p: string, tags: string[]): Promise<boolean> {
  if (!p) return false
  const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
  const doc = p === state.activePath ? state.draft : await window.api.readNote(p)
  const next = writeTags(doc, clean)
  if (next === doc) return false

  if (p === state.activePath) state.draft = next
  else await window.api.writeNote(p, next)

  await refreshTree()
  return true
}

/**
 * 把 frontmatter 里的 tags 整段换成 `clean`。
 *
 * 三件事必须同时做对，缺一件这篇笔记就废了：
 * · 本来没有 frontmatter 的笔记要**新建一个**，不能因为原生获取不到就放弃；
 * · 现有的 `tags: [a, b]` 与 `tags:` + 缩进列表两种写法都要能改写；
 * · 结果为空时把整段删掉 —— 留一行空的 `tags:` 在文件头是纯粹的噪音。
 */
function writeTags(doc: string, clean: string[]): string {
  const fm = doc.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/)
  const lines = fm ? fm[1].split('\n') : []
  const found = fm ? findTagsLine(lines) : null
  const body = doc.slice(fm ? fm[0].length : 0)

  /* 没有 frontmatter（或 frontmatter 里还没有 tags 行）→ 追加一行 */
  let head: string[]
  if (!found) {
    const others = fm ? lines : []
    head = clean.length ? [...others, `tags: [${clean.join(', ')}]`] : others
  } else {
    const block =
      clean.length === 0
        ? []
        : found.block
          ? [`${found.key}:`, ...clean.map((t) => `  - ${t}`)]
          : [`${found.key}: [${clean.join(', ')}]`]
    head = [...lines.slice(0, found.at), ...block, ...lines.slice(found.end + 1)]
  }

  const tidy = head
    .filter((l) => l !== '')
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\n+|\n+$/g, '')

  return tidy ? `---\n${tidy}\n---\n${body}` : body.replace(/^\n+/, '')
}

async function loadIcons() {
  if (!state.root) {
    if (Object.keys(state.icons).length) state.icons = {}
    state.tagIcons = {}
    return
  }
  state.icons = (await window.api.iconsRead?.(state.root)) ?? {}
  state.tagIcons = (await window.api.tagIconsRead?.(state.root)) ?? {}
}

/** 设置 / 清除（传 null）某个节点的图标 */
async function setNodeIcon(p: string, ic: NodeIcon | null) {
  if (!state.root || !p) return
  const key = relOf(p)
  // reactive 对象上直接改属性是可行的（state 本身是 reactive），
  // 但下面要整体写回磁盘，所以先复制一份再赋值，保证界面这次就更新
  const next = { ...state.icons }
  if (ic) next[key] = encodeIcon(ic)
  else delete next[key]
  state.icons = next
  await window.api.iconsWrite?.(state.root, next)
}

/**
 * 「正在换笔记」的窗口期。
 *
 * 这一小段时间里 activePath 和 draft 必须一起换，中间不能被任何一次
 * 自动保存插进来 —— 否则会出现「新路径 + 旧内容」的组合，把上一篇的
 * 正文写进这一篇（导入笔记后新笔记被清空、内容跑到别的笔记里，就是这么来的）。
 */
let opening = false

async function openNote(path: string) {
  // 先把当前这篇的改动落盘；这一步用的是旧的 activePath，是对的
  if (dirty.value) await saveNote()
  opening = true
  try {
    // 先读盘再改 state：等待期间界面上仍是上一篇，不会闪一下空白
    const raw = await window.api.readNote(path)
    state.activePath = path
    state.draft = raw
    state.savedDraft = raw
    // 记下「上次在看哪一篇」，下次启动时直接回到它（见 restoreLastWorkspace）
    try {
      localStorage.setItem(LAST_NOTE_KEY, path)
    } catch {
      /* 落盘失败不影响这次打开 */
    }
  } finally {
    opening = false
  }
}

/**
 * 版本快照的节流状态。
 *
 * 以前只有「非静默保存」才记版本，而自动保存一律走 silent —— 于是
 * 用户从头到尾只按自动保存的话，历史里一个版本都没有，这个功能等于不存在。
 *
 * 但每次自动保存都记也不行：600ms 一次防抖意味着连打一行字就是十几份快照，
 * 真正想找的那一次早被挤出 40 份的上限了。
 *
 * 所以按「内容变了 + 距上一份快照超过 SNAP_GAP_MS」来记：
 *  - 手动保存（Ctrl+S / 切笔记 / 关窗）不设门槛，每次都记 —— 那是用户
 *    明确表示「我在这里停一下」的时刻；
 *  - 自动保存走门槛，一段连续输入只会留下一份。
 */
const SNAP_GAP_MS = 30_000
let lastSnap = { path: '', text: '', at: 0 }

async function saveNote(opts: { silent?: boolean } = {}) {
  if (opening) return
  if (!state.activePath || !dirty.value) return
  const path = state.activePath
  const content = state.draft
  state.saving = true
  try {
    await window.api.writeNote(path, content)
    state.savedDraft = content
    state.lastSavedAt = Date.now()
    if (state.root) {
      const now = Date.now()
      const sameNote = lastSnap.path === path
      const changed = !sameNote || content !== lastSnap.text
      const cooled = !opts.silent || now - lastSnap.at >= SNAP_GAP_MS
      if (changed && cooled) {
        lastSnap = { path, text: content, at: now }
        await window.api.historySave?.(state.root, path, content)
      }
    }
  } finally {
    state.saving = false
  }
}

/**
 * 新建笔记。没指定目录时落在「当前笔记所在的那个文件夹」——
 * 原来取的是树里第一个目录，正在某个文件夹里写笔记时新建，
 * 结果跑到别的目录去了，看着像放错了地方。
 */
async function newNote(dir?: string) {
  const target =
    dir ??
    (state.activePath
      ? state.activePath.replace(/[\\/][^\\/]*$/, '')
      : (state.tree.find((n) => n.type === 'dir')?.path ?? state.root))
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
  if (state.aiNote === path) setAiNote(next)
  state.renaming = null
  await refreshTree()
}

/* ── 右键菜单里那几件事 ──
   都在这一层做，而不是散在组件里：改的是同一份 state（activePath /
   aiNote / draft），散出去写就会出现「文件挪了，面板还指着老路径」。 */

/** 路径 → 不带扩展名的名字 */
function baseNameOf(p: string) {
  const parts = p.split(/[\\/]/)
  return (parts[parts.length - 1] ?? '').replace(/\.md$/i, '') || '未命名笔记'
}

/** 路径 → 它所在的文件夹（去工作区前缀） */
function folderOfPath(p: string) {
  const root = state.root ?? ''
  const rel = root && p.startsWith(root) ? p.slice(root.length) : p
  const parts = rel.replace(/^[\\/]+/, '').split(/[\\/]/)
  parts.pop()
  return parts.join(' / ') || '根目录'
}

/** 收藏状态写在 frontmatter 的 star 里，所以「收藏」＝改这篇笔记本身 */
function withStar(doc: string, on: boolean): string {
  const starLine = /^star(red)?\s*:\s*.*$/gim
  const fm = doc.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/)
  if (!fm) return on ? `---\nstar: true\n---\n\n${doc}` : doc
  const head = fm[1].replace(starLine, '').replace(/\n{2,}/g, '\n').replace(/\s+$/, '')
  const next = on ? `${head}\nstar: true` : head
  const tail = doc.slice(fm[0].length)
  return next.trim() ? `---\n${next}\n---\n${tail}` : (on ? `---\nstar: true\n---\n${tail}` : tail)
}

async function toggleStar(path: string, on?: boolean) {
  const node = allFiles.value.find((f) => f.path === path)
  const next = on ?? !node?.starred
  // 是当前打开的那篇就改草稿而不是直接写盘：编辑器里可能还有没落盘的改动，
  // 直接写文件会在 600ms 后被自动保存原样覆盖回去
  const raw = path === state.activePath ? state.draft : await window.api.readNote(path)
  const text = withStar(raw ?? '', next)
  if (path === state.activePath) {
    state.draft = text
    state.savedDraft = text
  }
  await window.api.writeNote(path, text)
  await refreshTree()
  return next
}

/** 归类：把笔记挪到另一个文件夹。内容不动，只换位置 */
async function moveNoteTo(path: string, dir: string) {
  const next = await window.api.moveNote(path, dir)
  if (next === path) return path
  if (state.activePath === path) {
    // 内容没变，路径变了：先把脏标记对齐，再换路径，
    // 免得自动保存以为有改动、把正文写到老路径上去
    state.savedDraft = state.draft
    state.activePath = next
  }
  if (state.aiNote === path) setAiNote(next)
  await refreshTree()
  return next
}

async function revealNote(path: string) {
  await window.api.revealNote(path)
}

/** 「归类」对话框里的候选：工作区根 + 所有子目录，带层级前缀便于区分同名目录 */
const folderOptions = computed(() => {
  const out: { name: string; path: string }[] = []
  if (state.root) out.push({ name: '工作区根目录', path: state.root })
  const walk = (nodes: TreeNode[], prefix: string) => {
    for (const n of nodes) {
      if (n.type !== 'dir') continue
      out.push({ name: prefix + n.name, path: n.path })
      if (n.children) walk(n.children, `${prefix}${n.name} / `)
    }
  }
  walk(state.tree, '')
  return out
})

function toggleDir(path: string) {
  state.expanded[path] = !state.expanded[path]
}

/** 打开「新建文件夹」输入框；parent 为空时建在工作区根目录 */
function startNewFolder(parent?: string) {
  state.newFolderIn = parent ?? state.root ?? ''
}

/** 目录在前、文件在后，各自按名称排 —— 跟主进程 walk() 里那份一致 */
function sortNodes(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
  return a.name.localeCompare(b.name, 'zh-CN')
}

/**
 * 先把新文件夹摆进树里，不等 IPC。
 *
 * 原来是「建 → 等 IPC 回来 → 重新扫整棵树」才画出来。扫树要为每个 .md
 * 开一次文件读 frontmatter（`workspace:tree` 里的 readMeta），工作区一大
 * 就是几百次 IO —— 于是点了确定、输入框收了、树里却半天不动，
 * 看着像「没建上」或者「卡了一下」。
 *
 * 现在节点立刻出现，真的建好之后再让整棵树归位。摆的位置照主进程的
 * 排序规则来，避免刷新完又跳一下。
 */
function insertDirOptimistic(parent: string, dirPath: string, name: string) {
  const node: TreeNode = { type: 'dir', name, path: dirPath, children: [] }
  const put = (list: TreeNode[]): boolean => {
    for (const n of list) {
      if (n.type !== 'dir') continue
      if (n.path === parent) {
        n.children = [...(n.children ?? []), node]
        n.children.sort(sortNodes)
        return true
      }
      if (n.children && put(n.children)) return true
    }
    return false
  }
  if (!parent || parent === state.root || !put(state.tree)) {
    state.tree = [...state.tree, node]
    state.tree.sort(sortNodes)
  }
}

/** 提交新建文件夹 */
async function commitNewFolder(name: string) {
  const parent = state.newFolderIn
  state.newFolderIn = null
  const nm = name.trim()
  if (!parent || !nm) return
  state.expanded[parent] = true
  const guess = `${parent.replace(/[\\/]+$/, '')}/${nm}`
  insertDirOptimistic(parent, guess, nm)
  // 真名可能带序号（同名时主进程会落成「Wu 1」），建完再让整棵树归位
  await window.api.createFolder(parent, nm)
  await refreshTree()
}

function cancelNewFolder() {
  state.newFolderIn = null
}

/** 点标签筛选；再点一次同一个标签就取消筛选 */
function setActiveTag(tag: string | null) {
  state.activeTag = state.activeTag === tag ? null : tag
  // 标签就是一份筛选结果，切了就得让列表露出来
  showNoteList()
}

/**
 * 改一个标签：改名或删掉（newName 传 null 就是删）。
 *
 * 标签没有自己的库，它是每篇笔记 frontmatter 里的一行，所以「删标签」
 * 必然是「把所有带这个标签的笔记都改一遍」—— 这里就直接做这件事，
 * 不做「看起来删了、其实还在」的假动作。
 *
 * 只动带这个标签的笔记，别的笔记一个字节都不碰。
 * 当前正在编辑的那篇改的是 draft（走既有的保存通道），
 * 其余的直接读写磁盘，改完刷新一次目录树，侧栏的标签清单立刻跟着变。
 *
 * @returns 真正改过的笔记篇数
 */
async function retagNotes(oldName: string, newName: string | null): Promise<number> {
  const from = oldName.trim()
  if (!from) return 0
  const to = newName?.trim() ?? null
  const targets = allFiles.value.filter((f) => (f.tags ?? []).includes(from))
  let n = 0

  for (const f of targets) {
    const doc = f.path === state.activePath ? state.draft : await window.api.readNote(f.path)
    const next = retagDoc(doc, from, to)
    if (next === doc) continue

    if (f.path === state.activePath) {
      // 正在写的那篇改 draft：编辑器会跟着同步，自动保存也会照常落盘
      state.draft = next
    } else {
      await window.api.writeNote(f.path, next)
    }
    n++
  }

  if (n > 0) {
    if (state.activeTag === from) state.activeTag = to
    await refreshTree()
  }
  return n
}

/** frontmatter 里 tags 那一行的位置与写法 */
function findTagsLine(lines: string[]) {
  const at = lines.findIndex((l) => /^(tags|tag)[ \t]*:/.test(l))
  if (at < 0) return null
  const inline = /^(tags|tag)[ \t]*:[ \t]*(\[.*\])$/.exec(lines[at])
  if (inline) {
    const items = inline[2]
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
    return { at, key: inline[1], block: false, items, end: at }
  }
  // 块式：`tags:` 下面缩进挂一串 `- 名`
  let end = at
  const items: string[] = []
  for (let i = at + 1; i < lines.length; i++) {
    const item = /^[ \t]*-[ \t]+(.*)$/.exec(lines[i] ?? '')
    if (!item) break
    items.push(item[1].trim().replace(/^["']|["']$/g, ''))
    end = i
  }
  const key = /^(tags|tag)/.exec(lines[at])?.[1] ?? 'tags'
  return { at, key, block: true, items, end }
}

/**
 * 在 frontmatter 里把一个标签换成另一个（或去掉）；`[a, b]` 与 `- a` 两种写法都认。
 * 没有 frontmatter、或这篇根本没这个标签时原样返回，调用方据此判断「有没有改动」。
 */
function retagDoc(doc: string, from: string, to: string | null): string {
  const fm = doc.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/)
  if (!fm) return doc

  const lines = fm[1].split('\n')
  const found = findTagsLine(lines)
  if (!found || !found.items.includes(from)) return doc

  const next = found.items.map((t) => (t === from ? to : t)).filter((t): t is string => !!t)

  /* 一个标签都不剩就把整段 tags 拿掉 —— 留一个空的 `tags:` 在开头，
     每次打开这篇都会看到一行没用的元数据。 */
  const replaced =
    next.length === 0
      ? []
      : found.block
        ? [`${found.key}:`, ...next.map((t) => `  - ${t}`)]
        : [`${found.key}: [${next.join(', ')}]`]

  const head = [...lines.slice(0, found.at), ...replaced, ...lines.slice(found.end + 1)]
  const body = head.join('\n').replace(/\n{2,}/g, '\n').replace(/^\n+|\n+$/g, '')
  const tail = doc.slice(fm[0].length)
  return body ? `---\n${body}\n---\n${tail}` : tail.replace(/^\n+/, '')
}

/** 把中间那一列拉回笔记列表。点导航、点标签时都要先走这一步，
    否则「我点了最近编辑」会看起来毫无反应——那一列还停在附件库上。
    AI 那格不动：它是用户明确打开的另一种东西，由 setMainView 负责切回来。 */
function showNoteList() {
  if (state.columnView !== 'notes' && state.columnView !== 'ai') setColumnView('notes')
}

/* ── 导出 ──
   四种格式共用同一条管线：Markdown 先渲染成 HTML（marked + 代码高亮，
   和预览同一套），再按目标格式套壳 —— HTML 直接存，Word 换一层 Word
   认的壳存 .doc，PDF 交给主进程在隐藏窗口里打印。

   内容一律从「当前草稿」或磁盘取：是正在写的那篇就用草稿，这样
   「刚写完还没保存就导出」也能拿到最新内容。 */
export type ExportKind = 'md' | 'html' | 'pdf' | 'word'

/**
 * 把正文里的相对媒体路径换成 file:// 绝对路径。
 *
 * 预览里那些图靠 nota-media:// 协议显示，那是应用内部的东西，导出后
 * 打开就全是裂图。换成绝对路径后，导出的文件在本机放哪儿都还能看到图。
 */
function absolutizeMedia(html: string): string {
  const root = state.root
  if (!root) return html
  return html.replace(
    /(<(?:img|video|source)\b[^>]*?\bsrc=")([^"]+)(")/g,
    (whole, head: string, src: string, tail: string) => {
      if (/^(https?:|data:|file:|blob:|nota-media:)/i.test(src)) return whole
      const abs = `${root.replace(/[\\/]+$/, '')}/${src.replace(/^[\\/]+/, '')}`
      return `${head}file:///${encodeURI(abs.replace(/\\/g, '/'))}${tail}`
    },
  )
}

/**
 * 导出用的排版。
 *
 * 早先这只是「够把 Markdown 摊开成一份像样的文档」的十几行，结果导出来的
 * 东西和软件里看到的完全不是一回事：表格是方框、代码块没有圆角、字体掉回
 * 系统默认。现在它按预览那一套来写（同一组圆角、同一套层级、同一份配色），
 * 只是把所有 var() 换成具体值——导出的文件是独立打开的，拿不到本机的
 * 主题变量。
 *
 * 字族与软件一致：圆体在前，系统字体兜底。本机装了圆体（软件本身自带）时
 * 导出的文档跟屏幕上是一个字形；换一台没装字的机器也只是退回系统字体，
 * 不会缺字、不会变乱码。
 */
export const EXPORT_CSS = `
:root {
  --fg: #24231f; --fg-dim: #55534e; --fg-faint: #8a867c;
  --line: #dedbd4; --surface: #f7f6f3;
  --code-bg: #f4f2ec; --code-line: #e2ded4; --code-fg: #3b3934;
  --accent: #2f6f52; --accent-soft: #eef4f0;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  max-width: 780px; margin: 0 auto; padding: 40px 26px 64px;
  font-family: "NanxiXinyuanti", "南西新圆体", -apple-system, "Segoe UI",
    "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  font-size: 16px; line-height: 1.78; color: var(--fg); background: #fbfaf7;
  -webkit-font-smoothing: antialiased;
  orphans: 3; widows: 3;
}
/* ── 标题层级 ── */
h1, h2, h3, h4, h5, h6 {
  line-height: 1.34; margin: 1.5em 0 .5em; font-weight: 700;
  letter-spacing: -.015em; color: var(--fg);
  break-after: avoid; page-break-after: avoid;
  break-inside: avoid; page-break-inside: avoid;
}
h1 { font-size: 1.62em; margin-top: 0; padding-bottom: .25em; border-bottom: 1px solid var(--line); }
h2 { font-size: 1.34em; padding-bottom: .2em; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.16em; }
h4 { font-size: 1.04em; }
h5 { font-size: .96em; color: var(--fg-dim); }
h6 { font-size: .92em; color: var(--fg-faint); }
/* ── 正文段落与列表 ── */
p { margin: .8em 0; }
ul, ol { padding-left: 1.45em; margin: .8em 0; }
li { margin: .28em 0; }
li > ul, li > ol { margin: .28em 0; }
ul.contains-task-list { list-style: none; padding-left: .2em; }
li.task-list-item { display: flex; gap: .5em; align-items: baseline; }
li.task-list-item input { margin: 0; }
/* ── 行内元素 ── */
a { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
a[href] { word-break: break-word; }
strong { font-weight: 700; }
del { color: var(--fg-faint); }
mark { background: #f6e3a8; color: inherit; padding: 0 2px; border-radius: 3px; }
hr { border: none; border-top: 1px solid var(--line); margin: 2em 0; }
/* ── 代码 ── */
code {
  font-family: "JetBrains Mono", "Cascadia Code", ui-monospace, Consolas,
    "Sarasa Mono SC", monospace;
  font-size: .88em; padding: .15em .4em; border-radius: 5px;
  color: var(--code-fg); background: var(--code-bg);
}
pre {
  margin: .95em 0; padding: 13px 15px;
  border: 1px solid var(--code-line); border-radius: 10px;
  background: var(--code-bg); color: var(--code-fg);
  overflow-x: auto; tab-size: 2;
  break-inside: avoid; page-break-inside: avoid;
  white-space: pre-wrap; word-break: break-word;
}
pre code {
  display: block; padding: 0; border: 0; background: transparent;
  color: inherit; font-size: .88em; line-height: 1.72;
}
.pv-line { display: block; min-height: 1.5em; }
.pv-line.is-hl { background: #e8f0eb; border-radius: 3px; margin: 0 -6px; padding: 0 6px; }
/* 行号：CSS 计数器，导出里也能正确显示 */
pre[data-line-numbers] { counter-reset: pv-ln; padding-left: 3.2em; position: relative; }
pre[data-line-numbers] .pv-line { counter-increment: pv-ln; }
pre[data-line-numbers] .pv-line::before {
  content: counter(pv-ln);
  position: absolute; left: 0; width: 2.4em;
  text-align: right; padding-right: .6em;
  font-size: .78em; color: var(--fg-faint);
  user-select: none; -webkit-user-select: none;
}
/* ── 引用块 ── */
blockquote {
  margin: 1em 0; padding: .45em 0 .45em 14px;
  border-left: 3px solid var(--accent); border-radius: 0 6px 6px 0;
  background: var(--accent-soft); color: var(--fg-dim);
  break-inside: avoid; page-break-inside: avoid;
}
blockquote p:first-child { margin-top: 0; }
blockquote p:last-child { margin-bottom: 0; }
/* ── 图片与 figure ── */
img, video { max-width: 100%; height: auto; border-radius: 8px; }
img { display: block; margin: 1em auto; }
figure { margin: 1em 0; text-align: center; break-inside: avoid; page-break-inside: avoid; }
figure.pv-code-fig { text-align: left; }
pre, .pv-code-box { text-align: left; }
figcaption { font-size: .88em; color: var(--fg-faint); margin-top: .4em; }
/* ── 表格 ── */
.pv-table-wrap {
  margin: 1em 0; border: 1px solid var(--line);
  border-radius: 10px; overflow: hidden;
  break-inside: avoid; page-break-inside: avoid;
}
table { border-collapse: separate; border-spacing: 0; width: 100%; margin: 0; font-size: .94em; }
th, td { border-right: 1px solid var(--line); border-bottom: 1px solid var(--line);
  padding: 7px 11px; vertical-align: top;
  text-align: center; word-break: break-word; }
th[align='left'], td[align='left'] { text-align: left; }
th[align='right'], td[align='right'] { text-align: right; }
th:last-child, td:last-child { border-right: none; }
tbody tr:last-child td { border-bottom: none; }
th { background: var(--surface); font-weight: 600; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
/* ── Callout 提示块 ── */
.pv-callout {
  margin: 1.15em 0; padding: .7em 14px .75em;
  border: 1px solid var(--code-line); border-left: 4px solid var(--accent);
  border-radius: 8px; background: var(--accent-soft);
  break-inside: avoid; page-break-inside: avoid;
}
.pv-callout-head { display: flex; align-items: center; gap: 7px;
  font-size: .92em; font-weight: 600; line-height: 1.5; }
.pv-callout-title { color: var(--accent); letter-spacing: .01em; }
.pv-callout-icon { display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border-radius: 6px; color: var(--accent);
  background: var(--accent-soft); }
.pv-callout-icon svg { width: 14px; height: 14px; }
.pv-callout-body { margin-top: .2em; }
.pv-callout-body > p:first-child { margin-top: .3em; }
.pv-callout-body > p:last-child { margin-bottom: 0; }
.pv-callout[data-type='note'] { --c: #5b60d6; --s: #eef0fb; }
.pv-callout[data-type='info'] { --c: #2a7fc0; --s: #ecf4fb; }
.pv-callout[data-type='tip'] { --c: #2c8f63; --s: #ecf6f1; }
.pv-callout[data-type='success'] { --c: #3f8f3a; --s: #eef6ea; }
.pv-callout[data-type='example'] { --c: #8a4fc9; --s: #f3edfb; }
.pv-callout[data-type='important'] { --c: #b34bb0; --s: #f9edf9; }
.pv-callout[data-type='question'] { --c: #cf4b86; --s: #fceef5; }
.pv-callout[data-type='warning'] { --c: #a67c1a; --s: #fbf4e4; }
.pv-callout[data-type='caution'] { --c: #b8641a; --s: #fcf0e6; }
.pv-callout[data-type='danger'] { --c: #c33f2c; --s: #fceceb; }
.pv-callout[data-type='quote'] { --c: #6f6c66; --s: #f4f3f0; }
.pv-callout { border-left-color: var(--c); background: var(--s); }
.pv-callout-title, .pv-callout-icon { color: var(--c); }
.pv-callout-icon { background: #fff; }
/* ── 待办 ── */
.pv-task { display: inline-block; margin-right: .35em; color: var(--fg-dim); }
.pv-task::after { content: "\\2610"; font-size: 1.05em; }
.pv-task.on::after { content: "\\2612"; color: var(--accent); }
/* ── 折叠块：导出时强制展开 ── */
.pv-fold, details.pv-details { break-inside: avoid; page-break-inside: avoid; }
details.pv-details > summary { cursor: default; font-weight: 600; margin-bottom: .3em; }
details.pv-details[open] > summary { margin-bottom: .5em; }
.pv-details-body { padding-left: .8em; border-left: 2px solid var(--line); }
/* ── 分栏标签：导出时全部摊平，每个标签带标题 ── */
.pv-tabs { break-inside: avoid; page-break-inside: avoid; margin: 1em 0; }
.pv-tabbar { display: none; }
.pv-tab-pane { display: block !important; margin: .8em 0; padding: .7em 12px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.pv-tab-pane::before { content: attr(data-label); display: block;
  font-weight: 700; font-size: .88em; color: var(--accent); margin-bottom: .4em; }
/* ── 嵌入与双链 ── */
.pv-embed { display: inline-flex; gap: 5px; padding: 2px 9px 2px 7px;
  border: 1px solid var(--line); border-radius: 6px; background: var(--surface);
  font-size: .92em; color: var(--accent); }
.pv-wlink { color: var(--accent); text-decoration: none;
  border-bottom: 1px solid rgba(47,111,82,.4); }
.pv-wlink.is-missing, .pv-embed.is-missing { border-style: dashed; color: var(--fg-faint); }
.pv-wlink-tag, .pv-embed-tag { margin-right: 4px; padding: 0 4px; border-radius: 3px;
  background: rgba(47,111,82,.12); color: var(--accent); font-size: 10px; }
/* ── 公式 ── */
.pv-math, .pv-math-block { font-family: ui-monospace, Consolas, monospace;
  background: var(--code-bg); border-radius: 4px; padding: 0 .3em; }
.pv-math-block { display: block; padding: .5em .7em; margin: .8em 0; text-align: center;
  break-inside: avoid; page-break-inside: avoid; }
/* ── Mermaid 图表 ── */
.pv-mermaid { margin: 1.2em 0; text-align: center; break-inside: avoid; page-break-inside: avoid; }
.pv-mermaid-graph { display: inline-block; max-width: 100%; }
.pv-mermaid-graph svg { max-width: 100%; height: auto; }
.pv-mermaid-src { display: none; }
/* ── 脚注 ── */
.footnotes { margin-top: 2.5em; padding-top: 1em; border-top: 1px solid var(--line);
  font-size: .9em; color: var(--fg-dim);
  break-inside: avoid; page-break-inside: avoid; }
.pv-fn-list { margin: 0; padding-left: 1.3em; }
.pv-fn-n { color: var(--accent); font-weight: 600; }
.pv-fnback { display: none; }
sup a { text-decoration: none; }
sup.pv-fnref { font-size: .75em; line-height: 0; vertical-align: super; }
/* ── 高级代码块外壳 ── */
.pv-code-fig { margin: 1em 0; text-align: left; break-inside: avoid; page-break-inside: avoid; }
.pv-code-box { break-inside: avoid; page-break-inside: avoid; }
.pv-code-fig > .pv-code-box > pre { margin: 0; border-top-left-radius: 0; border-top-right-radius: 0; }
.pv-code-fig:not(:has(.pv-code-title)) > .pv-code-box > pre { border-radius: 10px; }
.pv-code-lang { display: block; text-align: right; margin: .3em 0 -.5em;
  font-size: .72em; font-weight: 600; letter-spacing: .02em; color: var(--fg-faint); }
.pv-code-title { padding: 6px 14px; border: 1px solid var(--code-line); border-bottom: 0;
  border-radius: 8px 8px 0 0; background: var(--surface);
  font-size: .78em; font-weight: 600; color: var(--fg-dim); }
/* ── 标签与块 ID ── */
.pv-tag { padding: 0 .4em; border-radius: 6px; background: var(--accent-soft);
  color: var(--accent); font-size: .92em; }
.pv-bid { color: var(--fg-faint); font-size: .85em; }
/* ── 代码高亮 ── */
.cm-hl-keyword { color: #8a4e30 } .cm-hl-string { color: #2d7a56 }
.cm-hl-number { color: #b56a16 } .cm-hl-func { color: #3d5f8f }
.cm-hl-type { color: #6a548f } .cm-hl-prop { color: #5c6848 }
.cm-hl-operator { color: #8a4e30 } .cm-hl-punct { color: #6b6862 }
.cm-hl-var { color: #6b6862 } .cm-hl-comment { color: #8d8a83; font-style: italic }
/* ── 手动分页符 ── */
.pdf-break { break-before: page; page-break-before: always; }
/* ── 页面设置 ── */
@page { size: A4; margin: 20mm 18mm; }
@media print {
  body { max-width: none; margin: 0; padding: 0; background: #fff; font-size: 11pt; }
  a { color: var(--fg); text-decoration: none; }
  a[href^="http"]::after { content: " (" attr(href) ")"; font-size: .8em; color: var(--fg-faint); }
  pre, .pv-table-wrap, .pv-callout, img, figure, .pv-mermaid,
  .pv-code-fig, .pv-code-box, details.pv-details, .pv-tabs {
    box-shadow: none;
    break-inside: avoid; page-break-inside: avoid;
  }
  /* 打印时表格容器不能 overflow:hidden，否则 thead 重复失效 */
  .pv-table-wrap { overflow: visible; border-radius: 0; }
  pre { overflow-x: visible; }
  h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
  .footnotes { break-before: auto; }
}
/* 导出文件不带暗色模式：打印/分享时永远是白底 */
`

/**
 * Word / WPS 那一份样式表。
 *
 * 为什么不复用上面那份：Word 打开 .doc 走的是**它自己的 HTML 引擎**，
 * 它不认 CSS 变量（var(--fg)）、不认 color-mix、不认 oklch。上面那份里
 * 凡是写成 var() 的地方，到了 Word 里一律等于没写 —— 字号、颜色、行距、
 * 边框全线丢失，于是看上去就是「标题不比正文大、表格没有线、整篇挤在一起」，
 * 也就是用户说的「很乱」。所以这一份里每个值都是字面量，并补上 Word 自己的
 * mso 属性（行高规则、表格间距、图片边框）。
 *
 * 尺寸一律用 pt：Word 的排版单位是 pt，用 em/px 它换算出来的大小常常对不上。
 */
export const WORD_CSS = `
body { font-family: "等线","DengXian","Microsoft YaHei","PingFang SC",sans-serif;
  font-size: 10.5pt; line-height: 1.72; color: #24231f; background: #ffffff;
  margin: 0; padding: 0; }
p { margin: 0 0 6pt; text-align: justify; }
p, li, td, th { mso-line-height-rule: exactly; }
h1, h2, h3, h4, h5, h6 { font-weight: bold; color: #1e1d1a; margin: 14pt 0 6pt;
  line-height: 1.35; page-break-after: avoid; }
h1 { font-size: 20pt; margin-top: 0; border-bottom: 1pt solid #dedbd4; padding-bottom: 4pt; }
h2 { font-size: 16pt; border-bottom: 1pt solid #dedbd4; padding-bottom: 3pt; }
h3 { font-size: 14pt; }
h4 { font-size: 12.5pt; }
h5 { font-size: 11pt; color: #55534e; }
h6 { font-size: 10.5pt; color: #8a867c; }
ul, ol { margin: 0 0 8pt; padding-left: 22pt; }
li { margin: 0 0 3pt; text-align: justify; }
a { color: #2f6f52; text-decoration: underline; }
strong { font-weight: bold; }
del, s { color: #8a867c; }
mark { background: #f6e3a8; }
hr { border: none; border-top: 1pt solid #dedbd4; margin: 14pt 0; }
blockquote { margin: 10pt 0 10pt 12pt; padding: 4pt 0 4pt 12pt; border-left: 3pt solid #2f6f52;
  background: #f2f5f3; color: #55534e; }
code { font-family: Consolas,"Courier New",monospace; font-size: 9.5pt;
  background: #f4f2ec; padding: 0 2pt; }
/* 代码块 → 单格表格（Word 不画 div 的边框和底色）
   pre/code 外壳已在 wordify 里拆除，td 里直接是 .pv-code-lang + <p> 代码行 */
table.wc-code { width: 100%; border-collapse: collapse; margin: 10pt 0;
  page-break-inside: avoid; }
table.wc-code td { border: 1pt solid #e2ded4; background: #f7f6f2;
  padding: 8pt 10pt; font-family: Consolas,"Courier New",monospace; font-size: 9pt;
  line-height: 1.6; text-align: left; color: #3b3934; }
table.wc-code td p { margin: 0; padding: 0; text-align: left;
  font-family: Consolas,"Courier New",monospace; font-size: 9pt; line-height: 1.55;
  white-space: pre-wrap; word-break: break-all; }
table.wc-code .pv-code-lang { display: block; text-align: right;
  font-size: 8pt; color: #8a867c; font-weight: bold; margin: 0 0 3pt;
  font-family: Consolas,"Courier New",monospace; }
/* 代码高亮走字面色 */
.cm-hl-keyword { color: #8a4e30 } .cm-hl-string { color: #2d7a56 }
.cm-hl-number { color: #b56a16 } .cm-hl-func { color: #3d5f8f }
.cm-hl-type { color: #6a548f } .cm-hl-prop { color: #5c6848 }
.cm-hl-operator { color: #8a4e30 } .cm-hl-punct { color: #6b6862 }
.cm-hl-var { color: #6b6862 } .cm-hl-comment { color: #8d8a83; font-style: italic }
/* 提示块 → 单格表格 */
table.wc-callout { width: 100%; border-collapse: collapse; margin: 12pt 0;
  page-break-inside: avoid; }
table.wc-callout td { padding: 8pt 11pt; font-size: 10pt; text-align: left;
  border: 1pt solid #dedbd4; background: #f7f6f3; }
table.wc-callout[data-type='note'] td { border-left: 4.5pt solid #5b60d6; background: #eef0fb; }
table.wc-callout[data-type='info'] td { border-left: 4.5pt solid #2a7fc0; background: #ecf4fb; }
table.wc-callout[data-type='tip'] td { border-left: 4.5pt solid #2c8f63; background: #ecf6f1; }
table.wc-callout[data-type='success'] td { border-left: 4.5pt solid #3f8f3a; background: #eef6ea; }
table.wc-callout[data-type='example'] td { border-left: 4.5pt solid #8a4fc9; background: #f3edfb; }
table.wc-callout[data-type='important'] td { border-left: 4.5pt solid #b34bb0; background: #f9edf9; }
table.wc-callout[data-type='question'] td { border-left: 4.5pt solid #cf4b86; background: #fceef5; }
table.wc-callout[data-type='warning'] td { border-left: 4.5pt solid #a67c1a; background: #fbf4e4; }
table.wc-callout[data-type='caution'] td { border-left: 4.5pt solid #b8641a; background: #fcf0e6; }
table.wc-callout[data-type='danger'] td { border-left: 4.5pt solid #c33f2c; background: #fceceb; }
table.wc-callout[data-type='quote'] td { border-left: 4.5pt solid #6f6c66; background: #f4f3f0; }
table.wc-callout[data-type='note'] .pv-callout-title { color: #4a4fc0 }
table.wc-callout[data-type='info'] .pv-callout-title { color: #236ba4 }
table.wc-callout[data-type='tip'] .pv-callout-title { color: #237553 }
table.wc-callout[data-type='success'] .pv-callout-title { color: #337530 }
table.wc-callout[data-type='example'] .pv-callout-title { color: #743faa }
table.wc-callout[data-type='important'] .pv-callout-title { color: #973d94 }
table.wc-callout[data-type='question'] .pv-callout-title { color: #af3e70 }
table.wc-callout[data-type='warning'] .pv-callout-title { color: #8c6815 }
table.wc-callout[data-type='caution'] .pv-callout-title { color: #9c5315 }
table.wc-callout[data-type='danger'] .pv-callout-title { color: #a53425 }
table.wc-callout[data-type='quote'] .pv-callout-title { color: #5d5a54 }
.pv-callout-head { font-weight: bold; margin: 0 0 3pt; }
.pv-callout-title { font-size: 10.5pt; }
.pv-callout-icon { display: none; }
.pv-callout-body p { margin: 0 0 4pt; font-size: 10pt; line-height: 1.6; text-align: left; }
.pv-callout-body > p:first-child { margin-top: 0; }
.pv-callout-body > p:last-child { margin-bottom: 0; }
/* 数据表格 */
table:not(.wc-code):not(.wc-callout) { border-collapse: collapse; width: 100%;
  margin: 10pt 0; font-size: 10pt; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
th, td { border: 1pt solid #dedbd4; padding: 6pt 9pt; vertical-align: top;
  text-align: center; }
th[align='left'], td[align='left'] { text-align: left; }
th[align='right'], td[align='right'] { text-align: right; }
th { background: #f2f1ed; font-weight: bold; }
/* 图片：居中、不超页宽 */
img { border: 0; display: block; margin: 8pt auto; }
figure { margin: 10pt 0; text-align: center; }
figcaption { font-size: 9pt; color: #8a867c; margin-top: 4pt; text-align: center; }
/* 待办 */
.pv-task { font-family: "Segoe UI Symbol",Arial,sans-serif; }
/* 双链与嵌入 */
.pv-embed { color: #2f6f52; border-bottom: 1pt solid #dedbd4; }
.pv-wlink { color: #2f6f52; text-decoration: underline; }
.pv-wlink.is-missing, .pv-embed.is-missing { color: #8a867c; }
.pv-tag { color: #2f6f52; }
.pv-bid { color: #8a867c; font-size: 9pt; }
/* 代码块标题与语言标签 */
.pv-code-title { font-weight: bold; font-size: 9.5pt; color: #55534e;
  margin: 0 0 3pt; }
.pv-code-lang { font-size: 8.5pt; color: #8a867c; font-weight: bold; }
/* 公式降级：MathML 在 WPS 里靠不住，保底给等宽底色 */
.pv-math, .pv-math-block { font-family: Consolas,monospace; background: #f4f2ec; }
.pv-math-block { display: block; text-align: center; padding: 6pt 0; margin: 8pt 0; }
/* Mermaid 图表：居中 */
.pv-mermaid { text-align: center; margin: 10pt 0; }
.pv-mermaid img { margin: 0 auto; }
/* 折叠块：导出时已展开，给个视觉区分 */
.pv-details { margin: 10pt 0; }
.pv-details summary { font-weight: bold; color: #55534e; margin-bottom: 4pt; }
.pv-details-body { padding-left: 12pt; border-left: 2pt solid #dedbd4; }
/* 分栏标签：导出时摊平，每个标签一段 */
.pv-tabs { margin: 10pt 0; }
.pv-tabbar { display: none; }
.pv-tab-pane { margin: 8pt 0; padding: 6pt 10pt;
  border: 1pt solid #dedbd4; background: #f7f6f3; }
.pv-tab-pane p { margin: 0 0 4pt; font-size: 10.5pt; line-height: 1.72; text-align: justify; }
.pv-tab-label { font-weight: bold; font-size: 10pt; color: #2f6f52; margin: 0 0 4pt; }
/* 脚注 */
.footnotes { margin-top: 16pt; padding-top: 6pt; border-top: 1pt solid #dedbd4;
  font-size: 9pt; color: #55534e; }
.pv-fnback { display: none; }
sup { vertical-align: super; font-size: 8pt; }
sup a { text-decoration: none; }
@page WordSection1 { size: A4; margin: 2.54cm 2.2cm; }
div.WordSection1 { page: WordSection1; }
`

/**
 * 把正文 HTML 改成 Word 认得的结构。
 *
 * 两处必须换掉，都是同一个原因：**Word 不画 div 的边框和底色**。
 *   · 提示块 → 单格表格（左边那条 4.5pt 的粗边就是类型色）
 *   · 代码块 → 单格表格（灰底 + 细框 + 等宽字）
 * 另外待办那个方框是 CSS 画的（::after），Word 里看不见，换成 ☐ / ☒ 字符。
 */
export function wordify(root: HTMLElement) {
  const toCell = (el: Element, cls: string, attrs: string[] = []) => {
    const table = document.createElement('table')
    table.className = cls
    for (const a of attrs) {
      const v = el.getAttribute(a)
      if (v) table.setAttribute(a, v)
    }
    const td = document.createElement('td')
    while (el.firstChild) td.appendChild(el.firstChild)
    const tr = document.createElement('tr')
    tr.appendChild(td)
    table.appendChild(tr)
    el.replaceWith(table)
  }

  /* ── 1. 解包 .pv-table-wrap ──
     预览里表格外面套了一层 div 用来做圆角和 overflow，Word 不认这些，
     留着反而让表格多一层缩进。直接把 table 提出来。 */
  for (const wrap of Array.from(root.querySelectorAll('.pv-table-wrap'))) {
    const table = wrap.querySelector('table')
    if (table) wrap.replaceWith(table)
    else wrap.remove()
  }

  /* ── 2. 分栏标签摊平 ──
     Word 没有 tab 交互，把每个 pane 变成带标题的段落块。 */
  for (const tabs of Array.from(root.querySelectorAll('.pv-tabs'))) {
    const frag = document.createDocumentFragment()
    // 从 tabbar 里取标签文字
    const labels = Array.from(tabs.querySelectorAll('.pv-tab')).map(
      (t) => t.textContent?.trim() ?? '',
    )
    const panes = Array.from(tabs.querySelectorAll('.pv-tab-pane'))
    panes.forEach((pane, i) => {
      const label = labels[i] || pane.getAttribute('data-label') || `标签 ${i + 1}`
      const titleP = document.createElement('p')
      titleP.className = 'pv-tab-label'
      titleP.textContent = `▎${label}`
      frag.appendChild(titleP)
      const div = document.createElement('div')
      div.className = 'pv-tab-pane'
      while (pane.firstChild) div.appendChild(pane.firstChild)
      frag.appendChild(div)
    })
    tabs.replaceWith(frag)
  }

  /* ── 3. 折叠块展开 ──
     <details>/<summary> 是 HTML5 元素，Word 不认。
     换成：summary → 加粗段落，body → 带左边线的 div。 */
  for (const det of Array.from(root.querySelectorAll('details.pv-details, details.pv-fold'))) {
    const div = document.createElement('div')
    div.className = 'pv-details'
    const summary = det.querySelector('summary')
    if (summary) {
      const p = document.createElement('p')
      p.className = 'pv-details-title'
      while (summary.firstChild) p.appendChild(summary.firstChild)
      div.appendChild(p)
      summary.remove()
    }
    const bodyDiv = det.querySelector('.pv-details-body')
    if (bodyDiv) {
      while (bodyDiv.firstChild) div.appendChild(bodyDiv.firstChild)
      bodyDiv.remove()
    }
    while (det.firstChild) div.appendChild(det.firstChild)
    det.replaceWith(div)
  }

  /* ── 4. 提示块 → 单格表格 ── */
  for (const el of Array.from(root.querySelectorAll('.pv-callout'))) {
    // Word / WPS 不认行内 <svg>，图标删掉（类型色条已经表达身份）
    el.querySelectorAll('.pv-callout-icon').forEach((n) => n.remove())
    toCell(el, 'wc-callout', ['data-type'])
  }

  /* ── 5. 行号：CSS 计数器在 Word 里不存在，改成真实文字 ──
     必须在 pre 被替换成表格之前做：属性挂在 pre 上，替换后就找不到了。 */
  for (const pre of Array.from(root.querySelectorAll('pre[data-line-numbers]'))) {
    const lines = pre.querySelectorAll('.pv-line')
    lines.forEach((line, i) => {
      const numSpan = document.createElement('span')
      numSpan.className = 'wc-ln'
      numSpan.textContent = `${String(i + 1).padStart(3, ' ')} \u2502 `
      line.insertBefore(numSpan, line.firstChild)
    })
    pre.removeAttribute('data-line-numbers')
  }

  /* ── 6. 代码块 → 单格表格 ──
     必须包整个 .pv-code-box（含语言标签），不能只包 pre：
     只包 pre 的话，.pv-code-lang 会飘在表格外面，排版断裂。
     带标题的 figure 整块包进去。 */
  for (const el of Array.from(root.querySelectorAll('.pv-code-box'))) {
    if (el.closest('figure.pv-code-fig')) continue
    if (el.closest('table.wc-code')) continue
    toCell(el, 'wc-code')
  }
  for (const el of Array.from(root.querySelectorAll('figure.pv-code-fig'))) {
    toCell(el, 'wc-code')
  }
  /* 兜底：没有 .pv-code-box 包裹的裸 pre（理论上不会出现，保险起见） */
  for (const el of Array.from(root.querySelectorAll('pre'))) {
    if (el.closest('table.wc-code')) continue
    toCell(el, 'wc-code')
  }

  /* ── 7. 拆除代码块里的行内外壳 ──
     toCell 之后 td 里的结构是：.pv-code-box > pre > code > .pv-line
     而 inlineWordStyles 会把 .pv-line 换成 <p>（块级）。
     <code> 是行内元素，<pre> 也不该嵌套 <p>，Word 解析时会把结构拆散，
     导致代码全部挤成一行。这里把 code / pre / .pv-code-box 逐层拆掉，
     让 td 里直接是 .pv-code-lang + 代码行，干净利落。 */
  const unwrap = (el: Element) => {
    const parent = el.parentNode
    if (!parent) return
    while (el.firstChild) parent.insertBefore(el.firstChild, el)
    parent.removeChild(el)
  }
  for (const code of Array.from(root.querySelectorAll('table.wc-code code'))) unwrap(code)
  for (const pre of Array.from(root.querySelectorAll('table.wc-code pre'))) unwrap(pre)
  for (const box of Array.from(root.querySelectorAll('table.wc-code .pv-code-box'))) unwrap(box)

  /* ── 8. 待办方框 ── */
  for (const el of Array.from(root.querySelectorAll('.pv-task'))) {
    el.textContent = el.classList.contains('on') ? '\u2612' : '\u2610'
  }

  /* ── 9. 段落内的 <br> 拆成独立段落 ──
     Word 把 HTML 的 <br> 当成「软回车」，而软回车**同样参与两端对齐**：
     一个段落里挤出多行时（`**作者：豆包**<br>**版本：v2.0**<br>…`），
     每一行都会被强行拉满整行宽，短行的字间距就被扯得七零八落 ——
     用户看到的「作者　：　　豆　包」就是这么来的。
     拆成各自独立的 <p> 之后，每段只有一行，那是段落末行，justify 不碰它。
     行距给一点点（2pt）而不是归零：这些行原本是同段，拆开后不该散得太开。 */
  for (const p of Array.from(root.querySelectorAll('p'))) {
    if (!p.querySelector('br')) continue
    const base = p.getAttribute('style') ?? ''
    const makeP = () => {
      const np = document.createElement('p')
      np.setAttribute('style', base ? `${base};margin:0 0 2pt;` : 'margin:0 0 2pt;')
      return np
    }
    const frag = document.createDocumentFragment()
    let cur = makeP()
    for (const kid of Array.from(p.childNodes)) {
      if (kid.nodeType === 1 && (kid as Element).tagName === 'BR') {
        // 空行留一个不换行空格，否则 Word 会把它整个并掉
        if (!cur.firstChild) cur.appendChild(document.createTextNode('\u00A0'))
        frag.appendChild(cur)
        cur = makeP()
        continue
      }
      cur.appendChild(kid)
    }
    if (cur.firstChild) frag.appendChild(cur)
    p.replaceWith(frag)
  }

  /* ── 10. Mermaid 源码块移除 ── */
  for (const el of Array.from(root.querySelectorAll('.pv-mermaid'))) {
    el.querySelectorAll('.pv-mermaid-src').forEach((n) => n.remove())
  }

  /* ── 11. 脚注回链移除（静态文档里点不动） ── */
  for (const el of Array.from(root.querySelectorAll('.pv-fnback'))) {
    el.remove()
  }

  /* ── 12. hr 换成 Word 认的结构 ──
     Word 对 CSS border-top 的 <hr> 支持不稳定，换成一个单格表格画线。 */
  for (const hr of Array.from(root.querySelectorAll('hr'))) {
    const table = document.createElement('table')
    table.className = 'wc-hr'
    table.setAttribute('style', 'width:100%;border-collapse:collapse;margin:14pt 0;')
    const tr = document.createElement('tr')
    const td = document.createElement('td')
    td.setAttribute('style', 'border:none;border-top:1pt solid #dedbd4;padding:0;height:0;')
    td.innerHTML = '&nbsp;'
    tr.appendChild(td)
    table.appendChild(tr)
    hr.replaceWith(table)
  }

  inlineWordStyles(root)
}

/**
 * 排版规则**逐元素内联**。
 *
 * Word 和 WPS 对 HTML 里 `<style>` 块的支持都没个准谱：MS Word 大体认，
 * WPS 时认时不认，一不认就退回它自己的默认样式 —— 标题变成 Calibri Light
 * 的蓝色大字、正文 11px 宋体、代码块没了等宽，整篇就成了用户说的「乱」。
 * 内联 style 是唯一两边都乖乖照办的通道，所以关键规则在 wordify 之后
 * 再逐元素敲死一遍（数值与 WORD_CSS 一致，那份留着兜底）。
 */
const WORD_CALLOUT_COLORS: Record<string, [string, string]> = {
  note: ['#5b60d6', '#eef0fb'],
  info: ['#2a7fc0', '#ecf4fb'],
  tip: ['#2c8f63', '#ecf6f1'],
  success: ['#3f8f3a', '#eef6ea'],
  example: ['#8a4fc9', '#f3edfb'],
  important: ['#b34bb0', '#f9edf9'],
  question: ['#cf4b86', '#fceef5'],
  warning: ['#a67c1a', '#fbf4e4'],
  caution: ['#b8641a', '#fcf0e6'],
  danger: ['#c33f2c', '#fceceb'],
  quote: ['#6f6c66', '#f4f3f0'],
}

const WORD_HL_COLORS: Record<string, string> = {
  'cm-hl-keyword': '#8a4e30',
  'cm-hl-string': '#2d7a56',
  'cm-hl-number': '#b56a16',
  'cm-hl-func': '#3d5f8f',
  'cm-hl-type': '#6a548f',
  'cm-hl-prop': '#5c6848',
  'cm-hl-operator': '#8a4e30',
  'cm-hl-punct': '#6b6862',
  'cm-hl-var': '#6b6862',
  'cm-hl-comment': '#8d8a83',
}

export function inlineWordStyles(root: HTMLElement) {
  const stamp = (el: Element, css: string) => {
    const old = el.getAttribute('style')
    el.setAttribute('style', old ? `${css};${old}` : css)
  }
  const each = (sel: string, css: string, skip = '') => {
    for (const el of Array.from(root.querySelectorAll(sel))) {
      if (skip && el.closest(skip)) continue
      stamp(el, css)
    }
  }

  // 标题：字号、颜色、段前段后全部敲死，不给 Word 的内置标题样式留缝
  const h = (size: string, color: string, extra = '') =>
    `font-size:${size};font-weight:bold;color:${color};margin:14pt 0 6pt;line-height:1.35;${extra}`
  each('h1', `font-size:20pt;font-weight:bold;color:#1e1d1a;margin:0 0 6pt;line-height:1.35;border-bottom:1pt solid #dedbd4;padding-bottom:4pt;`)
  each('h2', h('16pt', '#1e1d1a', 'border-bottom:1pt solid #dedbd4;padding-bottom:3pt;'))
  each('h3', h('14pt', '#1e1d1a'))
  each('h4', h('12.5pt', '#1e1d1a'))
  each('h5', h('11pt', '#55534e'))
  each('h6', h('10.5pt', '#8a867c'))
  // 正文：中文文档的通行排法 —— 两端对齐 + 固定行距
  const body = 'font-size:10.5pt;line-height:1.72;text-align:justify;'
  each('p', `${body}margin:0 0 6pt;`, '.wc-code,.wc-callout,.pv-tab-pane,.pv-tab-label,.pv-details-title')
  each('li', `${body}margin:0 0 3pt;`)
  each('ul,ol', 'margin:0 0 8pt;padding-left:22pt;')
  each('blockquote',
    'margin:10pt 0 10pt 12pt;padding:4pt 0 4pt 12pt;border-left:3pt solid #2f6f52;background:#f2f5f3;color:#55534e;')
  each('code', 'font-family:Consolas,"Courier New",monospace;font-size:9.5pt;background:#f4f2ec;',
    '.wc-code')
  each('a', 'color:#2f6f52;text-decoration:underline;')
  each('mark', 'background:#f6e3a8;')
  each('del,s', 'color:#8a867c;')
  // 图片：居中 + 不超页宽
  each('img', 'border:0;display:block;margin:8pt auto;')
  each('figure', 'margin:10pt 0;text-align:center;')
  each('figcaption', 'font-size:9pt;color:#8a867c;margin-top:4pt;text-align:center;', '.pv-code-title')
  each('.pv-task', 'font-family:"Segoe UI Symbol",Arial,sans-serif;')
  each('.pv-code-lang', 'font-size:8.5pt;color:#8a867c;font-family:Consolas,"Courier New",monospace;')
  each('.pv-code-title', 'font-weight:bold;font-size:9.5pt;color:#55534e;margin:0 0 3pt;')
  // 行号 span
  each('.wc-ln', 'font-family:Consolas,"Courier New",monospace;font-size:8pt;color:#8a867c;')
  // 高亮行
  each('p[style*="background:#eef4f0"]', '')
  // 正文数据表：对齐尊重原表的 align 属性（左/右对齐别被居中盖掉）
  const tableCellCss = (el: Element, base: string) => {
    const align = el.getAttribute('align')
    return `${base}text-align:${align && align !== 'center' ? align : 'center'};`
  }
  for (const el of Array.from(
    root.querySelectorAll('table:not(.wc-code):not(.wc-callout):not(.wc-hr) th'),
  )) {
    stamp(el, tableCellCss(el, 'border:1pt solid #dedbd4;background:#f2f1ed;font-weight:bold;padding:6pt 9pt;'))
  }
  for (const el of Array.from(
    root.querySelectorAll('table:not(.wc-code):not(.wc-callout):not(.wc-hr) td'),
  )) {
    stamp(el, tableCellCss(el, 'border:1pt solid #dedbd4;padding:6pt 9pt;'))
  }
  // 代码块表格
  each('table.wc-code td',
    'border:1pt solid #e2ded4;background:#f7f6f2;padding:8pt 10pt;font-family:Consolas,"Courier New",monospace;font-size:9pt;line-height:1.6;text-align:left;')
  /* 「不跨页」要看块有多长 —— 一刀切会把翻页节奏搞乱。
     <style> 里给代码块和提示块统一写了 page-break-inside:avoid，本意是
     不让一个短块被切成两半。可一条四十行的代码块也照此办理时，Word 只剩
     「整块推到下一页」这一条路，上一页于是留下半页空白 —— 用户看到的就是
     大段大段的空白。短块保留 avoid（整体性更要紧），长块放开让 Word 自己找断点。 */
  for (const el of Array.from(root.querySelectorAll('table.wc-code, table.wc-callout'))) {
    // 数 .pv-line —— 此刻代码行还是 span（换成 <p> 是 inlineWordStyles 的最后一步），
    // 数 td p 会一律得 0，长块判定就永远不成立。
    const rows = el.querySelectorAll('td .pv-line').length || el.querySelectorAll('td p').length || 1
    stamp(el, `border-collapse:collapse;width:100%;page-break-inside:${rows > 12 ? 'auto' : 'avoid'};`)
  }
  // 提示块表格：左边一条类型色粗边是它的身份
  for (const el of Array.from(root.querySelectorAll('table.wc-callout'))) {
    const type = el.getAttribute('data-type') ?? 'note'
    const [bar, bg] = WORD_CALLOUT_COLORS[type] ?? WORD_CALLOUT_COLORS.note
    stamp(el, 'border-collapse:collapse;width:100%;margin:12pt 0;')
    for (const td of Array.from(el.querySelectorAll('td'))) {
      stamp(td,
        `border:1pt solid #dedbd4;border-left:4.5pt solid ${bar};background:${bg};padding:8pt 11pt;text-align:left;`)
    }
    const head = el.querySelector('.pv-callout-head')
    if (head) stamp(head, 'font-weight:bold;margin:0 0 3pt;')
    const title = el.querySelector('.pv-callout-title')
    if (title) stamp(title, `font-size:10.5pt;color:${bar};`)
  }
  // 代码高亮：类选择器在 WPS 里靠不住，颜色直接写到 span 上
  for (const el of Array.from(root.querySelectorAll('[class*="cm-hl-"]'))) {
    const cls = Array.from(el.classList).find((c) => WORD_HL_COLORS[c])
    if (cls) stamp(el, `color:${WORD_HL_COLORS[cls]};`)
  }
  // 分栏标签摊平后的样式
  each('.pv-tab-label', 'font-weight:bold;font-size:10pt;color:#2f6f52;margin:8pt 0 3pt;')
  each('.pv-tab-pane', 'margin:0 0 8pt;padding:6pt 10pt;border:1pt solid #dedbd4;background:#f7f6f3;')
  each('.pv-tab-pane p', 'margin:0 0 4pt;text-align:justify;font-size:10.5pt;line-height:1.72;')
  // callout 内部段落（被 each('p') 跳过，这里补打）
  each('.wc-callout p', 'margin:0 0 4pt;text-align:left;font-size:10pt;line-height:1.6;')
  // 折叠块展开后
  each('.pv-details', 'margin:10pt 0;')
  each('.pv-details-title', 'font-weight:bold;color:#55534e;margin:0 0 4pt;')
  // Mermaid 图表居中
  each('.pv-mermaid', 'text-align:center;margin:10pt 0;')
  // 脚注区
  each('.footnotes', 'margin-top:16pt;padding-top:6pt;border-top:1pt solid #dedbd4;font-size:9pt;color:#55534e;')

  /* 代码的每一行必须是**真的块级元素**。
     预览里一行就是一个 `<span class="pv-line">`，换行靠 CSS `display:block` 撑；
     Word / WPS 不认这条规则，整段代码于是糊成一行。
     换成 `<p>` 后 Word 一定当段落处理。
     注意：wordify 已经把 pre/code/.pv-code-box 外壳拆掉了，这里的 .pv-line
     直接在 table.wc-code 的 td 里，所以 p 上要带全等宽字体与换行规则。 */
  for (const el of Array.from(root.querySelectorAll('.pv-line'))) {
    const p = document.createElement('p')
    let css = 'margin:0;padding:0;line-height:1.55;text-align:left;' +
      'font-family:Consolas,"Courier New",monospace;font-size:9pt;' +
      'white-space:pre-wrap;word-break:break-all;color:#3b3934;'
    if (el.classList.contains('is-hl')) css += 'background:#eef4f0;'
    const old = el.getAttribute('style')
    p.setAttribute('style', old ? `${css};${old}` : css)
    while (el.firstChild) p.appendChild(el.firstChild)
    // 空行留一个不换行空格，不然 Word 会把它并掉
    if (!p.firstChild) p.appendChild(document.createTextNode('\u00A0'))
    // 缩进：HTML 会把行首的空格并掉，换成不换行空格才保得住代码的层次
    const lead = p.firstChild
    if (lead && lead.nodeType === Node.TEXT_NODE) {
      const m = /^[ \t]+/.exec(lead.nodeValue ?? '')
      if (m) {
        lead.nodeValue =
          '\u00A0'.repeat(m[0].length) + (lead.nodeValue ?? '').slice(m[0].length)
      }
    }
    el.replaceWith(p)
  }

  // callout 最后一段去掉底部间距（必须在所有 p 样式之后执行，确保覆盖生效）
  for (const el of Array.from(root.querySelectorAll('.wc-callout .pv-callout-body > p:last-child'))) {
    stamp(el, 'margin-bottom:0;')
  }
}

/**
 * 给每张图钉死像素尺寸。
 *
 * Word 不认 `max-width`：只写百分比的话它按图片**原始像素**排版。
 * 图表是 2 倍图，一张就两千多像素宽 —— 铺出去两三页、还捅破页边距，
 * 就是用户说的「图表显得特别大特别大」。
 * Word 认的是 `width` / `height` 属性（按 96dpi 折算），所以这里按 A4
 * 正文宽度封顶（页边距各 2.54cm，正文约 15.9cm ≈ 600px），等比例算高；
 * 本来比正文窄的图维持原尺寸，不放大。
 */
const WORD_IMG_MAX_PX = 580

export async function fitWordImages(root: HTMLElement) {
  const imgs = Array.from(root.querySelectorAll('img'))
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          const apply = (w: number, h: number) => {
            if (w > 0 && h > 0) {
              const k = Math.min(1, WORD_IMG_MAX_PX / w)
              const ow = Math.max(1, Math.round(w * k))
              const oh = Math.max(1, Math.round(h * k))
              img.setAttribute('width', String(ow))
              img.setAttribute('height', String(oh))
              const old = img.getAttribute('style')
              img.setAttribute('style', `width:${ow}px;height:${oh}px;${old ? old + ';' : ''}`)
            }
            resolve()
          }
          if (img.naturalWidth > 0) return apply(img.naturalWidth, img.naturalHeight)
          const src = img.getAttribute('src') ?? ''
          if (!src) return resolve()
          const probe = new Image()
          probe.onload = () => apply(probe.naturalWidth, probe.naturalHeight)
          probe.onerror = () => resolve()
          probe.src = src
        }),
    ),
  )
}

/** Markdown → 正文 HTML（和预览同一套解析与高亮） */

/* ── MathML → OMML（Word 原生公式格式） ──
   Word / WPS 对 W3C MathML 支持极差（实测会把公式显示成 LaTeX 源码）。
   OMML 才是它们的一等公民：HTML 里嵌 <m:oMath>、根元素声明 m 命名空间，
   两种打开器都会转成真正的公式对象。这里把 KaTeX 输出的 MathML 递归
   翻译成 OMML，覆盖常见节点（分数 / 上下标 / 根式 / 运算符 / 文本）。 */

function ommLText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function mathmlToOmmL(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node.textContent ?? '').trim()
    if (!t) return ''
    return `<m:r><m:t xml:space="preserve">${ommLText(t)}</m:t></m:r>`
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as Element
  const tag = el.tagName.toLowerCase()
  const kids = () => Array.from(el.childNodes).map(mathmlToOmmL).join('')
  const child = (i: number) => (el.children[i] ? mathmlToOmmL(el.children[i]!) : '')
  switch (tag) {
    case 'math':
    case 'semantics':
    case 'mrow':
    case 'mstyle':
    case 'menclose':
    case 'mtr':
    case 'mtd':
    case 'mtable':
      return kids()
    case 'mi':
      // 变量名斜体，像真正的公式
      return `<m:r><m:rPr><m:sty m:val="i"/></m:rPr><m:t>${ommLText(el.textContent ?? '')}</m:t></m:r>`
    case 'mn':
    case 'mo':
    case 'mtext':
      return `<m:r><m:t>${ommLText(el.textContent ?? '')}</m:t></m:r>`
    case 'mspace':
      return `<m:r><m:t xml:space="preserve"> </m:t></m:r>`
    case 'msup':
      return `<m:sSup><m:e>${child(0)}</m:e><m:sup>${child(1)}</m:sup></m:sSup>`
    case 'msub':
      return `<m:sSub><m:e>${child(0)}</m:e><m:sub>${child(1)}</m:sub></m:sSub>`
    case 'msubsup':
      return `<m:sSubSup><m:e>${child(0)}</m:e><m:sub>${child(1)}</m:sub><m:sup>${child(2)}</m:sup></m:sSubSup>`
    case 'mfrac':
      return `<m:f><m:num>${child(0)}</m:num><m:den>${child(1)}</m:den></m:f>`
    case 'msqrt':
      return `<m:rad><m:deg/><m:e>${kids()}</m:e></m:rad>`
    case 'mroot':
      return `<m:rad><m:deg>${child(1)}</m:deg><m:e>${child(0)}</m:e></m:rad>`
    case 'mover':
    case 'munder':
    case 'munderover':
    case 'mphantom':
      return kids()
    case 'annotation':
    case 'mprescripts':
    case 'none':
      return ''
    default:
      return kids()
  }
}

/** 把 Word 分支的公式（KaTeX MathML）全部换成 OMML 对象。
 *
 * OMML 是大小写敏感的 XML（m:oMath 必须精确匹配），而 DOM 序列化会把
 * 未声明命名空间的标签小写成 m:omath —— Word 就不认了。所以这里先用
 * 私用区字符占位，等 innerHTML 序列化完成后再做字符串级替换。 */
export function mathToOmmL(root: HTMLElement): Array<[string, string]> {
  const placeholders: Array<[string, string]> = []
  let idx = 0
  for (const el of Array.from(
    root.querySelectorAll('.pv-math.is-rendered, .pv-math-block.is-rendered'),
  )) {
    const math = el.querySelector('math')
    if (!math) continue
    const inner = Array.from(math.childNodes).map(mathmlToOmmL).join('')
    const oMath = `<m:oMath>${inner}</m:oMath>`
    const ph = `\uE000M${idx++}\uE001`
    if (el.classList.contains('pv-math-block')) {
      const div = document.createElement('div')
      div.className = 'pv-math-block'
      div.setAttribute('style', 'text-align:center;margin:8pt 0;')
      div.textContent = ph
      el.replaceWith(div)
    } else {
      el.replaceWith(document.createTextNode(ph))
    }
    placeholders.push([
      ph,
      el.classList.contains('pv-math-block') ? `<m:oMathPara>${oMath}</m:oMathPara>` : oMath,
    ])
  }
  return placeholders
}

/**
 * 把 Markdown 摊成导出用的 HTML 片段，外加这份笔记**额外需要**的样式。
 *
 * 变换链跟预览**完全一致**（`highlightFences` → `enhancePreview`）：
 * 提示块、分栏标签、折叠、高亮、嵌入、公式、图表、表格包裹全在这一步。
 * 早先导出只跑了 `highlightFences`，于是预览里是提示块的，导出来是一段
 * `> [!TIP]` 原文；预览里是表格圆角的，导出来是没包裹的方框表。
 * 少走这一步，导出和屏幕上就是两样东西。
 *
 * 之后再把这几个「预览里靠 JS 补出来」的东西真正渲染出来：
 *   · Mermaid —— 渲染成内联 SVG 塞回去（SVG 自带样式，不依赖外部文件）；
 *   · 公式 —— KaTeX 的 HTML，样式与字体由 extraCss 带（见 export-style.ts）。
 * 不渲染的话导出来就是一块空的图表容器加一堆 `$...$`。
 *
 * `forWord` 换一套输出：图表光栅化成 PNG、公式出 MathML。
 * Word 的 HTML 解析器既不认行内 `<svg>` 也不认 KaTeX 那套 span 布局，
 * 但对 `<img>` 和 `<math>` 都是一等公民。Word 那一路不需要额外样式 ——
 * 它自己排公式，把浏览器的 CSS 塞进去反而会打架。
 *
 * 渲染在一个游离的容器里做，不进页面 DOM，所以不会闪一下。
 */
export async function renderExportBody(
  md: string,
  forWord = false,
): Promise<{ body: string; extraCss: string }> {
  const { marked } = await getMarked()
  const raw = marked.parse(prepareMarkdown(md), { async: false }) as string
  let body = absolutizeMedia(enhancePreview(await highlightFences(raw)).html)

  const hasGraph = body.includes('pv-mermaid-graph')
  const hasMath = body.includes('pv-math')

  // 导出**总是**要把 HTML 挂上 DOM 过一遍：
  // · Word 那条路靠 wordify 把提示块/代码块换成表格；
  // · HTML/PDF 那条路也要做后处理（强制 details 展开、tabs 加标签、去脚注回链）。
  const host = document.createElement('div')
  host.innerHTML = body
  let ommLPlaceholders: Array<[string, string]> = []
  // light: true —— 导出的终点永远是白底（Word 白纸 / PDF 白页 / HTML 白背景），
  // 深色主题下算出的浅色线条放上去会整张隐形，所以强制按浅色渲染。
  if (hasGraph) await renderMermaidInHtml(host, { asImage: forWord, light: true })
  if (hasMath) await renderMathInHtml(host, forWord ? { output: 'mathml' } : {})

  if (forWord) {
    if (hasMath) ommLPlaceholders = mathToOmmL(host)
    await fitWordImages(host)
    wordify(host)
  } else {
    // HTML/PDF 后处理
    postProcessForHtml(host)
  }

  body = host.innerHTML
  // OMML 不能进 DOM（标签会被小写化），序列化之后再从占位符换成真身
  for (const [ph, om] of ommLPlaceholders) body = body.split(ph).join(om)

  // 公式样式（含 base64 字体）只有真有公式时才值得带上，约 340KB
  const extraCss = hasMath && !forWord ? (await import('@/editor/export-style')).katexExportCss() : ''
  return { body, extraCss }
}

/**
 * HTML / PDF 导出的后处理。
 *
 * 预览里有些交互元素在静态文件里没有意义，导出前统一摊平：
 *   · <details> 强制展开（加 open 属性），否则导出来是收起的，内容看不见
 *   · .pv-tab-pane 加 data-label（CSS ::before 要用它显示标签名）
 *   · 脚注回链 ↩ 移除（静态文件里点不动，留着是一个无意义的箭头）
 *   · .pv-mermaid-src 移除（图已画好，源码块是加载中的替身）
 */
export function postProcessForHtml(root: HTMLElement) {
  // 强制展开所有折叠块
  for (const det of Array.from(root.querySelectorAll('details'))) {
    det.setAttribute('open', '')
  }
  // 给每个 tab-pane 加上 data-label（从 tabbar 里取对应文字）
  for (const tabs of Array.from(root.querySelectorAll('.pv-tabs'))) {
    const labels = Array.from(tabs.querySelectorAll('.pv-tab')).map(
      (t) => t.textContent?.trim() ?? '',
    )
    const panes = Array.from(tabs.querySelectorAll('.pv-tab-pane'))
    panes.forEach((pane, i) => {
      if (!pane.getAttribute('data-label')) {
        pane.setAttribute('data-label', labels[i] || `标签 ${i + 1}`)
      }
    })
  }
  // 移除脚注回链
  for (const el of Array.from(root.querySelectorAll('.pv-fnback'))) {
    el.remove()
  }
  // 移除 mermaid 源码块（图已渲染好）
  for (const el of Array.from(root.querySelectorAll('.pv-mermaid-src'))) {
    el.remove()
  }
}

function escapeHtmlText(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function htmlDocument(title: string, body: string, extraCss = '') {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="Nota">
<title>${escapeHtmlText(title)}</title>
<style>${EXPORT_CSS}</style>${extraCss ? `\n<style>${extraCss}</style>` : ''}
</head>
<body>
${body}
</body>
</html>`
}

/**
 * Word 只认自己那套命名空间。给它一份带 `w:WordDocument` 声明的 HTML、
 * 存成 .doc，Word / WPS 打开就是一篇正常文档（标题、列表、表格都在）。
 * 不去拼 OOXML：那需要 ZIP 打包，为一个导出把体积和复杂度都抬上去不值。
 */
export function wordDocument(title: string, body: string) {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>${escapeHtmlText(title)}</title>
<!--[if gte mso 9]>
<xml>
 <w:WordDocument>
  <w:View>Print</w:View>
  <w:Zoom>100</w:Zoom>
  <w:DoNotOptimizeForBrowser/>
 </w:WordDocument>
</xml>
<![endif]-->
<style>
${WORD_CSS}
</style>
</head>
<body style="font-family:'等线','DengXian','Microsoft YaHei','PingFang SC',sans-serif;font-size:10.5pt;line-height:1.72;color:#24231f;">
<div class="WordSection1">
${body}
</div>
</body>
</html>`
}

/**
 * 导出某一篇笔记。
 *
 * @param path 目标笔记（右键菜单可以对准任意一篇，不只是打开的那篇）
 */
async function exportNoteAs(path: string, kind: ExportKind): Promise<string | null> {
  const name = baseNameOf(path)
  const md = path === state.activePath ? state.draft : ((await window.api.readNote(path)) ?? '')
  if (kind === 'md') {
    return window.api.exportSave({ defaultName: `${name}.md`, kind, data: md })
  }
  const body = await renderExportBody(md, kind === 'word')
  if (kind === 'pdf') {
    return window.api.exportPdf({ defaultName: `${name}.pdf`, html: htmlDocument(name, body.body, body.extraCss) })
  }
  if (kind === 'word') {
    return window.api.exportSave({
      defaultName: `${name}.doc`,
      kind,
      data: wordDocument(name, body.body),
    })
  }
  return window.api.exportSave({
    defaultName: `${name}.html`,
    kind,
    data: htmlDocument(name, body.body, body.extraCss),
  })
}

/** 顶栏那个导出下拉用的入口：对准当前打开的那篇。
    四种格式与右键菜单完全一致 —— 只放两种的时候，想在顶栏导 PDF 的人
    会以为「这个软件导不了 PDF」。 */
async function exportNote(kind: ExportKind) {
  if (!state.activePath) return null
  return exportNoteAs(state.activePath, kind)
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

/** 侧栏显隐 */
function toggleSidebar() {
  state.sidebar = !state.sidebar
  localStorage.setItem('nota-sidebar', state.sidebar ? '1' : '0')
}

/* ── 中间那一列：一个栏放四件事 ──
   笔记列表、附件库、回收站、AI 编写，性质不同但「都是某一类东西的清单」，
   共用一列换着看，比各开一个窗口省事：主区永远留给正文/AI 对话，
   不用为了插一张图离开正在写的笔记。

   AI 编写也从「占满主区的独立页面」改成这一列的第四格 —— 开着对话
   还能看着正文，才是它真正的用法。 */
export type ColumnView = 'notes' | 'outline' | 'quote' | 'attach' | 'trash' | 'ai'

/** 中间那一列的固定页签：笔记这一类里的三种看法。附件库 / 回收站 / AI 各占一屏，
    它们由侧栏的入口切过去，不挤在这三个格子里 —— 参考图就是这么分的。 */
export const NOTE_TABS: ColumnView[] = ['notes', 'outline', 'quote']
const COLUMN_VIEWS: ColumnView[] = ['notes', 'outline', 'quote', 'attach', 'trash', 'ai']

const COLUMN_KEY = 'nota-column'
/** 中间那一列是不是还在「自适应」（人拖过就变 0） */
const COLUMN_AUTO_KEY = 'nota-column-auto'
const AI_NOTE_KEY = 'nota-ai-note'
const AI_WITH_NOTE_KEY = 'nota-ai-withnote'
const AI_WEB_KEY = 'nota-ai-web'

/**
 * 关系图的开关。
 *
 * 打开时主区换成关系图，但**不清掉当前打开的笔记** —— 从图上点一篇过去、
 * 再回到正文，是它最主要的用法；关掉图就该还在原来那一篇上。
 */
function toggleGraph() {
  state.graphOpen = !state.graphOpen
}

function setColumnView(v: ColumnView) {
  state.columnView = v
  // 两者是同一个意思的两种写法：mainView 给「主区在看什么」，columnView 给这一列
  state.mainView = v === 'ai' ? 'ai' : 'note'
  localStorage.setItem(COLUMN_KEY, v)
}

/* ── 各栏宽度：拖动分隔线改的就是这几个值 ──
   都带上下限，免得被拖成 0 或者宽到把正文挤没。 */
export const WIDTH_LIMITS = {
  sidebar: { min: 180, max: 420, collapsed: 48 },
  column: { min: 220, max: 560, collapsed: 34 },
  outline: { min: 140, max: 340 },
} as const

type WidthKey = keyof typeof WIDTH_LIMITS

function clampWidth(key: WidthKey, v: number) {
  const { min, max } = WIDTH_LIMITS[key]
  return Math.max(min, Math.min(max, Math.round(v)))
}

/** 侧栏此刻实际占多宽（收成窄轨时是 48，不是它存着的宽度） */
/**
 * 侧栏此刻实际占多宽。
 *
 * 除了「存的那个值」和「窗口宽度」，还得再收一道上限：把资料栏的最小宽度和
 * 编辑区的最小宽度先让出来，剩下的才是侧栏能占的。
 * 少了这道上限，在宽窗口里把侧栏拖到 420 的人换个 960 的窄窗口，
 * 三栏加起来就超过了窗口宽度 —— 以前这时会把资料栏整栏收掉顶账，
 * 现在资料栏常驻，只能让侧栏自己退。
 *
 * 这一路**只用常量算**：不能去问 `effectiveColumnWidth`，那条路会绕回来
 * 问 `sidebarNow`，两个函数互相等对方先给个数。
 */
export function sidebarNow(winW: number = window.innerWidth) {
  if (!state.sidebar) return WIDTH_LIMITS.sidebar.collapsed
  const cap = Math.max(
    WIDTH_LIMITS.sidebar.min,
    winW - WIDTH_LIMITS.column.min - EDITOR_MIN_WIDTH,
  )
  return Math.max(WIDTH_LIMITS.sidebar.min, Math.min(state.sidebarWidth, winW, cap))
}

/* ── 资料栏常驻 ──
   这一列没有收起：笔记列表、大纲、引用、AI 都长在这一列上，
   收掉等于整个应用只剩一个编辑器 —— 放在 Note 里就没有「不要资料栏」的用法。
   侧栏（工作区导航）才是有收放的那一个，因为它是「偶尔看一眼」的。
   窄窗要让宽，靠的是拖中间的分割线（sidebarNow 会给侧栏收上限），不靠藏一整列。 */
/** 中间那一列最多能占多少：先把侧栏和编辑区各自的那份让出来，剩下的才是它的。
    少了这一步，拖动 / 自适应都可能把编辑区压到没地方放顶行，最后挤出去的是窗口按钮。 */
export function maxColumnWidth(winW: number = window.innerWidth) {
  return Math.max(WIDTH_LIMITS.column.min, winW - sidebarNow(winW) - EDITOR_MIN_WIDTH)
}

/** 反过来给侧栏算上限（同一个道理，只是换一边让路） */
export function maxSidebarWidth(winW: number = window.innerWidth) {
  const colW = Math.min(effectiveColumnWidth(winW), WIDTH_LIMITS.column.min)
  return Math.max(WIDTH_LIMITS.sidebar.min, winW - colW - EDITOR_MIN_WIDTH)
}

function setWidth(key: WidthKey, v: number) {
  let next = clampWidth(key, v)
  // 两边都不许把编辑区挤到它站不住的地方：写在广阔的窗口里拖宽过的比例，
  // 换个窄窗口不一定还成立。
  if (key === 'sidebar') next = Math.max(WIDTH_LIMITS.sidebar.min, Math.min(next, maxSidebarWidth()))
  else if (key === 'column') {
    next = Math.max(WIDTH_LIMITS.column.min, Math.min(next, maxColumnWidth()))
    state.columnWidth = next
    // 人自己拖过，就别再拿自适应覆盖他的选择（这个决定要跟着人走，重启也别偷偷改回来）
    state.columnAuto = false
    localStorage.setItem(COLUMN_AUTO_KEY, '0')
  } else state.outlineWidth = next
  if (key === 'sidebar') state.sidebarWidth = next
  localStorage.setItem(`nota-w-${key}`, String(next))
  return next
}

/** 每个视图「刚刚好」要占窗口的多少。
    聊天要的是能读成句的行宽，笔记列表要的是扫一眼能看全一屏，
    两者差得不少 —— 一个固定比例必然有一边别扭，所以按视图各给一个。 */
const AUTO_RATIO: Record<string, { r: number; max: number }> = {
  ai: { r: 0.32, max: 520 },
  notes: { r: 0.22, max: 340 },
  outline: { r: 0.22, max: 340 },
  quote: { r: 0.22, max: 340 },
  attach: { r: 0.26, max: 400 },
  trash: { r: 0.26, max: 400 },
}

/** 编辑区再挤也不能比这更窄：再窄顶行那一排就装不下了（每一栏都留着自己的底线）。
    顶行自己还有一套「挤窄降级」（见 EditorPane 的 data-crammed），两者配合着用。 */
export const EDITOR_MIN_WIDTH = 520

/** 中间那一列的「自适应」宽度：窗口越宽它越宽，但始终给编辑区留够地方。
    上下都收在 WIDTH_LIMITS.column 里，跟拖动时的钳制保持一致。 */
export function autoColumnWidth(winW: number, view: string = 'notes') {
  const { r, max } = AUTO_RATIO[view] ?? AUTO_RATIO.notes
  return clampWidth('column', Math.min(winW * r, max, maxColumnWidth(winW)))
}

/** 中间那一列现在实际占多宽：自适应时是算出来的，人手动调过就是存的那个值。
    拖动分隔线必须从「眼睛看到的这个宽度」起算 —— 拿 state.columnWidth 当起点的话，
    自适应状态下第一拖会莫名其妙地跳一下（存的 296 和显示的 330 不是一回事）。 */
export function effectiveColumnWidth(winW: number = window.innerWidth) {
  // 从「上次那个宽窗口」恢复到窄窗口时，存着的宽度可能已经站不下了 —— 照样收一次上限
  const cap = maxColumnWidth(winW)
  return Math.min(state.columnAuto ? autoColumnWidth(winW, state.columnView) : state.columnWidth, cap)
}

/** 回到自适应（双击中间那道分隔线）。
    宽度照样落盘 —— 下次再拖是从这个宽度起步，只是「自适应」这个开关重新打开。 */
function resetColumnWidth() {
  const next = autoColumnWidth(window.innerWidth, state.columnView)
  state.columnWidth = next
  state.columnAuto = true
  localStorage.setItem('nota-w-column', String(next))
  localStorage.setItem(COLUMN_AUTO_KEY, '1')
  return next
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
  // 换了筛选条件，中间那一列得回到笔记列表 —— 停在附件库或大纲上
  // 会让「我点了最近编辑」看起来毫无反应
  showNoteList()
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
  // 注意这里**不读** `nota-column-open`：资料栏已经改成常驻，没有收起一说。
  // 留着那个键不读也不删 —— 万一哪天又想让它可收，旧用户的上次选择还在。
  const cv = localStorage.getItem(COLUMN_KEY)
  if (cv && (COLUMN_VIEWS as string[]).includes(cv)) {
    state.columnView = cv as ColumnView
    state.mainView = cv === 'ai' ? 'ai' : 'note'
  }
  const an = localStorage.getItem(AI_NOTE_KEY)
  state.aiNote = an && an.length ? an : null
  state.aiWithNote = localStorage.getItem(AI_WITH_NOTE_KEY) !== '0'
  state.aiWeb = localStorage.getItem(AI_WEB_KEY) === '1'
  for (const key of ['sidebar', 'column', 'outline'] as WidthKey[]) {
    const raw = Number(localStorage.getItem(`nota-w-${key}`))
    if (raw > 0) {
      const next = clampWidth(key, raw)
      if (key === 'sidebar') state.sidebarWidth = next
      else if (key === 'column') state.columnWidth = next
      else state.outlineWidth = next
    }
  }
  // 「自适应」是个独立的开关：只要人没拖过分隔线，重启后仍然是自适应，
  // 哪怕磁盘上还留着上次量出来的宽度（它只是下次手拖的起点）。
  state.columnAuto = localStorage.getItem(COLUMN_AUTO_KEY) !== '0'
  const v = localStorage.getItem('nota-view')
  if (v === 'write' || v === 'split' || v === 'read') state.viewMode = v
  loadRoots()
  initAccent()
  initAi()
  initPrefs2()
  initSessions()
  initSync()
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

/* ── 云同步（WebDAV）── */

function setSyncConfig(patch: Partial<SyncUi['config']>) {
  state.sync.config = { ...state.sync.config, ...patch }
  try {
    localStorage.setItem('nota-sync', JSON.stringify(state.sync.config))
  } catch {
    /* 存不下就算了 */
  }
}

function initSync() {
  try {
    const raw = localStorage.getItem('nota-sync')
    if (raw) state.sync.config = { ...state.sync.config, ...JSON.parse(raw) }
  } catch {
    /* 坏了就当没配过 */
  }
  if (state.sync.config.url) {
    void runSync(true)
    // 静默自动同步：每 10 分钟一轮，只有开着「自动」才跑
    setInterval(() => {
      if (state.sync.config.auto && state.sync.config.url && state.root) void runSync(true)
    }, 10 * 60 * 1000)
  }
}

function syncCfg() {
  const { url, username, password, dir } = state.sync.config
  return { url, username, password, dir }
}

async function testSync(): Promise<{ ok: boolean; error?: string }> {
  state.sync.status = 'busy'
  state.sync.message = '正在测试连接…'
  const r = await window.api.syncTest(syncCfg())
  state.sync.status = r.ok ? 'ok' : 'error'
  state.sync.message = r.ok ? '连接成功' : (r.error ?? '连接失败')
  return r
}

async function runSync(silent = false): Promise<boolean> {
  if (!state.root) {
    if (!silent) toastSync('先打开一个工作区再同步')
    return false
  }
  if (state.sync.status === 'busy') return false
  state.sync.status = 'busy'
  state.sync.message = '正在同步…'
  window.api.onSyncProgress((text) => {
    if (state.sync.status === 'busy') state.sync.message = text
  })
  const r = await window.api.syncRun(state.root, syncCfg())
  if (r.ok) {
    state.sync.status = 'ok'
    state.sync.lastAt = Date.now()
    const parts = [`上传 ${r.uploaded}`, `下载 ${r.downloaded}`]
    if (r.conflicts) parts.push(`冲突 ${r.conflicts}`)
    parts.push(`无变化 ${r.skipped}`)
    state.sync.message = parts.join(' · ')
    if (r.conflicts > 0 || (!silent && (r.uploaded || r.downloaded))) {
      window.dispatchEvent(
        new CustomEvent('nota:toast', { detail: `同步完成：${state.sync.message}` }),
      )
    }
  } else {
    state.sync.status = 'error'
    state.sync.message = r.error ?? '同步失败'
    if (!silent) toastSync(`同步失败：${state.sync.message}`)
  }
  return r.ok
}

function toastSync(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
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

/** 主区显示什么。AI 编写现在住在中间那一列里，两个字段得保持一致：
    切到 ai 就把那一列也切到 AI；切回 note 只在「本来停在 AI」时才动它，
    免得把用户自己选的附件库 / 回收站顶掉。 */
function setMainView(v: MainView) {
  if (v === 'ai') setColumnView('ai')
  else if (state.columnView === 'ai') setColumnView('notes')
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
const CONTEXT_LIMIT = 1500

function noteContext(body: string, name: string, limit = CONTEXT_LIMIT) {
  const text = body.trim()
  if (!text) return ''
  return `【${name}】\n${text.slice(0, limit)}${text.length > limit ? '\n…（已截断）' : ''}`
}

/** AI 要处理哪一篇：用户手动指的那篇优先，否则就是当前打开的那篇 */
function aiTargetPath() {
  return state.aiNote ?? state.activePath
}

/** 目标笔记的名字（不带 .md），给面板上的下拉按钮显示 */
const aiTargetName = computed(() => {
  const p = aiTargetPath()
  if (!p) return '未选笔记'
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1].replace(/\.md$/i, '')
})

/**
 * 把目标笔记的正文读出来。
 *
 * 是当前打开的那篇就直接用草稿（可能还没落盘，读盘会读到旧的）；
 * 是别的篇才去读盘 —— 用户明确指了另一篇，读盘才是他要的。
 */
async function readAiTarget(): Promise<{ name: string; path: string; text: string } | null> {
  const path = aiTargetPath()
  if (!path) return null
  const name = path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? '当前笔记'
  if (path === state.activePath) return { name, path, text: state.draft }
  try {
    const text = await window.api.readNote(path)
    return { name, path, text: text ?? '' }
  } catch {
    return { name, path, text: '' }
  }
}

/* ── 执行过程 ──
   面板上那两行「思考过程 / 执行过程」不能是装饰：每一条都得对上一个
   真动作。下面这几个小工具负责往当前这一轮的步骤表里记一笔，
   连带这一步花了多久 —— 时间是真的，不是编的。 */

function makeRecorder(msg: ChatMessage) {
  const t0 = performance.now()
  return {
    begin(label: string, detail?: string) {
      const s: AgentStep = { label, detail, status: 'run' }
      // 必须整体换一个新数组再赋回去：直接 push 到原数组上，
      // 走的是原始对象、不是 reactive 代理，视图收不到通知
      msg.steps = [...(msg.steps ?? []), s]
      return { step: s, at: performance.now() }
    },
    end(h: { step: AgentStep; at: number }, detail?: string, status: 'ok' | 'fail' = 'ok') {
      h.step.status = status
      if (detail !== undefined) h.step.detail = detail
      h.step.ms = Math.round(performance.now() - h.at)
      // 同上：换一份副本，让这一步的完成状态真的推给面板
      msg.steps = [...(msg.steps ?? [])]
    },
    get elapsed() {
      return Math.round(performance.now() - t0)
    },
  }
}

/**
 * 发一轮对话。
 *
 * 比起「发一句、等、回一句」，这里做的是 agent 该做的事：
 * 先把这一轮要用的东西备齐（读哪篇笔记、怎么组织上下文），
 * 每一步都记在消息的执行过程里；模型的推理过程则一边生成一边流进面板。
 * 面板上看到的步骤和耗时都是真的，不是先摆好一排再逐条打勾。
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
  state.aiStage = '准备上下文…'

  // 先建一条空的助手消息：步骤、思考、回答都往它身上长，
  // 这样面板在等第一个字的时候就已经有东西可看。
  // 注意拿的是数组里那个**响应式代理**，后面所有改动都走它 ——
  // 改本地那个原始对象不会触发更新，界面上会一直空着。
  chatSeq += 1
  state.chat.push({ id: chatSeq, role: 'assistant', content: '' })
  const msg = state.chat[state.chat.length - 1] as ChatMessage
  const rec = makeRecorder(msg)
  const sess = currentSession()
  if (sess) sess.updatedAt = Date.now()

  // 流式增量进来时挂到这条消息上。只有一个请求在跑（aiBusy 守着），
  // 所以不需要给增量打标记区分是哪一轮
  let streaming = true
  window.api.onAiDelta?.((d) => {
    if (!streaming) return
    if (d.reasoning) {
      msg.thinking = (msg.thinking ?? '') + d.reasoning
      state.aiStage = '正在思考…'
    }
    if (d.text) {
      msg.content += d.text
      state.aiStage = '正在写回答…'
    }
  })

  const withNote = opts.withNote ?? state.aiWithNote

  try {
    // ① 选笔记
    const h1 = rec.begin(withNote ? '读取要处理的笔记' : '跳过笔记上下文')
    let ctx: { name: string; text: string } | null = null
    if (withNote) {
      const t = await readAiTarget()
      if (t) ctx = { name: t.name, text: t.text }
      rec.end(
        h1,
        t
          ? `${t.name} · ${t.text.trim().length} 字${t.text.trim() ? '' : '（空的）'}`
          : '还没有打开任何笔记',
      )
    } else {
      rec.end(h1, '按你的开关，这轮只带对话本身')
    }

    // ② 组织上下文
    const h2 = rec.begin('组织上下文')
    const noteBlock = ctx ? noteContext(ctx.text, ctx.name) : ''
    const truncated = !!ctx && ctx.text.trim().length > CONTEXT_LIMIT
    rec.end(
      h2,
      noteBlock
        ? truncated
          ? `笔记正文截到 ${CONTEXT_LIMIT} 字，近 12 轮对话一并带上`
          : '笔记正文与近 12 轮对话一并带上'
        : '只带近 12 轮对话',
    )

    // ②·b 联网检索。放在组织上下文之后：先知道笔记要说什么，才知道该怎么查
    let webBlock = ''
    if (state.aiWeb) {
      const hw = rec.begin('联网检索', q.length > 24 ? `${q.slice(0, 24)}…` : q)
      state.aiStage = '正在联网检索…'
      try {
        const r = await window.api.aiWebSearch(q, 5)
        if (r.ok && r.hits?.length) {
          webBlock = webContextBlock(r.hits)
          msg.sources = r.hits.map((h) => ({ title: h.title, url: h.url }))
          rec.end(hw, `${r.engine ?? '搜索'} · ${r.hits.length} 条来源`)
        } else {
          // 没查到不算失败：这一轮照常回答，只是没有外部资料可依托
          rec.end(hw, r.error ?? '没检索到结果，按已有知识回答')
        }
      } catch (e) {
        rec.end(hw, String(e), 'fail')
      }
    }

    const system = [state.ai.system]
    if (noteBlock) system.push(`以下是用户正在写的笔记，回答时参考它：\n${noteBlock}`)
    if (webBlock) system.push(webBlock)
    const systemText = system.join('\n\n')

    const messages = [
      { role: 'system', content: systemText },
      ...state.chat
        .filter((m) => !m.error && m.id !== msg.id && m.content)
        .slice(-12) // 只带最近几轮，长对话不该把上下文无限撑大
        .map((m) => ({ role: m.role, content: m.content })),
    ]

    // ③ 调用模型
    const h3 = rec.begin('调用模型', state.ai.model || '未配置模型')
    state.aiStage = '正在等模型…'
    const r = await window.api.aiChat({ ...state.ai }, messages)
    streaming = false

    if (r.ok) {
      rec.end(h3, `${state.ai.model || '模型'} 已返回`)
      // 非流式（或流被中间掐断）时，把兜底结果补上
      if (!msg.content) msg.content = r.text ?? ''
      if (!msg.thinking && r.reasoning) msg.thinking = r.reasoning
      const h4 = rec.begin('收到回答')
      rec.end(h4, `${msg.content.length} 字${msg.thinking ? '，另带一段推理' : ''}`)
    } else {
      rec.end(h3, r.error ?? '请求失败', 'fail')
      msg.error = r.error ?? '请求失败'
    }
  } catch (e) {
    streaming = false
    msg.error = String(e)
  } finally {
    state.aiBusy = false
    state.aiStage = ''
    msg.ms = rec.elapsed
    if (sess) sess.updatedAt = Date.now()
    saveSessions()
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

/** AI 这一轮改哪一篇。传 null 表示跟着当前打开的那篇走 */
function setAiNote(path: string | null) {
  state.aiNote = path
  if (path) localStorage.setItem(AI_NOTE_KEY, path)
  else localStorage.removeItem(AI_NOTE_KEY)
}

/**
 * 开关 = 「这一轮要不要带上笔记」。
 *
 * 语义按用户的说法：**打开＝选中笔记，关掉＝不选中（自由聊天）**。
 * 所以打开那一刻如果还没挑过笔记，自动把当前这篇认下来——
 * 否则会出现「开关明明开着，旁边的笔记却写着未选中」的自相矛盾状态，
 * 看上去像是开关没生效。
 */
function setAiWithNote(v: boolean) {
  state.aiWithNote = v
  if (v && !state.aiNote && state.activePath) setAiNote(state.activePath)
  localStorage.setItem(AI_WITH_NOTE_KEY, v ? '1' : '0')
}

/**
 * 联网检索开关。
 *
 * 默认关：多数提问不需要联网，而每一轮都先去抓一次网页会白白多等几秒。
 * 开着时会在执行过程里多出一步「联网检索」，查到几条、用的哪个引擎
 * 都写在那一行的结果里 —— agent 做的事得看得见。
 */
function setAiWeb(v: boolean) {
  state.aiWeb = v
  localStorage.setItem(AI_WEB_KEY, v ? '1' : '0')
}

/** 把检索结果压成一段模型能直接用的参考资料 */
function webContextBlock(hits: { title: string; url: string; snippet: string }[]) {
  const lines = hits.map((h, i) => {
    const snip = h.snippet.trim()
    return `[${i + 1}] ${h.title}\n    ${h.url}${snip ? `\n    ${snip}` : ''}`
  })
  return [
    '以下是联网检索到的资料（可能不完整，也可能有过时内容）。',
    '回答时优先参考它们；哪一条支撑了你的说法，就在句末用 [序号] 标出来。',
    '资料里没有的内容不要编，直接说没查到。',
    '',
    ...lines,
  ].join('\n')
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
  toggleGraph,
  restoreLastWorkspace,
  openWorkspace,
  switchWorkspace,
  forgetRoot,
  refreshTree,
  loadIcons,
  iconOf,
  setNodeIcon,
  tagIconOf,
  setTagIcon,
  setNoteTags,
  openNote,
  saveNote,
  newNote,
  removeNote,
  renameNote,
  toggleStar,
  moveNoteTo,
  revealNote,
  folderOptions,
  baseNameOf,
  folderOfPath,
  toggleDir,
  startNewFolder,
  commitNewFolder,
  cancelNewFolder,
  setActiveTag,
  retagNotes,
  setTheme,
  setAccent,
  setAiConfig,
  setSyncConfig,
  testSync,
  runSync,
  initTheme,
  autoExpand,
  exportNote,
  exportNoteAs,
  importNotes,
  toggleSidebar,
  setColumnView,
  NOTE_TABS,
  setWidth,
  autoColumnWidth,
  effectiveColumnWidth,
  sidebarNow,
  resetColumnWidth,
  WIDTH_LIMITS,
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
  aiTargetName,
  aiTargetPath,
  setAiNote,
  setAiWithNote,
  setAiWeb,
  sendChat,
  retryChat,
  clearChat,
  pushChat,
  newChat,
  switchSession,
  deleteSession,
  renameSession,
}
