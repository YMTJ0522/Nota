<script setup lang="ts">
/**
 * 「归类」用的文件夹选择器。
 *
 * 候选直接取 store.folderOptions（工作区根 + 所有子目录），
 * 不用另开一条读盘通道 —— 目录树本来就已经在内存里了。
 * 层级用「父 / 子」的前缀铺平展示，两个同名文件夹一眼分得清。
 */
import { computed, ref, watch } from 'vue'
import { Folder, FolderInput, X } from 'lucide-vue-next'
import { store } from '@/store'

const props = withDefaults(
  defineProps<{
    open: boolean
    /** 正在归类的笔记名，摆在标题下面让人确认改的是哪一篇 */
    noteName?: string
    title?: string
  }>(),
  { noteName: '', title: '归到哪个文件夹' },
)

const emit = defineEmits<{ (e: 'pick', dir: string): void; (e: 'close'): void }>()

const { state } = store
const keyword = ref('')
const input = ref<HTMLInputElement | null>(null)

const items = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  const all = store.folderOptions.value
  return q ? all.filter((f) => f.name.toLowerCase().includes(q)) : all
})

/** 当前这篇已经在哪个文件夹里 —— 高亮它，省得重复归类还看不出 */
const current = computed(() =>
  state.activePath ? state.activePath.replace(/[\\/][^\\/]*$/, '') : '',
)

watch(
  () => props.open,
  async (v) => {
    if (!v) return
    keyword.value = ''
    await new Promise((r) => requestAnimationFrame(r))
    input.value?.focus()
  },
)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fp-mask" @pointerdown.self="emit('close')">
      <div class="fp" role="dialog" aria-modal="true" :aria-label="title">
        <header class="fp-head">
          <span class="fp-title">{{ title }}</span>
          <button class="fp-x" title="关闭 (Esc)" @click="emit('close')">
            <X :size="14" :stroke-width="2.1" />
          </button>
        </header>

        <p v-if="noteName" class="fp-sub">把《{{ noteName }}》移到：</p>

        <div class="fp-search">
          <FolderInput class="fp-ico" :size="13" :stroke-width="2" />
          <input
            ref="input"
            v-model="keyword"
            class="fp-input"
            type="text"
            placeholder="按文件夹名筛选…"
            spellcheck="false"
            @keydown.esc="emit('close')"
          />
        </div>

        <div class="fp-list">
          <button
            v-for="f in items"
            :key="f.path"
            class="fp-item"
            :class="{ on: f.path === current }"
            :title="f.path"
            @click="emit('pick', f.path)"
          >
            <Folder class="fp-item-ico" :size="13" :stroke-width="1.8" />
            <span class="fp-item-name">{{ f.name }}</span>
            <span v-if="f.path === current" class="fp-item-here">当前</span>
          </button>
          <div v-if="items.length === 0" class="fp-empty">没有匹配的文件夹</div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.fp-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  background: var(--n-mask);
  animation: fp-fade 120ms var(--n-ease);
}

.fp {
  width: 400px;
  max-width: calc(100vw - 32px);
  display: flex;
  flex-direction: column;
  max-height: 60vh;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  background: var(--n-raised);
  box-shadow: var(--n-shadow-xl);
  overflow: hidden;
}

.fp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 12px 11px 15px;
}

.fp-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--n-fg);
}

.fp-x {
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-faint);
}

.fp-x:hover {
  background: var(--n-surface);
  color: var(--n-fg);
}

.fp-x svg,
.fp-ico,
.fp-item-ico {
  fill: none;
  stroke: currentColor;
}

.fp-sub {
  margin: 0;
  padding: 0 15px 10px;
  font-size: 12px;
  color: var(--n-fg-dim);
}

.fp-search {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 12px 8px;
  padding: 0 9px;
  height: 30px;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-sm);
  background: var(--n-surface);
}

.fp-search:focus-within {
  border-color: var(--n-accent);
}

.fp-ico {
  flex: none;
  color: var(--n-fg-faint);
}

.fp-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  outline: none;
  color: var(--n-fg);
  font-size: 12.5px;
}

.fp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 10px;
}

.fp-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border-radius: var(--n-r-sm);
  text-align: left;
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.fp-item:hover {
  background: var(--n-surface);
  color: var(--n-fg);
}

.fp-item.on {
  color: var(--n-accent);
}

.fp-item-ico {
  flex: none;
  color: var(--n-fg-faint);
}

.fp-item.on .fp-item-ico {
  color: var(--n-accent);
}

.fp-item-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fp-item-here {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--n-accent-soft);
  font-size: 10px;
  color: var(--n-accent);
}

.fp-empty {
  padding: 16px 10px;
  font-size: 12px;
  color: var(--n-fg-faint);
}

@keyframes fp-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
