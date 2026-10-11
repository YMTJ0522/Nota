<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import {
  Clock,
  FilePlus2,
  FileText,
  FolderPlus,
  Hash,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Star,
  X,
} from 'lucide-vue-next'
import { store } from '@/store'
import type { NavFilter } from '@/store'
import TreeNodeItem from './TreeNodeItem.vue'
import SettingsDialog from '@/components/SettingsDialog.vue'

const { state } = store

const settingsOpen = ref(false)
const folderInput = ref<HTMLInputElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)

/** 导航项：图标 + 中文名 + 计数来源，顺序与 inkstone 一致 */
const NAV: { id: NavFilter; label: string; icon: typeof FileText; countKey: keyof typeof store.navCounts.value }[] = [
  { id: 'all', label: '所有笔记', icon: FileText, countKey: 'all' },
  { id: 'recent', label: '最近编辑', icon: Clock, countKey: 'recent' },
  { id: 'starred', label: '收藏', icon: Star, countKey: 'starred' },
  { id: 'unfiled', label: '未归类', icon: Inbox, countKey: 'unfiled' },
]

const navCounts = computed(() => store.navCounts.value)
const tags = computed(() => store.allTags.value)
const visible = computed(() => store.visibleTree.value)

// 目录树刷新后自动展开顶层目录
watch(
  () => state.tree,
  () => store.autoExpand(),
)

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

/** 导航项点击：再点一次当前项就回到「所有笔记」 */
function pickNav(id: NavFilter) {
  store.setNavFilter(state.navFilter === id && id !== 'all' ? 'all' : id)
}
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
          placeholder="搜索笔记…"
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
            :class="{ on: state.navFilter === n.id }"
            @click="pickNav(n.id)"
          >
            <span class="nav-ico"><component :is="n.icon" :size="14" :stroke-width="1.9" /></span>
            <span class="nav-label">{{ n.label }}</span>
            <span v-if="navCounts[n.countKey] > 0" class="nav-count">{{ navCounts[n.countKey] }}</span>
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
        <span class="root" :title="state.root ?? ''">{{ state.root }}</span>
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
          :class="{ on: state.navFilter === n.id }"
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
        <button class="rail-btn" data-tip="设置" @click="settingsOpen = true">
          <Settings :size="16" :stroke-width="1.9" />
        </button>
      </div>
    </template>

    <SettingsDialog :open="settingsOpen" @close="settingsOpen = false" />
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
  font-size: 14px;
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
  margin: 0 8px 8px;
  padding: 0 8px;
  border-radius: var(--n-r-sm);
  border: 1px solid var(--n-line);
  background: var(--n-surface);
  transition: border-color var(--n-dur) var(--n-ease);
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
  font-size: 12.5px;
  color: var(--n-fg);
  background: none;
  border: none;
  outline: none;
}

.search-input::placeholder {
  color: var(--n-fg-faint);
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

.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 30px;
  padding: 0 8px;
  border-radius: var(--n-r-md);
  color: var(--n-fg-dim);
  text-align: left;
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
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
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-count {
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--n-fg-faint);
}

.nav-item:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}

.nav-item.on {
  background: var(--n-accent-soft);
  color: var(--n-fg);
}

.nav-item.on .nav-ico {
  color: var(--n-accent);
}

/* ── 分区 ── */
.sec {
  margin-top: 14px;
}

.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 22px;
  padding: 0 4px 0 8px;
}

.sec-title {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--n-fg-faint);
}

.sec-add {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
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

/* ── 底部 ── */
.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 12px;
  border-top: 1px solid var(--n-line);
}

.root {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  font-family: var(--n-font-mono);
  color: var(--n-fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
