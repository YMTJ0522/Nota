<script setup lang="ts">
/**
 * 中间那一列的「笔记」视图。
 *
 * 侧栏回答「去哪找」，这一栏回答「有哪些」：
 * 把当前视图（所有笔记 / 最近编辑 / 收藏 / 未归类 / 某个标签 / 搜索结果）
 * 下的笔记拍平成一列，标题 + 摘要 + 所属目录 + 标签 + 修改时间一次看全，
 * 不用像目录树那样一层层展开。
 *
 * 顶上那条搜索框原来在侧栏：两个输入框写同一件事，用哪个都显得另一个多余。
 * 现在只有这一条 —— 「筛选出哪些笔记」本来就属于这一栏。
 *
 * 摘要由主进程在扫目录时顺手从文件头部摘出来（见 workspace:tree），
 * 不额外读盘，所以开着这一栏也不会让打开工作区变慢。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { FilePlus2, Search, Star, X } from 'lucide-vue-next'
import { store } from '@/store'

const { state } = store

const files = computed(() => store.visibleFiles.value)
const title = computed(() => store.navTitle.value)
const root = computed(() => state.root ?? '')
const box = ref<HTMLInputElement | null>(null)

/** 去工作区前缀，只留「目录 / 子目录」 */
function folderOf(p: string) {
  const rel = root.value && p.startsWith(root.value) ? p.slice(root.value.length) : p
  const parts = rel.replace(/^[\\/]+/, '').split(/[\\/]/)
  parts.pop()
  return parts.join(' / ') || '根目录'
}

