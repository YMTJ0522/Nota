<script setup lang="ts">
/**
 * 图标选择器。
 *
 * 两类混在一个弹窗里，用页签分开：技术栈图标（真实品牌色）与工作向表情。
 * 给搜索框是因为七十多个品牌图标一屏铺不完，而人心里想的是
 * 「Python 那个」「齿轮那个」—— 名字能搜到比翻页快得多。
 *
 * 「恢复默认」必须要有：挑错了得能退回去，否则一次误点就是永久的。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { Folder, FileText, Search, X } from 'lucide-vue-next'
import { BRAND_ICONS } from '@/assets/brand-icons'
import { WORK_EMOJI } from '@/assets/work-emoji'

const props = defineProps<{
  open: boolean
  /** 在给谁挑图标。只用于标题与默认图标预览 */
  name: string
  type: 'dir' | 'file'
}>()
const emit = defineEmits<{
  (e: 'pick', icon: { kind: 'brand' | 'emoji'; id: string } | null): void
  (e: 'close'): void
}>()

const tab = ref<'brand' | 'emoji'>('brand')
const q = ref('')
const input = ref<HTMLInputElement | null>(null)

const keyword = computed(() => q.value.trim().toLowerCase())

const brands = computed(() => {
  if (!keyword.value) return BRAND_ICONS
  return BRAND_ICONS.filter(
    (i) => i.name.toLowerCase().includes(keyword.value) || i.id.includes(keyword.value),
  )
})

const emojis = computed(() => {
  if (!keyword.value) return WORK_EMOJI
  return WORK_EMOJI.filter(
    (e) => e.name.toLowerCase().includes(keyword.value) || e.char === q.value.trim(),
  )
})

const empty = computed(() =>
  tab.value === 'brand' ? brands.value.length === 0 : emojis.value.length === 0,
)

watch(
  () => props.open,
  async (v) => {
    if (!v) return
    // 每次打开都从头开始：上一次的搜索词留着会让人以为「没有这个图标」
    q.value = ''
    await nextTick()
    input.value?.focus()
  },
)

function pick(icon: { kind: 'brand' | 'emoji'; id: string }) {
  emit('pick', icon)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ip-mask" @click.self="emit('close')" @keydown="onKey">
      <div class="ip" role="dialog" aria-modal="true" aria-label="选择图标">
        <header class="ip-head">
          <span class="ip-ic">
            <Folder v-if="type === 'dir'" :size="14" :stroke-width="1.9" />
            <FileText v-else :size="14" :stroke-width="1.9" />
          </span>
          <span class="ip-title">更换图标</span>
          <span class="ip-name">{{ name }}</span>
          <button class="ip-x" title="关闭" @click="emit('close')">
            <X :size="15" :stroke-width="1.9" />
          </button>
        </header>

        <div class="ip-bar">
          <div class="ip-seg">
            <button :class="{ on: tab === 'brand' }" @click="tab = 'brand'">
              <span>技术栈</span>
            </button>
            <button :class="{ on: tab === 'emoji' }" @click="tab = 'emoji'">
              <span>表情</span>
            </button>
          </div>
          <label class="ip-search">
            <Search :size="12" :stroke-width="2" />
            <input
              ref="input"
              v-model="q"
              type="text"
              placeholder="搜索名称…"
              spellcheck="false"
            />
          </label>
        </div>

        <div class="ip-grid">
          <template v-if="tab === 'brand'">
            <button
              v-for="i in brands"
              :key="i.id"
              class="ip-cell"
              :title="i.name"
              @click="pick({ kind: 'brand', id: i.id })"
            >
              <svg class="ip-svg" viewBox="0 0 24 24" :style="{ color: `#${i.hex}` }">
                <path :d="i.path" fill="currentColor" />
              </svg>
              <span class="ip-label">{{ i.name }}</span>
            </button>
          </template>
          <template v-else>
            <button
              v-for="e in emojis"
              :key="e.char"
              class="ip-cell"
              :title="e.name"
              @click="pick({ kind: 'emoji', id: e.char })"
            >
              <span class="ip-emo">{{ e.char }}</span>
              <span class="ip-label">{{ e.name.split(' ')[0] }}</span>
            </button>
          </template>
          <p v-if="empty" class="ip-empty">没有匹配的图标</p>
        </div>

        <footer class="ip-foot">
          <button class="ip-btn ghost" @click="emit('pick', null)">恢复默认</button>
          <button class="ip-btn" @click="emit('close')">取消</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ip-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--n-mask);
  backdrop-filter: blur(2px);
  animation: ip-fade 120ms var(--n-ease);
}

