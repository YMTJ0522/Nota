<script setup lang="ts">
/**
 * 右键菜单里的一行。
 *
 * 图标是可选的：没有图标时文字缩进对齐，靠 padding-left 补出来，
 * 免得纯文字行和带图标行左右参差。
 */
const props = withDefaults(
  defineProps<{
    label: string
    icon?: unknown
    shortcut?: string
    disabled?: boolean
    danger?: boolean
  }>(),
  { icon: undefined, shortcut: '', disabled: false, danger: false },
)

const emit = defineEmits<{ (e: 'select'): void }>()

function onPick() {
  if (props.disabled) return
  emit('select')
}
</script>

<template>
  <button
    class="ctx-item"
    :class="{ off: disabled, danger: danger && !disabled }"
    role="menuitem"
    :disabled="disabled"
    @click="onPick"
  >
    <span v-if="icon" class="ctx-ico"><component :is="icon" :size="13" :stroke-width="1.9" /></span>
    <span class="ctx-label">{{ label }}</span>
    <span v-if="shortcut" class="ctx-key">{{ shortcut }}</span>
  </button>
</template>

<style scoped>
.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 8px 0 8px;
  border-radius: var(--n-r-md);
  font-size: 12px;
  color: var(--n-fg);
  text-align: left;
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

/* 没图标时把图标那格的空间补上，文字才会和别行对齐 */
.ctx-item:not(:has(.ctx-ico)) {
  padding-left: 29px;
}

.ctx-item:hover:not(.off) {
  background: var(--n-raised);
}

.ctx-item.danger:hover:not(.off) {
  color: #d0453b;
}

.ctx-item.off {
  color: var(--n-fg-faint);
  opacity: 0.62;
  cursor: default;
}

.ctx-ico {
  flex: none;
  display: inline-flex;
  color: var(--n-fg-dim);
}

.ctx-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ctx-key {
  flex: none;
  font-family: var(--n-font-mono);
  font-size: 10px;
  color: var(--n-fg-faint);
}

.ctx-ico svg {
  fill: none;
  stroke: currentColor;
}
</style>
