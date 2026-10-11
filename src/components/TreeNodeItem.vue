<script setup lang="ts">
import { ref, nextTick, computed } from 'vue'
import { ChevronRight, FileText, Folder, FolderOpen, Trash2 } from 'lucide-vue-next'
import { store } from '@/store'
import type { TreeNode } from '@/store'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const props = defineProps<{ node: TreeNode; depth?: number }>()
const { state } = store

const depth = computed(() => props.depth ?? 0)
const nameInput = ref<HTMLInputElement | null>(null)

/** 删除确认弹窗：先记下要删的路径，等用户点确认才真删 */
const confirmOpen = ref(false)

function askDelete() {
  confirmOpen.value = true
}

async function doDelete() {
  confirmOpen.value = false
  await store.removeNote(props.node.path)
}

const isOpen = computed(() => !!state.expanded[props.node.path])
const isActive = computed(() => state.activePath === props.node.path)
const displayName = computed(() => props.node.name.replace(/\.md$/i, ''))

async function onRenameCommit(e: Event) {
  const val = (e.target as HTMLInputElement).value
  if (val.trim()) await store.renameNote(props.node.path, val)
  else state.renaming = null
}

function startRename() {
  state.renaming = props.node.path
  nextTick(() => nameInput.value?.select())
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
  if (e.key === 'Escape') {
    state.renaming = null
  }
}
</script>

<template>
  <li>
    <!-- 目录 -->
    <template v-if="node.type === 'dir'">
      <button
        class="row dir"
        :style="{ paddingLeft: 4 + depth * 13 + 'px' }"
        @click="store.toggleDir(node.path)"
      >
        <ChevronRight class="chev" :class="{ open: isOpen }" :size="12" :stroke-width="2.2" />
        <span class="ico">
          <FolderOpen v-if="isOpen" :size="14" :stroke-width="1.9" />
          <Folder v-else :size="14" :stroke-width="1.9" />
        </span>
        <span class="name dir">{{ node.name }}</span>
      </button>
      <ul v-show="isOpen" class="list">
        <TreeNodeItem v-for="c in node.children" :key="c.path" :node="c" :depth="depth + 1" />
      </ul>
    </template>

    <!-- 文件 -->
    <div v-else class="rowwrap">
      <input
        v-if="state.renaming === node.path"
        ref="nameInput"
        class="rename"
        :value="displayName"
        @blur="onRenameCommit"
        @keydown="onKey"
      />
      <button
        v-else
        class="row file"
        :class="{ active: isActive }"
        :style="{ paddingLeft: 4 + depth * 13 + 'px' }"
        @click="store.openNote(node.path)"
        @dblclick="startRename"
      >
        <span class="chev-slot" />
        <span class="ico">
          <FileText :size="14" :stroke-width="1.9" />
        </span>
        <span class="name">{{ displayName }}</span>
        <span v-if="node.starred" class="star">★</span>
      </button>
      <button class="del" title="删除笔记" @click.stop="askDelete">
        <Trash2 :size="15" :stroke-width="1.9" />
      </button>

      <!-- 删除前先确认一次，避免误点把笔记删掉。
           实际动作是移到工作区内的 .nota/trash，所以文案写明能恢复、去哪恢复。 -->
      <ConfirmDialog
        :open="confirmOpen"
        title="删除这篇笔记？"
        :message="`「${displayName}」将被移到回收站，可以在「附件库与回收站」里恢复。`"
        confirm-text="删除"
        danger
        @confirm="doDelete"
        @cancel="confirmOpen = false"
      />
    </div>
  </li>
</template>

<style scoped>
.list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.rowwrap {
  position: relative;
  display: flex;
  align-items: center;
}

.row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding-right: 8px;
  border-radius: var(--n-r-md);
  color: var(--n-fg-dim);
  text-align: left;
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.row:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}

.row.active {
  background: var(--n-accent-soft);
  color: var(--n-fg);
}

.row.active .ico {
  color: var(--n-accent);
}

.chev {
  flex: none;
  fill: none;
  stroke: currentColor;
  color: var(--n-fg-faint);
  transition: transform var(--n-dur) var(--n-ease);
}

.chev.open {
  transform: rotate(90deg);
}

/* 文件行没有折叠箭头，用一个同宽的占位把图标对齐到目录的图标列 */
.chev-slot {
  flex: none;
  width: 12px;
}

.ico {
  flex: none;
  display: inline-flex;
  color: var(--n-fg-faint);
  transition: color var(--n-dur) var(--n-ease);
}

.ico svg {
  fill: none;
  stroke: currentColor;
}

.name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.name.dir {
  font-weight: 500;
  color: var(--n-fg);
}

.star {
  flex: none;
  font-size: 10px;
  color: var(--n-warn);
}

.del {
  position: absolute;
  right: 4px;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  background: var(--n-raised);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease),
    background var(--n-dur) var(--n-ease);
}

.del svg {
  fill: none;
  stroke: currentColor;
}

.rowwrap:hover .del {
  opacity: 1;
  pointer-events: auto;
}

.del:hover {
  background: var(--n-danger-soft);
  color: var(--n-danger);
}

.rename {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  font-size: 12.5px;
  border: 1px solid var(--n-accent);
  border-radius: var(--n-r-sm);
  background: var(--n-raised);
  color: var(--n-fg);
  outline: none;
}
</style>
