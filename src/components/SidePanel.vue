<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onBeforeUnmount } from 'vue'
import {
  Check,
  ChevronDown,
  Clock,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  Sparkles,
  Star,
  Trash2,
  X,
} from 'lucide-vue-next'
import { isSettingsSection, store } from '@/store'
import type { NavFilter, SettingsSection, TreeNode } from '@/store'
import TreeNodeItem from './TreeNodeItem.vue'
import TagChip from '@/components/TagChip.vue'
import SettingsDialog from '@/components/SettingsDialog.vue'
import NoteContextMenu, { type NoteExportKind } from '@/components/NoteContextMenu.vue'
import MarkDialog from '@/components/MarkDialog.vue'
import FolderContextMenu from '@/components/FolderContextMenu.vue'
import TagContextMenu from '@/components/TagContextMenu.vue'
import PromptDialog from '@/components/PromptDialog.vue'
import FolderPicker from '@/components/FolderPicker.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const { state } = store

const settingsOpen = ref(false)
/** 设置面板要停在哪个分区（工具栏 AI 菜单的「模型设置…」会指定） */
const settingsSection = ref<SettingsSection>('general')
const folderInput = ref<HTMLInputElement | null>(null)

/** 笔记视图的四项：图标 + 名称 + 计数来源 */
const NAV: { id: NavFilter; label: string; icon: typeof FileText; countKey: keyof typeof store.navCounts.value }[] = [
  { id: 'all', label: '所有笔记', icon: FileText, countKey: 'all' },
  { id: 'recent', label: '最近编辑', icon: Clock, countKey: 'recent' },
  { id: 'starred', label: '收藏', icon: Star, countKey: 'starred' },
  { id: 'unfiled', label: '未归类', icon: Inbox, countKey: 'unfiled' },
]

const navCounts = computed(() => store.navCounts.value)
const tags = computed(() => store.allTags.value)
const visible = computed(() => store.visibleTree.value)

/* ── 附件库 / 回收站的条数 ──
   挂在导航项右边的小数字。都是「工作区层面的东西」，所以打开工作区时
   取一次、库里有增删时再取一次，不做轮询。 */
const libCounts = ref({ attach: 0, trash: 0 })

async function refreshLibCounts() {
  const root = state.root
  if (!root) {
    libCounts.value = { attach: 0, trash: 0 }
    return
  }
  try {
    const [a, t] = await Promise.all([window.api.attachList(root), window.api.trashList(root)])
    libCounts.value = { attach: a.length, trash: t.length }
  } catch {
    /* 拿不到就不显示数字，不影响导航本身 */
  }
}

/** 折叠态窄轨上的图标顺序：搜索 → 四项导航 → 新建 → 库 → AI */
const railTools = computed(() => {
  const list: { id: string; label: string; icon: unknown }[] = [
    { id: 'attach', label: '附件库', icon: Paperclip },
    { id: 'trash', label: '回收站', icon: Trash2 },
  ]
  if (state.ai.enabled) list.push({ id: 'ai', label: 'AI 编写', icon: Sparkles })
  return list
})

// 目录树刷新后自动展开顶层目录
watch(
  () => state.tree,
  () => store.autoExpand(),
)

// 换工作区后重取库的条数
watch(() => state.root, () => void refreshLibCounts(), { immediate: true })

// 「新建文件夹」输入框出现时自动聚焦
watch(
  () => state.newFolderIn,
  async (v) => {
    if (v === null) return
    await nextTick()
    folderInput.value?.focus()
  },
)

function commitFolder(e: Event) {
  store.commitNewFolder((e.target as HTMLInputElement).value)
}

/** 折叠态点搜索：先把中间那一列打开并切到笔记列表，再把焦点交给它的搜索框。
    搜索框现在住在那一列的顶部（参考图的分布就是这样：侧栏负责去哪找，
    那一列负责有哪些，搜索属于「有哪些」）。 */
async function focusSearch() {
  if (!state.column) store.setColumn(true)
  store.setColumnView('notes')
  await nextTick()
  window.dispatchEvent(new CustomEvent('nota:focus-search'))
}

/**
 * 附件库 / 回收站 / AI 编写的入口。
 *
 * 三样东西都住在中间那一列里。那一列收着的时候先把它拉开 ——
 * 用户点这个入口就是为了看它，「点了没反应」是最糟的交互。
 */
function openLibrary(tab: 'attach' | 'trash') {
  if (!state.column) store.setColumn(true)
  store.setColumnView(tab)
}

function openAi() {
  if (!state.column) store.setColumn(true)
  store.setMainView('ai')
}

/* ── 新建标签 ──
   标签的唯一来源是笔记本身（frontmatter 里的 tags），所以「新建标签」
   就是给当前这篇打上它：改了正文内容 → 走既有的自动保存通道落盘，
   Ctrl+Z 也能撤销。没有打开笔记时不做假动作，直接说清楚。 */
