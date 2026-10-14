<script setup lang="ts">
/**
 * 快速跳转 / 全文搜索。
 *
 * 两个快捷键，一个面板，因为它们回答的是同一个问题：「我那篇东西在哪」。
 *   · Ctrl+P —— 只比标题和路径。记得名字的一半时用这个，几十毫秒就有结果；
 *   · Ctrl+Shift+F —— 连正文一起搜。想不起来叫什么、只记得里面写过什么时用这个。
 *
 * 为什么正文搜索要另开一个键而不是塞进同一个框：把两件事合成一个，
 * 每敲一个字都要去磁盘上把几百篇读一遍，输入会被拖住；
 * 而现在 Ctrl+P 那条路是纯内存的（文件名本来就在树里），快到没有延迟感。
 *
 * 结果分两段摆：先标题后正文。人的直觉是「先看看有没有叫这个名字的」，
 * 没有再往下看哪篇提到了它。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { CornerDownLeft, FileText, Loader2, Search, TextQuote, X } from 'lucide-vue-next'
import { store } from '@/store'
import { searchBody, type BodyHit } from '@/editor/body-search'

const props = defineProps<{
  open: boolean
  /** true = 连正文一起搜（Ctrl+Shift+F）；false = 只比标题（Ctrl+P） */
  body: boolean
}>()
const emit = defineEmits<{ close: [] }>()

const { state } = store

const keyword = ref('')
const cursor = ref(0)
const bodyHits = ref<BodyHit[]>([])
const scanning = ref(false)
const scanned = ref(0)
const total = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

const mode = computed(() => props.body)
const q = computed(() => keyword.value.trim().toLowerCase())

/** 名字/路径里含这个词就算命中；空词时给最近编辑的十几篇，当作「最近打开」 */
const nameHits = computed(() => {
  const files = store.allFiles.value
  if (!q.value) {
    return [...files]
      .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
      .slice(0, 12)
      .map((f) => ({ file: f, why: '' }))
  }
  return files
    .filter((f) => f.name.toLowerCase().includes(q.value) || rel(f.path).toLowerCase().includes(q.value))
    .slice(0, 40)
    .map((f) => ({ file: f, why: '' }))
})

function rel(p: string) {
  const root = state.root ?? ''
  const s = root && p.startsWith(root) ? p.slice(root.length) : p
  return s.replace(/^[\\/]+/, '')
}

function folderOf(p: string) {
  const parts = rel(p).split(/[\\/]/)
  parts.pop()
  return parts.join(' / ') || '根目录'
}

/* 正文搜索是异步的，所以走防抖：连着敲的时候只跑最后一次。
   另外它读磁盘，词太短（一两个字）匹配出来的噪音比有用信息还多，要两个字起。 */
let timer = 0
watch(
  () => [keyword.value, props.open, props.body],
  () => {
    window.clearTimeout(timer)
    bodyHits.value = []
    scanned.value = 0
    cursor.value = 0
    if (!props.open || !props.body) return
    if (q.value.length < 2) return
    timer = window.setTimeout(async () => {
      const want = q.value
      scanning.value = true
      const r = await searchBody(store.allFiles.value, state.root ?? '', want)
      // 跑完的时候输入框可能已经改成别的词了 —— 那这次结果就不作数
      if (q.value !== want) return
      bodyHits.value = r.hits
      scanned.value = r.scanned
      total.value = r.total
      scanning.value = false
    }, 240)
  },
  { immediate: true },
)

watch(
  () => props.open,
  (v) => {
    if (!v) return
    keyword.value = ''
    cursor.value = 0
    nextTick(() => inputEl.value?.focus())
  },
)

/** 上下键在两段的合并列表里走 */
const rowCount = computed(() => nameHits.value.length + bodyHits.value.length)

function move(d: number) {
  if (rowCount.value === 0) return
  cursor.value = (cursor.value + d + rowCount.value) % rowCount.value
  nextTick(() => {
    listEl.value
      ?.querySelector<HTMLElement>(`.sp-row.on`)
      ?.scrollIntoView({ block: 'nearest' })
  })
}

