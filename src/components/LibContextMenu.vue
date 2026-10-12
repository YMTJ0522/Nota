<script setup lang="ts">
/**
 * 附件库 / 回收站的右键菜单。
 *
 * 这两个视图的菜单项完全不同（一个「插入 / 删除」，一个「恢复 / 彻底删除」），
 * 但结构一样、而且都带「全选 / 取消选择」这类通用的多选动作。
 * 与其写两份几乎一样的模板，不如把菜单项当数据传进来。
 */
import ContextMenu from '@/components/ContextMenu.vue'
import ContextMenuItem from '@/components/ContextMenuItem.vue'
import ContextMenuSeparator from '@/components/ContextMenuSeparator.vue'

export interface LibMenuItem {
  id: string
  label: string
  /** Lucide 组件。不传就是纯文字项 */
  icon?: unknown
  danger?: boolean
  /** 在这一项前面插一条分隔线 */
  sepBefore?: boolean
}

const props = withDefaults(
  defineProps<{
    open: boolean
    x: number
    y: number
    label?: string
    items: LibMenuItem[]
  }>(),
  { label: '操作' },
)

const emit = defineEmits<{ (e: 'close'): void; (e: 'pick', id: string): void }>()
</script>

<template>
  <ContextMenu :open="open" :x="x" :y="y" :label="label" @close="emit('close')">
    <template v-for="it in items" :key="it.id">
      <ContextMenuSeparator v-if="it.sepBefore" />
      <ContextMenuItem
        :icon="it.icon"
        :label="it.label"
        :danger="it.danger"
        @select="emit('pick', it.id)"
      />
    </template>
  </ContextMenu>
</template>