const newTagOpen = ref(false)
const tagInput = ref<HTMLInputElement | null>(null)

async function startNewTag() {
  if (!state.activePath) {
    window.dispatchEvent(
      new CustomEvent('nota:toast', { detail: '先打开一篇笔记 —— 标签是记在笔记上的' }),
    )
    return
  }
  newTagOpen.value = true
  await nextTick()
  tagInput.value?.focus()
}

function cancelTag() {
  newTagOpen.value = false
}

function commitTag(e: Event) {
  const el = e.target as HTMLInputElement
  const name = el.value.trim().replace(/^#+/, '')
  newTagOpen.value = false
  el.value = ''
  if (!name) return
  window.dispatchEvent(new CustomEvent('nota:tag', { detail: name }))
}

/* ── 目录树 / 标签的右键菜单 ──
   菜单本身只弹一份，位置与对象由这里记着。TreeNodeItem 是递归组件，
   「在哪儿右键了哪一个」由它逐层 emit 上来。 */

type TreeMenu = { x: number; y: number; node: TreeNode }
const treeMenu = ref<TreeMenu | null>(null)
const tagMenu = ref<{ x: number; y: number; name: string; count: number; active: boolean } | null>(
  null,
)

/** 菜单里点了需要弹窗的那些动作时，先把对象留下来 */
const actionNode = ref<TreeNode | null>(null)
const renameOpen = ref(false)
const moveOpen = ref(false)
const removeOpen = ref(false)
const noteRemoveOpen = ref(false)
const tagRenameOpen = ref(false)
const tagRemoveOpen = ref(false)
const tagRenameFrom = ref('')

const actionName = computed(() =>
  actionNode.value ? store.baseNameOf(actionNode.value.path) : '',
)
const actionIsDir = computed(() => actionNode.value?.type === 'dir')

function onTreeMenu(p: TreeMenu) {
  treeMenu.value = p
}

function onTagMenu(e: MouseEvent, t: { name: string; count: number }) {
  e.preventDefault()
  tagMenu.value = {
    x: e.clientX,
    y: e.clientY,
    name: t.name,
    count: t.count,
    active: state.activeTag === t.name,
  }
}

/** 取走菜单指着的那个节点，并把菜单收掉 */
function takeNode(): TreeNode | null {
  const n = treeMenu.value?.node ?? null
  actionNode.value = n
  treeMenu.value = null
  return n
}

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

/* ── 文件：打开 / 收藏 / 重命名 / 归类 / 复制路径 / 定位 / 导出 / 删除 ── */
function onMenuOpen() {
  const n = takeNode()
  if (n) void store.openNote(n.path)
}

function onMenuStar() {
  const n = takeNode()
  if (!n) return
  void store.toggleStar(n.path).then((on) => toast(on ? '已收藏' : '已取消收藏'))
}

async function onMenuCopyPath() {
  const n = takeNode()
  if (!n) return
  try {
    await navigator.clipboard.writeText(n.path)
    toast('路径已复制')
  } catch {
    toast('剪贴板不可用')
  }
}

async function onMenuReveal() {
  const n = takeNode()
  if (n) await store.revealNote(n.path)
}

/* ── 换图标 ──
   图标写在 .nota/icons.json，记的是相对路径。文件夹也能换，
   所以这里不区分类型，一律交给 setNodeIcon。 */
const markOpen = ref(false)

async function onIconPick(ic: { kind: 'brand' | 'emoji'; id: string } | null) {
  const n = actionNode.value
  markOpen.value = false
  if (!n) return
  await store.setNodeIcon(n.path, ic)
  toast(ic ? '图标已更换' : '已恢复默认图标')
}

async function onMenuExport(kind: NoteExportKind) {
  const n = takeNode()
  if (!n) return
  const out = await store.exportNoteAs(n.path, kind)
  toast(out ? `已导出到 ${out}` : '导出已取消')
}

/* ── 文件夹：新建笔记 / 新建子文件夹 / 重命名 / 删除 ── */
function onFolderNewNote() {
  const n = takeNode()
  if (!n) return
  void store.newNote(n.path)
}

function onFolderNewSub() {
  const n = takeNode()
  if (!n) return
  // 先展开，否则输入框出现在收起的目录里等于没出现
  state.expanded[n.path] = true
  store.startNewFolder(n.path)
}

function onRenameCommit(v: string) {
  renameOpen.value = false
  const n = actionNode.value
  if (!n || !v.trim()) return
  void store.renameNote(n.path, v.trim()).then(() => refreshTreeSoon())
}

function onMoveCommit(dir: string) {
  moveOpen.value = false
  const n = actionNode.value
  if (!n) return
  void store.moveNoteTo(n.path, dir).then((next) => {
    if (next !== n.path) toast('已归类')
  })
}

/** 删文件夹：连里面的笔记一起进回收站，所以弹窗里把话说清楚 */
async function onRemoveConfirm() {
  removeOpen.value = false
  noteRemoveOpen.value = false
  const n = actionNode.value
  if (!n) return
  await store.removeNote(n.path)
  toast(n.type === 'dir' ? `文件夹「${n.name}」已移入回收站` : `《${store.baseNameOf(n.path)}》已移入回收站`)
}

/** 重命名/删除之后目录树要重读一次，否则侧栏还写着旧名字 */
function refreshTreeSoon() {
  window.setTimeout(() => void store.refreshTree(), 120)
}

/* ── 标签 ── */
function onTagFilter() {
  const t = tagMenu.value
  tagMenu.value = null
  if (t) store.setActiveTag(t.active ? null : t.name)
}

async function onTagCopy() {
  const t = tagMenu.value
  tagMenu.value = null
  if (!t) return
  try {
    await navigator.clipboard.writeText(`#${t.name}`)
    toast('标签名已复制')
  } catch {
    toast('剪贴板不可用')
  }
}

function onTagRename() {
  const t = tagMenu.value
  tagMenu.value = null
  if (!t) return
  tagRenameFrom.value = t.name
  tagRenameOpen.value = true
}

function onTagRemove() {
  const t = tagMenu.value
  tagMenu.value = null
  if (!t) return
  tagRenameFrom.value = t.name
  tagRemoveOpen.value = true
}

async function commitTagRename(v: string) {
  tagRenameOpen.value = false
  const from = tagRenameFrom.value
  const to = v.trim().replace(/^#+/, '')
  if (!to || to === from) return
  const n = await store.retagNotes(from, to)
  toast(n ? `已把 ${n} 篇笔记上的 #${from} 改成 #${to}` : `没有笔记用到 #${from}`)
}

async function commitTagRemove() {
  tagRemoveOpen.value = false
  const from = tagRenameFrom.value
  const n = await store.retagNotes(from, null)
  toast(n ? `已从 ${n} 篇笔记上移除 #${from}` : `没有笔记用到 #${from}`)
}

/** 工具栏 AI 菜单的「模型设置…」：打开对话框并停在 AI 分区 */
function onSettingsRequest(e: Event) {
  const id = (e as CustomEvent<string>).detail
  if (isSettingsSection(id)) settingsSection.value = id
  settingsOpen.value = true
}

/** 库对话框关闭后刷新条数（删了附件 / 清空了回收站） */
function onLibraryChanged() {
  void refreshLibCounts()
}

onMounted(() => {
  window.addEventListener('nota:settings', onSettingsRequest)
  window.addEventListener('nota:library-changed', onLibraryChanged)
})
onBeforeUnmount(() => {
  window.removeEventListener('nota:settings', onSettingsRequest)
  window.removeEventListener('nota:library-changed', onLibraryChanged)
})

/** 导航项点击：再点一次当前项就回到「所有笔记」 */
function pickNav(id: NavFilter) {
  store.setMainView('note')
  store.setNavFilter(state.navFilter === id && id !== 'all' ? 'all' : id)
}

/** 只显示路径最后一段，完整路径挂在 title 上 */
function tailOf(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

const rootTail = computed(() => (state.root ? tailOf(state.root) : '打开文件夹'))

/* ── 底部那个文件夹选择器 ──
   换工作区以前只有「打开文件夹…」一条路，每次都从盘符开始点。
   常用的目录其实就那么两三个，所以把它做成跟「模型选择」同款的下拉：
   点开是最近打开过的文件夹，最后一条是「添加文件夹…」（走系统选择框）。 */
const rootMenu = ref(false)
const rootOptions = computed(() => state.recentRoots)

function toggleRootMenu() {
  rootMenu.value = !rootMenu.value
}

/** 换到列表里的某个文件夹 */
async function pickRoot(dir: string) {
  rootMenu.value = false
  const ok = await store.switchWorkspace(dir)
  if (!ok) toast('这个文件夹打不开了，已从列表里移除')
}

/** 「添加文件夹…」：走系统目录选择框，选完直接切过去 */
async function addRoot() {
  rootMenu.value = false
  await store.openWorkspace()
}

/** 就地弹出的菜单一律靠 pointerdown 收起（跟 AI 面板那两处同一个套路） */
function onDocPointer(e: PointerEvent) {
  if (!rootMenu.value) return
  const el = e.target as HTMLElement | null
  if (el?.closest('.foot-pick')) return
  rootMenu.value = false
}

onMounted(() => document.addEventListener('pointerdown', onDocPointer))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointer))
</script>

<template>
  <aside class="panel" :class="{ collapsed: !state.sidebar }">
    <!-- ══ 展开态 ══ -->
    <template v-if="state.sidebar">
      <header class="head">
        <!-- 标：界面里的「Nota」记号（折角纸页 + 三行字，最后一笔用琥珀收尾）。
             应用图标是另一回事（build/icon-source.png，奶油底手写体那张）——
             界面上不用那张：18px 的彩色位图塞进侧栏顶栏只会糊成一格色块，
             描边版才跟这一栏其它图标同一种笔法。 -->
        <span class="logo" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="18" height="18" fill="none">
            <path
              d="M10 4.4h8.8L24 9.6v14.9a3.1 3.1 0 0 1-3.1 3.1H10a3.1 3.1 0 0 1-3.1-3.1V7.5A3.1 3.1 0 0 1 10 4.4Z"
              stroke="currentColor"
              stroke-width="1.9"
              stroke-linejoin="round"
            />
            <path
              d="M18.8 4.4v5.2H24"
              stroke="currentColor"
              stroke-width="1.9"
              stroke-linejoin="round"
            />
            <path
              d="M10.6 17.4h8.6M10.6 21.2h4.6"
              stroke="currentColor"
              stroke-width="1.9"
              stroke-linecap="round"
            />
            <path d="M17.6 21.2h3.2" stroke="#d98a4e" stroke-width="1.9" stroke-linecap="round" />
          </svg>
        </span>
        <span class="head-title">资料库</span>
        <!-- 这一行永远只有一枚：收起侧边栏（管的就是自己，Ctrl+\）。
             资料栏那枚不再出现在这儿：它长在资料栏自己的顶行右端，
             收起后跟着资料栏一起缩成一条窄轨 —— 于是两栏各有一枚、
             各管自己，不会再有两枚并排、一枚收自己一枚开邻居的样子。 -->
        <span class="head-actions">
          <button
            class="mini"
            data-role="sidebar-toggle"
            data-tip="收起侧边栏 (Ctrl+\)"
            @click="store.toggleSidebar()"
          >
            <PanelLeftClose :size="15" :stroke-width="1.9" />
          </button>
        </span>
      </header>

      <div class="scroll">
        <!-- 笔记视图 -->
        <nav class="nav">
          <button
            v-for="n in NAV"
            :key="n.id"
            class="nav-item"
            :class="{ on: state.mainView === 'note' && state.navFilter === n.id }"
            @click="pickNav(n.id)"
          >
            <span class="nav-ico"><component :is="n.icon" :size="15" :stroke-width="1.9" /></span>
            <span class="nav-label">{{ n.label }}</span>
            <span v-if="navCounts[n.countKey] > 0" class="nav-count">{{ navCounts[n.countKey] }}</span>
          </button>
        </nav>

        <!-- 附件库 / 回收站 / AI 编写：三件性质完全不同的事，各自独立成组。
             挤在一个块里会让人以为它们是一类东西。
             点它们不再弹窗，而是把中间那一列切到对应视图。 -->
        <nav class="nav nav-group">
          <button
            class="nav-item"
            :class="{ on: state.mainView === 'note' && state.column && state.columnView === 'attach' }"
            @click="openLibrary('attach')"
          >
            <span class="nav-ico"><Paperclip :size="15" :stroke-width="1.9" /></span>
            <span class="nav-label">附件库</span>
            <span v-if="libCounts.attach > 0" class="nav-count">{{ libCounts.attach }}</span>
          </button>
        </nav>

        <nav class="nav nav-group">
          <button
            class="nav-item"
            :class="{ on: state.mainView === 'note' && state.column && state.columnView === 'trash' }"
            @click="openLibrary('trash')"
          >
            <span class="nav-ico"><Trash2 :size="15" :stroke-width="1.9" /></span>
            <span class="nav-label">回收站</span>
            <span v-if="libCounts.trash > 0" class="nav-count">{{ libCounts.trash }}</span>
          </button>
        </nav>

        <nav v-if="state.ai.enabled" class="nav nav-group">
          <button
            class="nav-item"
            :class="{ on: state.mainView === 'ai' && state.column }"
            @click="openAi"
          >
            <span class="nav-ico"><Sparkles :size="15" :stroke-width="1.9" /></span>
            <span class="nav-label">AI 编写</span>
            <span v-if="state.chat.length" class="nav-count">{{ state.chat.length }}</span>
          </button>
        </nav>

        <!-- 文件夹 / 笔记 -->
        <section class="sec">
          <div class="sec-head">
            <span class="sec-title">
              {{ state.activeTag ? `# ${state.activeTag}` : state.navFilter === 'all' ? '文件夹' : '笔记' }}
            </span>
            <button class="sec-add" data-tip="新建文件夹" @click="store.startNewFolder()">
              <FolderPlus :size="15" :stroke-width="1.9" />
            </button>
          </div>

          <div v-if="state.newFolderIn !== null" class="folder-new">
            <input
              ref="folderInput"
              class="folder-input"
              placeholder="文件夹名称"
              @keydown.enter="commitFolder"
              @keydown.esc="store.cancelNewFolder()"
              @blur="commitFolder"
            />
          </div>

          <div v-if="state.loading" class="hint">读取中…</div>
          <div v-else-if="visible.length === 0" class="hint">
            {{ state.searchQuery ? '没有匹配的笔记' : '这里还没有 .md 文件' }}
          </div>
          <ul v-else class="tree">
            <TreeNodeItem
              v-for="n in visible"
              :key="n.path"
              :node="n"
              @menu="onTreeMenu"
            />
          </ul>
        </section>

        <!-- 标签。
             这一块以前是「有标签才显示」，工作区里的笔记一篇没打过标签时
             整块就消失了 —— 用户看到的结论是「这里没有标签功能」。
             现在常显，并且在标题旁给一个入口：标签是记在笔记上的，
             所以新建＝给当前这篇打上这个标签。 -->
        <section class="sec">
          <div class="sec-head">
            <span class="sec-title">标签</span>
            <button
              v-if="state.activeTag"
              class="sec-add"
              data-tip="清除筛选"
              @click="store.setActiveTag(null)"
            >
              <X :size="14" :stroke-width="2.2" />
            </button>
            <button class="sec-add" data-tip="新建标签" @click="startNewTag">
              <Plus :size="15" :stroke-width="2.2" />
            </button>
          </div>

          <div v-if="newTagOpen" class="folder-new">
            <input
              ref="tagInput"
              class="folder-input"
              placeholder="标签名，回车确认"
              @keydown.enter="commitTag"
              @keydown.esc="cancelTag"
              @blur="commitTag"
            />
          </div>

          <div v-if="tags.length === 0" class="hint">
            还没有标签。标签写在笔记开头的 frontmatter 里，给当前这篇加一个试试。
          </div>
          <div v-else class="tags-body">
            <button
              v-for="t in tags"
              :key="t.name"
              class="tag"
              :class="{ on: state.activeTag === t.name }"
              @click="store.setActiveTag(t.name)"
              @contextmenu.prevent="onTagMenu($event, t)"
            >
              <TagChip :name="t.name" :size="11" />
              <span class="tag-n">{{ t.count }}</span>
            </button>
          </div>
        </section>
      </div>

      <!-- 底部：左边是工作区选择器（最近打开的文件夹 / 添加文件夹…），
           右边是设置。以前这里只是一行死文案，换目录只能回系统选择框重头点。 -->
      <div class="foot">
        <div class="foot-pick">
          <button
            class="fp-btn"
            :class="{ on: rootMenu }"
            data-role="root-pick"
            :title="state.root ?? '还没打开文件夹'"
            @click="toggleRootMenu"
          >
            <FolderOpen v-if="state.root" :size="13" :stroke-width="1.9" />
            <FolderPlus v-else :size="13" :stroke-width="1.9" />
            <span class="fp-name">{{ rootTail }}</span>
            <ChevronDown :size="11" :stroke-width="2" />
          </button>

          <div v-if="rootMenu" class="n-menu n-menu-inline fp-menu">
            <div class="n-menu-head"><span>文件夹</span></div>
            <button
              v-for="d in rootOptions"
              :key="d"
              class="n-menu-item"
              :class="{ on: d === state.root }"
              :title="d"
              @click="pickRoot(d)"
            >
              <Folder :size="12" :stroke-width="1.9" />
              <span class="n-menu-name">{{ tailOf(d) }}</span>
              <Check v-if="d === state.root" :size="12" :stroke-width="2.2" />
            </button>
            <p v-if="rootOptions.length === 0" class="n-menu-hint">还没有打开过文件夹</p>
            <button class="n-menu-item fp-add" @click="addRoot">
              <FolderPlus :size="12" :stroke-width="1.9" />
              <span class="n-menu-name">添加文件夹…</span>
            </button>
          </div>
        </div>

        <span v-if="state.root" class="foot-sub">{{ navCounts.all }} 篇</span>
        <button class="foot-btn" data-tip="设置" @click="settingsOpen = true">
          <Settings :size="16" :stroke-width="1.9" />
        </button>
      </div>
    </template>

    <!-- ══ 折叠态：纯图标窄轨 ══ -->
    <template v-else>
      <div class="rail-head">
        <button class="rail-btn" data-tip="展开侧边栏 (Ctrl+\)" @click="store.toggleSidebar()">
          <PanelLeftOpen :size="16" :stroke-width="1.9" />
        </button>
      </div>
      <div class="rail-group">
        <button class="rail-btn" data-tip="搜索笔记" @click="focusSearch">
          <Search :size="16" :stroke-width="1.9" />
        </button>
        <button
          v-for="n in NAV"
          :key="n.id"
          class="rail-btn"
          :class="{ on: state.mainView === 'note' && state.navFilter === n.id }"
          :data-tip="n.label"
          @click="pickNav(n.id)"
        >
          <component :is="n.icon" :size="16" :stroke-width="1.9" />
        </button>
        <span class="rail-sep" />
        <button class="rail-btn" data-tip="新建笔记 (Ctrl+N)" @click="store.newNote()">
          <FilePlus2 :size="16" :stroke-width="1.9" />
        </button>
        <button class="rail-btn" data-tip="新建文件夹" @click="store.startNewFolder()">
          <FolderPlus :size="16" :stroke-width="1.9" />
        </button>
      </div>
      <span class="rail-spacer" />
      <div class="rail-group rail-bottom">
        <button
          v-for="t in railTools"
          :key="t.id"
          class="rail-btn"
          :class="{ on: state.column && state.columnView === (t.id === 'ai' ? 'ai' : t.id) }"
          :data-tip="t.label"
          @click="t.id === 'ai' ? openAi() : openLibrary(t.id === 'attach' ? 'attach' : 'trash')"
        >
          <component :is="t.icon" :size="16" :stroke-width="1.9" />
        </button>
        <button class="rail-btn" data-tip="设置" @click="settingsOpen = true">
          <Settings :size="16" :stroke-width="1.9" />
        </button>
      </div>
    </template>

    <!-- 目录树的右键菜单：文件与文件夹两套，同一时刻只会弹一个 -->
    <NoteContextMenu
      v-if="treeMenu && treeMenu.node.type !== 'dir'"
      :target="{
        x: treeMenu.x,
        y: treeMenu.y,
        path: treeMenu.node.path,
        starred: !!treeMenu.node.starred,
      }"
      @close="treeMenu = null"
      @open="onMenuOpen"
      @star="onMenuStar"
      @rename="
        () => {
          takeNode()
          renameOpen = true
        }
      "
      @move="
        () => {
          takeNode()
          moveOpen = true
        }
      "
      @mark="
        () => {
          takeNode()
          markOpen = true
        }
      "
      @copy-path="onMenuCopyPath"
      @reveal="onMenuReveal"
      @export="onMenuExport"
      @remove="
        () => {
          takeNode()
          noteRemoveOpen = true
        }
      "
    />

    <FolderContextMenu
      v-if="treeMenu && treeMenu.node.type === 'dir'"
      :target="{
        x: treeMenu.x,
        y: treeMenu.y,
        path: treeMenu.node.path,
        name: treeMenu.node.name,
      }"
      @close="treeMenu = null"
      @new-note="onFolderNewNote"
      @new-folder="onFolderNewSub"
      @rename="
        () => {
          takeNode()
          renameOpen = true
        }
      "
      @icon="
        () => {
          takeNode()
          markOpen = true
        }
      "
      @copy-path="onMenuCopyPath"
      @reveal="onMenuReveal"
      @remove="
        () => {
          takeNode()
          removeOpen = true
        }
      "
    />

    <!-- 图标与标签现在是同一个入口：笔记进来有两页（标签 + 图标），
         文件夹没有 frontmatter，所以只给图标那一页，连页签都不画。 -->
    <MarkDialog
      :open="markOpen"
      :name="actionIsDir ? actionNode?.name ?? '' : actionName"
      :type="actionIsDir ? 'dir' : 'file'"
      :path="actionNode?.path ?? ''"
      :tags="actionIsDir ? [] : (actionNode?.tags ?? [])"
      @close="markOpen = false"
      @pick-icon="onIconPick"
    />

    <TagContextMenu
      :target="tagMenu"
      @close="tagMenu = null"
      @filter="onTagFilter"
      @copy="onTagCopy"
      @rename="onTagRename"
      @remove="onTagRemove"
    />

    <PromptDialog
      :open="renameOpen"
      :title="actionIsDir ? '重命名文件夹' : '重命名'"
      :label="actionIsDir ? '文件夹名' : '标题'"
      :initial="actionIsDir ? actionNode?.name ?? '' : actionName"
      placeholder="输入新的名字"
      confirm-text="重命名"
      @confirm="onRenameCommit"
      @cancel="renameOpen = false"
    />

    <FolderPicker
      :open="moveOpen"
      :note-name="actionName"
      @pick="onMoveCommit"
      @close="moveOpen = false"
    />

    <ConfirmDialog
      :open="removeOpen"
      title="删除这个文件夹？"
      :message="`「${actionNode?.name ?? ''}」连同里面的笔记会一起移入回收站，之后还能在那里恢复。`"
      confirm-text="删除文件夹"
      danger
      @confirm="onRemoveConfirm"
      @cancel="removeOpen = false"
    />

    <ConfirmDialog
      :open="noteRemoveOpen"
      title="删除这篇笔记？"
      :message="`《${actionName}》会被移入回收站，之后还能恢复。`"
      confirm-text="确认删除"
      danger
      @confirm="onRemoveConfirm"
      @cancel="noteRemoveOpen = false"
    />

    <PromptDialog
      :open="tagRenameOpen"
      title="重命名标签"
      label="新名字"
      :initial="tagRenameFrom"
      placeholder="输入新的标签名"
      confirm-text="重命名"
      @confirm="commitTagRename"
      @cancel="tagRenameOpen = false"
    />

    <ConfirmDialog
      :open="tagRemoveOpen"
      title="删除这个标签？"
      :message="`会从所有带着 #${tagRenameFrom} 的笔记里把它去掉。笔记本身不动。`"
      confirm-text="删除标签"
      danger
      @confirm="commitTagRemove"
      @cancel="tagRemoveOpen = false"
    />

    <SettingsDialog :open="settingsOpen" :section="settingsSection" @close="settingsOpen = false" />
  </aside>
