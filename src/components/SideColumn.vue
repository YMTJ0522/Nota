<script setup lang="ts">
/**
 * 中间那一列 —— 一个栏，四件事。
 *
 * 笔记列表 / 附件库 / 回收站 / AI 编写，看起来是四样东西，但在使用上是同一件事：
 * 「当前这一类东西有哪些，我要挑一个」。所以它们共用一个栏换着看，
 * 而不是各占一个弹窗、每开一次都要先确认自己在哪一层。
 *
 * 好处最直接的体现在两处：
 *   · 插图时不用离开正文 —— 左边挑素材，右边光标还等着；
 *   · 开着 AI 对话还能看着正文 —— AI 编写从「占满主区的独立页面」改成这第四格，
 *     它的用法本来就是「边看边改」，铺满整屏反而把要改的东西挡住了。
 *
 * 这一列可收（宽度还给正文）、可拖（见 SplitHandle），宽度都会记住。
 */
import { computed } from 'vue'
import { FileText, PanelLeftClose, Paperclip, Sparkles, Trash2 } from 'lucide-vue-next'
import { store } from '@/store'
import type { ColumnView } from '@/store'
import NoteListView from './NoteListView.vue'
import AttachView from './AttachView.vue'
import TrashView from './TrashView.vue'
import AiChatPanel from './AiChatPanel.vue'

const { state } = store

const TABS: { id: ColumnView; label: string; icon: unknown }[] = [
  { id: 'notes', label: '笔记', icon: FileText },
  { id: 'attach', label: '附件', icon: Paperclip },
  { id: 'trash', label: '回收站', icon: Trash2 },
  { id: 'ai', label: 'AI', icon: Sparkles },
]

/** AI 没开就在页签里把它藏掉，省得点进去是一句「先去设置里开」 */
const tabs = computed(() => TABS.filter((t) => t.id !== 'ai' || state.ai.enabled))

const view = computed(() => state.columnView)
const noteCount = computed(() => store.visibleFiles.value.length)

function pick(id: ColumnView) {
  store.setColumnView(id)
}

/** 页签上的小数字：只有「笔记」这一格能立刻算出来，
    附件 / 回收站的条数在各自视图里，显示了反而要额外读一次盘 */
function tabCount(id: ColumnView) {
  return id === 'notes' ? noteCount.value : 0
}
</script>

<template>
  <section class="col" :data-view="view" aria-label="资料栏">
    <header class="col-flow">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="col-tab"
        :class="{ on: view === t.id }"
        :data-view="t.id"
        :aria-pressed="view === t.id"
        :title="t.label"
        @click="pick(t.id)"
      >
        <component :is="t.icon" :size="13" :stroke-width="1.9" />
        <span class="col-tab-label">{{ t.label }}</span>
        <span v-if="tabCount(t.id)" class="col-tab-n">{{ tabCount(t.id) }}</span>
      </button>
      <span class="col-spacer" />
      <button class="col-x" data-tip="收起这一栏" title="收起这一栏" @click="store.toggleColumn()">
        <PanelLeftClose :size="14" :stroke-width="1.9" />
      </button>
    </header>

    <div class="col-body">
      <NoteListView v-if="view === 'notes'" />
      <AttachView v-else-if="view === 'attach'" />
      <TrashView v-else-if="view === 'trash'" />
      <AiChatPanel v-else compact />
    </div>
  </section>
</template>

<style scoped>
.col {
  flex: none;
  width: var(--col-w, 296px);
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--n-line);
  background: color-mix(in oklab, var(--n-sunken) 62%, var(--n-bg));
  overflow: hidden;
}

/* ── 页签行 ── */
.col-flow {
  flex: none;
  height: 34px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px 0 8px;
  border-bottom: 1px solid var(--n-line);
}

.col-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 7px;
  border-radius: var(--n-r-sm);
  font-size: 11.5px;
  color: var(--n-fg-faint);
  white-space: nowrap;
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.col-tab svg {
  fill: none;
  stroke: currentColor;
  flex: none;
}

.col-tab:hover {
  color: var(--n-fg-dim);
  background: var(--n-raised);
}

.col-tab.on {
  color: var(--n-accent);
  background: var(--n-accent-soft);
  font-weight: 600;
}

.col-tab-n {
  font-size: 9.5px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--n-fg-faint);
}

.col-tab.on .col-tab-n {
  color: var(--n-accent);
}

.col-spacer {
  flex: 1;
}

.col-x {
  position: relative;
  flex: none;
  width: 22px;
  height: 22px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-faint);
}

.col-x svg {
  fill: none;
  stroke: currentColor;
}

.col-x:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}

/* 提示：窄栏里往右探会顶到正文，改成往下出 */
.col-x::after {
  content: attr(data-tip);
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 60;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--n-fg);
  color: var(--n-bg);
  font-size: 11px;
  white-space: nowrap;
  opacity: 0;
  transform: translateY(-3px);
  pointer-events: none;
  transition: opacity 130ms var(--n-ease), transform 130ms var(--n-ease);
  box-shadow: var(--n-shadow-md);
}

.col-x:hover::after {
  opacity: 1;
  transform: none;
}

.col-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
