<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { store } from '@/store'
import type { TreeNode } from '@/store'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const props = defineProps<{ node: TreeNode; depth?: number }>()
const { state } = store

const depth = props.depth ?? 0
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

function isOpen() {
  return !!state.expanded[props.node.path]
}

function isActive() {
  return state.activePath === props.node.path
}

function displayName() {
  return props.node.name.replace(/\.md$/i, '')
}

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
      <button class="row" :style="{ paddingLeft: 8 + depth * 12 + 'px' }" @click="store.toggleDir(node.path)">
        <svg
          class="chev"
          :class="{ open: isOpen() }"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
        <span class="name dir">{{ node.name }}</span>
      </button>
      <ul v-show="isOpen()" class="list">
        <TreeNodeItem v-for="c in node.children" :key="c.path" :node="c" :depth="depth + 1" />
      </ul>
    </template>

    <!-- 文件 -->
    <div v-else class="rowwrap">
      <input
        v-if="state.renaming === node.path"
        ref="nameInput"
        class="rename"
        :value="displayName()"
        @blur="onRenameCommit"
        @keydown="onKey"
      />
      <button
        v-else
        class="row"
        :class="{ active: isActive() }"
        :style="{ paddingLeft: 8 + depth * 12 + 18 + 'px' }"
        @click="store.openNote(node.path)"
        @dblclick="startRename"
      >
        <span class="name">{{ displayName() }}</span>
      </button>
      <button class="del" title="删除笔记" @click.stop="askDelete">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
        </svg>
      </button>

      <!-- 删除前先确认一次，避免误点把笔记删掉。
           实际动作是 shell.trashItem → 进系统回收站，所以文案如实写「回收站」。 -->
      <ConfirmDialog
        :open="confirmOpen"
        title="删除这篇笔记？"
        :message="`「${displayName()}」将被移到系统回收站。`"
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
  gap: 4px;
  height: 28px;
  padding-right: 8px;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  text-align: left;
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.row:hover {
  background: var(--n-bg);
  color: var(--n-fg);
}

.row.active {
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

.chev {
  flex: none;
  transition: transform var(--n-dur) var(--n-ease);
}

.chev.open {
  transform: rotate(90deg);
}

.name {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.name.dir {
  font-weight: 500;
  color: var(--n-fg);
}

.del {
  position: absolute;
  right: 6px;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-faint);
  opacity: 0;
  transition: opacity var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.rowwrap:hover .del {
  opacity: 1;
}

.del:hover {
  color: var(--n-danger);
}

.rename {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  font-size: 13px;
  border: 1px solid var(--n-accent);
  border-radius: var(--n-r-sm);
  background: var(--n-raised);
  outline: none;
}
</style>
