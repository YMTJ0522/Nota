<script setup lang="ts">
/**
 * 中间那一列的「大纲」视图。
 *
 * 数据不是这里解析的：编辑区每渲染一次预览就会把标题结构写进 store
 * （state.headings），这里只负责把它列出来。两个地方各解析一遍
 * Markdown 既费时，又可能出现「编辑区看到 3 个标题、大纲里只有 2 个」。
 *
 * 点一条不是自己滚，而是抛个事件给编辑区 —— 该滚的是正文，
 * 而且分栏模式下预览区和编辑区要一起过去。
 */
import { computed } from 'vue'
import { ListTree } from 'lucide-vue-next'
import { store } from '@/store'

const { state } = store

const heads = computed(() => state.headings)

function go(id: string) {
  const h = heads.value.find((x) => x.id === id)
  if (h) window.dispatchEvent(new CustomEvent('nota:heading', { detail: h }))
}
</script>

<template>
  <div class="ov">
    <div class="pn-head">
      <span class="pn-ico"><ListTree :size="13" :stroke-width="1.9" /></span>
      <span class="pn-title">大纲</span>
      <span class="pn-sub">{{ heads.length }}</span>
    </div>

    <div class="pn-body">
      <div v-if="!state.activePath" class="pn-empty">先打开一篇笔记</div>
      <div v-else-if="heads.length === 0" class="pn-empty">
        这篇还没有标题。用 <code>## 标题</code> 起一个小节，大纲就会长出来。
      </div>
      <nav v-else class="ov-list" aria-label="笔记大纲">
        <button
          v-for="h in heads"
          :key="h.id"
          class="ov-item"
          :class="{ on: h.id === state.activeHeading }"
          :style="{ paddingLeft: 10 + (h.level - 1) * 12 + 'px' }"
          :title="h.text || '未命名标题'"
          @click="go(h.id)"
        >
          <span class="ov-lv">H{{ h.level }}</span>
          <span class="ov-text">{{ h.text || '未命名标题' }}</span>
        </button>
      </nav>
    </div>
  </div>
</template>

<style scoped>
.ov {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.ov-list {
  padding: 4px 6px 10px;
}

.ov-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 8px;
  border-radius: var(--n-r-sm);
  text-align: left;
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.ov-item:hover {
  background: color-mix(in oklab, var(--n-raised) 70%, transparent);
}

/* 当前读到哪一节：一条细竖线 + 提亮的字。
   不用实色块盖住整行——大纲是「瞄一眼就知道位置」的东西，
   块太重会把左边标题序号也吃掉。 */
.ov-item.on {
  background: var(--n-accent-soft);
  box-shadow: inset 2px 0 0 var(--n-accent);
}

.ov-item.on .ov-lv {
  color: var(--n-accent);
}

.ov-item.on .ov-text {
  color: var(--n-fg);
  font-weight: 600;
}

.ov-lv {
  flex: none;
  width: 18px;
  font-family: var(--n-font-mono);
  font-size: 9.5px;
  color: var(--n-fg-faint);
}

.ov-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--n-fg-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ov-item:hover .ov-text {
  color: var(--n-fg);
}
</style>