</template>

<style scoped>
/* ══ 外壳 ══
   宽度在这里过渡：折叠/展开时整块滑过去，内容整体换一套。
   注意不能 overflow:hidden —— 窄轨的悬停提示要能探出去。 */
.panel {
  position: relative;
  z-index: 20;
  /* 宽度由 App 写在 --side-w 上，拖动分隔线改的就是它 */
  width: var(--side-w, var(--n-sidebar));
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--n-sunken);
  border-right: 1px solid var(--n-line);
  transition: width 220ms var(--n-ease);
}

.panel.collapsed {
  width: 48px;
}

/* ══ 展开态 ══ */
.head {
  flex: none;
  height: var(--n-topbar);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 6px 0 12px;
  /* 侧栏这一条也是窗口的拖动区：全局标题栏去掉之后，
     三栏的顶栏各自都是抓手，从哪儿都能拖窗口 */
  -webkit-app-region: drag;
}

.logo {
  flex: none;
  display: inline-flex;
  color: var(--n-accent);
}

.head-title {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--n-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.head-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 1px;
  -webkit-app-region: no-drag;
}

.mini {
  padding: 0;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.mini svg {
  fill: none;
  stroke: currentColor;
}

.mini:hover {
  background: var(--n-raised);
  color: var(--n-accent);
}

/* ── 滚动区 ── */
.scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 12px;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* 每个入口单独一组，组间一条淡分隔线。
   间距收在 6px：三组连着排也不至于散开。 */
.nav-group {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid color-mix(in oklab, var(--n-line) 60%, transparent);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  height: var(--n-row);
  padding: 0 8px;
  border-radius: var(--n-r-md);
  color: color-mix(in oklab, var(--n-fg) 72%, var(--n-fg-dim));
  font-size: var(--n-nav-fs);
  font-weight: 500;
  letter-spacing: -0.01em;
  text-align: left;
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease),
    box-shadow var(--n-dur) var(--n-ease);
}