/** 今天只给时间，七天内给星期，再往上给日期——越近的信息越细 */
function when(ms?: number) {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `${p(d.getHours())}:${p(d.getMinutes())}`
  const days = Math.floor((now.getTime() - ms) / 86400_000)
  if (days < 7) return `${days === 1 ? '昨天' : `${days} 天前`}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function open(path: string) {
  void store.openNote(path)
}

/** 窄轨那枚放大镜点过来时，把焦点交给这里 */
function focusSearch() {
  box.value?.focus()
  box.value?.select()
}

onMounted(() => window.addEventListener('nota:focus-search', focusSearch))
onBeforeUnmount(() => window.removeEventListener('nota:focus-search', focusSearch))
</script>

<template>
  <div class="nlist">
    <!-- 顶上先是一条筛选：和侧栏的导航一起决定「这一栏列出哪些」 -->
    <div class="nl-search">
      <Search class="nl-search-ico" :size="13" :stroke-width="2" />
      <input
        ref="box"
        class="nl-search-input"
        type="text"
        placeholder="在笔记中筛选…"
        spellcheck="false"
        :value="state.searchQuery"
        @input="store.setSearchQuery(($event.target as HTMLInputElement).value)"
      />
      <button
        v-if="state.searchQuery"
        class="nl-search-x"
        title="清除"
        @click="store.setSearchQuery('')"
      >
        <X :size="12" :stroke-width="2.2" />
      </button>
    </div>

    <div class="nl-head">
      <span class="nl-title">{{ title }}</span>
      <span class="nl-count">{{ files.length }}</span>
      <span class="nl-acts">
        <button class="nl-btn" data-tip="新建笔记 (Ctrl+N)" @click="store.newNote()">
          <FilePlus2 :size="14" :stroke-width="1.9" />
        </button>
      </span>
    </div>

    <div class="nl-scroll">
      <div v-if="state.loading" class="nl-empty">读取中…</div>
      <div v-else-if="files.length === 0" class="nl-empty">
        {{ state.searchQuery || state.activeTag ? '这里没有匹配的笔记' : '这里还没有 .md 文件' }}
      </div>
      <template v-else>
        <button
          v-for="f in files"
          :key="f.path"
          class="nl-item"
          :class="{ on: f.path === state.activePath }"
          :title="f.path"
          @click="open(f.path)"
        >
          <span class="nl-name">
            <span class="nl-text">{{ f.name.replace(/\.md$/i, '') }}</span>
            <Star v-if="f.starred" class="nl-star" :size="11" :stroke-width="2" />
          </span>
          <span v-if="f.excerpt" class="nl-excerpt">{{ f.excerpt }}</span>
          <span class="nl-meta">
            <span class="nl-folder">{{ folderOf(f.path) }}</span>
            <span class="nl-when">{{ when(f.mtime) }}</span>
          </span>
          <!-- 标签单独一行：和文件夹挤在一行时，长目录名会把标签整个挤掉 -->
          <span class="nl-tags">
            <span v-for="t in f.tags ?? []" :key="t" class="nl-tag">#{{ t }}</span>
            <span v-if="!f.tags?.length" class="nl-tag nl-tag-none">未打标签</span>
          </span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.nlist {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

/* ── 筛选行 ──
   长得像输入框但更安静：它是这一栏的日常入口，不该比笔记本身还抢眼 */
.nl-search {
  flex: none;
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  margin: 8px 8px 2px;
  padding: 0 8px;
  border-radius: 10px;
  border: 1px solid color-mix(in oklab, var(--n-line) 54%, transparent);
  background: color-mix(in oklab, var(--n-raised) 42%, var(--n-sunken));
  transition: border-color var(--n-dur) var(--n-ease),
    background-color var(--n-dur) var(--n-ease);
}

.nl-search:hover,
.nl-search:focus-within {
  border-color: color-mix(in oklab, var(--n-line) 88%, transparent);
  background: color-mix(in oklab, var(--n-raised) 72%, var(--n-sunken));
}

.nl-search:focus-within {
  border-color: var(--n-accent);
}

.nl-search-ico {
  flex: none;
  fill: none;
  stroke: currentColor;
  color: var(--n-fg-faint);
}

.nl-search-input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  letter-spacing: -0.01em;
  color: var(--n-fg);
  background: none;
  border: none;
  outline: none;
}

.nl-search-input::placeholder {
  color: color-mix(in oklab, var(--n-fg-faint) 82%, transparent);
}

.nl-search-x {
  flex: none;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--n-fg-faint);
}

.nl-search-x svg {
  fill: none;
  stroke: currentColor;
}

.nl-search-x:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}

.nl-head {
  flex: none;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 14px;
}

.nl-title {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--n-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nl-count {
  flex: none;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--n-surface);
  border: 1px solid var(--n-line);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  color: var(--n-fg-faint);
}

.nl-acts {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 1px;
}

.nl-btn {
  position: relative;
  width: 24px;
  height: 24px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.nl-btn:hover {
  background: var(--n-raised);
  color: var(--n-accent);
}

/* 悬停提示：和折叠窄轨同一套做法，纯 CSS 向右探出 */
.nl-btn::after {
  content: attr(data-tip);
  position: absolute;
  left: calc(100% + 8px);
  top: 50%;
  z-index: 60;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--n-fg);
  color: var(--n-bg);
  font-size: 11.5px;
  white-space: nowrap;
  opacity: 0;
  transform: translateY(-50%) translateX(-4px);
  pointer-events: none;
  transition: opacity 130ms var(--n-ease), transform 130ms var(--n-ease);
  box-shadow: var(--n-shadow-md);
}

.nl-btn:hover::after {
  opacity: 1;
  transform: translateY(-50%) translateX(0);
}

.nl-head svg {
  fill: none;
  stroke: currentColor;
}

.nl-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

.nl-empty {
  padding: 18px 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--n-fg-faint);
}

/* ── 一条笔记 ── */
.nl-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--n-r-md);
  text-align: left;
  transition: background var(--n-dur) var(--n-ease);
}

.nl-item + .nl-item {
  margin-top: 1px;
}

.nl-item:hover {
  background: color-mix(in oklab, var(--n-raised) 62%, transparent);
}

.nl-item.on {
  background: color-mix(in oklab, var(--n-accent-soft) 76%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--n-accent) 22%, transparent);
}

.nl-name {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.nl-text {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--n-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nl-item.on .nl-text {
  font-weight: 600;
}

.nl-star {
  flex: none;
  fill: currentColor;
  stroke: currentColor;
  color: var(--n-accent);
}

/* 摘要两行截断：够认出这篇讲什么，又不会把列表撑散 */
.nl-excerpt {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--n-fg-dim);
  word-break: break-word;
}

.nl-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 1px;
  font-size: 10px;
  color: var(--n-fg-faint);
  min-width: 0;
}

.nl-folder {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nl-when {
  flex: none;
  font-variant-numeric: tabular-nums;
}

/* 标签独占一行，超过一行就换行，不再被挤没 */
.nl-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 1px;
  font-size: 10px;
}

.nl-tag {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--n-accent-soft) 90%, transparent);
  color: color-mix(in oklab, var(--n-accent) 82%, var(--n-fg));
  white-space: nowrap;
}

.nl-tag-none {
  background: none;
  color: var(--n-fg-faint);
}
</style>
