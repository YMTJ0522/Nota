<script setup lang="ts">
/**
 * 中间那一列的「引用」视图：哪些笔记提到了当前这一篇。
 *
 * 做法是把工作区里的笔记读一遍，找指向当前这篇的链接 ——
 * `[[笔记名]]`、`[[目录/笔记名|别名]]`、`[文字](目录/笔记名.md)` 都算。
 *
 * 为什么要读完再找：笔记的全貌在磁盘上，目录树里只有摘要。
 * 但也不会每次都读：文件按「路径 + 修改时间」缓存，改过的才重读；
 * 工作区特别大时只扫前若干篇，并在界面上说清楚扫了多少，
 * 而不是假装整个工作区都查过了。
 */
import { computed, ref, watch } from 'vue'
import { Quote, RefreshCw } from 'lucide-vue-next'
import { store } from '@/store'

const { state } = store

/** 一次最多扫这么多篇。再多就明显卡住首次打开了，宁可说清楚 */
const MAX_FILES = 400
/** 同时读几篇。开太大反而被 IPC 排队拖慢 */
const POOL = 8

interface Row {
  path: string
  name: string
  folder: string
  lines: string[]
}

const rows = ref<Row[]>([])
const scanning = ref(false)
/** 已经看完的篇数，给进度条用 */
const done = ref(0)
const total = ref(0)
const limited = ref(false)

/** 路径 + mtime → 正文。改了才会失效，没改的直接复用 */
const fileCache = new Map<string, { mtime: number; text: string }>()

const targetName = computed(() => store.activeName.value)
const root = computed(() => state.root ?? '')

function folderOf(p: string) {
  const rel = root.value && p.startsWith(root.value) ? p.slice(root.value.length) : p
  const parts = rel.replace(/^[\\/]+/, '').split(/[\\/]/)
  parts.pop()
  return parts.join(' / ') || '根目录'
}

function esc(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 指向某一篇的链接。前一半认 [[…]]，后一半认 (…md) */
function linkRe(name: string) {
  const n = esc(name)
  return new RegExp(
    `\\[\\[\\s*(?:[^\\]|]*\\/)?${n}(?:\\.md)?\\s*(?:[|#][^\\]]*)?\\]\\]` +
      `|\\]\\([^)]*${n}\\.md[^)]*\\)`,
    'i',
  )
}

async function readCached(path: string, mtime: number) {
  const hit = fileCache.get(path)
  if (hit && hit.mtime === mtime) return hit.text
  try {
    const text = (await window.api.readNote(path)) ?? ''
    fileCache.set(path, { mtime, text })
    return text
  } catch {
    fileCache.set(path, { mtime, text: '' })
    return ''
  }
}

async function scan() {
  const target = state.activePath
  const name = targetName.value
  rows.value = []
  done.value = 0
  total.value = 0
  limited.value = false
  if (!target || !name) return

  const all = store.allFiles.value.filter((f) => f.path !== target)
  const files = all.slice(0, MAX_FILES)
  limited.value = all.length > files.length
  total.value = files.length
  scanning.value = true

  const re = linkRe(name)
  const found: Row[] = []
  let cursor = 0

  async function worker() {
    for (;;) {
      const i = cursor++
      if (i >= files.length) return
      const f = files[i]
      const text = await readCached(f.path, f.mtime ?? 0)
      done.value += 1
      if (!text || !re.test(text)) continue
      // 命中的行各摘一行出来当上下文，最多两条 —— 认出「在哪儿提到的」就够了
      const lines = text
        .split(/\r?\n/)
        .filter((l) => re.test(l))
        .slice(0, 2)
        .map((l) => l.trim().slice(0, 120))
      found.push({ path: f.path, name: f.name.replace(/\.md$/i, ''), folder: folderOf(f.path), lines })
    }
  }

  await Promise.all(Array.from({ length: Math.min(POOL, files.length) }, worker))
  scanning.value = false

  // 按路径排一下，顺序稳定，切来切去不会跳
  found.sort((a, b) => a.path.localeCompare(b.path))
  rows.value = found
}

watch(
  () => [state.activePath, state.tree, state.root],
  () => void scan(),
  { immediate: true },
)

function open(path: string) {
  void store.openNote(path)
}

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

async function refresh() {
  fileCache.clear()
  await scan()
  toast('已重扫工作区')
}
</script>

<template>
  <div class="qv">
    <div class="pn-head">
      <span class="pn-ico"><Quote :size="13" :stroke-width="1.9" /></span>
      <span class="pn-title">引用</span>
      <span class="pn-sub">{{ scanning ? `${done}/${total}` : rows.length }}</span>
      <span class="pn-x">
        <button class="qv-btn" title="重扫工作区" :disabled="scanning" @click="refresh">
          <RefreshCw :class="{ spin: scanning }" :size="12" :stroke-width="2" />
        </button>
      </span>
    </div>

    <div class="pn-body">
      <div v-if="!state.activePath" class="pn-empty">先打开一篇笔记，这里会列出提到它的那些笔记</div>

      <div v-else-if="scanning && rows.length === 0" class="pn-empty">
        正在翻工作区里的笔记…（{{ done }}/{{ total }}）
      </div>

      <div v-else-if="rows.length === 0" class="pn-empty">
        还没有别的笔记提到《{{ targetName }}》。<br />
        在别处写 <code>[[{{ targetName }}]]</code>，它就会出现在这里。
      </div>

      <template v-else>
        <p v-if="limited" class="pn-tip">
          工作区里笔记很多，这次只扫了前 {{ MAX_FILES }} 篇。
        </p>
        <div class="pn-list">
          <button v-for="r in rows" :key="r.path" class="pn-row qv-row" :title="r.path" @click="open(r.path)">
            <span class="qv-name">{{ r.name }}</span>
            <span class="qv-folder">{{ r.folder }}</span>
            <span v-for="(l, i) in r.lines" :key="i" class="qv-line">{{ l }}</span>
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.qv {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.qv-btn {
  padding: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-faint);
}

.qv-btn svg {
  fill: none;
  stroke: currentColor;
}

.qv-btn:hover:not(:disabled) {
  background: var(--n-raised);
  color: var(--n-accent);
}

.qv-btn:disabled {
  opacity: 0.6;
}

.spin {
  animation: qv-spin 900ms linear infinite;
}

@keyframes qv-spin {
  to { transform: rotate(360deg); }
}

.qv-row {
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
  height: auto;
  padding: 8px 10px;
}

.qv-name {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--n-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.qv-folder {
  font-size: 10px;
  color: var(--n-fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 命中的那一行原文：让「在哪儿提到的」一眼可见 */
.qv-line {
  font-family: var(--n-font-mono);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--n-fg-dim);
  background: color-mix(in oklab, var(--n-accent-soft) 62%, transparent);
  border-radius: 4px;
  padding: 2px 5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