.nav-ico {
  flex: none;
  display: inline-flex;
  color: var(--n-fg-faint);
  transition: color var(--n-dur) var(--n-ease);
}

.nav-ico svg {
  fill: none;
  stroke: currentColor;
}

.nav-label {
  flex: 1;
  min-width: 0;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-count {
  flex: none;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: color-mix(in oklab, var(--n-fg-faint) 80%, transparent);
}

.nav-item:hover {
  background: color-mix(in oklab, var(--n-raised) 54%, transparent);
  color: var(--n-fg);
}

/* 选中态：一层强调色底 + 一圈极淡的内描边，
   比纯色块轻，但足够把「我在哪」说清楚。 */
.nav-item.on {
  background: color-mix(in oklab, var(--n-accent-soft) 76%, transparent);
  color: var(--n-fg);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--n-accent) 9%, transparent);
}

.nav-item.on .nav-ico {
  color: var(--n-accent);
}

/* ── 分区 ── */
.sec {
  margin-top: 16px;
}

.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  /* 跟着加号一起长高，不然 26px 的按钮会顶出这一行 */
  height: 26px;
  padding: 0 2px 0 8px;
}

.sec-title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: color-mix(in oklab, var(--n-fg-faint) 86%, transparent);
}

/* 分区上的加号。
   尺寸对着顶栏那颗「收起」来（26×26、图标 15），并且常显——
   以前是 20×20 加 13px 图标、还要鼠标划过才肯出来，
   结果就是「想建文件夹的时候找不到那个按钮」。 */
