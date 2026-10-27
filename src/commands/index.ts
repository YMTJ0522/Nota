/**
 * 命令面板的命令表。
 *
 * 这张表只干一件事：把散落在菜单、工具栏按钮、快捷键里的动作排成一列，
 * 让它们都能被搜到。以后加新功能，顺手往这里加一条，
 * 它就在 Ctrl+K 里露脸 —— 这是 Nota 唯一一个「加功能不会让功能更难找」的地方。
 *
 * 三条约定：
 * · `hint` 写这条命令已有的快捷键（没有就不写）。所以这张表本身也是一份
 *   快捷键速查表：用户不是记不住，是从来没人一次性告诉过他。
 * · `keys` 是搜索别名，英文 / 缩写 / 拼音都行。用户怎么叫它，就该能搜到它 ——
 *   叫「主题」还是「暗色」还是「dark」，都得出来。
 * · `needNote` 的命令在没有打开笔记时**置灰而不是藏起来**。藏起来更糟：
 *   用户会以为这个功能根本不存在。
 */
import type { Component } from 'vue'
import {
  BookOpen,
  ChevronsDown,
  Clock,
  Columns,
  FileDown,
  FilePlus,
  FileUp,
  Files,
  FolderOpen,
  History,
  ListTree,
  Moon,
  PanelLeft,
  Paperclip,
  PenLine,
  Quote,
  RefreshCw,
  Search,
  Settings,
  Share2,
  Sparkles,
  Star,
  StickyNote,
  Trash2,
} from 'lucide-vue-next'
import { store } from '@/store'

export type CmdGroup = '文件' | '面板' | '视图' | '工具' | '便签'

export interface Command {
  id: string
  title: string
  /** 右侧那行灰字：有快捷键写快捷键，没有写它到底干什么 */
  hint?: string
  group: CmdGroup
  icon: Component
  keys?: string[]
  /** 需要先打开一篇笔记 */
  needNote?: boolean
  /** 返回值没人要，所以用 unknown 收着 —— 各动作返回 void / string / 数组都有 */
  run: () => unknown
}

/** 发一个我们自己的事件，让别处（侧栏、编辑器）去响应 */
function fire(name: string, detail?: unknown) {
  window.dispatchEvent(new CustomEvent(name, detail === undefined ? undefined : { detail }))
}

