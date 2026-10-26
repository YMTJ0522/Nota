<script setup lang="ts">
/**
 * 便签的「标记」弹窗：图标 + 标签。
 *
 * 为什么不直接用笔记那个 MarkDialog：
 * 笔记的标签写在文件的 frontmatter 里，靠的是**全库**那张标签表（store.allTags），
 * 图标也存在库的 .nota/icons.json 里。便签刻意和库解耦（见 electron/stickies.ts），
 * 没有库的时候也要能打标签——硬套那个弹窗，没建库的用户打开就是一片空白，
 * 而「新建标签」还会去创建一个并不存在的库。
 *
 * 所以这里是同一套视觉、另一套数据源：标签跟着便签自己的记录走，
 * 图标是这张纸的图标（技术栈一眼认出来），不挂到标签上。
 *
 * 改动即时生效（和 MarkDialog 一致）：关掉弹窗不该把已经点过的选择弄丢。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { Hash, Plus, Shapes, StickyNote, X } from 'lucide-vue-next'
import MarkIconGrid, { type MarkIcon } from '@/components/MarkIconGrid.vue'

const props = defineProps<{
  open: boolean
  /** 便签标题，只用于标题栏预览 */
  title: string
  icon?: MarkIcon | null
  tags?: string[]
  /** 所有便签上用过的标签，点一下就能加，免得同义词越攒越多 */
  known?: { name: string; count: number }[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'pickIcon', icon: MarkIcon | null): void
  (e: 'setTags', tags: string[]): void
}>()

const pane = ref<'icon' | 'tag'>('icon')
const q = ref('')
const input = ref<HTMLInputElement | null>(null)

const mine = computed(() => props.tags ?? [])

/** 已经是自己的就不再列进候选 */
const suggest = computed(() =>
  (props.known ?? []).filter((t) => !mine.value.includes(t.name)).slice(0, 12),
)

const canAdd = computed(() => {
  const v = q.value.trim()
  return !!v && !mine.value.includes(v)
})

function add(name: string) {
  const v = name.trim().replace(/^#/, '')
  if (!v || mine.value.includes(v)) return
  emit('setTags', [...mine.value, v])
  q.value = ''
}

function drop(name: string) {
  emit(
    'setTags',
    mine.value.filter((t) => t !== name),
  )
}

function onEnter() {
  if (canAdd.value) add(q.value)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

watch(
  () => props.open,
  async (v) => {
    if (!v) return
    q.value = ''
    // 默认停在图标页：便签上的标记绝大多数时候回答「这是哪个技术栈的」，
    // 那是图标；标签是次要的、可以随时补。
    pane.value = 'icon'
    await nextTick()
  },
)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sm-mask" @click.self="emit('close')" @keydown="onKey">
      <div class="sm" role="dialog" aria-modal="true" aria-label="便签标记">
        <header class="sm-head">
          <span class="sm-ic"><StickyNote :size="14" :stroke-width="1.9" /></span>
          <span class="sm-title">标记</span>
          <span class="sm-name">{{ title }}</span>
          <button class="sm-x" title="关闭" @click="emit('close')">
            <X :size="15" :stroke-width="1.9" />
          </button>
        </header>

        <div class="sm-tabs">
          <button :class="{ on: pane === 'icon' }" @click="pane = 'icon'">
            <Shapes :size="12" :stroke-width="2.2" /><span>图标</span>
          </button>
          <button :class="{ on: pane === 'tag' }" @click="pane = 'tag'">
            <Hash :size="12" :stroke-width="2.2" /><span>标签</span>
          </button>
        </div>

        <MarkIconGrid
          v-if="pane === 'icon'"
          class="sm-grid"
          :current="icon ?? null"
          @pick="(ic) => emit('pickIcon', ic)"
        />

        <div v-else class="sm-pane">
          <label class="sm-input">
            <Hash :size="12" :stroke-width="2.2" />
            <input
              ref="input"
              v-model="q"
              type="text"
              placeholder="输入标签，回车加上"
              spellcheck="false"
              @keydown.enter.prevent="onEnter"
            />
            <button v-if="canAdd" class="sm-add" :title="`加上「${q.trim()}」`" @click="onEnter">
              <Plus :size="12" :stroke-width="2.6" /><span>添加</span>
            </button>
          </label>

          <div v-if="mine.length" class="sm-tags">
            <button v-for="t in mine" :key="t" class="sm-tag" :title="`去掉「${t}」`" @click="drop(t)">
              <span>#{{ t }}</span>
              <X :size="10" :stroke-width="2.6" />
            </button>
          </div>

          <template v-if="suggest.length">
            <p class="sm-hint">别的便签用过</p>
            <div class="sm-tags">
              <button v-for="t in suggest" :key="t.name" class="sm-tag ghost" @click="add(t.name)">
                <Plus :size="10" :stroke-width="2.6" />
                <span>#{{ t.name }}</span>
              </button>
            </div>
          </template>

          <p v-if="!mine.length && !suggest.length" class="sm-empty">
            便签的标签不进笔记库，存为笔记时才写进那篇笔记的 frontmatter。
          </p>
        </div>

        <footer class="sm-foot">
          <button class="sm-btn ghost" @click="emit('pickIcon', null)">去掉图标</button>
          <button class="sm-btn" @click="emit('close')">完成</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sm-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--n-mask);
  animation: sm-fade 120ms var(--n-ease);
}

