<script setup lang="ts">
/**
 * 笔记选择器：给「笔记嵌入」用。
 *
 * 嵌入语法 `![[笔记名]]` 只有名字，但工作区里同名笔记很常见
 * （两个文件夹下各有一篇「README」），所以列表里必须同时显示相对路径，
 * 让用户能分清自己选的是哪一篇。
 *
 * 键盘全程可用：输入即过滤，↑↓ 移动，Enter 确认，Esc 取消。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { FileText, Search, X } from 'lucide-vue-next'
import { store } from '@/store'

const props = defineProps<{ open: boolean; title?: string }>()
const emit = defineEmits<{ pick: [path: string]; close: [] }>()

const keyword = ref('')
const cursor = ref(0)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLDivElement | null>(null)

interface Item {
  /** 相对工作区的路径，例如 `日记/2026-01.md` */
  rel: string
  /** 去掉 .md 的名字，也就是嵌进 `![[]]` 里的内容 */
  name: string
  /** 所在目录，纯展示，用来消歧义 */
  dir: string
}

const items = computed<Item[]>(() => {
  const root = store.state.root ?? ''
  const all = store.allFiles.value
    .map((n) => {
      const rel = root
        ? n.path.replace(root, '').replace(/^[/\\]/, '')
        : n.path.split(/[/\\]/).pop() ?? n.path
      const relPosix = rel.replace(/\\/g, '/')
      const at = relPosix.lastIndexOf('/')
      return {
        rel: relPosix,
        name: relPosix.slice(at + 1).replace(/\.md$/i, ''),
        dir: at > 0 ? relPosix.slice(0, at) : '',
      }
    })
    .sort((a, b) => a.rel.localeCompare(b.rel, 'zh'))

  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return all
  return all.filter(
    (it) => it.name.toLowerCase().includes(kw) || it.rel.toLowerCase().includes(kw),
  )
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    keyword.value = ''
    cursor.value = 0
    nextTick(() => input.value?.focus())
  },
)

watch(items, () => {
  if (cursor.value >= items.value.length) cursor.value = Math.max(0, items.value.length - 1)
})

function move(step: number) {
  const n = items.value.length
  if (n === 0) return
  cursor.value = (cursor.value + step + n) % n
  nextTick(() => {
    const el = list.value?.querySelector<HTMLElement>('.on')
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function confirm() {
  const it = items.value[cursor.value]
  if (!it) return
  emit('pick', it.rel)
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
    confirm()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="np-mask" @pointerdown.self="emit('close')">
      <div class="np" @keydown="onKey">
        <header class="np-head">
          <span class="np-title">{{ title ?? '选择要嵌入的笔记' }}</span>
          <button class="np-x" title="关闭 (Esc)" @click="emit('close')">
            <X :size="14" :stroke-width="2.1" />
          </button>
        </header>

        <div class="np-search">
          <Search class="np-ico" :size="13" :stroke-width="2" />
          <input
            ref="input"
            v-model="keyword"
            class="np-input"
            type="text"
            placeholder="按标题或路径筛选…"
            spellcheck="false"
          />
        </div>

        <div ref="list" class="np-list">
          <button
            v-for="(it, i) in items"
            :key="it.rel"
            class="np-item"
            :class="{ on: i === cursor }"
            @click="cursor = i"
            @dblclick="confirm"
            @mouseenter="cursor = i"
          >
            <FileText class="np-item-ico" :size="14" :stroke-width="1.8" />
            <span class="np-item-main">
              <span class="np-item-name">{{ it.name }}</span>
              <span v-if="it.dir" class="np-item-dir">{{ it.dir }}</span>
            </span>
          </button>
          <div v-if="items.length === 0" class="np-empty">
            {{ keyword ? '没有匹配的笔记' : '工作区里还没有 .md 文件' }}
          </div>
        </div>

        <footer class="np-foot">
          <span>↑↓ 选择 · Enter 嵌入 · Esc 取消</span>
          <span class="np-count">{{ items.length }} 篇</span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.np-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  background: var(--n-mask);
}

.np {
  width: 460px;
  max-width: calc(100vw - 32px);
  display: flex;
  flex-direction: column;
  max-height: 62vh;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  background: var(--n-raised);
  box-shadow: var(--n-shadow-xl);
  overflow: hidden;
}

.np-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 12px 11px 15px;
  border-bottom: 1px solid var(--n-line);
}
.np-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--n-fg);
}
.np-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
}
.np-x:hover {
  background: var(--n-surface);
  color: var(--n-fg);
}

.np-search {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--n-line);
}
.np-ico {
  color: var(--n-fg-faint);
  flex: none;
}
.np-input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  font-family: var(--n-font-ui);
  font-size: 13px;
  color: var(--n-fg);
  outline: none;
}
.np-input::placeholder {
  color: var(--n-fg-faint);
}

.np-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 5px;
}
.np-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 9px;
  border-radius: var(--n-r-md);
  text-align: left;
}
.np-item:hover {
  background: var(--n-surface);
}
.np-item.on {
  background: var(--n-accent-soft);
}
.np-item.on .np-item-name {
  color: var(--n-accent);
}
.np-item-ico {
  color: var(--n-fg-faint);
  flex: none;
}
.np-item.on .np-item-ico {
  color: var(--n-accent);
}
.np-item-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.np-item-name {
  font-size: 12.5px;
  color: var(--n-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.np-item-dir {
  font-size: 10.5px;
  color: var(--n-fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.np-empty {
  padding: 26px 0;
  text-align: center;
  font-size: 12px;
  color: var(--n-fg-faint);
}

.np-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-top: 1px solid var(--n-line);
  font-size: 11px;
  color: var(--n-fg-faint);
}
.np-count {
  font-variant-numeric: tabular-nums;
}
</style>
