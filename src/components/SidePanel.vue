<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onBeforeUnmount } from 'vue'
import {
  Clock,
  FilePlus2,
  FileText,
  FolderPlus,
  Hash,
  Inbox,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sparkles,
  Star,
  Trash2,
  X,
} from 'lucide-vue-next'
import { isSettingsSection, store } from '@/store'
import type { NavFilter, SettingsSection } from '@/store'
import TreeNodeItem from './TreeNodeItem.vue'
import SettingsDialog from '@/components/SettingsDialog.vue'

const { state } = store

const settingsOpen = ref(false)
/** 设置面板要停在哪个分区（工具栏 AI 菜单的「模型设置…」会指定） */
const settingsSection = ref<SettingsSection>('general')
const folderInput = ref<HTMLInputElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)

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

/** 折叠态点搜索：先展开侧栏，再把焦点交给搜索框 */
async function focusSearch() {
  if (!state.sidebar) store.toggleSidebar()
  await nextTick()
  searchInput.value?.focus()
}

function clearSearch() {
  store.setSearchQuery('')
}

/**
 * 附件库 / 回收站 / AI 编写的入口。
 *
 * 库那两项抛全局事件而不是 emit：对话框挂在 App 层（要跨侧栏和编辑区工作），
 * 一层层传 props 会把两边焊死。AI 编写是主区的一个视图，直接改 store。
 */
function openLibrary(tab: 'attach' | 'trash') {
  window.dispatchEvent(new CustomEvent('nota:library', { detail: tab }))
}

function openAi() {
  store.setMainView('ai')
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

/** 底部只显示工作区最后一段目录名，完整路径挂在 title 上 */
const rootTail = computed(() => {
  const r = state.root ?? ''
  return r.split(/[\\/]/).filter(Boolean).pop() ?? r
})
</script>

<template>
  <aside class="panel" :class="{ collapsed: !state.sidebar }">
    <!-- ══ 展开态 ══ -->
    <template v-if="state.sidebar">
      <header class="head">
        <span class="logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none">
            <rect x="3" y="2.5" width="18" height="19" rx="4" fill="currentColor" opacity="0.14" />
            <path
              d="M7.5 2.5h9a4 4 0 0 1 4 4v11a4 4 0 0 1-4 4h-9a4 4 0 0 1-4-4v-11a4 4 0 0 1 4-4z"
              stroke="currentColor"
              stroke-width="1.5"
            />
            <path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </span>
        <span class="head-title">资料库</span>
        <span class="head-actions">
          <button class="mini" data-tip="新建笔记 (Ctrl+N)" @click="store.newNote()">
            <FilePlus2 :size="15" :stroke-width="1.9" />
          </button>
          <button class="mini" data-tip="新建文件夹" @click="store.startNewFolder()">
            <FolderPlus :size="15" :stroke-width="1.9" />
          </button>
          <button class="mini" data-tip="收起侧边栏 (Ctrl+\)" @click="store.toggleSidebar()">
            <PanelLeftClose :size="15" :stroke-width="1.9" />
          </button>
        </span>
      </header>

      <div class="search">
        <Search class="search-ico" :size="13" :stroke-width="2" />
        <input
          ref="searchInput"
          class="search-input"
          type="text"
          placeholder="在笔记中筛选…"
          spellcheck="false"
          :value="state.searchQuery"
          @input="store.setSearchQuery(($event.target as HTMLInputElement).value)"
        />
        <button v-if="state.searchQuery" class="search-x" data-tip="清除" @click="clearSearch">
          <X :size="12" :stroke-width="2.2" />
        </button>
      </div>

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
             挤在一个块里会让人以为它们是一类东西。 -->
        <nav class="nav nav-group">
          <button class="nav-item" @click="openLibrary('attach')">
            <span class="nav-ico"><Paperclip :size="15" :stroke-width="1.9" /></span>
            <span class="nav-label">附件库</span>
            <span v-if="libCounts.attach > 0" class="nav-count">{{ libCounts.attach }}</span>
          </button>
        </nav>

        <nav class="nav nav-group">
          <button class="nav-item" @click="openLibrary('trash')">
            <span class="nav-ico"><Trash2 :size="15" :stroke-width="1.9" /></span>
            <span class="nav-label">回收站</span>
            <span v-if="libCounts.trash > 0" class="nav-count">{{ libCounts.trash }}</span>
          </button>
        </nav>

        <nav v-if="state.ai.enabled" class="nav nav-group">
          <button class="nav-item" :class="{ on: state.mainView === 'ai' }" @click="openAi">
            <span class="nav-ico"><Sparkles :size="15" :stroke-width="1.9" /></span>
            <span class="nav-label">AI 编写</span>
            <span v-if="state.chat.length" class="nav-count">{{ state.chat.length }}</span>
          </button>
        </nav>

        <!-- 文件夹 / 笔记 -->
        <section class="sec">
          <div class="sec-head">
            <span class="sec-title">{{ state.navFilter === 'all' ? '文件夹' : '笔记' }}</span>
            <button class="sec-add" data-tip="新建文件夹" @click="store.startNewFolder()">
              <FolderPlus :size="13" :stroke-width="1.9" />
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
            <TreeNodeItem v-for="n in visible" :key="n.path" :node="n" />
          </ul>
        </section>

        <!-- 标签 -->
        <section v-if="tags.length" class="sec">
          <div class="sec-head">
            <span class="sec-title">标签</span>
            <button v-if="state.activeTag" class="sec-add" data-tip="清除筛选" @click="store.setActiveTag(null)">
              <X :size="12" :stroke-width="2.2" />
            </button>
          </div>
          <div class="tags-body">
            <button
              v-for="t in tags"
              :key="t.name"
              class="tag"
              :class="{ on: state.activeTag === t.name }"
              @click="store.setActiveTag(t.name)"
            >
              <Hash :size="10" :stroke-width="2.2" />
              {{ t.name }}
              <span class="tag-n">{{ t.count }}</span>
            </button>
          </div>
        </section>
      </div>

      <div class="foot">
        <span class="foot-meta">
          <span class="foot-name" :title="state.root ?? ''">{{ rootTail }}</span>
          <span class="foot-sub">{{ navCounts.all }} 篇笔记</span>
        </span>
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
          :class="{ on: t.id === 'ai' && state.mainView === 'ai' }"
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
  width: var(--n-sidebar);
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
  height: 44px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 12px;
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
}

