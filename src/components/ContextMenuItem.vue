<script setup lang="ts">
/**
 * 右键菜单里的一行。
 *
 * 长相不在这里定义 —— 走全局那一套菜单样式（styles/menu.css），
 * 和顶栏的导出菜单、工具栏的下拉是同一批行。这里只负责语义：
 * 图标可选、快捷键可选、能不能点、是不是危险动作。
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
    class="ctx-item n-menu-item"
    :class="{ off: disabled, danger: danger && !disabled }"
    role="menuitem"
    :disabled="disabled"
    @click="onPick"
  >
    <span v-if="icon" class="ctx-ico n-menu-ico">
      <component :is="icon" :size="13" :stroke-width="1.9" />
    </span>
    <span class="ctx-label n-menu-name">{{ label }}</span>
    <span v-if="shortcut" class="ctx-key n-menu-tail">{{ shortcut }}</span>
  </button>
</template>

<style scoped>
/* 没图标时把图标那格的空间补上，文字才会和别行对齐 */
.ctx-item:not(:has(.ctx-ico)) {
  padding-left: 29px;
}
</style>