function pick(i: number) {
  if (i < nameHits.value.length) {
    void store.openNote(nameHits.value[i].file.path)
  } else {
    void store.openNote(bodyHits.value[i - nameHits.value.length].path)
  }
  emit('close')
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    move(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    move(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (rowCount.value > 0) pick(cursor.value)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

const hint = computed(() =>
  mode.value
    ? '搜标题与正文 · 至少两个字'
    : '只搜标题与路径 · 要连正文一起搜按 Ctrl+Shift+F',
)
</script>

<template>
  <div v-if="open" class="sp-mask" @pointerdown.self="emit('close')">
    <div class="sp" role="dialog" aria-label="快速跳转">
      <div class="sp-head">
        <span class="sp-ico"><Search :size="14" :stroke-width="1.9" /></span>
        <input
          ref="inputEl"
          v-model="keyword"
          class="sp-input"
          type="text"
          :placeholder="mode ? '在正文里找…' : '跳到笔记…'"
          spellcheck="false"
          @keydown="onKey"
        />
        <button class="sp-x" aria-label="关闭" @click="emit('close')">
          <X :size="14" :stroke-width="1.9" />
        </button>
      </div>

      <div ref="listEl" class="sp-list">
        <template v-if="nameHits.length">
          <div class="sp-sec">{{ q ? '笔记' : '最近编辑' }}</div>
          <button
            v-for="(h, i) in nameHits"
            :key="h.file.path"
            class="sp-row"
            :class="{ on: cursor === i }"
            @pointerenter="cursor = i"
            @click="pick(i)"
          >
            <span class="sp-ico"><FileText :size="13" :stroke-width="1.9" /></span>
            <span class="sp-name">{{ h.file.name.replace(/\.md$/i, '') }}</span>
            <span class="sp-path">{{ folderOf(h.file.path) }}</span>
          </button>
        </template>

        <template v-if="mode">
          <div v-if="q.length >= 2" class="sp-sec">
            <span>正文里提到</span>
            <span class="sp-sec-tail">
              <Loader2 v-if="scanning" class="spin" :size="11" :stroke-width="2" />
              <template v-else-if="bodyHits.length">{{ bodyHits.length }} 处</template>
              <template v-else-if="scanned">扫了 {{ scanned }} 篇，没找到</template>
            </span>
          </div>
          <button
            v-for="(h, k) in bodyHits"
            :key="h.path + h.at"
            class="sp-row"
            :class="{ on: cursor === nameHits.length + k }"
            @pointerenter="cursor = nameHits.length + k"
            @click="pick(nameHits.length + k)"
          >
            <span class="sp-ico"><TextQuote :size="13" :stroke-width="1.9" /></span>
            <span class="sp-name">{{ h.name }}</span>
            <span class="sp-line">{{ h.line }}</span>
          </button>
          <p v-if="q.length === 1" class="sp-tip">再敲一个字才开始搜正文</p>
          <p v-if="scanned && scanned < total" class="sp-tip">
            工作区有 {{ total }} 篇，这次只扫了前 {{ scanned }} 篇
          </p>
        </template>

        <p v-if="!rowCount && !scanning" class="sp-empty">没有匹配的笔记</p>
      </div>

      <div class="sp-foot">
        <span class="sp-key"><CornerDownLeft :size="11" :stroke-width="2" /> 打开</span>
        <span class="sp-key">↑↓ 选择</span>
        <span class="sp-key">Esc 关闭</span>
        <span class="sp-hint">{{ hint }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sp-mask {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  background: var(--n-mask);
}
.sp {
  width: 560px;
  max-width: calc(100vw - 32px);
  display: flex;
  flex-direction: column;
  max-height: 66vh;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  background: var(--n-raised);
  box-shadow: var(--n-shadow-xl);
  overflow: hidden;
}
.sp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 10px 14px;
  border-bottom: 1px solid var(--n-line);
}
.sp-ico {
  display: inline-flex;
  flex: none;
  color: var(--n-fg-faint);
}
.sp-input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--n-fg);
  font-family: inherit;
  font-size: 13.5px;
  outline: none;
}
.sp-input::placeholder {
  color: var(--n-fg-faint);
}
.sp-x {
  padding: 3px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--n-fg-faint);
  cursor: pointer;
}
.sp-x:hover {
  background: var(--n-hover);
  color: var(--n-fg);
}
.sp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}
.sp-sec {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--n-fg-faint);
}
.sp-sec-tail {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 400;
}
.sp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: var(--n-r-sm);
  background: transparent;
  color: var(--n-fg);
  font-family: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.sp-row.on {
  background: var(--n-active);
}
.sp-name {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.sp-path,
.sp-line {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--n-fg-faint);
}
.sp-empty,
.sp-tip {
  margin: 10px 8px;
  font-size: 12px;
  color: var(--n-fg-faint);
}
.sp-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 14px;
  border-top: 1px solid var(--n-line);
  font-size: 11px;
  color: var(--n-fg-faint);
}
.sp-key {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.sp-hint {
  margin-left: auto;
}
.spin {
  animation: sp-spin 0.9s linear infinite;
}
@keyframes sp-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
