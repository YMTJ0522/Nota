<script setup lang="ts">
/**
 * 编辑区顶栏右侧的文件动作 —— 只管「当前打开的这一篇」。
 *
 * 原来是「更多操作」一个下拉里塞了导出 Markdown / 导出 HTML / 版本历史——
 * 点两下才够得着，而且三件事的性质根本不同。现在拆开：
 *   导出（另存为 md / html） · 版本历史
 * 各自一个按钮，导出保留下拉是因为它确实有两种格式要选。
 *
 * 「新建」和「导入」不在这儿：它们改的是「工作区里有哪些笔记」，不是当前这一篇，
 * 2.2.3 起挪到了资料栏右上角（那一列不管切到笔记/附件/AI，它们都在同一处）。
 */
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import {
  /* 图标统一取自 Lucide（ISC），和工具栏同源 */
  Download,
  FileCode2,
  FileDown,
  FileText,
  FileType,
  History,
} from 'lucide-vue-next'
import { store, type ExportKind } from '@/store'
import HistoryPanel from '@/components/HistoryPanel.vue'

const { state } = store

/** 顶栏导出菜单的四项。顺序、图标、文案都跟笔记右键菜单那一份保持一致
    ——两处入口长得不一样，人就会以为它们是两件不同的事。 */
const EXPORT_ITEMS: { kind: ExportKind; label: string; icon: unknown }[] = [
  { kind: 'pdf', label: '导出 PDF', icon: FileDown },
  { kind: 'word', label: '导出 Word', icon: FileType },
  { kind: 'html', label: '导出 HTML', icon: FileText },
  { kind: 'md', label: '导出 Markdown', icon: FileCode2 },
]

const openMenu = ref(false)
const historyOpen = ref(false)

const anchor = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const style = ref<Record<string, string>>({})

/** 和工具栏下拉同一套摆位逻辑：量锚点、右边缘避让。
    菜单挂在 header 里，父级没有 overflow 裁剪，但仍用 fixed
    保持和工具栏一致的行为（窗口 resize 时不会错位）。
    默认从按钮左缘起排（菜单出现在按钮右侧），贴到窗口右缘
    放不下时退回右对齐 —— 靠边的那颗按钮不能把菜单挤出屏幕。 */
function place() {
  const a = anchor.value
  const m = menu.value
  if (!a || !m) return
  const r = a.getBoundingClientRect()
  const mw = Math.ceil(m.getBoundingClientRect().width)
  const EDGE = 8
  let left = r.left
  if (left + mw > window.innerWidth - EDGE) left = r.right - mw
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

async function doExport(kind: ExportKind) {
  close()
  // PDF 要开一个隐藏窗口打印，比另存慢一截；先给一句反馈，别让人以为没点上
  if (kind === 'pdf' || kind === 'word') toast('正在生成，稍等…')
  const path = await store.exportNote(kind)
  if (path) toast(`已导出到 ${path}`)
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
        <button
          v-for="it in EXPORT_ITEMS"
          :key="it.kind"
          class="ea-item hm-item n-menu-item"
          @click="doExport(it.kind)"
        >
          <component :is="it.icon" :size="14" :stroke-width="1.8" />
          <span class="n-menu-name">{{ it.label }}</span>
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
