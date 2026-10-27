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
 *
 * 每个动作都把**目标 id 一起报出去**。以前是报个空事件、调用方回头去读
 * `target.id`，可菜单收起和动作是同一轮里发生的，读的时候 target 可能已经是
 * null 了 —— 表现是「点了没反应」。id 从点击那一刻就定了，就该跟着事件走。
 */
import {
  Copy,
  ExternalLink,
  NotebookPen,
  PencilLine,
  Shapes,
  SquareCheck,
  StickyNote,
  Trash2,
} from 'lucide-vue-next'
import ContextMenu from '@/components/ContextMenu.vue'
import ContextMenuItem from '@/components/ContextMenuItem.vue'
import ContextMenuSeparator from '@/components/ContextMenuSeparator.vue'

const props = defineProps<{
  /** null = 不显示。x/y 是鼠标落点 */
  target: { x: number; y: number; id: string; saved: boolean } | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  /** 动作名 + 目标 id。写成联合签名，`act()` 里才能直接把变量传进来 */
  (e: 'open' | 'rename' | 'mark' | 'select' | 'copy' | 'save' | 'reveal' | 'remove', id: string): void
}>()

type Action = 'open' | 'rename' | 'mark' | 'select' | 'copy' | 'save' | 'reveal' | 'remove'

/** 动作都从这里发：id 取的是「菜单是为哪一张开的」，不是回调那一刻的 props */
function act(name: Action) {
  const id = props.target?.id ?? ''
  if (!id) return
  emit(name, id)
}
</script>

<template>
  <ContextMenu
    :open="!!target"
    :x="target?.x ?? 0"
    :y="target?.y ?? 0"
    label="便签操作"
    @close="emit('close')"
  >
    <ContextMenuItem :icon="StickyNote" label="打开" @select="act('open')" />

    <ContextMenuSeparator />

    <ContextMenuItem :icon="PencilLine" label="重命名" @select="act('rename')" />
    <ContextMenuItem :icon="Shapes" label="标记…" @select="act('mark')" />
    <!-- 批量选择从这一条进：底栏那颗按钮是「从零开始选」，从某一张进的时候
         多半是「从这张往下都要」，所以带上它一起选中 -->
    <ContextMenuItem :icon="SquareCheck" label="选择这张…" @select="act('select')" />

    <ContextMenuSeparator />

    <ContextMenuItem :icon="Copy" label="复制正文" @select="act('copy')" />
    <ContextMenuItem
      :icon="NotebookPen"
      :label="target?.saved ? '已存入笔记（再存一份）' : '存为笔记'"
      @select="act('save')"
    />
    <ContextMenuItem :icon="ExternalLink" label="在文件夹中显示" @select="act('reveal')" />

    <ContextMenuSeparator />

    <ContextMenuItem :icon="Trash2" label="删除" danger @select="act('remove')" />
  </ContextMenu>
</template>
