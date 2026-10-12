<script setup lang="ts">
/**
 * 笔记卡片 / 目录树上的右键菜单。
 *
 * 顺序照参考图来：先「我对这篇做什么」（打开、收藏），
 * 再「改它本身」（重命名、归类），
 * 再「它在磁盘上的位置」（复制路径、在系统打开），
 * 然后是四种导出，最后才是删除——危险的那一项永远在最下面、带红色。
 *
 * 组件只管「列出这些动作并报出用户点了哪个」，具体怎么做在调用方，
 * 因为它需要 store 与弹窗；这里保持无状态。
 */
import {
  Copy,
  ExternalLink,
  FileCode2,
  FileDown,
  FileText,
  FileType,
  FolderInput,
  PencilLine,
  Star,
  Trash2,
} from 'lucide-vue-next'
import ContextMenu from '@/components/ContextMenu.vue'
import ContextMenuItem from '@/components/ContextMenuItem.vue'
import ContextMenuSeparator from '@/components/ContextMenuSeparator.vue'

export type NoteExportKind = 'pdf' | 'html' | 'md' | 'word'

const props = defineProps<{
  /** null = 不显示。x/y 是鼠标落点 */
  target: { x: number; y: number; path: string; starred: boolean } | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open'): void
  (e: 'star'): void
  (e: 'rename'): void
  (e: 'move'): void
  (e: 'copyPath'): void
  (e: 'reveal'): void
  (e: 'export', kind: NoteExportKind): void
  (e: 'remove'): void
}>()

const EXPORTS: { kind: NoteExportKind; label: string; icon: unknown }[] = [
  { kind: 'pdf', label: '导出 PDF', icon: FileDown },
  { kind: 'html', label: '导出 HTML', icon: FileText },
  { kind: 'md', label: '导出 Markdown', icon: FileCode2 },
  { kind: 'word', label: '导出 Word', icon: FileType },
]
</script>

<template>
  <ContextMenu
    :open="!!target"
    :x="target?.x ?? 0"
    :y="target?.y ?? 0"
    label="笔记操作"
    @close="emit('close')"
  >
    <ContextMenuItem :icon="FileText" label="打开" @select="emit('open')" />
    <ContextMenuItem
      :icon="Star"
      :label="target?.starred ? '取消收藏' : '收藏'"
      @select="emit('star')"
    />

    <ContextMenuSeparator />

    <ContextMenuItem :icon="PencilLine" label="重命名" @select="emit('rename')" />
    <ContextMenuItem :icon="FolderInput" label="归类…" @select="emit('move')" />

    <ContextMenuSeparator />

    <ContextMenuItem :icon="Copy" label="复制路径" @select="emit('copyPath')" />
    <ContextMenuItem :icon="ExternalLink" label="在系统打开" @select="emit('reveal')" />

    <ContextMenuSeparator />

    <ContextMenuItem
      v-for="it in EXPORTS"
      :key="it.kind"
      :icon="it.icon"
      :label="it.label"
      @select="emit('export', it.kind)"
    />

    <ContextMenuSeparator />

    <ContextMenuItem :icon="Trash2" label="删除" danger @select="emit('remove')" />
  </ContextMenu>
</template>
