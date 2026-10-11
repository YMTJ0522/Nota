<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { FolderPlus, Plus, PanelLeftClose, Settings, Tag, X } from 'lucide-vue-next'
import { store } from '@/store'
import TreeNodeItem from './TreeNodeItem.vue'
import SettingsDialog from '@/components/SettingsDialog.vue'

const { state } = store

const settingsOpen = ref(false)
const folderInput = ref<HTMLInputElement | null>(null)

// 目录树刷新后自动展开顶层目录
watch(
  () => state.tree,
  () => store.autoExpand()
)

// 「新建文件夹」输入框出现时自动聚焦
watch(
  () => state.newFolderIn,
  async (v) => {
    if (v === null) return
    await nextTick()
    folderInput.value?.focus()
  }
)

/** 折叠按钮放在「资料库」这一行、加号旁边——跟标题同一视觉组 */
const showFolders = computed(() => state.tree.some((n) => n.type === 'dir'))

function commitFolder(e: Event) {
  store.commitNewFolder((e.target as HTMLInputElement).value)
}
</script>

<template>
  <aside class="panel">
    <div class="head">
      <span class="label">资料库</span>
      <span class="head-actions">
        <button class="mini" title="新建文件夹" @click="store.startNewFolder()">
          <FolderPlus :size="15" :stroke-width="1.9" />
        </button>
        <button class="mini" title="新建笔记 (Ctrl+N)" @click="store.newNote()">
          <Plus :size="15" :stroke-width="2" />
        </button>
        <button class="mini" title="收起侧边栏 (Ctrl+\)" @click="store.toggleSidebar()">
          <PanelLeftClose :size="15" :stroke-width="1.9" />
        </button>
      </span>
    </div>

    <!-- 新建文件夹的输入行：跟着 title 行出现，位置固定不跳 -->
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

    <div class="tree">
      <div v-if="state.loading" class="hint">读取中…</div>
      <div v-else-if="state.tree.length === 0" class="hint">这个目录里还没有 .md 文件</div>
      <ul v-else class="list">
        <TreeNodeItem v-for="n in state.tree" :key="n.path" :node="n" />
      </ul>
    </div>

    <!-- 标签区：列出全工作区的 frontmatter 标签，点一下筛选 -->
    <div v-if="store.allTags.value.length" class="tags">
      <div class="tags-head">
        <Tag :size="12" :stroke-width="2" />
        <span>标签</span>
        <button
          v-if="state.activeTag"
          class="tags-clear"
          title="清除筛选"
          @click="store.setActiveTag(null)"
        >
          <X :size="11" :stroke-width="2.4" />
        </button>
      </div>
      <div class="tags-body">
        <button
          v-for="t in store.allTags.value"
          :key="t.name"
          class="tag"
          :class="{ on: state.activeTag === t.name }"
          @click="store.setActiveTag(t.name)"
        >
          {{ t.name }}
          <span class="tag-n">{{ t.count }}</span>
        </button>
      </div>
    </div>

    <!-- 底部：工作区路径 + 设置入口（用户要求设置放在左下角） -->
    <div class="foot">
      <span class="root" :title="state.root ?? ''">{{ state.root }}</span>
      <button class="foot-btn" title="设置" @click="settingsOpen = true">
        <Settings :size="16" :stroke-width="1.9" />
      </button>
    </div>

    <SettingsDialog :open="settingsOpen" @close="settingsOpen = false" />
  </aside>
</template>

<style scoped>
.panel {
  width: var(--n-sidebar);
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--n-surface);
  border-right: 1px solid var(--n-line);
}

.head {
  flex: none;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 16px;
}

.label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--n-fg-faint);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 1px;
}

.mini {
  width: 24px;
  height: 24px;
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
  background: var(--n-bg);
  color: var(--n-accent);
}

.folder-new {
  flex: none;
  padding: 0 8px 6px;
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

.tree {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px 12px;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.hint {
  padding: 12px 8px;
  font-size: 12.5px;
  color: var(--n-fg-faint);
  line-height: 1.6;
}

/* ── 标签区 ── */
.tags {
  flex: none;
  max-height: 168px;
  overflow-y: auto;
  padding: 8px 12px 10px;
  border-top: 1px solid var(--n-line);
}

.tags-head {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 7px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--n-fg-faint);
}

.tags-head svg {
  fill: none;
  stroke: currentColor;
}

.tags-clear {
  margin-left: auto;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--n-fg-faint);
}

.tags-clear:hover {
  background: var(--n-bg);
  color: var(--n-danger);
}

.tags-body {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  font-size: 11.5px;
  border-radius: 11px;
  border: 1px solid var(--n-line);
  background: var(--n-raised);
  color: var(--n-fg-dim);
  transition: all var(--n-dur) var(--n-ease);
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
  opacity: 0.6;
}

/* ── 底部 ── */
.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px 7px 12px;
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
</style>
