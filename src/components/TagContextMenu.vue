<script setup lang="ts">
/**
 * 侧栏标签的右键菜单。
 *
 * 标签没有自己的库，它是每篇笔记 frontmatter 里的一行，所以这里的两条
 * 「改名 / 删除」动的是所有带这个标签的笔记 —— 不是把这个名字从侧栏
 * 藏起来（那样下次刷新就又冒出来了，等于没删）。
 *
 * 菜单里的文案把这一点写明，免得用户以为只是改了个显示名。
 */
import { Copy, Filter, PencilLine, Trash2 } from 'lucide-vue-next'
import ContextMenu from '@/components/ContextMenu.vue'
import ContextMenuItem from '@/components/ContextMenuItem.vue'
import ContextMenuSeparator from '@/components/ContextMenuSeparator.vue'

const props = defineProps<{
  /** null = 不显示。x/y 是鼠标落点 */
  target: { x: number; y: number; name: string; count: number; active: boolean } | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'filter'): void
  (e: 'copy'): void
  (e: 'rename'): void
  (e: 'remove'): void
}>()
</script>

<template>
  <ContextMenu
    :open="!!target"
    :x="target?.x ?? 0"
    :y="target?.y ?? 0"
    :label="`标签 #${target?.name ?? ''}`"
    @close="emit('close')"
  >
    <ContextMenuItem
      :icon="Filter"
      :label="target?.active ? '取消筛选' : '只看这个标签'"
      @select="emit('filter')"
    />
    <ContextMenuItem :icon="Copy" label="复制标签名" @select="emit('copy')" />

    <ContextMenuSeparator />

    <ContextMenuItem :icon="PencilLine" label="重命名标签（改所有笔记）" @select="emit('rename')" />
    <ContextMenuItem
      :icon="Trash2"
      :label="`删除标签（从 ${target?.count ?? 0} 篇笔记移除）`"
      danger
      @select="emit('remove')"
    />
  </ContextMenu>
</template>
