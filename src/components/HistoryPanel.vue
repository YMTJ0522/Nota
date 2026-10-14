<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  X,
  ChevronDown,
  History as HistoryIcon,
  RotateCcw,
  GitCompareArrows,
  FileText,
} from 'lucide-vue-next'
import { store } from '@/store'
import { diffLines, diffSummary, type DiffLine } from '@/utils/diff'

/**
 * 版本历史抽屉。
 *
 * 快照由主进程写在工作区下的 `.nota-history/`，这里只负责列出、预览、对比、恢复。
 * 恢复做成「载入到编辑器」而不是「直接覆盖磁盘」——用户可以先看一眼、
 * 改一改再决定保存，比默默回滚安全得多。
 *
 * 两个模式：
 *  · 内容 —— 看某一个版本写了什么；
 *  · 对比 —— 拿它和「基准」逐行比。基准可以是当前编辑器里的内容
 *    （最常用：我刚才改坏了什么），也可以是另一个历史版本。
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

/** 内容 / 对比 */
const mode = ref<'view' | 'diff'>('view')
/** 基准：'cur' = 编辑器里的当前内容；否则是某个版本的文件路径 */
const baseKey = ref('cur')
const baseText = ref('')

const baseOptions = computed(() => [
  { key: 'cur', label: '当前笔记（编辑器里的内容）' },
  ...items.value.map((it) => ({ key: it.path, label: fmt(it.mtime) })),
])

/** 基准下拉的开关。这里原本是个原生 <select>，在深色下会露出系统那套
    蓝底高亮，跟其它就地弹出的菜单两种语言，所以换成自绘的那一份。 */
const baseMenu = ref(false)
const baseLabel = computed(
  () => baseOptions.value.find((o) => o.key === baseKey.value)?.label ?? '选择基准',
)

/* 就地弹出的菜单靠 pointerdown 收起：脚本发的 click / mousedown 关不掉它 */
function onDocPointer(e: PointerEvent) {
  const el = e.target as HTMLElement
  if (!el.closest('.hp-base-pick')) baseMenu.value = false
}

function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape') baseMenu.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer)
  document.addEventListener('keydown', onEsc)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer)
  document.removeEventListener('keydown', onEsc)
})

const diffRows = computed<DiffLine[]>(() => {
  if (mode.value !== 'diff' || !active.value) return []
  return diffLines(baseText.value, preview.value)
})

const summary = computed(() => diffSummary(diffRows.value))

/** 基准是版本时要把内容读出来；是当前笔记时直接用草稿 */
async function loadBase() {
  if (baseKey.value === 'cur') {
    baseText.value = state.draft ?? ''
    return
  }
  baseText.value = (await window.api.historyRead?.(baseKey.value)) ?? ''
}

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
    // 基准默认落在「前一个版本」：拿最新版本跟它上一版比，
    // 正是「我刚才动过什么」；只有一版时退回跟当前笔记比。
    baseKey.value = items.value[1]?.path ?? 'cur'
    await loadBase()
  } finally {
    loading.value = false
  }
}

function setMode(m: 'view' | 'diff') {
  mode.value = m
  if (m === 'diff') void loadBase()
}

