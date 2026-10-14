<script setup lang="ts">
/**
 * 图标素材网格 —— 「给节点挑图标」和「给标签挑图标」共用这一份。
 *
 * 抽出来不是为了复用几行样式，而是为了保证**两个入口看到的是同一批图标、
 * 同样的排布、同样的搜索手感**。以前它们是两套想法：给文件选图标是一回事，
 * 标签有图标是另一回事（还没有）。既然要合起来，最前面的素材库必须是同一个，
 * 否则用户会发现「在标签里能挑的图标，给文件时挑不到」，那不叫统一，叫两个 bug。
 *
 * 这里只负责「铺出来 + 报出点了哪个」，选中态由外面决定。
 */
import { computed, ref } from 'vue'
import { Search } from 'lucide-vue-next'
import { BRAND_ICONS } from '@/assets/brand-icons'
import { WORK_EMOJI } from '@/assets/work-emoji'

export type MarkIcon = { kind: 'brand' | 'emoji'; id: string }

const props = defineProps<{
  /** 当前选中的那一枚，用来画高亮 */
  current?: MarkIcon | null
  placeholder?: string
}>()
const emit = defineEmits<{ (e: 'pick', icon: MarkIcon): void }>()

const tab = ref<'brand' | 'emoji'>('brand')
const q = ref('')
const input = ref<HTMLInputElement | null>(null)

const keyword = computed(() => q.value.trim().toLowerCase())

const brands = computed(() =>
  keyword.value
    ? BRAND_ICONS.filter(
        (i) => i.name.toLowerCase().includes(keyword.value) || i.id.includes(keyword.value),
      )
    : BRAND_ICONS,
)

const emojis = computed(() =>
  keyword.value
    ? WORK_EMOJI.filter(
        (e) => e.name.toLowerCase().includes(keyword.value) || e.char === q.value.trim(),
      )
    : WORK_EMOJI,
)

const empty = computed(() =>
  tab.value === 'brand' ? brands.value.length === 0 : emojis.value.length === 0,
)

function isOn(kind: 'brand' | 'emoji', id: string) {
  return props.current?.kind === kind && props.current.id === id
}

function focus() {
  input.value?.focus()
}
defineExpose({ focus })
</script>

<template>
  <div class="ig">
    <div class="ig-bar">
      <div class="ig-seg">
        <button :class="{ on: tab === 'brand' }" @click="tab = 'brand'"><span>技术栈</span></button>
        <button :class="{ on: tab === 'emoji' }" @click="tab = 'emoji'"><span>表情</span></button>
      </div>
      <label class="ig-search">
        <Search :size="12" :stroke-width="2" />
        <input
          ref="input"
          v-model="q"
          type="text"
          :placeholder="placeholder ?? '搜索名称…'"
          spellcheck="false"
        />
      </label>
    </div>

    <div class="ig-grid">
      <template v-if="tab === 'brand'">
        <button
          v-for="i in brands"
          :key="i.id"
          class="ig-cell"
          :class="{ cur: isOn('brand', i.id) }"
          :title="i.name"
          @click="emit('pick', { kind: 'brand', id: i.id })"
        >
          <svg class="ig-svg" viewBox="0 0 24 24" :style="{ color: `#${i.hex}` }">
            <path :d="i.path" fill="currentColor" />
          </svg>
          <span class="ig-label">{{ i.name }}</span>
        </button>
      </template>
      <template v-else>
        <button
          v-for="e in emojis"
          :key="e.char"
          class="ig-cell"
          :class="{ cur: isOn('emoji', e.char) }"
          :title="e.name"
          @click="emit('pick', { kind: 'emoji', id: e.char })"
        >
          <span class="ig-emo">{{ e.char }}</span>
          <span class="ig-label">{{ e.name.split(' ')[0] }}</span>
        </button>
      </template>
      <p v-if="empty" class="ig-empty">没有匹配的图标</p>
    </div>
  </div>
</template>

<style scoped>
.ig {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.ig-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--n-line);
}

.ig-seg {
  display: inline-flex;
  flex: none;
  padding: 2px;
  border-radius: var(--n-r-sm);
  background: var(--n-bg);
}

.ig-seg button {
  height: 22px;
  padding: 0 10px;
  border-radius: 5px;
  font-size: 11.5px;
  color: var(--n-fg-dim);
}

.ig-seg button.on {
  background: var(--n-raised);
  color: var(--n-accent);
  box-shadow: var(--n-shadow-sm);
}

.ig-search {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-sm);
  background: var(--n-surface);
  color: var(--n-fg-faint);
}

.ig-search svg {
  flex: none;
  fill: none;
  stroke: currentColor;
}

.ig-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  font-family: inherit;
  font-size: 12px;
  color: var(--n-fg);
  outline: none;
}

.ig-grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 4px;
  padding: 10px 12px;
  align-content: start;
}

.ig-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 7px 2px 6px;
  border-radius: var(--n-r-sm);
  border: 1px solid transparent;
  transition: background var(--n-dur) var(--n-ease);
}

.ig-cell:hover {
  background: var(--n-bg);
}

.ig-cell.cur {
  border-color: var(--n-accent);
  background: var(--n-accent-soft);
}

.ig-svg {
  width: 20px;
  height: 20px;
  flex: none;
}

.ig-emo {
  font-size: 19px;
  line-height: 24px;
  flex: none;
}

.ig-label {
  max-width: 100%;
  font-size: 10px;
  line-height: 1.2;
  color: var(--n-fg-faint);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ig-empty {
  grid-column: 1 / -1;
  margin: 8px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--n-fg-faint);
}
</style>