.ip {
  width: 560px;
  max-width: calc(100vw - 40px);
  height: 460px;
  max-height: calc(100vh - 60px);
  display: flex;
  flex-direction: column;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  box-shadow: var(--n-shadow-xl);
  overflow: hidden;
  animation: ip-in 140ms var(--n-ease);
}

.ip-head {
  flex: none;
  height: 44px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--n-line);
  color: var(--n-fg-dim);
}

.ip-ic {
  display: inline-flex;
  color: var(--n-accent);
}

.ip-ic svg {
  fill: none;
  stroke: currentColor;
}

.ip-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--n-fg);
}

.ip-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--n-fg-faint);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ip-x {
  padding: 0;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
}

.ip-x svg {
  fill: none;
  stroke: currentColor;
}

.ip-x:hover {
  background: var(--n-bg);
  color: var(--n-fg);
}

.ip-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--n-line);
}

.ip-seg {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--n-r-sm);
  background: var(--n-bg);
  flex: none;
}

.ip-seg button {
  height: 22px;
  padding: 0 10px;
  border-radius: 5px;
  font-size: 11.5px;
  color: var(--n-fg-dim);
}

.ip-seg button.on {
  background: var(--n-raised);
  color: var(--n-accent);
  box-shadow: var(--n-shadow-sm);
}

.ip-search {
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

.ip-search svg {
  flex: none;
  fill: none;
  stroke: currentColor;
}

.ip-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  font-family: inherit;
  font-size: 12px;
  color: var(--n-fg);
  outline: none;
}

/* 六列：560px 宽下每格约 84px，图标 20px + 一行名字正好 */
.ip-grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 4px;
  padding: 10px 12px;
  align-content: start;
}

.ip-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 7px 2px 6px;
  border-radius: var(--n-r-sm);
  transition: background var(--n-dur) var(--n-ease);
}

.ip-cell:hover {
  background: var(--n-bg);
}

.ip-svg {
  width: 20px;
  height: 20px;
  flex: none;
}

.ip-emo {
  font-size: 19px;
  line-height: 24px;
  flex: none;
}

/* 名字是次要信息：一行截断，鼠标悬上去有 title */
.ip-label {
  max-width: 100%;
  font-size: 10px;
  line-height: 1.2;
  color: var(--n-fg-faint);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ip-empty {
  grid-column: 1 / -1;
  margin: 8px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--n-fg-faint);
}

.ip-foot {
  flex: none;
  height: 46px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 12px;
  border-top: 1px solid var(--n-line);
}

.ip-btn {
  height: 28px;
  padding: 0 12px;
  border-radius: var(--n-r-sm);
  font-size: 12.5px;
  color: var(--n-fg-dim);
  background: var(--n-surface);
  border: 1px solid var(--n-line);
}

.ip-btn:hover {
  color: var(--n-fg);
  background: var(--n-raised);
}

.ip-btn.ghost {
  margin-right: auto;
  background: none;
  border-color: transparent;
  color: var(--n-fg-faint);
}

.ip-btn.ghost:hover {
  color: var(--n-danger);
  background: var(--n-danger-soft);
}

@keyframes ip-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes ip-in {
  from { opacity: 0; transform: translateY(-8px) scale(0.99); }
  to { opacity: 1; transform: none; }
}
</style>