.sec-add {
  padding: 0;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-faint);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.sec-head:hover .sec-add {
  color: var(--n-fg-dim);
}

.sec-add svg {
  fill: none;
  stroke: currentColor;
}

.sec-add:hover {
  background: var(--n-raised);
  color: var(--n-accent);
}

.tree {
  list-style: none;
  margin: 2px 0 0;
  padding: 0;
}

.folder-new {
  padding: 4px 4px 2px;
}

.folder-input {
  width: 100%;
  height: 26px;
  padding: 0 8px;
  font-size: 12.5px;
  border: 1px solid var(--n-accent);
  border-radius: var(--n-r-sm);
  background: var(--n-raised);
  color: var(--n-fg);
  outline: none;
}

.hint {
  padding: 10px 8px;
  font-size: 12px;
  color: var(--n-fg-faint);
  line-height: 1.6;
}

/* ── 标签 ── */
.tags-body {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 6px 4px 0;
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  font-size: 11.5px;
  border-radius: 11px;
  border: 1px solid var(--n-line);
  background: var(--n-surface);
  color: var(--n-fg-dim);
  transition: border-color var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease),
    background var(--n-dur) var(--n-ease);
}

.tag svg {
  flex: none;
  fill: none;
  stroke: currentColor;
  opacity: 0.7;
}