export const commands: Command[] = [
  /* ── 文件 ── */
  {
    id: 'file.new',
    title: '新建笔记',
    hint: 'Ctrl+N',
    group: '文件',
    icon: FilePlus,
    keys: ['new', 'note', 'xinjian', 'biji'],
    run: () => store.newNote(),
  },
  {
    id: 'file.save',
    title: '保存当前笔记',
    hint: 'Ctrl+S',
    group: '文件',
    icon: FileDown,
    keys: ['save', 'baocun'],
    needNote: true,
    run: () => store.saveNote(),
  },
  {
    id: 'file.export.pdf',
    title: '导出为 PDF',
    group: '文件',
    icon: FileDown,
    keys: ['export', 'pdf', 'daochu'],
    needNote: true,
    run: () => store.exportNote('pdf'),
  },
  {
    id: 'file.export.word',
    title: '导出为 Word',
    group: '文件',
    icon: FileDown,
    keys: ['export', 'word', 'doc', 'docx', 'daochu'],
    needNote: true,
    run: () => store.exportNote('word'),
  },
  {
    id: 'file.export.html',
    title: '导出为 HTML',
    group: '文件',
    icon: FileDown,
    keys: ['export', 'html', 'web', 'daochu'],
    needNote: true,
    run: () => store.exportNote('html'),
  },
  {
    id: 'file.export.md',
    title: '导出为 Markdown',
    group: '文件',
    icon: FileDown,
    keys: ['export', 'markdown', 'md', 'daochu'],
    needNote: true,
    run: () => store.exportNote('md'),
  },
  {
    id: 'file.import',
    title: '导入文件到当前目录',
    group: '文件',
    icon: FileUp,
    keys: ['import', 'daoru'],
    run: () => store.importNotes(),
  },
  {
    id: 'file.reveal',
    title: '在文件夹中显示',
    group: '文件',
    icon: FolderOpen,
    keys: ['reveal', 'folder', 'explorer', 'dakai'],
    needNote: true,
    run: () => (store.state.activePath ? store.revealNote(store.state.activePath) : undefined),
  },
  {
    id: 'file.workspace',
    title: '打开另一个笔记库',
    hint: 'Ctrl+O',
    group: '文件',
    icon: FolderOpen,
    keys: ['workspace', 'vault', 'open', 'gongzuoqu'],
    run: () => store.openWorkspace(),
  },
  {
    id: 'file.star',
    title: '收藏 / 取消收藏当前笔记',
    group: '文件',
    icon: Star,
    keys: ['star', 'shoucang', 'favorite'],
    needNote: true,
    run: () => (store.state.activePath ? store.toggleStar(store.state.activePath) : undefined),
  },

  /* ── 面板（中间那一列切到哪一屏） ── */
  {
    id: 'panel.notes',
    title: '所有笔记',
    group: '面板',
    icon: Files,
    keys: ['notes', 'all', 'suoyou'],
    run: () => {
      store.setNavFilter('all')
      store.setColumnView('notes')
    },
  },
  {
    id: 'panel.starred',
    title: '收藏的笔记',
    group: '面板',
    icon: Star,
    keys: ['starred', 'shoucang'],
    run: () => {
      store.setNavFilter('starred')
      store.setColumnView('notes')
    },
  },
  {
    id: 'panel.recent',
    title: '最近编辑',
    group: '面板',
    icon: Clock,
    keys: ['recent', 'zuijin'],
    run: () => {
      store.setNavFilter('recent')
      store.setColumnView('notes')
    },
  },
  {
    id: 'panel.outline',
    title: '大纲',
    group: '面板',
    icon: ListTree,
    keys: ['outline', 'dagang', 'toc'],
    run: () => store.setColumnView('outline'),
  },
  {
    id: 'panel.quote',
    title: '引用',
    group: '面板',
    icon: Quote,
    keys: ['quote', 'yinyong', 'backlink'],
    run: () => store.setColumnView('quote'),
  },
  {
    id: 'panel.attach',
    title: '附件库',
    group: '面板',
    icon: Paperclip,
    keys: ['attach', 'media', 'image', 'fujian', 'tupian'],
    run: () => store.setColumnView('attach'),
  },
  {
    id: 'panel.stickies',
    title: '便签墙',
    group: '面板',
    icon: StickyNote,
    keys: ['sticky', 'board', 'bianqian'],
    run: () => store.setColumnView('stickies'),
  },
  {
    id: 'panel.trash',
    title: '回收站',
    group: '面板',
    icon: Trash2,
    keys: ['trash', 'recycle', 'huishouzhan', 'shanchu'],
    run: () => store.setColumnView('trash'),
  },
  {
    id: 'panel.ai',
    title: 'AI 编写',
    group: '面板',
    icon: Sparkles,
    keys: ['ai', 'chat', 'write', 'xiezuo'],
    run: () => store.setColumnView('ai'),
  },
  {
    id: 'panel.history',
    title: '当前笔记的版本历史',
    group: '面板',
    icon: History,
    keys: ['history', 'version', 'snapshot', 'lishi', 'banben'],
    needNote: true,
    run: () => fire('nota:history'),
  },

  /* ── 视图 ── */
  {
    id: 'view.theme',
    title: '切换明暗主题',
    group: '视图',
    icon: Moon,
    keys: ['theme', 'dark', 'light', 'zhuti', 'an', 'liang'],
    run: () => store.setTheme(store.state.theme === 'light' ? 'dark' : 'light'),
  },
  {
    id: 'view.write',
    title: '写作视图',
    group: '视图',
    icon: PenLine,
    keys: ['write', 'edit', 'xiezuo'],
    needNote: true,
    run: () => store.setViewMode('write'),
  },
  {
    id: 'view.split',
    title: '左右分栏（边写边看预览）',
    group: '视图',
    icon: Columns,
    keys: ['split', 'side', 'fenlan', 'yulan'],
    needNote: true,
    run: () => store.setViewMode('split'),
  },
  {
    id: 'view.read',
    title: '阅读视图',
    group: '视图',
    icon: BookOpen,
    keys: ['read', 'preview', 'yuedu', 'yulan'],
    needNote: true,
    run: () => store.setViewMode('read'),
  },
  {
    id: 'view.sidebar',
    title: '折叠 / 展开侧栏',
    hint: 'Ctrl+\\',
    group: '视图',
    icon: PanelLeft,
    keys: ['sidebar', 'cebian'],
    run: () => store.toggleSidebar(),
  },
  {
    id: 'view.outline',
    title: '显示 / 隐藏大纲栏',
    group: '视图',
    icon: ListTree,
    keys: ['outline', 'dagang'],
    needNote: true,
    run: () => store.toggleOutline(),
  },
  {
    id: 'view.graph',
    title: '笔记关系图',
    hint: 'Ctrl+Shift+G',
    group: '视图',
    icon: Share2,
    keys: ['graph', 'map', 'links', 'guanxitu'],
    run: () => store.toggleGraph(),
  },

  /* ── 工具 ── */
  {
    id: 'tool.searchBody',
    title: '全文搜索（连正文一起搜）',
    hint: 'Ctrl+Shift+F',
    group: '工具',
    icon: Search,
    keys: ['search', 'find', 'body', 'quanwen', 'sousuo'],
    run: () => fire('nota:palette', 'body'),
  },
  {
    id: 'tool.jump',
    title: '跳到笔记（只比标题）',
    hint: 'Ctrl+P',
    group: '工具',
    icon: Search,
    keys: ['jump', 'goto', 'quick', 'tiaozhuan'],
    run: () => fire('nota:palette', 'name'),
  },
  {
    id: 'tool.sync',
    title: '立即同步到 WebDAV',
    group: '工具',
    icon: RefreshCw,
    keys: ['sync', 'webdav', 'tongbu', 'beifen'],
    run: () => store.runSync(),
  },
  {
    id: 'tool.settings',
    title: '设置',
    group: '工具',
    icon: Settings,
    keys: ['settings', 'prefs', 'shezhi', 'peizhi'],
    run: () => fire('nota:settings'),
  },

  /* ── 便签 ── */
  {
    id: 'sticky.new',
    title: '新建便签',
    hint: 'Alt+N',
    group: '便签',
    icon: StickyNote,
    keys: ['sticky', 'new', 'bianqian', 'xinjian'],
    run: () => window.api.stickyNew?.(),
  },
  {
    id: 'sticky.closeAll',
    title: '收起桌面上所有便签',
    group: '便签',
    icon: ChevronsDown,
    keys: ['sticky', 'close', 'all', 'shouqi'],
    run: () => window.api.stickyCloseAll?.(),
  },
]

