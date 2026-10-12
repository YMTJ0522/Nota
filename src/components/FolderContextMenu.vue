<script setup lang="ts">
/**
 * 侧栏文件夹的右键菜单。
 *
 * 目录树以前只能点开/收起，要建东西得跑到上面的按钮去点——
 * 而那个按钮建出来的是「工作区根目录」的文件夹，不是你右键的那个。
 * 这里每一条都对准右键点中的那一个文件夹。
 *
 * 和笔记菜单一样只负责「报出用户点了哪个」，具体动作在 SidePanel，
 * 因为建/改名/删除都要走 store 和弹窗。
 */
import {
  Copy,
  ExternalLink,
  FilePlus2,
  FolderPlus,
  PencilLine,
  Trash2,
} from 'lucide-vue-next'
import ContextMenu from '@/components/ContextMenu.vue'
import ContextMenuItem from '@/components/ContextMenuItem.vue'
import ContextMenuSeparator from '@/components/ContextMenuSeparator.vue'

const props = defineProps<{
  /** null = 不显示。x/y 是鼠标落点 */
  target: { x: number; y: number; path: string; name: string } | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'newNote'): void
  (e: 'newFolder'): void
  (e: 'rename'): void
  (e: 'copyPath'): void
  (e: 'reveal'): void
  (e: 'remove'): void
}>()
</script>

<template>
  <ContextMenu
    :open="!!target"
    :x="target?.x ?? 0"
    :y="target?.y ?? 0"
    :label="`文件夹「${target?.name ?? ''}」`"
    @close="emit('close')"
  >
    <ContextMenuItem :icon="FilePlus2" label="在此新建笔记" @select="emit('newNote')" />
    <ContextMenuItem :icon="FolderPlus" label="在此新建子文件夹" @select="emit('newFolder')" />

    <ContextMenuSeparator />

    <ContextMenuItem :icon="PencilLine" label="重命名" @select="emit('rename')" />

    <ContextMenuSeparator />

    <ContextMenuItem :icon="Copy" label="复制路径" @select="emit('copyPath')" />
    <ContextMenuItem :icon="ExternalLink" label="在系统打开" @select="emit('reveal')" />

    <ContextMenuSeparator />

    <ContextMenuItem :icon="Trash2" label="删除文件夹" danger @select="emit('remove')" />
  </ContextMenu>
</template>
