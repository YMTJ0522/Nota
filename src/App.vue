<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch } from 'vue'
import { store } from '@/store'
import SidePanel from '@/components/SidePanel.vue'
import SideColumn from '@/components/SideColumn.vue'
import SplitHandle from '@/components/SplitHandle.vue'
import EditorPane from '@/components/EditorPane.vue'
import GraphView from '@/components/GraphView.vue'
import SearchPalette from '@/components/SearchPalette.vue'
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
  store.setColumnView(which === 'trash' ? 'trash' : 'attach')
}

/**
 * 搜索面板：一个面板两个快捷键。
 *
 * · Ctrl+P —— 只搜标题与路径（纯内存，几十毫秒）；
 * · Ctrl+Shift+F —— 连正文一起搜（要读磁盘，所以另开一个键）。
 * body 这个标记决定打开时搜不搜正文，面板自己按它改文案和提示。
 */
const search = ref<{ open: boolean; body: boolean }>({ open: false, body: false })

/** 窗口宽度：中间那一列的「自适应」要跟着它走，所以得是个响应式的值。
    用 ResizeObserver 而不是 resize 事件 —— 窗口最大化、系统缩放、
    拖分隔线之外的各种尺寸变化都能收到。 */
const winW = ref(window.innerWidth)
let ro: ResizeObserver | null = null

/** 各栏宽度由 SplitHandle 拖着改，这里只负责把它们写到 CSS 变量上。
    中间那一列没被人拖过时走「自适应」：窗口宽它就宽，但始终给编辑区留够地方。 */
const colW = computed(() => store.effectiveColumnWidth(winW.value))
/**
 * 侧栏真正画出来的宽度也得走同一个算法（`sidebarNow`），不能直接用存的那个值。
 * 存的宽度是上次在**宽窗口**里拖出来的，换个窄窗口它就已经站不下了 ——
 * 只在上限计算里收着、渲染时照旧画，结果是三栏加起来超过窗口，
 * 被挤的是编辑区（实测 960px 下编辑区只剩 508，比它的下限 520 还窄）。
 */
const sideW = computed(() => store.sidebarNow(winW.value))

function widthVars() {
  return {
    '--side-w': `${sideW.value}px`,
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
    // 侧边栏折叠/展开。资料栏没有这个快捷键 —— 它一直开着。
    e.preventDefault()
    store.toggleSidebar()
  } else if (e.key === 'p') {
    e.preventDefault()
    search.value = { open: true, body: false }
  } else if (e.shiftKey && (e.key === 'F' || e.key === 'f')) {
    e.preventDefault()
    search.value = { open: true, body: true }
  } else if (e.shiftKey && (e.key === 'G' || e.key === 'g')) {
    e.preventDefault()
    store.toggleGraph()
  }
}

/**
 * 正文、AI 回答、来源列表里都会出现 http(s) 链接。
 * 直接让默认行为跑的话，Electron 会把整个应用窗口导航到那个网址——
 * 界面没了，笔记还在。所以统一拦下来交给系统浏览器。
 *
 * 用 window.open 而不是 IPC：主进程已经装了 setWindowOpenHandler，
 * 它会把新窗口转成 shell.openExternal 并 deny 掉，正好是我们要的行为。
 */
function onLinkClick(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0) return
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const el = e.target as HTMLElement | null
  const a = el?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!a) return
  const href = a.getAttribute('href') ?? ''
  if (!/^https?:\/\//i.test(href)) return
  e.preventDefault()
  window.open(href, '_blank', 'noopener')
}

/** 侧栏的点「全文搜索」/「关系图」这类入口 → 打开搜索面板 */
function onPalette(e: Event) {
  const which = (e as CustomEvent<'name' | 'body'>).detail
  search.value = { open: true, body: which === 'body' }
}

onMounted(async () => {
  store.initTheme()
  store.initPrefs()
  // 回到上次那个工作区（与上次在看的那篇）。失败就退回欢迎页，不弹错误 ——
  // 「盘不在了」这种事用户自己一看就明白，弹窗反而是打扰。
  await store.restoreLastWorkspace()
  window.addEventListener('keydown', onKey)
  window.addEventListener('nota:palette', onPalette)
  window.addEventListener('nota:library', onLibrary)
  document.addEventListener('click', onLinkClick)
  ro = new ResizeObserver(() => {
    winW.value = window.innerWidth
  })
  ro.observe(document.documentElement)
})

/* 资料栏常驻，宽度靠 `effectiveColumnWidth` 自己收上限（见 store），
   侧栏那边也有一道上限（`sidebarNow`）。两道都只跟当前窗口现算，
   所以窗口怎么变都不需要额外再收放一次 —— 以前这里挂着一个
   「窄到放不下就把整栏收掉」的 watcher，现在那条路不存在了。 */

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('nota:palette', onPalette)
  window.removeEventListener('nota:library', onLibrary)
  document.removeEventListener('click', onLinkClick)
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
      <!-- 资料栏常驻：没有收起态，也就没有「叫它回来」的入口要放在别处。 -->
      <SideColumn v-if="state.root" />
      <SplitHandle v-if="state.root" target="column" label="拖动调整资料栏宽度" />

      <main class="main">
        <!-- 右侧编辑区自己会画顶栏；没有打开笔记时它不出现，
             所以这两种空态各自补一条顶栏，窗口才拖得动、关得掉 -->
        <header v-if="!state.activePath" class="bare">
          <span class="mark">Nota</span>
          <WindowControls />
        </header>

        <WelcomeView v-if="!state.root" />
        <!-- 关系图占的是主区（中间那一列只有 300px，画不下几百个节点）。
             它不是「关掉当前笔记」：从图上点一篇跳过去、再关掉图，正文还该在。 -->
        <GraphView v-else-if="state.graphOpen" />
        <EditorPane v-else-if="state.activePath" />
        <div v-else class="idle">
          <p>从左侧选一篇笔记，或者<button class="link" @click="store.newNote()">新建一篇</button></p>
        </div>
      </main>
    </div>

    <SearchPalette
      :open="search.open"
      :body="search.body"
      @close="search.open = false"
    />

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

/* 资料栏收起 / 展开的过渡写在 SideColumn 自己的 `.col` 上（宽度 200ms）。
   这里不再需要 Transition：那一列现在是常驻渲染的，收起态只是它内部的一次
   换装（一条 34px 的窄轨），不存在「整块被移出 DOM」这回事。 */

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
