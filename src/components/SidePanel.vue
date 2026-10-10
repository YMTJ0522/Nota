<script setup lang="ts">
import { watch } from 'vue'
import { store } from '@/store'
import TreeNodeItem from './TreeNodeItem.vue'

const { state } = store

// 目录树刷新后自动展开顶层目录
watch(
  () => state.tree,
  () => store.autoExpand()
)
</script>

<template>
  <aside class="panel">
    <div class="head">
      <span class="label">资料库</span>
      <button class="mini" title="新建笔记 (Ctrl+N)" @click="store.newNote()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>

    <div class="tree">
      <div v-if="state.loading" class="hint">读取中…</div>
      <div v-else-if="state.tree.length === 0" class="hint">这个目录里还没有 .md 文件</div>
      <ul v-else class="list">
        <TreeNodeItem v-for="n in state.tree" :key="n.path" :node="n" />
      </ul>
    </div>

    <div class="foot">
      <span class="root" :title="state.root ?? ''">{{ state.root }}</span>
    </div>
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

.mini:hover {
  background: var(--n-bg);
  color: var(--n-accent);
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

.foot {
  flex: none;
  padding: 8px 12px;
  border-top: 1px solid var(--n-line);
}

.root {
  display: block;
  font-size: 11px;
  font-family: var(--n-font-mono);
  color: var(--n-fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