.tag:hover {
  border-color: var(--n-accent);
  color: var(--n-accent);
}

.tag.on {
  background: var(--n-accent);
  border-color: var(--n-accent);
  color: var(--n-on-accent);
}

.tag-n {
  font-size: 10px;
  opacity: 0.62;
}

/* ── 底部：工作区 + 设置 ── */
.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px 7px 12px;
  border-top: 1px solid color-mix(in oklab, var(--n-line) 72%, transparent);
  background: color-mix(in oklab, var(--n-sunken) 92%, var(--n-raised));
}

/* ── 工作区选择器 ──
   跟「模型选择」同一副长相：一枚按钮 + 向上展开的菜单。
   按钮要塞进 231px 宽的底栏，所以名字用省略号兜，篇数只留一个「N 篇」。 */
.foot-pick {
  position: relative;
  flex: 1;
  min-width: 0;
}

.fp-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  height: 28px;
  padding: 0 6px;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.fp-btn svg {
  flex: none;
  fill: none;
  stroke: currentColor;
}

.fp-btn:hover,
.fp-btn.on {
  background: var(--n-raised);
  color: var(--n-fg);
}

.fp-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 菜单往上开：底栏贴着窗口下沿，往下开会被窗口切掉。
   选择器得写成双类 `.n-menu.fp-menu` —— 单类压不住 menu.css 里的
   `.n-menu.n-menu-inline { top: calc(100% + 6px) }`，那个 top 会跟这里的
   bottom 同时生效，把菜单挤成一条（模型下拉就是这么坏过的）。 */
