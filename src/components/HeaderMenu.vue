<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import {
  /* 图标统一取自 Lucide（ISC），和工具栏同源 */
  Download,
  FileText,
  FileCode2,
  History,
} from 'lucide-vue-next'
import { store } from '@/store'
import HistoryPanel from '@/components/HistoryPanel.vue'

const { state } = store

const openMenu = ref(false)
const historyOpen = ref(false)

const anchor = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const style = ref<Record<string, string>>({})

/** 和工具栏下拉同一套摆位逻辑：量锚点、右边缘避让。
    这里菜单挂在 header 里，父级没有 overflow 裁剪，但仍用 fixed
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

async function doExport(kind: 'md' | 'html') {
  close()
  const path = await store.exportNote(kind)
  if (path) window.dispatchEvent(new CustomEvent('nota:toast', { detail: `已导出到 ${path}` }))
}

function openHistory() {
  close()
  historyOpen.value = true
}

function onDocPointer(e: PointerEvent) {
  const el = e.target as HTMLElement
  if (!el.closest('.hm-menu') && !el.closest('.hm-anchor')) close()
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
  <div class="hm">
    <button
      ref="anchor"
      class="hm-anchor hm-btn"
      :class="{ on: openMenu }"
      title="更多操作"
      :disabled="!state.activePath"
      @click="toggle"
    >
      <Download :size="14" :stroke-width="1.9" />
    </button>

    <Teleport to="body">
      <div v-if="openMenu" ref="menu" class="hm-menu" :style="style">
        <button class="hm-item" @click="doExport('md')">
          <FileText :size="14" :stroke-width="1.8" />
          <span>导出为 Markdown</span>
        </button>
        <button class="hm-item" @click="doExport('html')">
          <FileCode2 :size="14" :stroke-width="1.8" />
          <span>导出为 HTML</span>
        </button>
        <span class="hm-sep" />
        <button class="hm-item" @click="openHistory">
          <History :size="14" :stroke-width="1.8" />
          <span>版本历史</span>
        </button>
      </div>
    </Teleport>

    <HistoryPanel :open="historyOpen" @close="historyOpen = false" />
  </div>
</template>

<style scoped>
.hm {
  display: inline-flex;
  align-items: center;
}

.hm-btn {
  width: 26px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.hm-btn svg {
  fill: none;
  stroke: currentColor;
}

.hm-btn:hover:not(:disabled) {
  background: var(--n-raised);
  color: var(--n-fg);
}

.hm-btn.on {
  background: var(--n-raised);
  color: var(--n-accent);
}

.hm-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>

<style>
/* 菜单本体被 Teleport 到 body，不受 scoped 约束，单独写一段 */
.hm-menu {
  z-index: 999;
  width: max-content;
  min-width: 154px;
  padding: 4px;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  box-shadow: var(--n-shadow-lg);
  animation: hm-in 120ms var(--n-ease);
}

.hm-item {
  width: 100%;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 9px;
  border-radius: var(--n-r-sm);
  font-size: 13px;
  color: var(--n-fg);
  text-align: left;
  white-space: nowrap;
}

.hm-item svg {
  fill: none;
  stroke: currentColor;
  color: var(--n-fg-faint);
  flex: none;
}

.hm-item:hover {
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

.hm-item:hover svg {
  color: var(--n-accent);
}

.hm-sep {
  display: block;
  height: 1px;
  margin: 4px 6px;
  background: var(--n-line);
}

@keyframes hm-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
</style>