/** 有没有打开笔记 —— 决定 needNote 的命令能不能点 */
export function cmdEnabled(c: Command): boolean {
  return !c.needNote || !!store.state.activePath
}

/** 把 query 的字符按顺序在 text 里找一遍。「导出word」能命中「导出为 Word」靠它 */
function subseq(text: string, q: string): boolean {
  if (!q) return false
  let i = 0
  for (const ch of text) {
    if (ch === q[i]) i++
    if (i === q.length) return true
  }
  return false
}

/** 越大越靠前；0 = 不匹配 */
function score(c: Command, q: string): number {
  const t = c.title.toLowerCase()
  const keys = (c.keys ?? []).map((k) => k.toLowerCase())
  if (t === q) return 130
  if (t.startsWith(q)) return 110
  if (t.includes(q)) return 95
  if (keys.includes(q)) return 100
  if (keys.some((k) => k.startsWith(q))) return 80
  if (keys.some((k) => k.includes(q))) return 65
  if (subseq(t, q)) return 45
  if (keys.some((k) => subseq(k, q))) return 30
  return 0
}

/**
 * 按 query 过滤并排序。
 * `recent` 里出现过的命令整体上浮 —— 这个面板要「越用越顺」，
 * 不能每次打「导出」都把四条导出按固定顺序摆一遍。
 */
export function matchCommands(q: string, recent: string[] = []): Command[] {
  const query = q.trim().toLowerCase()
  if (!query) {
    const byId = new Map(commands.map((c) => [c.id, c]))
    const hit = recent.map((id) => byId.get(id)).filter((c): c is Command => !!c)
    // 最近用过的排前面，剩下的按表里的顺序补齐，免得面板一打开只有两三行
    const rest = commands.filter((c) => !recent.includes(c.id))
    return [...hit, ...rest]
  }
  return commands
    .map((c) => ({ c, s: score(c, query) + (recent.includes(c.id) ? 25 : 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c)
}