.n-menu.fp-menu {
  top: auto;
  bottom: calc(100% + 6px);
  left: 0;
  width: 236px;
  max-height: 320px;
  overflow-y: auto;
}

/* 「添加文件夹…」是动作不是选项，用一条线跟上面的列表分开 */
.fp-add {
  margin-top: 4px;
  border-top: 1px solid color-mix(in oklab, var(--n-line) 70%, transparent);
}

.foot-sub {
  flex: none;
  font-size: 10px;
  color: var(--n-fg-faint);
}

.foot-btn {
  padding: 0;
  flex: none;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.foot-btn svg {
  fill: none;
  stroke: currentColor;
}

.foot-btn:hover {
  background: var(--n-raised);
  color: var(--n-accent);
}

/* ══ 折叠态窄轨 ══ */
.rail-head {
  flex: none;
  height: var(--n-topbar);
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: drag;
}

.rail-head .rail-btn {
  -webkit-app-region: no-drag;
}

.rail-group {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 2px 0;
}

.rail-bottom {
  border-top: 1px solid var(--n-line);
  padding: 6px 0;
}

.rail-spacer {
  flex: 1;
}

.rail-sep {
  width: 22px;
  height: 1px;
  margin: 5px 0;
  background: var(--n-line);
}

.rail-btn {
  padding: 0;
  position: relative;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-md);
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.rail-btn svg {
  fill: none;
  stroke: currentColor;
}

.rail-btn:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}

.rail-btn.on {
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

/* 悬停提示：向右探出的一枚小气泡，纯 CSS，无需 JS 定位 */
.rail-btn::after {
  content: attr(data-tip);
  position: absolute;
  left: calc(100% + 8px);
  top: 50%;
  z-index: 60;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--n-fg);
  color: var(--n-bg);
  font-size: 11.5px;
  line-height: 1.35;
  white-space: nowrap;
  opacity: 0;
  transform: translateY(-50%) translateX(-4px);
  pointer-events: none;
  transition: opacity 130ms var(--n-ease), transform 130ms var(--n-ease);
  box-shadow: var(--n-shadow-md);
}

.rail-btn:hover::after {
  opacity: 1;
  transform: translateY(-50%) translateX(0);
}
</style>
