<script setup lang="ts">
/**
 * 中间那一列。
 *
 * 它的顶部分成两种情形，和参考图一样：
 *
 * · 「笔记」这一类（笔记 / 大纲 / 引用）—— 顶上一排页签，右边一个「+」。
 *   三种看法看的是同一批东西，所以并排放在一排里。
 *
 * · 附件库 / 回收站 / AI 编写 —— 各自是一次单独的「去某个地方」，
 *   顶栏只写自己叫什么，没有页签。它们从侧栏的入口切过来。
 *
 * 为什么不再各开一个弹窗：插图时不该离开正文（左边挑素材，右边光标还等着），
 * 开着 AI 对话也该同时看得见要改的那一篇 —— AI 铺满整屏反而把正文挡住了。
 *
 * 这一列可收（宽度还给正文）、可拖（见 SplitHandle），宽度都会记住。
 */
import { computed, watch } from 'vue'
import { FileText, ListTree, PanelLeftClose, Paperclip, Plus, Quote, Sparkles, Trash2 } from 'lucide-vue-next'
import { store } from '@/store'
import type { ColumnView } from '@/store'
import NoteListView from './NoteListView.vue'
import AttachView from './AttachView.vue'
import TrashView from './TrashView.vue'
import OutlineView from './OutlineView.vue'
import QuoteView from './QuoteView.vue'
import AiChatPanel from './AiChatPanel.vue'

const { state } = store

/**
 * 笔记这一类里的三种看法。
 *
 * 大纲那一格可以被设置关掉（原来它指的是「预览区右侧的大纲」，
 * 那一栏已经没了，开关挪到这一格上）：有人从来不看标题导航，
 * 少一格省得每次都从它旁边划过去。
 */
const NOTE_TABS = computed(() =>
  [
    { id: 'notes' as ColumnView, label: '笔记', icon: FileText },
    { id: 'outline' as ColumnView, label: '大纲', icon: ListTree },
    { id: 'quote' as ColumnView, label: '引用', icon: Quote },
  ].filter((t) => t.id !== 'outline' || state.outline),
)

/** 另外三种：各占一屏，靠侧栏入口切过来 */
const SOLO: Record<string, { label: string; icon: unknown }> = {
  attach: { label: '附件库', icon: Paperclip },
  trash: { label: '回收站', icon: Trash2 },
  ai: { label: 'AI 编写', icon: Sparkles },
}

const view = computed(() => state.columnView)
const isNoteTab = computed(() => NOTE_TABS.value.some((t) => t.id === view.value))
const solo = computed(() => SOLO[view.value] ?? SOLO.notes)
const noteCount = computed(() => store.visibleFiles.value.length)

function pick(id: ColumnView) {
  store.setColumnView(id)
}

/** 大纲那一格被关掉时不能停在它上面——那样这一列就成了一块空白 */
watch(
  () => state.outline,
  (on) => {
    if (!on && state.columnView === 'outline') store.setColumnView('notes')
  },
  { immediate: true },
)

/** 页签上的小数字：只有「笔记」这一格能立刻算出来 */
function tabCount(id: ColumnView) {
  return id === 'notes' ? noteCount.value : 0
}
</script>

<template>
  <section class="col" :data-view="view" aria-label="资料栏">
    <header class="col-flow">
      <!-- 笔记这一类：一排页签 + 新建 -->
      <template v-if="isNoteTab">
        <button
          v-for="t in NOTE_TABS"
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
        <button class="col-x" data-tip="新建笔记 (Ctrl+N)" title="新建笔记 (Ctrl+N)" @click="store.newNote()">
          <Plus :size="14" :stroke-width="2.1" />
        </button>
      </template>

      <!-- 另外三种：顶栏就是它的名字 -->
      <template v-else>
        <span class="col-name" :data-view="view">
          <component :is="solo.icon" :size="13" :stroke-width="1.9" />
          <span>{{ solo.label }}</span>
        </span>
        <span class="col-spacer" />
      </template>

      <button class="col-x" data-tip="收起这一栏" title="收起这一栏" @click="store.toggleColumn()">
        <PanelLeftClose :size="14" :stroke-width="1.9" />
      </button>
    </header>

    <div class="col-body">
      <NoteListView v-if="view === 'notes'" />
      <OutlineView v-else-if="view === 'outline'" />
      <QuoteView v-else-if="view === 'quote'" />
      <AttachView v-else-if="view === 'attach'" />
      <TrashView v-else-if="view === 'trash'" />
      <AiChatPanel v-else />
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
  height: var(--n-topbar);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px 0 8px;
  border-bottom: 1px solid var(--n-line);
  /* 和侧栏、编辑区一样，这一条也是窗口的抓手 */
  -webkit-app-region: drag;
}

.col-flow button {
  -webkit-app-region: no-drag;
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

/* 附件库 / 回收站 / AI 的名字行：和页签同高，但不假装能点 */
.col-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 7px;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--n-fg);
}

.col-name svg {
  fill: none;
  stroke: currentColor;
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