.mini {
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

/* ── 搜索 ── */
.search {
  flex: none;
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  margin: 0 8px 10px;
  padding: 0 8px;
  border-radius: 10px;
  border: 1px solid color-mix(in oklab, var(--n-line) 54%, transparent);
  background: color-mix(in oklab, var(--n-raised) 42%, var(--n-sunken));
  transition: border-color var(--n-dur) var(--n-ease),
    background-color var(--n-dur) var(--n-ease);
}

.search:hover,
.search:focus-within {
  border-color: color-mix(in oklab, var(--n-line) 88%, transparent);
  background: color-mix(in oklab, var(--n-raised) 72%, var(--n-sunken));
}

.search:focus-within {
  border-color: var(--n-accent);
}

.search-ico {
  flex: none;
  fill: none;
  stroke: currentColor;
  color: var(--n-fg-faint);
}

.search-input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  letter-spacing: -0.01em;
  color: var(--n-fg);
  background: none;
  border: none;
  outline: none;
}

.search-input::placeholder {
  color: color-mix(in oklab, var(--n-fg-faint) 82%, transparent);
}

.search-x {
  flex: none;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--n-fg-faint);
}

.search-x svg {
  fill: none;
  stroke: currentColor;
}

.search-x:hover {
  background: var(--n-raised);
  color: var(--n-fg);
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
  height: 20px;
  padding: 0 4px 0 8px;
}

.sec-title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: color-mix(in oklab, var(--n-fg-faint) 86%, transparent);
}

.sec-add {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--n-fg-faint);
  opacity: 0;
  transition: opacity var(--n-dur) var(--n-ease), background var(--n-dur) var(--n-ease),
    color var(--n-dur) var(--n-ease);
}

.sec-head:hover .sec-add,
.sec-add:focus-visible {
  opacity: 1;
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

.foot-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.foot-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--n-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.foot-sub {
  font-size: 10px;
  color: var(--n-fg-faint);
}

.foot-btn {
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
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
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
