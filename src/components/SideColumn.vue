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
 *
 * 顶行最右是「新建笔记 / 导入已有笔记」——一进一出，管的是「工作区里有哪些笔记」，
 * 所以住在列表面这一侧，而不是编辑区顶行（那里剩下的是「对当前这一篇做什么」：
 * 导出、版本历史）。
 */
import { computed, ref, watch } from 'vue'
import {
  FilePlus2,
  FileText,
  ListTree,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Quote,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-vue-next'
import { store } from '@/store'
import { useFitTiers } from '@/composables/fit-tiers'
import type { ColumnView } from '@/store'
import NoteListView from './NoteListView.vue'
import AttachView from './AttachView.vue'
import TrashView from './TrashView.vue'
import OutlineView from './OutlineView.vue'
import QuoteView from './QuoteView.vue'
import AiChatPanel from './AiChatPanel.vue'

const { state } = store

/* 顶行挤窄时的让位：这一排放着三个页签（带计数）和三枚入口按钮
   （新建 / 导入 / 收起这一栏），栏宽到 220 的下限时它们会互相挤到一起去。
   让位顺序：先收掉页签上的计数 → 再把页签内边距压到最小 →
   最后连页签文字一起收掉，只留图标（有 title，鼠标停上去看得到名字）。
   入口按钮一直留着：它们是这一栏唯一的新建 / 导入 / 收起入口，
   收掉就等于这一栏在窄的时候干不了活。
   用哪一档由这一行自己试出来（见 useFitTiers）。 */
const colEl = ref<HTMLElement | null>(null)
const flowEl = ref<HTMLElement | null>(null)
const { tier: flowTier } = useFitTiers(flowEl, colEl, 3)

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

/**
 * 另外三种：各占一屏，靠侧栏入口切过来。
 *
 * 这张表只有那三种 —— 「笔记 / 大纲 / 引用」是页签，名字和图标在
 * NOTE_TABS 里。所以「当前这一屏叫什么」要分两路问，不能一路问到底：
 * 收起后的窄轨上要写这一栏收着的是什么，笔记类得回页签那张表去要，
 * 拿 SOLO[view] 去问会拿到 undefined（第一版就栽在这儿，
 * 一点收起整列渲染抛错，编辑区宽度是还回来了，列自己没了）。
 */
const SOLO: Record<string, { label: string; icon: unknown }> = {
  attach: { label: '附件库', icon: Paperclip },
  trash: { label: '回收站', icon: Trash2 },
  ai: { label: 'AI 编写', icon: Sparkles },
}

const view = computed(() => state.columnView)
const isNoteTab = computed(() => NOTE_TABS.value.some((t) => t.id === view.value))
const solo = computed(() => {
  if (isNoteTab.value) {
    const t = NOTE_TABS.value.find((x) => x.id === view.value)
    return { label: t?.label ?? '笔记', icon: t?.icon ?? FileText }
  }
  return SOLO[view.value] ?? { label: '笔记', icon: FileText }
})
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

/**
 * 新建：顺手把这一列切回「笔记」。
 *
 * 住在资料栏右上角，就得对得起这个位置 —— 在「大纲」「引用」页签下点它，
 * 新笔记是建了，可眼前这一屏跟新笔记半点关系都没有，看着像没反应。
 */
async function doNew() {
  if (!state.root) return
  await store.newNote()
  if (isNoteTab.value && view.value !== 'notes') store.setColumnView('notes')
}

/** 导入要读文件再写文件，给个转圈，免得以为点了没反应 */
const importing = ref(false)

async function doImport() {
  if (importing.value) return
  importing.value = true
  try {
    const added = await store.importNotes()
    if (!added.length) return
    window.dispatchEvent(
      new CustomEvent('nota:toast', {
        detail: `已导入 ${added.length} 篇：${added.map((a) => a.name).join('、')}`,
      }),
    )
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <section ref="colEl" class="col" :class="{ folded: !state.column }" :data-view="view" aria-label="资料栏">
    <template v-if="state.column">
    <header ref="flowEl" class="col-flow" :data-crammed="flowTier || null">
      <!-- 笔记这一类：一排页签。 -->
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
      </template>

      <!-- 另外三种：顶栏就是它的名字 -->
      <template v-else>
        <span class="col-name" :data-view="view">
          <component :is="solo.icon" :size="13" :stroke-width="1.9" />
          <span>{{ solo.label }}</span>
        </span>
        <span class="col-spacer" />
      </template>

      <!-- 一进一出，永远在这一列的右上角：
           不管当前看的是笔记、附件还是 AI，收起笔记的地方都在同一处。 -->
      <button
        class="col-act"
        data-role="new-note"
        title="新建笔记 (Ctrl+N)"
        :disabled="!state.root"
        @click="doNew"
      >
        <FilePlus2 :size="14" :stroke-width="1.9" />
      </button>
      <button
        class="col-act"
        data-role="import-note"
        title="导入已有笔记"
        :disabled="!state.root || importing"
        @click="doImport"
      >
        <Loader2 v-if="importing" class="spinning" :size="14" :stroke-width="1.9" />
        <Upload v-else :size="14" :stroke-width="1.9" />
      </button>
      <!-- 收起这一栏的开关长在它自己这一列上，不在侧栏顶行。
           侧栏顶行让给了「收起侧边栏」——两栏各自的开关各在各列，
           不会并排成一对看着像同级、其实谁跟谁都不是一回事的按钮。 -->
      <button
        class="col-act"
        data-role="column-toggle"
        data-tip="收起资料栏 (Ctrl+Shift+\)"
        @click="store.toggleColumn()"
      >
        <PanelRightClose :size="14" :stroke-width="1.9" />
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
    </template>

    <!-- ══ 收起态：一条窄轨 ══
         不是「完全消失 + 在别处留个入口」。完全消失之后，
         人得先在脑子里记着「它去哪了」，再去侧栏找那个入口——
         而那个入口跟侧栏自己的开关挨在一起，正是当初嫌难看的那副样子。
         留一条 34px 的窄轨，展开钮就在上面，原处来回，不用找。
         侧栏收起时也是这样一条窄轨，两栏用同一种语言。 -->
    <div v-else class="col-fold">
      <button
        class="fold-btn"
        data-role="column-toggle"
        data-tip="展开资料栏 (Ctrl+Shift+\)"
        @click="store.toggleColumn()"
      >
        <PanelRightOpen :size="15" :stroke-width="1.9" />
      </button>
      <span class="fold-crumb" :title="solo.label">
        <component :is="solo.icon" :size="13" :stroke-width="1.9" />
      </span>
      <span class="fold-spacer" />
      <span v-if="isNoteTab" class="fold-n">{{ noteCount }}</span>
    </div>
  </section>
</template>

<style scoped>
.col {
  flex: none;
  /* 收放是一次宽度过渡，不是突然消失：整列直接没掉的那一瞬间，
     编辑区会猛地往左跳一大截，眼睛根本跟不上。 */
  transition: width 200ms var(--n-ease);
  width: var(--col-w, 296px);
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--n-line);
  background: color-mix(in oklab, var(--n-sunken) 62%, var(--n-bg));
  overflow: hidden;
}

/* ── 收起态：34px 的窄轨 ── */
.col.folded {
  width: 34px;
}

.col-fold {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 5px 0;
  gap: 2px;
}

.fold-btn {
  flex: none;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
}

.fold-btn svg {
  fill: none;
  stroke: currentColor;
}

.fold-btn:hover {
  background: var(--n-bg);
  color: var(--n-accent);
}

/* 当前这一屏是什么。窄归窄，不能让人忘了这儿收着的是什么东西 */
.fold-crumb {
  flex: none;
  display: inline-flex;
  padding: 4px 0;
  color: var(--n-fg-faint);
}

.fold-crumb svg {
  fill: none;
  stroke: currentColor;
}

.fold-spacer {
  flex: 1;
  min-height: 0;
}

.fold-n {
  flex: none;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--n-fg-faint);
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

/* 挤窄时的让位顺序（档位由 useFitTiers 试出来，详见脚本上方的说明）：
   1 档 收掉页签上的计数 —— 它只是个数字，点开才知道有多少篇也不迟
   2 档 再压页签的内边距与行间距
   3 档 连页签文字一起收掉，只留图标 —— 顶行宁可只剩三个图标也不能溢出，
        溢出时最右边那枚「收起这一栏」会被切掉一半，那才是真的没法用 */
.col-flow[data-crammed="1"],
.col-flow[data-crammed="2"],
.col-flow[data-crammed="3"] {
  padding: 0 4px 0 6px;
}

.col-flow[data-crammed="2"],
.col-flow[data-crammed="3"] {
  gap: 0;
}

.col-flow[data-crammed="1"] .col-tab-n,
.col-flow[data-crammed="2"] .col-tab-n,
.col-flow[data-crammed="3"] .col-tab-n {
  display: none;
}

.col-flow[data-crammed="2"] .col-tab,
.col-flow[data-crammed="3"] .col-tab {
  padding: 0 4px;
}

.col-flow[data-crammed="3"] .col-tab-label {
  display: none;
}

.col-flow[data-crammed="3"] .col-tab {
  padding: 0 5px;
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

/* 右上角的两枚动作：和页签同高、同圆角，看着是同一排里的东西 */
.col-act {
  flex: none;
  width: 26px;
  height: 24px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  transition:
    background var(--n-dur) var(--n-ease),
    color var(--n-dur) var(--n-ease);
}

.col-act svg {
  fill: none;
  stroke: currentColor;
}

.col-act:hover:not(:disabled) {
  background: var(--n-raised);
  color: var(--n-accent);
}

.col-act:disabled {
  opacity: 0.4;
  cursor: default;
}

.spinning {
  animation: col-spin 900ms linear infinite;
}

@keyframes col-spin {
  to {
    transform: rotate(360deg);
  }
}

.col-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/**
 * 页签切换时内容淡入。
 *
 * 只做「进来」这一半，不做「出去」：Vue 的 v-if / v-else-if 本来就是
 * 同一帧里拆旧装新，再配 out-in 反而中间会空出一百多毫秒的空白，
 * 看着比不动画还卡。新的那块直接带一段极短的淡入 + 3px 上移就够顺了。
 *
 * 选择器写 `.col-body > *`：这几个视图各自是子组件，Vue 会把父组件的
 * scope id 打到它们的根元素上，所以 scoped 样式够得着。
 */
.col-body > * {
  animation: n-view-in 170ms var(--n-ease);
}

@keyframes n-view-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
