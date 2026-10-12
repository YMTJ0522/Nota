<script setup lang="ts">
import { ref, watch } from 'vue'
import { X, History as HistoryIcon, RotateCcw } from 'lucide-vue-next'
import { store } from '@/store'

/**
 * 版本历史抽屉。
 *
 * 快照由主进程写在工作区下的 `.nota-history/`，这里只负责列出、预览、恢复。
 * 恢复做成「载入到编辑器」而不是「直接覆盖磁盘」——用户可以先看一眼、
 * 改一改再决定保存，比默默回滚安全得多。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { state } = store

interface Item {
  name: string
  path: string
  size: number
  mtime: number
}

const items = ref<Item[]>([])
const active = ref<Item | null>(null)
const preview = ref('')
const loading = ref(false)

async function load() {
  if (!state.root || !state.activePath) {
    items.value = []
    return
  }
  loading.value = true
  try {
    items.value = (await window.api.historyList?.(state.root, state.activePath)) ?? []
    active.value = items.value[0] ?? null
    preview.value = active.value
      ? ((await window.api.historyRead?.(active.value.path)) ?? '')
      : ''
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  (v) => {
    if (v) load()
  },
)

/* 抽屉开着时换了笔记：跟着换，否则列出的还是上一篇的版本 */
watch(
  () => state.activePath,
  () => {
    if (props.open) load()
  },
)

async function pick(it: Item) {
  active.value = it
  preview.value = (await window.api.historyRead?.(it.path)) ?? ''
}

/** 恢复：把快照内容灌回当前笔记（进编辑器，未落盘） */
function restore() {
  if (!active.value) return
  state.draft = preview.value
  emit('close')
  window.dispatchEvent(
    new CustomEvent('nota:toast', { detail: '已载入该版本，按 Ctrl+S 保存后生效' }),
  )
}

function fmt(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtSize(n: number) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="hp-mask" @click.self="emit('close')">
      <aside class="hp" role="dialog" aria-modal="true" aria-label="版本历史">
        <header class="hp-head">
          <HistoryIcon :size="15" :stroke-width="1.9" />
          <span class="hp-title">版本历史</span>
          <span class="hp-sub">{{ store.activeName.value || '未命名笔记' }}</span>
          <button class="hp-x" title="关闭" @click="emit('close')">
            <X :size="15" :stroke-width="1.9" />
          </button>
        </header>

        <div class="hp-body">
          <div class="hp-list">
            <div v-if="loading" class="hp-hint">读取中…</div>
            <div v-else-if="items.length === 0" class="hp-hint">
              这篇还没有历史版本。<br />改动会被自动保存，保存后这里就多一个快照。
            </div>
            <button
              v-for="it in items"
              v-else
              :key="it.path"
              class="hp-row"
              :class="{ on: active?.path === it.path }"
              @click="pick(it)"
            >
              <span class="hp-time">{{ fmt(it.mtime) }}</span>
              <span class="hp-size">{{ fmtSize(it.size) }}</span>
            </button>
          </div>

          <div class="hp-preview">
            <pre v-if="preview">{{ preview }}</pre>
            <div v-else class="hp-hint">选一个版本查看内容</div>
          </div>
        </div>

        <footer class="hp-foot">
          <button class="hp-btn" @click="emit('close')">关闭</button>
          <button class="hp-btn hp-primary" :disabled="!active" @click="restore">
            <RotateCcw :size="13" :stroke-width="1.9" />
            <span>恢复此版本</span>
          </button>
        </footer>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.hp-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--n-mask);
  backdrop-filter: blur(2px);
  animation: hp-fade 120ms var(--n-ease);
}

.hp {
  width: 720px;
  max-width: calc(100vw - 40px);
  height: 480px;
  max-height: calc(100vh - 60px);
  display: flex;
  flex-direction: column;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  box-shadow: var(--n-shadow-xl);
  overflow: hidden;
  animation: hp-in 140ms var(--n-ease);
}

.hp-head {
  flex: none;
  height: 44px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 16px;
  border-bottom: 1px solid var(--n-line);
  color: var(--n-fg-dim);
}

.hp-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--n-fg);
}

.hp-sub {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--n-fg-faint);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.hp-x {
  padding: 0;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
}

.hp-x:hover {
  background: var(--n-bg);
  color: var(--n-fg);
}

.hp-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.hp-list {
  width: 236px;
  flex: none;
  border-right: 1px solid var(--n-line);
  overflow-y: auto;
  padding: 6px;
}

.hp-row {
  width: 100%;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 8px;
  border-radius: var(--n-r-sm);
  font-size: 12px;
  color: var(--n-fg-dim);
  font-variant-numeric: tabular-nums;
}

.hp-row:hover {
  background: var(--n-bg);
  color: var(--n-fg);
}

.hp-row.on {
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

.hp-size {
  font-size: 11px;
  color: var(--n-fg-faint);
}

.hp-preview {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 12px 14px;
}

.hp-preview pre {
  margin: 0;
  font-family: var(--n-font-mono);
  font-size: 12px;
  line-height: 1.62;
  color: var(--n-fg-dim);
  white-space: pre-wrap;
  word-break: break-word;
}

.hp-hint {
  padding: 10px 8px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--n-fg-faint);
}

.hp-foot {
  flex: none;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 12px;
  border-top: 1px solid var(--n-line);
}

.hp-btn {
  height: 30px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 14px;
  border-radius: var(--n-r-sm);
  font-size: 13px;
  color: var(--n-fg-dim);
  background: var(--n-surface);
  border: 1px solid var(--n-line);
}

.hp-btn svg {
  fill: none;
  stroke: currentColor;
}

.hp-btn:hover:not(:disabled) {
  color: var(--n-fg);
  background: var(--n-raised);
}

.hp-primary {
  color: #fff;
  background: var(--n-accent);
  border-color: transparent;
}

.hp-primary:hover:not(:disabled) {
  filter: brightness(1.08);
  color: #fff;
  background: var(--n-accent);
}

.hp-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

@keyframes hp-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes hp-in {
  from { opacity: 0; transform: translateY(-8px) scale(0.99); }
  to { opacity: 1; transform: none; }
}
</style>
