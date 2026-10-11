<script setup lang="ts">
/**
 * 回收站。
 *
 * 删掉的笔记（进工作区的 `.nota/trash/`），能原路恢复——
 * 删之前在哪个目录就回哪个目录，因为删除时把相对路径一并存了下来。
 *
 * 和「附件库」分开成独立窗口：一个处理素材、一个处理被删的笔记，
 * 没有共同的上下文，硬凑在一个页签组里只会让人每次都点错。
 */
import { computed, ref, watch } from 'vue'
import { FileText, History as HistoryIcon, RotateCcw, Trash2, X } from 'lucide-vue-next'
import { store } from '@/store'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

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
  () => props.open,
  (v) => {
    if (v) void load()
  },
  { immediate: true },
)

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

async function restore(t: TrashItem) {
  await window.api.trashRestore(root.value, t.key)
  items.value = items.value.filter((x) => x.key !== t.key)
  await store.refreshTree()
  toast(`已恢复到 ${t.rel}`)
}

async function purge(t: TrashItem) {
  await window.api.trashPurge(root.value, t.key)
  items.value = items.value.filter((x) => x.key !== t.key)
  toast(`已彻底删除 ${t.name}`)
}

async function emptyAll() {
  if (items.value.length === 0) return
  await window.api.trashEmpty(root.value)
  items.value = []
  toast('回收站已清空')
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
  <Teleport to="body">
    <div v-if="open" class="dlg-mask" @pointerdown.self="emit('close')">
      <div class="dlg tdlg" role="dialog" aria-modal="true" aria-label="回收站">
        <header class="dlg-head">
          <span class="dlg-head-ico tdlg-ico"><Trash2 :size="15" :stroke-width="1.9" /></span>
          <span class="dlg-title">回收站</span>
          <span class="dlg-sub">{{ root ? `${items.length} 篇被删的笔记` : '先打开一个笔记目录' }}</span>
          <button class="dlg-x" title="关闭 (Esc)" @click="emit('close')">
            <X :size="14" :stroke-width="2.1" />
          </button>
        </header>

        <div class="dlg-body">
          <div v-if="!root" class="dlg-empty">先打开一个笔记目录</div>
          <div v-else-if="loading" class="dlg-empty">读取中…</div>
          <div v-else-if="items.length === 0" class="dlg-empty">
            回收站是空的。删掉的笔记会先来这里，随时能捞回去。
          </div>
          <template v-else>
            <div class="dlg-list">
              <div v-for="t in items" :key="t.key" class="dlg-row">
                <FileText class="dlg-row-ico" :size="15" :stroke-width="1.8" />
                <span class="dlg-row-main">
                  <span class="dlg-row-name">{{ t.name }}</span>
                  <span class="dlg-row-sub">
                    {{ t.rel }} · {{ timeText(t.deletedAt) }} · {{ sizeText(t.size) }}
                  </span>
                </span>
                <button class="dlg-act tdlg-restore" title="恢复到原位置" @click="restore(t)">
                  <RotateCcw :size="12" :stroke-width="2" />
                  <span>恢复</span>
                </button>
                <button class="dlg-act danger" title="彻底删除" @click="purge(t)">
                  <Trash2 :size="12" :stroke-width="2" />
                </button>
              </div>
            </div>
            <div class="dlg-foot">
              <span class="tdlg-tip">
                <HistoryIcon :size="12" :stroke-width="1.9" />
                删除只是移动位置，清空之后才真的没了
              </span>
              <button class="dlg-btn danger" @click="emptyAll">清空回收站</button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 回收站是「删除」相关的东西，用警示色而不是强调色，和附件库区分开 */
.tdlg-ico {
  color: var(--n-danger);
}

.tdlg-restore {
  width: auto;
}

.tdlg-tip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-right: auto;
  font-size: 10.5px;
  color: var(--n-fg-faint);
}

.tdlg-tip svg {
  fill: none;
  stroke: currentColor;
}
</style>
