<script setup lang="ts">
import { computed } from 'vue'
import {
  filterSlashCommands,
  SLASH_LABELS,
  type SlashMenuRenderState,
  type SlashCommandId,
} from '@/editor/slash-commands'

const props = defineProps<{ state: SlashMenuRenderState }>()
const emit = defineEmits<{ (e: 'pick', id: SlashCommandId): void }>()

/** 标签统一来自扩展层，避免两处维护同一份文案 */
const LABELS = SLASH_LABELS

const ICONS: Record<SlashCommandId, string> = {
  // 文本
  heading1: 'H1', heading2: 'H2', heading3: 'H3',
  bold: 'B', italic: 'I', strikethrough: 'S', highlight: '▮', inlineCode: '</>',
  // 列表
  bulletList: '•', numberedList: '1.', taskList: '☑', quote: '❝',
  // 链接与引用
  link: '🔗', wikiLink: '[[', noteEmbed: '![[', blockReference: '[[#', footnote: '[^]',
  image: '🖼',
  // 笔记
  tag: '#', blockId: '^', frontMatter: '---', comment: '%%',
  // 代码 / 表格 / 数学
  codeBlock: '```', advancedCodeBlock: '⌗', mermaid: '◈', table: '▦',
  inlineMath: '$', mathBlock: '$$',
  // 内容块
  callout: '❗', details: '▸', tabs: '⧉', divider: '—',
  // AI
  aiSummarize: '✦', aiOutline: '✦', aiContinue: '✦', aiTranslate: '✦',
}

const items = computed(() => filterSlashCommands(props.state.filter))

const style = computed(() => ({
  left: `${props.state.x}px`,
  top: `${props.state.y + 6}px`,
}))

/** 选中项滚动进视野 */
function isActive(id: SlashCommandId) {
  return items.value[props.state.selectedIndex]?.id === id
}
</script>

<template>
  <div
    v-if="items.length"
    class="slash"
    :style="style"
    role="listbox"
    @pointerdown.prevent
  >
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      role="option"
      :aria-selected="isActive(item.id)"
      :class="['slash-item', { on: isActive(item.id) }]"
      @click="emit('pick', item.id)"
    >
      <span class="ico">{{ ICONS[item.id] }}</span>
      <span class="txt">{{ LABELS[item.id] }}</span>
      <span v-if="item.group === 'ai'" class="badge">AI</span>
    </button>
  </div>
</template>

<style scoped>
.slash {
  position: fixed;
  z-index: 60;
  width: 232px;
  max-height: 300px;
  overflow-y: auto;
  padding: 4px;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  box-shadow: var(--n-shadow-lg);
  animation: slash-in 120ms var(--n-ease);
}

@keyframes slash-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to { opacity: 1; transform: none; }
}

.slash-item {
  width: 100%;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 8px;
  border-radius: var(--n-r-sm);
  font-size: 13px;
  color: var(--n-fg);
  text-align: left;
}

.slash-item.on {
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

.ico {
  flex: none;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  font-family: var(--n-font-mono);
  border-radius: 4px;
  background: var(--n-surface);
  color: var(--n-fg-dim);
}

.slash-item.on .ico {
  background: var(--n-accent);
  color: var(--n-on-accent);
}

.txt {
  flex: 1;
  white-space: nowrap;
}

.badge {
  flex: none;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--n-surface);
  color: var(--n-fg-faint);
  border: 1px solid var(--n-line);
}
</style>