async function pickBase(key: string) {
  baseKey.value = key
  baseMenu.value = false
  await loadBase()
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
  // 对比模式下基准若正好是它自己，比出来当然是空的 —— 挪到上一版
  if (mode.value === 'diff' && baseKey.value === it.path) {
    const i = items.value.findIndex((x) => x.path === it.path)
    await pickBase(items.value[i + 1]?.path ?? 'cur')
  }
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
      <!-- 对比模式下加宽：两列行号 + 正文，720px 会把长行挤得没法读 -->
      <aside class="hp" :class="{ wide: mode === 'diff' }" role="dialog" aria-modal="true" aria-label="版本历史">
        <header class="hp-head">
          <HistoryIcon :size="15" :stroke-width="1.9" />
          <span class="hp-title">版本历史</span>
          <span class="hp-sub">{{ store.activeName.value || '未命名笔记' }}</span>
          <button class="hp-x" data-role="hp-close" title="关闭" @click="emit('close')">
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
              :class="{ on: active?.path === it.path, base: mode === 'diff' && baseKey === it.path }"
              @click="pick(it)"
            >
              <span class="hp-time">{{ fmt(it.mtime) }}</span>
              <span class="hp-size">{{ fmtSize(it.size) }}</span>
            </button>
          </div>

          <div class="hp-main">
            <div class="hp-bar">
              <div class="hp-seg">
                <button :class="{ on: mode === 'view' }" @click="setMode('view')">
                  <FileText :size="12" :stroke-width="1.9" />
                  <span>内容</span>
                </button>
                <button :class="{ on: mode === 'diff' }" @click="setMode('diff')">
                  <GitCompareArrows :size="12" :stroke-width="1.9" />
                  <span>对比</span>
                </button>
              </div>

              <template v-if="mode === 'diff'">
                <div class="hp-base">
                  <span>基准</span>
                  <div class="hp-base-pick">
                    <button
                      class="hp-base-btn"
                      data-role="base-pick"
                      :class="{ on: baseMenu }"
                      :title="baseLabel"
                      @click="baseMenu = !baseMenu"
                    >
                      <span class="hp-base-name">{{ baseLabel }}</span>
                      <ChevronDown :size="11" :stroke-width="2" />
                    </button>
                    <div v-if="baseMenu" class="n-menu n-menu-inline hp-base-menu">
                      <div class="n-menu-head"><span>跟哪个版本比</span></div>
                      <button
                        v-for="o in baseOptions"
                        :key="o.key"
                        class="n-menu-item"
                        :class="{ on: o.key === baseKey }"
                        @click="pickBase(o.key)"
                      >
                        <span class="n-menu-name">{{ o.label }}</span>
                      </button>
                    </div>
                  </div>
                </div>
                <span class="hp-sum">
                  <span class="hp-add">+{{ summary.add }}</span>
                  <span class="hp-del">−{{ summary.del }}</span>
                </span>
              </template>
            </div>

            <!-- 对比：只把有变化的行摆出来更容易读，但会丢掉上下文，
                 所以保留完整文本、用底色区分（和 git diff 的默认行为一致）。 -->
            <div v-if="mode === 'diff'" class="hp-diff">
              <div v-if="diffRows.length === 0" class="hp-hint">选一个版本进行对比</div>
              <div
                v-for="(r, i) in diffRows"
                v-else
                :key="i"
                class="hp-dl"
                :class="r.op"
              >
                <span class="hp-g">{{ r.oldNo ?? '' }}</span>
                <span class="hp-g">{{ r.newNo ?? '' }}</span>
                <span class="hp-sign">{{ r.op === 'add' ? '+' : r.op === 'del' ? '−' : '' }}</span>
                <span class="hp-dt">{{ r.text || ' ' }}</span>
              </div>
            </div>

            <div v-else class="hp-preview">
              <pre v-if="preview">{{ preview }}</pre>
              <div v-else class="hp-hint">选一个版本查看内容</div>
            </div>
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

.hp.wide {
  width: 880px;
  height: 560px;
}

.hp-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* 右半边：上面一条模式栏，下面内容或对比。
   模式栏单独占一行而不是塞进抽屉头部 —— 头部还要放笔记名，
   两件事挤在一行里，窄窗口下必然有一个被压没。 */
.hp-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.hp-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--n-line);
}

.hp-seg {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--n-r-sm);
  background: var(--n-bg);
  flex: none;
}

.hp-seg button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 9px;
  border-radius: 5px;
  font-size: 11.5px;
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.hp-seg button svg {
  fill: none;
  stroke: currentColor;
}

.hp-seg button.on {
  background: var(--n-raised);
  color: var(--n-accent);
  box-shadow: var(--n-shadow-sm);
}

.hp-base {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 11.5px;
  color: var(--n-fg-faint);
}

.hp-base-pick {
  position: relative;
  min-width: 0;
}

.hp-base-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 220px;
  height: 24px;
  padding: 0 7px;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-sm);
  background: var(--n-surface);
  color: var(--n-fg);
  font-family: inherit;
  font-size: 11.5px;
  transition: background var(--n-dur) var(--n-ease), border-color var(--n-dur) var(--n-ease);
}

.hp-base-btn:hover,
.hp-base-btn.on {
  background: var(--n-raised);
  border-color: color-mix(in oklab, var(--n-accent) 40%, var(--n-line));
}

.hp-base-name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.hp-base-menu {
  min-width: 200px;
  max-height: 260px;
  overflow-y: auto;
}

.hp-sum {
  margin-left: auto;
  display: inline-flex;
  gap: 8px;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  flex: none;
}

/* 增绿减红是编辑器与 git 的通行约定，这里沿用 */
.hp-add { color: var(--n-accent); }
.hp-del { color: var(--n-danger); }

.hp-diff {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 0 10px;
  font-family: var(--n-font-mono);
  font-size: 12px;
  line-height: 1.6;
}

.hp-dl {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 10px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.hp-dl.add { background: color-mix(in srgb, var(--n-accent) 12%, transparent); }
.hp-dl.del { background: color-mix(in srgb, var(--n-danger) 11%, transparent); }

.hp-g {
  flex: none;
  width: 34px;
  text-align: right;
  color: var(--n-fg-faint);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.hp-sign {
  flex: none;
  width: 10px;
  color: var(--n-fg-dim);
  user-select: none;
}

.hp-dl.add .hp-sign { color: var(--n-accent); }
.hp-dl.del .hp-sign { color: var(--n-danger); }

.hp-dt {
  flex: 1;
  min-width: 0;
  color: var(--n-fg-dim);
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

/* 对比模式下基准那一条也要看得出来，否则「跟谁比」全靠上面那个下拉 */
.hp-row.base::before {
  content: '';
  position: absolute;
  left: 0;
  width: 2px;
  height: 16px;
  border-radius: 1px;
  background: var(--n-accent);
}

.hp-row {
  position: relative;
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
