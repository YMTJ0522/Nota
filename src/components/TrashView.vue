<script setup lang="ts">
/**
 * 中间那一列的「回收站」视图。
 *
 * 删掉的笔记（进工作区的 `.nota/trash/`），能原路恢复——
 * 删之前在哪个目录就回哪个目录，因为删除时把相对路径一并存了下来。
 *
 * 和「附件库」同在中间这一列，但是两个各自独立的视图，不共用一个页签组：
 * 一个处理素材、一个处理被删的笔记，没有共同的上下文，硬凑一起只会点错。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FileText, History as HistoryIcon, RotateCcw, Trash2 } from 'lucide-vue-next'
import { store } from '@/store'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

interface TrashItem {
  key: string
  rel: string
  name: string
  deletedAt: number
  size: number
}

const items = ref<TrashItem[]>([])
const loading = ref(false)

const root = computed(() => store.state.root ?? '')

async function load() {
  if (!root.value) {
    items.value = []
    return
  }
  loading.value = true
  try {
    items.value = await window.api.trashList(root.value)
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}

watch(
  () => [root.value, store.state.columnView] as const,
  ([r, view]) => {
    if (r && view === 'trash') void load()
    else if (!r) items.value = []
  },
  { immediate: true },
)

function onLibraryChanged() {
  if (store.state.columnView === 'trash') void load()
}

onMounted(() => window.addEventListener('nota:library-changed', onLibraryChanged))
onBeforeUnmount(() => window.removeEventListener('nota:library-changed', onLibraryChanged))

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

/** 条数变了，侧栏的小数字也要跟着走 */
function announce() {
  window.dispatchEvent(new CustomEvent('nota:library-changed'))
}

async function restore(t: TrashItem) {
  await window.api.trashRestore(root.value, t.key)
  items.value = items.value.filter((x) => x.key !== t.key)
  await store.refreshTree()
  toast(`已恢复到 ${t.rel}`)
  announce()
}

/**
 * 彻底删除 / 清空都要过一道确认。
 *
 * 回收站里按下去就是**不可撤销**的（没有第二层兜底），
 * 所以不能像别处那样「点了就删」——先问一句，用户点头才动手。
 * 两件事共用同一个弹窗，靠 pending 记住这次要删的是「一条」还是「全部」。
 */
const pending = ref<{ kind: 'one'; item: TrashItem } | { kind: 'all' } | null>(null)

function askPurge(t: TrashItem) {
  pending.value = { kind: 'one', item: t }
}

function askEmpty() {
  if (items.value.length === 0) return
  pending.value = { kind: 'all' }
}

const confirmTitle = computed(() =>
  pending.value?.kind === 'all' ? '清空回收站？' : '彻底删除这篇笔记？',
)
const confirmMessage = computed(() => {
  const p = pending.value
  if (!p) return ''
  if (p.kind === 'all') return `${items.value.length} 篇被删的笔记会被永久删除，无法恢复。`
  return `「${p.item.name}」会被永久删除，无法恢复。`
})

async function doConfirm() {
  const p = pending.value
  pending.value = null
  if (!p) return
  if (p.kind === 'one') await purge(p.item)
  else await emptyAll()
}

async function purge(t: TrashItem) {
  await window.api.trashPurge(root.value, t.key)
  items.value = items.value.filter((x) => x.key !== t.key)
  toast(`已彻底删除 ${t.name}`)
  announce()
}

async function emptyAll() {
  if (items.value.length === 0) return
  await window.api.trashEmpty(root.value)
  items.value = []
  toast('回收站已清空')
  announce()
}

function sizeText(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function timeText(ms: number) {
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<template>
  <div class="tv">
    <header class="pn-head">
      <span class="pn-ico tv-ico"><Trash2 :size="14" :stroke-width="1.9" /></span>
      <span class="pn-title">回收站</span>
      <span class="pn-sub">{{ root ? `${items.length} 篇被删的笔记` : '' }}</span>
    </header>

    <div class="pn-body">
      <div v-if="!root" class="pn-empty">先打开一个笔记目录</div>
      <div v-else-if="loading" class="pn-empty">读取中…</div>
      <div v-else-if="items.length === 0" class="pn-empty">
        回收站是空的。删掉的笔记会先来这里，随时能捞回去。
      </div>
      <template v-else>
        <div class="pn-list">
          <div v-for="t in items" :key="t.key" class="pn-row">
            <FileText class="pn-row-ico" :size="14" :stroke-width="1.8" />
            <span class="pn-row-main">
              <span class="pn-row-name">{{ t.name }}</span>
              <span class="pn-row-sub">{{ timeText(t.deletedAt) }} · {{ sizeText(t.size) }}</span>
              <span class="pn-row-sub">{{ t.rel }}</span>
            </span>
            <button class="pn-act tv-restore" title="恢复到原位置" @click="restore(t)">
              <RotateCcw :size="12" :stroke-width="2" />
            </button>
            <button class="pn-act danger" title="彻底删除" @click="askPurge(t)">
              <Trash2 :size="12" :stroke-width="2" />
            </button>
          </div>
        </div>
        <div class="pn-foot">
          <span class="pn-tip">
            <HistoryIcon :size="11" :stroke-width="1.9" />
            清空之后才真的没了
          </span>
          <button class="pn-btn danger" @click="askEmpty">清空回收站</button>
        </div>
      </template>
    </div>

    <ConfirmDialog
      :open="!!pending"
      :title="confirmTitle"
      :message="confirmMessage"
      confirm-text="永久删除"
      danger
      @confirm="doConfirm"
      @cancel="pending = null"
    />
  </div>
</template>

<style scoped>
.tv {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

/* 回收站是「删除」相关的东西，用警示色而不是强调色，和附件库区分开 */
.tv-ico {
  color: var(--n-danger);
}

/* 恢复用图标就够了：这一列不宽，两个字反而挤 */
.tv-restore {
  width: 28px;
  padding: 0;
}
</style>
