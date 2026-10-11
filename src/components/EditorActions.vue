<script setup lang="ts">
/**
 * 编辑区顶栏右侧的三个文件动作。
 *
 * 原来是「更多操作」一个下拉里塞了导出 Markdown / 导出 HTML / 版本历史——
 * 点两下才够得着，而且三件事的性质根本不同。现在拆开：
 *   导入（把外面的 .md 收进工作区） · 导出（另存为 md / html） · 版本历史
 * 各自一个按钮，导出保留下拉是因为它确实有两种格式要选。
 */
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import {
  /* 图标统一取自 Lucide（ISC），和工具栏同源 */
  Download,
  FileCode2,
  FileText,
  History,
  Loader2,
  Upload,
} from 'lucide-vue-next'
import { store } from '@/store'
import HistoryPanel from '@/components/HistoryPanel.vue'

const { state } = store

const openMenu = ref(false)
const historyOpen = ref(false)
/** 导入要读文件再写文件，给个转圈，免得以为点了没反应 */
const importing = ref(false)

const anchor = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const style = ref<Record<string, string>>({})

/** 和工具栏下拉同一套摆位逻辑：量锚点、右边缘避让。
    菜单挂在 header 里，父级没有 overflow 裁剪，但仍用 fixed
    保持和工具栏一致的行为（窗口 resize 时不会错位）。 */
function place() {
  const a = anchor.value
  const m = menu.value
  if (!a || !m) return
  const r = a.getBoundingClientRect()
  const mw = Math.ceil(m.getBoundingClientRect().width)
  const EDGE = 8
  let left = r.right - mw
  if (left < EDGE) left = EDGE
  style.value = {
    position: 'fixed',
    top: `${Math.round(r.bottom + 4)}px`,
    left: `${Math.round(left)}px`,
  }
}

async function toggle() {
  openMenu.value = !openMenu.value
  if (!openMenu.value) return
  await nextTick()
  place()
  requestAnimationFrame(place)
}

function close() {
  openMenu.value = false
}

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

async function doExport(kind: 'md' | 'html') {
  close()
  const path = await store.exportNote(kind)
  if (path) toast(`已导出到 ${path}`)
}

/**
 * 导入：把工作区外面的 Markdown 收进来。
 * 目标目录取「当前笔记所在的目录」，没有打开的笔记就放工作区根——
 * 多数人是「正在哪写就收到哪」。
 */
async function doImport() {
  if (importing.value) return
  importing.value = true
  try {
    const added = await store.importNotes()
    if (!added.length) return
    toast(`已导入 ${added.length} 篇：${added.map((a) => a.name).join('、')}`)
  } finally {
    importing.value = false
  }
}

function onDocPointer(e: PointerEvent) {
  const el = e.target as HTMLElement
  if (!el.closest('.ea-menu') && !el.closest('.ea-anchor')) close()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

function onReposition() {
  if (openMenu.value) place()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', onReposition)
  window.addEventListener('scroll', onReposition, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onReposition)
  window.removeEventListener('scroll', onReposition, true)
})
</script>

<template>
  <div class="ea">
    <!-- 导入：和导出左右相邻，一进一出 -->
    <button
      class="ea-btn"
      title="导入 Markdown 文件到工作区"
      :disabled="!state.root || importing"
      @click="doImport"
    >
      <Loader2 v-if="importing" class="spin" :size="14" :stroke-width="1.9" />
      <Upload v-else :size="14" :stroke-width="1.9" />
    </button>

    <!-- 导出：两种格式，所以还是留一个下拉 -->
    <button
      ref="anchor"
      class="ea-btn ea-anchor hm-anchor"
      :class="{ on: openMenu }"
      title="导出当前笔记"
      :disabled="!state.activePath"
      @click="toggle"
    >
      <Download :size="14" :stroke-width="1.9" />
    </button>

    <!-- 版本历史：从原来的下拉里独立出来 -->
    <button
      class="ea-btn"
      title="版本历史"
      :disabled="!state.activePath"
      @click="historyOpen = true"
    >
      <History :size="14" :stroke-width="1.9" />
    </button>

    <Teleport to="body">
      <div v-if="openMenu" ref="menu" class="ea-menu hm-menu n-menu" :style="style">
        <button class="ea-item hm-item n-menu-item" @click="doExport('md')">
          <FileText :size="14" :stroke-width="1.8" />
          <span class="n-menu-name">导出为 Markdown</span>
        </button>
        <button class="ea-item hm-item n-menu-item" @click="doExport('html')">
          <FileCode2 :size="14" :stroke-width="1.8" />
          <span class="n-menu-name">导出为 HTML</span>
        </button>
      </div>
    </Teleport>

    <HistoryPanel :open="historyOpen" @close="historyOpen = false" />
  </div>
</template>

<style scoped>
.ea {
  display: inline-flex;
  align-items: center;
  gap: 1px;
}

.ea-btn {
  width: 26px;
  height: 24px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.ea-btn svg {
  fill: none;
  stroke: currentColor;
}

.ea-btn:hover:not(:disabled) {
  background: var(--n-raised);
  color: var(--n-fg);
}

.ea-btn.on {
  background: var(--n-raised);
  color: var(--n-accent);
}

.ea-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.spin {
  animation: ea-spin 900ms linear infinite;
}

@keyframes ea-spin {
  to { transform: rotate(360deg); }
}
</style>

<style>
/* 菜单被 Teleport 到 body，不受 scoped 约束，所以单独写一段。
   长相（描边 / 圆角 / 底色 / 阴影 / 行样式 / 入场动画）统一在
   styles/menu.css 的 .n-menu 里，这里只留这条菜单特有的东西：
   层级和宽度。类名沿用 hm-menu / hm-item，几轮回归脚本引用过它。 */
.hm-menu,
.ea-menu {
  z-index: 999;
  width: max-content;
  min-width: 154px;
}
</style>
