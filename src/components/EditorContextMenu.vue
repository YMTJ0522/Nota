<script setup lang="ts">
/**
 * 编辑区右键菜单。
 *
 * 分三组：
 * 1. 撤销 / 重做 —— 看历史栈里有没有东西，没有就置灰而不是点了没反应；
 * 2. 剪切 / 复制 / 粘贴 —— 剪切复制只在有选区时可用；
 * 3. AI 操作 —— 必须有选区（改的是选中的那段），AI 关掉时整组不出现。
 */
import {
  ClipboardPaste,
  Copy,
  Redo2,
  Scissors,
  SquareDashedMousePointer,
  Undo2,
  WandSparkles,
} from 'lucide-vue-next'
import ContextMenu from '@/components/ContextMenu.vue'
import ContextMenuItem from '@/components/ContextMenuItem.vue'
import ContextMenuSeparator from '@/components/ContextMenuSeparator.vue'

export type EditorAiAction = 'expand' | 'polish' | 'summarize' | 'translate'

export interface EditorMenuTarget {
  x: number
  y: number
  hasSelection: boolean
  canUndo: boolean
  canRedo: boolean
}

const props = withDefaults(
  defineProps<{
    target: EditorMenuTarget | null
    aiEnabled?: boolean
    aiBusy?: boolean
  }>(),
  { aiEnabled: true, aiBusy: false },
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'undo'): void
  (e: 'redo'): void
  (e: 'cut'): void
  (e: 'copy'): void
  (e: 'paste'): void
  (e: 'selectAll'): void
  (e: 'ai', kind: EditorAiAction): void
}>()

const AI_ITEMS: { kind: EditorAiAction; label: string }[] = [
  { kind: 'expand', label: '扩写这段' },
  { kind: 'polish', label: '润色这段' },
  { kind: 'summarize', label: '总结这段' },
  { kind: 'translate', label: '翻译这段' },
]

function run(kind: EditorAiAction) {
  emit('ai', kind)
}

/** 菜单里 AI 是否可点：AI 得开着、有选区、且没有正在跑的请求 */
function aiOff() {
  return props.aiBusy || !props.target?.hasSelection
}
</script>

<template>
  <ContextMenu :open="!!target" :x="target?.x ?? 0" :y="target?.y ?? 0" label="编辑器操作" @close="emit('close')">
    <ContextMenuItem
      :icon="Undo2"
      label="撤销"
      shortcut="Ctrl+Z"
      :disabled="!target?.canUndo"
      @select="emit('undo')"
    />
    <ContextMenuItem
      :icon="Redo2"
      label="重做"
      shortcut="Ctrl+Y"
      :disabled="!target?.canRedo"
      @select="emit('redo')"
    />
    <ContextMenuSeparator />
    <ContextMenuItem
      :icon="Scissors"
      label="剪切"
      shortcut="Ctrl+X"
      :disabled="!target?.hasSelection"
      @select="emit('cut')"
    />
    <ContextMenuItem
      :icon="Copy"
      label="复制"
      shortcut="Ctrl+C"
      :disabled="!target?.hasSelection"
      @select="emit('copy')"
    />
    <ContextMenuItem
      :icon="ClipboardPaste"
      label="粘贴"
      shortcut="Ctrl+V"
      @select="emit('paste')"
    />
    <template v-if="aiEnabled">
      <ContextMenuSeparator />
      <div class="ctx-group">
        <span class="ctx-group-ico"><WandSparkles :size="12" :stroke-width="1.9" /></span>
        <span>{{ aiBusy ? 'AI 正在生成…' : 'AI 操作' }}</span>
      </div>
      <ContextMenuItem
        v-for="it in AI_ITEMS"
        :key="it.kind"
        :icon="WandSparkles"
        :label="it.label"
        :disabled="aiOff()"
        @select="run(it.kind)"
      />
    </template>
    <ContextMenuSeparator />
    <ContextMenuItem
      :icon="SquareDashedMousePointer"
      label="全选"
      shortcut="Ctrl+A"
      @select="emit('selectAll')"
    />
  </ContextMenu>
</template>

<style scoped>
.ctx-group {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 8px 2px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--n-fg-faint);
}

.ctx-group-ico {
  display: inline-flex;
  color: var(--n-accent);
}

.ctx-group-ico svg {
  fill: none;
  stroke: currentColor;
}
</style>
