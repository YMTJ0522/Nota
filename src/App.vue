<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch } from 'vue'
import { store } from '@/store'
import SidePanel from '@/components/SidePanel.vue'
import SideColumn from '@/components/SideColumn.vue'
import SplitHandle from '@/components/SplitHandle.vue'
import EditorPane from '@/components/EditorPane.vue'
import WelcomeView from '@/components/WelcomeView.vue'
import WindowControls from '@/components/WindowControls.vue'
import ToastHost from '@/components/ToastHost.vue'

const { state } = store

/**
 * 附件库 / 回收站不再各开一个窗口，它们现在是中间那一列里的视图。
 * 侧栏那两枚入口（可能还带着「我想看回收站」的意图）改成切这一列的视图。
 */
function onLibrary(e: Event) {
  const which = (e as CustomEvent<'attach' | 'trash'>).detail
  if (!state.column) store.toggleColumn()
  store.setColumnView(which === 'trash' ? 'trash' : 'attach')
}

/** 窗口宽度：中间那一列的「自适应」要跟着它走，所以得是个响应式的值。
    用 ResizeObserver 而不是 resize 事件 —— 窗口最大化、系统缩放、
    拖分隔线之外的各种尺寸变化都能收到。 */
const winW = ref(window.innerWidth)
let ro: ResizeObserver | null = null

/** 各栏宽度由 SplitHandle 拖着改，这里只负责把它们写到 CSS 变量上。
    中间那一列没被人拖过时走「自适应」：窗口宽它就宽，但始终给编辑区留够地方。 */
const colW = computed(() => store.effectiveColumnWidth(winW.value))

function widthVars() {
  return {
    '--side-w': `${state.sidebarWidth}px`,
    '--col-w': `${colW.value}px`,
    '--outline-w': `${state.outlineWidth}px`,
  }
}

// AI 入口被关掉时不能停在聊天视图——那样这一列就成了一块空白
watch(
  () => state.ai.enabled,
  (enabled) => {
    if (!enabled && state.columnView === 'ai') store.setColumnView('notes')
  },
  { immediate: true },
)

function onKey(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return

  if (e.key === 's') {
    e.preventDefault()
    store.saveNote()
  } else if (e.key === 'n') {
    e.preventDefault()
    store.newNote()
  } else if (e.key === 'o') {
    e.preventDefault()
    store.openWorkspace()
  } else if (e.key === '\\') {
    // 侧边栏折叠/展开
    e.preventDefault()
    store.toggleSidebar()
  }
}

onMounted(() => {
  store.initTheme()
  store.initPrefs()
  window.addEventListener('keydown', onKey)
  window.addEventListener('nota:library', onLibrary)
  ro = new ResizeObserver(() => {
    winW.value = window.innerWidth
  })
  ro.observe(document.documentElement)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('nota:library', onLibrary)
  ro?.disconnect()
})
</script>

<template>
  <div class="shell">
    <!-- 顶部不再有一条横贯整窗的标题栏：
         侧栏顶部放「资料库」和收起按钮，中间栏顶部放页签，
         右侧编辑区顶部放标题与路径 —— 三块各管各的，像参考图那样。
         窗口控制按钮跟着右侧编辑区走（见 EditorPane / 下面那条空态条）。 -->
    <div class="body" :style="widthVars()">
      <SidePanel v-if="state.root" />
      <SplitHandle v-if="state.root && state.sidebar" target="sidebar" label="拖动调整侧边栏宽度" />
      <!-- 资料栏收起/展开是一次「整块滑走 / 滑回来」：v-if 直接删掉的话，
           编辑区会硬生生跳一大截。用 Transition 让它在 0 宽度上收缩/张开。
           侧栏那一条本来就有自己的宽度过渡（它收起后还要留一条图标窄轨）。 -->
      <Transition name="colx">
        <SideColumn v-if="state.root && state.column" />
      </Transition>
      <SplitHandle v-if="state.root && state.column" target="column" label="拖动调整资料栏宽度" />

      <main class="main">
        <!-- 右侧编辑区自己会画顶栏；没有打开笔记时它不出现，
             所以这两种空态各自补一条顶栏，窗口才拖得动、关得掉 -->
        <header v-if="!state.activePath" class="bare">
          <span class="mark">Nota</span>
          <WindowControls />
        </header>

        <WelcomeView v-if="!state.root" />
        <EditorPane v-else-if="state.activePath" />
        <div v-else class="idle">
          <p>从左侧选一篇笔记，或者<button class="link" @click="store.newNote()">新建一篇</button></p>
        </div>
      </main>
    </div>

    <!-- 全应用共用的轻提示：把各处抛出的 nota:toast 接住 -->
    <ToastHost />
  </div>
</template>


<style scoped>
.shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--n-bg);
}

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--n-bg);
}

/* 资料栏收起 / 展开：宽度从 0 滑到 --col-w。
   `!important` 是因为 .col 自己那条 `width: var(--col-w)` 和这里同权重，
   写不写全靠谁在后面，太脆；不如明说这一刻就是 0。
   只在进出场这两百多毫秒里挂过渡，窗口缩放时宽度照旧是瞬时的
   —— 拖窗口时栏跟在后面甩，比不动画还难受。 */
.colx-enter-active,
.colx-leave-active {
  overflow: hidden;
  transition:
    width 200ms var(--n-ease),
    opacity 160ms var(--n-ease);
}

.colx-enter-from,
.colx-leave-to {
  width: 0 !important;
  opacity: 0;
}

/* 空态下的顶栏：只有名字和三颗窗口按钮，
   整条都是拖动区（按钮自己声明 no-drag）。 */
.bare {
  flex: none;
  height: var(--n-topbar);
  display: flex;
  align-items: center;
  padding-left: 14px;
  background: var(--n-surface);
  border-bottom: 1px solid var(--n-line);
  -webkit-app-region: drag;
}

.mark {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--n-fg);
}

.idle {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--n-fg-dim);
  font-size: 14px;
}

.link {
  color: var(--n-accent);
  text-decoration: underline;
  text-underline-offset: 3px;
  padding: 0 2px;
}
</style>
