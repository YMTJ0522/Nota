<script setup lang="ts">
/**
 * 便签列表里的右键菜单。
 *
 * 分组和笔记的右键菜单一致（先「打开」，再「改它本身」，再「磁盘/搬运」，
 * 最后是红色的删除）——两处菜单长得一样，人才不用重新找一遍。
 *
 * 少了什么、为什么：
 *  · 没有「收藏」：便签本来就是随手记，星标是给长期存放的笔记做检索用的；
 *  · 没有四种导出：一张便签导出成 PDF 是杀鸡用牛刀，要导出就先「存为笔记」。
 *
 * 组件无状态：只列动作、报出点了哪个，具体怎么做在 StickyView 里。
 */
import {
  Copy,
  ExternalLink,
  NotebookPen,
  PencilLine,
  Shapes,
  StickyNote,
  Trash2,
} from 'lucide-vue-next'
import ContextMenu from '@/components/ContextMenu.vue'
import ContextMenuItem from '@/components/ContextMenuItem.vue'
import ContextMenuSeparator from '@/components/ContextMenuSeparator.vue'

defineProps<{
  /** null = 不显示。x/y 是鼠标落点 */
  target: { x: number; y: number; id: string; saved: boolean } | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open'): void
  (e: 'rename'): void
  (e: 'mark'): void
  (e: 'copy'): void
  (e: 'save'): void
  (e: 'reveal'): void
  (e: 'remove'): void
}>()
</script>

<template>
  <ContextMenu
    :open="!!target"
    :x="target?.x ?? 0"
    :y="target?.y ?? 0"
    label="便签操作"
    @close="emit('close')"
  >
    <ContextMenuItem :icon="StickyNote" label="打开" @select="emit('open')" />

    <ContextMenuSeparator />

    <ContextMenuItem :icon="PencilLine" label="重命名" @select="emit('rename')" />
    <ContextMenuItem :icon="Shapes" label="标记…" @select="emit('mark')" />

    <ContextMenuSeparator />

    <ContextMenuItem :icon="Copy" label="复制正文" @select="emit('copy')" />
    <ContextMenuItem
      :icon="NotebookPen"
      :label="target?.saved ? '已存入笔记（再存一份）' : '存为笔记'"
      @select="emit('save')"
    />
    <ContextMenuItem :icon="ExternalLink" label="在文件夹中显示" @select="emit('reveal')" />

    <ContextMenuSeparator />

    <ContextMenuItem :icon="Trash2" label="删除" danger @select="emit('remove')" />
  </ContextMenu>
</template>