.sm {
  width: 468px;
  max-width: calc(100vw - 40px);
  /* 高度跟着当前页走：图标页有网格要占满，标签页内容少就不该拖着半屏空白 */
  height: auto;
  max-height: calc(100vh - 60px);
  display: flex;
  flex-direction: column;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  box-shadow: var(--n-shadow-xl);
  overflow: hidden;
  animation: sm-in 140ms var(--n-ease);
}

.sm-head {
  flex: none;
  height: 44px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--n-line);
  color: var(--n-fg-dim);
}

.sm-ic {
  display: inline-flex;
  color: var(--n-accent);
}

.sm-ic svg,
.sm-tabs svg,
.sm-x svg {
  fill: none;
  stroke: currentColor;
}

.sm-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--n-fg);
}

.sm-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sm-x {
  flex: none;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
}

.sm-x:hover {
  background: var(--n-surface);
  color: var(--n-fg);
}

.sm-tabs {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 8px 12px 0;
}

.sm-tabs button {
  height: 26px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
  border-radius: 7px 7px 0 0;
  font-size: 12px;
  color: var(--n-fg-dim);
}

.sm-tabs button.on {
  background: var(--n-surface);
  color: var(--n-fg);
}

.sm-grid {
  /* 图标网格自己滚，所以这里必须给死高度——否则 height:auto 会让它撑到屏幕外 */
  flex: none;
  height: 294px;
}

.sm-pane {
  flex: 0 1 auto;
  min-height: 96px;
  max-height: 294px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px 12px;
  overflow-y: auto;
}

.sm-input {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  border-radius: 9px;
  border: 1px solid var(--n-line);
  background: var(--n-surface);
  color: var(--n-fg-faint);
}

.sm-input:focus-within {
  border-color: var(--n-accent);
}

.sm-input input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: none;
  font-size: 12px;
  color: var(--n-fg);
}

.sm-add {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 7px;
  border-radius: 6px;
  background: var(--n-accent);
  color: #fff;
  font-size: 11px;
}

.sm-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.sm-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid var(--n-line);
  background: var(--n-surface);
  font-size: 11.5px;
  color: var(--n-fg);
}

.sm-tag svg {
  fill: none;
  stroke: currentColor;
  opacity: 0.55;
}

.sm-tag:hover {
  border-color: var(--n-accent);
}

.sm-tag:hover svg {
  opacity: 1;
  color: #c0392b;
}

.sm-tag.ghost {
  border-style: dashed;
  color: var(--n-fg-dim);
}

.sm-hint {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--n-fg-faint);
}

.sm-empty {
  margin: 12px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--n-fg-faint);
}

.sm-foot {
  flex: none;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 12px;
  border-top: 1px solid var(--n-line);
}

.sm-btn {
  height: 28px;
  padding: 0 14px;
  border-radius: 7px;
  background: var(--n-surface);
  border: 1px solid var(--n-line);
  font-size: 12px;
  color: var(--n-fg);
}

.sm-btn:hover {
  border-color: var(--n-line-strong, var(--n-line));
}

.sm-btn.ghost {
  margin-right: auto;
  background: none;
  border-color: transparent;
  color: var(--n-fg-dim);
}

.sm-btn.ghost:hover {
  background: var(--n-surface);
  color: var(--n-fg);
}

@keyframes sm-fade {
  from {
    opacity: 0;
  }
}

@keyframes sm-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.985);
  }
}
</style>
