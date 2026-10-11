<script setup lang="ts">
import { ref, watch, onBeforeUnmount, nextTick } from 'vue'
import { ListTree } from 'lucide-vue-next'
import type { HeadingItem } from '@/editor/preview-rich'

const props = defineProps<{
  headings: HeadingItem[]
  /** 预览滚动容器（预览区本身就是滚动元素） */
  scroller: HTMLElement | null
}>()

const active = ref<string | null>(null)
let raf = 0

/** 滚动跟随：取「最后一个越过顶部参考线」的标题作为当前项 */
function onScroll() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(() => {
    const box = props.scroller
    if (!box || props.headings.length === 0) return
    const top = box.scrollTop + 64
    let current: string | null = props.headings[0]?.id ?? null
    for (const h of props.headings) {
      const el = box.querySelector<HTMLElement>(`#${CSS.escape(h.id)}`)
      if (!el) continue
      if (el.offsetTop <= top) current = h.id
      else break
    }
    active.value = current
  })
}

function bind() {
  const box = props.scroller
  if (!box) return
  box.addEventListener('scroll', onScroll, { passive: true })
  onScroll()
}

function unbind() {
  props.scroller?.removeEventListener('scroll', onScroll)
  cancelAnimationFrame(raf)
}

watch(
  () => props.scroller,
  async () => {
    unbind()
    await nextTick()
    bind()
  },
  { immediate: true },
)

watch(
  () => props.headings,
  () => {
    active.value = props.headings[0]?.id ?? null
    onScroll()
  },
)

onBeforeUnmount(unbind)

function jump(h: HeadingItem) {
  const box = props.scroller
  if (!box) return
  const el = box.querySelector<HTMLElement>(`#${CSS.escape(h.id)}`)
  if (!el) return
  box.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' })
  active.value = h.id
}
</script>

<template>
  <nav v-if="headings.length" class="outline" aria-label="大纲">
    <div class="outline-head">
      <ListTree :size="11" :stroke-width="2" />
      <span>大纲</span>
    </div>
    <ul class="outline-list">
      <li v-for="h in headings" :key="h.id">
        <button
          class="outline-item"
          :class="{ on: active === h.id }"
          :style="{ paddingLeft: 8 + (h.level - 1) * 10 + 'px' }"
          :title="h.text || '未命名标题'"
          @click="jump(h)"
        >
          <span v-if="active === h.id" class="outline-bar" />
          {{ h.text || '未命名标题' }}
        </button>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.outline {
  flex: none;
  /* 宽度由 App 写在 --outline-w 上，拖分隔线改的就是它 */
  width: var(--outline-w, 176px);
  min-height: 0;
  overflow-y: auto;
  padding: 16px 8px 24px 0;
  border-left: 1px solid var(--n-line);
}

.outline-head {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 8px;
  padding-left: 10px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--n-fg-faint);
}

.outline-head svg {
  fill: none;
  stroke: currentColor;
}

.outline-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.outline-item {
  position: relative;
  display: block;
  width: 100%;
  padding: 4px 8px 4px 10px;
  border-radius: var(--n-r-sm);
  font-size: 11.5px;
  line-height: 1.45;
  text-align: left;
  color: var(--n-fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color var(--n-dur) var(--n-ease), background var(--n-dur) var(--n-ease);
}

.outline-item:hover {
  color: var(--n-fg-dim);
  background: var(--n-raised);
}

.outline-item.on {
  color: var(--n-accent);
  font-weight: 600;
}

.outline-bar {
  position: absolute;
  left: 2px;
  top: 50%;
  width: 2px;
  height: 13px;
  border-radius: 2px;
  background: var(--n-accent);
  transform: translateY(-50%);
}
</style>
